/**
 * potbot 手机 Word Demo —— 共享合同 v1
 *
 * ## 维护归属（2026-10-02 起变更）
 *
 * 本文件原由**主协调者独占维护**。自 **WCF-D07**（design-05-P8 的服务侧）起，
 * `apps/demo/contracts.ts` 归该子包写入，**规则是只增不改**：
 * 既有形状一个字都不动（`apps/demo/web/**`、`apps/demo/model/**`、`tests/demo/**`
 * 都有既有消费者），新能力一律**追加**新类型与新路由常量。
 * 需要修改既有形状时，仍须回报主协调者。
 *
 * 本文件只描述**接口形状与语义**，不含任何实现。
 * 语义要点（与 `docs/other/ds-mobile-word-demo-3h-2026-10-02.md` 一致）：
 *  - `ready` 只证明服务就绪；`modelConfigured` 不等于实调通过，实调通过看 `modelVerified`。
 *  - `ready` 状态必须由**真实文件回读证据**支撑，不能只看内核工作项是 completed。
 *  - 相同 `requestId` + 相同输入返回既有任务，不重复调用模型；同 ID 不同输入返回 409。
 *  - 观察记录不改写内核 `published`，也不把用户自述升格为机器验证。
 *  - **文档会话（编辑链）**：`editRevision` / `taskRevision` / `artifactVersion` 是三个号
 *    （R141），接口把它们**分别**暴露，不合并成一个 `revision`；
 *    `baseRevision` 过期 ⇒ `409 stale_revision` 且回应当前 revision（R143）；
 *    相同 `idempotencyKey` + 相同输入**不产生第二个版本**（R137/R146）。
 *
 * 工程约定（NodeNext + ESM）：apps/demo 内的相对导入必须写 `.js` 扩展名。
 */

/** 合同版本。S1–S6 引用它来确认自己面对的是同一版接口。 */
export const CONTRACT_VERSION = 'demo-v1' as const;

/** Demo 服务默认监听端口（合同固定值；改动须主协调者统一改）。 */
export const DEFAULT_PORT = 8765;

/** 服务启动时的构建标识与运行标识，用于区分「同一份代码的两次启动」。 */
export interface HealthResponse {
  readonly ready: boolean;
  /** 已配置 provider/model —— **不等于**实调通过。 */
  readonly modelConfigured: boolean;
  /** 本轮真机服务进程真实跑通过一次 live 模型调用。 */
  readonly modelVerified: boolean;
  readonly buildId: string;
  readonly bootId: string;
}

/** 应用层任务状态。**注意**：这不是内核工作项状态，二者不要互相冒充。 */
export type TaskStatus =
  | 'accepted'
  | 'running'
  | 'ready'
  | 'failed'
  | 'interrupted'
  | 'unknown';

/** 生成流程所处阶段，仅用于页面显示「现在在哪一步」。 */
export type TaskStage =
  | 'accepted'
  | 'model_pending'
  | 'model_done'
  | 'kernel_pending'
  | 'kernel_done'
  | 'materialized'
  | 'ready'
  | 'failed'
  | 'interrupted';

/** 结构化草稿。段落 id 由宿主规范化，正文按**纯文本**渲染（禁止模型 HTML 执行）。 */
export interface DraftParagraph {
  readonly id: string;
  readonly text: string;
}

export interface Draft {
  readonly title: string;
  readonly paragraphs: readonly DraftParagraph[];
  /** 恒为 `model_generated`：不得把模型草稿标成用户已确认事实。 */
  readonly provenance: 'model_generated';
}

/** 可下载产物引用。服务端按 artifactId 查映射，**不接收任意磁盘路径**。 */
export interface ArtifactRef {
  readonly artifactId: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly downloadPath: string;
  readonly taskRevision: number;
  readonly artifactVersion: number;
}

/** 稳定错误：code 机器可判、message 面向用户（中文）、retryable 是否可重试。不得暴露密钥。 */
export interface DemoError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

/** `POST /api/documents` 请求体。requestId 由客户端生成，**刷新后保留**。 */
export interface CreateDocumentRequest {
  readonly requestId: string;
  readonly instruction: string;
}

/** `POST /api/documents` 成功响应（HTTP 202）。 */
export interface CreateDocumentResponse {
  readonly requestId: string;
  readonly taskId: string;
  readonly status: TaskStatus;
}

