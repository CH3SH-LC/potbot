/**
 * **连续对话闭环门面**（CHAT-01 / CHAT-04 / CHAT-05 / CHAT-06 的产品侧收口）。
 *
 * ## 这个模块回答什么
 *
 * 网页对话界面（`apps/demo/web/conversation-store.js`）只做状态归位，真正的"多轮怎么归位、
 * 指代怎么解、一句话改多个产物怎么算、结果怎么说给用户听"落在内核的若干纯逻辑模块里
 * （`src/conversation/**`、`src/facts/**`）。本文件是这些模块**面向产品的一条装配线**：
 * 它把用户的一条消息，按**显式绑定**归属到 `(task_id, revision)`，把指代解析成
 * `(task_id, artifact_id, revision)`，把"一句话改多个关联产物"编排成一次可核对的事务，
 * 并把产物与证据整理成**不含内部术语**的用户可读说明。
 *
 * ```text
 * 用户消息 ──[归属：显式 task_id > 会话内唯一活动任务 > 需要澄清]──> 任务 + 版本
 *          ├─ 指代（"这个文件 / 刚才那个 / 改一下它"）──> (task_id, artifact_id, revision)
 *          ├─ 追问 / 补资料 ──> 同一任务（连续三轮不新建第二个任务）
 *          ├─ 一句话改多个关联产物 ──> buildMultiArtifactTransaction 事务视图
 *          └─ 结果解释 ──> 用户可读文案（证据另存，不进用户文案）
 * ```
 *
 * ## 唯一硬约束：**不靠文本相似度猜**
 *
 * 归属与指代只认**显式判据**（复用 `src/conversation/run-constraints.ts` 的同一套）：
 *
 * | 判据 | 触发条件 | 说明 |
 * |---|---|---|
 * | 显式任务 | 指令带 `task_id` | 最强，直接命中，不看一个字 |
 * | 显式消息 | 指令带 `message_id`（"就这条"） | 经消息绑定表解出任务与版本 |
 * | 显式产物 | 指代带 `artifact_id` | 直接命中该产物所属任务 |
 * | 会话内唯一活动任务 | 以上皆无，且**恰好一个**活动任务 | 按**数量**归属，仍零文本比对 |
 *
 * 其余情况**一律不猜**：两个及以上活动任务 ⇒ `needs_clarification`（带候选，请用户点一下）；
 * 一个都没有 ⇒ `rejected: no_active_task`。本文件**没有**任何字符串相似度 / 关键词 /
 * 标题匹配的代码路径——连"当前文件"与"刚才那个"都是**指针**语义（UI 打开的那个 / 最近改动
 * 那一个），并列时同样要求澄清，而不是挑一个像的。
 *
 * ## 端口注入与就绪（诚实纪律）
 *
 * 目录端口（{@link ConversationCatalogPort}）是**唯一**的外部数据来源：任务与产物的候选只能
 * 从它读。**不注入端口 ⇒ 未就绪**（{@link ConversationLoop.readiness} 如实返回
 * `ready: false`），此时所有操作结构化拒绝 `not_ready`——不假装能解指代、能解释。
 * 本模块**不调用任何模型**：一切判定都是确定性的纯逻辑；测试夹具替代端口，产品路径由宿主注入。
 *
 * ## 与既有模块的关系（**只读复用**，不改它们）
 *
 * - `src/conversation/turn-model.ts`：消息 / 轮次生命周期（幂等、重试、续取）；
 * - `src/conversation/run-constraints.ts`：**运行中要求的归属判据**（本层按会话分板复用）；
 * - `src/facts/multi-artifact-update.ts`：多产物事务视图与反向对照核对器；
 * - `src/protocol`：载体形状与品牌类型；`src/workledger`：气泡 / 动作类型。
 *
 * 纯逻辑、零 IO、无墙钟、无随机数：时间一律由调用方以 `LogicalTime` 传入。
 */

import {
  asLogicalTime,
  asRevision,
  asTaskId,
  createIdSource,
  type ArtifactRecord,
  type ArtifactRef,
  type IdSource,
  type LogicalTime,
  type MessageId,
  type Revision,
  type SharedFactRecord,
  type TaskId,
  type TemplateKind,
} from '../../../src/protocol/index.js';
import {
  RunConstraintBoard,
  TurnModel,
  type ActiveRun,
  type ApplyRequirementResult,
  type RequirementKind,
  type TurnMessage,
  type TurnTask,
} from '../../../src/conversation/index.js';
import {
  buildMultiArtifactTransaction,
  checkTransactionView,
  type MultiArtifactTransactionView,
  type SharedFactUpdate,
  type TransactionObservation,
  type TransactionViolation,
} from '../../../src/facts/index.js';
import type { ActionRecord, DecisionBubble } from '../../../src/workledger/index.js';

