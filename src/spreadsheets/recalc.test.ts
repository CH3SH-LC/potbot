/**
 * `recalc.ts` 的单元测试（design-06-P8 / XLS-08）。
 *
 * XLS-08 的四句话在这里各有一组用例：
 * 1. **修改数据后公式重算**（改 A1 ⇒ 整条依赖链跟着变）；
 * 2. **依赖顺序（拓扑排序）**（顺序本身被断言，且 `verifyOrder` 给出机器可核的证据）；
 * 3. **循环引用与错误值**（环**不产出数值**；`#DIV/0!` / `#REF!` 沿依赖链传播）；
 * 4. **缓存和公式一致**（`checkFormulaCache` 能把漂移的缓存指认出来）。
 *
 * 反向对照（防假绿）：
 * - "循环引用却算出一个数"：环里三个格子必须 `ok: false`，而**同一簿里的无环格子必须算出数**
 *   ——证明是"识别出环"，不是"整簿一律阻塞"；
 * - "未知函数却返回 0"：`NOSUCHFN(1)` 必须阻塞，**不得**是 `numberValue(0)`；
 * - "不支持的公式被改写"：重算后单元格文本必须**逐字未变**。
 */

import { describe, expect, it } from 'vitest';

import { extractFormulaReferences } from './formula.js';
import {
  buildDependencyGraph,
  cellKey,
  checkFormulaCache,
  dependentClosure,
  dependencyOrder,
  directDependents,
  outcomesEqual,
  parseCellKey,
  recalcWorkbook,
  scanDependencyTargets,
  verifyOrder,
  type CellKey,
} from './recalc.js';
import { createSheet, getCellValue, setCellValue, type SheetState } from './sheet.js';
import { createWorkbook, getSheet, type WorkbookState } from './workbook.js';
import {
  errorValue,
  formulaValue,
  numberValue,
  textValue,
  type CellValue,
} from './value.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function sheetWith(name: string, cells: Record<string, CellValue>): SheetState {
  let sheet = createSheet(name);
  for (const [ref, value] of Object.entries(cells)) {
    sheet = setCellValue(sheet, ref, value);
  }
  return sheet;
}

function mustSheet(workbook: WorkbookState, name: string): SheetState {
  const sheet = getSheet(workbook, name);
  if (sheet === undefined) {
    throw new Error(`夹具里没有工作表 ${name}`);
  }
  return sheet;
}

function replaceSheet(workbook: WorkbookState, name: string, sheet: SheetState): WorkbookState {
  return Object.freeze({
    ...workbook,
    sheets: Object.freeze(workbook.sheets.map((item) => (item.name === name ? sheet : item))),
  });
}

/**
 * 主夹具（`Sheet1`）：
 *
 * - 数据 `A1..A3 = 1,2,3`；
 * - 依赖链 `A1 → B1 → B2`、`A1:A3 → B3`、`B1:B3 → B4`、`B1..B4 → C1`；
 * - 环 `D1 ↔ D2`、自环 `E1`；
 * - 错误链 `F1 = 1/0 → F2`、`G1 = INDEX(...,9) → G2`；
 * - 未知函数 `H1 → H2`；
 * - 扩展函数 `I1 = SUMIF(...) → I2`；
 * - `TODAY()` 需要注入 `J1`；
 * - 语法过不去 `K1`（依赖未知）。
 */
