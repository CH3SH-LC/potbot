/**
 * F-I03 render 包出口（barrel）。
 *
 * 消费方式（NodeNext，带 `.js` 后缀）：
 *   import { renderHtml, renderText, accessibilityTree } from '<...>/render/index.js';
 *
 * 本包零运行时依赖、纯 TS、框架无关；不触碰网络 / 文件 / 时钟 / 随机数 /
 * `KernelClient`。三块：
 *   - `view.ts`       声明式 ViewNode 模型 + 令牌约束的样式 + fail-closed 校验
 *   - `render-html.ts`确定性 HTML 字符串序列化（转义 + 固定属性/样式顺序）
 *   - `render-text.ts`文本 / 可访问性序列化（可访问性树 + 逐行朗读文本）
 *
 * 本包**未做**（本轮范围外，如实标注，不算完成）：
 *   - 布局求解：不产 dp 坐标 / 不排版；host 需要自行测量。
 *   - Android View：不构造原生 View、不绑定事件、不做软键盘/安全区。
 *   - 事件与交互：ViewNode 只描述静态结构，无 onClick/状态机。
 *   - 真机渲染：无 on-device 证据；HTML 输出可在浏览器预览但不等价于安卓真机。
 *   - `KernelClient`：本包不发命令、不订阅事件。
 */

export * from './view.js';
export * from './render-html.js';
export * from './render-text.js';
