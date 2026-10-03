/**
 * D02A-WF3 —— design-02 **P6**「三类模板各自的最小能力合同与明确边界」的验收（**J7**）。
 *
 * 判据来源：任务书 **§6** 的三行模板合同 + 合同 v1.4 **R48.2 / R48.3 / R53** +
 * design-02 需求 6 / 验收标准。
 *
 * | 类 | §6 明确边界 | J7 的机器判据 |
 * |---|---|---|
 * | 文档 | **不自行改写已确认人数、金额与日期** | 正文里的关键值与事实快照**逐字一致**；且"额外数字"被**判出**（构建期拒绝 / `untraceableDigitRuns` 报出） |
 * | 表格 | **缺失值不默认视为零**；关键计算经代码检查 | 未知事实 ⇒ 值单元格**整格不存在**、全文无 `<v>0</v>`；**对照**：已知的 0 必须写出 |
 * | 演示 | **引用统一数据，不另编数字** | 产物**可见文本**里每个数字都能指认到快照；非事实文本含数字 ⇒ 构建期拒绝 |
 *
 * ## 判据跑在"可见文本"上（这是一条必须写明的前提）
 *
 * `untraceableDigitRuns` 的口径是**原子字符串整段掩码**，只适合跑在**可见文本**上。
 * 本文件用第 2 层独立读回（`independent-readback.ts`）取 `part_text`——它来自
 * `xml.etree` 的 `itertext()`，**只含文本节点、不含属性值**，因此几何 / 字号等属性里的
 * 数字不会污染判定。若哪天读回口径变成"含属性"，本条判据会失效（已在声明里登记）。
 *
 * ## 正例走真实管线，负例走构建器
 *
 * 正例（三类各一份）经 `office-support.ts` 的场景夹具**真实发布**再独立读回——
 * 证明的不是"构建器自己说得对"，而是盘上那份真实产物。负例与单元格级纵深防御
 * （表格的未知值）直接调**公开纯构建器**，因为那正是"构建器边界"本身的被测对象；
 * 场景级的同一输入会更早被 `missing_fact` 阻塞（已由 `p3-shared-facts.test.ts` 覆盖）。
 */

import { readFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ValidationError,
  asFactRef,
  asInstanceId,
  asLogicalTime,
  asRevision,
  createSharedFactRecord,
  isDeliveredArtifact,
  type ArtifactRecord,
  type FactRef,
  type FactSource,
  type SharedFactRecord,
  type SharedFactValue,
} from '../../../src/protocol/index.js';
import type { KnownFactSnapshotEntry } from '../../../src/artifacts/ports.js';
import {
  buildDocxTemplate,
  renderDocxFactValue,
  untraceableDigitRuns,
} from '../../../src/artifacts/templates/docx.js';
import {
  buildPresentation,
  renderFactLine,
} from '../../../src/artifacts/templates/pptx.js';
import {
  buildXlsxSheetXml,
  buildXlsxTemplate,
  computeLineTotal,
  type XlsxFactEntry,
  type XlsxFactValue,
  type XlsxSheetSpec,
} from '../../../src/artifacts/templates/xlsx.js';
import {
  OFFICE_SHARED_FACT_KEY,
  OFFICE_TASK_ID,
  buildOfficeScenario,
  type OfficeScenario,
} from './office-support.js';

// ---------------------------------------------------------------------------
// 场景事实（与 `p3-shared-facts.test.ts` 同源构造；J7 只关心"值有没有被改写"）
// ---------------------------------------------------------------------------

const CONFIRMER = asInstanceId('inst-wf3-p6');
const USER_SOURCE: FactSource = Object.freeze({
  kind: 'user_confirmation',
  detail: '用户在前台确认（WF3-P6 场景）',
});

const HEADCOUNT_REF = asFactRef('fact-wf3-p6-headcount');
const BUDGET_REF = asFactRef('fact-wf3-p6-budget-total');
const DATE_REF = asFactRef('fact-wf3-p6-event-date');

function makeFact(id: FactRef, key: string, value: SharedFactValue): SharedFactRecord {
  return createSharedFactRecord({
    fact_id: id,
    task_id: OFFICE_TASK_ID,
    task_revision: asRevision(1),
    fact_key: key,
    value,
    source: USER_SOURCE,
    confirmed_by: CONFIRMER,
    confirmed_at: asLogicalTime(1),
    supersedes_fact_id: null,
  });
}

function entryOf(fact: SharedFactRecord): KnownFactSnapshotEntry {
  const value = fact.value;
  if (value.kind !== 'known') {
    throw new Error(`断言保护：${fact.fact_key} 必须是 known 才能进快照`);
  }
  return { fact_ref: fact.fact_id, fact_key: fact.fact_key, value: value.value, source: fact.source };
}

