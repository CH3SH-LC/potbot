/**
 * P-R06 · **来源/单位/事实版本审计**。
 *
 * 拿一份 {@link ProvenanceManifest} 与一个**目标事实版本快照**，逐内容单元回答：
 *
 * | 判据 | 触发条件 | 冲突种类 |
 * |---|---|---|
 * | 每一处该有归属的内容都有记录 | `required_unit_ids` 里的单元在清单里缺席 | `missing_provenance` |
 * | 数字必须带单位 | 记录下来是数值，却没有带单位的量 | `bare_number` |
 * | 单位必须已登记 | 记录的量用了未登记单位 | `unknown_unit` |
 * | 单位维度须与事实键相符 | 期望维度表里该键的维度 ≠ 记录量的维度 | `unit_dimension_mismatch` |
 * | 事实来源必须指名运行 | `model` 来源的 `run_id` 为空 | `unattributed_model_output` |
 * | 资料内容必须带引用 | `document` 来源却没有引用 | `missing_citation` |
 * | 引用必须可解析 | 引用指向未声明来源 | `citation_unresolved` |
 * | 事实版本必须最新 | 记录的版本 ≠ 目标版本 | `stale_fact_version` |
 * | 依据的事实必须存在 | 目标快照里没有该键 | `missing_fact` |
 * | 事实值必须数值型 | 数值内容却依据文本/日期事实 | `fact_type_mismatch` |
 * | 单位须与事实一致 | 记录量单位 ≠ 事实值单位 | `fact_unit_mismatch` |
 * | 数值须与事实一致 | 记录量数值 ≠ 事实值 | `fact_value_mismatch` |
 *
 * 结构化：{@link FactSnapshotView} 与 `src/presentations/fact-sync.ts` 的 `VersionedFactSnapshot`
 * **逐字段一致**，因此真实快照可直接传入（用例交叉断言）。`KnownFactValueView` 同理对应
 * protocol 的 `KnownFactValue`：**数值事实带 `unit` / `currency`**，本层据此核对单位。
 *
 * 本模块零 IO、零墙钟、不读环境，纯函数。
 */

import { dimensionOf, unitDef, type UnitDimension } from './units.js';
import { sameFactVersion, type FactVersion, type ProvenanceManifest } from './model.js';

// ---------------------------------------------------------------------------
// 事实快照的结构视图（与 protocol.KnownFactValue / fact-sync.VersionedFactSnapshot 一致）
// ---------------------------------------------------------------------------

/** 已知事实值的结构视图（`src/protocol` 的 `KnownFactValue` 结构上满足）。 */
export type KnownFactValueView =
  | { readonly type: 'number'; readonly amount: number; readonly unit: string; readonly currency: string | null }
  | { readonly type: 'date'; readonly iso_date: string; readonly time_zone: string }
  | { readonly type: 'text'; readonly text: string; readonly source: string };

/** 版本化事实快照的结构视图（`fact-sync.VersionedFactSnapshot` 结构上满足）。 */
export interface FactSnapshotView {
  readonly version: FactVersion;
  readonly entries: readonly {
    readonly fact_key: string;
    readonly fact_ref: string;
    readonly value: KnownFactValueView;
  }[];
}

// ---------------------------------------------------------------------------
// 冲突
// ---------------------------------------------------------------------------

/** 冲突种类（封闭枚举）。 */
export const PROVENANCE_CONFLICT_KINDS = [
  'missing_provenance',
  'bare_number',
  'unknown_unit',
  'unit_dimension_mismatch',
  'unattributed_model_output',
  'missing_citation',
  'citation_unresolved',
  'stale_fact_version',
  'missing_fact',
  'fact_type_mismatch',
  'fact_unit_mismatch',
  'fact_value_mismatch',
] as const;
export type ProvenanceConflictKind = (typeof PROVENANCE_CONFLICT_KINDS)[number];

/** 一条冲突。 */
export interface ProvenanceConflict {
  readonly kind: ProvenanceConflictKind;
  /** 涉及的内容单元；与具体单元无关（如 `missing_provenance`）时为 `null`… 见下。 */
  readonly unit_id: string | null;
  /** 涉及的事实键；不涉及事实时为 `null`。 */
  readonly fact_key: string | null;
  readonly message: string;
}

