import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

// 说明：`./key-leak-audit.mjs` 无 `.d.mts` 声明，NodeNext 下解析不到类型（同 tests/mobile-kernel/K-R01）。
// `@ts-ignore` 只作用于**紧邻的下一行**，TS7016 报在 import 的收尾行，故注释贴在 `} from` 之前。
import {
  KNOWN_EXCEPTIONS,
  RULES,
  SCHEMA_VERSION,
  SECRET_PATTERNS,
  SEVERITY_LEVELS,
  SINKS,
  buildReport,
  collectScope,
  contextOf,
  redactSecret,
  resolveSurface,
  scanText,
  severityFor,
  validateFinding,
  validateReport,
  // @ts-ignore -- 无 .d.mts 声明，NodeNext 下无法解析其类型（TS7016 报在本行）
} from './key-leak-audit.mjs';
// K02 侧的真实导出（不是读源码文本猜口径）——用于「与 K02 脱敏口径对齐」的边界对照。
// 只读导入产品模块，不修改它；redact.ts 是零依赖纯函数，仅 `import type`，运行时无副作用。
import {
  PLAINTEXT_SECRET_PATTERNS as K02_SECRET_PATTERNS,
  findPlaintextSecret as k02FindPlaintextSecret,
} from '../../../apps/mobile-kernel/model/redact.js';

/**
 * K-R04 审计器自证测试。
 * =====================================================================
 * 测试对象是**审计器的行为**，不是仓库现状。因此：
 *   - 每条规则都有**正向样例**（必须命中）与**反向对照**（必须不命中）——
 *     防止「正则写错 ⇒ 静默零命中 ⇒ 假绿灯」；
 *   - 对真实仓库只断言**口径不变量**（排除面真被排除、报告自洽、schema 合规），
 *     **不断言「仓库零命中」**——那会把现存问题变成测试红，而本包不修产品源码。
 *
 * 仓库当前的真实命中记录在 baseline-report.json 与 README，如实呈现。
 */

const SCAN = (text: string, opts: Record<string, unknown> = {}) => scanText(text, opts);
const byRule = (hits: any[], rule: string) => hits.filter((h) => h.rule === rule);
const ids = (hits: any[]) => hits.map((h) => h.rule);

/** 绝对干净的样例：任何规则都不该命中。 */
const CLEAN = [
  "export const greeting: string = 'hello world';",
  "import { describe } from 'vitest';",
  'const ratio = 0.5;',
  '',
].join('\n');

