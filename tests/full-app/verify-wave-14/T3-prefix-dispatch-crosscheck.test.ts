/**
 * FA-VERIFY-WAVE-14 · 第 4 项 —— **`/api/**` 前缀表 vs 真实派发**（真服务实测）。
 *
 * ## 判据
 *
 * `route-dispatch-scan.ts` 能从源码**现推**一份"已挂载前缀表"——但它只是**静态**文本分析。
 * 本项做的是**交叉核对**：把现推表里的**每一个**前缀都拿去打**真服务**（`createDemoServer`
 * 起真 `node:http`），确认它**真的被派发**了（响应不是 `/api/**` 兜底 404 的指纹
 * `{code:'not_found', message:'没有这个接口'}`）。
 *
 * 这就是"第六波 `http.ts` import 了却没派发、真服务上整片 404、两个 tsc 全绿"那个坑的
 * **机器化探针**：静态表说挂了、真服务说没挂 ⇒ 本项报红。
 *
 * 另含两条反向对照：
 * - 一个**从未挂载**的命名空间必须**有**兜底指纹（证明探针有辨别力，不是恒不命中）；
 * - `http.ts` 自己实现的既有路由（`/health`、`/api/identity`、`/api/conversations`…）同样
 *   必须**不**落兜底 404（证明"被扫描的实现路由"不是被漏掉的一类）。
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createDemoServer } from '../../../apps/demo/server/main.js';
import {
  createWorkspaceModuleReader,
  deriveMountedPrefixes,
} from '../../../apps/demo/server/route-dispatch-scan.js';
import { getJson, isApiFallback, listen, type Running } from './http.js';

const REPO = process.cwd();
const SERVER_DIR = join(REPO, 'apps', 'demo', 'server');
const REAL_HTTP = readFileSync(join(SERVER_DIR, 'http.ts'), 'utf8');
const READER = createWorkspaceModuleReader(SERVER_DIR);
const TABLE = deriveMountedPrefixes(REAL_HTTP, READER);

const tempDirs: string[] = [];
const running: Running[] = [];

afterAll(async () => {
  while (running.length > 0) {
    const r = running.pop();
    if (r !== undefined) await r.close();
  }
  while (tempDirs.length > 0) rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

let productPromise: Promise<Running> | null = null;
async function product(): Promise<Running> {
  productPromise ??= (async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'fa-w14-prefix-'));
    tempDirs.push(runDir);
    const demo = await createDemoServer({ POTBOT_RUN_DIR: runDir });
    const r = await listen(demo.server);
    running.push(r);
    return r;
  })();
  return productPromise;
}

describe('W14-T3 · 现推前缀表（静态）', () => {
  it('表规模 ≥ 14；无重复前缀；每条都有模块与派发点', () => {
    const prefixes = TABLE.prefixes.map((p) => p.prefix);
    expect(prefixes.length).toBeGreaterThanOrEqual(14);
    expect(new Set(prefixes).size, '前缀不得重复').toBe(prefixes.length);
    for (const entry of TABLE.prefixes) {
      expect(entry.dispatchLabel, `${entry.prefix} 必须有派发点`).not.toBeNull();
      expect(entry.dispatchedBy.length).toBeGreaterThan(0);
    }
  });

  it('静态守卫与模块前缀声明**一致**：unownedDispatches 为空；嵌套前缀 `/api/memory/facts` 在表内', () => {
    // eslint-disable-next-line no-console
    console.log('[unownedDispatches]', JSON.stringify(TABLE.unownedDispatches));
    // 历史：在 `fa1d6e2` 上，`trace-fact-versions.ts` 的嵌套前缀 `/api/memory/facts` 因**旧正则只认顶层
    // 前缀**被误判为"无主"，使 wave-10/T5、wave-11/T4 两个**已合入 main** 的守卫测试变红；
    // `9ad653e` 把正则放宽到嵌套前缀后消解。本条钉住"现推表里嵌套前缀也被认下"。
    expect(TABLE.unownedDispatches).toEqual([]);
    const prefixes = TABLE.prefixes.map((p) => p.prefix);
    expect(prefixes).toContain('/api/memory/facts');
    expect(prefixes.filter((p) => p.startsWith('/api/memory'))).toEqual(['/api/memory', '/api/memory/facts']);
  });
});

describe('W14-T3 · 真服务：每个已挂载前缀都必须"真的被派发"', () => {
  it('★核心：现推表里**每一个**前缀的**根路径**，真服务上都不是 `/api/**` 兜底 404', async () => {
    const { base } = await product();
    const offenders: string[] = [];
    for (const entry of TABLE.prefixes) {
      const response = await getJson(base, entry.prefix);
      if (isApiFallback(response.json)) {
        offenders.push(`${entry.prefix} ⇒ ${String(response.status)} ${JSON.stringify(response.json)}`);
      }
    }
    // 说明：**不**拿"前缀下的假子路径"当判据——路由模块对不认识的子路径返回 `false` 交回
    // 调用方、由 `/api/**` 兜底 404 作答，那是**正常**的模块契约（如 `/api/documents/…`），
    // 不是"没挂载"。判据只用前缀根路径。
    expect(offenders, '这些前缀在源码里"挂了"，真服务上前缀根却落兜底 404（import-only 接线的指纹）').toEqual([]);
  });

  it('如实申报：前缀根的真实状态码（不把"非 404"当成"功能可用"）', async () => {
    const { base } = await product();
    const table: string[] = [];
    for (const entry of TABLE.prefixes) {
      const response = await getJson(base, entry.prefix);
      table.push(`${entry.prefix} ⇒ ${String(response.status)} ${String(response.json['code'] ?? '')}`);
    }
    // eslint-disable-next-line no-console
    console.log(table.join('\n'));
    expect(table.length).toBe(TABLE.prefixes.length);
  });

  it('★反向对照：从未挂载的命名空间**必须**落兜底 404（探针有辨别力）', async () => {
    const { base } = await product();
    const response = await getJson(base, '/api/definitely-not-mounted-wave14');
    expect(response.status).toBe(404);
    expect(isApiFallback(response.json), JSON.stringify(response.json)).toBe(true);
    // 再给一个"像真的但不存在"的：同样落兜底。
    const second = await getJson(base, '/api/definitely-not-mounted-wave14/sub');
    expect(isApiFallback(second.json)).toBe(true);
  });

  it('★`http.ts` 自己实现的既有路由同样不落兜底 404（探针覆盖非模块派发的一类）', async () => {
    const { base } = await product();
    const health = await getJson(base, '/health');
    expect(health.status, '/health').toBe(200);
    expect(isApiFallback(health.json)).toBe(false);

    const conversations = await getJson(base, '/api/conversations');
    expect([200, 503]).toContain(conversations.status);
    expect(isApiFallback(conversations.json), '/api/conversations 是 http.ts 自实现路由').toBe(false);

    const identity = await getJson(base, '/api/identity');
    expect([200, 503]).toContain(identity.status);
    expect(isApiFallback(identity.json), '/api/identity 是 http.ts 自实现路由').toBe(false);

    // 未知任务：是**模块内**的 404（task_unknown），不是兜底 404 —— 证明该前缀确实被接管。
    const task = await getJson(base, '/api/tasks/definitely-not-a-task');
    expect(task.status).toBe(404);
    expect(task.json['code']).toBe('task_unknown');
    expect(isApiFallback(task.json)).toBe(false);
  });

  it('★嵌套前缀 `/api/memory/facts` 那条派发（handleFactVersionsRequest）在真服务上**确实可用**', async () => {
    const { base } = await product();
    // 它的真实路径是 `/api/memory/facts/<key>/versions`；前缀根 `/api/memory/facts` 也在现推表里。
    const root = await getJson(base, '/api/memory/facts');
    expect(isApiFallback(root.json), `前缀根：${JSON.stringify(root.json)}`).toBe(false);
    const response = await getJson(base, '/api/memory/facts/wave14-probe/versions');
    expect(isApiFallback(response.json), JSON.stringify(response.json)).toBe(false);
    expect(response.status, '复用记忆宿主 ⇒ 结构化作答，不是兜底 404').not.toBe(404);
  });
});
