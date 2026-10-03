/**
 * P10 独立验收：**手机侧演示编辑会话**（PPT-01 / PPT-14 / PPT-16）。
 *
 * ## 这一批钉死什么
 *
 * - **事务**：`apply` 要么整体成功（版本 +1）要么原样失败（历史与模型摘要一字不变）；
 *   `undo` / `redo` 按步回放；版本对不上 ⇒ `stale_write` 而不是"最后写入者赢"。
 * - **同版事实**：正文 / 表格 / 图表三处的数值必须来自**同一版**事实。`set_fact_value`
 *   发布新版本并**原子地**把图表嵌入数据、表格字面量刷成同版；保存前门禁判定，
 *   **冲突即拒绝交付**（不静默取一处）。
 * - **保存 — 重开 — 再编辑**：`save` 出字节，`openSessionFromBytes` 读回成新会话继续编辑。
 *
 * ## 判据尽量**独立于待测模块**
 *
 * - 保存产物的字节用 `readZip` **独立解包**（不是听会话自报）：数 slide 部件、读文本；
 * - 保存回执里的 sha256 在**本文件里**用 `digestBytes` 独立重算比对；
 * - 模型的图表嵌入数据 / 表格字面量用**模型字段**直接读，不经会话的 `verify`；
 * - 冲突用例走 `syncPresentationFacts` 的**报告字段**（`kind` / `stale_version`）断言。
 *
 * ## 如实登记（**本文件不验证**的）
 *
 * 手机真机放映、Office / 演示消费端打开无修复提示、音视频播放——本批**均未验证**（无真机、
 * 无消费端）。本文件只到"模型层 + 字节层"。
 */

import { describe, expect, it } from 'vitest';

import { digestBytes } from '../../../../src/artifacts/digest.js';
import { readZip } from '../../../../src/artifacts/ooxml/index.js';
import {
  bodyText,
  chartFromFacts,
  factCell,
  factTextBody,
  versionedSnapshot,
  type FactBindings,
  type VersionedFactSnapshot,
} from '../../../../src/presentations/fact-sync.js';
import {
  MISSING_FACT_PLACEHOLDER,
  literalText,
  transform,
  type ChartShape,
  type Presentation,
  type TableShape,
} from '../../../../src/presentations/model.js';
import { addShape, addSlide } from '../../../../src/presentations/operations.js';
import { emptyPresentation } from '../../../../src/presentations/render.js';
import { findPlaceholders } from '../../../../src/presentations/undo-history.js';
import {
  PRESENTATION_SESSION_OPS,
  applySessionEdit,
  createPresentationSession,
  openSessionFromBytes,
  openSessionFromPresentation,
  redoSession,
  saveSession,
  sessionPresentation,
  sessionSummary,
  undoSession,
  verifySessionFacts,
  type SessionEditOutcome,
} from '../../../../src/mobile-plugins/presentations/session/index.js';

// ---------------------------------------------------------------------------
// 夹具（事实版本与演示模型）
// ---------------------------------------------------------------------------

const R1 = { task_id: 't1', task_revision: 1 } as const;
const R2 = { task_id: 't1', task_revision: 2 } as const;

const V1: VersionedFactSnapshot = versionedSnapshot(R1, [
  { fact_key: 'headcount', fact_ref: 'fact.headcount.r1', value: { type: 'number', amount: 8, unit: '人', currency: null } },
]);
const V2: VersionedFactSnapshot = versionedSnapshot(R2, [
  { fact_key: 'headcount', fact_ref: 'fact.headcount.r2', value: { type: 'number', amount: 12, unit: '人', currency: null } },
]);

const HEADCOUNT_BINDINGS: FactBindings = {
  chart: [{ shape_id: 4, series: [{ name: '人数', fact_keys: ['headcount'] }] }],
  table: [{ shape_id: 3, cells: [{ row: 0, column: 0, fact_key: 'headcount' }] }],
};

function addOneSlide(presentation: Presentation): { presentation: Presentation; slideId: number } {
  const added = addSlide(presentation);
  return { presentation: added.presentation, slideId: added.slide_id };
}

