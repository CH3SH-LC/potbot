/**
 * 工作包 **FA-MEM-PRODUCT-E2E**：记忆管理的**用户旅程**端到端（真 HTTP + 真产品入口 + 真落盘）。
 *
 * ## 为什么这条套件与既有记忆套件**不重复**
 *
 * | 既有套件 | 覆盖到哪 | 本套件补什么 |
 * |---|---|---|
 * | `memory-routes.test.ts` | 路由层语义（纯函数 / 直接调 `routeMemoryRequest`） | **不碰**：本套件全程真 HTTP |
 * | `e2e-routes.test.ts` | 路由层语义（真 HTTP，但用**易失端口**、种子直写仓库） | **不碰**：本套件走**产品入口 + 文件落盘**，写侧走**产品写接口** |
 * | `mem-write-side.test.ts` | 写侧语义（直调 `writeMemoryRecord`） | **不碰**：本套件从 HTTP 请求体一路走到落盘文件 |
 *
 * 一句话：**此前没有任何一条测试把"记忆"当用户功能从写入走到跨重启**——读侧
 * （`/entries`、`/injection`）与写侧（`/messages`、`/facts`）各自有单测，但没有一条
 * 把它们串成一条用户能走完的旅程。本套件就是那条旅程。
 *
 * ## 走的是哪条链（不替换任何一层）
 *
 * `createDemoServer()`（**产品入口**，与 `main.ts` 里 `startDemoServer` 同一个函数）→
 * `createDemoRequestHandler` → `handleMemoryRequest`（真 `node:http` 的 `IncomingMessage`
 * / `ServerResponse`）→ `routeMemoryRequest` → `writeMemoryRecord` / `MemoryRepository` →
 * `createFileMemoryPersistence`（**真文件落盘**：`<runDir>/memory/memory-store.json`）。
 *
 * 端口用 `listen(0)` 由内核分配（避免与并行工作者抢固定端口）；模型配置一律缺席 ⇒
 * 模型端口如实为 `null`（本套件不碰模型）。
 *
 * ## 八步用户旅程（每一步都有反向对照）
 *
 * 1. **写入**：经 `POST /api/memory/messages` 与 `POST /api/memory/facts` 真写（带 owner/task）；
 * 2. **查看 / 搜索**：`/entries` 四类分型正确、分页正确、**跨 owner 读不到**；
 * 3. **注入**：`/injection` **真包含**刚写的条目（证明"注入恒空"已不成立）；
 * 4. **修改 / 停用 / 删除 / 忘记**：四种动作各走一遍；**忘记后 `/injection` 不再含它**；
 * 5. **备份预览**：`/backup/preview` **剔除凭据并记名**；
 * 6. **保留期 dry-run**：`/retention/preview` 恒 `dry_run:true`、**不确定项不上删除清单**；
 * 7. **跨重启**：换服务实例（**同运行目录**）⇒ 记忆仍在、**忘记过的不复活**；
 * 8. **反向对照**：跨 owner 读 / 改被拒；缺 `owner_id` ⇒ 400；坏形态 ⇒ 结构化拒绝（不补默认值）。
 *
 * ## 诚实边界（结果不得编造）
 *
 * - **真机未验证**：本套件全部在 Node 进程内（真 HTTP + 真文件），**不碰**安卓真机、不碰浏览器、不碰真实模型。
 * - **保留期的"不确定项"在路由层结构上恒空**（仓库条目一律经 `createMemoryEntry` 校验）：
 *   `uncertain_untouched === true` 因此是**结构上恒真**的，不构成"不确定项不删"的正面证明。
 *   本套件如实标注这一点（见 E 组的 console 说明），不把恒真断言说成已证明安全。
 * - **持久化是"同进程内换服务实例 + 同一份文件"**：走的是产品真实落盘链，但**不是**
 *   跨进程 / 跨机器的恢复验证（那是 `tests/demo/fa-n-restart.test.ts` 那一类硬杀进程的活）。
 *
 * 【模型身份】交付说明：本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { asLogicalTime, asRevision, asTaskId, asTemplateId } from '../../../src/protocol/index.js';
import { asOwnerId, createMemoryEntry } from '../../../src/memory/index.js';

import { getJson, postJson, startProduct, type Json, type RunningProduct } from './e2e-product-harness.js';

// ---------------------------------------------------------------------------
// 通用
// ---------------------------------------------------------------------------

const T = (n: number): ReturnType<typeof asLogicalTime> => asLogicalTime(n);

/** 每个用例自起的运行中服务；`afterEach` 统一收摊（cross-restart 用例会提前显式关掉旧的）。 */
const running: RunningProduct[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (running.length > 0) {
    const product = running.pop();
    if (product !== undefined) await product.close();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** 起一个真产品服务（同运行目录可复用：跨重启用例据此换实例）。 */
async function open(runDir: string): Promise<RunningProduct> {
  const product = await startProduct(runDir);
  running.push(product);
  return product;
}

function newRunDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'potbot-mem-e2e-'));
  tempDirs.push(dir);
  return dir;
}

