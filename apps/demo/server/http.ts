/**
 * 应用宿主：**HTTP 层**（共享合同 v1；S3 独占写入范围）。
 *
 * 只用 Node 自带的 `node:http` / `node:fs`（不引入新依赖），严格按 `contracts.ts`
 * 的路由与形状实现：
 *
 * | 路由 | 语义 |
 * |---|---|
 * | `GET /health` | `{ready, modelConfigured, modelVerified, buildId, bootId}` |
 * | `POST /api/documents` | 202 + `{requestId, taskId, status}`；同 ID 同输入回既有、同 ID 不同输入 409 |
 * | `GET /api/tasks/:taskId` | 应用状态（`ready` 必须由真实文件回读证据支撑） |
 * | `GET /api/artifacts/:artifactId/download` | DOCX 字节，准确 MIME / Content-Disposition；**每次重新核对摘要** |
 * | `POST /api/artifacts/:artifactId/observations` | 只记录观察，不改写内核 `published` |
 * | 其余 GET | `apps/demo/web/` 静态页（同源；防路径穿越） |
 *
 * 错误响应体一律是 `DemoError`：稳定 code + 中文说明 + retryable。**不暴露密钥**
 * （错误文本只取端口给的 message，端口契约本身就要求脱敏）。
 *
 * 本文件**不碰内核**：所有业务判定都在 `KernelHost` 里，这里只做路由、编解码与状态码。
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  DOCX_MIME,
  ROUTES,
  SESSION_LIMITS,
  type CreateDocumentRequest,
  type DemoError,
  type EditErrorResponse,
  type ObservationRequest,
} from '../contracts.js';
import type { KernelHost } from './kernel.js';
import type { DocumentSessionHost } from './session-host.js';
import type { DeliverableHost } from './deliverable-host.js';
import { taskCompletionOf, type TaskCompletionView } from './task-completion.js';
import type { ConversationHost, CandidateIdentity } from './conversation-host.js';
// 会话搜索的分页边界：**同一份常量**（宿主与路由两层用的是同一个上限，不会各写各的）。
import { CONVERSATION_SEARCH_LIMITS } from './conversation-host.js';
// FA-X 的适配器产品入口（时钟 / 日历 / 美团）。**独立路由模块**：这里只按前缀转交，
// 不改动本文件既有的任何路由分支，避免与同波次其它包冲突。
import type { AdaptersHost } from './adapters-host.js';
// FA-WIRE-PRODUCT-ROUTES：记忆 / 模板平台 / 连续对话闭环三组独立路由模块的产品挂载。
// 同样**只按前缀转交**（在 `/api/**` 兜底 404 之前），不改动本文件既有的任何路由分支。
import { createMemoryRouteHost, handleMemoryRequest, type MemoryRouteHost } from './memory-routes.js';
// FA-TRACE-FACT-VERSIONS：事实版本轨迹的产品读口（`/api/memory/facts/:key/versions`）。
// 同样**只按前缀转交**，紧跟记忆路由之后；`matchMemoryRoute` 对本路径返回 `null`（前缀不重叠），
// 因此不改变任何既有分支，也不落入 `/api/**` 的 404。
import { handleFactVersionsRequest } from './trace-fact-versions.js';
import { handlePluginRequest, type PluginRoutesOptions } from './plugin-routes.js';
import { createConversationLoopRoutes, type ConversationLoopRoutes } from './route-wiring.js';
import { createDocumentsRouteHost, handleDocumentsRequest, type DocumentsRouteHost } from './documents-routes.js';
import { handleResearchRequest, type ResearchRoutesOptions } from './research-routes.js';
// FA-PPT-FACTS-PRODUCT2：PPT 同版事实交付的产品入口（`/api/ppt-facts/**`）。
// **纯函数路由**（无端口、无落盘），因此没有"宿主未装配"这一未就绪形态——只按前缀转交。
import { handlePptxFactsRequest } from './ppt-facts-product.js';
// FA-PPT-MEDIA-MOUNT：PPT 媒体 / 形状 / 表格 / 图表 / 音视频的产品入口（`/api/ppt-media/**`）。
// **挂载 ppt-media-product 的未挂载交接**：同一个 `ppt-facts-product.ts` 契约形状，纯函数路由
// （**零端口、零落盘、零网络**，每个请求自带全部输入）。因此它没有"端口缺席 ⇒ 未就绪"这一分支：
// 不注入任何宿主时它照样结构化作答（**不是** 404、**不是**假装可用）。只按前缀转交。
import { handlePptxMediaRequest } from './ppt-media-harness.js';
// FA-KRN-TOOL-LOOP-PRODUCT：KRN-04 工具循环的产品入口（`/api/tool-loop/**`）。
// 同一条纪律：独立路由模块，本文件只按前缀转交，不改动既有任何路由分支。
import { handleToolLoopRequest, type ToolLoopHost } from './tool-loop-product.js';
import type { createRolesWiring } from './roles-wiring.js';
// FA-XLS-FACTS-PRODUCT：共享事实 → 表格 → 跨模板发布 的产品交付链入口（`/api/xls-facts/**`）。
// **只按前缀转交**（放在 `/api/**` 兜底 404 之前），不改动本文件既有的任何路由分支。
import { createXlsFactsHost, handleXlsFactsRequest, type XlsFactsHost } from './xls-facts-product.js';
// FA-XLS-FORMULA-REPORT：**导出侧公式求值报告**的产品 HTTP 出口（`/api/xls-formula/**`）。
// 读的是交付会话某一版的**盘上真实字节**（与 `/api/deliverables/**` 同一份来源、同一份摘要校验），
// 把 `writeWorkbookXlsx().evaluations` 的逐格结论 + 阻塞原因接上产品面。**只按前缀转交**
// （放在 `/api/**` 兜底 404 之前），不改动本文件既有的任何路由分支。
import {
  createXlsFormulaReportHost,
  handleXlsFormulaReportRequest,
  type XlsFormulaReportHost,
  type XlsFormulaReportSource,
} from './xls-formula-report.js';
// FA-FIX-TAUTOLOGY：会话包适配器（时钟 / 日历 + 检索呈现）+ 预算闸门 + 检查点归约的
// 产品入口（`/api/session-adapters/**`）。**只按前缀转交**（放在 `/api/**` 兜底 404 之前），
// 不改动本文件既有的任何路由分支。
import { createSessionAdaptersWiring, type SessionAdaptersWiring } from './session-adapters-wiring.js';
// FA-FACTS-HTTP-ROUTE：共享事实的产品 HTTP 路由（`/api/facts/**`）。
// **只按前缀转交**（放在 `/api/**` 兜底 404 之前），不改动本文件既有的任何路由分支；
// 宿主就是内核真相源本身（`host.store`），**不另建第二份事实源**。
import { handleFactsRequest, type FactsRouteHost } from './facts-routes.js';
// FA-KRN-BARREL-CONSUME：`src/scheduler` 桶模块的产品侧真调用（`/api/krn-barrel/**`）。
// 同一纪律：独立路由模块，本文件**只按前缀转交**，不改动既有任何路由分支。
import { createKrnBarrelWiring, type KrnBarrelWiring } from './krn-barrel.js';
// FA-XLS-PRINT-ROUTE：XLSX 打印设置的产品入口（`/api/xls-print/**`，补 `fa/prod-depth-c`
// 实测的"产品 HTTP 无打印通道"缺口）。**只按前缀转交**（放在 `/api/**` 兜底 404 之前），
// 不改动本文件既有任何路由分支；宿主缺席时用一个"无物化端口"的降级替身作答（结构化失败），
// **不是** 404、**不是**假装可用。
import { createXlsPrintHost, handleXlsPrintRequest, type XlsPrintHost } from './xls-print-route.js';
// FA-KRN-ORPHANS：处置 `src/scheduler` 里 7 个孤儿模块（`/api/krn-orphans/**`）。
// **只做加法**：独立路由模块 + 一个可选选项 + 一次前缀转交，不改动既有任何路由分支。
import { createKrnOrphansWiring, type KrnOrphansWiring } from './krn-orphans.js';
// FA-XLS-STRUCTURE-PRODUCT：XLSX **结构操作**（增删行列 / 宽高 / 隐藏 / 自动调整 / 冻结 / 合并拆分 /
// 复制 / 移动）的产品入口（`/api/xls-structure/**`，补 `fa/prod-depth-h` 实测的"封闭枚举无结构通道"
// 缺口）。**纯函数路由**（零端口、零落盘，每个请求自带工作簿规格或导入字节），因此没有"端口缺席 ⇒
// 未就绪"这一分支。**只按前缀转交**（放在 `/api/**` 兜底 404 之前），不改动本文件既有任何路由分支。
import { handleXlsStructureRequest } from './xls-structure-product.js';
import { CONVERSATION_LIMITS, isSafeIdentifier } from './conversation-store.js';
import type { PublishedVersion, SessionFailureDetail } from '../../../src/documents/session/index.js';

/** 会话包里的版本映射行（本模块只在路由里读它的字段，不构造）。 */
type SessionVersionView = PublishedVersion;

/** 请求体上限（写作要求最多 4000 字，留足 JSON 包装余量）。 */
const MAX_BODY_BYTES = 64 * 1024;

const STATIC_CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
});

