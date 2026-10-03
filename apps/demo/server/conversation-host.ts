/**
 * **连续对话宿主**（FA-N；合同 R207–R226、H2 硬门）。
 *
 * ## 这个模块是 H2 的那条链
 *
 * 网页上的对话界面（`apps/demo/web/conversation-store.js`）只做状态归位，它明确写着
 * 「真实执行由 B 流的会话/后台内核提供」。本文件就是那个提供者，而且**不是**
 * 把新页面接到旧的一次性生成接口（H2 明文不通过那种做法）：
 *
 * ```text
 * 用户消息（clientId 幂等）
 *   → 持久消息 + 事件（ConversationStore，R207/R208/R209）
 *   → **真实执行器**：createRealExecutor + runToolLoop（多轮上下文 + 工具循环，R221–R223）
 *       工具 create_word_document（由**代码**执行，不是模型自己说自己写完了）
 *         → buildDocxTemplate 产出真实 DOCX 字节
 *         → 内核任务版本递增 → staged 记录 → **写盘 + 回读**
 *         → 发布投影（与生成链/编辑链**同一个** projection）→ published + 回执
 *         → 工具把产物身份如实回给模型（R223：机械转发由代码处理）
 *   → 事件流（每轮一条 assistant_turn；游标只增）→ 客户端续取
 * ```
 *
 * ## 「已接收」「业务完成」「失败」「取消」是四件不同的事（R209）
 *
 * 收下消息 ⇒ `phase='accepted'`；执行中 ⇒ `'running'`；工具循环 `completed` **且**
 * 真的产出了已发布产物 ⇒ `'completed'`；循环自己说完成但**没有**产物 ⇒ 如实记
 * `'failed'`（`code='no_artifact'`，R226：不把"部分完成"写成"完成"）。
 *
 * ## 假执行器的地位（R224）
 *
 * 构造函数收的是 `RealExecutor`。测试可以传 `createFakeExecutor()`（同一接口），
 * 但**最终验收只认 `createRealExecutor()`** —— 交付说明与测试名里都写明这一点。
 *
 * ## FA-CHAT-REJECT-RETRY：三条被点名的断点
 *
 * 1. **被拒的轮次不进工具循环**：`#beginTurn()` 的返回值是**承重**的。内核没给这一轮
 *    起轮次（stage = `task` / `message` / `run` / `duplicate`）⇒ `#run()` 立刻收手，
 *    **一个模型请求都不发**，并如实记一条 `turn_rejected` 失败。修复前这里只记错误就返回，
 *    调用方照样跑完整个循环 —— 那会产出"没有主人"的文件。
 * 2. **重试有独立的尝试记录**：轮次身份由 (会话, 消息, **尝试序号**) 派生
 *    （见 `chat-product.ts` 的 `conversationTurnKernelIds`）。重试因此是一轮**新的**
 *    内核轮次 + 工作项，而不是撞上 `duplicate_not_created` 后拿旧记录蒙混。
 * 3. **当前文档跨进程可恢复**：`currentDocument()` 的内存 Map 只是缓存，真相在
 *    **内核 store**（`shared_facts` 的 `conversation.current_document` + 产物记录）。
 *    核不上就返回 `undefined`（换运行目录 ⇒ 恢复必然失败），不把全局位置当本会话数据。
 *
 * 另有：**取消后的迟到结果不得发布** —— 工具调用是异步的，`runToolLoop` 只能保证
 * "下一次模型请求之前停下"。`#publishDocument` 因此在写盘前后各查一次取消信号
 * （`abortedNow`），写盘已发生但未发布时产物停在 `staged`，不写 `published`、不改 `current`。
 *
 * ## R219：宿主与验证者必须能核对同一候选
 *
 * `identity()` 给出**实际生效**的运行身份（端口 / 运行目录 / 运行 id / 构建 id /
 * 内核存储路径 / 产物根）。运行 id 由**运行目录名**派生，**不是**写死的常量——
 * `POTBOT_PORT` / `POTBOT_RUN_DIR` 改了，这里就会跟着变；验证者读到的是同一份值。
 */

import { createHash } from 'node:crypto';

import {
  applyTaskPatch,
  asFactRef,
  asGroupId,
  asInstanceId,
  asLogicalTime,
  asRevision,
  asTaskId,
  createArtifactRecord,
  createGroupMember,
  createIdSource,
  createInstanceState,
  createSharedFactRecord,
  createTaskPatch,
  createTaskRecord,
  isDeliveredArtifact,
  type ArtifactRecord,
  type FactRef,
  type GroupId,
  type IdSource,
  type InstanceId,
  type LogicalTime,
  type Revision,
  type Store,
  type TaskId,
} from '../../../src/protocol/index.js';
import { LogicalClock } from '../../../src/clock/index.js';
import { logicalTimeHighWater } from '../../../src/storage/store-core.js';
import {
  createArtifactPublicationProjection,
  digestBytes,
  materializationFailure,
  materializationSuccess,
  planArtifact,
  resolveNextArtifactVersion,
  selfCheckArtifactBytes,
  type ArtifactMaterializationPort,
  type ArtifactMaterializationReceipt,
  type ArtifactMaterializationRequest,
  type ArtifactMaterializationResult,
  type ArtifactPlan,
  type KnownFactSnapshotEntry,
  type StagedArtifactFact,
} from '../../../src/artifacts/index.js';
import {
  buildDocxTemplate,
  DOCX_TITLE_BODY_PRESENTATION,
  untraceableDigitRuns,
} from '../../../src/artifacts/templates/docx.js';
import { applyWordFormatting, parseWordFormatRequest } from './word-format-product.js';
import { publicationEventHooks } from './kernel.js';
import { taskCompletionOf, type TaskCompletionView } from './task-completion.js';
import {
  ConversationTurnLedger,
  type ConversationTurnKernelIds,
  type ConversationTurnSettlement,
} from './chat-product.js';
import type { Scheduler } from '../../../src/scheduler/index.js';
import { normalizeDocxFilename, type DocumentPort } from '../documents/port.js';
import {
  DEFAULT_EXECUTOR_BUDGET,
  runToolLoop,
  type ExecutorBudget,
  type ExecutorMessage,
  type RealExecutor,
  type ToolHandler,
  type ToolLoopResult,
} from '../model/executor.js';
import { isModelCallError } from '../model/errors.js';
import { asOwnerId, type MemoryRepository, type OwnerId } from '../../../src/memory/index.js';
import {
  buildConversationContext,
  type ConversationContextResult,
  type ConversationMemoryContext,
} from './mem-inject-product.js';
import {
  writeMemoryRecord,
  type ConversationMessageWrite,
  type TaskFactWrite,
} from './mem-write-side.js';
import {
  ConversationStore,
  conversationFail,
  conversationOk,
  type ConversationArtifactRef,
  type ConversationMessage,
  type ConversationResult,
  type ConversationSummary,
} from './conversation-store.js';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 会话任务 id 前缀（与生成链的 `T-<hex>`、编辑链的 `T-doc-` 三足鼎立，不混身份）。 */
export const CONVERSATION_TASK_PREFIX = 'T-conv-';

/** 产物文件名前缀（`normalizeDocxFilename` 会补 `.docx`）。 */
export const CONVERSATION_FILENAME_STEM = 'conversation-document';

/** 工具名（模型看到的字面量；声明与执行**同一处定义**，不会分叉）。 */
export const TOOL_CREATE_DOCUMENT = 'create_word_document';
export const TOOL_READ_CURRENT_DOCUMENT = 'read_current_document';
/**
 * **排版工具**（FA-FIX-FORMAT-CLAIM）：修复前这条链上**没有**能表达排版的工具，
 * 于是"标题居中、加粗、三号字…"只能被模型写进**回复文字**里，产物字节不变而版本号照涨。
 */
export const TOOL_FORMAT_DOCUMENT = 'format_word_document';

/** 源事实键（产物记录要求 `source_fact_refs` 非空）。 */
export const CONVERSATION_SOURCE_FACT_KEY = 'conversation.source';

/**
 * 「本会话当前文档」在内核 shared fact 里的稳定键（FA-CHAT-REJECT-RETRY）。
 *
 * 落盘介质就是**内核 store 自己**（`Store.shared_facts`，与产物记录、任务同一次落盘），
 * 不另开文件、不另开账本 —— 这是"复用既有 store / 落盘端口"的落点。
 */
export const CONVERSATION_CURRENT_DOC_FACT_KEY = 'conversation.current_document';

/**
 * 系统提示：**不说"你完成了"就算完成**。
 *
 * 明确要求它不要写数字，是因为 DOCX 模板链有一条真实约束（`untraceableDigitRuns`）：
 * 没有来源登记的数字会被**拒绝**。与其让它在验收时第一次撞墙，不如先讲清楚——
 * 撞墙时工具也会返回结构化原因，模型据此重试（这正是工具循环存在的意义）。
 */
const SYSTEM_PROMPT = [
  '你是 potbot 的文档助手，用中文与用户连续对话，并按用户要求产出**真实可下载的 Word 文档**。',
  '',
  '规则：',
  '1. 只有调用工具，文档才会被真的产出 / 真的改动；**不要**用文字声称已经生成或已经改好。',
  '2. 用户要求建文档或整篇重写时，把**完整的**标题与正文段落交给 `create_word_document`（不是只给改动部分）。',
  '3. 用户要求**排版**（对齐 / 加粗 / 字号 / 首行缩进 / 加表格）时，**必须**调用 `format_word_document`。' +
    '只在回复里写"已居中 / 已加粗 / 已插入表格"而**没有**调用它，是编造——产物字节不会因此改变。',
  '4. 正文 2–4 段，每段是一句话到几句话；总字数不超过 2000 字。',
  '5. **正文、标题与表格单元格里都不要出现阿拉伯数字**（模板链要求数字必须有来源登记，否则会被拒绝）。',
  '6. 需要确认当前文档是什么时，先调 `read_current_document`，不要凭记忆猜。',
  '7. 工具返回失败时，按它给的结构化原因修正后**重试**，不要把失败说成成功；' +
    '若工具明确回话说"没有产生任何字节变化"，就必须如实告诉用户**没有改动**，不得声称改好了。',
  '',
  '工具与参数（**参数名必须逐字一致**，多一个键都会被拒绝）：',
  '- `create_word_document`：从零生成 / 整篇重写。参数：title（字符串，必填）、paragraphs（字符串数组，必填，2–4 段）。',
  '- `read_current_document`：读回本会话当前文档。**无参数**。',
  '- `format_word_document`：给**本会话当前文档**施加排版（不改正文文字）。参数**全部可选，但至少要给一个**：',
  '  · title_alignment：字符串，取 center / left / right / justify / distribute（居中就是 center）；',
  '  · title_bold：布尔值（加粗就是 true）；',
  '  · title_font_size：数字（磅值）或字符串（中文字号名，例如 三号）；',
  '  · body_first_line_indent_chars：数字，正文每个段落首行缩进的**字符数**（缩进两个字符就是 2）；',
  '  · table：对象，键为 rows（行数）、cols（列数）、header（布尔，首行是否表头）、' +
    'cells（可选，二维字符串数组，行×列，给每个单元格的文字）。',
  '  需要"三行两列的表格"时：table 的 rows 给三、cols 给二。',
].join('\n');

// ---------------------------------------------------------------------------
// 选项与身份
// ---------------------------------------------------------------------------

/** R219：可核对的候选身份（宿主与验证者读同一份）。 */
export interface CandidateIdentity {
  /** 运行 id：**由运行目录名派生**，不是写死的常量。 */
  readonly runId: string;
  readonly runDir: string;
  /** 实际生效的监听端口。 */
  readonly port: number;
  readonly bind: string;
  readonly repoRoot: string;
  readonly buildId: string;
  readonly bootId: string;
  readonly artifactRootDir: string;
  readonly kernelStorePath: string;
  readonly conversationDir: string;
  readonly model: string | null;
  readonly provider: string | null;
}

// ---------------------------------------------------------------------------
// 记忆接线（FA-MEM-INTO-CHAT）：写侧 + 稳定 owner 来源
// ---------------------------------------------------------------------------

/**
 * 记忆写入的 **owner 命名空间前缀**（与其它 owner 命名空间区分，一眼可辨来源）。
 *
 * 与 `mem-write-side.ts` 的 `STABLE_ID_PREFIX = 'mw'` 同理：这是"这条记忆是谁写的"的
 * 可读标记，不是隔离判据（隔离判据是 `owner_id` 本身）。
 */
export const CONVERSATION_MEMORY_OWNER_PREFIX = 'conv-';

/**
 * **稳定 owner 来源**：由会话 id **确定性派生**（`conv-<sha256(conversationId)[:32]>`）。
 *
 * ## 为什么是它（这个选择必须写明，不得凭空编造用户身份）
 *
 * 本宿主目前**没有**账号 / 登录体系：会话是**客户端**建的（`conversation-store.js` 的本地
 * 会话 id），服务端手里唯一稳定的、可跨重启复现的身份来源就是**会话 id 本身**。
 * 于是 owner 取它的确定性哈希，而不是：
 *
 * - **不**编一个用户名 / 手机号 / "default-user" —— 那是**伪造**用户身份（R235/R237 要求
 *   记忆必须归属到真实主体，本层没有那个信息就不假装有）；
 * - **不**用进程级 / 全局常量 —— 那会把所有会话的记忆并成**一个**主体，跨用户隔离形同虚设。
 *
 * ## 它的语义与代价（如实标注，不夸大）
 *
 * - 语义：**一个会话 = 一个记忆主体**。同一会话的后续轮次因此能看见前面轮次写入的记忆
 *   （这是本包闭环证明的基础）；不同会话**互为**他主体，读不到对方。
 * - 代价：**同一用户的不同会话之间，记忆不共享**。这是**保守**的边界——宁可少共享，
 *   也不要把两个会话错误地并成一个人。将来接入账号体系时，只需把这个函数换成
 *   "账号 id ⇒ owner"，调用点一处都不用改。
 */
