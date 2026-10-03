/**
 * FA-M **共享动作合同模型**（合同 `full-app-contract-v1.md` **R241 / R242 / R246**）。
 *
 * ## 为什么放在 clock 包、却给三个包共用
 *
 * 合同 R242 的七个状态与 R241 的工具声明，是美团 / 时钟 / 日历**同一套**语义。
 * 合同明令"八条流**不得各造一套协议**"——所以本仓只应有**一份**实现。
 * 合同正文（无代码）由总协调冻结；`src/protocol/**` 目前**没有**这个枚举
 * （已实测 `grep -rn "已交接\|ActionState" src/ --include=*.ts` 无命中），
 * 因此本批由 FA-M **实现合同已冻结的语义**，不改协议层，并在
 * `outputs/FA-M/interface-declaration.md` 建议总协调把它提升为协议层。
 *
 * 放在 clock 包的理由：CLK-08/09/10 对"动作生命周期"（版本绑定、重复点击、
 * 取消与触发竞态、`dismiss` 不等同删除）描述最细，是这套词汇的天然宿主。
 * meituan / calendar 以 `../clock/action-contract.js` 相对引用**同一份**定义，
 * **不复制字面量**。
 *
 * ## 本模块只做两件事
 *
 * 1. **七态**的标签、转换规则与"不许冒充"的硬约束（构造即校验）；
 * 2. **工具声明**（R241）的结构与校验。
 *
 * 不含任何 IO、不读墙钟、不依赖宿主——纯数据与纯函数。
 */

// ---------------------------------------------------------------------------
// 一、七态（R242）
// ---------------------------------------------------------------------------

/**
 * R242 的七个状态，**顺序即依赖顺序**（越靠后越"确定"）。
 *
 * 关键区别（本模块用类型与断言把它钉死，而不是靠注释约定）：
 * - `handed_off`（已交接）**不等于** `submitted`（已提交）：前者是我们把参数交给
 *   外部 App/页面、**由外部负责执行**（如 Intent 打开），后者是我们**已向某个接口
 *   发出写入**。R246「打开页面不等于写入」。
 * - `submitted` 也**不等于** `confirmed`（已确认完成）：只有**回读**到与意图一致的
 *   外部观测，才算确认完成（R241「可信回执」）。
 * - `user_reported`（用户报告完成）**不得**自动升级为 `confirmed`——用户口述不是回执。
 * - `unknown`（结果未知）是**如实**的结局，不是"失败"，也**不得盲目重试**（R246/R217）。
 */
export const ACTION_STATES = [
  'prepared',
  'handed_off',
  'submitted',
  'confirmed',
  'unknown',
  'user_reported',
  'failed',
] as const;

export type ActionState = (typeof ACTION_STATES)[number];

/** 中文标签，与合同 R242 逐字对齐。 */
export const ACTION_STATE_LABELS: Readonly<Record<ActionState, string>> = Object.freeze({
  prepared: '已准备',
  handed_off: '已交接',
  submitted: '已提交',
  confirmed: '已确认完成',
  unknown: '结果未知',
  user_reported: '用户报告完成',
  failed: '已失效或失败',
});

/** 是否终态（终态不再接受新的常规转换）。 */
export function isTerminal(state: ActionState): boolean {
  return state === 'confirmed' || state === 'failed';
}

// ---------------------------------------------------------------------------
// 二、回执（R241「可信回执」）
// ---------------------------------------------------------------------------

/**
 * 回执的可信级别。
 *
 * - `readback`：从**外部系统**读回与意图一致的观测（最强证据，唯一能支撑 `confirmed`）；
 * - `acknowledgement`：外部接口**受理**了请求（只能支撑 `submitted`，**不能**支撑 `confirmed`）；
 * - `none`：没有任何回执（只能停在 `handed_off` / `unknown`）。
 *
 * **`handed_off` 与 `submitted` 不得携带 `readback`**——这是"打开页面不等于写入"
 * 在类型层面的落点（R246）。
 */
