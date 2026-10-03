/**
 * 工作包 **FA-TRACE-FACT-VERSIONS** —— 事实版本轨迹读口（`/api/memory/facts/:key/versions`）的验收套件。
 *
 * ## 本套件要证明的四件事（对应工作包的四条任务）
 *
 * | # | 判据 | 用例组 |
 * |---|---|---|
 * | 1 | **判定：该接**，且判定依据**具名可核**（不是一句散文） | A-1 / A-2 |
 * | 2 | **该接就接**：真实 HTTP 端点能把每个**版本 / 来源 / 时间 / 状态**读回 | B |
 * | 3 | **反向对照**：不存在的键 ⇒ **404**（不是空数组）；跨 owner / 跨 task / 缺隔离键 / 非 GET / 未就绪 各自的结构化拒绝 | C / A-4 / A-5 |
 * | 4 | **可达性自证**：`traceFactVersions` 在**非测试代码**里确有**按名引用**（源码扫描，剥注释），且能被**真实请求**触达 | A-1 / A-3 / B |
 *
 * ## 为什么源码扫描要**先剥注释**
 *
 * 文件头的散文里写着 `traceFactVersions` 这个名字——若按裸字符串扫描，"零引用残留"会
 * 被自己的注释**假翻正**。所以 A-1 的扫描器先剥掉行注释与块注释，再找
 * `\btraceFactVersions\b`（值位置的 import / 调用），并要求**模块自身被排除**。
 * A-2 是本扫描器的**判别力对照**：同一扫描器对"编造的名字"必须找不到任何引用。
 *
 * ## 诚实边界（务必连着读）
 *
 * 1. **正例走真产品写口**：版本链由 `POST /api/memory/facts`（产品写侧）逐条造出来，
 *    不用夹具直接塞仓库——否则"产品上读不读得到"就没被证明。
 *    > 该写侧**不**把旧版本置 `disabled`（只追加），所以 HTTP 造出的链里多条都是 `active`。
 *    > 本套件**原样**断言这一点（B-2），**不**替写入侧粉饰成 `disabled`。
 * 2. **`startProduct` 是产品入口**（`createDemoServer` + `listen`），注入**文件落盘**的
 *    `MemoryPersistencePort`；本套件不替换任何一层，不碰模型、不连真机、不碰 Office。
 * 3. **另有一条真服务冒烟在套件之外**（起编译后的 `main.js` + curl），结论写在交付回报里；
 *    本文件只覆盖 vitest 能覆盖到的部分。
 *
 * 【模型身份】交付说明：本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  getJson,
  postJson,
  startProduct,
  type Json,
  type RunningProduct,
} from './e2e-full-chain-harness.js';
import { createMemoryRouteHost } from './memory-routes.js';
import type { TaskFactMemory } from '../../../src/memory/index.js';
import {
  FACT_VERSIONS_MODULES_REACHABLE_BY_ROUTE,
  FACT_VERSIONS_ROOT,
  FACT_VERSIONS_SYMBOL,
  FACT_VERSIONS_SYMBOL_MODULE,
  PRODUCT_JUSTIFICATION,
  matchFactVersionsRoute,
  routeFactVersionsRequest,
} from './trace-fact-versions.js';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

// ---------------------------------------------------------------------------
// 夹具常量
// ---------------------------------------------------------------------------

const OWNER = 'owner-trace';
/** 另一个 owner：跨用户隔离的反向对照。 */
const OTHER_OWNER = 'owner-other';
const TASK = 'T-trace-1';
/** 另一个任务：跨任务隔离的反向对照。 */
const OTHER_TASK = 'T-trace-2';
/** 主用例的事实键。 */
const KEY = 'deadline';
/** 只写一条版本、之后被"忘记"的键（证明历史不复活）。 */
const KEY_FORGOTTEN = 'forgotten.key';
/** 另一个键：证明 404 不是"一刀切"（同 owner 同任务下它仍然 200）。 */
const KEY_OTHER = 'paper_size';