// ---------------------------------------------------------------------------
// 端口：候选数据的唯一来源
// ---------------------------------------------------------------------------

/** 会话里的一张任务卡（本层的只读视图；与内核记录同口径，不引入第二套身份）。 */
export interface LoopTask {
  readonly task_id: TaskId;
  readonly title: string;
  readonly revision: Revision;
  readonly status: 'running' | 'paused' | 'completed' | 'cancelled' | 'failed';
}

/** 会话里的一个产物（本层的只读视图；`digest` 未回读核实时为 `null`，不以"应该有"冒充）。 */
export interface LoopArtifact {
  readonly artifact_id: ArtifactRef;
  readonly task_id: TaskId;
  readonly revision: Revision;
  readonly version: number;
  readonly template_kind: TemplateKind;
  /** 用户可读的名字（用于候选与解释；**不参与**任何归属判定）。 */
  readonly title: string;
  readonly digest: string | null;
  readonly updated_at: LogicalTime;
}

/**
 * 目录端口：任务与产物的**唯一**外部来源。
 *
 * 实现方负责从内核 / 落盘读出真实数据；本层只读、只做显式判定。
 * **不注入 ⇒ 未就绪**（{@link ConversationLoop.readiness}）。
 */
export interface ConversationCatalogPort {
  listTasks(conversation_id: string): readonly LoopTask[];
  listArtifacts(conversation_id: string): readonly LoopArtifact[];
}

// ---------------------------------------------------------------------------
// 就绪
// ---------------------------------------------------------------------------

export interface LoopReadiness {
  readonly ready: boolean;
  readonly reason: 'catalog_port_injected' | 'no_catalog_port';
}

// ---------------------------------------------------------------------------
// 指代解析
// ---------------------------------------------------------------------------

/**
 * 指代**指针**（结构化，不是文本）。
 *
 * 界面知道"用户在看哪个文件 / 刚点了哪个"，把结构化指针交给本层；本层据此给出**显式**
 * `(task_id, artifact_id, revision)`。这里没有"文本像不像"的入口——`title` 只用于让用户在
 * 候选里认出来，**绝不**参与命中判定。
 */
export type ReferenceHint =
  /** "这个文件"：界面给显式产物 id（用户正打开的那一个）。 */
  | { readonly kind: 'artifact'; readonly artifact_id: ArtifactRef }
  /** "那个任务"。 */
  | { readonly kind: 'task'; readonly task_id: TaskId }
  /** "就这条消息"：经消息绑定表解析任务与版本。 */
  | { readonly kind: 'message'; readonly message_id: MessageId }
  /** "这个文件"（会话当前指针）：由 {@link ConversationLoop.noteCurrentArtifact} 设置。 */
  | { readonly kind: 'current' }
  /** "刚才那个 / 改一下它"：会话内**最近改动**的产物（确定性时间指针）。 */
  | { readonly kind: 'last_modified' };

/** 解析出的**显式**绑定：任务 + 版本（+ 可选产物）。 */
export interface ResolvedBinding {
  readonly task_id: TaskId;
  /** 指到任务（而非具体产物）时为 `null`。 */
  readonly artifact_id: ArtifactRef | null;
  readonly revision: Revision;
  /** 凭什么解出来的（逐条可核对）。 */
  readonly by: ReferenceHint['kind'];
}

export type ReferenceRejectCode =
  | 'not_ready'
  | 'empty_conversation'
  | 'unknown_artifact'
  | 'artifact_not_in_conversation'
  | 'unknown_task'
  | 'unknown_message'
  | 'no_current_artifact';

export type ReferenceResolution =
  | { readonly status: 'resolved'; readonly binding: ResolvedBinding }
  | {
      readonly status: 'needs_clarification';
      readonly reason: 'ambiguous_referent';
      readonly candidates: readonly LoopArtifact[];
      readonly question: string;
    }
  | { readonly status: 'rejected'; readonly code: ReferenceRejectCode; readonly message: string };