describe('K-R04 · 备份面：BK1 / BK2 / BK3 / BK4', () => {
  it('BK1 命中 allowBackup="true"', () => {
    const src = '<manifest><application android:allowBackup="true" android:label="x"/></manifest>\n';
    const hits = byRule(SCAN(src, { path: 'apps/android/app/src/main/AndroidManifest.xml' }), 'BK1');
    expect(hits.length).toBe(1);
    expect(hits[0].subtype).toBe('allow-backup-true');
    expect(hits[0].severity).toBe('high');
    expect(hits[0].sink).toBe('backup');
  });

  it('BK1 命中「未声明 allowBackup」（系统默认 true）', () => {
    const src = '<manifest><application android:label="x"/></manifest>\n';
    const hits = byRule(SCAN(src, { path: '.../AndroidManifest.xml' }), 'BK1');
    expect(hits.length).toBe(1);
    expect(hits[0].subtype).toBe('allow-backup-default-true');
  });

  it('BK1 反向：allowBackup="false" 不命中', () => {
    const src = '<manifest><application android:allowBackup="false" android:dataExtractionRules="@xml/x"/></manifest>\n';
    expect(byRule(SCAN(src, { path: '.../AndroidManifest.xml' }), 'BK1')).toEqual([]);
  });

  it('BK2 命中 allowBackup=false 但缺 dataExtractionRules', () => {
    const src = '<manifest><application android:allowBackup="false"/></manifest>\n';
    const hits = byRule(SCAN(src, { path: '.../AndroidManifest.xml' }), 'BK2');
    expect(hits.length).toBe(1);
    expect(hits[0].severity).toBe('medium');
  });

  it('BK2 反向：声明了 dataExtractionRules 即不命中', () => {
    const src = '<manifest><application android:allowBackup="false" android:dataExtractionRules="@xml/backup_rules"/></manifest>\n';
    expect(byRule(SCAN(src, { path: '.../AndroidManifest.xml' }), 'BK2')).toEqual([]);
  });

  it('BK3 命中「密钥类路径被 include 且无 exclude」', () => {
    const src = [
      '<?xml version="1.0"?>',
      '<full-backup-content>',
      '  <include domain="file" path="keys/"/>',
      '  <exclude domain="file" path="artifacts/"/>',
      '</full-backup-content>',
      '',
    ].join('\n');
    const hits = byRule(SCAN(src, { path: 'apps/android/app/src/main/res/xml/backup_rules.xml' }), 'BK3');
    expect(hits.length).toBe(1);
    expect(hits[0].severity).toBe('high');
  });

  it('BK3 反向：include 的是非密钥路径不命中', () => {
    const src = '<full-backup-content>\n  <include domain="file" path="artifacts/"/>\n</full-backup-content>\n';
    expect(byRule(SCAN(src, { path: 'app/src/main/res/xml/backup_rules.xml' }), 'BK3')).toEqual([]);
  });

  it('BK3 反向：密钥路径若已被 exclude 覆盖则不命中', () => {
    const src = [
      '<full-backup-content>',
      '  <include domain="file" path="keys/"/>',
      '  <exclude domain="file" path="keys/"/>',
      '</full-backup-content>',
      '',
    ].join('\n');
    expect(byRule(SCAN(src, { path: 'app/src/main/res/xml/backup_rules.xml' }), 'BK3')).toEqual([]);
  });

  it('BK4 命中「domain 覆盖私有目录根的宽口径 include」', () => {
    const src = '<full-backup-content>\n  <include domain="file" path="."/>\n</full-backup-content>\n';
    const hits = byRule(SCAN(src, { path: 'app/src/main/res/xml/backup_rules.xml' }), 'BK4');
    expect(hits.length).toBe(1);
    expect(hits[0].severity).toBe('high');
  });

  it('BK4 反向：精确 include 不命中', () => {
    const src = '<full-backup-content>\n  <include domain="file" path="artifacts/"/>\n</full-backup-content>\n';
    expect(byRule(SCAN(src, { path: 'app/src/main/res/xml/backup_rules.xml' }), 'BK4')).toEqual([]);
  });
});

describe('K-R04 · 剪贴板面：CB1 / CB2 / CB3 / CB4', () => {
  it('CB1 命中 setPrimaryClip 写入，且附 CB3（缺 sensitive 标记）', () => {
    const hits = SCAN('clipboard.setPrimaryClip(clip);\n');
    expect(byRule(hits, 'CB1')[0]?.severity).toBe('medium');
    expect(byRule(hits, 'CB1')[0]?.sink).toBe('clipboard');
    expect(byRule(hits, 'CB3')[0]?.severity).toBe('low');
  });

  it('CB1 反向：view.setClipData(ClipData.newRawUri(...)) 是分享 URI 传播，不是剪贴板——必须不命中', () => {
    const src = 'view.setClipData(android.content.ClipData.newRawUri(safeName, uri));\n';
    const hits = SCAN(src, { path: 'apps/android/app/src/main/java/com/potbot/demo/MainActivity.java' });
    expect(byRule(hits, 'CB1')).toEqual([]);
    expect(byRule(hits, 'CB2')).toEqual([]);
    expect(byRule(hits, 'CB3')).toEqual([]);
    expect(byRule(hits, 'CB4')).toEqual([]);
  });

  it('CB2 命中「剪贴板写入同行带密钥类标识符」且为 critical', () => {
    const hits = byRule(SCAN('clipboard.setPrimaryClip(ClipData.newPlainText("k", apiKey));\n'), 'CB2');
    expect(hits.length).toBe(1);
    expect(hits[0].severity).toBe('critical');
  });

  it('CB2 反向：写非敏感值不命 CB2（只命 CB1）', () => {
    const hits = SCAN('clipboard.setPrimaryClip(ClipData.newPlainText("t", title));\n');
    expect(byRule(hits, 'CB2')).toEqual([]);
    expect(byRule(hits, 'CB1').length).toBe(1);
  });

  it('CB3 反向：有 EXTRA_IS_SENSITIVE 标记时不命中', () => {
    const src = 'clip.setExtras(extrasWith(ClipDescription.EXTRA_IS_SENSITIVE));\nclipboard.setPrimaryClip(clip);\n';
    const hits = SCAN(src);
    expect(byRule(hits, 'CB1').length).toBe(1);
    expect(byRule(hits, 'CB3')).toEqual([]);
  });

  it('CB4 命中剪贴板读取', () => {
    const hits = byRule(SCAN('const item = clipboardManager.getPrimaryClip();\n'), 'CB4');
    expect(hits.length).toBe(1);
    expect(hits[0].severity).toBe('medium');
  });

  it('CB4 命中前端 navigator.clipboard.readText', () => {
    const hits = byRule(SCAN('const t = await navigator.clipboard.readText();\n'), 'CB4');
    expect(hits.length).toBe(1);
  });
});

