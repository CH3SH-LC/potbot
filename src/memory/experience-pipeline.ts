/**
 * 经验流水线：候选 → 敏感 / 冲突 / 去重检查 → 允许或拒绝 → **版本化写入**
 * （design-06 P4 / MEM-06；合同 R239 / R240）。
 *
 * ## 裁决**只读复用**，本文件不另造
 *
 * 单条裁决 = `experience.ts` 的 `evaluateExperienceCandidate()`；
 * 一批并发候选 = `experience-merge.ts` 的 `mergeExperienceCandidates()`（确定性、顺序无关）；
 * 落库 = `experience-merge.ts` 的 `commitExperienceDecision()`（写入新版本 + 失效被取代的旧条）。
 * 本层只把这三步串成**一条可交付的流水线**，并补齐流水线级的**证据留痕**与**阻塞计数**。
 *
 * ## 未知外部结果**不固化成成功经验**（R239）——本层的硬门
 *
 * `blocked_unknown_external` 单独列出所有因"外部结果未知"被挡下的候选 lesson。
 * 只要命中了它，就**不会**出现在 `accepted_lessons`，也**不会**被写进库里。
 * 这是"下单未知 / 回执未读回就当成成功经验"在流水线层的机器化否定。
 *
 * ## 记录证据与适用条件（MEM-06）
 *
 * 每条被接受的经验都在 `evidence_records` 里留下：`lesson`、`evidence_kind`、
 * `evidence_refs`、`applies_to_version`、`template_id`。经验不是空口断言——
 * 它带着自己**凭什么**成立、**适用于哪个版本**。
 *
 * ## R240：写库失败如实报告
 *
 * 提供了仓库时，被接受的经验逐条落库；任一失败进入 `commits_failed`，**不宣称已写入**。
 *
 * 纯函数 + 注入仓库：零 IO、不含墙钟与随机数，时间由调用方经 `LogicalTime` 传入。
 */

import type { LogicalTime, Revision, TemplateId } from '../protocol/index.js';
import {
  EXPERIENCE_REJECTION_REASONS,
  type ExperienceCandidate,
  type ExperienceContext,
  type ExperienceEvidenceKind,
  type ExperienceRejectionReason,
} from './experience.js';
import {
  commitExperienceDecision,
  mergeExperienceCandidates,
  type MergedDecision,
} from './experience-merge.js';
import type { MemoryRepository } from './repository.js';
import type { MemoryId } from './types.js';

// ---------------------------------------------------------------------------
// 产出形状
// ---------------------------------------------------------------------------

/** 一条被接受经验的**证据留痕**（MEM-06：经验带证据与适用条件，不是空口断言）。 */
export interface ExperienceEvidenceRecord {
  readonly lesson: string;
  readonly template_id: TemplateId;
  readonly evidence_kind: ExperienceEvidenceKind;
  readonly evidence_refs: readonly string[];
  readonly applies_to_version: string;
}

/** 一条被拒绝的候选及其结构化拒因码。 */
export interface RejectedExperienceRecord {
  readonly lesson: string;
  readonly reason_codes: readonly ExperienceRejectionReason[];
  readonly reasons: readonly string[];
}

/** 一条已版本化写入的经验。 */
export interface WrittenExperience {
  readonly lesson: string;
  readonly memory_id: MemoryId;
  readonly version: Revision;
  /** 被本次取代而失效的旧条 id（无取代时为 `null`）。 */
  readonly superseded_invalidated: MemoryId | null;
}

/** 写库失败记录（R240：如实报告，不宣称成功）。 */
export interface ExperienceCommitFailure {
  readonly lesson: string;
  readonly detail: string;
}

/** 经验流水线的收口结论。 */
export interface ExperiencePipelineReport {
  /** 合并采用的**确定性顺序**（与输入顺序无关）。 */
  readonly stable_order: readonly string[];
  readonly accepted_lessons: readonly string[];
  readonly no_change_lessons: readonly string[];
  readonly rejected: readonly RejectedExperienceRecord[];
  /** 因"外部结果未知"被挡下的 lesson（R239 的硬门；**必然不在** accepted）。 */
  readonly blocked_unknown_external: readonly string[];
  /** 被接受经验的证据与适用条件（MEM-06）。 */
  readonly evidence_records: readonly ExperienceEvidenceRecord[];
  /** 逐条裁决（含被拒 / 不新增），供审计。 */
  readonly decisions: readonly MergedDecision[];
  /** 落库成功的经验（未提供仓库时为空）。 */
  readonly written: readonly WrittenExperience[];
  /** 落库失败（未提供仓库时为空；R240 如实报告）。 */
  readonly commits_failed: readonly ExperienceCommitFailure[];
}

export interface SynthesizeExperiencesInput {
  readonly candidates: readonly ExperienceCandidate[];
  /** 裁决上下文（既有经验 / 敏感 / 冲突策略 / 来源 / 确定性 id 接缝）。 */
  readonly context: ExperienceContext;
  readonly at: LogicalTime;
  /** 提供则**落库**；省略则只评估、不写（纯评估模式）。 */
  readonly repository?: MemoryRepository;
}

