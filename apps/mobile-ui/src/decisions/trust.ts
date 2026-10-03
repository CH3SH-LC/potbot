/**
 * F05 decisions / **最终确认走 K07 原生信任路径**。
 *
 * ## 这个文件关掉的洞
 *
 * `card.ts` 的 `confirmCard` 在本地**自己造**一枚 `AuthorizationGrant`
 * （`grantId: grant:<actionId>:r<revision>`）。那只是无内核时的 fixture——
 * 契约 §5 明确：`AuthorizationGrant` 由 **K07 独占**「发行 / 验证 / 消费」，
 * 前端（F 线）**只渲染**。若前端自签授权，就等于客户端自称"用户已批准"，
 * 与仓库 P0（`user_approved` 取自请求体）同类。
 *
 * 本文件提供真实运行该走的那条路：
 *
 *   `submitThroughNativeTrust(卡, 请求, 原生信任端口)`
 *     = 先跑 F05 闸门（可见性 / 旧 revision / 过期 / 一次性）
 *     → 把卡桥接成 K07 形状的 `ConfirmAction`
 *     → `recordConfirmAction`（账本登记，展示与授权的唯一事实来源）
 *     → `attest`（账本签发确认凭证，凭证在模块 WeakSet 里登记）
 *     → `issueGrant`（只有登记过的凭证才发得出一枚一次性授权）
 *     → 把 K07 授权映射回契约 `AuthorizationGrant` 挂到 `ConfirmAction` 上。
 *
 * ## 编码换算：按总协调裁决，走 `WireBridge` 端口（**不猜币种位数**）
 *
 * 总协调 2026-10-03 裁决（`contracts/mobile-v1/README.md` §金额与时间编码，
 * K07 已实体化为 `apps/mobile-kernel/actions/wire-codec.ts`）：
 *   - wire 层 `amount` 是十进制字符串、时间戳是 ISO-8601 UTC；
 *   - 领域层金额是**整数最小单位**，**小数位数由币种决定**（`CNY`=2 位 ⇒ 分）；
 *   - 换算必须**精确**：逐位字符串解析（禁止 `parseFloat(str)*100`），
 *     不可精确表示（如 `CNY` 的 `1.2345`）**拒绝**，不四舍五入、不截断。
 *
 * 本包**不自造币种位数**也不写死 10^-4：换算经由注入的 {@link WireBridge}
 * 完成，默认实现 {@link defaultWireBridge} 与裁决一致。测试另用**真实** K07
 * `wire-codec.ts` 交叉核对（等价性），从而在"默认桥属重复实现（生产未 import 其运行时）"
 * 与"换算与权威一致"之间两者兼得。
 *
 * ## 适配边界：真实 K07 账本（本文件唯一 import K07 之处）
 *
 * {@link asNativeTrustPort} 以 `import type` **类型化**引用真实 K07 `AuthorizationLedger`，
 * 编译期核对方法签名、运行时零耦合；{@link createKernelTrustSubmitter} 把真实账本与
 * **任务身份**（{@link requireTaskId} 校验后）及**真实原生确认页 id**
 * （{@link asNativeConfirmSurface} 校验后）绑成提交器。这样生产接线不再依赖占位
 * {@link DEFAULT_NATIVE_SURFACE}，也不用每次重复传 port / surface。
 *
 * **K-I02 同步（2026-10-03）**：K07 把 `ActionBinding.taskId` 变为**必需**、账本键改为
 * `(taskId, actionId)`、`getConfirmAction` / `attest` 各加一个 `taskId` 形参。本文件的
 * {@link NativeActionBinding} / {@link NativeTrustPort} 已随之对齐——真实账本因此**结构上
 * 重新满足**端口（`asNativeTrustPort` 仍是直通，同一引用）。`taskId` 由调用方经
 * {@link TrustOptions.taskId} 如实注入，F05 不从 actionId / cardId 拼（不猜任务身份）。
 * 契约层 `ConfirmAction` 仍无 `taskId`（契约 schema 未同步，属编排人交接），故 `taskId`
 * 只存在于领域 / 原生信任层。
 *
 * ## 明确未做（不得当成已完成）
 *
 * - **未接原生确认页 / Android 进程**：`createKernelTrustSubmitter` 使页 id **可注入**，
 *   但"真机原生页 id"与"只有原生页能 `attest`"的调用者边界仍需真机证据，本包未验证。
 * - **未持久化**：端口注入的若是内存账本，崩溃后仍读不到同一份记录（依赖 K09）。
 * - **未在真机验证**：本文件的证据只到单元 + 契约层；测试实跑真实 K07 模块，
 *   但那是手机内核的独立实现，非真机接线。
 * - **默认桥 vs K07 codec 是两处实现**：已用等价性测试兜住，但**真正的单一权威**
 *   仍是 K07 codec；待集成人收敛（见 integrationRequests）。
 */

