/**
 * P-R06 · **模型生成内容的来源、数据/单位/引用与事实版本**的定向取证。
 *
 * ## 判据的来源纪律
 *
 * - **事实版本 / 事实值 / 单位**：用 `src/presentations/fact-sync.ts` 的**真实** `versionedSnapshot`
 *   造快照，再用 `lookupVersionedFact` 独立查回，与被测审计器读数**交叉断言**——不是拿本模块
 *   自己的常量自证；快照能被本模块的 `FactSnapshotView` 直接接收也同时证明两层结构互换。
 * - **单位换算**：期望值**手算**写死（`8000 person = 8 kperson`、`90 min = 1.5 h`…），
 *   不调用被测换算器反推。
 * - **协议对齐**：`quantityFromFactValue` 的输入用 protocol 的 `NumberFactValue` 字段形状。
 *
 * ## 反向对照（不许空壳）
 *
 * 每个坏样例都在正例上**只偏离一处**，其触发的判据必须**恰好**是预期的那一条：
 *
 * | 坏样例 | 期望判据 |
 * |---|---|
 * | 事实版本记为 r2、目标 r3 | `stale_fact_version` |
 * | 数值 7 而事实为 8 | `fact_value_mismatch` |
 * | 单位 `kperson` 而事实为 `person` | `fact_unit_mismatch` |
 * | 目标快照无此键 | `missing_fact` |
 * | 数值事实却没有量 | `bare_number` |
 * | 文本事实却挂了数值 | `fact_type_mismatch` |
 * | 未登记单位 `widgets` | `unknown_unit` |
 * | 维度不符（人当钱） | `unit_dimension_mismatch` |
 * | 资料内容无引用 | `missing_citation` |
 * | 引用未声明来源 | `citation_unresolved` |
 * | 模型来源缺 run_id | `unattributed_model_output` |
 * | 必备单元缺席 | `missing_provenance` |
 *
 * 单位换算另有负例：跨币种 ⇒ `rate_required`、跨维度 ⇒ `incompatible_unit`、
 * 未登记 ⇒ `unknown_unit`、币种缺失/多余 ⇒ `currency_required` / `currency_not_allowed`。
 */

import { describe, expect, it } from 'vitest';

import {
  lookupVersionedFact,
  versionedSnapshot,
  type VersionedFactSnapshot,
} from '../../../../src/presentations/fact-sync.js';

import {
  ProvenanceCitationError,
  ProvenanceError,
  ProvenanceUnitError,
  auditProvenance,
  buildProvenanceManifest,
  buildSourceRegistry,
  contentProvenance,
  convertQuantity,
  describeOrigin,
  dimensionOf,
  formatCitation,
  formatProvenanceLine,
  formatQuantity,
  makeCitation,
  parseQuantity,
  quantityEquals,
  quantityFromFactValue,
  sameFactVersion,
  unitsCompatible,
  unitDef,
  type CitationRef,
  type ContentProvenanceRecord,
  type FactVersion,
  type ProvenanceAuditReport,
  type ProvenanceCitationErrorReason,
  type ProvenanceConflictKind,
  type ProvenanceErrorReason,
  type ProvenanceManifest,
  type ProvenanceUnitErrorReason,
  type Quantity,
  type SourceDeclaration,
} from './provenance/index.js';

// ---------------------------------------------------------------------------
// 夹具（全部手写常量；事实快照来自 fact-sync 真实实现）
// ---------------------------------------------------------------------------

const V2: FactVersion = { task_id: 't1', task_revision: 2 };
const V3: FactVersion = { task_id: 't1', task_revision: 3 };

/** 目标版本 r3 的**真实** fact-sync 快照：人数 8、预算 1200000 CNY、日期、文本。 */
const SNAPSHOT: VersionedFactSnapshot = versionedSnapshot(V3, [
  { fact_key: 'headcount', fact_ref: 'f-hc', value: { type: 'number', amount: 8, unit: 'person', currency: null } },
  {
    fact_key: 'budget.total',
    fact_ref: 'f-budget',
    value: { type: 'number', amount: 1_200_000, unit: 'CNY', currency: 'CNY' },
  },
  {
    fact_key: 'event.date',
    fact_ref: 'f-date',
    value: { type: 'date', iso_date: '2026-10-03', time_zone: 'Asia/Shanghai' },
  },
  { fact_key: 'project.name', fact_ref: 'f-name', value: { type: 'text', text: '深蓝计划', source: '立项书' } },
]);

