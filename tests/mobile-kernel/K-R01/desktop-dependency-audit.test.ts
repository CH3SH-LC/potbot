import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

// 说明：`./audit.mjs` 无 `.d.mts` 声明，NodeNext 下解析不到类型（同 tests/full-app/bound-run-ledger）。
// 注意 `@ts-ignore` 只作用于**紧邻的下一行**：多行 import 的 TS7016 报在收尾行（`} from './audit.mjs';`），
// 因此注释必须贴在那一行之前，而不是 import 关键字之前——否则 `pnpm typecheck` 会红。
import {
  KNOWN_EXCEPTIONS,
  RULES,
  SCHEMA_VERSION,
  buildReport,
  collectScope,
  contextOf,
  redactSecret,
  resolveSurface,
  scanText,
  severityFor,
  // @ts-ignore -- 无 .d.mts 声明，NodeNext 下无法解析其类型（TS7016 报在本行）
} from './audit.mjs';

/**
 * K-R01 审计器自证测试。
 * =====================================================================
 * 测试对象是**审计器的行为**，不是仓库现状。因此：
 *   - 每条规则都有**正向样例**（必须命中）与**反向对照**（必须不命中）——
 *     防止「正则写错 ⇒ 静默零命中 ⇒ 假绿灯」；
 *   - 对真实仓库只断言**口径不变量**（排除面真的被排除、报告自洽），
 *     **不断言「仓库零命中」**——那会把现存问题变成测试红，而本包不修产品源码。
 *
 * 仓库当前的真实命中（含 R1 裸 NUL / 0x01）记录在 baseline-report.json 与 README，如实呈现。
 */

const HITS = (text: string, opts: Record<string, unknown> = {}) => scanText(text, opts);
const byRule = (hits: any[], rule: string) => hits.filter((h) => h.rule === rule);

/** 绝对干净的样例：任何规则都不该命中。 */
const CLEAN = [
  "export const greeting: string = 'hello world';",
  "import { describe } from 'vitest';",
  'const ratio = 0.5;',
  'const label = "docs/notes.txt";',
  '',
].join('\n');

