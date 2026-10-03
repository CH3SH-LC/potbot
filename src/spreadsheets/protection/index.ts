/**
 * `src/spreadsheets/protection/` 公开出口（design-06-P8 / XLS-15）。
 *
 * 三部分：工作表保护（`sheet-protection.ts`，含单元格锁定语义与未知口令拒绝）、工作簿保护
 * （`workbook-protection.ts`）与**注入助手**（`worksheet-injection.ts`，把 `<sheetProtection>`
 * 按 CT_Worksheet 序列放进工作表）。三者共用遗留口令哈希。
 */

export * from './sheet-protection.js';
export * from './workbook-protection.js';
export * from './worksheet-injection.js';
