/**
 * K-I15 —— 车道契约一致性闸门的 **wire fixture 发射器**。
 *
 * ## 这个单元在做什么
 *
 * 把手机内核线（lane K）各包**真实运行**产出的对外对象，按冻结契约
 * `contracts/mobile-v1` 的信封格式（`{ $schemaRef, note, value }`）写成 fixture，
 * 再交给**冻结的** CLI `contracts/mobile-v1/validate.mjs` 校验（正例 exit 0 /
 * 负例 exit 1）。它把车道的证据从「各包自己的单元断言」抬到「同一份冻结 schema」。
 *
 * ## 逐包的产出来源（都是 import 真实模块，不是手抄）
 *
 * | K 包 | 发射对象 | 用到的真实函数 |
 * | --- | --- | --- |
 * | bootstrap (K01) | command 三条分支 + 一条真实运行事件 | `validateCommand` + `createBootstrapRuntime` |
 * | dispatch (K05) | plan/cancel/status 的**契约投影** command | `validateDispatchCommand` + `CONTRACT_OPERATION_HINT` |
 * | actions/wire-codec (K07) | confirm-action + external-receipt | `toWireConfirmAction` / `toWireExternalReceipt` |
 * | security (K03) | 5 个密钥子操作的 payload | `assertSecurityCommand` + `SECURITY_TO_COMMAND_OPERATION` |
 *
 * ## 两处**已知的契约落差**（本闸门如实投影，不掩盖；详见 README）
 *
 * 1. **dispatch 的内部命令面不是契约命令面**：K05 的 `plan` payload 用
 *    `split` / `max_parallel`，`cancel` 用 `reason`——这些键在
 *    `command.schema.json` 的 payload（`additionalProperties:false`）里都不存在。
 *    因此本发射器按 K05 自己声明的 `CONTRACT_OPERATION_HINT` 取 operation
 *    （plan→create / cancel→cancel / status→query），payload 只保留契约允许的键。
 *    `split`/`max_parallel`/`reason` 无处安放 = 集成残差，登记在 README。
 * 2. **K07 的 taskId 不落 wire**：领域 `ActionBinding` 有九项（含 `taskId`），但
 *    `confirm-action.schema.json` 无 `taskId` 字段且 `additionalProperties:false`。
 *    `toWireConfirmAction` 因此**不写** taskId（写了必被冻结 schema 拒）——
 *    这也是集成残差，登记在 README。
 *
 * 发射是**确定性**的：所有时间戳来自注入时钟的固定值，无随机、无墙钟。
 */

import {
  createBootstrapRuntime,
  createManualClock,
  validateCommand,
  type Command,
} from '../../../apps/mobile-kernel/bootstrap/index.js';
import {
  CONTRACT_OPERATION_HINT,
  validateDispatchCommand,
} from '../../../apps/mobile-kernel/dispatch/index.js';
import {
  SECURITY_TO_COMMAND_OPERATION,
  assertSecurityCommand,
} from '../../../apps/mobile-kernel/security/index.js';
import {
  toWireConfirmAction,
  toWireExternalReceipt,
  type ConfirmAction,
  type ConfirmScope,
  type ExternalReceipt,
} from '../../../apps/mobile-kernel/actions/index.js';

// ---------------------------------------------------------------------------
// 信封与 fixture 类型
// ---------------------------------------------------------------------------

/** 冻结校验器认得的信封：只校验 `value`；`$schemaRef` 相对 contract 根解析。 */
export interface WireEnvelope {
  readonly $schemaRef: string;
  readonly note: string;
  readonly value: unknown;
}

export interface WireFixture {
  /** 落盘文件名（含 `.json`）。 */
  readonly file: string;
  readonly envelope: WireEnvelope;
}

const CMD_SCHEMA = 'schemas/command.schema.json';
const EVT_SCHEMA = 'schemas/event.schema.json';
const CONFIRM_SCHEMA = 'schemas/confirm-action.schema.json';
const RECEIPT_SCHEMA = 'schemas/external-receipt.schema.json';
const SECURITY_SCHEMA = 'schemas/security-keystore.schema.json';

/** 固定注入时刻（UTC ISO-8601），让发射结果可复现。 */
const FIXED_CLOCK_ISO = '2026-10-03T00:00:00.000Z';
/** 与上面同一个时刻的领域毫秒值。 */
const FIXED_EPOCH_MS = Date.parse(FIXED_CLOCK_ISO);

function sampleDigest(fill: string): string {
  return `sha256:${fill.repeat(64).slice(0, 64)}`;
}

