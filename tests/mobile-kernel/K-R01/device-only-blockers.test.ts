import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { AuditFinding, AuditReport } from './report-types.js';

// 同 desktop-dependency-audit.test.ts：`./audit.mjs` 无 .d.mts 声明，NodeNext 下 TS7016
// 报在 import 收尾行，故 @ts-ignore 必须贴在 `} from './audit.mjs';` 上一行。
import {
  BLOCKER_CLASSES,
  CONTEXTS,
  RULES,
  SEVERITIES,
  buildReport,
  classifyDeviceOnly,
  deviceOnlyBlockers,
  scanText,
  validateReport,
  // @ts-ignore -- 无 .d.mts 声明，NodeNext 下无法解析其类型（TS7016 报在本行）
} from './audit.mjs';

/**
 * K-R01 增量测试：device-only 阻断投影 + 报告 schema 契约。
 * =====================================================================
 * 这组测试回答任务书那句「静态审计会破坏无电脑运行的桌面/网络依赖，产出机器可读清单」：
 *   - classifyDeviceOnly 的**判定边界**（正向 hard / 正向 conditional / 全部反向 null）；
 *   - 真实仓库扫描后 summary.blockers 与明细自洽；
 *   - validateReport 能**接受**合法报告、能**拒绝**被破坏的报告（负例）；
 *   - 代码里的 enum 与 report.schema.json 的 enum 互等（防契约漂移）。
 */

// 全仓扫描成本高（900+ 文件）且六线并发，只做一次、两个 describe 复用，避免重复扫描。
const REPO = buildReport(process.cwd()) as AuditReport;

const hit = (over: Partial<AuditFinding> & Record<string, unknown> = {}) => ({
  rule: 'R2',
  subtype: 'loopback-ipv4',
  path: 'src/a.ts',
  migrationSurface: 'target',
  line: 1,
  column: 1,
  severity: 'high',
  context: 'product',
  blockerClass: null,
  ...over,
});

describe('K-R01 · classifyDeviceOnly：判定边界', () => {
  it('hard：目标面 + product + high 的 R1/R2/R3/R5 都算硬阻断', () => {
    for (const rule of ['R1', 'R2', 'R3', 'R5'] as const) {
      expect(classifyDeviceOnly(hit({ rule, severity: 'high' }))).toBe('hard');
    }
  });

  it('hard：R4 tier1 模块导入（fs/path…）硬阻断', () => {
    expect(classifyDeviceOnly(hit({ rule: 'R4', subtype: 'module-import', module: 'path', tier: 1 }))).toBe('hard');
  });

  it('conditional：R4 Buffer 全局只是「取决于 polyfill」，不是硬阻断', () => {
    expect(classifyDeviceOnly(hit({ rule: 'R4', subtype: 'global-buffer', module: 'Buffer', tier: 1 }))).toBe('conditional');
  });

  it('null 反向：注释上下文不算（注释里写地址不是产品依赖）', () => {
    expect(classifyDeviceOnly(hit({ context: 'comment', severity: 'info' }))).toBe(null);
  });

  it('null 反向：测试上下文不算', () => {
    expect(classifyDeviceOnly(hit({ context: 'test', severity: 'info' }))).toBe(null);
  });

  it('null 反向：参考面（电脑侧宿主）不算——它根本不进手机', () => {
    expect(classifyDeviceOnly(hit({ migrationSurface: 'reference', severity: 'medium' }))).toBe(null);
    // 即便是参考面上的裸 NUL，migrationSurface !== target 也不计入 device-only 阻断
    expect(classifyDeviceOnly(hit({ migrationSurface: 'reference', rule: 'R1', subtype: 'nul' }))).toBe(null);
  });

  it('null 反向：binding/endpoint 常量与 medium 严重度都不算硬阻断', () => {
    expect(classifyDeviceOnly(hit({ context: 'bind-or-default', severity: 'medium' }))).toBe(null);
    expect(classifyDeviceOnly(hit({ context: 'endpoint-constant', severity: 'medium' }))).toBe(null);
    expect(classifyDeviceOnly(hit({ severity: 'medium' }))).toBe(null);
    expect(classifyDeviceOnly(hit({ severity: 'info' }))).toBe(null);
  });

  it('null 反向：tier2 模块导入（观察项，severity=medium）不是阻断', () => {
    expect(classifyDeviceOnly(hit({ rule: 'R4', subtype: 'module-import', module: 'os', tier: 2, severity: 'medium' }))).toBe(null);
  });

  it('null 反向：非法输入不抛异常', () => {
    expect(classifyDeviceOnly(null)).toBe(null);
    expect(classifyDeviceOnly(undefined)).toBe(null);
    expect(classifyDeviceOnly('x' as unknown as AuditFinding)).toBe(null);
  });
});

