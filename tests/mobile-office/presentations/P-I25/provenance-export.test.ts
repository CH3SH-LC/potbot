/**
 * P-I25 · **归属层提升 + 导出接线**的定向取证。
 *
 * ## 判据（不是自证）
 *
 * 1. **真实导出路径**：用 `exportPresentationPdf`（P-I14 的导出）产出**真实字节**，再用本单元的
 *    调用钩子把归属清单作为部件写进去——断言的是**真实 PPTX 字节**，不是内存对象。
 * 2. **独立审计**：把部件**从字节里读回**，用 `auditProvenance` 对**真实 `fact-sync` 快照**再审计
 *    一次；零冲突才算通过。读回的 `FactVersion` / 数值另用 `lookupVersionedFact` 交叉断言。
 * 3. **重开可读**：读回的部件内容类型 = 本层登记的独立类型；`reopenEditablePptx` 仍能读回可编辑
 *    模型（注入不破坏演示）。
 * 4. **反空壳**：`require_clean:false` 时把**明知有冲突**的清单写进去，独立再审计**必须**报出那条
 *    冲突——证明"零冲突"不是判据恒真的产物。缺失部件必须具名 `part_missing`。
 *
 * 全程零网络、零真机；不触碰任何密钥 / 手机号 / 地址。
 */

import { describe, expect, it } from 'vitest';

import { digestBytes } from '../../../../src/artifacts/digest.js';
import { lookupVersionedFact, versionedSnapshot } from '../../../../src/presentations/fact-sync.js';
import type { VersionedFactSnapshot } from '../../../../src/presentations/fact-sync.js';
import { reopenEditablePptx, exportPresentationPdf } from '../../../../src/presentations/export-handoff.js';
import { literalText, transform, type Presentation, type Shape } from '../../../../src/presentations/model.js';
import { addShape, addSlide } from '../../../../src/presentations/operations.js';
import { emptyPresentation, renderPresentation } from '../../../../src/presentations/render.js';

import {
  PROVENANCE_PART_CONTENT_TYPE,
  PROVENANCE_PART_PATH,
  PROVENANCE_PART_SCHEMA,
  ProvenancePartError,
  attachProvenancePart,
  auditProvenance,
  buildProvenanceManifest,
  contentProvenance,
  exportPresentationWithProvenance,
  hasProvenancePart,
  makeCitation,
  parseProvenancePart,
  parseQuantity,
  readProvenancePart,
  serializeProvenanceManifest,
  type ContentProvenanceRecord,
  type FactVersion,
  type ProvenanceManifest,
  type ProvenancePartErrorReason,
  type SourceDeclaration,
} from '../../../../src/presentations/provenance/index.js';

// ---------------------------------------------------------------------------
// 夹具（事实快照来自 fact-sync **真实**实现）
// ---------------------------------------------------------------------------

const V3: FactVersion = { task_id: 'p-demo', task_revision: 3 };
const V2: FactVersion = { task_id: 'p-demo', task_revision: 2 };

/** 目标版本 r3 的真实快照：人数 8、预算 1200000 CNY、文本型项目名。 */
const SNAPSHOT: VersionedFactSnapshot = versionedSnapshot(V3, [
  {
    fact_key: 'headcount',
    fact_ref: 'f-hc',
    value: { type: 'number', amount: 8, unit: 'person', currency: null },
  },
  {
    fact_key: 'budget.total',
    fact_ref: 'f-budget',
    value: { type: 'number', amount: 1_200_000, unit: 'CNY', currency: 'CNY' },
  },
  {
    fact_key: 'project.name',
    fact_ref: 'f-name',
    value: { type: 'text', text: '深蓝计划', source: '立项书' },
  },
]);

const SOURCE_ANNUAL: SourceDeclaration = {
  source_id: 'src-annual',
  title: '年报',
  origin: 'user_document',
  retrieved_at: '2026-10-01T00:00:00Z',
};