// ---------------------------------------------------------------------------
// bootstrap（K01）：command 三分支 + 一条真实运行事件
// ---------------------------------------------------------------------------

/** create 分支命令（契约 `$defs.createBranch`）。 */
export function bootstrapCreateCommand(): Command {
  return {
    schemaVersion: 'mobile-v1',
    commandId: 'cmd-k01-create',
    operation: 'create',
    idempotencyKey: 'idem-k01-create',
    payload: { goal: '把这份周报改成一页', templateId: 'word-doc' },
  };
}

/** mutate 分支命令（契约 `$defs.mutationBranch`：必须有 expectedRevision + 目标）。 */
export function bootstrapMutateCommand(): Command {
  return {
    schemaVersion: 'mobile-v1',
    commandId: 'cmd-k01-mutate',
    operation: 'mutate',
    idempotencyKey: 'idem-k01-mutate',
    payload: { conversationId: 'conv-k01', expectedRevision: 0, patch: { title: '一页周报' } },
  };
}

/** query 分支命令（cancel 属 `$defs.queryBranch`）。 */
export function bootstrapCancelCommand(): Command {
  return {
    schemaVersion: 'mobile-v1',
    commandId: 'cmd-k01-cancel',
    operation: 'cancel',
    idempotencyKey: 'idem-k01-cancel',
    payload: { conversationId: 'conv-k01' },
  };
}

/**
 * 用真实的 bootstrap 运行时跑一条 create 命令，取回**运行时自己签发**的事件。
 * 如果事件形状不合法，那是 K01 的缺陷——本闸门会由冻结 CLI 判红。
 */
async function bootstrapRuntimeEvent(): Promise<unknown> {
  const runtime = createBootstrapRuntime({
    clock: createManualClock(FIXED_CLOCK_ISO),
    verificationMode: 'fixture',
  });
  runtime.registerModule({
    id: 'module.k-i15-probe',
    operations: ['create'],
    handle: () => ({ status: 'succeeded', resultRef: 'artifact:conv-k01@1' }),
  });
  runtime.start();
  try {
    return await runtime.dispatch(bootstrapCreateCommand());
  } finally {
    runtime.stop();
  }
}

// ---------------------------------------------------------------------------
// dispatch（K05）：内部命令 → 契约 operation 的投影
// ---------------------------------------------------------------------------

/** K05 内部派发命令的形状（snake_case，非契约命令面）。 */
interface DispatchCommandLike {
  readonly schemaVersion: string;
  readonly commandId: string;
  readonly operation: 'plan' | 'cancel' | 'status';
  readonly idempotencyKey: string;
  readonly payload: Record<string, unknown>;
}

/** 三条契约投影都覆盖得到的派发命令样例。 */
export function dispatchSamples(): readonly DispatchCommandLike[] {
  return [
    {
      schemaVersion: 'mobile-v1',
      commandId: 'cmd-k05-plan',
      operation: 'plan',
      idempotencyKey: 'idem-k05-plan',
      payload: {
        goal: '完成一份周报',
        split: { goal: '完成一份周报', subtasks: [{ id: 's1', goal: '收集素材' }] },
        max_parallel: 2,
      },
    },
    {
      schemaVersion: 'mobile-v1',
      commandId: 'cmd-k05-cancel',
      operation: 'cancel',
      idempotencyKey: 'idem-k05-cancel',
      payload: { task_id: 'task-k05', reason: '用户撤销' },
    },
    {
      schemaVersion: 'mobile-v1',
      commandId: 'cmd-k05-status',
      operation: 'status',
      idempotencyKey: 'idem-k05-status',
      payload: { task_id: 'task-k05' },
    },
  ];
}

/**
 * 取 dispatch 命令的**契约投影**：operation 用 K05 自己声明的映射，
 * payload 只保留 `command.schema.json` 允许的键。
 *
 * `plan` 是 create 分支，payload 只有目标 `goal`；
 * `cancel`/`status` 是 query 分支，payload 只有目标 `taskId`（由内部 `task_id` 改名）。
 */
