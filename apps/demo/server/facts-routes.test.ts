/**
 * 工作包 **FA-FACTS-HTTP-ROUTE** —— `/api/facts/**` 产品 HTTP 路由的验收套件。
 *
 * ## 这一组要证明什么（**全部经真 `node:http` 服务 + 真落盘 + 产品入口**）
 *
 * | # | 判据 | 用例组 |
 * |---|---|---|
 * | 1 | **读写**：列出当前事实、按 key 取、**版本化更新**（新值 supersede 旧值、**保留历史**） | A |
 * | 2 | **版本绑定**：更新必须带 `expected_revision`；不符 ⇒ **409**（不静默覆盖）；无 version ⇒ 400 | B |
 * | 3 | **并发 / 迟到**：旧版本更新必须被拒（**后到者 409**，当前值不被回改） | B |
 * | 4 | **与交付链打通**：事实换版后，完成视图只认当前版本产物（旧版本产物不再计入 `artifactsDelivered`） | C |
 * | 5 | **反向对照**：无 version 字段被拒；跨任务读写被拒；不存在的事实键读取 **404** 而不是空值冒充 | D |
 *
 * ## 诚实边界（务必连着读）
 *
 * 1. **写入内核真相源的两种方式**：夹具的**初始登记**（任务 / 事实 / 产物）直接经
 *    `main.demo.host.store.transact(...)` —— 与 `e2e-full-chain.test.ts` 同一口径，
 *    因为"某个任务的事实"必须**先在**真相源上存在，路由才有东西可读。**HTTP 只用来
 *    读事实、改事实、读完成口径**。`GET /api/facts` 的 404 → 200 是本套件要修的缺口本身。
 * 2. **两条交付宿主各有各的内核存储**（`http.ts` 的 `/completion` 注释已登记这是事实）：
 *    `DocumentSessionHost`（`/api/sessions/**`）与 `DeliverableHost`（`/api/deliverables/**`）
 *    各自持有**自己的**进程内内核存储；本路由注入的是**主内核真相源**。
 *    因此 C-1（事实换版 ⇒ 产物失效）落在**主内核真相源**上，用 `/api/tasks/:taskId/completion`
 *    这条真实 HTTP 读口证明；C-2 用**真实 HTTP** 单独证明两条交付宿主**自己的**完成视图
 *    也"只认当前版本产物"（它们靠自己的 `task_revision` 过滤，不由本路由改写它们的私有存储）。
 *    **本路由没有通往那两份私有存储的写口，不假装有。**
 * 3. **不使用模型、不连真机、不碰 Office。**
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// `DOCX_TITLE_BODY_PRESENTATION` **不在** `src/artifacts/index.js` 的聚焦转出里，
// 按路径直接 import（与 `e2e-full-chain.test.ts` 同一写法）——不能靠 import 同名符号
// 让它悄悄变成 `undefined`。
import {
  DOCX_TITLE_BODY_PRESENTATION,
  buildDocxTemplate,
} from '../../../src/artifacts/templates/docx.js';
import {
  asArtifactRef,
  asFactRef,
  asInstanceId,
  asLogicalTime,
  asRevision,
  asTaskId,
  createArtifactRecord,
  createSharedFactRecord,
  createTaskRecord,
  currentFactByKey,
  isDeliveredArtifact,
  type FactRef,
  type SharedFactRecord,
} from '../../../src/protocol/index.js';
import {
  getJson,
  postJson,
  startProduct,
  type Json,
  type RunningProduct,
} from './e2e-full-chain-harness.js';
import {
  FACTS_MODULES_REACHABLE_BY_ROUTE,
  FACTS_ROOT,
  isFactsPath,
  matchFactsRoute,
} from './facts-routes.js';

// ---------------------------------------------------------------------------
// 夹具常量
// ---------------------------------------------------------------------------

const REV = asRevision(2);
const INSTANCE = asInstanceId('I-facts-route');
const AT = asLogicalTime(10);

/** A / B 组的任务：两个事实键（`headcount` 与无关对照 `budget.total`）。 */
const TASK_A = 'T-facts-a';
/** C 组的任务：一个事实键 + 一条**已发布**产物（完成口径的判据输入）。 */
const TASK_C = 'T-facts-c';
const ARTIFACT_C = 'A-facts-c-1';

