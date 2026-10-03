/**
 * 审阅包入口（design-05 P7：WF-077–080）。
 *
 * 边界（与协调者分派的写权一致）：
 * - **不改 `model/types.ts`**：批注正文用既有的 `CommentNode`（挂 `model.comments`），
 *   回复/解决态用本包自带的 `ReviewIndex` 侧表；修订用 `RevisionRecord[]` 表达；
 * - **不做 DOCX 读写**（`w:ins`/`w:del`/`w:commentRangeStart` 的序列化由后续波次接线）；
 * - **不做 UI / 服务端**。
 *
 * 合同锚点：R101（稳定 id）、R102（码位偏移）、R110（不静默丢弃）、R112/R113（零项/多项可解释）、
 * R136（原子性）、R137（幂等）、R141（版本）。
 */

export * from './types.js';
export * from './comments.js';
export * from './revisions.js';
export * from './accept.js';
export * from './compare.js';
export * from './read-revisions.js';