const SOURCE_ANNUAL: SourceDeclaration = {
  source_id: 'src-annual',
  title: '年报',
  origin: 'user_document',
  retrieved_at: '2026-10-01T00:00:00Z',
};

function factOrigin(factKey: string, factRef: string, version: FactVersion) {
  return { kind: 'fact' as const, fact_key: factKey, fact_ref: factRef, version };
}

function expectUnitReason(fn: () => unknown, reason: ProvenanceUnitErrorReason): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ProvenanceUnitError);
    expect((error as ProvenanceUnitError).reason).toBe(reason);
    return;
  }
  throw new Error(`期望抛出 ProvenanceUnitError(${reason})，但没有抛错`);
}

function expectCitationReason(fn: () => unknown, reason: ProvenanceCitationErrorReason): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ProvenanceCitationError);
    expect((error as ProvenanceCitationError).reason).toBe(reason);
    return;
  }
  throw new Error(`期望抛出 ProvenanceCitationError(${reason})，但没有抛错`);
}

function expectProvenanceReason(fn: () => unknown, reason: ProvenanceErrorReason): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ProvenanceError);
    expect((error as ProvenanceError).reason).toBe(reason);
    return;
  }
  throw new Error(`期望抛出 ProvenanceError(${reason})，但没有抛错`);
}

function conflictKinds(report: ProvenanceAuditReport): readonly ProvenanceConflictKind[] {
  return report.conflicts.map((entry) => entry.kind);
}

/** 直接组装清单（绕过 `buildProvenanceManifest` 的构建期校验），用于喂"坏"记录给审计器。 */
function rawManifest(
  records: readonly ContentProvenanceRecord[],
  declarations: readonly SourceDeclaration[] = [],
): ProvenanceManifest {
  const sources = buildSourceRegistry(declarations);
  return Object.freeze({
    records: Object.freeze([...records]),
    sources,
    byUnitId: new Map(records.map((record) => [record.unit_id, record] as const)),
  });
}

// ---------------------------------------------------------------------------
// A. 数据与单位
// ---------------------------------------------------------------------------

describe('A. 数据与单位', () => {
  it('构造带单位的量并冻结；注册表可查', () => {
    const q = parseQuantity(8, 'person');
    expect(q).toEqual({ value: 8, unit: 'person', currency: null });
    expect(Object.isFrozen(q)).toBe(true);
    expect(unitDef('kperson')?.factor).toBe(1000);
    expect(unitDef('widgets')).toBeUndefined();
    expect(dimensionOf('%')).toBe('ratio');
    expect(dimensionOf('CNY')).toBe('currency');
  });

  it('币种类量必须给匹配的 currency；非币种不得给', () => {
    expect(parseQuantity(1_200_000, 'CNY', 'CNY')).toEqual({
      value: 1_200_000,
      unit: 'CNY',
      currency: 'CNY',
    });
    expectUnitReason(() => parseQuantity(1, 'CNY'), 'currency_required');
    expectUnitReason(() => parseQuantity(1, 'CNY', 'USD'), 'currency_required');
    expectUnitReason(() => parseQuantity(8, 'person', 'CNY'), 'currency_not_allowed');
  });

  it('反向对照：非法量值 / 空单位 / 未登记单位都具名报错', () => {
    expectUnitReason(() => parseQuantity(Number.NaN, 'person'), 'non_finite_value');
    expectUnitReason(() => parseQuantity(Number.POSITIVE_INFINITY, 'person'), 'non_finite_value');
    expectUnitReason(() => parseQuantity(8, ''), 'empty_unit');
    expectUnitReason(() => parseQuantity(8, 'widgets'), 'unknown_unit');
    expectUnitReason(() => dimensionOf('widgets'), 'unknown_unit');
  });

  it('同维度换算与手算一致（人数 / 时长 / 比率 / 长度 / 质量）', () => {
    expect(convertQuantity(parseQuantity(8000, 'person'), 'kperson').value).toBe(8);
    expect(convertQuantity(parseQuantity(90, 'min'), 'h').value).toBe(1.5);
    expect(convertQuantity(parseQuantity(15, '%'), 'ratio').value).toBeCloseTo(0.15, 12);
    expect(convertQuantity(parseQuantity(2, 'km'), 'm').value).toBe(2000);
    expect(convertQuantity(parseQuantity(1500, 'g'), 'kg').value).toBe(1.5);
  });

  it('反向对照：跨维度 / 跨币种 / 未登记目标都具名报错', () => {
    expectUnitReason(() => convertQuantity(parseQuantity(8, 'person'), 'CNY'), 'incompatible_unit');
    expectUnitReason(
      () => convertQuantity(parseQuantity(1200, 'CNY', 'CNY'), 'USD'),
      'rate_required',
    );
    expectUnitReason(() => convertQuantity(parseQuantity(8, 'person'), 'widgets'), 'unknown_unit');
    expect(unitsCompatible('person', 'kperson')).toBe(true);
    expect(unitsCompatible('person', 'CNY')).toBe(false);
    expectUnitReason(() => unitsCompatible('person', 'widgets'), 'unknown_unit');
  });

  it('确定性格式：人 / 币 / 百分号 / 时长', () => {
    expect(formatQuantity(parseQuantity(8, 'person'))).toBe('8 人');
    expect(formatQuantity(parseQuantity(1_200_000, 'CNY', 'CNY'))).toBe('CNY 1200000');
    expect(formatQuantity(parseQuantity(15, '%'))).toBe('15%');
    expect(formatQuantity(parseQuantity(2, 'h'))).toBe('2 小时');
    expect(formatQuantity(parseQuantity(1.5, 'min'))).toBe('1.5 分钟');
  });

  it('从事实数值载荷造量（与 protocol.NumberFactValue 字段对齐）', () => {
    const fromFact = quantityFromFactValue({ type: 'number', amount: 8, unit: 'person', currency: null });
    expect(quantityEquals(fromFact, parseQuantity(8, 'person'))).toBe(true);
    // 交叉断言：与真实快照里该事实的读回值一致
    const entry = lookupVersionedFact(SNAPSHOT, 'headcount');
    expect(entry?.value.type).toBe('number');
    if (entry?.value.type === 'number') {
      expect(quantityFromFactValue(entry.value)).toEqual(fromFact);
    }
  });
});

