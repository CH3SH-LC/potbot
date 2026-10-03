/**
 * 表格域：**损坏包的准确拒绝**（X01 / EXCEL.md "损坏包准确拒绝"）。
 *
 * ## 这个文件要补的是哪块空白
 *
 * `readZip` 与 `readWorkbookXlsx` 都已经会抛错，但调用方拿到的是一个裸异常：
 * 它**分不清**"ZIP 容器坏了"和"容器好但 OOXML 结构坏了"，也拿不到一个可陈述的类别码。
 * 一个要"准确拒绝损坏包"的装配器需要的是**结构性结论**，而不只是一条消息字符串。
 *
 * 本模块把两层拒绝**收敛成一个可陈述的结果**：
 *
 * | 层 | 触发者 | 含义 |
 * |---|---|---|
 * | `container` | `readZip`（`ZipReadError`） | ZIP 容器本身不合法（截断 / CRC / 压缩炸弹 / 路径非法……） |
 * | `package` | `readWorkbookXlsx`（`ValidationError`） | 容器合法，但 OOXML 结构不合法（缺部件 / 悬空关系 / 关系 id 重复 / 单元格越界……） |
 *
 * ## 不吞掉未知错误
 *
 * 只有 `ZipReadError` 与 `ValidationError` 被归类；**其它任何异常原样抛出**——
 * "我认识的坏"与"我没见过的坏"必须能被调用方区分，不能统一包装成"损坏"。
 *
 * ## 边界
 *
 * - 本模块**不修改**输入字节，也**不修改**任何既有读取行为；它只是把 `readZip` +
 *   `readWorkbookXlsx` 的结论显式化。
 * - `warnings` 只登记"能读但不完全合规"的观察（例如缺 `[Content_Types].xml`），
 *   它**不是**拒绝；调用方自行决定是否收紧。
 * - 正常路径会读两次（一次 `readZip` 取条目数、一次 `readWorkbookXlsx`），
 *   这是为了在不改读取器返回形状的前提下拿到容器层诊断；两份读取器都是纯函数。
 */

import { ZipReadError } from '../../artifacts/ooxml/index.js';
import { readZip } from '../../artifacts/ooxml/zip-read.js';
import { ValidationError } from '../../protocol/index.js';
import { readWorkbookXlsx } from '../xlsx-read.js';

/** 拒绝发生在哪一层。 */
export type PackageRejectionLayer = 'container' | 'package';

/** 读得动的包。 */
export interface PackageOk {
  readonly status: 'ok';
  /** ZIP 条目数（含关系部件与 `[Content_Types].xml`）。 */
  readonly part_count: number;
  /** 工作表名（按工作簿顺序）。 */
  readonly sheet_names: readonly string[];
  /** 读进残留的未知部件路径（R249）。 */
  readonly residual_part_paths: readonly string[];
  /** 能读但不完全合规的观察（**不是**错误）。 */
  readonly warnings: readonly string[];
}

/** 被拒绝的包。 */
export interface PackageRejected {
  readonly status: 'rejected';
  readonly layer: PackageRejectionLayer;
  /** 类别码：容器层是 `ZipReadError.reason`；包层是本模块的稳定分类码。 */
  readonly code: string;
  /** 原始消息（真实、未改写）。 */
  readonly detail: string;
}

export type PackageInspection = PackageOk | PackageRejected;

/** 包层错误的分类表（模式来自读取器的稳定对外契约；命中第一条即取该码）。 */
const PACKAGE_REASON_TABLE: readonly { readonly code: string; readonly pattern: RegExp }[] = Object.freeze([
  Object.freeze({ code: 'missing_required_part', pattern: /缺少部件/ }),
  Object.freeze({ code: 'missing_sheets', pattern: /缺少 <sheets>|<sheets> 是空的/ }),
  Object.freeze({ code: 'missing_sheet_name_or_id', pattern: /缺少 name 或 r:id/ }),
  Object.freeze({ code: 'dangling_sheet_relationship', pattern: /关系表里不存在/ }),
  Object.freeze({ code: 'duplicate_relationship_id', pattern: /关系 id .* 出现了两次/ }),
  Object.freeze({ code: 'multiple_shared_formula_masters', pattern: /多个共享公式主格/ }),
  Object.freeze({ code: 'shared_formula_unresolvable', pattern: /共享公式的从属格/ }),
  Object.freeze({ code: 'formula_without_text', pattern: /无文本的/ }),
  Object.freeze({ code: 'unknown_error_value', pattern: /不认识的错误值/ }),
  Object.freeze({ code: 'invalid_cell_value', pattern: /无法解析|超出本仓支持范围|引用了越界的共享字符串|引用越界/ }),
  Object.freeze({ code: 'invalid_date_value', pattern: /非法 ISO 日期/ }),
  Object.freeze({ code: 'unsupported_feature', pattern: /本仓不支持/ }),
]);

function classifyPackageError(message: string): string {
  for (const entry of PACKAGE_REASON_TABLE) {
    if (entry.pattern.test(message)) return entry.code;
  }
  return 'package_structure_invalid';
}

/**
 * 检查一份字节是不是**读得动的 .xlsx 包**，并在读不动时给出**准确的分层拒绝**。
 *
 * @throws 任何**非** `ZipReadError` / `ValidationError` 的异常原样向外抛（不吞未知错误）。
 */
export function inspectWorkbookPackage(bytes: Uint8Array): PackageInspection {
  try {
    const archive = readZip(bytes);
    const { workbook, residual } = readWorkbookXlsx(bytes);

    const warnings: string[] = [];
    if (!archive.by_path.has('[Content_Types].xml')) {
      warnings.push('包内缺少 [Content_Types].xml：OPC 要求它存在，本仓仍能读回，但该包不完全合规');
    }

    return Object.freeze({
      status: 'ok' as const,
      part_count: archive.entries.length,
      sheet_names: Object.freeze(workbook.sheets.map((sheet) => sheet.name)),
      residual_part_paths: Object.freeze(residual.parts.map((part) => part.path)),
      warnings: Object.freeze(warnings),
    });
  } catch (error) {
    if (error instanceof ZipReadError) {
      return Object.freeze({
        status: 'rejected' as const,
        layer: 'container' as const,
        code: error.reason,
        detail: error.message,
      });
    }
    if (error instanceof ValidationError) {
      return Object.freeze({
        status: 'rejected' as const,
        layer: 'package' as const,
        code: classifyPackageError(error.message),
        detail: error.message,
      });
    }
    throw error;
  }
}

/** 判定便捷：`status === 'rejected'`。 */
export function isRejected(inspection: PackageInspection): inspection is PackageRejected {
  return inspection.status === 'rejected';
}