/**
 * 一页：正文 fact run + 表格（字面量为 `tableLiteral`）+ 图表（嵌入数据为 `chartValue`）。
 * 三处都指向事实键 `headcount`，便于"同版一致"的判定。
 */
function deck(opts: {
  readonly tableLiteral: string;
  readonly chartValue: number;
}): { presentation: Presentation; bindings: FactBindings } {
  let presentation = emptyPresentation('p1', '同版事实演示');
  const added = addOneSlide(presentation);
  presentation = added.presentation;
  const slideId = added.slideId;

  presentation = addShape(presentation, slideId, {
    kind: 'text_box',
    shape_id: 2,
    name: '正文',
    transform: transform(0, 0, 4000000, 1000000),
    text: factTextBody('headcount'),
  });
  const table: TableShape = {
    kind: 'table',
    shape_id: 3,
    name: '表格',
    transform: transform(0, 2000000, 4000000, 1000000),
    rows: [{ cells: [{ text: literalText(opts.tableLiteral), col_span: 1, row_span: 1 }] }],
    column_widths_emu: [4000000],
  };
  presentation = addShape(presentation, slideId, table);
  const chart: ChartShape = {
    kind: 'chart',
    shape_id: 4,
    name: '图表',
    transform: transform(0, 3000000, 4000000, 2000000),
    chart: {
      chart_type: 'bar',
      categories: ['人数'],
      series: [{ name: '人数', values: [opts.chartValue] }],
      title: null,
    },
  };
  presentation = addShape(presentation, slideId, chart);
  return { presentation, bindings: HEADCOUNT_BINDINGS };
}

/** 生成路径：正文 / 表格 / 图表**全部**由事实键装配（值来自 `snapshot`）。 */
function deckFromFacts(snapshot: VersionedFactSnapshot): { presentation: Presentation; bindings: FactBindings } {
  let presentation = emptyPresentation('p1', '由同版事实生成');
  const added = addOneSlide(presentation);
  presentation = added.presentation;
  const slideId = added.slideId;
  presentation = addShape(presentation, slideId, {
    kind: 'text_box',
    shape_id: 2,
    name: '正文',
    transform: transform(0, 0, 4000000, 1000000),
    text: factTextBody('headcount'),
  });
  presentation = addShape(presentation, slideId, {
    kind: 'table',
    shape_id: 3,
    name: '表格',
    transform: transform(0, 2000000, 4000000, 1000000),
    rows: [{ cells: [factCell('headcount', snapshot)] }],
    column_widths_emu: [4000000],
  } satisfies TableShape);
  presentation = addShape(presentation, slideId, {
    kind: 'chart',
    shape_id: 4,
    name: '图表',
    transform: transform(0, 3000000, 4000000, 2000000),
    chart: chartFromFacts({
      chart_type: 'bar',
      title: null,
      categories: ['人数'],
      series: [{ name: '人数', fact_keys: ['headcount'] }],
      snapshot,
    }),
  } satisfies ChartShape);
  return { presentation, bindings: HEADCOUNT_BINDINGS };
}

// ---------------------------------------------------------------------------
// 独立读取器（不复用会话自报）
// ---------------------------------------------------------------------------

function slideParts(bytes: Uint8Array): readonly { readonly path: string; readonly text: string }[] {
  return readZip(bytes)
    .entries.filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.path))
    .map((entry) => ({ path: entry.path, text: Buffer.from(entry.data).toString('utf8') }));
}

function allSlideText(bytes: Uint8Array): string {
  return slideParts(bytes).map((part) => part.text).join('\n');
}

function firstChart(presentation: Presentation) {
  for (const slide of presentation.slides) {
    for (const shape of slide.shapes) {
      if (shape.kind === 'chart') return shape.chart;
    }
  }
  throw new Error('模型里没有图表');
}

function onlyTableCell(presentation: Presentation): string {
  for (const slide of presentation.slides) {
    for (const shape of slide.shapes) {
      if (shape.kind === 'table') {
        const cell = shape.rows[0]?.cells[0];
        return cell?.text === null || cell?.text === undefined ? '' : bodyText(cell.text, []);
      }
    }
  }
  throw new Error('模型里没有表格');
}