function textBox(id: number, text: string): Shape {
  return {
    kind: 'text_box',
    shape_id: id,
    name: `Box ${String(id)}`,
    transform: transform(0, 0, 4000000, 1000000),
    text: literalText(text),
  };
}

/** 三页、五对象的模型生成演示。 */
function buildDeck(): Presentation {
  let deck = emptyPresentation('p-i25', '归属演示');
  deck = addSlide(deck).presentation;
  deck = addSlide(deck).presentation;
  deck = addSlide(deck).presentation;
  const [s1, s2, s3] = deck.slides;
  if (s1 === undefined || s2 === undefined || s3 === undefined) {
    throw new Error('夹具未建成三页');
  }
  deck = addShape(deck, s1.slide_id, textBox(2, '模型生成的要点'));
  deck = addShape(deck, s2.slide_id, textBox(2, '引用年报的一段话'));
  deck = addShape(deck, s2.slide_id, textBox(3, '人数 8 人'));
  deck = addShape(deck, s3.slide_id, textBox(2, '预算 1200000 元'));
  return deck;
}

function unitId(slideIndex: number, shapeId: number, run = 0): string {
  return `slide${String(slideIndex + 1)}/shape${String(shapeId)}/run${String(run)}`;
}

/**
 * 一组"完全正确"的归属记录：模型 / 资料 / 事实 / 用户四类齐备。
 * `version` 可注入旧版本以造冲突。
 */
function goodRecords(version: FactVersion = V3): readonly ContentProvenanceRecord[] {
  return [
    contentProvenance({
      unit_id: unitId(0, 2),
      origin: {
        kind: 'model',
        provider: 'deepseek',
        model_id: 'deepseek-flash',
        run_id: 'run-25',
        prompt_ref: 'p-outline',
      },
    }),
    contentProvenance({
      unit_id: unitId(1, 2),
      origin: { kind: 'document', source_id: 'src-annual', locator: 'p.3' },
      citations: [makeCitation({ source_id: 'src-annual', locator: 'p.3', quote: '第八次会议' })],
    }),
    contentProvenance({
      unit_id: unitId(1, 3),
      origin: { kind: 'fact', fact_key: 'headcount', fact_ref: 'f-hc', version },
      data: parseQuantity(8, 'person'),
      fact_version: version,
    }),
    contentProvenance({
      unit_id: unitId(2, 2),
      origin: { kind: 'fact', fact_key: 'budget.total', fact_ref: 'f-budget', version },
      data: parseQuantity(1_200_000, 'CNY', 'CNY'),
      fact_version: version,
    }),
  ];
}

function goodManifest(version: FactVersion = V3): ProvenanceManifest {
  return buildProvenanceManifest(goodRecords(version), [SOURCE_ANNUAL]);
}

function expectPartReason(fn: () => unknown, reason: ProvenancePartErrorReason): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ProvenancePartError);
    expect((error as ProvenancePartError).reason).toBe(reason);
    return;
  }
  throw new Error(`期望抛出 ProvenancePartError(${reason})，但没有抛错`);
}

// ---------------------------------------------------------------------------
// A. 提升后的模块（从 src 走）
// ---------------------------------------------------------------------------