export interface DemoHttpOptions {
  readonly host: KernelHost;
  /** 静态页面目录（S2 的产物；本模块只读）。 */
  readonly webDir: string;
  /**
   * 文档会话宿主（编辑 / 导入 / 保存链）。
   *
   * **省略或为 `null` 时，会话路由如实返回 503**——不假装可用，也不退回"直接写文件"
   * 那种看似能跑、实则没有交付证据的实现。
   */
  readonly sessions?: DocumentSessionHost | null;
  /**
   * 连续对话宿主（FA-N；合同 R207–R209 / H2）。
   *
   * **省略或为 `null` 时会话路由如实返回 503**——不假装可用，也不把旧的一次性生成接口
   * 接进来冒充连续对话（H2 明文不通过那种做法）。
   */
  readonly conversations?: ConversationHost | null;
  /**
   * 交付会话宿主（design-06 P8/P9：表格与演示的产品入口）。
   *
   * **省略或为 `null` 时，交付路由如实返回 503**——不假装可用，也不退回"直接写文件"。
   * 与 `sessions`（字处理编辑链）**并存**：两条链共用同一套内核发布投影，
   * 但各自服务不同的编辑语义（见 `deliverable-host.ts` 头部）。
   */
  readonly deliverables?: DeliverableHost | null;
  /**
   * R219：**实际生效**的候选身份（端口 / 运行目录 / 运行 id / 构建 id）。
   *
   * 存在的理由是一条具体的坑：`POTBOT_PORT` / `POTBOT_RUN_DIR` 改了**不会**自动改变
   * 验收侧读取的地址与 runId。宿主把自己的身份**报出来**，验证者才能核对
   * "我连的是不是同一个候选"，而不是靠约定猜。
   */
  readonly identity?: (() => CandidateIdentity | null) | null;
  /**
   * 适配器产品入口（FA-X；时钟 / 日历 / 美团，`/api/adapters/**`）。
   *
   * **省略或为 `null` 时**这些路由不注册：请求落到既有的 `/api/**` 404 分支——
   * 如实"没有这个接口"，而不是假装有。
   */
  readonly adapters?: AdaptersHost | null;
  /**
   * 记忆管理入口（FA-WIRE-PRODUCT-ROUTES；`/api/memory/**`）。
   *
   * **省略或为 `null` 时**该前缀仍会被处理：`handleMemoryRequest` 用一个"无持久端口"的
   * 宿主作答——数据接口结构化 503（**不**退回进程内存冒充持久，R220），**不是** 404、
   * **不是**假装可用。
   */
  readonly memoryRoutes?: MemoryRouteHost | null;
  /**
   * 模板平台入口（FA-WIRE-PRODUCT-ROUTES；`/api/plugins/**`）。
   *
   * **省略时为 `{}`**：未注入 `store` ⇒ 整个前缀结构化 503 `plugin_store_unwired`
   * （不退回内存冒充持久）。产品路径由 `main.ts` 注入文件落盘的 `InstallStateStore`。
   */
  readonly pluginRoutes?: PluginRoutesOptions | null;
  /**
   * 连续对话闭环入口（FA-WIRE-PRODUCT-ROUTES；`/api/conversation-loop/**`）。
   *
   * **省略或为 `null` 时**该前缀仍会被处理：返回结构化 503 `loop_not_ready`
   * （目录端口未装配），**不是** 404。产品路径由 `main.ts` 注入读内核 store 的目录端口。
   */
  readonly conversationLoop?: ConversationLoopRoutes | null;
  /** 文档工作流路由宿主（FA-WIRE-DOCUMENTS-REACH）。省略 => 受管路由一律结构化 503。 */
  readonly documentsRoutes?: DocumentsRouteHost | null;
  /** 资料检索路由选项（FA-WIRE-RESEARCH-REACH）。省略 => 各段结构化未就绪。 */
  readonly researchRoutes?: ResearchRoutesOptions | null;
  /** 三种基础角色接线（FA-WIRE-ROLES-REACH）。省略 => /api/roles/** 落 404。 */
  readonly rolesWiring?: ReturnType<typeof createRolesWiring> | null;
  /**
   * 共享事实绑定的表格交付入口（FA-XLS-FACTS-PRODUCT；`/api/xls-facts/**`）。
   *
   * **省略或为 `null` 时**仍会被处理：`handleXlsFactsRequest` 用一个"无发布通道"的宿主
   * 作答（发布段结构化 `not-wired`，`claimed_published` 恒 false），**不是** 404、
   * **不是**假装可用。产品路径由 `main.ts` 注入宿主（同样不注入任何通道）。
   */
  readonly xlsFacts?: XlsFactsHost | null;
  /**
   * 工具循环产品入口（FA-KRN-TOOL-LOOP-PRODUCT；`/api/tool-loop/**`）。
   *
   * **省略或为 `null` 时**该前缀仍会被处理：用一个"无端口"宿主作答
   * （`/status` 如实 `ready:false`、`/run` 结构化 503 `not_ready`、`/parse` 照常可用），
   * **不是** 404、**不是**假装可用。产品路径由 `main.ts` 注入真实模型端口与真实工具执行器。
   */
  readonly toolLoop?: ToolLoopHost | null;
  /**
   * 会话适配器入口（FA-FIX-TAUTOLOGY；`/api/session-adapters/**`）。
   *
   * 承载三件事的产品调用点：`src/session` 的时钟 / 日历与检索呈现两个适配器（N-5-4）、
   * 预算闸门 `ProductBudgetWiring`（N-5-5）、检查点归约（N-5-6）。
   *
   * **省略或为 `null` 时**该前缀仍会被处理：用一个"未注入内核 store / 未装配预算"的降级
   * 替身作答——检查点段与预算段各自结构化 503（**不是** 404、**不是**假装可用）。
   * 产品路径由 `main.ts` 注入真实运行目录 + `host.store` + 预算接线。
   */
  readonly sessionAdapters?: SessionAdaptersWiring | null;
  /**
   * `src/scheduler` 桶模块的产品入口（FA-KRN-BARREL-CONSUME；`/api/krn-barrel/**`）。
   *
   * 承载必录审计、重启高水位、预算已提交事实、在途轮次、收件箱去重、授权/撤权/权限闸门、
   * 协作终止判定与迟到结果发布决定。
   *
   * **省略或为 `null` 时**该前缀仍会被处理：用一个"未注入内核 store"的降级替身作答——
   * 三个读端点结构化 503（**不是** 404、**不是**假装"没有记录就是干净"），写端点照常可用。
   * 产品路径由 `main.ts` 注入 `host.store`。
   */
  readonly krnBarrel?: KrnBarrelWiring | null;
  /**
   * XLSX 打印设置的产品入口（FA-XLS-PRINT-ROUTE；`/api/xls-print/**`）。
   *
   * **省略或为 `null` 时**该前缀仍会被处理：用一个"无物化端口"的降级替身作答
   * （会话发布结构化失败，一次性导出 / 交接 / 拒绝已打印照常可用），**不是** 404、
   * **不是**假装可用。产品路径由 `main.ts` 注入**同一个** `DocumentPort` 的宿主。
   */
  readonly xlsPrint?: XlsPrintHost | null;
  /**
   * 孤儿模块处置入口（FA-KRN-ORPHANS；`/api/krn-orphans/**`）。
   *
   * 承载能力清单 / 按需组装上下文 / 产物版本提交闸门 / 进展监督 / 持久工作队列 / 后台工作循环。
   *
   * **省略或为 `null` 时**该前缀仍会被处理：用一个"未注入 store / 未注入注册表"的降级替身作答
   * ——依赖真实状态的段一律结构化 503（**不是** 404、**不是**假装"没有记录就是干净"）。
   */
  readonly krnOrphans?: KrnOrphansWiring | null;
}

function errorBody(code: string, message: string, retryable: boolean): DemoError {
  return Object.freeze({ code, message, retryable });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, error: DemoError): void {
  sendJson(res, status, error);
}

/**
 * 超限后**允许继续丢弃**的字节上限。
 *
 * 为什么要排空而不是直接拒绝：不排空就在还有未读字节时写响应，Node 会 RST 掉套接字，
 * **客户端看不到那 413，只看到 ECONNRESET**（WCF-D63 实测：>1 MiB 的越界请求全是这个现象）。
 * 但排空本身不能无上限（否则一个恶意的大 body 就能拖住连接），所以设一个上限：
 * 超过它就主动销毁套接字——**宁可断开，也不无限读**。
 */
const DRAIN_CAP_BYTES = 32 * 1024 * 1024;

/**
 * 丢弃请求里剩余的数据（有界），让随后写出的错误响应**有机会送达客户端**。
 *
 * 客户端中途断开是正常情形（我们本来就在拒绝它），吞掉异常即可。
 */
async function drainRequest(req: IncomingMessage): Promise<void> {
  let drained = 0;
  try {
    for await (const chunk of req) {
      drained += Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(String(chunk));
      if (drained > DRAIN_CAP_BYTES) {
        req.destroy();
        return;
      }
    }
  } catch {
    // 对端提前关闭：不影响我们要给出的拒绝结果。
  }
}