/** 断言成功；否则抛出可读的 status/reason（比裸 `if (!x.ok) return` 更能发现回归）。 */
function expectOk(outcome: SessionEditOutcome): Extract<SessionEditOutcome, { ok: true }> {
  if (!outcome.ok) {
    throw new Error(`期望成功，实得 ${outcome.status}：${JSON.stringify(outcome)}`);
  }
  return outcome;
}

// ===========================================================================
// ① 事务撤销 / 重做 / 失败保旧 / 乐观并发
// ===========================================================================

describe('P10 / PPT-14：事务 · 撤销重做 · 失败保旧 · 乐观并发', () => {
  it('add_slide → set_slide_title → undo → redo：版本号与模型摘要按步回放', () => {
    let session = createPresentationSession({ presentationId: 'p1', title: '汇报' });
    expect(session.revision).toBe(0);

    const add = expectOk(applySessionEdit(session, { op: 'add_slide', title: '封面' }, session.revision));
    session = add.session;
    expect(session.revision).toBe(1);
    const digestAtR1 = sessionSummary(session).digest;

    const title = expectOk(
      applySessionEdit(session, { op: 'set_slide_title', slide_id: 1, text: '封面（改）' }, session.revision),
    );
    session = title.session;
    expect(session.revision).toBe(2);
    const digestAtR2 = sessionSummary(session).digest;
    expect(digestAtR2).not.toBe(digestAtR1);

    const undone = expectOk(undoSession(session, session.revision));
    session = undone.session;
    expect(session.revision).toBe(1);
    expect(sessionSummary(session).digest).toBe(digestAtR1);
    expect(sessionSummary(session).redo_depth).toBe(1);

    const redone = expectOk(redoSession(session, session.revision));
    session = redone.session;
    expect(session.revision).toBe(2);
    expect(sessionSummary(session).digest).toBe(digestAtR2);
  });

  it('反向对照：无可撤销 / 无可重做必须**具名**拒绝，不静默成功', () => {
    const fresh = createPresentationSession({ presentationId: 'p1', title: '空' });
    const undo = undoSession(fresh, fresh.revision);
    expect(undo.ok).toBe(false);
    if (!undo.ok && undo.status === 'rejected') {
      expect(undo.reason).toBe('nothing_to_undo');
    } else {
      throw new Error(`期望 rejected/nothing_to_undo，实得 ${JSON.stringify(undo)}`);
    }

    const added = expectOk(applySessionEdit(fresh, { op: 'add_slide', title: '甲' }, fresh.revision));
    const redo = redoSession(added.session, added.session.revision);
    expect(redo.ok).toBe(false);
    if (!redo.ok && redo.status === 'rejected') {
      expect(redo.reason).toBe('nothing_to_redo');
    } else {
      throw new Error(`期望 rejected/nothing_to_redo，实得 ${JSON.stringify(redo)}`);
    }
  });

  it('并发：expectedRevision 已过时 ⇒ stale_write，会话一字不动（不是最后写入者赢）', () => {
    let session = createPresentationSession({ presentationId: 'p1', title: '汇报' });
    session = expectOk(applySessionEdit(session, { op: 'add_slide', title: '第一页' }, 0)).session;
    expect(session.revision).toBe(1);
    const before = sessionSummary(session);

    const stale = applySessionEdit(session, { op: 'add_slide', title: '并发页' }, 0);
    expect(stale.ok).toBe(false);
    if (!stale.ok && stale.status === 'stale_write') {
      expect(stale.expected).toBe(0);
      expect(stale.current).toBe(1);
      expect(stale.session).toBe(session);
    } else {
      throw new Error(`期望 stale_write，实得 ${JSON.stringify(stale)}`);
    }
    expect(sessionSummary(session)).toEqual(before);
  });

  it('失败保旧：指向不存在页的改写 ⇒ 具名拒绝且模型摘要一字不变', () => {
    let session = createPresentationSession({ presentationId: 'p1', title: '汇报' });
    session = expectOk(applySessionEdit(session, { op: 'add_slide', title: '甲' }, session.revision)).session;
    const before = sessionSummary(session);

    const bad = applySessionEdit(session, { op: 'set_slide_title', slide_id: 999, text: '不存在' }, session.revision);
    expect(bad.ok).toBe(false);
    if (!bad.ok && bad.status === 'rejected') {
      expect(bad.reason).toBe('invalid_edit');
    } else {
      throw new Error(`期望 rejected，实得 ${JSON.stringify(bad)}`);
    }
    expect(sessionSummary(session)).toEqual(before);
    expect(session.revision).toBe(before.revision);
  });

  it('封闭枚举：未知 op（含被别的格式支持、演示不支持的）⇒ unsupported_op，且会话不变', () => {
    const session = createPresentationSession({ presentationId: 'p1', title: '汇报' });
    const before = sessionSummary(session);
    for (const edit of [
      { op: 'set_slide_size', width: 12192000, height: 6858000 },
      { op: 'move_slide', slide_id: 0, to: 2 },
      { op: 'not_a_real_op' },
    ]) {
      const outcome = applySessionEdit(session, edit, session.revision);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok && outcome.status === 'rejected') {
        expect(outcome.reason).toBe('unsupported_op');
      } else {
        throw new Error(`期望 unsupported_op，实得 ${JSON.stringify(outcome)}`);
      }
    }
    expect(sessionSummary(session)).toEqual(before);
    expect(PRESENTATION_SESSION_OPS).toHaveLength(8);
  });

  it('replace_text：命中 ⇒ 替换；无命中 ⇒ no_change（版本不递增）', () => {
    let session = createPresentationSession({ presentationId: 'p1', title: '汇报' });
    session = expectOk(applySessionEdit(session, { op: 'add_slide', title: '封面页' }, session.revision)).session;
    const revisionBefore = session.revision;

    const noHit = expectOk(applySessionEdit(session, { op: 'replace_text', query: '查无此词', replacement: 'X' }, session.revision));
    expect(noHit.status).toBe('no_change');
    expect(noHit.session.revision).toBe(revisionBefore);

    const hit = expectOk(applySessionEdit(noHit.session, { op: 'replace_text', query: '封面', replacement: '扉页' }, noHit.session.revision));
    expect(hit.status).toBe('applied');
    expect(hit.session.revision).toBe(revisionBefore + 1);
    // 选中段被换掉、原后缀「页」原样保留（选区语义：前缀/后缀不丢）
    const runs = JSON.stringify(sessionPresentation(hit.session));
    expect(runs).toContain('扉页');
    expect(runs).toContain('"text":"页"');
  });
});

