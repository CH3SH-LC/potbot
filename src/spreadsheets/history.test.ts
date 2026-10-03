/**
 * `history.ts` 的验收用例（design-06-P8 / XLS-17）。
 *
 * 覆盖：撤销 / 重做、版本比较、并发冲突检测、**失败保旧**；
 * 以及预算的**定点精度**、单位、**缺失不当零**、**独立复算**。
 *
 * 每条能力都有一条**反向对照**：把"缺失当 0 / 浮点漂移 / 最后写入者赢 / 半改状态"
 * 这些错误做法摆到用例里，证明断言**能分辨对错**，而不是"函数没抛就算过"。
 */

import { describe, expect, it } from 'vitest';

import {
  canRedo,
  canUndo,
  cloneWorkbook,
  commit,
  compareWorkbooks,
  createHistory,
  currentRevision,
  currentSnapshot,
  currentWorkbook,
  detectStaleWrite,
  historyLabels,
  knownRevisions,
  mergeWorkbooks,
  recomputeBudget,
  redo,
  redoDepth,
  restoreAt,
  revisionOf,
  sumBudgetOrNull,
  undo,
  undoDepth,
  undoSteps,
  updateSheet,
  verifyBudget,
  versionTimeline,
  type BudgetItem,
  type HistoryState,
} from './history.js';
import { formatQuantity, parseQuantity, type Quantity } from './quantity.js';
import { createSheet, getCellValue, setCellValue, type SheetState } from './sheet.js';
import { createWorkbook, getSheet, type WorkbookState } from './workbook.js';
import { blank, numberValue, textValue, type CellValue } from './value.js';

// ---------------------------------------------------------------------------
// 助手
// ---------------------------------------------------------------------------

function sheetOf(workbook: WorkbookState, name: string): SheetState {
  const sheet = getSheet(workbook, name);
  if (sheet === undefined) throw new Error(`测试夹具里没有工作表 ${name}`);
  return sheet;
}

function valueOf(workbook: WorkbookState, sheet: string, ref: string): CellValue {
  return getCellValue(sheetOf(workbook, sheet), ref);
}

function budgetSheet(): WorkbookState {
  let sheet = createSheet('预算', { row_count: 4, column_count: 3 });
  sheet = setCellValue(sheet, 'A1', textValue('项目'));
  sheet = setCellValue(sheet, 'B2', numberValue(100));
  return createWorkbook([sheet]);
}

function money(text: string, unit = 'CNY'): Quantity {
  return parseQuantity(text, 2, unit);
}

/** 把"改一张表"补成"改工作簿"（历史的改写函数返回工作簿）。 */
function setIn(workbook: WorkbookState, sheet: string, ref: string, value: CellValue): WorkbookState {
  return updateSheet(workbook, sheet, (state) => setCellValue(state, ref, value));
}

// ---------------------------------------------------------------------------
// 撤销 / 重做
// ---------------------------------------------------------------------------

describe('撤销 / 重做', () => {
  it('提交推进版本，撤销 / 重做回到对应快照', () => {
    let history = createHistory(budgetSheet(), 'initial');
    expect(canUndo(history)).toBe(false);

    const first = commit(history, '写入摘要', (workbook) => setIn(workbook, '预算', 'C2', textValue('已核对')));
    expect(first.ok).toBe(true);
    history = first.history;
    expect(currentRevision(history)).toBe(1);
    expect(historyLabels(history)).toEqual(['initial', '写入摘要']);
    expect(valueOf(currentWorkbook(history), '预算', 'C2')).toEqual(textValue('已核对'));

    history = undo(history);
    expect(currentRevision(history)).toBe(0);
    expect(valueOf(currentWorkbook(history), '预算', 'C2')).toEqual(blank);
    expect(canRedo(history)).toBe(true);

    history = redo(history);
    expect(currentRevision(history)).toBe(1);
    expect(valueOf(currentWorkbook(history), '预算', 'C2')).toEqual(textValue('已核对'));
  });

  it('撤销后再提交清空"未来"（不留下分叉）', () => {
    let history = createHistory(budgetSheet());
    history = (commit(history, 'a', (w) => setIn(w, '预算', 'A2', textValue('1'))) as { history: typeof history }).history;
    history = undo(history);
    expect(redoDepth(history)).toBe(1);
    const next = commit(history, 'b', (w) => setIn(w, '预算', 'A3', textValue('2')));
    expect(next.ok).toBe(true);
    expect(canRedo(next.history)).toBe(false);
    expect(redoDepth(next.history)).toBe(0);
    expect(undoDepth(next.history)).toBe(1);
  });

  it('多步撤销 / 越界撤销显式失败', () => {
    let history = createHistory(budgetSheet());
    for (const label of ['一', '二', '三']) {
      const outcome = commit(history, label, (w) => setIn(w, '预算', 'A2', textValue(label)));
      expect(outcome.ok).toBe(true);
      history = outcome.history;
    }
    expect(currentRevision(history)).toBe(3);
    const back = undoSteps(history, 2);
    expect(currentRevision(back)).toBe(1);
    expect(() => undoSteps(back, 5)).toThrow(/没有可撤销/);
    expect(() => undoSteps(history, -1)).toThrow(/非负整数/);
  });
});