// ---------------------------------------------------------------------------
// B. 引用与来源
// ---------------------------------------------------------------------------

describe('B. 引用与来源', () => {
  it('来源注册表：可查、顺序稳定、重复 id 报错', () => {
    const registry = buildSourceRegistry([SOURCE_ANNUAL]);
    expect(registry.has('src-annual')).toBe(true);
    expect(registry.get('src-annual')?.title).toBe('年报');
    expect(registry.ids()).toEqual(['src-annual']);
    expectCitationReason(
      () => buildSourceRegistry([SOURCE_ANNUAL, SOURCE_ANNUAL]),
      'duplicate_source_id',
    );
  });

  it('反向对照：来源字段非法具名报错', () => {
    expectCitationReason(
      () => buildSourceRegistry([{ ...SOURCE_ANNUAL, source_id: '' }]),
      'empty_source_id',
    );
    expectCitationReason(() => buildSourceRegistry([{ ...SOURCE_ANNUAL, title: '' }]), 'empty_title');
    expectCitationReason(
      () => buildSourceRegistry([{ ...SOURCE_ANNUAL, origin: 'blog' as never }]),
      'invalid_origin',
    );
  });

  it('引用构造与解析：定位器非空、指向未声明来源报错', () => {
    const registry = buildSourceRegistry([SOURCE_ANNUAL]);
    const citation = makeCitation({ source_id: 'src-annual', locator: 'p.3', quote: '第八次会议' });
    expect(citation.quote).toBe('第八次会议');
    expect(() => formatCitation(registry, citation)).not.toThrow();
    expect(formatCitation(registry, citation)).toBe('[年报 p.3: "第八次会议"]');
    expectCitationReason(
      () => makeCitation({ source_id: 'src-annual', locator: '' }),
      'empty_locator',
    );
    expectCitationReason(() => makeCitation({ source_id: '', locator: 'p.1' }), 'empty_source_id');
  });
});

// ---------------------------------------------------------------------------
// C. 来源记录与清单
// ---------------------------------------------------------------------------