/** 读取请求体（带大小上限；超限直接拒绝，不静默截断）。 */
async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) {
      await drainRequest(req);
      return null;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 提取 `/api/tasks/<id>` 之类的路径参数（已解码；`null` = 形状不符）。 */
function pathParam(pathname: string, prefix: string, suffix = ''): string | null {
  if (!pathname.startsWith(prefix)) {
    return null;
  }
  const rest = pathname.slice(prefix.length);
  const value = suffix.length === 0 ? rest : rest.endsWith(suffix) ? rest.slice(0, -suffix.length) : null;
  if (value === null || value.length === 0 || value.includes('/')) {
    return null;
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 静态文件服务（同源）。
 *
 * 防穿越：解析后的绝对路径必须落在 `webDir` 之内；含 `..` 段或指向目录外一律 404。
 * 只允许 `GET` / `HEAD`；不列目录。
 */
function serveStatic(webDir: string, pathname: string, req: IncomingMessage, res: ServerResponse): void {
  let relative: string;
  try {
    relative = decodeURIComponent(pathname);
  } catch {
    sendError(res, 400, errorBody('bad_path_encoding', 'URL 路径编码不合法', false));
    return;
  }
  if (relative === '/' || relative.length === 0) {
    relative = '/index.html';
  }
  const normalized = normalize(relative).split('\\').join('/');
  if (normalized.split('/').includes('..')) {
    sendError(res, 404, errorBody('not_found', '没有这个路径', false));
    return;
  }
  const webRoot = resolve(webDir);
  const target = resolve(join(webRoot, `.${normalized}`));
  if (target !== webRoot && !target.startsWith(webRoot + sep)) {
    sendError(res, 404, errorBody('not_found', '没有这个路径', false));
    return;
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    sendError(res, 404, errorBody('not_found', '没有这个文件', false));
    return;
  }

  const contentType = STATIC_CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream';
  const size = statSync(target).size;
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': size,
    'cache-control': 'no-store',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(target).pipe(res);
}

/** 会话上传体的上限（base64 包装后；见 `SESSION_LIMITS.maxUploadBytes` 的纪律）。 */
const MAX_SESSION_BODY_BYTES = SESSION_LIMITS.maxUploadBytes;

/** 会话接口不可用时的统一回复（宿主未接入 ⇒ 503；**不退化**成"直接写文件"）。 */
function sessionsUnavailable(): DemoError {
  return errorBody(
    'sessions_unavailable',
    '文档会话能力未接入：本进程没有可用的物化端口，无法产出可交付文件（不伪造成功）',
    false,
  );
}

/** 交付会话不可用时的错误体（与 `sessionsUnavailable` 同一口径，不伪造成功）。 */
function deliverablesUnavailable(): DemoError {
  return errorBody(
    'deliverables_unavailable',
    '交付会话能力未接入：本进程没有可用的物化端口，无法产出可交付文件（不伪造成功）',
    false,
  );
}

/**
 * 交付会话失败 → 错误体。
 *
 * 复用会话链的码表与状态映射（`sessionStatusOf` / `textErrorOf`）：两条链的失败码
 * **本就是同一套**（`stale_revision` 只有一个含义），再开一张表只会让两边慢慢分叉。
 * `extra` 只挑**标量**转发，避免把结构体塞进错误体而让客户端要去解析形状。
 */
function deliverableErrorOf(outcome: {
  readonly code: string;
  readonly message: string;
  readonly detail: { readonly extra: Readonly<Record<string, unknown>> };
}): EditErrorResponse {
  const extra: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(outcome.detail.extra)) {
    if (typeof value === 'string' || typeof value === 'number') extra[key] = value;
  }
  const currentRevision = outcome.detail.extra['current_revision'];
  return textErrorOf(outcome.code, outcome.message, {
    ...(typeof currentRevision === 'number' ? { currentRevision } : {}),
    extra,
  });
}

/**
 * 交付会话的版本映射行（**带格式字段**）。
 *
 * 为什么不复用字处理链的 `toVersionEntry`：表格/演示的"结果可核对"必须能**只凭这一行**
 * 回答"这一版交付的是什么格式"（R232），因此这里多带 `fileFormat` / `mimeType` /
 * `templateKind`。字处理链的响应形状**保持不变**（既有证据面不动）。
 */
function toDeliverableVersionEntry(version: {
  readonly edit_revision: number;
  readonly task_revision: number;
  readonly artifact_version: number;
  readonly artifact_id: string;
  readonly content_digest: string;
  readonly byte_length: number;
  readonly filename: string;
  readonly file_format: string;
  readonly mime_type: string;
  readonly template_kind: string;
  readonly published_at: string;
}): Record<string, unknown> {
  return Object.freeze({
    editRevision: version.edit_revision,
    taskRevision: version.task_revision,
    artifactVersion: version.artifact_version,
    artifactId: version.artifact_id,
    contentDigest: version.content_digest,
    byteLength: version.byte_length,
    filename: version.filename,
    fileFormat: version.file_format,
    mimeType: version.mime_type,
    templateKind: version.template_kind,
    publishedAt: version.published_at,
  });
}

/**
 * 任务级完成视图 → HTTP 响应（camelCase；内部下划线形状不直接倒出去）。
 *
 * 有意把**判据**与**事实**一并给出：`predicates` 是三个可复算谓词本身，
 * `flags` / `counts` / 各 id 清单是结论背后的事实。这样调用方可以自己复算，
 * 而不必相信一个笼统的 `completed: true`（R262/R263 的判据要求"可复算"）。
 */
function toTaskCompletionResponse(view: TaskCompletionView): Record<string, unknown> {
  return Object.freeze({
    taskId: view.task_id,
    now: view.now,
    completed: view.completed,
    label: view.label,
    labelText: view.label_text,
    detail: view.detail,
    predicates: Object.freeze({
      allWorkItemsTerminal: view.predicates.all_work_items_terminal,
      noInFlightRuns: view.predicates.no_in_flight_runs,
      noUnresolvedActions: view.predicates.no_unresolved_actions,
    }),
    flags: Object.freeze({
      allWorkItemsCompleted: view.flags.all_work_items_completed,
      anyWorkItemFailed: view.flags.any_work_item_failed,
      anyWorkItemCancelled: view.flags.any_work_item_cancelled,
      anyResultUnknownAction: view.flags.any_result_unknown_action,
      anyUnknownActionState: view.flags.any_unknown_action_state,
      hasDeliveredArtifact: view.flags.has_delivered_artifact,
    }),
    counts: Object.freeze({
      workItems: view.counts.work_items,
      workItemsTerminal: view.counts.work_items_terminal,
      runs: view.counts.runs,
      runsInFlight: view.counts.runs_in_flight,
      runsRunningLeaseExpired: view.counts.runs_running_lease_expired,
      actions: view.counts.actions,
      actionsUnresolved: view.counts.actions_unresolved,
      artifacts: view.counts.artifacts,
      artifactsDelivered: view.counts.artifacts_delivered,
    }),
    inFlightRunIds: view.in_flight_run_ids,
    expiredRunningRunIds: view.expired_running_run_ids,
    unresolvedActionIds: view.unresolved_action_ids,
    unknownActionStates: view.unknown_action_states,
    deliveredArtifactIds: view.delivered_artifact_ids,
  });
}

/** `/api/deliverables/<id>/versions/<n>/download` 的形状解析。 */
function parseDeliverableVersionPath(
  pathname: string,
): { readonly sessionId: string; readonly editRevision: number } | null {
  const match = /^\/api\/deliverables\/([^/]+)\/versions\/(\d+)\/download$/.exec(pathname);
  if (match === null) return null;
  const rawId = match[1];
  const rawRevision = match[2];
  if (rawId === undefined || rawRevision === undefined) return null;
  try {
    return { sessionId: decodeURIComponent(rawId), editRevision: Number.parseInt(rawRevision, 10) };
  } catch {
    return null;
  }
}

/** 读取请求体（带上限；超限返回 `null`，**不静默截断**）。 */
async function readBodyLimited(req: IncomingMessage, limit: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.byteLength;
    if (total > limit) {
      // 同 `readBody`：**先把剩余数据排空**再拒绝，否则客户端只会看到 ECONNRESET（WCF-D63 实测）。
      await drainRequest(req);
      return null;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 解析 JSON 对象；失败时**已经**写好响应并返回 `null`（调用方直接 return）。 */
function parseJsonObject(raw: string, res: ServerResponse): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    sendError(res, 400, errorBody('invalid_json', '请求体不是合法 JSON', false));
    return null;
  }
  if (!isRecord(parsed)) {
    sendError(res, 400, errorBody('invalid_body', '请求体必须是对象', false));
    return null;
  }
  return parsed;
}

/** 标识符形态（会话 id / 幂等键共用；收窄以免进入路径与日志时产生歧义）。 */
function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= SESSION_LIMITS.maxIdentifierChars &&
    /^[A-Za-z0-9._-]+$/.test(value)
  );
}

/**
 * 解码 base64（严格）。
 *
 * 用 `Buffer.from(x, 'base64')` 的宽容解析是**危险的**：它会把非法字符悄悄丢掉，
 * 于是"上传了一个坏文件"会变成"上传了一个被悄悄改过的文件"。这里做一次回环核对。
 */
function decodeBase64(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    return null;
  }
  const buffer = Buffer.from(value, 'base64');
  if (buffer.toString('base64') !== value) {
    return null;
  }
  return new Uint8Array(buffer);
}

/** 意图的步骤数（形状不对时返回 `null`，交给下游如实报结构错误）。 */
function countIntentSteps(intent: unknown): number | null {
  if (typeof intent !== 'object' || intent === null) return null;
  const steps = (intent as { readonly steps?: unknown }).steps;
  return Array.isArray(steps) ? steps.length : null;
}

/** 会话失败码 → HTTP 状态。**机器可判**的稳定映射，不靠错误文本匹配。 */
function sessionStatusOf(code: string): number {
  switch (code) {
    case 'session_not_found':
      return 404;
    // 两个字面量是同一语义的两处命名：`session_already_exists`（`src/session`）与
    // `session_exists`（`src/documents/session`）。都表示"该 id 已被占用"，一律 409。
    case 'session_already_exists':
    case 'session_exists':
    case 'stale_revision':
    case 'idempotency_conflict':
      return 409;
    case 'session_limit_reached':
    case 'sessions_unavailable':
      return 503;
    case 'unsupported':
    case 'not_found':
    case 'ambiguous':
    case 'invalid_expression':
    case 'invalid_range':
    case 'invalid_query':
    case 'empty_range':
      return 422;
    case 'import_failed':
    case 'mismatched_document':
    // 文件名与声明的文件格式不符：**请求侧**错误，4xx 且不可重试（R232 的互不冒充）。
    case 'invalid_filename':
      return 400;
    default:
      // `publish_failed` / `export_failed` / 其它：下游没交付成功 ⇒ 502（上游依赖失败），
      // `retryable: true`——重试是允许的（幂等键保证不会重复套用）。
      return 502;
  }
}

/**
 * 会话失败 → 错误体（补上机器可判的版本字段，R143）。
 *
 * `detail` 直接取**会话契约**的 `SessionFailureDetail`，而不是手抄一份 `{ currentRevision,
 * requestedRevision, extra }` 的镜像类型：镜像会与契约各自漂移（`FailureDetail.extra`
 * 已扩到允许 `boolean` 标量，W-R04），而这里只读它的标量字段，用契约类型即可自动跟随。
 */
function textErrorOf(code: string, message: string, detail?: SessionFailureDetail): EditErrorResponse {
  const reason = detail?.extra?.['reason'];
  return Object.freeze({
    code,
    message,
    retryable: code === 'stale_revision' || code === 'publish_failed' || code === 'export_failed',
    currentRevision: detail?.currentRevision ?? 0,
    requestedRevision: detail?.requestedRevision ?? null,
    reason: reason === 'revision' || reason === 'digest' ? reason : null,
  });
}

/** `/api/sessions/<id>/versions/<n>/download` 的形状解析。 */
function parseVersionPath(pathname: string): { readonly sessionId: string; readonly editRevision: number } | null {
  const match = /^\/api\/sessions\/([^/]+)\/versions\/(\d+)\/download$/.exec(pathname);
  if (match === null) return null;
  const rawId = match[1];
  const rawRevision = match[2];
  if (rawId === undefined || rawRevision === undefined) return null;
  try {
    return { sessionId: decodeURIComponent(rawId), editRevision: Number.parseInt(rawRevision, 10) };
  } catch {
    return null;
  }
}

/** 版本映射行（会话包的 `snake_case` → 合同的 `camelCase`）。 */
function toVersionEntry(version: PublishedVersion): {
  readonly editRevision: number;
  readonly taskRevision: number;
  readonly artifactVersion: number;
  readonly artifactId: string;
  readonly contentDigest: string;
  readonly byteLength: number;
  readonly publishedAt: string;
} {
  return Object.freeze({
    editRevision: version.edit_revision,
    taskRevision: version.task_revision,
    artifactVersion: version.artifact_version,
    artifactId: version.artifact_id,
    contentDigest: version.content_digest,
    byteLength: version.byte_length,
    publishedAt: version.published_at,
  });
}

// ---------------------------------------------------------------------------
// 连续对话路由（FA-N）
// ---------------------------------------------------------------------------

const CONVERSATIONS_ROOT = '/api/conversations';

export type ConversationRoute =
  | { readonly kind: 'collection' }
  /** 单个会话资源：`GET` 读、`PATCH` 重命名、`DELETE` 删除（CHAT-02/08）。 */
  | { readonly kind: 'get'; readonly conversationId: string }
  | { readonly kind: 'archive'; readonly conversationId: string }
  | { readonly kind: 'messages'; readonly conversationId: string }
  | { readonly kind: 'events'; readonly conversationId: string }
  | { readonly kind: 'retry'; readonly conversationId: string; readonly messageId: string }
  | { readonly kind: 'cancel'; readonly conversationId: string; readonly messageId: string }
  | { readonly kind: 'download'; readonly conversationId: string; readonly artifactId: string };

/** 把一段路径解码成标识符；不是合法标识符即返回 `null`（不把任意字符串当 id 用）。 */
function decodeIdentifier(segment: string | undefined): string | null {
  if (segment === undefined) {
    return null;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }
  return isSafeIdentifier(decoded) ? decoded : null;
}

/**
 * 解析 `/api/conversations/**`。
 *
 * 逐段匹配而不是一条大正则：段数一样时**先匹配更长的形状**（`documents/.../download`
 * 必须先于 `get`），否则 `:id` 会把子路径整段吞掉。
 */