import { amountToScaledUnits } from './compare.js';
import { evaluateConfirmGate } from './card.js';
import type {
  AuthorizationGrant,
  ConfirmAction,
  ConfirmCardView,
  ConfirmFailureReason,
  ConfirmRequest,
  ConfirmScope,
} from './types.js';

// 适配边界（**本文件是唯一允许 import K07 的地方**）：只取**类型**，`import type`
// 在运行时被完全擦除，故不引入跨线运行时耦合；但编译期会强制核对 K07 真实方法签名
// 与 {@link NativeTrustPort} 兼容（见文件末尾 asNativeTrustPort）。
import type { AuthorizationLedger as KernelAuthorizationLedger } from '../../../mobile-kernel/actions/index.js';

// ---------------------------------------------------------------------------
// 编码换算端口（wire ⇄ 领域），默认实现与总协调裁决一致
// ---------------------------------------------------------------------------

/** ISO 4217 最小单位位数表（**不是全集**；表外币种一律拒绝，不猜位数）。 */
export const CURRENCY_MINOR_DIGITS: Readonly<Record<string, number>> = Object.freeze({
  CNY: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  HKD: 2,
  MOP: 2,
  TWD: 2,
  SGD: 2,
  AUD: 2,
  CAD: 2,
  JPY: 0,
  KRW: 0,
  VND: 0,
  CLP: 0,
  ISK: 0,
  BHD: 3,
  KWD: 3,
  OMR: 3,
  TND: 3,
  JOD: 3,
  IQD: 3,
  LYD: 3,
});

const POW10 = [1, 10, 100, 1000] as const;
const WIRE_AMOUNT_RE = /^[0-9]+(\.[0-9]{1,4})?$/;
const WIRE_TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/;

/** 换算错误（带 K07 同源的机读 `code` / `field`，便于上层如实映射拒因）。 */
export class WireBridgeError extends Error {
  readonly code: string;
  readonly field: string | null;
  constructor(code: string, detail: string, field: string | null = null) {
    super(`[${code}]${field === null ? '' : `[${field}]`} ${detail}`);
    this.name = 'WireBridgeError';
    this.code = code;
    this.field = field;
  }
}

/** wire ⇄ 领域的编码换算端口。默认 {@link defaultWireBridge}；真机可注入 K07 codec 的等价实现。 */
export interface WireBridge {
  /** wire 十进制金额 → 领域整数最小单位（按币种位数，精确、fail-closed）。 */
  toMinorUnits(amount: string, currency: string): number;
  /** 领域整数最小单位 → wire 十进制金额（定点，位数与币种一致）。 */
  fromMinorUnits(minorUnits: number, currency: string): string;
  /** wire ISO-8601 UTC → 领域整数毫秒。 */
  toEpochMs(iso: string): number;
  /** 领域整数毫秒 → wire ISO-8601 UTC。 */
  fromEpochMs(ms: number): string;
}

function minorDigits(currency: string): number {
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
    throw new WireBridgeError('unsupported_currency', `币种必须是 ISO 4217 大写三字母，收到 ${JSON.stringify(currency)}`, 'currency');
  }
  const digits = CURRENCY_MINOR_DIGITS[currency];
  if (digits === undefined) {
    throw new WireBridgeError('unsupported_currency', `币种 ${currency} 不在最小单位位数表里：不猜位数`, 'currency');
  }
  return digits;
}

