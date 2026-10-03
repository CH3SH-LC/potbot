/**
 * K07 授权与提交账本 —— **状态词表、数据结构与端口**（零依赖、纯类型 + 纯函数）。
 *
 * 契约来源：`docs/other/ds-six-lanes-2026-10-03/README.md` §5
 * （`ConfirmAction` 绑定九项 + 期限、`ExternalReceipt` 的 `observedState` 八态、K07 独占
 * `AuthorizationGrant` 格式与可信校验）与 `KERNEL.md` K07 行。
 *
 * **2026-10-03 集成（K-I02）**：`ActionBinding` 增加**任务身份 `taskId`**（九项绑定），
 * 账本内部一律以 `(taskId, actionId)` 为键——关闭 K-R06 记录的 B1（无任务身份）与
 * B2（actionId 全局命名空间）。契约 `contracts/mobile-v1/schemas/confirm-action.schema.json`
 * 的同步（新增 taskId 属性 + required）不在本包写权内，属**编排人交接**（见 K-I02 残差）。
 *
 * ## 八态词表（**严格用这八个词，不得合并**）
 *
 * `prepared → authorized → submitting → submitted → unknown / confirmed / failed / cancelled`
 *
 * 一条动作的完整生命周期横跨三个对象：
 * 确认请求入账 = `prepared`；授权发行 = `authorized`；授权被占用 = `submitting`；
 * 执行器受理 = `submitted`；之后是 `unknown`（无回执）/ `confirmed`（可信回执）/ `failed`；
 * 撤权或取消 = `cancelled`。`AuthorizationLedger.observedStateOf()` 把它们串成一条可观测状态。
 *
 * ## 唯一可声称"完成"的状态
 *
 * `COMPLETION_CLAIMABLE_STATES` 只有 `confirmed` 一项。`unknown` / `submitted` / `failed`
 * **一律不得**被写成完成——这不是注释里的口号，由 `mayClaimExternalCompletion()` /
 * `assertCompletionClaimable()` 机器化断言，并且在账本唯一的写入汇点 `#writeSubmission()`
 * 里再挡一次（`confirmed` 必须携带**受控执行器签发**的可信回执）。
 *
 * ## 与 `contracts/mobile-v1/` 的关系（本包开发期间该契约已由总协调交付）
 *
 * 字段名与八态词表已对齐并逐条核对（`vocab/status.json` 的 `externalReceiptStates`
 * 与本模块 `SUBMISSION_STATES` 逐字同序）。已对齐项：`scope` 取值域（`CONFIRM_SCOPES`
 * ← 契约 enum）、`accountRef` / `paramsDigest` 形状（契约 pattern）、`grant.consumed` 布尔、
 * 回执的 `verificationMode` 及"fixture 不得 confirmed"不变量。
 *
 * **编码分歧已由总协调裁决（2026-10-03，`contracts/mobile-v1/README.md` §"金额与时间编码"）**：
 * 契约在 **wire/JSON** 层把 `amount` 定为十进制字符串（`^[0-9]+(\\.[0-9]{1,4})?$`）、
 * 把 `expiresAt` / `observedAt` / `issuedAt` 定为 ISO-8601 UTC 字符串；**领域层一律用
 * 整数最小单位（分）** 与**注入时钟的整数值**。换算**只在边界**、必须精确，落在
 * `wire-codec.ts`；判据（本文件与 `ledger.ts`）**不得**引入浮点，也不得调用 codec。
 */

import { BINDING_FIELDS, type BindingField, AuthorizationError } from './errors.js';

// ---------------------------------------------------------------------------
// 八态词表
// ---------------------------------------------------------------------------

export const SUBMISSION_STATES = [
  'prepared',
  'authorized',
  'submitting',
  'submitted',
  'unknown',
  'confirmed',
  'failed',
  'cancelled',
] as const;

export type SubmissionState = (typeof SUBMISSION_STATES)[number];

/** 每个状态的中文名（原生确认页 / 证据展示用；**不参与判定**）。 */
export const SUBMISSION_STATE_LABELS: Readonly<Record<SubmissionState, string>> = Object.freeze({
  prepared: '已准备',
  authorized: '已授权',
  submitting: '提交中',
  submitted: '已提交',
  unknown: '结果未知',
  confirmed: '已确认',
  failed: '已失败',
  cancelled: '已取消',
});

/** 终态：不再前进（`unknown` / `submitted` **不是**终态——晚到回执仍可确认）。 */
export const TERMINAL_SUBMISSION_STATES = ['confirmed', 'failed', 'cancelled'] as const;