/** 一步实测记录（状态码 + 关键字段），用例末尾统一打印，避免断言与日志各说各话。 */
type Step = readonly [label: string, detail: string];
function logSteps(title: string, steps: readonly Step[]): void {
  // eslint-disable-next-line no-console
  console.log(`\n[${title}]\n` + steps.map(([label, detail]) => `  · ${label}：${detail}`).join('\n'));
}

const SOURCE = { kind: 'user_statement', detail: 'FA-MEM-PRODUCT-E2E 旅程' };

/** 经产品写接口写一条**对话消息**，返回 `{status, memoryId}`。 */
async function writeMessage(
  baseUrl: string,
  input: {
    readonly owner: string;
    readonly conversation: string;
    readonly text: string;
    readonly role?: string;
    readonly at: number;
    readonly confirmation?: string;
  },
): Promise<{ readonly status: number; readonly memoryId: string; readonly outcome: string }> {
  const { status, json } = await postJson(baseUrl, '/api/memory/messages', {
    owner_id: input.owner,
    conversation_id: input.conversation,
    role: input.role ?? 'user',
    text: input.text,
    source: SOURCE,
    confirmation: input.confirmation ?? 'confirmed',
    at: input.at,
  });
  return { status, memoryId: String(json['memory_id'] ?? ''), outcome: String(json['outcome'] ?? '') };
}

/** 经产品写接口写一条**任务事实**，返回 `{status, memoryId}`。 */
async function writeFact(
  baseUrl: string,
  input: {
    readonly owner: string;
    readonly task: string;
    readonly key: string;
    readonly value: string;
    readonly at: number;
  },
): Promise<{ readonly status: number; readonly memoryId: string }> {
  const { status, json } = await postJson(baseUrl, '/api/memory/facts', {
    owner_id: input.owner,
    task_id: input.task,
    fact_key: input.key,
    value_text: input.value,
    source: SOURCE,
    confirmation: 'confirmed',
    at: input.at,
  });
  return { status, memoryId: String(json['memory_id'] ?? '') };
}

function idsOf(body: Json): readonly string[] {
  return (body['entries'] as readonly Json[]).map((entry) => String(entry['memory_id']));
}

function groupIds(body: Json, kind: string): readonly string[] {
  const groups = body['groups'] as Json;
  return (groups[kind] as readonly Json[]).map((entry) => String(entry['memory_id']));
}

/**
 * 把 `preference` / `template_experience` 两类**直写进产品仓库**（同一份 `MemoryRepository`，
 * 就是 HTTP 路由在用的那个宿主持有的那一个），再落盘。
 *
 * 为什么这么做：写侧产品接口（`/messages`、`/facts`）刻意**只写两类**（不越权写偏好 / 模板经验）。
 * 但用户旅程第 2 步要求"四类分型正确"，所以这两类必须存在。这里如实标注：它们是**测试种子**，
 * 走的是产品宿主自己的仓库 + 落盘口，不是"另造一份真相源"。
 */
function seedNonWritableKinds(product: RunningProduct): void {
  const access = product.demo.memoryRoutes.open();
  if (!access.ok) throw new Error(`记忆宿主未就绪：${access.message}`);
  const base = {
    source: { kind: 'user_statement' as const, detail: '端到端种子（preference / template_experience）' },
    confirmation: 'confirmed' as const,
    version: asRevision(0),
    status: 'active' as const,
  };
  const seeds = [
    {
      ...base,
      kind: 'preference',
      memory_id: 'e2e-pref-1',
      owner_id: asOwnerId('owner-a'),
      scope: { kind: 'user', task_id: null, template_id: null },
      created_at: T(5),
      updated_at: T(5),
      preference_key: 'font',
      value_text: '宋体',
    },
    {
      ...base,
      kind: 'template_experience',
      memory_id: 'e2e-exp-1',
      owner_id: asOwnerId('owner-a'),
      scope: { kind: 'template', task_id: null, template_id: asTemplateId('tpl-1') },
      created_at: T(6),
      updated_at: T(6),
      template_id: asTemplateId('tpl-1'),
      lesson: '先定大纲再写正文',
      applies_to_version: 'v1',
    },
  ];
  for (const raw of seeds) {
    const result = access.repository.remember(createMemoryEntry(raw));
    if (!result.ok) throw new Error(`种子写入失败：${result.reason} ${result.detail}`);
  }
  product.demo.memoryRoutes.persist(T(6));
}

// ===========================================================================
// 1–2. 写入 + 查看 / 搜索（四类分型、分页、跨 owner 隔离）
// ===========================================================================