function pow10(digits: number): number {
  const value = POW10[digits];
  if (value === undefined) {
    throw new WireBridgeError('unsupported_currency', `最小单位位数 ${digits} 超出支持范围（0–3）`, 'currency');
  }
  return value;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/**
 * 默认换算实现：与总协调裁决逐条一致（逐位解析、按币种位数、不可表示即拒、
 * 亚毫秒时间不截断、非法日历时刻拒绝）。**生产不 import K07**，故此实现内联；
 * 与 K07 `wire-codec.ts` 的等价性由 `tests/mobile-ui/F05/trust.test.ts` 机器化核对。
 */
export const defaultWireBridge: WireBridge = Object.freeze({
  toMinorUnits(amount: string, currency: string): number {
    const digits = minorDigits(currency);
    if (typeof amount !== 'string' || !WIRE_AMOUNT_RE.test(amount)) {
      throw new WireBridgeError('wire_amount_invalid', `wire 金额必须是十进制字符串（^[0-9]+(\\.[0-9]{1,4})?$），收到 ${JSON.stringify(amount)}`, 'amount');
    }
    const dot = amount.indexOf('.');
    const intPart = dot === -1 ? amount : amount.slice(0, dot);
    const fracPart = dot === -1 ? '' : amount.slice(dot + 1);
    if (fracPart.length > digits && /[^0]/.test(fracPart.slice(digits))) {
      throw new WireBridgeError(
        'wire_amount_not_representable',
        `${currency} 的最小单位是 ${digits} 位小数，但 ${amount} 的更低位的非零：不能精确表示，拒绝`,
        'amount',
      );
    }
    const fracPadded = fracPart.slice(0, digits).padEnd(digits, '0');
    const value = Number(intPart) * pow10(digits) + (fracPadded === '' ? 0 : Number(fracPadded));
    if (!Number.isSafeInteger(value)) {
      throw new WireBridgeError('wire_amount_not_representable', `wire 金额 ${amount} 换算后超出安全整数范围：${String(value)}`, 'amount');
    }
    return value;
  },

  fromMinorUnits(minorUnits: number, currency: string): string {
    const digits = minorDigits(currency);
    if (typeof minorUnits !== 'number' || !Number.isSafeInteger(minorUnits) || minorUnits < 0) {
      throw new WireBridgeError('wire_amount_invalid', `领域金额必须是非负整数最小单位，收到 ${JSON.stringify(minorUnits)}`, 'amount');
    }
    const unit = pow10(digits);
    const intPart = Math.floor(minorUnits / unit);
    const fracPart = minorUnits % unit;
    if (digits === 0) return String(intPart);
    return `${intPart}.${pad(fracPart, digits)}`;
  },

  toEpochMs(iso: string): number {
    if (typeof iso !== 'string') {
      throw new WireBridgeError('wire_timestamp_invalid', `wire 时间戳必须是 ISO-8601 UTC 字符串，收到 ${JSON.stringify(iso)}`, 'expiresAt');
    }
    const match = WIRE_TIMESTAMP_RE.exec(iso);
    if (match === null) {
      throw new WireBridgeError('wire_timestamp_invalid', `wire 时间戳形状不符（YYYY-MM-DDThh:mm:ss[.f{1,6}]Z），收到 ${JSON.stringify(iso)}`, 'expiresAt');
    }
    const [, y, mo, d, h, mi, s, frac = ''] = match;
    if (frac.length > 3 && /[^0]/.test(frac.slice(3))) {
      throw new WireBridgeError('wire_timestamp_not_representable', `${iso} 的微秒位非零：注入时钟只到毫秒，不能精确表示，拒绝`, 'expiresAt');
    }
    const ms = frac === '' ? 0 : Number(frac.slice(0, 3).padEnd(3, '0'));
    const date = new Date(0);
    date.setUTCFullYear(Number(y), Number(mo) - 1, Number(d));
    date.setUTCHours(Number(h), Number(mi), Number(s), ms);
    const epoch = date.getTime();
    if (
      !Number.isFinite(epoch) ||
      date.getUTCFullYear() !== Number(y) ||
      date.getUTCMonth() !== Number(mo) - 1 ||
      date.getUTCDate() !== Number(d) ||
      date.getUTCHours() !== Number(h) ||
      date.getUTCMinutes() !== Number(mi) ||
      date.getUTCSeconds() !== Number(s) ||
      date.getUTCMilliseconds() !== ms
    ) {
      throw new WireBridgeError('wire_timestamp_invalid', `${iso} 不是合法的 UTC 日历时刻（含 02-30 之类越界日期）`, 'expiresAt');
    }
    return epoch;
  },

  fromEpochMs(ms: number): string {
    if (typeof ms !== 'number' || !Number.isSafeInteger(ms)) {
      throw new WireBridgeError('wire_timestamp_invalid', `领域时间戳必须是安全整数（毫秒），收到 ${JSON.stringify(ms)}`, 'expiresAt');
    }
    const date = new Date(ms);
    const year = date.getUTCFullYear();
    if (!Number.isFinite(date.getTime()) || year < 0 || year > 9999) {
      throw new WireBridgeError('wire_timestamp_invalid', `领域时间戳 ${ms} 无法表示为四位年份的 ISO-8601 时刻`, 'expiresAt');
    }
    return (
      `${pad(year, 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}` +
      `T${pad(date.getUTCHours(), 2)}:${pad(date.getUTCMinutes(), 2)}:${pad(date.getUTCSeconds(), 2)}` +
      `.${pad(date.getUTCMilliseconds(), 3)}Z`
    );
  },
});

// ---------------------------------------------------------------------------
// 原生信任端口（**结构化**形状：与 K07 `AuthorizationLedger` 结构兼容，
// 真机可直接注入真实账本；本文件不 import K07，避免把两条线绑死）
// ---------------------------------------------------------------------------

/**
 * 原生确认页标识**占位**（真机必须换成原生页 id；K07 用它做 `grantedBy` 审计）。
 *
 * 占位值只供"无原生页"的夹具使用；生产接线走 {@link createKernelTrustSubmitter}
 * 并**强制**注入真实页 id，不再依赖本常量。
 */
export const DEFAULT_NATIVE_SURFACE = 'f05-confirm-card';

/** 原生确认页标识（品牌类型，表示"这是原生宿主给的真实页 id"）。 */
export type NativeConfirmSurface = string & { readonly __nativeConfirmSurface: unique symbol };

/**
 * 校验并品牌化一个原生确认页标识（空串 / 纯空白即拒，fail-closed）。
 *
 * K07 的 `attest` 侧会对 `surface` 做 `requireText`；前端在适配边界提前拦下，
 * 既更早曝错，也杜绝把"占位/空串"当成真实页 id 混进账本的 `grantedBy` 审计字段。
 */
export function asNativeConfirmSurface(id: string): NativeConfirmSurface {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new TypeError(`原生确认页标识必须是非空字符串，收到 ${JSON.stringify(id)}`);
  }
  return id as NativeConfirmSurface;
}

