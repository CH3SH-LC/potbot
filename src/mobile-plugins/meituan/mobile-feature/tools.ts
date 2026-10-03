/**
 * M10 业务 Agent 工具声明与**按实际 scope 暴露**（复用 `src/adapters/clock/action-contract.js`
 * 的 R241 `ToolContract`，不另造一套协议）。
 *
 * ## 两个硬结论，都做成可断言的结构事实
 *
 * 1. **支付不是一个工具**。平台支付页/SDK/回跳归 M08，用户自己完成支付；本包**不提供**
 *    任何 `pay` 工具，`PAYMENT_IS_NOT_A_TOOL` 为字面量 `true`，且 `NO_TOOL_CAPABILITIES`
 *    把 `pay` 单列为"有 scope 但无工具"。想给美团模板加"代付"能力的改动在这里当场失败。
 * 2. **工具只在能力被核实为 `verified` 时暴露**。`resolveExposedTools(matrix)` 是唯一的
 *    暴露出口：`unverified` ⇒ `blocked(scope_unverified)`，`denied` ⇒
 *    `blocked(scope_denied)`。没有"默认全开"的路径。
 *
 * ## 与旧 `src/adapters/meituan/contract.ts` 的关系
 *
 * 旧合同声明了 `cap.meituan.search` / `cap.meituan.detail` / `cap.meituan.handoff`。
 * 本批用户已授权开发下单能力，因此这里**新增**了报价/确认/提交/查询/取消五个工具的声明，
 * 但**没有删除**旧的购买保护：仍由 `validateToolContract` 拒绝 `irreversible` 副作用，
 * 且支付被彻底排除在工具集之外。旧的 handoff 读取仍由旧文件承载，本包专注于消费旅程。
 */

import {
  validateToolContract,
  type ToolContract,
} from '../../../adapters/clock/action-contract.js';
import type { CapabilityMatrix, ExposedTool, ExposureReason, ScopeCapability } from './types.js';

/** 归属模板 `plugin_id`（与 `src/plugins/catalog.ts` 的既有命名对齐，不新造平行命名）。 */
export const MEITUAN_TEMPLATE = 'template.meituan';

/** 有 scope 能力但**没有**对应工具的能力（结构性地排除"代付"）。 */
export const NO_TOOL_CAPABILITIES = ['pay'] as const;
export type NoToolCapability = (typeof NO_TOOL_CAPABILITIES)[number];

/** 字面量断言：支付在本包**不是**一个工具。任何想让它变成工具的改动都会红。 */
export const PAYMENT_IS_NOT_A_TOOL: true = true;

const NETWORK_READ = [{ permissionId: 'perm.network.read', required: true }] as const;
const DEVICE_LOCATION = [{ permissionId: 'perm.device.location', required: true }] as const;
const EXTERNAL_ORDER = [{ permissionId: 'perm.external-order', required: true }] as const;
const USER_CONFIRM = [{ permissionId: 'perm.user.confirm', required: true }] as const;

/** 工具声明 + 它归属的 scope 能力（`null` = 无平台 API 依赖，永不因 scope 被阻断）。 */
export interface ScopedToolDeclaration {
  readonly capability: ScopeCapability | null;
  readonly contract: ToolContract;
}

const SEARCH: ScopedToolDeclaration = {
  capability: 'search',
  contract: {
    toolId: 'cap.meituan.search',
    template: MEITUAN_TEMPLATE,
    summary: '按品类/位置/人数/预算查询**真实**候选店铺；候选只能来自已授权接口',
    inputSchema: {
      fields: {
        category: { type: 'string', required: true, description: '品类（如"火锅"）' },
        location: { type: 'string', required: true, description: '位置/范围' },
        budgetMinor: { type: 'number', required: false, description: '预算（整数最小单位，分）' },
      },
    },
    outputSchema: {
      fields: {
        candidates: { type: 'array', required: true, description: '候选清单（每条带来源）' },
        status: {
          type: 'string',
          required: true,
          description: 'ok / not_ready / unavailable（不得以编造候选代替）',
          enumValues: ['ok', 'not_ready', 'unavailable'],
        },
      },
    },
    permissions: [...NETWORK_READ],
    externalSideEffect: 'read',
    requiresConfirmation: false,
    idempotency: 'idempotent',
    queryable: true,
    undo: 'not_applicable',
    trustedReceipt: '已授权接口的原始响应（每条候选必须能指回其来源）',
  },
};