describe('A. 写入 → 查看 / 搜索（真 HTTP；四类分型 / 分页 / 跨 owner 隔离）', () => {
  it('A1 经 /messages 与 /facts 真写，四类分型 + 分页 + 跨 owner 读不到', async () => {
    const runDir = newRunDir();
    const product = await open(runDir);
    const base = product.baseUrl;
    const steps: Step[] = [];
    try {
      seedNonWritableKinds(product);

      // --- 1. 写入（产品写接口）-----------------------------------------
      const m1 = await writeMessage(base, { owner: 'owner-a', conversation: 'conv-1', text: '周报写三段', at: 100 });
      const m2 = await writeMessage(base, { owner: 'owner-a', conversation: 'conv-1', text: '语气正式一点', at: 200 });
      const m3 = await writeMessage(base, { owner: 'owner-a', conversation: 'conv-2', text: '标题用黑体', at: 300 });
      const f1 = await writeFact(base, { owner: 'owner-a', task: 'task-1', key: 'week', value: 'W40', at: 400 });
      const b1 = await writeMessage(base, { owner: 'owner-b', conversation: 'conv-b', text: '别人家的消息', at: 500 });

      steps.push(['写入 /messages（owner-a）', [m1, m2, m3].map((r) => `${r.status}/${r.outcome}`).join(' , ')]);
      steps.push(['写入 /facts（owner-a）', `${f1.status} id=${f1.memoryId}`]);
      steps.push(['写入 /messages（owner-b）', `${b1.status}/${b1.outcome} id=${b1.memoryId}`]);
      expect(m1.status).toBe(200);
      expect(m1.outcome).toBe('created');
      expect(m2.status).toBe(200);
      expect(m3.status).toBe(200);
      expect(f1.status).toBe(200);
      expect(b1.status).toBe(200);
      // 稳定 id 前缀（`mw-sm-` / `mw-tf-`）证明走的是写侧落库链，不是别的东西。
      expect(m1.memoryId.startsWith('mw-sm-')).toBe(true);
      expect(f1.memoryId.startsWith('mw-tf-')).toBe(true);

      // --- 2a. 四类分型（固定四个键，四类各占一个）------------------------
      const list = await getJson(base, '/api/memory/entries?owner_id=owner-a&limit=50');
      steps.push(['GET /entries（owner-a）', `${list.status} total=${String((list.json['paging'] as Json)['total_matched'])}`]);
      expect(list.status).toBe(200);
      const groups = list.json['groups'] as Json;
      expect(Object.keys(groups).sort()).toEqual(
        ['preference', 'session_message', 'task_fact', 'template_experience'].sort(),
      );
      expect([...groupIds(list.json, 'session_message')].sort()).toEqual([m1.memoryId, m2.memoryId, m3.memoryId].sort());
      expect(groupIds(list.json, 'task_fact')).toEqual([f1.memoryId]);
      expect(groupIds(list.json, 'preference')).toEqual(['e2e-pref-1']);
      expect(groupIds(list.json, 'template_experience')).toEqual(['e2e-exp-1']);
      steps.push([
        '四类分型',
        `session_message=${String(groupIds(list.json, 'session_message').length)} fact=${String(
          groupIds(list.json, 'task_fact').length,
        )} preference=${String(groupIds(list.json, 'preference').length)} experience=${String(
          groupIds(list.json, 'template_experience').length,
        )}`,
      ]);

      // --- 2b. 搜索（text 子串，真打到仓库检索）---------------------------
      const searched = await getJson(base, '/api/memory/entries?owner_id=owner-a&text=%E9%BB%91%E4%BD%93&limit=50');
      steps.push(['GET /entries?text=黑体', `${searched.status} total=${String((searched.json['paging'] as Json)['total_matched'])}`]);
      expect(searched.status).toBe(200);
      expect(idsOf(searched.json)).toEqual([m3.memoryId]);

      // --- 2c. 分页（limit=1 逐页取，页间不重不漏）-------------------------
      const page0 = await getJson(base, '/api/memory/entries?owner_id=owner-a&limit=1&offset=0');
      const page1 = await getJson(base, '/api/memory/entries?owner_id=owner-a&limit=1&offset=1');
      const paging0 = page0.json['paging'] as Json;
      steps.push([
        '分页 limit=1',
        `offset0 returned=${String(paging0['returned'])} has_more=${String(paging0['has_more'])} id=${idsOf(page0.json)[0]}; offset1 id=${idsOf(page1.json)[0]} ceiling=${String(paging0['ceiling'])}`,
      ]);
      expect(page0.status).toBe(200);
      expect(paging0['limit']).toBe(1);
      expect(paging0['returned']).toBe(1);
      expect(paging0['has_more']).toBe(true);
      expect(paging0['bounded']).toBe(true);
      expect(idsOf(page0.json)).toHaveLength(1);
      expect(idsOf(page1.json)).toHaveLength(1);
      expect(idsOf(page0.json)[0]).not.toBe(idsOf(page1.json)[0]);
      // 稳定排序（updated_at 降序）：owner-a 里最晚的是 f1(at=400)，其后依次 m3(300)/m2(200)/m1(100)。
      expect(idsOf(page0.json)[0]).toBe(f1.memoryId);
      expect(idsOf(page1.json)[0]).toBe(m3.memoryId);

      // --- 2d. 跨 owner 读不到 ------------------------------------------
      const other = await getJson(base, '/api/memory/entries?owner_id=owner-b&limit=50');
      steps.push(['GET /entries（owner-b）', `${other.status} total=${String((other.json['paging'] as Json)['total_matched'])}`]);
      expect(other.status).toBe(200);
      expect(idsOf(other.json)).toEqual([b1.memoryId]);
      expect(JSON.stringify(other.json), 'owner-b 的响应里不得出现 owner-a 的任何条目').not.toContain(m1.memoryId);
      expect(JSON.stringify(other.json)).not.toContain('e2e-pref-1');

      // 反向对照：跨 owner 单条查看 ⇒ 404（不泄漏是否存在）
      const crossed = await getJson(base, `/api/memory/entries/${m1.memoryId}?owner_id=owner-b`);
      steps.push(['跨 owner 单条查看', `${crossed.status} code=${String(crossed.json['code'])}`]);
      expect(crossed.status).toBe(404);
      expect(crossed.json['code']).toBe('memory_not_visible');
    } finally {
      logSteps('A1 写入/查看/分页/隔离', steps);
    }
  });
});

