/**
 * M10 独立宿主 —— 把美团四包（M04/M05/M07/M09）的端口装配成一个可运行的纵切，
 * 并把「fixture 不得进入生产路径」做成**结构性事实**。
 *
 * ## 为什么是"独立宿主"
 *
 * 工作书要求本线在自己的宿主和真实语料上完成模块验证，而不等全内核（K01）先跑起来。
 * 这个宿主**只依赖注入端口**：报价端口（M04 `QuotePort`）、下单执行器与查原单端口
 * （M07 `OrderExecutorPort` / `OrderQueryPort`）。正式手机上这些端口由 M02 的真实
 * transport 实现；开发期由 fixture 实现——**同一个接口**，因此模型层可独立测试。
 *
 * ## 结构性保证：fixture 不能被"翻"成生产
 *
 * - `createFixtureFeatureHost` 返回的宿主 `mode` 是**字面量 `'fixture'`**；
 * - 它带一个 `activateProduction()` 方法，**调用即抛** `fixture_host_cannot_be_promoted`
 *   —— 不是"需要一个开关"，而是**根本没有那条路径**；
 * - `promoteToProduction(host)` 对 fixture 宿主同样直接抛错；
 * - 真机宿主 `createRealFeatureHost` 现在是一个**凭证闸门**（M-I10 接线）：只有传入一枚
 *   **已登记**的可信 `RealTransportAttestation`（由 M02/M-I19 用
 *   `issueRealTransportAttestation` 签发）才构造得出来；缺凭证 ⇒ `real_host_not_wired`，
 *   伪造凭证 ⇒ `untrusted_real_attestation`。它给的是 real 台账（可记录 confirmed/支付）
 *   与 real manifest（过得了生产启用闸门），但**真正下单/支付的执行路径仍未接线**——
 *   `activateProduction()` 与真实网络都不存在。
 *
 * 因此 fixture 的成功**无法**被升级为真实下单通道；真机通道只能由独立签发的真机凭证开启。
 */

import type { QuotePort } from '../cart/index.js';
import type { OrderExecutorPort, OrderQueryPort } from '../order-submit/index.js';
import {
  createFixtureEvidenceLedger,
  createRealEvidenceLedger,
  isTrustedRealTransportAttestation,
  type EvidenceLedger,
} from './evidence.js';
import { buildMeituanFeatureManifest, type FeatureManifest } from './manifest.js';
import { assertNoPaymentTool, enabledToolContracts, resolveExposedTools } from './tools.js';
import {
  unverifiedMatrix,
  type CapabilityMatrix,
  type Clock,
  type ExposedTool,
  type RealTransportAttestation,
} from './types.js';
import type { ToolContract } from '../../../adapters/clock/action-contract.js';

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

export const HOST_ERROR_CODES = [
  'missing_clock',
  'missing_quote_port',
  'fixture_host_cannot_be_promoted',
  'real_host_not_wired',
  'untrusted_real_attestation',
  'real_host_already_production',
  'not_a_host',
] as const;
export type HostErrorCode = (typeof HOST_ERROR_CODES)[number];