/**
 * 校验任务身份（K-I02 之后 `(taskId, actionId)` 才是账本键）：空串 / 纯空白 / 非串即拒。
 *
 * 前端在适配边界提前拦下，与 K07 `requireText('taskId')` 同口径且更早曝错；
 * **绝不**回退到 actionId 之类"自造的任务身份"。
 */
export function requireTaskId(id: string): string {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new TypeError(`任务身份 taskId 必须是非空字符串，收到 ${JSON.stringify(id)}`);
  }
  return id;
}

/**
 * K07 形状的**九项绑定**（原八项 + 任务身份 `taskId`；`amount` 为整数最小单位）。
 *
 * 2026-10-03 K07（K-I02）把 `ActionBinding` 加了**必需**的 `taskId`，账本内部一律以
 * `(taskId, actionId)` 为键——`actionId` 不再是全局命名空间。本接口随之对齐：
 * 没有 `taskId` 的绑定连账本的 `requireText` 都过不了（`invalid_confirm_action[taskId]`）。
 * F05 的**契约层** `ConfirmAction` 仍无 `taskId`（契约 schema 未同步，见
 * `contracts/mobile-v1/schemas/confirm-action.schema.json`）；`taskId` 只在
 * **领域 / 原生信任层**出现，由调用方经 {@link TrustOptions.taskId} 注入，F05 不猜。
 */
