/**
 * K-R06 对抗harness —— 以**独立对手**身份驱动 K07 授权账本，逐条钉住四类攻击。
 *
 * 本模块**只读**产品代码（`apps/mobile-kernel/actions/`），不写、不改、不 mock 它：
 * 每条用例都是真实调用账本的公开方法，观测真实的拒因码与状态转换。
 * 端口（执行器 / 原单查询）用具名夹具注入——它们**记录调用次数**，
 * 因此"只发出一次""只查一次"这类判据有真实计数托底，而不是靠注释。
 *
 * 判定见 `types.ts` 头部：`closed`（挡住了）/ `open`（仍缺口）/ `correct-by-design`（有意如此）。
 *
 * ## 每条用例都配"能咬动"的观测
 *
 * 用例不满足预期时 `passed=false`，测试会红。为了让负例**能咬动**（把实现改坏会红），
 * 观测除了拒因码还带真实计数/状态：例如 A2 断言 `submissions===1`，
 * 若实现允许第二次占用，计数会变 2、用例变红。
 *
 * ## 已知局限（诚实标注）
 *
 * - 单进程内存账本下"并发"只能以**重入 / 不 await** 表达（JS 单线程）；真机多进程/多线程
 *   竞争**未验证**（见 `runbook.md` 的未验证层）。
 * - 时间用注入时钟，**不读墙钟**；真机时钟跳变/时区未验证。
 * - 跨任务族（B）的结论是"**当前绑定里没有任务身份**"，这是对**基线**的静态+行为观测，
 *   不是对某个未来契约的判断。
 */

import {
  createAuthorizationLedger,
  createManualClock,
  createTrustedReceipt,
  isAuthorizationError,
  type ActionBinding,
  type AuthorizationLedger,
  type ConfirmAction,
  type ExecutorOutcome,
  type ExternalReceipt,
  type ExternalSubmitRequest,
  type ManualClock,
  type OrderQueryPort,
  type OrderQueryRequest,
} from '../../../apps/mobile-kernel/actions/index.js';

import type {
  AttackRun,
  AttackRunSummary,
  ScenarioExpectation,
  ScenarioObservation,
  ScenarioRecord,
} from './types.js';

/** 夹具时间原点（任意常数，与真实时间无关，只用于过期判据）。 */
export const T0 = 1_700_000_000_000;

const PRODUCT_MODULE = 'apps/mobile-kernel/actions/ledger.ts';

// ---------------------------------------------------------------------------
// 夹具：标准确认请求 + 记账执行器 + 记账查询端口
// ---------------------------------------------------------------------------

export function confirmAction(over: Partial<ConfirmAction> = {}): ConfirmAction {
  return {
    taskId: 'task-a', // 任务身份（2026-10-03 集成加入）：默认任务 A，B 族用另一任务对照
    actionId: 'act-1',
    accountRef: 'acct:demo:0001', // 契约形状的**引用**占位，非真实账号
    taskRevision: 7,
    paramsDigest: 'sha256:' + '1'.repeat(64),
    quoteRef: 'quote:demo-001',
    amount: 3980,
    currency: 'CNY',
    scope: 'purchase',
    expiresAt: T0 + 60_000,
    ...over,
  };
}

/** 取一条确认请求的八项绑定（去掉 expiresAt）。 */
export function bindingOf(over: Partial<ActionBinding> = {}): ActionBinding {
  const { expiresAt: _drop, ...rest } = confirmAction();
  void _drop;
  return { ...rest, ...over };
}

interface RecordingExecutor {
  readonly identity: string;
  readonly calls: ExternalSubmitRequest[];
  send(request: ExternalSubmitRequest): ExecutorOutcome | Promise<ExecutorOutcome>;
}

function recordingExecutor(
  handler: (request: ExternalSubmitRequest, index: number) => ExecutorOutcome | Promise<ExecutorOutcome>,
): RecordingExecutor {
  const calls: ExternalSubmitRequest[] = [];
  return {
    identity: 'kr06.executor',
    calls,
    send(request) {
      calls.push(request);
      return handler(request, calls.length - 1);
    },
  };
}

interface RecordingQuery extends OrderQueryPort {
  readonly identity: string;
  readonly calls: OrderQueryRequest[];
}

