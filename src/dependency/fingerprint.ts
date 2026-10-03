/**
 * **阻塞指纹**（Q9-b；任务书 §10「相同任务版本、相同阻塞指纹在没有新证据时最多进行一次自动恢复」）。
 *
 * 合同 Q9-b 冻结的四元组：
 *
 * ```
 * (task_revision, 阻塞工作项 id 集合, 阻塞原因类别, 依赖项 id 集合)
 * ```
 * **四项全同 = 同一指纹**。本文件是这四项的**唯一规范化与摘要实现处**。
 *
 * ## 规范化规则（本文件定，登记在证据 JSON 里）
 * 1. 三个集合一律 **去重 + 升序**（`compareStrings`，不依赖 locale ⇒ Q8-c 重现性）；
 * 2. 阻塞工作项 = 未终态 **且** 有 `blocker_reason` 的项（`isBlocked`）；
 * 3. 阻塞原因类别 = 这些项的 `blocker_reason.kind` 的**集合**。合同原文"原因类别"是单数，
 *    但多个阻塞项可能类别不同；取集合在"全部同类别"时自然退化为单元素，且**更精确**
 *    （精确 = 更少把不同的阻塞误判为同一指纹 ⇒ 不会错误地少恢复）。此为对合同的**主动解释**，
 *    已在 `docs/other/evidence/D05/` 的证据 JSON 中登记。
 * 4. 依赖项 id = 阻塞项的 `dependency_refs` 里**三种命名空间**的标识（`req:` / `ins:` / `art:` 前缀）。
 *    前缀避免 `req:x` 与 `ins:x` 撞成同一字符串；
 * 5. 阻塞项**必须同属一个任务版本**：跨版本无法算出单一 `task_revision` ⇒ 抛 `FingerprintError`
 *    （"算不出就报错"，不猜）。
 *
 * `key`（规范化字符串）用于相等判定与 Map 键；`digest`（sha256）用于日志与证据。
 */

import {
  asRevision,
  type BlockerKind,
  type RequestId,
  type Revision,
  type WorkItem,
} from '../protocol/index.js';
import { canonicalDigest } from './digest.js';
import { DependencyError } from './errors.js';
import { compareStrings, dependencyIdTags, indexWorkItems, isBlocked, uniqueSorted } from './graph.js';

export class FingerprintError extends DependencyError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FingerprintError';
  }
}

/** Q9-b 四元组的原始输入（未规范化）。 */
export interface BlockingFingerprintInput {
  readonly task_revision: Revision;
  readonly blocked_request_ids: readonly RequestId[];
  readonly blocker_kinds: readonly BlockerKind[];
  readonly dependency_ids: readonly string[];
}

/** Q9-b 四元组（已规范化 + 摘要）。 */
export interface BlockingFingerprint {
  readonly task_revision: Revision;
  /** 阻塞工作项 id 集合（升序、去重）。 */
  readonly blocked_request_ids: readonly RequestId[];
  /** 阻塞原因类别集合（升序、去重）。 */
  readonly blocker_kinds: readonly BlockerKind[];
  /** 依赖项 id 集合（带命名空间前缀，升序、去重）。 */
  readonly dependency_ids: readonly string[];
  /** 规范化字符串（相等判定 / Map 键；只含可见 ASCII）。 */
  readonly key: string;
  /** `key` 的 sha256 摘要（日志与证据用）。 */
  readonly digest: string;
}

/**
 * 规范化并计算指纹。
 *
 * 规范化后的 `key` 是 JSON 数组编码 `[revision, blocked, kinds, deps]`——
 * 数组编码无歧义（不会因分隔符出现在 id 里而产生碰撞），且不含控制字符。
 */
export function computeBlockingFingerprint(input: BlockingFingerprintInput): BlockingFingerprint {
  const revision = input.task_revision;
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) {
    throw new FingerprintError(`任务版本非法：${JSON.stringify(revision)}——阻塞指纹算不出即报错`);
  }
  const blocked = uniqueSorted(input.blocked_request_ids.map(String)) as RequestId[];
  const kinds = uniqueSorted(input.blocker_kinds.map(String)) as BlockerKind[];
  const deps = uniqueSorted(input.dependency_ids);

  const key = JSON.stringify([Number(revision), blocked, kinds, deps]);
  return Object.freeze({
    task_revision: revision,
    blocked_request_ids: Object.freeze(blocked),
    blocker_kinds: Object.freeze(kinds),
    dependency_ids: Object.freeze(deps),
    key,
    digest: canonicalDigest(key),
  });
}

