/**
 * 工作包 **FA-MEM-EXPERIENCE-PRODUCT**：把**经验流水线**（MEM-06 / MEM-07）在**产品 HTTP** 上走完。
 *
 * ## 这条链在产品 HTTP 上长什么样（每一个入口都点名）
 *
 * ```
 * POST /api/roles/experience/synthesize   ← 运行期唯一写入口（role_id = experience_agent）
 *   → handleExperience()（apps/demo/server/roles-wiring.ts）
 *   → taskCompletionOf(store, task_id)     ← 终态口径**只此一处**（apps/demo/server/task-completion.ts）
 *   → synthesizeTaskExperience(...)        ← 触发门 + 证据门 + 裁决 + 版本化写入
 *       （apps/demo/server/experience-wiring.ts，**复用** src/memory/** 与 src/roles/experience-agent.ts）
 *
 * GET  /api/memory/experiences            ← 写/失效两条泳道（读口）
 * GET  /api/memory/injection              ← 实例注入（recall 真路径 + 闸门）
 * POST /api/memory/experiences/:id/rollback
 * POST /api/memory/experiences/:id/invalidate
 * POST /api/memory/entries/:id            ← forget（把经验也当普通记忆条目忘记）
 * ```
 *
 * 起服务用的是**产品入口** `createDemoServer()`（与 `main.ts` 的 `startDemoServer` 同一个函数），
 * 端口 `listen(0)` 由内核分配；模型配置一律缺席 ⇒ 不碰模型。
 *
 * ## 与既有套件的分工（本文件**不重复**它们）
 *
 * | 既有套件 | 它覆盖到哪 | 本文件补什么 |
 * |---|---|---|
 * | `experience-wiring.test.ts` | **直接调用**接线函数（不碰 HTTP） | 本文件**全程真 HTTP**，走 `handleExperience()` |
 * | `roles-wiring.test.ts` | 路由层（`handleRolesRequest`，手工 req/res 桩） | 本文件走**真 `node:http`** + 真落盘 store |
 * | `a-items-product.test.ts` A17 | 经验四步的**一次纵切**（真 HTTP） | 本文件补 **`no_change`（"不新增"）**、**版本化递增**、**foreign 模板证据剔除**、**空证据集**，并把**产品面 / 内核面的边界**做成结构判据 |
 * | `memory-routes.test.ts` | 管理口语义（纯函数） | 本文件不碰：它只作对照 |
 *
 * ## 六条要成立的事（每一条都配反向对照）
 *
 * 1. **终态触发**：只有任务终态（`TaskCompletionView.completed`）才允许提经验候选；
 *    在途任务 ⇒ `422 experience_trigger_rejected`，且 `report.proposal` / `report.pipeline`
 *    均为 `null`——**结构上**走不到裁决与写库（不是"这次碰巧没写"）。
 * 2. **证据门槛**：只接受 `sealed && readback_verified` 的证据；未封存 / 未读回 ⇒
 *    `evidence_not_sealed`（不产出候选）；`unknown_external`（外部结果未知）即便已封存也
 *    不得固化成成功经验 ⇒ `blocked_unknown_external`；**别的模板**的证据被剔除并具名登记。
 * 3. **候选 → 裁决 → 版本化写入**：`add` ⇒ 版本 = 既有同模板最大版本 + 1；
 *    **可得出"不新增"**：同文本候选 ⇒ `no_change`，`written` 为空且库**逐字节不变**。
 * 4. **注入**：新实例（`instance_id`）经 `GET /api/memory/injection` 真吃到相关经验
 *    （走 `recall`，不是"自己拼一遍"）；**忘记 / 失效后不再注入**。
 * 5. **回滚**：回滚**一次具体写入（版本）**；回滚后检索不再命中、历史条目保留（不删除）。
 * 6. **边界如实**：哪些是**产品面真通**、哪些仍**只是内核逻辑（无 HTTP 入口）**——见 E 组。
 *
 * ## ⚠️ 如实标注（结果不得编造）
 *
 * - **真机未验证**：全部在 Node 进程内（真 HTTP + 真落盘），**不碰**安卓真机、不碰浏览器、
 *   不碰真实模型。设备侧经验注入**未验证**。
 * - **"库零新增"的判据**是 `GET /api/memory/experiences` 的两条泳道计数 + `GET /api/memory/injection`
 *   的召回结果——它们是产品读口，**不是**直接读内核内存（但也不是独立进程外证据）。
 * - **注入是"按 owner + 模板的召回"**：`GET /api/memory/injection` 每次从 `recall` 现算，
 *   因此它**结构性**不可能出现"失效后仍注入"。真正的"实例冻结规则漂移检测"
 *   （`verifyInstanceInjection` / `removed_since_binding`）**没有 HTTP 入口**——见 E 组，
 *   本文件**不为它编造产品面证据**。
 * - **回滚响应里的 `history_preserved: true` / `injectable_after: false` 是接线层写死的字面量**
 *   （见 `memory-routes.ts` 的 `handleExperienceRollback`）。本文件**不轻信**它们，
 *   一律用 `GET /api/memory/injection` + 泳道列表**独立复核**。
 * - **夹具只造起点状态**：任务行 / 工作项行经 `store.transact` 直写内核（与
 *   `a-items-product.test.ts` 的 `seedTask` 同一手法）；**所有断言都落在 HTTP 返回值上**。
 * - 【模型身份】交付说明：本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asInstanceId,
  asLogicalTime,
  asRequestId,
  asRevision,
  asTaskId,
  createTaskRecord,
  createWorkItem,
} from '../../../src/protocol/index.js';

import { getJson, postJson, startProduct, type Json, type RunningProduct } from './e2e-product-harness.js';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 本套件只用一个模板 id（外加一个"别的模板"用于 foreign 剔除对照）。 */
const TPL = 'template.document';
const FOREIGN_TPL = 'template.spreadsheet';

