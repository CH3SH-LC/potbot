/**
 * 选区与范围包入口（design-05 P1/P8 的选区底座）。
 *
 * 对应合同：R102（码位偏移）、R104（空白/软换行保真）、R111–R116（范围解析）、
 * R114/R143（选区随 revision 失效）、WF-085（查找半边）、WF-088（选区与取文）。
 */

export * from './types.js';
export * from './codepoint.js';
export * from './equals.js';
export * from './inline-map.js';
export * from './structure.js';
export * from './find.js';
export * from './expression.js';
export * from './resolve.js';
export * from './selection.js';
export * from './expand.js';
export * from './clipboard.js';