describe('K-R04 · 日志面：LG1 / LG2 / LG3', () => {
  it('LG1 命中「日志同行带密钥类标识符」且为 critical', () => {
    const hits = byRule(SCAN('Log.d(TAG, "auth=" + apiKey);\n'), 'LG1');
    expect(hits.length).toBe(1);
    expect(hits[0].severity).toBe('critical');
    expect(hits[0].sink).toBe('logs');
  });

  it('LG1 命中 console.log 带 token', () => {
    const hits = byRule(SCAN("console.log('token', token);\n"), 'LG1');
    expect(hits.length).toBe(1);
  });

  it('LG1 反向：真实仓库里那种「日志 + 异常对象」不命中（仅 LG3 清点）', () => {
    const src = 'Log.w(TAG, "重算文本缩放失败（保持原值）", e);\n';
    const hits = SCAN(src, { path: 'apps/android/app/src/main/java/com/potbot/demo/MainActivity.java' });
    expect(byRule(hits, 'LG1')).toEqual([]);
    expect(byRule(hits, 'LG3').length).toBe(1);
    expect(byRule(hits, 'LG3')[0].severity).toBe('info');
  });

  it('LG2 命中 printStackTrace', () => {
    const hits = byRule(SCAN('e.printStackTrace();\n'), 'LG2');
    expect(hits.length).toBe(1);
    expect(hits[0].severity).toBe('medium');
  });

  it('LG2 命中 Java System.out.print', () => {
    expect(byRule(SCAN('System.out.println("boom");\n'), 'LG2').length).toBe(1);
  });

  it('LG3 命中普通日志调用（清点，info）', () => {
    const hits = byRule(SCAN("console.log('hi');\n"), 'LG3');
    expect(hits.length).toBe(1);
    expect(hits[0].severity).toBe('info');
  });
});

describe('K-R04 · 崩溃诊断面：CR1 / CR2 / CR3', () => {
  it('CR1 命中未捕获异常处理器（清点，info）', () => {
    const hits = byRule(SCAN('Thread.setDefaultUncaughtExceptionHandler(handler);\n'), 'CR1');
    expect(hits.length).toBe(1);
    expect(hits[0].severity).toBe('info');
    expect(hits[0].sink).toBe('crash');
  });

  it('CR2 命中「崩溃路径同行带密钥类标识符」且为 high', () => {
    const hits = byRule(
      SCAN('Thread.setDefaultUncaughtExceptionHandler((t, e) -> report(apiKey));\n'),
      'CR2',
    );
    expect(hits.length).toBe(1);
    expect(hits[0].severity).toBe('high');
    // 命中 CR2 时不再同时报 CR1（二选一），避免双计
    expect(byRule(SCAN('Thread.setDefaultUncaughtExceptionHandler((t, e) -> report(apiKey));\n'), 'CR1')).toEqual([]);
  });

  it('CR3 命中第三方崩溃上报 SDK', () => {
    const hits = byRule(SCAN('FirebaseCrashlytics.getInstance().recordException(e);\n'), 'CR3');
    expect(hits.length).toBe(1);
    expect(hits[0].severity).toBe('medium');
  });

  it('CR1/CR2/CR3 反向：干净代码不命中', () => {
    const hits = SCAN('export function add(a: number, b: number): number { return a + b; }\n');
    expect(ids(hits).filter((x: string) => x.startsWith('CR'))).toEqual([]);
  });
});

