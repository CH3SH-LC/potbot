/**
 * 图形操作的结果形态（R136/R140/R154），与表格包的 `types.ts` 同一纪律。
 *
 * 失败分支**不带 `model`**：调用方拿不到"改了一半的文档"。任何一步抛
 * `DocumentModelError`，原模型一个字节都没动（纯函数 + 局部计算）。
 */

import { DocumentModelError, type DocumentModelProblemCode } from '../../model/errors.js';
import type { DocumentModel } from '../../model/types.js';

/** 失败：`code` 是判据，`detail` 是人类可读说明。 */
export interface DrawingFailure {
  readonly ok: false;
  readonly code: DocumentModelProblemCode;
  readonly detail: string;
}

/** 成功 + 载荷。 */
export type DrawingOutcome<Payload extends object = { readonly model: DocumentModel }> =
  | ({ readonly ok: true } & Payload)
  | DrawingFailure;

/** 跑一段"要么全成、要么什么都不产出"的纯计算。 */
export function runDrawingEdit<Payload extends object>(work: () => Payload): DrawingOutcome<Payload> {
  try {
    return { ok: true, ...work() };
  } catch (error) {
    if (error instanceof DocumentModelError) {
      return { ok: false, code: error.code, detail: error.detail };
    }
    throw error;
  }
}