export function matchConversationRoute(pathname: string): ConversationRoute | null {
  if (pathname !== CONVERSATIONS_ROOT && !pathname.startsWith(`${CONVERSATIONS_ROOT}/`)) {
    return null;
  }
  if (pathname === CONVERSATIONS_ROOT) {
    return { kind: 'collection' };
  }
  const rest = pathname.slice(CONVERSATIONS_ROOT.length + 1);
  const segments = rest.split('/');
  const conversationId = decodeIdentifier(segments[0]);
  if (conversationId === null) {
    return null;
  }
  if (segments.length === 1) {
    return { kind: 'get', conversationId };
  }
  if (segments.length === 2 && segments[1] === 'messages') {
    return { kind: 'messages', conversationId };
  }
  if (segments.length === 2 && segments[1] === 'events') {
    return { kind: 'events', conversationId };
  }
  if (segments.length === 2 && segments[1] === 'archive') {
    return { kind: 'archive', conversationId };
  }
  if (segments.length === 4 && segments[1] === 'messages') {
    const messageId = decodeIdentifier(segments[2]);
    if (messageId === null) {
      return null;
    }
    if (segments[3] === 'retry') {
      return { kind: 'retry', conversationId, messageId };
    }
    if (segments[3] === 'cancel') {
      return { kind: 'cancel', conversationId, messageId };
    }
    return null;
  }
  if (segments.length === 4 && segments[1] === 'documents' && segments[3] === 'download') {
    const artifactId = decodeIdentifier(segments[2]);
    if (artifactId !== null) {
      return { kind: 'download', conversationId, artifactId };
    }
  }
  return null;
}

/** 对话失败码 → HTTP 状态（机器可判的稳定映射，不靠错误文本匹配）。 */
function conversationStatusOf(code: string): number {
  switch (code) {
    case 'conversation_not_found':
    case 'message_not_found':
      return 404;
    case 'idempotency_conflict':
    case 'not_retryable':
    case 'already_terminal':
    case 'cursor_conversation_mismatch':
      return 409;
    case 'conversation_limit_reached':
    case 'conversations_unavailable':
      return 503;
    case 'invalid_cursor':
    case 'empty_text':
    case 'text_too_long':
    case 'empty_name':
    case 'invalid_client_id':
    case 'invalid_paragraphs':
    case 'invalid_title':
      return 422;
    // 请求形状问题（缺字段 / 类型不对 / 分页越界）是**调用方的请求**不对，不是被请求的
    // 资源状态不对 —— 400，不混进 422（422 留给"字段齐全但值本身被业务规则拒绝"那一类）。
    case 'empty_query':
    case 'invalid_pagination':
    case 'invalid_name':
    case 'invalid_archived':
      return 400;
    default:
      return 502;
  }
}

/** 布尔型查询参数：只有 `true` / `1` 算真，其余（含缺省）一律假——不猜调用方的意思。 */
function isTruthyQueryFlag(raw: string | null): boolean {
  return raw === 'true' || raw === '1';
}

/**
 * 解析一个**有界整数**查询参数。
 *
 * 缺省 ⇒ `fallback`；形状不符或越界 ⇒ `null`（调用方据此结构化拒绝，**不**静默夹紧：
 * 把 `limit=9999` 悄悄改成 100 会让调用方以为"就这么多"）。
 */
function parseBoundedInt(raw: string | null, fallback: number, min: number, max: number): number | null {
  if (raw === null) {
    return fallback;
  }
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const value = Number.parseInt(raw, 10);
  if (value < min || value > max) {
    return null;
  }
  return value;
}

/** 消息 → 响应形状（`phase` 承载 R209 的业务五态，`state` 承载界面侧枚举）。 */
function toMessageView(message: {
  readonly messageId: string;
  readonly role: string;
  readonly text: string;
  readonly state: string;
  readonly phase: string;
  readonly seq: number;
  readonly clientId: string;
  readonly attempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly error: unknown;
  readonly artifact: unknown;
}): Record<string, unknown> {
  return {
    messageId: message.messageId,
    role: message.role,
    text: message.text,
    state: message.state,
    phase: message.phase,
    seq: message.seq,
    clientId: message.clientId,
    attempts: message.attempts,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    error: message.error,
    artifact: message.artifact,
  };
}

interface ConversationRouteInput {
  readonly route: ConversationRoute;
  readonly method: string;
  readonly url: URL;
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly conversations: ConversationHost;
}

/**
 * 处理一条对话路由。
 *
 * @returns `true` = 已经写过响应（调用方直接 return）；`false` = 形状对但方法不对，
 *   由调用方落到 404 —— 本函数**不自作主张**把未知方法当成合法请求。
 */