export interface NativeActionBinding {
  readonly taskId: string;
  readonly actionId: string;
  readonly accountRef: string;
  readonly taskRevision: number;
  readonly paramsDigest: string;
  readonly quoteRef: string;
  readonly amount: number;
  readonly currency: string;
  readonly scope: ConfirmScope;
}

/** K07 形状的确认请求（八项绑定 + 期限整数）。 */
export interface NativeConfirmAction extends NativeActionBinding {
  readonly expiresAt: number;
}

/** K07 形状的确认凭证（账本签发，调用方无法伪造）。 */
export interface NativeAttestation {
  readonly actionId: string;
  readonly binding: NativeConfirmAction;
  readonly surface: string;
  readonly confirmedAt: number;
}

/** K07 形状的一次性授权。 */
export interface NativeGrant extends NativeActionBinding {
  readonly grantId: string;
  readonly expiresAt: number;
  readonly issuedAt: number;
  readonly grantedBy: string;
  readonly state: 'authorized' | 'submitting' | 'cancelled';
  readonly consumed: boolean;
  readonly consumedAt: number | null;
  readonly consumedBySubmissionId: string | null;
  readonly revokedAt: number | null;
  readonly revokedReason: string | null;
}

/**
 * F05 需要的那一小片原生信任端口。
 *
 * 与 K07 `AuthorizationLedger` 对应方法**同名同形**（含 K-I02 的 `(taskId, actionId)` 键），
 * 因此真实账本可直接满足本接口。方法用 method 语法声明以取得参数双变
 * （否则 `claim` 等可选参数会造成不兼容）。
 */
export interface NativeTrustPort {
  recordConfirmAction(action: NativeConfirmAction): NativeConfirmAction;
  getConfirmAction(taskId: string, actionId: string): NativeConfirmAction | undefined;
  attest(
    taskId: string,
    actionId: string,
    options: { surface: string; claim?: Partial<NativeActionBinding> },
  ): NativeAttestation;
  issueGrant(attestation: NativeAttestation): NativeGrant;
  consume(input: { grantId: string; actual: NativeActionBinding }): { grant: NativeGrant };
}

// ---------------------------------------------------------------------------
// 桥接：卡 → 原生确认请求；原生授权 → 契约授权
// ---------------------------------------------------------------------------

/**
 * 卡面 → 原生确认请求。金额 / 范围 / 期限任一非法、或 `taskId` 缺失则返回 null（不编造）。
 *
 * `taskId` 是 K-I02 之后的**必需**任务身份（K07 逐项绑定的一员，`(taskId, actionId)` 才是
 * 账本键）：必须由调用方如实给出，F05 **不**从 actionId / cardId 拼一个（那样等于自造任务
 * 身份，跨任务同名动作会互相顶掉）。空串 / 非串一律拒。
 */
export function toNativeConfirmAction(
  card: ConfirmCardView,
  taskId: string,
  bridge: WireBridge = defaultWireBridge,
): NativeConfirmAction | null {
  const price = card.price;
  const scope = card.scope;
  if (price === null || scope === null) return null;
  if (typeof taskId !== 'string' || taskId.trim() === '') return null;
  let amount: number;
  let expiresAt: number;
  try {
    amount = bridge.toMinorUnits(price.amount, price.currency);
    expiresAt = bridge.toEpochMs(card.expiresAt);
  } catch {
    return null;
  }
  return {
    taskId,
    actionId: card.actionId,
    accountRef: card.accountRef,
    taskRevision: card.taskRevision,
    paramsDigest: card.paramsDigest,
    quoteRef: card.quoteRef,
    amount,
    currency: price.currency,
    scope,
    expiresAt: Math.trunc(expiresAt),
  };
}