/** **唯一**可以声称"外部动作已完成"的状态。 */
export const COMPLETION_CLAIMABLE_STATES = ['confirmed'] as const;

export function isSubmissionState(value: unknown): value is SubmissionState {
  return typeof value === 'string' && (SUBMISSION_STATES as readonly string[]).includes(value);
}

export function isTerminalSubmissionState(state: SubmissionState): boolean {
  return (TERMINAL_SUBMISSION_STATES as readonly SubmissionState[]).includes(state);
}

/** 是否**已经动过外部世界**（发出意图或已被受理）：撤权不得抹掉这类记录。 */
export function hasTouchedExternalWorld(entry: {
  readonly sendIntentAt: number | null;
}): boolean {
  return entry.sendIntentAt !== null;
}

/**
 * **完成口径的机器化判据**：只有 `confirmed` 可以声称外部动作完成。
 * 传入 `unknown` / `failed` / `submitted` … 一律返回 false。
 */
export function mayClaimExternalCompletion(state: SubmissionState): boolean {
  return (COMPLETION_CLAIMABLE_STATES as readonly SubmissionState[]).includes(state);
}

/**
 * 提交状态转换表。表外一律 `illegal_submission_transition`（含自环）。
 *
 * 两条刻意**不**开的边，正是"结果未知不得重试"与"一次性"的落点：
 * - `unknown → submitted`（不回退，不重发）；
 * - `submitted → submitting`（不重来）。
 *
 * 两条刻意**开**的边：
 * - `submitting → confirmed`：本地"已发出意图"只是**猜测**，可信回执是**证据**；
 *   查询原单确认存在后，证据优先于猜测（崩溃窗口的提交也能被正确收口）。
 * - `submitted → unknown`：提交后迟迟没有回执 = 结果未知，而不是"还在提交中"。
 */
export const SUBMISSION_TRANSITIONS: Readonly<Record<SubmissionState, readonly SubmissionState[]>> =
  Object.freeze({
    prepared: ['authorized', 'submitting', 'cancelled', 'failed'],
    authorized: ['submitting', 'cancelled', 'failed'],
    submitting: ['submitted', 'unknown', 'confirmed', 'failed', 'cancelled'],
    submitted: ['confirmed', 'unknown', 'failed', 'cancelled'],
    unknown: ['confirmed', 'failed', 'cancelled'],
    confirmed: [],
    failed: [],
    cancelled: [],
  });

export function canTransitionSubmission(from: SubmissionState, to: SubmissionState): boolean {
  return (SUBMISSION_TRANSITIONS[from] ?? []).includes(to);
}

// ---------------------------------------------------------------------------
// 确认请求（ConfirmAction）——九字段，字段名严格照契约
// ---------------------------------------------------------------------------

/**
 * 动作的**九项可核对绑定**（原八项 + 任务身份 `taskId`）。授权发行时逐项绑定，
 * 提交时逐项复核；任一项变化 ⇒ 旧授权失效（`grant_binding_mismatch`，带 `field`）。
 */
/**
 * `scope` 的取值域，**逐字取自** `contracts/mobile-v1/schemas/confirm-action.schema.json`
 * 的 `$defs.scope.enum`（不是本模块自造的词表）。
 */
export const CONFIRM_SCOPES = [
  'purchase',
  'payment',
  'submit-order',
  'write-file',
  'external-mutation',
] as const;

export type ConfirmScope = (typeof CONFIRM_SCOPES)[number];