// ===========================================================================
// 3. 注入不再恒空
// ===========================================================================

describe('B. 注入（真 HTTP）——写进去的东西真的能被注入', () => {
  it('B1 写前注入为空，写后 /injection 真包含刚写的条目；跨 owner / 跨 task 不越界', async () => {
    const runDir = newRunDir();
    const product = await open(runDir);
    const base = product.baseUrl;
    const steps: Step[] = [];
    try {
      // 写之前：一个全新的主体 ⇒ 注入如实为空（"恒空"这件事本身先被记录一次）。
      const before = await getJson(base, '/api/memory/injection?owner_id=owner-empty');
      steps.push([
        '写前注入（owner-empty）',
        `${before.status} status=${String(before.json['status'])} digest=${JSON.stringify(before.json['digest'])} included=${String((before.json['included_ids'] as readonly string[]).length)}`,
      ]);
      expect(before.status).toBe(200);
      expect(before.json['digest']).toBe('');
      expect(before.json['included_ids']).toEqual([]);

      const m1 = await writeMessage(base, { owner: 'owner-a', conversation: 'conv-1', text: '记住：周报要写三段', at: 100 });
      const f1 = await writeFact(base, { owner: 'owner-a', task: 'task-1', key: 'week', value: 'W40', at: 200 });
      const bMsg = await writeMessage(base, { owner: 'owner-b', conversation: 'conv-b', text: '别人的东西', at: 300 });
      const otherTask = await writeFact(base, { owner: 'owner-a', task: 'task-2', key: 'other', value: 'X', at: 400 });

      // 无 task 过滤 ⇒ 本 owner 全类目（会话消息 + 事实都在）。
      const all = await getJson(base, '/api/memory/injection?owner_id=owner-a');
      const allIds = (all.json['included_ids'] as readonly string[]).map(String);
      steps.push([
        'GET /injection（owner-a，无 task 过滤）',
        `${all.status} status=${String(all.json['status'])} injected=${String(all.json['injected'])} included=${JSON.stringify(allIds)}`,
      ]);
      expect(all.status).toBe(200);
      expect(all.json['digest'], '注入摘要非空 ⇒ "注入恒空"已不成立').not.toBe('');
      expect(String(all.json['digest'])).toContain('周报要写三段');
      expect(allIds).toContain(m1.memoryId);
      expect(allIds).toContain(f1.memoryId);
      expect(allIds, 'owner-b 的条目不得进 owner-a 的注入').not.toContain(bMsg.memoryId);

      // task 过滤 ⇒ 只含本任务的条目（会话消息 scope.task_id=null，结构上取不到）。
      const scoped = await getJson(base, '/api/memory/injection?owner_id=owner-a&task_id=task-1');
      const scopedIds = (scoped.json['included_ids'] as readonly string[]).map(String);
      steps.push([
        'GET /injection（owner-a + task_id=task-1）',
        `${scoped.status} included=${JSON.stringify(scopedIds)}`,
      ]);
      expect(scoped.status).toBe(200);
      expect(scopedIds).toEqual([f1.memoryId]);
      expect(scopedIds, '跨任务隔离：task-2 的事实不进来').not.toContain(otherTask.memoryId);

      // 反向对照：owner-b 的注入里没有 owner-a 的东西。
      const bInject = await getJson(base, '/api/memory/injection?owner_id=owner-b');
      steps.push(['GET /injection（owner-b）', `${bInject.status} included=${JSON.stringify(bInject.json['included_ids'])}`]);
      expect((bInject.json['included_ids'] as readonly string[]).map(String)).toEqual([bMsg.memoryId]);
    } finally {
      logSteps('B1 注入不再恒空', steps);
    }
  });
});

// ===========================================================================
// 4. 修改 / 停用 / 删除 / 忘记
// ===========================================================================

