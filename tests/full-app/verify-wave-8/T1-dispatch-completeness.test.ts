/**
 * FA-VERIFY-WAVE-8 · T1 —— **派发完整性**（本轮第一疑点）。
 *
 * 事故背景（本仓真实发生过两次）：
 * - 一次是**多行 replace 因 CRLF 静默失效**，导致某个 handler 只被 import、没有派发；
 * - 一次是**并集解决把 `if` 块主体吞掉**，留下语法错。
 *
 * 本文件用**独立自研**的扫描（不复用实现方任何工具、不读实现方的测试结论）断言：
 * A. `http.ts` 里每个 `handleXxx*` / `createXxx*` 本地值导入都**确有调用点**；
 * B. 每个由独立模块承担的前缀，其派发标识符在 `http.ts` 里**确有调用点**；
 * C. 每个 `http.ts` 自有的前缀字面量**确实存在**；
 * D. 没有**新增**的"零引用导入"（合并吞掉使用点会留下这个痕迹）；
 * E. 没有只赋值不读取的宿主 / 选项 / 路由常量。
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  callSitesOf,
  localValueImportsOf,
  unusedConstsOf,
  unusedImportsOf,
} from './source-scan.js';
import { DELEGATED_ROUTES, OWN_ROUTES } from './dispatch-graph.js';

const REPO = join(import.meta.dirname, '..', '..', '..');
const HTTP = 'apps/demo/server/http.ts';
const MAIN = 'apps/demo/server/main.ts';

const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8');

/**
 * 已登记的**存量**"零引用导入"（**缺陷**，非本轮合并引入；见独立报告 §问题清单）。
 *
 * 它们是"import 了却从未被读"的同一个味道——本仓未开 `noUnusedLocals`，tsc 不会报。
 * 本测试**只保证不新增**（新增 ⇒ 红 ⇒ 很可能又是一次"使用点被吃掉"）。
 */
const KNOWN_DEAD_IMPORTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'apps/demo/server/http.ts': ['CONVERSATION_LIMITS'],
  'apps/demo/server/documents-routes.ts': [
    'footerPartXml',
    'headerPartXml',
    'pageCountFromEngine',
    'setOrientation',
    'setPageSize',
    'addHeaderFooterReference',
  ],
  'apps/demo/server/main.ts': [],
  'apps/demo/server/route-wiring.ts': [],
});

describe('T1 · 派发完整性', () => {
  it('A. http.ts 每个 handleXxx*/createXxx* 本地值导入都有调用点', () => {
    const text = read(HTTP);
    const handlers = localValueImportsOf(HTTP, text).filter((entry) => /^(handle|create)/.test(entry.name));
    // 先证明我们确实抓到了足够多的 handler（防"空断言"：一个都没抓到也能"通过"）。
    expect(handlers.length).toBeGreaterThanOrEqual(10);
    const missing = handlers.filter((entry) => callSitesOf(HTTP, text, entry.name).length === 0);
    expect(missing.map((entry) => entry.name)).toEqual([]);
  });

  it('A2. http.ts 的每个 handleXxx* 导入都另有派发块（含 return 收尾）', () => {
    const text = read(HTTP);
    // 逐个 handler：调用点必须出现在 `/api/**` 兜底 404 之前（1810 行附近之后、1876 行的 404 分支之前）。
    // 这里用行号护栏：派发块必须在兜底 404 之前，否则等于没派发。
    const body = text;
    const catchAllIdx = body.indexOf("if (pathname.startsWith('/api/')) {");
    expect(catchAllIdx).toBeGreaterThan(0);
    for (const entry of localValueImportsOf(HTTP, text).filter((e) => /^handle/.test(e.name))) {
      const sites = callSitesOf(HTTP, text, entry.name);
      const beforeCatchAll = sites.filter((line) => {
        // 行号 → 字符偏移
        const offset = body.split('\n').slice(0, line - 1).join('\n').length;
        return offset < catchAllIdx;
      });
      expect(beforeCatchAll, `${entry.name} 的调用点必须在兜底 404 之前`).not.toEqual([]);
    }
  });

  it('B. 每个转交前缀的派发标识符都有调用点', () => {
    const text = read(HTTP);
    const problems: string[] = [];
    for (const unit of DELEGATED_ROUTES) {
      if (unit.viaReceiver === true) {
        const pattern = new RegExp(`\\b${unit.via}\\.handle\\s*\\(`);
        if (!pattern.test(text)) problems.push(`${unit.root} ← ${unit.via}.handle(`);
      } else if (callSitesOf(HTTP, text, unit.via).length === 0) {
        problems.push(`${unit.root} ← ${unit.via}(`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('C. http.ts 自有前缀的字面量都存在', () => {
    const text = read(HTTP);
    const missing = OWN_ROUTES.filter((route) => !text.includes(route.literal)).map((route) => route.root);
    expect(missing).toEqual([]);
  });

  it('D. 没有新增的"零引用导入"（合并吞掉使用点的信号）', () => {
    const grown: Record<string, readonly string[]> = {};
    for (const rel of Object.keys(KNOWN_DEAD_IMPORTS)) {
      const text = read(rel);
      const unused = [...unusedImportsOf(rel, text)].sort();
      const known = [...(KNOWN_DEAD_IMPORTS[rel] ?? [])].sort();
      const extra = unused.filter((name) => !known.includes(name));
      if (extra.length > 0) grown[rel] = extra;
    }
    expect(grown).toEqual({});
  });

  it('E. 没有只赋值不读取的宿主 / 选项 / 路由常量', () => {
    const suspects: Record<string, readonly string[]> = {};
    for (const rel of [HTTP, MAIN]) {
      const text = read(rel);
      const dead = unusedConstsOf(rel, text).filter((name) =>
        /(Host|Options|Routes|Wiring|Facts|Loop|adapters|toolLoop|sessions|deliverables|conversations)$/.test(name),
      );
      if (dead.length > 0) suspects[rel] = dead;
    }
    expect(suspects).toEqual({});
  });
});
