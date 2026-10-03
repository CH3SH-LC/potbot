/**
 * P-I25 · **导出接线**（把归属清单作为一个部件注入导出的 PPTX，并能独立读回）。
 *
 * ## 为什么是"独立模块 + 调用钩子"，而不是改 `export-handoff.ts`
 *
 * `export-handoff.ts`（P-I14 独占）负责"导出 PDF 与可编辑 PPTX 同时交付"。本层不改它一字节：
 * 它把归属部件当成**导出后的一次追加装配**——用 `openPresentationPackage` 打开导出字节，
 * 经 `assemblePresentationPackage` 新增 `customXml/potbot-provenance.json` 并挂关系，其余部件
 * **逐字节保留**（装配器的既有保证）。对外只暴露一个调用钩子
 * {@link exportPresentationWithProvenance}：内部先调 `exportPresentationPdf`（导出路径），
 * 再 {@link attachProvenancePart}（写清单部件），返回与 `PdfExportResult` **形状兼容**的结果。
 *
 * ## 判据链
 *
 * 1. **审计门**：默认 `require_clean !== false` 时，先 {@link auditProvenance} 清单；有冲突即
 *    `conflicting_manifest` 抛错——**不发出**一份对不上的清单（宁可拒绝，也不写假归属）。
 * 2. **注入**：部件文本来自 {@link serializeProvenanceManifest}，写入后**读回自检**
 *    （{@link readProvenancePart}），确保"写进去的能读出来"。
 * 3. **幂等**：部件已存在则走 `replace_parts`，关系已存在则不重复追加——重复注入不会堆部件。
 *
 * 本模块不做 IO、不读环境；`openPresentationPackage` / `assemblePresentationPackage` 都是纯函数。
 */

import { digestBytes } from '../../artifacts/digest.js';
import {
  assemblePresentationPackage,
  openPresentationPackage,
  type PackageRelationshipGroup,
  type PresentationPackage,
  type PresentationPackagePlan,
} from '../import.js';
import {
  exportPresentationPdf,
  type PdfExportRequest,
  type PdfExportResult,
} from '../export-handoff.js';
import type { Presentation } from '../model.js';

import { auditProvenance, type FactSnapshotView, type ProvenanceAuditReport } from './audit.js';
import type { FactVersion, ProvenanceManifest } from './model.js';
import type { UnitDimension } from './units.js';
import {
  PROVENANCE_PART_CONTENT_TYPE,
  PROVENANCE_PART_PATH,
  PROVENANCE_RELATIONSHIP_TYPE,
  ProvenancePartError,
  parseProvenancePart,
  serializeProvenanceManifest,
  type ParsedProvenancePart,
} from './part.js';

const PRESENTATION_PART = 'ppt/presentation.xml';

// ---------------------------------------------------------------------------
// 注入
// ---------------------------------------------------------------------------

/** {@link attachProvenancePart} 的选项。 */
export interface AttachProvenanceOptions {
  /** 清单的目标事实版本（随部件一起持久化，供读回后独立审计）。 */
  readonly target_version: FactVersion;
  /**
   * 是否给 `ppt/presentation.xml` 追加一条指向归属部件的内部关系（默认 `true`）。
   * `false` 时部件仍写入、内容类型仍登记，但**不**挂关系——只给"要自己管关系"的调用方。
   */
  readonly link_relationship?: boolean;
}

/** {@link attachProvenancePart} 的结果。 */
export interface AttachProvenanceResult {
  readonly bytes: Buffer;
  readonly part_path: string;
  /** `true` = 本次新增部件；`false` = 覆盖已存在的同名部件。 */
  readonly part_created: boolean;
  readonly relationship_added: boolean;
  readonly entry_count: number;
  readonly content_digest: string;
  /** 装配后从**真实字节**读回的包视图。 */
  readonly package: PresentationPackage;
}

/** 包里是否已存在归属清单部件。 */
export function hasProvenancePart(bytes: Uint8Array): boolean {
  return openPresentationPackage(bytes).by_path.has(PROVENANCE_PART_PATH);
}