describe('K-R04 · 密钥实体：SM1 与脱敏红线', () => {
  it('SM1 命中 sk- 形状密钥，且回显里不含原值', () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz012345';
    const hits = byRule(SCAN(`const apiKey = '${secret}';\n`), 'SM1');
    // 同行既有 `apiKey = '...'`（api-key-assign）又有 sk- 形状，两条 pattern 都应命中。
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.some((h: any) => h.subtype === 'sk-key')).toBe(true);
    for (const h of hits) expect(h.severity).toBe('critical');
    expect(JSON.stringify(hits)).not.toContain(secret);
    expect(hits.some((h: any) => h.snippet.includes('[REDACTED'))).toBe(true);
  });

  it('SM1 命中 Bearer 令牌，且不回显原值', () => {
    const token = 'AQAAANCMnd8BFdERjHoAwE_Cl-sBAAAA';
    const hits = byRule(SCAN(`const h = { authorization: 'Bearer ${token}' };\n`), 'SM1');
    expect(hits.length).toBe(1);
    expect(JSON.stringify(hits)).not.toContain(token);
  });

  it('SM1 命中 PEM 私钥头', () => {
    const hits = byRule(SCAN('const p = `-----BEGIN RSA PRIVATE KEY-----`;\n'), 'SM1');
    expect(hits.length).toBe(1);
    expect(hits[0].subtype).toBe('private-key-pem');
  });

  it('SM1 反向：占位符 / 短值不命中', () => {
    expect(byRule(SCAN("const apiKey = 'placeholder';\n"), 'SM1')).toEqual([]);
    expect(byRule(SCAN("const apiKey = '';\n"), 'SM1')).toEqual([]);
    expect(byRule(SCAN("import { x } from './task-lifecycle.js';\n"), 'SM1')).toEqual([]);
  });

  it('redactSecret 只出形状，绝不出原值', () => {
    const value = 'sk-livekeyvalue0123456789';
    const r = redactSecret(value);
    expect(r.shape).toBe('sk-****');
    expect(r.length).toBe(value.length);
    expect(JSON.stringify(r)).not.toContain('livekeyvalue');
  });
});