export interface ActionBinding {
  /**
   * **任务身份**（K-R06 B1/B2 的封堵点，2026-10-03 集成）。
   *
   * 没有它，`actionId` 就是一个**全局**命名空间：两个逻辑任务派生出同名 actionId
   * 会互相顶掉，且没有任何字段能把一条授权/提交绑回它所属的任务——越权在结构上
   * 不可表达、更不可机器拒绝。加入 taskId 之后：
   * - 它是**逐项绑定**的一员（见 `BINDING_FIELDS`），授权发行时绑定、提交时逐项复核，
   *   跨任务占用 ⇒ `grant_binding_mismatch`（`field === 'taskId'`）；
   * - 账本内部一律以 `(taskId, actionId)` 为键，因此"任务内"的 actionId 不再是全局键，
   *   两个任务的同名动作可以各自独立走完整条链。
   *
   * 非空字符串（`requireText` 校验；本模块不猜任务 id 的字面规则）。
   */
  readonly taskId: string;
  readonly actionId: string;
  /** 账号/收款方引用，不是凭据。契约形状：`^acct:[A-Za-z0-9._:-]+$`。 */
  readonly accountRef: string;
  /** 任务版本：推进后旧授权失效。 */
  readonly taskRevision: number;
  /** 完整参数摘要。契约形状：`^sha256:[0-9a-f]{64}$`（本模块在校验时强制）。 */
  readonly paramsDigest: string;
  /** 报价引用（价格可能随报价变化；变更即失效）。 */
  readonly quoteRef: string;
  /**
   * **整数最小单位**（分）。禁止浮点——浮点金额会让"相等"变成不可靠判据。
   *
   * 与 `contracts/mobile-v1` 的差异见本文件头部"编码差异"一节：
   * 契约在 **wire/JSON** 层用十进制字符串（同样是为了避免浮点），本模块在**内核内存**
   * 层用整数分；两者之间的换算属于适配层，不在授权判据里。
   */
  readonly amount: number;
  /** ISO 4217 大写三字母（`CNY` / `USD`）。 */
  readonly currency: string;
  /** 权限范围：取值域见 `CONFIRM_SCOPES`（取自契约 enum）。 */
  readonly scope: ConfirmScope;
}

/** 确认请求：绑定的九项 + 期限。**展示数据一律从持久账本读**，见 `ConfirmationDisplay`。 */
export interface ConfirmAction extends ActionBinding {
  /** 期限（与 `Clock.now()` 同单位）。到 / 过此值 ⇒ 不得确认、不得发行、不得占用。 */
  readonly expiresAt: number;
}

/**
 * 原生确认页要渲染的载荷。
 *
 * `source` 是**字面量 `'ledger'`**：它只能由账本读取产生，调用方无法构造出
 * "来自账本但其实来自模型字符串"的载荷。`claimVerified` 表示调用方**另外声明**的
 * 一份摘要是否与账本逐项核对通过（声明不一致即**拒**，不会走到这里）。
 */
export interface ConfirmationDisplay extends ActionBinding {
  readonly source: 'ledger';
  readonly expiresAt: number;
  /** 是否附带做了"调用方声明 vs 账本"的逐项核对（未声明则为 false）。 */
  readonly claimVerified: boolean;
}

/**
 * 可信确认根：**只有本模块账本能签发**的确认凭证。
 *
 * 这就是"客户端可自称用户已批准"的封堵点——凭证在模块私有的 `WeakSet` 里登记，
 * 调用方**无法**凭一个形状相同的对象冒充（`untrusted_attestation`），
 * 也无法凭一张旧凭证在账本内容变化后继续发行（`attestation_binding_mismatch`）。
 */
export interface ConfirmationAttestation {
  readonly actionId: string;
  /** 签发时刻**从账本逐字段拷贝**的快照（不是调用方传来的声明）。 */
  readonly binding: ConfirmAction;
  /** 确认界面标识（真机上是原生确认页；本包未接原生页，见 `ledger.ts` 头部说明）。 */
  readonly surface: string;
  readonly confirmedAt: number;
}

// ---------------------------------------------------------------------------
// 一次性授权（AuthorizationGrant）
// ---------------------------------------------------------------------------

/** 授权自身的状态（八态词表的子集）。 */
export type GrantState = 'authorized' | 'submitting' | 'cancelled';

export interface AuthorizationGrant extends ActionBinding {
  readonly grantId: string;
  readonly expiresAt: number;
  readonly issuedAt: number;
  /** 签发凭证的确认界面标识（可审计：谁批的）。 */
  readonly grantedBy: string;
  readonly state: GrantState;
  /** 契约 `$defs.grant` 的必需布尔字段；恒等于 `consumedAt !== null`。 */
  readonly consumed: boolean;
  /** 被占用的时刻；`null` = 尚未占用。 */
  readonly consumedAt: number | null;
  /** 占用它的提交记录 id（一次授权至多产生一条提交）。 */
  readonly consumedBySubmissionId: string | null;
  readonly revokedAt: number | null;
  readonly revokedReason: string | null;
}

// ---------------------------------------------------------------------------
// 外部回执（ExternalReceipt）与提交记录（Submission）
// ---------------------------------------------------------------------------

/**
 * 回执允许回报的状态：只有这四种是"外部世界对我们说的话"。
 * 注意 `unknown` 也在内——"问了但没问出结果"同样是回执的一种，且**绝不等同于完成**。
 */
export const RECEIPT_OBSERVED_STATES = ['confirmed', 'unknown', 'failed', 'cancelled'] as const;

export type ReceiptObservedState = (typeof RECEIPT_OBSERVED_STATES)[number];