async function handleConversationRoute(input: ConversationRouteInput): Promise<boolean> {
  const { route, method, url, req, res, conversations } = input;
  const isGet = method === 'GET' || method === 'HEAD';

  if (route.kind === 'collection') {
    if (isGet) {
      const includeArchived = isTruthyQueryFlag(url.searchParams.get('include_archived'));
      const query = url.searchParams.get('q');
      if (query !== null) {
        // **搜索**（CHAT-02）：空 `q` 由宿主结构化拒绝 ⇒ 400，绝不回落成"返回全部"。
        const limit = parseBoundedInt(
          url.searchParams.get('limit'),
          CONVERSATION_SEARCH_LIMITS.defaultLimit,
          1,
          CONVERSATION_SEARCH_LIMITS.maxLimit,
        );
        const offset = parseBoundedInt(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
        if (limit === null || offset === null) {
          sendError(
            res,
            400,
            errorBody(
              'invalid_pagination',
              `limit 必须是 1–${String(CONVERSATION_SEARCH_LIMITS.maxLimit)} 的整数，offset 必须是非负整数`,
              false,
            ),
          );
          return true;
        }
        const found = conversations.searchConversations({ query, includeArchived, limit, offset });
        if (!found.ok) {
          sendError(res, conversationStatusOf(found.code), errorBody(found.code, found.message, false));
          return true;
        }
        sendJson(res, 200, found.value);
        return true;
      }
      // 归档位：默认**不含**已归档会话；`include_archived=true` 时可见（CHAT-02 反向对照）。
      sendJson(res, 200, { conversations: conversations.listConversations(includeArchived) });
      return true;
    }
    if (method !== 'POST') {
      sendError(res, 405, errorBody('method_not_allowed', '该接口只接受 GET 或 POST', false));
      return true;
    }
    const raw = await readBody(req);
    if (raw === null) {
      sendError(
        res,
        413,
        errorBody('body_too_large', `请求体超过 ${String(MAX_BODY_BYTES)} 字节上限`, false),
      );
      return true;
    }
    let parsed: Record<string, unknown> = {};
    if (raw.trim() !== '') {
      const body = parseJsonObject(raw, res);
      if (body === null) {
        return true;
      }
      parsed = body;
    }
    const rawId = parsed['conversationId'];
    const rawName = parsed['name'];
    const conversationId =
      rawId === undefined
        ? `conv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
        : typeof rawId === 'string'
          ? rawId
          : '';
    if (!isIdentifier(conversationId)) {
      sendError(
        res,
        400,
        errorBody('invalid_conversation_id', 'conversationId 必须是 1–128 位安全字符', false),
      );
      return true;
    }
    const created = conversations.createConversation(
      conversationId,
      typeof rawName === 'string' ? rawName : undefined,
    );
    if (!created.ok) {
      sendError(res, conversationStatusOf(created.code), errorBody(created.code, created.message, false));
      return true;
    }
    sendJson(res, 201, {
      conversationId: created.value.conversationId,
      name: created.value.name,
      createdAt: created.value.createdAt,
      headCursor: conversations.headCursor(created.value.conversationId),
    });
    return true;
  }

  if (route.kind === 'get') {
    // 单会话资源上的三种方法：GET 读 / PATCH 重命名 / DELETE 删除（CHAT-02/08，加法）。
    if (method === 'PATCH') {
      const raw = await readBody(req);
      if (raw === null) {
        sendError(
          res,
          413,
          errorBody('body_too_large', `请求体超过 ${String(MAX_BODY_BYTES)} 字节上限`, false),
        );
        return true;
      }
      const parsed = parseJsonObject(raw, res);
      if (parsed === null) {
        return true;
      }
      const rawName = parsed['name'];
      if (typeof rawName !== 'string') {
        sendError(res, 400, errorBody('invalid_name', '缺少 name（非空字符串）', false));
        return true;
      }
      const renamed = conversations.renameConversation(route.conversationId, rawName);
      if (!renamed.ok) {
        sendError(res, conversationStatusOf(renamed.code), errorBody(renamed.code, renamed.message, false));
        return true;
      }
      sendJson(res, 200, {
        conversationId: renamed.value.conversationId,
        name: renamed.value.name,
        updatedAt: renamed.value.updatedAt,
      });
      return true;
    }
    if (method === 'DELETE') {
      const deleted = conversations.deleteConversation(route.conversationId);
      if (!deleted.ok) {
        sendError(res, conversationStatusOf(deleted.code), errorBody(deleted.code, deleted.message, false));
        return true;
      }
      // `detached_tasks` 与 `reverted:false` 是 CHAT-08 的**语义**：
      // 删会话**没有**取消任何任务（那些任务原样列在这里），也**没有**撤销任何已发生的副作用。
      // 这里**不**再回一个"cancelled_tasks: []"——一个结构性恒空的字段是**死判据**，
      // "任务没被取消"由测试直接读 `/api/tasks/:id/completion` 仍然 200 来证明。
      sendJson(res, 200, {
        conversationId: deleted.value.conversationId,
        deleted: deleted.value.deleted,
        detached_tasks: deleted.value.detached_tasks,
        reverted: deleted.value.reverted,
      });
      return true;
    }
    if (!isGet) {
      sendError(res, 405, errorBody('method_not_allowed', '该接口只接受 GET / PATCH / DELETE', false));
      return true;
    }
    const record = conversations.readConversation(route.conversationId);
    if (record === undefined) {
      /* 「读不回来」**不是**「不存在」：落盘文件在、但内容读不回时如实说清楚，
         否则用户会以为会话被删了（R216/R240 那一类陷阱）。 */
      const broken = conversations.unreadable(route.conversationId);
      if (broken !== undefined) {
        sendError(
          res,
          503,
          errorBody(
            'conversation_unreadable',
            `会话 ${route.conversationId} 的落盘状态存在但读不回来（${broken.reason}）：` +
              '本服务不按空会话继续，也不假装它不存在',
            false,
          ),
        );
        return true;
      }
      sendError(
        res,
        404,
        errorBody('conversation_not_found', `没有会话 ${route.conversationId}`, false),
      );
      return true;
    }
    sendJson(res, 200, {
      conversationId: record.conversationId,
      name: record.name,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      archived: record.archived,
      messages: record.messages.map(toMessageView),
      headCursor: conversations.headCursor(route.conversationId),
      currentDocument: conversations.currentDocument(route.conversationId)?.ref ?? null,
    });
    return true;
  }

  if (route.kind === 'archive') {
    if (method !== 'POST') {
      sendError(res, 405, errorBody('method_not_allowed', '该接口只接受 POST', false));
      return true;
    }
    const raw = await readBody(req);
    if (raw === null) {
      sendError(
        res,
        413,
        errorBody('body_too_large', `请求体超过 ${String(MAX_BODY_BYTES)} 字节上限`, false),
      );
      return true;
    }
    let parsed: Record<string, unknown> = {};
    if (raw.trim() !== '') {
      const body = parseJsonObject(raw, res);
      if (body === null) {
        return true;
      }
      parsed = body;
    }
    // 缺省 = 归档（`true`）；显式 `{archived:false}` = 取消归档（同一端点两个方向，
    // 不另开 `/unarchive`：归档位是**一个**字段，两个方向改的是同一个东西）。
    const rawArchived = parsed['archived'];
    if (rawArchived !== undefined && typeof rawArchived !== 'boolean') {
      sendError(res, 400, errorBody('invalid_archived', 'archived 必须是布尔值', false));
      return true;
    }
    const archived = rawArchived === undefined ? true : rawArchived;
    const outcome = conversations.archiveConversation(route.conversationId, archived);
    if (!outcome.ok) {
      sendError(res, conversationStatusOf(outcome.code), errorBody(outcome.code, outcome.message, false));
      return true;
    }
    sendJson(res, 200, {
      conversationId: outcome.value.conversationId,
      archived: outcome.value.archived,
      updatedAt: outcome.value.updatedAt,
    });
    return true;
  }

  if (route.kind === 'messages') {
    if (method !== 'POST') {
      sendError(res, 405, errorBody('method_not_allowed', '该接口只接受 POST', false));
      return true;
    }
    const raw = await readBody(req);
    if (raw === null) {
      sendError(
        res,
        413,
        errorBody('body_too_large', `请求体超过 ${String(MAX_BODY_BYTES)} 字节上限`, false),
      );
      return true;
    }
    const parsed = parseJsonObject(raw, res);
    if (parsed === null) {
      return true;
    }
    const clientId = parsed['clientId'];
    const text = parsed['text'];
    if (!isIdentifier(clientId)) {
      sendError(
        res,
        400,
        errorBody('invalid_client_id', '缺少合法的 clientId（1–128 位安全字符；它就是幂等键）', false),
      );
      return true;
    }
    if (typeof text !== 'string' || text.trim() === '') {
      sendError(res, 400, errorBody('invalid_text', '缺少 text（非空字符串）', false));
      return true;
    }
    const outcome = conversations.send(route.conversationId, clientId, text);
    if (!outcome.ok) {
      sendError(res, conversationStatusOf(outcome.code), errorBody(outcome.code, outcome.message, false));
      return true;
    }
    sendJson(res, 202, {
      conversationId: route.conversationId,
      messageId: outcome.value.message.messageId,
      clientId: outcome.value.message.clientId,
      state: outcome.value.message.state,
      phase: outcome.value.message.phase,
      duplicate: outcome.value.duplicate,
      // 已接收 ≠ 业务完成：这一条**只是**"服务端收下了"。
      cursor: conversations.headCursor(route.conversationId),
    });
    return true;
  }

  if (route.kind === 'events') {
    if (!isGet) {
      sendError(res, 405, errorBody('method_not_allowed', '该接口只接受 GET', false));
      return true;
    }
    const cursor = url.searchParams.get('cursor');
    const page = conversations.events(route.conversationId, cursor);
    if (!page.ok) {
      sendError(res, conversationStatusOf(page.code), errorBody(page.code, page.message, false));
      return true;
    }
    sendJson(res, 200, {
      conversationId: page.value.conversationId,
      events: page.value.events,
      cursor: page.value.cursor,
      more: page.value.more,
      pending: page.value.pending.map(toMessageView),
    });
    return true;
  }

  if (route.kind === 'retry') {
    if (method !== 'POST') {
      sendError(res, 405, errorBody('method_not_allowed', '该接口只接受 POST', false));
      return true;
    }
    const outcome = conversations.retry(route.conversationId, route.messageId);
    if (!outcome.ok) {
      sendError(res, conversationStatusOf(outcome.code), errorBody(outcome.code, outcome.message, false));
      return true;
    }
    sendJson(res, 202, {
      conversationId: route.conversationId,
      messageId: outcome.value.messageId,
      clientId: outcome.value.clientId,
      state: outcome.value.state,
      phase: outcome.value.phase,
      attempts: outcome.value.attempts,
      cursor: conversations.headCursor(route.conversationId),
    });
    return true;
  }

  if (route.kind === 'cancel') {
    if (method !== 'POST') {
      sendError(res, 405, errorBody('method_not_allowed', '该接口只接受 POST', false));
      return true;
    }
    const outcome = conversations.cancel(route.conversationId, route.messageId);
    if (!outcome.ok) {
      sendError(res, conversationStatusOf(outcome.code), errorBody(outcome.code, outcome.message, false));
      return true;
    }
    sendJson(res, 200, {
      conversationId: route.conversationId,
      messageId: outcome.value.messageId,
      state: outcome.value.state,
      phase: outcome.value.phase,
      cursor: conversations.headCursor(route.conversationId),
    });
    return true;
  }

  // download
  if (!isGet) {
    sendError(res, 405, errorBody('method_not_allowed', '该接口只接受 GET', false));
    return true;
  }
  const found = await conversations.download(route.artifactId);
  if (found === undefined) {
    sendError(
      res,
      404,
      errorBody(
        'artifact_not_found',
        '没有这个已交付的产物（未发布，或盘上字节与发布摘要已不符）',
        false,
      ),
    );
    return true;
  }
  const asciiFallback = found.filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '_');
  res.writeHead(200, {
    'content-type': DOCX_MIME,
    'content-length': found.bytes.byteLength,
    'content-disposition': `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(
      found.filename,
    )}`,
    'x-content-sha256': found.sha256,
    'x-potbot-artifact-id': found.artifactId,
    'cache-control': 'no-store',
  });
  if (method === 'HEAD') {
    res.end();
    return true;
  }
  res.end(Buffer.from(found.bytes));
  return true;
}

/**
 * 构造请求处理器。返回的是**同步**签名（`node:http` 的监听接口），异步部分在内部处理并兜底。
 */
export function createDemoRequestHandler(
  options: DemoHttpOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  const {
    host,
    webDir,
    sessions = null,
    conversations = null,
    deliverables = null,
    adapters = null,
    memoryRoutes = null,
    pluginRoutes = null,
    conversationLoop = null,
    documentsRoutes = null,
    researchRoutes = null,
    rolesWiring = null,
    xlsFacts = null,
    toolLoop = null,
    sessionAdapters = null,
    krnBarrel = null,
    xlsPrint = null,
    krnOrphans = null,
  } = options;

  // 三组独立路由（记忆 / 模板平台 / 连续对话闭环）的**降级替身**：端口缺席时仍然作答，
  // 但一律是结构化 503，绝不落到 `/api/**` 的 404（那会让"未就绪"看起来像"没有这个接口"）。
  const memoryHost: MemoryRouteHost = memoryRoutes ?? createMemoryRouteHost({});
  const pluginOptions: PluginRoutesOptions = pluginRoutes ?? {};
  const loopRoutes: ConversationLoopRoutes = conversationLoop ?? createConversationLoopRoutes({ loop: null });
  const documentsHost: DocumentsRouteHost = documentsRoutes ?? createDocumentsRouteHost({});
  const researchOptions: ResearchRoutesOptions = researchRoutes ?? {};
  // 共享事实交付入口（FA-XLS-FACTS-PRODUCT）的**降级替身**：宿主缺席时仍由此作答
  // （无通道 ⇒ 发布段结构化 not-wired），绝不落到 `/api/**` 的 404。
  const xlsFactsHost: XlsFactsHost = xlsFacts ?? createXlsFactsHost({});
  // 导出侧公式求值报告（FA-XLS-FORMULA-REPORT）的**版本字节来源**：直接复用交付会话宿主，
  // 报告读的就是 `/api/deliverables/:id/versions/:rev/download` 那份盘上字节（同一份来源、
  // 同一份摘要校验）——不另建会话、不另存字节。宿主缺席（降级替身）⇒ 报告端点结构化 503，
  // 绝不落到 `/api/**` 的 404（那会让"未就绪"看起来像"没有这个接口"）。
  const xlsFormulaSource: XlsFormulaReportSource | null =
    deliverables === null
      ? null
      : {
          hasSession: (sessionId) => deliverables.status(sessionId) !== undefined,
          readVersion: (sessionId, revision) => deliverables.versionBytes(sessionId, revision),
        };
  const xlsFormulaReportHost: XlsFormulaReportHost = createXlsFormulaReportHost({
    source: xlsFormulaSource,
  });
  // 会话适配器入口的**降级替身**（FA-FIX-TAUTOLOGY）：没有内核 store / 没有预算接线时
  // 仍由此作答——检查点段与预算段结构化 503，其余段（时钟 / 日历 / 检索呈现）照常可用。
  const sessionAdaptersRoutes: SessionAdaptersWiring = sessionAdapters ?? createSessionAdaptersWiring({});
  // 共享事实路由的宿主**就是内核真相源**（`KernelHost.store` 那一份）——
  // 不另建事实仓库，也不注入任何私有存储。
  const factsHost: FactsRouteHost = { store: host.store, logicalNow: () => host.logicalNow() };
  // 内核桶入口的**降级替身**（FA-KRN-BARREL-CONSUME）：没有内核 store 时读端点结构化 503
  // （写端点的内存状态照常可用），绝不落到 `/api/**` 的 404。
  const krnBarrelRoutes: KrnBarrelWiring = krnBarrel ?? createKrnBarrelWiring({});
  // 打印入口（FA-XLS-PRINT-ROUTE）的**降级替身**：没有注入宿主时，一次性导出 / 交接 /
  // 拒绝"已打印"照常可用；会话发布因无物化端口而结构化失败（**不**建第二份账本顶替）。
  const xlsPrintHost: XlsPrintHost = xlsPrint ?? createXlsPrintHost({ documents: null });
  // 孤儿模块入口的**降级替身**（FA-KRN-ORPHANS）：没有内核 store / 注册表时，
  // 依赖真实状态的段结构化 503（`/status` 与不依赖状态的段照常作答），绝不落到 `/api/**` 的 404。
  const krnOrphansRoutes: KrnOrphansWiring = krnOrphans ?? createKrnOrphansWiring({});

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname;

    // --- GET /health -------------------------------------------------------
    if (pathname === ROUTES.health) {
      if (method !== 'GET' && method !== 'HEAD') {
        sendError(res, 405, errorBody('method_not_allowed', '该接口只接受 GET', false));
        return;
      }
      sendJson(res, 200, host.health());
      return;
    }

    // --- POST /api/documents ----------------------------------------------
    if (pathname === ROUTES.documents) {
      if (method !== 'POST') {
        sendError(res, 405, errorBody('method_not_allowed', '该接口只接受 POST', false));
        return;
      }
      const raw = await readBody(req);
      if (raw === null) {
        sendError(
          res,
          413,
          errorBody('body_too_large', `请求体超过 ${String(MAX_BODY_BYTES)} 字节上限`, false),
        );
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        sendError(res, 400, errorBody('invalid_json', '请求体不是合法 JSON', false));
        return;
      }
      if (!isRecord(parsed)) {
        sendError(res, 400, errorBody('invalid_body', '请求体必须是对象', false));
        return;
      }
      const requestId = parsed['requestId'];
      const instruction = parsed['instruction'];
      if (typeof requestId !== 'string') {
        sendError(res, 400, errorBody('invalid_request_id', '缺少 requestId（字符串）', false));
        return;
      }
      if (typeof instruction !== 'string') {
        sendError(res, 400, errorBody('invalid_instruction', '缺少 instruction（字符串）', false));
        return;
      }
      const body: CreateDocumentRequest = { requestId, instruction };
      const outcome = host.submit(body.requestId, body.instruction);
      switch (outcome.kind) {
        case 'created':
        case 'existing':
          sendJson(res, 202, {
            requestId: outcome.task.requestId,
            taskId: outcome.task.taskId,
            status: outcome.task.status,
          });
          return;
        case 'conflict':
          sendError(
            res,
            409,
            errorBody(
              'duplicate_request_conflict',
              '这个 requestId 已经用于另一次不同的写作要求：请换一个 requestId，或按原输入重新提交',
              false,
            ),
          );
          return;
        case 'invalid':
          sendError(res, 400, outcome.error);
          return;
      }
    }

    // --- GET /api/tasks/:taskId/completion --------------------------------
    //
    // 任务级"完成"口径的**只读**派生入口（contract 附五 R261–R263）。
    // **只有 GET**：这里没有、也不会有"把任务置为完成"的写入口（R261 明文禁止）。
    // 结论是从内核存储里的三个集合**算出来**的，同一组状态重复求值必得同一结论。
    const completionTaskId = pathParam(pathname, '/api/tasks/', '/completion');
    if (completionTaskId !== null) {
      if (method !== 'GET' && method !== 'HEAD') {
        sendError(res, 405, errorBody('method_not_allowed', '该接口只接受 GET（完成是派生结论，不可写入）', false));
        return;
      }
      const view = taskCompletionOf(host.store, completionTaskId, host.logicalNow());
      if (view === undefined) {
        sendError(res, 404, errorBody('task_unknown', '没有这个任务', false));
        return;
      }
      sendJson(res, 200, toTaskCompletionResponse(view));
      return;
    }

    // --- GET /api/tasks/:taskId -------------------------------------------
    const taskId = pathParam(pathname, '/api/tasks/');
    if (taskId !== null) {
      if (method !== 'GET' && method !== 'HEAD') {
        sendError(res, 405, errorBody('method_not_allowed', '该接口只接受 GET', false));
        return;
      }
      const response = host.taskResponse(taskId);
      if (response === undefined) {
        sendError(res, 404, errorBody('task_unknown', '没有这个任务', false));
        return;
      }
      sendJson(res, 200, response);
      return;
    }

    // --- GET /api/artifacts/:artifactId/download --------------------------
    const downloadId = pathParam(pathname, '/api/artifacts/', '/download');
    if (downloadId !== null) {
      if (method !== 'GET' && method !== 'HEAD') {
        sendError(res, 405, errorBody('method_not_allowed', '该接口只接受 GET', false));
        return;
      }
      const outcome = await host.downloadArtifact(downloadId);
      if (outcome.kind === 'error') {
        sendError(res, outcome.httpStatus, outcome.error);
        return;
      }
      // RFC 5987 的两段式文件名：ASCII 回退 + UTF-8 原名（中文标题也能正确落地）。
      const asciiFallback = outcome.filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '_');
      res.writeHead(200, {
        'content-type': outcome.mimeType,
        'content-length': outcome.bytes.byteLength,
        'content-disposition': `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(
          outcome.filename,
        )}`,
        'x-content-sha256': outcome.sha256,
        // 放行依据来自哪一层：内核本次启动的 store，还是应用索引在发布时登记的摘要。
        'x-potbot-kernel-record-present': String(outcome.kernelRecordPresent),
        'cache-control': 'no-store',
      });
      if (method === 'HEAD') {
        res.end();
        return;
      }
      res.end(Buffer.from(outcome.bytes));
      return;
    }

    // --- POST /api/artifacts/:artifactId/observations ---------------------
    const observationId = pathParam(pathname, '/api/artifacts/', '/observations');
    if (observationId !== null) {
      if (method !== 'POST') {
        sendError(res, 405, errorBody('method_not_allowed', '该接口只接受 POST', false));
        return;
      }
      const raw = await readBody(req);
      if (raw === null) {
        sendError(
          res,
          413,
          errorBody('body_too_large', `请求体超过 ${String(MAX_BODY_BYTES)} 字节上限`, false),
        );
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        sendError(res, 400, errorBody('invalid_json', '请求体不是合法 JSON', false));
        return;
      }
      if (!isRecord(parsed)) {
        sendError(res, 400, errorBody('invalid_body', '请求体必须是对象', false));
        return;
      }
      const request = parsed as unknown as ObservationRequest;
      const outcome = host.recordObservation(observationId, request);
      sendJson(res, outcome.httpStatus, outcome.body);
      return;
    }

    // --- 文档会话：POST /api/sessions（新建 / 导入） -----------------------
    if (pathname === ROUTES.sessions) {
      if (method !== 'POST') {
        sendError(res, 405, errorBody('method_not_allowed', '该接口只接受 POST', false));
        return;
      }
      if (sessions === null) {
        sendError(res, 503, sessionsUnavailable());
        return;
      }
      const raw = await readBodyLimited(req, MAX_SESSION_BODY_BYTES);
      if (raw === null) {
        sendError(
          res,
          413,
          errorBody('body_too_large', `请求体超过 ${String(MAX_SESSION_BODY_BYTES)} 字节上限`, false),
        );
        return;
      }
      const parsed = parseJsonObject(raw, res);
      if (parsed === null) return;

      const sessionId = parsed['sessionId'];
      const filename = parsed['filename'];
      const mode = parsed['mode'];
      const docxBase64 = parsed['docxBase64'];
      if (!isIdentifier(sessionId)) {
        sendError(res, 400, errorBody('invalid_session_id', '缺少合法的 sessionId（1–128 位安全字符）', false));
        return;
      }
      if (typeof filename !== 'string' || filename.trim().length === 0) {
        sendError(res, 400, errorBody('invalid_filename', '缺少 filename（非空字符串）', false));
        return;
      }
      if (mode !== 'new' && mode !== 'import') {
        sendError(res, 400, errorBody('invalid_mode', 'mode 必须是 "new" 或 "import"', false));
        return;
      }
      if (typeof docxBase64 !== 'string') {
        sendError(res, 400, errorBody('invalid_docx', '缺少 docxBase64（base64 字符串）', false));
        return;
      }
      const bytes = decodeBase64(docxBase64);
      if (bytes === null || bytes.byteLength === 0) {
        sendError(res, 400, errorBody('invalid_docx', 'docxBase64 不是合法 base64 或解码后为空', false));
        return;
      }

      const opened = sessions.openSession({
        session_id: sessionId,
        filename,
        mode,
        template_bytes: bytes,
      });
      if (!opened.ok) {
        sendError(res, sessionStatusOf(opened.code), textErrorOf(opened.code, opened.message));
        return;
      }
      sendJson(res, 201, {
        sessionId: opened.value.session_id,
        documentId: opened.value.document_id,
        filename: opened.value.filename,
        kernelTaskId: opened.value.kernel_task_id,
        editRevision: opened.value.edit_revision,
        contentDigest: opened.value.content_digest,
      });
      return;
    }

    // --- 文档会话：POST /api/sessions/:id/edits（提交编辑计划） -------------
    const editSessionId = pathParam(pathname, '/api/sessions/', '/edits');
    if (editSessionId !== null) {
      if (method !== 'POST') {
        sendError(res, 405, errorBody('method_not_allowed', '该接口只接受 POST', false));
        return;
      }
      if (sessions === null) {
        sendError(res, 503, sessionsUnavailable());
        return;
      }
      const raw = await readBodyLimited(req, MAX_BODY_BYTES);
      if (raw === null) {
        sendError(
          res,
          413,
          errorBody('body_too_large', `请求体超过 ${String(MAX_BODY_BYTES)} 字节上限`, false),
        );
        return;
      }
      const parsed = parseJsonObject(raw, res);
      if (parsed === null) return;

      const idempotencyKey = parsed['idempotencyKey'];
      const baseRevision = parsed['baseRevision'];
      const baseDigest = parsed['baseDigest'];
      if (!isIdentifier(idempotencyKey)) {
        sendError(res, 400, errorBody('invalid_idempotency_key', '缺少合法的 idempotencyKey（1–128 位安全字符）', false));
        return;
      }
      if (typeof baseRevision !== 'number' || !Number.isInteger(baseRevision) || baseRevision < 0) {
        sendError(res, 400, errorBody('invalid_base_revision', 'baseRevision 必须是 ≥0 的整数', false));
        return;
      }
      if (typeof baseDigest !== 'string' || !/^[0-9a-f]{64}$/.test(baseDigest)) {
        sendError(res, 400, errorBody('invalid_base_digest', 'baseDigest 必须是 64 位小写十六进制', false));
        return;
      }
      const intent = parsed['intent'];
      const sectionIntent = parsed['sectionIntent'];
      const listIntent = parsed['listIntent'];
      const given = [intent, sectionIntent, listIntent].filter((value) => value !== undefined).length;
      if (given === 0) {
        sendError(
          res,
          400,
          errorBody(
            'invalid_intent',
            '缺少 intent（结构化编辑意图）/ sectionIntent（节编辑意图）/ listIntent（列表编辑意图）之一',
            false,
          ),
        );
        return;
      }
      if (given > 1) {
        // **三选一**：三条意图各自有作用域语法与执行器，混在一起没有可判定的语义
        // （而且会让"一次用户指令 = 一次 revision"这条不变量说不清）。
        sendError(
          res,
          400,
          errorBody('invalid_intent', 'intent / sectionIntent / listIntent 只能给一个', false),
        );
        return;
      }
      const stepCount = countIntentSteps(intent ?? sectionIntent ?? listIntent);
      if (stepCount !== null && stepCount > SESSION_LIMITS.maxStepsPerIntent) {
        sendError(
          res,
          422,
          errorBody(
            'too_many_steps',
            `一次编辑最多 ${String(SESSION_LIMITS.maxStepsPerIntent)} 步（收到 ${String(stepCount)} 步）：请拆分提交`,
            false,
          ),
        );
        return;
      }

      const outcome = await sessions.submitEdit({
        session_id: editSessionId,
        idempotency_key: idempotencyKey,
        base_revision: baseRevision,
        base_digest: baseDigest,
        ...(intent === undefined ? {} : { intent }),
        ...(sectionIntent === undefined ? {} : { section_intent: sectionIntent }),
        ...(listIntent === undefined ? {} : { list_intent: listIntent }),
      });
      if (!outcome.ok) {
        sendError(res, sessionStatusOf(outcome.code), textErrorOf(outcome.code, outcome.message, outcome.detail));
        return;
      }
      const value = outcome.value as {
        readonly replayed: boolean;
        readonly no_op: boolean;
        readonly edit_revision: number;
        readonly steps: readonly { readonly range: string; readonly domain: string; readonly hitCount: number; readonly changed: boolean; readonly toggleTarget?: 'on' | 'off' | null }[];
        readonly published: SessionVersionView | null;
      };
      sendJson(res, 200, {
        sessionId: editSessionId,
        replayed: value.replayed,
        noOp: value.no_op,
        editRevision: value.edit_revision,
        steps: value.steps.map((step) => ({
          range: step.range,
          domain: step.domain,
          hitCount: step.hitCount,
          changed: step.changed,
          ...(step.toggleTarget === undefined ? {} : { toggleTarget: step.toggleTarget }),
        })),
        version: value.published === null ? null : toVersionEntry(value.published),
      });
      return;
    }

    // --- 文档会话：GET /api/sessions/:id/versions/:rev/download ------------
    const versionPath = parseVersionPath(pathname);
    if (versionPath !== null) {
      if (method !== 'GET' && method !== 'HEAD') {
        sendError(res, 405, errorBody('method_not_allowed', '该接口只接受 GET', false));
        return;
      }
      if (sessions === null) {
        sendError(res, 503, sessionsUnavailable());
        return;
      }
      const found = await sessions.versionBytes(versionPath.sessionId, versionPath.editRevision);
      if (found === undefined) {
        sendError(
          res,
          404,
          errorBody('version_not_found', '这个会话里没有该编辑版本的已交付文件（未发布或摘要已不符）', false),
        );
        return;
      }
      const asciiFallback = found.filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '_');
      res.writeHead(200, {
        'content-type': DOCX_MIME,
        'content-length': found.bytes.byteLength,
        'content-disposition': `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(
          found.filename,
        )}`,
        'x-content-sha256': found.content_digest,
        'x-potbot-artifact-id': found.artifact_id,
        'cache-control': 'no-store',
      });
      if (method === 'HEAD') {
        res.end();
        return;
      }
      res.end(Buffer.from(found.bytes));
      return;
    }

    // --- 文档会话：GET /api/sessions/:id（状态 + 版本映射 + 日志） ---------
    const sessionId = pathParam(pathname, '/api/sessions/');
    if (sessionId !== null) {
      if (method !== 'GET' && method !== 'HEAD') {
        sendError(res, 405, errorBody('method_not_allowed', '该接口只接受 GET', false));
        return;
      }
      if (sessions === null) {
        sendError(res, 503, sessionsUnavailable());
        return;
      }
      // 会话不在内存里 ≠ 这个会话不存在：宿主重启后内存是空的，但会话状态在
      // `<runDir>/sessions/<id>.json` 里（R216「保存并重新打开」）。因此这里**真的**去恢复一次，
      // 而不是直接 404。恢复失败会带着具体原因返回（读不回来 / 没有文件名 / 内核任务登记失败），
      // 绝不"看着像有就当作能打开"。
      let status = sessions.status(sessionId);
      let restoredFromDisk = false;
      if (status === undefined) {
        const reopened = sessions.restorePersistedSession(sessionId);
        if (!reopened.ok) {
          sendError(
            res,
            sessionStatusOf(reopened.code),
            textErrorOf(reopened.code, reopened.message, reopened.detail),
          );
          return;
        }
        restoredFromDisk = true;
        status = sessions.status(sessionId);
        if (status === undefined) {
          // 恢复报告成功却查不到状态：内部不一致，如实报 500，不构造一份假的响应。
          sendError(
            res,
            500,
            errorBody('session_restore_inconsistent', '恢复报告成功但宿主里查不到该会话', true),
          );
          return;
        }
      }
      sendJson(res, 200, {
        sessionId: status.session_id,
        documentId: status.document_id,
        filename: status.filename,
        /**
         * 本响应是**从落盘状态恢复**出来的，还是内存里本来就有。
         * 读者必须能分清这两者，否则"重开成功"会被误读成"一直在内存里"。
         */
        restoredFromDisk,
        editRevision: status.edit_revision,
        contentDigest: status.content_digest,
        sourceKind: status.source_kind,
        sourceDigest: status.source_digest,
        versions: status.published.map(toVersionEntry),
        currentVersion: status.current === null ? null : toVersionEntry(status.current),
        lastFailure: status.last_failure,
        log: status.log.slice(-SESSION_LIMITS.maxLogEntriesInResponse).map((entry) => ({
          seq: entry.seq,
          kind: entry.kind,
          baseRevision: entry.base_revision,
          resultRevision: entry.result_revision,
          at: entry.at,
          idempotencyKey: entry.idempotency_key,
          ranges: entry.ranges,
          hitCounts: entry.hit_counts,
          changed: entry.changed,
          rejection: entry.rejection,
        })),
      });
      return;
    }

    // --- 交付会话：POST /api/deliverables（开会话：空白源 / 导入） ---------
    //
    // design-06 P8/P9 的**产品入口**：表格与演示经它与字处理链**同一套**内核发布链交付。
    // 刻意与 `/api/sessions` 分开而不是在旧路由上加一个 format 参数：旧路由的契约
    // （`docxBase64` / 三种 Word 意图）已经被「待验收」的证据面钉住，改它会把那些证据作废。
    if (pathname === '/api/deliverables') {
      if (method !== 'POST') {
        sendError(res, 405, errorBody('method_not_allowed', '该接口只接受 POST', false));
        return;
      }
      if (deliverables === null) {
        sendError(res, 503, deliverablesUnavailable());
        return;
      }
      const raw = await readBodyLimited(req, MAX_SESSION_BODY_BYTES);
      if (raw === null) {
        sendError(
          res,
          413,
          errorBody('body_too_large', `请求体超过 ${String(MAX_SESSION_BODY_BYTES)} 字节上限`, false),
        );
        return;
      }
      const parsed = parseJsonObject(raw, res);
      if (parsed === null) return;

      const sessionId = parsed['sessionId'];
      const deliverableId = parsed['deliverableId'];
      const filename = parsed['filename'];
      const format = parsed['format'];
      const title = parsed['title'];
      const fileBase64 = parsed['fileBase64'];
      if (!isIdentifier(sessionId)) {
        sendError(res, 400, errorBody('invalid_session_id', '缺少合法的 sessionId（1–128 位安全字符）', false));
        return;
      }
      if (!isIdentifier(deliverableId)) {
        sendError(res, 400, errorBody('invalid_deliverable_id', '缺少合法的 deliverableId', false));
        return;
      }
      if (typeof filename !== 'string' || filename.trim().length === 0) {
        sendError(res, 400, errorBody('invalid_filename', '缺少 filename（非空字符串）', false));
        return;
      }
      if (format !== 'xlsx' && format !== 'pptx') {
        // **刻意的封闭面**：`docx` 走 `/api/sessions`（带段落 / 节 / 列表语义），本入口本轮不开。
        sendError(
          res,
          400,
          errorBody(
            'invalid_format',
            'format 必须是 "xlsx" 或 "pptx"（docx 请走 /api/sessions）',
            false,
          ),
        );
        return;
      }
      if (fileBase64 !== undefined && typeof fileBase64 !== 'string') {
        sendError(res, 400, errorBody('invalid_file', 'fileBase64 必须是字符串', false));
        return;
      }
      const bytes = typeof fileBase64 === 'string' ? decodeBase64(fileBase64) : null;
      if (typeof fileBase64 === 'string' && bytes === null) {
        sendError(res, 400, errorBody('invalid_file', 'fileBase64 不是合法 base64', false));
        return;
      }
      const opened = deliverables.open({
        session_id: sessionId,
        deliverable_id: deliverableId,
        filename,
        format,
        ...(bytes === null ? {} : { bytes }),
        ...(typeof title === 'string' ? { title } : {}),
      });
      if (!opened.ok) {
        sendError(res, sessionStatusOf(opened.code), deliverableErrorOf(opened));
        return;
      }
      sendJson(res, 201, {
        sessionId: opened.value.session_id,
        deliverableId: opened.value.deliverable_id,
        filename: opened.value.filename,
        fileFormat: opened.value.file_format,
        templateKind: opened.value.template_kind,
        kernelTaskId: opened.value.kernel_task_id,
        editRevision: opened.value.edit_revision,
        contentDigest: opened.value.content_digest,
      });
      return;
    }

    // --- 交付会话：POST /api/deliverables/:id/edits（编辑 + 交付一版） ------
    const deliverableEditId = pathParam(pathname, '/api/deliverables/', '/edits');
    if (deliverableEditId !== null) {
      if (method !== 'POST') {
        sendError(res, 405, errorBody('method_not_allowed', '该接口只接受 POST', false));
        return;
      }
      if (deliverables === null) {
        sendError(res, 503, deliverablesUnavailable());
        return;
      }
      const raw = await readBodyLimited(req, MAX_BODY_BYTES);
      if (raw === null) {
        sendError(
          res,
          413,
          errorBody('body_too_large', `请求体超过 ${String(MAX_BODY_BYTES)} 字节上限`, false),
        );
        return;
      }
      const parsed = parseJsonObject(raw, res);
      if (parsed === null) return;

      const idempotencyKey = parsed['idempotencyKey'];
      const baseRevision = parsed['baseRevision'];
      const baseDigest = parsed['baseDigest'];
      const edit = parsed['edit'];
      if (!isIdentifier(idempotencyKey)) {
        sendError(res, 400, errorBody('invalid_idempotency_key', '缺少合法的 idempotencyKey', false));
        return;
      }
      if (typeof baseRevision !== 'number' || !Number.isInteger(baseRevision) || baseRevision < 0) {
        sendError(res, 400, errorBody('invalid_base_revision', 'baseRevision 必须是 ≥0 的整数', false));
        return;
      }
      if (typeof baseDigest !== 'string' || !/^[0-9a-f]{64}$/.test(baseDigest)) {
        sendError(res, 400, errorBody('invalid_base_digest', 'baseDigest 必须是 64 位小写十六进制', false));
        return;
      }

      const outcome = await deliverables.publish(deliverableEditId, {
        idempotency_key: idempotencyKey,
        base_revision: baseRevision,
        base_digest: baseDigest,
        ...(edit === undefined ? {} : { edit }),
      });
      if (!outcome.ok) {
        sendError(res, sessionStatusOf(outcome.code), deliverableErrorOf(outcome));
        return;
      }
      const value = outcome.value;
      sendJson(res, 200, {
        sessionId: deliverableEditId,
        replayed: value.replayed,
        changed: value.changed,
        editRevision: value.edit_revision,
        notes: value.notes,
        version: value.published === null ? null : toDeliverableVersionEntry(value.published),
      });
      return;
    }

    // --- 交付会话：GET /api/deliverables/:id/versions/:rev/download --------
    const deliverableVersion = parseDeliverableVersionPath(pathname);
    if (deliverableVersion !== null) {
      if (method !== 'GET' && method !== 'HEAD') {
        sendError(res, 405, errorBody('method_not_allowed', '该接口只接受 GET', false));
        return;
      }
      if (deliverables === null) {
        sendError(res, 503, deliverablesUnavailable());
        return;
      }
      const found = await deliverables.versionBytes(
        deliverableVersion.sessionId,
        deliverableVersion.editRevision,
      );
      if (found === undefined) {
        sendError(
          res,
          404,
          errorBody('version_not_found', '这个交付会话里没有该编辑版本的已交付文件（未发布或摘要已不符）', false),
        );
        return;
      }
      const asciiFallback = found.filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '_');
      res.writeHead(200, {
        // **格式随版本走**（R232）：Content-Type 取自这一版自己的映射行，
        // 不是这条链的常量——三种格式因此不可能互相冒充。
        'content-type': found.mime_type,
        'content-length': found.bytes.byteLength,
        'content-disposition': `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(
          found.filename,
        )}`,
        'x-content-sha256': found.content_digest,
        'x-potbot-artifact-id': found.artifact_id,
        'x-potbot-file-format': found.file_format,
        'cache-control': 'no-store',
      });
      if (method === 'HEAD') {
        res.end();
        return;
      }
      res.end(Buffer.from(found.bytes));
      return;
    }

    // --- 交付会话：GET /api/deliverables/:id（状态 + 版本映射 + 日志） -----
    const deliverableId = pathParam(pathname, '/api/deliverables/');
    if (deliverableId !== null) {
      if (method !== 'GET' && method !== 'HEAD') {
        sendError(res, 405, errorBody('method_not_allowed', '该接口只接受 GET', false));
        return;
      }
      if (deliverables === null) {
        sendError(res, 503, deliverablesUnavailable());
        return;
      }
      const status = deliverables.status(deliverableId);
      if (status === undefined) {
        sendError(res, 404, errorBody('session_not_found', '没有这个交付会话', false));
        return;
      }
      sendJson(res, 200, {
        sessionId: status.session_id,
        deliverableId: status.deliverable_id,
        filename: status.filename,
        fileFormat: status.file_format,
        templateKind: status.template_kind,
        editRevision: status.edit_revision,
        contentDigest: status.content_digest,
        sourceKind: status.source_kind,
        sourceDigest: status.source_digest,
        versions: status.published.map(toDeliverableVersionEntry),
        currentVersion: status.current === null ? null : toDeliverableVersionEntry(status.current),
        lastFailure: status.last_failure,
        // 与 `/api/sessions/:id` 同一口径：响应一律 camelCase，不把内部状态形状直接倒出去。
        log: status.log.slice(-SESSION_LIMITS.maxLogEntriesInResponse).map((entry) => ({
          seq: entry.seq,
          kind: entry.kind,
          baseRevision: entry.base_revision,
          resultRevision: entry.result_revision,
          at: entry.at,
          idempotencyKey: entry.idempotency_key,
          changed: entry.changed,
          rejection: entry.rejection,
        })),
      });
      return;
    }

    // --- 交付会话：GET /api/deliverables/:id/completion --------------------
    //
    // 交付会话那条内核任务的**完成口径**派生视图（contract 附五 R261–R263）。
    // 与 `/api/tasks/:taskId/completion` **同一个派生模块**，只是任务的家不同
    // （交付会话的任务在内核交付存储里，不在主内核存储里——两处并存是事实，见交付说明）。
    // **只读**：没有 POST/PUT 面，完成不可写入。
    const deliverableCompletionId = pathParam(pathname, '/api/deliverables/', '/completion');
    if (deliverableCompletionId !== null) {
      if (method !== 'GET' && method !== 'HEAD') {
        sendError(res, 405, errorBody('method_not_allowed', '该接口只接受 GET（完成是派生结论，不可写入）', false));
        return;
      }
      if (deliverables === null) {
        sendError(res, 503, deliverablesUnavailable());
        return;
      }
      const view = deliverables.completionOf(deliverableCompletionId);
      if (view === undefined) {
        sendError(res, 404, errorBody('session_not_found', '没有这个交付会话', false));
        return;
      }
      sendJson(res, 200, toTaskCompletionResponse(view));
      return;
    }

    // --- R219：候选身份（宿主与验证者核对**同一候选**的入口）---------------
    if (pathname === '/api/identity') {
      if (method !== 'GET' && method !== 'HEAD') {
        sendError(res, 405, errorBody('method_not_allowed', '该接口只接受 GET', false));
        return;
      }
      const reported = options.identity?.() ?? null;
      if (reported === null) {
        sendError(
          res,
          503,
          errorBody('identity_unavailable', '本进程没有可报告的运行身份（宿主未接入）', false),
        );
        return;
      }
      sendJson(res, 200, reported);
      return;
    }

    // --- 连续对话（FA-N；合同 R207–R209 / H2）-----------------------------
    const conversationRoute = matchConversationRoute(pathname);
    if (conversationRoute !== null) {
      if (conversations === null) {
        sendError(
          res,
          503,
          errorBody(
            'conversations_unavailable',
            '连续对话能力未接入：本进程没有对话宿主（不退化接旧的一次性生成接口）',
            false,
          ),
        );
        return;
      }
      const handled = await handleConversationRoute({
        route: conversationRoute,
        method,
        url,
        req,
        res,
        conversations,
      });
      if (handled) {
        return;
      }
    }

    // --- 适配器产品入口（FA-X；时钟 / 日历 / 美团，/api/adapters/**）-------
    //
    // 独立路由模块，只按前缀转交。未接入时不注册，落到下面的 /api/** 404。
    // `handle` 自己负责把"未就绪/阻塞"渲染成结构化 503/501（**不是** 500）。
    if (adapters !== null) {
      const handled = await adapters.handle({ method, pathname, url, req, res });
      if (handled) {
        return;
      }
    }

    // --- 记忆 / 模板平台 / 连续对话闭环三组独立路由（FA-WIRE-PRODUCT-ROUTES）---
    //
    // 按前缀依次尝试（三者前缀互不重叠）；命中即返回。**放在 `/api/**` 兜底 404 之前**，
    // 因此不改变任何既有分支：非本前缀的请求三条 `handle` 都直接返回 `false`。
    // 未装配端口时仍由此作答（结构化 503），而不是落到 404。
    if (await handleMemoryRequest({ req, res, url, host: memoryHost })) {
      return;
    }
    // 事实版本轨迹（FA-TRACE-FACT-VERSIONS）：**复用同一个记忆宿主**（同一份真相源 /
    // 同一份持久端口），不另建仓库；路径前缀与记忆路由不重叠（`matchMemoryRoute` 对它返回 `null`）。
    if (await handleFactVersionsRequest({ req, res, url, method }, memoryHost)) {
      return;
    }
    if (await handlePluginRequest({ method, pathname, url, req, res }, pluginOptions)) {
      return;
    }
    if (await loopRoutes.handle({ method, pathname, url, req, res })) {
      return;
    }
    // 文档工作流 / 资料检索两组（同一纪律：前缀不重叠、命中即返回、端口缺席结构化未就绪）
    if (await handleDocumentsRequest({ req, res, url, host: documentsHost })) {
      return;
    }
    if (await handleResearchRequest({ req, res, url } as never, researchOptions)) {
      return;
    }
    // PPT 同版事实交付（FA-PPT-FACTS-PRODUCT2；`/api/ppt-facts/**`）。同一纪律：前缀不重叠、
    // 命中即返回；本路由是纯函数，不依赖任何端口，因此没有"未就绪"分支。
    if (await handlePptxFactsRequest({ req, res, url })) {
      return;
    }
    // PPT 媒体 / 形状 / 表格 / 图表 / 音视频（FA-PPT-MEDIA-MOUNT；`/api/ppt-media/**`）。同一纪律：
    // 前缀不重叠、命中即返回；本路由是纯函数，零端口零落盘，因此没有"未就绪"分支。
    if (await handlePptxMediaRequest({ req, res, url })) {
      return;
    }
    // 三种基础角色（同一纪律：前缀不重叠、命中即返回）
    if (rolesWiring !== null && (await rolesWiring.handle({ method, pathname, url, req, res }))) {
      return;
    }
    // 共享事实绑定的表格交付入口（FA-XLS-FACTS-PRODUCT，同一纪律：前缀不重叠、命中即返回）
    if (await handleXlsFactsRequest({ req, res, url, method }, xlsFactsHost)) {
      return;
    }
    // XLSX 结构操作入口（FA-XLS-STRUCTURE-PRODUCT；`/api/xls-structure/**`，同一纪律：前缀不重叠、
    // 命中即返回）。**纯函数路由**：不依赖任何端口，因此没有"未就绪"分支。**只做加法**。
    if (await handleXlsStructureRequest({ req, res, url, method })) {
      return;
    }
    // 导出侧公式求值报告（FA-XLS-FORMULA-REPORT；`/api/xls-formula/**`，同一纪律：
    // 前缀不重叠、命中即返回）。**只做加法**：非本前缀直接返回 false，不改任何既有分支。
    if (await handleXlsFormulaReportRequest({ req, res, url, method }, xlsFormulaReportHost)) {
      return;
    }
    // 共享事实的产品 HTTP 路由（FA-FACTS-HTTP-ROUTE；`/api/facts/**`，同一纪律：前缀不重叠、命中即返回）。
    // 读写都走内核真相源，不建第二份事实源。
    if (await handleFactsRequest({ req, res, url, method }, factsHost)) {
      return;
    }
    // 工具循环（FA-KRN-TOOL-LOOP-PRODUCT；/api/tool-loop/**，同一纪律）。
    // `host: null` ⇒ 模块自己用一个"无端口"宿主作答（结构化 503 / 如实未就绪），不是 404。
    if (await handleToolLoopRequest({ req, res, url, host: toolLoop })) {
      return;
    }
    // 会话适配器入口（FA-FIX-TAUTOLOGY，同一纪律：前缀不重叠、命中即返回）
    if (await sessionAdaptersRoutes.handle({ method, pathname, url, req, res })) {
      return;
    }
    // 内核桶入口（FA-KRN-BARREL-CONSUME；/api/krn-barrel/**，同一纪律）。
    // 省略 krnBarrel ⇒ 降级替身作答（读端点结构化 503），不是 404。
    if (await krnBarrelRoutes.handle({ method, pathname, url, req, res })) {
      return;
    }
    // XLSX 打印设置入口（FA-XLS-PRINT-ROUTE；`/api/xls-print/**`，同一纪律：前缀不重叠、
    // 命中即返回、端口缺席结构化失败）。这是 `fa/prod-depth-c` 实测"产品 HTTP 无打印通道"的翻正点。
    if (await handleXlsPrintRequest({ req, res, url, method }, xlsPrintHost)) {
      return;
    }
    // 孤儿模块处置入口（FA-KRN-ORPHANS；/api/krn-orphans/**，同一纪律）。
    // 省略 krnOrphans ⇒ 降级替身作答（依赖真实状态的段结构化 503），不是 404。
    if (await krnOrphansRoutes.handle({ method, pathname, url, req, res })) {
      return;
    }

    // --- 其它 /api/** 一律 404（不落到静态服务）----------------------------
    if (pathname.startsWith('/api/')) {
      sendError(res, 404, errorBody('not_found', '没有这个接口', false));
      return;
    }

    // --- 静态页面 ---------------------------------------------------------
    if (method !== 'GET' && method !== 'HEAD') {
      sendError(res, 405, errorBody('method_not_allowed', '静态资源只接受 GET', false));
      return;
    }
    serveStatic(webDir, pathname, req, res);
  };

  return (req, res): void => {
    void handle(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      const detail = error instanceof Error ? error.message : String(error);
      sendError(
        res,
        500,
        errorBody('internal_error', `服务内部错误：${detail}`, true),
      );
    });
  };
}
