/**
 * F-UI01 shell 包出口（barrel）。
 *
 * 消费方式：
 *   `import { buildHomeModel, SCREEN_REGISTRY, pushScreen } from '<...>/shell/index.js'`。
 *
 * 覆盖范围（本单元「壳 + 导航注册表」）：
 *   - `screens.ts`    四入口外壳屏幕模型：四入口（对话/群组/文件/我的）+ 细橙色选中下划线、
 *                     首页近期活动成果卡 + 其余近期对话、底部输入区（键盘上方 / 安全区感知）；
 *   - `registry.ts`   唯一导航注册表：按规范顺序枚举每个模块的屏幕 id，拒绝重复 / 缺失 / 未登记；
 *   - `navigation.ts` 导航栈：不可变栈 + 每页滚动锚点，根节点 pop 不下溢、超深拒绝。
 *
 * 只读消费 F01 foundation（`themeSnapshot()` / `getControl()` / `listControls()` /
 * `layoutShell()` / `inputBarOffset()` / `contentPadding()`），**不重推颜色**，foundation 是
 * 单一 token 来源。
 *
 * 本包**未做**（本轮范围外，如实标注，不算作已完成）：
 *   - 真实渲染：不生成 DOM / Android View，只出可断言的视图模型；滚动、View 层级、软键盘
 *     避让未实现、未真机验证。
 *   - 真实 IME / 系统 inset：安全区与键盘高度由宿主注入，本包只做换算（foundation safe-area），
 *     未读取系统 inset。
 *   - `KernelClient`：本包不发命令、不订阅事件；近期成果/近期对话的数据由调用方注入。
 *   - 各业务模块的具体屏幕：本注册表只登记屏幕 id 与归属，不含 F02–F10 的页面实现；
 *     业务数据（成果卡、对话行）需由适配层把 F03/F06 视图映射为本包输入形状。
 */

export * from './screens.js';
export * from './registry.js';
export * from './navigation.js';
