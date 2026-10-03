/**
 * 产物记录（design-02 P1 / P2 / P3 的载体；合同 v1.4 待冻结项）。
 *
 * ## 为什么是**并列记录**而不是扩展 `ArtifactRef`
 *
 * `ArtifactRef`（`ids.ts:44`）是品牌化字符串，现有 `TaskRecord.artifact_refs` /
 * `WorkItem.result_refs` 都在用它，改动它会波及 842 个既有测试与所有调用点。
 * 按 `task-control.ts` 的「载体记录」范式（info-007 的教训：**新概念用新记录集合**），
 * 产物语义由本文件的 `ArtifactRecord` 承载，`ArtifactRef` 保持为**纯 id**。
 *
 * ## 读侧约定（P1 的反面判据）
 *
 * 拿到一个 `ArtifactRef` 的读者，**只有**在 `artifacts` 集合里查到记录、
 * 且该记录 `status === 'published'`（即 `isDeliveredArtifact()` 为真）时，
 * 才能把"已交付"当结论。查不到 = design-01 旧语义下的**占位引用**，不是交付。
 *
 * ## 时间与确定性
 *
 * 本文件只用 `LogicalTime`；**不含墙钟、不含 `Date`、不读 `process.*`**（Q8-a / Q8-c）。
 */

import {
  type ArtifactRef,
  type FactRef,
  type InstanceId,
  type LogicalTime,
  type Revision,
  type TaskId,
} from './ids.js';
import { ValidationError } from './errors.js';

// ---------------------------------------------------------------------------
// 封闭枚举与唯一的字面量来源
// ---------------------------------------------------------------------------

/**
 * 模板种类（封闭枚举，对应任务书 §6 的三类模板）。
 * 三类之外（美团 / 时钟 / 日历 / 资料检索）属后续 design，**不得**在此处悄悄扩张。
 */
export const TEMPLATE_KINDS = ['document', 'spreadsheet', 'presentation'] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

/**
 * 模板种类 → 文件扩展名。**路径规划的唯一字面量来源**（planner 不得另写一份）。
 */
export const TEMPLATE_KIND_EXTENSIONS: Readonly<Record<TemplateKind, string>> = Object.freeze({
  document: 'docx',
  spreadsheet: 'xlsx',
  presentation: 'pptx',
});

/** 模板种类 → 默认 MIME（OOXML 官方类型）。 */
export const TEMPLATE_KIND_MIME_TYPES: Readonly<Record<TemplateKind, string>> = Object.freeze({
  document: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  spreadsheet: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  presentation: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
});

/**
 * 产物状态（封闭枚举）。
 *
 * - `staged`：计划已登记、字节尚未物化或刚物化未发布。**不代表任何交付**（I-4）。
 * - `published`：已物化、已回读、有回执——唯一的"已交付"状态（I-1 / I-2）。
 * - `failed`：物化失败（必须给出 `failure_kind`）。
 * - `superseded`：被**更高任务版本**或**更高产物版本**取代，保留为历史、不得冒充当前（P2）。
 * - `expired`：因版本变更或依赖失效被判定过期，同样保留为历史。
 */
export const ARTIFACT_STATUSES = [
  'staged',
  'published',
  'failed',
  'superseded',
  'expired',
] as const;
export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number];

/** 只有这个状态构成"已交付"（见 `isDeliveredArtifact`）。 */
export const DELIVERED_ARTIFACT_STATUS: ArtifactStatus = 'published';

/**
 * 失败种类（封闭枚举）。**必须与物化端口的失败种类一一对应**
 * （`src/artifacts/ports.ts` 的 `ArtifactMaterializationFailureKind`），
 * 使"端口报了什么"与"记录里记了什么"不会分叉。
 */
export const ARTIFACT_FAILURE_KINDS = [
  'missing_fact', // 资料缺失：关键共享事实为 unknown / not_applicable（P3）
  'builder_failed', // 构建器失败：模板构建抛错或产出无法解析
  'write_failed', // 写盘失败：临时路径写入 / 原子 rename 失败
  'version_stale', // 版本已过期：物化前版本闸门发现任务版本已被超越（P2）
  'self_check_failed', // 结构自检不通过：产物结构不合法
] as const;
export type ArtifactFailureKind = (typeof ARTIFACT_FAILURE_KINDS)[number];

/**
 * 交付前检查的种类（封闭枚举）。**每种检查在一条记录里最多一条**（去重校验见构造器）。
 * 与 design-02 验收判据的对应：结构自检 ↔ 内核对自产字节的检查；版本匹配 ↔ J9；
 * 独立读回 ↔ J2；软件打开 ↔ "目标软件可打开"那一层（未实测须记 `inconclusive` + 原因）。
 */