function buildWorkbook(): WorkbookState {
  const first = sheetWith('Sheet1', {
    A1: numberValue(1),
    A2: numberValue(2),
    A3: numberValue(3),
    B1: formulaValue('A1+A2'),
    B2: formulaValue('B1*2'),
    B3: formulaValue('SUM(A1:A3)'),
    B4: formulaValue('SUM(B1:B3)'),
    C1: formulaValue('B1+B2+B3+B4'),
    D1: formulaValue('D2+1'),
    D2: formulaValue('D1+1'),
    E1: formulaValue('E1+1'),
    F1: formulaValue('1/0'),
    F2: formulaValue('F1+1'),
    G1: formulaValue('INDEX(A1:A3, 9)'),
    G2: formulaValue('G1+1'),
    H1: formulaValue('NOSUCHFN(1)'),
    H2: formulaValue('H1+1'),
    I1: formulaValue('SUMIF(A1:A3, ">1")'),
    I2: formulaValue('I1*2'),
    J1: formulaValue('TODAY()'),
    K1: formulaValue('SUM(A1,'),
  });
  const second = sheetWith('Sheet2', {
    A1: formulaValue('Sheet1!A1*10'),
    A2: formulaValue('Sheet2!A1+1'),
  });
  return createWorkbook([first, second]);
}

function outcomeOf(workbook: WorkbookState, key: CellKey) {
  const report = recalcWorkbook(workbook);
  const outcome = report.values.get(key);
  if (outcome === undefined) {
    throw new Error(`没有 ${key} 的求值结论`);
  }
  return outcome;
}

function valueOf(workbook: WorkbookState, key: CellKey): CellValue {
  const outcome = outcomeOf(workbook, key);
  if (!outcome.ok) {
    throw new Error(`${key} 被阻塞：${outcome.reason} ${outcome.detail}`);
  }
  return outcome.value;
}

function reasonOf(workbook: WorkbookState, key: CellKey): string {
  const outcome = outcomeOf(workbook, key);
  if (outcome.ok) {
    throw new Error(`${key} 没有被阻塞，算出了 ${JSON.stringify(outcome.value)}`);
  }
  return outcome.reason;
}

const WORKBOOK = buildWorkbook();

// ---------------------------------------------------------------------------
// 1. 依赖图与拓扑排序
// ---------------------------------------------------------------------------

