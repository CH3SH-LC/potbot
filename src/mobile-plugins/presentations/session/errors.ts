/**
 * P10 手机侧演示编辑会话的**具名失败面**。
 *
 * 纪律：会话层的每一次拒绝都带一个封闭枚举里的 `reason`，绝不静默夹取、绝不吞错。
 * 产品面据此把 `reason` 映射成 HTTP/事件码；测试据此做**具名**断言（不是"抛了就算过"）。
 */

import { ValidationError } from '../../../protocol/index.js';

/** 会话层具名拒绝原因（封闭枚举）。 */
export type PresentationSessionErrorReason =
  /** 编辑对象不是合法结构 / 缺少必需字段。 */
  | 'invalid_edit'
  /** 编辑的 `op` 不在封闭枚举里。 */
  | 'unsupported_op'
  /** 并发：写入方基于的版本已不是当前版本。 */
  | 'stale_write'
  /** 导入的既有演示**不能**增 / 删页（`exportImportedPresentation` 的 `slide_set_changed`）。 */
  | 'slide_set_locked_for_imported'
  /** 导入的既有演示**不能**新增 / 删除备注部件（备注部件增删未封装）。 */
  | 'notes_part_locked_for_imported'
  /** 事实未接入（还没有目标版本），却要执行需要事实的操作。 */
  | 'no_facts_attached'
  /** 指定的历史事实版本不存在。 */
  | 'unknown_fact_version'
  /** 导入字节失败。 */
  | 'import_failed'
  /** 保存时同版事实冲突（据实拒绝交付，不静默取一处）。 */
  | 'fact_conflict'
  /** 无可撤销 / 无可重做。 */
  | 'nothing_to_undo'
  | 'nothing_to_redo'
  /** 适配器导出的摘要与会话独立重算的 sha256 不一致（构件层缺陷）。 */
  | 'digest_mismatch';

/** 会话层错误。`reason` 是判定用的稳定标识；`message` 只给人看。 */
export class PresentationSessionError extends ValidationError {
  readonly reason: PresentationSessionErrorReason;

  constructor(reason: PresentationSessionErrorReason, message: string) {
    super(message);
    this.name = 'PresentationSessionError';
    this.reason = reason;
  }
}

/** 把任意抛出物描述成一行文本。 */
export function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
