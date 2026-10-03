/**
 * X-I28（池位 28）：**桥接层源码纪律的机器化断言**。
 *
 * 本单元的产品代码（`src/mobile-plugins/spreadsheets/bridge/**`）必须能在 WebView / 安卓内核里跑，
 * 因此：
 *
 * 1. **零 Node 内置**：不 import / require 任何 `node:*`（本单元点名 `node:fs` / `node:path` /
 *    `node:zlib` 三个最易混入的），也不 import 任何裸包名（内核无运行期依赖）。
 * 2. **零墙钟 / 零随机**：代码里不出现 `Date.now(` / `new Date(` / `performance.now(` /
 *    `Math.random(` / `process.pid` / `process.platform` / `toLocaleString`。
 *
 * 这是**扫描器**：读文件是验收侧行为（本文件在 `tests/**`，允许用 Node 内置）。
 * 反向对照：对一段自造的违例文本，扫描器必须逐个命中（防"扫描器没生效"的假绿）。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const BRIDGE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'src',
  'mobile-plugins',
  'spreadsheets',
  'bridge',
);

const FORBIDDEN_RUNTIME_TOKENS: readonly string[] = Object.freeze([
  'Date.now(',
  'new Date(',
  'performance.now(',
  'Math.random(',
  'process.pid',
  'process.platform',
  'toLocaleString',
]);

function bridgeFiles(): readonly string[] {
  return readdirSync(BRIDGE_DIR)
    .filter((name) => name.endsWith('.ts'))
    .sort();
}

describe('X-I28 · 桥接层源码纪律', () => {
  it('扫描器确实扫到了 bridge 目录下的源码文件（防空集假绿）', () => {
    const files = bridgeFiles();
    expect(files.length).toBeGreaterThanOrEqual(4);
    expect(files).toContain('index.ts');
    expect(files).toContain('codec.ts');
    expect(files).toContain('session-store.ts');
  });

  it('没有 import / require 任何 node:* 内建（点名 node:fs / node:path / node:zlib）', () => {
    const offenders: string[] = [];
    for (const name of bridgeFiles()) {
      const text = readFileSync(join(BRIDGE_DIR, name), 'utf8');
      // import ... from 'node:x' | import 'node:x' | require('node:x') | import('node:x')
      const patterns = [/'node:[a-z_]+'/g, /"node:[a-z_]+"/g];
      for (const pattern of patterns) {
        const hits = text.match(pattern);
        if (hits !== null) offenders.push(`${name}: ${hits.join(', ')}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('不 import 任何裸包名（内核无运行期依赖：只允许相对路径）', () => {
    const offenders: string[] = [];
    const importSpecifier = /(?:from|require\()\s*['"]([^'"]+)['"]/g;
    for (const name of bridgeFiles()) {
      const text = readFileSync(join(BRIDGE_DIR, name), 'utf8');
      for (const match of text.matchAll(importSpecifier)) {
        const specifier = match[1] ?? '';
        if (specifier.startsWith('./') || specifier.startsWith('../')) continue;
        offenders.push(`${name} → ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('代码里不出现墙钟 / 随机 / 进程 token', () => {
    const offenders: string[] = [];
    for (const name of bridgeFiles()) {
      const text = readFileSync(join(BRIDGE_DIR, name), 'utf8');
      for (const token of FORBIDDEN_RUNTIME_TOKENS) {
        if (text.includes(token)) offenders.push(`${name} → ${token}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('反向对照：自造的违例文本被扫描器逐个命中', () => {
    const snippet = [
      "import { readFileSync } from 'node:fs';",
      "import { deflateSync } from 'node:zlib';",
      "const p = require('node:path');",
      'const a = Date.now();',
      'const b = Math.random();',
      'const c = process.platform;',
    ].join('\n');

    const nodeHits = snippet.match(/'node:[a-z_]+'/g) ?? [];
    expect(nodeHits.length).toBe(3);
    for (const token of ['Date.now(', 'Math.random(', 'process.platform']) {
      expect(snippet.includes(token)).toBe(true);
    }

    const importMatch = [...snippet.matchAll(/(?:from|require\()\s*['"]([^'"]+)['"]/g)]
      .map((m) => m[1] ?? '')
      .filter((s) => !s.startsWith('./') && !s.startsWith('../'));
    expect(importMatch).toHaveLength(3);
  });
});
