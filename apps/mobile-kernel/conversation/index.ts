/**
 * K04 连续对话 —— 对外 barrel。
 *
 * 目录归属：`apps/mobile-kernel/conversation/**`（K04 独占写区，见
 * `docs/other/ds-six-lanes-2026-10-03/KERNEL.md` 的 K04 行）。本包只**新建**手机侧模块，
 * 未改动 `src/conversation/**` 下任何既有文件（只 import 复用其类型与判据）、未改
 * `apps/demo/server/**`、未改任何共享配置。接入宿主是后续集成人的活。
 *
 * 读法建议（按依赖顺序）：`errors.ts`（失败码与结果类型）→ `types.ts`（落盘 schema、
 * 消息 / 事件形状、端口）→ `transcript.ts`（幂等发送 / 重试 / 分页 / 搜索 / 跨进程恢复）→
 * `resume.ts`（P0：跨进程续聊的当前文档恢复）→ `session-adapter.ts`（手机记录 ⇄ 内核会话语义）。
 *
 * 范围与已知局限见同目录 `README.md`。
 */

export * from './errors.js';
export * from './types.js';
export * from './transcript.js';
export * from './resume.js';
export * from './session-adapter.js';