/** 一步实测记录（状态码 + 关键字段），用例末尾统一打印，避免断言与日志各说各话。 */
type Step = readonly [label: string, detail: string];
function logSteps(title: string, steps: readonly Step[]): void {
  // eslint-disable-next-line no-console
  console.log(`\n[${title}]\n` + steps.map(([label, detail]) => `  · ${label}：${detail}`).join('\n'));
}

// ---------------------------------------------------------------------------
// 夹具：任务行 / 工作项行（只造起点状态）
// ---------------------------------------------------------------------------

/**
 * 落一条**在途**任务：一条非终态工作项（`processing` + 明确的等待原因）。
 * 谓词 ① `all_work_items_terminal` 为假 ⇒ 完成视图 `completed === false`。
 */
function seedInFlightTask(running: RunningProduct, taskId: string): void {
  running.demo.host.store.transact((tx) => {
    tx.putTask(
      createTaskRecord({
        task_id: asTaskId(taskId),
        goal: 'FA-MEM-EXPERIENCE-PRODUCT 在途夹具任务',
        created_at: asLogicalTime(0),
        revision: asRevision(1),
      }),
    );
    tx.putWorkItem(
      createWorkItem({
        request_id: asRequestId(`req-${taskId}`),
        owner_instance_id: asInstanceId(`I-${taskId}`),
        task_id: asTaskId(taskId),
        task_revision: asRevision(1),
        status: 'processing',
        blocker_reason: { kind: 'waiting_external' as const, detail: '在途：等待外部结果（夹具）' },
        created_at: asLogicalTime(1),
      }),
    );
  });
}

/** 落一条**终态**任务：一条 `completed` 工作项 ⇒ 谓词 ① 成立（其余两个谓词在空集上成立）。 */
function seedTerminalTask(running: RunningProduct, taskId: string): void {
  running.demo.host.store.transact((tx) => {
    tx.putTask(
      createTaskRecord({
        task_id: asTaskId(taskId),
        goal: 'FA-MEM-EXPERIENCE-PRODUCT 终态夹具任务',
        created_at: asLogicalTime(0),
        revision: asRevision(1),
      }),
    );
    tx.putWorkItem(
      createWorkItem({
        request_id: asRequestId(`req-${taskId}`),
        owner_instance_id: asInstanceId(`I-${taskId}`),
        task_id: asTaskId(taskId),
        task_revision: asRevision(1),
        status: 'completed',
        created_at: asLogicalTime(1),
      }),
    );
  });
}

// ---------------------------------------------------------------------------
// 请求小工具
// ---------------------------------------------------------------------------

/** 一条"外壳完整"的证据；用例用 `overrides` 只改它关心的那一项。 */
function evidence(lesson: string, overrides: Json = {}): Json {
  return {
    evidence_ref: `ev-${lesson}`,
    template_id: TPL,
    lesson,
    applies_to_version: '2026.10',
    outcome: 'success',
    sealed: true,
    readback_verified: true,
    ...overrides,
  };
}

interface SynthesizeInput {
  readonly owner: string;
  readonly task: string;
  readonly evidence: readonly Json[];
  readonly template?: string;
  readonly at?: number;
}

/** 经**产品入口**提交一次经验固化（`POST /api/roles/experience/synthesize`）。 */
async function synthesize(
  base: string,
  input: SynthesizeInput,
): Promise<{ readonly status: number; readonly json: Json }> {
  return postJson(base, '/api/roles/experience/synthesize', {
    owner_id: input.owner,
    task_id: input.task,
    template_id: input.template ?? TPL,
    evidence: input.evidence,
    at: input.at ?? 0,
  });
}

/** 读经验的两条泳道（`GET /api/memory/experiences`）。 */
async function lanes(
  base: string,
  owner: string,
  template: string = TPL,
): Promise<{ readonly status: number; readonly json: Json }> {
  const query = new URLSearchParams({ owner_id: owner, template_id: template });
  return getJson(base, `/api/memory/experiences?${query.toString()}`);
}

/** 读实例注入面（`GET /api/memory/injection`，只取模板经验）。 */
async function injection(
  base: string,
  owner: string,
  instance = 'mem-exp-probe',
  template: string = TPL,
): Promise<{ readonly status: number; readonly json: Json }> {
  const query = new URLSearchParams({
    owner_id: owner,
    template_id: template,
    kind: 'template_experience',
    instance_id: instance,
  });
  return getJson(base, `/api/memory/injection?${query.toString()}`);
}

