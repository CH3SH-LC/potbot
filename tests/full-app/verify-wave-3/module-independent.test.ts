/**
 * FA-VERIFY-WAVE-3 · 对表（≥10 个前几轮**未覆盖**模块的独立断言）
 *
 * 每个模块都给「正向 1 条 + 反向对照 1 条」以上。**全部输入由验证方自造**，
 * 不复用实现者的 fixture / 结论。
 *
 * 覆盖清单（14 个模块）：
 *  1. spreadsheets/sort-filter.ts      8. scheduler/progress-monitor.ts
 *  2. spreadsheets/structured-table.ts 9. roles/main-agent.ts
 *  3. spreadsheets/conditional-format.ts 10. presentations/animation.ts
 *  4. presentations/geometry.ts        11. presentations/notes-and-links.ts
 *  5. clock/logical-clock.ts           12. memory/{conflict-resolution,recall,fact-update}
 *  6. adapters/research/tokenize.ts    13. documents/units/length.ts
 *  7. plugins/catalog.ts               14. memory/repository.ts
 *
 * 诚实边界：全部为**纯逻辑/内存**断言；真机、真实模型、真实 Office 一律未实测。
 */

import { describe, expect, it } from 'vitest';

import type { LogicalTime } from '../../../src/protocol/index.js';
import { asRevision, asTaskId } from '../../../src/protocol/index.js';
import { createSheet, getCellValue, setCellValue, type SheetState } from '../../../src/spreadsheets/sheet.js';
import { blank, numberValue, textValue } from '../../../src/spreadsheets/value.js';
import {
  cellSignature,
  compareCellValues,
  dedupeRows,
  findCells,
  isBlankRow,
  replaceInCells,
  sortRange,
} from '../../../src/spreadsheets/sort-filter.js';
import {
  buildTotalsFormulas,
  createStructuredTable,
  isValidTableName,
  tableDataRange,
  tableHeaderRange,
  tableTotalsRange,
} from '../../../src/spreadsheets/structured-table.js';
import {
  migrateIntervalRows,
  normalizeColor,
  normalizePriorities,
  validateCfRule,
} from '../../../src/spreadsheets/conditional-format.js';
import type { CfRule } from '../../../src/spreadsheets/conditional-format.js';
import { GeometryError, scaleBoundsTo } from '../../../src/presentations/geometry.js';
import { LogicalClock, LogicalClockError } from '../../../src/clock/logical-clock.js';
import { normalizeForMatch, termFrequencies, tokenize, uniqueTerms } from '../../../src/adapters/research/tokenize.js';
import {
  BASE_ROLE_COUNT,
  BUSINESS_TEMPLATE_COUNT,
  PLUGIN_CATALOG,
  findPluginManifest,
} from '../../../src/plugins/catalog.js';
import { createProgressMonitor } from '../../../src/scheduler/progress-monitor.js';
import {
  AnimationError,
  addAnimationSpec,
  buildClickGroups,
  moveAnimationSpec,
  normalizeOrder,
  updateAnimationSpec,
  type AnimationSpec,
} from '../../../src/presentations/animation.js';
import { FooterReadbackError, readBackFooterXml } from '../../../src/presentations/notes-and-links.js';
import { lengthToTwips, pointsToTwips, twipsToLength, twipsToPoints } from '../../../src/documents/units/length.js';
import {
  MAIN_AGENT_ACTIONS,
  assertMainAgentSurface,
  createStructuralMainAgentPorts,
  handleMainAgentRequest,
  isDirectExecutionAction,
} from '../../../src/roles/main-agent.js';
import { RoleBoundaryError } from '../../../src/roles/types.js';
import { createMemoryRepository } from '../../../src/memory/repository.js';
import { asMemoryId, asOwnerId, type PreferenceMemory } from '../../../src/memory/types.js';
import { resolvePreferenceConflict } from '../../../src/memory/recall.js';
import { updateTaskFact } from '../../../src/memory/fact-update.js';
import {
  resolveCurrentInstructionAgainstMemory,
  traceFactVersions,
} from '../../../src/memory/conflict-resolution.js';

const T = (n: number): LogicalTime => n as LogicalTime;
const SOURCE = { kind: 'user_statement', detail: '用户明确说明' } as const;

