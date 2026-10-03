/**
 * design-05 **WF-089**（PDF 导出）的**排版引擎端口**。
 *
 * ## 为什么要有"端口"
 *
 * WF-089 要求"使用**真实可用排版引擎**"。本机实测（WCF-D06）只有一条真实路线：
 * **Microsoft Word 16.0.20430 的 COM `ExportAsFixedFormat`**（没有 LibreOffice、没有 WPS）。
 * 端口把"引擎"抽出来，好处有两条：
 *
 * 1. **失败可注入**：引擎不可用 / 未授权 / 超时 / 目标不可写是**四种不同的结构化失败**，
 *    可以在**不碰真实 Word** 的日常测试里逐一注入验证（判据要求的正是这个）。
 * 2. **平台边界显式**：真实实现是 **Windows 桌面专属**；目标平台是 **Android**，
 *    二者不等价——端口让"当前有没有可用引擎"变成一个**可回答的事实**，而不是一句假设。
 *
 * ## 失败一律结构化（不许把"没导出"报成成功）
 *
 * {@link PdfEngineFailureKind} 是**封闭枚举**。调用方按 `kind` 分支，
 * **不要**去匹配 `message` 文本。`ok: true` 只表示"引擎自己说导出成功了"——
 * 产物是否真的是 PDF、页数对不对，由 {@link import('./pdf-export.js').exportPdf} 的**读回**判定，
 * 这里**从不**代替读回下结论。
 */

// ---------------------------------------------------------------------------
// 失败分类（封闭枚举）
// ---------------------------------------------------------------------------

/** 引擎侧失败的**机器可判**分类。新增取值必须同步 {@link PDF_ENGINE_FAILURE_KINDS}。 */
export type PdfEngineFailureKind =
  /** 源 DOCX 不存在（还没轮到引擎）。 */
  | 'source_missing'
  /** 引擎本身不可用：没装 pywin32、Word ProgID 未注册、DispatchEx 失败。 */
  | 'engine_unavailable'
  /** 引擎因**授权**拒绝工作（不是"注册表说未授权"，而是引擎真的拒绝了）。 */
  | 'engine_unlicensed'
  /** 引擎在超时内没返回；调用方负责把它变成一次超时失败。 */
  | 'engine_timeout'
  /** 目标目录不存在或不可写（在起引擎**之前**判定）。 */
  | 'target_not_writable'
  /** 其它引擎错误（含 Word 拒开包，如 24601）。 */
  | 'engine_error';

/** 封闭枚举的运行时副本——测试用它断言"每个 kind 都有一条被注入过的用例"。 */
export const PDF_ENGINE_FAILURE_KINDS = [
  'source_missing',
  'engine_unavailable',
  'engine_unlicensed',
  'engine_timeout',
  'target_not_writable',
  'engine_error',
] as const satisfies readonly PdfEngineFailureKind[];

export function isPdfEngineFailureKind(value: string): value is PdfEngineFailureKind {
  return (PDF_ENGINE_FAILURE_KINDS as readonly string[]).includes(value);
}

/** 人可读的中文说明（报告与交付气泡用；判据**不得**依赖它）。 */
export const PDF_ENGINE_FAILURE_MEANINGS: Readonly<Record<PdfEngineFailureKind, string>> = {
  source_missing: '源 DOCX 不存在',
  engine_unavailable: '排版引擎不可用（未安装 / ProgID 未注册 / 依赖缺失）',
  engine_unlicensed: '排版引擎因授权问题拒绝工作',
  engine_timeout: '排版引擎在超时内未返回',
  target_not_writable: '目标目录不存在或不可写',
  engine_error: '排版引擎报错',
};

// ---------------------------------------------------------------------------
// 引擎身份与授权提示
// ---------------------------------------------------------------------------

/**
 * 引擎自报的授权状态。
 *
 * **关键区别（WCF-D06 实测）**：Word 处于「未经授权产品」状态时，COM 自动化**仍然可用**
 * （域刷新 + PDF 导出全成功）。所以"注册表读到 `unlicensed`"是一条**提示**，
 * **不是**导出失败；只有**引擎自己拒绝**时才记 {@link PdfEngineFailureKind} 的 `engine_unlicensed`。
 */
export interface PdfEngineLicense {
  readonly state: 'licensed' | 'unlicensed' | 'unknown';
  readonly evidence: string;
  /** 观察到"未授权但可用"时为 true——**必须**随交付一起如实标出（R156/R158）。 */
  readonly unlicensedButUsableObserved: boolean;
}

/** 引擎身份。`platform`/`route` 是**声明边界**的落点：这条路线只在 Windows 桌面成立。 */
export interface PdfEngineIdentity {
  readonly name: string;
  readonly version: string;
  readonly build: string;
  /** 走的哪条路线，例如 `microsoft-word-com/ExportAsFixedFormat`。 */
  readonly route: string;
  readonly platform: 'windows-desktop';
  readonly license: PdfEngineLicense;
}

// ---------------------------------------------------------------------------
// 请求 / 结果
// ---------------------------------------------------------------------------

export interface PdfEngineRequest {
  readonly sourceDocxPath: string;
  readonly targetPdfPath: string;
  /** 引擎调用超时（毫秒）。调用方负责把它变成 `engine_timeout`。 */
  readonly timeoutMs: number;
}

export interface PdfEngineFailure {
  readonly kind: PdfEngineFailureKind;
  readonly message: string;
  /** 引擎原始诊断（命令原文 / 异常栈 / 报告路径），供报告如实粘贴。 */
  readonly detail?: string;
}

/** 引擎返回的产物事实（**引擎自报**，尚未独立核验）。 */
export interface PdfEngineArtifact {
  readonly path: string;
  readonly byteLength: number;
  readonly magic: string;
  readonly magicOk: boolean;
}

export type PdfEngineOutcome =
  | {
      readonly ok: true;
      readonly identity: PdfEngineIdentity;
      readonly artifact: PdfEngineArtifact;
      readonly durationMs: number;
      /** 引擎报告的原始载荷（JSON 文本），报告里逐字粘贴。 */
      readonly raw: string;
    }
  | {
      readonly ok: false;
      readonly failure: PdfEngineFailure;
      readonly durationMs: number;
      readonly raw: string;
    };

/** 排版引擎端口。真实实现见 {@link import('./word-com-engine.js').createWordComPdfEngine}。 */
export interface PdfEngine {
  /** 探测引擎是否可用；不可用返回 `null`（**不抛异常**——"没有引擎"是正常事实）。 */
  probe(): Promise<PdfEngineIdentity | null>;
  /** 导出。失败一律走 {@link PdfEngineOutcome} 的 `ok: false`，**不抛异常**。 */
  export(request: PdfEngineRequest): Promise<PdfEngineOutcome>;
}

// ---------------------------------------------------------------------------
// 构造失败的小工具（引擎实现与测试共用，保证形状一致）
// ---------------------------------------------------------------------------

export function engineFailure(
  kind: PdfEngineFailureKind,
  message: string,
  detail?: string,
): PdfEngineFailure {
  return detail === undefined ? { kind, message } : { kind, message, detail };
}