function writtenIds(body: Json): readonly string[] {
  return (body['written'] as readonly Json[]).map((entry) => String(entry['memory_id']));
}

function invalidIds(body: Json): readonly string[] {
  return (body['invalid'] as readonly Json[]).map((entry) => String(entry['memory_id']));
}

/** 泳道条目的 `id@version` 指纹（用于"库逐字节不变"的对照，不依赖排序）。 */
function laneFingerprint(body: Json): readonly string[] {
  const all = [...(body['written'] as readonly Json[]), ...(body['invalid'] as readonly Json[])];
  return all.map((entry) => `${String(entry['memory_id'])}@r${String(entry['version'])}`).sort();
}

function countOf(body: Json, key: 'written' | 'invalid'): number {
  return (body['counts'] as Json)[key] as number;
}

/** 从 200 响应的 `report.written` 里取一条（按 lesson）。 */
function writtenByLesson(report: Json, lesson: string): Json {
  const hit = (report['written'] as readonly Json[]).find((entry) => String(entry['lesson']) === lesson);
  if (hit === undefined) throw new Error(`report.written 里没有 lesson=${JSON.stringify(lesson)}`);
  return hit;
}

// ---------------------------------------------------------------------------
// 服务（本套件共用一个产品实例；用例之间靠 owner 隔离）
// ---------------------------------------------------------------------------

let workDir: string;
let main: RunningProduct;

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'potbot-mem-exp-e2e-'));
  main = await startProduct(join(workDir, 'run-exp'));
}, 120_000);

afterAll(async () => {
  await main.close();
  rmSync(workDir, { recursive: true, force: true });
});

// ===========================================================================
// A. 终态触发门：在途任务不得提经验候选
// ===========================================================================

describe('A. 终态触发门（真 HTTP）——在途任务不得提经验候选', () => {
  it('A1 在途任务 ⇒ 422 experience_trigger_rejected，且库零新增', async () => {
    const owner = 'owner-inflight';
    const task = 'task-inflight-1';
    seedInFlightTask(main, task);
    const steps: Step[] = [];
    try {
      const rejected = await synthesize(main.baseUrl, {
        owner,
        task,
        evidence: [evidence('在途任务不该固化这条')],
      });
      const trigger = (rejected.json['trigger'] ?? {}) as Json;
      const report = (rejected.json['report'] ?? {}) as Json;
      steps.push([
        'POST /api/roles/experience/synthesize（在途）',
        `${rejected.status} code=${String(rejected.json['code'])} trigger.state=${String(trigger['state'])} written=${JSON.stringify(rejected.json['written'])}`,
      ]);
      expect(rejected.status, JSON.stringify(rejected.json)).toBe(422);
      expect(rejected.json['code']).toBe('experience_trigger_rejected');
      expect(rejected.json['written']).toEqual([]);
      expect(trigger['state']).toBe('in_flight');
      expect(trigger['eligible']).toBe(false);
      // **结构后果**（不是"这次碰巧为空"）：没有候选、没有裁决、没有写库路径可走。
      expect(report['proposal'], '在途任务结构上不产生候选').toBeNull();
      expect(report['pipeline'], '在途任务结构上不做裁决 / 不写库').toBeNull();

      // 反向对照：库零新增（写泳道 0、失效泳道 0、注入读不到）。
      const after = await lanes(main.baseUrl, owner);
      expect(after.status).toBe(200);
      expect(countOf(after.json, 'written'), '被拒后写泳道必须为 0').toBe(0);
      expect(countOf(after.json, 'invalid')).toBe(0);
      const inj = await injection(main.baseUrl, owner);
      expect(inj.status).toBe(200);
      expect(inj.json['status']).toBe('not_found');
      expect(inj.json['digest']).toBe('');
      expect(inj.json['included_ids']).toEqual([]);
      steps.push([
        '反向对照：库零新增',
        `experiences: written=${String(countOf(after.json, 'written'))} invalid=${String(countOf(after.json, 'invalid'))}；injection: status=${String(inj.json['status'])} digest=${JSON.stringify(inj.json['digest'])}`,
      ]);
    } finally {
      logSteps('A1 在途任务被拒 + 库零新增', steps);
    }
  });

  it('A2 任务不在内核存储里 ⇒ 422 task_not_found（连完成视图都派生不出，不编造）', async () => {
    const res = await synthesize(main.baseUrl, {
      owner: 'owner-notask',
      task: 'task-absent-1',
      evidence: [evidence('任务不存在时的候选')],
    });
    logSteps('A2 未知任务', [['POST synthesize（未知 task）', `${res.status} code=${String(res.json['code'])}`]]);
    expect(res.status).toBe(422);
    expect(res.json['code']).toBe('task_not_found');
  });

  it('A3 反向对照：终态任务 ⇒ 200 且真写入（证明 A1 的拒绝不是"路由全灭"）', async () => {
    const owner = 'owner-terminal';
    const task = 'task-terminal-1';
    seedTerminalTask(main, task);
    const steps: Step[] = [];
    try {
      const ok = await synthesize(main.baseUrl, {
        owner,
        task,
        evidence: [evidence('终态任务的真实经验')],
      });
      const report = ok.json['report'] as Json;
      steps.push([
        'POST synthesize（终态）',
        `${ok.status} eligible=${String((report['trigger'] as Json)['eligible'])} written=${String((report['written'] as readonly Json[]).length)} clean=${String(report['clean'])}`,
      ]);
      expect(ok.status, JSON.stringify(ok.json)).toBe(200);
      expect((report['trigger'] as Json)['eligible']).toBe(true);
      expect((report['trigger'] as Json)['state']).toBe('eligible');
      expect(report['written']).toHaveLength(1);
      expect(writtenByLesson(report, '终态任务的真实经验')['version']).toBe(0);
      expect(report['clean']).toBe(true);

      // 库确实新增（与 A1 的"零新增"构成同一把尺子的两端）。
      const after = await lanes(main.baseUrl, owner);
      expect(countOf(after.json, 'written')).toBe(1);
      steps.push(['终态后泳道', `written=${String(countOf(after.json, 'written'))}`]);
    } finally {
      logSteps('A3 终态任务真写入', steps);
    }
  });
});