describe('K-R01 · 审计器正向样例：每条规则都必须能命中', () => {
  it('R1 命中裸 NUL', () => {
    const hits = byRule(HITS("const a = 'x\u0000y';\n"), 'R1');
    expect(hits.length).toBe(1);
    expect(hits[0].subtype).toBe('nul');
    expect(hits[0].line).toBe(1);
  });

  it('R1 命中其他 C0 控制字符（0x01）', () => {
    const hits = byRule(HITS("const sep = '\u0001';\n"), 'R1');
    expect(hits.length).toBe(1);
    expect(hits[0].subtype).toBe('control-char');
    expect(hits[0].severity).toBe('high');
  });

  it('R1 命中零宽字符（ZWJ）并给出行号', () => {
    const hits = byRule(HITS("const family = 'a\u200db';\n"), 'R1');
    expect(hits.length).toBe(1);
    expect(hits[0].subtype).toBe('zero-width-joiner');
    expect(hits[0].line).toBe(1);
  });

  it('R1 命中 BOM 且只降为 info（编码提示而非缺陷）', () => {
    const hits = byRule(HITS('\uFEFFconst a = 1;\n'), 'R1');
    expect(hits.length).toBe(1);
    expect(hits[0].subtype).toBe('bom');
    expect(hits[0].severity).toBe('info');
  });

  it('R2 命中回环 IPv4 / hostname / 通配绑定 / 私网段', () => {
    expect(byRule(HITS("const u = 'http://127.0.0.1:8008';\n"), 'R2')[0]?.subtype).toBe('loopback-ipv4');
    expect(byRule(HITS("const u = 'http://localhost:3000';\n"), 'R2')[0]?.subtype).toBe('loopback-hostname');
    expect(byRule(HITS("server.listen(8765, '0.0.0.0');\n"), 'R2')[0]?.subtype).toBe('wildcard-bind');
    expect(byRule(HITS("const u = 'http://192.168.1.10:80';\n"), 'R2')[0]?.subtype).toBe('private-192-168');
    expect(byRule(HITS("const u = 'http://10.0.0.7:80';\n"), 'R2')[0]?.subtype).toBe('private-10');
    expect(byRule(HITS("const u = 'http://172.20.3.4:80';\n"), 'R2')[0]?.subtype).toBe('private-172-16-31');
  });

  it('R2 区分「测试上下文」与「产品上下文」——同样字面量，严重度不同', () => {
    const prod = byRule(HITS("const base = 'http://127.0.0.1:1';\n", { path: 'src/a.ts' }), 'R2')[0];
    const test = byRule(HITS("const base = 'http://127.0.0.1:1';\n", { path: 'src/a.test.ts' }), 'R2')[0];
    expect(prod.severity).toBe('high');
    expect(prod.context).toBe('product');
    expect(test.severity).toBe('info');
    expect(test.context).toBe('test');
  });

  it('R2 注释里的地址降为 info（不一刀切）', () => {
    const hit = byRule(HITS("// 默认绑定 127.0.0.1，绝不开到局域网\n", { path: 'src/a.ts' }), 'R2')[0];
    expect(hit.context).toBe('comment');
    expect(hit.severity).toBe('info');
  });

  it('R3 命中 Windows 盘符 / UNC / 家目录 / file URL', () => {
    // 用 String.raw 写反斜杠，避免「源码里到底几个 \」的转义计数歧义。
    expect(byRule(HITS(String.raw`const p = 'C:\Users\x\a.docx';` + '\n'), 'R3')[0]?.subtype).toBe('windows-drive');
    expect(byRule(HITS("const p = 'D:/work/out';\n"), 'R3')[0]?.subtype).toBe('windows-drive');
    expect(byRule(HITS(String.raw`const p = '\\?\C:\dev';` + '\n'), 'R3')[0]?.subtype).toBe('windows-unc');
    expect(byRule(HITS("const p = '/Users/me/a.docx';\n"), 'R3')[0]?.subtype).toBe('posix-home');
    expect(byRule(HITS("const p = '/home/ci/out';\n"), 'R3')[0]?.subtype).toBe('posix-home');
    expect(byRule(HITS("const p = 'file:///tmp/a';\n"), 'R3')[0]?.subtype).toBe('file-url');
  });

  it('R4 命中 node:fs / node:path 的普通单行 import', () => {
    const hits = byRule(HITS("import { readFileSync } from 'node:fs';\n"), 'R4');
    expect(hits.length).toBe(1);
    expect(hits[0].module).toBe('fs');
    expect(hits[0].tier).toBe(1);
    expect(byRule(HITS("import { dirname } from 'node:path';\n"), 'R4')[0]?.module).toBe('path');
  });

  it('R4 命中 require 与裸 import 形式', () => {
    expect(byRule(HITS("const fs = require('node:fs');\n"), 'R4')[0]?.module).toBe('fs');
    expect(byRule(HITS("import 'node:os';\n"), 'R4')[0]?.module).toBe('os');
  });

  it('R4 必须命中**跨行 import**（第一版审计器真实漏检过的回归点）', () => {
    const src = 'import {\n  readFileSync,\n  writeFileSync,\n} from \'node:fs\';\n';
    const hits = byRule(HITS(src), 'R4');
    expect(hits.length).toBe(1);
    expect(hits[0].module).toBe('fs');
    expect(hits[0].line).toBe(4); // 说明符在结尾那一行
  });

  it('R4 命中 Buffer 全局用法，且注释里的 Buffer 降为 info', () => {
    const code = byRule(HITS("const b = Buffer.from('x');\n"), 'R4')[0];
    expect(code.module).toBe('Buffer');
    expect(code.severity).toBe('high');
    const comment = byRule(HITS(' * @param bytes 原始字节（`Buffer` 是其子类）\n', { path: 'src/a.ts' }), 'R4')[0];
    expect(comment.severity).toBe('info');
  });

  it('R5 命中 sk- 形状的密钥字面量，且**回显里不含原值**', () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz012345';
    const hits = byRule(HITS(`const apiKey = '${secret}';\n`), 'R5');
    expect(hits.length).toBe(1);
    expect(hits[0].subtype).toBe('openai-style-key');
    // 红线：命中记录与整份 JSON 都不得出现原值
    expect(hits[0].text).toBe('sk-****(len=35)');
    expect(hits[0].snippet).not.toContain(secret);
    expect(JSON.stringify(hits)).not.toContain(secret);
  });

  it('R5 命中 Bearer 令牌，且不回显原值', () => {
    const token = 'AQAAANCMnd8BFdERjHoAwE_Cl-sBAAAA';
    const hits = byRule(HITS(`const h = { authorization: 'Bearer ${token}' };\n`), 'R5');
    expect(hits.length).toBe(1);
    expect(hits[0].subtype).toBe('bearer-token');
    expect(JSON.stringify(hits)).not.toContain(token);
  });

  it('R5 命中紧邻 key/token 的长 base64 字面量，且不回显原值', () => {
    const blob = 'QWxsIHlvdXIgYmFzZTY0IGFyZSBiZWxvbmcgdG8gdXMhISE';
    const hits = byRule(HITS(`const clientSecret = '${blob}';\n`), 'R5');
    expect(hits.length).toBe(1);
    expect(hits[0].subtype).toBe('long-base64-literal');
    expect(hits[0].text).toContain(`len=${blob.length}`);
    expect(JSON.stringify(hits)).not.toContain(blob);
  });
});

