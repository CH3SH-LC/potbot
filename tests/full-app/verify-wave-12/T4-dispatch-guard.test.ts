/**
 * FA-VERIFY-WAVE-12 · 第 4 项 —— 派发守卫前缀表"从源码现推"（`2c61684`）独立复核。
 *
 * ## 待验声明（实现方 `2c61684`）
 *
 * `route-dispatch-scan.ts` 的 `deriveMountedPrefixes()` **从 `http.ts` 源码现推**挂载前缀，
 * 取代原先的**手抄常量**表；因此自造"新路由 + 派发"会**自动进表**，`/api/facts`、
 * `/api/session-adapters`、`/api/krn-barrel` 三条曾经漏登记的缺口随之闭合。
 *
 * ## 本文件怎么独立证伪 / 证真
 *
 * 断言分三层：
 *   A. **真实 http.ts** 上现推出的前缀集合**包含**三条曾经缺失的前缀，并且 `http.ts`
 *      确实在派发它们（"包含"不能是空话）；
 *   B. 扫描器**没有**手抄常量（回到手抄表则本组变红）；
 *   C. **自造新路由 + 派发**（本包自己的临时夹具，不复用实现方用例）必须自动进表；
 *      幽灵派发（没有 `*_ROOT` 常量）必须报 `unownedDispatches`。
 *
 * ## 咬合力（谁把它改红）
 *
 * 把 `deriveMountedPrefixes` 换成读一个硬编码常量表（即"手抄"），C 组第一条立刻变红；
 * 把 `scanHttpSource` 的 unowned 判定删掉，C 组第二条变红。本包只报告、不修。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createWorkspaceModuleReader,
  deriveMountedPrefixes,
  scanHttpSource,
} from '../../../apps/demo/server/route-dispatch-scan.js';

const REPO_ROOT = process.cwd();
const SERVER_DIR = join(REPO_ROOT, 'apps', 'demo', 'server');
const HTTP_SOURCE = readFileSync(join(SERVER_DIR, 'http.ts'), 'utf8');
const READER = createWorkspaceModuleReader(SERVER_DIR);

describe('T4 · A 真实 http.ts：现推前缀表（2c61684）', () => {
  const table = deriveMountedPrefixes(HTTP_SOURCE, READER);

  it('包含三条曾漏登记的前缀，且 http.ts 确实派发它们', () => {
    const prefixes = table.prefixes.map((entry) => entry.prefix);
    for (const required of ['/api/facts', '/api/session-adapters', '/api/krn-barrel']) {
      expect(prefixes, `现推表缺 ${required}`).toContain(required);
    }
    // "包含"必须有真实派发行支撑。
    expect(HTTP_SOURCE).toMatch(/\bawait\s+handleFactsRequest\s*\(/);
    expect(HTTP_SOURCE).toMatch(/\bsessionAdaptersRoutes\.handle\s*\(/);
    expect(HTTP_SOURCE).toMatch(/\bkrnBarrelRoutes\.handle\s*\(/);
  });

  it('表规模 ≥ 12 且无"派发但未登记"的悬空项', () => {
    expect(table.prefixes.length).toBeGreaterThanOrEqual(12);
    expect(table.unownedDispatches).toEqual([]);
  });

  it('真实 http.ts 上 scanHttpSource 零报红（规则 A/B/C）', () => {
    expect(scanHttpSource(HTTP_SOURCE, READER)).toEqual([]);
  });
});

describe('T4 · B 扫描器不得是"手抄常量表"', () => {
  it('源码有 deriveMountedPrefixes，且没有 `export const MOUNTED_PREFIXES`', () => {
    const source = readFileSync(join(SERVER_DIR, 'route-dispatch-scan.ts'), 'utf8');
    expect(source).toContain('export function deriveMountedPrefixes');
    expect(source).not.toContain('export const MOUNTED_PREFIXES');
  });
});

describe('T4 · C 判别力：自造新路由 + 派发必须自动进表', () => {
  it('新路由（本包自带夹具）⇒ 现推表自动含它', () => {
    const routeModule =
      "export const GADGET_ROOT = '/api/gadgets';\n" +
      'export async function handleGadgetRequest(): Promise<boolean> { return false; }\n';
    const http =
      "import { handleGadgetRequest } from './gadget-routes.js';\n" +
      'async function serve(): Promise<void> {\n' +
      '  if (await handleGadgetRequest()) { return; }\n' +
      '}\n';
    const read = (rel: string): string => (rel === 'gadget-routes.ts' ? routeModule : rel === 'http.ts' ? http : '');
    const derived = deriveMountedPrefixes(http, read);
    expect(derived.prefixes.map((entry) => entry.prefix)).toContain('/api/gadgets');
    expect(derived.unownedDispatches).toEqual([]);
  });

  it('幽灵派发（没有 *_ROOT 常量）⇒ 必须报 unownedDispatches（不是静默通过）', () => {
    const http =
      "import { handleGhostRequest } from './ghost-routes.js';\n" +
      'async function serve(): Promise<void> {\n' +
      '  if (await handleGhostRequest()) { return; }\n' +
      '}\n';
    const read = (rel: string): string =>
      rel === 'ghost-routes.ts' ? 'export async function handleGhostRequest(): Promise<boolean> { return false; }\n' : '';
    expect(deriveMountedPrefixes(http, read).unownedDispatches.length).toBeGreaterThan(0);
  });
});