export interface ReferenceQuery {
  readonly conversation_id: string;
  readonly hint: ReferenceHint;
}

// ---------------------------------------------------------------------------
// 多轮
// ---------------------------------------------------------------------------

/** 本轮归属凭的是什么（可核对）。 */
export type TurnOwnership = 'explicit' | 'sole_active_run' | 'created';

export type SubmitRejectCode =
  | 'not_ready'
  | 'empty_text'
  | 'empty_client_id'
  | 'ambiguous_task'
  | 'idempotency_conflict';

export interface SubmitTurnInput {
  readonly conversation_id: string;
  /** 幂等键：同一 `client_id` 重发 ⇒ 同一条消息，**不新建任务**（R207）。 */
  readonly client_id: string;
  readonly text: string;
  /** 显式续接到已有任务；省略时按会话内唯一活动任务归属（或新建）。 */
  readonly task_id?: TaskId;
}

export type SubmitTurnResult =
  | {
      readonly ok: true;
      readonly message: TurnMessage;
      readonly task: TurnTask;
      readonly ownership: TurnOwnership;
      readonly task_created: boolean;
      readonly duplicate: boolean;
    }
  | {
      readonly ok: false;
      readonly code: SubmitRejectCode;
      readonly message: string;
      readonly candidates?: readonly ActiveRun[];
      readonly question?: string;
    };

// ---------------------------------------------------------------------------
// 多产物事务
// ---------------------------------------------------------------------------

export type MultiArtifactRejectCode =
  | 'not_ready'
  | 'empty_task'
  | 'ambiguous_task'
  | 'invalid_instruction';

export interface MultiArtifactChangeInput {
  readonly conversation_id: string;
  readonly instruction_id: string;
  /** 用户原话（可读证据；**不参与**判定）。 */
  readonly utterance: string;
  /** 显式绑定任务；省略时按会话内唯一活动任务归属。 */
  readonly task_id?: TaskId;
  /**
   * 可选**锚**指针（指代解析的结果）。仅作核对：给出的产物必须属于解析出的任务，
   * 否则拒绝——避免"改 A 的任务却拿 B 的产物当锚"这种错配。
   */
  readonly referent?: ReferenceHint;
  readonly from_revision: Revision;
  readonly to_revision: Revision;
  readonly updates: readonly SharedFactUpdate[];
  readonly artifacts: readonly ArtifactRecord[];
  readonly bubbles?: readonly DecisionBubble[];
  readonly actions?: readonly ActionRecord[];
  readonly facts?: readonly SharedFactRecord[];
  readonly at: LogicalTime;
}

export type MultiArtifactChangeResult =
  | { readonly status: 'planned'; readonly view: MultiArtifactTransactionView }
  | {
      readonly status: 'needs_clarification';
      readonly reason: 'ambiguous_task';
      readonly candidates: readonly ActiveRun[];
      readonly question: string;
    }
  | { readonly status: 'rejected'; readonly code: MultiArtifactRejectCode; readonly message: string };

// ---------------------------------------------------------------------------
// 结果解释
// ---------------------------------------------------------------------------

export interface ExplanationInput {
  readonly conversation_id: string;
  /** 只看某个任务；省略时看整个会话。 */
  readonly task_id?: TaskId;
  /** 刚发生的一次多产物改动（可选）；给出时解释会说明"改了哪些、哪些没动、哪些失效"。 */
  readonly view?: MultiArtifactTransactionView;
  /** 仍在等用户拍板的操作（可读文案）。 */
  readonly pending_decisions?: readonly { readonly prompt: string }[];
}

export interface Explanation {
  /** 面向用户的说明：**不含**内部术语（id / 版本号 / 摘要 / 拒因码）。 */
  readonly user_text: string;
  /** 机器可核对的依据（id / 摘要等），**不**进用户文案。 */
  readonly evidence: readonly string[];
}

// ---------------------------------------------------------------------------
// 选项
// ---------------------------------------------------------------------------