export class HostError extends Error {
  readonly code: HostErrorCode;
  constructor(code: HostErrorCode, message: string) {
    super(message);
    this.name = 'HostError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// 端口与宿主
// ---------------------------------------------------------------------------

/** 宿主需要的注入端口。执行器/查询端口可为 `null`（则提交与查询能力不可用）。 */
export interface FeatureHostPorts {
  readonly clock: Clock;
  readonly quote: QuotePort;
  readonly orderExecutor: OrderExecutorPort | null;
  readonly orderQuery: OrderQueryPort | null;
}

export interface FixtureFeatureHostConfig {
  readonly ports: FeatureHostPorts;
  /** 能力矩阵；省略即"全部未核实"的诚实默认。 */
  readonly matrix?: CapabilityMatrix;
  readonly identity?: string;
}

export interface FeatureHost {
  readonly identity: string;
  /** 字面量 `'fixture'`：本批唯一的宿主模式。 */
  readonly mode: 'fixture';
  readonly manifest: FeatureManifest;
  readonly ledger: EvidenceLedger;
  readonly tools: readonly ExposedTool[];
  readonly ports: FeatureHostPorts;
  /** 交给模型（ModelPort `toolSchemas`）的**只含 enabled** 工具合同。 */
  toolSchemas(): readonly ToolContract[];
  /** **无运行期开关**：fixture 宿主调用即抛。 */
  activateProduction(): never;
}

function requirePorts(ports: FeatureHostPorts): void {
  if (ports === null || typeof ports !== 'object') {
    throw new HostError('missing_clock', '宿主需要注入端口对象');
  }
  if (typeof ports.clock?.now !== 'function') {
    throw new HostError('missing_clock', '宿主需要注入时钟（禁止读墙钟）');
  }
  if (ports.quote === null || typeof ports.quote !== 'object' || typeof ports.quote.price !== 'function') {
    throw new HostError('missing_quote_port', '宿主需要注入报价端口（M04 QuotePort）');
  }
}

/**
 * 造一个 **fixture** 独立宿主。
 *
 * manifest 固定 `verificationMode: 'fixture'`、`portReady: false`；
 * 证据台账固定为 fixture 台账；工具按传入矩阵（默认全部未核实）暴露。
 */
export function createFixtureFeatureHost(config: FixtureFeatureHostConfig): FeatureHost {
  if (config === null || typeof config !== 'object') {
    throw new HostError('not_a_host', '需要一份配置对象');
  }
  requirePorts(config.ports);
  const matrix = config.matrix ?? unverifiedMatrix();
  const tools = resolveExposedTools(matrix);
  const ledger = createFixtureEvidenceLedger({ clock: config.ports.clock });
  const manifest = buildMeituanFeatureManifest({ verificationMode: 'fixture', portReady: false });
  const host: FeatureHost = {
    identity: config.identity ?? 'fixture-meituan-feature-host',
    mode: 'fixture',
    manifest,
    ledger,
    tools,
    ports: config.ports,
    toolSchemas(): readonly ToolContract[] {
      return enabledToolContracts(tools);
    },
    activateProduction(): never {
      throw new HostError(
        'fixture_host_cannot_be_promoted',
        'fixture 宿主没有生产路径：任何"把它接到真实下单"的尝试都必须在 M02 交付后新建 real 宿主，而不是翻转本对象',
      );
    },
  };
  return Object.freeze(host);
}

/** 真机宿主配置：**必须**携带一枚已登记的可信真机传输凭证。 */
export interface RealFeatureHostConfig {
  readonly ports: FeatureHostPorts;
  readonly matrix: CapabilityMatrix;
  /**
   * 已登记的可信真机传输凭证（`issueRealTransportAttestation` 签发）。缺省 / 伪造一律拒。
   */
  readonly attestation: RealTransportAttestation;
  readonly identity?: string;
}

/**
 * 真机宿主：由**可信凭证闸门**构造。
 *
 * 与 fixture 宿主的三点结构性差异：
 * 1. 构造需要一枚**已登记**的 `RealTransportAttestation`——缺 ⇒ `real_host_not_wired`，
 *    形状相同但未登记（伪造/拷贝）⇒ `untrusted_real_attestation`；
 * 2. 台账是 **real 台账**（`createRealEvidenceLedger`），因此**可以**记录 `confirmed`
 *    与 `payment_confirmed`（fixture 台账结构上写不了）；
 * 3. manifest 为 `verificationMode: 'real'` + `portReady: true`，因此**过得了**生产启用闸门
 *    （fixture manifest 恒过不了）。
 *
 * **诚实边界**：它只证明"构造真机通道的凭证闸门确实关着"，不证明本批已经能真实下单——
 * 真正下单/支付仍需 K07 账本与真实 transport 端口实现，因此 `activateProduction()` 仍然抛错。
 * 另外本构造函数会先跑 `assertNoPaymentTool()`：只要工具集里出现支付工具，真机宿主构造即失败。
 */
export interface RealFeatureHost {
  readonly identity: string;
  /** 字面量 `'real'`：由凭证闸门构造。 */
  readonly mode: 'real';
  readonly manifest: FeatureManifest;
  readonly ledger: EvidenceLedger;
  readonly tools: readonly ExposedTool[];
  readonly ports: FeatureHostPorts;
  readonly attestation: RealTransportAttestation;
  /** 交给模型的**只含 enabled** 工具合同。 */
  toolSchemas(): readonly ToolContract[];
  /** 真实下单/支付执行路径仍未接线：调用即抛（不会假装已在真实通道上）。 */
  activateProduction(): never;
}

/** 本模块造出的真机宿主登记（私有 WeakSet）：`isRealFeatureHost` 对伪造对象返回 false。 */
const REAL_HOSTS = new WeakSet<object>();

export function createRealFeatureHost(config: RealFeatureHostConfig): RealFeatureHost {
  if (config === null || typeof config !== 'object') {
    throw new HostError('real_host_not_wired', '真机宿主需要一份配置对象');
  }
  if (config.attestation === undefined || config.attestation === null) {
    throw new HostError(
      'real_host_not_wired',
      '真机宿主需要一枚已登记的可信真机传输凭证（由 M02/M-I19 用 issueRealTransportAttestation 签发）；没有它不得构造真实通道',
    );
  }
  if (!isTrustedRealTransportAttestation(config.attestation)) {
    throw new HostError(
      'untrusted_real_attestation',
      '真机传输凭证形状相同但未登记：真机宿主只能由已登记凭证构造，不得用自造/拷贝对象冒充',
    );
  }
  requirePorts(config.ports);
  if (config.matrix === null || typeof config.matrix !== 'object') {
    throw new HostError('not_a_host', '真机宿主需要一份能力矩阵');
  }
  // 支付不是工具：真机宿主构造前先做结构检查。
  assertNoPaymentTool();
  const tools = resolveExposedTools(config.matrix);
  const ledger = createRealEvidenceLedger({ clock: config.ports.clock, attestation: config.attestation });
  const manifest = buildMeituanFeatureManifest({ verificationMode: 'real', portReady: true });
  const host: RealFeatureHost = {
    identity: config.identity ?? 'real-meituan-feature-host',
    mode: 'real',
    manifest,
    ledger,
    tools,
    ports: config.ports,
    attestation: config.attestation,
    toolSchemas(): readonly ToolContract[] {
      return enabledToolContracts(tools);
    },
    activateProduction(): never {
      throw new HostError(
        'real_host_not_wired',
        '真机宿主是凭证闸门：真正下单/支付仍需 K07 账本与真实 transport 端口，本批未接线——不得假装已在真实通道执行',
      );
    },
  };
  REAL_HOSTS.add(host);
  return Object.freeze(host);
}

// ---------------------------------------------------------------------------
// 防"翻转"
// ---------------------------------------------------------------------------

/** 该对象是否是本模块造的合法 fixture 宿主。 */
export function isFeatureHost(value: unknown): value is FeatureHost {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as FeatureHost).mode === 'fixture' &&
    typeof (value as FeatureHost).activateProduction === 'function'
  );
}

