/**
 * **暂存**（design-02 A 批；合同 v1.4 R49.1 的**事务 1**）。
 *
 * ## 这一段在做什么
 *
 * 把"某个 Agent 想交付一份办公室文件"的**意图**，变成一条**已提交的 `staged` 记录**：
 * 装配事实快照 → 用纯构建器算出**真实字节** → 派生 id 与版本化路径 → 写 `ArtifactRecord(status='staged')`。
 *
 * ## 三个关键取舍
 *
 * 1. **字节在事务内算**。构建器是**纯函数**（零 IO、零墙钟），所以"在事务内构建"不违反
 *    info-006 的"外部副作用必须在提交之后"——写盘才是副作用，构建不是。
 *    好处是 `content_digest` 与 `staged` 记录**一起提交**：期望摘要在暂存时就已知，
 *    I-1（回执摘要来自实际回读）与"摘要是记录的一部分"才可能同时成立。
 * 2. **事实由内核装配，不由 Agent 传数字**（R48.3）。Agent 只给"意图 + 用到哪些事实键"，
 *    数字一律从 `SharedFactRecord` 取——它**没有参数位置**可以顺手改数。
 * 3. **缺事实就拒绝，不产零值产物**（R48.4）。快照不可用 ⇒ 返回结构化失败 `missing_fact`，
 *    **不写任何 `staged` 记录**、不写盘。调用方据此把工作项如实收成"部分完成 / 未知"。
 *
 * ## 本文件不做的事
 *
 * - **不写盘**（那是物化端口的事，见 `ports.ts` 与验收侧的宿主实现）；
 * - **不发布**（`staged → published` 是 `publish.ts` 的投影）；
 * - **不改工作项**（`result_refs` 的写入归调度侧的发布事务，本函数只返回产物 id）。
 */

import {
  type ArtifactRef,
  type FactRef,
  type InstanceId,
  type LogicalTime,
  type Revision,
  type StorageTransaction,
  type TaskId,
  type TemplateKind,
} from '../protocol/index.js';
import { createArtifactRecord, type ArtifactFailureKind, type ArtifactRecord } from '../protocol/artifact.js';
import {
  buildFactSnapshot,
  describeUnusableFacts,
  isFactSnapshotUsable,
  type FactSnapshot,
} from '../facts/index.js';
import { planArtifact, type ArtifactPlan } from './planner.js';
import type { ArtifactMaterializationRequest } from './ports.js';
import { buildDocxTemplate, type DocxReference, type DocxTaskRequirement } from './templates/docx.js';
import { buildPresentation } from './templates/pptx.js';
import { buildXlsxTemplate, type XlsxSheetSpec } from './templates/xlsx.js';

/**
 * Agent 在完成发布里给出的**产物意图**（R49.1 事务 1 的入口）。
 *
 * **没有 `artifact_version`**：版本由内核按"同一任务 + 同一模板种类的既有产物数 + 1"派生
 * （`resolveNextArtifactVersion`）。让 Agent 自己挑版本会引入"挑重了 ⇒ 同一 id 幂等塌陷"
 * 的风险，而这属于内核该管的记账。
 */
export interface ArtifactPublicationIntent {
  readonly intent: ArtifactIntent;
  /** 本产物用到的**事实键**（有序）；既用于装配快照，也逐键成为 `source_fact_refs`。 */
  readonly fact_keys: readonly string[];
}

/** 下一个产物版本（同一任务 + 同一模板种类的既有产物数 + 1；确定性、无随机）。 */
export function resolveNextArtifactVersion(
  tx: StorageTransaction,
  taskId: TaskId,
  templateKind: TemplateKind,
): number {
  let max = 0;
  for (const record of tx.listArtifacts()) {
    if (record.task_id === taskId && record.template_kind === templateKind && record.artifact_version > max) {
      max = record.artifact_version;
    }
  }
  return max + 1;
}

/** 三类模板各自的**意图**——注意里面**没有事实值**，只有键与展示意图。 */
export type ArtifactIntent =
  | {
      readonly template_kind: 'document';
      readonly requirement: DocxTaskRequirement;
      readonly references: readonly DocxReference[];
    }
  | {
      readonly template_kind: 'spreadsheet';
      readonly sheet: XlsxSheetSpec;
    }
  | {
      readonly template_kind: 'presentation';
      readonly title: string;
      readonly goal: string;
      readonly audience: string;
    };

/** 一次暂存请求（全部输入；**没有时间之外的墙钟**，`at` 是逻辑时间）。 */
export interface StageArtifactInput {
  readonly intent: ArtifactIntent;
  readonly task_id: TaskId;
  readonly task_revision: Revision;
  /** 同一任务、同一模板种类下的第几版（从 1 起）。 */
  readonly artifact_version: number;
  /**
   * 本产物用到的**事实键**（有序）。它们既用于装配快照，也**逐键**成为
   * `ArtifactRecord.source_fact_refs`——"这个数字从哪来"因此永远可指认。
   */
  readonly fact_keys: readonly string[];
  /** 产物根目录（注入；由调用方决定，**不含墙钟**）。 */
  readonly root_dir: string;
  readonly created_by_instance_id: InstanceId;
  readonly at: LogicalTime;
}