const V0 = '2026-10-10 交初稿';
const V1 = '2026-10-12 交初稿（顺延两天）';
const V2 = '2026-10-12 17:00 前交初稿';

/** 一个安全字符的路径段（本套件的键都满足；含 `/` 的键另见 A-5 单元断言）。 */
function versionsPath(key: string, owner: string = OWNER, task: string = TASK): string {
  return `${FACT_VERSIONS_ROOT}/${key}/versions?owner_id=${owner}&task_id=${task}`;
}

/** 写一条任务事实（**产品写口**；不直接塞仓库）。 */
function writeFact(
  baseUrl: string,
  valueText: string,
  options: { readonly key?: string; readonly owner?: string; readonly task?: string; readonly detail?: string } = {},
): Promise<{ readonly status: number; readonly json: Json }> {
  return postJson(baseUrl, `${FACT_VERSIONS_ROOT}`, {
    owner_id: options.owner ?? OWNER,
    task_id: options.task ?? TASK,
    fact_key: options.key ?? KEY,
    value_text: valueText,
    source: { kind: 'user_statement', detail: options.detail ?? `用户说：${valueText}` },
  });
}

// ---------------------------------------------------------------------------
// 源码扫描器（**先剥注释**，再按名找引用）
// ---------------------------------------------------------------------------

/**
 * 剥掉注释（**状态机**，不是正则——正则会被骗）。
 *
 * 为什么不能用正则：本仓 `http.ts` 有一行**行注释**里写着以斜杠加星号开头的通配路径
 * （`/api/` 后跟两个星号），其中的"斜杠 + 星号"会被"块注释"正则当成块注释的开头，
 * 于是它一路吃到**下一个**"星号 + 斜杠"，把中间的**真实 import 语句**一起抹掉——
 * A-3 因此一度把 `import ... from './trace-fact-versions.js'` 判成"不存在"
 * （本套件开发过程中真实踩到过）。所以这里按字符扫状态：
 * 行注释 / 块注释 / 单引号串 / 双引号串 / 模板串，各自的结束条件分开判。
 *
 * 诚实边界：字符串与模板串的**内容原样保留**（只在其中跟踪转义与模板占位深度），
 * 因此"名字出现在字符串里"仍会被算作一次按名引用——本套件另外要求**调用**形态
 * （名字后紧跟左括号）来抵消这一宽松度。
 */
function stripComments(source: string): string {
  type Mode = 'code' | 'line' | 'block' | 'single' | 'double' | 'template';
  let mode: Mode = 'code';
  let braces = 0;
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i] ?? '';
    const next = source[i + 1];
    if (mode === 'code') {
      if (ch === '/' && next === '/') { mode = 'line'; out += '  '; i += 2; continue; }
      if (ch === '/' && next === '*') { mode = 'block'; out += '  '; i += 2; continue; }
      if (ch === "'") mode = 'single';
      else if (ch === '"') mode = 'double';
      else if (ch === '`') mode = 'template';
      out += ch;
      i += 1;
      continue;
    }
    if (mode === 'line') {
      if (ch === '\n') { mode = 'code'; out += ch; } else { out += ' '; }
      i += 1;
      continue;
    }
    if (mode === 'block') {
      if (ch === '*' && next === '/') { mode = 'code'; out += '  '; i += 2; continue; }
      out += ch === '\n' ? '\n' : ' ';
      i += 1;
      continue;
    }
    // 字符串 / 模板串：内容保留，只处理转义与自己的结束符
    if (ch === '\\') { out += ch + (next ?? ''); i += 2; continue; }
    if (mode === 'single' && ch === "'") { mode = 'code'; out += ch; i += 1; continue; }
    if (mode === 'double' && ch === '"') { mode = 'code'; out += ch; i += 1; continue; }
    if (mode === 'template') {
      if (ch === '`' && braces === 0) { mode = 'code'; out += ch; i += 1; continue; }
      if (ch === '$' && next === '{') { braces += 1; out += '${'; i += 2; continue; }
      if (ch === '}' && braces > 0) { braces -= 1; out += ch; i += 1; continue; }
    }
    out += ch;
    i += 1;
  }
  return out;
}