// ---------------------------------------------------------------------------
// 流水线
// ---------------------------------------------------------------------------

/** 从裁决理由里抽出结构化拒因码（`evaluateExperienceCandidate` 以 `[code] ` 前缀给出）。 */
function reasonCodesOf(reasons: readonly string[]): readonly ExperienceRejectionReason[] {
  const codes: ExperienceRejectionReason[] = [];
  for (const reason of reasons) {
    const matched = /^\[([a-z_]+)\]/.exec(reason);
    const code = matched?.[1];
    if (code !== undefined && (EXPERIENCE_REJECTION_REASONS as readonly string[]).includes(code)) {
      codes.push(code as ExperienceRejectionReason);
    }
  }
  return Object.freeze(codes);
}

/**
 * 跑一遍经验流水线：合并裁决 → （可选）版本化落库。
 *
 * 关键性质：
 * - **确定性**：合并顺序由稳定排序键决定，与 `candidates` 的输入顺序无关；
 * - **未知外部结果被挡**：进入 `blocked_unknown_external`，绝不写入；
 * - **可得出"不新增"**：同文本候选去重为 `no_change`，不写同义经验；
 * - **R240**：落库失败进 `commits_failed`，不宣称已写入。
 */
export function synthesizeExperiences(input: SynthesizeExperiencesInput): ExperiencePipelineReport {
  const merged = mergeExperienceCandidates(input.candidates, input.context, input.at);

  const accepted: ExperienceCandidate[] = [];
  const acceptedLessons: string[] = [];
  const noChangeLessons: string[] = [];
  const rejected: RejectedExperienceRecord[] = [];
  const blockedUnknownExternal: string[] = [];
  const evidenceRecords: ExperienceEvidenceRecord[] = [];
  const written: WrittenExperience[] = [];
  const commitsFailed: ExperienceCommitFailure[] = [];

  for (const mergedDecision of merged.decisions) {
    const { candidate, decision } = mergedDecision;

    if (decision.decision === 'add') {
      accepted.push(candidate);
      acceptedLessons.push(candidate.lesson);
      evidenceRecords.push(
        Object.freeze({
          lesson: candidate.lesson,
          template_id: candidate.template_id,
          evidence_kind: candidate.evidence_kind,
          evidence_refs: Object.freeze([...candidate.evidence_refs]),
          applies_to_version: candidate.applies_to_version,
        }),
      );
      continue;
    }

    if (decision.decision === 'no_change') {
      noChangeLessons.push(candidate.lesson);
      continue;
    }

    const codes = reasonCodesOf(decision.reasons);
    rejected.push(
      Object.freeze({
        lesson: candidate.lesson,
        reason_codes: codes,
        reasons: decision.reasons,
      }),
    );
    if (codes.includes('unknown_external_result')) {
      blockedUnknownExternal.push(candidate.lesson);
    }
  }

  if (input.repository !== undefined) {
    for (const mergedDecision of merged.decisions) {
      if (mergedDecision.decision.decision !== 'add') continue;
      const candidate = mergedDecision.candidate;
      const committed = commitExperienceDecision({
        repository: input.repository,
        owner_id: input.context.owner_id,
        decision: mergedDecision.decision,
        supersedes_lesson: candidate.supersedes_lesson,
        at: input.at,
      });
      if (committed.kind === 'written') {
        written.push(
          Object.freeze({
            lesson: candidate.lesson,
            memory_id: committed.entry.memory_id,
            version: committed.entry.version,
            superseded_invalidated: committed.superseded_invalidated,
          }),
        );
      } else {
        commitsFailed.push(
          Object.freeze({
            lesson: candidate.lesson,
            detail: committed.kind === 'skipped' ? committed.reason : `${committed.reason}: ${committed.detail}`,
          }),
        );
      }
    }
  }

  return Object.freeze({
    stable_order: merged.order,
    accepted_lessons: Object.freeze(acceptedLessons),
    no_change_lessons: Object.freeze(noChangeLessons),
    rejected: Object.freeze(rejected),
    blocked_unknown_external: Object.freeze(blockedUnknownExternal),
    evidence_records: Object.freeze(evidenceRecords),
    decisions: merged.decisions,
    written: Object.freeze(written),
    commits_failed: Object.freeze(commitsFailed),
  });
}

/**
 * 流水线是否可认为"干净"：无落库失败、且没有任何"未知外部结果"候选被接受。
 *
 * 注意：`no_change` 与"敏感 / 冲突被拒"**不影响**干净度——它们是**正确**的结局（R239）。
 */
export function isExperiencePipelineClean(report: ExperiencePipelineReport): boolean {
  if (report.commits_failed.length > 0) return false;
  const accepted = new Set(report.accepted_lessons);
  return !report.blocked_unknown_external.some((lesson) => accepted.has(lesson));
}