describe('A. 归属层已提升进 src/presentations/provenance', () => {
  it('单位 / 记录 / 审计从源出口可用且正例零冲突', () => {
    expect(parseQuantity(8, 'person')).toEqual({ value: 8, unit: 'person', currency: null });
    const report = auditProvenance(goodManifest(), {
      target_version: V3,
      snapshot: SNAPSHOT,
      required_unit_ids: [unitId(0, 2), unitId(1, 3)],
      expected_dimension_by_key: { headcount: 'headcount', 'budget.total': 'currency' },
    });
    expect(report.ok).toBe(true);
    expect(report.conflicts).toEqual([]);
    expect(report.attributed_model_units).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// B. 部件序列化：确定性 + 读回即校验
// ---------------------------------------------------------------------------

describe('B. 清单 ↔ 部件文本', () => {
  it('序列化确定性（两次逐字符相同）且读回重建出等价清单', () => {
    const manifest = goodManifest();
    const first = serializeProvenanceManifest(manifest, V3);
    const second = serializeProvenanceManifest(manifest, V3);
    expect(second).toBe(first);

    const parsed = parseProvenancePart(first);
    expect(parsed.target_version).toEqual(V3);
    expect(parsed.manifest.records).toHaveLength(4);
    // 记录按 unit_id 升序稳定排列
    const ids = parsed.manifest.records.map((record) => record.unit_id);
    expect(ids).toEqual([...ids].sort());
    // 读回的清单能独立审计通过
    const report = auditProvenance(parsed.manifest, { target_version: V3, snapshot: SNAPSHOT });
    expect(report.ok).toBe(true);
  });

  it('反空壳：非法 JSON / 陌生 schema / 缺目标版本都具名报错', () => {
    expectPartReason(() => parseProvenancePart('不是 json'), 'malformed_json');
    expectPartReason(
      () => parseProvenancePart(JSON.stringify({ schema: 'other/9', target_version: V3 })),
      'unknown_schema',
    );
    expectPartReason(
      () => parseProvenancePart(JSON.stringify({ schema: PROVENANCE_PART_SCHEMA })),
      'missing_target_version',
    );
  });
});

// ---------------------------------------------------------------------------
// C. 导出接线：注入 → 读回 → 独立再审计 → 重开
// ---------------------------------------------------------------------------

describe('C. 导出路径写出归属部件并可独立读回', () => {
  it('模型生成演示：钩子导出后零冲突、部件可读回、可编辑 PPTX 仍能重开', () => {
    const deck = buildDeck();
    const result = exportPresentationWithProvenance({
      presentation: deck,
      manifest: goodManifest(),
      target_version: V3,
      versioned_snapshot: SNAPSHOT,
      required_unit_ids: [unitId(0, 2), unitId(1, 3), unitId(2, 2)],
      expected_dimension_by_key: { headcount: 'headcount', 'budget.total': 'currency' },
    });

    // 前置：导出确实产出了 PDF 与可编辑 PPTX
    expect(result.pdf.page_count).toBe(3);
    expect(result.editable_pptx.slide_count).toBe(3);
    expect(result.provenance.relationship_added).toBe(true);
    expect(result.provenance.part_created).toBe(true);

    const bytes = result.editable_pptx.bytes;
    expect(hasProvenancePart(bytes)).toBe(true);

    // 摘要按**注入后的新字节**重算（不是沿用旧值）
    expect(result.editable_pptx.content_digest).toBe(digestBytes(bytes));

    // 独立读回（不依赖写它的那次调用）
    const readback = readProvenancePart(bytes);
    expect(readback.part_path).toBe(PROVENANCE_PART_PATH);
    expect(readback.content_type).toBe(PROVENANCE_PART_CONTENT_TYPE);
    expect(readback.target_version).toEqual(V3);

    // 独立再审计：对**真实 fact-sync 快照**零冲突
    const reaudit = auditProvenance(readback.manifest, {
      target_version: V3,
      snapshot: SNAPSHOT,
      required_unit_ids: [unitId(0, 2), unitId(1, 3), unitId(2, 2)],
      expected_dimension_by_key: { headcount: 'headcount', 'budget.total': 'currency' },
    });
    expect(reaudit.conflicts).toEqual([]);
    expect(reaudit.ok).toBe(true);
    expect(reaudit.checked_units).toBe(4);
    expect(reaudit.attributed_model_units).toBe(1);

    // 交叉断言：读回的量与 fact-sync 独立查询的值一致
    const headcount = lookupVersionedFact(SNAPSHOT, 'headcount');
    const hcRecord = readback.manifest.byUnitId.get(unitId(1, 3));
    expect(headcount?.value).toEqual({ type: 'number', amount: 8, unit: 'person', currency: null });
    expect(hcRecord?.data).toEqual({ value: 8, unit: 'person', currency: null });

    // 注入不破坏演示：可编辑 PPTX 仍能重开且页数对得上
    const reopened = reopenEditablePptx(bytes);
    expect(reopened.openable).toBe(true);
    expect(reopened.editable).toBe(true);
    expect(reopened.slide_count).toBe(3);
  });

  it('独立模块直接注入已导出字节（不经钩子）也能读回', () => {
    const deck = buildDeck();
    const exported = exportPresentationPdf({ presentation: deck });
    expect(hasProvenancePart(exported.editable_pptx.bytes)).toBe(false);

    const attached = attachProvenancePart(exported.editable_pptx.bytes, goodManifest(), {
      target_version: V3,
    });
    expect(attached.part_created).toBe(true);
    expect(attached.relationship_added).toBe(true);
    expect(attached.content_digest).toBe(digestBytes(attached.bytes));

    const readback = readProvenancePart(attached.bytes);
    const reaudit = auditProvenance(readback.manifest, { target_version: V3, snapshot: SNAPSHOT });
    expect(reaudit.ok).toBe(true);
  });

  it('幂等：重复注入不堆部件、不重复挂关系、读回一致', () => {
    const deck = buildDeck();
    const exported = exportPresentationPdf({ presentation: deck });
    const first = attachProvenancePart(exported.editable_pptx.bytes, goodManifest(), {
      target_version: V3,
    });
    const second = attachProvenancePart(first.bytes, goodManifest(), { target_version: V3 });

    expect(first.part_created).toBe(true);
    expect(second.part_created).toBe(false);
    expect(first.relationship_added).toBe(true);
    expect(second.relationship_added).toBe(false);

    const readA = readProvenancePart(first.bytes);
    const readB = readProvenancePart(second.bytes);
    expect(readB.raw).toBe(readA.raw);
    expect(auditProvenance(readB.manifest, { target_version: V3, snapshot: SNAPSHOT }).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D. 反空壳 / 反静默
// ---------------------------------------------------------------------------

describe('D. 审计门与缺失判定不为空壳', () => {
  it('冲突清单默认被拒（conflicting_manifest），关闭后写入且再审计如实报冲突', () => {
    const deck = buildDeck();
    const stale = goodManifest(V2);
    const staleSnapshotOk = auditProvenance(stale, { target_version: V3, snapshot: SNAPSHOT });
    expect(staleSnapshotOk.ok).toBe(false);
    expect(staleSnapshotOk.conflicts.map((conflict) => conflict.kind)).toContain('stale_fact_version');

    // 默认 require_clean ⇒ 拒绝写出
    expectPartReason(
      () =>
        exportPresentationWithProvenance({
          presentation: deck,
          manifest: stale,
          target_version: V3,
          versioned_snapshot: SNAPSHOT,
        }),
      'conflicting_manifest',
    );

    // 关闭门禁 ⇒ 部件照样写出，独立再审计**必须**报出那条冲突（证明审计非恒真）
    const forced = exportPresentationWithProvenance({
      presentation: deck,
      manifest: stale,
      target_version: V3,
      versioned_snapshot: SNAPSHOT,
      require_clean: false,
    });
    const readback = readProvenancePart(forced.editable_pptx.bytes);
    const reaudit = auditProvenance(readback.manifest, { target_version: V3, snapshot: SNAPSHOT });
    expect(reaudit.ok).toBe(false);
    expect(reaudit.conflicts.map((conflict) => conflict.kind)).toContain('stale_fact_version');
  });

  it('缺失归属部件 ⇒ 具名 part_missing（不静默当空清单）', () => {
    const bare = renderPresentation(buildDeck()).bytes;
    expectPartReason(() => readProvenancePart(bare), 'part_missing');
    expect(hasProvenancePart(bare)).toBe(false);
  });
});