describe('K-R01 · scanText 真的把 blockerClass 写进命中', () => {
  it('同一行 node:fs，在 src 产品路径上是 hard，在参考面/注释里是 null', () => {
    const line = "const fs = require('node:fs');\n";
    expect(scanText(line, { path: 'src/x.ts' })[0]?.blockerClass).toBe('hard');
    expect(scanText(line, { path: 'apps/demo/server/x.ts', migrationSurface: 'reference' })[0]?.blockerClass).toBe(null);
    expect(scanText(`// ${line}`, { path: 'src/x.ts' })[0]?.blockerClass).toBe(null);
  });

  it('Buffer 全局在 src 产品路径上是 conditional', () => {
    const hits = scanText("const b = Buffer.from('x');\n", { path: 'src/x.ts' });
    const buf = hits.find((h: AuditFinding) => h.module === 'Buffer');
    expect(buf?.blockerClass).toBe('conditional');
  });

  it('回环地址在 src 产品路径上是 hard；在测试文件里是 null', () => {
    const line = "const u = 'http://127.0.0.1:8008';\n";
    expect(scanText(line, { path: 'src/x.ts' })[0]?.blockerClass).toBe('hard');
    expect(scanText(line, { path: 'src/x.test.ts' })[0]?.blockerClass).toBe(null);
  });
});

describe('K-R01 · deviceOnlyBlockers 投影与真实仓库自洽', () => {
  const report = REPO;

  it('投影计数与 summary.blockers 一致，且是 hits 的子集', () => {
    const { hard, conditional } = deviceOnlyBlockers(report);
    expect(hard.length).toBe(report.summary.blockers.hard);
    expect(conditional.length).toBe(report.summary.blockers.conditional);
    expect(hard.length + conditional.length).toBeLessThanOrEqual(report.hits.length);
  });

  it('每一条 hard 都满足 target + product + high（判定不变量）', () => {
    const { hard } = deviceOnlyBlockers(report);
    for (const h of hard) {
      expect(h.migrationSurface).toBe('target');
      expect(h.context).toBe('product');
      expect(h.severity).toBe('high');
      expect(h.blockerClass).toBe('hard');
    }
  });

  it('每一条 conditional 都是 R4（当前语义：Runtime polyfill/端口）', () => {
    const { conditional } = deviceOnlyBlockers(report);
    for (const h of conditional) expect(h.rule).toBe('R4');
  });

  it('hits 全覆盖 blockerClass 字段，取值仅 hard/conditional/null', () => {
    for (const h of report.hits) {
      expect(BLOCKER_CLASSES).toContain(h.blockerClass);
    }
  });
});

describe('K-R01 · validateReport 契约校验', () => {
  const report = REPO;

  it('接受真实仓库生成的报告', () => {
    const v = validateReport(report);
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
  });

  it('接受提交的基线报告（说明基线与当前契约同版）', () => {
    const baseline = JSON.parse(readFileSync(new URL('./baseline-report.json', import.meta.url), 'utf8'));
    const v = validateReport(baseline);
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
  });

  it('拒绝：非对象', () => {
    expect(validateReport(null).ok).toBe(false);
    expect(validateReport(42).ok).toBe(false);
  });

  it('拒绝：缺必需顶层字段', () => {
    const bad = { schemaVersion: 1, auditor: 'x', rules: [], summary: {}, hits: [] };
    delete (bad as Record<string, unknown>).summary;
    const v = validateReport(bad);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e: string) => e.includes('summary'))).toBe(true);
  });

  it('拒绝：命中带非法 severity / 非法 rule', () => {
    const bad = { ...report, hits: [{ ...report.hits[0], severity: 'catastrophic', rule: 'R99' }] };
    const v = validateReport(bad);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e: string) => e.includes('severity 非法'))).toBe(true);
    expect(v.errors.some((e: string) => e.includes('rule 非法'))).toBe(true);
  });

  it('拒绝：summary.byRule 与明细不符（防汇总漂移）', () => {
    const bad = JSON.parse(JSON.stringify(report));
    bad.summary.byRule.R1 = (bad.summary.byRule.R1 ?? 0) + 999;
    const v = validateReport(bad);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e: string) => e.includes('summary.byRule.R1'))).toBe(true);
  });

  it('拒绝：blockerClass 取值越界', () => {
    const bad = { ...report, hits: [{ ...report.hits[0], blockerClass: 'maybe' }] };
    const v = validateReport(bad);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e: string) => e.includes('blockerClass 非法'))).toBe(true);
  });
});

describe('K-R01 · 代码 enum 与 report.schema.json 契约互等（防漂移）', () => {
  const schema = JSON.parse(readFileSync(new URL('./report.schema.json', import.meta.url), 'utf8'));

  it('severity / context / ruleId / blockerClass 四处 enum 必须完全一致', () => {
    expect(schema.$defs.severity.enum).toEqual(SEVERITIES);
    expect(schema.$defs.context.enum).toEqual(CONTEXTS);
    expect(schema.$defs.ruleId.enum).toEqual(RULES.map((r: { id: string }) => r.id));
    expect(schema.$defs.blockerClass.enum).toEqual(BLOCKER_CLASSES);
  });

  it('finding 的必需字段覆盖审计器每条命中都会写的字段', () => {
    const required = schema.$defs.finding.required as string[];
    for (const k of ['rule', 'path', 'line', 'column', 'severity', 'context', 'blockerClass']) {
      expect(required).toContain(k);
    }
  });

  it('schema 是合法 JSON 且声明 2020-12 草案', () => {
    expect(schema.$schema).toContain('2020-12');
    expect(schema.properties.schemaVersion.const).toBe(1);
    expect(schema.properties.summary.required).toContain('blockers');
  });
});