/**
 * 验证模式（契约 `$defs.verificationMode`）。
 * **`fixture` 产物不得冒充真实订单/支付/手机通过回执**：见 `ReceiptObservedState` 下的不变量。
 */
export const VERIFICATION_MODES = ['fixture', 'real'] as const;

export type VerificationMode = (typeof VERIFICATION_MODES)[number];

/**
 * 受控执行器/供应方签发的回执。字段名照契约 `ExternalReceipt`。
 *
 * **不变量**（契约 `external-receipt.schema.json` 的 `oneOf`/`not`）：
 * `verificationMode === 'fixture'` 时 `observedState` **不得**为 `confirmed`——
 * 假端口不得签发"真实完成"。本模块在 `createTrustedReceipt()` 强制它。
 */
export interface ExternalReceipt {
  readonly actionId: string;
  /** 供应方标识（如 `meituan`）。 */
  readonly provider: string;
  /** 供应方侧的原单引用（查询原单用的就是它）。 */
  readonly requestRef: string;
  readonly externalId: string;
  readonly observedState: ReceiptObservedState;
  readonly observedAt: number;
  readonly evidenceRef: string;
  /** 契约要求存在；`fixture` 模式不得为 `confirmed`。 */
  readonly verificationMode: VerificationMode;
  readonly detail: string;
}

/**
 * 提交记录：占用授权的那一刻落账，**先于**任何对外调用。
 *
 * `sendIntentAt` 是本设计的核心一格：
 * - `null` ⇒ 本地账本认为**尚未发出**（崩在占用之后、发出之前）；
 * - 非 `null` ⇒ **已留下发出意图**（此后发出的可能已经到达供应方，状态只能是"未知"）。
 *
 * 恢复入口 `recover()` 就是靠它区分"未发出"与"已发出未知"，从而决定是"继续同一条提交"
 * 还是"只能查原单"。
 */