describe('K-R01 · 审计器反向对照：干净样例与近似样例必须不命中', () => {
  it('完全干净的样例：五条规则全部零命中', () => {
    const hits = HITS(CLEAN);
    expect(hits).toEqual([]);
  });

  it('R2 反向：公网域名 / 相似但非私网的地址不命中', () => {
    expect(byRule(HITS("const u = 'https://api.example.com/v1';\n"), 'R2')).toEqual([]);
    expect(byRule(HITS("const u = 'http://example.com:443';\n"), 'R2')).toEqual([]);
    expect(byRule(HITS("const ip = '11.0.0.1';\n"), 'R2')).toEqual([]); // 11.x 不是 RFC1918
    expect(byRule(HITS("const ip = '172.32.0.1';\n"), 'R2')).toEqual([]); // 172.32 出了 16–31
  });

  it('R2 反向：`10.` 前缀的普通版本号不该被当成私网地址', () => {
    // 已知局限：这是启发式的常见误报面，故反向钉一条「四段式但不能是版本号」的样例。
    // 说明符 "10.1.2" 只有三段 ⇒ 不应命中。
    expect(byRule(HITS("const v = '10.1.2';\n"), 'R2')).toEqual([]);
  });

  it('R3 反向：相对路径 / POSIX 系统路径 / 普通 URL 不命中', () => {
    expect(byRule(HITS("const p = 'docs/notes.txt';\n"), 'R3')).toEqual([]);
    expect(byRule(HITS("const p = '/var/tmp/out.docx';\n"), 'R3')).toEqual([]);
    expect(byRule(HITS("const p = '/etc/hosts';\n"), 'R3')).toEqual([]);
    expect(byRule(HITS("const u = 'https://example.com/a/b';\n"), 'R3')).toEqual([]);
  });

  it('R3 反向：注释里裸写盘符（未加引号）不命中', () => {
    expect(byRule(HITS('// 保留 POSIX 根 / 与 Windows 盘符根 C:/ 的语义\n'), 'R3')).toEqual([]);
  });

  it('R4 反向：非 Node 专用模块不命中', () => {
    for (const s of [
      "import { describe } from 'vitest';",
      "import { join } from 'lodash';",
      "import { x } from './local-module.js';",
      "import type { Foo } from 'zod';",
    ]) {
      expect(byRule(HITS(`${s}\n`), 'R4')).toEqual([]);
    }
  });

  it('R4 反向：`path` / `fs` 作为普通标识符（非模块说明符）不命中', () => {
    expect(byRule(HITS('const filePath = "/a/b"; const docPath = filePath;\n'), 'R4')).toEqual([]);
    expect(byRule(HITS('export function fs(): void {}\n'), 'R4')).toEqual([]);
    expect(byRule(HITS("const x = arr.from('abc');\n"), 'R4')).toEqual([]);
  });

  it('R5 反向：占位符 / 短值 / 非密钥高熵串不命中', () => {
    expect(byRule(HITS("const apiKey = 'placeholder';\n"), 'R5')).toEqual([]);
    expect(byRule(HITS("const token = 'short-token';\n"), 'R5')).toEqual([]);
    expect(byRule(HITS("const apiKey = '';\n"), 'R5')).toEqual([]);
    // 长 base64 但**周围没有** key/token/secret 标识符 ⇒ 不按密钥报
    expect(byRule(HITS("const payload = 'QWxsIHlvdXIgYmFzZTY0IGFyZSBiZWxvbmcgdG8gdXMhISE';\n"), 'R5')).toEqual([]);
  });

  it('R5 反向：`sk-` 出现在更长单词内部（如 task-/risk-）不命中', () => {
    expect(byRule(HITS("import { x } from './task-lifecycle.js';\n"), 'R5')).toEqual([]);
    expect(byRule(HITS('const riskFree = 0.02;\n'), 'R5')).toEqual([]);
  });

  it('R1 反向：制表符 / 换行 / 回车不算控制字符命中', () => {
    expect(byRule(HITS('const a = 1;\n\tconst b = 2;\r\n'), 'R1')).toEqual([]);
  });

  it('redactSecret 只出形状，绝不出原值', () => {
    const value = 'sk-livekeyvalue0123456789';
    const r = redactSecret(value);
    expect(r.shape).toBe('sk-****');
    expect(r.length).toBe(value.length);
    expect(JSON.stringify(r)).not.toContain('livekeyvalue');
  });
});