describe('K-R04 · 上下文与严重度口径', () => {
  it('同一样例在测试上下文降为 info', () => {
    const prod = byRule(SCAN('Log.d(TAG, "auth=" + apiKey);\n', { path: 'src/a.ts' }), 'LG1')[0];
    const test = byRule(SCAN('Log.d(TAG, "auth=" + apiKey);\n', { path: 'src/a.test.ts' }), 'LG1')[0];
    expect(prod.severity).toBe('critical');
    expect(test.severity).toBe('info');
    expect(prod.context).toBe('product');
    expect(test.context).toBe('test');
  });

  it('注释里的命中降为 info', () => {
    const hit = byRule(SCAN('// Log.d(TAG, "token=" + token);  示例，实际禁止\n', { path: 'src/a.ts' }), 'LG1')[0];
    expect(hit.context).toBe('comment');
    expect(hit.severity).toBe('info');
  });

  it('参考面（apps/demo/server）的 high 降为 medium', () => {
    const hit = byRule(SCAN('Log.d(TAG, "token=" + token);\n', { path: 'apps/demo/server/x.ts', migrationSurface: 'reference' }), 'LG1')[0];
    expect(hit.severity).toBe('medium');
    expect(hit.severityNote).toBe('capped: reference surface');
  });

  it('contextOf / severityFor 分档合同稳定', () => {
    expect(contextOf('const a = 1;\n', 'src/a.ts')).toBe('product');
    expect(contextOf('// x\n', 'src/a.ts')).toBe('comment');
    expect(contextOf('const a = 1;\n', 'src/a.test.ts')).toBe('test');
    expect(severityFor('product', 'critical')).toBe('critical');
    expect(severityFor('comment', 'critical')).toBe('info');
    expect(severityFor('test', 'high')).toBe('info');
  });

  it('已知例外是「降级不隐藏」：命中仍在列表里且带 exceptionId', () => {
    expect(KNOWN_EXCEPTIONS.length).toBeGreaterThan(0);
    for (const ex of KNOWN_EXCEPTIONS) expect(RULES.some((r: any) => r.id === ex.rule)).toBe(true);
    for (const ex of KNOWN_EXCEPTIONS) expect((ex as any).reason.length).toBeGreaterThan(10);
  });

  it('EX-LG1-SHEET：表格 token 的误报被降级但不隐藏；其他面仍为 critical', () => {
    const sheet = byRule(
      SCAN("console.log('DBG parse-fail', token, String(error));\n", { path: 'src/spreadsheets/sheet.ts' }),
      'LG1',
    )[0];
    expect(sheet.severity).toBe('low');
    expect(sheet.exceptionId).toBe('EX-LG1-SHEET');
    // 同样的日志在非表格文件里仍是 critical（例外只对 src/spreadsheets/** 生效）
    const other = byRule(
      SCAN("console.log('DBG parse-fail', token, String(error));\n", { path: 'src/model/client.ts' }),
      'LG1',
    )[0];
    expect(other.severity).toBe('critical');
    expect(other.exceptionId).toBeUndefined();
  });
});

describe('K-R04 · 口径：扫描面纳入与排除必须真的生效', () => {
  const roots: string[] = [];
  const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), 'k-r04-'));
    roots.push(root);
    const w = (rel: string, body: string, binary = false) => {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      if (binary) writeFileSync(abs, Buffer.from([0x61, 0x00, 0x62]));
      else writeFileSync(abs, body, 'utf8');
    };
    w('src/clean.ts', CLEAN);
    w('src/deep/log.ts', 'Log.d(TAG, "token=" + token);\n');           // LG1 命中，验证递归
    w('src/bad.test.ts', 'Log.d(TAG, "token=" + token);\n');           // 必须被排除
    w('docs/note.ts', 'Log.d(TAG, "token=" + token);\n');              // 必须被排除
    w('tests/thing.ts', 'Log.d(TAG, "token=" + token);\n');            // 必须被排除
    w('apps/android/app/build/tmp.java', 'e.printStackTrace();\n');    // build 必须被排除
    w('apps/android/app/src/main/AndroidManifest.xml', '<manifest><application android:allowBackup="true"/></manifest>\n'); // 纳入
    w('src/blob.bin.ts', 'placeholder', true);                          // 二进制 ⇒ 跳过而非误报
    return root;
  };
  afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

  it('collectScope 只纳入允许面，排除 tests/docs/build，点名二进制', () => {
    const r = fixture();
    const { files, skippedBinary, surfaces, stats } = collectScope(r);
    const rels = files.map((f: any) => f.rel);
    expect(rels).toContain('src/clean.ts');
    expect(rels).toContain('src/deep/log.ts');
    expect(rels).toContain('apps/android/app/src/main/AndroidManifest.xml');
    expect(rels).not.toContain('src/bad.test.ts');
    expect(rels.some((x: string) => x.startsWith('docs/'))).toBe(false);
    expect(rels.some((x: string) => x.startsWith('tests/'))).toBe(false);
    expect(rels.some((x: string) => x.includes('/build/'))).toBe(false);
    expect(skippedBinary.map((s: any) => s.rel)).toContain('src/blob.bin.ts');
    expect(stats.testFilesExcluded).toContain('src/bad.test.ts');
    expect(surfaces.find((s: any) => s.id === 'android-app')?.present).toBe(true);
  });

  it('buildReport 在夹具上：二进制不计命中，manifest 的 BK1 计为 android-app 面', () => {
    const r = fixture();
    const report: any = buildReport(r);
    const paths = report.findings.map((h: any) => h.path);
    expect(paths).not.toContain('src/blob.bin.ts');
    const bk = report.findings.find((h: any) => h.rule === 'BK1');
    expect(bk?.surface).toBe('android-app');
    expect(bk?.severity).toBe('high');
  });

  it('buildReport 对同一输入是确定的（仅 generatedAt 变化）', () => {
    const r = fixture();
    const a: any = buildReport(r);
    const b: any = buildReport(r);
    const strip = (x: any) => { const y = { ...x }; delete y.generatedAt; return y; };
    expect(strip(a)).toEqual(strip(b));
  });

  it('resolveSurface 取最长前缀', () => {
    expect(resolveSurface('src/a.ts')?.id).toBe('kernel');
    expect(resolveSurface('apps/mobile-kernel/model/x.ts')?.id).toBe('mobile-kernel');
    expect(resolveSurface('apps/android/app/build.gradle')?.id).toBe('android-app');
    expect(resolveSurface('scripts/gate/run.mjs')).toBe(null);
  });
});