/** 原生授权 → 契约 `AuthorizationGrant`（唯一用于渲染的形状）。 */
export function toContractGrant(grant: NativeGrant, bridge: WireBridge = defaultWireBridge): AuthorizationGrant {
  const base: AuthorizationGrant = {
    grantId: grant.grantId,
    actionId: grant.actionId,
    issuedAt: bridge.fromEpochMs(grant.issuedAt),
    consumed: grant.consumed,
  };
  return grant.consumedAt === null ? base : { ...base, consumedAt: bridge.fromEpochMs(grant.consumedAt) };
}

function sameBinding(left: NativeActionBinding, right: NativeActionBinding): boolean {
  return (
    left.taskId === right.taskId &&
    left.actionId === right.actionId &&
    left.accountRef === right.accountRef &&
    left.taskRevision === right.taskRevision &&
    left.paramsDigest === right.paramsDigest &&
    left.quoteRef === right.quoteRef &&
    left.amount === right.amount &&
    left.currency === right.currency &&
    left.scope === right.scope
  );
}

// ---------------------------------------------------------------------------
// 错误映射（K07 拒因 → F05 机读拒因）
// ---------------------------------------------------------------------------

/** duck-type：跨打包边界的 `instanceof` 不可靠，故同时看 `code`。 */
export function nativeTrustErrorCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return null;
}

export function nativeTrustErrorField(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'field' in error) {
    const field = (error as { field: unknown }).field;
    if (typeof field === 'string') return field;
  }
  return null;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// 提交（最终确认）
// ---------------------------------------------------------------------------

/** 原生信任路径的拒因：F05 闸门拒因，或"被原生信任路径拒绝"（带 K07 `code` / `field`）。 */
export type TrustFailureReason = ConfirmFailureReason | 'native-trust-rejected';

export type TrustSubmitResult =
  | {
      readonly ok: true;
      readonly action: ConfirmAction;
      readonly card: ConfirmCardView;
      /** 原生账本签发的一次性授权（**不是**本地自签）。 */
      readonly grant: NativeGrant;
    }
  | {
      readonly ok: false;
      readonly reason: TrustFailureReason;
      /** K07 拒因码 / 换算拒因码（F05 闸门拒因时为 null）。 */
      readonly code: string | null;
      /** 逐项绑定不一致时指出是哪一项。 */
      readonly field: string | null;
      readonly detail: string;
      readonly card: ConfirmCardView;
    };

export interface TrustOptions {
  /**
   * **任务身份（必填）**。K-I02 之后 K07 的 `ActionBinding` 必须有 `taskId`，
   * 账本键是 `(taskId, actionId)`。F05 不猜任务 id：缺 / 空 ⇒ 桥接失败（fail-closed），
   * 绝不会退回全局 actionId 这种已经被 K07 封掉的命名空间。
   */
  readonly taskId: string;
  /** 原生确认页标识（真机须换成原生页 id）。 */
  readonly surface?: string;
  /** 编码换算端口（默认 {@link defaultWireBridge}；可注入 K07 codec 等价实现）。 */
  readonly bridge?: WireBridge;
}

/**
 * **最终确认**：走 K07 原生信任路径签发一次性授权。
 *
 * 与 `confirmCard` 的区别只有一处、也是关键一处：授权**不是本地造的**，
 * 而是 `recordConfirmAction → attest → issueGrant` 由注入的原生账本签发。
 * 任何一步被拒都如实映射为拒因，**绝不**降级成本地签发。
 */
