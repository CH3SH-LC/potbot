/**
 * 手机 Word Demo —— **服务入口**（S3 独占写入范围）。
 *
 * 启动顺序：
 * 1. 解析运行目录 / 产物根 / 静态页目录（可用环境变量覆盖，便于换运行实例）；
 * 2. 接上两个内部端口（S4 模型 / S5 文档）——**缺失即如实降级**，不伪造能力；
 * 3. `kernel.boot()` 做一次诚实的重启自检（在途标 interrupted、已完成的重新回读校验）；
 * 4. 在 `127.0.0.1:8765`（合同 `DEFAULT_PORT`）上用 `node:http` 起服务。
 *
 * ## 端口接入的两种"没有"要分开
 *
 * - **模块不在** ⇒ 编译期就失败（静态 import，S4/S5 已落地）；
 * - **模型未配置** ⇒ `createModelPort(env)` 抛错 ⇒ 捕获后 `model = null`，
 *   `/health` 的 `modelConfigured` **如实为 false**（不是"假装能生成"）。
 *
 * ## 密钥纪律
 *
 * 只把 `process.env` 交给 S4 的 `createModelPort()`；本文件**不打印任何环境变量值**，
 * 日志里只有 provider / model 名与端口号。
 */

import { createServer, type Server } from 'node:http';
import { networkInterfaces } from 'node:os';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONTRACT_VERSION, DEFAULT_PORT } from '../contracts.js';
import { createDocumentPort, type DocumentPort } from '../documents/port.js';
// `resolveMaxRequests` 是 `POTBOT_MODEL_MAX_REQUESTS` 的**唯一解析处**（模型端口自己用的也是它）。
// 宿主闸门必须与模型端口**同源**：在主协调者的集成实测里，宿主曾经硬编码 12，导致显式设了 24
// 也照样被宿主的闸门拦住——「文档写了却不起作用的旋钮」。这里直接复用它，不再写第三套解析。
import { resolveMaxRequests } from '../model/ledger.js';
import { createModelPort, describeModelConfig, type ModelPort } from '../model/port.js';
import { createFileStore, type FileStore, type LoadReport } from '../../../src/storage/index.js';
import type { LogicalTime, Store } from '../../../src/protocol/index.js';
import type { Scheduler } from '../../../src/scheduler/index.js';
import { createDemoRequestHandler } from './http.js';
import { createAdaptersHost, type AdaptersHostOptions } from './adapters-host.js';
import type { ControlledActionExecutor } from './adapters-actions.js';
// FA-WIRE-PRODUCT-ROUTES：三组独立路由模块的产品端口装配（本层是唯一碰 node:fs 的落盘实现处）。
import {
  createConversationLoopWiring,
  createFileMemoryPersistence,
  createPluginRoutesOptions,
  memoryStoreFileOf,
  type ConversationLoopRoutes,
  createFileDocumentStore,
} from './route-wiring.js';
import { createDocumentsRouteHost } from './documents-routes.js';
import { createRolesWiring } from './roles-wiring.js';
// FA-FIX-TAUTOLOGY：会话适配器（时钟 / 日历 + 检索呈现）+ 预算闸门 + 检查点归约的产品接线。
// **只做加法**：本文件其余路径不变。
import {
  createSessionAdaptersBudget,
  createSessionAdaptersWiring,
  describeCheckpointRecoveryLine,
  type SessionAdaptersWiring,
} from './session-adapters-wiring.js';
// N-7-10：把预算闸门从"合成端点"推进到**真实模型 / 工具调用**的边界上（`/api/tool-loop/**`）。
// **只做加法**：`createToolLoopHostForDemo` 的第三个参数省略时，行为与接线前逐字一致。
import {
  createProductBudgetGate,
  gateModelTurnPort,
  gateToolExecutor,
  gateToolLoopHost,
  type ProductBudgetGate,
} from './budget-wiring.js';
import { createMemoryRouteHost, type MemoryRouteHost } from './memory-routes.js';
// FA-KRN-BARREL-CONSUME：`src/scheduler` 桶模块的产品入口（`/api/krn-barrel/**`）。
// **只做加法**：注入**同一个** `host.store`，因此读端点报的是真实运行记录。
import { createKrnBarrelWiring, type KrnBarrelWiring } from './krn-barrel.js';
// FA-KRN-ORPHANS：处置 `src/scheduler` 里 7 个孤儿模块（`/api/krn-orphans/**`）。
// **只做加法**：注入**同一个** `host.store` 与**同一个**模板平台注册表（`/api/plugins/**` 那份），
// 因此能力清单 / 上下文组装 / 提交闸门 / 进展监督 / 队列 / 后台循环读的都是真实状态。
import { createKrnOrphansWiring, type KrnOrphansWiring } from './krn-orphans.js';
// FA-XLS-FACTS-PRODUCT：共享事实 → 表格 → 跨模板发布 的产品交付链宿主（`/api/xls-facts/**`）。
// **不注入任何发布通道**：产品路径上 docx / pptx 恒为结构化 not-wired（不假装可用）。
import { createXlsFactsHost } from './xls-facts-product.js';
// FA-PPT-MEDIA-MOUNT：PPT 媒体路由（`/api/ppt-media/**`）的前缀常量。
// 该路由**零端口、零落盘、零网络**（每个请求自带全部输入），因此**不需要注入任何宿主**：
// http.ts 里按前缀无条件转交即可（与 `/api/ppt-facts` 同形）。这里只把它登记到启动输出，
// 让验收侧能一眼核对前缀确实在产品面上——**没有**"端口缺席 ⇒ 未就绪"这一分支可言。
import { PPT_MEDIA_ROOT } from './ppt-media-harness.js';
import type { PluginRoutesOptions } from './plugin-routes.js';
import {
  ConversationHost,
  type CandidateIdentity,
  type ConversationMemoryBinding,
} from './conversation-host.js';
import { ConversationStore } from './conversation-store.js';
import { createRealExecutor, type RealExecutor } from '../model/executor.js';
// FA-KRN-TOOL-LOOP-PRODUCT：把 KRN-04 的工具循环接到产品运行路径（`/api/tool-loop/**`）。
// 端口在这里装配：模型端口复用 `createRealExecutor()`（同一个 `.env` 配置、同一个额度账本文件），
// 工具执行器落在真实 `DocumentPort` 上（真写盘 + 回读核对）。
import {
  createDocumentToolCatalog,
  createDocumentToolExecutor,
  createModelTurnPortFromExecutor,
  createToolLoopHost,
  type ModelReadiness,
  type ModelCallLog,
  type ToolLoopHost,
} from './tool-loop-product.js';
import { JobIndex, type JobIndexPersistence, type JobIndexState } from './jobs.js';
import { DocumentSessionHost } from './session-host.js';
import { DeliverableHost } from './deliverable-host.js';
import { createXlsPrintHost, type XlsPrintHost } from './xls-print-route.js';
import { decodeSessionState, encodeSessionState } from '../../../src/documents/session/index.js';
import {
  decodeSessionState as decodeDeliverableState,
  encodeSessionState as encodeDeliverableState,
  type DeliverableSessionState,
} from '../../../src/session/index.js';
import {
  KernelHost,
  type BootReport,
  type KernelTrace,
  type KernelTracePersistence,
} from './kernel.js';