// ===========================================================================
// ② 同版事实：正文 / 表格 / 图表
// ===========================================================================

describe('P10 / PPT-16：正文 · 表格 · 图表同版事实', () => {
  it('由事实生成的演示接入 V1 ⇒ 门禁 ok，三处角色各一', () => {
    const { presentation, bindings } = deckFromFacts(V1);
    let session = openSessionFromPresentation(presentation);
    session = expectOk(applySessionEdit(session, { op: 'attach_facts', target: V1, bindings }, session.revision)).session;

    const gate = verifySessionFacts(session);
    expect(gate.status).toBe('ok');
    if (gate.status === 'ok') {
      expect(gate.report.ok).toBe(true);
      expect(gate.report.counts).toEqual({ text: 1, table: 1, chart: 1 });
      expect(gate.report.version).toEqual({ task_id: 't1', task_revision: 1 });
      expect(gate.report.conflicts).toHaveLength(0);
    }
  });

  it('★ set_fact_value 8 → 12 ⇒ 图表嵌入数据 / 表格字面量原子刷成同版，门禁仍 ok', () => {
    const { presentation, bindings } = deckFromFacts(V1);
    let session = openSessionFromPresentation(presentation);
    session = expectOk(applySessionEdit(session, { op: 'attach_facts', target: V1, bindings }, session.revision)).session;
    const attachRevision = session.revision;

    const set = expectOk(
      applySessionEdit(
        session,
        { op: 'set_fact_value', fact_key: 'headcount', value: { type: 'number', amount: 12, unit: '人', currency: null } },
        session.revision,
      ),
    );
    session = set.session;
    expect(session.revision).toBe(attachRevision + 1);
    expect(set.fact_version).toEqual({ task_id: 't1', task_revision: 2 });

    // 模型层（独立读字段，不经 verify）
    expect(firstChart(sessionPresentation(session)).series[0]?.values).toEqual([12]);
    expect(onlyTableCell(sessionPresentation(session))).toBe('12 人');
    // 正文仍是**事实引用**（不是写死数字）
    expect(findPlaceholders(sessionPresentation(session)).map((ref) => ref.fact_key)).toEqual(['headcount']);

    const gate = verifySessionFacts(session);
    expect(gate.status).toBe('ok');
    if (gate.status === 'ok') expect(gate.report.counts).toEqual({ text: 1, table: 1, chart: 1 });
  });

  it('撤销事实更新 ⇒ 目标版本与三处数值回到旧版；重做再回到新版', () => {
    const { presentation, bindings } = deckFromFacts(V1);
    let session = openSessionFromPresentation(presentation);
    session = expectOk(applySessionEdit(session, { op: 'attach_facts', target: V1, bindings }, session.revision)).session;
    session = expectOk(
      applySessionEdit(
        session,
        { op: 'set_fact_value', fact_key: 'headcount', value: { type: 'number', amount: 12, unit: '人', currency: null } },
        session.revision,
      ),
    ).session;
    expect(firstChart(sessionPresentation(session)).series[0]?.values).toEqual([12]);

    const undone = expectOk(undoSession(session, session.revision));
    session = undone.session;
    expect(session.revision).toBe(1);
    expect(undone.fact_version).toEqual({ task_id: 't1', task_revision: 1 });
    expect(firstChart(sessionPresentation(session)).series[0]?.values).toEqual([8]);
    expect(verifySessionFacts(session).status).toBe('ok');

    const redone = expectOk(redoSession(session, session.revision));
    expect(redone.fact_version).toEqual({ task_id: 't1', task_revision: 2 });
    expect(firstChart(sessionPresentation(redone.session)).series[0]?.values).toEqual([12]);
  });

  it('★ 反向：目标版本是新版而字面量仍是旧值 ⇒ stale_fact_version，保存被拒（不静默取一处）', () => {
    const { presentation, bindings } = deckFromFacts(V1); // 字面量 = 8（V1）
    let session = openSessionFromPresentation(presentation);
    session = expectOk(applySessionEdit(session, { op: 'attach_facts', target: V1, bindings }, session.revision)).session;
    // 只换目标版本到 V2，**不**重刷字面量 —— attach 不重写字面量，正是"图表没跟着更新"的形态
    session = expectOk(applySessionEdit(session, { op: 'attach_facts', target: V2 }, session.revision)).session;

    const gate = verifySessionFacts(session);
    expect(gate.status).toBe('conflict');
    if (gate.status === 'conflict') {
      // 冲突是**逐处**的：图表与表格各一条 stale_fact_version（都用了旧版 8）
      const stales = gate.report.conflicts.filter((conflict) => conflict.kind === 'stale_fact_version');
      expect(stales.length, `期望至少一条 stale_fact_version，实得 ${JSON.stringify(gate.report.conflicts)}`).toBeGreaterThanOrEqual(1);
      const roles = new Set(stales.flatMap((conflict) => [...conflict.roles]));
      expect(roles.has('table')).toBe(true);
      expect(roles.has('chart')).toBe(true);
      for (const stale of stales) expect(stale.stale_version).toEqual({ task_id: 't1', task_revision: 1 });
    }

    const save = saveSession(session);
    expect(save.ok).toBe(false);
    if (!save.ok) {
      expect(save.status).toBe('blocked');
      if (save.status === 'blocked') expect(save.reason).toBe('fact_conflict');
    }
  });

  it('反向：字面量与任何已知版本都对不上 ⇒ value_mismatch（不是 stale），保存被拒', () => {
    const { presentation, bindings } = deck({ tableLiteral: '99', chartValue: 99 });
    let session = openSessionFromPresentation(presentation);
    session = expectOk(applySessionEdit(session, { op: 'attach_facts', target: V1, bindings }, session.revision)).session;

    const gate = verifySessionFacts(session);
    expect(gate.status).toBe('conflict');
    if (gate.status === 'conflict') {
      expect(gate.report.conflicts.some((conflict) => conflict.kind === 'value_mismatch')).toBe(true);
      expect(gate.report.conflicts.some((conflict) => conflict.kind === 'stale_fact_version')).toBe(false);
    }
    expect(saveSession(session).ok).toBe(false);
  });

  it('use_fact_version 回退到未发布版本 ⇒ unknown_fact_version，会话不变', () => {
    let session = openSessionFromPresentation(deckFromFacts(V1).presentation);
    session = expectOk(applySessionEdit(session, { op: 'attach_facts', target: V1, bindings: HEADCOUNT_BINDINGS }, session.revision)).session;
    const before = sessionSummary(session);
    const outcome = applySessionEdit(session, { op: 'use_fact_version', version: { task_id: 't1', task_revision: 9 } }, session.revision);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.status === 'rejected') expect(outcome.reason).toBe('unknown_fact_version');
    expect(sessionSummary(session)).toEqual(before);
  });
});