describe('C. 修改 / 停用 / 删除 / 忘记（真 HTTP；忘记后注入不再含它）', () => {
  it('C1 四种动作各走一遍，且忘记立即从 /injection 消失', async () => {
    const runDir = newRunDir();
    const product = await open(runDir);
    const base = product.baseUrl;
    const steps: Step[] = [];
    try {
      const toModify = await writeMessage(base, { owner: 'owner-a', conversation: 'conv-1', text: '初稿', at: 100 });
      const toDisable = await writeMessage(base, { owner: 'owner-a', conversation: 'conv-1', text: '待停用', at: 200 });
      const toDelete = await writeMessage(base, { owner: 'owner-a', conversation: 'conv-1', text: '待删除', at: 300 });
      const toForget = await writeMessage(base, { owner: 'owner-a', conversation: 'conv-1', text: '忘记我-ZZQ', at: 400 });

      // 忘记前：注入确实含它（否则"忘记后不含"可能是假阴性）。
      const beforeForget = await getJson(base, '/api/memory/injection?owner_id=owner-a');
      expect((beforeForget.json['included_ids'] as readonly string[]).map(String)).toContain(toForget.memoryId);
      steps.push(['忘记前 /injection', `${beforeForget.status} 含 toForget=${String(true)}`]);

      // --- 修改 ---------------------------------------------------------
      const modified = await postJson(base, `/api/memory/entries/${toModify.memoryId}`, {
        owner_id: 'owner-a',
        action: 'modify',
        patch: { text: '终稿' },
        at: 500,
      });
      steps.push(['修改', `${modified.status} action=${String(modified.json['action'])} affected=${JSON.stringify(modified.json['affected'])}`]);
      expect(modified.status).toBe(200);
      expect(modified.json['action']).toBe('modify');
      expect(modified.json['persisted']).toBe(true);
      const afterModify = await getJson(base, `/api/memory/entries/${toModify.memoryId}?owner_id=owner-a`);
      expect(String((afterModify.json['entry'] as Json)['text'])).toBe('终稿');
      expect((afterModify.json['entry'] as Json)['version']).toBe(1);

      // --- 停用 ---------------------------------------------------------
      const disabled = await postJson(base, `/api/memory/entries/${toDisable.memoryId}`, {
        owner_id: 'owner-a',
        action: 'disable',
        at: 600,
      });
      steps.push(['停用', `${disabled.status} action=${String(disabled.json['action'])}`]);
      expect(disabled.status).toBe(200);
      expect(disabled.json['action']).toBe('disable');
      const listed = await getJson(base, '/api/memory/entries?owner_id=owner-a&limit=50');
      expect(idsOf(listed.json), '停用后默认检索不再返回').not.toContain(toDisable.memoryId);
      const withDisabled = await getJson(base, '/api/memory/entries?owner_id=owner-a&limit=50&include_disabled=true');
      const disabledRow = (withDisabled.json['entries'] as readonly Json[]).find(
        (entry) => String(entry['memory_id']) === toDisable.memoryId,
      );
      expect(String(disabledRow?.['status'])).toBe('disabled');

      // --- 删除（软删，审计留痕）------------------------------------------
      const deleted = await postJson(base, `/api/memory/entries/${toDelete.memoryId}`, {
        owner_id: 'owner-a',
        action: 'delete',
        at: 700,
      });
      steps.push(['删除', `${deleted.status} action=${String(deleted.json['action'])}`]);
      expect(deleted.status).toBe(200);
      expect(deleted.json['action']).toBe('delete');
      const afterDelete = await getJson(base, '/api/memory/entries?owner_id=owner-a&limit=50&include_disabled=true');
      expect(idsOf(afterDelete.json), '软删条目连 include_disabled 都不返回').not.toContain(toDelete.memoryId);
      const audit = await getJson(base, `/api/memory/entries/${toDelete.memoryId}?owner_id=owner-a`);
      expect(audit.status, '审计记录仍在库（单条可读回 deleted）').toBe(200);
      expect(String((audit.json['entry'] as Json)['status'])).toBe('deleted');

      // --- 忘记（硬忘；立即从注入消失）-------------------------------------
      const forgotten = await postJson(base, `/api/memory/entries/${toForget.memoryId}`, {
        owner_id: 'owner-a',
        action: 'forget',
        at: 800,
      });
      steps.push(['忘记', `${forgotten.status} action=${String(forgotten.json['action'])} affected=${JSON.stringify(forgotten.json['affected'])}`]);
      expect(forgotten.status).toBe(200);
      expect(forgotten.json['action']).toBe('forget');
      expect(forgotten.json['affected']).toEqual([toForget.memoryId]);
      const afterForget = await getJson(base, '/api/memory/injection?owner_id=owner-a');
      const afterIds = (afterForget.json['included_ids'] as readonly string[]).map(String);
      steps.push([
        '忘记后 /injection',
        `${afterForget.status} 含 toForget=${String(afterIds.includes(toForget.memoryId))} digest含文本=${String(String(afterForget.json['digest']).includes('ZZQ'))}`,
      ]);
      expect(afterIds, '忘记后注入不再含它').not.toContain(toForget.memoryId);
      expect(String(afterForget.json['digest'])).not.toContain('ZZQ');
      const gone = await getJson(base, `/api/memory/entries/${toForget.memoryId}?owner_id=owner-a`);
      expect(gone.status).toBe(404);

      // 反向对照：把"忘记过的同一条"再写一次 ⇒ 拒绝（不得复活）。
      const revive = await writeMessage(base, { owner: 'owner-a', conversation: 'conv-1', text: '忘记我-ZZQ', at: 900 });
      steps.push(['重写已忘条目', `${revive.status}`]);
      expect(revive.status).toBe(409);
    } finally {
      logSteps('C1 修改/停用/删除/忘记', steps);
    }
  });
});