export function projectDispatchToContract(sample: DispatchCommandLike): Command {
  const validation = validateDispatchCommand(sample);
  if (!validation.ok) {
    throw new Error(
      `K05 派发命令样例本身非法：${validation.issues.map((i) => `${i.path}:${i.code}`).join(', ')}`,
    );
  }
  const mapped = CONTRACT_OPERATION_HINT[sample.operation];
  if (mapped === null) {
    throw new Error(`operation ${sample.operation} 是内核内部步骤，不对外暴露，不能投影为契约命令`);
  }
  const goal = sample.payload['goal'];
  const taskId = sample.payload['task_id'];
  const payload: { goal?: string; taskId?: string } = {};
  if (typeof goal === 'string') payload.goal = goal;
  if (typeof taskId === 'string') payload.taskId = taskId;

  const projected: Command = {
    schemaVersion: 'mobile-v1',
    commandId: sample.commandId,
    operation: mapped as Command['operation'],
    idempotencyKey: sample.idempotencyKey,
    payload,
  };
  // 交叉核对：投影结果必须同时过 bootstrap 的命令形状校验（两包对同一契约的两个实现）。
  const cross = validateCommand(projected);
  if (!cross.ok) {
    throw new Error(
      `投影命令未过 bootstrap 校验：${cross.issues.map((i) => `${i.path}:${i.code}`).join(', ')}`,
    );
  }
  return projected;
}

// ---------------------------------------------------------------------------
// actions / wire-codec（K07）：confirm-action 与 external-receipt
// ---------------------------------------------------------------------------

function domainConfirmAction(): ConfirmAction {
  return {
    taskId: 'task-k07',
    actionId: 'act-k07-1',
    accountRef: 'acct:meituan:7788',
    taskRevision: 7,
    paramsDigest: sampleDigest('1'),
    quoteRef: 'quote:mt-001',
    amount: 3980,
    currency: 'CNY',
    scope: 'purchase' as ConfirmScope,
    expiresAt: FIXED_EPOCH_MS,
  };
}

function domainConfirmedReceipt(): ExternalReceipt {
  return {
    actionId: 'act-k07-1',
    provider: 'meituan',
    requestRef: 'sub:act-k07-1',
    externalId: 'MT-2026-0001',
    observedState: 'confirmed',
    observedAt: FIXED_EPOCH_MS + 5000,
    evidenceRef: 'evidence://meituan/MT-2026-0001',
    verificationMode: 'real',
    detail: '商家已接单',
  };
}

function domainFixtureReceipt(): ExternalReceipt {
  return {
    actionId: 'act-k07-2',
    provider: 'meituan',
    requestRef: 'sub:act-k07-2',
    externalId: 'MT-2026-0002',
    observedState: 'unknown',
    observedAt: FIXED_EPOCH_MS + 9000,
    evidenceRef: 'evidence://meituan/MT-2026-0002',
    verificationMode: 'fixture',
    detail: '',
  };
}

// ---------------------------------------------------------------------------
// security（K03）：5 个密钥子操作的 payload
// ---------------------------------------------------------------------------

interface SecurityCommandLike {
  readonly schemaVersion: string;
  readonly commandId: string;
  readonly operation: string;
  readonly idempotencyKey: string;
  readonly payload: Record<string, unknown>;
}

/** 每个安全子操作一条样例命令（kind/keyRef/sourceRef 都是引用，绝无明文）。 */
export function securitySamples(): readonly SecurityCommandLike[] {
  return [
    {
      schemaVersion: 'mobile-v1',
      commandId: 'cmd-k03-import',
      operation: 'import',
      idempotencyKey: 'idem-k03-import',
      payload: {
        operation: 'key.import',
        kind: 'model',
        keyRef: 'keyref:model.deepseek-flash',
        sourceRef: 'oneshot:desktop-import-1',
      },
    },
    {
      schemaVersion: 'mobile-v1',
      commandId: 'cmd-k03-rotate',
      operation: 'mutate',
      idempotencyKey: 'idem-k03-rotate',
      payload: {
        operation: 'key.rotate',
        kind: 'meituan',
        expectedRevision: 3,
        sourceRef: 'oneshot:desktop-rotate-1',
      },
    },
    {
      schemaVersion: 'mobile-v1',
      commandId: 'cmd-k03-delete',
      operation: 'mutate',
      idempotencyKey: 'idem-k03-delete',
      payload: { operation: 'key.delete', kind: 'meituan', expectedRevision: 4 },
    },
    {
      schemaVersion: 'mobile-v1',
      commandId: 'cmd-k03-status',
      operation: 'inspect',
      idempotencyKey: 'idem-k03-status',
      payload: { operation: 'key.status', kind: 'model' },
    },
    {
      schemaVersion: 'mobile-v1',
      commandId: 'cmd-k03-recover',
      operation: 'inspect',
      idempotencyKey: 'idem-k03-recover',
      payload: { operation: 'key.recover' },
    },
  ];
}