const HEADCOUNT_8 = makeFact(HEADCOUNT_REF, OFFICE_SHARED_FACT_KEY, {
  kind: 'known',
  value: { type: 'number', amount: 8, unit: '人', currency: null },
});
const BUDGET_600 = makeFact(BUDGET_REF, 'budget.total', {
  kind: 'known',
  value: { type: 'number', amount: 600, unit: '元', currency: 'CNY' },
});
const DATE_1002 = makeFact(DATE_REF, 'event.date', {
  kind: 'known',
  value: { type: 'date', iso_date: '2026-10-02', time_zone: 'Asia/Shanghai' },
});

const HEADCOUNT_ENTRY = entryOf(HEADCOUNT_8);
const BUDGET_ENTRY = entryOf(BUDGET_600);
const DATE_ENTRY = entryOf(DATE_1002);

/** 文档消费的事实键 = 夹具的 `OFFICE_FACT_KEYS_BY_KIND.document`。 */
const DOC_SNAPSHOT: readonly KnownFactSnapshotEntry[] = [HEADCOUNT_ENTRY, DATE_ENTRY];
/** 演示消费的事实键 = `OFFICE_FACT_KEYS_BY_KIND.presentation`。 */
const PRES_SNAPSHOT: readonly KnownFactSnapshotEntry[] = [
  HEADCOUNT_ENTRY,
  BUDGET_ENTRY,
  DATE_ENTRY,
];

/** 抓一个同步抛错（负例用；不让 try/catch 吞掉断言细节）。 */
function captureThrow(work: () => unknown): unknown {
  try {
    work();
    return undefined;
  } catch (error) {
    return error;
  }
}

// ---------------------------------------------------------------------------
// 共享场景：三类产物各真实发布一份（正例的唯一数据来源）
// ---------------------------------------------------------------------------

let shared: OfficeScenario;

beforeAll(() => {
  shared = buildOfficeScenario('p6-template-contracts');
  for (const fact of [HEADCOUNT_8, BUDGET_600, DATE_1002]) shared.registerFact(fact);
  shared.mark('注册 3 条共享事实');
  shared.materializeAll();
  shared.mark('放行产物发布投影');
});

afterAll(() => {
  shared?.cleanup();
});

function recordOfKind(kind: 'document' | 'spreadsheet' | 'presentation'): ArtifactRecord {
  const rows = shared.artifacts().filter(
    (record) => record.template_kind === kind && isDeliveredArtifact(record),
  );
  expect(rows).toHaveLength(1);
  const record = rows[0];
  if (record === undefined) throw new Error(`断言保护：${kind} 应恰好有 1 条已发布记录`);
  return record;
}

/** 先断言夹具确实产生了数据（每个正例的第一条断言）。 */
function expectSharedScenarioProduced(): void {
  expect(shared.materializeCalls()).toBe(3);
  expect(shared.artifacts().filter((record) => isDeliveredArtifact(record))).toHaveLength(3);
}

// ---------------------------------------------------------------------------
// J7-文档：不自行改写已确认人数 / 金额 / 日期
// ---------------------------------------------------------------------------