export type ReceiptKind = 'readback' | 'acknowledgement' | 'none';

export interface ActionReceipt {
  readonly kind: ReceiptKind;
  /** 回执来自哪个外部系统 / 接口（可审计）。 */
  readonly source: string;
  /** 人类可读说明。 */
  readonly detail: string;
  /**
   * **回读到的具体观测**（仅 `readback` 允许非空）。
   * 必须与意图字段逐项可对：例如"闹钟 07:30 已存在""eventId 已存在且标题一致"。
   */
  readonly observed?: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// 三、转换规则
// ---------------------------------------------------------------------------

/** 合法转换表。未列出的边一律非法。 */
const ALLOWED_TRANSITIONS: Readonly<Record<ActionState, readonly ActionState[]>> = Object.freeze({
  // 已准备：参数已绑定版本，但尚未对外发出任何东西。
  prepared: ['handed_off', 'submitted', 'failed'],
  // 已交接：参数已交给外部 App/页面；我们**没有**写入能力，只能等外部结果。
  handed_off: ['submitted', 'unknown', 'user_reported', 'confirmed', 'failed'],
  // 已提交：接口已受理；等回读或超时。
  submitted: ['confirmed', 'unknown', 'user_reported', 'failed'],
  // 已确认完成：终态。**只能**因"外部后来把它废掉"（expired）而失效。
  confirmed: ['failed'],
  // 结果未知：可由后续回读收敛为 confirmed，或由用户报告，或判失败。
  unknown: ['confirmed', 'user_reported', 'failed'],
  // 用户报告完成：用户口述；可被后续回读**证实**为 confirmed，但不会自动升级。
  user_reported: ['confirmed', 'failed'],
  // 已失效或失败：终态。
  failed: [],
});

/** 离开 `confirmed` 的唯一理由（R242 的"已失效"分支）。 */
export type FailureKind = 'expired' | 'rejected' | 'error' | 'cancelled';

export interface TransitionContext {
  /** 目标为 `confirmed` 时**必须**提供的回执。 */
  readonly receipt?: ActionReceipt;
  /** 目标为 `failed` 时的失败类别。 */
  readonly failureKind?: FailureKind;
}

export interface TransitionResult {
  readonly from: ActionState;
  readonly to: ActionState;
  readonly receipt: ActionReceipt;
}

/**
 * 校验一次状态转换；不合法即**抛出**（构造即校验，不静默接受）。
 *
 * 硬约束（均有对应用例）：
 * 1. 边必须在 `ALLOWED_TRANSITIONS` 里；
 * 2. `to === 'confirmed'` ⇒ 回执 `kind` 必须是 `readback` 且 `observed` 非空；
 * 3. 任何**非 `confirmed`** 目标都**不得**携带 `readback` 回执（防止"打开页面当写入"）；
 * 4. `from === 'confirmed'` 而 `to === 'failed'` ⇒ `failureKind` 必须是 `expired`
 *    （已确认完成的事实只能被"外部后来废止"，不能被重写成"当初就失败了"）；
 * 5. `prepared` 不得直接进 `unknown`（还没对外发出动作，谈不上"结果未知"）。
 */
export function assertTransition(
  from: ActionState,
  to: ActionState,
  context: TransitionContext = {},
): TransitionResult {
  const allowed = ALLOWED_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new Error(
      `非法动作状态转换：${label(from)} → ${label(to)}（允许：${allowed.map(label).join(' / ') || '无'}）`,
    );
  }

  const receipt = context.receipt ?? { kind: 'none', source: '(none)', detail: '未提供回执' };