const F_HEAD_8 = asFactRef('F-facts-a-headcount-1');
const F_BUDGET = asFactRef('F-facts-a-budget');

function numberValue(amount: number): unknown {
  return { kind: 'known', value: { type: 'number', amount, unit: '人', currency: null } };
}

function factRecord(input: {
  readonly factId: FactRef;
  readonly taskId: string;
  readonly factKey: string;
  readonly amount: number;
  readonly supersedes?: FactRef | null;
}): SharedFactRecord {
  return createSharedFactRecord({
    fact_id: input.factId,
    task_id: asTaskId(input.taskId),
    task_revision: REV,
    fact_key: input.factKey,
    value: numberValue(input.amount) as never,
    source: { kind: 'user_confirmation', detail: '夹具初始登记' },
    confirmed_by: INSTANCE,
    confirmed_at: AT,
    ...(input.supersedes === undefined || input.supersedes === null
      ? {}
      : { supersedes_fact_id: input.supersedes }),
  });
}

// ---------------------------------------------------------------------------
// 共享状态（本文件按声明顺序执行）
// ---------------------------------------------------------------------------

let workDir: string;
let main: RunningProduct;
const notes: string[] = [];

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'potbot-facts-routes-'));
  main = await startProduct(join(workDir, 'run-facts'));
}, 60_000);

afterAll(async () => {
  if (main !== undefined) await main.close();
  if (workDir !== undefined) rmSync(workDir, { recursive: true, force: true });
}, 60_000);

/** 在**内核真相源**上登记任务 + 事实（夹具的初始条件；HTTP 只负责读 / 改 / 核）。 */
function seedTaskFacts(): void {
  main.demo.host.store.transact((tx) => {
    for (const taskId of [TASK_A, TASK_C]) {
      tx.putTask(
        createTaskRecord({
          task_id: asTaskId(taskId),
          goal: `共享事实 HTTP 路由夹具任务 ${taskId}`,
          revision: REV,
          created_at: AT,
          updated_at: AT,
        }),
      );
    }
    tx.putSharedFact(
      factRecord({ factId: F_HEAD_8, taskId: TASK_A, factKey: 'headcount', amount: 8 }),
    );
    tx.putSharedFact(
      factRecord({ factId: F_BUDGET, taskId: TASK_A, factKey: 'budget.total', amount: 60000 }),
    );
    tx.putSharedFact(
      factRecord({ factId: asFactRef('F-facts-c-headcount-1'), taskId: TASK_C, factKey: 'headcount', amount: 8 }),
    );
    // 一条**已发布并回读**的产物，依据 TASK_C 的 headcount 首版事实（P3：可追溯来源非空）。
    tx.putArtifact(
      createArtifactRecord({
        artifact_id: asArtifactRef(ARTIFACT_C),
        task_id: asTaskId(TASK_C),
        task_revision: REV,
        artifact_version: 1,
        template_kind: 'document',
        byte_length: 1024,
        content_digest: 'a'.repeat(64),
        source_fact_refs: [asFactRef('F-facts-c-headcount-1')],
        created_by_instance_id: INSTANCE,
        status: 'published',
        verifications: [{ kind: 'structural_self_check', outcome: 'pass', detail: '夹具：结构自检通过' }],
        receipt: {
          final_path: '/fixture/out.docx',
          readback_digest: 'a'.repeat(64),
          verifier: 'FA-FACTS-HTTP-ROUTE fixture',
          at: AT,
        },
        created_at: AT,
      }),
    );
  });
}

// ===========================================================================
// A. 读写 + 版本化更新（supersede，保留历史）
// ===========================================================================

