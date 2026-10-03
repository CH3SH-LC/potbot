/**
 * MT-04：按用户分享的**文本 / 链接 / 图片 / 文件**补充候选。
 *
 * ## 与在线来源**分开标识**
 *
 * 本模块产出的候选一律 `sourceKind === 'user_shared'`，并复用 `candidates.ts` 的
 * {@link candidatesFromUserShare} 构造（同一套来源模型，不另造一套）。
 * 分区口径见 {@link partitionBySource}——**不**把分享条目与接口条目混在一起排序。
 *
 * ## 图片 / 文件不是"看一眼就懂"
 *
 * 从图片 / 文件里抽候选，需要 **OCR / 文档解析**通道。该通道未接通时，
 * 本模块把该分享物**结构化地跳过**（记原因），**不**凭模型"看图说话"编出店名与价格。
 *
 * ## 只比较几个候选 ≠ 全平台最优
 *
 * 出口字段 `optimized_over_all_platforms` 是**字面量 `false`**：分享回来的信息
 * 无论写着"全网最低""内部价"，都改变不了"我们只比较了你给的那几条"这一事实。
 */

import {
  candidatesFromUserShare,
  type Candidate,
  type UserSharedItem,
} from './candidates.js';

/** 用户分享物的形态。 */
export type ShareKind = 'text' | 'link' | 'image' | 'file';

export interface UserShareInput {
  readonly kind: ShareKind;
  /** 分享物标识（"粘贴文本#1" / 链接 / "聊天截图.png"）。**不得为空**。 */
  readonly label: string;
  /** 文本 / 链接 的正文；图片 / 文件为占位（真正内容要经抽取通道）。 */
  readonly content: string;
}

/**
 * 图片 / 文件的抽取端口（OCR / 文档解析）。
 * 未接通时为 null —— 那时图片 / 文件只会被**跳过**，不会被"读心"。
 */
export interface ShareExtractionPort {
  readonly sourceId: string;
  extract(input: UserShareInput): Promise<
    | { readonly ok: true; readonly text: string }
    | { readonly ok: false; readonly reason: string }
  >;
}

export interface SkippedShare {
  readonly label: string;
  readonly kind: ShareKind;
  readonly reason: string;
}

export interface ShareIntakeResult {
  /** 由分享内容转成的候选（`sourceKind === 'user_shared'`）。 */
  readonly accepted: readonly Candidate[];
  /** 被结构化跳过的分享物（图片 / 文件缺抽取通道，或内容为空）。 */
  readonly skipped: readonly SkippedShare[];
  /**
   * **恒为 false**：只比较用户给的这几条，**不**宣称全平台最优。
   * 写成字面量类型，使"宣称全平台最优"在类型层面不成立。
   */
  readonly optimized_over_all_platforms: false;
  /** 比较范围的如实说明（必须随结果展示）。 */
  readonly comparisonScope: string;
}

/** 从分享物文本里抽出候选条目（文本 / 链接直接可用；图片 / 文件见下）。 */
export function shareToItems(input: UserShareInput): readonly UserSharedItem[] {
  const content = input.content.trim();
  if (content === '') return [];
  return [
    {
      title: firstLine(content),
      detail: content,
      sourceRef: input.label,
    },
  ];
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/u, 1)[0] ?? text;
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

/**
 * 接收用户分享，产出**与在线来源分开**的候选。
 *
 * - 文本 / 链接：直接成候选（来源 = 分享物标识）；
 * - 图片 / 文件：**必须**有抽取端口；缺端口 ⇒ 结构化跳过，**不**臆造内容；
 * - 抽取端口失败 ⇒ 同样跳过并记接口给的原因。
 */
export async function intakeSharedCandidates(
  shares: readonly UserShareInput[],
  extraction: ShareExtractionPort | null,
  fetchedAtMs: number,
): Promise<ShareIntakeResult> {
  const items: UserSharedItem[] = [];
  const skipped: SkippedShare[] = [];

  for (const share of shares) {
    if (share.kind === 'text' || share.kind === 'link') {
      const direct = shareToItems(share);
      if (direct.length === 0) {
        skipped.push({ label: share.label, kind: share.kind, reason: '分享内容为空，未产出候选' });
        continue;
      }
      items.push(...direct);
      continue;
    }

    // 图片 / 文件：必须有抽取通道。
    if (extraction === null) {
      skipped.push({
        label: share.label,
        kind: share.kind,
        reason:
          `未接通 OCR / 文档解析通道（来源端口 ${share.kind === 'image' ? 'OCR' : '文档解析'} 未就绪）：` +
          '不凭模型"看图说话"编出店名与价格，故跳过该分享物。',
      });
      continue;
    }

    const extracted = await extraction.extract(share);
    if (!extracted.ok) {
      skipped.push({
        label: share.label,
        kind: share.kind,
        reason: `抽取失败：${extracted.reason}`,
      });
      continue;
    }
    const parsed = shareToItems({ ...share, content: extracted.text });
    if (parsed.length === 0) {
      skipped.push({ label: share.label, kind: share.kind, reason: '抽取结果为空，未产出候选' });
      continue;
    }
    items.push(...parsed);
  }

  const accepted = candidatesFromUserShare(items, fetchedAtMs);
  const count = accepted.length;

  return {
    accepted,
    skipped,
    optimized_over_all_platforms: false,
    comparisonScope:
      count === 0
        ? '本次没有从分享内容得到任何候选：仅代表"这些分享物"没给出可用条目，**不**代表全网无此店。'
        : `仅比较用户分享的 ${String(count)} 条候选（另有 ${String(skipped.length)} 条被跳过）：` +
          '**不**代表全平台最优，也**不**替代在线来源的检索（MT-04）。',
  };
}

/** 拆分分享候选与在线候选（分享条目**不**混进在线排序）。 */
export function splitShareFromOnline(candidates: readonly Candidate[]): {
  readonly online: readonly Candidate[];
  readonly userShared: readonly Candidate[];
} {
  return {
    online: candidates.filter((candidate) => candidate.provenance.sourceKind === 'authorized_interface'),
    userShared: candidates.filter((candidate) => candidate.provenance.sourceKind === 'user_shared'),
  };
}