/** 该对象是否是本模块造出的合法真机宿主（私有 WeakSet 登记，伪造对象返回 false）。 */
export function isRealFeatureHost(value: unknown): value is RealFeatureHost {
  return typeof value === 'object' && value !== null && REAL_HOSTS.has(value);
}

/** 断言宿主确实是 fixture（真实/伪造对象一律拒）。 */
export function assertFixtureHost(host: unknown): void {
  if (!isFeatureHost(host)) {
    throw new HostError('not_a_host', '需要一个 fixture 宿主');
  }
}

/**
 * 尝试把宿主提升为生产。**fixture 宿主必抛**——这是"不能把 fixture 接入生产开关"的
 * 唯一入口，也让"有没有那条路径"变成可断言的事实。
 *
 * 真机宿主是**构造时就真实**的：它由凭证闸门产出，因此没有"从 fixture 提升"这一步，
 * 调用同样抛 `real_host_already_production`（而不是含糊的 `not_a_host`）。
 */
export function promoteToProduction(host: unknown): never {
  if (isRealFeatureHost(host)) {
    throw new HostError(
      'real_host_already_production',
      `宿主 ${host.identity} 已是 real 模式：它由可信凭证闸门构造，没有"从 fixture 提升"这一步`,
    );
  }
  if (isFeatureHost(host)) {
    throw new HostError(
      'fixture_host_cannot_be_promoted',
      `宿主 ${host.identity} 是 fixture：没有运行期开关可翻转为生产；请在 M02 交付后新建 real 宿主`,
    );
  }
  throw new HostError('not_a_host', '待提升的对象不是本模块的宿主');
}