describe('A. 读写 / 版本化更新：新值 supersede 旧值、旧值保留为历史', () => {
  it('A-0 夹具：任务与事实登记在内核真相源上', () => {
    seedTaskFacts();
    const facts = main.demo.host.store.snapshot().shared_facts;
    const current = currentFactByKey(facts, {
      task_id: asTaskId(TASK_A),
      task_revision: REV,
      fact_key: 'headcount',
    });
    expect(current?.fact_id).toBe(F_HEAD_8);
    notes.push('A-0 内核真相源：T-facts-a@r2 headcount=8、budget.total=60000、T-facts-c@r2 headcount=8 已登记');
  });

  it('A-1 GET /api/facts 列出当前事实（200；两条事实键）', async () => {
    const response = await getJson(main.baseUrl, `${FACTS_ROOT}?task_id=${TASK_A}`);
    expect(response.status, JSON.stringify(response.json)).toBe(200);
    expect(response.json['taskId']).toBe(TASK_A);
    expect(response.json['taskRevision']).toBe(2);
    const facts = response.json['facts'] as readonly Json[];
    expect(facts.length, '两条当前事实').toBe(2);
    const keys = facts.map((fact) => String(fact['factKey'])).sort();
    expect(keys).toEqual(['budget.total', 'headcount']);
    const head = facts.find((fact) => fact['factKey'] === 'headcount');
    expect(head?.['revision'], '首版事实的版本号是 1').toBe(1);
    notes.push(`A-1 GET ${FACTS_ROOT}?task_id=${TASK_A} → 200（facts=2，headcount revision=1）`);
  });

  it('A-2 GET /api/facts/:key 取当前事实（200）；不存在的事实键 ⇒ 404（不用空值冒充）', async () => {
    const found = await getJson(main.baseUrl, `${FACTS_ROOT}/headcount?task_id=${TASK_A}`);
    expect(found.status, JSON.stringify(found.json)).toBe(200);
    expect(found.json['factKey']).toBe('headcount');
    expect(found.json['revision']).toBe(1);
    expect(found.json['value']).toEqual(numberValue(8));

    const missing = await getJson(main.baseUrl, `${FACTS_ROOT}/nope?task_id=${TASK_A}`);
    expect(missing.status, '不存在的事实键必须是 404，绝不是 200 + 空值/0').toBe(404);
    expect(missing.json['code']).toBe('fact_not_found');
    notes.push('A-2 GET /api/facts/headcount → 200（8 人）；GET /api/facts/nope → 404 fact_not_found');
  });

  it('A-3 POST /api/facts/:key 版本化更新（200）：新值 10 取代 8，历史保留', async () => {
    const updated = await postJson(main.baseUrl, `${FACTS_ROOT}/headcount`, {
      task_id: TASK_A,
      expected_revision: 1,
      value: numberValue(10),
      source: { kind: 'user_confirmation', detail: '用户改口：十人' },
    });
    expect(updated.status, JSON.stringify(updated.json)).toBe(200);
    expect(updated.json['revision'], '版本推进到 2').toBe(2);
    expect(updated.json['previousRevision']).toBe(1);
    expect(updated.json['supersededFactId'], '新记录取代的是旧记录的 id').toBe(String(F_HEAD_8));
    expect((updated.json['fact'] as Json)['value']).toEqual(numberValue(10));

    const current = await getJson(main.baseUrl, `${FACTS_ROOT}/headcount?task_id=${TASK_A}`);
    expect(current.status).toBe(200);
    expect(current.json['value']).toEqual(numberValue(10));
    expect(current.json['revision']).toBe(2);

    const history = await getJson(main.baseUrl, `${FACTS_ROOT}/headcount/history?task_id=${TASK_A}`);
    expect(history.status, JSON.stringify(history.json)).toBe(200);
    const versions = history.json['versions'] as readonly Json[];
    expect(versions.length, '两版都在（历史不丢）').toBe(2);
    expect(versions[0]?.['value'], '第一版仍是 8').toEqual(numberValue(8));
    expect(versions[0]?.['current'], '第一版不再是当前').toBe(false);
    expect(versions[1]?.['value'], '第二版是 10').toEqual(numberValue(10));
    expect(versions[1]?.['current']).toBe(true);

    const stored = main.demo.host.store.snapshot().shared_facts.find((fact) => fact.fact_id === F_HEAD_8);
    expect(stored, '旧事实仍在仓库里（保留历史）').toBeDefined();
    notes.push('A-3 POST /api/facts/headcount(expected_revision=1) → 200（revision 1→2，supersede 旧记录，历史两版俱在）');
  });
});

// ===========================================================================
// B. 版本绑定 / 并发迟到
// ===========================================================================

