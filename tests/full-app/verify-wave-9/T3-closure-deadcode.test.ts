/**
 * FA-VERIFY-WAVE-9 · 任务第 1 项（续）—— 死判据 / 死导出 / 空断言的**静态复现**。
 *
 * 覆盖：V-1（late-result-gate 字面量死闸门）、V-2（export-handoff editable）、V-3（honored_as_success
 * 同名不同型）、V-9（xls-io 死模块）、V-10（checkToolCall 死导出）、V-4/V-5（跨包七态/幂等键）、
 * Q-1..Q-6（空断言/自证）、N-5-2/N-5-3，以及**两次"半截接线"事故**的派发是否仍在。
 *
 * 判据：全部取自**验证方自读源码**（注释已剥离），或**自有调用点计数器**；不引用实现者说法。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { countCalls, codeOf, findReferences, rawOf } from './source-probe.js';

const ROOT = process.cwd();
const has = (text: string, needle: string): boolean => text.includes(needle);

// ---------------------------------------------------------------------------
// V-1 / V-2 / V-3 —— 字面量类型造成的死判据
// ---------------------------------------------------------------------------

describe('W9-V-1 · late-result-gate 的「假称撤销」死判据', () => {
  it('V-1 未修：`effect.reverted !== false` 仍在代码里（5 处）', () => {
    const code = codeOf(ROOT, 'src/scheduler/late-result-gate.ts');
    const hits = [...code.matchAll(/effect\.reverted !== false/g)];
    // eslint-disable-next-line no-console
    console.log(`[W9 V-1] late-result-gate code hits = ${String(hits.length)}`);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('V-1 未修：`reverted` 仍是字面量 `false`（判据的结构性前提未变）', () => {
    const code = codeOf(ROOT, 'src/workledger/action-ledger.ts');
    expect(has(code, 'reverted: false')).toBe(true);
  });
});

describe('W9-V-2 · export-handoff 的 editable 自检', () => {
  it('V-2 已修：`editable_pptx.editable !== true` 这条**不可达检查已被移除**', () => {
    const code = codeOf(ROOT, 'src/presentations/export-handoff.ts');
    expect(has(code, 'editable_pptx.editable !== true')).toBe(false);
  });

  it('V-2：`editable` 仍是字面量 `true`（类型级事实不变，变的是检查方式）', () => {
    const code = codeOf(ROOT, 'src/presentations/export-handoff.ts');
    expect(has(code, 'readonly editable: true')).toBe(true);
  });
});

describe('W9-V-3 · honored_as_success 同名不同型', () => {
  it('V-3 未修：task-lifecycle 侧仍是字面量 `false`', () => {
    const code = codeOf(ROOT, 'src/scheduler/task-lifecycle.ts');
    expect(has(code, 'honored_as_success: false')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// V-9 / V-10 —— 死模块 / 死导出
// ---------------------------------------------------------------------------

const XLS_IO_SYMBOLS = [
  'importCsvWorkbook',
  'exportWorkbookCsv',
  'openWorkbookDocument',
  'saveWorkbookDocument',
  'saveWorkbookDocumentAs',
  'createWorkbookDocument',
  'XLS18_FACT_PUBLICATION_PORT',
];

describe('W9-V-9 · xls-io 是否仍是死模块', () => {
  it('V-9 部分修：符号已被 `xlsx-io.ts` 按名引用 —— 但引用者自身只经 barrel 可达', () => {
    const refs = findReferences(ROOT, XLS_IO_SYMBOLS);
    const files = [...new Set(refs.map((r) => r.file))].sort();
    // eslint-disable-next-line no-console
    console.log(`[W9 V-9] xls-io symbol references (non-test): ${files.join(', ')}`);
    expect(files).toContain('src/session/adapters/xlsx-io.ts');

    // 引用者 xlsx-io.ts 自己是否被**产品文件**（apps/**）按名使用？
    const xlsxIoRefs = findReferences(ROOT, [
      'WorkbookDocumentIoAdapter',
      'createWorkbookDocumentIo',
      'xlsxIo',
    ]).filter((r) => r.file.startsWith('apps/'));
    // eslint-disable-next-line no-console
    console.log(`[W9 V-9] apps/** references to xlsx-io symbols: ${JSON.stringify(xlsxIoRefs)}`);
    // 不预设结论：把事实打出来（供报告判定"真用 / 只 import"）。
    expect(files).toContain('src/session/adapters/xlsx-io.ts');
  });
});

describe('W9-V-10 · checkToolCall 死导出', () => {
  it('V-10 已修：非测试代码里 `checkToolCall(` 已有 1 个调用点（apps/demo/server/krn-barrel.ts）', () => {
    const calls = countCalls(ROOT, ['checkToolCall']).filter(
      (c) => c.file !== 'src/scheduler/permission-check.ts',
    );
    // eslint-disable-next-line no-console
    console.log(`[W9 V-10] checkToolCall call sites (non-test): ${JSON.stringify(calls)}`);
    // 判别力：删掉 krn-barrel.ts 的那处调用 ⇒ 列表变回空 ⇒ 本行重新变红（第六轮此处即为空）。
    expect(calls.map((c) => c.file)).toEqual(['apps/demo/server/krn-barrel.ts']);
    expect(calls.every((c) => c.line > 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// V-4 / V-5 —— 跨包口径
// ---------------------------------------------------------------------------

describe('W9-V-4/V-5 · 跨包口径分叉现状', () => {
  it('V-4/V-5：clock 与 workledger 的七态键名**仍不同**（分歧未在词表层消除）', () => {
    const clock = codeOf(ROOT, 'src/adapters/clock/action-contract.ts');
    const ledger = codeOf(ROOT, 'src/workledger/action-ledger.ts');
    // clock 侧键名
    expect(has(clock, "'confirmed'")).toBe(true);
    // workledger 侧键名
    expect(has(ledger, "'confirmed_complete'")).toBe(true);
    // clock 侧**不**直接用 workledger 键名
    expect(has(clock, "'confirmed_complete'")).toBe(false);
  });

  it('V-4/V-5：但已建**显式映射**与**版本敏感幂等键**（分歧被登记并可归口）', () => {
    const align = codeOf(ROOT, 'src/workledger/action-state-alignment.ts');
    expect(has(align, 'ACTION_STATE_ALIGNMENT')).toBe(true);
    expect(has(align, 'versionAwareClockLedgerOptions')).toBe(true);
    expect(has(align, "equivalent: false")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Q-1..Q-6 / N-5-2 / N-5-3 —— 空断言与自证
// ---------------------------------------------------------------------------

// 用 codeOf（**注释已剥离**）：Q 系列断言若只出现在注释里，不得算作"仍在"。
const researchRoutesTest = (): string => codeOf(ROOT, 'apps/demo/server/research-routes.test.ts');
const rolesWiringTest = (): string => codeOf(ROOT, 'apps/demo/server/roles-wiring.test.ts');
const documentsRoutesTest = (): string => codeOf(ROOT, 'apps/demo/server/documents-routes.test.ts');

describe('W9-Q-1..Q-6 · 空断言 / 自证 现状', () => {
  it('Q-1 未修：research-routes.test.ts 仍有 `const chunk … = null; expect(chunk).toBeNull()`', () => {
    const text = researchRoutesTest();
    expect(has(text, 'const chunk: Chunk | null = null;')).toBe(true);
    expect(has(text, 'expect(chunk).toBeNull();')).toBe(true);
  });

  it('Q-2 未修：roles-wiring.test.ts 仍有恒真负对照 `handleMainAgentRequestX(`', () => {
    expect(has(rolesWiringTest(), "not.toContain('handleMainAgentRequestX('")).toBe(true);
  });

  it('Q-3 未修（弱判据保留）：documents-routes.test.ts 仍有 400≤status<500 区间断言', () => {
    const text = documentsRoutesTest();
    expect(has(text, 'toBeGreaterThanOrEqual(400)')).toBe(true);
    expect(has(text, 'toBeLessThan(500)')).toBe(true);
  });

  it('Q-4 未修：research-routes.test.ts 仍有 `expect(createMemoryBlobPort()).toBeTruthy()`', () => {
    expect(has(researchRoutesTest(), 'expect(createMemoryBlobPort()).toBeTruthy()')).toBe(true);
  });

  it('N-5-3/Q-6 未修：documents-routes.test.ts 的 `coverage` 自证仍在', () => {
    expect(has(documentsRoutesTest(), "expect(body['coverage']).toEqual(DOCUMENTS_ROUTE_MODULE_COVERAGE)")).toBe(
      true,
    );
  });

  it('Q-6 未修：gate-and-device.test.ts 断言的仍是**人工数据文件的常量**', () => {
    const gate = readFileSync(join(ROOT, 'tests/full-app/gate-and-device.test.ts'), 'utf8');
    const device = readFileSync(join(ROOT, 'tests/full-app/device-status.ts'), 'utf8');
    expect(has(gate, "expect(DEVICE_REACHABILITY).toBe('reachable')")).toBe(true);
    expect(has(device, "export const DEVICE_REACHABILITY: DeviceReachability = 'reachable';")).toBe(true);
  });

  it('N-5-2 已修：checkpoint.test.ts 的 `f(x) === f(x)` 自比已被替换（有判别力的期望表）', () => {
    const text = readFileSync(join(ROOT, 'src/scheduler/checkpoint.test.ts'), 'utf8');
    expect(has(text, 'expect(classifyActionState(shared)).toBe(classifyActionState(shared))')).toBe(false);
  });

  it('V-7 已修：export-handoff.test.ts 不再拿源常量自比作期望', () => {
    const text = codeOf(ROOT, 'src/presentations/export-handoff.test.ts');
    expect(/expect\([^)]*\)\.toEqual\(EXPORT_HANDOFF_UNVERIFIED_CLAIMS\)/.test(text)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 两次「半截接线」事故 —— 派发是否仍在（且不在 `if (false` 里）
// ---------------------------------------------------------------------------

describe('W9-HALF-WIRE · 两次合并并集吞掉派发块的修复是否在', () => {
  const httpCode = (): string => codeOf(ROOT, 'apps/demo/server/http.ts');

  it('事故①：documents / research 两组路由**有派发调用**（N-5-1 回归护栏）', () => {
    const code = httpCode();
    expect(/if \(await handleDocumentsRequest\(/.test(code)).toBe(true);
    expect(/if \(await handleResearchRequest\(/.test(code)).toBe(true);
  });

  it('事故②：toolLoop 与 xlsFacts 派发块主体**未被并集吞掉**（含完整调用与 return）', () => {
    const code = httpCode();
    expect(/if \(await handleToolLoopRequest\(/.test(code)).toBe(true);
    expect(/if \(await handleXlsFactsRequest\(/.test(code)).toBe(true);
    // 防"只有 if 头、没有 return/关括号"的半截形态：两条派发都必须紧跟 `return;`
    expect(/handleToolLoopRequest\([^;]*\)\)\s*\{\s*return;/.test(code)).toBe(true);
    expect(/handleXlsFactsRequest\([^;]*\)\)\s*\{\s*return;/.test(code)).toBe(true);
    // 反向对照：没有任何派发被放在 `if (false` 之后
    expect(/if \(false[^)]*handle\w+Request/.test(code)).toBe(false);
  });
});