export const ARTIFACT_VERIFICATION_KINDS = [
  'structural_self_check',
  'version_match',
  'independent_readback',
  'application_open',
] as const;
export type ArtifactVerificationKind = (typeof ARTIFACT_VERIFICATION_KINDS)[number];

/**
 * 检查结论三值。`inconclusive` 是**一等值**：环境阻塞 / 超时不得写成 `pass`，
 * 也不得因为写不成 `pass` 就把整条检查丢掉（如实上报，P5 的精神）。
 */
export const ARTIFACT_VERIFICATION_OUTCOMES = ['pass', 'fail', 'inconclusive'] as const;
export type ArtifactVerificationOutcome = (typeof ARTIFACT_VERIFICATION_OUTCOMES)[number];

// ---------------------------------------------------------------------------
// 检查结果与回执
// ---------------------------------------------------------------------------

/** 一条交付前检查：种类 + 结论 + 说明（说明不得为空，否则无法追溯）。 */
export interface ArtifactVerification {
  readonly kind: ArtifactVerificationKind;
  readonly outcome: ArtifactVerificationOutcome;
  readonly detail: string;
}

/**
 * 交付回执：**声称交付的必要证据**。
 *
 * `readback_digest` 必须是**对 `final_path` 实际回读**得到的字节摘要，
 * 而不是"计划里期望的摘要"或"写入时用的摘要"——否则不满足 I-1。
 */
export interface ArtifactReceipt {
  /** 最终路径（发布后的实际落点）。 */
  readonly final_path: string;
  /** 对最终路径**回读**得到的字节摘要。 */
  readonly readback_digest: string;
  /** 验证者标识（谁做的回读；不得为内核自产字节的"自证"含糊带过）。 */
  readonly verifier: string;
  /** 回读发生的逻辑时刻。 */
  readonly at: LogicalTime;
  /**
   * **容器条目数**（DOCX / XLSX / PPTX 的 ZIP 部件数）。
   *
   * 为什么是**可选**（缺省 = 未登记，**不判失败**）：
   * 它是物化端口的量（`ArtifactMaterializationReceipt.entry_count`），
   * 而本接口同时是**历史记录**（含本字段引入之前落库的一切记录）的载体类型——
   * 做成必填会让那些记录在构造/自检时凭空失败，等于用"新字段"追溯性地否定既有事实。
   * 省略只表示"这份回执没有登记条目数"，**不表示 0**（R48.2：不得用 0 冒充缺失）。
   *
   * 给出时**必须**是 ≥ 0 的整数（形状校验见 `freezeReceipt`）。
   */
  readonly entry_count?: number;
}

// ---------------------------------------------------------------------------
// 产物记录
// ---------------------------------------------------------------------------

export interface ArtifactRecord {
  /** 产物 id（复用既有品牌类型 `ArtifactRef`，不扩展成对象）。 */
  readonly artifact_id: ArtifactRef;
  readonly task_id: TaskId;
  /** 本产物所绑定的任务版本（P2：版本变更使产物过期）。 */
  readonly task_revision: Revision;
  /** **产物版本**：同一任务、同一模板种类下的第几版（从 1 起，正整数）。 */
  readonly artifact_version: number;
  readonly template_kind: TemplateKind;
  readonly mime_type: string;
  readonly byte_length: number;
  /** 内容的 sha256 摘要（真实字节的摘要；由物化端给出）。 */
  readonly content_digest: string;
  /**
   * 内容所依据的**共享事实引用**。**必须非空**——这是 P3 的机器判据：
   * 没有事实来源的产物不可能是"引用统一数据源"的结果。
   */
  readonly source_fact_refs: readonly FactRef[];
  /** 依赖的其它产物（P2 的影响面传播用；没有依赖时为空）。 */
  readonly dependency_artifact_refs: readonly ArtifactRef[];
  readonly created_by_instance_id: InstanceId;
  readonly status: ArtifactStatus;
  /** 交付前检查结果列表（每种检查最多一条）。 */
  readonly verifications: readonly ArtifactVerification[];
  /** 失败种类（`status === 'failed'` 时必填；`published` 时必须为 null）。 */
  readonly failure_kind: ArtifactFailureKind | null;
  /** 回执（`status === 'published'` 时必填；`staged`/`failed` 时必须为 null）。 */
  readonly receipt: ArtifactReceipt | null;
  readonly created_at: LogicalTime;
  readonly updated_at: LogicalTime;
}