/** 是否已有一条（任意持有者）指向归属部件的内部关系。 */
function hasProvenanceRelationship(pkg: PresentationPackage): boolean {
  for (const group of pkg.relationship_groups as readonly PackageRelationshipGroup[]) {
    for (const relationship of group.relationships) {
      if (
        relationship.type === PROVENANCE_RELATIONSHIP_TYPE &&
        relationship.resolved_path === PROVENANCE_PART_PATH
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 把归属清单写进一份已导出的 PPTX（新增或覆盖部件；可选挂关系），返回新字节。
 *
 * **未列出的部件逐字节保留**（装配器保证）：本函数只新增 / 覆盖归属部件、按需追加一条关系、
 * 并（在部件集合变化时）重建 `[Content_Types].xml`。
 *
 * @throws {ProvenancePartError} 装配失败时原因来自装配器；本层只在序列化 / 自检处具名报错。
 */
export function attachProvenancePart(
  bytes: Uint8Array,
  manifest: ProvenanceManifest,
  options: AttachProvenanceOptions,
): AttachProvenanceResult {
  const pkg = openPresentationPackage(bytes);
  const partText = serializeProvenanceManifest(manifest, options.target_version);

  const partCreated = !pkg.by_path.has(PROVENANCE_PART_PATH);
  const plan: {
    replace_parts?: ReadonlyMap<string, Uint8Array | string>;
    add_parts?: PresentationPackagePlan['add_parts'];
    relationship_edits?: PresentationPackagePlan['relationship_edits'];
  } = partCreated
    ? {
        add_parts: [
          { path: PROVENANCE_PART_PATH, content_type: PROVENANCE_PART_CONTENT_TYPE, data: partText },
        ],
      }
    : { replace_parts: new Map([[PROVENANCE_PART_PATH, partText]]) };

  const linkRelationship = options.link_relationship !== false;
  let relationshipAdded = false;
  if (linkRelationship && !hasProvenanceRelationship(pkg)) {
    plan.relationship_edits = [
      {
        owner_part_path: PRESENTATION_PART,
        add: [{ type: PROVENANCE_RELATIONSHIP_TYPE, target: `../${PROVENANCE_PART_PATH}` }],
      },
    ];
    relationshipAdded = true;
  }

  const assembly = assemblePresentationPackage(pkg, plan);

  // 写后自检：真实字节里必须能读回同一份清单（"写进去的能读出来"）。
  const readback = readProvenancePart(assembly.bytes);
  if (readback.raw.trim() !== partText.trim()) {
    throw new ProvenancePartError(
      'invalid_record',
      '归属部件写入后读回的文本与写入不一致（装配链路有损）',
    );
  }

  return Object.freeze({
    bytes: assembly.bytes,
    part_path: PROVENANCE_PART_PATH,
    part_created: partCreated,
    relationship_added: relationshipAdded,
    entry_count: assembly.entry_count,
    content_digest: digestBytes(assembly.bytes),
    package: assembly.package,
  });
}

// ---------------------------------------------------------------------------
// 读回
// ---------------------------------------------------------------------------

/** {@link readProvenancePart} 的结果：重建清单 + 部件元信息。 */
export interface ReadProvenanceResult extends ParsedProvenancePart {
  readonly part_path: string;
  /** 部件在 `[Content_Types].xml` 里登记的内容类型；未登记 ⇒ `null`（如实返回，不猜）。 */
  readonly content_type: string | null;
  /** 部件的**原始文本**（供上游逐字节转述 / 再解析）。 */
  readonly raw: string;
}

/**
 * 从一份 PPTX 读回归属清单部件（独立读回，不依赖写它的那次调用）。
 *
 * @throws {ProvenancePartError} `part_missing`：包里没有归属部件；
 *   其余原因来自 {@link parseProvenancePart}（JSON / schema / 字段非法）。
 */
export function readProvenancePart(bytes: Uint8Array): ReadProvenanceResult {
  const pkg = openPresentationPackage(bytes);
  const entry = pkg.by_path.get(PROVENANCE_PART_PATH);
  if (entry === undefined) {
    throw new ProvenancePartError(
      'part_missing',
      `包内没有归属部件 ${PROVENANCE_PART_PATH}`,
    );
  }
  const raw = Buffer.from(entry.data).toString('utf8');
  const parsed = parseProvenancePart(raw);
  return Object.freeze({
    part_path: PROVENANCE_PART_PATH,
    content_type: pkg.content_types.overrides.get(PROVENANCE_PART_PATH) ?? null,
    raw,
    manifest: parsed.manifest,
    target_version: parsed.target_version,
  });
}

// ---------------------------------------------------------------------------
// 导出调用钩子
// ---------------------------------------------------------------------------

/** 归属导出钩子的输入：导出请求 + 清单 + 目标版本事实快照。 */
export interface ProvenanceExportInput {
  readonly presentation: Presentation;
  /** 求值 `fact` 引用用的**模型快照**（转交 `exportPresentationPdf`）。 */
  readonly fact_snapshot?: PdfExportRequest['fact_snapshot'];
  readonly media?: PdfExportRequest['media'];
  /** 要随文件走的归属清单。 */
  readonly manifest: ProvenanceManifest;
  /** 目标事实版本（写进部件）。 */
  readonly target_version: FactVersion;
  /** 目标版本事实快照（结构视图；真实 `VersionedFactSnapshot` 可直接传）。 */
  readonly versioned_snapshot: FactSnapshotView;
  readonly required_unit_ids?: readonly string[];
  readonly expected_dimension_by_key?: Readonly<Record<string, UnitDimension>>;
  /** 默认 `true`：审计有冲突即拒绝发出部件（`conflicting_manifest`）。 */
  readonly require_clean?: boolean;
}

/** 归属导出钩子的结果：与 `PdfExportResult` 形状兼容 + 归属元信息。 */
export interface ProvenanceExportResult extends PdfExportResult {
  readonly provenance: {
    readonly report: ProvenanceAuditReport;
    readonly part_path: string;
    readonly part_created: boolean;
    readonly relationship_added: boolean;
  };
}

/**
 * **导出路径的调用钩子**：导出可编辑 PPTX，并把归属清单作为部件一并写出。
 *
 * 步骤：审计清单（默认要求零冲突）→ `exportPresentationPdf` → `attachProvenancePart` →
 * 用追加后的字节重建 `editable_pptx`（`entry_count` / `content_digest` 按**新字节**重算，
 * 不沿用旧值——否则摘要与实际字节不符）。
 *
 * @throws {ProvenancePartError} `conflicting_manifest`：审计有冲突且未关闭 `require_clean`。
 */
export function exportPresentationWithProvenance(
  input: ProvenanceExportInput,
): ProvenanceExportResult {
  const report = auditProvenance(input.manifest, {
    target_version: input.target_version,
    snapshot: input.versioned_snapshot,
    ...(input.required_unit_ids === undefined ? {} : { required_unit_ids: input.required_unit_ids }),
    ...(input.expected_dimension_by_key === undefined
      ? {}
      : { expected_dimension_by_key: input.expected_dimension_by_key }),
  });
  if (input.require_clean !== false && !report.ok) {
    throw new ProvenancePartError(
      'conflicting_manifest',
      `归属清单与目标事实版本 ${input.target_version.task_id}@r${String(
        input.target_version.task_revision,
      )} 有 ${String(report.conflicts.length)} 条冲突，拒绝写出：` +
        report.conflicts.map((conflict) => conflict.kind).join(' / '),
    );
  }

  const base = exportPresentationPdf({
    presentation: input.presentation,
    ...(input.fact_snapshot === undefined ? {} : { fact_snapshot: input.fact_snapshot }),
    ...(input.media === undefined ? {} : { media: input.media }),
  });

  const attached = attachProvenancePart(base.editable_pptx.bytes, input.manifest, {
    target_version: input.target_version,
  });

  return Object.freeze({
    pdf: base.pdf,
    editable_pptx: Object.freeze({
      bytes: attached.bytes,
      slide_count: base.editable_pptx.slide_count,
      entry_count: attached.entry_count,
      content_digest: attached.content_digest,
      editable: true as const,
    }),
    invariants: base.invariants,
    provenance: Object.freeze({
      report,
      part_path: attached.part_path,
      part_created: attached.part_created,
      relationship_added: attached.relationship_added,
    }),
  });
}