/** 审计选项。 */
export interface ProvenanceAuditOptions {
  /** 当前任务的**目标**事实版本。 */
  readonly target_version: FactVersion;
  /** 目标版本的事实快照（结构视图；真实 `VersionedFactSnapshot` 可直接传）。 */
  readonly snapshot: FactSnapshotView;
  /** 期望"必须被登记"的内容单元 id 集合；缺席即 `missing_provenance`。 */
  readonly required_unit_ids?: readonly string[];
  /** 期望维度表：事实键 → 该键数值应有的单位维度。 */
  readonly expected_dimension_by_key?: Readonly<Record<string, UnitDimension>>;
}

/** 审计报告。 */
export interface ProvenanceAuditReport {
  readonly ok: boolean;
  readonly target_version: FactVersion;
  readonly conflicts: readonly ProvenanceConflict[];
  /** 被审计的内容单元数。 */
  readonly checked_units: number;
  /** 来源为 `model` 且有 `run_id` 的单元数（可归属的模型内容）。 */
  readonly attributed_model_units: number;
  /** 「本层判据的范围」原文，供上游如实转述。 */
  readonly scope: string;
}

export const PROVENANCE_AUDIT_SCOPE =
  '逐内容单元核对：来源可归属、数字带单位、单位与事实键维度相符、引用可解析到已声明来源、' +
  '事实来源的版本与目标版本一致且数值/单位与目标快照里该事实逐字段相等。本层是**模型层**判据，' +
  '不涉及渲染、也不涉及手机/Office 消费端实开。';

function conflict(
  kind: ProvenanceConflictKind,
  unitId: string | null,
  factKey: string | null,
  message: string,
): ProvenanceConflict {
  return { kind, unit_id: unitId, fact_key: factKey, message };
}

// ---------------------------------------------------------------------------
// 审计
// ---------------------------------------------------------------------------

function findFact(
  snapshot: FactSnapshotView,
  factKey: string,
): FactSnapshotView['entries'][number] | undefined {
  return snapshot.entries.find((entry) => entry.fact_key === factKey);
}

/**
 * 逐单元审计 provenance 清单。
 *
 * 判据全部**从目标快照与清单本身**得出，不调用任何"待证"的旁路；冲突按 `unit_id` 升序、
 * 同单元内按枚举顺序稳定输出。
 */