describe('C. 来源记录与清单', () => {
  it('四类来源都能构造；事实来源必须带同版 fact_version', () => {
    const model = contentProvenance({
      unit_id: 'slide1/shape2/run0',
      origin: {
        kind: 'model',
        provider: 'deepseek',
        model_id: 'deepseek-flash',
        run_id: 'run-77',
        prompt_ref: 'p-outline',
      },
    });
    expect(model.data).toBeNull();
    expect(model.fact_version).toBeNull();

    const fact = contentProvenance({
      unit_id: 'slide2/shape5/run0',
      origin: factOrigin('headcount', 'f-hc', V3),
      data: parseQuantity(8, 'person'),
      fact_version: V3,
    });
    expect(fact.fact_version?.task_revision).toBe(3);

    const doc = contentProvenance({
      unit_id: 'slide3/shape1/body',
      origin: { kind: 'document', source_id: 'src-annual', locator: 'p.3' },
      citations: [makeCitation({ source_id: 'src-annual', locator: 'p.3' })],
    });
    expect(doc.citations).toHaveLength(1);

    const user = contentProvenance({
      unit_id: 'slide1/shape1/title',
      origin: { kind: 'user', confirmed_by: 'inst-1', confirmed_at: 12 },
    });
    expect(user.origin.kind).toBe('user');
  });

  it('反向对照：单元 id 空 / 模型来源缺 run_id / 文档缺定位器都报错', () => {
    expectProvenanceReason(
      () =>
        contentProvenance({
          unit_id: '',
          origin: { kind: 'user', confirmed_by: 'u', confirmed_at: 1 },
        }),
      'empty_unit_id',
    );
    expectProvenanceReason(
      () =>
        contentProvenance({
          unit_id: 'a',
          origin: { kind: 'model', provider: 'deepseek', model_id: 'deepseek-flash', run_id: '', prompt_ref: 'p' },
        }),
      'invalid_origin',
    );
    expectProvenanceReason(
      () =>
        contentProvenance({
          unit_id: 'a',
          origin: { kind: 'document', source_id: 's', locator: '' },
        }),
      'invalid_origin',
    );
    expectProvenanceReason(
      () =>
        contentProvenance({
          unit_id: 'a',
          origin: { kind: 'user', confirmed_by: 'u', confirmed_at: Number.NaN },
        }),
      'invalid_origin',
    );
  });

  it('反向对照：事实来源缺版本 / 版本不符 / 无事实来源挂版本都报错', () => {
    expectProvenanceReason(
      () => contentProvenance({ unit_id: 'a', origin: factOrigin('headcount', 'f-hc', V3) }),
      'invalid_origin',
    );
    expectProvenanceReason(
      () =>
        contentProvenance({
          unit_id: 'a',
          origin: factOrigin('headcount', 'f-hc', V3),
          fact_version: V2,
        }),
      'invalid_origin',
    );
    expectProvenanceReason(
      () =>
        contentProvenance({
          unit_id: 'a',
          origin: { kind: 'user', confirmed_by: 'u', confirmed_at: 1 },
          fact_version: V3,
        }),
      'orphan_fact_version',
    );
  });

  it('清单构建即查重与引用解析；确定性行格式', () => {
    const records = [
      contentProvenance({
        unit_id: 'slide1/shape1/title',
        origin: { kind: 'user', confirmed_by: 'inst-1', confirmed_at: 12 },
      }),
      contentProvenance({
        unit_id: 'slide3/shape1/body',
        origin: { kind: 'document', source_id: 'src-annual', locator: 'p.3' },
        citations: [makeCitation({ source_id: 'src-annual', locator: 'p.3' })],
      }),
    ];
    const manifest = buildProvenanceManifest(records, [SOURCE_ANNUAL]);
    expect(manifest.records).toHaveLength(2);
    expect(manifest.byUnitId.get('slide3/shape1/body')?.unit_id).toBe('slide3/shape1/body');
    expect(formatProvenanceLine(records[1]!, manifest.sources)).toBe(
      'slide3/shape1/body ← document:src-annual(p.3) · [年报 p.3]',
    );
    expect(describeOrigin(records[0]!.origin)).toBe('user:inst-1@12');

    // 重复单元 id
    expectProvenanceReason(
      () => buildProvenanceManifest([records[0]!, records[0]!], []),
      'duplicate_unit_id',
    );
    // 引用未声明来源（构建期就抛）
    expectProvenanceReason(
      () =>
        buildProvenanceManifest(
          [
            contentProvenance({
              unit_id: 'x',
              origin: { kind: 'document', source_id: 'ghost', locator: 'p.1' },
              citations: [makeCitation({ source_id: 'ghost', locator: 'p.1' })],
            }),
          ],
          [],
        ),
      'citation_unresolved',
    );
  });
});

// ---------------------------------------------------------------------------
// D. 事实版本审计（与 fact-sync 真实快照交叉）
// ---------------------------------------------------------------------------