describe('K-R04 · 契约：finding/report 满足 schema.json', () => {
  const schema = JSON.parse(readFileSync(new URL('./schema.json', import.meta.url), 'utf8'));

  it('schema.json 自身可解析，required 与导出常量一致', () => {
    expect(schema.$defs.finding.required.sort()).toEqual(
      ['rule', 'sink', 'subtype', 'severity', 'confidence', 'path', 'line', 'column', 'context', 'snippet', 'evidence', 'fixHint'].sort(),
    );
    expect(schema.properties.rules.items.properties.baseSeverity.enum).toEqual(SEVERITY_LEVELS);
    expect(schema.$defs.finding.properties.sink.enum).toEqual(SINKS);
  });

  const sampleReport = () => buildReport(mkdtempSync(join(tmpdir(), 'k-r04-schema-')));

  it('validateFinding 对合规 finding 通过，对缺字段/错枚举拒绝', () => {
    const good = scanText('Log.d(TAG, "token=" + token);\n')[0];
    expect(validateFinding(good).ok).toBe(true);
    const missing = { ...good }; delete (missing as any).fixHint;
    expect(validateFinding(missing).ok).toBe(false);
    expect(validateFinding({ ...good, severity: 'nope' }).ok).toBe(false);
    expect(validateFinding({ ...good, rule: 'ZZ9' }).ok).toBe(false);
  });

  it('validateReport：真实仓库报告自洽（totalFindings = ΣbyRule = findings.length）', () => {
    const report: any = buildReport(process.cwd());
    const res = validateReport(report);
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
    expect(report.findings.length).toBe(report.summary.totalFindings);
    let sum = 0;
    for (const r of RULES as any[]) sum += report.summary.byRule[r.id];
    expect(sum).toBe(report.summary.totalFindings);
    // 全仓扫描较重（数百文件），显式给时限（vitest 配置要求重型用例自带时限）。
  }, 30000);
});

