/**
 * M-I22 夹具：**统一金额 wire 边界一致性**（不是被收集的用例文件）。
 *
 * 本单元是「波 1 之后的集成波」，只新建 `tests/mobile-meituan/M-I22/**`，不改任何
 * 被测源码。三个金额编解码器此刻**并存**于仓库：
 *
 * 1. `src/mobile-plugins/meituan/cart/money.ts`（M04：`minorUnitsToWireAmount` /
 *    `wireAmountToMinorUnits`）——integration request 点名要求 M06/M07 消费它；
 * 2. `apps/mobile-kernel/actions/wire-codec.ts`（K07：`formatWireAmount` /
 *    `parseWireAmount`）——K07 声称与判据隔离、不 import 判据模块；
 * 3. `apps/mobile-ui/src/decisions/trust.ts`（F05：`defaultWireBridge`）——F05 声称
 *    "生产不 import K07，故此实现内联"。
 *
 * 三者在**生产代码里互不 import**（各自注明理由），因此没有任何一处能替它们证等价。
 * 本夹具把它们拉到一起做**运行时对照**：同一 (整数最小单位, 币种) 三元组必须产出同一
 * wire 字符串；同一 wire 字符串必须解析回同一整数。凡口径不一致处，本套件**如实断言**
 * 该分歧（不是假装它们相同），并落进残差交给对应线负责人。
 *
 * 冻结契约的 `amount` / `currency` 正则**运行时**从
 * `contracts/mobile-v1/schemas/confirm-action.schema.json` 读出，绝不在测试里另抄一份。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  CartSession,
  FixtureClock,
  createFixtureQuotePort,
  type Quote,
} from '../../../src/mobile-plugins/meituan/cart/index.js';

/** 逻辑时间原点（非零，暴露"偷偷按 0 起始"的错误）。 */
export const T0 = 1_000_000;

/** 报价有效期。 */
export const QUOTE_TTL_MS = 300_000;

/** 标准账号引用（引用，不是凭据）。 */
export const ACCOUNT_REF = 'acct:meituan:7788';

/** 标准任务版本。 */
export const TASK_REVISION = 7;

/** 标准动作实例 id。 */
export const ACTION_ID = 'act-m-i22';

/** 标准确认期限终点（注入时钟域）。 */
export const CONFIRM_EXPIRES = T0 + QUOTE_TTL_MS;

/** 冻结契约 schema 的路径（相对本夹具的 URL）。 */
export const CONFIRM_ACTION_SCHEMA_URL = new URL(
  '../../../contracts/mobile-v1/schemas/confirm-action.schema.json',
  import.meta.url,
);

/** 冻结契约里我们关心的那一小片（只声明会被读取的键，避免把 schema 抄成类型）。 */
export interface ConfirmActionSchemaShape {
  readonly $id: string;
  readonly required: readonly string[];
  readonly additionalProperties: boolean;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly $defs: {
    readonly amount: { readonly type: string; readonly pattern: string };
    readonly currency: { readonly type: string; readonly pattern: string };
    readonly timestamp: { readonly type: string; readonly pattern: string };
    readonly scope: { readonly enum: readonly string[] };
  };
}

/** 运行时读出冻结的 confirm-action schema（只读文件，不写入）。 */
export function loadConfirmActionSchema(): ConfirmActionSchemaShape {
  const path = fileURLToPath(CONFIRM_ACTION_SCHEMA_URL);
  return JSON.parse(readFileSync(path, 'utf8')) as ConfirmActionSchemaShape;
}

/** 由冻结 schema 现场编译出 wire 正则（不在测试里手写 pattern）。 */
export function loadWirePatterns(): {
  readonly amount: RegExp;
  readonly currency: RegExp;
  readonly timestamp: RegExp;
  readonly raw: { readonly amount: string; readonly currency: string };
} {
  const schema = loadConfirmActionSchema();
  return {
    amount: new RegExp(schema.$defs.amount.pattern),
    currency: new RegExp(schema.$defs.currency.pattern),
    timestamp: new RegExp(schema.$defs.timestamp.pattern),
    raw: { amount: schema.$defs.amount.pattern, currency: schema.$defs.currency.pattern },
  };
}

/**
 * 用注入端口造一份**确定性**报价（无网络、无系统时间）。
 *
 * 面条 3800×2 + 茶 800×1 = 8400；打包费 100 + 配送费 300 = 400 ⇒ 8800 最小单位。
 * 币种由调用方给出：对 `JPY` 而言 8800 就是 8800 日元（0 位小数的币种域内恒为整数）。
 */
export async function fixtureQuote(currency = 'CNY'): Promise<Quote> {
  const clock = new FixtureClock(T0);
  const port = createFixtureQuotePort({
    unitAmountsMinor: { 'sku-noodle': 3800, 'sku-tea': 800 },
    fees: [{ code: 'packaging', label: '打包费', amountMinor: 100 }],
    deliveryFeeMinor: 300,
    ttlMs: QUOTE_TTL_MS,
  });
  const session = new CartSession({ merchantId: 'merchant-1', currency, port, clock });
  session.cart.addLine({ dishId: 'dish-noodle', skuId: 'sku-noodle', quantity: 2 });
  session.cart.addLine({ dishId: 'dish-tea', skuId: 'sku-tea', quantity: 1 });
  session.cart.setDeliveryAddress('addr-home');
  return session.requestQuote();
}

/**
 * 覆盖三类小数位的样品：(整数最小单位, 币种, 期望 wire)。期望值由 ISO-4217 位数推出，
 * 与任何编解码器无关——用来做**三方对照**而非自证。
 */
export const MINOR_WIRE_CASES: readonly {
  readonly minor: number;
  readonly currency: string;
  readonly wire: string;
}[] = Object.freeze([
  { minor: 0, currency: 'CNY', wire: '0.00' },
  { minor: 5, currency: 'CNY', wire: '0.05' },
  { minor: 1234, currency: 'CNY', wire: '12.34' },
  { minor: 8800, currency: 'CNY', wire: '88.00' },
  { minor: 999999999, currency: 'CNY', wire: '9999999.99' },
  { minor: 0, currency: 'USD', wire: '0.00' },
  { minor: 1234, currency: 'USD', wire: '12.34' },
  { minor: 0, currency: 'JPY', wire: '0' },
  { minor: 5, currency: 'JPY', wire: '5' },
  { minor: 8800, currency: 'JPY', wire: '8800' },
  { minor: 0, currency: 'KRW', wire: '0' },
  { minor: 1234, currency: 'KRW', wire: '1234' },
  { minor: 1234, currency: 'KWD', wire: '1.234' },
  { minor: 5, currency: 'KWD', wire: '0.005' },
  { minor: 1, currency: 'KWD', wire: '0.001' },
  { minor: 1234, currency: 'BHD', wire: '1.234' },
]);

/** 三个编解码器**都**认的币种（用于严格等价对照）。 */
export const SHARED_CURRENCIES: readonly string[] = Object.freeze([
  'CNY',
  'USD',
  'EUR',
  'GBP',
  'HKD',
  'TWD',
  'SGD',
  'AUD',
  'CAD',
  'JPY',
  'KRW',
  'VND',
  'CLP',
  'ISK',
  'BHD',
  'KWD',
  'OMR',
  'TND',
  'JOD',
  'IQD',
  'LYD',
]);