  if (to === 'confirmed') {
    if (receipt.kind !== 'readback') {
      throw new Error(
        `不得把 ${label(from)} 标为「已确认完成」：回执必须是外部**回读**（readback），` +
          `收到的是 ${receipt.kind}。用户口述或接口受理都不构成完成证据（R241/R242）。`,
      );
    }
    if (receipt.observed === undefined || Object.keys(receipt.observed).length === 0) {
      throw new Error('「已确认完成」必须给出**回读到的具体观测**（observed 不得为空）。');
    }
  } else if (receipt.kind === 'readback') {
    throw new Error(
      `目标状态是「${label(to)}」，却携带 readback 回执：` +
        `打开页面 / 接口受理都不等于写入完成（R246）。回读只用于 confirmed。`,
    );
  }

  if (from === 'confirmed' && to === 'failed' && context.failureKind !== 'expired') {
    throw new Error(
      '已确认完成的动作只能因外部废止（failureKind=expired）而失效；' +
        '不得改写成"当初就失败/被拒/被取消"（R242 保留已发生事实）。',
    );
  }

  return { from, to, receipt };
}

/** 供展示层使用的 `from → to（标签）` 描述。 */
export function label(state: ActionState): string {
  return ACTION_STATE_LABELS[state];
}

/**
 * 用户报告完成**不得**被静默当成系统确认（R242）。
 * 展示层若要显示"完成"，必须同时显示证据级别。
 */
export function describeEvidence(state: ActionState, receipt: ActionReceipt): string {
  switch (state) {
    case 'confirmed':
      return `已确认完成（外部回读：${receipt.source}）`;
    case 'submitted':
      return `已提交，尚未回读（受理来源：${receipt.source}）`;
    case 'handed_off':
      return `已交接给外部页面，未读回结果（目标：${receipt.source}）`;
    case 'user_reported':
      return '用户报告完成（**无系统回执**，不得当作系统确认）';
    case 'unknown':
      return '结果未知（外部系统未给出可读回执；按 R246 不盲目重试）';
    case 'prepared':
      return '已准备，尚未对外发出';
    case 'failed':
      return '已失效或失败';
  }
}

// ---------------------------------------------------------------------------
// 四、工具声明（R241）
// ---------------------------------------------------------------------------

export type JsonType = 'string' | 'number' | 'boolean' | 'object' | 'array';

export interface SchemaField {
  readonly type: JsonType;
  readonly required: boolean;
  readonly description: string;
  /** 取值受限于固定集合时列出（如 system action 名）。 */
  readonly enumValues?: readonly string[];
}

/** 极简 schema（够表达 R241 的"输入输出 schema"，不引入 JSON-Schema 依赖）。 */
export interface ToolSchema {
  readonly fields: Readonly<Record<string, SchemaField>>;
}

/** 外部副作用的强度。**`handoff` 与 `write` 必须分开**（R246）。 */
export type SideEffect =
  /** 只读，不改外部状态。 */
  | 'none'
  /** 只读外部数据。 */
  | 'read'
  /** 打开外部页面 / 交接参数，由外部负责执行；我们无法写回。 */
  | 'handoff'
  /** 我们向外部接口发出了写入。 */
  | 'write'
  /** 写入**不可撤销**（如支付）。合同 R246：美团**不得**出现此值。 */
  | 'irreversible';

/** 幂等能力。 */
export type Idempotency = 'idempotent' | 'keyed' | 'not_idempotent';
/** 撤销能力。 */
export type UndoCapability = 'none' | 'compensating' | 'not_applicable';

/**
 * R241 的工具/动作声明。**每一项都必须显式给出**——
 * 缺字段是类型错误，不是运行时默认。
 */
export interface ToolContract {
  /** 稳定工具 ID（与 `src/plugins/catalog.ts` 的 capability_id 对齐，不另造命名）。 */
  readonly toolId: string;
  /** 归属模板 `plugin_id`（`template.meituan` / `template.clock` / `template.calendar`）。 */
  readonly template: string;
  readonly summary: string;
  readonly inputSchema: ToolSchema;
  readonly outputSchema: ToolSchema;
  readonly permissions: readonly { readonly permissionId: string; readonly required: boolean }[];
  readonly externalSideEffect: SideEffect;
  readonly requiresConfirmation: boolean;
  readonly idempotency: Idempotency;
  /** 是否支持**查询回读**（决定能否到达 `confirmed`）。 */
  readonly queryable: boolean;
  readonly undo: UndoCapability;
  /** 可信回执的来源说明（R241 末项）。 */
  readonly trustedReceipt: string;
}