/** 校验一条安全命令并返回其 payload（供契约的 security-keystore schema 校验）。 */
export function securityPayloadOf(sample: SecurityCommandLike): Record<string, unknown> {
  const subOp = assertSecurityCommand(sample);
  const expected = SECURITY_TO_COMMAND_OPERATION[subOp];
  if (sample.operation !== expected) {
    throw new Error(`安全命令 operation 与子操作映射不符：${sample.operation} ≠ ${expected}`);
  }
  return sample.payload;
}

// ---------------------------------------------------------------------------
// 正例 fixture 集合
// ---------------------------------------------------------------------------

/** 逐包发射正例 fixture；顺序稳定，便于断言与 diff。 */
export async function buildPositiveFixtures(): Promise<WireFixture[]> {
  const fixtures: WireFixture[] = [];

  // --- K01 bootstrap：command 三分支 ---
  fixtures.push({
    file: 'bootstrap-command-create.json',
    envelope: {
      $schemaRef: CMD_SCHEMA,
      note: 'K01 bootstrap.validateCommand() 通过后的 create 命令（$defs.createBranch）。',
      value: bootstrapCreateCommand(),
    },
  });
  fixtures.push({
    file: 'bootstrap-command-mutate.json',
    envelope: {
      $schemaRef: CMD_SCHEMA,
      note: 'K01 bootstrap.validateCommand() 通过后的 mutate 命令（$defs.mutationBranch：expectedRevision + conversationId）。',
      value: bootstrapMutateCommand(),
    },
  });
  fixtures.push({
    file: 'bootstrap-command-cancel.json',
    envelope: {
      $schemaRef: CMD_SCHEMA,
      note: 'K01 bootstrap.validateCommand() 通过后的 cancel 命令（$defs.queryBranch）。',
      value: bootstrapCancelCommand(),
    },
  });
  // --- K01 bootstrap：真实运行时事件 ---
  fixtures.push({
    file: 'bootstrap-event-succeeded.json',
    envelope: {
      $schemaRef: EVT_SCHEMA,
      note: 'K01 createBootstrapRuntime().dispatch() 真实返回的 succeeded 事件（带 resultRef、verificationMode=fixture、idempotentReplay=false）。',
      value: await bootstrapRuntimeEvent(),
    },
  });

  // --- K05 dispatch：契约投影 command ---
  for (const sample of dispatchSamples()) {
    const mapped = CONTRACT_OPERATION_HINT[sample.operation];
    fixtures.push({
      file: `dispatch-command-${sample.operation}.json`,
      envelope: {
        $schemaRef: CMD_SCHEMA,
        note:
          `K05 派发命令 ${sample.operation} → 契约 operation "${String(mapped)}" 的投影` +
          `（内部 payload 键 split/max_parallel/reason 无契约字段，故只保留契约允许的子集）。`,
        value: projectDispatchToContract(sample),
      },
    });
  }

  // --- K07 actions/wire-codec：confirm-action + external-receipt ---
  fixtures.push({
    file: 'actions-confirm-action.json',
    envelope: {
      $schemaRef: CONFIRM_SCHEMA,
      note: 'K07 toWireConfirmAction() 输出：领域整数分 3980 → 十进制字符串 "39.80"，注入时钟整数 → ISO-8601。',
      value: toWireConfirmAction(domainConfirmAction()),
    },
  });
  fixtures.push({
    file: 'actions-external-receipt-real-confirmed.json',
    envelope: {
      $schemaRef: RECEIPT_SCHEMA,
      note: 'K07 toWireExternalReceipt() 输出：real 模式、observedState=confirmed，领域 detail 收进 metadata.detail。',
      value: toWireExternalReceipt(domainConfirmedReceipt()),
    },
  });
  fixtures.push({
    file: 'actions-external-receipt-fixture-unknown.json',
    envelope: {
      $schemaRef: RECEIPT_SCHEMA,
      note: 'K07 toWireExternalReceipt() 输出：fixture 模式、observedState=unknown（fixture 不得 confirmed，不变量 1）。',
      value: toWireExternalReceipt(domainFixtureReceipt()),
    },
  });

  // --- K03 security：5 个子操作的 payload ---
  for (const sample of securitySamples()) {
    const subOp = String(sample.payload['operation']);
    fixtures.push({
      file: `security-${subOp.replace('.', '-')}.json`,
      envelope: {
        $schemaRef: SECURITY_SCHEMA,
        note: `K03 assertSecurityCommand() 通过后的 ${subOp} payload（command.operation="${sample.operation}"，无任何明文字段）。`,
        value: securityPayloadOf(sample),
      },
    });
  }

  return fixtures;
}