const MENU: ScopedToolDeclaration = {
  capability: 'menu',
  contract: {
    toolId: 'cap.meituan.menu',
    template: MEITUAN_TEMPLATE,
    summary: '读取店铺菜单 / SKU / 规格 / 起送与配送范围；未知项**分别标记**，不补造菜品',
    inputSchema: {
      fields: {
        merchantId: { type: 'string', required: true, description: '店铺 ID（须来自已授权接口）' },
      },
    },
    outputSchema: {
      fields: {
        dishes: { type: 'array', required: true, description: '菜品与 SKU（含必选/多选规格）' },
        unknownFields: { type: 'array', required: true, description: '未知项及原因（不得补造）' },
      },
    },
    permissions: [...NETWORK_READ],
    externalSideEffect: 'read',
    requiresConfirmation: false,
    idempotency: 'idempotent',
    queryable: true,
    undo: 'not_applicable',
    trustedReceipt: '已授权接口的原始响应',
  },
};

const ADDRESS: ScopedToolDeclaration = {
  capability: 'address',
  contract: {
    toolId: 'cap.meituan.address',
    template: MEITUAN_TEMPLATE,
    summary: '解析收货地址与配送时段（手填或授权定位）；定位被拒**不自动换地址**',
    inputSchema: {
      fields: {
        resolutionMode: {
          type: 'string',
          required: true,
          description: '解析路径：显式选择 / 已授权定位 / 默认地址',
          enumValues: ['explicit_selection', 'authorized_locating', 'default'],
        },
        addressRef: { type: 'string', required: false, description: '用户显式选择的地址引用（可选）' },
        slotRef: { type: 'string', required: false, description: '配送时段引用（可选）' },
      },
    },
    outputSchema: {
      fields: {
        resolution: {
          type: 'string',
          required: true,
          description: 'ready / needs_explicit_selection / invalid_selection',
          enumValues: ['ready', 'needs_explicit_selection', 'invalid_selection'],
        },
        addressRef: { type: 'string', required: false, description: '解析出的地址引用（未就绪时无）' },
      },
    },
    permissions: [...DEVICE_LOCATION],
    externalSideEffect: 'read',
    requiresConfirmation: false,
    idempotency: 'idempotent',
    queryable: true,
    undo: 'not_applicable',
    trustedReceipt: '定位/时段接口的原始响应（脱敏引用）',
  },
};

const QUOTE: ScopedToolDeclaration = {
  capability: 'preview',
  contract: {
    toolId: 'cap.meituan.quote',
    template: MEITUAN_TEMPLATE,
    summary: '服务端**预览计价**：返回最终价与币种、费用与优惠；本地不重算价格',
    inputSchema: {
      fields: {
        paramsDigest: { type: 'string', required: true, description: '购物车参数指纹（本地算出）' },
        addressRef: { type: 'string', required: true, description: '绑定的地址引用' },
      },
    },
    outputSchema: {
      fields: {
        quoteRef: { type: 'string', required: true, description: '报价引用（报价变化即失效）' },
        amountMinor: { type: 'number', required: true, description: '最终金额（整数最小单位）' },
        currency: { type: 'string', required: true, description: 'ISO 4217 币种' },
        expiresAt: { type: 'number', required: true, description: '报价到期（注入时钟域）' },
      },
    },
    permissions: [...NETWORK_READ],
    externalSideEffect: 'read',
    requiresConfirmation: false,
    idempotency: 'idempotent',
    queryable: true,
    undo: 'not_applicable',
    trustedReceipt: '服务端计价接口的原始响应（最终价与币种由服务端给出）',
  },
};

const CONFIRM: ScopedToolDeclaration = {
  capability: null,
  contract: {
    toolId: 'cap.meituan.confirm',
    template: MEITUAN_TEMPLATE,
    summary: '汇总商家/SKU/规格/数量/总费用/地址/时段，生成待确认参数摘要；**不发出任何外部写入**',
    inputSchema: {
      fields: {
        quoteRef: { type: 'string', required: true, description: '要确认的报价引用' },
        paramsDigest: { type: 'string', required: true, description: '完整参数摘要' },
      },
    },
    outputSchema: {
      fields: {
        actionId: { type: 'string', required: true, description: '待确认动作标识（K07 账本键）' },
        paramsDigest: { type: 'string', required: true, description: '回显的参数摘要' },
      },
    },
    permissions: [...USER_CONFIRM],
    externalSideEffect: 'none',
    requiresConfirmation: false,
    idempotency: 'idempotent',
    queryable: true,
    undo: 'not_applicable',
    trustedReceipt: '无外部回执：确认动作只产生本地待确认参数（K07 独占发行 AuthorizationGrant）',
  },
};