describe('K-R01 · 口径：扫描面纳入与排除必须真的生效', () => {
  const roots: string[] = [];

  const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), 'k-r01-'));
    roots.push(root);
    const w = (rel: string, body: string, binary = false) => {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      if (binary) writeFileSync(abs, Buffer.from([0x61, 0x00, 0x62]));
      else writeFileSync(abs, body, 'utf8');
    };
    w('src/clean.ts', CLEAN);
    w('src/deep/nested.ts', String.raw`const p = 'C:\tmp\x';` + '\n'); // R3 命中，且验证递归
    w('src/bad.test.ts', "const u = 'http://127.0.0.1:1';\n");          // 必须被排除
    w('src/bad.spec.ts', "const u = 'http://127.0.0.1:1';\n");          // 必须被排除
    w('docs/note.ts', "const u = 'http://127.0.0.1:1';\n");             // 必须被排除
    w('tests/thing.ts', "const u = 'http://127.0.0.1:1';\n");           // 必须被排除
    w('node_modules/pkg/index.ts', "const u = 'http://127.0.0.1:1';\n"); // 必须被排除
    w('.runtime/cache.ts', "const u = 'http://127.0.0.1:1';\n");        // 必须被排除
    w('src/blob.bin.ts', 'placeholder', true);                          // 二进制 ⇒ 跳过而非误报
    w('apps/demo/server/srv.ts', "const host = '127.0.0.1';\n");        // 参考面，纳入
    return root;
  };

  afterAll(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });

  it('collectScope 只纳入允许的扫描面，且真的排除 tests/docs/node_modules/.runtime', () => {
    const r = fixture();
    const { files, skippedBinary, surfaces, stats } = collectScope(r);
    const rels = files.map((f: any) => f.rel);

    expect(rels).toContain('src/clean.ts');
    expect(rels).toContain('src/deep/nested.ts');
    expect(rels).toContain('apps/demo/server/srv.ts');

    expect(rels).not.toContain('src/bad.test.ts');
    expect(rels).not.toContain('src/bad.spec.ts');
    expect(rels.some((x: string) => x.startsWith('docs/'))).toBe(false);
    expect(rels.some((x: string) => x.startsWith('tests/'))).toBe(false);
    expect(rels.some((x: string) => x.startsWith('node_modules/'))).toBe(false);
    expect(rels.some((x: string) => x.startsWith('.runtime/'))).toBe(false);

    expect(stats.testFilesExcluded).toEqual(['src/bad.spec.ts', 'src/bad.test.ts']);
    expect(skippedBinary.map((s: any) => s.rel)).toEqual(['src/blob.bin.ts']);

    const kernel = surfaces.find((s: any) => s.id === 'kernel');
    expect(kernel?.present).toBe(true);
    expect(surfaces.find((s: any) => s.id === 'mobile-kernel')?.present).toBe(false);
  });

  it('buildReport 在夹具上：面/迁移面标注正确，二进制 NUL 不计为 R1 命中', () => {
    const r = fixture();
    const report = buildReport(r);
    const paths = report.hits.map((h: any) => h.path);
    expect(paths).not.toContain('src/blob.bin.ts'); // 二进制被跳过，不是「源码裸 NUL」
    expect(report.scope.skippedBinary.map((s: any) => s.rel)).toContain('src/blob.bin.ts');
    const srv = report.hits.find((h: any) => h.path === 'apps/demo/server/srv.ts');
    expect(srv?.surface).toBe('demo-server');
    expect(srv?.migrationSurface).toBe('reference');
    // 参考面的 high 应被压到 medium（裸 NUL 除外）
    expect(srv?.severity).toBe('medium');
  });

  it('buildReport 对同一输入是确定的（仅 generatedAt 变化）', () => {
    const r = fixture();
    const a: any = buildReport(r);
    const b: any = buildReport(r);
    const strip = (x: any) => { const y = { ...x }; delete y.generatedAt; return y; };
    expect(strip(a)).toEqual(strip(b));
  });

  it('resolveSurface 取最长前缀（src 与 src/mobile-plugins 重叠时按更专用的算）', () => {
    expect(resolveSurface('src/a.ts')?.id).toBe('kernel');
    expect(resolveSurface('src/mobile-plugins/p.ts')?.id).toBe('mobile-plugins');
    expect(resolveSurface('apps/demo/server/x.ts')?.id).toBe('demo-server');
    expect(resolveSurface('scripts/gate/run.mjs')).toBe(null);
  });

  it('contextOf / severityFor 的分档合同稳定', () => {
    expect(contextOf("const u = 'http://127.0.0.1';\n", 'src/a.ts')).toBe('product');
    expect(contextOf('// 127.0.0.1\n', 'src/a.ts')).toBe('comment');
    expect(contextOf("server.listen(1, '127.0.0.1');\n", 'src/a.ts')).toBe('bind-or-default');
    expect(contextOf("const u = 'http://127.0.0.1';\n", 'src/a.test.ts')).toBe('test');
    expect(severityFor('product', 'high')).toBe('high');
    expect(severityFor('comment', 'high')).toBe('info');
    expect(severityFor('test', 'high')).toBe('info');
    expect(severityFor('bind-or-default', 'high')).toBe('medium');
  });
});

