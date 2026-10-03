/**
 * FA-KRN-ORPHANS：处置 `fa/krn-barrel-consume` 登记为 **`orphaned`** 的 7 个 `src/scheduler` 模块
 * （`/api/krn-orphans/**`）。
 *
 * ## 这一件修的是什么
 *
 * 上一个包把 7 个模块如实登记为"**除桶导出外 `src/**` 里零非测试引用，连内核路径都没有调用者**"，
 * 并明说"把它们说成'仅内核可达'会是谎报"。登记是对的，但**登记不是处置**：缺口还在。
 * 本包对这 7 个**逐个判定**，把确有产品调用者的**真接**（每条都有真实 HTTP 端点 + 反向对照 +
 * 诚实边界），把没有产品侧消费者的**具名登记**，并用两张可断言的表把那 7 个**全集**覆盖住。
 *
 * ## 判定口径（本文件自己的复算，**不照抄** 7 这个数字）
 *
 * 判据是"**这个模块的产品侧消费者是谁**"，落到两问：
 * 1. 它的判定 / 编排语义能不能在**真实产品状态**上完整跑一遍（内核 store 的真实记录 /
 *    模板平台的**真注册表**）？
 * 2. 这个端点**如果删掉，会有产品行为变差吗**——即是否存在一个真实消费者？
 *
 * 两条都成立 ⇒ `KRN_ORPHANS_RESOLVED`（已接）；只有"正确调用者在内核事务内部、产品侧没有
 * 独立于内核事务的用户动作"时才进 `KRN_ORPHANS_REGISTERED`（登记）。
 *
 * ## 已接的 6 个（每个都有真实端点 + 反向对照）
 *
 * | 模块 | 端点 | 真实状态来源 | 反向对照 |
 * |---|---|---|---|
 * | `capability-registry` | `GET /capabilities`、`POST /capabilities/select` | **模板平台的活注册表**（`/api/plugins/**` 用的同一份 `PluginRegistry` + 已落盘的安装状态） | 无关模板入选由 `findIrrelevantSelections()` 抓出；未就绪模板**不进**可用清单，只进 `blocked` |
 * | `context-assembly` | `POST /context` | 同上（注册表五态 → 候选） | 渲染文本里**不得**出现未选中模板的指令全文（响应里给出 `unselected_instructions_leaked` 自证位）；预算超限 ⇒ 结构化 `budget_exceeded`，不静默截断 |
 * | `fact-version-gate` | `POST /fact/seed`、`POST /fact/observe`、`POST /fact/lock`、`POST /fact/commit`、`GET /fact/slots` | **内核 store 的真实产物版本 / 共享事实 / 任务版本**（seed 与 observe 都从 store 读） | 迟到结果（`base < current`）⇒ `stale_artifact_version`；版本断层（`base > current`）⇒ `artifact_version_gap`；无有效栅栏 ⇒ `lock_not_held`；绑定过期 ⇒ `stale_fact_binding` |
 * | `progress-monitor` | `GET /progress`、`POST /progress/observe`、`POST /progress/action`、`POST /progress/fork` | **内核 store 的真实 `work_items`**（按任务过滤）+ 注入的停滞预算台账 | 同阻塞指纹、同证据周期内第二次自动恢复被拒（`already_recovered`）；新证据放行；分身超上限被拒（`fork_cap_reached`） |
 * | `work-queue` | `GET /queue`、`POST /queue/{enqueue,claim,renew,complete,fail,recover}` | **内核 store 本身**（队列条目 / 租约 / 工作态实例都落真实持久记录） | 同一项被第二个 worker 再领 ⇒ `claimed:false`；`recoverAfterCrash()` 对 `result_unknown` 的动作不下发重放 |
 * | `worker-loop` | `GET /worker`、`POST /worker/{start,stop,step}` | **真宿主进程**：`setInterval` 驱动的后台循环 + 上面那个真队列 | `polling:'busy'` 注入 ⇒ `PollingDiscipline` 当场记违规；停机后不再领新项 |
 *
 * ## 登记为无产品侧消费者的 1 个
 *
 * `task-group-isolation`：它是**纯结构判据**（纯函数登记表 + 归属链自检），没有独立于内核事务的
 * 用户动作可驱动；把内核 store 的真实记录喂进它只会得到**另一份并行登记表**，其判定**不约束任何
 * 真实写入**（释放 / 续接的落地在 `src/scheduler` 的生命周期与持久化路径，不在本包写权内）。
 * 因此**不为凑数造假 import**，如实登记（见 `KRN_ORPHANS_REGISTERED`）。
 *
 * ## 诚实边界（**逐条如实标注，不得当结论引用**）
 *
 * 1. **`fact-version-gate` 的推进只落在本宿主的进程内台账上**（`createMemoryFactVersionLedger()`，
 *    `shared_across_processes === false`），**不回写内核 store**。它能做的是"拿**真实**当前版本
 *    判定这次提交合法不合法"（观测与 CAS 基数都来自真实状态），它**不是** `finish_run` 的权威提交
 *    路径——那条路径在 `src/scheduler/runs.ts`，**不在本包写权内**（本包只允许新增 apps 文件）。
 *    响应里 `authoritative_write: false` 是这句话的机器可读形式，不是免责话术。
 * 2. **`worker-loop` 的默认执行器是"未装配"**：本宿主**不代签执行结论**，默认执行器一律返回
 *    `failed / executor_unwired`。真实执行器由装配方经 `worker_executor` 注入。因此被本宿主
 *    领取的条目会**如实记一条失败**（`wq-` 命名空间，与调度器自己的 `req-` / `run-` 不混）。
 * 3. **"崩溃"与"多进程"都是同进程模拟**：队列恢复 = 同一个 store 上再跑一次 `recoverAfterCrash()`；
 *    后台循环 = 本进程的一个 `setInterval`。**真实多进程并发写同一状态文件未做实测**。
 * 4. **`context-assembly` 没有改道工具循环宿主内部**：`/api/tool-loop/**` 的模型往返仍由
 *    `tool-loop-product.ts` 自己组装上下文（该文件不在本包写权内）。本包的 `/context` 是**真实
 *    端点 + 真实注册表**上的按需选择，但"工具循环宿主内部已改用它"这一条**未做到**，如实标注。
 * 5. `progress-monitor` 的**分身计数不跨进程 / 不跨重启**（模块自身的诚实边界），本宿主持有它时
 *    同样如此；重启后计数归零。
 *
 * ## 状态码约定
 *
 * `200` = 判定完成（判定内容在体内）；`400` = 输入非法；`403` = 不持有资源锁（**锁的语义拒绝**，
 * 与 `409` 区分）；`409` = 语义拒绝（迟到结果 / 绑定过期 / 语义冲突）；`503` = 端口未装配。
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  asArtifactRef,
  asGroupId,
  asInstanceId,
  asLogicalTime,
  asRequestId,
  asRevision,
  asRunId,
  asTaskId,
  snapshotArtifacts,
  snapshotSharedFacts,
  type Store,
  type WorkItem,
} from '../../../src/protocol/index.js';
import { DEFAULT_SCENARIO_LIMITS, canonicalDigest, type DiagnosisBudget } from '../../../src/dependency/index.js';
import type { StagnationDiagnosis } from '../../../src/dependency/index.js';
import { conservativeProbes, type DiscoveryProbes, type PluginRegistry } from '../../../src/plugins/index.js';
import {
  assembleContext,
  candidatesFromRegistry,
  renderContextText,
  type CapabilityRequirement,
  type ContextBudget,
  type ContextTemplateCandidate,
} from '../../../src/scheduler/context-assembly.js';
import {
  findIrrelevantSelections,
  listImmediatelySupplementable,
  projectCapabilityInventory,
  selectCapabilities,
} from '../../../src/scheduler/capability-registry.js';
import {
  FactVersionGate,
  artifactVersionKeyOf,
  captureFactVersion,
  createMemoryFactVersionLedger,
  createMemoryLockPort,
  describeLockMedium,
  type FactVersionView,
  type LockFence,
  type ResultCommitRequest,
} from '../../../src/scheduler/fact-version-gate.js';
import { ProgressMonitor, type ProgressReport } from '../../../src/scheduler/progress-monitor.js';
import type { StagnationBudgetLedger } from '../../../src/scheduler/stagnation.js';
import { createWorkQueue, deliveryGuarantee, type QueueClaim, type WorkQueue } from '../../../src/scheduler/work-queue.js';
import {
  createWorkerLoop,
  type WorkerClock,
  type WorkerExecutor,
  type WorkerLoop,
} from '../../../src/scheduler/worker-loop.js';

// ---------------------------------------------------------------------------
// 路由根
// ---------------------------------------------------------------------------

/** 本模块独占的路由根（`http.ts` 只按这个前缀转交；与其它前缀互不重叠）。 */
export const KRN_ORPHANS_ROOT = '/api/krn-orphans';