const SUBMIT: ScopedToolDeclaration = {
  capability: 'submit',
  contract: {
    toolId: 'cap.meituan.submitOrder',
    template: MEITUAN_TEMPLATE,
    summary: '在用户**本次真实确认**后提交订单；必须携带 K07 一次性授权与幂等键；未知先查原单',
    inputSchema: {
      fields: {
        actionId: { type: 'string', required: true, description: 'K07 已确认的动作标识' },
        authorizationRef: { type: 'string', required: true, description: 'K07 一次性授权引用（脱敏）' },
        idempotencyKey: { type: 'string', required: true, description: '幂等键（同次意图复用同值）' },
      },
    },
    outputSchema: {
      fields: {
        state: {
          type: 'string',
          required: true,
          description: '提交状态（六态）；只有 confirmed 可声称已下单',
          enumValues: ['submitting', 'submitted', 'rejected', 'unknown', 'confirmed', 'cancelled'],
        },
        externalOrderId: { type: 'string', required: false, description: '平台订单号（成功时才有）' },
      },
    },
    permissions: [...EXTERNAL_ORDER],
    externalSideEffect: 'write',
    requiresConfirmation: true,
    idempotency: 'keyed',
    queryable: true,
    undo: 'compensating',
    trustedReceipt: '平台业务结果码 + 查原单回读；HTTP 成功但业务失败不得当成功',
  },
};

const QUERY: ScopedToolDeclaration = {
  capability: 'query',
  contract: {
    toolId: 'cap.meituan.queryOrder',
    template: MEITUAN_TEMPLATE,
    summary: '按原单查询订单/配送/退款状态；externalId/账号/金额逐项匹配，断线先查原单',
    inputSchema: {
      fields: {
        externalOrderId: { type: 'string', required: true, description: '本地已核验的原单号' },
        accountRef: { type: 'string', required: true, description: '账号引用（须与原单一致）' },
      },
    },
    outputSchema: {
      fields: {
        stages: { type: 'array', required: true, description: '下单/支付/接单/配送/取消/退款分别报告' },
        statusRecognized: { type: 'boolean', required: true, description: '状态码是否被识别' },
      },
    },
    permissions: [...NETWORK_READ],
    externalSideEffect: 'read',
    requiresConfirmation: false,
    idempotency: 'idempotent',
    queryable: true,
    undo: 'not_applicable',
    trustedReceipt: '平台查询接口的原始响应（externalId 与意图逐项匹配）',
  },
};

const CANCEL: ScopedToolDeclaration = {
  capability: 'cancel',
  contract: {
    toolId: 'cap.meituan.cancelOrder',
    template: MEITUAN_TEMPLATE,
    summary: '请求取消订单 / 发起退款申请；**取消成功 ≠ 退款到账**，须分别报告',
    inputSchema: {
      fields: {
        externalOrderId: { type: 'string', required: true, description: '要取消的原单号' },
        idempotencyKey: { type: 'string', required: true, description: '幂等键（防重复取消）' },
      },
    },
    outputSchema: {
      fields: {
        cancelState: {
          type: 'string',
          required: true,
          description: '取消请求结论（不把"已申请退款"当"已到账"）',
          enumValues: ['requested', 'submitted', 'unknown', 'confirmed', 'rejected', 'cancelled'],
        },
        refundState: { type: 'string', required: true, description: '退款状态（独立于取消）' },
      },
    },
    permissions: [...EXTERNAL_ORDER],
    externalSideEffect: 'write',
    requiresConfirmation: true,
    idempotency: 'keyed',
    queryable: true,
    undo: 'not_applicable',
    trustedReceipt: '平台取消/退款接口的原始响应；退款到账须另行查询确认',
  },
};

/** 全部工具声明（含 scope 归属），冻结在模块内。 */
export const MEITUAN_TOOL_DECLARATIONS: readonly ScopedToolDeclaration[] = Object.freeze([
  SEARCH,
  MENU,
  ADDRESS,
  QUOTE,
  CONFIRM,
  SUBMIT,
  QUERY,
  CANCEL,
]);

/** 仅工具合同（供 `validateToolContract` 逐条校验）。 */
export function meituanToolContracts(): readonly ToolContract[] {
  return MEITUAN_TOOL_DECLARATIONS.map((declaration) => declaration.contract);
}