// ===========================================================================
// 5. 备份预览（剔除凭据并记名）
// ===========================================================================

describe('D. 备份预览（真 HTTP）——凭据剔除并记名', () => {
  it('D1 夹带凭据的条目被剔除且具名，进入备份的集合确实不含凭据', async () => {
    const runDir = newRunDir();
    const product = await open(runDir);
    const base = product.baseUrl;
    const steps: Step[] = [];
    try {
      await writeMessage(base, { owner: 'owner-a', conversation: 'conv-1', text: '正常消息', at: 100 });
      const clean = await writeFact(base, { owner: 'owner-a', task: 'task-1', key: 'week', value: 'W40', at: 200 });
      // 凭据两种命中形态：字段名像凭据（fact_key=api_key）+ 值形态像密钥（sk-…）。
      const secret = await writeFact(base, {
        owner: 'owner-a',
        task: 'task-1',
        key: 'api_key',
        value: 'sk-TESTONLY0000000000000000',
        at: 300,
      });
      expect(secret.status).toBe(200);

      const { status, json } = await getJson(base, '/api/memory/backup/preview?owner_id=owner-a');
      const exclusions = (json['credential_exclusions'] as readonly Json[]).map((item) => String(item['memory_id']));
      const included = (json['included_ids'] as readonly string[]).map(String);
      steps.push([
        'GET /backup/preview',
        `${status} total=${String(json['total_entries'])} included=${String(json['included_count'])} exclusions=${JSON.stringify(exclusions)} leak=${String(json['credential_leak_detected'])} free=${String(json['credential_free'])} dry_run=${String(json['dry_run'])}`,
      ]);
      expect(status).toBe(200);
      expect(json['dry_run']).toBe(true);
      expect(exclusions, '凭据条目被剔除且**具名**').toContain(secret.memoryId);
      expect(included).not.toContain(secret.memoryId);
      expect(included, '正常条目仍进备份（剔除不是"整库不备份"）').toContain(clean.memoryId);
      expect(json['credential_free'], '进入备份的集合经逐条复核不含凭据').toBe(true);
      expect((json['kinds'] as readonly Json[])).toHaveLength(4);

      // 预览不改库：被剔除的那条仍在库里。
      const still = await getJson(base, `/api/memory/entries/${secret.memoryId}?owner_id=owner-a`);
      expect(still.status).toBe(200);
    } finally {
      logSteps('D1 备份预览', steps);
    }
  });
});

// ===========================================================================
// 6. 保留期 dry-run
// ===========================================================================

describe('E. 保留期 dry-run（真 HTTP）——不确定项不上删除清单', () => {
  it('E1 恒 dry_run:true；将删清单可解释；不确定项一条都不在删除清单里', async () => {
    const runDir = newRunDir();
    const product = await open(runDir);
    const base = product.baseUrl;
    const steps: Step[] = [];
    try {
      const old = await writeMessage(base, { owner: 'owner-a', conversation: 'conv-1', text: '很久以前的消息', at: 1000 });
      const future = await writeMessage(base, { owner: 'owner-a', conversation: 'conv-1', text: '保留期内的消息', at: 100000 });
      const otherOwner = await writeMessage(base, { owner: 'owner-b', conversation: 'conv-b', text: '别的主体的消息', at: 1000 });

      const { status, json } = await getJson(
        base,
        '/api/memory/retention/preview?owner_id=owner-a&max_age=100&now=100000',
      );
      const willDelete = (json['will_delete_ids'] as readonly string[]).map(String);
      const uncertain = (json['uncertain_ids'] as readonly string[]).map(String);
      steps.push([
        'GET /retention/preview',
        `${status} dry_run=${String(json['dry_run'])} cutoff=${String(json['cutoff'])} will_delete=${JSON.stringify(willDelete)} keep=${String(json['will_keep_count'])} uncertain=${JSON.stringify(uncertain)} uncertain_untouched=${String(json['uncertain_untouched'])} out_of_scope=${String(json['out_of_scope_count'])}`,
      ]);
      expect(status).toBe(200);
      expect(json['dry_run']).toBe(true);
      expect(json['cutoff']).toBe(99900);
      expect(willDelete).toContain(old.memoryId);
      expect(willDelete, '保留期内的条目不在删除清单').not.toContain(future.memoryId);
      // 范围外（owner-b）的条目既不在删除清单、也不在保留清单里 —— 如实计入 out_of_scope。
      expect(willDelete).not.toContain(otherOwner.memoryId);
      expect((json['out_of_scope_count'] as number)).toBeGreaterThan(0);
      // 每条将删都有"为什么"的依据（可解释）。
      const willDeleteRows = json['will_delete'] as readonly Json[];
      expect(willDeleteRows.length).toBe(willDelete.length);
      for (const row of willDeleteRows) {
        expect(String(row['reason'])).toContain('范围');
        expect(String(row['reason'])).toContain('超期');
      }
      // **不确定项不上删除清单**：不相交 + 路由自带的不变式。
      for (const id of uncertain) expect(willDelete).not.toContain(id);
      expect(json['uncertain_untouched']).toBe(true);
      // ⚠️ 诚实标注：路由层的保留期分类只读**仓库**条目，而仓库条目一律经 `createMemoryEntry`
      // 校验，因此 `uncertain` 这一支经路由**结构上恒为空**（下面这条断言是恒真的，不构成
      // "不确定项不删"的正面证明；正面证据在 `src/memory/backup-plan.test.ts` 的层下对照）。
      steps.push(['诚实标注', `路由层 uncertain 恒空（结构上）⇒ uncertain_untouched=true 是恒真断言，非安全证明`]);
      expect(uncertain).toEqual([]);

      // 预览不改库：将删的条目仍在库里。
      const still = await getJson(base, `/api/memory/entries/${old.memoryId}?owner_id=owner-a`);
      expect(still.status).toBe(200);
    } finally {
      logSteps('E1 保留期 dry-run', steps);
    }
  });
});

