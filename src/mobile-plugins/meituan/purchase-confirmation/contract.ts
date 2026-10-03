/**
 * M06 升级后的美团业务合同（v2）——**动作表与不变量**（零依赖、纯数据 + 纯函数）。
 *
 * ## 从 v1 到 v2 到底改了什么
 *
 * 旧合同 `src/adapters/meituan/contract.ts` 的态度是**直接禁止**：
 * `FORBIDDEN_MEITUAN_ACTIONS` 含 `purchase / pay / checkout / place_order / submit_order`，
 * 且 `assertNotPurchaseAction` 见到它们当场抛错——因为当时「没有真实接口与账号，
 * 任何能查候选的实现都只能是编造」。
 *
 * 本次用户授权开发下单能力，于是升级（不是删除）这条边界：
 * - **新增**下单/支付/取消三个动作进合同，并**允许**它们被登记；
 * - 但它们**必须**携带一次性用户确认（`requiresUserConfirmation: true`）且
 *   **永不**允许自主执行（`autonomousAllowed: false`，字面量）。
 *
 * 保护没有消失：旧合同问的是「这个动作能不能存在」，新合同问的是
 * 「这个动作在**什么条件下**才被允许执行」。给动作加 `scope` 与确认要求，
 * 正是把旧的静态禁止换成运行期可核对的授权链。
 *
 * ## 独立复核用的对照
 *
 * `tests/mobile-meituan/M06/contract.test.ts` 断言：
 * 1. 一切 `mutatesExternalWorld` 的规则 `requiresUserConfirmation` 必为 true 且
 *    `autonomousAllowed` 必为 false（合同不得自相矛盾）；
 * 2. `assertAutonomousPurchaseForbidden` 对下单/支付/取消一律抛 `autonomous_purchase_forbidden`；
 * 3. 只读动作（搜店/菜单/地址/计价/查询）依然无需确认。
 */

import { PurchaseConfirmationError } from './errors.js';
import {
  CONFIRM_SCOPES,
  MEITUAN_ACTION_KINDS,
  MEITUAN_BUSINESS_CONTRACT_VERSION,
  type ConfirmScope,
  type MeituanActionKind,
  type MeituanActionRule,
} from './types.js';

/**
 * 本版业务合同的动作表。**这是唯一的事实来源**——不在别处另造动作词表。
 */
export const MEITUAN_ACTION_CONTRACT: Readonly<Record<MeituanActionKind, MeituanActionRule>> = Object.freeze({
  'search-merchant': {
    actionId: 'search-merchant',
    mutatesExternalWorld: false,
    requiresUserConfirmation: false,
    requiredScope: null,
    autonomousAllowed: true,
    summary: '按品类/位置查询真实商家候选；候选只能来自已授权接口。',
  },
  'read-menu': {
    actionId: 'read-menu',
    mutatesExternalWorld: false,
    requiresUserConfirmation: false,
    requiredScope: null,
    autonomousAllowed: true,
    summary: '读取商家菜单 / SKU / 规格；未知不补造。',
  },
  'read-address': {
    actionId: 'read-address',
    mutatesExternalWorld: false,
    requiresUserConfirmation: false,
    requiredScope: null,
    autonomousAllowed: true,
    summary: '读取已绑定地址与其版本（引用，不含明文）。',
  },
  'price-quote': {
    actionId: 'price-quote',
    mutatesExternalWorld: false,
    requiresUserConfirmation: false,
    requiredScope: null,
    autonomousAllowed: true,
    summary: '请求服务端计价；本地不重算价格。',
  },
  'prepare-purchase': {
    actionId: 'prepare-purchase',
    mutatesExternalWorld: false,
    requiresUserConfirmation: false,
    requiredScope: null,
    autonomousAllowed: true,
    summary: '组装订单参数与确认 ViewModel；**不发出任何外部写入**。',
  },
  'submit-order': {
    actionId: 'submit-order',
    mutatesExternalWorld: true,
    requiresUserConfirmation: true,
    requiredScope: 'submit-order',
    autonomousAllowed: false,
    summary: '提交订单——必须携带一次性用户确认，且不得自主执行。',
  },
  'pay-order': {
    actionId: 'pay-order',
    mutatesExternalWorld: true,
    requiresUserConfirmation: true,
    requiredScope: 'payment',
    autonomousAllowed: false,
    summary: '发起支付——必须经平台许可流程并由用户完成，不得自主支付或代填凭据。',
  },
  'cancel-order': {
    actionId: 'cancel-order',
    mutatesExternalWorld: true,
    requiresUserConfirmation: true,
    requiredScope: 'external-mutation',
    autonomousAllowed: false,
    summary: '取消 / 退款请求——改动外部世界，必须有确认。',
  },
  'query-order': {
    actionId: 'query-order',
    mutatesExternalWorld: false,
    requiresUserConfirmation: false,
    requiredScope: null,
    autonomousAllowed: true,
    summary: '查询订单状态（结果未知时唯一合法动作）；只读。',
  },
});