// ===========================================================================
// ③ 保存 → 重开 → 再编辑（手机闭环）
// ===========================================================================

describe('P10 / PPT-01：保存 → 重开 → 再编辑', () => {
  it('新建两页 → 保存 → 独立解包 → 重开 → 再编辑 → 再保存', () => {
    let session = createPresentationSession({ presentationId: 'p1', title: '汇报' });
    session = expectOk(applySessionEdit(session, { op: 'add_slide', title: '封面' }, session.revision)).session;
    session = expectOk(applySessionEdit(session, { op: 'add_slide', title: '第二页' }, session.revision)).session;
    expect(session.revision).toBe(2);

    const saved = saveSession(session);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    // 未接入事实：保存允许，但如实标 not_verified 并带警告（不假装校验过）
    expect(saved.record.fact_gate).toBe('not_verified');
    expect(saved.record.warnings).toHaveLength(1);
    expect(saved.record.revision).toBe(2);
    expect(saved.record.entry_count).toBeGreaterThan(0);
    // 独立重算摘要
    expect(saved.record.digest).toBe(digestBytes(saved.record.bytes));

    // 独立解包：恰好两个 slide 部件，且标题文本在字节里
    expect(slideParts(saved.record.bytes)).toHaveLength(2);
    expect(allSlideText(saved.record.bytes)).toContain('封面');

    // 重开：新会话，从导入件起（revision 归 0），两页、来源标为导入
    const reopened = openSessionFromBytes(saved.record.bytes);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    expect(reopened.session.revision).toBe(0);
    expect(reopened.session.source.imported).not.toBeNull();
    const summary = sessionSummary(reopened.session);
    expect(summary.slide_count).toBe(2);
    expect(summary.imported_origin).toBe(true);
    // 重开后未接入事实 ⇒ 门禁如实报 not_ready（不是 ok、不是 conflict）
    expect(verifySessionFacts(reopened.session).status).toBe('not_ready');

    // 再编辑：改第 1 页标题
    const firstSlideId = sessionPresentation(reopened.session).slides[0]?.slide_id;
    expect(typeof firstSlideId).toBe('number');
    const edit = expectOk(
      applySessionEdit(reopened.session, { op: 'set_slide_title', slide_id: firstSlideId as number, text: '重开后改名' }, reopened.session.revision),
    );
    expect(edit.session.revision).toBe(1);

    const again = saveSession(edit.session);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.record.digest).toBe(digestBytes(again.record.bytes));
    expect(allSlideText(again.record.bytes)).toContain('重开后改名');
  });

  it('导入件预检：增 / 删页在适配器接缝上不可持久化 ⇒ 具名拒绝，不留假入口', () => {
    let session = createPresentationSession({ presentationId: 'p1', title: '汇报' });
    session = expectOk(applySessionEdit(session, { op: 'add_slide', title: '封面' }, session.revision)).session;
    const saved = saveSession(session);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const reopened = openSessionFromBytes(saved.record.bytes);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;

    const slideId = sessionPresentation(reopened.session).slides[0]?.slide_id as number;
    for (const edit of [
      { op: 'add_slide', title: '新页' },
      { op: 'remove_slide', slide_id: slideId },
    ]) {
      const outcome = applySessionEdit(reopened.session, edit, reopened.session.revision);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok && outcome.status === 'rejected') {
        expect(outcome.reason).toBe('slide_set_locked_for_imported');
      } else {
        throw new Error(`期望 slide_set_locked_for_imported，实得 ${JSON.stringify(outcome)}`);
      }
    }
    // 改既有标题仍可用（不是"导入件一律冻结"）
    expect(applySessionEdit(reopened.session, { op: 'set_slide_title', slide_id: slideId, text: '可改' }, reopened.session.revision).ok).toBe(true);
  });

  it('导入件预检：新增备注部件不可持久化 ⇒ 具名拒绝；改既有备注文字允许', () => {
    let session = createPresentationSession({ presentationId: 'p1', title: '汇报' });
    session = expectOk(applySessionEdit(session, { op: 'add_slide', title: '封面' }, session.revision)).session;
    session = expectOk(applySessionEdit(session, { op: 'set_slide_notes', slide_id: 1, text: '原本的备注' }, session.revision)).session;
    const saved = saveSession(session);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const reopened = openSessionFromBytes(saved.record.bytes);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    const slideId = sessionPresentation(reopened.session).slides[0]?.slide_id as number;

    // 备注已存在 ⇒ 改文字可以
    expect(applySessionEdit(reopened.session, { op: 'set_slide_notes', slide_id: slideId, text: '改过的备注' }, reopened.session.revision).ok).toBe(true);
    // 删除备注部件不行
    const removal = applySessionEdit(reopened.session, { op: 'set_slide_notes', slide_id: slideId, text: null }, reopened.session.revision);
    expect(removal.ok).toBe(false);
    if (!removal.ok && removal.status === 'rejected') {
      expect(removal.reason).toBe('notes_part_locked_for_imported');
    } else {
      throw new Error(`期望 notes_part_locked_for_imported，实得 ${JSON.stringify(removal)}`);
    }
  });
});

