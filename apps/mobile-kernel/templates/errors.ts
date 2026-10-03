/**
 * K06 模板 manifest 生命周期 —— **错误类型与拒因词表**（零依赖）。
 *
 * ## 为什么四态必须"分别报告"，而"合并成一个布尔"要被**拒**
 *
 * `contracts/mobile-v1/schemas/template-manifest.schema.json` 的根对象与 `probe`
 * 子对象都写了 `additionalProperties: false`，并且 probe 的 `required` 明确列出
 * `installed / enabled / authorized / portReady` **四个独立布尔**。契约作者在 description
 * 里写死了理由：**四态不得合并成一个布尔**。
 *
 * 本模块把这条纪律从"schema 层拒绝"延伸到"运行期拒绝"：
 *  - 校验方向：`assertManifest()` 用 `additionalProperties=false` 拒掉根对象上的 `ready`
 *    以及 probe 子对象上的额外合并字段（`manifest_invalid`）；
 *  - 报告方向：`assertSeparateReadinessStates()` 拒绝任何"把四态压成单布尔"的就绪报告
 *    （`merged_readiness_forbidden`）——包括 `installed: true`（布尔而非状态对象）。
 *
 * ## 为什么探针失败必须是**显式未就绪 + 原因**，而不是 `false`
 *
 * manifest 里的 `probe` 字段是模板**自称**的状态。自称不是证据：安装成功、端口打通、
 * 权限授予都必须由**宿主侧真实探针**读回。任何一处探针失败，对应态就报 `not-ready`
 * 并带上可机读原因；合并成单布尔会把"哪个环节没通过"这一信息永久丢掉。
 *
 * 本文件只放词表与错误类型；校验在 `manifest.ts`，状态机在 `lifecycle.ts`。
 */

/** 模板生命周期链路上**全部**可机读拒因。新增拒因必须同时在此登记（测试逐条对照）。 */
export const TEMPLATE_ERROR_CODES = [
  // --- manifest 校验 ---
  /** manifest 不满足契约：缺字段 / 类型不符 / 多余字段（含被禁止的合并就绪态字段）。 */
  'manifest_invalid',
  /** 就绪报告把四态合并成了单布尔（`installed/enabled/authorized/portReady` 必须各自独立）。 */
  'merged_readiness_forbidden',

  // --- 安装与运行时兼容 ---
  /** 该模板 id 从未安装过（不能对没装的东西报就绪）。 */
  'template_not_installed',
  /** 该模板的**这个版本**不存在（或已被彻底卸载）。 */
  'version_not_installed',
  /** 同一个 `id@version` 已安装且未卸载：不得重复安装（版本是身份的一部分，不静默覆盖）。 */
  'template_already_installed',
  /** manifest 声明的运行时/os/ABI 与宿主不符（带 `field` 指认是哪一项）。 */
  'runtime_incompatible',

  // --- 权限 ---
  /** 请求授予的权限里有 manifest **没有声明**的项（不得凭空扩权）。 */
  'permission_not_declared',

  // --- 升级 / 回滚 ---
  /** 迁移链对不上：`migration.from` 必须等于当前在用的版本、`migration.to` 必须等于新版本。 */
  'migration_chain_mismatch',
  /** `migration.reversible === false`（或策略不允许）：不得回滚。 */
  'migration_not_reversible',
  /** `strategy: 'manual'` 需要调用方显式确认，否则拒绝自动升级。 */
  'migration_manual_confirmation_required',

  // --- 任务冻结 ---
  /** 该任务没有冻结任何模板版本（`resolve()` 时查不到）。 */
  'pin_not_found',
  /** 该任务已经钉住了一个版本：改钉必须先 `release`，不得静默换版本。 */
  'task_already_pinned',
] as const;

export type TemplateErrorCode = (typeof TEMPLATE_ERROR_CODES)[number];

/**
 * 出错的**可逐项核对字段**：运行时兼容用 `os/minimumOs/runtimes/abis`，
 * 迁移链用 `migration.from` / `migration.to`，权限用 `permissions`。
 */
export type TemplateErrorField =
  | 'os'
  | 'minimumOs'
  | 'runtimes'
  | 'abis'
  | 'migration.from'
  | 'migration.to'
  | 'permissions'
  | null;

/** K06 链路唯一的错误类型。所有拒绝都抛它，验收按 `code` / `field` 断言。 */
export class TemplateError extends Error {
  readonly code: TemplateErrorCode;

  /** 逐项核对失败时指出是**哪一项**（非此类错误为 null）。 */
  readonly field: TemplateErrorField;

  constructor(code: TemplateErrorCode, detail: string, field: TemplateErrorField = null) {
    super(`[${code}]${field === null ? '' : `[${field}]`} ${detail}`);
    this.name = 'TemplateError';
    this.code = code;
    this.field = field;
  }
}

/** 便于测试与调用方识别的类型守卫（跨模块 `instanceof` 在打包后可能失效，故同时看 `code`）。 */
export function isTemplateError(value: unknown): value is TemplateError {
  return (
    value instanceof TemplateError ||
    (typeof value === 'object' &&
      value !== null &&
      'code' in value &&
      typeof (value as { code: unknown }).code === 'string' &&
      (TEMPLATE_ERROR_CODES as readonly string[]).includes((value as { code: string }).code))
  );
}