// ===========================================================================
// B. 证据门槛：只接受已封存且有回读证据的结果
// ===========================================================================

describe('B. 证据门槛（真 HTTP）——未封存 / 未读回 / 外部未知 / 异模板', () => {
  it('B1 未封存与未读回 ⇒ evidence_not_sealed，不产出候选、库零新增', async () => {
    const owner = 'owner-evidence-seal';
    const task = 'task-evidence-1';
    seedTerminalTask(main, task);
    const steps: Step[] = [];
    try {
      const res = await synthesize(main.baseUrl, {
        owner,
        task,
        evidence: [
          evidence('未封存的做法', { sealed: false }),
          evidence('未读回的做法', { readback_verified: false }),
        ],
      });
      const report = res.json['report'] as Json;
      const codes = (report['evidence_rejections'] as readonly Json[]).map((item) => String(item['code']));
      steps.push([
        'POST synthesize（未封存 / 未读回）',
        `${res.status} written=${JSON.stringify(report['written'])} rejection_codes=${JSON.stringify(codes)} accepted=${JSON.stringify(report['accepted_lessons'])}`,
      ]);
      expect(res.status).toBe(200);
      expect(report['written']).toEqual([]);
      expect(report['accepted_lessons']).toEqual([]);
      expect(codes, '未封存 / 未读回必须**具名**记录，不静默丢弃').toContain('evidence_not_sealed');

      const after = await lanes(main.baseUrl, owner);
      expect(countOf(after.json, 'written'), '未封存证据不得落库').toBe(0);
    } finally {
      logSteps('B1 证据门槛', steps);
    }
  });

  it('B2 外部结果未知（unknown_external）⇒ 不固化成成功经验，具名挡下、库零新增', async () => {
    const owner = 'owner-unknown-external';
    const task = 'task-evidence-2';
    seedTerminalTask(main, task);
    const steps: Step[] = [];
    try {
      const res = await synthesize(main.baseUrl, {
        owner,
        task,
        // 已封存 + 已读回，**但**外部结果未知：这是"读回"覆盖不到的那类事实。
        evidence: [evidence('外部结果未知的做法', { outcome: 'unknown_external' })],
      });
      const report = res.json['report'] as Json;
      steps.push([
        'POST synthesize（unknown_external）',
        `${res.status} written=${JSON.stringify(report['written'])} blocked=${JSON.stringify(report['blocked_unknown_external'])} accepted=${JSON.stringify(report['accepted_lessons'])} clean=${String(report['clean'])}`,
      ]);
      expect(res.status).toBe(200);
      expect(report['written']).toEqual([]);
      expect(report['blocked_unknown_external']).toContain('外部结果未知的做法');
      expect(report['accepted_lessons']).not.toContain('外部结果未知的做法');
      // 挡住它是**干净**结局（clean 为真不是"没被检出"）。
      expect(report['clean']).toBe(true);

      // 反向对照：库零新增，注入读不回它。
      const after = await lanes(main.baseUrl, owner);
      expect(countOf(after.json, 'written')).toBe(0);
      const inj = await injection(main.baseUrl, owner);
      expect(inj.json['status']).toBe('not_found');
      expect(String(inj.json['digest'])).not.toContain('外部结果未知的做法');
      steps.push(['反向对照', `写泳道=${String(countOf(after.json, 'written'))}；injection.status=${String(inj.json['status'])}`]);
    } finally {
      logSteps('B2 未知外部结果不得固化', steps);
    }
  });

  it('B3 属于别的模板的证据被剔除并具名登记（foreign_template_evidence_refs）', async () => {
    const owner = 'owner-foreign-template';
    const task = 'task-evidence-3';
    seedTerminalTask(main, task);
    const steps: Step[] = [];
    try {
      const res = await synthesize(main.baseUrl, {
        owner,
        task,
        template: TPL,
        evidence: [evidence('别的模板的经验', { template_id: FOREIGN_TPL })],
      });
      const report = res.json['report'] as Json;
      steps.push([
        'POST synthesize（异模板证据）',
        `${res.status} written=${JSON.stringify(report['written'])} foreign=${JSON.stringify(report['foreign_template_evidence_refs'])}`,
      ]);
      expect(res.status).toBe(200);
      expect(report['written'], '异模板证据不得写成本模板的经验').toEqual([]);
      expect(report['foreign_template_evidence_refs']).toContain('ev-别的模板的经验');

      const after = await lanes(main.baseUrl, owner);
      expect(countOf(after.json, 'written')).toBe(0);
      // 反向对照：异模板**本模板**模板 id 下无新增；但那名"别的模板"下也一条没写（证据被剔除，不是改嫁）。
      const foreignLanes = await lanes(main.baseUrl, owner, FOREIGN_TPL);
      expect(countOf(foreignLanes.json, 'written')).toBe(0);
    } finally {
      logSteps('B3 异模板证据剔除', steps);
    }
  });

  it('B4 空证据集 ⇒ empty_evidence_set，可得出"不新增"、库零新增', async () => {
    const owner = 'owner-empty-evidence';
    const task = 'task-evidence-4';
    seedTerminalTask(main, task);
    const steps: Step[] = [];
    try {
      const res = await synthesize(main.baseUrl, { owner, task, evidence: [] });
      const report = res.json['report'] as Json;
      const codes = (report['evidence_rejections'] as readonly Json[]).map((item) => String(item['code']));
      steps.push([
        'POST synthesize（空证据）',
        `${res.status} written=${JSON.stringify(report['written'])} rejection_codes=${JSON.stringify(codes)}`,
      ]);
      expect(res.status).toBe(200);
      expect(codes).toContain('empty_evidence_set');
      expect(report['written']).toEqual([]);

      const after = await lanes(main.baseUrl, owner);
      expect(countOf(after.json, 'written')).toBe(0);
    } finally {
      logSteps('B4 空证据集', steps);
    }
  });
});

