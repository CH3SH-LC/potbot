/**
 * FA-VERIFY-WAVE-10 · 第 5 项 —— **派发守卫前缀表**独立复核（2026-10-03 14:3x **翻正版**）。
 *
 * ## 本文件的历史与翻正
 *
 * 本项最初复核的是 `27b701e`（"前缀表改为**从源码现推**，补 `/api/facts`，防新增路由忘登记"）。
 * 当时（wave-10 开工候选 `e4bb1b7`）它**不在 HEAD 的祖先里**，因此文件里写的是
 * 「交付树仍是手抄 10 条表 ⇒ `/api/facts`、`/api/session-adapters`、`/api/krn-barrel`
 * 三条真实覆盖缺口 ⇒ 自造新路由不会自动进表 = 假绿」。
 *
 * **该缺口随后已闭合**：协调者把它合入 main（`2c61684`），并同步修好了另两处引用旧常量的探针。
 * 本文件随之**翻正**为断言"**已从源码现推**"，但**保留判别力**：
 * 若有人把手抄表塞回去，下面每条都会重新变红。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createWorkspaceModuleReader,
  deriveMountedPrefixes,
  scanHttpSource,
} from '../../../apps/demo/server/route-dispatch-scan.js';

const REPO_ROOT = process.cwd();
const SERVER_DIR = join(REPO_ROOT, 'apps', 'demo', 'server');
const REAL_HTTP = readFileSync(join(SERVER_DIR, 'http.ts'), 'utf8');
const READER = createWorkspaceModuleReader(SERVER_DIR);
const TABLE = deriveMountedPrefixes(REAL_HTTP, READER);

describe('T5 · 派发守卫前缀表：已由源码现推（翻正）', () => {
  it('【翻正】源码里有 deriveMountedPrefixes、**没有**手抄常量', () => {
    // 原断言固化的是"手抄 10 条表"这一缺陷；现在断言的是修好之后的状态。
    const scanSource = readFileSync(join(SERVER_DIR, 'route-dispatch-scan.ts'), 'utf8');
    expect(scanSource).toContain('export function deriveMountedPrefixes');
    expect(scanSource).not.toContain('export const MOUNTED_PREFIXES');
  });

  it('【翻正】现推表**包含**三条曾经缺失的前缀（原覆盖缺口已闭合）', () => {
    const prefixes = TABLE.prefixes.map((entry) => entry.prefix);
    for (const missing of ['/api/facts', '/api/krn-barrel', '/api/session-adapters']) {
      expect(prefixes, `现推表缺少 ${missing}`).toContain(missing);
    }
    // 真实性：http.ts 确实在派发 facts（否则"包含"没有意义）。
    expect(REAL_HTTP).toMatch(/\bawait\s+handleFactsRequest\s*\(/);
  });

  it('表规模 ≥ 12 且每条都有可解析的派发行（防"现推"退化成空表）', () => {
    expect(TABLE.prefixes.length).toBeGreaterThanOrEqual(12);
    expect(TABLE.unownedDispatches).toEqual([]);
  });

  it('【判别力】自造"新路由 + 派发"必须**自动进表**（手抄表做不到这一点）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'potbot-prefix-'));
    try {
      const widget = "export const WIDGET_ROOT = '/api/widgets';\nexport async function handleWidgetRequest(): Promise<boolean> { return false; }\n";
      writeFileSync(join(dir, 'widget-routes.ts'), widget);
      const http =
        "import { handleWidgetRequest } from './widget-routes.js';\n" +
        'async function handle(): Promise<void> {\n' +
        '  if (await handleWidgetRequest()) { return; }\n' +
        '}\n';
      const reader = (rel: string): string =>
        rel === 'widget-routes.ts' ? widget : rel === 'http.ts' ? http : '';
      const derived = deriveMountedPrefixes(http, reader);
      expect(derived.prefixes.map((entry) => entry.prefix)).toContain('/api/widgets');
      expect(derived.unownedDispatches).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('【判别力】派发一个**没有 `*_ROOT` 常量**的幽灵路由 ⇒ 必须报红（不是静默通过）', () => {
    const http =
      "import { handleGhostRequest } from './ghost-routes.js';\n" +
      'async function handle(): Promise<void> {\n' +
      '  if (await handleGhostRequest()) { return; }\n' +
      '}\n';
    const reader = (rel: string): string =>
      rel === 'ghost-routes.ts' ? 'export async function handleGhostRequest(): Promise<boolean> { return false; }\n' : '';
    const derived = deriveMountedPrefixes(http, reader);
    expect(derived.unownedDispatches.length).toBeGreaterThan(0);
  });

  it('守卫在**真实 http.ts** 上零报红（含规则 A/B/C）', () => {
    expect(scanHttpSource(REAL_HTTP, READER)).toEqual([]);
  });
});