// ---------------------------------------------------------------------------
// 路径解析
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 仓库根定位。
 *
 * 构建产物在 `<root>/.runtime/mobile-word-demo/build/apps/demo/server/main.js`，
 * 因此从这里上溯 6 级就是仓库根；若布局变化，再自上而下找 `apps/demo/web/index.html`
 * 兜底（找到的是"确实存在这个布局"的目录，不是猜出来的）。
 */
export function resolveRepoRoot(startDir: string = HERE): string {
  const candidate = resolve(startDir, '..', '..', '..', '..', '..', '..');
  if (existsSync(join(candidate, 'package.json'))) {
    return candidate;
  }
  let cursor = resolve(startDir);
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(cursor, 'apps', 'demo', 'web'))) {
      return cursor;
    }
    const parent = dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// 监听地址（POTBOT_BIND；安全默认闭合）
// ---------------------------------------------------------------------------

/** 未显式设置时的绑定地址：**只监听本机回环**。 */
export const DEFAULT_BIND = '127.0.0.1';

/** 本机 IPv4 字面量（四段 0–255）。 */
const IPV4_LITERAL = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** 主机名（用于允许用户显式写局域网名；不允许含 `/`、空白或 scheme）。 */
const HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

function isIpv4Literal(value: string): boolean {
  const match = IPV4_LITERAL.exec(value);
  if (match === null) {
    return false;
  }
  for (let index = 1; index <= 4; index += 1) {
    const part = match[index];
    if (part === undefined || Number(part) > 255) {
      return false;
    }
  }
  return true;
}

/**
 * 解析 `POTBOT_BIND`。
 *
 * 纪律（主协调者裁定）：
 * - **未设置 ⇒ `127.0.0.1`**（默认绝不开到局域网）；
 * - **显式给出** `0.0.0.0` 或本机 LAN IP ⇒ 按值绑定（手机走同一 Wi-Fi 时才需要）；
 * - **非法值 ⇒ 抛错**（中文原因），**绝不静默回落到 0.0.0.0**——
 *   "写错了就当全开"正是安全默认必须闭合的那一类失效。
 */
export function resolveBindAddress(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env['POTBOT_BIND'];
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_BIND;
  }
  const value = raw.trim();
  if (value === 'localhost') {
    return DEFAULT_BIND;
  }
  if (value === '::1') {
    return value;
  }
  // 全数字点分形态必须**是合法的 IPv4 字面量**才算通过：`999.1.1.1` 这种既不是合法 IP、
  // 也不能当域名接受（否则"写错了"会被静默当成域名绑上去）。
  const allNumericLabels = /^\d+(\.\d+)*$/.test(value);
  if (allNumericLabels) {
    if (isIpv4Literal(value)) {
      return value;
    }
    throw new Error(
      `POTBOT_BIND 的值不合法：${JSON.stringify(raw)}。` +
        '它看起来像 IP 地址但不是合法的 IPv4（每段必须在 0–255 之间）；' +
        '非法值直接启动失败，不回落、不当作域名接受。',
    );
  }
  if (!value.includes('/') && !value.includes(':') && !/\s/.test(value) && HOSTNAME.test(value)) {
    return value;
  }
  throw new Error(
    `POTBOT_BIND 的值不合法：${JSON.stringify(raw)}。` +
      '请填 127.0.0.1、0.0.0.0 或本机 IPv4 地址（例如 192.168.1.10）；' +
      '不接受 scheme、端口、路径或空白。为避免"写错了就对外全开"，非法值直接启动失败，不回落。',
  );
}

/** 本机非回环 IPv4 地址（用于打印手机应访问的 URL；只读，不改任何配置）。 */
export function localIpv4Addresses(): readonly string[] {
  const found: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family === 'IPv4' && !info.internal) {
        found.push(info.address);
      }
    }
  }
  return Object.freeze([...new Set(found)]);
}

export interface DemoPaths {
  readonly repoRoot: string;
  readonly webDir: string;
  readonly runDir: string;
  readonly artifactRootDir: string;
  readonly indexPath: string;
}

/** 解析本次运行的目录布局（环境变量优先，便于开新运行实例）。 */
export function resolveDemoPaths(env: NodeJS.ProcessEnv = process.env): DemoPaths {
  const repoRoot = env['POTBOT_REPO_ROOT'] ?? resolveRepoRoot();
  const webDir = env['POTBOT_WEB_DIR'] ?? join(repoRoot, 'apps', 'demo', 'web');
  const runDir =
    env['POTBOT_RUN_DIR'] ?? join(repoRoot, '.runtime', 'mobile-word-demo', 'MWD-20261002-A');
  // 内核的路径规划固定用 `/` 分隔（planner 的纪律），故产物根也存正斜杠形态。
  const artifactRootDir = toForwardSlashes(join(runDir, 'artifacts'));
  return Object.freeze({
    repoRoot,
    webDir,
    runDir,
    artifactRootDir,
    indexPath: join(runDir, 'app-index.json'),
  });
}

function toForwardSlashes(path: string): string {
  return path.split('\\').join('/');
}

// ---------------------------------------------------------------------------
// 文件持久化（应用索引）
// ---------------------------------------------------------------------------

/**
 * 应用索引的文件持久化：先写临时文件再 rename（不留下半截 JSON）。
 *
 * **这不是内核持久化**：只保存应用层任务索引 / 产物映射 / 额度登记 / 观察记录。
 */