describe('J7-文档：不自行改写已确认数据（人数 / 金额 / 日期）', () => {
  it('正例：正文里的关键值逐字来自事实快照，且没有任何快照外的数字', () => {
    expectSharedScenarioProduced();
    const document = recordOfKind('document');
    const readback = shared.readback(shared.runFileOf(document));
    expect(readback.ok).toBe(true);

    // 先断言"读回来了正文"，再断言内容——否则空串会静默通过后面的检查。
    expect(Object.keys(readback.part_text)).toContain('word/document.xml');
    const text = readback.part_text['word/document.xml'];
    expect(text === undefined).toBe(false);
    const body = text ?? '';

    // 人数与日期逐字等于快照（8 就是 8，不是"约八人"、不是别的数）——字面量写死在断言里，
    // 不经过被测渲染器，因此"渲染器把 8 改成 10"会当场变红。
    expect(body).toContain('headcount: 8 人');
    expect(body).toContain('event.date: 2026-10-02 (Asia/Shanghai)');

    // 没有快照外的数字（构建器自己的边界检查器，独立跑在**读回的真实正文**上）。
    expect(untraceableDigitRuns(body, DOC_SNAPSHOT)).toEqual([]);
  });

  it('负例：正文出现快照外的数字 ⇒ 构建期拒绝', () => {
    const input = {
      requirement: { title: '聚餐安排 10 人', description: '不改写已确认数据' },
      fact_snapshot: [HEADCOUNT_ENTRY] as readonly KnownFactSnapshotEntry[],
      references: [{ label: '用户确认', detail: '人数由用户在前台确认' }],
    };
    const caught = captureThrow(() => buildDocxTemplate(input));
    expect(caught instanceof ValidationError).toBe(true);
    const message = caught instanceof Error ? caught.message : '';
    // 拒因必须点明是哪个数字凭空出现（可指认，不是笼统报错）。
    expect(message.includes('10')).toBe(true);
  });

  it('负例（同源检查器直测）：额外数字被判出，快照内的数字放行', () => {
    expect(untraceableDigitRuns('聚餐安排 10 人', [HEADCOUNT_ENTRY])).toEqual(['10']);
    expect(untraceableDigitRuns('headcount: 8 人', [HEADCOUNT_ENTRY])).toEqual([]);
    // 掩码是**原子串整段匹配**：日期整串在 ⇒ 放行；单独的 10 冒出来 ⇒ 抓住。
    expect(untraceableDigitRuns('会议日期 2026-10-02 开始', [DATE_ENTRY])).toEqual([]);
    expect(untraceableDigitRuns('第 10 次会议', [DATE_ENTRY])).toEqual(['10']);
    // 展示器本身不做算术：8 就渲染成 "8 人"。
    expect(renderDocxFactValue({ type: 'number', amount: 8, unit: '人', currency: null })).toBe('8 人');
  });
});

// ---------------------------------------------------------------------------
// J7-表格：缺失值不默认视为零（对照：已知的 0 必须写出）
// ---------------------------------------------------------------------------

const SHEET_SPEC: XlsxSheetSpec = {
  sheet_name: '人数汇总',
  label_header: '项目',
  value_header: '数量',
  unit: '人',
  lines: [{ label: '参会人数', fact_key: OFFICE_SHARED_FACT_KEY }],
  total_label: '合计',
  scale: 0,
};

function sheetEntry(value: XlsxFactValue): XlsxFactEntry {
  return {
    fact_ref: HEADCOUNT_REF,
    fact_key: OFFICE_SHARED_FACT_KEY,
    value,
    source: USER_SOURCE,
  };
}

describe('J7-表格：缺失值不默认视为零', () => {
  it('未知事实 ⇒ 值单元格整格不存在，全文无 <v>0</v>', () => {
    const unknown = sheetEntry({ kind: 'unknown', reason: '用户尚未确认人数' });
    const xml = buildXlsxSheetXml(SHEET_SPEC, [unknown]);

    // 先断言确实生成了表格骨架（否则"没有 B2"可能只是因为什么都没生成）。
    expect(xml).toContain('<worksheet');
    expect(xml).toContain('<sheetData>');
    expect(xml).toContain('参会人数');
    expect(xml).toContain('r="A2"'); // 标签格在 ⇒ 整行存在
    expect(xml).toContain('r="A3"'); // 合计标签也在

    // 值格与合计格**整格不存在**；全部单元格里没有任何 <v>。
    expect(xml.includes('r="B2"')).toBe(false);
    expect(xml.includes('r="B3"')).toBe(false);
    expect(xml.includes('<v>')).toBe(false);
    expect(xml.includes('<v>0</v>')).toBe(false);

    // 容器全文（全 STORE，工作表 XML 原样在字节里）同样不含 <v>0</v>。
    const bytes = buildXlsxTemplate(SHEET_SPEC, [unknown]).bytes;
    expect(bytes.byteLength > 0).toBe(true);
    expect(bytes.includes('<v>0</v>')).toBe(false);

    // 关键计算经代码检查：未知 ⇒ 不可计算，给出原因而不是"把缺失当零的部分和"。
    expect(computeLineTotal(SHEET_SPEC, [unknown])).toEqual({ ok: false, reason: 'unknown_fact' });
  });

  it('not_applicable 与被缺失的键同样留空（各自给出可指认的原因）', () => {
    const notApplicableValue: XlsxFactValue = { kind: 'not_applicable', reason: '本任务不统计人数' };
    expect(xmlHasNoNumericCell(notApplicableValue)).toBe(true);
    expect(computeLineTotal(SHEET_SPEC, [sheetEntry(notApplicableValue)])).toEqual({
      ok: false,
      reason: 'not_applicable_fact',
    });

    // 快照里根本没有这个键 ⇒ missing_fact（同样不得补 0）。
    const missingXml = buildXlsxSheetXml(SHEET_SPEC, []);
    expect(missingXml.includes('<v>')).toBe(false);
    expect(computeLineTotal(SHEET_SPEC, [])).toEqual({ ok: false, reason: 'missing_fact' });
  });

  it('对照：已知的 0 是合法值 ⇒ 必须写出（不是缺失、不得留空）', () => {
    const zero = sheetEntry({ type: 'number', amount: 0, unit: '人', currency: null });
    const xml = buildXlsxSheetXml(SHEET_SPEC, [zero]);

    expect(xml).toContain('r="B2"');
    expect(xml).toContain('<v>0</v>');
    expect(xml.includes('r="B3"')).toBe(true);

    const bytes = buildXlsxTemplate(SHEET_SPEC, [zero]).bytes;
    expect(bytes.includes('<v>0</v>')).toBe(true);

    expect(computeLineTotal(SHEET_SPEC, [zero])).toEqual({ ok: true, amount: 0 });
  });

  it('正例（真实管线）：场景产出的表格里，与快照一致的值被写出', () => {
    expectSharedScenarioProduced();
    const sheet = recordOfKind('spreadsheet');
    const path = shared.runFileOf(sheet);
    const bytes = readFileSync(path);
    expect(bytes.includes('<v>8</v>')).toBe(true);

    const readback = shared.readback(path);
    expect(readback.ok).toBe(true);
    const text = readback.part_text['xl/worksheets/sheet1.xml'];
    expect(text === undefined).toBe(false);
    expect(text ?? '').toContain('参会人数');
    expect(text ?? '').toContain('8');
  });
});