/**
 * 校验全部工具声明自洽。**模块加载即可调用**，保证"工具合同不得自相矛盾"是机器可检查的。
 * 同时硬拒任何声明了不可撤销副作用（R246）或挂到 `pay` 能力的工具。
 */
export function validateMeituanTools(): readonly string[] {
  const problems: string[] = [];
  for (const declaration of MEITUAN_TOOL_DECLARATIONS) {
    problems.push(...validateToolContract(declaration.contract).map((text) => `${declaration.contract.toolId}: ${text}`));
    if (declaration.contract.externalSideEffect === 'irreversible') {
      problems.push(`${declaration.contract.toolId}: 出现不可撤销副作用——禁止直接购买/支付`);
    }
    if ((declaration.capability as string | null) === 'pay') {
      problems.push(`${declaration.contract.toolId}: 不得挂到 pay 能力——支付不是本包的工具`);
    }
  }
  return problems;
}

/** 断言工具集里**没有**支付工具（结构事实，不是口头约定）。 */
export function assertNoPaymentTool(): void {
  const offenders = MEITUAN_TOOL_DECLARATIONS.filter(
    (declaration) =>
      (declaration.capability as string | null) === 'pay' ||
      /pay|payment|支付|付款/i.test(declaration.contract.toolId) ||
      /支付|付款|代付/.test(declaration.contract.summary),
  );
  if (offenders.length > 0) {
    throw new Error(
      `美团工具集里出现了支付工具：${offenders.map((o) => o.contract.toolId).join(', ')}。` +
        `支付必须由用户在平台许可流程内完成——本包不提供代付工具。`,
    );
  }
}

/**
 * 按能力矩阵解析工具暴露。**唯一**的暴露出口。
 *
 * - `capability === null`（如本地确认）⇒ `enabled(no_scope_capability)`；
 * - `verified` ⇒ `enabled(scope_verified)`；
 * - `unverified` ⇒ `blocked(scope_unverified)`；
 * - `denied` ⇒ `blocked(scope_denied)`。
 */
export function resolveExposedTools(matrix: CapabilityMatrix): readonly ExposedTool[] {
  return Object.freeze(
    MEITUAN_TOOL_DECLARATIONS.map((declaration) => {
      const capability = declaration.capability;
      const contract = declaration.contract;
      if (capability === null) {
        return freezeExposed({
          toolId: contract.toolId,
          capability,
          exposure: 'enabled',
          reason: 'no_scope_capability' as ExposureReason,
          detail: '本地动作，无平台 API 依赖（不因 scope 被阻断）',
          contract,
        });
      }
      const verdict = matrix.verdicts[capability];
      if (verdict === undefined) {
        // 缺项按 unverified 处理——绝不默认可用。
        return freezeExposed({
          toolId: contract.toolId,
          capability,
          exposure: 'blocked',
          reason: 'scope_unverified' as ExposureReason,
          detail: `能力 ${capability} 缺少核实结论，按未核实处理`,
          contract,
        });
      }
      if (verdict.availability === 'verified') {
        return freezeExposed({
          toolId: contract.toolId,
          capability,
          exposure: 'enabled',
          reason: 'scope_verified' as ExposureReason,
          detail: verdict.detail,
          contract,
        });
      }
      const reason: ExposureReason = verdict.availability === 'denied' ? 'scope_denied' : 'scope_unverified';
      return freezeExposed({
        toolId: contract.toolId,
        capability,
        exposure: 'blocked',
        reason,
        detail: verdict.detail,
        contract,
      });
    }),
  );
}

function freezeExposed(tool: ExposedTool): ExposedTool {
  return Object.freeze(tool);
}

/** 交给模型（ModelPort `toolSchemas`）的**只含 enabled** 的工具合同列表。 */
export function enabledToolContracts(tools: readonly ExposedTool[]): readonly ToolContract[] {
  return Object.freeze(tools.filter((tool) => tool.exposure === 'enabled').map((tool) => tool.contract));
}

/** 已暴露工具的 ID（含 blocked 的），便于展示与验收比对。 */
export function toolIdExposureMap(tools: readonly ExposedTool[]): Readonly<Record<string, ToolExposureLabel>> {
  const map: Record<string, ToolExposureLabel> = {};
  for (const tool of tools) {
    map[tool.toolId] = `${tool.exposure}:${tool.reason}`;
  }
  return Object.freeze(map);
}

export type ToolExposureLabel = string;