describe('recalc：依赖图（引用抓取走 AST，不走正则）', () => {
  it('引用目标是引用节点与区域节点；含字符串字面量的公式同样抓得到', () => {
    expect(scanDependencyTargets('IF(A1>0,"是",B1)')).toHaveLength(2);
    expect(scanDependencyTargets('SUM(A1:A3)')).toEqual([
      {
        sheet: null,
        start: { column: 1, row: 1, abs_column: false, abs_row: false },
        end: { column: 1, row: 3, abs_column: false, abs_row: false },
      },
    ]);
    expect(scanDependencyTargets('Sheet2!$A$1*2')).toEqual([
      {
        sheet: 'Sheet2',
        start: { column: 1, row: 1, abs_column: true, abs_row: true },
        end: { column: 1, row: 1, abs_column: true, abs_row: true },
      },
    ]);
    // 对照：既有 `formula.ts` 的抽取器对**含双引号的公式**一律返回 null（它服务于引用迁移，
    // 口径更保守）；本模块必须用 AST，否则 IF 里的引用会被漏掉。
    expect(extractFormulaReferences('IF(A1>0,"是",B1)')).toBeNull();
    expect(scanDependencyTargets('SUM(')).toBeNull();
  });

  it('只把**本 / 他表的公式格**连成边（数据格不是节点）', () => {
    const graph = buildDependencyGraph(WORKBOOK);
    expect(graph.keys).toContain('Sheet1!B1');
    expect(graph.keys).not.toContain('Sheet1!A1'); // 数据格没有节点
    expect(graph.dependencies.get('Sheet1!B1')).toEqual([]); // 只引用数据格
    expect(graph.dependencies.get('Sheet1!B2')).toEqual(['Sheet1!B1']);
    expect(graph.dependencies.get('Sheet1!B4')).toEqual(['Sheet1!B1', 'Sheet1!B2', 'Sheet1!B3']);
    expect(graph.dependencies.get('Sheet1!C1')).toEqual(['Sheet1!B1', 'Sheet1!B2', 'Sheet1!B3', 'Sheet1!B4']);
    expect(graph.dependencies.get('Sheet1!E1')).toEqual(['Sheet1!E1']); // 自环
    expect(graph.dependencies.get('Sheet2!A2')).toEqual(['Sheet2!A1']);
  });

  it('语法过不去的公式：依赖未知（登记），但不影响它自己必然阻塞', () => {
    const graph = buildDependencyGraph(WORKBOOK);
    expect([...graph.unparsed.keys()]).toEqual(['Sheet1!K1']);
    expect(graph.dependencies.get('Sheet1!K1')).toEqual([]);
    expect(reasonOf(WORKBOOK, 'Sheet1!K1')).toBe('parse_error');
  });

  it('拓扑序：依赖一定在前，且自检为空', () => {
    const graph = buildDependencyGraph(WORKBOOK);
    const { order, cycles } = dependencyOrder(graph);
    const at = (key: CellKey): number => order.indexOf(key);
    expect(at('Sheet1!B1')).toBeLessThan(at('Sheet1!B2'));
    expect(at('Sheet1!B3')).toBeLessThan(at('Sheet1!B4'));
    expect(at('Sheet1!B1')).toBeLessThan(at('Sheet1!B4'));
    expect(at('Sheet1!B4')).toBeLessThan(at('Sheet1!C1'));
    expect(at('Sheet1!F1')).toBeLessThan(at('Sheet1!F2'));
    expect(at('Sheet2!A1')).toBeLessThan(at('Sheet2!A2'));
    expect(verifyOrder(graph, order)).toEqual([]);
    // 环内节点**不在**顺序里（它们的结局是阻塞，不是"算出来"）。
    for (const key of ['Sheet1!D1', 'Sheet1!D2', 'Sheet1!E1']) {
      expect(order).not.toContain(key);
    }
    expect(cycles).toHaveLength(2);
  });

  it('依赖环被识别成 SCC（互相引用的两个、自引用的一个）', () => {
    const { cycles } = dependencyOrder(buildDependencyGraph(WORKBOOK));
    const rendered = cycles.map((cycle) => [...cycle].sort()).sort((a, b) => a.length - b.length);
    expect(rendered).toEqual([['Sheet1!E1'], ['Sheet1!D1', 'Sheet1!D2']]);
  });

  it('verifyOrder 是**真的**在检查（对照：故意给出逆序 ⇒ 必须报违规）', () => {
    const graph = buildDependencyGraph(WORKBOOK);
    const { order } = dependencyOrder(graph);
    const reversed = [...order].reverse();
    expect(verifyOrder(graph, reversed).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 2. 重算取值
// ---------------------------------------------------------------------------

describe('recalc：重算取值', () => {
  it('整条依赖链算对（含跨表）', () => {
    expect(valueOf(WORKBOOK, 'Sheet1!B1')).toEqual(numberValue(3));
    expect(valueOf(WORKBOOK, 'Sheet1!B2')).toEqual(numberValue(6));
    expect(valueOf(WORKBOOK, 'Sheet1!B3')).toEqual(numberValue(6));
    expect(valueOf(WORKBOOK, 'Sheet1!B4')).toEqual(numberValue(15));
    expect(valueOf(WORKBOOK, 'Sheet1!C1')).toEqual(numberValue(30));
    expect(valueOf(WORKBOOK, 'Sheet2!A1')).toEqual(numberValue(10));
    expect(valueOf(WORKBOOK, 'Sheet2!A2')).toEqual(numberValue(11));
  });

  it('扩展函数（XLS-07）参与重算链', () => {
    expect(valueOf(WORKBOOK, 'Sheet1!I1')).toEqual(numberValue(5)); // SUMIF(A1:A3, ">1") = 2+3
    expect(valueOf(WORKBOOK, 'Sheet1!I2')).toEqual(numberValue(10));
  });

  it('TODAY()：注入当前日期才算得出，未注入则阻塞', () => {
    expect(reasonOf(WORKBOOK, 'Sheet1!J1')).toBe('unsupported_construct');
    const injected = recalcWorkbook(WORKBOOK, { today_serial: 45366 });
    expect(injected.values.get('Sheet1!J1')).toEqual({ ok: true, value: numberValue(45366) });
  });
});

// ---------------------------------------------------------------------------
// 3. 修改数据后重算
// ---------------------------------------------------------------------------

describe('recalc：修改数据后公式重算', () => {
  it('改 A1 ⇒ 依赖链整体跟着变', () => {
    const before = recalcWorkbook(WORKBOOK);
    expect(before.values.get('Sheet1!B1')).toEqual({ ok: true, value: numberValue(3) });

    const sheet = mustSheet(WORKBOOK, 'Sheet1');
    const changed = replaceSheet(WORKBOOK, 'Sheet1', setCellValue(sheet, 'A1', numberValue(10)));
    const after = recalcWorkbook(changed);

    expect(after.values.get('Sheet1!B1')).toEqual({ ok: true, value: numberValue(12) });
    expect(after.values.get('Sheet1!B2')).toEqual({ ok: true, value: numberValue(24) });
    expect(after.values.get('Sheet1!B3')).toEqual({ ok: true, value: numberValue(15) });
    expect(after.values.get('Sheet1!B4')).toEqual({ ok: true, value: numberValue(51) });
    expect(after.values.get('Sheet1!C1')).toEqual({ ok: true, value: numberValue(102) });
    expect(after.values.get('Sheet2!A1')).toEqual({ ok: true, value: numberValue(100) });
    expect(after.values.get('Sheet2!A2')).toEqual({ ok: true, value: numberValue(101) });
    // 与 A1 无关的公式不受影响。
    expect(after.values.get('Sheet1!F1')).toEqual({ ok: true, value: errorValue('#DIV/0!') });
  });

  it('dependentClosure：改一个**数据格**也能定位到全部受影响的公式格', () => {
    const graph = buildDependencyGraph(WORKBOOK);
    expect(directDependents(graph, 'Sheet1!A1')).toEqual([
      'Sheet1!B1',
      'Sheet1!B3',
      'Sheet1!G1',
      'Sheet1!I1',
      'Sheet2!A1',
    ]);
    expect(dependentClosure(graph, ['Sheet1!A1'])).toEqual(
      [
        'Sheet1!B1',
        'Sheet1!B2',
        'Sheet1!B3',
        'Sheet1!B4',
        'Sheet1!C1',
        'Sheet1!G1',
        'Sheet1!G2',
        'Sheet1!I1',
        'Sheet1!I2',
        'Sheet2!A1',
        'Sheet2!A2',
      ].sort(),
    );
  });

  it('dependentClosure：不相干的公式**不被**牵进来（精度对照）', () => {
    const graph = buildDependencyGraph(WORKBOOK);
    const closure = dependentClosure(graph, ['Sheet1!A1']);
    for (const key of ['Sheet1!F1', 'Sheet1!F2', 'Sheet1!H1', 'Sheet1!H2', 'Sheet1!J1', 'Sheet1!D1']) {
      expect(closure).not.toContain(key);
    }
    expect(dependentClosure(graph, ['Sheet1!C1'])).toEqual(['Sheet1!C1']);
  });
});

// ---------------------------------------------------------------------------
// 4. 循环引用与错误值
// ---------------------------------------------------------------------------

describe('recalc：循环引用', () => {
  it('**环里的格子绝不产出数值**（反向对照）', () => {
    const report = recalcWorkbook(WORKBOOK);
    for (const key of ['Sheet1!D1', 'Sheet1!D2', 'Sheet1!E1']) {
      const outcome = report.values.get(key);
      expect(outcome?.ok, `${key} 不该算出任何东西`).toBe(false);
      expect(outcome?.ok ? '' : outcome?.reason).toBe('circular_reference');
      // 反向对照：不许出现任何"看起来像结果"的数值。
      expect(outcome).not.toEqual({ ok: true, value: numberValue(7) });
      expect(outcome).not.toEqual({ ok: true, value: numberValue(0) });
    }
    expect(report.cycles).toHaveLength(2);
  });

  it('同一簿里的**无环**格子照常算出数（证明是识别环，不是一律阻塞）', () => {
    const report = recalcWorkbook(WORKBOOK);
    expect(report.values.get('Sheet1!B1')).toEqual({ ok: true, value: numberValue(3) });
    expect(report.blocked.some((entry) => entry.reason === 'circular_reference')).toBe(true);
    expect(report.blocked.some((entry) => entry.reason === 'unsupported_function')).toBe(true);
  });

  it('环的 detail 里能看出环成员（阻塞可被指认，不是黑箱）', () => {
    const report = recalcWorkbook(WORKBOOK);
    const entry = report.blocked.find((item) => item.key === 'Sheet1!D1');
    expect(entry?.detail).toContain('Sheet1!D1');
    expect(entry?.detail).toContain('Sheet1!D2');
  });
});

describe('recalc：错误值传播（#DIV/0! / #REF! / 未知函数）', () => {
  it('#DIV/0! 沿依赖链传播（不是变成 0）', () => {
    expect(valueOf(WORKBOOK, 'Sheet1!F1')).toEqual(errorValue('#DIV/0!'));
    expect(valueOf(WORKBOOK, 'Sheet1!F2')).toEqual(errorValue('#DIV/0!'));
  });

  it('#REF! 由 INDEX 越界产生并传播', () => {
    expect(valueOf(WORKBOOK, 'Sheet1!G1')).toEqual(errorValue('#REF!'));
    expect(valueOf(WORKBOOK, 'Sheet1!G2')).toEqual(errorValue('#REF!'));
  });

  it('**未知函数不返回 0**：阻塞沿链向上传播（反向对照）', () => {
    expect(reasonOf(WORKBOOK, 'Sheet1!H1')).toBe('unsupported_function');
    expect(reasonOf(WORKBOOK, 'Sheet1!H2')).toBe('unsupported_function');
    expect(outcomeOf(WORKBOOK, 'Sheet1!H1')).not.toEqual({ ok: true, value: numberValue(0) });
    expect(outcomeOf(WORKBOOK, 'Sheet1!H2')).not.toEqual({ ok: true, value: numberValue(0) });
  });

  it('被阻塞的公式**不进入 values 的成功分支**：`ok: false` 的格没有数值可取', () => {
    const report = recalcWorkbook(WORKBOOK);
    for (const [key, outcome] of report.values) {
      if (outcome.ok) continue;
      expect(key.length).toBeGreaterThan(0);
      // 处于阻塞态就没有 value 字段可读——用类型层面的事实断言：
      expect('value' in outcome).toBe(false);
    }
  });
});

describe('recalc：不支持的公式保留原文（XLS-08「保留或阻塞」）', () => {
  it('重算后的工作簿与输入**同一个对象**：公式没被固化成数值', () => {
    const report = recalcWorkbook(WORKBOOK);
    expect(report.workbook).toBe(WORKBOOK);
    for (const key of ['Sheet1!H1', 'Sheet1!J1', 'Sheet1!K1', 'Sheet1!D1']) {
      const parsed = parseCellKey(key);
      const cell = getCellValue(mustSheet(report.workbook, parsed.sheet), parsed.ref);
      expect(cell.kind).toBe('formula');
    }
  });

  it('原文逐字未变（含语法过不去的那条）', () => {
    const report = recalcWorkbook(WORKBOOK);
    const parsed = parseCellKey('Sheet1!K1');
    expect(getCellValue(mustSheet(report.workbook, parsed.sheet), parsed.ref)).toEqual(
      formulaValue('SUM(A1,'),
    );
    const blockedEntry = report.blocked.find((item) => item.key === 'Sheet1!K1');
    expect(blockedEntry?.text).toBe('SUM(A1,');
    expect(blockedEntry?.reason).toBe('parse_error');
  });
});

// ---------------------------------------------------------------------------
// 5. 缓存与公式一致
// ---------------------------------------------------------------------------

describe('recalc：缓存和公式一致', () => {
  it('刚算出来的缓存必然一致（缓存就是在当前工作簿上算的）', () => {
    const report = recalcWorkbook(WORKBOOK);
    const check = checkFormulaCache(WORKBOOK, report.values);
    expect(check.consistent).toBe(true);
    expect(check.mismatches).toEqual([]);
  });

  it('**漂移的缓存被指认**（反向对照：篡改一格 ⇒ 必须不一致）', () => {
    const report = recalcWorkbook(WORKBOOK);
    const tampered = new Map(report.values);
    tampered.set('Sheet1!B1', { ok: true, value: numberValue(999) });
    const check = checkFormulaCache(WORKBOOK, tampered);
    expect(check.consistent).toBe(false);
    expect(check.mismatches.map((item) => item.key)).toEqual(['Sheet1!B1']);
    expect(check.mismatches[0]?.expected).toEqual({ ok: true, value: numberValue(3) });
  });

  it('缺格与多格都算不一致（缓存多出一条"幽灵公式"也要报）', () => {
    const report = recalcWorkbook(WORKBOOK);
    const missing = new Map(report.values);
    missing.delete('Sheet1!B3');
    expect(checkFormulaCache(WORKBOOK, missing).mismatches.map((item) => item.key)).toEqual(['Sheet1!B3']);

    const extra = new Map(report.values);
    extra.set('Sheet1!Z9', { ok: true, value: numberValue(1) });
    const extraCheck = checkFormulaCache(WORKBOOK, extra);
    expect(extraCheck.consistent).toBe(false);
    expect(extraCheck.mismatches.map((item) => item.key)).toEqual(['Sheet1!Z9']);
  });

  it('数据一改，旧缓存立刻不一致（这就是"要重算"的机器判据）', () => {
    const stale = recalcWorkbook(WORKBOOK).values;
    const sheet = mustSheet(WORKBOOK, 'Sheet1');
    const changed = replaceSheet(WORKBOOK, 'Sheet1', setCellValue(sheet, 'A1', numberValue(10)));
    const check = checkFormulaCache(changed, stale);
    expect(check.consistent).toBe(false);
    expect(check.mismatches.length).toBeGreaterThan(0);
    // 缓存里的 B1 = 3，新算出来是 12 ⇒ 指认的正是这一格。
    expect(check.mismatches.map((item) => item.key)).toContain('Sheet1!B1');
  });

  it('outcomesEqual：类别不同即不等（数字 3 与文本 "3" 不是一回事）', () => {
    expect(outcomesEqual({ ok: true, value: numberValue(3) }, { ok: true, value: numberValue(3) })).toBe(true);
    expect(outcomesEqual({ ok: true, value: numberValue(3) }, { ok: true, value: textValue('3') })).toBe(false);
    expect(
      outcomesEqual(
        { ok: false, reason: 'parse_error', detail: 'x' },
        { ok: false, reason: 'parse_error', detail: 'y' },
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. 键工具
// ---------------------------------------------------------------------------

describe('recalc：单元格键', () => {
  it('造键 / 拆键互逆（表名可含空格与非 ASCII）', () => {
    expect(cellKey('Sheet1', 'B3')).toBe('Sheet1!B3');
    expect(cellKey('预算 表', { column: 2, row: 4 })).toBe('预算 表!B4');
    expect(parseCellKey('预算 表!B4')).toEqual({
      sheet: '预算 表',
      ref: 'B4',
      address: { column: 2, row: 4 },
    });
    expect(() => cellKey('', 'A1')).toThrowError();
    expect(() => parseCellKey('A1')).toThrowError();
  });
});