/** `GET /api/tasks/:taskId` 响应。 */
export interface TaskResponse {
  readonly requestId: string;
  readonly taskId: string;
  readonly status: TaskStatus;
  readonly stage: TaskStage;
  readonly draft?: Draft;
  readonly artifact?: ArtifactRef;
  readonly error?: DemoError;
}

/** 观察类型：只记录观察，不驱动内核，也不等于机器验证。 */
export type ObservationKind =
  | 'download_verified'
  | 'handoff_requested'
  | 'user_reported_opened';

/** `POST /api/artifacts/:artifactId/observations` 请求体。 */
export interface ObservationRequest {
  readonly observationId: string;
  readonly kind: ObservationKind;
  readonly detail: string;
}

export interface ObservationResponse {
  readonly observationId: string;
  readonly recorded: boolean;
}

/** 合同固定上限。超出即结构化拒绝，不得静默截断。 */
export const LIMITS = {
  /** 草稿段落数下限（含）。 */
  minParagraphs: 2,
  /** 草稿段落数上限（含）。 */
  maxParagraphs: 4,
  /** 草稿正文总字数上限（含）。 */
  maxDraftChars: 2000,
  /** 用户请求文本字数上限（含）。 */
  maxInstructionChars: 4000,
} as const;

/** HTTP 路径常量，避免各方各写各的字面量。 */
export const ROUTES = {
  health: '/health',
  documents: '/api/documents',
  task: (taskId: string) => `/api/tasks/${encodeURIComponent(taskId)}`,
  download: (artifactId: string) => `/api/artifacts/${encodeURIComponent(artifactId)}/download`,
  observations: (artifactId: string) => `/api/artifacts/${encodeURIComponent(artifactId)}/observations`,
  // --- 文档会话（编辑 / 导入 / 保存链；WCF-D07） ---------------------------
  sessions: '/api/sessions',
  session: (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}`,
  sessionEdits: (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}/edits`,
  sessionVersion: (sessionId: string, editRevision: number) =>
    `/api/sessions/${encodeURIComponent(sessionId)}/versions/${String(editRevision)}/download`,
} as const;

/** DOCX MIME，S1/S2/S5 共用同一字面量。 */
export const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document' as const;

// ---------------------------------------------------------------------------
// 文档会话（编辑链）—— WCF-D07 / design-05-P8；合同 §G
// ---------------------------------------------------------------------------

/**
 * 会话的起始包如何解释。
 *
 * - `new`：新建（客户端给一份空白/起始 DOCX；来源记为 `user_request`）；
 * - `import`：导入既有文件（来源记为 `imported`，**不等于**用户已确认事实，R148）。
 */
export type SessionMode = 'new' | 'import';

/** `POST /api/sessions` 请求体。 */
export interface CreateSessionRequest {
  readonly sessionId: string;
  readonly filename: string;
  readonly mode: SessionMode;
  /**
   * 起始包字节（**base64**）。
   *
   * 为什么是 base64 而不是裸字节：本服务的其它接口统一是 JSON，混一种二进制体
   * 会让错误处理分叉（体超限时你分不清是 JSON 语法错还是二进制截断）。
   * 代价是体积膨胀 4/3，因此上传上限单独设（见 {@link SESSION_LIMITS}）。
   */
  readonly docxBase64: string;
}

/** `POST /api/sessions` 成功响应（HTTP 201）。 */
export interface CreateSessionResponse {
  readonly sessionId: string;
  readonly documentId: string;
  readonly filename: string;
  /** 会话对应的**内核任务** id（发布链的产品记录挂在它下面；证据链的入口）。 */
  readonly kernelTaskId: string;
  readonly editRevision: number;
  readonly contentDigest: string;
}

/**
 * 一条**版本映射**（R141）：把三个号放在一行里，且每个号都能单独读出来。
 *
 * 只在一次**成功发布**之后才有这一行——"计划算出来了"或"字节导出了"都不产生它。
 */
export interface SessionVersionEntry {
  /** 号 ①：编辑版本（一次成功的事务 +1）。 */
  readonly editRevision: number;
  /** 号 ②：发布时的内核任务版本（由内核自己的 patch 语义递增）。 */
  readonly taskRevision: number;
  /** 号 ③：同任务同模板种类下的第几版（内核派生）。 */
  readonly artifactVersion: number;
  readonly artifactId: string;
  /** **回读**摘要（来自对最终路径的实际回读，I-1）。 */
  readonly contentDigest: string;
  readonly byteLength: number;
  readonly publishedAt: string;
}