export interface SubmissionRecord extends ActionBinding {
  readonly submissionId: string;
  readonly grantId: string;
  readonly state: SubmissionState;
  readonly sendIntentAt: number | null;
  readonly sentAt: number | null;
  readonly receipt: ExternalReceipt | null;
  readonly failureReason: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

// ---------------------------------------------------------------------------
// 端口（端口是**同步或异步均可**的；"发出"的记账在调用端口**之前**完成）
// ---------------------------------------------------------------------------

/** 交给执行器的提交请求（`submissionId` 同时充当幂等键）。 */
export interface ExternalSubmitRequest extends ActionBinding {
  readonly submissionId: string;
  readonly at: number;
}

export type ExecutorOutcome =
  | { readonly outcome: 'accepted' }
  | { readonly outcome: 'failed'; readonly reason: string }
  | { readonly outcome: 'unknown'; readonly detail: string };

/**
 * 真实执行器端口。真机上是网络调用（异步）；夹具可以是同步函数。
 * **端口抛错 = 进程在发出途中死掉**：账本有意**不**兜住这个异常，
 * 让提交记录停在 `submitting` + `sendIntentAt != null`，交给 `recover()` 辨明。
 */
export interface ExternalExecutorPort {
  readonly identity: string;
  send(request: ExternalSubmitRequest): ExecutorOutcome | Promise<ExecutorOutcome>;
}

export interface OrderQueryRequest {
  readonly submissionId: string;
  /** 任务身份（与绑定同源）：查原单也带上，供应方回执才能归属到正确的任务。 */
  readonly taskId: string;
  readonly actionId: string;
  readonly requestRef: string;
}

/** 原单查询端口：结果未知时**只查原单**，不重下。 */
export interface OrderQueryPort {
  readonly identity: string;
  query(request: OrderQueryRequest): ExternalReceipt | null | Promise<ExternalReceipt | null>;
}

// ---------------------------------------------------------------------------
// 恢复
// ---------------------------------------------------------------------------

/**
 * 恢复判定的分类。
 * - `not_sent`：占用后、发出前中断 ⇒ 同一提交可继续（**不是**新提交、更不是新授权）；
 * - `sent_unknown`：已留下发出意图但没有可靠结果 ⇒ **只能查原单**；
 * - `awaiting_receipt`：执行器已受理，等回执 ⇒ 查原单；
 * - `settled`：终态，无需动作。
 */
export type RecoveryKind = 'not_sent' | 'sent_unknown' | 'awaiting_receipt' | 'settled';

export type RecoveryAllowedAction = 'resume_same_submission' | 'query_original_order' | 'none';

/**
 * 恢复结论。`mayIssueNewGrant` / `mayCreateNewSubmission` 是**字面量 `false`**：
 * 恢复入口在类型层面就不表达"另发授权 / 重复下单"这两件事
 * （与仓库既有的 `ActionSideEffect.reverted: false` 同一纪律）。
 */
export interface RecoveryVerdict {
  readonly submissionId: string;
  readonly state: SubmissionState;
  readonly kind: RecoveryKind;
  readonly allowedAction: RecoveryAllowedAction;
  readonly detail: string;
  readonly mayIssueNewGrant: false;
  readonly mayCreateNewSubmission: false;
}

/**
 * `reconcileUnknown()` 的结论：恢复判据 + （仅在允许时）查原单之后的最新提交。
 *
 * `queried` 如实标明本次是否真的调用了原单查询端口：
 * 终态与"未发出"**不查询**，因此 `queried: false`——不得把它当成"查过且没结果"。
 * `mayIssueNewGrant` / `mayCreateNewSubmission` 是字面量 `false`（同 `RecoveryVerdict`）：
 * 恢复路径在类型层面就不表达"另发授权 / 重复下单"。
 */
export interface ReconciliationOutcome {
  readonly verdict: RecoveryVerdict;
  readonly submission: SubmissionRecord;
  readonly queried: boolean;
  readonly mayIssueNewGrant: false;
  readonly mayCreateNewSubmission: false;
}

// ---------------------------------------------------------------------------
// 占用与出口
// ---------------------------------------------------------------------------

export interface ConsumeInput {
  readonly grantId: string;
  /** 提交时的**实际值**：与授权绑定逐项复核，任一项不一致即拒。 */
  readonly actual: ActionBinding;
  /**
   * 原子提交**之后**才调用的观察钩子（取证 / 重入对抗用）。
   * 它的存在本身就是承诺：任何下游代码看到的都是"已占用"之后的账本，
   * 不存在半占用状态可以被观察到。
   */
  readonly onConsumed?: (info: { readonly grant: AuthorizationGrant; readonly submission: SubmissionRecord }) => void;
}

export interface ConsumeOutcome {
  readonly grant: AuthorizationGrant;
  readonly submission: SubmissionRecord;
}

/** 对"外部动作到底做完了没有"的**如实**描述。 */
export interface ExternalOutcomeDescription {
  readonly state: SubmissionState;
  readonly summary: string;
  /** 是否可以声称完成：只有 `confirmed` 为 true。 */
  readonly claimableAsComplete: boolean;
}

// ---------------------------------------------------------------------------
// 纯函数判据
// ---------------------------------------------------------------------------

/**
 * **判据（机器化）**：非 `confirmed` 状态一律不得声称外部动作完成。
 * 把 `unknown` 当成 `confirmed` 调用本函数 ⇒ 抛 `completion_not_claimable`。
 */
export function assertCompletionClaimable(record: SubmissionRecord): void {
  if (!mayClaimExternalCompletion(record.state)) {
    throw new AuthorizationError(
      'completion_not_claimable',
      `提交 ${record.submissionId} 的状态是 ${record.state}（${SUBMISSION_STATE_LABELS[record.state]}）：` +
        `只有 confirmed 才能声称外部动作完成；unknown / submitted / failed 一律不得冒充完成`,
    );
  }
}

/** 如实描述一条提交的外部结果（`unknown` 就是"结果未知"，不美化）。 */
export function describeExternalOutcome(record: SubmissionRecord): ExternalOutcomeDescription {
  return Object.freeze({
    state: record.state,
    summary: SUBMISSION_STATE_LABELS[record.state],
    claimableAsComplete: mayClaimExternalCompletion(record.state),
  });
}

/** 逐项找出两份绑定中**第一个**不一致的字段（无差异返回 null）。 */
export function findBindingMismatch(left: ActionBinding, right: ActionBinding): BindingField | null {
  for (const field of BINDING_FIELDS) {
    if (left[field] !== right[field]) {
      return field;
    }
  }
  return null;
}

/** 从任意绑定形状里取出九项（用于把 ConfirmAction / Grant / Submission 归一比较）。 */
export function bindingOf(source: ActionBinding): ActionBinding {
  return Object.freeze({
    taskId: source.taskId,
    actionId: source.actionId,
    accountRef: source.accountRef,
    taskRevision: source.taskRevision,
    paramsDigest: source.paramsDigest,
    quoteRef: source.quoteRef,
    amount: source.amount,
    currency: source.currency,
    scope: source.scope,
  });
}
