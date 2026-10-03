/**
 * F02 chat —— 引用卡渲染描述（结构 + 文案/配色，**不读真实 bytes**）。
 *
 * 只读消费 F01 令牌：`colors.success` 的用途列写死为「有可信完成证据；状态始终有文字」，
 * `colors['accent-text']` 为「轻强调文字和待处理信息」。因此：
 *   有合法 `sha256:` 摘要 ⇒ 可核验（success 语义 + 文字状态）；
 *   只有标题/引用而**无**摘要 ⇒ 未核验（强调色 + 明确写「尚无完成证据」）。
 * 这一条与契约「fixture 不得冒充 confirmed」「不得返回电脑绝对路径」同源：
 * 引用卡不得把「有引用」渲染成「已完成」。
 */

import { colors } from '../foundation/tokens.js';
import type { MessageReference, ReferenceKind } from './types.js';

const SHA256_RE = /^sha256:[0-9a-f]{64}$/;

export type ReferenceStatus = 'available' | 'unverified';

export interface ReferenceView {
  readonly refId: string;
  readonly kind: ReferenceKind;
  /** 卡片标题（引用自身的 label，不做「已完成」措辞）。 */
  readonly title: string;
  readonly kindLabel: string;
  /** 副标题：证据与版本的可读描述。 */
  readonly subtitle: string;
  readonly status: ReferenceStatus;
  /** 状态文字：状态**始终有文字**，不允许只靠颜色表达。 */
  readonly statusLabel: string;
  /** 取自 F01 令牌的十六进制颜色。 */
  readonly toneColor: string;
  readonly actionLabel: string;
}

const KIND_LABELS: Readonly<Record<ReferenceKind, string>> = {
  artifact: '产物',
  file: '文件',
  decision: '决策',
  task: '任务',
};

/** 只有合法的 `sha256:<64 位小写十六进制>` 才被当作可核验证据。 */
export function isVerifiableDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && SHA256_RE.test(value);
}

/** 该引用是否带可核验证据（渲染为 success 语义的**唯一**条件）。 */
export function hasVerifiedEvidence(ref: MessageReference): boolean {
  return isVerifiableDigest(ref.digest);
}

function subtitleFor(ref: MessageReference, status: ReferenceStatus): string {
  const parts: string[] = [];
  if (typeof ref.revision === 'number') parts.push(`版本 ${ref.revision}`);
  if (ref.mime !== undefined && ref.mime.length > 0) parts.push(ref.mime);
  if (status === 'available' && typeof ref.digest === 'string') {
    parts.push(`摘要 ${ref.digest.slice(7, 15)}…`);
  } else {
    parts.push('尚无完成证据');
  }
  return parts.join(' · ');
}

/** 由引用结构生成渲染描述（纯函数，不读文件、不发请求）。 */
export function describeReference(ref: MessageReference): ReferenceView {
  const status: ReferenceStatus = hasVerifiedEvidence(ref) ? 'available' : 'unverified';
  return {
    refId: ref.refId,
    kind: ref.kind,
    title: ref.label,
    kindLabel: KIND_LABELS[ref.kind],
    subtitle: subtitleFor(ref, status),
    status,
    statusLabel: status === 'available' ? '已核验' : '未核验',
    toneColor: status === 'available' ? colors.success.value : colors['accent-text'].value,
    actionLabel: status === 'available' ? '打开' : '查看状态',
  };
}

export function describeReferences(refs: readonly MessageReference[]): readonly ReferenceView[] {
  return refs.map(describeReference);
}