describe('D. 事实版本审计', () => {
  /** 一份"完全正确"的清单：三处内容分别来自用户 / 事实 / 资料。 */
  function goodManifest(): ProvenanceManifest {
    return buildProvenanceManifest(
      [
        contentProvenance({
          unit_id: 'slide1/shape1/title',
          origin: { kind: 'user', confirmed_by: 'inst-1', confirmed_at: 12 },
        }),
        contentProvenance({
          unit_id: 'slide2/shape5/run0',
          origin: factOrigin('headcount', 'f-hc', V3),
          data: parseQuantity(8, 'person'),
          fact_version: V3,
        }),
        contentProvenance({
          unit_id: 'slide2/shape6/chart1',
          origin: factOrigin('budget.total', 'f-budget', V3),
          data: parseQuantity(1_200_000, 'CNY', 'CNY'),
          fact_version: V3,
        }),
        contentProvenance({
          unit_id: 'slide3/shape1/body',
          origin: { kind: 'document', source_id: 'src-annual', locator: 'p.3' },
          citations: [makeCitation({ source_id: 'src-annual', locator: 'p.3' })],
        }),
        contentProvenance({
          unit_id: 'slide4/shape2/run0',
          origin: {
            kind: 'model',
            provider: 'deepseek',
            model_id: 'deepseek-flash',
            run_id: 'run-77',
            prompt_ref: 'p-outline',
          },
        }),
      ],
      [SOURCE_ANNUAL],
    );
  }

  it('正例：来源可归属、单位齐、版本对 ⇒ 零冲突', () => {
    // 交叉断言：本模块 FactVersion 与 fact-sync 快照版本可互换
    expect(sameFactVersion(V3, SNAPSHOT.version)).toBe(true);

    const report = auditProvenance(goodManifest(), {
      target_version: V3,
      snapshot: SNAPSHOT,
      required_unit_ids: ['slide1/shape1/title', 'slide2/shape5/run0'],
      expected_dimension_by_key: { headcount: 'headcount', 'budget.total': 'currency' },
    });
    expect(report.ok).toBe(true);
    expect(report.conflicts).toEqual([]);
    expect(report.checked_units).toBe(5);
    expect(report.attributed_model_units).toBe(1);
    expect(report.scope.length).toBeGreaterThan(0);

    // 交叉核对：审计器读到的事实值与 fact-sync 的独立查询一致
    const headcount = lookupVersionedFact(SNAPSHOT, 'headcount');
    expect(headcount?.value).toEqual({ type: 'number', amount: 8, unit: 'person', currency: null });
  });

  it('反向对照：事实版本过期 ⇒ stale_fact_version', () => {
    const stale = buildProvenanceManifest(
      [
        contentProvenance({
          unit_id: 'slide2/shape5/run0',
          origin: factOrigin('headcount', 'f-hc', V2),
          data: parseQuantity(8, 'person'),
          fact_version: V2,
        }),
      ],
      [],
    );
    const report = auditProvenance(stale, { target_version: V3, snapshot: SNAPSHOT });
    expect(conflictKinds(report)).toEqual(['stale_fact_version']);
    expect(report.conflicts[0]?.fact_key).toBe('headcount');
    expect(report.conflicts[0]?.message).toContain('t1@r2');
    expect(report.conflicts[0]?.message).toContain('t1@r3');
  });

  it('反向对照：数值与事实不符 ⇒ fact_value_mismatch', () => {
    const wrong = rawManifest([
      contentProvenance({
        unit_id: 'slide2/shape5/run0',
        origin: factOrigin('headcount', 'f-hc', V3),
        data: parseQuantity(7, 'person'),
        fact_version: V3,
      }),
    ]);
    const report = auditProvenance(wrong, { target_version: V3, snapshot: SNAPSHOT });
    expect(conflictKinds(report)).toEqual(['fact_value_mismatch']);
  });

  it('反向对照：单位与事实不符 ⇒ fact_unit_mismatch（不隐式换算）', () => {
    const wrong = rawManifest([
      contentProvenance({
        unit_id: 'slide2/shape5/run0',
        origin: factOrigin('headcount', 'f-hc', V3),
        // 8000 person 数值上等于 8 kperson，但单位不同 ⇒ 必须报，不得偷偷换算放行
        data: parseQuantity(8, 'kperson'),
        fact_version: V3,
      }),
    ]);
    const report = auditProvenance(wrong, { target_version: V3, snapshot: SNAPSHOT });
    expect(conflictKinds(report)).toEqual(['fact_unit_mismatch']);
  });

  it('反向对照：目标快照无此键 ⇒ missing_fact', () => {
    const wrong = rawManifest([
      contentProvenance({
        unit_id: 'slide2/shape5/run0',
        origin: factOrigin('headcount.v2', 'f-hc2', V3),
        data: parseQuantity(8, 'person'),
        fact_version: V3,
      }),
    ]);
    const report = auditProvenance(wrong, { target_version: V3, snapshot: SNAPSHOT });
    expect(conflictKinds(report)).toEqual(['missing_fact']);
  });

  it('反向对照：数值事实却没有量 ⇒ bare_number', () => {
    const wrong = rawManifest([
      contentProvenance({
        unit_id: 'slide2/shape5/run0',
        origin: factOrigin('headcount', 'f-hc', V3),
        fact_version: V3,
      }),
    ]);
    const report = auditProvenance(wrong, { target_version: V3, snapshot: SNAPSHOT });
    expect(conflictKinds(report)).toEqual(['bare_number']);
  });

  it('反向对照：文本事实却挂数值 / 未登记单位 / 维度不符都报错', () => {
    // 文本事实挂数值
    const asNumber = rawManifest([
      contentProvenance({
        unit_id: 'slide4/shape1/run0',
        origin: factOrigin('project.name', 'f-name', V3),
        data: parseQuantity(3, 'person'),
        fact_version: V3,
      }),
    ]);
    expect(conflictKinds(auditProvenance(asNumber, { target_version: V3, snapshot: SNAPSHOT }))).toEqual([
      'fact_type_mismatch',
    ]);

    // 未登记单位（外部构造的记录，绕过 parseQuantity）
    const bogus = {
      unit_id: 'slide4/shape1/run0',
      origin: { kind: 'user', confirmed_by: 'u', confirmed_at: 1 },
      citations: [],
      data: { value: 8, unit: 'widgets', currency: null } as unknown as Quantity,
      fact_version: null,
    } satisfies ContentProvenanceRecord;
    expect(conflictKinds(auditProvenance(rawManifest([bogus]), { target_version: V3, snapshot: SNAPSHOT }))).toEqual([
      'unknown_unit',
    ]);

    // 维度不符：headcount 事实键却挂了货币单位
    const wrongDim = rawManifest([
      contentProvenance({
        unit_id: 'slide2/shape5/run0',
        origin: factOrigin('headcount', 'f-hc', V3),
        data: parseQuantity(8, 'CNY', 'CNY'),
        fact_version: V3,
      }),
    ]);
    const report = auditProvenance(wrongDim, {
      target_version: V3,
      snapshot: SNAPSHOT,
      expected_dimension_by_key: { headcount: 'headcount' },
    });
    expect(conflictKinds(report)).toContain('unit_dimension_mismatch');
  });

  it('反向对照：资料内容无引用 / 引用未声明 / 模型缺 run_id / 必备单元缺席', () => {
    const noCitation = rawManifest([
      contentProvenance({
        unit_id: 'slide3/shape1/body',
        origin: { kind: 'document', source_id: 'src-annual', locator: 'p.3' },
      }),
    ]);
    expect(conflictKinds(auditProvenance(noCitation, { target_version: V3, snapshot: SNAPSHOT }))).toEqual([
      'missing_citation',
    ]);

    const unresolved: CitationRef[] = [makeCitation({ source_id: 'ghost', locator: 'p.1' })];
    const cite = {
      unit_id: 'slide3/shape1/body',
      origin: { kind: 'document', source_id: 'src-annual', locator: 'p.3' },
      citations: unresolved,
      data: null,
      fact_version: null,
    } satisfies ContentProvenanceRecord;
    expect(conflictKinds(auditProvenance(rawManifest([cite]), { target_version: V3, snapshot: SNAPSHOT }))).toEqual([
      'citation_unresolved',
    ]);

    const noRun = {
      unit_id: 'slide5/shape1/run0',
      origin: { kind: 'model', provider: 'deepseek', model_id: 'deepseek-flash', run_id: '', prompt_ref: 'p' },
      citations: [],
      data: null,
      fact_version: null,
    } as unknown as ContentProvenanceRecord;
    expect(
      conflictKinds(auditProvenance(rawManifest([noRun]), { target_version: V3, snapshot: SNAPSHOT })),
    ).toEqual(['unattributed_model_output']);

    const missing = auditProvenance(goodManifest(), {
      target_version: V3,
      snapshot: SNAPSHOT,
      required_unit_ids: ['slide2/shape5/run0', 'slide9/shape1/ghost'],
    });
    expect(conflictKinds(missing)).toEqual(['missing_provenance']);
    expect(missing.conflicts[0]?.unit_id).toBe('slide9/shape1/ghost');
  });
});