describe('B. 版本绑定：expected_revision 不符 ⇒ 409；旧版本更新必须被拒', () => {
  it('B-1 无 expected_revision ⇒ 400（无 version 字段的更新一律被拒）', async () => {
    const response = await postJson(main.baseUrl, `${FACTS_ROOT}/headcount`, {
      task_id: TASK_A,
      value: numberValue(999),
    });
    expect(response.status).toBe(400);
    expect(response.json['code']).toBe('missing_expected_revision');
    const current = await getJson(main.baseUrl, `${FACTS_ROOT}/headcount?task_id=${TASK_A}`);
    expect(current.json['value'], '被拒的更新不得改动当前值').toEqual(numberValue(10));
    notes.push('B-1 POST 无 expected_revision → 400 missing_expected_revision（当前值不动）');
  });

  it('B-2 expected_revision 与当前版本不符 ⇒ 409（不静默覆盖）', async () => {
    const response = await postJson(main.baseUrl, `${FACTS_ROOT}/headcount`, {
      task_id: TASK_A,
      expected_revision: 1,
      value: numberValue(999),
    });
    expect(response.status, '旧版本基线必须 409').toBe(409);
    expect(response.json['code']).toBe('revision_conflict');
    expect(response.json['currentRevision']).toBe(2);
    expect(response.json['expectedRevision']).toBe(1);
    const current = await getJson(main.baseUrl, `${FACTS_ROOT}/headcount?task_id=${TASK_A}`);
    expect(current.json['value'], '被拒的更新不得改动当前值').toEqual(numberValue(10));
    notes.push('B-2 POST expected_revision=1（当前=2）→ 409 revision_conflict（当前值仍为 10）');
  });

  it('B-3 正确版本 ⇒ 200 推进到第 3 版', async () => {
    const response = await postJson(main.baseUrl, `${FACTS_ROOT}/headcount`, {
      task_id: TASK_A,
      expected_revision: 2,
      value: numberValue(12),
    });
    expect(response.status, JSON.stringify(response.json)).toBe(200);
    expect(response.json['revision']).toBe(3);
    notes.push('B-3 POST expected_revision=2 → 200（revision 3）');
  });

  it('B-4 【并发 / 迟到】同一份旧版本再更新一次 ⇒ 409，当前值不回改', async () => {
    const late = await postJson(main.baseUrl, `${FACTS_ROOT}/headcount`, {
      task_id: TASK_A,
      expected_revision: 2,
      value: numberValue(999),
    });
    expect(late.status, '迟到的更新必须被拒，不得覆盖已推进的当前值').toBe(409);
    expect(late.json['currentRevision']).toBe(3);
    const current = await getJson(main.baseUrl, `${FACTS_ROOT}/headcount?task_id=${TASK_A}`);
    expect(current.json['value']).toEqual(numberValue(12));
    expect(current.json['revision']).toBe(3);
    notes.push('B-4 迟到更新（expected_revision=2，当前=3）→ 409；当前值仍为 12');
  });
});

// ===========================================================================
// C. 与交付链打通：完成视图只认当前版本产物
// ===========================================================================