export function auditProvenance(
  manifest: ProvenanceManifest,
  options: ProvenanceAuditOptions,
): ProvenanceAuditReport {
  const conflicts: ProvenanceConflict[] = [];

  // 1. 必备单元缺席
  for (const requiredId of options.required_unit_ids ?? []) {
    if (!manifest.byUnitId.has(requiredId)) {
      conflicts.push(
        conflict(
          'missing_provenance',
          requiredId,
          null,
          `内容单元 ${requiredId} 在 provenance 清单里缺席（每一处生成内容都要能说出自己的来源）`,
        ),
      );
    }
  }

  let attributedModelUnits = 0;
  const records = [...manifest.records].sort((left, right) =>
    left.unit_id < right.unit_id ? -1 : left.unit_id > right.unit_id ? 1 : 0,
  );

  for (const record of records) {
    const { unit_id, origin } = record;

    // 引用可解析（清单构建时已查过；这里对"外部直接构造"的记录再核一次）
    for (const citation of record.citations) {
      if (!manifest.sources.has(citation.source_id)) {
        conflicts.push(
          conflict(
            'citation_unresolved',
            unit_id,
            null,
            `引用来源 ${citation.source_id}（定位器 ${citation.locator}）未声明`,
          ),
        );
      }
    }

    // 来源类型专属检查
    if (origin.kind === 'model') {
      if (origin.run_id.length === 0) {
        conflicts.push(
          conflict(
            'unattributed_model_output',
            unit_id,
            null,
            '模型生成内容缺 run_id，无法归属到具体一次运行',
          ),
        );
      } else {
        attributedModelUnits += 1;
      }
    } else if (origin.kind === 'document' && record.citations.length === 0) {
      conflicts.push(
        conflict(
          'missing_citation',
          unit_id,
          null,
          `来自资料（${origin.source_id} / ${origin.locator}）的内容必须带引用`,
        ),
      );
    }

    // 数值载荷：必须带已登记单位
    if (record.data !== null) {
      const def = unitDef(record.data.unit);
      if (def === undefined) {
        conflicts.push(
          conflict(
            'unknown_unit',
            unit_id,
            null,
            `数值载荷用了未登记单位 ${JSON.stringify(record.data.unit)}`,
          ),
        );
      } else {
        const expected =
          origin.kind === 'fact' ? options.expected_dimension_by_key?.[origin.fact_key] : undefined;
        if (expected !== undefined && def.dimension !== expected) {
          conflicts.push(
            conflict(
              'unit_dimension_mismatch',
              unit_id,
              origin.kind === 'fact' ? origin.fact_key : null,
              `单位 ${record.data.unit} 的维度 ${def.dimension} 与事实键应有的维度 ${expected} 不符`,
            ),
          );
        }
      }
    }

    // 事实来源：版本 + 值 + 单位
    if (origin.kind !== 'fact') continue;
    const factKey = origin.fact_key;

    if (record.fact_version === null || !sameFactVersion(record.fact_version, options.target_version)) {
      conflicts.push(
        conflict(
          'stale_fact_version',
          unit_id,
          factKey,
          `内容依据的事实版本 ${
            record.fact_version === null ? '(缺少)' : describe(record.fact_version)
          } 与目标版本 ${describe(options.target_version)} 不一致（旧版事实不得冒充当前）`,
        ),
      );
      continue; // 版本已旧，不再拿旧值去比目标值，避免噪声
    }

    const entry = findFact(options.snapshot, factKey);
    if (entry === undefined) {
      conflicts.push(
        conflict(
          'missing_fact',
          unit_id,
          factKey,
          `目标版本 ${describe(options.target_version)} 里没有事实键 ${factKey}（缺失不得当零）`,
        ),
      );
      continue;
    }

    if (entry.value.type !== 'number') {
      if (record.data !== null) {
        conflicts.push(
          conflict(
            'fact_type_mismatch',
            unit_id,
            factKey,
            `事实 ${factKey} 是 ${entry.value.type} 型，记录却挂了数值载荷`,
          ),
        );
      }
      continue;
    }

    if (record.data === null) {
      conflicts.push(
        conflict(
          'bare_number',
          unit_id,
          factKey,
          `事实 ${factKey} 是数值（${String(entry.value.amount)} ${entry.value.unit}），` +
            '记录却没有带单位的量——禁止出现不带单位的裸数',
        ),
      );
      continue;
    }

    if (record.data.unit !== entry.value.unit) {
      conflicts.push(
        conflict(
          'fact_unit_mismatch',
          unit_id,
          factKey,
          `记录单位 ${record.data.unit} 与事实 ${factKey} 的单位 ${entry.value.unit} 不一致` +
            '（不做隐式换算：同维不同单位要显式换算并写明）',
        ),
      );
    }
    if (record.data.value !== entry.value.amount) {
      conflicts.push(
        conflict(
          'fact_value_mismatch',
          unit_id,
          factKey,
          `记录数值 ${String(record.data.value)} 与目标版本事实 ${factKey} 的值 ` +
            `${String(entry.value.amount)} 不一致`,
        ),
      );
    }
  }

  return Object.freeze({
    ok: conflicts.length === 0,
    target_version: Object.freeze({ ...options.target_version }),
    conflicts: Object.freeze(conflicts),
    checked_units: records.length,
    attributed_model_units: attributedModelUnits,
    scope: PROVENANCE_AUDIT_SCOPE,
  });
}

function describe(version: FactVersion): string {
  return `${version.task_id}@r${String(version.task_revision)}`;
}

/** 供调用方做单位维度速查（避免直接依赖 `units.ts` 的内部）。 */
export { dimensionOf as unitDimensionOf };