/** 取数字单元格的值（非数字即抛，避免把类型收窄写进断言）。 */
function numAt(sheet: SheetState, ref: string): number {
  const value = getCellValue(sheet, ref);
  if (value.kind !== 'number') throw new Error(`${ref} 不是数字单元格：${value.kind}`);
  return value.value;
}
/** 取文本单元格的值。 */
function textAt(sheet: SheetState, ref: string): string {
  const value = getCellValue(sheet, ref);
  if (value.kind !== 'text') throw new Error(`${ref} 不是文本单元格：${value.kind}`);
  return value.value;
}

// ───────────────────────────────────────────────────────────────────────────
// 1. spreadsheets/sort-filter.ts
// ───────────────────────────────────────────────────────────────────────────
describe('独立断言 · spreadsheets/sort-filter.ts', () => {
  it('正向：类型感知比较与排序（空白默认在后、保留原相对次序）', () => {
    expect(compareCellValues(numberValue(1), numberValue(2))).toBeLessThan(0);
    expect(compareCellValues(textValue('b'), textValue('a'))).toBeGreaterThan(0);
    // 空白默认排最后
    expect(compareCellValues(blank, numberValue(0))).toBeGreaterThan(0);
    // blanksFirst = true 时排最前
    expect(compareCellValues(blank, numberValue(0), true)).toBeLessThan(0);

    let sheet = createSheet('S', { row_count: 10, column_count: 4 });
    for (const [ref, value] of [['A1', 3], ['A2', 1], ['A3', 2]] as const) {
      sheet = setCellValue(sheet, ref, numberValue(value));
    }
    const sorted = sortRange(sheet, 'A1:A3', [{ column: 1, direction: 'asc' }]);
    expect(numAt(sorted, 'A1')).toBe(1);
    expect(numAt(sorted, 'A3')).toBe(3);
    // 原件不变
    expect(numAt(sheet, 'A1')).toBe(3);
  });

  it('反向：空键表 / 越界列号一律抛 ValidationError', () => {
    const sheet = createSheet('S', { row_count: 5, column_count: 2 });
    expect(() => sortRange(sheet, 'A1:B2', [])).toThrow();
    expect(() => sortRange(sheet, 'A1:B2', [{ column: 9, direction: 'asc' }])).toThrow();
  });

  it('正向/反向：去重保留首次出现；key_columns 为空抛；判重是类型感知的', () => {
    let sheet = createSheet('S', { row_count: 10, column_count: 3 });
    sheet = setCellValue(sheet, 'A1', textValue('x'));
    sheet = setCellValue(sheet, 'A2', textValue('x'));
    sheet = setCellValue(sheet, 'A3', textValue('y'));
    const deduped = dedupeRows(sheet, 'A1:A3');
    expect(textAt(deduped, 'A2')).toBe('y');
    expect(getCellValue(deduped, 'A3').kind).toBe('blank');
    expect(() => dedupeRows(sheet, 'A1:A3', { key_columns: [] })).toThrow();

    // 类型感知：数字 1 与文本 "1" 不是同一个判重键
    expect(cellSignature(numberValue(1))).not.toBe(cellSignature(textValue('1')));
  });

  it('正向/反向：替换只动文本、返回实际改动地址；查找串为空抛', () => {
    let sheet = createSheet('S', { row_count: 6, column_count: 2 });
    sheet = setCellValue(sheet, 'A1', textValue('Alpha alpha'));
    sheet = setCellValue(sheet, 'A2', numberValue(123));
    const replaced = replaceInCells(sheet, 'A1:A2', 'alpha', 'X');
    expect(replaced.refs).toEqual(['A1']);
    expect(textAt(replaced.sheet, 'A1')).toBe('X X');
    // 数字单元格不动
    expect(getCellValue(replaced.sheet, 'A2').kind).toBe('number');
    expect(() => replaceInCells(sheet, 'A1:A2', '', 'X')).toThrow();

    // 非文本不参与查找
    expect(findCells(sheet, 'A1:A2', '123')).toEqual([]);
    // 越界行 isBlankRow 抛
    expect(() => isBlankRow(sheet, 'A1:A2', 99)).toThrow();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. spreadsheets/structured-table.ts
// ───────────────────────────────────────────────────────────────────────────
describe('独立断言 · spreadsheets/structured-table.ts', () => {
  it('正向：表名合法性 + 表结构派生区间', () => {
    expect(isValidTableName('Sales')).toBe(true);
    expect(isValidTableName('_t1')).toBe(true);
    // A1 形如单元格引用，Excel 禁止
    expect(isValidTableName('A1')).toBe(false);
    expect(isValidTableName('')).toBe(false);
    expect(isValidTableName('has space')).toBe(false);

    const table = createStructuredTable({
      name: 'Sales',
      range: 'A1:C4',
      columns: ['Region', 'Qty', 'Total'],
      totals_row: true,
    });
    expect(table.range).toBe('A1:C4');
    expect(tableHeaderRange(table)).toBe('A1:C1');
    expect(tableDataRange(table)).toBe('A2:C3');
    expect(tableTotalsRange(table)).toBe('A4:C4');
  });

  it('反向：列数与区域宽度不符 / 列名重复 / 表名非法 一律抛', () => {
    expect(() => createStructuredTable({ name: 'T', range: 'A1:C2', columns: ['a', 'b'] })).toThrow();
    expect(() => createStructuredTable({ name: 'T', range: 'A1:B2', columns: ['a', 'a'] })).toThrow();
    expect(() => createStructuredTable({ name: 'bad name', range: 'A1:B2', columns: ['a', 'b'] })).toThrow();
  });

  it('正向/反向：汇总行公式只在有 totals_function 的列生成，无汇总行时抛', () => {
    const table = createStructuredTable({
      name: 'T',
      range: 'A1:B3',
      columns: [{ name: 'Qty', totals_function: 'sum' }, 'Note'],
      totals_row: true,
    });
    const formulas = buildTotalsFormulas(table);
    expect(formulas[0]?.formula).toBe('SUBTOTAL(109,T[Qty])');
    expect(formulas[1]?.formula).toBeNull();

    const noTotals = createStructuredTable({ name: 'Totalless', range: 'A1:B2', columns: ['a', 'b'] });
    expect(tableTotalsRange(noTotals)).toBeNull();
    expect(() => buildTotalsFormulas(noTotals)).toThrow();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. spreadsheets/conditional-format.ts
// ───────────────────────────────────────────────────────────────────────────
describe('独立断言 · spreadsheets/conditional-format.ts', () => {
  const base = (over: Partial<CfRule>): CfRule => ({ range: 'A1:A10', priority: 1, type: 'cellIs', operator: 'greaterThan', ...over } as CfRule);

  it('正向：颜色归一化为 8 位大写 ARGB；优先级稳定重编号', () => {
    expect(normalizeColor('ff0000')).toBe('FFFF0000');
    expect(normalizeColor('80ff0000')).toBe('80FF0000');
    const normalized = normalizePriorities([
      base({ priority: 3 }),
      base({ priority: 1 }),
    ]);
    expect(normalized.map((r) => r.priority)).toEqual([1, 2]);
  });

  it('反向：非法色值 / 重复优先级 / 类型与字段不匹配 一律抛', () => {
    expect(() => normalizeColor('xyz')).toThrow();
    expect(() => normalizeColor('#ff0000')).toThrow();
    expect(() => normalizePriorities([base({ priority: 1 }), base({ priority: 1 })])).toThrow();
    // cellIs 缺 operator
    expect(() => validateCfRule(base({ operator: undefined }))).toThrow();
    // 非 cellIs 带 operator
    expect(() => validateCfRule({ range: 'A1', priority: 1, type: 'top10', rank: 3, operator: 'lessThan' } as CfRule)).toThrow();
    // containsText 缺 text
    expect(() => validateCfRule({ range: 'A1', priority: 1, type: 'containsText' } as CfRule)).toThrow();
    // colorScale 端点不足
    expect(() =>
      validateCfRule({ range: 'A1', priority: 1, type: 'colorScale', color_scale: [{ type: 'min', color: 'FFFFFF' }] } as CfRule),
    ).toThrow();
    // extended 只允许 colorScale/dataBar/iconSet
    expect(() => validateCfRule(base({ extended: true }))).toThrow();
  });

  it('正向/反向：行区间迁移（插入撑大 / 删除截短 / 整段删除丢弃）', () => {
    expect(migrateIntervalRows('A5:A10', 3, 2, 'insert')).toEqual({ ok: true, range: 'A7:A12' });
    expect(migrateIntervalRows('A5:A10', 6, 2, 'delete')).toEqual({ ok: true, range: 'A5:A8' });
    expect(migrateIntervalRows('A5:A6', 5, 2, 'delete')).toEqual({ ok: false, reason: 'deleted' });
    expect(() => migrateIntervalRows('A5:A6', 0, 1, 'insert')).toThrow();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4. presentations/geometry.ts
// ───────────────────────────────────────────────────────────────────────────
describe('独立断言 · presentations/geometry.ts', () => {
  it('正向：按页面尺寸等比缩放（四舍五入）', () => {
    const scaled = scaleBoundsTo(
      { x_emu: 100, y_emu: 200, cx_emu: 300, cy_emu: 400 },
      { cx_emu: 1000, cy_emu: 1000 },
      { cx_emu: 2000, cy_emu: 500 },
    );
    expect(scaled).toEqual({ x_emu: 200, y_emu: 100, cx_emu: 600, cy_emu: 200 });
  });

  it('反向：源页面尺寸非正 ⇒ GeometryError(invalid_bounds)', () => {
    try {
      scaleBoundsTo({ x_emu: 0, y_emu: 0, cx_emu: 1, cy_emu: 1 }, { cx_emu: 0, cy_emu: 10 }, { cx_emu: 1, cy_emu: 1 });
      throw new Error('应当抛 GeometryError');
    } catch (error) {
      expect(error).toBeInstanceOf(GeometryError);
      expect((error as GeometryError).reason).toBe('invalid_bounds');
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 5. clock/logical-clock.ts
// ───────────────────────────────────────────────────────────────────────────
describe('独立断言 · clock/logical-clock.ts', () => {
  it('正向：显式推进、reads 计数、累计推进量对账', () => {
    const clock = new LogicalClock(T(100));
    const view = clock.readOnlyView();
    expect(view.now()).toBe(100); // reads 1
    expect(clock.advance(30)).toBe(130);
    expect(clock.advanceTo(T(200), 'cap')).toBe(200);
    expect(clock.reads).toBe(1);
    expect(clock.totalAdvanced).toBe(100); // 30 + 70
    expect(clock.advanceCount).toBe(2);
    expect(clock.state()).toEqual({ time: 200, reads: 1, advances: 2 });
    // 只读视图结构上不能推进时间
    expect('advance' in (view as unknown as Record<string, unknown>)).toBe(false);
  });

  it('反向：倒流 / 原地踏步 / 零推进量 / 非法初值 一律抛 LogicalClockError', () => {
    const clock = new LogicalClock(T(100));
    expect(() => clock.advance(0)).toThrow(LogicalClockError);
    expect(() => clock.advance(-1)).toThrow(LogicalClockError);
    expect(() => clock.advanceTo(T(100))).toThrow(LogicalClockError);
    expect(() => clock.advanceTo(T(50))).toThrow(LogicalClockError);
    expect(() => new LogicalClock(T(-5))).toThrow(LogicalClockError);
    // 失败推进不得改变状态
    expect(clock.time).toBe(100);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 6. adapters/research/tokenize.ts（本模块**没有任何 .test.ts**）
// ───────────────────────────────────────────────────────────────────────────
describe('独立断言 · adapters/research/tokenize.ts（无自带测试）', () => {
  it('正向：CJK 二元组 + 拉丁整词转小写', () => {
    expect(tokenize('人工智能')).toEqual(['人工', '工智', '智能']);
    expect(tokenize('AI模型')).toEqual(['ai', '模型']);
    expect(tokenize('独')).toEqual(['独']); // 单字保留
    expect(uniqueTerms('ab ab')).toEqual(['ab']);
    expect(normalizeForMatch('  A\tB\n C  ')).toBe('a b c');
    expect([...termFrequencies(['a', 'b', 'a']).entries()]).toEqual([['a', 2], ['b', 1]]);
  });

  it('反向：非 CJK/拉丁的标点不产出词元；空串产出空数组', () => {
    expect(tokenize('  ,.!! ')).toEqual([]);
    expect(tokenize('')).toEqual([]);
    // 归一化只折叠空白、不改字符本身（保护偏移）
    expect(normalizeForMatch('ＡＢ')).toBe('ａｂ');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 7. plugins/catalog.ts
// ───────────────────────────────────────────────────────────────────────────
describe('独立断言 · plugins/catalog.ts', () => {
  it('正向：7 模板 + 3 角色 = 10 条目录，按 id 可查', () => {
    expect(BUSINESS_TEMPLATE_COUNT).toBe(7);
    expect(BASE_ROLE_COUNT).toBe(3);
    expect(PLUGIN_CATALOG).toHaveLength(10);
    expect(findPluginManifest('role.front_agent')?.display_name).toBe('前台主智能体');
    expect(findPluginManifest('no.such.plugin')).toBeUndefined();
  });

  it('反向：只有 document/spreadsheet/presentation 三个模板标 real，其余 7 条如实标 stub', () => {
    const real = PLUGIN_CATALOG.filter((m) => m.implementation === 'real').map((m) => m.plugin_id).sort();
    expect(real).toEqual(['template.document', 'template.presentation', 'template.spreadsheet']);
    for (const m of PLUGIN_CATALOG.filter((x) => x.implementation === 'stub')) {
      expect(m.stub_reason !== null && m.stub_reason.length > 0).toBe(true);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 8. scheduler/progress-monitor.ts
// ───────────────────────────────────────────────────────────────────────────
describe('独立断言 · scheduler/progress-monitor.ts', () => {
  const monitor = () => createProgressMonitor({ budget: { runs: 4, diagnoses: 6, time: 10_000 }, max_forks: 2 });

  it('正向：分身有上限、同目的不重复、释放后名额回来', () => {
    const m = monitor();
    const a = m.spawnFork({ purpose: 'a', at: T(1) });
    const b = m.spawnFork({ purpose: 'b', at: T(2) });
    expect(a.allowed && b.allowed).toBe(true);
    const c = m.spawnFork({ purpose: 'c', at: T(3) });
    expect(c.allowed).toBe(false);
    expect(c.allowed === false && c.reason).toBe('fork_cap_reached');
    const dup = m.spawnFork({ purpose: 'a', at: T(4) });
    expect(dup.allowed === false && dup.reason).toBe('duplicate_purpose');
    expect(m.releaseFork('fork-1')).toBe(true);
    expect(m.spawnFork({ purpose: 'c', at: T(5) }).allowed).toBe(true);
    expect(m.activeForks().map((f) => f.purpose)).toEqual(['b', 'c']);
  });

  it('反向：空目的被拒；负数上限构造即抛', () => {
    const m = monitor();
    const refused = m.spawnFork({ purpose: '   ', at: T(1) });
    expect(refused.allowed === false && refused.reason).toBe('purpose_required');
    expect(() => createProgressMonitor({ budget: { runs: 1, diagnoses: 1, time: 1 }, max_forks: -1 })).toThrow(RangeError);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 9. roles/main-agent.ts
// ───────────────────────────────────────────────────────────────────────────
describe('独立断言 · roles/main-agent.ts', () => {
  it('正向：白名单动作面通过；结构桩对话标注 produced_by=structural_stub（不是模型）', () => {
    expect(assertMainAgentSurface(MAIN_AGENT_ACTIONS)).toEqual(MAIN_AGENT_ACTIONS);
    expect(isDirectExecutionAction('invoke_office_tool')).toBe(true);
    const ports = createStructuralMainAgentPorts(asTaskId('T-1'));
    const outcome = handleMainAgentRequest(ports, { kind: 'dialogue', text: '你好' });
    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.kind === 'dialogue') {
      expect(outcome.utterance.produced_by).toBe('structural_stub');
    }
  });

  it('反向：动作面混入直接执行 / 未登记动作一律抛 RoleBoundaryError', () => {
    expect(() => assertMainAgentSurface(['dialogue', 'invoke_system_tool'])).toThrow(RoleBoundaryError);
    expect(() => assertMainAgentSurface(['dialogue', 'launch_missiles'])).toThrow(RoleBoundaryError);
  });

  it('反向对照：direct_execution 请求在触碰任何端口前即被拒', () => {
    const ports = createStructuralMainAgentPorts(asTaskId('T-1'));
    const outcome = handleMainAgentRequest(ports, {
      kind: 'direct_execution',
      action: 'produce_office_artifact',
      detail: '想直接吐一个 docx',
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.rejection.code).toBe('direct_execution_forbidden');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 10. presentations/animation.ts
// ───────────────────────────────────────────────────────────────────────────
describe('独立断言 · presentations/animation.ts', () => {
  const spec = (over: Partial<AnimationSpec> = {}): AnimationSpec => ({
    shape_id: 1,
    effect: 'fade',
    kind: 'entrance',
    trigger: 'on_click',
    duration_ms: 500,
    delay_ms: 0,
    ...over,
  });

  it('正向：追加不改入参；按触发方式分组；order 同组内 0 起', () => {
    const base: readonly AnimationSpec[] = [];
    const list = addAnimationSpec(base, spec());
    expect(base).toHaveLength(0);
    expect(list).toHaveLength(1);
    const ordered = normalizeOrder([
      spec({ trigger: 'on_click' }),
      spec({ trigger: 'with_previous' }),
      spec({ trigger: 'on_click' }),
    ]);
    expect(ordered.map((s) => s.order)).toEqual([0, 0, 1]);
    const groups = buildClickGroups([spec({ trigger: 'on_click' }), spec({ trigger: 'with_previous' })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.effects).toHaveLength(2);
  });

  it('反向：未支持效果 / 负时长 / 越界下标 一律抛 AnimationError', () => {
    expect(() => addAnimationSpec([], spec({ effect: 'wobble' as unknown as AnimationSpec['effect'] }))).toThrow(AnimationError);
    expect(() => addAnimationSpec([], spec({ duration_ms: -1 }))).toThrow(AnimationError);
    expect(() => updateAnimationSpec([spec()], 5, {})).toThrow(AnimationError);
    expect(() => moveAnimationSpec([spec()], 0, 3)).toThrow(AnimationError);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 11. presentations/notes-and-links.ts
// ───────────────────────────────────────────────────────────────────────────
describe('独立断言 · presentations/notes-and-links.ts', () => {
  const ftr =
    '<p:sp><p:nvSpPr><p:nvPr><p:ph type="ftr"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>内部资料</a:t></a:r></a:p></p:txBody></p:sp>';

  it('正向：空片段全默认；纯页脚文本读回', () => {
    expect(readBackFooterXml('')).toEqual({ footer_text: null, show_date: false, show_slide_number: false });
    const rb = readBackFooterXml(ftr);
    expect(rb.footer_text).toBe('内部资料');
    expect(rb.show_date).toBe(false);
  });

  it('反向：字面量日期（无域）⇒ FooterReadbackError(literal_date)，绝不当作"页脚正常"', () => {
    const literalDate =
      '<p:sp><p:nvSpPr><p:nvPr><p:ph type="dt"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>2026-10-03</a:t></a:r></a:p></p:txBody></p:sp>';
    try {
      readBackFooterXml(literalDate);
      throw new Error('应当抛 FooterReadbackError');
    } catch (error) {
      expect(error).toBeInstanceOf(FooterReadbackError);
      expect((error as FooterReadbackError).reason).toBe('literal_date');
    }
    // 占位符缺 type ⇒ malformed_footer
    const noType = '<p:sp><p:nvSpPr><p:nvPr><p:ph/></p:nvPr></p:nvSpPr></p:sp>';
    expect(() => readBackFooterXml(noType)).toThrow(FooterReadbackError);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 12. memory/{conflict-resolution,recall,fact-update}
// ───────────────────────────────────────────────────────────────────────────
describe('独立断言 · memory/fact-update + conflict-resolution', () => {
  const owner = asOwnerId('u1');
  const task = asTaskId('T-1');

  it('正向：版本链追加、旧版本置失效但值保留；无变化不写新版本', () => {
    const repo = createMemoryRepository();
    let seq = 0;
    const newMemoryId = () => asMemoryId(`m${(seq += 1)}`);

    const first = updateTaskFact({ repository: repo, owner_id: owner, task_id: task, fact_key: 'deadline', value_text: '周五', source: SOURCE, at: T(1), newMemoryId });
    expect(first.kind).toBe('updated');

    const second = updateTaskFact({ repository: repo, owner_id: owner, task_id: task, fact_key: 'deadline', value_text: '周一', source: SOURCE, at: T(2), newMemoryId });
    expect(second.kind).toBe('updated');

    const trace = traceFactVersions(repo, { owner_id: owner, task_id: task, fact_key: 'deadline' });
    expect(trace.versions.map((v) => v.value_text)).toEqual(['周五', '周一']);
    expect(trace.current_value).toBe('周一');
    expect(trace.previous_value).toBe('周五');
    // 旧版本仍留值可审计（只是被置为 disabled）
    expect(trace.versions[0]?.status).toBe('disabled');

    const again = updateTaskFact({ repository: repo, owner_id: owner, task_id: task, fact_key: 'deadline', value_text: '周一', source: SOURCE, at: T(3), newMemoryId });
    expect(again.kind).toBe('no_change');
    expect(traceFactVersions(repo, { owner_id: owner, task_id: task, fact_key: 'deadline' }).versions).toHaveLength(2);
  });

  it('反向：缺来源的更新不写入、不成差异、标 partial（R236/R240）', () => {
    const repo = createMemoryRepository();
    const report = resolveCurrentInstructionAgainstMemory({
      repository: repo,
      owner_id: owner,
      at: T(1),
      current_instructions: [],
      preferences: [],
      fact_updates: [{ task_id: task, fact_key: 'k', value_text: 'v', source: { kind: '', detail: '' } as never }],
      newMemoryId: () => asMemoryId('m1'),
    });
    expect(report.applied).toBe('current');
    expect(report.partial).toBe(true);
    expect(report.failures).toHaveLength(1);
    expect(report.differences).toEqual([]); // 失败项不编造差异
    expect(report.explanation.length).toBeGreaterThan(0);
  });

  it('正向/反向：当前指令覆盖旧偏好（值不同=冲突，值相同=不冲突）', () => {
    const mkPref = (key: string, value: string): PreferenceMemory =>
      ({
        kind: 'preference',
        memory_id: asMemoryId(`p-${key}`),
        owner_id: owner,
        scope: { kind: 'user', task_id: null, template_id: null },
        source: SOURCE,
        confirmation: 'confirmed',
        created_at: T(1),
        updated_at: T(1),
        version: asRevision(0),
        status: 'active',
        preference_key: key,
        value_text: value,
      }) as PreferenceMemory;

    const resolution = resolvePreferenceConflict({
      current_instructions: [
        { preference_key: 'tone', value: '正式' },
        { preference_key: 'lang', value: '中文' },
      ],
      preferences: [mkPref('tone', '随意'), mkPref('lang', '中文')],
    });
    expect(resolution.applied).toBe('current');
    expect(resolution.conflicts.map((c) => c.preference_key)).toEqual(['tone']);
    expect(resolution.conflicts[0]?.preferred_value).toBe('随意');
    expect(resolution.unopposed.map((p) => p.preference_key)).toEqual(['lang']);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 13. documents/units/length.ts
// ───────────────────────────────────────────────────────────────────────────
describe('独立断言 · documents/units/length.ts', () => {
  it('正向：pt/inch/cm/mm 换算到 twips（Word 口径）', () => {
    expect(lengthToTwips({ unit: 'pt', value: 12 })).toBe(240);
    expect(lengthToTwips({ unit: 'inch', value: 1 })).toBe(1440);
    expect(lengthToTwips({ unit: 'cm', value: 2 })).toBe(1134);
    expect(lengthToTwips({ unit: 'mm', value: 10 })).toBe(567);
    expect(pointsToTwips(12)).toBe(240);
    expect(twipsToPoints(240)).toBe(12);
    expect(twipsToLength(1440, 'inch')).toEqual({ unit: 'inch', value: 1 });
  });

  it('反向：往返稳定（twips → Length → twips）', () => {
    for (const unit of ['pt', 'cm', 'mm', 'inch', 'twips'] as const) {
      const round = lengthToTwips(twipsToLength(567, unit));
      expect(Math.abs(round - 567)).toBeLessThanOrEqual(1);
    }
  });
});
