/**
 * FA-VERIFY-WAVE-8 · T5 —— **独立复算实现方的机器化守卫** `route-dispatch-guard`。
 *
 * 纪律（任务明文）："若 `route-dispatch-guard.test.ts` 已在 main，**独立复算它、别只信它**"。
 *
 * 本工作树开工时（`50d8dcc`）该守卫**尚不存在**；验证过程中 `main` 前进到 `23acad3` 并合入了它
 * （`2e9025b` 的合并说明自称"用 route-dispatch-guard 复核：11/11 绿"）。故本文件：
 *
 * 1. **自己跑一遍** `scanHttpSource`（不引用它的测试结论）；
 * 2. **独立量它的覆盖面——把现推前缀表与验证方自己的 `DELEGATED_ROUTES` 对表` 对表；
 * 3. **独立验它会红**——抹掉一行真实派发行，看三条规则是否真报红；
 * 4. **独立验它的 `stripComments` 不把真文件读废**。
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  deriveMountedPrefixes,
  createWorkspaceModuleReader,
  scanHttpSource,
  stripComments,
} from '../../../apps/demo/server/route-dispatch-scan.js';
import { DELEGATED_ROUTES } from './dispatch-graph.js';

const REPO = join(import.meta.dirname, '..', '..', '..');
const SERVER_DIR = join(REPO, 'apps', 'demo', 'server');
const REAL = readFileSync(join(SERVER_DIR, 'http.ts'), 'utf8');
const READER = createWorkspaceModuleReader(SERVER_DIR);

describe('T5 · 独立复算 route-dispatch-guard', () => {
  it('① 真实 http.ts 上，实现方守卫确实零报红（验证方自己跑出来的）', () => {
    const findings = scanHttpSource(REAL, READER);
    expect(findings.map((f) => `${f.kind}:${f.symbol}`)).toEqual([]);
  });

  it('② 守卫的 stripComments 在真文件上不把内容读废（行数守恒 + 注释文字真被抹掉）', () => {
    const stripped = stripComments(REAL);
    expect(stripped.split('\n').length).toBe(REAL.split('\n').length);
    // 这几个短语只出现在注释里；若抹平后仍在 ⇒ 状态机走偏（正则里的引号把 code 误当字符串）。
    for (const commentOnly of ['不暴露密钥', '兜底 404', '被并集吞掉', '路径穿越']) {
      expect(stripped.includes(commentOnly), `注释文字「${commentOnly}」未被抹掉`).toBe(false);
    }
    // 代码里的关键字仍在（没被反向吃掉）。
    expect(stripped).toContain('const handle = async');
    expect(stripped).toContain('await handleToolLoopRequest');
  });

  it('③ 守卫真会红：抹掉 facts 派发行 ⇒ 规则 A 报红', () => {
    const mutated = REAL.split('\n')
      .map((line) => (line.includes('await handleFactsRequest(') ? '' : line))
      .join('\n');
    expect(mutated).not.toBe(REAL);
    const keys = scanHttpSource(mutated, READER).map((f) => `${f.kind}:${f.symbol}`);
    expect(keys).toContain('handle-import-not-dispatched:handleFactsRequest');
    expect(keys).toContain('host-constant-never-read:factsHost');
  });

  it('④ 覆盖面复算：守卫的前缀表**没有** `__MISSING__`（独立量出的差距）', () => {
    // 独立量：守卫登记的 vs 验证方认定的「转交前缀」。
    const guarded = deriveMountedPrefixes(REAL, READER).prefixes.map((entry) => entry.prefix);
    const delegated = DELEGATED_ROUTES.map((unit) => unit.root);
    // `/api/adapters/actions` 由 `/api/adapters` 覆盖（子前缀），故按前缀包含关系判"被覆盖"。
    const covered = (prefix: string): boolean =>
      guarded.some((g) => g === prefix || prefix.startsWith(`${g}/`));
    const unguardedDelegated = delegated.filter((prefix) => !covered(prefix));
    // 如实记录差距：`/api/facts`（本轮新合入）不在守卫的前缀表里。
    expect(unguardedDelegated.sort()).toEqual(['/api/facts']);
    // 守卫表里的每一个，验证方也认为它是「转交前缀」（无分歧，防两份表各说各话）。
    for (const entry of deriveMountedPrefixes(REAL, READER).prefixes) {
      expect(delegated, `守卫表里的 ${entry.prefix} 不在验证方的转交前缀里`).toContain(entry.prefix);
    }
    expect(guarded).toHaveLength(10);
  });

  it('⑤ 守卫对 http.ts 自有前缀（非转交）本就不覆盖——如实记录', () => {
    // 守卫表只覆盖"独立模块 + *_ROOT 常量"那一类；http.ts 自己实现的路由不在其列。
    const guarded = new Set(deriveMountedPrefixes(REAL, READER).prefixes.map((entry) => entry.prefix));
    for (const own of ['/health', '/api/identity', '/api/tasks', '/api/artifacts', '/api/sessions', '/api/deliverables']) {
      expect(guarded.has(own)).toBe(false);
    }
    // 【翻正】前缀表现由源码现推（fa/guard-prefix-table，2026-10-03）——不再是手抄 10 条。
    expect(deriveMountedPrefixes(REAL, READER).prefixes.length).toBeGreaterThanOrEqual(12);
  });
});
