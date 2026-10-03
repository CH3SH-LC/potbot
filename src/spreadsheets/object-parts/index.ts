/**
 * `src/spreadsheets/object-parts/` 的唯一出口（X07；XLS-12/14）。
 *
 * 本目录放「对象部件」的**独立只读**工具——它们不参与写侧组装，只从真实容器字节里
 * 把关系图解析出来做审计。当前内容见 `relationships.ts`。
 *
 * 对外可供交付前门禁使用的入口：`assertRelationshipsClean(bytes)`（通过返回回执，不通过抛错）。
 * 本出口**已**并入主索引 `src/spreadsheets/index.ts`（集成方落地），因此
 * `assertRelationshipsClean` / `auditRelationships` 可从 `src/spreadsheets/index.js` 直接取到。
 */

export * from './relationships.js';