// ===========================================================================
// C. 候选 → 裁决 → 版本化写入（可得出"不新增"）
// ===========================================================================

describe('C. 裁决与版本化写入（真 HTTP）——含"不新增"', () => {
  it('C1 逐条写入：版本 = 既有同模板最大版本 + 1（r0 → r1）', async () => {
    const owner = 'owner-version';
    const task = 'task-version-1';
    seedTerminalTask(main, task);
    const steps: Step[] = [];
    try {
      const first = await synthesize(main.baseUrl, {
        owner,
        task,
        evidence: [evidence('先写大纲再写正文')],
      });
      expect(first.status, JSON.stringify(first.json)).toBe(200);
      const firstReport = first.json['report'] as Json;
      const firstEntry = writtenByLesson(firstReport, '先写大纲再写正文');
      expect(firstEntry['version'], '模板下的第一条经验版本为 r0').toBe(0);

      const second = await synthesize(main.baseUrl, {
        owner,
        task,
        evidence: [evidence('交付前做一次自检')],
      });
      expect(second.status, JSON.stringify(second.json)).toBe(200);
      const secondReport = second.json['report'] as Json;
      const secondEntry = writtenByLesson(secondReport, '交付前做一次自检');
      expect(secondEntry['version'], '第二条经验版本递增为 r1').toBe(1);
      steps.push([
        '两次写入',
        `第一条 r${String(firstEntry['version'])} id=${String(firstEntry['memory_id'])}；第二条 r${String(secondEntry['version'])} id=${String(secondEntry['memory_id'])}`,
      ]);

      const after = await lanes(main.baseUrl, owner);
      expect(countOf(after.json, 'written')).toBe(2);
      steps.push(['泳道', `written=${String(countOf(after.json, 'written'))}`]);
    } finally {
      logSteps('C1 版本化写入', steps);
    }
  });

  it('C2 同文本候选再提 ⇒ no_change（"不新增"是一等结论），库逐字节不变', async () => {
    const owner = 'owner-nochange';
    const task = 'task-version-2';
    seedTerminalTask(main, task);
    const steps: Step[] = [];
    try {
      const first = await synthesize(main.baseUrl, {
        owner,
        task,
        evidence: [evidence('同一条经验只写一次')],
      });
      expect(first.status).toBe(200);
      expect((first.json['report'] as Json)['written']).toHaveLength(1);

      const before = await lanes(main.baseUrl, owner);
      const beforeFingerprint = laneFingerprint(before.json);
      stepFingerprint(steps, '写入后泳道指纹', beforeFingerprint);

      // 同文本（同模板、同 owner）再提一次。
      const again = await synthesize(main.baseUrl, {
        owner,
        task,
        evidence: [evidence('同一条经验只写一次', { evidence_ref: 'ev-second-attempt' })],
      });
      const report = again.json['report'] as Json;
      steps.push([
        'POST synthesize（同文本）',
        `${again.status} written=${JSON.stringify(report['written'])} no_change=${JSON.stringify(report['no_change_lessons'])} accepted=${JSON.stringify(report['accepted_lessons'])}`,
      ]);
      expect(again.status).toBe(200);
      expect(report['no_change_lessons']).toContain('同一条经验只写一次');
      expect(report['accepted_lessons']).toEqual([]);
      expect(report['written'], 'no_change 不得写库').toEqual([]);

      // 反向对照：库**逐字节不变**（同 id、同版本，条数不变）。
      const after = await lanes(main.baseUrl, owner);
      const afterFingerprint = laneFingerprint(after.json);
      expect(afterFingerprint).toEqual(beforeFingerprint);
      expect(countOf(after.json, 'written')).toBe(1);
      stepFingerprint(steps, 'no_change 后泳道指纹', afterFingerprint);
    } finally {
      logSteps('C2 不新增（no_change）', steps);
    }
  });
});

