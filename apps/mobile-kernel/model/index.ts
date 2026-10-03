/**
 * K02 手机内核模型端口 —— 对外 barrel。
 *
 * 目录归属：`apps/mobile-kernel/model/**`（K02 独占写区，见
 * `docs/other/ds-six-lanes-2026-10-03/KERNEL.md` 的 K02 行）。契约来源
 * `contracts/mobile-v1/schemas/model-port.schema.json`（只读，本包未改）。
 *
 * 读法建议（按依赖顺序）：`types.ts`（契约形状）→ `errors.ts`（拒因词表）→
 * `cancellation.ts`（可订阅取消）→ `transport.ts`（注入端口与假 transport）→
 * `redact.ts`（脱敏记录）→ `port.ts`（请求构造 / 流映射 / 运行）→
 * `tools.ts`（工具循环 / 幂等账本 / 结果配对）。
 *
 * **未做**：真实 HTTPS 传输、真实分词、真实工具执行器。本包只定义端口并用假 transport/
 * 假执行器做确定性验收；任何"手机已直连 deepseek-flash"的说法都必须另有真机证据。
 *
 * **keyRef 来源（K03 集成）**：`keyRef` 不再由本包写死——`buildModelRequest` /
 * `createModelPort` 接受可选注入的 `keyRefProvider`，缺省委托 K03 安全包的 `DEFAULT_KEY_REFS`。
 * 宿主可注入 `(kind) => keyManager.status(kind).keyRef`。无论来源，出口一律过
 * `KEY_REF_PATTERN` + 明文内容双重判据（`DEFAULT_KEY_REF_PROVIDER` 见 `port.ts`）。
 */

export * from './types.js';
export * from './errors.js';
export * from './cancellation.js';
export * from './transport.js';
export * from './redact.js';
export * from './port.js';
export * from './tools.js';