/** 操作日志一条（R139）。 */
export interface SessionLogEntry {
  readonly seq: number;
  readonly kind: string;
  readonly baseRevision: number;
  readonly resultRevision: number;
  readonly at: string;
  readonly idempotencyKey: string | null;
  readonly ranges: readonly string[];
  readonly hitCounts: readonly number[];
  readonly changed: boolean;
  readonly rejection: { readonly code: string; readonly message: string } | null;
}

/** `GET /api/sessions/:sessionId` 响应。 */
export interface SessionResponse {
  readonly sessionId: string;
  readonly documentId: string;
  readonly filename: string;
  readonly editRevision: number;
  readonly contentDigest: string;
  readonly sourceKind: string;
  readonly sourceDigest: string | null;
  readonly versions: readonly SessionVersionEntry[];
  readonly currentVersion: SessionVersionEntry | null;
  readonly lastFailure: {
    readonly editRevision: number;
    readonly kind: string;
    readonly detail: string;
    readonly at: string;
  } | null;
  readonly log: readonly SessionLogEntry[];
}

/** `POST /api/sessions/:sessionId/edits` 请求体。 */
export interface SubmitEditRequest {
  /** 调用方生成；重试**必须复用同一个键**（R146）。 */
  readonly idempotencyKey: string;
  /** 本操作基于的编辑版本（R103/R143）。 */
  readonly baseRevision: number;
  /** 本操作基于的内容摘要（R142：与 revision 一起绑定）。 */
  readonly baseDigest: string;
  /** 结构化编辑意图（受限形状；不接受的种类在**操作前**被拒，R140）。 */
  readonly intent: unknown;
}

/** 一步的执行回执。 */
export interface EditStepReport {
  readonly range: string;
  readonly domain: string;
  readonly hitCount: number;
  readonly changed: boolean;
  readonly toggleTarget?: 'on' | 'off' | null;
}

/** `POST /api/sessions/:sessionId/edits` 成功响应（HTTP 200）。 */
export interface SubmitEditResponse {
  readonly sessionId: string;
  /** 命中幂等键：**没有**产生第二个版本，回执是第一次的。 */
  readonly replayed: boolean;
  /** 计划合法但没有任何一步真正改动文档 ⇒ 不产生新版本。 */
  readonly noOp: boolean;
  readonly editRevision: number;
  readonly steps: readonly EditStepReport[];
  readonly version: SessionVersionEntry | null;
}

/**
 * 编辑提交被拒时的错误体。
 *
 * 在 {@link DemoError} 之上补上**机器可判**的版本信息——R143 要求 stale 拒绝必须
 * 携带"当前 revision 供上层重试或提示"，只给一句中文提示是不够的。
 */
export interface EditErrorResponse extends DemoError {
  /** 服务端当前的编辑版本（任何拒绝都有这个值；调用方据此重取文档再提交）。 */
  readonly currentRevision: number;
  /** 请求里携带的版本（缺省时为 `null`）。 */
  readonly requestedRevision: number | null;
  /** 基线不符的**具体原因**：版本号对不上，还是内容摘要对不上。 */
  readonly reason: 'revision' | 'digest' | null;
}

/**
 * 会话相关接口的固定上限。超出即结构化拒绝，**不静默截断**（R164 的纪律）。
 *
 * 与旧 `LIMITS` 的关系：那套 2–4 段 / 2000 字的上限属于**"按短文生成"**那条链；
 * 编辑链不继承它（用户的文档不是短文）。这里的上限是**工程上限**（内存与传输），
 * 不是产品语义上限——达不到具体规模时如实报边界，不隐藏截断（R163/R164）。
 */
export const SESSION_LIMITS = {
  /** 会话起始包上限（含 base64 包装后的字节数）。 */
  maxUploadBytes: 16 * 1024 * 1024,
  /** `sessionId` / `idempotencyKey` 的合法形态长度上限。 */
  maxIdentifierChars: 128,
  /** 单次编辑意图的步骤数上限（复合指令仍是一次事务，但不得无界）。 */
  maxStepsPerIntent: 64,
  /** 操作日志在一次响应里最多返回多少条（最新的在前）。 */
  maxLogEntriesInResponse: 50,
} as const;