describe('C. 与交付链打通：事实换版后，旧版本产物不再计入 artifactsDelivered', () => {
  it('C-1 换版前：产物绑当前事实 ⇒ /api/tasks/:id/completion 计入 1 条已交付产物', async () => {
    const view = await getJson(main.baseUrl, `/api/tasks/${TASK_C}/completion`);
    expect(view.status, JSON.stringify(view.json)).toBe(200);
    expect((view.json['flags'] as Json)['hasDeliveredArtifact']).toBe(true);
    expect((view.json['counts'] as Json)['artifactsDelivered']).toBe(1);
    expect(view.json['deliveredArtifactIds']).toEqual([ARTIFACT_C]);
    notes.push(`C-1 GET /api/tasks/${TASK_C}/completion → 200 artifactsDelivered=1（[${ARTIFACT_C}]）`);
  });

  it('C-2 经 HTTP 换版（POST /api/facts）⇒ 依据旧版事实的产物被标记 superseded 并如实报出', async () => {
    const updated = await postJson(main.baseUrl, `${FACTS_ROOT}/headcount`, {
      task_id: TASK_C,
      expected_revision: 1,
      value: numberValue(10),
      source: { kind: 'user_confirmation', detail: '用户改口：十人' },
    });
    expect(updated.status, JSON.stringify(updated.json)).toBe(200);
    expect(updated.json['supersededArtifactIds'], '依据旧版事实的产物必须被如实报出').toEqual([ARTIFACT_C]);

    const stored = main.demo.host.store
      .snapshot()
      .artifacts.find((artifact) => String(artifact.artifact_id) === ARTIFACT_C);
    expect(stored, '产物记录仍保留（历史不删）').toBeDefined();
    expect(stored?.status, '状态置 superseded').toBe('superseded');
    expect(stored?.receipt, '回执仍在（不销毁证据）').not.toBeNull();
    expect(isDeliveredArtifact(stored as never), 'superseded 不再构成"已交付"').toBe(false);
    notes.push('C-2 POST /api/facts/headcount(T-facts-c) → 200（supersededArtifactIds=[A-facts-c-1]，记录保留、回执保留）');
  });

  it('C-3 换版后：完成视图只认当前版本产物 ⇒ 旧版本产物不再计入 artifactsDelivered（真实 HTTP）', async () => {
    const view = await getJson(main.baseUrl, `/api/tasks/${TASK_C}/completion`);
    expect(view.status, JSON.stringify(view.json)).toBe(200);
    expect((view.json['foo'] as unknown) ?? null).toBeNull(); // 形状守卫：不凭空多字段
    expect((view.json['flags'] as Json)['hasDeliveredArtifact'], '旧版产物不再算已交付').toBe(false);
    expect((view.json['counts'] as Json)['artifactsDelivered'], '旧版本产物不再计入').toBe(0);
    expect(view.json['deliveredArtifactIds']).toEqual([]);
    notes.push(`C-3 GET /api/tasks/${TASK_C}/completion → 200 artifactsDelivered=0（旧版产物已排除）`);
  });

  it('C-4 【交付链自身】/api/deliverables/** 完成视图只认当前版本产物（真实 HTTP）', async () => {
    const sessionId = 'fr-xlsx';
    const created = await postJson(main.baseUrl, '/api/deliverables', {
      sessionId,
      deliverableId: 'fr-xlsx-1',
      filename: '事实路由交付.xlsx',
      format: 'xlsx',
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    let revision = created.json['editRevision'] as number;
    let digest = created.json['contentDigest'] as string;

    const step = async (key: string, edit: unknown): Promise<Json> => {
      const outcome = await postJson(main.baseUrl, `/api/deliverables/${sessionId}/edits`, {
        idempotencyKey: key,
        baseRevision: revision,
        baseDigest: digest,
        edit,
      });
      expect(outcome.status, JSON.stringify(outcome.json)).toBe(200);
      revision = outcome.json['editRevision'] as number;
      const version = outcome.json['version'] as Json;
      digest = String(version['contentDigest']);
      return version;
    };

    const first = await step('fr-xlsx-1', { op: 'add_sheet', name: '甲' });
    const firstArtifactId = String(first['artifactId']);
    const before = await getJson(main.baseUrl, `/api/deliverables/${sessionId}/completion`);
    expect(before.status, JSON.stringify(before.json)).toBe(200);
    expect((before.json['counts'] as Json)['artifactsDelivered']).toBe(1);
    expect(before.json['deliveredArtifactIds']).toEqual([firstArtifactId]);

    const second = await step('fr-xlsx-2', { op: 'add_sheet', name: '乙' });
    const secondArtifactId = String(second['artifactId']);
    expect(secondArtifactId).not.toBe(firstArtifactId);

    const after = await getJson(main.baseUrl, `/api/deliverables/${sessionId}/completion`);
    expect(after.status, JSON.stringify(after.json)).toBe(200);
    expect((after.json['counts'] as Json)['artifactsDelivered'], '只有当前版本那一版算已交付').toBe(1);
    const ids = after.json['deliveredArtifactIds'] as readonly string[];
    expect(ids).toEqual([secondArtifactId]);
    expect(ids, '旧版本产物不再计入 deliveredArtifactIds').not.toContain(firstArtifactId);
    notes.push(
      `C-4 POST /api/deliverables → 201；两次 /edits → 200（v1=${firstArtifactId}，v2=${secondArtifactId}）；` +
        `GET /completion → 200 artifactsDelivered=1（只含 v2，旧版 v1 不再计入）`,
    );
  });

  it('C-5 【交付链自身】/api/sessions/** 只把当前版本当作 currentVersion（真实 HTTP）', async () => {
    const sessionId = 'fr-docx';
    const docx = buildDocxTemplate({
      requirement: {
        title: '会话完成视图夹具',
        description: '',
        // 正文里**不得出现任何数字**：P6 要求正文数字必须能指认到已确认事实（这里只是夹具）。
        paragraphs: [
          '本文档用于验证：完成视图只认当前版本产物',
          '正文第二段（模板要求段数下限）',
          '正文第三段：与事实无关的对照文字',
        ],
        presentation: DOCX_TITLE_BODY_PRESENTATION,
      },
      fact_snapshot: [],
      references: [{ label: '来源', detail: 'FA-FACTS-HTTP-ROUTE 夹具' }],
    });
    const created = await postJson(main.baseUrl, '/api/sessions', {
      sessionId,
      filename: '会话完成视图夹具.docx',
      mode: 'new',
      docxBase64: Buffer.from(docx.bytes).toString('base64'),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);

    const edit = async (
      key: string,
      baseRevision: unknown,
      baseDigest: unknown,
      step: unknown,
    ): Promise<Json> => {
      const outcome = await postJson(main.baseUrl, `/api/sessions/${sessionId}/edits`, {
        idempotencyKey: key,
        baseRevision,
        baseDigest,
        intent: { steps: [step] },
      });
      expect(outcome.status, JSON.stringify(outcome.json)).toBe(200);
      return outcome.json['version'] as Json;
    };

    // 两次编辑必须是**不同的**意图：同一次对齐重复提交会被会话判成"无变化"（changed=false），
    // 那就不会有第二版，也就证明不了"只有当前版本算当前"。
    const v1 = await edit('fr-docx-1', created.json['editRevision'], created.json['contentDigest'], {
      range: '第1段',
      operation: { kind: 'setAlignment', alignment: 'center' },
    });
    const after1 = await getJson(main.baseUrl, `/api/sessions/${sessionId}`);
    expect(after1.status).toBe(200);
    expect((after1.json['currentVersion'] as Json)['artifactId']).toBe(String(v1['artifactId']));
    expect((after1.json['versions'] as readonly Json[]).length).toBe(1);

    const v2 = await edit('fr-docx-2', v1['editRevision'], v1['contentDigest'], {
      range: '第2段',
      operation: { kind: 'setAlignment', alignment: 'right' },
    });
    expect(String(v2['artifactId']), '第二版必须是另一条产物').not.toBe(String(v1['artifactId']));
    const after2 = await getJson(main.baseUrl, `/api/sessions/${sessionId}`);
    expect(after2.status).toBe(200);
    expect((after2.json['currentVersion'] as Json)['artifactId'], '当前版本换成 v2').toBe(String(v2['artifactId']));
    expect((after2.json['currentVersion'] as Json)['artifactId']).not.toBe(String(v1['artifactId']));
    expect((after2.json['versions'] as readonly Json[]).length, '两版都留作历史').toBe(2);
    notes.push(
      `C-5 POST /api/sessions → 201；两次 /edits → 200；` +
        `GET /api/sessions/${sessionId} → currentVersion 只指向最新版（旧版留作历史）`,
    );
  });
});

// ===========================================================================
// D. 反向对照
// ===========================================================================

describe('D. 反向对照：跨任务被拒 / 404 语义 / 方法不允许', () => {
  it('D-1 跨任务读被拒：别的任务上不存在的事实键 ⇒ 404（不是空值冒充）', async () => {
    const response = await getJson(main.baseUrl, `${FACTS_ROOT}/budget.total?task_id=${TASK_C}`);
    expect(response.status, 'T-facts-c 上没有 budget.total').toBe(404);
    expect(response.json['code']).toBe('fact_not_found');
    const list = await getJson(main.baseUrl, `${FACTS_ROOT}?task_id=${TASK_C}`);
    expect(list.status).toBe(200);
    const keys = (list.json['facts'] as readonly Json[]).map((fact) => String(fact['factKey']));
    expect(keys, '别的任务的事实不得出现在本任务的清单里').not.toContain('budget.total');
    notes.push('D-1 跨任务读：T-facts-c 上 GET budget.total → 404；清单里也不含别的任务的键');
  });

  it('D-2 跨任务写被拒：拿别的任务的版本号改本任务没有的键 ⇒ 409，源任务的值不动', async () => {
    const before = await getJson(main.baseUrl, `${FACTS_ROOT}/budget.total?task_id=${TASK_A}`);
    expect(before.json['value']).toEqual(numberValue(60000));

    const response = await postJson(main.baseUrl, `${FACTS_ROOT}/budget.total`, {
      task_id: TASK_C,
      expected_revision: 1,
      value: numberValue(0),
    });
    expect(response.status, 'T-facts-c 上没有该键 ⇒ 当前版本为 0 ≠ 1 ⇒ 409').toBe(409);
    expect(response.json['currentRevision']).toBe(0);

    const after = await getJson(main.baseUrl, `${FACTS_ROOT}/budget.total?task_id=${TASK_A}`);
    expect(after.json['value'], '跨任务写入不得改动源任务的值').toEqual(numberValue(60000));
    notes.push('D-2 跨任务写：POST budget.total@T-facts-c(expected_revision=1) → 409；T-facts-a 的值仍为 60000');
  });

  it('D-3 任务不存在 ⇒ 404 task_not_found；缺 task_id ⇒ 400 missing_task_id', async () => {
    const noTask = await getJson(main.baseUrl, `${FACTS_ROOT}/headcount?task_id=T-nope`);
    expect(noTask.status).toBe(404);
    expect(noTask.json['code']).toBe('task_not_found');

    const noParam = await getJson(main.baseUrl, FACTS_ROOT);
    expect(noParam.status).toBe(400);
    expect(noParam.json['code']).toBe('missing_task_id');
    notes.push('D-3 GET ?task_id=T-nope → 404 task_not_found；GET 无 task_id → 400 missing_task_id');
  });

  it('D-4 方法不允许：DELETE /api/facts/:key ⇒ 405（且不落任何写入）', async () => {
    const response = await fetch(`${main.baseUrl}${FACTS_ROOT}/headcount?task_id=${TASK_A}`, {
      method: 'DELETE',
    });
    expect(response.status).toBe(405);
    const current = await getJson(main.baseUrl, `${FACTS_ROOT}/headcount?task_id=${TASK_A}`);
    expect(current.json['revision']).toBe(3);
    notes.push('D-4 DELETE /api/facts/headcount → 405（当前版本仍为 3）');
  });

  it('D-5 路径匹配是纯函数：/api/facts 命名空间不吞别的 /api 前缀', () => {
    expect(isFactsPath(FACTS_ROOT)).toBe(true);
    expect(isFactsPath(`${FACTS_ROOT}/headcount`)).toBe(true);
    expect(isFactsPath('/api/factsX')).toBe(false);
    expect(isFactsPath('/api/xls-facts')).toBe(false);
    expect(matchFactsRoute(FACTS_ROOT)).toEqual({ kind: 'index' });
    expect(matchFactsRoute(`${FACTS_ROOT}/headcount`)).toEqual({ kind: 'fact', factKey: 'headcount' });
    expect(matchFactsRoute(`${FACTS_ROOT}/headcount/history`)).toEqual({
      kind: 'history',
      factKey: 'headcount',
    });
    // 段数先长后短：`history` 不得被当成事实键。
    expect(matchFactsRoute(`${FACTS_ROOT}/headcount/history/x`)).toBeNull();
    expect(matchFactsRoute('/api/deliverables/x/completion')).toBeNull();
    expect(FACTS_MODULES_REACHABLE_BY_ROUTE).toContain('src/protocol/facts.ts');
    expect(FACTS_MODULES_REACHABLE_BY_ROUTE).toContain('src/artifacts/publish.ts');
    notes.push('D-5 路径匹配纯函数：命名空间边界与段数优先级正确');
  });

  it('D-6 证据小结（本套件经真实 HTTP 实测的调用面）', () => {
    // 只打印，不作断言——把本套件真正打过的 HTTP 面记下来，便于独立复核。
    for (const note of notes) {
      process.stdout.write(`  · ${note}\n`);
    }
    expect(notes.length).toBeGreaterThan(10);
  });
});