/** 合同动作表的有序清单（导出常量，便于遍历与证据）。 */
export const MEITUAN_ACTION_RULES: readonly MeituanActionRule[] = Object.freeze(
  MEITUAN_ACTION_KINDS.map((kind) => MEITUAN_ACTION_CONTRACT[kind]),
);

/** 改动外部世界、因而必须带确认的动作（合同内部推导出来的，不是手抄的清单）。 */
export const MUTATING_MEITUAN_ACTIONS: readonly MeituanActionKind[] = Object.freeze(
  MEITUAN_ACTION_RULES.filter((rule) => rule.mutatesExternalWorld).map((rule) => rule.actionId),
);

function isKnownAction(actionId: string): actionId is MeituanActionKind {
  return (MEITUAN_ACTION_KINDS as readonly string[]).includes(actionId);
}

/** 取一条动作的合同规则；未知动作抛 `action_not_in_contract`（不静默当只读）。 */
export function actionRuleOf(actionId: string): MeituanActionRule {
  if (!isKnownAction(actionId)) {
    throw new PurchaseConfirmationError(
      'action_not_in_contract',
      `动作 ${JSON.stringify(actionId)} 不在本版美团业务合同（${MEITUAN_BUSINESS_CONTRACT_VERSION}）里；` +
        `合同登记的动作：${MEITUAN_ACTION_KINDS.join(' / ')}`,
      'actionId',
    );
  }
  return MEITUAN_ACTION_CONTRACT[actionId];
}

/**
 * 断言动作要求的范围与给定的范围一致。
 * 只读动作（`requiredScope: null`）不接受任何范围。
 */
export function assertScopePermitted(actionId: string, scope: ConfirmScope | null): void {
  const rule = actionRuleOf(actionId);
  if (!(CONFIRM_SCOPES as readonly string[]).includes(scope as string) && scope !== null) {
    throw new PurchaseConfirmationError(
      'scope_not_permitted',
      `范围 ${JSON.stringify(scope)} 不是契约 scope enum（${CONFIRM_SCOPES.join(' / ')}）`,
      'scope',
    );
  }
  if (rule.requiredScope === null) {
    if (scope !== null) {
      throw new PurchaseConfirmationError(
        'scope_not_permitted',
        `只读动作 ${actionId} 不接受范围，收到 ${JSON.stringify(scope)}`,
        'scope',
      );
    }
    return;
  }
  if (scope !== rule.requiredScope) {
    throw new PurchaseConfirmationError(
      'scope_not_permitted',
      `动作 ${actionId} 要求的范围是 ${rule.requiredScope}，收到 ${JSON.stringify(scope)}——` +
        `范围不符即不得执行`,
      'scope',
    );
  }
}

/**
 * **自主购买的硬闸门**：任何改动外部世界的动作，若无用户确认就走这条路，一律拒绝。
 *
 * 这是旧合同 `assertNotPurchaseAction` 在新架构下的继承者：
 * 它不再问「动作能不能存在」，而是问「**未经用户确认**的自主路径敢不敢执行」——
 * 答案恒为「不敢」（`autonomous_purchase_forbidden`）。
 *
 * @param actionId 待执行动作
 * @param hasUserConfirmation 调用方是否持有可信的一次性用户确认
 */
export function assertAutonomousPurchaseForbidden(actionId: string, hasUserConfirmation: boolean): void {
  const rule = actionRuleOf(actionId);
  if (rule.mutatesExternalWorld && !hasUserConfirmation) {
    throw new PurchaseConfirmationError(
      'autonomous_purchase_forbidden',
      `动作 ${actionId}（${rule.summary}）改动外部世界，但未携带用户确认：` +
        `自主购买/支付一律禁止——必须先取得一次性原生确认`,
      'actionId',
    );
  }
}

/** 合同的静态自检：返回问题清单（空数组 = 自洽）。模块加载即可调用。 */
export function validateMeituanBusinessContract(): readonly string[] {
  const problems: string[] = [];
  for (const rule of MEITUAN_ACTION_RULES) {
    if (rule.mutatesExternalWorld) {
      if (!rule.requiresUserConfirmation) {
        problems.push(`${rule.actionId}: 改动外部世界却未要求用户确认`);
      }
      if (rule.autonomousAllowed !== false) {
        problems.push(`${rule.actionId}: 改动外部世界却允许自主执行`);
      }
      if (rule.requiredScope === null) {
        problems.push(`${rule.actionId}: 改动外部世界却没有范围`);
      }
    } else {
      if (rule.requiresUserConfirmation) {
        problems.push(`${rule.actionId}: 只读动作却要求用户确认`);
      }
      if (rule.requiredScope !== null) {
        problems.push(`${rule.actionId}: 只读动作却声明了范围`);
      }
    }
    if (rule.requiredScope !== null && !(CONFIRM_SCOPES as readonly string[]).includes(rule.requiredScope)) {
      problems.push(`${rule.actionId}: 范围 ${rule.requiredScope} 不在契约 scope enum 内`);
    }
  }
  return Object.freeze(problems);
}