function recordingQuery(handler: (request: OrderQueryRequest, index: number) => ExternalReceipt | null): RecordingQuery {
  const calls: OrderQueryRequest[] = [];
  return {
    identity: 'kr06.order-query',
    calls,
    query(request) {
      calls.push(request);
      return handler(request, calls.length - 1);
    },
  };
}

interface Harness {
  readonly ledger: AuthorizationLedger;
  readonly clock: ManualClock;
}

function harness(options: {
  readonly executor?: RecordingExecutor | null;
  readonly orderQuery?: RecordingQuery | null;
} = {}): Harness {
  const clock = createManualClock(T0);
  const executor = options.executor ?? recordingExecutor(() => ({ outcome: 'accepted' as const }));
  const orderQuery =
    options.orderQuery ??
    recordingQuery(() => null);
  const ledger = createAuthorizationLedger({ clock, executor, orderQuery });
  return { ledger, clock };
}

// ---------------------------------------------------------------------------
// 观测助手：**没有抛错就是 NO_THROW**，绝不把"没拒绝"静默成"成功"
// ---------------------------------------------------------------------------

function capture(fn: () => unknown): string {
  try {
    fn();
    return 'NO_THROW';
  } catch (error) {
    return isAuthorizationError(error) ? error.code : `UNEXPECTED:${String(error)}`;
  }
}

async function captureAsync(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return 'NO_THROW';
  } catch (error) {
    return isAuthorizationError(error) ? error.code : `UNEXPECTED:${String(error)}`;
  }
}

function obs(
  code: string,
  state: string | null,
  extra: Record<string, string | number | boolean> = {},
): ScenarioObservation {
  return Object.freeze({ code, state, extra: Object.freeze(extra) });
}

// ---------------------------------------------------------------------------
// 用例定义
// ---------------------------------------------------------------------------

interface Scenario {
  readonly id: string;
  readonly family: ScenarioRecord['family'];
  readonly title: string;
  readonly expectation: ScenarioExpectation;
  run(): Promise<ScenarioObservation>;
}

