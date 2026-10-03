/**
 * 表格操作的结果形态（R136/R140/R154）。
 *
 * ## 为什么失败分支**不带** `model`
 *
 * 与 `model/structure.ts` 的 `StructureEditOutcome` 同一条纪律：失败时调用方拿不到
 * "改了一半的表"。实现上每个操作都在**局部变量**里算出完整的新表，最后一步才换进模型；
 * 任何一步抛 `DocumentModelError`，原模型一个字节都没动。
 *
 * 调用方通常不需要看这个类型——用 `runTableEdit` 包住纯计算即可：
 *
 * ```ts
 * const outcome = runTableEdit(() => ({ model: replaceTableInModel(model, id, next) }));
 * ```
 */

import { DocumentModelError, type DocumentModelProblemCode } from '../../model/errors.js';
import type { DocumentModel } from '../../model/types.js';

/** 失败：`code` 是**判据**（可机械分支），`detail` 是人类可读说明。 */
export interface TableFailure {
  readonly ok: false;
  readonly code: DocumentModelProblemCode;
  readonly detail: string;
}

/** 成功 + 操作特有的载荷。 */
export type TableOutcome<Payload extends object = { readonly model: DocumentModel }> =
  | ({ readonly ok: true } & Payload)
  | TableFailure;

/**
 * 跑一段"要么全成、要么什么都不产出"的纯计算。
 *
 * 只把 `DocumentModelError` 转成失败分支——其他异常（bug、类型错）**照原样抛出**，
 * 不伪装成"业务拒绝"（否则真正的缺陷会被当成合法结果吞掉）。
 */
export function runTableEdit<Payload extends object>(work: () => Payload): TableOutcome<Payload> {
  try {
    return { ok: true, ...work() };
  } catch (error) {
    if (error instanceof DocumentModelError) {
      return { ok: false, code: error.code, detail: error.detail };
    }
    throw error;
  }
}

/** 构造失败分支（供不需要 try/catch 的前置检查使用）。 */
export function tableFailure(code: DocumentModelProblemCode, detail: string): TableFailure {
  return { ok: false, code, detail };
}