// ---------------------------------------------------------------------------
// 负例 fixture 集合（反向对照：冻结 schema 必须拒绝）
// ---------------------------------------------------------------------------

/**
 * 反例都是**形状合理的篡改**——不是乱码，而是触碰冻结不变量/必需字段的产物。
 * 它们必须全部被冻结 CLI 判 FAIL（exit 1），以证明闸门不是橡皮图章。
 */
export function buildNegativeFixtures(): WireFixture[] {
  const validCreate = bootstrapCreateCommand();
  const validReceipt = toWireExternalReceipt(domainConfirmedReceipt());

  return [
    {
      file: 'neg-command-missing-idempotency.json',
      envelope: {
        $schemaRef: CMD_SCHEMA,
        note: '反例：删掉根必需字段 idempotencyKey。',
        value: {
          schemaVersion: validCreate.schemaVersion,
          commandId: validCreate.commandId,
          operation: validCreate.operation,
          payload: validCreate.payload,
        },
      },
    },
    {
      file: 'neg-command-wrong-version.json',
      envelope: {
        $schemaRef: CMD_SCHEMA,
        note: '反例：schemaVersion 改成 mobile-v2（const 不符）。',
        value: { ...validCreate, schemaVersion: 'mobile-v2' },
      },
    },
    {
      file: 'neg-command-unknown-payload-key.json',
      envelope: {
        $schemaRef: CMD_SCHEMA,
        note: '反例：create payload 塞入契约不允许的 split 键（additionalProperties:false）。',
        value: { ...validCreate, payload: { goal: 'x', split: {} } },
      },
    },
    {
      file: 'neg-command-mutate-no-expected-revision.json',
      envelope: {
        $schemaRef: CMD_SCHEMA,
        note: '反例：mutate 缺 expectedRevision（mutationBranch required）。',
        value: {
          schemaVersion: 'mobile-v1',
          commandId: 'cmd-neg-mutate',
          operation: 'mutate',
          idempotencyKey: 'idem-neg-mutate',
          payload: { conversationId: 'conv-1' },
        },
      },
    },
    {
      file: 'neg-event-succeeded-no-resultref.json',
      envelope: {
        $schemaRef: EVT_SCHEMA,
        note: '反例：succeeded 不带 resultRef（不变量 3 fail-closed）。',
        value: { eventId: 'evt-neg', seq: 1, commandId: 'cmd-neg', revision: 0, status: 'succeeded' },
      },
    },
    {
      file: 'neg-receipt-fixture-confirmed.json',
      envelope: {
        $schemaRef: RECEIPT_SCHEMA,
        note: '反例：fixture 模式却自称 observedState=confirmed（不变量 1）。',
        value: { ...validReceipt, verificationMode: 'fixture' },
      },
    },
    {
      file: 'neg-receipt-missing-mode.json',
      envelope: {
        $schemaRef: RECEIPT_SCHEMA,
        note: '反例：回执缺 verificationMode（oneOf 两分支都要求它存在）。',
        value: {
          actionId: validReceipt.actionId,
          provider: validReceipt.provider,
          requestRef: validReceipt.requestRef,
          externalId: validReceipt.externalId,
          observedState: validReceipt.observedState,
          observedAt: validReceipt.observedAt,
          evidenceRef: validReceipt.evidenceRef,
        },
      },
    },
    {
      file: 'neg-confirm-action-bad-amount.json',
      envelope: {
        $schemaRef: CONFIRM_SCHEMA,
        note: '反例：amount 小数位超过 4 位（"1.23456"），违反契约金额 pattern。',
        value: { ...toWireConfirmAction(domainConfirmAction()), amount: '1.23456' },
      },
    },
    {
      file: 'neg-confirm-action-bad-account.json',
      envelope: {
        $schemaRef: CONFIRM_SCHEMA,
        note: '反例：accountRef 不带 acct: 前缀（契约 pattern）。',
        value: { ...toWireConfirmAction(domainConfirmAction()), accountRef: 'meituan:7788' },
      },
    },
    {
      file: 'neg-security-import-no-sourceref.json',
      envelope: {
        $schemaRef: SECURITY_SCHEMA,
        note: '反例：key.import 缺 sourceRef（keyImport required）。',
        value: { operation: 'key.import', kind: 'model' },
      },
    },
  ];
}
