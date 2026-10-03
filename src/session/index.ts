/**
 * **通用交付会话包入口**（design-06 P8/P9 的产品入口）。
 *
 * | 关注点 | 文件 | 合同 |
 * |---|---|---|
 * | 文件格式轴（MIME / 扩展名 / 互不冒充） | `formats.ts` | R232 / R247 |
 * | 格式适配器接口（格式相关的唯一接缝） | `adapter.ts` | R232 / R247 |
 * | 形状（状态 / 版本映射 / 日志 / 幂等 / 端口） | `types.ts` | R141 / R145 / R146 |
 * | 会话（新建 / 导入 / 提交 / 恢复 / 状态） | `session.ts` | R141–R146 / R216 |
 * | 规范化指纹 | `canonical.ts` | R137 / R139 |
 * | 状态编解码（二进制与 Map 安全的 JSON） | `persistence.ts` | R216 |
 * | 具体格式适配器 | `adapters/xlsx.ts`、`adapters/pptx.ts` | R247–R250 |
 *
 * ## 与 `src/documents/session/**` 的分工
 *
 * 那边是**字处理会话**（段落 / 字符 / 节 / 列表语义 + `exportDocx`）；
 * 这边是**格式无关的交付会话**（生命周期 + 注入适配器）。两者本轮**并存**，
 * 收敛路径见 `.task-manifest/outputs/FA-T/interface-declaration.md` 的已知缺口。
 *
 * ## 本包不做
 *
 * DOCX 字节读写（`src/documents/docx/**`）、XLSX/PPTX 的模型与渲染
 * （`src/spreadsheets/**`、`src/presentations/**`）、内核暂存与发布
 * （`src/artifacts/**`）、HTTP（`apps/demo/server/**`）。
 */

export * from './types.js';
export * from './formats.js';
export * from './adapter.js';
export * from './canonical.js';
export * from './persistence.js';
export * from './session.js';
export * from './adapters/xlsx.js';
export * from './adapters/pptx.js';

export * from './adapters/cal-clock.js';

export * from './adapters/research-citations.js';

export * from './adapters/xlsx-print.js';

export * from './adapters/pptx-facts.js';

export * from './adapters/xlsx-io.js';