export interface ArtifactRecordInput {
  readonly artifact_id: ArtifactRef;
  readonly task_id: TaskId;
  readonly task_revision: Revision;
  readonly artifact_version: number;
  readonly template_kind: TemplateKind;
  /** 省略时按模板种类取默认 MIME。 */
  readonly mime_type?: string;
  readonly byte_length: number;
  readonly content_digest: string;
  readonly source_fact_refs: readonly FactRef[];
  readonly dependency_artifact_refs?: readonly ArtifactRef[];
  readonly created_by_instance_id: InstanceId;
  readonly status: ArtifactStatus;
  readonly verifications?: readonly ArtifactVerification[];
  readonly failure_kind?: ArtifactFailureKind | null;
  readonly receipt?: ArtifactReceipt | null;
  readonly created_at: LogicalTime;
  readonly updated_at?: LogicalTime;
}

// ---------------------------------------------------------------------------
// 校验工具（构造期与自检共用同一批判据，避免两处规则分叉）
// ---------------------------------------------------------------------------

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${field} 不能为空字符串（收到 ${describe(value)}）`);
  }
  return value;
}

function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ValidationError(
      `${field} 必须是 ${allowed.join(' | ')} 之一，收到 ${describe(value)}`,
    );
  }
  return value as T;
}

function requireInteger(value: unknown, field: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
    throw new ValidationError(
      `${field} 必须是 ≥ ${minimum} 的整数，收到 ${describe(value)}`,
    );
  }
  return value;
}

function requireLogicalTime(value: unknown, field: string): LogicalTime {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(`${field} 必须是有限数（逻辑时间），收到 ${describe(value)}`);
  }
  return value as LogicalTime;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  return `${typeof value}(${String(value)})`;
}

function freezeVerifications(
  verifications: readonly ArtifactVerification[],
): readonly ArtifactVerification[] {
  const seen = new Set<ArtifactVerificationKind>();
  const frozen: ArtifactVerification[] = [];
  for (const entry of verifications) {
    const kind = requireEnum(
      entry?.kind,
      ARTIFACT_VERIFICATION_KINDS,
      'ArtifactVerification.kind',
    );
    const outcome = requireEnum(
      entry?.outcome,
      ARTIFACT_VERIFICATION_OUTCOMES,
      'ArtifactVerification.outcome',
    );
    const detail = requireNonEmptyString(entry?.detail, `检查 ${kind} 的 detail`);
    if (seen.has(kind)) {
      throw new ValidationError(
        `同一条产物记录里检查种类 ${kind} 出现了两次：每种检查最多一条（否则"检查过了"无法判定）`,
      );
    }
    seen.add(kind);
    frozen.push(Object.freeze({ kind, outcome, detail }));
  }
  return Object.freeze(frozen);
}

function freezeReceipt(receipt: ArtifactReceipt): ArtifactReceipt {
  return Object.freeze({
    final_path: requireNonEmptyString(receipt.final_path, 'ArtifactReceipt.final_path'),
    readback_digest: requireNonEmptyString(
      receipt.readback_digest,
      'ArtifactReceipt.readback_digest',
    ),
    verifier: requireNonEmptyString(receipt.verifier, 'ArtifactReceipt.verifier'),
    at: requireLogicalTime(receipt.at, 'ArtifactReceipt.at'),
    // 可选字段：**省略时不出现在冻结结果里**（保持"未登记"与"登记了 0"在结构上可区分，
    // 也让历史记录的形状原样往返）。给了就必须是 ≥ 0 的整数——负数 / 小数 / null
    // 都是"登记了但不可能为真"，属形状错误而非"未登记"。
    ...(receipt.entry_count === undefined
      ? {}
      : {
          entry_count: requireInteger(
            receipt.entry_count,
            'ArtifactReceipt.entry_count',
            0,
          ),
        }),
  });
}

/**
 * 构造产物记录。**状态与必填字段的对应关系在构造期可判**：
 *
 * | 条件 | 结果 |
 * |---|---|
 * | `source_fact_refs` 为空 | 抛 `ValidationError`（P3 机器判据） |
 * | `published` 而 `receipt === null` | 抛（I-1：无回执不得称交付） |
 * | `published` 而 `failure_kind !== null` | 抛（已交付的产物不得携带失败种类） |
 * | `published` 而 `verifications` 为空 | 抛（P1：交付前必须经过检查流程） |
 * | `failed` 而 `failure_kind === null` | 抛（镜像 `WorkItem.failure_reason` 的纪律） |
 * | `failed` 而 `receipt !== null` | 抛（失败的产物不得有交付回执） |
 * | `staged` 而 `receipt !== null` | 抛（未发布不得有回执；I-4 的可判定形式） |
 * | 同种检查出现两次 | 抛 |
 */
export function createArtifactRecord(input: ArtifactRecordInput): ArtifactRecord {
  const artifactId = requireNonEmptyString(input.artifact_id, 'ArtifactRecord.artifact_id') as ArtifactRef;
  const taskId = requireNonEmptyString(input.task_id, 'ArtifactRecord.task_id') as TaskId;
  const taskRevision = requireInteger(input.task_revision, 'ArtifactRecord.task_revision', 0) as Revision;
  const artifactVersion = requireInteger(input.artifact_version, 'ArtifactRecord.artifact_version', 1);
  const templateKind = requireEnum(
    input.template_kind,
    TEMPLATE_KINDS,
    'ArtifactRecord.template_kind',
  );
  const status = requireEnum(input.status, ARTIFACT_STATUSES, 'ArtifactRecord.status');
  const byteLength = requireInteger(input.byte_length, 'ArtifactRecord.byte_length', 0);
  const contentDigest = requireNonEmptyString(input.content_digest, 'ArtifactRecord.content_digest');
  const createdBy = requireNonEmptyString(
    input.created_by_instance_id,
    'ArtifactRecord.created_by_instance_id',
  ) as InstanceId;

  const sourceFactRefs = Object.freeze([...(input.source_fact_refs ?? [])]);
  if (sourceFactRefs.length === 0) {
    throw new ValidationError(
      'ArtifactRecord.source_fact_refs 不能为空：产物必须能追溯到它所依据的共享事实（P3 的机器判据）',
    );
  }
  for (const ref of sourceFactRefs) {
    requireNonEmptyString(ref, 'ArtifactRecord.source_fact_refs[]');
  }

  const dependencyRefs = Object.freeze([...(input.dependency_artifact_refs ?? [])]);
  for (const ref of dependencyRefs) {
    requireNonEmptyString(ref, 'ArtifactRecord.dependency_artifact_refs[]');
  }
  const verifications = freezeVerifications(input.verifications ?? []);

  const failureKind =
    input.failure_kind === undefined || input.failure_kind === null
      ? null
      : requireEnum(input.failure_kind, ARTIFACT_FAILURE_KINDS, 'ArtifactRecord.failure_kind');

  const receipt = input.receipt === undefined || input.receipt === null
    ? null
    : freezeReceipt(input.receipt);

  if (status === DELIVERED_ARTIFACT_STATUS) {
    if (receipt === null) {
      throw new ValidationError(
        'published 产物必须有回执：回执来自对最终路径的实际回读，无回读不得宣称交付（I-1）',
      );
    }
    if (failureKind !== null) {
      throw new ValidationError('published 产物不得携带 failure_kind（已交付与失败互斥）');
    }
    if (verifications.length === 0) {
      throw new ValidationError(
        'published 产物必须有至少一条交付前检查结果（P1：交付前必须经过检查流程，不得"生成即交付"）',
      );
    }
  }
  if (status === 'failed') {
    if (failureKind === null) {
      throw new ValidationError('failed 产物必须给出 failure_kind（镜像 WorkItem.failure_reason 的纪律）');
    }
    if (receipt !== null) {
      throw new ValidationError('failed 产物不得携带交付回执（失败与已交付互斥）');
    }
  }
  if (status === 'staged' && receipt !== null) {
    throw new ValidationError('staged 产物不得携带交付回执（尚未发布就声称有回执）');
  }

  const createdAt = requireLogicalTime(input.created_at, 'ArtifactRecord.created_at');
  const updatedAt = requireLogicalTime(input.updated_at ?? input.created_at, 'ArtifactRecord.updated_at');

  return Object.freeze({
    artifact_id: artifactId,
    task_id: taskId,
    task_revision: taskRevision,
    artifact_version: artifactVersion,
    template_kind: templateKind,
    mime_type:
      input.mime_type === undefined
        ? TEMPLATE_KIND_MIME_TYPES[templateKind]
        : requireNonEmptyString(input.mime_type, 'ArtifactRecord.mime_type'),
    byte_length: byteLength,
    content_digest: contentDigest,
    source_fact_refs: sourceFactRefs,
    dependency_artifact_refs: dependencyRefs,
    created_by_instance_id: createdBy,
    status,
    verifications,
    failure_kind: failureKind,
    receipt,
    created_at: createdAt,
    updated_at: updatedAt,
  });
}

/**
 * 形状自检：用于测试与诊断（含从存储读回的外部构造记录）。与构造期校验同源。
 * @throws {ValidationError}
 */
export function assertArtifactInvariants(record: ArtifactRecord): void {
  // 用同一批构造期判据复核一遍：把记录原样喂回构造器，任何违规都会抛。
  createArtifactRecord(record);
}

/**
 * **读侧唯一判据**：这份记录是否构成"已交付"（P1 的反面判据也据此）。
 * 注意：它只回答"记录层面的交付状态"，不回答"文件此刻是否还在磁盘上"——
 * 后者需要回读（I-2 的反面）。
 */
export function isDeliveredArtifact(record: ArtifactRecord): boolean {
  return record.status === DELIVERED_ARTIFACT_STATUS && record.receipt !== null;
}
