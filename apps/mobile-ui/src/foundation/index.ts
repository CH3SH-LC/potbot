/**
 * F01 foundation 包出口（barrel）。
 *
 * 消费方式：`import { themeSnapshot, getControl, tokenContrastAudit } from '<...>/foundation/index.js'`。
 * 本包零依赖、纯 TS、框架无关；不触碰网络 / 文件 / 时钟 / 随机数 / `KernelClient`。
 *
 * 覆盖范围（对应 design-07 v6）：
 *   - `tokens.ts`   设计令牌唯一来源（颜色/字号/间距/触区/圆角/动效/断点/入口），逐项带出处行号
 *   - `layout.ts`   布局壳结构描述（header/main/tabbar、断点、输入区定位）
 *   - `controls.ts` 基础控件规格 + 校验 + 色调映射（触区/字号/色角色/焦点/可访问名称）+ CSS 变量投影
 *   - `contrast.ts` WCAG 对比度计算与 token 配对实测（对比度合格证据）
 *   - `safe-area.ts` 安全区换算（内容 padding、输入区偏移、铰链/挖孔/手势禁止区）+ 宿主注入钩子
 *   - `theme.ts`    扁平可序列化主题快照 + 品牌素材描述符 + CSS 变量投影（含 fontScale）
 *
 * 本包**未做**（本轮范围外，交付时如实标注，不算作已完成）：
 *   - 真实渲染：不生成 DOM / Android View，`layout.ts`/`controls.ts` 只出结构描述与规格数据。
 *     软键盘避让、真实滚动、原生 View 层级未实现、未真机验证。
 *   - 可访问性运行时：只提供「需要可访问名称」的**规则与断言函数**，未接 TalkBack / 焦点引擎；
 *     200% 字号走查、横屏/折叠屏实机未做。
 *   - 对比度：只算 token 配对；未做真机亮度/夜间/外接屏实测，未做端到端可访问性验收。
 *   - 品牌素材：只描述「引用原图、不重绘」，未做图片解码/裁剪/多密度切图，未接入打包。
 *   - 安全区：只做数值换算，真实 inset 由调用方注入；未读取系统 inset，未真机验证。
 *   - `KernelClient`：本包不涉及任何命令/事件，不发请求、不订阅。
 *
 * 类型检查说明：根 `tsconfig.json` 的 `include` 为 ["src","tests"]，**不覆盖**
 * `apps/mobile-ui/`；本包由 vitest(esbuild) 转译执行。为 mobile-ui 建独立 tsconfig/构建清单
 * 属 F 线协调者单写，见交付时的 integrationRequests。
 */

export * from './tokens.js';
export * from './layout.js';
export * from './controls.js';
export * from './contrast.js';
export * from './safe-area.js';
export * from './theme.js';

import { controlsCssVariables } from './controls.js';
import { themeCssVariables, type ThemeCssOptions } from './theme.js';

/**
 * 壳与各模块消费的**单点** CSS 变量表：主题（`themeSnapshot()`）+ 控件
 * （`listControls()`）投影合并。消费方只需这一张表 + `renderCssVariables()`，
 * 不得各自从 tokens 里挑值。
 */
export function foundationCssVariables(options: ThemeCssOptions = {}): Readonly<Record<string, string>> {
  return { ...themeCssVariables(options), ...controlsCssVariables(options) };
}
