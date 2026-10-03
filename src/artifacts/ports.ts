/**
 * **产物物化端口**（design-02 P1；W-B 与 W-D / W-E / W-F 的并行开发接缝）。
 *
 * ## 为什么是"语义端口"
 *
 * 与 `src/dependency/ports.ts` 同一纪律：本文件**不 import 任何 `src/scheduler/**` 的类型**
 * （调度器在编写本包时还不存在，且物化过程与调度判定是两件事）。端口两侧只传
 * **可序列化的结构化事实**，因此：
 * - W-D 的模板构建器 / W-F 的真实落盘端口只需满足本文件的形状；
 * - 夹具可以只收集请求、只回放结构化结果，而不必拉起内核或真的写盘。
 *
 * ## 三段式与失败语义（对齐已批准方案）
 *
 * 事务内 `staged` → **提交后**物化（版本闸门 → 版本化临时路径 → 结构自检 → 原子 rename
 * → 回读摘要）→ 事务内 `published` + 回执。本端口就是中间那一段的边界：
 * **外部副作用只发生在端口实现里**，且端口**不抛错、不静默**——失败必须是
 * 结构化返回值（`{ ok: false, failure }`），调用方据此落 `failed` 或 `superseded`。
 *
 * ## 失败种类与 `ArtifactFailureKind` 一一对应
 *
 * 端口返回的 `kind` 直接就是记录里的 `failure_kind`（同一封闭枚举，见 `protocol/artifact.ts`），
 * 避免"端口报 A、记录记 B"的分叉。
 */

import {
  asLogicalTime,
  LOGICAL_TIME_ORIGIN,
  type ArtifactRef,
  type ArtifactReceipt,
  type ArtifactFailureKind,
  type FactRef,
  type FactSource,
  type KnownFactValue,
  type LogicalTime,
  type Revision,
  type TaskId,
  type TemplateKind,
} from '../protocol/index.js';
import { ValidationError } from '../protocol/index.js';
import type { ArtifactPlan } from './planner.js';

/**
 * 事实快照的一条：**只可能是"已知值"**。
 *
 * 缺失 / 未知 / 不适用的事实**不得**进入本快照——按 P3 判据，那种情况必须在**进入物化之前**
 * 就阻塞为 `missing_fact`，不产出产物、更不产出零值产物。让 `value` 的类型是
 * `KnownFactValue`（而非 `SharedFactValue`）正是这条纪律的结构化表达。
 */
export interface KnownFactSnapshotEntry {
  readonly fact_ref: FactRef;
  /** 稳定事实键（`headcount` / `budget.total` / `event.date`）。 */
  readonly fact_key: string;
  /** 已知值载荷（数值+单位+币种 / 日期+时区 / 文本+来源）。 */
  readonly value: KnownFactValue;
  readonly source: FactSource;
}

/** 物化请求（进入物化端口的全部输入；**没有时间参数**——时间由端口回执自己报）。 */
export interface ArtifactMaterializationRequest {
  readonly artifact_id: ArtifactRef;
  readonly task_id: TaskId;
  readonly task_revision: Revision;
  readonly template_kind: TemplateKind;
  /** 事实快照（键 → 已知值/单位/来源）。 */
  readonly fact_snapshot: readonly KnownFactSnapshotEntry[];
  /** 路径计划（版本化最终路径 + 临时路径；由 `planArtifact()` 产出）。 */
  readonly plan: ArtifactPlan;
  /** 期望内容摘要（与 `plan.expected_content_digest` 一致；物化后必须核对）。 */
  readonly expected_content_digest: string;
  /**
   * **内核已经构建好的产物字节**（可选）。
   *
   * 为什么要有它：内核在**暂存事务内**用**纯构建器**把字节算好，才能把 `content_digest`
   * 与 `staged` 记录**一起提交**——期望摘要在暂存时就必须已知，否则 I-1（回执摘要来自
   * 实际回读）与"摘要是记录的一部分"这两条无法同时成立。
   *
   * **端口契约**：存在时**必须直接写这份字节**，不得再自行重建（两处产出可能分叉）；
   * 省略时才回退到"端口自己调用构建器"（保留该路径以便单独测试端口）。
   * 无论哪条路径，落盘后都必须回读最终路径并把摘要与 `expected_content_digest` 核对。
   */
  readonly payload?: Uint8Array;
}