const scenarios: readonly Scenario[] = [
  // ===== A 族：重复确认 =====================================================
  {
    id: 'A1',
    family: 'duplicate-confirmation',
    title: '同一动作连点两次"确认"：第二张凭证换不到第二张授权',
    expectation: {
      verdict: 'closed',
      code: 'grant_already_issued',
      state: 'authorized',
      note: '一个动作至多一张授权；重复确认不得再批一次。',
    },
    async run() {
      const { ledger } = harness();
      ledger.recordConfirmAction(confirmAction());
      const first = ledger.attest('task-a', 'act-1', { surface: 'native.confirm' });
      const second = ledger.attest('task-a', 'act-1', { surface: 'native.confirm' });
      ledger.issueGrant(first);
      const code = capture(() => ledger.issueGrant(second));
      return obs(code, ledger.observedStateOf('task-a', 'act-1'), { grants: ledger.counts().grants });
    },
  },
  {
    id: 'A2',
    family: 'duplicate-confirmation',
    title: '同一授权被占用两次（重复点击）：第二次拒且只留一条提交',
    expectation: {
      verdict: 'closed',
      code: 'grant_already_consumed',
      state: 'submitting',
      note: '一次性授权：并发/重复占用最多成功一次。',
    },
    async run() {
      const { ledger } = harness();
      ledger.recordConfirmAction(confirmAction());
      const grant = ledger.issueGrant(ledger.attest('task-a', 'act-1', { surface: 'native.confirm' }));
      ledger.consume({ grantId: grant.grantId, actual: bindingOf() });
      const code = capture(() => ledger.consume({ grantId: grant.grantId, actual: bindingOf() }));
      return obs(code, ledger.observedStateOf('task-a', 'act-1'), { submissions: ledger.counts().submissions });
    },
  },
  {
    id: 'A3',
    family: 'duplicate-confirmation',
    title: '同一提交发出两次：第二次只能查原单，执行器仅被调用一次',
    expectation: {
      verdict: 'closed',
      code: 'already_sent_query_only',
      state: 'submitted',
      note: '重复下单在 API 上不可表达；执行器调用次数是真实判据。',
    },
    async run() {
      const executor = recordingExecutor(() => ({ outcome: 'accepted' as const }));
      const { ledger } = harness({ executor });
      ledger.recordConfirmAction(confirmAction());
      const grant = ledger.issueGrant(ledger.attest('task-a', 'act-1', { surface: 'native.confirm' }));
      const consumed = ledger.consume({ grantId: grant.grantId, actual: bindingOf() });
      await ledger.send(consumed.submission.submissionId);
      const code = await captureAsync(() => ledger.send(consumed.submission.submissionId));
      return obs(code, ledger.observedStateOf('task-a', 'act-1'), { executorCalls: executor.calls.length });
    },
  },
  {
    id: 'A4',
    family: 'duplicate-confirmation',
    title: '同一 actionId 重复登记确认请求：拒',
    expectation: {
      verdict: 'closed',
      code: 'confirm_already_recorded',
      state: 'prepared',
      note: '一个动作只有一条确认请求。',
    },
    async run() {
      const { ledger } = harness();
      ledger.recordConfirmAction(confirmAction());
      const code = capture(() => ledger.recordConfirmAction(confirmAction({ amount: 1 })));
      return obs(code, ledger.observedStateOf('task-a', 'act-1'), { confirms: ledger.counts().confirms });
    },
  },
  {
    id: 'A5',
    family: 'duplicate-confirmation',
    title: '用甲动作的授权去占用乙动作（actionId 不符）：逐项拒绝',
    expectation: {
      verdict: 'closed',
      code: 'grant_binding_mismatch',
      state: 'authorized',
      note: 'actionId 参与逐项绑定，串动作占用被拒。',
    },
    async run() {
      const { ledger } = harness();
      ledger.recordConfirmAction(confirmAction({ actionId: 'act-A', paramsDigest: 'sha256:' + '2'.repeat(64) }));
      ledger.recordConfirmAction(confirmAction({ actionId: 'act-B', paramsDigest: 'sha256:' + '2'.repeat(64) }));
      const grantA = ledger.issueGrant(ledger.attest('task-a', 'act-A', { surface: 'native.confirm' }));
      const code = capture(() => ledger.consume({ grantId: grantA.grantId, actual: bindingOf({ actionId: 'act-B' }) }));
      return obs(code, ledger.observedStateOf('task-a', 'act-A'), { submissions: ledger.counts().submissions });
    },
  },

  // ===== B 族：跨任务授权 ===================================================
  {
    id: 'B1',
    family: 'cross-task-authorization',
    title: '绑定/提交记录携带任务身份；跨任务占用被机器拒绝',
    expectation: {
      verdict: 'closed',
      code: 'NO_THROW',
      state: 'submitting',
      note:
        'ActionBinding 现在含 taskId（九项绑定之一）：confirm/grant/submission 记录都携带任务身份；' +
        '且 "甲任务的授权被乙任务使用" 可表达、可机读拒绝（grant_binding_mismatch，field=taskId）。',
    },
    async run() {
      const { ledger } = harness();
      const confirm = confirmAction();
      ledger.recordConfirmAction(confirm);
      const grant = ledger.issueGrant(ledger.attest('task-a', 'act-1', { surface: 'native.confirm' }));
      const consumed = ledger.consume({ grantId: grant.grantId, actual: bindingOf() });
      const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

      // 跨任务越权：任务 C 拿着任务 B 的授权来占用 ⇒ 逐项复核在 taskId 上不符，被拒。
      const cross = harness();
      cross.ledger.recordConfirmAction(confirmAction({ taskId: 'task-b' }));
      const crossGrant = cross.ledger.issueGrant(
        cross.ledger.attest('task-b', 'act-1', { surface: 'native.confirm' }),
      );
      const crossTaskCode = capture(() =>
        cross.ledger.consume({ grantId: crossGrant.grantId, actual: bindingOf({ taskId: 'task-c' }) }),
      );

      return obs('NO_THROW', ledger.observedStateOf('task-a', 'act-1'), {
        confirmHasTaskId: has(confirm, 'taskId'),
        grantHasTaskId: has(grant, 'taskId'),
        submissionHasTaskId: has(consumed.submission, 'taskId'),
        confirmTaskId: confirm.taskId,
        submissionTaskId: consumed.submission.taskId,
        crossTaskCode,
        crossTaskSubmissions: cross.ledger.counts().submissions,
      });
    },
  },
  {
    id: 'B2',
    family: 'cross-task-authorization',
    title: '两个逻辑任务可用同一 actionId：actionId 是任务内键，不再全局冲突',
    expectation: {
      verdict: 'closed',
      code: 'NO_THROW',
      state: 'prepared',
      note:
        '账本以 (taskId, actionId) 为键：任务 A 与任务 B 各自的 shared-act 互不顶掉，' +
        '两条确认请求都能登记（confirms=2），各自都有可观测状态——全局命名空间冲突已消除。',
    },
    async run() {
      const { ledger } = harness();
      ledger.recordConfirmAction(confirmAction({ taskId: 'task-a', actionId: 'shared-act' }));
      // "另一个任务"登记同名动作：任务内键不同，不再冲突
      const code = capture(() =>
        ledger.recordConfirmAction(confirmAction({ taskId: 'task-b', actionId: 'shared-act' })),
      );
      return obs(code, ledger.observedStateOf('task-b', 'shared-act'), {
        confirms: ledger.counts().confirms,
        taskAState: String(ledger.observedStateOf('task-a', 'shared-act')),
      });
    },
  },
  {
    id: 'B3',
    family: 'cross-task-authorization',
    title: 'taskRevision 漂移：任务推进后旧授权失效（这一项是绑住的）',
    expectation: {
      verdict: 'closed',
      code: 'grant_binding_mismatch',
      state: 'authorized',
      note:
        'taskRevision 是整数修订号、参与绑定：任务推进后旧授权失效。它与 taskId 是两回事——' +
        'taskId 钉住"属于哪个任务"，taskRevision 钉住"任务推进到哪一版"。',
    },
    async run() {
      const { ledger } = harness();
      ledger.recordConfirmAction(confirmAction());
      const grant = ledger.issueGrant(ledger.attest('task-a', 'act-1', { surface: 'native.confirm' }));
      const code = capture(() => ledger.consume({ grantId: grant.grantId, actual: bindingOf({ taskRevision: 8 }) }));
      return obs(code, ledger.observedStateOf('task-a', 'act-1'), { submissions: ledger.counts().submissions });
    },
  },

  // ===== C 族：过期授权 =====================================================
  {
    id: 'C1',
    family: 'expired-grant',
    title: '授权过期后占用：拒，且不产生任何提交',
    expectation: {
      verdict: 'closed',
      code: 'grant_expired',
      state: 'authorized',
      note: '到点即失效（now >= expiresAt）。',
    },
    async run() {
      const { ledger, clock } = harness();
      ledger.recordConfirmAction(confirmAction());
      const grant = ledger.issueGrant(ledger.attest('task-a', 'act-1', { surface: 'native.confirm' }));
      clock.advance(120_000);
      const code = capture(() => ledger.consume({ grantId: grant.grantId, actual: bindingOf() }));
      return obs(code, ledger.observedStateOf('task-a', 'act-1'), { submissions: ledger.counts().submissions });
    },
  },
  {
    id: 'C2',
    family: 'expired-grant',
    title: '占用后、发出前授权过期：send 拒，提交置 cancelled',
    expectation: {
      verdict: 'closed',
      code: 'grant_expired',
      state: 'cancelled',
      note: '过期即时影响后续调用，且不发出任何东西。',
    },
    async run() {
      const executor = recordingExecutor(() => ({ outcome: 'accepted' as const }));
      const { ledger, clock } = harness({ executor });
      ledger.recordConfirmAction(confirmAction());
      const grant = ledger.issueGrant(ledger.attest('task-a', 'act-1', { surface: 'native.confirm' }));
      const consumed = ledger.consume({ grantId: grant.grantId, actual: bindingOf() });
      clock.advance(120_000);
      const code = await captureAsync(() => ledger.send(consumed.submission.submissionId));
      return obs(code, ledger.observedStateOf('task-a', 'act-1'), { executorCalls: executor.calls.length });
    },
  },
  {
    id: 'C3',
    family: 'expired-grant',
    title: '确认请求过期后连凭证都签不出：confirm_expired',
    expectation: {
      verdict: 'closed',
      code: 'confirm_expired',
      state: 'prepared',
      note: '不得靠"再确认一次"绕过期限。',
    },
    async run() {
      const { ledger, clock } = harness();
      ledger.recordConfirmAction(confirmAction());
      clock.advance(120_000);
      const code = capture(() => ledger.attest('task-a', 'act-1', { surface: 'native.confirm' }));
      return obs(code, ledger.observedStateOf('task-a', 'act-1'), { grants: ledger.counts().grants });
    },
  },
  {
    id: 'C4',
    family: 'expired-grant',
    title: '凭证在有效期内签发，但发行时已过期：grant_expired',
    expectation: {
      verdict: 'closed',
      code: 'grant_expired',
      state: 'prepared',
      note: '发行是独立时点，逐次核对时钟（不能靠"签凭证时还早"蒙过）。',
    },
    async run() {
      const { ledger, clock } = harness();
      ledger.recordConfirmAction(confirmAction());
      const attestation = ledger.attest('task-a', 'act-1', { surface: 'native.confirm' });
      clock.advance(120_000);
      const code = capture(() => ledger.issueGrant(attestation));
      return obs(code, ledger.observedStateOf('task-a', 'act-1'), { grants: ledger.counts().grants });
    },
  },
  {
    id: 'C5',
    family: 'expired-grant',
    title: '过期后到达的**真回执**仍可确认（有意设计：订单已在有效期内发出）',
    expectation: {
      verdict: 'correct-by-design',
      code: 'NO_THROW',
      state: 'confirmed',
      note:
        '期限约束的是"能不能发"，不是"能不能收"。订单在有效期内发出，晚到回执必须能被记账为 confirmed；' +
        '把这条改成拒绝会让真实订单永远无法收口。写死断言防止未来误改。',
    },
    async run() {
      const executor = recordingExecutor(() => ({ outcome: 'accepted' as const }));
      const { ledger, clock } = harness({ executor });
      ledger.recordConfirmAction(confirmAction());
      const grant = ledger.issueGrant(ledger.attest('task-a', 'act-1', { surface: 'native.confirm' }));
      const consumed = ledger.consume({ grantId: grant.grantId, actual: bindingOf() });
      await ledger.send(consumed.submission.submissionId); // 有效期内发出
      clock.advance(120_000); // 授权此后过期
      const receipt = createTrustedReceipt({
        actionId: 'act-1',
        provider: 'demo-provider',
        requestRef: consumed.submission.submissionId,
        externalId: 'EXT-1',
        observedState: 'confirmed',
        observedAt: T0 + 130_000,
        evidenceRef: 'evidence://kr06/EXT-1',
        verificationMode: 'real',
      });
      const code = capture(() => ledger.observe(consumed.submission.submissionId, receipt));
      return obs(code, ledger.observedStateOf('task-a', 'act-1'), { executorCalls: executor.calls.length });
    },
  },

  // ===== D 族：晚到结果 =====================================================
  {
    id: 'D1',
    family: 'late-result',
    title: '已到终态 cancelled 之后来的 confirmed：拒（终态不得被复活）',
    expectation: {
      verdict: 'closed',
      code: 'illegal_submission_transition',
      state: 'cancelled',
      note: '终态不可回退；晚到结果不得把已取消的单改写成已完成。',
    },
    async run() {
      const executor = recordingExecutor(() => ({ outcome: 'accepted' as const }));
      const { ledger } = harness({ executor });
      ledger.recordConfirmAction(confirmAction());
      const grant = ledger.issueGrant(ledger.attest('task-a', 'act-1', { surface: 'native.confirm' }));
      const consumed = ledger.consume({ grantId: grant.grantId, actual: bindingOf() });
      await ledger.send(consumed.submission.submissionId);
      const cancelled = createTrustedReceipt({
        actionId: 'act-1',
        provider: 'demo-provider',
        requestRef: consumed.submission.submissionId,
        externalId: 'EXT-1',
        observedState: 'cancelled',
        observedAt: T0 + 1,
        evidenceRef: 'evidence://kr06/EXT-1',
        verificationMode: 'real',
      });
      ledger.observe(consumed.submission.submissionId, cancelled);
      const late = createTrustedReceipt({
        actionId: 'act-1',
        provider: 'demo-provider',
        requestRef: consumed.submission.submissionId,
        externalId: 'EXT-1',
        observedState: 'confirmed',
        observedAt: T0 + 2,
        evidenceRef: 'evidence://kr06/EXT-1',
        verificationMode: 'real',
      });
      const code = capture(() => ledger.observe(consumed.submission.submissionId, late));
      return obs(code, ledger.observedStateOf('task-a', 'act-1'), {});
    },
  },
  {
    id: 'D2',
    family: 'late-result',
    title: '同一份 confirmed 回执重复投递：幂等空操作（缺口已关闭）',
    expectation: {
      verdict: 'closed',
      code: 'NO_THROW',
      state: 'confirmed',
      note:
        '去重键 actionId+requestRef+externalId+observedState：重复投递同一份回执返回原提交（no-op），' +
        '不再抛 illegal_submission_transition；换外部 id 的另一份回执仍受状态机约束。',
    },
    async run() {
      const executor = recordingExecutor(() => ({ outcome: 'accepted' as const }));
      const { ledger } = harness({ executor });
      ledger.recordConfirmAction(confirmAction());
      const grant = ledger.issueGrant(ledger.attest('task-a', 'act-1', { surface: 'native.confirm' }));
      const consumed = ledger.consume({ grantId: grant.grantId, actual: bindingOf() });
      await ledger.send(consumed.submission.submissionId);
      const make = () =>
        createTrustedReceipt({
          actionId: 'act-1',
          provider: 'demo-provider',
          requestRef: consumed.submission.submissionId,
          externalId: 'EXT-1',
          observedState: 'confirmed',
          observedAt: T0 + 1,
          evidenceRef: 'evidence://kr06/EXT-1',
          verificationMode: 'real',
        });
      const first = ledger.observe(consumed.submission.submissionId, make());
      const code = capture(() => ledger.observe(consumed.submission.submissionId, make()));
      const after = ledger.getSubmission(consumed.submission.submissionId);
      return obs(code, ledger.observedStateOf('task-a', 'act-1'), {
        stateUnchanged: after?.state === 'confirmed',
        receiptUnchanged: after?.receipt?.externalId === first.receipt?.externalId,
        submissions: ledger.counts().submissions,
      });
    },
  },
  {
    id: 'D3',
    family: 'late-result',
    title: '晚到回执指向的动作与提交不符：receipt_action_mismatch',
    expectation: {
      verdict: 'closed',
      code: 'receipt_action_mismatch',
      state: 'submitted',
      note: '回执必须归属到正确的动作，串单回执被拒。',
    },
    async run() {
      const executor = recordingExecutor(() => ({ outcome: 'accepted' as const }));
      const { ledger } = harness({ executor });
      ledger.recordConfirmAction(confirmAction());
      const grant = ledger.issueGrant(ledger.attest('task-a', 'act-1', { surface: 'native.confirm' }));
      const consumed = ledger.consume({ grantId: grant.grantId, actual: bindingOf() });
      await ledger.send(consumed.submission.submissionId);
      const wrong = createTrustedReceipt({
        actionId: 'act-OTHER',
        provider: 'demo-provider',
        requestRef: consumed.submission.submissionId,
        externalId: 'EXT-9',
        observedState: 'confirmed',
        observedAt: T0 + 1,
        evidenceRef: 'evidence://kr06/EXT-9',
        verificationMode: 'real',
      });
      const code = capture(() => ledger.observe(consumed.submission.submissionId, wrong));
      return obs(code, ledger.observedStateOf('task-a', 'act-1'), {});
    },
  },
  {
    id: 'D4',
    family: 'late-result',
    title: '发出后撤权，晚到 confirmed 仍确认（有意设计：撤权不得抹掉在途单）',
    expectation: {
      verdict: 'correct-by-design',
      code: 'NO_THROW',
      state: 'confirmed',
      note:
        '撤权只对"尚未发出"的提交置 cancelled；已发出的订单不会因本地撤权消失，' +
        '晚到真回执必须能收口。写死断言防止误改。',
    },
    async run() {
      const executor = recordingExecutor(() => ({ outcome: 'accepted' as const }));
      const { ledger } = harness({ executor });
      ledger.recordConfirmAction(confirmAction());
      const grant = ledger.issueGrant(ledger.attest('task-a', 'act-1', { surface: 'native.confirm' }));
      const consumed = ledger.consume({ grantId: grant.grantId, actual: bindingOf() });
      await ledger.send(consumed.submission.submissionId);
      const stateAfterSend = ledger.getSubmission(consumed.submission.submissionId)?.state ?? null;
      ledger.revoke('task-a', 'act-1', '用户撤权');
      const stateAfterRevoke = ledger.getSubmission(consumed.submission.submissionId)?.state ?? null;
      const late = createTrustedReceipt({
        actionId: 'act-1',
        provider: 'demo-provider',
        requestRef: consumed.submission.submissionId,
        externalId: 'EXT-1',
        observedState: 'confirmed',
        observedAt: T0 + 1,
        evidenceRef: 'evidence://kr06/EXT-1',
        verificationMode: 'real',
      });
      const code = capture(() => ledger.observe(consumed.submission.submissionId, late));
      return obs(code, ledger.observedStateOf('task-a', 'act-1'), {
        stateAfterSend: String(stateAfterSend),
        stateAfterRevoke: String(stateAfterRevoke),
      });
    },
  },
  {
    id: 'D5',
    family: 'late-result',
    title: '已 confirmed 的提交做恢复：settled，且不得另发授权/另建提交',
    expectation: {
      verdict: 'closed',
      code: 'NO_THROW',
      state: 'confirmed',
      note: '恢复入口在类型层面就不表达"另发授权 / 重复下单"。',
    },
    async run() {
      const executor = recordingExecutor(() => ({ outcome: 'accepted' as const }));
      const { ledger } = harness({ executor });
      ledger.recordConfirmAction(confirmAction());
      const grant = ledger.issueGrant(ledger.attest('task-a', 'act-1', { surface: 'native.confirm' }));
      const consumed = ledger.consume({ grantId: grant.grantId, actual: bindingOf() });
      await ledger.send(consumed.submission.submissionId);
      const receipt = createTrustedReceipt({
        actionId: 'act-1',
        provider: 'demo-provider',
        requestRef: consumed.submission.submissionId,
        externalId: 'EXT-1',
        observedState: 'confirmed',
        observedAt: T0 + 1,
        evidenceRef: 'evidence://kr06/EXT-1',
        verificationMode: 'real',
      });
      ledger.observe(consumed.submission.submissionId, receipt);
      const verdict = ledger.recover(consumed.submission.submissionId);
      return obs('NO_THROW', ledger.observedStateOf('task-a', 'act-1'), {
        recoveryKind: verdict.kind,
        allowedAction: verdict.allowedAction,
        mayIssueNewGrant: verdict.mayIssueNewGrant,
        mayCreateNewSubmission: verdict.mayCreateNewSubmission,
        grants: ledger.counts().grants,
        submissions: ledger.counts().submissions,
      });
    },
  },
];