/** 暂存结果：成功给记录 + 物化请求；失败给**结构化**原因（不抛错、不静默）。 */
export type StageArtifactResult =
  | {
      readonly ok: true;
      readonly record: ArtifactRecord;
      readonly request: ArtifactMaterializationRequest;
      readonly snapshot: FactSnapshot;
    }
  | {
      readonly ok: false;
      readonly kind: ArtifactFailureKind;
      readonly detail: string;
      readonly snapshot: FactSnapshot;
    };

/** 构建结果的最小共用形状（三个模板构建器都满足）。 */
interface BuiltBytes {
  readonly bytes: Buffer | Uint8Array;
  readonly entry_count: number;
  readonly content_digest: string;
}

function buildBytes(intent: ArtifactIntent, snapshot: FactSnapshot): BuiltBytes {
  switch (intent.template_kind) {
    case 'document':
      return buildDocxTemplate({
        requirement: intent.requirement,
        fact_snapshot: snapshot.usable,
        references: intent.references,
      });
    case 'spreadsheet':
      return buildXlsxTemplate(intent.sheet, snapshot.usable);
    case 'presentation':
      return buildPresentation({
        title: intent.title,
        goal: intent.goal,
        audience: intent.audience,
        fact_snapshot: snapshot.usable,
      });
  }
}

/**
 * **事务内**暂存一份产物（R49.1 事务 1）。
 *
 * 失败时**不写任何东西**（不 `putArtifact`、不写盘），只返回结构化原因——
 * 这样"缺资料 ⇒ 报部分完成/未知"是一条可判定的路径，而不是靠调用方自觉。
 */
export function stageArtifactInTransaction(
  tx: StorageTransaction,
  input: StageArtifactInput,
): StageArtifactResult {
  // ① 单一来源：事实从存储取，Agent 手里没有数字（R48.3）。
  const snapshot = buildFactSnapshot({
    facts: tx.listSharedFacts(),
    task_id: input.task_id,
    task_revision: input.task_revision,
    fact_keys: input.fact_keys,
  });

  if (!isFactSnapshotUsable(snapshot)) {
    // ② 缺失/未知 ⇒ 阻塞。**不产产物、不产零值产物**（R48.4）。
    return {
      ok: false,
      kind: 'missing_fact',
      detail: describeUnusableFacts(snapshot),
      snapshot,
    };
  }

  let built: BuiltBytes;
  try {
    built = buildBytes(input.intent, snapshot);
  } catch (error) {
    // 构建器抛出（例如文档正文里出现了无法指认的数字）⇒ 结构化失败，不让它掀掉整个收尾事务。
    return {
      ok: false,
      kind: 'builder_failed',
      detail: error instanceof Error ? error.message : String(error),
      snapshot,
    };
  }

  // ③ 计划：派生 id + 版本化路径（无计数器、无墙钟、无随机）。
  const plan: ArtifactPlan = planArtifact({
    task_id: input.task_id,
    task_revision: input.task_revision,
    template_kind: input.intent.template_kind,
    artifact_version: input.artifact_version,
    root_dir: input.root_dir,
    expected_content_digest: built.content_digest,
  });

  const sourceFactRefs: FactRef[] = snapshot.usable.map((entry) => entry.fact_ref);
  const templateKind: TemplateKind = input.intent.template_kind;

  // ④ 落 `staged` 记录（与事实、工作项在**同一事务**）。
  //    此刻**还没有任何文件被写**——这正是 I-4 说"staged 不满足任何交付判据"的原因。
  const record = createArtifactRecord({
    artifact_id: plan.artifact_id,
    task_id: input.task_id,
    task_revision: input.task_revision,
    artifact_version: input.artifact_version,
    template_kind: templateKind,
    byte_length: built.bytes.byteLength,
    content_digest: built.content_digest,
    source_fact_refs: sourceFactRefs,
    created_by_instance_id: input.created_by_instance_id,
    status: 'staged',
    verifications: [
      {
        kind: 'version_match',
        outcome: 'pass',
        detail: `暂存时任务版本 r${String(input.task_revision)}（发布前还会在投影里再核对一次）`,
      },
    ],
    created_at: input.at,
  });
  tx.putArtifact(record);

  return {
    ok: true,
    record,
    snapshot,
    request: {
      artifact_id: plan.artifact_id,
      task_id: input.task_id,
      task_revision: input.task_revision,
      template_kind: templateKind,
      fact_snapshot: snapshot.usable,
      plan,
      expected_content_digest: built.content_digest,
      payload: built.bytes,
    },
  };
}

/** 只读辅助：从暂存结果里取产物 id（失败时为 `null`），便于调度侧写 `result_refs`。 */
export function stagedArtifactId(result: StageArtifactResult): ArtifactRef | null {
  return result.ok ? result.record.artifact_id : null;
}