export function submitThroughNativeTrust(
  card: ConfirmCardView,
  request: ConfirmRequest,
  port: NativeTrustPort,
  options: TrustOptions,
): TrustSubmitResult {
  const bridge = options.bridge ?? defaultWireBridge;
  const { taskId } = options;
  const gate = evaluateConfirmGate(card, request);
  if (!gate.ok) {
    return {
      ok: false,
      reason: gate.reason,
      code: null,
      field: null,
      detail: `F05 闸门拒因 ${gate.reason}`,
      card: gate.card,
    };
  }

  const native = toNativeConfirmAction(card, taskId, bridge);
  if (native === null) {
    return {
      ok: false,
      reason: 'native-trust-rejected',
      code: 'native-bridge-invalid',
      field: null,
      detail: '卡面无法桥接为原生确认请求（任务身份 / 金额 / 范围 / 期限非法或币种不可表示）',
      card,
    };
  }

  try {
    // ① 账本登记：展示与授权的**唯一**事实来源。已登记则逐项核对。
    const existing = port.getConfirmAction(taskId, card.actionId);
    if (existing === undefined) {
      port.recordConfirmAction(native);
    } else if (!sameBinding(existing, native) || existing.expiresAt !== native.expiresAt) {
      return {
        ok: false,
        reason: 'native-trust-rejected',
        code: 'confirm_binding_stale',
        field: null,
        detail: '账本里的确认请求与当前卡面不一致（关键条件已变，须先 amend 账本再确认）',
        card,
      };
    }

    // ② 账本签发确认凭证（绑定当前账本内容）。③ 只有登记过的凭证能发行授权。
    const attestation = port.attest(taskId, card.actionId, { surface: options.surface ?? DEFAULT_NATIVE_SURFACE });
    const grant = port.issueGrant(attestation);

    const contractGrant = toContractGrant(grant, bridge);
    const action: ConfirmAction = { ...gate.base, authorizationGrant: contractGrant };
    return {
      ok: true,
      action,
      card: { ...card, status: 'confirmed', grant: contractGrant },
      grant,
    };
  } catch (error) {
    const code = nativeTrustErrorCode(error);
    const field = nativeTrustErrorField(error);
    const reason: TrustFailureReason =
      code === 'confirm_expired' || code === 'grant_expired' ? 'expired' : 'native-trust-rejected';
    return { ok: false, reason, code, field, detail: errorDetail(error), card };
  }
}

// ---------------------------------------------------------------------------
// 消费（一键一次性）
// ---------------------------------------------------------------------------

export type TrustConsumeFailure =
  | 'already-consumed'
  | 'expired'
  | 'revoked'
  | 'binding-mismatch'
  | 'not-found'
  | 'rejected';

export type TrustConsumeResult =
  | { readonly ok: true; readonly grant: NativeGrant }
  | { readonly ok: false; readonly reason: TrustConsumeFailure; readonly code: string | null; readonly detail: string };

function mapConsumeCode(code: string | null): TrustConsumeFailure {
  switch (code) {
    case 'grant_already_consumed':
      return 'already-consumed';
    case 'grant_expired':
      return 'expired';
    case 'grant_revoked':
      return 'revoked';
    case 'grant_binding_mismatch':
      return 'binding-mismatch';
    case 'grant_not_found':
      return 'not-found';
    default:
      return 'rejected';
  }
}

/**
 * 通过原生账本**原子占用**一次性授权（真机上紧接着才是"发出"）。
 * 第二次占用同一授权 ⇒ `already-consumed`——这是"重复点击"在权威侧的落点。
 */
export function consumeGrantThroughTrust(
  port: NativeTrustPort,
  grantId: string,
  actual: NativeActionBinding,
): TrustConsumeResult {
  try {
    const outcome = port.consume({ grantId, actual });
    return { ok: true, grant: outcome.grant };
  } catch (error) {
    const code = nativeTrustErrorCode(error);
    return { ok: false, reason: mapConsumeCode(code), code, detail: errorDetail(error) };
  }
}