// ---------------------------------------------------------------------------
// 失败保旧
// ---------------------------------------------------------------------------

describe('失败保旧（失败不得留下半个工作簿）', () => {
  it('改写函数抛错 ⇒ 原历史原样返回，规范状态逐字节未动', () => {
    const history = createHistory(budgetSheet());
    const beforeBytes = JSON.stringify([...sheetOf(currentWorkbook(history), '预算').cells.entries()]);

    const outcome = commit(history, '改到一半', (workbook) => {
      const cells = sheetOf(workbook, '预算').cells as Map<string, CellValue>;
      cells.set('B2', numberValue(999)); // 先写草稿
      cells.set('B3', numberValue(888));
      throw new Error('算到一半失败');
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.history).toBe(history); // 同一个对象，未被替换
    expect(currentRevision(history)).toBe(0);
    expect(canUndo(outcome.history)).toBe(false);
    expect(valueOf(currentWorkbook(history), '预算', 'B2')).toEqual(numberValue(100));
    const afterBytes = JSON.stringify([...sheetOf(currentWorkbook(history), '预算').cells.entries()]);
    expect(afterBytes).toBe(beforeBytes);
  });

  it('反向对照：草稿的 Map 与规范状态的 Map **不是同一个对象**（否则"改到一半"会污染规范状态）', () => {
    const history = createHistory(budgetSheet());
    const canonical = sheetOf(currentWorkbook(history), '预算');
    let seen: SheetState | null = null;
    const outcome = commit(history, '读一眼', (workbook) => {
      seen = sheetOf(workbook, '预算');
      return workbook;
    });
    expect(outcome.ok).toBe(true);
    expect(seen).not.toBeNull();
    expect((seen as unknown as SheetState).cells).not.toBe(canonical.cells);
    expect(canonical.cells.get('B2')).toEqual(numberValue(100));
  });

  it('反向对照：改写函数返回"半个工作簿" ⇒ 被结构校验拦下', () => {
    const history = createHistory(budgetSheet());
    const outcome = commit(history, '返回半个', () => ({ sheets: [], active_sheet: 0 } as unknown as WorkbookState));
    expect(outcome.ok).toBe(false);
    expect(outcome.history).toBe(history);
    const noCells = commit(history, '没有 cells', (workbook) => {
      const sheet = sheetOf(workbook, '预算');
      return { sheets: [{ ...sheet, cells: 'not-a-map' }], active_sheet: 0 } as unknown as WorkbookState;
    });
    expect(noCells.ok).toBe(false);
  });

  it('失败不消耗历史：失败后再成功提交，版本号仍从 0 递增', () => {
    const history = createHistory(budgetSheet());
    const failed = commit(history, '坏的', () => {
      throw new Error('boom');
    });
    expect(failed.ok).toBe(false);
    const ok = commit(history, '好的', (w) => setIn(w, '预算', 'A2', textValue('x')));
    expect(ok.ok).toBe(true);
    expect(currentRevision(ok.history)).toBe(1);
  });

  it('cloneWorkbook 深拷贝 cells Map（改副本不动原件）', () => {
    const original = budgetSheet();
    const clone = cloneWorkbook(original);
    (sheetOf(clone, '预算').cells as Map<string, CellValue>).set('B2', numberValue(7));
    expect(valueOf(original, '预算', 'B2')).toEqual(numberValue(100));
    expect(valueOf(clone, '预算', 'B2')).toEqual(numberValue(7));
  });
});

// ---------------------------------------------------------------------------
// 版本比较
// ---------------------------------------------------------------------------

describe('版本比较', () => {
  it('逐格列出增 / 删 / 改，并识别新增工作表', () => {
    let before = createSheet('预算', { row_count: 3, column_count: 3 });
    before = setCellValue(before, 'A1', textValue('项目'));
    before = setCellValue(before, 'B1', numberValue(10));
    const beforeBook = createWorkbook([before]);

    let after = createSheet('预算', { row_count: 3, column_count: 3 });
    after = setCellValue(after, 'A1', textValue('项目')); // 未变
    after = setCellValue(after, 'C1', numberValue(30)); // 新增
    const afterBook = createWorkbook([after, createSheet('说明')]);

    const diff = compareWorkbooks(beforeBook, afterBook);
    expect(diff.identical).toBe(false);
    const budget = diff.sheets.find((sheet) => sheet.name === '预算');
    expect(budget?.added).toEqual(['C1']);
    expect(budget?.removed).toEqual(['B1']);
    expect(budget?.changed).toEqual([]);
    const note = diff.sheets.find((sheet) => sheet.name === '说明');
    expect(note?.before_exists).toBe(false);
    expect(note?.after_exists).toBe(true);
  });

  it('改动被识别为 changed 并带上前后取值', () => {
    const before = createWorkbook([setCellValue(createSheet('S'), 'A1', numberValue(1))]);
    const after = createWorkbook([setCellValue(createSheet('S'), 'A1', numberValue(2))]);
    const diff = compareWorkbooks(before, after);
    const sheet = diff.sheets[0];
    expect(sheet?.changed).toHaveLength(1);
    expect(sheet?.changed[0]?.ref).toBe('A1');
    expect(sheet?.changed[0]?.before).toEqual(numberValue(1));
    expect(sheet?.changed[0]?.after).toEqual(numberValue(2));
  });

  it('取值相同（含空白）不算变化：identical 为真', () => {
    const before = createWorkbook([setCellValue(createSheet('S'), 'A1', textValue('x'))]);
    let same = setCellValue(createSheet('S'), 'A1', textValue('x'));
    same = setCellValue(same, 'B1', numberValue(5));
    const after = createWorkbook([same]);
    // before 无 B1（读到 blank），after 有 B1=5 ⇒ 有变化
    expect(compareWorkbooks(before, after).identical).toBe(false);
    expect(compareWorkbooks(before, before).identical).toBe(true);
    // 把 B1 设成同一空白值 ⇒ 仍视为相同
    const cleared = createWorkbook([setCellValue(createSheet('S'), 'A1', textValue('x'))]);
    expect(compareWorkbooks(before, cleared).identical).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 并发冲突检测
// ---------------------------------------------------------------------------

describe('并发冲突检测', () => {
  it('乐观并发：版本不一致 ⇒ stale_write', () => {
    expect(detectStaleWrite(3, 3)).toEqual({ ok: true });
    const stale = detectStaleWrite(3, 4);
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.reason).toBe('stale_write');
      expect(stale.expected).toBe(3);
      expect(stale.current).toBe(4);
    }
  });

  it('三路合并：两方改了同一格且不同 ⇒ 冲突（不静默覆盖）', () => {
    const base = createWorkbook([setCellValue(createSheet('预算'), 'B2', numberValue(100))]);
    const mine = createWorkbook([setCellValue(createSheet('预算'), 'B2', numberValue(200))]);
    const theirs = createWorkbook([setCellValue(createSheet('预算'), 'B2', numberValue(300))]);

    // 反向对照：朴素的"最后写入者赢"会静默丢掉 200。
    const naiveLastWriteWins = valueOf(theirs, '预算', 'B2');
    expect(naiveLastWriteWins).toEqual(numberValue(300));

    const merged = mergeWorkbooks(base, mine, theirs);
    expect(merged.ok).toBe(false);
    if (!merged.ok && merged.reason === 'conflict') {
      expect(merged.conflicts).toHaveLength(1);
      expect(merged.conflicts[0]?.sheet).toBe('预算');
      expect(merged.conflicts[0]?.ref).toBe('B2');
      expect(merged.conflicts[0]?.mine).toEqual(numberValue(200));
      expect(merged.conflicts[0]?.theirs).toEqual(numberValue(300));
    } else {
      throw new Error('应当报告冲突');
    }
  });

  it('非冲突改动可自动合并（两方各改一格）', () => {
    const base = createWorkbook([setCellValue(setCellValue(createSheet('预算'), 'B2', numberValue(100)), 'C2', numberValue(1))]);
    const mine = createWorkbook([setCellValue(setCellValue(createSheet('预算'), 'B2', numberValue(200)), 'C2', numberValue(1))]);
    const theirs = createWorkbook([setCellValue(setCellValue(createSheet('预算'), 'B2', numberValue(100)), 'C2', numberValue(5))]);
    const merged = mergeWorkbooks(base, mine, theirs);
    expect(merged.ok).toBe(true);
    if (merged.ok) {
      expect(valueOf(merged.workbook, '预算', 'B2')).toEqual(numberValue(200));
      expect(valueOf(merged.workbook, '预算', 'C2')).toEqual(numberValue(5));
      expect(merged.merged_cells).toBe(2);
    }
  });

  it('两方改成同一值 ⇒ 不算冲突', () => {
    const base = createWorkbook([setCellValue(createSheet('S'), 'A1', numberValue(1))]);
    const mine = createWorkbook([setCellValue(createSheet('S'), 'A1', numberValue(9))]);
    const theirs = createWorkbook([setCellValue(createSheet('S'), 'A1', numberValue(9))]);
    const merged = mergeWorkbooks(base, mine, theirs);
    expect(merged.ok).toBe(true);
    if (merged.ok) expect(valueOf(merged.workbook, 'S', 'A1')).toEqual(numberValue(9));
  });

  it('表集合不一致 ⇒ sheet_set_mismatch（不猜表级合并）', () => {
    const base = createWorkbook([createSheet('S')]);
    const mine = createWorkbook([createSheet('S')]);
    const theirs = createWorkbook([createSheet('S'), createSheet('T')]);
    const merged = mergeWorkbooks(base, mine, theirs);
    expect(merged.ok).toBe(false);
    if (!merged.ok) expect(merged.reason).toBe('sheet_set_mismatch');
  });
});

// ---------------------------------------------------------------------------
// 金额精度 / 单位 / 缺失不当零 / 独立复算
// ---------------------------------------------------------------------------

describe('金额精度（定点，不得浮点漂移）', () => {
  it('0.1 + 0.2 == 0.30（定点相加）', () => {
    const sum = recomputeBudget([
      { ref: 'B2', amount: money('0.1') },
      { ref: 'B3', amount: money('0.2') },
    ]);
    expect(sum.ok).toBe(true);
    if (sum.ok) {
      expect(formatQuantity(sum.total)).toBe('0.30');
      expect(sum.total.amount_minor).toBe(30n);
    }
  });

  it('反向对照：同样的 0.1 + 0.2 走浮点会漂移，本模块拒绝把漂移结果当数', () => {
    expect(0.1 + 0.2).not.toBe(0.3); // 浮点事实
    expect(0.1 * 3).toBe(0.30000000000000004); // 浮点事实
    expect(() => parseQuantity(0.1 + 0.2, 2, 'CNY')).toThrow(/小数位超出精度/);
    // 同样的 0.1 加三次：定点路径不给浮点漂移留口子
    const tenths = recomputeBudget([
      { ref: 'a', amount: money('0.1') },
      { ref: 'b', amount: money('0.1') },
      { ref: 'c', amount: money('0.1') },
    ]);
    if (tenths.ok) expect(formatQuantity(tenths.total)).toBe('0.30');
    else throw new Error('应当可复算');
    // 19.99 × 3 也不经浮点
    const perItem = money('19.99');
    const total = recomputeBudget([
      { ref: 'a', amount: perItem },
      { ref: 'b', amount: perItem },
      { ref: 'c', amount: perItem },
    ]);
    if (total.ok) expect(formatQuantity(total.total)).toBe('59.97');
    else throw new Error('应当可复算');
  });

  it('回归：把定点量误当预算项传入时，诊断信息不因 BigInt 崩溃', () => {
    // 直接传 Quantity（没有 ref）是调用方错误；此处只要求**错误信息可读**，
    // 而不是被 JSON.stringify(BigInt) 的 TypeError 盖掉真正原因。
    expect(() => recomputeBudget([money('0.1')] as unknown as BudgetItem[])).toThrow(/非法预算项/);
  });
});

describe('单位', () => {
  it('跨单位 / 跨币种求和 ⇒ unit_mismatch，不硬加', () => {
    const outcome = recomputeBudget([
      { ref: 'B2', amount: money('100', 'CNY') },
      { ref: 'B3', amount: parseQuantity('5', 2, 'kg') },
    ]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.reason === 'unit_mismatch') {
      expect(outcome.message).toContain('不一致');
    } else {
      throw new Error('应当报单位不一致');
    }
  });

  it('反向对照：朴素的数值相加会把跨单位当成 105 —— 正是本模块要拦的静默错误', () => {
    const naive = 100 + 5;
    expect(naive).toBe(105);
    const outcome = recomputeBudget([
      { ref: 'B2', amount: money('100', 'CNY') },
      { ref: 'B3', amount: parseQuantity('5', 2, 'kg') },
    ]);
    expect(outcome.ok).toBe(false);
  });

  it('币种不同也算不一致（CNY vs USD）', () => {
    const outcome = recomputeBudget([
      { ref: 'B2', amount: money('10', 'CNY') },
      { ref: 'B3', amount: parseQuantity('10', 2, 'USD') },
    ]);
    expect(outcome.ok).toBe(false);
  });
});

describe('缺失不当零', () => {
  it('有缺失项 ⇒ missing_values 并列出引用，绝不把缺失当 0', () => {
    const items: BudgetItem[] = [
      { ref: 'B2', amount: money('100') },
      { ref: 'B3', amount: null },
      { ref: 'B4', amount: null },
    ];
    const outcome = recomputeBudget(items);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.reason === 'missing_values') {
      expect(outcome.missing).toEqual(['B3', 'B4']);
    } else {
      throw new Error('应当报缺失');
    }
  });

  it('反向对照：把缺失当 0 参与求和会给出 100（一个看着像结果的数）', () => {
    const items: BudgetItem[] = [
      { ref: 'B2', amount: money('100') },
      { ref: 'B3', amount: null },
    ];
    const naiveSumTreatingMissingAsZero = items.reduce(
      (accumulator, item) => accumulator + (item.amount === null ? 0 : Number(formatQuantity(item.amount))),
      0,
    );
    expect(naiveSumTreatingMissingAsZero).toBe(100);
    expect(recomputeBudget(items).ok).toBe(false); // 我们的实现捕获
    expect(sumBudgetOrNull(items)).toBeNull(); // 不给一个看着像结果的数
  });

  it('空列表 ⇒ empty（不是 0）', () => {
    const outcome = recomputeBudget([]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('empty');
  });
});

describe('关键预算独立复算', () => {
  it('存下来的合计与逐项复算一致 ⇒ matches: true', () => {
    const items: BudgetItem[] = [
      { ref: 'B2', amount: money('19.99') },
      { ref: 'B3', amount: money('10.01') },
    ];
    const result = verifyBudget(money('30.00'), items);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.matches).toBe(true);
      expect(formatQuantity(result.recomputed)).toBe('30.00');
    }
  });

  it('反向对照：存下来的合计被改花 ⇒ matches: false（独立复算抓得住）', () => {
    const items: BudgetItem[] = [
      { ref: 'B2', amount: money('20.00') },
      { ref: 'B3', amount: money('10.00') },
    ];
    const result = verifyBudget(money('29.99'), items);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.matches).toBe(false);
      expect(formatQuantity(result.recomputed)).toBe('30.00');
    }
  });

  it('复算不可得（缺失）⇒ 不声称 matches', () => {
    const result = verifyBudget(money('100.00'), [
      { ref: 'B2', amount: money('100.00') },
      { ref: 'B3', amount: null },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not_computable');
      expect(result.detail.ok).toBe(false);
    }
  });

  it('单位对不上 ⇒ matches: false（不因单位不同而抛）', () => {
    const result = verifyBudget(parseQuantity('30', 2, 'kg'), [
      { ref: 'B2', amount: money('30.00') },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.matches).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 版本时间线 / 恢复到任意版本（XLS-17 的"版本与恢复"）
// ---------------------------------------------------------------------------

/**
 * 夹具：三次提交得到版本 0..3，各改一格（值即标签），便于逐版核对取值：
 * v1 改 A2、v2 改 B2、v3 改 C2；rev0 时 A2 空、B2=100、C2 空。
 */
function threeVersionHistory(): HistoryState {
  let history = createHistory(budgetSheet(), 'v0');
  const steps: readonly (readonly [string, string])[] = [
    ['v1', 'A2'],
    ['v2', 'B2'],
    ['v3', 'C2'],
  ];
  for (const [label, ref] of steps) {
    const outcome = commit(history, label, (workbook) => setIn(workbook, '预算', ref, textValue(label)));
    if (!outcome.ok) throw new Error(`夹具提交 ${label} 失败：${outcome.error.message}`);
    history = outcome.history;
  }
  return history;
}

describe('版本时间线 / 恢复到任意版本', () => {
  it('versionTimeline 从旧到新列出 past / present / future 及其位置', () => {
    // 三次提交后撤销两步：present=rev1，past=[rev0]，future=[rev2, rev3]
    let history = threeVersionHistory();
    history = undoSteps(history, 2);
    expect([...versionTimeline(history)].map((entry) => [entry.revision, entry.position])).toEqual([
      [0, 'past'],
      [1, 'present'],
      [2, 'future'],
      [3, 'future'],
    ]);
    expect(versionTimeline(history).map((entry) => entry.label)).toEqual(['v0', 'v1', 'v2', 'v3']);
    expect(currentSnapshot(history).revision).toBe(1);
  });

  it('knownRevisions 升序且含未来版本；revisionOf 与 currentRevision 同口径', () => {
    let history = threeVersionHistory();
    history = undoSteps(history, 2);
    expect(knownRevisions(history)).toEqual([0, 1, 2, 3]);
    expect(revisionOf(history)).toBe(1);
    expect(revisionOf(history)).toBe(currentRevision(history));
  });

  it('restoreAt 回到任意过去版本：被越过的版本进入 future，仍可重做', () => {
    const history = threeVersionHistory(); // present=rev3
    const at0 = restoreAt(history, 0);
    expect(currentRevision(at0)).toBe(0);
    expect(canUndo(at0)).toBe(false);
    expect(redoDepth(at0)).toBe(3); // rev1/rev2/rev3 全在 future
    // 逐版取值核查：rev0 的 A2 还是初始空白
    expect(valueOf(currentWorkbook(at0), '预算', 'A2')).toEqual(blank);
    expect(valueOf(currentWorkbook(at0), '预算', 'B2')).toEqual(numberValue(100));

    const at1 = restoreAt(history, 1);
    expect(currentRevision(at1)).toBe(1);
    expect(valueOf(currentWorkbook(at1), '预算', 'A2')).toEqual(textValue('v1'));
    expect(valueOf(currentWorkbook(at1), '预算', 'B2')).toEqual(numberValue(100));
    expect(undoDepth(at1)).toBe(1);
    expect(redoDepth(at1)).toBe(2);
  });

  it('restoreAt past<->future 双向跳转，全部快照一个不丢', () => {
    const history = threeVersionHistory();
    const at0 = restoreAt(history, 0);
    const backTo3 = restoreAt(at0, 3); // 从"未来"取回最新版
    expect(currentRevision(backTo3)).toBe(3);
    expect(canRedo(backTo3)).toBe(false);
    expect(valueOf(currentWorkbook(backTo3), '预算', 'C2')).toEqual(textValue('v3'));

    const at1 = restoreAt(backTo3, 1); // 再跳回中间版本
    expect(currentRevision(at1)).toBe(1);
    expect(valueOf(currentWorkbook(at1), '预算', 'A2')).toEqual(textValue('v1'));
    expect(valueOf(currentWorkbook(at1), '预算', 'C2')).toEqual(blank);
    expect(knownRevisions(at1)).toEqual([0, 1, 2, 3]); // 快照一个不丢
  });

  it('restoreAt 到当前版本 ⇒ 时间线原样（no-op）', () => {
    let history = threeVersionHistory();
    history = undoSteps(history, 1); // present=rev2，future=[rev3]
    const same = restoreAt(history, 2);
    expect(versionTimeline(same)).toEqual(versionTimeline(history));
    expect(currentRevision(same)).toBe(2);
  });

  it('restoreAt 未知 / 非法版本 ⇒ 显式失败（不就近套用）', () => {
    const history = threeVersionHistory();
    expect(() => restoreAt(history, 99)).toThrow(/不在本时间线内/);
    expect(() => restoreAt(history, -1)).toThrow(/非负整数/);
    expect(() => restoreAt(history, 1.5)).toThrow(/非负整数/);
  });

  it('restoreAt 后提交清空 future（不留分叉），版本号从恢复点继续递增', () => {
    const at1 = restoreAt(threeVersionHistory(), 1);
    const outcome = commit(at1, 'v1b', (workbook) => setIn(workbook, '预算', 'C2', textValue('v1b')));
    expect(outcome.ok).toBe(true);
    const next = outcome.history;
    expect(currentRevision(next)).toBe(2); // rev1 + 1
    expect(canRedo(next)).toBe(false);
    expect(knownRevisions(next)).toEqual([0, 1, 2]); // 旧 future 的 rev2/rev3 不复存在
    expect(versionTimeline(next).map((entry) => entry.position)).toEqual(['past', 'past', 'present']);
    expect(valueOf(currentWorkbook(next), '预算', 'A2')).toEqual(textValue('v1'));
    expect(valueOf(currentWorkbook(next), '预算', 'C2')).toEqual(textValue('v1b'));
  });

  it('反向对照：撤销只回一步，但时间线仍保留全部快照（restoreAt 的判据）；朴素"砍掉未来"会丢版本', () => {
    const history = undo(threeVersionHistory());
    expect(currentRevision(history)).toBe(2);
    expect(knownRevisions(history)).toEqual([0, 1, 2, 3]);
    expect(canRedo(history)).toBe(true);
    const redone = redo(history);
    expect(currentRevision(redone)).toBe(3);
    expect(valueOf(currentWorkbook(redone), '预算', 'C2')).toEqual(textValue('v3'));
  });

  it('恢复只移动指针并共享快照对象；要就地改写须先 cloneWorkbook（历史自身改不动）', () => {
    const history = threeVersionHistory();
    const at1 = restoreAt(history, 1);
    // 设计：restoreAt 只移动"现在"的指针，present 就是历史里那份快照本身（不复制），
    // 因此"跳到旧版 → 又能跳回被越过的版本"成立、快照一个不丢。
    expect(at1.present).toBe(history.past[1]);
    // 需要就地改写的调用方必须先克隆：cloneWorkbook 是隔离的出口。
    const safe = cloneWorkbook(currentWorkbook(at1));
    (sheetOf(safe, '预算').cells as Map<string, CellValue>).set('A2', textValue('篡改'));
    expect(valueOf(safe, '预算', 'A2')).toEqual(textValue('篡改'));
    expect(valueOf(currentWorkbook(restoreAt(history, 1)), '预算', 'A2')).toEqual(textValue('v1'));
  });

  it('反向对照：commit 的改写函数拿到草稿深拷贝，直接写草稿 Map 也污染不了历史', () => {
    const history = threeVersionHistory(); // present=rev3，A2 自 v1 起一直是 "v1"
    const outcome = commit(history, '草稿就地改写', (workbook) => {
      (sheetOf(workbook, '预算').cells as Map<string, CellValue>).set('A2', textValue('草稿'));
      return workbook;
    });
    expect(outcome.ok).toBe(true);
    expect(valueOf(currentWorkbook(history), '预算', 'A2')).toEqual(textValue('v1'));
    expect(valueOf(currentWorkbook(outcome.history), '预算', 'A2')).toEqual(textValue('草稿'));
  });
});