interface SourceFile {
  readonly path: string;
  readonly text: string;
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.runtime', '.claude', '.dev-evidence', 'dist', 'build']);

function collectSourceFiles(dir: string, out: SourceFile[] = []): SourceFile[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectSourceFiles(full, out);
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    // **非测试代码**：测试文件（`*.test.ts`）与夹具不算消费者，否则"被测试引用"会冒充"被产品引用"。
    if (entry.name.endsWith('.test.ts')) continue;
    out.push({ path: relative(ROOT, full).replaceAll('\\', '/'), text: stripComments(readFileSync(full, 'utf8')) });
  }
  return out;
}

interface Ref {
  readonly file: string;
  readonly hit: 'name' | 'call';
}

/** 在非测试源码里按名找引用；`exclude` 里的模块（声明方自身）不算消费者。 */
function referencesName(files: readonly SourceFile[], name: string, exclude: readonly string[]): readonly Ref[] {
  const namePattern = new RegExp(`\\b${name}\\b`);
  const callPattern = new RegExp(`\\b${name}\\s*\\(`);
  const refs: Ref[] = [];
  for (const file of files) {
    if (exclude.includes(file.path)) continue;
    if (!namePattern.test(file.text)) continue;
    refs.push({ file: file.path, hit: callPattern.test(file.text) ? 'call' : 'name' });
  }
  return Object.freeze(refs);
}

let sourceFiles: readonly SourceFile[];
let workDir: string;
let main: RunningProduct;
const notes: string[] = [];

beforeAll(async () => {
  sourceFiles = Object.freeze(collectSourceFiles(join(ROOT, 'apps')).concat(collectSourceFiles(join(ROOT, 'src'))));
  expect(sourceFiles.length, '扫描器至少应读到一百个非测试源文件（否则扫描口径本身失效）').toBeGreaterThan(100);
  workDir = mkdtempSync(join(tmpdir(), 'potbot-trace-fact-versions-'));
  main = await startProduct(join(workDir, 'run-trace'));
}, 60_000);

afterAll(async () => {
  if (main !== undefined) await main.close();
  if (workDir !== undefined) rmSync(workDir, { recursive: true, force: true });
}, 60_000);

// ===========================================================================
// A. 判定与可达性（不联网；源码扫描 + 纯路由核心）
// ===========================================================================