function stepFingerprint(steps: Step[], label: string, fingerprint: readonly string[]): void {
  steps.push([label, JSON.stringify(fingerprint)]);
}

// ===========================================================================
// D. 注入与回滚
// ===========================================================================

describe('D. 注入与回滚（真 HTTP）', () => {
  it('D1 新实例（instance_id）经真召回吃到相关经验；跨 owner 拿不到', async () => {
    const owner = 'owner-inject';
    const task = 'task-inject-1';
    seedTerminalTask(main, task);
    const steps: Step[] = [];
    try {
      const write = await synthesize(main.baseUrl, {
        owner,
        task,
        evidence: [evidence('注入给下一个新实例的经验')],
      });
      expect(write.status, JSON.stringify(write.json)).toBe(200);
      const id = String(writtenByLesson(write.json['report'] as Json, '注入给下一个新实例的经验')['memory_id']);

      // 写之前：一个全新实例什么都吃不到（"恒空"先被记录一次）。
      const beforeAny = await injection(main.baseUrl, 'owner-inject-empty-only', 'brand-new-instance');
      expect(beforeAny.json['status']).toBe('not_found');

      const inj = await injection(main.baseUrl, owner, 'brand-new-instance');
      steps.push([
        'GET /injection（新实例）',
        `${inj.status} status=${String(inj.json['status'])} injected=${String(inj.json['injected'])} included=${JSON.stringify(inj.json['included_ids'])}`,
      ]);
      expect(inj.status).toBe(200);
      expect(inj.json['status']).toBe('found');
      expect(inj.json['included_ids']).toContain(id);
      expect(String(inj.json['digest'])).toContain('注入给下一个新实例的经验');
      expect(inj.json['instance_id']).toBe('brand-new-instance');

      // 反向对照：跨 owner 的注入拿不到这条。
      const foreign = await injection(main.baseUrl, 'owner-else-inject', 'brand-new-instance');
      expect(foreign.json['included_ids']).not.toContain(id);
      expect(String(foreign.json['digest'])).not.toContain('注入给下一个新实例的经验');
      steps.push([
        '反向对照：跨 owner 注入',
        `status=${String(foreign.json['status'])} included=${JSON.stringify(foreign.json['included_ids'])}`,
      ]);
    } finally {
      logSteps('D1 新实例注入', steps);
    }
  });

  it('D2 忘记后不再注入（忘记前注入含它 —— 否则是假阴性）', async () => {
    const owner = 'owner-forget';
    const task = 'task-forget-1';
    seedTerminalTask(main, task);
    const steps: Step[] = [];
    try {
      const write = await synthesize(main.baseUrl, {
        owner,
        task,
        evidence: [evidence('忘记我-EXPFORGET')],
      });
      expect(write.status, JSON.stringify(write.json)).toBe(200);
      const id = String(writtenByLesson(write.json['report'] as Json, '忘记我-EXPFORGET')['memory_id']);

      const beforeForget = await injection(main.baseUrl, owner);
      expect(beforeForget.json['included_ids'], '忘记前必须真的能注入它').toContain(id);

      const forgotten = await postJson(main.baseUrl, `/api/memory/entries/${id}`, {
        owner_id: owner,
        action: 'forget',
      });
      steps.push(['忘记', `${forgotten.status} action=${String(forgotten.json['action'])}`]);
      expect(forgotten.status).toBe(200);

      const afterForget = await injection(main.baseUrl, owner);
      steps.push([
        '忘记后 /injection',
        `${afterForget.status} status=${String(afterForget.json['status'])} included=${JSON.stringify(afterForget.json['included_ids'])}`,
      ]);
      expect(afterForget.json['included_ids'], '忘记后不得再注入').not.toContain(id);
      expect(String(afterForget.json['digest'])).not.toContain('EXPFORGET');

      const after = await lanes(main.baseUrl, owner);
      expect(writtenIds(after.json)).not.toContain(id);
    } finally {
      logSteps('D2 忘记后不再注入', steps);
    }
  });

  it('D3 失效（invalidate）后不再注入，但条目落进失效泳道（历史保留）', async () => {
    const owner = 'owner-invalidate';
    const task = 'task-invalidate-1';
    seedTerminalTask(main, task);
    const steps: Step[] = [];
    try {
      const write = await synthesize(main.baseUrl, {
        owner,
        task,
        evidence: [evidence('失效我-EXPINVALID')],
      });
      expect(write.status, JSON.stringify(write.json)).toBe(200);
      const id = String(writtenByLesson(write.json['report'] as Json, '失效我-EXPINVALID')['memory_id']);
      expect((await injection(main.baseUrl, owner)).json['included_ids']).toContain(id);

      const invalidated = await postJson(main.baseUrl, `/api/memory/experiences/${id}/invalidate`, {
        owner_id: owner,
        reason: '该做法在新版本里不再成立',
        basis: '新版本实测回读显示相反结论',
        evidence_refs: ['ev-trial-2026-10'],
      });
      steps.push([
        '失效',
        `${invalidated.status} kind=${String(invalidated.json['kind'])} invalidated_version=${String(((invalidated.json['record'] ?? {}) as Json)['invalidated_version'])}`,
      ]);
      expect(invalidated.status, JSON.stringify(invalidated.json)).toBe(200);
      expect(invalidated.json['kind']).toBe('invalidated');

      const inj = await injection(main.baseUrl, owner);
      expect(inj.json['included_ids'], '失效后不得再注入').not.toContain(id);
      expect(String(inj.json['digest'])).not.toContain('EXPINVALID');

      const after = await lanes(main.baseUrl, owner);
      expect(invalidIds(after.json), '失效条目落进失效泳道（历史保留）').toContain(id);
      expect(writtenIds(after.json)).not.toContain(id);
      steps.push([
        '失效后',
        `injection.status=${String(inj.json['status'])}；written=${JSON.stringify(writtenIds(after.json))} invalid=${JSON.stringify(invalidIds(after.json))}`,
      ]);
    } finally {
      logSteps('D3 失效后不再注入', steps);
    }
  });

  it('D4 回滚后检索不再命中、历史保留（不轻信响应里的字面量，独立复核）', async () => {
    const owner = 'owner-rollback';
    const task = 'task-rollback-1';
    seedTerminalTask(main, task);
    const steps: Step[] = [];
    try {
      const write = await synthesize(main.baseUrl, {
        owner,
        task,
        evidence: [evidence('回滚我-EXPROLLBACK')],
      });
      expect(write.status, JSON.stringify(write.json)).toBe(200);
      const entry = writtenByLesson(write.json['report'] as Json, '回滚我-EXPROLLBACK');
      const id = String(entry['memory_id']);
      const version = entry['version'] as number;

      const beforeRollback = await lanes(main.baseUrl, owner);
      const historyBefore = countOf(beforeRollback.json, 'written') + countOf(beforeRollback.json, 'invalid');
      expect(historyBefore).toBe(1);

      const rolled = await postJson(main.baseUrl, `/api/memory/experiences/${id}/rollback`, {
        owner_id: owner,
        expected_version: version,
        reason: '做法已被取代',
      });
      steps.push([
        '回滚',
        `${rolled.status} kind=${String(rolled.json['kind'])} response.injectable_after=${String(rolled.json['injectable_after'])} response.history_preserved=${String(rolled.json['history_preserved'])}`,
      ]);
      expect(rolled.status, JSON.stringify(rolled.json)).toBe(200);
      expect(rolled.json['kind']).toBe('rolled_back');

      // —— 独立复核（不看响应里的字面量）——
      const inj = await injection(main.baseUrl, owner);
      expect(inj.json['included_ids'], '回滚后检索不再命中').not.toContain(id);
      expect(String(inj.json['digest'])).not.toContain('EXPROLLBACK');
      const afterRollback = await lanes(main.baseUrl, owner);
      const historyAfter = countOf(afterRollback.json, 'written') + countOf(afterRollback.json, 'invalid');
      expect(historyAfter, '回滚只停用不删除：条目总数不变').toBe(historyBefore);
      expect(invalidIds(afterRollback.json), '被回滚的版本落进失效泳道（历史保留）').toContain(id);
      expect(writtenIds(afterRollback.json)).not.toContain(id);
      steps.push([
        '独立复核',
        `injection.status=${String(inj.json['status'])}；历史条目 ${String(historyBefore)} → ${String(historyAfter)}；invalid=${JSON.stringify(invalidIds(afterRollback.json))}`,
      ]);

      // 反向对照 1：拿**过期版本号**回滚 ⇒ 具名拒绝（不是"随便回滚最新那条"）。
      const stale = await postJson(main.baseUrl, `/api/memory/experiences/${id}/rollback`, {
        owner_id: owner,
        expected_version: version + 9,
        reason: '版本不符',
      });
      steps.push(['反向对照：过期版本回滚', `${stale.status}/${String(stale.json['code'])}`]);
      expect(stale.status).toBeGreaterThanOrEqual(400);
      expect(stale.json['code']).toBe('version_mismatch');

      // 反向对照 2：**跨 owner** 回滚 ⇒ 404（隔离键）。
      const cross = await postJson(main.baseUrl, `/api/memory/experiences/${id}/rollback`, {
        owner_id: 'owner-someone-else',
        expected_version: version,
        reason: '别人的东西',
      });
      steps.push(['反向对照：跨 owner 回滚', `${cross.status}/${String(cross.json['code'])}`]);
      expect(cross.status).toBe(404);
      expect(cross.json['code']).toBe('owner_mismatch');
    } finally {
      logSteps('D4 回滚后不再命中 + 历史保留', steps);
    }
  });

  it('D5 反向对照：缺原因的失效 / 回滚被拒，且库不变', async () => {
    const owner = 'owner-missing-reason';
    const task = 'task-rollback-2';
    seedTerminalTask(main, task);
    const steps: Step[] = [];
    try {
      const write = await synthesize(main.baseUrl, {
        owner,
        task,
        evidence: [evidence('没有依据就不能失效')],
      });
      expect(write.status, JSON.stringify(write.json)).toBe(200);
      const id = String(writtenByLesson(write.json['report'] as Json, '没有依据就不能失效')['memory_id']);

      const before = await lanes(main.baseUrl, owner);
      const beforeFingerprint = laneFingerprint(before.json);

      // 失效缺 reason/basis/evidence_refs ⇒ 400（没有依据的失效是空口断言）。
      const badInvalidate = await postJson(main.baseUrl, `/api/memory/experiences/${id}/invalidate`, {
        owner_id: owner,
      });
      // 回滚缺 reason ⇒ 400。
      const badRollback = await postJson(main.baseUrl, `/api/memory/experiences/${id}/rollback`, {
        owner_id: owner,
        expected_version: 0,
      });
      steps.push([
        '反向对照：缺依据',
        `invalidate ${badInvalidate.status}/${String(badInvalidate.json['code'])}；rollback ${badRollback.status}/${String(badRollback.json['code'])}`,
      ]);
      expect(badInvalidate.status).toBe(400);
      expect(badInvalidate.json['code']).toBe('missing_basis');
      expect(badRollback.status).toBe(400);
      expect(badRollback.json['code']).toBe('missing_reason');

      // 库不变（被拒的操作一个字节都没写）。
      const after = await lanes(main.baseUrl, owner);
      expect(laneFingerprint(after.json)).toEqual(beforeFingerprint);
      expect((await injection(main.baseUrl, owner)).json['included_ids']).toContain(id);
      steps.push(['库不变', `指纹=${JSON.stringify(beforeFingerprint)}`]);
    } finally {
      logSteps('D5 缺依据被拒', steps);
    }
  });
});

