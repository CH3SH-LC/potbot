/**
 * F-APP 组合根出口（barrel）—— 把 F 线前端库拼成**可交付页面**的入口。
 *
 * 消费方式（编译后）：
 *   `import { renderScreenDocument, renderScreenText, listScreens } from '<...>/app/index.js'`
 *
 * 三个文件：
 *   - `fixtures.ts`  夹具数据 + 诚实标签（数据源缝合点，换成真实适配层即可）
 *   - `pages.ts`     registry + navigation + screens → `ViewNode` 树
 *   - `document.ts`  `ViewNode` → 完整 HTML 文档 / 可访问性文本
 *
 * 与兄弟包的边界：本包**只做装配**，不重写 shell / render / foundation / files。
 * 本包不连内核、不发命令、不落盘、不建网络服务——服务是 spike，见
 * `apps/mobile-ui/spikes/serve-mobile-ui.mjs`。
 */

export * from './fixtures.js';
export * from './pages.js';
export * from './document.js';
