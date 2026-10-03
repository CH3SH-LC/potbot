/**
 * 校对与内容包公开出口（WF-093–096；design-05-P9）。
 *
 * | 能力 | 文件 | 说明 |
 * |---|---|---|
 * | 符号与特殊字符（WF-093） | `symbols.ts` | 码位即真值；NBSP 可读回、不被规范化 |
 * | 字数与统计（WF-094） | `counts.ts` | 口径写死并可复算；页数**无引擎即未验证**（R158） |
 * | 拼写与语法检查（WF-095） | `spelling.ts` | 只产出提示+定位；接受才改，且只改那一处 |
 * | 文本语言（WF-096） | `language.ts` | BCP-47 校验；已接线到导出（`docx/language-render.ts`） |
 * | 选区翻译（WF-096） | `translation.ts` | 绑 revision、限选区、走模型预算、来源可读 |
 * | 显式注入端口（P9 收口） | `port.ts` | 就绪状态可查；**未接模型时如实 `not_ready`**，不伪造结果 |
 * | **K02 ModelPort 接线** | `model-port.ts` | 消费 K02：取消/过期不改稿；模型无输出报 `no_output`（**不是**通过）；预算超限 `budget_exceeded` |
 *
 * 测试夹具（桩翻译器/样例规则）在 `testing.ts`，**不从这里导出**（同选区包纪律）。
 * 纯函数、零 IO、**不接真实模型**。
 */

export * from './symbols.js';
export * from './counts.js';
export * from './spelling.js';
export * from './language.js';
export * from './translation.js';
export * from './port.js';
export * from './model-port.js';