export function ownerIdForConversation(conversationId: string): OwnerId {
  const digest = createHash('sha256').update(conversationId, 'utf8').digest('hex').slice(0, 32);
  return asOwnerId(`${CONVERSATION_MEMORY_OWNER_PREFIX}${digest}`);
}

/**
 * 宿主注入的**记忆接缝**（与 `MemoryRouteHost` 对接的那一层；本模块只消费，不重造仓库）。
 *
 * - `open()`：打开（惰性）记忆仓库；不可用（未注入持久端口 / 读不回来）⇒ `null`。
 *   返回 `null` 时本模块**什么都不写**——绝不退回进程内存冒充"已记住"（R220/R240）。
 * - `ownerOf()`：可选覆盖 owner 来源；**省略**用 {@link ownerIdForConversation}。
 *   返回空串 / 非字符串 ⇒ 写入**结构化拒绝**（缺 owner，不编造身份）。
 * - `persist()`：可选落盘；抛错由本模块**如实登记**（`memoryDiagnostics()`），不静默吞。
 */
export interface ConversationMemoryBinding {
  open(): MemoryRepository | null;
  ownerOf?(conversationId: string): string;
  persist?(at: LogicalTime): void;
}

/**
 * 一条记忆写入的**只读台账**（宿主读口 `memoryWrites()`）。
 *
 * `ok:false` 是**结构化拒绝**（缺 owner / 超长 / 来源缺失 / 仓库失败），**不是**"悄悄跳过"：
 * 反向对照要能拿它证明"缺 owner 时确实没写进去、且原因可判"。
 */
export interface ConversationMemoryWrite {
  readonly conversationId: string;
  /** 写入标签（`session_message:user` / `session_message:assistant` / `task_fact:<key>` / `owner`）。 */
  readonly label: string;
  readonly ownerId: string;
  readonly ok: boolean;
  /** `created` / `existing`；失败时 `null`。 */
  readonly outcome: string | null;
  readonly memoryId: string | null;
  /** 失败原因（`mem-write-side.ts` 的封闭枚举之一）；成功时 `null`。 */
  readonly reason: string | null;
  readonly detail: string;
}

export interface ConversationHostOptions {
  readonly store: ConversationStore;
  /** 内核存储（与 `KernelHost` **同一个**：产物记录要落在同一个真相源里）。 */
  readonly kernelStore: Store;
  /** 物化端口；`null` ⇒ 工具**如实失败**，绝不用"内存里的字节"顶替。 */
  readonly documents: DocumentPort | null;
  /** 真实执行器；`null` ⇒ 收下消息但如实标失败（`model_not_configured`）。 */
  readonly executor: RealExecutor | null;
  readonly runId: string;
  readonly artifactRootDir: string;
  readonly identity: CandidateIdentity;
  readonly now?: () => Date;
  readonly budget?: ExecutorBudget;
  /** 系统提示覆盖（测试用；省略用产品默认）。 */
  readonly systemPrompt?: string;
  /**
   * 内核调度器（与 `KernelHost` **同一个**：轮次 / 工作项 / 事件 id 都写在同一个真相源里）。
   *
   * **加法接线（FA-CHAT-PRODUCT-LOOP）**：给出后，每轮对话经内核 `onMessage` + `startRun`
   * 起**真实轮次**并落**真实工作项**，于是任务级完成口径能对该会话任务给出真实结论；
   * 省略 ⇒ 完全维持既有行为（不产生轮次 / 工作项），完成视图对该任务如实报"尚未完成"。
   */
  readonly scheduler?: Scheduler | null;
  /**
   * 完成口径要判"轮次租约是否过期"，而租约用**逻辑**时间。给出后与内核宿主取同一口
   * （`KernelHost.logicalNow()`）；省略时退回本宿主自己的逻辑钟（同源起步，单调不减）。
   */
  readonly logicalNow?: () => LogicalTime;
  /**
   * **记忆接线（FA-MEM-INTO-CHAT，加法）**：给出后
   * - 每轮对话结束（无论完成 / 失败 / 取消 / 抛异常）都把**用户消息**与**助手回复 / 任务事实**
   *   经既有 `writeMemoryRecord` 落进**同一个**记忆仓库（不建第二份账本）；
   * - 每轮组装上下文时把 `buildConversationContext` 的注入块并进执行器上下文。
   *
   * **省略 / `null` ⇒ 与接线前逐字一致**（不写一条记忆、不注入任何记忆）——这条"省略即不接线"
   * 正是反向对照要的：证明注入不是凭空出现的。
   */
  readonly memory?: ConversationMemoryBinding | null;
}

export interface SendOutcome {
  readonly message: ConversationMessage;
  readonly duplicate: boolean;
  /** 本次是否触发了执行（重复投递不触发，R207）。 */
  readonly started: boolean;
}

export interface DownloadOutcome {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly artifactId: string;
  readonly sha256: string;
}

/**
 * 会话**搜索**的命中项：会话摘要 + 命中的**首条消息**正文（标题命中而首条不命中时为 `null`）。
 *
 * 为什么要带命中正文：只回一个标题列表，调用方无法判断"是标题命中的还是内容命中的"，
 * 也就无法在界面上把命中片段高亮出来（那正是"搜索"与"过滤列表"的区别）。
 */
export interface ConversationSearchHit extends ConversationSummary {
  readonly matchedFirstMessage: string | null;
}

/** 会话搜索的**一页**（CHAT-02）。`total` 是**匹配总数**，不是本页条数。 */
export interface ConversationSearchPage {
  readonly query: string;
  readonly conversations: readonly ConversationSearchHit[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  /** 分页之后是否还有下一页（`offset + conversations.length < total`）。 */
  readonly more: boolean;
}

/** 搜索分页边界（默认值 / 上限；越界由宿主结构化拒绝，**不**静默夹紧）。 */
export const CONVERSATION_SEARCH_LIMITS = Object.freeze({
  defaultLimit: 20,
  maxLimit: 100,
});

/**
 * 删除一个会话的结论（CHAT-08）。
 *
 * 这两个字段是**语义**，不是装饰：
 *
 * - `detached_tasks`：删会话**不取消**它的任务——原样留在内核任务账本里的任务 id 在这里列出；
 * - `reverted`：**字面量 `false`**。删除聊天记录**不等于**撤销已经发生的外部副作用
 *   （与 `ActionSideEffect.reverted`、`external_actions_reverted` 同一条纪律：
 *   在类型上就写不出"已撤销"）。
 */
export interface ConversationDeleteOutcome {
  readonly conversationId: string;
  readonly deleted: true;
  readonly detached_tasks: readonly string[];
  readonly reverted: false;
}

/** 「本会话当前文档」= 已发布的产物引用 + 只有内存里才有、因此必须顺带落盘的两项。 */
export interface CurrentDocumentEntry {
  readonly ref: ConversationArtifactRef;
  /** 标题与正文段落：模板链只把它们编进 DOCX 字节，别处读不回来，故随关联一并落盘。 */
  readonly title: string;
  readonly paragraphs: readonly string[];
}

/**
 * `#beginTurn` 的结论（FA-CHAT-REJECT-RETRY）。
 *
 * `ok:false` ⇒ **本轮在内核里没开工**（没有轮次、没有工作项）：调用方必须直接收手，
 * 一个模型请求都不许发。`stage` 就是卡在哪一步（`task` / `message` / `run` / `duplicate`）。
 */
type TurnBeginOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly stage: string; readonly reason: string };

/**
 * 一轮对话里**工具动作的如实台账**（FA-FIX-FORMAT-CLAIM）。
 *
 * 为什么不是一句 `toolCalls.includes('create_word_document')`：那句话只证明"模型**提过**要建文档"，
 * 不证明"发布链**真的产出**了一份新产物"。修复前正是这个差别让"调了工具、字节没变、
 * 版本号却 +1、状态还写 completed"成为一种可发生的编造成功。
 *
 * - `produced`：本轮**真的发布出去的那一份**（发布失败 / 被判 `no_change` 时保持 `null`）；
 * - `attempts`：本轮发起过的工具名（按顺序；供取消结算如实报"调用了几次"）；
 * - `lastFailure`：最近一次工具失败的 `code` + 原因（供本轮收尾时如实写出**为什么**没产出）。
 */
interface TurnToolOutcome {
  produced: ConversationArtifactRef | null;
  readonly attempts: string[];
  lastFailure: { readonly code: string; readonly detail: string } | null;
}

// ---------------------------------------------------------------------------
// 宿主
// ---------------------------------------------------------------------------

export class ConversationHost {
  readonly #options: ConversationHostOptions;
  readonly #store: ConversationStore;
  readonly #kernel: Store;
  readonly #documents: DocumentPort | null;
  readonly #executor: RealExecutor | null;
  readonly #ids: IdSource = createIdSource();
  readonly #clock: LogicalClock;
  readonly #now: () => Date;
  readonly #budget: ExecutorBudget;
  readonly #systemPrompt: string;
  /**
   * 每个会话当前**已发布**的文档（"指代当前文件"的答案来自这里，不来自模型记忆）。
   *
   * **它是缓存，不是真相源**（FA-CHAT-REJECT-RETRY）：真相在**内核 store**里
   * （`Store.shared_facts` 的 `conversation.current_document` + 产物记录）。
   * 进程重启后内存为空，`currentDocument()` 会从内核记录重建并回填这里。
   */
  readonly #current = new Map<string, CurrentDocumentEntry>();
  /** 在途执行的取消开关（messageId → controller）。 */
  readonly #inflight = new Map<string, AbortController>();
  readonly #unhandled: string[] = [];
  /**
   * 本轮对话对应的内核轮次身份（`messageId → 身份 + 是否已写结局`）。
   *
   * 只在**接线了 scheduler** 时才有条目；它保证同一轮次只写一次结局（幂等），
   * 也让"起轮次后执行链异常"也能被收成一条真实结局（见 `#dispatch` 的兜底）。
   */
  readonly #turns = new Map<string, { readonly ids: ConversationTurnKernelIds; settled: boolean }>();
  /** 内核轮次台账（未接线时为 `null`：不产生轮次 / 工作项，行为与接线前逐字一致）。 */
  readonly #turnLedger: ConversationTurnLedger | null;
  /** 完成口径取用的**逻辑**时间（与内核宿主同口；未给时退回本宿主自己的逻辑钟）。 */
  readonly #logicalNow: () => LogicalTime;
  /** 记忆接缝（未接线为 `null`：不写一条记忆、不注入任何记忆，行为与接线前逐字一致）。 */
  readonly #memory: ConversationMemoryBinding | null;
  /** 记忆写入的只读台账（宿主读口 `memoryWrites()`；`ok:false` 也是**如实**的记录）。 */
  readonly #memoryWrites: ConversationMemoryWrite[] = [];
  /** 记忆链的结构性异常（仓库打开失败 / 注入被拒 / 落盘失败 / 写入链抛错），如实登记。 */
  readonly #memoryDiagnostics: string[] = [];