describe('K-R04 · 与 K02 脱敏口径对齐（consumer-reopen）', () => {
  it('SECRET_PATTERNS 与 K02 PLAINTEXT_SECRET_PATTERNS 逐类对齐（条数 + 显著 token）', () => {
    // 直接核对 K02 的**真实导出**（不是读源码文本猜），条数必须一致。
    expect(SECRET_PATTERNS.length).toBe(5);
    expect(K02_SECRET_PATTERNS.length).toBe(SECRET_PATTERNS.length);
    // 两侧各自的 5 条 pattern 都要含同一组显著 token（两处口径不许漂移）。
    const k02Text = K02_SECRET_PATTERNS.map((p) => p.source).join(' | ');
    const k04Text = SECRET_PATTERNS.map((p: any) => p.re.source).join(' | ');
    for (const token of ['sk-', 'Bearer', 'AIza', 'PRIVATE KEY', 'api[_-]?key']) {
      expect(k02Text).toContain(token);
      expect(k04Text).toContain(token);
    }
    // K02 源文件里也必须仍声明这些核心 token（防止 import 到的是别的模块）。
    const k02src = readFileSync(new URL('../../../apps/mobile-kernel/model/redact.ts', import.meta.url), 'utf8');
    for (const token of ['sk-', 'Bearer', 'AIza', 'PRIVATE KEY', 'api[_-]?key']) {
      expect(k02src).toContain(token);
    }
  });

  it('边界对齐：普通单词内部的 sk- 两边都不误报，伪装引用两边都命中', () => {
    const k04Hit = (text: string) =>
      SECRET_PATTERNS.some((p: any) => {
        p.re.lastIndex = 0;
        return p.re.test(text);
      });

    // 反向对照：`task-registered` 的 `sk-` 在词内部（前一个字符是词字符 `a`）。
    // 朴素 `/sk-/` 会误报（下方钉住），但 K02 与 K-R04 两侧都必须判为「不是密钥」。
    expect(/sk-[A-Za-z0-9_-]{10,}/.test('task-registered')).toBe(true); // 朴素正则确实误报
    expect(k02FindPlaintextSecret('task-registered')).toBeNull();       // K02 已修：不误报
    expect(k04Hit('task-registered')).toBe(false);                       // K-R04 本来就不误报

    // 正向对照：伪装引用（形状是引用、内容是明文）两边都必须抓住。
    const masq = 'keyref:sk-live-abcdefghijklmnop';
    expect(k02FindPlaintextSecret(masq)).not.toBeNull();
    expect(k04Hit(masq)).toBe(true);
    // K02 命中的是 `sk-` 起的密钥体本身（证明 `:` 未被算作词字符而切掉边界、也未被误伤）。
    expect(k02FindPlaintextSecret(masq)?.startsWith('sk-')).toBe(true);
    // 边界不伤正例：行首 / 空白后的真密钥仍命中。
    expect(k02FindPlaintextSecret('sk-abcdefghijklmnop')).not.toBeNull();
    expect(k02FindPlaintextSecret('  sk-abcdefghijklmnop')).not.toBeNull();
  });

  it('K02 的 sk- 模式必须带左边界（防回退到无界 /sk-/）', () => {
    const skPattern = K02_SECRET_PATTERNS.find((p) => p.source.includes('sk-'));
    expect(skPattern).toBeDefined();
    expect(skPattern?.source ?? '').toContain('(?<![A-Za-z0-9_])');
  });

  it('与 K03 keyref 对齐：合法 keyRef 不命 SM1，伪装 keyref 必须命中', () => {
    // K03 已落地 security/keyref.ts（K03 worker 产物）。合法 keyRef 是引用不是密钥。
    const k03 = readFileSync(new URL('../../../apps/mobile-kernel/security/keyref.ts', import.meta.url), 'utf8');
    expect(k03).toContain('keyref:model.deepseek-flash');
    // 合法 keyRef 形状：不得被 SM1 当成明文密钥
    expect(byRule(SCAN("const ref = 'keyref:model.deepseek-flash';\n"), 'SM1')).toEqual([]);
    expect(byRule(SCAN("const ref = 'keyref:meituan.demo';\n"), 'SM1')).toEqual([]);
    // 伪装：形状是引用、内容是明文（K03 点名的「挡不住」场景）——审计器必须抓出来
    const masq = byRule(SCAN("const ref = 'keyref:sk-live-abcdefghijklmnop';\n"), 'SM1');
    expect(masq.length).toBe(1);
    expect(masq[0].evidence).toContain('sk-****');
  });
});