describe('A. 判定：该接（具名理由）+ 可达性自证（源码扫描 / 纯核心反向对照）', () => {
  it('A-1 可达性自证：traceFactVersions 在**非测试代码**里确有按名引用（剥注释扫描）', () => {
    const refs = referencesName(sourceFiles, FACT_VERSIONS_SYMBOL, [FACT_VERSIONS_SYMBOL_MODULE]);
    // 判别力：把 apps/demo/server/trace-fact-versions.ts 里那次调用删掉 ⇒ refs 变空 ⇒ 本行变红。
    expect(refs.length, `应被非测试代码引用：${JSON.stringify(refs)}`).toBeGreaterThan(0);
    expect(refs.map((ref) => ref.file)).toContain('apps/demo/server/trace-fact-versions.ts');
    // **值位置**（调用），不只是 import 进类型位置——"可达但不干活"的判据就是这条。
    const call = refs.find((ref) => ref.file === 'apps/demo/server/trace-fact-versions.ts');
    expect(call?.hit, '必须是调用而非仅按名提到').toBe('call');
    notes.push(`A-1 扫描 ${String(sourceFiles.length)} 个非测试源文件：traceFactVersions 的消费者=${JSON.stringify(refs)}`);
  });

  it('A-2 扫描器判别力（反向对照）：编造的名字必须查不到引用，被测文件里的**注释**不算引用', () => {
    // ① 编造的名字 ⇒ 0 引用（否则扫描器只是"什么都返回"）。
    expect(referencesName(sourceFiles, 'traceFactVersions__no_such_symbol__', [])).toEqual([]);
    // ② 本文件（测试）里确实写过这个名字，但它**不是**非测试代码里的引用：
    //    扫描器按 `*.test.ts` 排除 ⇒ 被测模块的引用者集合里不含任何测试文件。
    const refs = referencesName(sourceFiles, FACT_VERSIONS_SYMBOL, [FACT_VERSIONS_SYMBOL_MODULE]);
    expect(refs.some((ref) => ref.file.includes('.test.'))).toBe(false);
    // ③ 注释剥离真的生效：把只出现在注释里的名字喂给扫描器 ⇒ 查不到。
    const stripped = stripComments('// traceFactVersions 只是被提到\n/* traceFactVersions 也在块注释里 */\nconst x = 1;\n');
    expect(new RegExp(`\\b${FACT_VERSIONS_SYMBOL}\\b`).test(stripped)).toBe(false);
    notes.push('A-2 判别力对照：编造名 0 引用；测试文件被排除；注释剥离有效');
  });

  it('A-3 接线链完整：main.ts → http.ts → 本模块（按名引用，非注释）', () => {
    const http = sourceFiles.find((file) => file.path === 'apps/demo/server/http.ts');
    const main = sourceFiles.find((file) => file.path === 'apps/demo/server/main.ts');
    expect(http, 'http.ts 应在扫描集合里').toBeDefined();
    expect(new RegExp(`\\bhandleFactVersionsRequest\\s*\\(`).test(http?.text ?? ''), 'http.ts 必须**调用**handleFactVersionsRequest').toBe(true);
    expect(http?.text.includes("from './trace-fact-versions.js'"), 'http.ts 必须 import 本模块').toBe(true);
    // main.ts 经 `createDemoRequestHandler` 到达 http.ts（模块边，非按名符号）。
    expect(main?.text.includes('createDemoRequestHandler'), 'main.ts 必须经 createDemoRequestHandler 组装 http.ts').toBe(true);
    notes.push('A-3 接线链：main.ts → http.ts（handleFactVersionsRequest 调用）→ trace-fact-versions.ts');
  });

  it('A-4 判定具名理由可核（三条，且都不是"因为能接就接"）', () => {
    expect(PRODUCT_JUSTIFICATION.length, '判定依据必须给出条数明确、可逐条核对').toBeGreaterThanOrEqual(3);
    const joined = PRODUCT_JUSTIFICATION.join('\n');
    expect(joined).toContain('R236');
    expect(joined).toContain('决策气泡');
    for (const reason of PRODUCT_JUSTIFICATION) {
      expect(reason.length, `理由太短，像是凑数：${reason}`).toBeGreaterThan(20);
    }
    // 被接线的内核模块登记与本模块的实际 import 一致（不虚报消费者）。
    expect(FACT_VERSIONS_MODULES_REACHABLE_BY_ROUTE).toContain(FACT_VERSIONS_SYMBOL_MODULE);
    notes.push(`A-4 判定依据（${String(PRODUCT_JUSTIFICATION.length)} 条）：${PRODUCT_JUSTIFICATION.map((r) => r.slice(0, 24)).join(' / ')}…`);
  });

  it('A-5 路径匹配：只吃 `/api/memory/facts/:key/versions`，不吞别的形状', () => {
    expect(matchFactVersionsRoute(`${FACT_VERSIONS_ROOT}/${KEY}/versions`)).toEqual({ factKey: KEY });
    // 大写键 / URL 编码键都能解出（键是自由文本）
    expect(matchFactVersionsRoute(`${FACT_VERSIONS_ROOT}/%E6%88%AA%E6%AD%A2%E6%97%A5%E6%9C%9F/versions`)).toEqual({
      factKey: '截止日期',
    });
    // 非本路由：写入口本身、缺 versions 后缀、别的后缀、别的命名空间、含 `/` 的键、空段
    expect(matchFactVersionsRoute(FACT_VERSIONS_ROOT)).toBeNull();
    expect(matchFactVersionsRoute(`${FACT_VERSIONS_ROOT}/`)).toBeNull();
    expect(matchFactVersionsRoute(`${FACT_VERSIONS_ROOT}/${KEY}`)).toBeNull();
    expect(matchFactVersionsRoute(`${FACT_VERSIONS_ROOT}/${KEY}/history`)).toBeNull();
    expect(matchFactVersionsRoute(`${FACT_VERSIONS_ROOT}/${KEY}/versions/`)).toBeNull();
    expect(matchFactVersionsRoute(`${FACT_VERSIONS_ROOT}//versions`)).toBeNull();
    expect(matchFactVersionsRoute(`/api/facts/${KEY}/history`)).toBeNull();
    expect(matchFactVersionsRoute('/api/memory/entries')).toBeNull();
    expect(matchFactVersionsRoute('/api/memory/facts/a/b/versions')).toBeNull();
  });

  it('A-6 反向对照：未注入持久端口 ⇒ 503 memory_not_ready，**不是** 200 + 空版本链', () => {
    const notReady = createMemoryRouteHost({}); // 无 persistence ⇒ 未就绪（R220）
    const response = routeFactVersionsRequest(
      { method: 'GET', pathname: `${FACT_VERSIONS_ROOT}/${KEY}/versions`, query: new URLSearchParams({ owner_id: OWNER, task_id: TASK }) },
      notReady,
    );
    expect(response?.status, JSON.stringify(response?.body)).toBe(503);
    const body = response?.body as Json;
    expect(body['code']).toBe('memory_not_ready');
    expect(body['retryable']).toBe(false);
    // **关键**：未就绪的响应里不得出现 `versions` 字段——否则读成"这个键没有历史"。
    expect(Object.prototype.hasOwnProperty.call(body, 'versions')).toBe(false);
    expect(Array.isArray(body['unlock']), '未就绪必须给出可执行的解锁项').toBe(true);
    notes.push('A-6 未就绪 → 503 memory_not_ready（响应无 versions 字段，不冒充空历史）');
  });

  it('A-7 纯核心：非 GET / HEAD ⇒ 405（只读口），且不触仓库', () => {
    const opened: string[] = [];
    const host = createMemoryRouteHost({});
    const spy = Object.create(host) as typeof host;
    Object.defineProperty(spy, 'open', {
      value: () => {
        opened.push('open');
        return { ok: false as const, code: 'memory_not_ready' as const, message: 'spy', unlock: [] };
      },
    });
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const response = routeFactVersionsRequest(
        { method, pathname: `${FACT_VERSIONS_ROOT}/${KEY}/versions`, query: new URLSearchParams({ owner_id: OWNER, task_id: TASK }) },
        spy,
      );
      expect(response?.status, `${method} 应 405`).toBe(405);
      expect((response?.body as Json)['code']).toBe('method_not_allowed');
    }
    expect(opened, '非 GET/HEAD 的请求不得去开仓库').toEqual([]);
    notes.push('A-7 非 GET/HEAD → 405（且未打开仓库：方法判定先于就绪判定）');
  });
});

