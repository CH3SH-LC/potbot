/**
 * **W-R05 操作描述符（schemas / types）**——把「独立复核」与「保存重开差异」表达成
 * 两个**具名、可机读**的操作，字段形状对齐六线 README §5 的 `OfficePlugin`
 * （`inspect` / `apply` 语义：返回结构完整性、变更对象与告警，而不是一句自然语言）。
 *
 * 纯 TS，零 `node:*`——与 `verifier/**` 其余部分同约束。
 *
 * ## 两个操作
 * - `ooxml.verify`：吃一个包的字节，吐 `VerifyResult`（是否自洽 + 逐条 issue）。
 * - `ooxml.diffSaveReopen`：吃「消费端保存前 / 保存后」两份字节，吐一份 `SaveReopenReport`：
 *   逐部件差异 + 两边的结构复核 + 告警。**告警而非失败**地报告「部件被新增/删除」——真实
 *   消费端（Word/WPS/python-docx）在重开另存时**可能**合法地新增部件（如补 customXml、
 *   补 docProps）；判「损坏」的硬判据是**两边各自是否自洽**，而不是「部件集合必须不变」。
 */

import {
  diffOoxmlPackages,
  verifyOoxmlPackage,
  type PartDiff,
  type VerifyResult,
} from './ooxml-verify.js';
import type { ZipParseOptions } from './zip-container.js';

/** 本复核器对外暴露的操作名。 */
export type Wr05Operation = 'ooxml.verify' | 'ooxml.diffSaveReopen';

// ---------------------------------------------------------------------------
// ooxml.verify
// ---------------------------------------------------------------------------

export interface OoxmlVerifyRequest {
  /** 整个 OOXML/ZIP 包的字节。 */
  readonly zipBytes: Uint8Array;
}

/** 与 `verifyOoxmlPackage` 同形——避免两套结果结构。 */
export type OoxmlVerifyResult = VerifyResult;

// ---------------------------------------------------------------------------
// ooxml.diffSaveReopen
// ---------------------------------------------------------------------------

export interface SaveReopenDiffRequest {
  /** 消费端**保存前**的包字节（例如导入的外部 DOCX）。 */
  readonly beforeBytes: Uint8Array;
  /** 消费端**保存后**的包字节（例如 Word/WPS/python-docx 重开另存）。 */
  readonly afterBytes: Uint8Array;
}

export type SaveReopenWarningKind =
  /** 消费端产物**多出**了部件（合法但需登记）。 */
  | 'structure_added'
  /** 消费端产物**少了**部件（合法但要确认不是丢件）。 */
  | 'structure_removed'
  /** 保存前的包本身不完备（缺声明 / 悬空关系 / CRC 不符 / 结构错）。 */
  | 'source_invalid'
  /** 保存后的包不完备——这是**真正危险**的信号：消费端产出了坏包。 */
  | 'result_invalid'
  /** 没有任何部件逐字节保留——可疑（连媒体/自定义部件都被重写）。 */
  | 'no_parts_preserved';

export interface SaveReopenWarning {
  readonly kind: SaveReopenWarningKind;
  readonly detail: string;
}

export interface SaveReopenReport {
  /** 两份包**各自自洽**才算 `true`（`added`/`removed` 只作告警，不判失败）。 */
  readonly ok: boolean;
  /** 逐部件字节差异（新增 / 删除 / 变化 / 保留）。 */
  readonly diff: PartDiff;
  readonly sourceVerify: VerifyResult;
  readonly resultVerify: VerifyResult;
  /** 逐字节保留的部件名（= `diff.unchanged`，单列以便消费者直读）。 */
  readonly preservedParts: readonly string[];
  readonly warnings: readonly SaveReopenWarning[];
}

const EMPTY_DIFF: PartDiff = {
  added: [],
  removed: [],
  changed: [],
  unchanged: [],
};

function hasZipError(result: VerifyResult): boolean {
  return result.issues.some((issue) => issue.kind === 'zip_error');
}

/**
 * 生成一份「保存重开」报告：先各自独立复核两份包，再做逐部件字节差异，最后把
 * 「部件集合变化」与「任一边不自洽」归成结构化告警。
 *
 * 任一边在**容器级**就失败（`zip_error`）时不做差异（无法可靠解包），`diff` 置空。
 */
export function saveReopenReport(
  beforeBytes: Uint8Array,
  afterBytes: Uint8Array,
  options: ZipParseOptions = {},
): SaveReopenReport {
  const sourceVerify = verifyOoxmlPackage(beforeBytes, options);
  const resultVerify = verifyOoxmlPackage(afterBytes, options);

  const warnings: SaveReopenWarning[] = [];
  if (!sourceVerify.ok) {
    warnings.push({
      kind: 'source_invalid',
      detail: sourceVerify.issues.map((issue) => `${issue.kind}:${issue.detail}`).join('; '),
    });
  }
  if (!resultVerify.ok) {
    warnings.push({
      kind: 'result_invalid',
      detail: resultVerify.issues.map((issue) => `${issue.kind}:${issue.detail}`).join('; '),
    });
  }

  let diff: PartDiff = EMPTY_DIFF;
  if (!hasZipError(sourceVerify) && !hasZipError(resultVerify)) {
    diff = diffOoxmlPackages(beforeBytes, afterBytes, options);
    for (const name of diff.added) {
      warnings.push({ kind: 'structure_added', detail: name });
    }
    for (const name of diff.removed) {
      warnings.push({ kind: 'structure_removed', detail: name });
    }
    if (diff.unchanged.length === 0 && diff.added.length === 0) {
      warnings.push({
        kind: 'no_parts_preserved',
        detail: 'no package part survived the reopen byte-identical',
      });
    }
  }

  return {
    ok: sourceVerify.ok && resultVerify.ok,
    diff,
    sourceVerify,
    resultVerify,
    preservedParts: diff.unchanged,
    warnings,
  };
}