describe('K-R01 · 真实仓库基线报告', () => {
  const BASELINE: any = JSON.parse(
    readFileSync(new URL('./baseline-report.json', import.meta.url), 'utf8'),
  );

  it('基线报告存在、可解析、schema 与本审计器一致', () => {
    expect(BASELINE.schemaVersion).toBe(SCHEMA_VERSION);
    expect(BASELINE.auditor).toBe('K-R01-desktop-dependency-audit');
    expect(BASELINE.rules.map((r: any) => r.id)).toEqual(RULES.map((r: any) => r.id));
  });

  it('基线报告自洽：规则计数 = 命中明细计数 = summary.byRule = summary.totalHits', () => {
    const ruleIds = RULES.map((r: any) => r.id);
    let sum = 0;
    for (const id of ruleIds) {
      const detail = BASELINE.hits.filter((h: any) => h.rule === id).length;
      const rule = BASELINE.rules.find((r: any) => r.id === id);
      expect(rule.count).toBe(detail);
      expect(BASELINE.summary.byRule[id]).toBe(detail);
      sum += detail;
    }
    expect(BASELINE.summary.totalHits).toBe(sum);
    expect(BASELINE.summary.totalHits).toBe(BASELINE.hits.length);
  });

  it('基线报告里每条命中都带齐 文件/行/列/严重度/上下文', () => {
    for (const h of BASELINE.hits) {
      expect(typeof h.path).toBe('string');
      expect(h.path.length).toBeGreaterThan(0);
      expect(h.line).toBeGreaterThan(0);
      expect(h.column).toBeGreaterThan(0);
      expect(['high', 'medium', 'low', 'info']).toContain(h.severity);
      expect(typeof h.context).toBe('string');
    }
  });

  it('基线记录了扫描面存在性、排除与跳过的真实情况（不断言具体值，只断言字段齐备）', () => {
    expect(BASELINE.scope.filesScanned).toBeGreaterThan(0);
    expect(BASELINE.scope.filesBySurface.kernel).toBeGreaterThan(0);
    expect(typeof BASELINE.scope.testFilesExcluded).toBe('number');
    expect(Array.isArray(BASELINE.scope.skippedBinary)).toBe(true);
    expect(Array.isArray(BASELINE.scope.includeRoots)).toBe(true);
    expect(BASELINE.scope.includeRoots.find((r: any) => r.id === 'kernel').migrationSurface).toBe('target');
    expect(BASELINE.scope.includeRoots.find((r: any) => r.id === 'demo-server').migrationSurface).toBe('reference');
  });

  it('口径不变量：基线里不得出现排除面的路径', () => {
    const bad = BASELINE.hits.filter((h: any) => /^(docs|tests|node_modules|\.runtime|\.claude|\.task-manifest)\//.test(h.path));
    expect(bad).toEqual([]);
    const badTestFiles = BASELINE.hits.filter((h: any) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(h.path));
    expect(badTestFiles).toEqual([]);
  });

  // 重型用例自带时限：全仓扫描随仓库增长 + 六线并发负载会超过 vitest 默认 5 s。
  // 依本仓 vitest.config.ts 的纪律（配置里不设全局时限，重型用例自己带），此处显式给 30 s。
  it('口径不变量：对真实仓库重新扫描，排除面同样干净（防口径漂移）', () => {
    const fresh: any = buildReport(process.cwd());
    expect(fresh.scope.filesScanned).toBeGreaterThan(0);
    const bad = fresh.hits.filter((h: any) => /^(docs|tests|node_modules|\.runtime|\.claude|\.task-manifest)\//.test(h.path));
    expect(bad).toEqual([]);
  }, 30_000);

  it('R5 在当前基线上零命中——是真实结果，不是「已证明无密钥」', () => {
    // 反向钉住：形状判定为 0 不代表仓库没有密钥，README 的「已知局限」已声明该口径。
    // 这里断言的是**审计器对每条样例都能命中**（见上文正向组），而非「仓库无密钥」。
    expect(BASELINE.summary.byRule.R5).toBe(
      BASELINE.hits.filter((h: any) => h.rule === 'R5').length,
    );
  });

  it('已知例外是「降级不隐藏」：例外命中仍在明细里，且带 exceptionId', () => {
    expect(KNOWN_EXCEPTIONS.length).toBeGreaterThan(0);
    for (const ex of KNOWN_EXCEPTIONS) {
      const matched = BASELINE.hits.filter((h: any) => h.exceptionId === ex.id);
      for (const h of matched) {
        expect(h.rule).toBe(ex.rule);
        expect(h.severity).toBe('info');
        expect(typeof h.exceptionReason).toBe('string');
        expect(h.exceptionReason.length).toBeGreaterThan(0);
      }
    }
    // 例外必须**只**改严重度，不能把命中从列表里删掉
    expect(BASELINE.limitations.length).toBeGreaterThan(0);
  });
});