/**
 * 物化回执：协议记录里的 `ArtifactReceipt` **加上**端口独有的量（字节长度、条目数、产物 id）。
 * 结构上是 `ArtifactReceipt` 的超集，因此可以直接嵌进 `ArtifactRecord.receipt`。
 *
 * `readback_digest` **必须**来自对 `final_path` 的实际回读（I-1）。
 */
export interface ArtifactMaterializationReceipt extends ArtifactReceipt {
  readonly artifact_id: ArtifactRef;
  readonly byte_length: number;
  /**
   * 容器条目数（DOCX/XLSX/PPTX 的 ZIP 部件数）；自检与独立读回都用它交叉核对。
   *
   * 这里**必填**（对基类型的可选字段做窄化）：端口刚刚读完字节，条目数是它**当场就能给**的事实，
   * 没有"未登记"这一态。基类型 `ArtifactReceipt.entry_count` 之所以可选，是因为它同时承载
   * **历史记录**（本字段引入之前落库的回执里根本没有这一项）——那不是端口回执的处境。
   * 两者不冲突：`number` 可赋给 `number | undefined`，超集声明仍然成立。
   */
  readonly entry_count: number;
}

/** 结构化失败（**不抛错、不静默**）。`kind` 与 `ArtifactFailureKind` 是同一枚举。 */
export interface ArtifactMaterializationFailure {
  readonly artifact_id: ArtifactRef;
  readonly kind: ArtifactFailureKind;
  readonly detail: string;
  readonly at: LogicalTime;
}

export type ArtifactMaterializationResult =
  | { readonly ok: true; readonly receipt: ArtifactMaterializationReceipt }
  | { readonly ok: false; readonly failure: ArtifactMaterializationFailure };

/** 物化端口：实现方负责版本闸门、临时路径写入、结构自检、原子 rename 与回读。 */
export interface ArtifactMaterializationPort {
  materialize(request: ArtifactMaterializationRequest): ArtifactMaterializationResult;
}

/** 构造一条结构化失败（端口实现与夹具共用）。 */
export function materializationFailure(
  request: ArtifactMaterializationRequest,
  kind: ArtifactFailureKind,
  detail: string,
  at: LogicalTime,
): ArtifactMaterializationResult {
  if (detail.length === 0) {
    throw new ValidationError('物化失败的 detail 不能为空（失败必须可追溯，不得静默）');
  }
  return Object.freeze({
    ok: false as const,
    failure: Object.freeze({
      artifact_id: request.artifact_id,
      kind,
      detail,
      at: asLogicalTime(at),
    }),
  });
}

/** 构造一条成功结果（端口实现用；夹具若要测成功路径也应显式调用它，而不是让默认值假装成功）。 */
export function materializationSuccess(
  receipt: ArtifactMaterializationReceipt,
): ArtifactMaterializationResult {
  return Object.freeze({ ok: true as const, receipt: Object.freeze(receipt) });
}

/**
 * 校验请求内部自洽：语义字段必须与路径计划一致。
 * （不一致会让"回执里的路径"与"记录里的 id/版本"指向不同东西，属于静默分叉。）
 *
 * @throws {ValidationError}
 */