export interface ConversationLoopOptions {
  /** 目录端口；`null` / 省略 ⇒ 产品路径未就绪。 */
  readonly catalog?: ConversationCatalogPort | null;
  /** 固定种子（可复现 id）。 */
  readonly seed?: string;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

const KIND_LABELS: Readonly<Record<TemplateKind, string>> = Object.freeze({
  document: 'Word 文档',
  spreadsheet: '表格',
  presentation: '演示文稿',
});

const isActiveRun = (run: ActiveRun): boolean => run.status === 'running' || run.status === 'paused';

const refRejected = (code: ReferenceRejectCode, message: string): ReferenceResolution =>
  Object.freeze({ status: 'rejected' as const, code, message });

const REFERENCE_CLARIFY_QUESTION =
  '你说的"这个/刚才那个"当前对不上唯一一个文件：请点一下具体是哪一份（或指明是哪个任务），我不按名字像不像猜。';

// ---------------------------------------------------------------------------
// 会话循环门面
// ---------------------------------------------------------------------------

/**
 * 连续对话闭环门面：把一条用户消息的**归属 / 指代 / 多产物更新 / 结果解释**收口到一处。
 *
 * 每个会话一张 `RunConstraintBoard`（运行中要求的归属按会话分板：跨会话**不串**任务），
 * 一个共享的 `TurnModel`（消息与轮次的生命周期）。
 */
export class ConversationLoop {
  readonly #catalog: ConversationCatalogPort | null;
  readonly #ids: IdSource;
  readonly #turns: TurnModel;
  /** 每会话一张约束板 —— 归属判据按会话**隔离**（跨会话不串任务）。 */
  readonly #boards = new Map<string, RunConstraintBoard>();
  /** 本层创建 / 见过的、属于某会话的任务（与目录端口取并集）。 */
  readonly #tracked = new Map<string, Set<string>>();
  /** 每个会话的"当前文件"指针（"这个文件"指代用）。 */
  readonly #current = new Map<string, ArtifactRef>();
  /** 消息 → (任务, 版本) 绑定表（"就这条"指代用；只读查询，无副作用）。 */
  readonly #messageBindings = new Map<string, { readonly task_id: TaskId; readonly revision: Revision }>();

  constructor(options: ConversationLoopOptions = {}) {
    this.#catalog = options.catalog ?? null;
    this.#ids = createIdSource(options.seed === undefined ? {} : { seed: options.seed });
    this.#turns = new TurnModel(options.seed === undefined ? {} : { seed: options.seed });
  }

  // --- 就绪 ---------------------------------------------------------------

  /** 产品路径是否就绪（唯一判据：有没有注入目录端口）。 */
  readiness(): LoopReadiness {
    return this.#catalog === null
      ? Object.freeze({ ready: false, reason: 'no_catalog_port' as const })
      : Object.freeze({ ready: true, reason: 'catalog_port_injected' as const });
  }

  /** 把某个产物设为会话的"当前文件"（界面在用户打开文件时调用）。 */
  noteCurrentArtifact(conversation_id: string, artifact_id: ArtifactRef): void {
    this.#current.set(conversation_id, artifact_id);
  }

  // --- CHAT-01：指代解析 ---------------------------------------------------