// ===========================================================================
// 7. 跨重启（同运行目录，换服务实例）
// ===========================================================================

describe('F. 跨重启（真 HTTP + 真文件落盘；同运行目录换服务实例）', () => {
  it('F1 记忆仍在、忘记过的不复活，且重写被拒', async () => {
    const runDir = newRunDir();
    const steps: Step[] = [];
    const first = await open(runDir);
    let keepMessage = '';
    let keepFact = '';
    let forgotten = '';
    try {
      const m1 = await writeMessage(first.baseUrl, { owner: 'owner-a', conversation: 'conv-1', text: '重启后要记得我-AAA', at: 100 });
      const m2 = await writeMessage(first.baseUrl, { owner: 'owner-a', conversation: 'conv-1', text: '忘记我-BBB', at: 200 });
      const f1 = await writeFact(first.baseUrl, { owner: 'owner-a', task: 'task-1', key: 'week', value: 'W40', at: 300 });
      keepMessage = m1.memoryId;
      keepFact = f1.memoryId;
      forgotten = m2.memoryId;
      const forgottenAck = await postJson(first.baseUrl, `/api/memory/entries/${m2.memoryId}`, {
        owner_id: 'owner-a',
        action: 'forget',
        at: 400,
      });
      expect(forgottenAck.status).toBe(200);
      steps.push(['实例 1：写入 2 条 + 1 事实，忘记 1 条', `forget=${forgottenAck.status}`]);
    } finally {
      await first.close();
      // 从收摊队列里摘掉（已手动关闭）。
      const index = running.indexOf(first);
      if (index >= 0) running.splice(index, 1);
    }

    // --- 换一个服务实例（**同一运行目录**）--------------------------------
    const second = await open(runDir);
    try {
      const list = await getJson(second.baseUrl, '/api/memory/entries?owner_id=owner-a&limit=50');
      const ids = idsOf(list.json);
      steps.push([
        '实例 2：GET /entries',
        `${list.status} total=${String((list.json['paging'] as Json)['total_matched'])} ids=${JSON.stringify(ids)}`,
      ]);
      expect(list.status).toBe(200);
      expect(ids, '未忘记的条目跨重启仍在').toContain(keepMessage);
      expect(ids).toContain(keepFact);
      expect(ids, '忘记过的不复活').not.toContain(forgotten);
      // 不是"整库读不出来"造成的假阴性：注入也仍非空。
      const inject = await getJson(second.baseUrl, '/api/memory/injection?owner_id=owner-a');
      expect(inject.status).toBe(200);
      expect(String(inject.json['digest'])).toContain('AAA');
      steps.push(['实例 2：GET /injection', `${inject.status} 含未忘记条目=${String(String(inject.json['digest']).includes('AAA'))}`]);

      const gone = await getJson(second.baseUrl, `/api/memory/entries/${forgotten}?owner_id=owner-a`);
      expect(gone.status).toBe(404);
      // 反向对照：把忘记过的那条再写一次 ⇒ 409（墓碑跨重启仍在，不复活）。
      const revive = await writeMessage(second.baseUrl, { owner: 'owner-a', conversation: 'conv-1', text: '忘记我-BBB', at: 900 });
      steps.push(['实例 2：重写已忘条目', `${revive.status}`]);
      expect(revive.status).toBe(409);
    } finally {
      logSteps('F1 跨重启', steps);
    }
  });
});

// ===========================================================================
// 8. 反向对照
// ===========================================================================

