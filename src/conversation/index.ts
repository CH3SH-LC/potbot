/**
 * **会话与任务模型包入口**（完整能力目录 2026-10-03：CHAT-02 / CHAT-05 / CHAT-08）。
 *
 * | 能力 | 文件 | 回答什么 |
 * |---|---|---|
 * | CHAT-02 | `session-model.ts` | 新建/切换/重命名/归档/删除会话；历史持久化、分页/搜索、重开恢复；**会话之间不串任务或记忆** |
 * | CHAT-05 | `session-tasks.ts` | 同一会话多个任务；多个会话并行；任务卡/进度/文件/等待条件/决策气泡**各自归位** |
 * | CHAT-08 | `delete-semantics.ts` | 删除会话 / 取消任务 / 删除文件 / 忘记记忆**四类语义分开**；删了聊天不停未获准动作；**不假称撤销副作用** |
 *
 * ## 与既有 `apps/demo/server/conversation-store.ts` 的关系（**已知缺口，如实登记**）
 *
 * 宿主侧已有一个"连续对话的持久状态机"（FA-N；消息 / 事件 / 游标）。本包**不碰**它，
 * 也不改 `apps/**`——本包是**内核侧**的会话与任务归位模型，聚焦"会话集合 + 任务归位 +
 * 删除语义"三件事。两者**尚未收敛**为一个真相源（消息正文在宿主侧，会话/任务归位在内核侧）；
 * 收敛路径与缺口记在交付说明里，本轮**不做**。
 *
 * ## 部署就绪
 *
 * 会话模型**必须注入持久端口**才谈得上"刷新后还在"：
 * `createConversationSessions({ persistence: null }).readiness()` 返回
 * `{ ready: false, reason: 'no_persistence_port' }`——**未验证**不等于"能用"。
 *
 * ## 不做的事
 *
 * 不做 IO（端口注入）、不发请求、不产文件、不做 HTTP / 界面、不碰内核调度。
 * 纯数据 + 纯逻辑 + 注入接缝。
 */

export * from './session-model.js';
export * from './session-tasks.js';
export * from './delete-semantics.js';

export * from './turn-model.js';
export * from './run-constraints.js';
export * from './decision-bubble.js';

export * from './adapter-to-store.js';