export interface FingerprintFromItemsOptions {
  /** 期望的任务版本；给出时与阻塞项携带的版本不符即抛错（防止调用方张冠李戴）。 */
  readonly task_revision?: Revision;
  /**
   * **受控缺陷注入（R7 / Q10-c，默认关闭）**：让指纹忽略任务版本。
   * 打开后不同版本会得到**同一指纹** ⇒ "同版同阻塞最多一次恢复"退化为"永久只看一次"，
   * 用于证明 A05-09 / I-A05-1 的断言真会失败。
   */
  readonly ignore_task_revision?: boolean;
}

/**
 * 从工作项集合算出阻塞指纹。
 *
 * 无阻塞项 ⇒ 返回 `null`（没有阻塞就没有指纹，调用方据此跳过自动恢复判定）。
 */
export function fingerprintOfBlockedItems(
  items: readonly WorkItem[],
  options: FingerprintFromItemsOptions = {},
): BlockingFingerprint | null {
  indexWorkItems(items); // 重复 id 即抛错（与依赖图同一纪律）
  const blocked = items.filter(isBlocked);
  if (blocked.length === 0) {
    return null;
  }

  const ignoreRevision = options.ignore_task_revision === true;
  const revisions = new Set<number>(blocked.map((item) => Number(item.task_revision)));

  if (!ignoreRevision && revisions.size > 1) {
    throw new FingerprintError(
      `阻塞工作项跨越多个任务版本（${[...revisions].sort((a, b) => a - b).join(' / ')}）：` +
        `Q9-b 只定义单个 task_revision，无法算出单一阻塞指纹。` +
        `请按版本分别计算，或先推进任务版本`,
    );
  }

  const first = blocked[0];
  if (first === undefined) {
    return null;
  }
  const revision = ignoreRevision ? asRevision(0) : first.task_revision;

  if (options.task_revision !== undefined && !ignoreRevision && options.task_revision !== revision) {
    throw new FingerprintError(
      `调用方给出的任务版本 ${Number(options.task_revision)} 与阻塞项携带的版本 ` +
        `${Number(revision)} 不一致：无法算出可信的阻塞指纹`,
    );
  }

  const blockerKinds: BlockerKind[] = [];
  const dependencyIds: string[] = [];
  for (const item of blocked) {
    const kind = item.blocker_reason?.kind;
    if (kind !== undefined) {
      blockerKinds.push(kind);
    }
    dependencyIds.push(...dependencyIdTags(item.dependency_refs));
  }

  return computeBlockingFingerprint({
    task_revision: revision,
    blocked_request_ids: blocked.map((item) => item.request_id),
    blocker_kinds: blockerKinds,
    dependency_ids: dependencyIds,
  });
}

/** 指纹的规范化键（`null` 原样透传）。 */
export function fingerprintKeyOf(fingerprint: BlockingFingerprint | null): string | null {
  return fingerprint === null ? null : fingerprint.key;
}

/** 两个指纹是否同一（`key` 相等；`null` 只与 `null` 相等）。 */
export function isSameFingerprint(
  a: BlockingFingerprint | null,
  b: BlockingFingerprint | null,
): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.key === b.key;
}

/** 指纹的可读描述（诊断原因文本 / 证据用）。 */
export function describeFingerprint(fingerprint: BlockingFingerprint): string {
  return (
    `r${Number(fingerprint.task_revision)} ` +
    `阻塞[${fingerprint.blocked_request_ids.join(',')}] ` +
    `原因[${fingerprint.blocker_kinds.join(',')}] ` +
    `依赖[${fingerprint.dependency_ids.join(',')}] ` +
    `#${fingerprint.digest.slice(0, 12)}`
  );
}

/** 用于排序 / 断言的确定性比较（先版本、后键）。 */
export function compareFingerprints(a: BlockingFingerprint, b: BlockingFingerprint): number {
  if (a.task_revision !== b.task_revision) {
    return a.task_revision < b.task_revision ? -1 : 1;
  }
  return compareStrings(a.key, b.key);
}