/** 校验一份工具声明是否自洽；返回问题清单（空 = 通过）。 */
export function validateToolContract(contract: ToolContract): readonly string[] {
  const problems: string[] = [];

  if (!contract.toolId.trim()) problems.push('toolId 不得为空');
  if (!contract.template.startsWith('template.')) {
    problems.push(`template 必须是 plugin_id（template.*），收到 ${contract.template}`);
  }

  // R246：美团不得直接购买/支付 ⇒ 任何模板都不该出现 irreversible。
  if (contract.externalSideEffect === 'irreversible') {
    problems.push('externalSideEffect=irreversible：合同 R246 禁止直接购买/支付，本批不接受不可撤销写入');
  }

  // handoff 型动作**没有**回读能力 ⇒ 不得声明 queryable（否则会诱导把交接当写入）。
  if (contract.externalSideEffect === 'handoff' && contract.queryable) {
    problems.push('handoff 型动作不得声明 queryable=true：打开页面不等于可回读（R246）');
  }

  // 需要回读才能确认的动作，若不可查询，则永远到不了 confirmed——必须明说回执只到"已交接/已提交"。
  if (!contract.queryable && contract.externalSideEffect === 'write' && !contract.requiresConfirmation) {
    problems.push('可写但不可回读、且无需确认：无法产生可信回执，应至少要求一次用户确认');
  }

  // 硬权限必须至少声明一次。
  if (contract.permissions.length === 0) {
    problems.push('未声明任何权限：外部动作必须显式给出权限来源（R244）');
  }

  const requiredInputs = Object.values(contract.inputSchema.fields).filter((f) => f.required).length;
  if (requiredInputs === 0) {
    problems.push('输入 schema 没有任何必填字段：动作参数应可核对');
  }

  return problems;
}

/** 校验输入对象是否符合工具声明的输入 schema。 */
export function validateInput(
  contract: ToolContract,
  input: Readonly<Record<string, unknown>>,
): readonly string[] {
  const problems: string[] = [];
  for (const [name, field] of Object.entries(contract.inputSchema.fields)) {
    const value = input[name];
    if (value === undefined) {
      if (field.required) problems.push(`缺少必填输入：${name}`);
      continue;
    }
    if (!matchesType(value, field.type)) {
      problems.push(`输入 ${name} 类型应为 ${field.type}`);
      continue;
    }
    if (field.enumValues !== undefined && !field.enumValues.includes(String(value))) {
      problems.push(`输入 ${name} 取值必须是 ${field.enumValues.join(' | ')} 之一`);
    }
  }
  for (const name of Object.keys(input)) {
    if (!(name in contract.inputSchema.fields)) problems.push(`输入 ${name} 未在 schema 中声明`);
  }
  return problems;
}

function matchesType(value: unknown, type: JsonType): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}

// ---------------------------------------------------------------------------
// 五、动作台账（R243「幂等键防重复提交」/ CLK-09「重复点击」）
// ---------------------------------------------------------------------------

export interface ActionRequest {
  /** 幂等键：**同一次用户意图**的重复提交必须复用同一个值。 */
  readonly requestId: string;
  readonly toolId: string;
  /** 发起时绑定的参数/目标版本（CLK-09「动作参数版本绑定」）。 */
  readonly revision: number;
}