// ===========================================================================
// ④ 产物字节核验：事实数字真的进了导出的 PPTX
// ===========================================================================

describe('P10 / PPT-16：导出的 PPTX 字节里三处数字同版', () => {
  it('接入 V1 保存 ⇒ 字节里正文 fact run 渲染成「8 人」，不是占位；无修复级别的不一致', () => {
    // 表格字面量刻意写不带单位的「8」，从而「8 人」只可能来自正文 fact run 的求值
    const { presentation, bindings } = deck({ tableLiteral: '8', chartValue: 8 });
    let session = openSessionFromPresentation(presentation);
    session = expectOk(applySessionEdit(session, { op: 'attach_facts', target: V1, bindings }, session.revision)).session;

    const saved = saveSession(session);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.record.fact_gate).toBe('ok');
    expect(saved.record.fact_version).toEqual({ task_id: 't1', task_revision: 1 });

    const xml = allSlideText(saved.record.bytes);
    expect(xml).toContain('8 人');
    expect(xml).not.toContain(MISSING_FACT_PLACEHOLDER);

    // 改到 12 后再导出：同一处 fact run 变成「12 人」
    const bumped = expectOk(
      applySessionEdit(
        session,
        { op: 'set_fact_value', fact_key: 'headcount', value: { type: 'number', amount: 12, unit: '人', currency: null } },
        session.revision,
      ),
    );
    const saved2 = saveSession(bumped.session);
    expect(saved2.ok).toBe(true);
    if (!saved2.ok) return;
    expect(allSlideText(saved2.record.bytes)).toContain('12 人');
    expect(allSlideText(saved2.record.bytes)).not.toContain(MISSING_FACT_PLACEHOLDER);
  });

  it('保存回执带出「本仓无法验证」的断言（无消费端 ⇒ 原样转述，不默认通过）', () => {
    const { presentation, bindings } = deckFromFacts(V1);
    let session = openSessionFromPresentation(presentation);
    session = expectOk(applySessionEdit(session, { op: 'attach_facts', target: V1, bindings }, session.revision)).session;
    const saved = saveSession(session);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.record.unverified.length).toBeGreaterThanOrEqual(1);
    for (const claim of saved.record.unverified) {
      expect(claim.claim.length).toBeGreaterThan(0);
      expect(claim.requires.length).toBeGreaterThan(0);
    }
  });
});