function xmlHasNoNumericCell(value: XlsxFactValue): boolean {
  const xml = buildXlsxSheetXml(SHEET_SPEC, [sheetEntry(value)]);
  return !xml.includes('<v>') && !xml.includes('r="B2"');
}

// ---------------------------------------------------------------------------
// J7-演示：不另编数字（引用统一数据）
// ---------------------------------------------------------------------------

describe('J7-演示：不另编数字（每个数字都能指认到快照）', () => {
  it('正例：产物可见文本里每个数字都能指认到快照，非事实文本无数字', () => {
    expectSharedScenarioProduced();
    const presentation = recordOfKind('presentation');
    const readback = shared.readback(shared.runFileOf(presentation));
    expect(readback.ok).toBe(true);

    // 第 1 张：标题 / 目标 / 受众——**不得含任何数字**。
    expect(Object.keys(readback.part_text)).toContain('ppt/slides/slide1.xml');
    const slide1 = readback.part_text['ppt/slides/slide1.xml'] ?? '';
    expect(slide1.includes('聚餐安排')).toBe(true);
    expect(/[0-9]/.test(slide1)).toBe(false);

    // 第 2 张：事实页——每个数字串都必须能在快照里找到出处。
    expect(Object.keys(readback.part_text)).toContain('ppt/slides/slide2.xml');
    const slide2raw = readback.part_text['ppt/slides/slide2.xml'];
    expect(slide2raw === undefined).toBe(false);
    const slide2 = slide2raw ?? '';
    expect(slide2).toContain('headcount：8 人');
    expect(slide2).toContain('budget.total：600 元 CNY');
    expect(untraceableDigitRuns(slide2, PRES_SNAPSHOT)).toEqual([]);
  });

  it('负例：非事实文本含数字 ⇒ 构建期拒绝（不静默、不截断）', () => {
    for (const [field, input] of [
      ['title', { title: '第 2 次聚餐安排', goal: '确认聚餐人数', audience: '筹备组' }],
      ['goal', { title: '聚餐安排', goal: '确认 2 人聚餐', audience: '筹备组' }],
      ['audience', { title: '聚餐安排', goal: '确认聚餐人数', audience: '第 3 组' }],
    ] as const) {
      const caught = captureThrow(() =>
        buildPresentation({ ...input, fact_snapshot: PRES_SNAPSHOT }),
      );
      expect(caught instanceof ValidationError).toBe(true);
      const message = caught instanceof Error ? caught.message : '';
      expect(message.includes(field)).toBe(true);
    }
  });

  it('同源检查器：事实行放行，快照外的数字被抓出', () => {
    // 事实行里的 8 指认得到（同一份快照）。
    const line = renderFactLine(HEADCOUNT_ENTRY);
    expect(line).toBe('headcount：8 人');
    expect(untraceableDigitRuns(line, [HEADCOUNT_ENTRY])).toEqual([]);
    // 同一段文本里冒出快照外的 600 ⇒ 抓住（演示不得另编数字）。
    expect(untraceableDigitRuns('预算 600 元', [HEADCOUNT_ENTRY])).toEqual(['600']);
  });
});
