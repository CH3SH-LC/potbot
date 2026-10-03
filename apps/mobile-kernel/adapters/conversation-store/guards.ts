/**
 * K-I05 会话持久化适配层 —— **最小形状守卫**（零依赖）。
 *
 * 只做"能否安全合并"这一件事所需的判别，**不**复制 K04 的完整 record 校验：
 * 完整校验的真相源在 `apps/mobile-kernel/conversation/transcript.ts` 的
 * `decodeConversationRecords`，适配层不重复实现（避免第二个真相源漂移）。
 */

/** 是否是"朴素对象"（非 null、非数组、非其它引用类型）。 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