  /**
   * 把"这个文件 / 刚才那个 / 改一下它"解析成**显式** `(task_id, artifact_id, revision)`。
   *
   * 命中只看结构化指针与显式 id；**并列 / 对不上 ⇒ 需要澄清并给候选**，绝不按标题相似度挑。
   */
  resolveReference(query: ReferenceQuery): ReferenceResolution {
    const catalog = this.#catalog;
    if (catalog === null) {
      return refRejected('not_ready', '目录端口未注入：无法枚举候选，指代解析未就绪（不猜）');
    }
    const conversationId = query.conversation_id;
    const hint = query.hint;

    switch (hint.kind) {
      case 'task': {
        const task = this.#tasksOf(conversationId).find((item) => item.task_id === hint.task_id);
        if (task === undefined) {
          return refRejected(
            'unknown_task',
            `会话 ${conversationId} 里没有任务 ${String(hint.task_id)}（不按相近任务猜）`,
          );
        }
        return Object.freeze({
          status: 'resolved' as const,
          binding: Object.freeze({
            task_id: task.task_id,
            artifact_id: null,
            revision: task.revision,
            by: hint.kind,
          }),
        });
      }
      case 'artifact': {
        const artifact = this.#artifactsOf(conversationId).find(
          (item) => item.artifact_id === hint.artifact_id,
        );
        if (artifact === undefined) {
          return refRejected(
            'artifact_not_in_conversation',
            `产物 ${String(hint.artifact_id)} 不属于会话 ${conversationId}：不跨会话认领、不按名字相近猜`,
          );
        }
        this.noteCurrentArtifact(conversationId, artifact.artifact_id);
        return Object.freeze({
          status: 'resolved' as const,
          binding: Object.freeze({
            task_id: artifact.task_id,
            artifact_id: artifact.artifact_id,
            revision: artifact.revision,
            by: hint.kind,
          }),
        });
      }
      case 'message': {
        // 只读消息绑定表：解出任务与版本，**不**落库任何要求（无副作用）。
        const binding = this.#messageBindings.get(String(hint.message_id));
        if (binding === undefined) {
          return refRejected(
            'unknown_message',
            `消息 ${String(hint.message_id)} 没有绑定到本会话的任何任务：无法据此确定归属`,
          );
        }
        return Object.freeze({
          status: 'resolved' as const,
          binding: Object.freeze({
            task_id: binding.task_id,
            artifact_id: null,
            revision: binding.revision,
            by: hint.kind,
          }),
        });
      }
      case 'current': {
        const pointer = this.#current.get(conversationId);
        if (pointer === undefined) {
          return refRejected(
            'no_current_artifact',
            '会话里还没有"当前打开的文件"：请指明是哪一份（我不猜）',
          );
        }
        const artifact = this.#artifactsOf(conversationId).find((item) => item.artifact_id === pointer);
        if (artifact === undefined) {
          return refRejected(
            'no_current_artifact',
            '会话的当前文件指针已失效（该文件不在本会话的产物里）：请重新指明',
          );
        }
        return Object.freeze({
          status: 'resolved' as const,
          binding: Object.freeze({
            task_id: artifact.task_id,
            artifact_id: artifact.artifact_id,
            revision: artifact.revision,
            by: hint.kind,
          }),
        });
      }
      case 'last_modified': {
        const artifacts = this.#artifactsOf(conversationId);
        if (artifacts.length === 0) {
          return refRejected('empty_conversation', '会话里还没有任何文件：没有"刚才那个"可指');
        }
        const ranked = [...artifacts].sort(compareArtifactsByRecency);
        const top = ranked[0];
        if (top === undefined) {
          return refRejected('empty_conversation', '会话里还没有任何文件');
        }
        const tied = ranked.filter((item) => item.updated_at === top.updated_at);
        if (tied.length > 1) {
          return Object.freeze({
            status: 'needs_clarification' as const,
            reason: 'ambiguous_referent' as const,
            candidates: Object.freeze(tied),
            question: REFERENCE_CLARIFY_QUESTION,
          });
        }
        return Object.freeze({
          status: 'resolved' as const,
          binding: Object.freeze({
            task_id: top.task_id,
            artifact_id: top.artifact_id,
            revision: top.revision,
            by: hint.kind,
          }),
        });
      }
    }
  }

  // --- CHAT-01：多轮（追问 / 补资料归属同一任务）--------------------------