// ===========================================================================
// E. 产品面 vs 内核面（结构判据 + 如实标注）
// ===========================================================================

describe('E. 边界如实：哪些是产品面真通、哪些仍只是内核逻辑', () => {
  it('E1 结构判据：运行期写入口已接进产品 HTTP；实例冻结绑定 / 漂移检测仍无 HTTP 入口', () => {
    const serverDir = fileURLToPath(new URL('.', import.meta.url));
    const files = readdirSync(serverDir).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));
    const sources = files.map((name) => ({
      name,
      text: readFileSync(join(serverDir, name), 'utf8'),
    }));

    // ① 运行期**写入口**确实在产品闭包里：`roles-wiring.ts` 调 `synthesizeTaskExperience(`。
    const rolesWiring = sources.find((item) => item.name === 'roles-wiring.ts');
    expect(rolesWiring, 'roles-wiring.ts 必须存在').toBeDefined();
    expect(rolesWiring?.text, '运行期写入口必须真的被角色路由调用').toContain('synthesizeTaskExperience(');
    expect(rolesWiring?.text, '触发门必须真的被复用').toContain('experienceTriggerOf');

    // ② 实例冻结绑定 / 漂移检测（`bindTaskInstanceExperience` / `verifyInstanceInjection`）
    //    在本套件边界内**除定义它的 `experience-wiring.ts` 外，没有任何 app 文件引用**
    //    ⇒ 产品 HTTP 上没有入口（若有 HTTP 处理器接线，它必须 import 这两个符号 ⇒ 本断言变红）。
    const kernelOnly = ['bindTaskInstanceExperience', 'verifyInstanceInjection'];
    const httpWiring = sources.filter((item) => item.name !== 'experience-wiring.ts');
    for (const symbol of kernelOnly) {
      const referencing = httpWiring.filter((item) => item.text.includes(symbol)).map((item) => item.name);
      expect(referencing, `${symbol} 在 app 接线层不应被引用（内核逻辑，无 HTTP 入口）`).toEqual([]);
    }
    // ③ 非空性对照：这两个符号确实存在于内核接线文件里（上面②不是"扫了个不存在的名字"）。
    const experienceWiring = readFileSync(join(serverDir, 'experience-wiring.ts'), 'utf8');
    for (const symbol of kernelOnly) {
      expect(experienceWiring, `${symbol} 必须在 experience-wiring.ts 里被定义/导出`).toContain(symbol);
    }

    // eslint-disable-next-line no-console
    console.log(
      [
        '\n[E1 产品面 / 内核面边界]',
        '  · 产品面真通（有 HTTP 入口）：终态触发门 / 证据门槛 / 候选→裁决→版本化写入（含 no_change）',
        '    / 实例召回注入 / 忘记·失效后不再注入 / 回滚（版本化，历史保留）',
        '    —— 入口：POST /api/roles/experience/synthesize、GET /api/memory/experiences、',
        '       GET /api/memory/injection、POST /api/memory/experiences/:id/{rollback,invalidate}',
        '  · 仅内核逻辑（本套件边界内无 HTTP 入口）：实例**冻结规则**绑定（bindInstanceExperience）',
        '    与漂移检测（verifyInstanceInjection / removed_since_binding）',
        '    —— 产品注入口每次从 recall 现算，结构性不会"失效后仍注入"，因此该判据没有产品面证据。',
        '  · 未接真实模型 / 未接真机：证据由请求体声明（sealed / readback_verified），本层不替宿主编造来源。',
      ].join('\n'),
    );
  });
});