  constructor(options: ConversationHostOptions) {
    this.#options = options;
    this.#store = options.store;
    this.#kernel = options.kernelStore;
    this.#documents = options.documents;
    this.#executor = options.executor;
    this.#now = options.now ?? ((): Date => new Date());
    this.#budget = options.budget ?? DEFAULT_EXECUTOR_BUDGET;
    this.#systemPrompt = options.systemPrompt ?? SYSTEM_PROMPT;
    // 逻辑时钟从**已持久化的高水位**起步（R203 的同一条纪律）：不复用则重启后
    // 本模块写出的内核事件会带一个比既有事件更小的逻辑时间，把顺序搅乱。
    this.#clock = new LogicalClock();
    const high = logicalTimeHighWater(this.#kernel.snapshot());
    if (high > 0) {
      this.#clock.advance(high, 'conversation host: 从落盘高水位起步');
    }
    // 加法接线：给了内核调度器才建立轮次台账（没给 ⇒ 与接线前逐字一致）。
    this.#turnLedger = options.scheduler === undefined || options.scheduler === null
      ? null
      : new ConversationTurnLedger(options.scheduler);
    this.#logicalNow = options.logicalNow ?? ((): LogicalTime => this.#clock.now());
    // 记忆接线（加法）：没给 / `null` ⇒ 与接线前逐字一致（不写、不注入）。
    this.#memory = options.memory ?? null;
  }

  /**
   * 会话对应内核任务的**任务级完成口径**派生视图（合同附五 R261–R263）。
   *
   * **只读**：完成是从工作项 / 轮次 / 动作三个集合**算出来**的，没有任何写口。
   * 与 `DeliverableHost.completionOf` 同一个派生模块，只是任务的家是 `T-conv-*`。
   *
   * 任务还没在内核里登记时返回 `undefined`（**不是**"尚未完成"——那是两种不同的回答）。
   */
  completionOf(conversationId: string): TaskCompletionView | undefined {
    return taskCompletionOf(
      this.#kernel,
      String(ConversationHost.taskIdOf(conversationId)),
      this.#logicalNow(),
    );
  }

  /** 该会话在内核里的工作项（只读旁证；接线前后对照都用它）。 */
  kernelWorkItems(conversationId: string): readonly { readonly request_id: string; readonly status: string }[] {
    const taskId = String(ConversationHost.taskIdOf(conversationId));
    return Object.freeze(
      this.#kernel
        .snapshot()
        .work_items.filter((item) => String(item.task_id) === taskId)
        .map((item) => Object.freeze({ request_id: String(item.request_id), status: item.status })),
    );
  }

  /** 该会话在内核里的轮次（只读旁证）。 */
  kernelRuns(conversationId: string): readonly { readonly run_id: string; readonly status: string }[] {
    const taskId = String(ConversationHost.taskIdOf(conversationId));
    return Object.freeze(
      this.#kernel
        .snapshot()
        .runs.filter((run) => String(run.task_id) === taskId)
        .map((run) => Object.freeze({ run_id: String(run.run_id), status: run.status })),
    );
  }

  identity(): CandidateIdentity {
    return this.#options.identity;
  }

  /**
   * 启动时的诚实归位（R215/R216/R217）。
   *
   * 把上一进程**在途**的消息标成失败（`code='server_restarted'`, `retryable:true`），
   * 并补一条 `server_restarted` 事件。**不盲目重放**——上一进程可能已经发出过模型
   * 请求、甚至已经写过盘。返回被归位的消息，供启动日志如实报告"中断了几个"。
   */
  reconcileAfterRestart(): readonly { readonly conversationId: string; readonly messageId: string }[] {
    return this.#store.reconcileAfterRestart();
  }

  /** 启动日志用：未能归位的内途执行（异常被吞掉的那些，**如实登记**）。 */
  unhandledErrors(): readonly string[] {
    return Object.freeze([...this.#unhandled]);
  }

  /**
   * 「本会话当前是哪份文档」——**跨进程重启也读得回来**（FA-CHAT-REJECT-RETRY）。
   *
   * ## 为什么不是一句 `this.#current.get(conversationId)`
   *
   * 修复之前答案只活在**进程内的 Map** 里：重启后 `currentDocument()` 返回 `undefined`，
   * 于是"继续改刚才那份文档"变成"没有当前文档"，或者更糟 —— 调用方退回到某个全局位置，
   * 把**别的运行目录 / 别的会话**的产物当成本会话的数据。那是把"读不回来"伪装成"就是它"。
   *
   * ## 现在的口径
   *
   * 内存里有就用内存（同一进程内的快路径）；**没有就回内核 store 恢复**：
   *
   * 1. 按确定性 fact id 读 `shared_facts` 里的 `conversation.current_document`
   *    （**同一个内核 store**，与任务 / 产物 / 轮次同一次落盘，没有第二份账本）；
   * 2. 记下的 `artifactId` **必须在本内核 store 里存在**，且是一条**已交付**
   *    （`isDeliveredArtifact` 且回执非空）记录，任务也要对得上；
   * 3. 版本 / 摘要 / 字节数 / 文件名**一律以产物记录为准**（事实里只存
   *    "哪一份 + 标题 + 正文"，这些是别处读不回来的那几项）。
   *
   * 任一步不成立 ⇒ **返回 `undefined`**（如实说"本会话没有当前文档"）。
   * 这条"核不上就不认"的纪律正是反向对照要的：换一个独立的运行目录（那里既没有这条事实，
   * 也没有那份产物记录）⇒ 恢复**必须失败**，而不是把全局位置当成本会话数据。
   */
  currentDocument(conversationId: string): CurrentDocumentEntry | undefined {
    const cached = this.#current.get(conversationId);
    if (cached !== undefined) {
      return cached;
    }
    const restored = this.#restoreCurrent(conversationId);
    if (restored !== undefined) {
      this.#current.set(conversationId, restored);
    }
    return restored;
  }

  // --- 发消息（R207/R209）-------------------------------------------------

  /**
   * 收下一条用户消息并**开始**（不等待）执行。
   *
   * 幂等：同一 `clientId` 重发 ⇒ 返回既有消息、`duplicate:true`、**不再起一次执行**
   * （R207 的"重试不重复建任务"在服务端的落点）。
   */
  send(conversationId: string, clientId: string, text: string): ConversationResult<SendOutcome> {
    // **按需建立会话**：网页侧的会话是本机建的（`conversation-store.js`），服务端
    // 第一次见到这个 id 时就落一份库——否则客户端的消息与游标无处归属。
    if (!this.#store.has(conversationId)) {
      const created = this.#store.createConversation(undefined, conversationId);
      if (!created.ok) {
        return created as ConversationResult<SendOutcome>;
      }
      this.#store.appendEvent(conversationId, {
        kind: 'conversation_created',
        detail: { adopted: true },
      });
    }
    const accepted = this.#store.acceptMessage({ conversationId, clientId, text });
    if (!accepted.ok) {
      return accepted as ConversationResult<SendOutcome>;
    }
    if (accepted.value.duplicate) {
      return conversationOk(
        Object.freeze({ message: accepted.value.message, duplicate: true, started: false }),
      );
    }
    const message = accepted.value.message;
    this.#store.appendEvent(conversationId, {
      kind: 'run_requested',
      messageId: message.messageId,
      state: 'received',
      phase: 'accepted',
      detail: { attempts: message.attempts },
    });
    this.#dispatch(conversationId, message);
    return conversationOk(Object.freeze({ message, duplicate: false, started: true }));
  }

  /** 重试一条失败/取消的消息：复用同一条消息与同一个幂等键（R207）。 */
  retry(conversationId: string, messageId: string): ConversationResult<ConversationMessage> {
    const retried = this.#store.retryMessage(conversationId, messageId);
    if (!retried.ok) {
      return retried;
    }
    this.#store.appendEvent(conversationId, {
      kind: 'run_retried',
      messageId,
      state: 'received',
      phase: 'accepted',
      detail: { attempts: retried.value.attempts },
    });
    this.#dispatch(conversationId, retried.value);
    return retried;
  }

  /** 取消一条在执行的消息：abort 信号会让工具循环在**下一次请求之前**停下。 */
  cancel(conversationId: string, messageId: string): ConversationResult<ConversationMessage> {
    const controller = this.#inflight.get(key(conversationId, messageId));
    if (controller !== undefined) {
      controller.abort();
    }
    const cancelled = this.#store.cancelMessage(conversationId, messageId);
    if (!cancelled.ok) {
      return cancelled;
    }
    this.#store.appendEvent(conversationId, {
      kind: 'run_cancelled',
      messageId,
      state: 'cancelled',
      phase: 'cancelled',
      detail: controller === undefined ? { inflight: false } : { inflight: true },
    });
    return cancelled;
  }

  // --- 事件与游标（R208）--------------------------------------------------

  events(conversationId: string, cursor: string | null | undefined) {
    return this.#store.eventsSince(conversationId, cursor);
  }

  /** 当前游标（会话末尾）。客户端拿到它就知道"我已经消费到哪"。 */
  headCursor(conversationId: string): string {
    return this.#store.headCursor(conversationId);
  }

  /** 会话列表（不含已归档）。 */
  listConversations(includeArchived = false): readonly ConversationSummary[] {
    const all = this.#store.list();
    return includeArchived ? all : Object.freeze(all.filter((item) => !item.archived));
  }

  /** 只读：一个会话的完整记录（不存在返回 `undefined`，**不**隐式创建）。 */
  readConversation(conversationId: string) {
    return this.#store.get(conversationId);
  }

  /**
   * **「读不回来」与「没有这个会话」是两回事**（R216/R240）。
   *
   * 启动时读不回来的会话进不了内存，但它的落盘文件还在。若把它当成"不存在"返回 404，
   * 用户会以为会话被删了——那是**把数据丢失伪装成正常**。本方法把这类会话如实报出来，
   * HTTP 层据此回一个可判的 `conversation_unreadable`（带具体原因），而不是 404。
   */
  unreadable(conversationId: string): { readonly conversationId: string; readonly reason: string } | undefined {
    return this.#store.unreadableConversations().find((item) => item.conversationId === conversationId);
  }

  /** 启动自检的只读旁证（"读不回来"与"落盘上有但没进内存"两张名单）。 */
  diagnostics(): {
    readonly unreadable: readonly { readonly conversationId: string; readonly reason: string }[];
    readonly missingFromMemory: readonly string[];
    readonly unhandledErrors: readonly string[];
  } {
    return Object.freeze({
      unreadable: this.#store.unreadableConversations(),
      missingFromMemory: this.#store.missingFromMemory(),
      unhandledErrors: this.unhandledErrors(),
    });
  }

  // --- 记忆的宿主读口（FA-MEM-INTO-CHAT；只读，不写库）---------------------

  /**
   * 本会话（省略 = 全部会话）的**记忆写入台账**。
   *
   * 反向对照靠它判负：缺 owner 时这里必须出现 `ok:false` / `reason:'invalid_shape'`
   * 的条目，且**仓库里一条都没多**——"没写进去"与"悄悄跳过"必须分得开。
   */
  memoryWrites(conversationId?: string): readonly ConversationMemoryWrite[] {
    const all = this.#memoryWrites;
    return Object.freeze(
      conversationId === undefined ? [...all] : all.filter((item) => item.conversationId === conversationId),
    );
  }

  /** 记忆链的**如实登记**（未接线时恒空）：仓库打开失败 / 注入被拒 / 落盘失败 / 写入链抛错。 */
  memoryDiagnostics(): readonly string[] {
    return Object.freeze([...this.#memoryDiagnostics]);
  }

  /**
   * **宿主读口**：本次会话此时此刻会注入上下文的记忆块（与执行器真正拿到的是**同一条**
   * 构造路径 `#memoryBlockFor()`）。
   *
   * 未接线（`memory` 省略 / 仓库不可用 / owner 缺失）⇒ `null`：**"没有记忆接线"与
   * "有接线但暂时没记住"是两件不同的事**，故用 `null` 与 `{ok:true, context}` 分开表达，
   * 不把两者压成同一个"空"。
   */
  memoryContext(conversationId: string): ConversationContextResult | null {
    const repository = this.#memoryRepository();
    if (repository === null) {
      return null;
    }
    const ownerRaw = this.#memoryOwnerRaw(conversationId);
    if (ownerRaw === '') {
      return null;
    }
    return buildConversationContext({
      conversationId,
      taskId: ConversationHost.taskIdOf(conversationId),
      ownerId: asOwnerId(ownerRaw),
      repository,
    });
  }

  // --- 记忆接线（私有）----------------------------------------------------

  /** 打开记忆仓库；不可用 ⇒ `null`（**不退回进程内存冒充持久**，R220）。 */
  #memoryRepository(): MemoryRepository | null {
    const binding = this.#memory;
    if (binding === null) {
      return null;
    }
    try {
      return binding.open();
    } catch (error) {
      this.#memoryDiagnostics.push(`记忆仓库打开失败：${describe(error)}`);
      return null;
    }
  }

  /** 生效的 owner 原始串；未接线 / owner 缺失 ⇒ 空串（调用方据此**结构化拒绝**写入）。 */
  #memoryOwnerRaw(conversationId: string): string {
    const binding = this.#memory;
    if (binding === null) {
      return '';
    }
    const override = binding.ownerOf;
    const raw = override === undefined ? String(ownerIdForConversation(conversationId)) : override(conversationId);
    return typeof raw === 'string' ? raw : '';
  }

  /**
   * 本轮会并进执行器上下文的**记忆块**（读侧接线；失败 ⇒ `null` 且如实登记）。
   *
   * 注入失败（隔离绊线 / 上限 / 闸门）时**不放记忆**：宁可这一轮没有记忆，
   * 也不把无法核对的条目塞给模型。
   */
  #memoryBlockFor(conversationId: string): ConversationMemoryContext | null {
    const result = this.memoryContext(conversationId);
    if (result === null) {
      return null;
    }
    if (!result.ok) {
      this.#memoryDiagnostics.push(`上下文记忆注入被拒（${result.code}）：${result.message}`);
      return null;
    }
    return result.context;
  }

  /**
   * **每轮结束**后把这一轮的记忆写进仓库（写侧接线）。
   *
   * 写什么（四类分型里的两类，全部经 `writeMemoryRecord`）：
   * | 条目 | 范围 | 来源 |
   * |---|---|---|
   * | `session_message` user（用户本轮发言） | 用户范围 | `user_statement` |
   * | `session_message` assistant（助手本轮回复） | 用户范围 | `inference`（系统产出，非用户陈述） |
   * | `task_fact turn.<n>.user` | 任务范围 | `user_statement` |
   * | `task_fact turn.<n>.assistant` | 任务范围 | `inference` |
   *
   * 为什么用户发言**两份都写**：`session_message` 是用户范围的会话记忆（供
   * `GET /api/memory/injection?owner_id=…` 读回）；`task_fact` 是任务范围的记载，
   * 也是**对话上下文注入**真正取到的那一类（`buildConversationContext` 按任务过滤，
   * 见 `mem-inject-product.ts` 的隔离绊线）。
   *
   * 幂等：`session_message` 用显式稳定键（`messageId` 派生）⇒ 重试不会把同一条发言写成两条；
   * `task_fact` 由内容派生 ⇒ 重试命中 `existing`。
   *
   * **失败不吞**：`ok:false` 的结论进 `memoryWrites()` 台账（README 要求的反向对照读口）。
   */
  #recordTurnMemory(conversationId: string, message: ConversationMessage): void {
    const repository = this.#memoryRepository();
    if (repository === null) {
      return;
    }
    const ownerRaw = this.#memoryOwnerRaw(conversationId);
    if (ownerRaw === '') {
      this.#memoryWrites.push(
        Object.freeze({
          conversationId,
          label: 'owner',
          ownerId: '',
          ok: false,
          outcome: null,
          memoryId: null,
          reason: 'invalid_shape',
          detail: '宿主未给出可用 owner：缺 owner 的写入**结构化拒绝**（不凭空编造用户身份，R237）',
        }),
      );
      return;
    }
    const ownerId = asOwnerId(ownerRaw);
    const at = this.#logicalNow();
    const taskId = ConversationHost.taskIdOf(conversationId);
    const turn = this.#turnIndexOf(conversationId, message.messageId);
    const assistantText =
      this.#store.message(conversationId, assistantIdOf(message.messageId))?.text.trim() ?? '';

    const sessionSource = (
      role: 'user' | 'assistant',
      detail: string,
    ): ConversationMessageWrite['source'] => ({ kind: role === 'user' ? 'user_statement' : 'inference', detail });

    const userSession: ConversationMessageWrite = {
      kind: 'session_message',
      owner_id: ownerId,
      conversation_id: conversationId,
      role: 'user',
      text: message.text,
      source: sessionSource('user', `会话 ${conversationId} 第 ${String(turn)} 轮用户发言（客户端 id ${message.messageId}）`),
      confirmation: 'unconfirmed',
      at,
      stable_id: safeStableId(`user-${message.messageId}`),
    };
    this.#writeMemory(repository, conversationId, userSession, 'session_message:user', ownerId);

    if (assistantText !== '') {
      const assistantSession: ConversationMessageWrite = {
        kind: 'session_message',
        owner_id: ownerId,
        conversation_id: conversationId,
        role: 'assistant',
        text: assistantText,
        source: sessionSource('assistant', `助手对会话 ${conversationId} 第 ${String(turn)} 轮的回复（由模型产出，非用户陈述）`),
        confirmation: 'unconfirmed',
        at,
        stable_id: safeStableId(`assistant-${message.messageId}`),
      };
      this.#writeMemory(repository, conversationId, assistantSession, 'session_message:assistant', ownerId);
    }

    const userFact: TaskFactWrite = {
      kind: 'task_fact',
      owner_id: ownerId,
      task_id: taskId,
      fact_key: `turn.${String(turn)}.user`,
      value_text: message.text,
      source: sessionSource('user', `会话 ${conversationId} 第 ${String(turn)} 轮用户发言（任务事实分型）`),
      confirmation: 'unconfirmed',
      at,
    };
    this.#writeMemory(repository, conversationId, userFact, `task_fact:turn.${String(turn)}.user`, ownerId);

    if (assistantText !== '') {
      const assistantFact: TaskFactWrite = {
        kind: 'task_fact',
        owner_id: ownerId,
        task_id: taskId,
        fact_key: `turn.${String(turn)}.assistant`,
        value_text: assistantText,
        source: sessionSource('assistant', `助手对会话 ${conversationId} 第 ${String(turn)} 轮的回复（任务事实分型）`),
        confirmation: 'unconfirmed',
        at,
      };
      this.#writeMemory(repository, conversationId, assistantFact, `task_fact:turn.${String(turn)}.assistant`, ownerId);
    }

    const persist = this.#memory?.persist;
    if (persist !== undefined) {
      try {
        persist(at);
      } catch (error) {
        // 落盘失败**不**把已写进进程内仓库的条目说成没写：如实登记"重启会读不回来"。
        this.#memoryDiagnostics.push(`记忆落盘失败（进程内仓库已写）：${describe(error)}`);
      }
    }
  }

  /** 写一条并**如实**记台账（成功 / 幂等重放 / 结构化拒绝都记，不静默）。 */
  #writeMemory(
    repository: MemoryRepository,
    conversationId: string,
    input: ConversationMessageWrite | TaskFactWrite,
    label: string,
    ownerId: OwnerId,
  ): void {
    const outcome = writeMemoryRecord(repository, input);
    this.#memoryWrites.push(
      Object.freeze(
        outcome.ok
          ? {
              conversationId,
              label,
              ownerId: String(ownerId),
              ok: true,
              outcome: outcome.outcome,
              memoryId: String(outcome.memory_id),
              reason: null,
              detail: outcome.detail,
            }
          : {
              conversationId,
              label,
              ownerId: String(ownerId),
              ok: false,
              outcome: null,
              memoryId: null,
              reason: outcome.reason,
              detail: outcome.detail,
            },
      ),
    );
  }

  /** 本消息在会话里是**第几轮**用户发言（0 起；找不到 ⇒ 0，不靠猜测的序号造事实键）。 */
  #turnIndexOf(conversationId: string, messageId: string): number {
    const record = this.#store.get(conversationId);
    if (record === undefined) {
      return 0;
    }
    const index = record.messages
      .filter((item) => item.role === 'user')
      .findIndex((item) => item.messageId === messageId);
    return index < 0 ? 0 : index;
  }

  /** 显式建会话（客户端指定 id；已存在则幂等返回）。 */
  createConversation(conversationId: string, name?: string) {
    return this.#store.createConversation(name, conversationId);
  }

  // --- 会话生命周期：重命名 / 归档 / 删除 / 搜索（CHAT-02 / CHAT-08）--------
  //
  // 这四个动作在 `ConversationStore` 里本来就有实现（`rename` / `archive` / `delete`、
  // 以及 list），**唯独没有接到产品 HTTP 面**——「有实现但不可达」正是本批要补的缺口。
  // 宿主这一层只做三件事：透传重命名/归档、为删除补上 CHAT-08 的**语义**（任务是否被连带
  // 取消、副作用是否被假称撤销）、为搜索定义**匹配与分页**口径。

  /** 重命名（CHAT-02）。空名由 store 结构化拒绝（`empty_name`，HTTP 层 422）。 */
  renameConversation(conversationId: string, name: string) {
    return this.#store.rename(conversationId, name);
  }

  /** 归档 / 取消归档（CHAT-02）。归档位落在会话记录里并随落盘持久。 */
  archiveConversation(conversationId: string, archived: boolean) {
    return this.#store.archive(conversationId, archived);
  }

  /**
   * 删除一个会话（CHAT-08）。语义是**明确**的，不是含糊的"清理一下"：
   *
   * - **不自动取消它的任务**：删之前挂在这个会话上的内核任务**原样留在任务账本里**，
   *   并在 `detached_tasks` 里如实列出。删掉的是**聊天记录**，不是"正在跑的工作"——
   *   把它一并取消会是一次**用户没要求过的破坏性动作**（`detached` = 任务与它原来的
   *   会话脱钩，但仍然存在、仍然可追踪）。
   * - **不假称撤销已发生的外部副作用**：`reverted` 是**字面量 `false`**。会话里做过的
   *   事（写过的文件、发过的外部动作）**不会**因为删了聊天记录而消失，本服务也不作此声明。
   * - 删除后该 id 在**本进程**内再取 ⇒ `conversation_not_found`（HTTP 层 404）。
   *
   * ## 删除**是持久的**（FA-CONV-DELETE-PERSIST；修复前那条边界已关闭）
   *
   * 改前**实测**的缺陷：`delete -> 200 / get -> 404`，但**同运行目录重启后** `get -> 200`
   * 且列表里仍在 —— 已删的会话复活了（根因：store 只摘内存、不落墓碑）。
   *
   * 现在由 `ConversationStore.delete` 落一条**删除墓碑**（覆盖写同一个落盘槽位）。
   * 重启恢复认到墓碑 ⇒ 该会话不进内存 ⇒ 本方法所在的这条路走 `not_found`（HTTP 404），
   * 也不出现在 `listConversations()` 里。改后**实测**（真起 `main.js` + 真 HTTP，同一运行目录）：
   *
   * ```text
   * A: create -> 201 ; A: delete -> 200 ; A: get -> 404
   * B(restart, same runDir): get -> 404 ; B: get(未删的那个) -> 200 ; B: list 不含已删的
   * ```
   *
   * 落盘失败（墓碑写不下去）⇒ store 结构化 `delete_not_persisted`，本方法把它原样透传
   * （**不**假称已删除）；HTTP 层对未知码回 502，不会回 200。
   */
  deleteConversation(conversationId: string): ConversationResult<ConversationDeleteOutcome> {
    if (!this.#store.has(conversationId)) {
      return conversationFail('conversation_not_found', `没有会话 ${conversationId}`);
    }
    // 先登记"删之前挂着哪些内核任务"——**先量后删**，删完就查不到了（CHAT-08）。
    const taskId = String(ConversationHost.taskIdOf(conversationId));
    const detached = this.#kernel
      .snapshot()
      .tasks.map((task) => String(task.task_id))
      .filter((id) => id === taskId);
    const removed = this.#store.delete(conversationId);
    if (!removed.ok) {
      return conversationFail(removed.code, removed.message);
    }
    // 只清**缓存**（当前文档的真相源在内核 store）：被删会话不该再在内存里留一份关联。
    // 注意**不** abort 在途执行：删会话不等于取消任务（见上）。
    this.#current.delete(conversationId);
    return conversationOk(
      Object.freeze({
        conversationId,
        deleted: true as const,
        detached_tasks: Object.freeze(detached),
        reverted: false as const,
      }),
    );
  }

  /**
   * 会话**搜索**（CHAT-02）：按**标题**或**首条消息**的子串匹配，**大小写不敏感**。
   *
   * ## 为什么只匹配"首条消息"而不是全部消息
   *
   * 口径写在能力目录里（"历史持久化、分页/搜索"），本条实现取的是**可判定的最小口径**：
   * 标题 + 首条消息。全量正文检索是**另一件事**（要建索引、要处理 500 条消息 × 64 会话的
   * 扫描成本），本轮**未做**——不要把它当成"已经支持全文搜索"。
   *
   * ## 空查询**不**回落成"返回全部"
   *
   * `q` 为空 ⇒ 结构化 `empty_query`（HTTP 层 400）。把空查询当成"匹配一切"返回全部会话，
   * 是**拿列表冒充搜索**——调用方会以为"搜到了 64 条"，而其实一条都没搜。
   */
  searchConversations(input: {
    readonly query: string;
    readonly includeArchived?: boolean;
    readonly limit?: number;
    readonly offset?: number;
  }): ConversationResult<ConversationSearchPage> {
    const needle = input.query.trim().toLowerCase();
    if (needle === '') {
      return conversationFail('empty_query', '搜索词不能为空（空查询不返回全部冒充搜索）');
    }
    const limit = input.limit ?? CONVERSATION_SEARCH_LIMITS.defaultLimit;
    const offset = input.offset ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > CONVERSATION_SEARCH_LIMITS.maxLimit) {
      return conversationFail(
        'invalid_pagination',
        `limit 必须是 1–${String(CONVERSATION_SEARCH_LIMITS.maxLimit)} 的整数`,
      );
    }
    if (!Number.isInteger(offset) || offset < 0) {
      return conversationFail('invalid_pagination', 'offset 必须是非负整数');
    }
    const scoped = this.#store
      .list()
      .filter((item) => input.includeArchived === true || !item.archived);
    const hits: ConversationSearchHit[] = [];
    for (const summary of scoped) {
      const first = this.#store.get(summary.conversationId)?.messages[0];
      const firstText = first === undefined ? null : first.text;
      const titleHit = summary.name.toLowerCase().includes(needle);
      const firstHit = firstText !== null && firstText.toLowerCase().includes(needle);
      if (!titleHit && !firstHit) {
        continue;
      }
      hits.push(Object.freeze({ ...summary, matchedFirstMessage: firstHit ? firstText : null }));
    }
    const page = hits.slice(offset, offset + limit);
    return conversationOk(
      Object.freeze({
        query: input.query,
        conversations: Object.freeze(page),
        total: hits.length,
        limit,
        offset,
        more: offset + page.length < hits.length,
      }),
    );
  }

  // --- 下载（R247：每次重新核对摘要）--------------------------------------

  /**
   * 取某个产物字节。
   *
   * 与 `DocumentSessionHost.versionBytes` 同口径：走**物化端口的回读**（盘上的真实字节），
   * 并与发布时记录的摘要**重新核对**；不符 ⇒ `undefined`（宁可 404 也不发来源不明的字节）。
   */
  async download(artifactId: string): Promise<DownloadOutcome | undefined> {
    const record = this.#recordOf(artifactId);
    if (record === undefined || !isDeliveredArtifact(record) || record.receipt === null) {
      return undefined;
    }
    const documents = this.#documents;
    if (documents === null) {
      return undefined;
    }
    let bytes: Uint8Array | undefined;
    try {
      bytes = await documents.readBack(artifactId);
    } catch {
      return undefined;
    }
    if (bytes === undefined || digestBytes(bytes) !== record.content_digest) {
      return undefined;
    }
    const receipt = record.receipt;
    return Object.freeze({
      bytes,
      filename: receipt.final_path.split('/').pop() ?? `${artifactId}.docx`,
      artifactId,
      sha256: record.content_digest,
    });
  }

  /** 内核里的产物记录（只读旁证）。 */
  kernelArtifact(artifactId: string): ArtifactRecord | undefined {
    return this.#recordOf(artifactId);
  }

  // --- 执行 ---------------------------------------------------------------

  /**
   * 一轮对话在内核里**开工**：登记会话任务 → 起真实轮次并落真实工作项（加法接线）。
   *
   * - **未接线 scheduler** 时也登记内核任务（只登记任务行，不造轮次 / 工作项）：
   *   完成视图因此能对"没有轮次 / 工作项"的任务如实回答**"尚未完成"**
   *   （`allWorkItemsTerminal([]) === false`），而**不是**返回"没有这个任务"。
   * - 起轮次失败时把原因记进 `unhandledErrors()`（启动日志与诊断可读），**不静默**。
   *
   * ## 返回值是**承重**的（FA-CHAT-REJECT-RETRY）
   *
   * 这里返回 `ok:false` 表示**本轮在内核里根本没开工**。调用方（`#run`）必须据此**直接收手**：
   * 不进工具循环、不调执行器、不写盘 —— 一轮没有内核轮次的执行是**无主的副作用**
   * （产物会发布，却没有任何轮次 / 工作项解释它是谁做的）。
   * 修复之前本方法只把错误记进 `unhandledErrors()` 就 `return`，调用方看不出"没开成"，
   * 于是照样跑完整个工具循环。
   */
  #beginTurn(conversationId: string, message: ConversationMessage): TurnBeginOutcome {
    const taskId = ConversationHost.taskIdOf(conversationId);
    // 无论接线与否都先登记任务：完成口径需要任务行才能求值（否则是"没有这个任务"）。
    this.#ensureKernelTask(conversationId, taskId);
    const ledger = this.#turnLedger;
    if (ledger === null) {
      return { ok: true };
    }
    const begun = ledger.begin({
      conversationId,
      userMessageId: message.messageId,
      // 尝试序号进入轮次身份：重试因此拿到**独立的一组** request / message / instance / run
      // （见 `conversationTurnKernelIds`），而不是撞上上一轮的 `duplicate_not_created`。
      attempt: message.attempts,
      instruction: message.text,
      taskId,
    });
    if (!begun.ok) {
      // `duplicate` 是幂等护栏（同一**尝试**第二次到达内核入口），不是异常，故不进
      // `unhandledErrors()`；它同样意味着"本轮没开工"，调用方一样必须收手。
      if (begun.stage !== 'duplicate') {
        this.#unhandled.push(
          `turn begin(${begun.stage}) ${turnKey(conversationId, message.messageId, message.attempts)}: ${begun.reason}`,
        );
      }
      return { ok: false, stage: begun.stage, reason: begun.reason };
    }
    this.#turns.set(turnKey(conversationId, message.messageId, message.attempts), {
      ids: begun.ids,
      settled: false,
    });
    return { ok: true };
  }

  /**
   * 一轮对话在内核里**收工**：把结局交给内核（工作项随之进入终态）。
   *
   * **幂等**：同一轮次只写一次结局。未接线 / 未成功起轮次时是无操作。
   * 结局被内核拒绝时如实记进 `unhandledErrors()`（不谎称写过）。
   */
  #settleTurn(
    conversationId: string,
    messageId: string,
    attempt: number,
    settlement: ConversationTurnSettlement,
  ): void {
    const ledger = this.#turnLedger;
    if (ledger === null) {
      return;
    }
    const turn = this.#turns.get(turnKey(conversationId, messageId, attempt));
    if (turn === undefined || turn.settled) {
      return;
    }
    turn.settled = true;
    const outcome = ledger.settle({
      runId: turn.ids.runId,
      requestId: turn.ids.requestId,
      settlement,
    });
    if (!outcome.accepted) {
      this.#unhandled.push(
        `turn settle ${turnKey(conversationId, messageId, attempt)}: ${outcome.reason ?? '未给出原因'}`,
      );
    }
    this.#turns.delete(turnKey(conversationId, messageId, attempt));
  }

  /** 起一次执行并**立刻返回**（HTTP 202 的语义：收下了，但业务还没完成）。 */
  #dispatch(conversationId: string, message: ConversationMessage): void {
    void this.#run(conversationId, message)
      .catch((error: unknown) => {
        const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        this.#unhandled.push(`${conversationId}/${message.messageId}: ${detail}`);
        this.#store.updateMessage(conversationId, message.messageId, {
          state: 'failed',
          phase: 'failed',
          error: { code: 'host_error', message: `执行链抛出未处理异常：${detail}`, retryable: true },
        });
        this.#store.appendEvent(conversationId, {
          kind: 'run_failed',
          messageId: message.messageId,
          state: 'failed',
          phase: 'failed',
          text: null,
          detail: { code: 'host_error', detail },
        });
        // 执行链抛出未处理异常也是**一轮的真实失败**：内核工作项必须收成 failed，
        // 否则它会永远停在 processing，把任务的完成判据永久钉死（那是另一种撒谎）。
        this.#settleTurn(conversationId, message.messageId, message.attempts, {
          kind: 'failed',
          reason: `执行链抛出未处理异常：${detail}`,
        });
      })
      .finally(() => {
        // **记忆写入侧（FA-MEM-INTO-CHAT）**：每轮**结束**后（完成 / 失败 / 取消 / 抛异常都算
        // "结束"）把用户消息与助手回复 / 任务事实写进记忆仓库。选 `finally` 而不是某一条分支：
        // "用户说过什么"是本轮**真实发生过**的事实，不因执行失败而不存在；漏写会让下一轮
        // 的注入少一条本该有的记忆。
        // 未接线（`memory` 省略）时本方法是**无操作** ⇒ 与接线前逐字一致。
        try {
          this.#recordTurnMemory(conversationId, message);
        } catch (error) {
          // 记忆链自己抛错**不得**污染执行结果（那一轮该完成的已经完成）——如实登记，
          // 由 `memoryDiagnostics()` 读出，绝不吞掉。
          this.#memoryDiagnostics.push(`记忆写入链抛出异常：${describe(error)}`);
        }
      });
  }

  async #run(conversationId: string, message: ConversationMessage): Promise<void> {
    const assistantId = assistantIdOf(message.messageId);
    // 加法接线（FA-CHAT-PRODUCT-LOOP）：执行之前先在内核里起**真实轮次**并落**真实工作项**。
    //
    // **被拒 ⇒ 立刻收手**（FA-CHAT-REJECT-RETRY）：本轮在内核里没有轮次 / 工作项时，
    // 就不允许有任何执行 —— 执行器的调用次数必须是 **0**。否则会写出"没有主人"的产物：
    // 文件真的生成了、还进了发布链，而内核里没有任何轮次 / 工作项能解释它是谁做的
    // （工具循环的结局也无处可写）。这里如实记一条 `turn_rejected` 的失败，如实说明卡在哪一步。
    const begun = this.#beginTurn(conversationId, message);
    if (!begun.ok) {
      this.#failMessage(
        conversationId,
        message.messageId,
        'turn_rejected',
        `本轮未能在内核里开工（${begun.stage}）：${begun.reason}。` +
          '按 R226 如实记为未执行 —— 本轮没有进入工具循环，没有调用模型，也没有产出任何文件。',
        // `duplicate`（同一尝试被投递两次）同样可重试：再重试一次会拿到下一个尝试序号。
        true,
        { stage: begun.stage },
      );
      return;
    }
    const executor = this.#executor;
    if (executor === null) {
      this.#failMessage(
        conversationId,
        message.messageId,
        'model_not_configured',
        '本机未配置可用模型（未设置模型提供方与凭据），因此这条消息无法执行；请先完成模型配置。',
        true,
      );
      this.#settleTurn(conversationId, message.messageId, message.attempts, {
        kind: 'failed',
        reason: '本机未配置可用模型（未设置模型提供方与凭据），这条消息无法执行',
      });
      return;
    }

    // ① 业务开始：**已接收** → **执行中**（R209 的第 2、3 态）。
    this.#store.updateMessage(conversationId, message.messageId, { state: 'streaming', phase: 'running' });
    this.#store.appendEvent(conversationId, {
      kind: 'run_started',
      messageId: message.messageId,
      state: 'streaming',
      phase: 'running',
      detail: { provider: executor.provider, model: executor.model, attempt: message.attempts + 1 },
    });

    // ② 助手消息先建后填：客户端在事件里第一次看到它就 append，之后原地 update。
    this.#store.appendAssistantMessage(conversationId, {
      messageId: assistantId,
      text: '',
      state: 'streaming',
      phase: 'running',
    });

    const controller = new AbortController();
    this.#inflight.set(key(conversationId, message.messageId), controller);

    // ③ 真实执行器（每轮结束由装饰器发一条 `assistant_turn`，客户端据此看到增量）。
    //
    // `outcome` 是本轮工具动作的**如实台账**：`produced` 只在本轮**真的发布了**一份新产物时
    // 才被赋值；`lastFailure` 记住最近一次工具失败的原因。二者一起决定了这一轮到底算不算完成。
    const outcome: TurnToolOutcome = { produced: null, attempts: [], lastFailure: null };
    const streaming: RealExecutor = {
      provider: executor.provider,
      model: executor.model,
      runTurn: async (request) => {
        const turn = await executor.runTurn(request);
        this.#store.appendEvent(conversationId, {
          kind: 'assistant_turn',
          messageId: assistantId,
          state: 'streaming',
          phase: 'running',
          text: turn.text,
          detail: {
            stopReason: turn.stopReason,
            toolCallCount: turn.toolCalls.length,
          },
        });
        return turn;
      },
    };

    let result: ToolLoopResult | null = null;
    try {
      result = await runToolLoop({
        executor: streaming,
        conversationId,
        taskId: conversationId,
        systemPrompt: this.#systemPrompt,
        messages: this.#contextOf(conversationId),
        // 取消信号**同时**交给工具：工具循环只保证"下一次模型请求之前停下"，
        // 而在途的工具调用是异步的（写盘 + 回读）。工具自己据信号判断是否还能发布
        // （见 `#publishDocument` 的两处检查）——否则取消后的**迟到结果**照样会发布。
        tools: this.#tools(conversationId, message.messageId, outcome, controller.signal),
        signal: controller.signal,
        budget: this.#budget,
      });
    } catch (error) {
      // **取消不是失败**：`runToolLoop` 会把执行器抛出的 `model_cancelled` 原样冒泡，
      // 若在这里一律记 failed，用户主动取消就会被写成"执行失败"——那是**编造原因**。
      // 判据用**取消信号本身**，不用错误文本。
      if (controller.signal.aborted) {
        this.#settleCancelled(conversationId, message.messageId, assistantId, outcome.attempts.length);
        this.#settleTurn(conversationId, message.messageId, message.attempts, {
          kind: 'cancelled',
          reason: '用户取消了这一轮（执行器抛出取消信号）',
        });
        this.#inflight.delete(key(conversationId, message.messageId));
        return;
      }
      const code = isModelCallError(error) ? error.code : 'model_error';
      const detail = error instanceof Error ? error.message : String(error);
      const retryable = isModelCallError(error) ? error.retryable : true;
      this.#store.updateMessage(conversationId, message.messageId, {
        state: 'failed',
        phase: 'failed',
        error: { code, message: `执行失败：${detail}`, retryable },
      });
      this.#store.appendAssistantMessage(conversationId, {
        messageId: assistantId,
        text: this.#store.message(conversationId, assistantId)?.text ?? '',
        state: 'failed',
        phase: 'failed',
        error: { code, message: detail, retryable },
      });
      this.#store.appendEvent(conversationId, {
        kind: 'run_failed',
        messageId: message.messageId,
        state: 'failed',
        phase: 'failed',
        detail: { code },
      });
      this.#settleTurn(conversationId, message.messageId, message.attempts, {
        kind: 'failed',
        reason: `执行失败：${detail}`,
      });
      this.#inflight.delete(key(conversationId, message.messageId));
      return;
    }

    try {
      const finalText = this.#finalTextOf(conversationId, assistantId, result.messages, result.reason);
      // **产物身份**：只认**本轮真的发布出去的那一份**（`outcome.produced`），
      // 不再拿"当前文档缓存"顶替 —— 缓存里的可能是**上一轮**那一版。
      const artifact = outcome.produced;

      if (result.status === 'cancelled') {
        this.#store.appendAssistantMessage(conversationId, {
          messageId: assistantId,
          text: finalText,
          state: 'cancelled',
          phase: 'cancelled',
        });
        this.#settleCancelled(conversationId, message.messageId, assistantId, result.turns.length);
        this.#settleTurn(conversationId, message.messageId, message.attempts, {
          kind: 'cancelled',
          reason: '用户取消了这一轮（工具循环返回取消）',
        });
        return;
      }

      // **业务完成 = 循环说完成 且 本轮真的发布出了一份新产物**（R226：不把部分完成写成完成）。
      //
      // FA-FIX-FORMAT-CLAIM：判据从"模型**调用过**建文档工具"改成"发布链**真的产出**了产物"。
      // 前者会把"调了工具但字节没变（被 `no_change` 挡住）"也算成完成 —— 那正是
      // "版本号 +1、状态 completed、而文件一个字节没动"这条编造成功的来源。
      if (result.status === 'completed' && artifact !== null) {
        this.#store.updateMessage(conversationId, message.messageId, {
          state: 'completed',
          phase: 'completed',
          error: null,
          artifact,
        });
        this.#store.appendAssistantMessage(conversationId, {
          messageId: assistantId,
          text: finalText,
          state: 'completed',
          phase: 'completed',
          artifact,
        });
        this.#store.appendEvent(conversationId, {
          kind: 'run_completed',
          messageId: message.messageId,
          state: 'completed',
          phase: 'completed',
          detail: {
            status: result.status,
            artifactId: artifact.artifactId,
            sha256: artifact.sha256,
            byteLength: artifact.byteLength,
            turns: result.turns.length,
          },
        });
        // 业务完成 = 内核工作项 completed 且**带可指认的结果引用**（产物 id）。
        this.#settleTurn(conversationId, message.messageId, message.attempts, {
          kind: 'completed',
          resultRefs: [artifact.artifactId],
        });
        return;
      }

      // 结算原因用**本轮工具的真实结论**，不再一律写成笼统的 `no_artifact`：
      // 例如 `no_change`（工具明确回了"没有产生任何字节变化"）必须原样露出来，
      // 否则"模型声称改了、其实没改"在账本上又变成一句含糊的"没有产出文档"。
      const failure = outcome.lastFailure;
      const code = result.status === 'completed' ? (failure?.code ?? 'no_artifact') : result.status;
      const detail =
        result.status === 'completed'
          ? failure === null
            ? '模型结束了对话，但**没有**产出任何已发布的文档：按 R226 如实记为未完成（不把"说完了"当成"做完了"）'
            : `本轮**没有**产出新的已交付产物：${failure.detail}` +
              '（按 R226 如实记为未完成 —— 模型在回复里说了什么，都不等于文件被改过）'
          : result.reason;
      this.#store.updateMessage(conversationId, message.messageId, {
        state: 'failed',
        phase: 'failed',
        error: { code, message: detail, retryable: result.status !== 'unavailable_tool' },
      });
      this.#store.appendAssistantMessage(conversationId, {
        messageId: assistantId,
        text: finalText,
        state: 'failed',
        phase: 'failed',
        error: { code, message: detail, retryable: result.status !== 'unavailable_tool' },
      });
      this.#store.appendEvent(conversationId, {
        kind: 'run_failed',
        messageId: message.messageId,
        state: 'failed',
        phase: 'failed',
        detail: { code, status: result.status, turns: result.turns.length },
      });
      // 失败 / 被拒的一轮**必须**落 failed 工作项：它要参与完成视图的
      // `anyWorkItemFailed`，不能被"没有记录"吞掉。
      this.#settleTurn(conversationId, message.messageId, message.attempts, { kind: 'failed', reason: detail });
    } finally {
      this.#inflight.delete(key(conversationId, message.messageId));
    }
  }

  /** 统一的取消归位（`runToolLoop` 返回 cancelled 与执行器抛 `model_cancelled` 共用）。 */
  #settleCancelled(conversationId: string, messageId: string, assistantId: string, turns: number): void {
    const assistantText = this.#store.message(conversationId, assistantId)?.text ?? '';
    this.#store.updateMessage(conversationId, messageId, {
      state: 'cancelled',
      phase: 'cancelled',
      error: null,
    });
    this.#store.appendAssistantMessage(conversationId, {
      messageId: assistantId,
      text: assistantText,
      state: 'cancelled',
      phase: 'cancelled',
    });
    this.#store.appendEvent(conversationId, {
      kind: 'run_cancelled',
      messageId,
      state: 'cancelled',
      phase: 'cancelled',
      detail: { turns },
    });
  }

  #failMessage(
    conversationId: string,
    messageId: string,
    code: string,
    text: string,
    retryable: boolean,
    /** 附加的**短标量**细节（进事件 `detail`；只收 JSON 可序列化的原语）。 */
    extra: Readonly<Record<string, string | number | boolean | null>> = {},
  ): void {
    this.#store.updateMessage(conversationId, messageId, {
      state: 'failed',
      phase: 'failed',
      error: { code, message: text, retryable },
    });
    this.#store.appendEvent(conversationId, {
      kind: 'run_failed',
      messageId,
      state: 'failed',
      phase: 'failed',
      detail: { code, ...extra },
    });
  }

  /** 收尾文本：优先用循环给的理由；它为空时回退到最后一条助手文本。 */
  #finalTextOf(
    conversationId: string,
    assistantId: string,
    messages: readonly ExecutorMessage[],
    reason: string,
  ): string {
    const recorded = this.#store.message(conversationId, assistantId);
    if (reason.trim() !== '') {
      return reason.trim();
    }
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const item = messages[index];
      if (item !== undefined && item.role === 'assistant' && item.text.trim() !== '') {
        return item.text.trim();
      }
    }
    return recorded?.text ?? '';
  }

  /**
   * 本轮的**完整上下文**：会话历史 + **已记住的记忆块**（最近若干轮）。
   *
   * 取历史 = 连续对话与"一次性生成"的分水岭：多轮追问能看见自己上一轮说过什么。
   * 记忆块（FA-MEM-INTO-CHAT 的读侧接线）则是"记住的"这条线：上一轮**结束后写进记忆仓库**
   * 的内容，在这一轮以 `[已记住的记忆（只读参考…）]` 开头的一条消息出现——这正是
   * "读侧不再恒空"的接线点（未接线时它恒不出现）。
   */
  #contextOf(conversationId: string): readonly ExecutorMessage[] {
    const history = this.#historyOf(conversationId);
    // **读侧接线（FA-MEM-INTO-CHAT）**：把本会话已记住的记忆并进上下文（`buildConversationContext`
    // 的 `messages`，块首显式标注"这不是用户本轮发言"）。未接线 / 暂无记忆 / 注入被拒 ⇒ 原样返回历史
    // （失败时**不放**记忆：宁可这一轮没有记忆，也不把无法核对的条目塞给模型）。
    const memory = this.#memoryBlockFor(conversationId);
    if (memory === null || memory.messages.length === 0) {
      return history;
    }
    return Object.freeze([...memory.messages, ...history]);
  }

  /** 会话历史（系统提示之外、最近若干轮；空文本消息不入上下文）。 */
  #historyOf(conversationId: string): readonly ExecutorMessage[] {
    const record = this.#store.get(conversationId);
    if (record === undefined) {
      return Object.freeze([]);
    }
    const out: ExecutorMessage[] = [];
    for (const message of record.messages) {
      if (message.role === 'system') {
        continue;
      }
      if (message.text.trim() === '') {
        continue;
      }
      out.push(
        Object.freeze({
          role: message.role === 'assistant' ? ('assistant' as const) : ('user' as const),
          text: message.text,
        }),
      );
    }
    return Object.freeze(out);
  }

  // --- 工具（R223：由**代码**执行）----------------------------------------

  #tools(
    conversationId: string,
    userMessageId: string,
    outcome: TurnToolOutcome,
    signal: AbortSignal,
  ): readonly ToolHandler[] {
    return Object.freeze([
      this.#createDocumentTool(conversationId, outcome, signal),
      this.#formatDocumentTool(conversationId, outcome, signal),
      this.#readCurrentTool(conversationId, userMessageId),
    ]);
  }

  /** 记一次工具失败（事件 + 本轮台账），并返回**如实回喂给模型**的那句话。 */
  #noteToolFailure(
    conversationId: string,
    outcome: TurnToolOutcome,
    tool: string,
    code: string,
    message: string,
  ): { readonly ok: false; readonly content: string } {
    outcome.lastFailure = { code, detail: message };
    this.#store.appendEvent(conversationId, {
      kind: 'tool_failed',
      state: 'streaming',
      phase: 'running',
      // **原因必须落在事件里**：只记一个 code 的话，"模型为什么没产出文件"
      // 到了复盘时就成了不可回答的问题（这条是 FA-N 活体复算时暴露出来的）。
      detail: { tool, code, detail: truncate(message) },
    });
    // 失败也**如实回给模型**（R226）：它据此修正后重试，而不是自己编一个"已生成"。
    return { ok: false, content: `工具执行失败（${code}）：${message}` };
  }

  #createDocumentTool(conversationId: string, outcome: TurnToolOutcome, signal: AbortSignal): ToolHandler {
    return {
      name: TOOL_CREATE_DOCUMENT,
      invoke: async (call): Promise<{ ok: boolean; content: string }> => {
        outcome.attempts.push(TOOL_CREATE_DOCUMENT);
        const title = typeof call.arguments['title'] === 'string' ? (call.arguments['title'] as string) : '';
        const rawParagraphs = call.arguments['paragraphs'];
        const paragraphs = Array.isArray(rawParagraphs)
          ? rawParagraphs.filter((item): item is string => typeof item === 'string')
          : [];
        this.#store.appendEvent(conversationId, {
          kind: 'tool_invoked',
          state: 'streaming',
          phase: 'running',
          detail: {
            tool: TOOL_CREATE_DOCUMENT,
            title,
            paragraphCount: paragraphs.length,
          },
        });
        const published = await this.#publishDocument(conversationId, title, paragraphs, signal);
        if (!published.ok) {
          return this.#noteToolFailure(conversationId, outcome, TOOL_CREATE_DOCUMENT, published.code, published.message);
        }
        const ref = published.value;
        outcome.produced = ref;
        outcome.lastFailure = null;
        this.#store.appendEvent(conversationId, {
          kind: 'tool_result',
          state: 'streaming',
          phase: 'running',
          detail: {
            tool: TOOL_CREATE_DOCUMENT,
            artifactId: ref.artifactId,
            sha256: ref.sha256,
            byteLength: ref.byteLength,
          },
        });
        return {
          ok: true,
          content: JSON.stringify({
            ok: true,
            artifactId: ref.artifactId,
            filename: ref.filename,
            sha256: ref.sha256,
            byteLength: ref.byteLength,
            artifactVersion: ref.artifactVersion,
            taskRevision: ref.taskRevision,
            downloadPath: ref.downloadPath,
            note: '文档已由代码真正写盘并回读核对，用户可在下载入口取回。',
          }),
        };
      },
    };
  }

  /**
   * **排版工具**（FA-FIX-FORMAT-CLAIM）。
   *
   * 修复前这条链上没有它：模型只能把"标题居中、加粗、三号字、首行缩进、加表格"写进**回复**，
   * 而产物字节一动不动。现在这条工具把要求落到**盘上那一份真实字节**上：
   *
   * ```text
   * 读回当前产物字节（不是"我以为的那一份"）
   *   → 摘要核对（盘上还是不是我们记的那一份）
   *   → 数字护栏（新增的表格文字同样不得凭空出现数字）
   *   → applyWordFormatting（复用 src/documents/** 的既有排版能力，见 word-format-product.ts）
   *   → 发布链（**字节没变则不产生新版本**，见 `#publishBytes`）
   * ```
   *
   * 回执里带上 `previousSha256` 与 `bytesChanged`：**模型可以自己核对"到底改没改"**，
   * 因此它没有借口再声称一次没有发生的改动。
   */
  #formatDocumentTool(conversationId: string, outcome: TurnToolOutcome, signal: AbortSignal): ToolHandler {
    return {
      name: TOOL_FORMAT_DOCUMENT,
      invoke: async (call): Promise<{ ok: boolean; content: string }> => {
        outcome.attempts.push(TOOL_FORMAT_DOCUMENT);
        const parsed = parseWordFormatRequest(call.arguments);
        if (!parsed.ok) {
          return this.#noteToolFailure(
            conversationId,
            outcome,
            TOOL_FORMAT_DOCUMENT,
            parsed.code,
            parsed.message,
          );
        }
        const request = parsed.request;
        this.#store.appendEvent(conversationId, {
          kind: 'tool_invoked',
          state: 'streaming',
          phase: 'running',
          // 事件 `detail` 只收短标量：参数名列表拼成一行（`#publishBytes` 的纪律）。
          detail: { tool: TOOL_FORMAT_DOCUMENT, parameters: parsed.recognized.join(',') },
        });

        const current = this.currentDocument(conversationId);
        if (current === undefined) {
          return this.#noteToolFailure(
            conversationId,
            outcome,
            TOOL_FORMAT_DOCUMENT,
            'no_current_document',
            '本会话还没有当前文档：先用 create_word_document 生成一份，再谈排版',
          );
        }
        const documents = this.#documents;
        if (documents === null) {
          return this.#noteToolFailure(
            conversationId,
            outcome,
            TOOL_FORMAT_DOCUMENT,
            'document_port_unavailable',
            '文档端口未接入：读不回盘上字节，因此不排版（绝不用内存里的字节顶替）',
          );
        }

        let bytes: Uint8Array | undefined;
        try {
          bytes = await documents.readBack(current.ref.artifactId);
        } catch (error) {
          return this.#noteToolFailure(conversationId, outcome, TOOL_FORMAT_DOCUMENT, 'readback_failed', describe(error));
        }
        if (bytes === undefined) {
          return this.#noteToolFailure(
            conversationId,
            outcome,
            TOOL_FORMAT_DOCUMENT,
            'readback_missing',
            '盘上读不回当前文档的字节：没有可排版的输入，不得据此宣称改过',
          );
        }
        const beforeDigest = digestBytes(bytes);
        if (beforeDigest !== current.ref.sha256) {
          return this.#noteToolFailure(
            conversationId,
            outcome,
            TOOL_FORMAT_DOCUMENT,
            'readback_digest_mismatch',
            `盘上字节摘要 ${beforeDigest.slice(0, 12)}… 与最近一次交付记录的 ${current.ref.sha256.slice(0, 12)}… 不符：` +
              '盘上那一份可能已被换过，拒绝在来源不明的字节上排版',
          );
        }

        // 数字护栏（与模板链同一条口径）：**新增的表格文字**同样不得凭空出现阿拉伯数字。
        if (request.table !== null) {
          const cellText = (request.table.cells ?? []).map((row) => [...row].join('\n')).join('\n');
          if (cellText.trim() !== '') {
            const taskId = ConversationHost.taskIdOf(conversationId);
            const snapshot = this.#ensureKernelTask(conversationId, taskId);
            const untraceable = untraceableDigitRuns(cellText, [snapshot]);
            if (untraceable.length > 0) {
              return this.#noteToolFailure(
                conversationId,
                outcome,
                TOOL_FORMAT_DOCUMENT,
                'untraceable_number',
                `表格文字里出现了没有来源登记的数字：${untraceable.join('、')}；` +
                  '请改成不带阿拉伯数字的写法（如"两轮沟通"）后重试',
              );
            }
          }
        }

        const applied = applyWordFormatting(bytes, request);
        if (!applied.ok) {
          return this.#noteToolFailure(
            conversationId,
            outcome,
            TOOL_FORMAT_DOCUMENT,
            applied.code,
            applied.message,
          );
        }
        if (!applied.model_changed) {
          // 计划里的每一步都报告"没有改动"（例如要求居中的段落本来就已经居中）——
          // 那就**没有**新字节可言：如实说"没有变化"，不制造新版本。
          return this.#noteToolFailure(
            conversationId,
            outcome,
            TOOL_FORMAT_DOCUMENT,
            'no_change',
            `你要求的排版（${parsed.recognized.join('、')}）**没有产生任何改动**：` +
              `${JSON.stringify(applied.steps)}；文件与当前那一版逐字节相同，未产生新版本。` +
              '不得向用户声称已经改好。',
          );
        }

        const afterDigest = digestBytes(applied.bytes);
        const published = await this.#publishBytes(
          conversationId,
          current.title,
          current.paragraphs,
          applied.bytes,
          afterDigest,
          signal,
        );
        if (!published.ok) {
          return this.#noteToolFailure(
            conversationId,
            outcome,
            TOOL_FORMAT_DOCUMENT,
            published.code,
            published.message,
          );
        }

        const ref = published.value;
        outcome.produced = ref;
        outcome.lastFailure = null;
        this.#store.appendEvent(conversationId, {
          kind: 'tool_result',
          state: 'streaming',
          phase: 'running',
          detail: {
            tool: TOOL_FORMAT_DOCUMENT,
            artifactId: ref.artifactId,
            previousSha256: current.ref.sha256,
            sha256: ref.sha256,
            byteLength: ref.byteLength,
            parameters: parsed.recognized.join(','),
          },
        });
        return {
          ok: true,
          content: JSON.stringify({
            ok: true,
            applied: true,
            bytesChanged: ref.sha256 !== current.ref.sha256,
            previousSha256: current.ref.sha256,
            sha256: ref.sha256,
            byteLength: ref.byteLength,
            artifactId: ref.artifactId,
            filename: ref.filename,
            artifactVersion: ref.artifactVersion,
            taskRevision: ref.taskRevision,
            downloadPath: ref.downloadPath,
            requested: parsed.recognized,
            steps: applied.steps,
            table: applied.table_shape,
            note:
              '排版已由代码真正写盘并回读核对；`bytesChanged` 为 true 表示这一版的字节与上一版**确实不同**' +
              '（sha256 变了）。若为 false，则没有任何变化，不得声称改过。',
          }),
        };
      },
    };
  }

  #readCurrentTool(conversationId: string, _userMessageId: string): ToolHandler {
    return {
      name: TOOL_READ_CURRENT_DOCUMENT,
      invoke: async (): Promise<{ ok: boolean; content: string }> => {
        // **必须走 `currentDocument()`，不能一句 `this.#current.get()`**（FA-CONV-RESTART-CONTINUE）。
        // 那个 Map 只是**进程内缓存**：重启后为空，而模型据以"看到当前文件"的正是这条读路径。
        // 直读 Map 会让"接着刚才那份改"在新进程里退化成"没有当前文档"。
        // `currentDocument()` 在缓存未命中时从**持久事实**重建（`shared_facts` 的
        // `conversation.current_document` + 产物记录），核不上就如实返回 `undefined`——
        // 因此"换独立运行目录 ⇒ 读不回来"这条反向对照依旧成立。
        const current = this.currentDocument(conversationId);
        this.#store.appendEvent(conversationId, {
          kind: 'tool_invoked',
          state: 'streaming',
          phase: 'running',
          detail: { tool: TOOL_READ_CURRENT_DOCUMENT, hasCurrent: current !== undefined },
        });
        if (current === undefined) {
          return { ok: true, content: JSON.stringify({ ok: true, hasDocument: false }) };
        }
        return {
          ok: true,
          content: JSON.stringify({
            ok: true,
            hasDocument: true,
            artifactId: current.ref.artifactId,
            sha256: current.ref.sha256,
            title: current.title,
            paragraphs: current.paragraphs,
          }),
        };
      },
    };
  }

  // --- 生成 + 发布（与生成链/编辑链同一个投影）----------------------------

  /**
   * 生成 + 发布一份对话产物。
   *
   * ## `signal`：取消后的**迟到结果不得发布**
   *
   * 取消信号只保证工具循环"在**下一次模型请求之前**停下"；已在途的工具调用不受它支配。
   * 一次 `create_word_document` 里包含一次外部写盘（`#materialize`）——它可能刚好跨过用户
   * 点下取消的那一刻。若不管，这一轮的结局会被写成 `cancelled`，而**文件却已经发布**：
   * 用户看到"已取消"，盘上却多了一份被记成"已交付"的产物，`current` 也会被它改写。
   *
   * 因此这里在**两个位置**检查信号（都在外部副作用之前/之后）：
   * 1. 暂存事务之后、`#materialize`（真正写盘）之前 —— 大多数取消在这里就被挡住，**不写盘**；
   * 2. `#materialize` 之后、发布投影（写 `published` + 回执 + 事件）之前 —— 写盘已经发生，
   *    但**不发布**：产物如实停在 `staged`（既没交付、也不冒充交付），`current` 不更新。
   *
   * 诚实边界：第 2 种情形下**盘上确实多了一个文件**（外部副作用已经发生，改不了）。
   * 它停在 `staged`，不会被任何"已交付"判据认领 —— 这一点如实写在事件里（`tool_failed` 的 code）。
   */
  async #publishDocument(
    conversationId: string,
    title: string,
    paragraphs: readonly string[],
    signal?: AbortSignal,
  ): Promise<ConversationResult<ConversationArtifactRef>> {
    const validated = this.#validateDocumentText(title, paragraphs);
    if (!validated.ok) {
      return validated;
    }
    const { title: cleanTitle, paragraphs: body } = validated.value;
    const taskId = ConversationHost.taskIdOf(conversationId);
    const sourceFact = this.#ensureKernelTask(conversationId, taskId);

    let built: { bytes: Buffer; content_digest: string };
    try {
      built = buildDocxTemplate({
        requirement: {
          title: cleanTitle,
          description: body.join('\n'),
          paragraphs: body,
          presentation: DOCX_TITLE_BODY_PRESENTATION,
        },
        fact_snapshot: [sourceFact],
        references: [],
      });
    } catch (error) {
      return {
        ok: false,
        code: 'build_failed',
        message: `模板链拒绝了这份内容：${describe(error)}`,
      };
    }

    return this.#publishBytes(conversationId, cleanTitle, body, built.bytes, built.content_digest, signal);
  }

  /** 标题 / 段落口径（**生成链与排版链共用同一份**，不在两处各写一遍）。 */
  #validateDocumentText(
    title: string,
    paragraphs: readonly string[],
  ): ConversationResult<{ readonly title: string; readonly paragraphs: readonly string[] }> {
    const cleanTitle = title.trim();
    if (cleanTitle === '') {
      return { ok: false, code: 'invalid_title', message: '标题不能为空' };
    }
    const body = paragraphs.map((item) => item.trim()).filter((item) => item !== '');
    if (body.length < 2 || body.length > 4) {
      return {
        ok: false,
        code: 'invalid_paragraphs',
        message: `正文必须是 2–4 段（收到 ${String(body.length)} 段）：请把内容重新组织成 2–4 段再提交`,
      };
    }
    return conversationOk(
      Object.freeze({ title: cleanTitle, paragraphs: Object.freeze([...body]) as readonly string[] }),
    );
  }

  /**
   * **发布一份已经拿在手上的字节**（生成链与排版链共用这一条出口）。
   *
   * ## 诚实闸门（FA-FIX-FORMAT-CLAIM）：**字节没变就不产生新版本**
   *
   * 修复前这里是"来什么发什么"：`artifactVersion` / `editRevision` 每次调用**无条件**递增。
   * 于是"模型回复里说排版改好了、其实一个字节都没动"这种事，在账本上看起来却像**成功交付了
   * 一版新文档**（版本号 +1、状态 `completed`）。这是**编造成功**。
   *
   * 现在的口径：**先算摘要，与当前那一版比**。
   * - 相同 ⇒ 结构化 `no_change`：**不落暂存、不写盘、不递增任何版本号**，并把"没有产生任何
   *   字节变化"如实回喂给模型——它因此**没有依据**再声称改好了；
   * - 不同 ⇒ 走下面原样的暂存 → 写盘 → 回读 → 发布链（版本号这才递增）。
   *
   * 判据是**字节摘要**，不是"模型有没有调用工具"，也不是"操作是否报告 changed"：
   * 只有盘上那一份字节真的不一样，才叫一次新交付。
   */
  async #publishBytes(
    conversationId: string,
    cleanTitle: string,
    body: readonly string[],
    bytes: Uint8Array,
    contentDigest: string,
    signal?: AbortSignal,
  ): Promise<ConversationResult<ConversationArtifactRef>> {
    const documents = this.#documents;
    if (documents === null) {
      return Object.freeze({
        ok: false as const,
        code: 'document_port_unavailable',
        message: '文档端口未接入：无法写盘，因此不交付（绝不用内存里的字节顶替）',
      });
    }

    const previous = this.currentDocument(conversationId);
    if (previous !== undefined && previous.ref.sha256 === contentDigest) {
      return Object.freeze({
        ok: false as const,
        code: 'no_change',
        message:
          `本次请求**没有产生任何字节变化**：结果与当前那一版逐字节相同（sha256 ${contentDigest}），` +
          '因此**没有**产生新版本，盘上文件与旧版本都原封不动。' +
          '如果你是在改排版，说明这项改动没有真正落到文件上——不得向用户声称已经改好。',
      });
    }

    const taskId = ConversationHost.taskIdOf(conversationId);
    const sourceFact = this.#ensureKernelTask(conversationId, taskId);
    const at = asLogicalTime(this.#clock.now());
    let fact: StagedArtifactFact;
    try {
      const staged = this.#kernel.transact((tx) => {
        const task = tx.getTask(taskId);
        if (task === undefined) {
          throw new Error(`内核任务 ${String(taskId)} 不在存储中：不得在无法核对版本时发布`);
        }
        const bumped = applyTaskPatch(
          task,
          createTaskPatch(task.task_id, task.revision, [
            { field: 'deliverables', kind: 'replace', value: [`对话产出的 Word 文档：${cleanTitle}`] },
          ]),
          at,
        );
        tx.putTask(bumped);
        const artifactVersion = resolveNextArtifactVersion(tx, taskId, 'document');
        const plan: ArtifactPlan = planArtifact({
          task_id: taskId,
          task_revision: bumped.revision,
          template_kind: 'document',
          artifact_version: artifactVersion,
          root_dir: this.#options.artifactRootDir,
          expected_content_digest: contentDigest,
        });
        const record = createArtifactRecord({
          artifact_id: plan.artifact_id,
          task_id: taskId,
          task_revision: bumped.revision,
          artifact_version: artifactVersion,
          template_kind: 'document',
          byte_length: bytes.byteLength,
          content_digest: contentDigest,
          source_fact_refs: [sourceFact.fact_ref],
          created_by_instance_id: instanceIdOf(taskId),
          status: 'staged',
          verifications: [
            {
              kind: 'version_match',
              outcome: 'pass',
              detail: `暂存时内核任务版本 r${String(bumped.revision)}（对话 ${conversationId}）`,
            },
          ],
          created_at: at,
        });
        tx.putArtifact(record);
        const request: ArtifactMaterializationRequest = Object.freeze({
          artifact_id: plan.artifact_id,
          task_id: taskId,
          task_revision: plan.task_revision,
          template_kind: 'document',
          fact_snapshot: Object.freeze([sourceFact]),
          plan,
          expected_content_digest: contentDigest,
          payload: new Uint8Array(bytes),
        });
        return { record, request };
      });
      fact = Object.freeze({ record: staged.record, request: staged.request });
    } catch (error) {
      return { ok: false, code: 'staging_failed', message: `内核暂存失败：${describe(error)}（未写任何文件）` };
    }

    // **取消检查 ①**：写盘之前。此时外部副作用还没发生 —— 直接收手，盘上不会多出文件。
    if (abortedNow(signal)) {
      return {
        ok: false,
        code: 'cancelled',
        message: '本轮已取消：迟到结果不得发布（写盘尚未发生，产物未进入任何已交付状态）',
      };
    }

    // 外部副作用（写盘 + 回读）**只发生在任何事务之外**。
    const memoResult = await this.#materialize(fact, at, cleanTitle);

    // **取消检查 ②**：写盘之后、发布之前。写盘已经发生（如实承认这个副作用），
    // 但**不发布**：产物停在 `staged`，`published` 记录 / 回执 / `artifact_published` 事件
    // 一条都不写，`current` 也不更新 —— 取消后的迟到结果不得冒充足额交付。
    if (abortedNow(signal)) {
      return {
        ok: false,
        code: 'cancelled',
        message:
          '本轮已取消：迟到结果不得发布。声明如下 —— 字节已按物化端口写过盘，' +
          '但发布链未执行，该产物停在 staged（既未交付、也不冒充交付），当前文档未被它改写',
      };
    }

    const memo = new Map<string, ArtifactMaterializationResult>([[String(fact.record.artifact_id), memoResult]]);
    const port: ArtifactMaterializationPort = {
      materialize: (request: ArtifactMaterializationRequest): ArtifactMaterializationResult => {
        const hit = memo.get(String(request.artifact_id));
        if (hit === undefined) {
          return materializationFailure(
            request,
            'write_failed',
            '宿主未预先物化该产物（编排错误）：内核不得据未发生过的写盘宣称交付',
            at,
          );
        }
        return hit;
      },
    };

    this.#clock.advance(1, `publish conversation ${conversationId}`);
    const projection = createArtifactPublicationProjection({
      store: this.#kernel,
      port,
      hooks: publicationEventHooks(this.#ids),
    });
    const outcomes = projection.reconcile([fact], asLogicalTime(this.#clock.now()));
    const published = outcomes.find((outcome) => outcome.kind === 'published');
    const record = published?.record ?? null;
    if (
      record === null ||
      !isDeliveredArtifact(record) ||
      record.receipt === null ||
      outcomes.some((outcome) => outcome.kind === 'failed' || outcome.kind === 'unrecorded')
    ) {
      const detail = memoResult.ok
        ? outcomes.map((outcome) => outcome.detail).join('；')
        : memoResult.failure.detail;
      return { ok: false, code: 'publish_failed', message: `${detail}（既有版本未改动）` };
    }

    const artifactId = String(record.artifact_id);
    // 引用一律从**产物记录**（真相源）派生：见 `artifactRefOf` 的说明。
    const ref: ConversationArtifactRef = artifactRefOf(record, conversationId);
    const currentEntry = Object.freeze({
      ref,
      paragraphs: Object.freeze([...body]),
      title: cleanTitle,
    });
    this.#current.set(conversationId, currentEntry);
    // **落盘**（复用同一个内核 store：不新建第二份账本）。进程内 Map 只是缓存，
    // 重启后由 `currentDocument()` 从内核记录恢复（见那一处的说明）。
    this.#persistCurrent(conversationId, taskId, currentEntry);
    return conversationOk(ref);
  }

  /** 写盘 + 回读 + 结构自检 + 摘要核对（与生成链/编辑链同口径；失败一律结构化）。 */
  async #materialize(
    fact: StagedArtifactFact,
    at: LogicalTime,
    title: string,
  ): Promise<ArtifactMaterializationResult> {
    const documents = this.#documents;
    const request = fact.request;
    const payload = request.payload;
    if (documents === null || payload === undefined) {
      return materializationFailure(request, 'builder_failed', '物化端口缺失或 payload 为空：按失败收尾', at);
    }
    const artifactId = String(fact.record.artifact_id);
    let receipt: { readonly path: string; readonly sha256: string; readonly byteLength: number };
    try {
      receipt = await documents.materialize({
        artifactId,
        filename: normalizeDocxFilename(title, CONVERSATION_FILENAME_STEM),
        bytes: payload,
        expectedSha256: fact.record.content_digest,
      });
    } catch (error) {
      return materializationFailure(request, 'write_failed', `写盘失败：${describe(error)}`, at);
    }
    let back: Uint8Array | undefined;
    try {
      back = await documents.readBack(artifactId);
    } catch (error) {
      return materializationFailure(request, 'write_failed', `回读失败：${describe(error)}`, at);
    }
    if (back === undefined) {
      return materializationFailure(request, 'write_failed', '写盘后回读不到该文件：不得据此声称已交付', at);
    }
    let entryCount: number;
    try {
      const selfCheck = selfCheckArtifactBytes(back);
      if (!selfCheck.ok) {
        return materializationFailure(
          request,
          'self_check_failed',
          `回读字节未通过结构自检：${selfCheck.problems[0]?.detail ?? '未给出细节'}`,
          at,
        );
      }
      entryCount = selfCheck.entry_count;
    } catch (error) {
      return materializationFailure(request, 'self_check_failed', `结构自检自身失败：${describe(error)}`, at);
    }
    const readbackDigest = digestBytes(back);
    if (receipt.sha256 !== fact.record.content_digest || readbackDigest !== fact.record.content_digest) {
      return materializationFailure(
        request,
        'self_check_failed',
        `回读摘要与暂存期望不一致（期望 ${fact.record.content_digest}，端口回执 ${receipt.sha256}，宿主回读 ${readbackDigest}）：拒绝发布被改动或写错的字节`,
        at,
      );
    }
    const fullReceipt: ArtifactMaterializationReceipt = Object.freeze({
      artifact_id: fact.record.artifact_id,
      byte_length: back.byteLength,
      entry_count: entryCount,
      final_path: receipt.path.split('\\').join('/'),
      readback_digest: readbackDigest,
      verifier: 'demo-host/conversation-host（宿主对最终路径的实际回读）',
      at: asLogicalTime(at),
    });
    return materializationSuccess(fullReceipt);
  }

  // --- 内部：内核登记 -----------------------------------------------------

  /** 会话任务/实例/群成员/来源事实的确定性派生（无计数器、无随机）。 */
  static taskIdOf(conversationId: string): TaskId {
    const digest = createHash('sha256').update(conversationId, 'utf8').digest('hex').slice(0, 16);
    return asTaskId(`${CONVERSATION_TASK_PREFIX}${digest}`);
  }

  #ensureKernelTask(conversationId: string, taskId: TaskId): KnownFactSnapshotEntry {
    const key = String(taskId).replace(/^T-conv-/, '').slice(0, 12);
    const groupId: GroupId = asGroupId(`G-conv-${key}`);
    const instanceId: InstanceId = instanceIdOf(taskId);
    const factRef = asFactRef(`fact-conv-${key}-source`);
    const inner = Object.freeze({
      type: 'text' as const,
      text: `用户在本机对话（会话 ${conversationId}）里提出的文档要求`,
      source: '对话输入',
    });
    const source = Object.freeze({
      kind: 'external' as const,
      detail: '对话来源登记（含义是"这份文档因哪次对话而产生"；不表示正文事实已核实，也不得冒充用户确认）',
    });
    const snapshot: KnownFactSnapshotEntry = Object.freeze({
      fact_ref: factRef,
      fact_key: CONVERSATION_SOURCE_FACT_KEY,
      value: inner,
      source,
    });
    if (this.#kernel.snapshot().tasks.some((task) => task.task_id === taskId)) {
      return snapshot;
    }
    const at = asLogicalTime(this.#clock.now());
    const revision: Revision = asRevision(1);
    this.#kernel.transact((tx) => {
      tx.putTask(
        createTaskRecord({
          task_id: taskId,
          title: `对话任务 ${conversationId}`,
          goal:
            `按用户在连续对话里提出的要求产出可编辑的 Word 文档；` +
            `对话 ${conversationId}，运行实例 ${this.#options.runId}`,
          current_group_id: groupId,
          deliverables: ['一份可编辑的 Word 文档（按对话要求逐版交付）'],
          revision,
          created_at: at,
          updated_at: at,
        }),
      );
      tx.putInstance(createInstanceState({ instance_id: instanceId, group_id: groupId, updated_at: at }));
      tx.putGroupMember(
        createGroupMember({ group_id: groupId, instance_id: instanceId, registered_at: at }),
      );
      tx.putSharedFact(
        createSharedFactRecord({
          fact_id: factRef,
          task_id: taskId,
          task_revision: revision,
          fact_key: CONVERSATION_SOURCE_FACT_KEY,
          value: Object.freeze({ kind: 'known' as const, value: inner }),
          source,
          confirmed_by: instanceId,
          confirmed_at: at,
        }),
      );
    });
    return snapshot;
  }

  #recordOf(artifactId: string): ArtifactRecord | undefined {
    return this.#kernel.snapshot().artifacts.find((record) => String(record.artifact_id) === artifactId);
  }

  // --- 内部：当前文档关联的落盘与恢复（FA-CHAT-REJECT-RETRY）----------------

  /**
   * 「当前文档」事实的确定性 fact id（由会话任务 id 派生）。
   *
   * 同一会话永远得到同一个 id ⇒ `putSharedFact` 是**覆盖写**，同一会话只留一条当前关联，
   * 历史版本由**产物记录**（`artifact_version` 递增）承载 —— 事实里不另存版本历史。
   */
  #currentFactRef(taskId: TaskId): FactRef {
    return asFactRef(`fact-conv-${String(taskId).replace(/^T-conv-/, '').slice(0, 12)}-current`);
  }

  /**
   * 把「本会话当前文档」写进**内核 store**（`shared_facts`），供跨进程重启恢复。
   *
   * 只写三样：`artifactId`（哪一份）+ `title` / `paragraphs`（模板链只把它们编进 DOCX 字节，
   * 别处读不回来）。版本 / 摘要 / 字节数 / 文件名**不写进事实** —— 它们以产物记录为准
   * （写一份就是第二份真相源，两边漂移时无法判断谁对）。
   *
   * 写失败**不**把已交付的产物说成失败：发布本身早已完成（文件已交付、产物记录已落库），
   * 这里失败只意味着"重启后的当前文档恢复会读不回来"。如实登记进 `unhandledErrors()`。
   */
  #persistCurrent(conversationId: string, taskId: TaskId, entry: CurrentDocumentEntry): void {
    try {
      const at = asLogicalTime(this.#clock.now());
      const payload = JSON.stringify({
        artifactId: entry.ref.artifactId,
        title: entry.title,
        paragraphs: entry.paragraphs,
      });
      this.#kernel.transact((tx) => {
        const task = tx.getTask(taskId);
        tx.putSharedFact(
          createSharedFactRecord({
            fact_id: this.#currentFactRef(taskId),
            task_id: taskId,
            // 版本锚点跟任务当前版本走（每次发布都会推进它）。
            task_revision: asRevision(task?.revision ?? 1),
            fact_key: CONVERSATION_CURRENT_DOC_FACT_KEY,
            value: Object.freeze({
              kind: 'known' as const,
              value: Object.freeze({
                type: 'text' as const,
                text: payload,
                source: '对话发布链（由**代码**写入：当前文档的 artifactId + 标题 + 正文段落）',
              }),
            }),
            source: Object.freeze({
              kind: 'tool_result' as const,
              detail:
                'create_word_document 工具真实写盘 + 回读并发布后的产物身份，不是模型自述',
            }),
            confirmed_by: instanceIdOf(taskId),
            confirmed_at: at,
          }),
        );
      });
    } catch (error) {
      this.#unhandled.push(
        `current-document persist ${conversationId}: ${describe(error)}` +
          '（发布已成功、产物已交付；仅"重启后当前文档恢复"会读不回来）',
      );
    }
  }

  /** 从内核 store 恢复「当前文档」；任一环核不上就返回 `undefined`（不猜、不回落）。 */
  #restoreCurrent(conversationId: string): CurrentDocumentEntry | undefined {
    const taskId = ConversationHost.taskIdOf(conversationId);
    const factId = this.#currentFactRef(taskId);
    const fact = this.#kernel.snapshot().shared_facts.find((row) => row.fact_id === factId);
    if (fact === undefined || fact.task_id !== taskId) {
      return undefined;
    }
    if (fact.fact_key !== CONVERSATION_CURRENT_DOC_FACT_KEY) {
      return undefined;
    }
    if (fact.value.kind !== 'known' || fact.value.value.type !== 'text') {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fact.value.value.text);
    } catch {
      return undefined;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    const payload = parsed as Record<string, unknown>;
    const artifactId = payload['artifactId'];
    const title = payload['title'];
    const rawParagraphs = payload['paragraphs'];
    if (typeof artifactId !== 'string' || artifactId === '' || typeof title !== 'string') {
      return undefined;
    }
    if (!Array.isArray(rawParagraphs)) {
      return undefined;
    }
    const paragraphs = rawParagraphs.filter((item): item is string => typeof item === 'string');
    if (paragraphs.length !== rawParagraphs.length) {
      return undefined;
    }

    // **核上才认**：产物必须真的在本内核 store 里，且是一条已交付记录、任务也对得上。
    // 换一个独立的运行目录 ⇒ 这两条都不成立 ⇒ 恢复失败（不把全局位置当成本会话数据）。
    const artifact = this.#recordOf(artifactId);
    if (artifact === undefined || String(artifact.task_id) !== String(taskId)) {
      return undefined;
    }
    if (!isDeliveredArtifact(artifact) || artifact.receipt === null) {
      return undefined;
    }
    return Object.freeze({
      ref: artifactRefOf(artifact, conversationId),
      title,
      paragraphs: Object.freeze([...paragraphs]),
    });
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 助手消息 id 由用户消息 id 派生：重试时**复用同一个助手消息**（不会越积越多）。 */
export function assistantIdOf(userMessageId: string): string {
  return `${userMessageId}-assistant`;
}

function instanceIdOf(taskId: TaskId): InstanceId {
  return asInstanceId(`I-conv-${String(taskId).replace(/^T-conv-/, '').slice(0, 12)}`);
}

function key(conversationId: string, messageId: string): string {
  return `${conversationId}/${messageId}`;
}

/**
 * 内核轮次台账的键：(会话, 消息, **尝试序号**)。
 *
 * 带上尝试序号是必须的（FA-CHAT-REJECT-RETRY）：重试会给同一条消息起**新的一轮**，
 * 若共用同一个键，`#turns` 里上一轮的条目会被覆盖 / 提前删除，重试的结局就无处可写。
 * 注意 `#inflight`（取消开关）**仍按 (会话, 消息)** —— 取消针对的是"用户看得见的那条消息"，
 * 与它现在是第几次尝试无关。
 */
function turnKey(conversationId: string, messageId: string, attempt: number): string {
  return `${conversationId}/${messageId}#${String(attempt)}`;
}

/**
 * 从**产物记录**派生对外的文档引用。
 *
 * 版本 / 摘要 / 字节数 / 文件名只从记录读（**不**从"当前文档"事实里读）：
 * 记录的这些字段由发布链在回读核对之后写入，是唯一的真相源；
 * 事实里再存一份就会漂移，且漂移时无法判断谁对。
 */
function artifactRefOf(record: ArtifactRecord, conversationId: string): ConversationArtifactRef {
  const artifactId = String(record.artifact_id);
  const receipt = record.receipt;
  return Object.freeze({
    artifactId,
    filename: receipt?.final_path.split('/').pop() ?? `${artifactId}.docx`,
    sha256: record.content_digest,
    byteLength: record.byte_length,
    editRevision: record.artifact_version,
    taskRevision: record.task_revision,
    artifactVersion: record.artifact_version,
    downloadPath: `/api/conversations/${encodeURIComponent(conversationId)}/documents/${encodeURIComponent(artifactId)}/download`,
  });
}

/**
 * 取消信号当前是否已触发。
 *
 * 为什么包成函数而不是就地写 `signal?.aborted === true`：同一条代码路径上要检查**两次**
 * （写盘前、发布前），而 TypeScript 会把第一次检查之后的 `aborted` 收窄成 `false`，
 * 让第二次检查被判成"永远不成立"（TS2367）。这个函数把读取放到新的作用域里，
 * 两次检查都读到**当时**的真实值。
 */
function abortedNow(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** 事件 `detail` 只收短标量：过长的原因截断，避免事件流被一条错误撑爆。 */
function truncate(text: string, limit = 300): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/**
 * 会话消息的**显式稳定幂等键**（`mem-write-side.ts` 要求 `[A-Za-z0-9._-]{1,128}`）。
 *
 * 为什么不直接拿 `messageId`：客户端 id 允许的字符集比它宽（见 `conversation-store.ts`
 * 的 `isSafeIdentifier`），直接透传会让 `stableMemoryIdFor` 抛 `RangeError` ⇒ 整条写入被
 * **结构化拒绝**（用户消息就记不上了）。这里做两件可预测的事：不合法字符换成 `_`；
 * 超过 128 位时截断并**附哈希后缀**（截断不致碰撞）。
 */
function safeStableId(raw: string): string {
  const sanitized = raw.replace(/[^A-Za-z0-9._-]/g, '_');
  if (sanitized.length <= 128) {
    return sanitized;
  }
  const digest = createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 16);
  return `${sanitized.slice(0, 100)}-${digest}`;
}