export interface ActionLedgerEntry {
  readonly request: ActionRequest;
  readonly state: ActionState;
  readonly startedAtMs: number;
  readonly settledAtMs: number | null;
  /**
   * **是否已被同一 `requestId` 的更新版本取代**（R213「旧版本动作不得被复用」）。
   *
   * 只有**版本敏感**台账（注入了 `deriveIdempotencyKey`，见
   * `versionAwareClockLedgerOptions()`）才可能置真：当同 `requestId` 的**新版本**
   * 请求 `begin()`、而旧版本条目**尚未终结**时，旧条目被**显式**标记为此状态。
   *
   * 语义（三者缺一不可）：
   * - **保留**：被取代条目**仍在台账里**，已发生的事实不删除（可用 `supersededEntries()` 取回）；
   * - **不再未决**：它**不再计入** `activeCount()`——已被新版本替代，不是"未决动作"
   *   （否则 R261「无未决动作」会被旧版本永久顶住，恒为假）；
   * - **不改写历史**：只有**非终态**旧条目会被取代；已 `confirmed` / `failed` 的事实
   *   不因新版本到来而被改写（保留已确认完成 / 已失败的历史）。
   */
  readonly superseded: boolean;
  /** 被取代的时刻（毫秒）；未被取代为 `null`。 */
  readonly supersededAtMs: number | null;
}

/**
 * 幂等键推导函数（**可注入**）。
 *
 * 本包**不**反向依赖 `src/workledger`（避免内核 → 适配器的反向依赖），因此只**接受**
 * 调用方注入推导函数；权威实现与跨包桥接见
 * `src/workledger/action-state-alignment.ts` 的 `deriveClockLedgerKey()`
 * （那里复用 workledger 的 `deriveIdempotencyKey()`，绑定 `task_revision` + 参数摘要）。
 */
export type ActionLedgerKeyDerivation = (request: ActionRequest) => string;

export interface ActionLedgerOptions {
  /**
   * 注入的幂等键推导函数。
   *
   * - **注入时**：`begin()` 以 `deriveIdempotencyKey(request)` 的返回值作为幂等键去重。
   *   由于权威推导把 `revision` 也算进去，"同一 `requestId`、不同 `revision`"
   *   会得到**不同**的键 ⇒ 判为**两个动作**（与 R213「旧版本动作不得被复用」一致）。
   *   此时同 `requestId` 出现的**旧版本非终态条目**会被 `begin()` 显式标记
   *   `superseded: true` 并**不再计入** `activeCount()`（见 {@link ActionLedgerEntry.superseded}）。
   * - **不注入（默认）**：只按 `request.requestId` 去重。
   *   ⚠️ **此时不校验版本**——同名请求配不同版本（如 `revision: 1` 与 `revision: 999`）
   *   会被判为**同一动作**并返回旧条目。需要"版本不同即不同动作"时**必须**注入。
   *
   * **兼容性**：不注入时同一 `requestId` 只会产生一个键（`=== requestId`），
   * 因此**永远不会**触发取代路径——默认行为与旧版**逐字段一致**。
   */
  readonly deriveIdempotencyKey?: ActionLedgerKeyDerivation;
}

export interface ActionLedger {
  /**
   * 登记一次动作。**幂等键相同**的第二次调用返回既有条目（`duplicate: true`），
   * 不新建——这是"重复点击不重复执行"的落点。
   *
   * 幂等键由 `ActionLedgerOptions.deriveIdempotencyKey` 决定：**不注入**时就是
   * `request.requestId`（版本不参与判定，见该选项的警告）；**注入**时按注入函数计算。
   */
  begin(request: ActionRequest, atMs: number): { readonly duplicate: boolean; readonly entry: ActionLedgerEntry };
  /**
   * 推进到新状态；终态不可再改（触发/取消竞态 ⇒ 抛错，而不是静默覆盖）。
   *
   * 句柄是 `requestId` ⇒ 作用于该 `requestId` **最近登记**的条目（版本敏感台账里即最新版本）；
   * 被新版本取代的旧条目**不**经此推进（它已不再未决，见 `superseded`）。
   */
  settle(requestId: string, state: ActionState, atMs: number): ActionLedgerEntry;
  get(requestId: string): ActionLedgerEntry | null;
  /** 活跃（未终态、且未被取代）条目数。被取代的旧版本条目**不计入**（R261 防假阴性）。 */
  activeCount(): number;
  /**
   * 已被更新版本取代、但仍保留在台账中的条目（R213：旧版本动作不得被复用，但事实保留）。
   * 取代是**显式**的，故这些条目可被取回、审计——不静默丢失。
   */
  supersededEntries(): readonly ActionLedgerEntry[];
}

