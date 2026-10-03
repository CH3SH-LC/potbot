/**
 * F-I04 a11y 包出口（barrel）。
 *
 * 产品侧 ScreenSpec 生产者：把**渲染视图树**（`screen-spec.ts` 的 `ViewTree`）或
 * **Android 无障碍节点 dump**（`dump.ts` 的 `AndroidA11yDump`）转成
 * `tests/mobile-ui/F-R02/schema.ts` 的 `parseScreenSpec()` / `a11y.ts` 的
 * `auditScreen()` 可消费的 ScreenSpec。
 *
 * 唯一事实来源：最小触区阈值 `MIN_TARGET_DP` 直接来自 F01 令牌 `touch.minTargetDp`。
 *
 * 消费方式：`import { viewTreeToScreenSpec, androidDumpToScreenSpec } from '<...>/a11y/index.js'`。
 * 本包零依赖（仅依赖同包 foundation 令牌），不渲染、不连真机。
 */

export * from './screen-spec.js';
export * from './dump.js';
