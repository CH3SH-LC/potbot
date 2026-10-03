/**
 * 手机 Word 会话插件包入口（W10；WF-081–088）。
 *
 * 分工：
 * | 关注点 | 文件 |
 * |---|---|
 * | 形状（工具面 / 回执 / 另存 / 事实契约） | `types.ts` |
 * | 事实订阅与消费（版本校验 + 实际消费回执） | `facts-consumer.ts` |
 * | 工具面接线（多会话 / 另存副本 / 撤销重做 / 重开 / FactsPort 注入） | `word-session-plugin.ts` |
 * | 剪贴板 / IME 内容事务（`paste` / `cut` / `imeCommit` / `imeDeleteSurrounding` + `contentUndo`） | `word-session-plugin.ts` |
 *
 * 内容语义（一次提交 = 一个事务 = 一个编辑版本）在 `src/documents/session/**`，
 * 本包**不重写**它，只把它接成手机可调用的工具面。
 *
 * 接线请求（**本包未做，需要在别处登记**）：`src/mobile-plugins/**` 目前没有统一的插件
 * barrel（`grep` 过 `apps/` 与 `src/`），因此本包没有被任何注册表/barrel 再导出；
 * 若手机宿主需要"列出可用插件"，需要在那里显式加入 `word/session`。
 */

export * from './types.js';
export * from './facts-consumer.js';
export * from './word-session-plugin.js';