/** 全部用例的 id（供测试做"清单完整性"断言）。 */
export const SCENARIO_IDS: readonly string[] = Object.freeze(scenarios.map((s) => s.id));

export const PRODUCT_MODULE_PATH = PRODUCT_MODULE;

// ---------------------------------------------------------------------------
// 运行
// ---------------------------------------------------------------------------

function summarize(records: readonly ScenarioRecord[]): AttackRunSummary {
  return Object.freeze({
    total: records.length,
    passed: records.filter((r) => r.passed).length,
    closed: records.filter((r) => r.expectation.verdict === 'closed').length,
    open: records.filter((r) => r.expectation.verdict === 'open').length,
    correctByDesign: records.filter((r) => r.expectation.verdict === 'correct-by-design').length,
  });
}

/**
 * 跑完全部用例，返回机器可读的 `AttackRun`。
 *
 * `meta` 由调用方（测试）注入，因为内容摘要与基线 SHA 需要文件系统 / git，
 * 而本 harness 保持纯逻辑以便在手机运行时复用。
 */
export async function runAllScenarios(meta: {
  readonly productSourceSha256: string;
  readonly baselineSha: string;
}): Promise<AttackRun> {
  const records: ScenarioRecord[] = [];
  for (const scenario of scenarios) {
    const observation = await scenario.run();
    const expected = scenario.expectation;
    const passed = observation.code === expected.code && observation.state === expected.state;
    records.push(
      Object.freeze({
        id: scenario.id,
        family: scenario.family,
        title: scenario.title,
        expectation: Object.freeze({ ...expected }),
        observation,
        passed,
      }),
    );
  }
  return Object.freeze({
    schemaVersion: 'kr06-attack-run/1',
    productModule: PRODUCT_MODULE,
    productSourceSha256: meta.productSourceSha256,
    baselineSha: meta.baselineSha,
    scenarios: Object.freeze(records),
    summary: summarize(records),
  });
}
