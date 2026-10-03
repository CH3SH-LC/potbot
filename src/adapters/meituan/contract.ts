/**
 * 美团能力的**工具声明**（合同 R241）与**不变量**（R242 / R246）。
 *
 * ## 本模块刻意**不**做的事
 *
 * 合同 MT-02 明令「**不能用模型编候选**」，MT-08/R246 明令「**不直接购买/支付**」。
 * 在**没有真实接口与账号**的情况下，任何"能查候选"的实现都只能是编造。
 * 因此本模块**只产出合同与不变量**（可静态检查的部分），**不产出**任何候选数据。
 *
 * ## 工具 ID 与模板归属
 *
 * 与 `src/plugins/catalog.ts` 既有命名对齐（`cap.meituan.search` / `cap.meituan.detail` /
 * `cap.meituan.handoff`），**不新造平行命名**。
 */

import type { SideEffect, ToolContract } from '../clock/action-contract.js';
import { validateToolContract } from '../clock/action-contract.js';

export const MEITUAN_TEMPLATE = 'template.meituan';

/** R246 明令禁止的动作语义（**不得**出现在本模板的任何工具声明里）。 */
export const FORBIDDEN_MEITUAN_ACTIONS: readonly string[] = Object.freeze([
  'purchase',
  'pay',
  'checkout',
  'place_order',
  'submit_order',
  '支付',
  '下单',
  '购买',
]);

/** 候选查询（`cap.meituan.search`）。 */
export const SEARCH_TOOL: ToolContract = {
  toolId: 'cap.meituan.search',
  template: MEITUAN_TEMPLATE,
  summary: '按品类/位置/人数/预算/日期/偏好查询**真实**候选；候选只能来自已授权接口',
  inputSchema: {
    fields: {
      category: { type: 'string', required: true, description: '品类（如"火锅"）' },
      location: { type: 'string', required: true, description: '位置/范围' },
      people: { type: 'number', required: false, description: '人数' },
      budgetYuan: { type: 'number', required: false, description: '人均或总预算（元）' },
      date: { type: 'string', required: false, description: '日期（YYYY-MM-DD）' },
      preferences: { type: 'string', required: false, description: '偏好（自由文本）' },
    },
  },
  outputSchema: {
    fields: {
      candidates: { type: 'array', required: true, description: '候选清单（每条带来源）' },
      visibility: { type: 'string', required: true, description: '查询条件与结果范围的可见说明' },
      status: {
        type: 'string',
        required: true,
        description: 'ok / not_ready / unavailable（不得以编造候选代替）',
        enumValues: ['ok', 'not_ready', 'unavailable'],
      },
    },
  },
  permissions: [{ permissionId: 'perm.network.read', required: true }],
  externalSideEffect: 'read',
  requiresConfirmation: false,
  idempotency: 'idempotent',
  queryable: true,
  undo: 'not_applicable',
  trustedReceipt: '已授权接口的原始响应（每条候选必须能指回其来源）',
};

/** 详情与费用（`cap.meituan.detail`）。 */
export const DETAIL_TOOL: ToolContract = {
  toolId: 'cap.meituan.detail',
  template: MEITUAN_TEMPLATE,
  summary: '读取可得详情、套餐/费用条件、时效与来源；价格/库存/营业/路线未知**分别标记**',
  inputSchema: {
    fields: {
      candidateId: { type: 'string', required: true, description: '候选 ID（须来自已授权接口）' },
    },
  },
  outputSchema: {
    fields: {
      price: { type: 'object', required: true, description: '标价（**不是**最终价，条件另列）' },
      stock: { type: 'object', required: true, description: '库存：已知或未知+原因' },
      businessHours: { type: 'object', required: true, description: '营业：已知或未知+原因' },
      route: { type: 'object', required: true, description: '路线：已知或未知+原因' },
    },
  },
  permissions: [{ permissionId: 'perm.network.read', required: true }],
  externalSideEffect: 'read',
  requiresConfirmation: false,
  idempotency: 'idempotent',
  queryable: true,
  undo: 'not_applicable',
  trustedReceipt: '已授权接口的原始响应',
};

/** 目标页交接（`cap.meituan.handoff`）。 */
export const HANDOFF_TOOL: ToolContract = {
  toolId: 'cap.meituan.handoff',
  template: MEITUAN_TEMPLATE,
  summary: '生成并校验目标页面交接，参数与当前选择绑定；**打开页面不等于写入**，**不直接购买/支付**',
  inputSchema: {
    fields: {
      candidateId: { type: 'string', required: true, description: '要交接的候选 ID' },
      selectionRevision: {
        type: 'number',
        required: true,
        description: '当前选择的版本（防止交接过期参数）',
      },
    },
  },
  outputSchema: {
    fields: {
      state: {
        type: 'string',
        required: true,
        description: '七态之一；不可回读的外部结果只能报"已交接/结果未知"',
        enumValues: ['prepared', 'handed_off', 'submitted', 'confirmed', 'unknown', 'user_reported', 'failed'],
      },
      target: { type: 'object', required: true, description: '交接目标（深链/App 方案）与校验结果' },
    },
  },
  permissions: [{ permissionId: 'perm.network.read', required: false }],
  externalSideEffect: 'handoff',
  requiresConfirmation: true,
  idempotency: 'keyed',
  // handoff 型**不可回读**（R246）：validateToolContract 会拒绝 queryable=true。
  queryable: false,
  undo: 'none',
  trustedReceipt: '**无**：目标页交接没有可信回执，外部结果不可读时保留未知',
};

export const MEITUAN_TOOLS: readonly ToolContract[] = Object.freeze([
  SEARCH_TOOL,
  DETAIL_TOOL,
  HANDOFF_TOOL,
]);

/**
 * 校验本模板的工具声明集合。**模块加载即可调用**，
 * 保证"工具合同不得自相矛盾"是机器可检查的，而不是口头约定。
 */
export function validateMeituanTools(): readonly string[] {
  const problems: string[] = [];
  for (const tool of MEITUAN_TOOLS) {
    problems.push(...validateToolContract(tool).map((text) => `${tool.toolId}: ${text}`));
    if (tool.externalSideEffect === 'irreversible') {
      problems.push(`${tool.toolId}: 出现不可撤销副作用——MT-08/R246 禁止直接购买/支付`);
    }
  }
  return problems;
}

/**
 * 断言某动作名**不是**购买/支付类。任何想给美团模板加"下单/支付"能力的改动
 * 都会在这里当场失败（R246）。
 */
export function assertNotPurchaseAction(actionName: string): void {
  const normalized = actionName.trim().toLowerCase();
  if (FORBIDDEN_MEITUAN_ACTIONS.includes(normalized)) {
    throw new Error(
      `美团模板不得包含"${actionName}"：合同 MT-08 / R246 明确「不直接购买/支付」。` +
        `打开页面不等于写入，更不等于下单。`,
    );
  }
}

/** 交接后外部结果**不可读**时的如实结论（MT-08 / R246）。 */
export function externalResultWithoutReadback(): {
  readonly state: 'unknown';
  readonly note: string;
} {
  return {
    state: 'unknown',
    note:
      '外部最终结果无法读取 ⇒ 保留「结果未知」。**不**把它记为购买成功，' +
      '也不因此盲目重试（R246 / R217）。若用户口头说完成，只能另记「用户报告完成」。',
  };
}

/** 该副作用强度是否允许出现在美团模板里。 */
export function isAllowedSideEffect(effect: SideEffect): boolean {
  return effect !== 'irreversible';
}