export function createActionLedger(options: ActionLedgerOptions = {}): ActionLedger {
  const deriveKey = options.deriveIdempotencyKey;
  /** 条目按**幂等键**存储；不注入推导函数时幂等键 `=== requestId`，行为与旧版一致。 */
  const byKey = new Map<string, ActionLedgerEntry>();
  /** `requestId → 该 requestId 最近一次登记用的幂等键`（`get` / `settle` 仍以 requestId 为句柄）。 */
  const keyByRequestId = new Map<string, string>();

  const ledgerKeyOf = (request: ActionRequest): string =>
    deriveKey === undefined ? request.requestId : deriveKey(request);

  return {
    begin(request, atMs) {
      const key = ledgerKeyOf(request);
      const existing = byKey.get(key);
      if (existing !== undefined) {
        return { duplicate: true, entry: existing };
      }
      // 同 requestId 出现**新版本**（新键）时，旧的、仍**非终态**的条目被**显式**标记为
      // 「被取代」：保留事实，但不再算作未决动作——否则旧版本条目会被永久顶在 active 里
      // （`get`/`settle` 只够得到最新版本），让 R261「无未决动作」恒为假（N-2）。
      // 已终态（confirmed / failed）的事实**不**因新版本到来而被改写。
      const previousKey = keyByRequestId.get(request.requestId);
      if (previousKey !== undefined && previousKey !== key) {
        const previous = byKey.get(previousKey);
        if (previous !== undefined && !previous.superseded && !isTerminal(previous.state)) {
          byKey.set(previousKey, { ...previous, superseded: true, supersededAtMs: atMs });
        }
      }
      const entry: ActionLedgerEntry = {
        request,
        state: 'prepared',
        startedAtMs: atMs,
        settledAtMs: null,
        superseded: false,
        supersededAtMs: null,
      };
      byKey.set(key, entry);
      // 同一 requestId 出现多个版本时，两种键各留一条；`get`/`settle` 作用于**最近**登记的那条。
      keyByRequestId.set(request.requestId, key);
      return { duplicate: false, entry };
    },

    settle(requestId, state, atMs) {
      const key = keyByRequestId.get(requestId);
      const existing = key === undefined ? undefined : byKey.get(key);
      if (existing === undefined || key === undefined) {
        throw new Error(`未知的动作 requestId：${requestId}`);
      }
      if (isTerminal(existing.state)) {
        throw new Error(
          `动作 ${requestId} 已处于终态「${label(existing.state)}」，不得改写为「${label(state)}」` +
            `（取消与触发竞态必须显出冲突，而不是覆盖已发生事实）。`,
        );
      }
      const next: ActionLedgerEntry = { ...existing, state, settledAtMs: atMs };
      byKey.set(key, next);
      return next;
    },

    get(requestId) {
      const key = keyByRequestId.get(requestId);
      return key === undefined ? null : (byKey.get(key) ?? null);
    },

    activeCount() {
      let count = 0;
      for (const entry of byKey.values()) {
        // 被取代的旧版本条目**不计入**：它已被新版本替代，不是"未决动作"。
        if (!entry.superseded && !isTerminal(entry.state)) count += 1;
      }
      return count;
    },

    supersededEntries() {
      return [...byKey.values()].filter((entry) => entry.superseded);
    },
  };
}