export function assertRequestPlanConsistency(request: ArtifactMaterializationRequest): void {
  const { plan } = request;
  const mismatches: string[] = [];
  if (plan.artifact_id !== request.artifact_id) {
    mismatches.push(`artifact_id（请求 ${request.artifact_id} / 计划 ${plan.artifact_id}）`);
  }
  if (plan.task_id !== request.task_id) {
    mismatches.push(`task_id（请求 ${request.task_id} / 计划 ${plan.task_id}）`);
  }
  if (plan.task_revision !== request.task_revision) {
    mismatches.push(
      `task_revision（请求 ${String(request.task_revision)} / 计划 ${String(plan.task_revision)}）`,
    );
  }
  if (plan.template_kind !== request.template_kind) {
    mismatches.push(`template_kind（请求 ${request.template_kind} / 计划 ${plan.template_kind}）`);
  }
  if (plan.expected_content_digest !== request.expected_content_digest) {
    mismatches.push('expected_content_digest（请求与计划不一致）');
  }
  if (plan.expected_content_digest.length === 0) {
    mismatches.push('expected_content_digest 为空');
  }
  if (mismatches.length > 0) {
    throw new ValidationError(
      `物化请求与路径计划不一致：${mismatches.join('；')}（不得让回执路径与记录身份分叉）`,
    );
  }
}

/** 夹具可注入的应答器：拿到请求，返回结构化结果。 */
export type MaterializationResponder = (
  request: ArtifactMaterializationRequest,
) => ArtifactMaterializationResult;

/** 收集型端口（夹具用）：把请求与结果都记下来供断言。 */
export interface CollectingMaterializationPort extends ArtifactMaterializationPort {
  readonly requests: readonly ArtifactMaterializationRequest[];
  readonly results: readonly ArtifactMaterializationResult[];
  clear(): void;
}

/**
 * 构造**纯内存收集端口**（夹具用）。
 *
 * **默认应答 = 结构化失败**（`builder_failed`），理由是防伪造交付：
 * 收集型端口不产出任何真实字节，若默认返回一个"成功回执"，I-1（无回读不得称交付）
 * 就会被一个方便的默认值悄悄击穿。要测成功路径，必须**显式**注入 `responder`。
 *
 * 它不碰存储、不做 IO、不启动轮次：只按到达顺序收集请求与结果。
 */
export function createCollectingMaterializationPort(
  responder?: MaterializationResponder,
): CollectingMaterializationPort {
  const requests: ArtifactMaterializationRequest[] = [];
  const results: ArtifactMaterializationResult[] = [];
  const answer: MaterializationResponder =
    responder ??
    ((request) =>
      materializationFailure(
        request,
        'builder_failed',
        '收集型端口不产出真实字节，故不给出成功回执（I-1：无回读不得称交付）。' +
          '若要测成功路径，请在 createCollectingMaterializationPort(responder) 显式注入应答器。',
        asLogicalTime(LOGICAL_TIME_ORIGIN),
      ));
  return {
    materialize(request: ArtifactMaterializationRequest): ArtifactMaterializationResult {
      requests.push(request);
      const result = answer(request);
      results.push(result);
      return result;
    },
    get requests(): readonly ArtifactMaterializationRequest[] {
      return Object.freeze([...requests]);
    },
    get results(): readonly ArtifactMaterializationResult[] {
      return Object.freeze([...results]);
    },
    clear(): void {
      requests.length = 0;
      results.length = 0;
    },
  };
}

/** 结果的可读描述（证据 / 断言失败信息用）。 */
export function describeMaterializationResult(result: ArtifactMaterializationResult): string {
  return result.ok
    ? `产物 ${result.receipt.artifact_id} 已物化：${result.receipt.final_path}` +
        `（${String(result.receipt.byte_length)} 字节 / ${String(result.receipt.entry_count)} 条目，` +
        `回读摘要 ${result.receipt.readback_digest}，验证者 ${result.receipt.verifier}，@${String(result.receipt.at)}）`
    : `产物 ${result.failure.artifact_id} 物化失败（${result.failure.kind}）：${result.failure.detail}`;
}
