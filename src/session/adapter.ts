/**
 * **交付适配器**：格式相关的唯一接缝（design-06 P8/P9）。
 *
 * ## 为什么把"格式"做成注入而不是 switch
 *
 * 本层的会话生命周期（版本 / 日志 / 幂等 / 发布映射）对三种格式是**同一套**；
 * 不同的只有四件事：**源对象长什么样、怎么导出成字节、怎么改、怎么从字节读回来**。
 * 把这四件事收进一个接口，本层就能对 DOCX / XLSX / PPTX **一视同仁**，
 * 而不是在会话里写 `if (kind === 'spreadsheet')`——那种写法每加一个模板就要改会话，
 * 且"行为差异"会散落在会话的每个分支里（R232 要的正是**分开建模**）。
 *
 * ## 纪律
 *
 * - 适配器是**纯的**：不写盘、不读盘、不读墙钟、不读环境（`src/**` 的机器化断言）；
 * - 适配器**不产生摘要当作真相**：`exportBytes` 给的 `digest` 只是"构建器自己的说法"，
 *   会话层会**独立重算** sha256 并比对，不符即结构化失败（见 `session.ts` 的 ④）；
 * - 适配器**不得**吞掉失败：导出失败必须返回 `{ ok: false }` 而不是抛错，
 *   这样"源零改动 + 结构化原因"能一路传到 HTTP 面。
 */

import type { TemplateKind } from '../protocol/index.js';
import type { FileFormat } from './formats.js';

/** 导出结果（结构化；失败**不抛错**，交给调用方决定 HTTP 状态）。 */
export type AdapterExportResult =
  | {
      readonly ok: true;
      /** 真实容器字节。 */
      readonly bytes: Uint8Array;
      /** ZIP 部件数（进产物记录；由构建器给出，会话层另做结构自检）。 */
      readonly entry_count: number;
      /** 构建器**自己声称**的字节摘要（会话层会独立重算并比对）。 */
      readonly digest: string;
    }
  | { readonly ok: false; readonly kind: string; readonly detail: string };

/** 导入结果（同样结构化）。 */
export type AdapterImportResult<S> =
  | { readonly ok: true; readonly source: S }
  | { readonly ok: false; readonly kind: string; readonly detail: string };

/** 一次编辑的结果。失败时**调用方必须保持源不变**（不返回半成品）。 */
export type AdapterEditResult<S> =
  | {
      readonly ok: true;
      readonly source: S;
      /** 本次是否真的改动了源（false = 幂等空转，不产生新版本）。 */
      readonly changed: boolean;
      /** 人可读的一步回执（进 HTTP 响应，便于页面回显"改了什么"）。 */
      readonly notes: readonly string[];
    }
  | { readonly ok: false; readonly kind: string; readonly detail: string };

/**
 * 一个格式的适配器。
 *
 * @typeParam S 该格式的**源对象**类型（`WorkbookState` / `Presentation` / …）。
 *   必须是 JSON 可往返的纯数据（会话状态要持久化它）。
 */
export interface DeliverableAdapter<S> {
  /** 交付的文件格式（R232 的格式轴）。 */
  readonly format: FileFormat;
  /** 该格式对应的模板种类（R232 的模板轴；与 `format` **分开**声明）。 */
  readonly template_kind: TemplateKind;
  /** 源 → 一行人可读描述（进产物名 / 日志，不进任何判定）。 */
  describe(source: S): string;
  /** 源 → 真实字节（**确定性**：同一源必然同一字节）。 */
  exportBytes(source: S): AdapterExportResult;
  /** 应用一次编辑（**不可变**：返回新源，绝不就地改旧源）。 */
  applyEdit(source: S, edit: unknown): AdapterEditResult<S>;
  /**
   * 从既有字节导入成源（可选）。
   *
   * `undefined` = 该格式暂不支持导入。**不是**"导入永远失败"——产品入口据此
   * 在**收到导入请求时**就明确拒绝，而不是给一个"看起来支持、用起来报错"的入口。
   */
  readonly importBytes?: (bytes: Uint8Array) => AdapterImportResult<S>;
}