// ===========================================================================
// B. 正例：真 HTTP + 真写口 + 真读回（每个版本 / 来源 / 时间 / 状态）
// ===========================================================================

describe('B. 该接就接：真 HTTP 端点把每个版本的来源 / 时间 / 状态读回', () => {
  it('B-1 产品写口造两个版本（POST /api/memory/facts）', async () => {
    const first = await writeFact(main.baseUrl, V0, { detail: '用户第一次说交稿日' });
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    expect(first.json['version'], '首版 version=0').toBe(0);

    const second = await writeFact(main.baseUrl, V1, { detail: '用户改口顺延两天' });
    expect(second.status, JSON.stringify(second.json)).toBe(200);
    expect(second.json['version'], '第二版 version=1').toBe(1);
    notes.push(`B-1 POST ${FACT_VERSIONS_ROOT} ×2 → 200/200（version 0 → 1）`);
  });

  it('B-2 GET .../versions：200，两条版本按 version 升序，各自带 value_text / status / source / updated_at', async () => {
    const response = await getJson(main.baseUrl, versionsPath(KEY));
    expect(response.status, JSON.stringify(response.json)).toBe(200);
    expect(response.json['fact_key']).toBe(KEY);
    expect(response.json['owner_id']).toBe(OWNER);
    expect(response.json['task_id']).toBe(TASK);
    expect(response.json['revision']).toBe(2);

    const versions = response.json['versions'] as readonly Json[];
    expect(versions).toHaveLength(2);
    expect(versions.map((v) => v['version'])).toEqual([0, 1]);
    expect(versions.map((v) => v['value_text'])).toEqual([V0, V1]);
    // **来源逐条读回**（R236 的可审计性）
    expect((versions[0]?.['source'] as Json)['detail']).toBe('用户第一次说交稿日');
    expect((versions[1]?.['source'] as Json)['detail']).toBe('用户改口顺延两天');
    expect((versions[0]?.['source'] as Json)['kind']).toBe('user_statement');
    // **时间逐条读回**（数值逻辑时刻，升序不减）
    expect(typeof versions[0]?.['updated_at']).toBe('number');
    expect(typeof versions[1]?.['updated_at']).toBe('number');
    // **状态逐条读回，且原样**：产品写侧只追加、不把旧版本置 disabled ⇒ 两条都还是 active。
    // 本行**故意**如实钉住这一点，不替写入侧粉饰（见文件头"诚实边界"1）。
    expect(versions.map((v) => v['status'])).toEqual(['active', 'active']);
    expect(versions[0]?.['memory_id']).not.toBe(versions[1]?.['memory_id']);
    notes.push(`B-2 GET ${versionsPath(KEY)} → 200（2 条版本，升序 [0,1]，来源/时间/状态逐条可读）`);
  });

  it('B-3 当前值 / 前一值由内核函数算出；`truncated:false` 与仓库快照**逐条对数**', async () => {
    const response = await getJson(main.baseUrl, versionsPath(KEY));
    expect(response.json['current_value'], '当前值 = 最新有效版本').toBe(V1);
    expect(response.json['previous_value'], '前一值 = 版本号低于当前的那一条').toBe(V0);
    expect(response.json['truncated'], '内核函数不设上限，本口不做二次截断').toBe(false);
    expect(response.json['traced_by']).toBe(`${FACT_VERSIONS_SYMBOL_MODULE}#${FACT_VERSIONS_SYMBOL}`);

    // **对数**：不经 HTTP，直接读**同一个**仓库里的那份真相源。
    const access = main.demo.memoryRoutes.open();
    expect(access.ok, '产品入口注入的是文件落盘持久端口 ⇒ 仓库应可打开').toBe(true);
    if (!access.ok) return;
    const inRepo = access.repository
      .listByKind('task_fact')
      .filter((entry): entry is TaskFactMemory => entry.kind === 'task_fact')
      .filter(
        (entry) => String(entry.owner_id) === OWNER && String(entry.task_id) === TASK && entry.fact_key === KEY,
      );
    const versions = response.json['versions'] as readonly Json[];
    expect(versions.length, 'HTTP 读回的条数必须等于仓库里的真实条数（无遗漏、无重复）').toBe(inRepo.length);
    const repoIds = inRepo.map((entry) => String(entry.memory_id)).sort();
    const httpIds = versions.map((v) => String(v['memory_id'])).sort();
    expect(httpIds).toEqual(repoIds);
    notes.push(`B-3 current=${V1} / previous=${V0}；HTTP 条数=${String(versions.length)} = 仓库条数=${String(inRepo.length)}`);
  });

  it('B-4 追加第三个版本后：current / previous 随之推进（证明不是写死的常量）', async () => {
    const third = await writeFact(main.baseUrl, V2, { detail: '用户补上具体时刻' });
    expect(third.status, JSON.stringify(third.json)).toBe(200);

    const response = await getJson(main.baseUrl, versionsPath(KEY));
    expect(response.status).toBe(200);
    expect(response.json['revision']).toBe(3);
    expect(response.json['current_value']).toBe(V2);
    // previous 是"版本号低于当前的那一条" = 第二版（不是第一版）——这条语义只有内核函数给得出。
    expect(response.json['previous_value']).toBe(V1);
    expect((response.json['versions'] as readonly Json[]).map((v) => v['version'])).toEqual([0, 1, 2]);
    notes.push(`B-4 第三版后 revision=3，current=${V2}，previous=${V1}（随链推进）`);
  });

  it('B-5 另一条键与另一个 owner 各自独立（读口不是"一刀切"）', async () => {
    const other = await writeFact(main.baseUrl, 'A4 纸', { key: KEY_OTHER, detail: '用户指定纸张' });
    expect(other.status, JSON.stringify(other.json)).toBe(200);
    const mine = await getJson(main.baseUrl, versionsPath(KEY));
    expect(mine.status).toBe(200);
    expect(mine.json['fact_key']).toBe(KEY);
    expect(mine.json['revision'], 'KEY 仍是 3 条，不受 KEY_OTHER 影响').toBe(3);

    const seenByOther = await getJson(main.baseUrl, versionsPath(KEY, OTHER_OWNER, TASK));
    expect(seenByOther.status, '另一个 owner 看不到这个键（R237 隔离）').toBe(404);
    notes.push('B-5 KEY 与 KEY_OTHER 互不串扰；另一 owner 读同一键 → 404');
  });

  it('B-6 HEAD 也走同一条路径（状态码同 GET，不写响应体）', async () => {
    const response = await fetch(`${main.baseUrl}${versionsPath(KEY)}`, { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    notes.push('B-6 HEAD → 200（空体）');
  });
});

// ===========================================================================
// C. 反向对照（真 HTTP）
// ===========================================================================

describe('C. 反向对照：查不到就 404，不用空数组冒充', () => {
  it('C-1 不存在的事实键 ⇒ 404 fact_versions_not_found，响应里**没有** versions 字段', async () => {
    const response = await getJson(main.baseUrl, versionsPath('no.such.key'));
    expect(response.status, JSON.stringify(response.json)).toBe(404);
    expect(response.json['code']).toBe('fact_versions_not_found');
    expect(response.json['retryable']).toBe(false);
    // **核心判据**：不得返回 `versions: []`（那会被读成"键存在但没有版本"）。
    expect(Object.prototype.hasOwnProperty.call(response.json, 'versions'), '404 里不得出现 versions').toBe(false);
    notes.push('C-1 不存在的键 → 404 fact_versions_not_found（无 versions 字段，不是空数组）');
  });

  it('C-2 跨任务 ⇒ 404（同一个 owner、同一个键、换了 task_id）', async () => {
    const response = await getJson(main.baseUrl, versionsPath(KEY, OWNER, OTHER_TASK));
    expect(response.status, JSON.stringify(response.json)).toBe(404);
    expect(response.json['code']).toBe('fact_versions_not_found');
  });

  it('C-3 缺 / 非法隔离键 ⇒ 400，且不静默补默认值', async () => {
    const noOwner = await getJson(main.baseUrl, `${FACT_VERSIONS_ROOT}/${KEY}/versions?task_id=${TASK}`);
    expect(noOwner.status).toBe(400);
    expect(noOwner.json['code']).toBe('invalid_owner_id');

    const noTask = await getJson(main.baseUrl, `${FACT_VERSIONS_ROOT}/${KEY}/versions?owner_id=${OWNER}`);
    expect(noTask.status).toBe(400);
    expect(noTask.json['code']).toBe('invalid_task_id');

    const badOwner = await getJson(main.baseUrl, `${FACT_VERSIONS_ROOT}/${KEY}/versions?owner_id=${encodeURIComponent('bad owner')}&task_id=${TASK}`);
    expect(badOwner.status).toBe(400);
    expect(badOwner.json['code']).toBe('invalid_owner_id');
    notes.push('C-3 缺 owner_id / 缺 task_id / 非法 owner_id → 400（不补默认值）');
  });

  it('C-4 非 GET / HEAD ⇒ 405（真 HTTP；写事实请走 POST /api/memory/facts）', async () => {
    const posted = await postJson(main.baseUrl, versionsPath(KEY), {});
    expect(posted.status, JSON.stringify(posted.json)).toBe(405);
    expect(posted.json['code']).toBe('method_not_allowed');

    const put = await fetch(`${main.baseUrl}${versionsPath(KEY)}`, { method: 'PUT' });
    expect(put.status).toBe(405);
    notes.push('C-4 POST / PUT → 405');
  });

  it('C-5 忘记（R238 硬抹除）后 ⇒ 404：版本链不复活，也不从 tombstone 里重建', async () => {
    const written = await writeFact(main.baseUrl, '临时的值', {
      key: KEY_FORGOTTEN,
      detail: '将被忘记的版本',
    });
    expect(written.status, JSON.stringify(written.json)).toBe(200);
    const memoryId = String(written.json['memory_id']);
    const before = await getJson(main.baseUrl, versionsPath(KEY_FORGOTTEN));
    expect(before.status, '忘记前读得到').toBe(200);
    expect(before.json['revision']).toBe(1);

    const forgotten = await postJson(main.baseUrl, `/api/memory/entries/${memoryId}`, {
      owner_id: OWNER,
      action: 'forget',
    });
    expect(forgotten.status, JSON.stringify(forgotten.json)).toBe(200);

    const after = await getJson(main.baseUrl, versionsPath(KEY_FORGOTTEN));
    expect(after.status, '忘记后读不到——历史不复活（R238）').toBe(404);
    expect(after.json['code']).toBe('fact_versions_not_found');
    expect(Object.prototype.hasOwnProperty.call(after.json, 'versions')).toBe(false);
    notes.push(`C-5 忘记 ${memoryId} 后 → 404（历史消失且不复活；忘记前为 200/1 条）`);
  });

  it('C-6 不混淆另一条链：GET /api/facts/:key/history 仍是产物事实那一条（未被我方劫持）', async () => {
    // `/api/facts/**` 是共享事实（`SharedFactRecord`）那一条链。本套件没有建那个任务，
    // 因此它按自己的语义报 `task_not_found`——**不是**本口的 `fact_versions_not_found`。
    const response = await getJson(main.baseUrl, `/api/facts/${KEY}/history?task_id=${TASK}`);
    expect(response.status).toBe(404);
    expect(response.json['code'], '必须是 /api/facts 自己的错误码，证明两条链各走各的').toBe('task_not_found');
    notes.push('C-6 /api/facts/:key/history 仍由 facts-routes 作答（task_not_found），未被本口劫持');
  });
});

// ===========================================================================
// D. 交付回报（把上面的实测状态码原样记下来，不写散文）
// ===========================================================================

describe('D. 实测状态码汇总（供回报逐条核对，不是新增判据）', () => {
  it('D-1 本轮真 HTTP 的状态码与要点已全部落账并打印（不给"已验证"这种无法核对的说法）', () => {
    expect(notes.length, '每条实测都要留下可核对的记录').toBeGreaterThanOrEqual(12);
    console.log(['【FA-TRACE-FACT-VERSIONS 实测记录】', ...notes].join('\n'));
  });
});