const MAX_BODY_BYTES = 64 * 1024;

/**
 * 产品默认探针：与 `route-wiring.ts` 的 `defaultProbes()`（`plugin-routes.ts` 的 `DEFAULT_READY_ADAPTERS`）
 * **同值**——内置构建器"依赖就绪"，**实测支持恒为假**（R233 / R240：本入口不代签任何实测结论）。
 *
 * 那边没有导出该常量，这里同值重列一次；两处若要改，**必须一起改**（否则同一份注册表会在
 * `/api/plugins/**` 与 `/api/krn-orphans/**` 上给出不一致的五态）。装配方可用 `probes` 覆盖。
 */
const DEFAULT_READY_ADAPTERS: readonly string[] = Object.freeze([
  'builtin.docx_builder',
  'builtin.xlsx_builder',
  'builtin.pptx_builder',
]);

function defaultProbes(): DiscoveryProbes {
  return conservativeProbes({ readyAdapters: [...DEFAULT_READY_ADAPTERS] });
}

// ---------------------------------------------------------------------------
// 两张表：已接 / 登记（那 7 个的全集）
// ---------------------------------------------------------------------------

/** 被 `fa/krn-barrel-consume` 登记为 `orphaned` 的 7 个 `src/scheduler` 模块名。 */
export const KRN_ORPHANS: readonly string[] = Object.freeze([
  'capability-registry',
  'context-assembly',
  'fact-version-gate',
  'progress-monitor',
  'task-group-isolation',
  'work-queue',
  'worker-loop',
]);

/** 一条"已接"的判定：为什么本应有调用者、真实状态在哪、反向对照是什么、边界在哪。 */
export interface KrnOrphanResolution {
  /** 模块文件名（不含 `.ts`），与 {@link KRN_ORPHANS} 的取值同域。 */
  readonly module: string;
  /** 本包为它开的端点（相对 {@link KRN_ORPHANS_ROOT}）。 */
  readonly endpoints: readonly string[];
  /**
   * 可达性自证用的**真实请求**：测试照它打一发，必须 200 且响应体 `module` 等于本行的
   * `module`。表与实现的绑定因此是**机器可验证**的，不是文档承诺。
   */
  readonly probe: {
    readonly method: 'GET' | 'POST';
    readonly path: string;
    readonly body?: Readonly<Record<string, unknown>>;
  };
  /** 判定依据：它为什么**本应**有产品/内核调用者。 */
  readonly why: string;
  /** 端点读的**真实状态**（不是请求回显）。 */
  readonly real_state: readonly string[];
  /** 反向对照：检测器必须响的场景（测试里逐条真跑）。 */
  readonly reverse_control: string;
  /** 本包**没有**做到的事（未验证项，不得当结论引用）。 */
  readonly boundary: string;
}

export const KRN_ORPHANS_RESOLVED: readonly KrnOrphanResolution[] = Object.freeze([
  Object.freeze({
    module: 'capability-registry',
    endpoints: Object.freeze(['/capabilities', '/capabilities/select']),
    probe: Object.freeze({ method: 'GET' as const, path: '/capabilities' }),
    why:
      '能力发现是产品面：手机端要能回答"我现在有什么能力 / 为什么做不了这张表 / 授权一下能不能补上"。' +
      '它把模板平台的五态发现投影成能力清单 + 结构化阻塞 + 可补入，是 `/api/plugins/**` 之外的**能力视角**（按能力而不是按插件）。',
    real_state: Object.freeze([
      '模板平台的**活注册表**（`PluginRegistry`：与 `/api/plugins/**` 同一份实例，读的是已落盘的安装/启用/授权状态）',
      '注入的发现探针（产品默认：内置构建器依赖就绪、实测支持恒假）',
    ]),
    reverse_control:
      '未就绪（未安装 / 未授权 / 未实测 / stub）的模板**不得**出现在 `entries` 里，只能出现在 `blocked`；' +
      '另有一条独立检测器 `findIrrelevantSelections()`——喂一份"混入无关模板"的组装结果，它必须把无关项抓出来（端点上由 `irrelevant_selected` 暴露）。',
    boundary:
      '本端点只做**投影与判定**，不安装 / 不授权任何模板（那由 `/api/plugins/**` 的写通道负责）；' +
      '两侧共用同一份注册表，因此本端点的清单**随那边的写操作实时变化**。',
  }),
  Object.freeze({
    module: 'context-assembly',
    endpoints: Object.freeze(['/context']),
    probe: Object.freeze({
      method: 'POST' as const,
      path: '/context',
      body: Object.freeze({
        task_id: 'T-probe',
        task_revision: 1,
        requirements: Object.freeze([Object.freeze({ capability_id: 'cap.doc.create', required: true })]),
      }),
    }),
    why:
      '模型上下文是**要发出去的东西**：任务先表达成能力需求，只有声明了该能力的模板才进上下文，' +
      '预算是硬上限而不是"有就用"。这是 KRN-04/05 的产品落点（按需选模板 / 工具，不整目录喂入）。',
    real_state: Object.freeze([
      '模板平台的**活注册表**（候选的五态由 `describeDiscovery()` 原样透出，本层不重写任何一条判定）',
    ]),
    reverse_control:
      '响应自带 `unselected_instructions_leaked`：未选中模板的指令全文**一旦出现在渲染文本里**即为 `true`（测试断言必须为 `false`）。' +
      '预算不足时必需需求 ⇒ 结构化 `budget_exceeded` 阻塞，**不静默截断**成半份模板。',
    boundary:
      '**未改道工具循环宿主内部**：`/api/tool-loop/**` 的模型往返仍由 `tool-loop-product.ts` 自己组装上下文（该文件不在本包写权内）。' +
      '本端点是真实端点 + 真实注册表上的按需选择，"工具循环宿主内部已改用本层"这一条**未做到**。',
  }),
  Object.freeze({
    module: 'fact-version-gate',
    endpoints: Object.freeze(['/fact/seed', '/fact/observe', '/fact/lock', '/fact/commit', '/fact/slots']),
    probe: Object.freeze({
      method: 'POST' as const,
      path: '/fact/seed',
      body: Object.freeze({}),
    }),
    why:
      '多群组 / 多后端工作进程并行产出时，**迟到结果覆盖新产物**是经典丢更新（KRN-06）。' +
      '提交前的比较版本闸门（产物版本 CAS + 事实/依赖图绑定 + 资源锁栅栏）是真实需求，产品侧需要一个' +
      '"这次提交会不会被接受"的真实判据。',
    real_state: Object.freeze([
      '内核 store 的真实**产物版本**（`artifacts[].artifact_version`，槽位键 `(task_id, template_kind)`）',
      '内核 store 的真实**共享事实**（`currentFactByKey()` 是"哪条是当前"的唯一判据）与**任务版本**',
      '真实的资源锁端口（同进程内存介质，`describeLockMedium()` 把它变成可断言字符串）',
    ]),
    reverse_control:
      '迟到结果（`base < current`）⇒ `stale_artifact_version`；版本断层（`base > current`）⇒ `artifact_version_gap`；' +
      '无有效栅栏 ⇒ `lock_not_held`；绑定在 observe 之后事实变了 ⇒ `stale_fact_binding`；任务未 seed ⇒ `unknown_task`。',
    boundary:
      '版本推进只落在**本宿主的进程内台账**上（`shared_across_processes === false`），**不回写内核 store**；' +
      '它**不是** `finish_run` 的权威提交路径（那条在 `src/scheduler/runs.ts`，不在本包写权内）。' +
      '响应里的 `authoritative_write: false` 就是这句话，不是免责话术。',
  }),
  Object.freeze({
    module: 'progress-monitor',
    endpoints: Object.freeze(['/progress', '/progress/observe', '/progress/action', '/progress/fork']),
    probe: Object.freeze({
      method: 'POST' as const,
      path: '/progress/observe',
      body: Object.freeze({}),
    }),
    why:
      'KRN-11 的三个失效模式（无进展空转 / 依赖循环 / 分身失控）与两个过度反应（无限唤醒 / 占着执行槽等）' +
      '都需要一个**监督者**：产品宿主正是那个"看住轮次的人"，它的判定（是否让出执行槽 / 是否允许唤醒 / 是否还能开分身）会直接改变产品行为。',
    real_state: Object.freeze([
      '内核 store 的真实 `work_items`（可按任务过滤；阻塞指纹直接由这些真实项算出）',
      '注入的停滞预算台账（`stagnation_ledger`；未注入时用量按 0 计，如实）',
    ]),
    reverse_control:
      '同阻塞指纹 + 同一新证据周期内第二次自动恢复 ⇒ 被拒（`already_recovered`）；给出**新证据**后放行；' +
      '分身达到硬上限 ⇒ `fork_cap_reached`；同目的重复分身 ⇒ `duplicate_purpose`；空目的 ⇒ `purpose_required`。',
    boundary:
      '分身计数与"上次指纹"都在**本宿主进程内**：**不跨进程、不跨重启**（模块自身的诚实边界）。' +
      '本模块的判定实现（停滞阶梯 / 指纹 / 恢复账本）全在 `src/dependency/`，本层只做编排，未重写任何一条判定。',
  }),
  Object.freeze({
    module: 'work-queue',
    endpoints: Object.freeze(['/queue', '/queue/enqueue', '/queue/claim', '/queue/renew', '/queue/complete', '/queue/fail', '/queue/recover']),
    probe: Object.freeze({
      method: 'GET' as const,
      path: '/queue',
    }),
    why:
      '后台工作进程是**进程**：会崩、会重启、会被杀。"谁领了什么活、领到什么时候"必须落在持久记录上，' +
      '否则一次崩溃同时丢掉在途领取、进展与额度（KRN-10 / R214–R220）。这是产品侧的持久工作队列。',
    real_state: Object.freeze([
      '**内核 store 本身**（本对象不缓存状态）：条目 = `WorkItem`，领取/租约 = `RunRecord`，谁在干 = `InstanceState`',
      '队列用 `wq-` / `wq-lease-` 前缀与调度器自己的 `req-` / `run-` 区分（共享同一个 store 也不会互相误认）',
    ]),
    reverse_control:
      '同一项被第二个 worker 再领 ⇒ `claimed:false`（`reason:"all_blocked"`，不重复外借）；' +
      '非持有者续租 / 完成 ⇒ `not_owner`；`recoverAfterCrash()` 对 `handed_off` / `submitted` / `result_unknown` 的动作' +
      '一律 `no_replay_unknown_effect`（未知副作用**不盲重放**，R246）。',
    boundary:
      '交付语义是**至少一次**（`at_least_once`，`exactly_once_claimed: false` 是字面量）：崩溃窗口里"外部到底执行没有"本层无法分辨。' +
      '"崩溃"是同进程模拟（关掉 store 再开一个），**跨进程并发写同一状态文件未做实测**。',
  }),
  Object.freeze({
    module: 'worker-loop',
    endpoints: Object.freeze(['/worker', '/worker/start', '/worker/stop', '/worker/step']),
    probe: Object.freeze({
      method: 'GET' as const,
      path: '/worker',
    }),
    why:
      '账本语义（上面那个队列）不是"跑起来的进程"。真进程必须：空队列时退避等待、长任务到期前续租、' +
      '被杀之后回收在途项。产品宿主就是那个进程（本宿主用 `setInterval` 真驱动它）。',
    real_state: Object.freeze([
      '真实的后台循环（`setInterval` + 本进程真钟；`/worker/step` 供确定性单步驱动）',
      '上面那个**真队列**（队列语义一个字都没有重写）与内核 store 的只读审计（所有权 / 重放安全）',
    ]),
    reverse_control:
      '`polling:"busy"` 注入 ⇒ `PollingDiscipline` 当场记 `busy_poll` 违规（响应里 `polling_violations` 非空）；' +
      '停机后不再领新项（`requestStop()` ⇒ 在途项收尾、剩余条目保持可领取）；续租失败 ⇒ 执行器**谎报成功也不得记为成功**。',
    boundary:
      '**默认执行器是"未装配"**：本宿主不代签执行结论，默认一律返回 `failed / executor_unwired`，' +
      '真实执行器须由装配方经 `worker_executor` 注入。因此被领取的条目会**如实记一条失败**（不是成功）。' +
      '"多进程"是同一个 `WorkQueue` 上的两个循环实例，**不是**真实多进程实测。',
  }),
]);

