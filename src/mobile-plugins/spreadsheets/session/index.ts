/**
 * **表格手机会话包**（X10）唯一出口。
 *
 * | 文件 | 回答的问题 |
 * |---|---|
 * | `operations.ts` | 一个表格操作怎么作用到源上？（24 个 op，全部转调既有模块；含 X05 数据操作与 X02 结构复制移动） |
 * | `transaction.ts` | 一批操作怎么"全成或全不做"？版本怎么撤销 / 恢复？快照怎么落盘读回？ |
 * | `durable.ts` | 会话状态怎么变成一个**纯字符串**交给宿主落盘，载入时怎么核对不变量？ |
 * | `facts.ts` | 共享事实怎么发布（有回执才算数）、同版快照怎么消费（未接线不得声称同步）？ |
 *
 * 纪律：本包全部是纯逻辑，零 IO、零墙钟、零随机数（`durable.ts` 也只做 JSON 编解码，
 * 不 import `node:fs`）；落盘 / 联网由注入端口完成。
 */

export * from './operations.js';
export * from './transaction.js';
export * from './durable.js';
export * from './facts.js';
