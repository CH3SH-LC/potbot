/**
 * FA-VERIFY-WAVE-11 · 第 4 项 —— **派发守卫自动提取**（`2c61684`）独立复核。
 *
 * ## 被复核的断言（任务原文）
 *
 * - 前缀表是否**真现推**；
 * - **自造新路由 + 派发**看是否**自动进表**（手抄表做不到）。
 *
 * ## 本文件怎么做
 *
 * ① 表规模与"无手抄常量"（`export const MOUNTED_PREFIXES` 必须不存在）；
 * ② **自造**：拿**真实** `http.ts` 的源码副本，往里注入"一条 import + 一条派发"
 *    （并让 reader 供上对应的新模块源码）⇒ 新前缀**必须自动出现在表里**。
 *    手抄表在这一点上必红，现推表必绿 —— 这是本项的核心判据。
 * ③ **反向**：派发一个**没有 `*_ROOT` 常量**的幽灵路由 ⇒ 必须 `unownedDispatches` 非空（报红，不是静默通过）。
 * ④ **咬合**：在真实 `http.ts` 的副本里**删掉** `/api/facts` 的派发行 ⇒ 守卫必须报 `mounted-prefix-not-dispatched`。
 *    这条证明守卫在**真实源码**上是有荷载的，不是只在我造的样例上工作。
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createWorkspaceModuleReader,
  deriveMountedPrefixes,
  formatFindings,
  scanHttpSource,
} from '../../../apps/demo/server/route-dispatch-scan.js';

const REPO = process.cwd();
const SERVER_DIR = join(REPO, 'apps', 'demo', 'server');
const REAL_HTTP = readFileSync(join(SERVER_DIR, 'http.ts'), 'utf8');
const REAL_READER = createWorkspaceModuleReader(SERVER_DIR);

/** 在真实 http.ts 源码里注入"一条 import + 一条派发"，并给出对应的新模块 reader。 */
function httpWithInjectedRoute(input: {
  readonly importLine: string;
  readonly dispatchLine: string;
  readonly moduleFile: string;
  readonly moduleSource: string;
}): { readonly http: string; readonly reader: (rel: string) => string } {
  const http = `${input.importLine}\n${REAL_HTTP.replace(
    'const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {',
    `const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {\n    ${input.dispatchLine}`,
  )}`;
  return {
    http,
    reader: (rel: string): string =>
      rel === input.moduleFile ? input.moduleSource : REAL_READER(rel),
  };
}

describe('W11-T4 · 前缀表是「从源码现推」，不是手抄', () => {
  it('扫描器源码里有 deriveMountedPrefixes、没有手抄的 MOUNTED_PREFIXES 常量', () => {
    const scanSource = readFileSync(join(SERVER_DIR, 'route-dispatch-scan.ts'), 'utf8');
    expect(scanSource).toContain('export function deriveMountedPrefixes');
    expect(scanSource).not.toContain('export const MOUNTED_PREFIXES');
  });

  it('真实 http.ts 上零报红；表包含曾经缺失的三条前缀', () => {
    const table = deriveMountedPrefixes(REAL_HTTP, REAL_READER);
    const prefixes = table.prefixes.map((entry) => entry.prefix);
    for (const missing of ['/api/facts', '/api/krn-barrel', '/api/session-adapters']) {
      expect(prefixes, `现推表缺少 ${missing}`).toContain(missing);
    }
    expect(table.prefixes.length).toBeGreaterThanOrEqual(12);
    expect(table.unownedDispatches).toEqual([]);
    expect(formatFindings(scanHttpSource(REAL_HTTP, REAL_READER))).toBe('');
  });

  it('★自造新路由 + 派发：新前缀必须**自动进表**（手抄表做不到）', () => {
    const injected = httpWithInjectedRoute({
      importLine: "import { handleW11WidgetRequest } from './w11-widget-routes.js';",
      dispatchLine: 'if (await handleW11WidgetRequest()) { return; }',
      moduleFile: 'w11-widget-routes.ts',
      moduleSource:
        "export const W11_WIDGET_ROOT = '/api/w11-widgets';\n" +
        'export async function handleW11WidgetRequest(): Promise<boolean> { return false; }\n',
    });

    // 前置：真实源码里本来**没有**这个前缀（否则"自动进表"无从谈起）。
    expect(REAL_HTTP).not.toContain('/api/w11-widgets');

    const derived = deriveMountedPrefixes(injected.http, injected.reader);
    const entry = derived.prefixes.find((item) => item.prefix === '/api/w11-widgets');
    expect(entry, '自造的新路由必须自动出现在现推表里').toBeDefined();
    expect(entry?.moduleFile).toBe('w11-widget-routes.ts');
    expect(entry?.rootConstant).toBe('W11_WIDGET_ROOT');
    // 它还必须被认出"真的被派发了"（有派发行），而不是只被 import。
    expect(entry?.dispatchLabel ?? '').toContain('handleW11WidgetRequest');
    expect(derived.unownedDispatches).toEqual([]);
  });

  it('★反向：派发一个没有 `*_ROOT` 常量的幽灵路由 ⇒ 必须报红（不是静默通过）', () => {
    const injected = httpWithInjectedRoute({
      importLine: "import { handleW11GhostRequest } from './w11-ghost-routes.js';",
      dispatchLine: 'if (await handleW11GhostRequest()) { return; }',
      moduleFile: 'w11-ghost-routes.ts',
      moduleSource: 'export async function handleW11GhostRequest(): Promise<boolean> { return false; }\n',
    });
    const derived = deriveMountedPrefixes(injected.http, injected.reader);
    expect(derived.unownedDispatches.length, '幽灵路由必须被报红').toBeGreaterThan(0);
    expect(derived.unownedDispatches.map((item) => item.identifier)).toContain('handleW11GhostRequest');
    expect(formatFindings(scanHttpSource(injected.http, injected.reader))).toContain(
      'mounted-prefix-not-owned-by-module',
    );
  });

  it('★咬合：在真实 http.ts 里删掉 /api/facts 的派发行 ⇒ 守卫必须报 mounted-prefix-not-dispatched', () => {
    const dispatchLine = 'if (await handleFactsRequest({ req, res, url, method }, factsHost)) {';
    expect(REAL_HTTP, '真实源码里应有这行派发（否则本条判据不成立）').toContain(dispatchLine);
    const broken = REAL_HTTP.replace(dispatchLine, 'if (false) {');
    const findings = scanHttpSource(broken, REAL_READER);
    const factsFinding = findings.find((finding) => finding.symbol === '/api/facts');
    expect(factsFinding, `删掉派发后必须报红；实测 findings=${formatFindings(findings)}`).toBeDefined();
    expect(factsFinding?.kind).toBe('mounted-prefix-not-dispatched');
  });
});
