/**
 * `src/documents/units` —— **全项目唯一的单位换算与中文字号表**（合同 R127–R131）。
 *
 * 纪律：除本包外，任何模块**不得自行换算**。需要"12pt 是多少半点""2 字缩进写哪个属性"
 * "1.5 倍行距的 w:line 是多少"时，一律调用这里的函数。已存在的换算魔数（20 / 240 / 100 /
 * 567 / 2）只应出现在 `constants.ts`。
 */

export * from './constants.js';
export * from './length.js';
export * from './font-size.js';
export * from './line-spacing.js';
export * from './paragraph-spacing.js';
export * from './indent.js';
export * from './tab-stop.js';
export * from './format-params.js';