/** 从一张已确认的卡构造原生绑定（供占用时逐项复核；含任务身份）。 */
export function toNativeBinding(
  card: ConfirmCardView,
  taskId: string,
  bridge: WireBridge = defaultWireBridge,
): NativeActionBinding | null {
  const native = toNativeConfirmAction(card, taskId, bridge);
  if (native === null) return null;
  const { expiresAt: _expiresAt, ...binding } = native;
  return binding;
}

/** 兼容保留：卡面金额 → 10^-4 定标整数（**仅** `compare.ts` 比价排序用，非 wire 换算）。 */
export { amountToScaledUnits };

// ---------------------------------------------------------------------------
// 适配边界：真实 K07 账本接入（本文件唯一 import K07 之处）
// ---------------------------------------------------------------------------

/**
 * 适配边界：真实 K07 `AuthorizationLedger` → F05 `NativeTrustPort`。
 *
 * 这里**类型化地**引用 K07 的账本类（`import type`，运行时零耦合）：若 K07 的方法签名
 * 日后漂移，本函数**编译不过**——把"F05 实际要求的端口"与"K07 真实实现"钉在一起，
 * 不再只靠测试里的鸭子类型。结构兼容即直通：返回**同一对象**，不复制、不包裹，
 * 因此账本的原子性 / 单写者语义原样保留。
 */
export function asNativeTrustPort(ledger: KernelAuthorizationLedger): NativeTrustPort {
  return ledger;
}

/** `createKernelTrustSubmitter` 的接线参数。 */
export interface KernelTrustWiring {
  /** 真实 K07 账本（生产为持久账本；测试可注入其内存实现）。 */
  readonly ledger: KernelAuthorizationLedger;
  /**
   * **任务身份**（必填）。K-I02 之后账本键是 `(taskId, actionId)`，提交器据此把本任务下的
   * 同名动作与其它任务隔开；空 / 纯空白 ⇒ 构造即拒（fail-closed）。
   */
  readonly taskId: string;
  /**
   * **真实原生确认页 id**（必填）。`DEFAULT_NATIVE_SURFACE` 是占位，仅供无原生页的夹具；
   * 生产必须传原生宿主给出的页 id，经 {@link asNativeConfirmSurface} 校验后作为授权 `grantedBy`。
   */
  readonly surface: string;
  /** 编码换算端口（缺省 {@link defaultWireBridge}）。 */
  readonly bridge?: WireBridge;
}

/** 已绑定的信任路径提交器：账本与原生页 id 在构造时固定，调用处不再重复传。 */
export interface KernelTrustSubmitter {
  /** 已绑定的原生信任端口（即同一真实 K07 账本）。 */
  readonly port: NativeTrustPort;
  /** 已绑定的原生确认页 id（= 授权 `grantedBy`）。 */
  readonly surface: string;
  /** 走真实账本提交最终确认（surface 已绑定）。 */
  submit(card: ConfirmCardView, request: ConfirmRequest): TrustSubmitResult;
  /** 走真实账本原子占用一次性授权。 */
  consume(grantId: string, actual: NativeActionBinding): TrustConsumeResult;
}

/**
 * 生产接线入口：把**真实 K07 账本**与**真实原生确认页 id**绑成一个提交器，
 * 之后每次确认无需重复传 port / surface。`surface` 在此**强制校验**（空 / 纯空白即拒），
 * 杜绝把占位或空串当页面 id 混进账本的 `grantedBy` 审计字段。
 */
export function createKernelTrustSubmitter(wiring: KernelTrustWiring): KernelTrustSubmitter {
  if (typeof wiring !== 'object' || wiring === null) {
    throw new TypeError('createKernelTrustSubmitter 需要注入 { ledger, taskId, surface }');
  }
  const port = asNativeTrustPort(wiring.ledger);
  const surface = asNativeConfirmSurface(wiring.surface);
  const taskId = requireTaskId(wiring.taskId);
  const bridge = wiring.bridge ?? defaultWireBridge;
  return {
    port,
    surface,
    submit: (card, request) => submitThroughNativeTrust(card, request, port, { taskId, surface, bridge }),
    consume: (grantId, actual) => consumeGrantThroughTrust(port, grantId, actual),
  };
}