export function createFilePersistence(filePath: string): JobIndexPersistence {
  mkdirSync(dirname(filePath), { recursive: true });
  return {
    save(state: JobIndexState): void {
      const temporary = `${filePath}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      renameSync(temporary, filePath);
    },
    load(): unknown {
      if (!existsSync(filePath)) {
        return null;
      }
      try {
        return JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
      } catch (error) {
        // 索引坏了就按空台账启动，并把原因带出去（不静默吞掉）。
        return {
          schema: 'unreadable',
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 内核事件轨迹落盘
// ---------------------------------------------------------------------------

/**
 * 内核事件轨迹的文件持久化。
 *
 * 位置：`<runDir>/kernel-trace/<taskId>.json`（一任务一文件，**不共用一个大 JSON**——
 * 并发写入不会互相覆盖，独立复核也可以只取其中一个任务）。
 *
 * 形状：`KernelTrace`（`schema = potbot-kernel-trace.v1`），定义见 `kernel.ts`。
 *
 * **这不是内核持久化**：它是内核已提交事实的**只读取证切片**，写它不改变内核状态；
 * 写失败也只是"证据缺失"，不影响任务结论（失败原因经 stderr 如实报出）。
 */
export function createFileTracePersistence(runDir: string): KernelTracePersistence {
  const directory = join(runDir, 'kernel-trace');
  mkdirSync(directory, { recursive: true });
  return {
    save(taskId: string, trace: KernelTrace): void {
      // taskId 是 `T-<hex>`，但仍按"路径段"收窄一次：不信任任何可能进路径的字符。
      const safe = taskId.replace(/[^A-Za-z0-9._-]/g, '_');
      const target = join(directory, `${safe}.json`);
      const temporary = `${target}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(trace, null, 2)}\n`, 'utf8');
      renameSync(temporary, target);
    },
  };
}

// ---------------------------------------------------------------------------
// 端口接入
// ---------------------------------------------------------------------------

export interface PortWiring {
  readonly model: ModelPort | null;
  /**
   * 宿主闸门的每任务额度上限 —— 与模型端口**同源**（都经
   * `apps/demo/model/ledger.ts` 的 `resolveMaxRequests(env)` 解析 `POTBOT_MODEL_MAX_REQUESTS`）。
   * 显式设了 24 就必须是 24；不设时是该模块的默认值（12）。
   */
  readonly modelBudgetLimit: number;
  /** `/health.modelConfigured` 的唯一来源：S4 的 `describeModelConfig(env).configured`。 */
  readonly modelConfigured: boolean;
  /** S4 的脱敏调用账本路径（`/health.modelVerified` 的第二依据；缺失时为 null）。 */
  readonly ledgerPath: string | null;
  readonly modelIsLive: boolean;
  readonly documents: DocumentPort | null;
  readonly notes: readonly string[];
}

/**
 * 接上 S4 / S5 的真实端口。
 *
 * 端口构造失败**不是**错误路径而是如实状态：`createModelPort()` 在未配置模型时抛错，
 * 这里捕获后把 `model` 保持为 `null`，`/health` 的 `modelConfigured` 因此如实为 `false`。
 * **绝不**用假端口顶替（那会把"没配置"伪装成"能用"）。
 */
export function wirePorts(paths: DemoPaths, env: NodeJS.ProcessEnv = process.env): PortWiring {
  const notes: string[] = [];
  let model: ModelPort | null = null;
  let documents: DocumentPort | null = null;
  let modelConfigured = false;
  let ledgerPath: string | null = null;
  let modelBudgetLimit = resolveMaxRequests(env);

  // `modelConfigured` 只反映**配置存在**（主协调者裁定：用 S4 的 describeModelConfig）。
  try {
    const config = describeModelConfig(env);
    modelConfigured = config.configured;
    ledgerPath = config.ledgerPath;
    // 同源交叉核对：模型端口的配置里也带着同一个上限。两处不一致说明解析被谁改过分叉了，
    // 宁可当场说出来（这正是"宿主硬编码 12"那个缺陷的同型风险）。
    if (config.maxRequests !== modelBudgetLimit) {
      notes.push(
        `⚠ 额度上限来源分叉：resolveMaxRequests=${String(modelBudgetLimit)}、` +
          `describeModelConfig.maxRequests=${String(config.maxRequests)}；` +
          `以 resolveMaxRequests 为准，请检查 POTBOT_MODEL_MAX_REQUESTS 的解析`,
      );
    }
    modelBudgetLimit = config.maxRequests;
    notes.push(
      `模型配置：configured=${String(config.configured)} provider=${config.provider} ` +
        `model=${config.model} maxRequests=${String(config.maxRequests)}${
          config.missing.length === 0 ? '' : `；缺：${config.missing.join('、')}`
        }`,
    );
  } catch (error) {
    notes.push(
      `模型配置无法解析（${describeError(error)}）：configured 如实为 false；` +
        `额度上限仍按 resolveMaxRequests 取 ${String(modelBudgetLimit)}`,
    );
  }

  try {
    model = createModelPort(env);
    notes.push(`模型端口已接入：provider=${model.provider} model=${model.model}`);
  } catch (error) {
    notes.push(
      `模型端口未建立（${describeError(error)}）：受理会明确失败，绝不用假端口顶替`,
    );
  }

  try {
    documents = createDocumentPort(paths.artifactRootDir);
    notes.push(`文档端口已接入：产物根 ${paths.artifactRootDir}`);
  } catch (error) {
    notes.push(
      `文档端口构造失败（${describeError(error)}）：无法写盘，任务会如实失败而不是伪造文件`,
    );
  }

  return Object.freeze({
    model,
    modelBudgetLimit,
    modelConfigured,
    ledgerPath,
    // 构造成功的真实端口才置 live；进程内真实调用成功后才置 modelVerified。
    modelIsLive: model !== null,
    documents,
    notes: Object.freeze(notes),
  });
}

/** 内核状态加载结果的一行如实描述（内存实现如实说"无加载步骤"，不冒充）。 */
function describeStoreLoad(report: LoadReport | null): string {
  if (report === null) {
    return '内存实现（无加载步骤；重启即空）';
  }
  const parts = [report.reason];
  if (report.orphanTemporary) {
    parts.push('发现**从未提交**的残留 .tmp（上次在 rename 前中断），已忽略');
  }
  if (report.brokeStaleLock) {
    parts.push('上次持锁进程未正常退出，已按陈旧阈值打破写锁');
  }
  return parts.join('；');
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

// ---------------------------------------------------------------------------
// 组装与启动
// ---------------------------------------------------------------------------

/**
 * 构造**内核状态**的落盘存储（KRN-10；R214–R220）。
 *
 * 位置：`<runDir>/kernel-store/store.json`（与应用索引、会话状态**各占各的文件**，
 * 互不覆盖）；同目录另有两个由存储自己管理的同名文件：`.tmp`（原子写的临时件）与
 * `.lock`（跨进程写锁）。
 *
 * ## 为什么必须落盘（而不是"顺手把 Map 存一下"）
 *
 * 落盘前，宿主重启后内核里没有消息、任务、轮次与工作项——`boot()` 只能把在途任务
 * 标成 `interrupted` 并**如实声明"应用索引持久化不等于内核运行恢复"**。有了这份存储，
 * 重启后内核状态本身回来了，`interrupted` 才是真正的"这次确实中断了"而不是"内核本来就空"。
 *
 * ## 失败时**拒绝启动**
 *
 * 文件存在但读不回来（坏 JSON / schema 不符）时 `createFileStore` 默认抛错。
 * 这是刻意的：静默按空状态起会把"数据读丢了"伪装成"服务正常"，而那正是 R216/R240 那一类陷阱。
 *
 * @throws {PersistenceError} 状态文件存在但无法还原，且未显式选择放弃。
 */
export function createKernelStore(paths: DemoPaths): FileStore {
  return createFileStore({
    filePath: join(paths.runDir, 'kernel-store', 'store.json'),
    // ── 墙钟与进程身份的**默认实现**：按合同 R50.4 刻意放在这里 ──
    // `src/**` 禁止调用墙钟（`Date.now(` / `new Date(` / `process.pid` 都是禁用 token），
    // 而跨进程锁的新鲜度与超时**必须**用真实时间。所以由宿主注入：
    // 本文件在 `apps/**`，不在内核纪律的扫描范围内。
    // 二者必须**同源同基准**——锁文件里记的 `at` 与判活用的 `now()` 是同一把毫秒墙钟，
    // 否则不同进程写下的时刻无法互相比较（这正是"注入"而不是"随便给个默认"的原因）。
    now: () => Date.now(),
    lockOwner: `pid:${String(process.pid)}`,
  });
}

/**
 * 运行 id：**由运行目录名派生**（R219）。
 *
 * 为什么不是写死的 `'MWD-20261002-A'`：那正是 R219 记下的坑——`POTBOT_RUN_DIR` 改了
 * **不会**自动改变验收侧读取的 runId，于是"宿主跑在 A 目录、报告说自己是 B"这种事
 * 会静默发生，宿主与验证者再也核对不上同一个候选。运行目录名本来就是本次运行的
 * **唯一身份**（每次都不同），让它当 runId 是唯一自洽的做法。
 */
export function runIdOf(paths: DemoPaths): string {
  const parts = paths.runDir.replace(/[\\/]+$/, '').split(/[\\/]/);
  const last = parts[parts.length - 1];
  return last === undefined || last.trim() === '' ? 'unknown-run' : last.trim();
}

/**
 * 构造应用台账（**上限与模型端口同源**）。
 *
 * 抽成独立函数是为了让它**可被测试直接盯住**：主协调者的集成实测中，宿主曾在这里漏掉
 * `budgetLimit`，于是硬编码的 12 覆盖了显式设置的 24 —— 一个"文档写了却不起作用的旋钮"。
 * 现在上限只从 `wiring.modelBudgetLimit`（`resolveMaxRequests` 的产物）来，且这个函数的
 * 产物被测试断言为 24 / 12 / 12（见 `main.test.ts`）。
 */
export function createJobIndex(
  paths: DemoPaths,
  wiring: Pick<PortWiring, 'modelBudgetLimit'>,
  env: NodeJS.ProcessEnv = process.env,
): JobIndex {
  void env;
  return new JobIndex({
    persistence: createFilePersistence(paths.indexPath),
    runId: runIdOf(paths),
    budgetLimit: wiring.modelBudgetLimit,
  });
}

/**
 * 连续对话的**落盘目录**（一会话一文件）。
 *
 * 与 `sessions/`、`kernel-store/`、`app-index.json` 各占各的路径，互不覆盖。
 */
export function conversationDirOf(paths: DemoPaths): string {
  return join(paths.runDir, 'conversations');
}

/**
 * 连续对话宿主（FA-N）。
 *
 * `documents === null` 时仍然建立宿主：它会把"文档端口未接入"作为**工具的结构化失败**
 * 如实回给模型（而不是假装能写文件）。执行器未配置时同理——消息被如实标失败。
 */
export function createConversationHost(
  paths: DemoPaths,
  wiring: PortWiring,
  env: NodeJS.ProcessEnv,
  kernelStore: Store,
  identityBase: { readonly port: number; readonly bind: string; readonly buildId: string; readonly bootId: string },
  /**
   * 内核轮次接线（加法；FA-CHAT-PRODUCT-LOOP）。给出后每轮对话经内核 scheduler 起
   * **真实轮次**并落**真实工作项**，完成口径因此能对会话任务给出真实结论；
   * 省略 ⇒ 与接线前逐字一致（不产生轮次 / 工作项）。
   */
  kernelLoop?: { readonly scheduler: Scheduler; readonly logicalNow: () => LogicalTime } | null,
  /**
   * 记忆接线（FA-MEM-INTO-CHAT，**加法**）。给出后每轮对话结束都经既有
   * `writeMemoryRecord` 把用户消息 / 助手回复 / 任务事实写进**同一个**记忆仓库
   * （`memoryRoutes` 那一份，不建第二份账本），并把已记住的记忆并进对话上下文；
   * owner 由会话 id 稳定派生（见 `ownerIdForConversation`）。省略 ⇒ 与接线前逐字一致。
   */
  memory?: ConversationMemoryBinding | null,
): ConversationHost {
  const directory = conversationDirOf(paths);
  mkdirSync(directory, { recursive: true });
  const safe = (value: string): string => value.replace(/[^A-Za-z0-9._-]/g, '_');
  const persistence = (conversationId: string): { save(state: unknown): void; load(): unknown } => {
    const file = join(directory, `${safe(conversationId)}.json`);
    return {
      save(state: unknown): void {
        const temporary = `${file}.tmp`;
        writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
        renameSync(temporary, file);
      },
      load(): unknown {
        if (!existsSync(file)) {
          return null;
        }
        try {
          return JSON.parse(readFileSync(file, 'utf8')) as unknown;
        } catch (error) {
          // 读不回来就**如实**返回"坏掉的形状"，让存储层整份拒绝（不静默按空状态起）。
          return { schema: 'unreadable', reason: describeError(error) };
        }
      },
    };
  };

  const store = new ConversationStore({
    persistence,
    directory: {
      list: (): readonly string[] =>
        existsSync(directory)
          ? readdirSync(directory)
              .filter((name) => name.endsWith('.json'))
              .map((name) => name.slice(0, -'.json'.length))
          : [],
    },
    now: () => new Date(),
  });

  let executor: RealExecutor | null = null;
  try {
    executor = createRealExecutor({ env });
  } catch (error) {
    // 未配置模型不是错误路径而是如实状态：对话照样收消息，执行时如实标失败。
    void error;
  }

  const identity: CandidateIdentity = Object.freeze({
    runId: runIdOf(paths),
    runDir: paths.runDir,
    port: identityBase.port,
    bind: identityBase.bind,
    repoRoot: paths.repoRoot,
    buildId: identityBase.buildId,
    bootId: identityBase.bootId,
    artifactRootDir: paths.artifactRootDir,
    kernelStorePath: join(paths.runDir, 'kernel-store', 'store.json'),
    conversationDir: directory,
    provider: executor?.provider ?? null,
    model: executor?.model ?? null,
  });

  return new ConversationHost({
    store,
    kernelStore,
    documents: wiring.documents,
    executor,
    runId: identity.runId,
    artifactRootDir: paths.artifactRootDir,
    identity,
    // 加法接线：与 KernelHost **同一个** scheduler（事件 id / 轮次 / 工作项同一个真相源）。
    scheduler: kernelLoop?.scheduler ?? null,
    ...(kernelLoop === undefined || kernelLoop === null
      ? {}
      : { logicalNow: kernelLoop.logicalNow }),
    // 记忆接线（加法）：没给 ⇒ `null` ⇒ 不写、不注入（与接线前逐字一致）。
    memory: memory ?? null,
  });
}

export interface DemoServer {
  readonly server: Server;
  readonly host: KernelHost;
  readonly jobs: JobIndex;
  /** 文档会话宿主（编辑链）；物化端口未接入时为 `null`（会话路由如实 503）。 */
  readonly sessions: DocumentSessionHost | null;
  /** 交付会话宿主（表格 / 演示的产品入口）；物化端口未接入时为 `null`。 */
  readonly deliverables: DeliverableHost | null;
  /** 连续对话宿主（FA-N；合同 R207–R209 / H2）。 */
  readonly conversations: ConversationHost;
  /**
   * 记忆管理入口（FA-WIRE-PRODUCT-ROUTES；`/api/memory/**`）的宿主。
   *
   * 端口是**文件落盘**的 `MemoryPersistencePort`（`<runDir>/memory/memory-store.json`）；
   * 暴露出来是为了让验收侧能核对"写一条 → 换服务实例仍在"确实走的是同一条落盘链。
   */
  readonly memoryRoutes: MemoryRouteHost;
  /** 模板平台入口（FA-WIRE-PRODUCT-ROUTES；`/api/plugins/**`）的装配（文件落盘的 store）。 */
  readonly pluginRoutes: PluginRoutesOptions;
  /** 连续对话闭环入口（FA-WIRE-PRODUCT-ROUTES；`/api/conversation-loop/**`）的装配。 */
  readonly conversationLoop: ConversationLoopRoutes;
  /**
   * 会话适配器入口（FA-FIX-TAUTOLOGY；`/api/session-adapters/**`）的接线。
   *
   * 暴露出来是为了让验收侧能核对"产品路径确实注入了内核 store 与预算闸门"，
   * 而不是只在路由模块的单测里可达。
   */
  readonly sessionAdapters: SessionAdaptersWiring;
  /**
   * 内核桶入口（FA-KRN-BARREL-CONSUME；`/api/krn-barrel/**`）的接线。
   *
   * 暴露出来是为了让验收侧能核对"产品路径确实注入了**同一个**内核 store"（读端点报的是真实运行记录）。
   */
  readonly krnBarrel: KrnBarrelWiring;
  /**
   * XLSX 打印设置入口（FA-XLS-PRINT-ROUTE；`/api/xls-print/**`）的宿主。
   *
   * 暴露出来是为了让验收侧能核对"产品路径确实注入了**同一个** `DocumentPort`"，
   * 且**没有装配任何消费端**（打印结论上限「已交接」）。
   */
  readonly xlsPrint: XlsPrintHost;
  /**
   * 孤儿模块处置入口（FA-KRN-ORPHANS；`/api/krn-orphans/**`）的接线。
   *
   * 暴露出来是为了让验收侧能核对"产品路径确实注入了**同一个**内核 store 与**同一个**模板平台
   * 注册表"（能力清单 / 提交闸门 / 队列读的都是真实状态）；`stopWorker()` 供宿主优雅收尾。
   */
  readonly krnOrphans: KrnOrphansWiring;
  /** R219：本次运行**实际生效**的身份（端口 / 运行目录 / 运行 id / 构建 id）。 */
  readonly identity: CandidateIdentity;
  readonly paths: DemoPaths;
  readonly port: number;
  /** 实际绑定地址（`POTBOT_BIND`；未设置时为 `127.0.0.1`）。 */
  readonly bind: string;
  readonly wiring: PortWiring;
  readonly boot: BootReport;
}

/**
 * 构造文档会话宿主（编辑链）。
 *
 * **端口不在 ⇒ 宿主为 `null`**：会话路由会如实返回 503，而不是退回"直接写文件"。
 * 会话状态落 `<runDir>/sessions/<sessionId>.json`（与生成链的应用索引同一运行目录、
 * 各占各的文件，互不覆盖）。
 */
export function createSessionHost(paths: DemoPaths, wiring: PortWiring): DocumentSessionHost | null {
  if (wiring.documents === null) {
    return null;
  }
  const sessionDir = join(paths.runDir, 'sessions');
  mkdirSync(sessionDir, { recursive: true });
  return new DocumentSessionHost({
    documents: wiring.documents,
    artifact_root_dir: paths.artifactRootDir,
    run_id: runIdOf(paths),
    session_persistence: (sessionId: string) => {
      const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
      const file = join(sessionDir, `${safe}.json`);
      return {
        save(state: unknown): void {
          // 会话状态里有**二进制**（未改动部件的原始字节，R105/R151）⇒ 必须经会话包的
          // 编解码器：裸 `JSON.stringify` 会把 Uint8Array 写成数字键对象，读回时悄悄毁模型
          // （`persistence.ts` 头部记了这次实测教训）。
          const temporary = `${file}.tmp`;
          writeFileSync(temporary, `${JSON.stringify(encodeSessionState(state))}\n`, 'utf8');
          renameSync(temporary, file);
        },
        load(): unknown {
          if (!existsSync(file)) {
            return null;
          }
          try {
            return decodeSessionState(JSON.parse(readFileSync(file, 'utf8'))) as unknown;
          } catch {
            // 坏了就按"读不回来"如实返回；会话宿主据此拒绝恢复，不静默拿半截状态继续。
            return { schema: 'unreadable' };
          }
        },
      };
    },
  });
}

/**
 * 构造**工具循环宿主**（FA-KRN-TOOL-LOOP-PRODUCT；`/api/tool-loop/**`）。
 *
 * ## 两个端口都**如实装配**，缺一个就说缺一个
 *
 * - **模型端口**：`createRealExecutor({ env })` 的产物（与连续对话链**同一份 `.env` 配置**、
 *   同一个额度账本文件）。未配置模型 ⇒ 捕获后为 `null`，`/run` 结构化 503 `not_ready`，
 *   **绝不用桩顶替**。
 * - **工具执行器**：`DocumentPort` 存在时构造真实执行器（真写盘 + 回读核对）；不存在 ⇒ `null`。
 *
 * ## 诚实边界（**未验证**项，不得当结论引用）
 *
 * - 本函数为工具循环**另建一个** `RealExecutor` 实例。它与连续对话链的执行器
 *   **共用账本文件**（`model-ledger.jsonl`），因此额度是全进程同源的；但两个
 *   `ModelBudget` 各自在首次 `reserve` 时从文件恢复用量，**同进程并发**下不排除重复读的窗口。
 *   "两个执行器实例共享额度"这一点**未做并发实测**。
 * - 适配器不主动取消：客户端断开 ⇒ 循环中止这一条**未接线**（见模块头）。
 */
export function createToolLoopHostForDemo(
  wiring: Pick<PortWiring, 'documents'>,
  env: NodeJS.ProcessEnv = process.env,
  /**
   * 预算闸门（N-7-10，**加法**）。给出后，模型端口与工具执行器各包一层**事前闸门**：
   * 每次真实模型往返 / 工具执行之前先过 `ProductBudgetGate.admit()`——拒绝即**不发出**。
   * 省略 ⇒ 与接线前逐字一致（不设闸门）。
   */
  budgetGate: ProductBudgetGate | null = null,
): ToolLoopHost {
  const catalog = createDocumentToolCatalog();

  let readiness: ModelReadiness | null = null;
  try {
    const config = describeModelConfig(env);
    readiness = Object.freeze({
      configured: config.configured,
      provider: config.provider,
      model: config.model,
      missing: Object.freeze([...config.missing]),
    });
  } catch {
    readiness = null;
  }

  let modelPort: ToolLoopHost['modelPort'] = null;
  let modelCallLog: ModelCallLog | null = null;
  try {
    const executor = createRealExecutor({ env });
    const instrumented = createModelTurnPortFromExecutor(executor, catalog, {
      // 只有 `createRealExecutor()` 的产物才配声明 true（适配器会拒绝 fake-scripted）。
      real_executor: true,
      taskId: 'T-tool-loop',
      conversationId: 'tool-loop',
    });
    // 事前闸门（N-7-10）：模型往返在**发出之前**先过 `admit('model')`。
    modelPort =
      budgetGate === null
        ? instrumented.port
        : gateModelTurnPort(instrumented.port, budgetGate, { subject: 'tool-loop', label: 'model-turn' });
    modelCallLog = instrumented.log;
  } catch {
    // 未配置模型不是错误路径而是如实状态：宿主照建，`/run` 会结构化 503 `not_ready`。
    modelPort = null;
    modelCallLog = null;
  }

  const rawToolExecutor =
    wiring.documents === null ? null : createDocumentToolExecutor({ documents: wiring.documents });
  // 事前闸门（N-7-10）：工具执行在**运行之前**先过 `admit('tool')`；拒绝 ⇒ 结构化回执、不执行。
  const toolExecutor =
    rawToolExecutor === null || budgetGate === null
      ? rawToolExecutor
      : gateToolExecutor(rawToolExecutor, budgetGate, { subject: 'tool-loop' });

  const host = createToolLoopHost({
    catalog,
    modelPort,
    toolExecutor,
    modelReadiness: readiness,
    modelCallLog,
  });
  // 整轮闸门（N-7-10，加法）：`/run` 之前再过一道 `task_calls`——耗尽 ⇒ 干净 429、未装配 ⇒ 503。
  return budgetGate === null ? host : gateToolLoopHost(host, budgetGate);
}

/**
 * 构造**交付会话宿主**（design-06 P8/P9：表格 / 演示的产品入口）。
 *
 * 与 {@link createSessionHost} 同一套纪律：**端口不在 ⇒ 宿主为 `null`**，
 * 交付路由如实返回 503，而不是退回"直接写文件"。
 *
 * 会话状态落 `<runDir>/deliverables/<sessionId>.json`（与 `sessions/`、`kernel-store/`、
 * `conversations/` 各占各的路径，互不覆盖）。状态里有**二进制与 Map**
 * （表格的 `ReadonlyMap` 单元格、R249 保留部件的原始字节）⇒ 必须经 `src/session` 的
 * 编解码器，裸 `JSON.stringify` 会把它们悄悄毁掉。
 *
 * **内核存储与主内核是同一份**（FA-DELIVERABLE-RESTART）：交付任务 / 产物 / 工作项因此
 * 落在 `<runDir>/kernel-store/store.json` 里，与内核其余记录**同一份落盘真相源**——
 * 不另开账本（与 {@link createConversationHost} 共享 `host.store` 是同一条纪律）。
 * 省略 `store` 时交付宿主退回进程内存储（单进程 / 测试用），但那**不是**生产接线。
 */
export function createDeliverableHost(
  paths: DemoPaths,
  wiring: PortWiring,
  store: Store,
): DeliverableHost | null {
  if (wiring.documents === null) {
    return null;
  }
  const directory = join(paths.runDir, 'deliverables');
  mkdirSync(directory, { recursive: true });
  return new DeliverableHost({
    documents: wiring.documents,
    artifact_root_dir: paths.artifactRootDir,
    run_id: runIdOf(paths),
    store,
    session_persistence: (sessionId: string) => {
      const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
      const file = join(directory, `${safe}.json`);
      return {
        save(state: DeliverableSessionState): void {
          const temporary = `${file}.tmp`;
          writeFileSync(temporary, `${JSON.stringify(encodeDeliverableState(state))}\n`, 'utf8');
          renameSync(temporary, file);
        },
        load(): unknown {
          if (!existsSync(file)) return null;
          try {
            return decodeDeliverableState(JSON.parse(readFileSync(file, 'utf8'))) as unknown;
          } catch {
            return { schema: 'unreadable' };
          }
        },
      };
    },
  });
}

/**
 * `createDemoServer` 的**显式装配**选项（FA-FIX-DEFAULT-EXECUTOR，P0）。
 *
 * 只有一件事：把**受控执行器**交给适配器动作台账。**省略 ⇒ 缺省 fail-closed**
 *（`server.executor.unwired`：`/execute` 不签发令牌、不得 `confirmed_complete`）。
 * 测试 / 真实装配显式传入（如 `createLocalAdapterExecutor()` 或真实设备执行器）
 * 才恢复"注入执行器 ⇒ 可确认完成"的正向能力。
 */
export interface DemoServerOptions {
  /** 受控执行器（见 `adapters-actions.ts`）；省略 ⇒ 缺省 fail-closed 存根。 */
  readonly adapterExecutor?: ControlledActionExecutor;
}

export async function createDemoServer(
  env: NodeJS.ProcessEnv = process.env,
  options: DemoServerOptions = {},
): Promise<DemoServer> {
  // 先解析监听地址：非法值必须在**创建任何目录之前**就失败（安全默认闭合）。
  const bind = resolveBindAddress(env);
  const paths = resolveDemoPaths(env);
  mkdirSync(paths.runDir, { recursive: true });
  mkdirSync(paths.artifactRootDir.replace(/\//g, sep()), { recursive: true });

  const wiring = wirePorts(paths, env);

  const jobs = createJobIndex(paths, wiring, env);

  // 内核状态的落盘存储：读不回来时**抛错拒绝启动**（不静默按空台账起）。
  const store = createKernelStore(paths);

  const buildId = `potbot-demo-${CONTRACT_VERSION}-${String(Date.now())}`;
  const host = new KernelHost({
    jobs,
    store,
    runDir: paths.runDir,
    artifactRootDir: paths.artifactRootDir,
    model: wiring.model,
    modelConfigured: wiring.modelConfigured,
    ledgerPath: wiring.ledgerPath,
    modelIsLive: wiring.modelIsLive,
    documents: wiring.documents,
    traces: createFileTracePersistence(paths.runDir),
    buildId,
  });

  const boot = await host.boot();

  const sessions = createSessionHost(paths, wiring);

  // 交付会话宿主（design-06 P8/P9）：表格与演示经**同一条**内核发布链交付。
  // 内核存储与 `KernelHost` **是同一份**（FA-DELIVERABLE-RESTART）：交付产物的任务 /
  // 产物 / 工作项与内核其余记录落同一个文件，重启后交付会话与其版本历史因此读得回来。
  const deliverables = createDeliverableHost(paths, wiring, host.store);

  // 端口在**建宿主之前**解析：R219 要求身份里的端口是**实际生效**的那个，
  // 而不是一个"文档上写的默认值"。
  const port = Number.parseInt(env['POTBOT_PORT'] ?? String(DEFAULT_PORT), 10);
  const health = host.health();

  // 连续对话宿主（FA-N）。内核存储与 KernelHost **是同一份**：对话产物的
  // published 记录要落在同一个真相源里，不能另开一个账本。
  //
  // 记忆接线（FA-MEM-INTO-CHAT，**加法**）：`memoryHostRef` 是个"稍后填"的引用——
  // `memoryRoutes` 在下面三组路由的装配块里才构造，而对话宿主在这里就要传入接缝。
  // 二者共用**同一个** `memoryRoutes` 仓库（不建第二份账本）；引用只为避开构造顺序，
  // 真正 `open()` 发生在每轮对话时（那时引用早已填好）。
  let memoryHostRef: MemoryRouteHost | null = null;
  const conversationMemory: ConversationMemoryBinding = {
    open: () => {
      const routes = memoryHostRef;
      if (routes === null) {
        return null;
      }
      const access = routes.open();
      return access.ok ? access.repository : null;
    },
    // owner 来源用默认的 `ownerIdForConversation`（会话 id 稳定派生，不编造用户身份）。
    persist: (at) => {
      memoryHostRef?.persist(at);
    },
  };
  const conversations = createConversationHost(
    paths,
    wiring,
    env,
    host.store,
    {
      port,
      bind,
      buildId,
      bootId: health.bootId,
    },
    // 加法接线（FA-CHAT-PRODUCT-LOOP）：会话轮次接进内核的真实轮次 / 工作项。
    { scheduler: host.scheduler, logicalNow: (): LogicalTime => host.logicalNow() },
    // 加法接线（FA-MEM-INTO-CHAT）：每轮写记忆 + 注入已记住的记忆。
    conversationMemory,
  );

  // 重启诚实归位（R215/R216/R217）：把上一进程在途的消息标成失败（可重试），
  // **不盲目重放**（那会重复外部副作用）。
  const interruptedMessages = conversations.reconcileAfterRestart();
  if (interruptedMessages.length > 0) {
    process.stdout.write(
      `对话重启自检：${String(interruptedMessages.length)} 条在途消息已如实标为失败（未重放，可重试）\n`,
    );
  }

  // 适配器产品入口（FA-X）：时钟 / 日历 / 美团的 HTTP 入口（/api/adapters/**）。
  // **不传任何端口** —— 这是产品路径：凡依赖真机/A 装配的能力一律如实"未就绪/阻塞"，
  // 不在宿主里塞假端口冒充可用。（测试夹具才注入端口。）
  // **传的是内核 store**：动作账本写进 `Store.actions`（持久），不是进程内内存账本。
  //
  // 受控执行器（FA-FIX-DEFAULT-EXECUTOR，P0）：产品路径**默认不注入执行器** ⇒ 缺省执行器
  // 是 fail-closed 的 `server.executor.unwired`（一律 `unknown`）⇒ `/execute` **不签发令牌**、
  // 不得 `confirmed_complete`。要保留"注入执行器 ⇒ 可确认完成"的能力，由 `createDemoServer`
  // 的 `adapterExecutor` 选项**显式装配**（`startDemoServer` 不传 ⇒ 产品基线 fail-closed）。
  const adapterExecutor = options.adapterExecutor;
  const adaptersOptions: AdaptersHostOptions = {
    store: host.store,
    ...(adapterExecutor === undefined ? {} : { executor: adapterExecutor }),
  };
  const adapters = createAdaptersHost(adaptersOptions);

  // 三组独立路由的产品端口装配（FA-WIRE-PRODUCT-ROUTES）。**三者都注入真实端口**：
  // - 记忆：文件落盘的 MemoryPersistencePort（独立文件 `memory/memory-store.json`）；
  // - 模板：文件落盘的 InstallStateStore（独立文件 `plugins/plugin-store.json`，并先 reload）；
  // - 对话闭环：目录端口直接读**同一个** `host.store`（不新建第二份账本）。
  const memoryRoutes = createMemoryRouteHost({
    persistence: createFileMemoryPersistence(memoryStoreFileOf(paths.runDir)),
  });
  // 记忆接线（FA-MEM-INTO-CHAT，**加法**）：把上面已构造好的仓库交给对话宿主
  // （`ConversationHost` 在此之前的构造期只拿到引用，真正 open 发生在每轮对话时）。
  memoryHostRef = memoryRoutes;
  const pluginRoutes = createPluginRoutesOptions(paths.runDir);
  const conversationLoop = createConversationLoopWiring(host.store, runIdOf(paths));
  // 文档产物端口（文件落盘）；检索路由本机无联网/OCR 端口 => 各段如实未就绪，不伪造
  const documentsRoutes = createDocumentsRouteHost({
    store: createFileDocumentStore(join(paths.runDir, 'documents')),
  });
  const researchRoutes = {};
  // 共享事实绑定的表格交付宿主（FA-XLS-FACTS-PRODUCT）：**不注入任何发布通道**，
  // 因此产品路径上向 docx / pptx 的发布会如实给出结构化 not-wired。
  const xlsFacts = createXlsFactsHost({});
  // 三种基础角色：**复用** memoryRoutes 打开的同一个仓库（不新建第二份记忆真相源）
  const memoryAccess = memoryRoutes.open();
  const rolesWiring = createRolesWiring({
    store: host.store,
    repository: memoryAccess.ok ? memoryAccess.repository : null,
  });
  // 预算闸门装配（N-7-10）：**一处装配、两处共用**——工具循环的真实模型 / 工具调用与会话适配器
  // 的 `/tool-call` 用**同一个** `ProductBudgetWiring`（同一本台账、同一条落盘流水），
  // 免得两份台账各记一半、重启收敛时互相打架。八维上限没给全 ⇒ 如实"未装配"，
  // 而**不是**退回"不设限"。
  const sessionBudget = createSessionAdaptersBudget(env, paths.runDir);
  const budgetGate = createProductBudgetGate(sessionBudget.budget, sessionBudget.reason);

  // 工具循环产品入口（FA-KRN-TOOL-LOOP-PRODUCT）：真实模型端口 + 真实工具执行器。
  // 加法接线（N-7-10）：模型往返 / 工具执行在**发出之前**过预算闸门（拒绝 ⇒ 结构化拒、不发请求）。
  const toolLoop = createToolLoopHostForDemo(wiring, env, budgetGate);

  // 会话适配器产品入口（FA-FIX-TAUTOLOGY，`/api/session-adapters/**`）。**注入真实端口**：
  // - 内核 store ⇒ 检查点端点读 / 写**同一个**内核账本（不新建第二份）；
  // - 预算闸门由 `POTBOT_BUDGET_*` 装配；八维上限没给全 ⇒ 如实"未装配"（`/tool-call` 503），
  //   而**不是**退回"不设限"；
  // - 自管提醒快照落 `<runDir>/session-adapters/alarms.json`。
  // **不传任何真机端口**：系统时钟 / 日历段一律如实未就绪（产品基线）。
  // `sessionBudget` 在工具循环之前就已装配（N-7-10：两处共用同一份接线）。
  const sessionAdapters = createSessionAdaptersWiring({
    runDir: paths.runDir,
    store: host.store,
    budget: sessionBudget.budget,
    budgetUnwiredReason: sessionBudget.reason,
  });

  // 内核桶入口（FA-KRN-BARREL-CONSUME，`/api/krn-barrel/**`）。**注入同一个内核 store**：
  // 必录审计 / 重启高水位 / 预算已提交事实三个读端点因此报的是**真实运行记录**；
  // 写端点的内存状态不落盘（诚实边界见 `krn-barrel.ts` 头部）。
  const krnBarrel = createKrnBarrelWiring({ store: host.store });

  // XLSX 打印设置产品入口（FA-XLS-PRINT-ROUTE，`/api/xls-print/**`）。**注入同一个 `DocumentPort`**：
  // 打印产物的字节落进交付宿主用的**同一个**产物根（`<root>/<artifactId>/<filename>`），
  // 不另建第二份产物账；**不装配任何消费端** ⇒ `/confirm` 一律拒绝"已打印"（上限「已交接」）。
  const xlsPrint = createXlsPrintHost({ documents: wiring.documents });
  // 孤儿模块处置入口（FA-KRN-ORPHANS，`/api/krn-orphans/**`）。**注入真实状态**：
  // - **同一个** `host.store` ⇒ 产物版本闸门 / 进展诊断 / 工作队列读的都是真实运行记录；
  // - **同一个**模板平台注册表（`/api/plugins/**` 用的那个 `InstallSourceManager.pluginRegistry`）
  //   ⇒ 能力清单与按需组装随安装 / 启用 / 授权的真实变化而变；
  // - 逻辑时间与宿主同源（`host.logicalNow()`）。
  // 探针走模块默认（内置构建器依赖就绪、**实测支持恒假**——不代签实测结论）；
  // 后台工作循环默认不启动，且默认执行器是"未装配"（由 `worker_executor` 注入真执行器）。
  const krnOrphans = createKrnOrphansWiring({
    store: host.store,
    registry: pluginRoutes.manager?.pluginRegistry ?? null,
    logical_now: () => host.logicalNow(),
  });

  const server = createServer(
    createDemoRequestHandler({
      host,
      webDir: paths.webDir,
      adapters,
      sessions,
      conversations,
      deliverables,
      memoryRoutes,
      pluginRoutes,
      conversationLoop,
      documentsRoutes,
      researchRoutes,
      rolesWiring,
      xlsFacts,
      toolLoop,
      sessionAdapters,
      krnBarrel,
      xlsPrint,
      krnOrphans,
      identity: () => conversations.identity(),
    }),
  );

  return Object.freeze({
    server,
    host,
    jobs,
    sessions,
    conversations,
    deliverables,
    memoryRoutes,
    pluginRoutes,
    conversationLoop,
    sessionAdapters,
    krnBarrel,
    xlsPrint,
    krnOrphans,
    paths,
    port,
    bind,
    wiring,
    boot,
    identity: conversations.identity(),
  });
}

/** 启动并把启动事实打到 stdout（不含任何密钥）。 */
export async function startDemoServer(env: NodeJS.ProcessEnv = process.env): Promise<DemoServer> {
  const created = await createDemoServer(env);
  await new Promise<void>((resolvePromise, reject) => {
    created.server.once('error', reject);
    created.server.listen(created.port, created.bind, () => {
      resolvePromise();
    });
  });
  const health = created.host.health();
  const boot = created.boot;
  const reachable = reachableUrls(created.bind, created.port);
  process.stdout.write(
    [
      'potbot 手机 Word Demo 服务已启动',
      `  绑定：${created.bind}:${String(created.port)}（POTBOT_BIND 未设置时默认 ${DEFAULT_BIND}）`,
      ...reachable.map((url) => `  可访问：${url}`),
      created.bind === DEFAULT_BIND
        ? '  注意：当前只监听本机回环。手机要走同一 Wi-Fi 时，请以 POTBOT_BIND=0.0.0.0 重启，' +
          '再用上面的局域网地址访问（密钥始终只留在电脑，服务不向页面转发任何密钥）'
        : '  注意：已按 POTBOT_BIND 开放到局域网地址；密钥仍只留在电脑。只在你信任的网络上这样用。',
      // R219：**实际生效**的身份必须看得见——`POTBOT_PORT`/`POTBOT_RUN_DIR` 改了不会自动
      // 改变验收侧读取的地址与 runId，所以宿主主动报出来，验证者据此核对"是不是同一个候选"。
      `  候选身份（R219 核对用）：runId=${created.identity.runId} 端口=${String(created.identity.port)} ` +
        `绑定=${created.identity.bind}`,
      `    · 运行目录=${created.identity.runDir}`,
      `    · 内核存储=${created.identity.kernelStorePath}`,
      `    · 对话目录=${created.identity.conversationDir}`,
      `    · 产物根=${created.identity.artifactRootDir}`,
      `  对话：${created.identity.model === null ? '模型未配置（消息会如实标失败）' : `provider=${String(created.identity.provider)} model=${created.identity.model}`}`,
      `  静态页：${created.paths.webDir}`,
      // FA-PPT-MEDIA-MOUNT：把已挂载的 PPT 媒体前缀登记到启动输出。该路由无端口，故此处只作登记。
      `  PPT 媒体路由：${PPT_MEDIA_ROOT}/**（图片/形状/表格/图表/音视频 + /verify；无端口、零落盘 ⇒ 无条件挂载）`,
      `  运行目录：${created.paths.runDir}`,
      `  产物根：${created.paths.artifactRootDir}`,
      `  buildId：${health.buildId}`,
      `  bootId：${health.bootId}`,
      `  modelConfigured=${String(health.modelConfigured)}（只反映配置存在） ` +
        `modelVerified=${String(health.modelVerified)}（依据本轮脱敏账本里 call_result.ok===true，不是本进程自证）`,
      // 有效额度上限必须**看得见**：这个缺陷之所以能藏住，就是因为没有任何输出说明宿主闸门用的是哪个数。
      `  额度上限：${String(created.jobs.budgetLimit)}（宿主闸门与模型端口同源，均取自 POTBOT_MODEL_MAX_REQUESTS）`,
      ...created.wiring.notes.map((note) => `  端口：${note}`),
      `  应用索引：${boot.index_note}；` +
        `重启自检：已完成重新校验 ${String(boot.revalidated_ready.length)} 个、` +
        `降级 unknown ${String(boot.degraded_unknown.length)} 个、` +
        `在途中断 ${String(boot.interrupted.length)} 个`,
      // 内核状态的持久化口径必须**看得见**：读者要能分清"内核状态真的恢复了"
      // 与"只是应用索引还在，内核其实是空的"。
      `  内核状态：${describeStoreLoad(created.host.storeLoadReport())}；` +
        `重启租约协调：已过期作废 ${String(boot.abandoned_runs.length)} 个、` +
        `未过期续接 ${String(boot.continuing_runs.length)} 个（R203：过期的不复活、没到期的照常用）`,
      // FA-FIX-TAUTOLOGY（N-5-6）：**重启恢复路径**上的检查点只读视图——
      // 归约口径走 `src/scheduler/checkpoint.ts` 的既有函数（`loadCheckpoint` +
      // `planCheckpointRestore`），本行**不写任何东西**（恢复是操作者的显式动作）。
      `  检查点（重启只读视图）：${describeCheckpointRecoveryLine(created.host.store)}`,
      '',
    ].join('\n'),
  );
  return created;
}

/** 该绑定地址下手机/浏览器可以使用的完整 URL 列表（只做展示，不改绑定）。 */
export function reachableUrls(bind: string, port: number): readonly string[] {
  if (bind === '0.0.0.0') {
    const lan = localIpv4Addresses();
    return Object.freeze([
      `http://127.0.0.1:${String(port)}/（本机）`,
      ...lan.map((address) => `http://${address}:${String(port)}/（手机走同一 Wi-Fi 时用这个）`),
    ]);
  }
  return Object.freeze([`http://${bind}:${String(port)}/`]);
}

function sep(): string {
  return process.platform === 'win32' ? '\\' : '/';
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  startDemoServer().catch((error: unknown) => {
    process.stderr.write(`启动失败：${describeError(error)}\n`);
    process.exitCode = 1;
  });
}