/** 一条"登记为无产品侧消费者"的记录（**不为凑数造假 import**）。 */
export interface KrnOrphanRegistration {
  readonly module: string;
  readonly reason: string;
}

export const KRN_ORPHANS_REGISTERED: readonly KrnOrphanRegistration[] = Object.freeze([
  Object.freeze({
    module: 'task-group-isolation',
    reason:
      '纯结构判据：四层身份（任务 / 群组 / 实例 / 轮次）的边界分离与释放记账，全是纯函数 + 不可变登记表。' +
      '它**没有独立于内核事务的用户动作**可驱动——用户从不"释放我的群组作用域"，那是任务生命周期的事务语义。' +
      '把内核 store 的真实记录喂进它，只能得到**另一份并行登记表**：其判定不约束任何真实写入' +
      '（释放 / 跨群续接的落地在 `src/scheduler` 的调度与持久化路径，不在本包写权内），' +
      '因此真接上去只是一个"没人用的判据接口"。**不为凑数造假 import**，如实登记。',
  }),
]);

// ---------------------------------------------------------------------------
// HTTP 小工具（自足；不 import `http.ts` 的私有实现，避免耦合）
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { code, message, retryable: false, root: KRN_ORPHANS_ROOT });
}

/** 结构化未就绪：**原因** + **解锁条件**一并给出（不用空结果冒充"查过了"）。 */
function sendNotReady(res: ServerResponse, code: string, message: string, unlock: readonly string[]): void {
  sendJson(res, 503, { code, message, retryable: false, ready: false, unlock, root: KRN_ORPHANS_ROOT });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 查询串里的数字（`?limit=3` 是**字符串**，`asNumber()` 只认 JSON 数字，故单独解析）。 */
function numberParam(url: URL, name: string): number | null {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim().length === 0) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function asStringArray(value: unknown): readonly string[] {
  return asArray(value).filter((entry): entry is string => typeof entry === 'string');
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function atOf(body: Record<string, unknown>): ReturnType<typeof asLogicalTime> {
  return asLogicalTime(asNumber(body.at) ?? 0);
}

// ---------------------------------------------------------------------------
// 装配选项与接线
// ---------------------------------------------------------------------------

export interface KrnOrphansOptions {
  /**
   * 内核 store（必填项：`work-queue` / `fact-version-gate` / `progress-monitor` 读它）。
   * 省略或为 `null` ⇒ 这三类端点**结构化 503**（不假装"没有记录就是干净"）；
   * 不依赖 store 的段（`/capabilities` 走注册表、`/worker` 状态查询）照常可用。
   */
  readonly store?: Store | null;
  /**
   * 模板平台的**活注册表**（与 `/api/plugins/**` 同一份实例）。
   * 省略或为 `null` ⇒ `/capabilities` 与 `/context` 结构化 503。
   */
  readonly registry?: PluginRegistry | null;
  /** 发现探针（默认：内置构建器依赖就绪、实测支持恒假——与 `plugin-routes.ts` 同值）。 */
  readonly probes?: DiscoveryProbes | null;
  /** 停滞诊断预算（省略 ⇒ `DEFAULT_SCENARIO_LIMITS`，D=4 / R=6 / T=10000）。 */
  readonly budget?: DiagnosisBudget;
  /** 停滞预算台账（省略 ⇒ 用量按 0 计，如实）。 */
  readonly stagnation_ledger?: StagnationBudgetLedger | null;
  /** 有限分身上限（省略 ⇒ 模块默认 4）。 */
  readonly max_forks?: number;
  /** 队列租约时长（逻辑时间片；省略 ⇒ 模块默认）。 */
  readonly lease_ttl?: number;
  /** 逻辑时间读取口（装配方通常传 `host.logicalNow`）。省略 ⇒ 恒为逻辑时间原点。 */
  readonly logical_now?: () => ReturnType<typeof asLogicalTime>;
  /** 后台工作循环的执行器（省略 ⇒ **未装配**执行器，见文件头边界 2）。 */
  readonly worker_executor?: WorkerExecutor | null;
  /** 后台工作循环的时钟（省略 ⇒ 本进程真钟：`now()` 走 `Date.now()`，`wait()` 走 `setTimeout`）。 */
  readonly worker_clock?: WorkerClock | null;
}

export interface KrnOrphansHttpInput {
  readonly method: string;
  readonly pathname: string;
  readonly url: URL;
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
}

export interface KrnOrphansWiring {
  readonly root: string;
  /** 返回 `true` = 本模块已处理该请求（含它自己发出的错误响应）。 */
  handle(input: KrnOrphansHttpInput): Promise<boolean>;
  /** 后台工作循环（验收侧据此核对"真的起过进程内的循环"）。`stop()` 幂等。 */
  stopWorker(): void;
}

/** 未装配的执行器：**不代签执行结论**（见文件头边界 2）。 */
function unwiredExecutor(): WorkerExecutor {
  return {
    name: 'unwired',
    execute: () => ({ status: 'failed' as const, reason: 'executor_unwired（本宿主未装配真实执行器，不代签成功）' }),
  };
}

/** 本进程真钟（`apps/**` 允许墙钟；`src/**` 禁）。`wait(ticks)` 按毫秒等待并**封顶**。 */
function wallClock(): WorkerClock {
  return {
    now: () => asLogicalTime(Date.now()),
    wait: (ticks: number) =>
      new Promise<void>((resolve) => {
        const ms = Number.isFinite(ticks) ? Math.max(0, Math.min(1000, Math.floor(ticks))) : 0;
        setTimeout(resolve, ms);
      }),
  };
}

/** 解析能力需求：`[{capability_id, required, reason?}]`；没有 `capability_id` 的行如实忽略。 */
function parseRequirements(raw: unknown): readonly CapabilityRequirement[] {
  const parsed: CapabilityRequirement[] = [];
  for (const row of asArray(raw)) {
    if (!isRecord(row)) continue;
    const capabilityId = asString(row.capability_id);
    if (capabilityId === null) continue;
    const reason = asString(row.reason);
    parsed.push(
      Object.freeze({
        capability_id: capabilityId as CapabilityRequirement['capability_id'],
        required: row.required === true,
        ...(reason === null ? {} : { reason }),
      }),
    );
  }
  return Object.freeze(parsed);
}

/**
 * 解析上下文预算。**三项都必须给**，且每项 ≥ 1 的整数——内核的 `validateBudget()` 就是这么判的
 * （"没有上限"不是合法配置，KRN-04）。路由层先挡一道：非法预算 ⇒ **400**，
 * 不让它变成 `ValidationError` 逃出去做 500。
 */
function parseBudget(
  raw: unknown,
): { readonly ok: true; readonly budget: ContextBudget | undefined } | { readonly ok: false } {
  // 省略 / 显式 null ⇒ 走模块默认预算（`DEFAULT_CONTEXT_BUDGET`），不是错误。
  if (raw === undefined || raw === null) return { ok: true, budget: undefined };
  if (!isRecord(raw)) return { ok: false };
  const fields: ContextBudget = {
    max_templates: asNumber(raw.max_templates) ?? 0,
    max_tools: asNumber(raw.max_tools) ?? 0,
    max_instruction_chars: asNumber(raw.max_instruction_chars) ?? 0,
  };
  for (const key of ['max_templates', 'max_tools', 'max_instruction_chars'] as const) {
    const value = fields[key];
    if (!Number.isInteger(value) || value < 1) return { ok: false };
  }
  return { ok: true, budget: Object.freeze(fields) };
}

/**
 * 未选中模板的指令全文是否**泄漏**进了渲染文本。
 *
 * 这是"不把整目录喂进上下文"（R231）的**机器判据**：只要有任何一条未选中候选的指令全文
 * 出现在渲染输出里，即为泄漏。指令为空串的候选不参与判定（子串断言对空串恒真，没有信息量）。
 *
 * **导出是为了让单测直接构造泄漏场景做反向对照**——端点路径上 `assembleContext()` 不会
 * 选中无关模板，因此"检测器会不会响"必须在测试里喂一份**人为泄漏**的文本来证明。
 */
export function unselectedInstructionsLeaked(
  rendered: string,
  candidates: readonly ContextTemplateCandidate[],
  selectedIds: readonly string[],
): boolean {
  const selected = new Set(selectedIds);
  return candidates.some(
    (candidate) =>
      !selected.has(candidate.plugin_id) &&
      candidate.instructions.some((line) => line.length > 0 && rendered.includes(line)),
  );
}

/** 渲染文本里可见的模板小节（`### <plugin_id>@<version>`），用于核对"只放了选中的"。 */
function renderedTemplateIds(rendered: string): readonly string[] {
  return Object.freeze(
    rendered
      .split('\n')
      .filter((line) => line.startsWith('### '))
      .map((line) => line.slice(4).split('@')[0] as string),
  );
}

/** 任务产物依赖图的确定性摘要（`/fact/seed` 与 `/fact/observe` **必须同源**，否则绑定恒过期）。 */
function dependencyDigestOf(store: Store, taskId: string): string {
  const artifacts = snapshotArtifacts(store.snapshot()).filter((record) => String(record.task_id) === taskId);
  const refs: string[] = [];
  for (const artifact of artifacts) {
    for (const ref of artifact.dependency_artifact_refs) refs.push(String(ref));
  }
  refs.sort();
  return canonicalDigest(JSON.stringify({ task_id: taskId, dependency_refs: refs }));
}

interface FactGateState {
  readonly gate: FactVersionGate;
  /** 已捕获的绑定（`/fact/observe` 的产物）：**真实**绑定的一次快照，供后来提交时对账。 */
  readonly bindings: Map<string, FactVersionView>;
  /** 已获取的栅栏凭据（按 token 索引）。 */
  readonly fences: Map<string, LockFence>;
  /** 是否已从 store 对齐过（重复 seed 是幂等同步，不是错误）。 */
  readonly seeded: { value: boolean };
  seq: number;
}

interface WorkerState {
  loop: WorkerLoop | null;
  workerId: string;
  timer: NodeJS.Timeout | null;
  ticking: boolean;
  startedAt: number | null;
  lastTickError: string | null;
  steps: number;
  outcomes: readonly string[];
}

export function createKrnOrphansWiring(options: KrnOrphansOptions = {}): KrnOrphansWiring {
  const store = options.store ?? null;
  const registry = options.registry ?? null;
  const probes = options.probes ?? defaultProbes();
  const budget = options.budget ?? DEFAULT_SCENARIO_LIMITS;
  const logicalNow = options.logical_now ?? ((): ReturnType<typeof asLogicalTime> => asLogicalTime(0));

  // --- 队列（**真 store**；本对象不缓存状态） -------------------------------
  const queue: WorkQueue | null =
    store === null
      ? null
      : createWorkQueue(store, {
          ...(options.lease_ttl === undefined ? {} : { lease_ttl: options.lease_ttl }),
          now: logicalNow,
        });
  const claims = new Map<string, QueueClaim>();

  // --- 事实版本闸门（台账从 store 对齐；推进只落进程内，见文件头边界 1） -----
  const locks = createMemoryLockPort();
  const factState: FactGateState = {
    gate: new FactVersionGate({ locks, ledger: createMemoryFactVersionLedger() }),
    bindings: new Map<string, FactVersionView>(),
    fences: new Map<string, LockFence>(),
    seeded: { value: false },
    seq: 0,
  };

  // --- 进展监控（宿主单例：同一指纹的"上次"记忆与分身计数都在这里） ---------
  const monitor = new ProgressMonitor({
    budget,
    ...(options.stagnation_ledger === undefined || options.stagnation_ledger === null
      ? {}
      : { ledger: options.stagnation_ledger }),
    ...(options.max_forks === undefined ? {} : { max_forks: options.max_forks }),
  });
  let lastReport: ProgressReport | null = null;
  let lastDiagnosis: StagnationDiagnosis | null = null;

  // --- 后台工作循环（真宿主进程；`setInterval` 驱动） -----------------------
  const worker: WorkerState = {
    loop: null,
    workerId: 'krn-orphans-worker',
    timer: null,
    ticking: false,
    startedAt: null,
    lastTickError: null,
    steps: 0,
    outcomes: [],
  };

  /**
   * 拿到（必要时**新建**）工作循环。
   *
   * `polling` 只在**首次创建**时生效（循环对象是一次性构造的）：`'busy'` 是**检测器自证模式**，
   * 只为证明忙轮询会被 `PollingDiscipline` 当场记违规——**生产不得使用**（模块自身也这么标注）。
   */
  const ensureLoop = (workerId: string, polling: 'backoff' | 'busy' = 'backoff'): WorkerLoop | null => {
    if (queue === null || store === null) return null;
    if (worker.loop !== null && worker.workerId === workerId) return worker.loop;
    worker.loop = createWorkerLoop(
      {
        store,
        queue,
        clock: options.worker_clock ?? wallClock(),
        executor: options.worker_executor ?? unwiredExecutor(),
        stopRequested: () => false,
      },
      { worker_id: asInstanceId(workerId), polling },
    );
    worker.workerId = workerId;
    return worker.loop;
  };

  const stopWorker = (): void => {
    if (worker.timer !== null) {
      clearInterval(worker.timer);
      worker.timer = null;
    }
    if (worker.loop !== null) worker.loop.requestStop();
  };

  const workerView = (): Record<string, unknown> => ({
    module: 'worker-loop',
    started: worker.timer !== null,
    worker_id: worker.workerId,
    started_at: worker.startedAt,
    steps: worker.steps,
    ticking: worker.ticking,
    last_tick_error: worker.lastTickError,
    stats: worker.loop === null ? null : worker.loop.stats(),
    polling_violations: worker.loop === null ? [] : worker.loop.polling_violations(),
    last_recovery: worker.loop === null ? null : worker.loop.last_recovery(),
    delivery: deliveryGuarantee(),
    executor: options.worker_executor === undefined || options.worker_executor === null ? 'unwired' : 'injected',
  });

  return {
    root: KRN_ORPHANS_ROOT,
    stopWorker,
    async handle(input: KrnOrphansHttpInput): Promise<boolean> {
      const { method, pathname, req, res, url } = input;
      if (pathname !== KRN_ORPHANS_ROOT && !pathname.startsWith(`${KRN_ORPHANS_ROOT}/`)) {
        return false;
      }
      const rest = pathname === KRN_ORPHANS_ROOT ? '' : pathname.slice(KRN_ORPHANS_ROOT.length + 1);
      const isRead = method === 'GET' || method === 'HEAD';

      // === GET /status ======================================================
      if (rest === '' || rest === 'status') {
        if (!isRead) {
          sendError(res, 405, 'method_not_allowed', '该接口只接受 GET');
          return true;
        }
        sendJson(res, 200, {
          ready: true,
          root: KRN_ORPHANS_ROOT,
          store_wired: store !== null,
          registry_wired: registry !== null,
          modules_resolved: KRN_ORPHANS_RESOLVED.map((entry) => entry.module),
          modules_registered: KRN_ORPHANS_REGISTERED.map((entry) => entry.module),
          orphans_total: KRN_ORPHANS.length,
          lock_medium: describeLockMedium(locks),
          ledger_shared_across_processes: factState.gate.versionLedger.shared_across_processes,
        });
        return true;
      }

      // =======================================================================
      // capability-registry（`/capabilities`、`/capabilities/select`）
      // =======================================================================
      if (rest === 'capabilities') {
        if (!isRead) {
          sendError(res, 405, 'method_not_allowed', '该接口只接受 GET');
          return true;
        }
        if (registry === null) {
          sendNotReady(res, 'registry_unwired', '模板平台注册表未装配，能力清单无来源（不假装"没有能力"就是结论）', [
            '在宿主里注入 `/api/plugins/**` 用的同一个 InstallSourceManager.pluginRegistry',
          ]);
          return true;
        }
        const limitParam = numberParam(url, 'limit');
        const inventory = projectCapabilityInventory(
          registry,
          probes,
          // `limit` 必须是 ≥ 1 的整数（内核在 `boundOperations()` 里就这么判）；非法值交给内核抛。
          limitParam === null ? {} : { limit: Math.max(1, Math.floor(limitParam)) },
        );
        const supplementable = listImmediatelySupplementable(registry, probes);
        sendJson(res, 200, {
          module: 'capability-registry',
          registry_revision: registry.revision,
          limit: inventory.limit,
          total_available: inventory.total_available,
          truncated: inventory.truncated,
          omitted_count: inventory.omitted_count,
          ready_plugin_ids: inventory.ready_plugin_ids,
          entries: inventory.entries.map((entry) => ({
            plugin_id: entry.plugin_id,
            capability_id: entry.capability_id,
            label: entry.label,
            states: entry.states.states,
            ready: entry.states.ready,
          })),
          blocked: inventory.blocked.map((blocked) => ({
            plugin_id: blocked.plugin_id,
            false_states: blocked.false_states,
            not_ready_reasons: blocked.not_ready_reasons,
            stub: blocked.stub,
            stub_reason: blocked.stub_reason,
          })),
          supplementable: supplementable.map((entry) => ({
            plugin_id: entry.plugin_id,
            version: entry.version,
            unlock: entry.unlock,
          })),
          digest: inventory.digest,
        });
        return true;
      }

      if (rest === 'capabilities/select') {
        if (method !== 'POST') {
          sendError(res, 405, 'method_not_allowed', '该接口只接受 POST');
          return true;
        }
        if (registry === null) {
          sendNotReady(res, 'registry_unwired', '模板平台注册表未装配，按需选择无候选可筛', [
            '在宿主里注入 `/api/plugins/**` 用的同一个 InstallSourceManager.pluginRegistry',
          ]);
          return true;
        }
        const body = await readJsonBody(req);
        if (body === null) {
          sendError(res, 400, 'invalid_json', '请求体不是合法 JSON 对象');
          return true;
        }
        const taskId = asString(body.task_id);
        const requirements = parseRequirements(body.requirements);
        if (taskId === null || requirements.length === 0) {
          sendError(res, 400, 'missing_fields', '需要 task_id 与非空 requirements[{capability_id, required}]');
          return true;
        }
        const budgetOverride = parseBudget(body.budget);
        if (!budgetOverride.ok) {
          sendError(res, 400, 'invalid_budget', 'budget 三项（max_templates / max_tools / max_instruction_chars）都必须给出且为 ≥ 1 的整数');
          return true;
        }
        const selection = selectCapabilities({
          registry,
          probes,
          task_id: taskId,
          task_revision: asNumber(body.task_revision) ?? 1,
          requirements,
          granted_permissions: asStringArray(body.granted_permissions),
          authorize_installed: asStringArray(body.authorize_installed),
          ...(budgetOverride.budget === undefined ? {} : { budget: budgetOverride.budget }),
        });
        sendJson(res, 200, {
          module: 'capability-registry',
          task_id: taskId,
          selected_templates: selection.context.selected_templates.map((template) => ({
            plugin_id: template.plugin_id,
            version: template.version,
            satisfies: template.satisfies,
            source: template.source,
          })),
          selected_tools: selection.context.selected_tools,
          excluded_template_ids: selection.context.excluded_template_ids,
          blockers: selection.context.blockers.map((blocker) => ({
            code: blocker.code,
            capability_id: blocker.capability_id,
            plugin_id: blocker.plugin_id,
            detail: blocker.detail,
            remedy: blocker.remedy,
          })),
          blocks: selection.blocks,
          dropped_optional: selection.context.dropped_optional,
          budget: selection.context.budget,
          irrelevant_selected: selection.irrelevant_selected,
          digest: selection.context.digest,
        });
        return true;
      }

      // =======================================================================
      // context-assembly（`/context`）
      // =======================================================================
      if (rest === 'context') {
        if (method !== 'POST') {
          sendError(res, 405, 'method_not_allowed', '该接口只接受 POST');
          return true;
        }
        if (registry === null) {
          sendNotReady(res, 'registry_unwired', '模板平台注册表未装配，候选模板五态无从判定', [
            '在宿主里注入 `/api/plugins/**` 用的同一个 InstallSourceManager.pluginRegistry',
          ]);
          return true;
        }
        const body = await readJsonBody(req);
        if (body === null) {
          sendError(res, 400, 'invalid_json', '请求体不是合法 JSON 对象');
          return true;
        }
        const taskId = asString(body.task_id);
        const requirements = parseRequirements(body.requirements);
        if (taskId === null || requirements.length === 0) {
          sendError(res, 400, 'missing_fields', '需要 task_id 与非空 requirements[{capability_id, required}]');
          return true;
        }
        const budgetOverride = parseBudget(body.budget);
        if (!budgetOverride.ok) {
          sendError(res, 400, 'invalid_budget', 'budget 三项（max_templates / max_tools / max_instruction_chars）都必须给出且为 ≥ 1 的整数');
          return true;
        }
        const candidates = candidatesFromRegistry(registry, probes);
        const context = assembleContext({
          task_id: taskId,
          task_revision: asNumber(body.task_revision) ?? 1,
          requirements,
          candidates,
          granted_permissions: asStringArray(body.granted_permissions),
          authorize_installed: asStringArray(body.authorize_installed),
          ...(budgetOverride.budget === undefined ? {} : { budget: budgetOverride.budget }),
        });
        const rendered = renderContextText(context);
        const selectedIds = context.selected_templates.map((template) => template.plugin_id);
        sendJson(res, 200, {
          module: 'context-assembly',
          task_id: taskId,
          candidates: candidates.length,
          selected_templates: context.selected_templates.map((template) => ({
            plugin_id: template.plugin_id,
            version: template.version,
            kind: template.kind,
            satisfies: template.satisfies,
            source: template.source,
            instruction_lines: template.instructions.length,
          })),
          selected_tools: context.selected_tools,
          excluded_template_ids: context.excluded_template_ids,
          blockers: context.blockers,
          dropped_optional: context.dropped_optional,
          budget: context.budget,
          digest: context.digest,
          rendered_template_ids: renderedTemplateIds(rendered),
          unselected_instructions_leaked: unselectedInstructionsLeaked(rendered, candidates, selectedIds),
          // 独立检测器：把组装结果回喂给它，无关模板一旦入选就会被抓出来（健康时恒为空数组）。
          irrelevant_selected: findIrrelevantSelections(context.selected_templates, requirements),
          rendered_chars: rendered.length,
          rendered_text: rendered,
        });
        return true;
      }

      // =======================================================================
      // fact-version-gate（`/fact/**`）
      // =======================================================================
      if (rest === 'fact/seed') {
        if (method !== 'POST') {
          sendError(res, 405, 'method_not_allowed', '该接口只接受 POST');
          return true;
        }
        if (store === null) {
          sendNotReady(res, 'store_unwired', '内核 store 未装配，权威版本台账无对齐来源', [
            '在宿主里注入 KernelHost 的同一个 store',
          ]);
          return true;
        }
        const snapshot = store.snapshot();
        const facts = snapshotSharedFacts(snapshot);
        const seededTasks: Record<string, unknown>[] = [];
        const failedTasks: Record<string, unknown>[] = [];
        for (const task of snapshot.tasks) {
          try {
            const view = factState.gate.registerTask({
              task_id: task.task_id,
              task_revision: task.revision,
              facts,
              dependency_digest: dependencyDigestOf(store, String(task.task_id)),
            });
            seededTasks.push({
              task_id: String(view.task_id),
              task_revision: Number(view.task_revision),
              facts: view.facts.length,
              digest: view.digest,
            });
          } catch (error) {
            // 例：同一事实键出现两条当前事实（单一来源被破坏）——如实报出，不"任取一条"。
            failedTasks.push({ task_id: String(task.task_id), reason: describeError(error) });
          }
        }
        const slots: Record<string, unknown>[] = [];
        for (const artifact of snapshotArtifacts(snapshot)) {
          const ref = { task_id: artifact.task_id, artifact_key: artifact.template_kind };
          const known = factState.gate.currentArtifactVersion(ref);
          let action = 'in_sync';
          if (artifact.artifact_version > known) {
            action = factState.gate.versionLedger.compareAndSetArtifactVersion(ref, known, artifact.artifact_version)
              ? 'aligned_to_store'
              : 'cas_failed';
          } else if (artifact.artifact_version < known) {
            // 台账已由提交推进到 store 之上：**不回退**（回退等于让旧版本复活），如实标注。
            action = 'ledger_ahead';
          }
          slots.push({
            task_id: String(artifact.task_id),
            artifact_key: artifact.template_kind,
            store_version: artifact.artifact_version,
            ledger_version: factState.gate.currentArtifactVersion(ref),
            action,
          });
        }
        factState.seeded.value = true;
        sendJson(res, 200, {
          module: 'fact-version-gate',
          store_wired: true,
          tasks_seeded: seededTasks,
          tasks_failed: failedTasks,
          slots,
          lock_medium: describeLockMedium(locks),
          ledger_shared_across_processes: factState.gate.versionLedger.shared_across_processes,
          authoritative_write: false,
        });
        return true;
      }

      if (rest === 'fact/slots') {
        if (!isRead) {
          sendError(res, 405, 'method_not_allowed', '该接口只接受 GET');
          return true;
        }
        if (store === null) {
          sendNotReady(res, 'store_unwired', '内核 store 未装配，产物槽位无来源', [
            '在宿主里注入 KernelHost 的同一个 store',
          ]);
          return true;
        }
        const taskFilter = asString(url.searchParams.get('task_id'));
        const grouped = new Map<string, { task_id: string; artifact_key: string; versions: number[]; artifacts: string[] }>();
        for (const artifact of snapshotArtifacts(store.snapshot())) {
          if (taskFilter !== null && String(artifact.task_id) !== taskFilter) continue;
          const key = `${String(artifact.task_id)}::${artifact.template_kind}`;
          const row = grouped.get(key) ?? {
            task_id: String(artifact.task_id),
            artifact_key: artifact.template_kind,
            versions: [],
            artifacts: [],
          };
          row.versions.push(artifact.artifact_version);
          row.artifacts.push(String(artifact.artifact_id));
          grouped.set(key, row);
        }
        const slots = [...grouped.values()]
          .map((row) => {
            const ref = { task_id: asTaskId(row.task_id), artifact_key: row.artifact_key };
            const resource = artifactVersionKeyOf(ref);
            return {
              task_id: row.task_id,
              artifact_key: row.artifact_key,
              store_max_version: Math.max(...row.versions),
              store_versions: [...row.versions].sort((a, b) => a - b),
              artifact_ids: [...row.artifacts].sort(),
              ledger_version: factState.gate.currentArtifactVersion(ref),
              lock_holder: locks.holderOf(resource),
            };
          })
          .sort((left, right) =>
            left.task_id === right.task_id
              ? left.artifact_key < right.artifact_key
                ? -1
                : 1
              : left.task_id < right.task_id
                ? -1
                : 1,
          );
        sendJson(res, 200, {
          module: 'fact-version-gate',
          task_filter: taskFilter,
          slots,
          reset_possible: true,
          lock_medium: describeLockMedium(locks),
          authoritative_write: false,
        });
        return true;
      }

      if (rest === 'fact/observe') {
        if (method !== 'POST') {
          sendError(res, 405, 'method_not_allowed', '该接口只接受 POST');
          return true;
        }
        if (store === null) {
          sendNotReady(res, 'store_unwired', '内核 store 未装配，版本绑定无捕获来源', [
            '在宿主里注入 KernelHost 的同一个 store',
          ]);
          return true;
        }
        const body = await readJsonBody(req);
        if (body === null) {
          sendError(res, 400, 'invalid_json', '请求体不是合法 JSON 对象');
          return true;
        }
        const taskId = asString(body.task_id);
        if (taskId === null) {
          sendError(res, 400, 'missing_fields', '需要 task_id');
          return true;
        }
        const currentRevision = factState.gate.currentRevision(asTaskId(taskId));
        const taskRevision = asNumber(body.task_revision) ?? (currentRevision === undefined ? 1 : Number(currentRevision));
        let binding: FactVersionView;
        try {
          binding = captureFactVersion({
            task_id: asTaskId(taskId),
            task_revision: asRevision(taskRevision),
            facts: snapshotSharedFacts(store.snapshot()),
            dependency_digest: dependencyDigestOf(store, taskId),
          });
        } catch (error) {
          sendError(res, 409, 'binding_capture_failed', describeError(error));
          return true;
        }
        factState.seq += 1;
        const token = `binding-${String(factState.seq)}`;
        factState.bindings.set(token, binding);
        sendJson(res, 200, {
          module: 'fact-version-gate',
          binding_token: token,
          binding: {
            task_id: String(binding.task_id),
            task_revision: Number(binding.task_revision),
            facts: binding.facts.map((entry) => ({ fact_key: entry.fact_key, fact_id: String(entry.fact_id) })),
            dependency_digest: binding.dependency_digest,
            digest: binding.digest,
          },
        });
        return true;
      }

      if (rest === 'fact/lock') {
        if (method !== 'POST') {
          sendError(res, 405, 'method_not_allowed', '该接口只接受 POST');
          return true;
        }
        const body = await readJsonBody(req);
        if (body === null) {
          sendError(res, 400, 'invalid_json', '请求体不是合法 JSON 对象');
          return true;
        }
        const taskId = asString(body.task_id);
        const artifactKey = asString(body.artifact_key);
        const groupId = asString(body.group_id);
        const instanceId = asString(body.instance_id);
        if (taskId === null || artifactKey === null || groupId === null || instanceId === null) {
          sendError(res, 400, 'missing_fields', '需要 task_id / artifact_key / group_id / instance_id');
          return true;
        }
        const ref = { task_id: asTaskId(taskId), artifact_key: artifactKey };
        const resource = artifactVersionKeyOf(ref);
        const holder = locks.holderOf(resource);
        if (holder !== null) {
          // 已被别人持有：**不排队、不阻塞**（端口的既有语义），如实 409 + 现持有者。
          sendJson(res, 409, { module: 'fact-version-gate', acquired: false, resource, holder });
          return true;
        }
        const fence = factState.gate.acquire(
          ref,
          { group_id: asGroupId(groupId), instance_id: asInstanceId(instanceId) },
          atOf(body),
        );
        if (fence === null) {
          sendJson(res, 409, { module: 'fact-version-gate', acquired: false, resource, holder: locks.holderOf(resource) });
          return true;
        }
        factState.fences.set(fence.token, fence);
        sendJson(res, 200, { module: 'fact-version-gate', acquired: true, fence });
        return true;
      }

      if (rest === 'fact/commit') {
        if (method !== 'POST') {
          sendError(res, 405, 'method_not_allowed', '该接口只接受 POST');
          return true;
        }
        const body = await readJsonBody(req);
        if (body === null) {
          sendError(res, 400, 'invalid_json', '请求体不是合法 JSON 对象');
          return true;
        }
        const taskId = asString(body.task_id);
        const artifactKey = asString(body.artifact_key);
        const groupId = asString(body.group_id);
        const instanceId = asString(body.instance_id);
        const runId = asString(body.run_id);
        const artifactRef = asString(body.artifact_ref);
        const bindingToken = asString(body.binding_token);
        if (
          taskId === null ||
          artifactKey === null ||
          groupId === null ||
          instanceId === null ||
          runId === null ||
          artifactRef === null
        ) {
          sendError(
            res,
            400,
            'missing_fields',
            '需要 task_id / artifact_key / group_id / instance_id / run_id / artifact_ref',
          );
          return true;
        }
        if (bindingToken === null) {
          // 提交必须携带产出者据以计算的版本绑定（KRN-06）：先 `POST /fact/observe` 拿 binding_token。
          sendError(res, 400, 'binding_required', '缺少 binding_token：先 POST /fact/observe 捕获版本绑定');
          return true;
        }
        const binding = factState.bindings.get(bindingToken);
        if (binding === undefined) {
          sendError(res, 409, 'unknown_binding', `绑定 ${bindingToken} 不存在或已失效（重新 observe）`);
          return true;
        }
        const key = { task_id: asTaskId(taskId), artifact_key: artifactKey };
        const fenceToken = asString(body.fence_token);
        // 未持锁时给一个**必然无效**的栅栏（token 为空串 ⇒ `isValid` 为假），
        // 让 `evaluateCommit()` 的 `lock_not_held` 分支被真正走到，而不是在路由层短路。
        const fence: LockFence =
          (fenceToken === null ? undefined : factState.fences.get(fenceToken)) ??
          Object.freeze({
            resource: artifactVersionKeyOf(key),
            owner: Object.freeze({ group_id: asGroupId(groupId), instance_id: asInstanceId(instanceId) }),
            token: '',
            acquired_at: atOf(body),
          });
        const request: ResultCommitRequest = Object.freeze({
          key,
          produced_by_group: asGroupId(groupId),
          produced_by_instance: asInstanceId(instanceId),
          round: Object.freeze({
            run_id: asRunId(runId),
            task_revision: asRevision(asNumber(body.round_task_revision) ?? 1),
          }),
          base_artifact_version: Math.floor(asNumber(body.base_artifact_version) ?? 0),
          binding,
          artifact_ref: asArtifactRef(artifactRef),
          fence,
          at: atOf(body),
        });
        const decision = factState.gate.commit(request);
        sendJson(res, decision.ok ? 200 : 409, {
          module: 'fact-version-gate',
          decision,
          fence_valid: fenceToken !== null && locks.isValid(fence),
          lock_medium: describeLockMedium(locks),
          // 诚实边界 1：闸门的推进落在**本进程台账**上，不回写内核 store。
          authoritative_write: false,
          ledger_shared_across_processes: factState.gate.versionLedger.shared_across_processes,
        });
        return true;
      }

      // =======================================================================
      // progress-monitor（`/progress/**`）
      // =======================================================================
      if (rest === 'progress') {
        if (!isRead) {
          sendError(res, 405, 'method_not_allowed', '该接口只接受 GET');
          return true;
        }
        sendJson(res, 200, {
          module: 'progress-monitor',
          snapshot: monitor.snapshot(),
          max_forks: monitor.maxForks,
          budget,
          store_wired: store !== null,
          last_report:
            lastReport === null
              ? null
              : {
                  progressed: lastReport.progressed,
                  verdict: lastReport.verdict,
                  disposition: lastReport.disposition,
                  release_resources: lastReport.release_resources,
                  should_wake: lastReport.should_wake,
                  fingerprint_key: lastReport.fingerprint_key,
                  repeated_block_without_evidence: lastReport.repeated_block_without_evidence,
                },
        });
        return true;
      }

      if (rest === 'progress/observe') {
        if (method !== 'POST') {
          sendError(res, 405, 'method_not_allowed', '该接口只接受 POST');
          return true;
        }
        if (store === null) {
          sendNotReady(res, 'store_unwired', '内核 store 未装配，工作项无来源（诊断必须有真实的阻塞项可看）', [
            '在宿主里注入 KernelHost 的同一个 store',
          ]);
          return true;
        }
        const body = await readJsonBody(req);
        if (body === null) {
          sendError(res, 400, 'invalid_json', '请求体不是合法 JSON 对象');
          return true;
        }
        const taskFilter = asString(body.task_id);
        const allItems: readonly WorkItem[] = store.snapshot().work_items;
        const items =
          taskFilter === null ? allItems : allItems.filter((item) => String(item.task_id) === taskFilter);
        let report: ProgressReport;
        try {
          report = monitor.observe({
            items,
            now: asLogicalTime(asNumber(body.at) ?? 0),
            ...(taskFilter === null ? {} : { task_id: asTaskId(taskFilter) }),
            ...(asNumber(body.task_revision) === null
              ? {}
              : { task_revision: asRevision(asNumber(body.task_revision) as number) }),
            ...(asString(body.evidence_ref) === null ? {} : { evidence_ref: asString(body.evidence_ref) as string }),
          });
        } catch (error) {
          sendError(res, 400, 'observe_rejected', describeError(error));
          return true;
        }
        lastReport = report;
        lastDiagnosis = report.diagnosis;
        sendJson(res, 200, {
          module: 'progress-monitor',
          task_id: taskFilter,
          items_observed: items.length,
          report: {
            progressed: report.progressed,
            verdict: report.verdict,
            disposition: report.disposition,
            release_resources: report.release_resources,
            releasable_instance_ids: report.releasable_instance_ids.map(String),
            blocked_request_ids: report.blocked_request_ids.map(String),
            cycles: report.cycles,
            cycle_descriptions: report.cycle_descriptions,
            fingerprint_key: report.fingerprint_key,
            fingerprint_digest: report.fingerprint_digest,
            repeated_block_without_evidence: report.repeated_block_without_evidence,
            new_evidence: report.new_evidence,
            should_wake: report.should_wake,
          },
          diagnosis: {
            verdict: report.diagnosis.verdict,
            reason: report.diagnosis.reason,
            disposition: report.diagnosis.disposition,
          },
        });
        return true;
      }

      if (rest === 'progress/action') {
        if (method !== 'POST') {
          sendError(res, 405, 'method_not_allowed', '该接口只接受 POST');
          return true;
        }
        const body = await readJsonBody(req);
        if (body === null) {
          sendError(res, 400, 'invalid_json', '请求体不是合法 JSON 对象');
          return true;
        }
        const action = asString(body.action);
        if (action !== 'wake' && action !== 'replan') {
          sendError(res, 400, 'unknown_action', `未知动作 ${String(action)}（只接受 wake / replan）`);
          return true;
        }
        const fingerprint = lastDiagnosis === null ? null : lastDiagnosis.fingerprint;
        const decision = action === 'wake'
          ? monitor.requestWake(fingerprint, {
              at: atOf(body),
              ...(body.has_real_wait === true ? { has_real_wait: true } : {}),
            })
          : monitor.requestReplan(fingerprint, {
              at: atOf(body),
              ...(body.has_real_wait === true ? { has_real_wait: true } : {}),
            });
        sendJson(res, 200, {
          module: 'progress-monitor',
          used_fingerprint: lastDiagnosis === null || lastDiagnosis.fingerprint === null ? null : lastDiagnosis.fingerprint.key,
          decision,
        });
        return true;
      }

      if (rest === 'progress/fork') {
        if (method !== 'POST') {
          sendError(res, 405, 'method_not_allowed', '该接口只接受 POST');
          return true;
        }
        const body = await readJsonBody(req);
        if (body === null) {
          sendError(res, 400, 'invalid_json', '请求体不是合法 JSON 对象');
          return true;
        }
        const op = asString(body.op);
        if (op === 'spawn') {
          const decision = monitor.spawnFork({
            purpose: asString(body.purpose) ?? '',
            at: atOf(body),
            ...(asString(body.parent_instance_id) === null
              ? {}
              : { parent_instance_id: asInstanceId(asString(body.parent_instance_id) as string) }),
          });
          sendJson(res, 200, { module: 'progress-monitor', op, decision, active: monitor.activeForks() });
          return true;
        }
        if (op === 'release') {
          const forkId = asString(body.fork_id);
          if (forkId === null) {
            sendError(res, 400, 'missing_fields', 'release 需要 fork_id');
            return true;
          }
          const released = monitor.releaseFork(forkId);
          sendJson(res, 200, { module: 'progress-monitor', op, released, active: monitor.activeForks() });
          return true;
        }
        sendError(res, 400, 'unknown_op', `未知 op ${String(op)}（spawn / release）`);
        return true;
      }

      // =======================================================================
      // work-queue（`/queue*`）
      // =======================================================================
      if (rest === 'queue' || rest.startsWith('queue/')) {
        if (queue === null || store === null) {
          sendNotReady(res, 'store_unwired', '内核 store 未装配，持久工作队列无处落脚（不退回进程内存冒充持久）', [
            '在宿主里注入 KernelHost 的同一个 store',
          ]);
          return true;
        }
        const op = rest === 'queue' ? 'list' : rest.slice('queue/'.length);

        if (op === 'list') {
          if (!isRead) {
            sendError(res, 405, 'method_not_allowed', '队列列表只接受 GET');
            return true;
          }
          sendJson(res, 200, {
            module: 'work-queue',
            items: queue.listItems(),
            claimable: queue.listClaimable(),
            delivery: deliveryGuarantee(),
          });
          return true;
        }

        if (method !== 'POST') {
          sendError(res, 405, 'method_not_allowed', `队列操作 ${op} 只接受 POST`);
          return true;
        }
        const body = await readJsonBody(req);
        if (body === null) {
          sendError(res, 400, 'invalid_json', '请求体不是合法 JSON 对象');
          return true;
        }

        if (op === 'enqueue') {
          const taskId = asString(body.task_id);
          if (taskId === null) {
            sendError(res, 400, 'missing_fields', '入队需要 task_id');
            return true;
          }
          const requestId = asString(body.request_id);
          const item = queue.enqueue({
            task_id: asTaskId(taskId),
            ...(asNumber(body.task_revision) === null
              ? {}
              : { task_revision: asRevision(asNumber(body.task_revision) as number) }),
            ...(requestId === null ? {} : { request_id: asRequestId(requestId) }),
            ...(asString(body.description) === null ? {} : { description: asString(body.description) as string }),
            ...(asString(body.expected_output) === null
              ? {}
              : { expected_output: asString(body.expected_output) as string }),
            at: atOf(body),
          });
          sendJson(res, 200, { module: 'work-queue', op, item, claimable: queue.listClaimable().length });
          return true;
        }

        if (op === 'claim') {
          const workerId = asString(body.worker_id);
          if (workerId === null) {
            sendError(res, 400, 'missing_fields', '领取需要 worker_id');
            return true;
          }
          const outcome = queue.claim(asInstanceId(workerId), atOf(body));
          if (outcome.claim !== null) {
            claims.set(String(outcome.claim.request_id), outcome.claim);
          }
          sendJson(res, 200, { module: 'work-queue', op, outcome });
          return true;
        }

        if (op === 'renew' || op === 'complete' || op === 'fail') {
          const requestId = asString(body.request_id);
          if (requestId === null) {
            sendError(res, 400, 'missing_fields', `${op} 需要 request_id（领取时的那个）`);
            return true;
          }
          const claim = claims.get(requestId);
          if (claim === undefined) {
            sendError(res, 409, 'unknown_claim', `本宿主没有 ${requestId} 的领取记录（先 claim）`);
            return true;
          }
          if (op === 'renew') {
            const outcome = queue.renew(claim, atOf(body));
            sendJson(res, 200, { module: 'work-queue', op, outcome });
            return true;
          }
          if (op === 'complete') {
            const outcome = queue.complete(claim, atOf(body), asStringArray(body.result_refs).map((ref) => asArtifactRef(ref)));
            if (outcome.completed) claims.delete(requestId);
            sendJson(res, 200, { module: 'work-queue', op, outcome });
            return true;
          }
          const reason = asString(body.reason) ?? 'unspecified';
          const outcome = queue.fail(claim, atOf(body), reason);
          if (outcome.completed) claims.delete(requestId);
          sendJson(res, 200, { module: 'work-queue', op, outcome });
          return true;
        }

        if (op === 'recover') {
          const report = queue.recoverAfterCrash(atOf(body));
          sendJson(res, 200, { module: 'work-queue', op, report });
          return true;
        }

        sendError(res, 404, 'unknown_queue_op', `未知队列操作 ${op}`);
        return true;
      }

      // =======================================================================
      // worker-loop（`/worker*`）
      // =======================================================================
      if (rest === 'worker' || rest.startsWith('worker/')) {
        if (store === null || queue === null) {
          sendNotReady(res, 'store_unwired', '内核 store 未装配，后台工作循环没有可驱动的队列', [
            '在宿主里注入 KernelHost 的同一个 store',
          ]);
          return true;
        }
        const op = rest === 'worker' ? 'state' : rest.slice('worker/'.length);

        if (op === 'state') {
          if (!isRead) {
            sendError(res, 405, 'method_not_allowed', '状态查询只接受 GET');
            return true;
          }
          sendJson(res, 200, workerView());
          return true;
        }
        if (method !== 'POST') {
          sendError(res, 405, 'method_not_allowed', `worker 操作 ${op} 只接受 POST`);
          return true;
        }
        const body = await readJsonBody(req);
        if (body === null) {
          sendError(res, 400, 'invalid_json', '请求体不是合法 JSON 对象');
          return true;
        }

        if (op === 'step') {
          const workerId = asString(body.worker_id) ?? worker.workerId;
          const loop = ensureLoop(workerId, body.polling === 'busy' ? 'busy' : 'backoff');
          if (loop === null) {
            sendNotReady(res, 'worker_unavailable', '工作循环无法构造', ['检查 store / queue 装配']);
            return true;
          }
          const ticks = Math.max(1, Math.min(64, Math.floor(asNumber(body.ticks) ?? 1)));
          const outcomes: string[] = [];
          for (let index = 0; index < ticks; index += 1) {
            const outcome = await loop.tick();
            outcomes.push(outcome.kind === 'executed' ? `executed:${outcome.settlement.intent}` : `${outcome.kind}:${outcome.reason ?? ''}`);
          }
          worker.steps += ticks;
          worker.outcomes = [...worker.outcomes, ...outcomes].slice(-32);
          sendJson(res, 200, { ...workerView(), op, ticks, outcomes });
          return true;
        }

        if (op === 'start') {
          const workerId = asString(body.worker_id) ?? worker.workerId;
          const loop = ensureLoop(workerId);
          if (loop === null) {
            sendNotReady(res, 'worker_unavailable', '工作循环无法构造', ['检查 store / queue 装配']);
            return true;
          }
          if (worker.timer === null) {
            const interval = Math.max(1, Math.min(5000, Math.floor(asNumber(body.interval_ms) ?? 25)));
            worker.startedAt = Date.now();
            // 真后台进程：定时驱动 tick。**并发保护**：上一拍没跑完就不叠下一拍。
            // `unref()` 是为了让宿主进程能正常退出（本循环不是进程存活的唯一理由）。
            const timer = setInterval(() => {
              if (worker.ticking) return;
              worker.ticking = true;
              void loop
                .tick()
                .then(() => {
                  worker.steps += 1;
                  worker.lastTickError = null;
                })
                .catch((error: unknown) => {
                  worker.lastTickError = describeError(error);
                })
                .finally(() => {
                  worker.ticking = false;
                });
            }, interval);
            timer.unref();
            worker.timer = timer;
          }
          sendJson(res, 200, { ...workerView(), op, interval_ms: Number(asNumber(body.interval_ms) ?? 25) });
          return true;
        }

        if (op === 'stop') {
          stopWorker();
          sendJson(res, 200, { ...workerView(), op, stopped: true });
          return true;
        }

        sendError(res, 404, 'unknown_worker_op', `未知 worker 操作 ${op}`);
        return true;
      }

      sendError(res, 404, 'unknown_krn_orphans_route', `${method} ${pathname} 不是已知的孤儿模块接口`);
      return true;
    },
  };
}