describe('G. 反向对照（真 HTTP）', () => {
  it('G1 跨 owner 写被拒；缺 owner_id ⇒ 400；坏形态 ⇒ 结构化拒绝且不补默认值', async () => {
    const runDir = newRunDir();
    const product = await open(runDir);
    const base = product.baseUrl;
    const steps: Step[] = [];
    try {
      const mine = await writeMessage(base, { owner: 'owner-a', conversation: 'conv-1', text: '我的消息', at: 100 });
      expect(mine.status).toBe(200);

      const before = await getJson(base, '/api/memory/entries?owner_id=owner-a&limit=50&include_disabled=true');
      const beforeTotal = (before.json['paging'] as Json)['total_matched'];

      // --- 跨 owner 写（以 owner-b 的身份改 owner-a 的条目）⇒ 404 ---------
      const crossMutate = await postJson(base, `/api/memory/entries/${mine.memoryId}`, {
        owner_id: 'owner-b',
        action: 'forget',
      });
      steps.push(['跨 owner 改（forget）', `${crossMutate.status} code=${String(crossMutate.json['code'])}`]);
      expect(crossMutate.status).toBe(404);
      expect(crossMutate.json['code']).toBe('memory_not_visible');
      const survivor = await getJson(base, `/api/memory/entries/${mine.memoryId}?owner_id=owner-a`);
      expect(survivor.status, '被跨 owner 改过后条目仍在').toBe(200);

      // --- 缺 owner_id ⇒ 400（读与写各一条）-------------------------------
      const readNoOwner = await getJson(base, '/api/memory/entries');
      const writeNoOwner = await postJson(base, '/api/memory/messages', {
        conversation_id: 'conv-1',
        role: 'user',
        text: '没有主体',
        source: SOURCE,
      });
      steps.push([
        '缺 owner_id',
        `GET /entries ${readNoOwner.status}/${String(readNoOwner.json['code'])}；POST /messages ${writeNoOwner.status}/${String(writeNoOwner.json['code'])}`,
      ]);
      expect(readNoOwner.status).toBe(400);
      expect(readNoOwner.json['code']).toBe('invalid_owner_id');
      expect(writeNoOwner.status).toBe(400);
      expect(writeNoOwner.json['code']).toBe('invalid_owner_id');

      // --- 坏形态 ⇒ 结构化拒绝（422 / 400），且**仓库一条都没多** -----------
      const cases: readonly { readonly label: string; readonly path: string; readonly body: unknown; readonly expectStatus: number; readonly expectCode: string }[] = [
        {
          label: '缺 text',
          path: '/api/memory/messages',
          body: { owner_id: 'owner-a', conversation_id: 'conv-1', role: 'user', source: SOURCE },
          expectStatus: 422,
          expectCode: 'invalid_text',
        },
        {
          label: '坏 role',
          path: '/api/memory/messages',
          body: { owner_id: 'owner-a', conversation_id: 'conv-1', role: 'robot', text: 'x', source: SOURCE },
          expectStatus: 422,
          expectCode: 'invalid_role',
        },
        {
          label: '缺 source',
          path: '/api/memory/messages',
          body: { owner_id: 'owner-a', conversation_id: 'conv-1', role: 'user', text: 'x' },
          expectStatus: 422,
          expectCode: 'invalid_source',
        },
        {
          label: '坏 confirmation',
          path: '/api/memory/messages',
          body: { owner_id: 'owner-a', conversation_id: 'conv-1', role: 'user', text: 'x', source: SOURCE, confirmation: 'maybe' },
          expectStatus: 422,
          expectCode: 'invalid_confirmation',
        },
        {
          label: '缺 task_id',
          path: '/api/memory/facts',
          body: { owner_id: 'owner-a', fact_key: 'k', value_text: 'v', source: SOURCE },
          expectStatus: 422,
          expectCode: 'invalid_task_id',
        },
        {
          label: '缺 conversation_id',
          path: '/api/memory/messages',
          body: { owner_id: 'owner-a', role: 'user', text: 'x', source: SOURCE },
          expectStatus: 422,
          expectCode: 'invalid_conversation_id',
        },
        {
          label: '坏 action',
          path: `/api/memory/entries/${mine.memoryId}`,
          body: { owner_id: 'owner-a', action: 'purge' },
          expectStatus: 422,
          expectCode: 'invalid_action',
        },
        {
          label: '请求体不是对象',
          path: '/api/memory/messages',
          body: ['not', 'an', 'object'],
          expectStatus: 400,
          expectCode: 'invalid_body',
        },
      ];
      for (const item of cases) {
        const response = await postJson(base, item.path, item.body);
        steps.push([`坏形态「${item.label}」`, `${response.status}/${String(response.json['code'])}`]);
        expect(response.status, `${item.label} ⇒ 状态码`).toBe(item.expectStatus);
        expect(response.json['code'], `${item.label} ⇒ 结构化拒因`).toBe(item.expectCode);
      }

      // --- 仓库计数不变（"坏形态"没有被静默补成默认值落库）------------------
      const after = await getJson(base, '/api/memory/entries?owner_id=owner-a&limit=50&include_disabled=true');
      const afterTotal = (after.json['paging'] as Json)['total_matched'];
      steps.push(['坏形态后仓库计数', `before=${String(beforeTotal)} after=${String(afterTotal)}`]);
      expect(afterTotal, '所有被拒的坏形态一条都没落库').toBe(beforeTotal);

      // --- 反向对照：好形态仍能写（证明上面的拒绝不是"路由全灭"）------------
      const good = await writeMessage(base, { owner: 'owner-a', conversation: 'conv-1', text: '好形态', at: 800 });
      steps.push(['好形态对照', `${good.status}/${good.outcome}`]);
      expect(good.status).toBe(200);
      expect(good.outcome).toBe('created');
    } finally {
      logSteps('G1 反向对照', steps);
    }
  });
});