describe('K-R04 · 真实仓库基线报告', () => {
  const BASELINE: any = JSON.parse(readFileSync(new URL('./baseline-report.json', import.meta.url), 'utf8'));

  it('基线报告存在、可解析、schema 与本审计器一致', () => {
    expect(BASELINE.schemaVersion).toBe(SCHEMA_VERSION);
    expect(BASELINE.auditor).toBe('K-R04-key-leak-audit');
    expect(BASELINE.rules.map((r: any) => r.id)).toEqual(RULES.map((r: any) => r.id));
  });

  it('基线报告通过 validateReport（契约自洽）', () => {
    const res = validateReport(BASELINE);
    expect(res.errors).toEqual([]);
  });

  it('基线报告自洽：规则计数 = 明细计数 = summary.byRule', () => {
    const ruleIds = RULES.map((r: any) => r.id);
    let sum = 0;
    for (const id of ruleIds as string[]) {
      const detail = BASELINE.findings.filter((h: any) => h.rule === id).length;
      const rule = BASELINE.rules.find((r: any) => r.id === id);
      expect(rule.count).toBe(detail);
      expect(BASELINE.summary.byRule[id]).toBe(detail);
      sum += detail;
    }
    expect(BASELINE.summary.totalFindings).toBe(sum);
    expect(BASELINE.summary.totalFindings).toBe(BASELINE.findings.length);
  });

  it('基线每条命中都带齐字段与合法枚举', () => {
    for (const h of BASELINE.findings) {
      expect(typeof h.path).toBe('string');
      expect(h.path.length).toBeGreaterThan(0);
      expect(h.line).toBeGreaterThan(0);
      expect(h.column).toBeGreaterThan(0);
      expect(SEVERITY_LEVELS).toContain(h.severity);
      expect(SINKS).toContain(h.sink);
      expect(['product', 'comment', 'test']).toContain(h.context);
    }
  });

  it('口径不变量：基线不得出现排除面路径，也不得出现密钥原值', () => {
    const bad = BASELINE.findings.filter((h: any) => /^(docs|tests|node_modules|\.runtime|\.claude|\.task-manifest)\//.test(h.path));
    expect(bad).toEqual([]);
    const badTest = BASELINE.findings.filter((h: any) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(h.path));
    expect(badTest).toEqual([]);
    // 任何 finding 都不许内嵌**明文密钥形状**——用审计器自己的 pattern 判定
    // （朴素 /sk-/ 会误伤 `task-registered` 这种「sk- 在更长单词内部」的字面量）。
    const hasPlaintext = (text: string) => SECRET_PATTERNS.some((p: any) => {
      p.re.lastIndex = 0;
      return p.re.test(text);
    });
    for (const h of BASELINE.findings) {
      expect(hasPlaintext(h.snippet)).toBe(false);
    }
    // 反向钉住：朴素正则会误伤，审计器自己的 pattern 不会
    expect(/sk-[A-Za-z0-9_-]{10,}/.test('task-registered')).toBe(true); // 朴素正则确实误报
    expect(hasPlaintext('task-registered')).toBe(false); // 审计器不误报
  });

  it('口径不变量：对真实仓库重新扫描，排除面同样干净（防口径漂移）', () => {
    const fresh: any = buildReport(process.cwd());
    expect(fresh.scope.filesScanned).toBeGreaterThan(0);
    const bad = fresh.findings.filter((h: any) => /^(docs|tests|node_modules|\.runtime|\.claude|\.task-manifest)\//.test(h.path));
    expect(bad).toEqual([]);
  }, 30000);

  it('基线记录了扫描面存在性（不断言具体命中数，只断言字段齐备）', () => {
    expect(BASELINE.scope.filesScanned).toBeGreaterThan(0);
    expect(Array.isArray(BASELINE.scope.skippedBinary)).toBe(true);
    expect(BASELINE.scope.filesBySurface['android-app']).toBeGreaterThan(0);
    expect(BASELINE.limitations.length).toBeGreaterThan(0);
  });
});