  /**
   * 收下一条用户消息并**按显式判据**归属任务。
   *
   * - 带 `task_id` ⇒ 直接续接该任务（`ownership='explicit'`）；
   * - 不带 ⇒ 会话内**恰好一个**活动任务则续接（`'sole_active_run'`）；**零个**则新建
   *   （`'created'`）；**两个及以上** ⇒ `needs_clarification`（带候选，不按措辞猜）。
   */
  submit(input: SubmitTurnInput): SubmitTurnResult {
    if (this.#catalog === null) {
      return Object.freeze({ ok: false as const, code: 'not_ready' as const, message: '目录端口未注入：会话循环未就绪' });
    }
    if (typeof input.client_id !== 'string' || input.client_id.length === 0) {
      return Object.freeze({ ok: false as const, code: 'empty_client_id' as const, message: '缺少 client_id（幂等键）' });
    }
    if (typeof input.text !== 'string' || input.text.length === 0) {
      return Object.freeze({ ok: false as const, code: 'empty_text' as const, message: '消息正文不能为空' });
    }

    const conversationId = input.conversation_id;
    let ownership: TurnOwnership = 'created';
    let targetTaskId: TaskId | undefined;

    if (input.task_id !== undefined) {
      ownership = 'explicit';
      targetTaskId = input.task_id;
    } else {
      const active = this.#activeRuns(conversationId);
      if (active.length > 1) {
        return Object.freeze({
          ok: false as const,
          code: 'ambiguous_task' as const,
          message: '当前会话有多个任务在执行：请指明这条消息续到哪一个（点任务卡或引用那条消息），我不按措辞猜',
          candidates: active,
          question: '有多个任务在执行，这条消息是接着哪一个说的？',
        });
      }
      if (active.length === 1) {
        const only = active[0];
        if (only !== undefined) {
          ownership = 'sole_active_run';
          targetTaskId = only.task_id;
        }
      }
    }

    const submitted = this.#turns.submitUserMessage({
      text: input.text,
      client_id: input.client_id,
      ...(targetTaskId === undefined ? {} : { task_id: targetTaskId }),
    });
    if (!submitted.ok) {
      return Object.freeze({
        ok: false as const,
        code: submitted.code === 'idempotency_conflict' ? ('idempotency_conflict' as const) : ('empty_text' as const),
        message: submitted.message,
      });
    }

    const task = submitted.task;
    this.#track(conversationId, task.task_id);
    const board = this.#board(conversationId);
    if (board.getRun(task.task_id) === undefined) {
      board.startRun({ task_id: task.task_id, title: `会话任务 ${String(task.task_id)}`, revision: task.revision });
    }
    board.registerMessageBinding({
      message_id: submitted.message.message_id,
      task_id: task.task_id,
      revision: task.revision,
    });
    this.#messageBindings.set(String(submitted.message.message_id), {
      task_id: task.task_id,
      revision: task.revision,
    });

    return Object.freeze({
      ok: true as const,
      message: submitted.message,
      task,
      ownership: submitted.task_created ? ('created' as const) : ownership,
      task_created: submitted.task_created,
      duplicate: submitted.duplicate,
    });
  }

  /** 会话内已登记的任务数（用于断言"连续多轮不新建第二个任务"）。 */
  taskCount(conversation_id: string): number {
    return this.#tasksOf(conversation_id).length;
  }

  /** 全部消息（按 seq 升序）。 */
  messages(): readonly TurnMessage[] {
    return this.#turns.listMessages();
  }

  // --- CHAT-04：改约束 / 补资料（归属同一任务）-----------------------------

  /**
   * 把一条运行中的要求（改约束 / 补资料）按**显式判据**归属并落库。
   *
   * 直接复用 `RunConstraintBoard`——每个会话一块板，因此"唯一活动任务"是按会话数的，
   * 跨会话**不串**。无显式绑定且会话内无活动任务 ⇒ `no_active_run`（**不**回退去猜别的会话）。
   */
  applyRequirement(input: {
    readonly conversation_id: string;
    readonly kind: RequirementKind;
    readonly text: string;
    readonly task_id?: TaskId;
    readonly message_id?: MessageId;
    readonly revision?: Revision;
  }): ApplyRequirementResult | { readonly status: 'rejected'; readonly code: 'not_ready'; readonly message: string } {
    if (this.#catalog === null) {
      return Object.freeze({ status: 'rejected' as const, code: 'not_ready' as const, message: '目录端口未注入：会话循环未就绪' });
    }
    const conversationId = input.conversation_id;
    this.#syncBoard(conversationId);
    const board = this.#board(conversationId);
    return board.applyRequirement({
      kind: input.kind,
      text: input.text,
      ...(input.task_id === undefined ? {} : { task_id: input.task_id }),
      ...(input.message_id === undefined ? {} : { message_id: input.message_id }),
      ...(input.revision === undefined ? {} : { revision: input.revision }),
    });
  }

  // --- CHAT-06：一句话改多个关联产物 --------------------------------------

  /**
   * 编排一次"一句话改多个关联产物"的事务视图。
   *
   * 先按显式判据归属任务，再交给 `buildMultiArtifactTransaction`（失效闭包 → 只更新受影响
   * 产物 → 无关产物进"不动清单" → 旧气泡过期）。事务本身不在此层重算——本层只做归属与形状收口。
   */
  planMultiArtifactChange(input: MultiArtifactChangeInput): MultiArtifactChangeResult {
    if (this.#catalog === null) {
      return Object.freeze({ status: 'rejected' as const, code: 'not_ready' as const, message: '目录端口未注入：会话循环未就绪' });
    }
    const conversationId = input.conversation_id;

    let taskId: TaskId;
    if (input.task_id !== undefined) {
      taskId = input.task_id;
    } else {
      const active = this.#activeRuns(conversationId);
      if (active.length === 0) {
        return Object.freeze({ status: 'rejected' as const, code: 'empty_task' as const, message: '会话里没有正在执行的任务：无法确定这条改动改哪个任务' });
      }
      if (active.length > 1) {
        return Object.freeze({
          status: 'needs_clarification' as const,
          reason: 'ambiguous_task' as const,
          candidates: active,
          question: '当前有多个任务在执行：请指明这条改动改哪一个，我不按措辞猜',
        });
      }
      const only = active[0];
      if (only === undefined) {
        return Object.freeze({ status: 'rejected' as const, code: 'empty_task' as const, message: '会话里没有正在执行的任务' });
      }
      taskId = only.task_id;
    }

    // 锚指针核对：给出的指代产物必须属于解析出的任务（防"改 A 却拿 B 的产物当锚"）。
    if (input.referent !== undefined) {
      const resolved = this.resolveReference({ conversation_id: conversationId, hint: input.referent });
      if (resolved.status !== 'resolved') {
        return Object.freeze({ status: 'rejected' as const, code: 'invalid_instruction' as const, message: '指代未能唯一确定：请先澄清要改哪一份，再下达改动' });
      }
      if (resolved.binding.task_id !== taskId) {
        return Object.freeze({
          status: 'rejected' as const,
          code: 'invalid_instruction' as const,
          message: '指代到的产物与要改的任务不是同一个：拒绝执行（不跨任务套用）',
        });
      }
    }

    try {
      const view = buildMultiArtifactTransaction({
        instruction: {
          instruction_id: input.instruction_id,
          utterance: input.utterance,
          task_id: taskId,
          from_revision: input.from_revision,
          to_revision: input.to_revision,
          at: input.at,
        },
        updates: input.updates,
        artifacts: input.artifacts,
        ...(input.bubbles === undefined ? {} : { bubbles: input.bubbles }),
        ...(input.actions === undefined ? {} : { actions: input.actions }),
        ...(input.facts === undefined ? {} : { facts: input.facts }),
      });
      return Object.freeze({ status: 'planned' as const, view });
    } catch (error) {
      return Object.freeze({
        status: 'rejected' as const,
        code: 'invalid_instruction' as const,
        message: `改动指令不合法：${describeError(error)}`,
      });
    }
  }

  /**
   * 用"计划的应然"核验"实现的实然"（**反向对照**，复用 `checkTransactionView`）。
   *
   * 反例必须被抓：无关产物被重写 ⇒ `unrelated_artifact_rewritten`；受影响产物漏改 ⇒
   * `affected_artifact_missing`；旧气泡仍被执行 ⇒ `expired_bubble_executed`。
   */
  verifyMultiArtifact(
    view: MultiArtifactTransactionView,
    observation: TransactionObservation,
  ): readonly TransactionViolation[] {
    return checkTransactionView(view, observation);
  }

  // --- CHAT-01：结果解释（用户可读，无内部术语）----------------------------

  /**
   * 把产物与证据整理成**用户可读**的说明。
   *
   * 用户文案只用"文件 / 改动 / 待确认"这类词，**不出现** id、版本号、摘要、拒因码；
   * 机器依据（id / 摘要）另放在 `evidence` 里，供复核，不进用户文案。
   */
  explain(input: ExplanationInput): Explanation {
    const catalog = this.#catalog;
    if (catalog === null) {
      return Object.freeze({
        user_text: '当前还无法说明结果：会话的数据源尚未接入。',
        evidence: Object.freeze(['readiness=no_catalog_port']),
      });
    }
    const arts = this.#artifactsOf(input.conversation_id).filter(
      (item) => input.task_id === undefined || item.task_id === input.task_id,
    );

    const sentences: string[] = [];
    const evidence: string[] = [];

    if (arts.length === 0) {
      sentences.push('目前还没有产出任何文件。');
    } else {
      const counts = new Map<TemplateKind, number>();
      for (const item of arts) {
        counts.set(item.template_kind, (counts.get(item.template_kind) ?? 0) + 1);
      }
      const breakdown = [...counts.entries()]
        .map(([kind, count]) => `${String(count)} 份${KIND_LABELS[kind]}`)
        .join('、');
      sentences.push(`目前共有 ${String(arts.length)} 份文件（${breakdown}）。`);
      for (const item of arts) {
        evidence.push(`file ${String(item.artifact_id)} kind=${item.template_kind} digest=${item.digest ?? 'unknown'}`);
      }
    }

    const view = input.view;
    if (view !== undefined) {
      const updated = view.totals.artifacts_updated;
      const untouched = view.totals.artifacts_untouched;
      sentences.push(
        updated === 0
          ? '刚才那次改动没有需要重做的文件，已有文件保持不变。'
          : `刚才那次改动重做了 ${String(updated)} 份相关文件，另有 ${String(untouched)} 份文件没有受到影响、保持原样。`,
      );
      if (view.totals.bubbles_expired > 0) {
        sentences.push(
          `有 ${String(view.totals.bubbles_expired)} 个之前请你确认的操作已经失效，请重新确认后才会执行。`,
        );
      }
      if (view.totals.artifacts_preserved > 0) {
        sentences.push('被替换的旧文件已作为历史保留，可随时找回。');
      }
      evidence.push(`transaction ${view.instruction_id} digest=${view.review_digest}`);
    }

    const pending = input.pending_decisions ?? [];
    if (pending.length > 0) {
      sentences.push(`还有 ${String(pending.length)} 项操作在等你确认。`);
      for (const item of pending) {
        sentences.push(`· ${item.prompt}`);
      }
    }

    return Object.freeze({
      user_text: sentences.join(''),
      evidence: Object.freeze(evidence),
    });
  }

  // --- 内部：目录与约束板 -------------------------------------------------

  #tasksOf(conversation_id: string): readonly LoopTask[] {
    const catalog = this.#catalog;
    const fromCatalog = catalog === null ? [] : [...catalog.listTasks(conversation_id)];
    const seen = new Set(fromCatalog.map((item) => String(item.task_id)));
    // 本层已创建 / 见过的任务：目录端口尚未反映时（如刚落库），补上。
    for (const tracked of this.#tracked.get(conversation_id) ?? []) {
      if (!seen.has(tracked)) {
        seen.add(tracked);
        fromCatalog.push(
          Object.freeze({
            task_id: asTaskId(tracked),
            title: `会话任务 ${tracked}`,
            revision: asRevision(0),
            status: 'running' as const,
          }),
        );
      }
    }
    return Object.freeze(fromCatalog);
  }

  #artifactsOf(conversation_id: string): readonly LoopArtifact[] {
    const catalog = this.#catalog;
    return catalog === null ? Object.freeze([]) : catalog.listArtifacts(conversation_id);
  }

  #board(conversation_id: string): RunConstraintBoard {
    const existing = this.#boards.get(conversation_id);
    if (existing !== undefined) {
      return existing;
    }
    const fresh = new RunConstraintBoard();
    this.#boards.set(conversation_id, fresh);
    return fresh;
  }

  /** 把目录里已知的任务补登到本会话的板上（归属判据的"活动运行"来源）。 */
  #syncBoard(conversation_id: string): void {
    const board = this.#board(conversation_id);
    const known = new Set(board.listRuns().map((run) => String(run.task_id)));
    for (const task of this.#tasksOf(conversation_id)) {
      if (known.has(String(task.task_id))) {
        continue;
      }
      // 终态任务不进"活动运行"：它们不该被当成本轮归属的候选（`failed` 不在 RunStatus 里）。
      if (task.status !== 'running' && task.status !== 'paused') {
        continue;
      }
      board.startRun({ task_id: task.task_id, title: task.title, revision: task.revision });
      known.add(String(task.task_id));
    }
  }

  #activeRuns(conversation_id: string): readonly ActiveRun[] {
    this.#syncBoard(conversation_id);
    return this.#board(conversation_id).listRuns().filter(isActiveRun);
  }

  #track(conversation_id: string, task_id: TaskId): void {
    const set = this.#tracked.get(conversation_id) ?? new Set<string>();
    set.add(String(task_id));
    this.#tracked.set(conversation_id, set);
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 最近改动优先；同刻按 id 稳定排序（确定性，不用随机 / 墙钟）。 */
function compareArtifactsByRecency(a: LoopArtifact, b: LoopArtifact): number {
  if (a.updated_at !== b.updated_at) {
    return b.updated_at - a.updated_at;
  }
  return a.artifact_id < b.artifact_id ? -1 : a.artifact_id > b.artifact_id ? 1 : 0;
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

// 供调用方显式引用的时间构造（与仓库其他层同口径）。
export const loopLogicalTime = asLogicalTime;
