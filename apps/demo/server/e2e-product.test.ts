/**
 * 工作包 **FA-E2E-PRODUCT** —— 在**产品 HTTP 路径**上做三格式端到端。
 *
 * ## 这一组用例要证明什么（全部经真实 `node:http` 服务 + 真实落盘 store）
 *
 * | # | 判据 | 用例组 |
 * |---|---|---|
 * | 1 | DOCX / XLSX / PPTX **各自**经产品入口交付，下载字节由**自带独立 ZIP 解析器**读回，**格式互不冒充** | A |
 * | 2 | 交付成功后 `task-completion` 报**完成且成功**，且产物**绑当前版本**（旧版产物不计入） | B-1 |
 * | 3 | **被拒的编辑**让完成视图**不报"已完成且成功"**（S-1026-01 的最小复现在真实 HTTP 上跑出来） | B-2 |
 * | 4 | 空工作集 + 历史产物**不得**推出成功（S-1026-01 的字面复现，经 `/api/tasks/:id/completion`） | B-3 |
 * | 5 | 适配器动作经 `/api/adapters/actions/**` 进内核 `Store.actions`；**无可信回执不得 `confirmed_complete`**（409），可信回执才 200；该动作**能在完成视图里被读到** | C |
 * | 6 | 重启（新 store 实例、同一运行目录）后**动作与任务仍可读**；换独立运行目录**读不到** | D |
 *
 * ## 为什么三条路径各自不同（不是"同一条链换个后缀"）
 *
 * - **DOCX** 走 `/api/sessions/**`（字处理链：段落 / 节 / 列表语义）；
 * - **XLSX / PPTX** 走 `/api/deliverables/**`（交付链：表格 / 演示），
 *   两者都是**生产入口**、都经内核发布链，但入口与编辑语义不同——所以三格式各自跑一遍。
 *
 * ## 独立证据与边界（如实登记）
 *
 * - ZIP 解析器见 `e2e-product-harness.ts`：**只读中央目录**，不复用内核自检器
 *   （否则"自检器分不清格式"会同时污染被测对象与量尺）。
 * - MIME 断言用**硬编码官方字面量**，不从产品映射表读——避免"用产品的话证明产品"。
 * - 本套件**不含**真机 / 消费端（手机、Word、Excel、PowerPoint）打开验证：
 *   "文件能被目标软件打开"是第三层证据，本轮未做。
 * - 服务由产品入口 `createDemoServer` 组装（真 Host + 真 FileStore 落盘），
 *   仅把任务行 / 产物行**作为夹具**注入 store（与既有 `adapters-actions.test.ts` 的 `seedTask` 同一手法）。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildDocxTemplate, DOCX_TITLE_BODY_PRESENTATION } from '../../../src/artifacts/templates/docx.js';
import {
  asArtifactRef,
  asFactRef,
  asInstanceId,
  asLogicalTime,
  asRevision,
  asTaskId,
  createArtifactRecord,
  createTaskRecord,
} from '../../../src/protocol/index.js';
import {
  getBytes,
  getJson,
  postJson,
  startProduct,
  zipEntryNames,
  type Json,
  type RunningProduct,
} from './e2e-product-harness.js';

// ---------------------------------------------------------------------------
// 期望常量（硬编码官方字面量：不从产品映射表读，避免"用产品的话证明产品"）
// ---------------------------------------------------------------------------

/** 三种办公格式的**官方 MIME**（ECMA-376 / ISO 29500 的注册类型）。 */
const OFFICIAL_MIME = Object.freeze({
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
});

/** 三种格式的**主部件**（包内路径）。三者互斥是"格式互不冒充"的结构判据。 */
const MAIN_PART = Object.freeze({
  docx: 'word/document.xml',
  xlsx: 'xl/workbook.xml',
  pptx: 'ppt/presentation.xml',
});

/** 某格式的包**不得**含有另外两个格式的主部件。 */
function expectFormatExclusive(entryNames: readonly string[], format: 'docx' | 'xlsx' | 'pptx'): void {
  // 先证明解析器**真的读到了结构**（不是"解出空表所以什么都 not.toContain"）：
  // OOXML 包必有 `[Content_Types].xml` 与包级关系 `_rels/.rels`。
  expect(entryNames, 'OOXML 包必有 [Content_Types].xml').toContain('[Content_Types].xml');
  expect(entryNames, 'OOXML 包必有包级关系 _rels/.rels').toContain('_rels/.rels');
  expect(entryNames.length, '包内部件数应远多于 1').toBeGreaterThan(1);
  expect(entryNames, `${format} 包内应有主部件 ${MAIN_PART[format]}`).toContain(MAIN_PART[format]);
  for (const other of ['docx', 'xlsx', 'pptx'] as const) {
    if (other === format) continue;
    expect(
      entryNames,
      `${format} 包里不得出现 ${other} 的主部件 ${MAIN_PART[other]}（格式互不冒充）`,
    ).not.toContain(MAIN_PART[other]);
  }
}

/** 会话 DOCX 夹具（与既有 HTTP 会话测试同源：三段正文，供 `第2段` 意图定位）。 */
function fixtureDocx(): Uint8Array {
  // 标题 / 正文一律**不含数字**：`buildDocxTemplate` 的 P6 检查要求正文里的数字都能指认到
  // 一条已确认事实（"不得在正文里现编"），夹具不带事实快照，所以正文里不能出现数字。
  return buildDocxTemplate({
    requirement: {
      title: '端到端产品文档',
      description: '',
      paragraphs: ['第一段内容', '第二段内容', '第三段内容'],
      presentation: DOCX_TITLE_BODY_PRESENTATION,
    },
    fact_snapshot: [],
    references: [{ label: '来源', detail: '端到端产品测试夹具' }],
  }).bytes;
}

function seedTask(running: RunningProduct, taskId: string, revision: number): void {
  running.demo.host.store.transact((tx) => {
    tx.putTask(
      createTaskRecord({
        task_id: asTaskId(taskId),
        goal: 'FA-E2E-PRODUCT 夹具任务',
        created_at: asLogicalTime(0),
        revision: asRevision(revision),
      }),
    );
  });
}

// ---------------------------------------------------------------------------
// 主套件：一个产品服务（组 A/B/C 共用）
// ---------------------------------------------------------------------------

let workDir: string;
let main: RunningProduct;

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'potbot-e2e-product-'));
  main = await startProduct(join(workDir, 'run-main'));
}, 60_000);

afterAll(async () => {
  await main.close();
  rmSync(workDir, { recursive: true, force: true });
});

// ===========================================================================
// A. 三种格式各自交付（下载字节由独立 ZIP 解析器读回）
// ===========================================================================

describe('A. 三种格式各自经产品入口交付，且格式互不冒充', () => {
  it('DOCX：经 /api/sessions 交付，包内是 word/document.xml（无表格 / 演示主部件）', async () => {
    const created = await postJson(main.baseUrl, '/api/sessions', {
      sessionId: 'e2e-docx',
      filename: '报告.docx',
      mode: 'new',
      docxBase64: Buffer.from(fixtureDocx()).toString('base64'),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);

    const edit = await postJson(main.baseUrl, '/api/sessions/e2e-docx/edits', {
      idempotencyKey: 'docx-1',
      baseRevision: created.json['editRevision'],
      baseDigest: created.json['contentDigest'],
      intent: {
        steps: [{ range: '第2段', operation: { kind: 'setAlignment', alignment: 'center' } }],
      },
    });
    expect(edit.status, JSON.stringify(edit.json)).toBe(200);
    const version = edit.json['version'] as Json;
    expect(version['editRevision']).toBe(1);

    const download = await getBytes(main.baseUrl, '/api/sessions/e2e-docx/versions/1/download');
    expect(download.status).toBe(200);
    expect(download.contentType).toBe(OFFICIAL_MIME.docx);
    expectFormatExclusive(zipEntryNames(download.bytes), 'docx');
  });

  it('XLSX：经 /api/deliverables 交付，包内是 xl/workbook.xml（无文档 / 演示主部件）', async () => {
    const created = await postJson(main.baseUrl, '/api/deliverables', {
      sessionId: 'e2e-xlsx',
      deliverableId: 'd-xlsx',
      filename: '台账.xlsx',
      format: 'xlsx',
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    expect(created.json['templateKind']).toBe('spreadsheet');

    const edit = await postJson(main.baseUrl, '/api/deliverables/e2e-xlsx/edits', {
      idempotencyKey: 'xlsx-1',
      baseRevision: created.json['editRevision'],
      baseDigest: created.json['contentDigest'],
      edit: { op: 'add_sheet', name: '明细' },
    });
    expect(edit.status, JSON.stringify(edit.json)).toBe(200);
    const version = edit.json['version'] as Json;
    expect(version['mimeType']).toBe(OFFICIAL_MIME.xlsx);
    expect(version['fileFormat']).toBe('xlsx');

    const download = await getBytes(main.baseUrl, '/api/deliverables/e2e-xlsx/versions/1/download');
    expect(download.status).toBe(200);
    expect(download.contentType).toBe(OFFICIAL_MIME.xlsx);
    expectFormatExclusive(zipEntryNames(download.bytes), 'xlsx');
  });

  it('PPTX：经 /api/deliverables 交付，包内是 ppt/presentation.xml（无文档 / 表格主部件）', async () => {
    const created = await postJson(main.baseUrl, '/api/deliverables', {
      sessionId: 'e2e-pptx',
      deliverableId: 'd-pptx',
      filename: '汇报.pptx',
      format: 'pptx',
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    expect(created.json['templateKind']).toBe('presentation');

    const edit = await postJson(main.baseUrl, '/api/deliverables/e2e-pptx/edits', {
      idempotencyKey: 'pptx-1',
      baseRevision: created.json['editRevision'],
      baseDigest: created.json['contentDigest'],
      edit: { op: 'add_slide', title: '封面' },
    });
    expect(edit.status, JSON.stringify(edit.json)).toBe(200);
    const version = edit.json['version'] as Json;
    expect(version['mimeType']).toBe(OFFICIAL_MIME.pptx);
    expect(version['fileFormat']).toBe('pptx');

    const download = await getBytes(main.baseUrl, '/api/deliverables/e2e-pptx/versions/1/download');
    expect(download.status).toBe(200);
    expect(download.contentType).toBe(OFFICIAL_MIME.pptx);
    expectFormatExclusive(zipEntryNames(download.bytes), 'pptx');
  });

  it('三种格式的下载字节**两两不同**（不是同一份字节换个名字）', async () => {
    const docx = await getBytes(main.baseUrl, '/api/sessions/e2e-docx/versions/1/download');
    const xlsx = await getBytes(main.baseUrl, '/api/deliverables/e2e-xlsx/versions/1/download');
    const pptx = await getBytes(main.baseUrl, '/api/deliverables/e2e-pptx/versions/1/download');
    const { createHash } = await import('node:crypto');
    const digestOf = (bytes: Uint8Array): string =>
      createHash('sha256').update(bytes).digest('hex');
    const digests = new Set([digestOf(docx.bytes), digestOf(xlsx.bytes), digestOf(pptx.bytes)]);
    expect(digests.size, '三份字节的摘要必须互不相同').toBe(3);
  });
});

// ===========================================================================
// B. 完成口径
// ===========================================================================

describe('B. 完成口径（task-completion 经 HTTP 派生）', () => {
  it('B-1 交付成功后报"已完成且成功"，且产物**绑当前版本**（旧版产物不计入）', async () => {
    const created = await postJson(main.baseUrl, '/api/deliverables', {
      sessionId: 'e2e-complete',
      deliverableId: 'd-complete',
      filename: '完成口径.xlsx',
      format: 'xlsx',
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    let revision = created.json['editRevision'] as number;
    let digest = created.json['contentDigest'] as string;

    // 第一版：加一张表。
    const first = await postJson(main.baseUrl, '/api/deliverables/e2e-complete/edits', {
      idempotencyKey: 'complete-1',
      baseRevision: revision,
      baseDigest: digest,
      edit: { op: 'add_sheet', name: '明细' },
    });
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    const firstVersion = first.json['version'] as Json;
    revision = first.json['editRevision'] as number;
    digest = firstVersion['contentDigest'] as string;

    // 第二版：写一个单元格。
    const second = await postJson(main.baseUrl, '/api/deliverables/e2e-complete/edits', {
      idempotencyKey: 'complete-2',
      baseRevision: revision,
      baseDigest: digest,
      edit: {
        op: 'set_cell',
        sheet: 'Sheet1',
        address: 'A1',
        value: { kind: 'text', value: '项目' },
      },
    });
    expect(second.status, JSON.stringify(second.json)).toBe(200);
    const secondVersion = second.json['version'] as Json;
    expect(secondVersion['artifactId']).not.toBe(firstVersion['artifactId']);

    const completion = await getJson(main.baseUrl, '/api/deliverables/e2e-complete/completion');
    expect(completion.status).toBe(200);
    const view = completion.json;
    expect(view['completed']).toBe(true);
    expect(view['label']).toBe('completed_and_successful');
    expect(view['labelText']).toBe('已完成且成功');

    const counts = view['counts'] as Json;
    // 两版产物都在内核里，但**只有当前版本那一版**算"已交付"（R264 第 2 条）。
    expect(counts['artifacts']).toBe(2);
    expect(counts['artifactsDelivered']).toBe(1);
    expect(view['deliveredArtifactIds']).toEqual([secondVersion['artifactId']]);
    expect(view['deliveredArtifactIds']).not.toContain(firstVersion['artifactId']);
  });

  it('B-2 S-1026-01：**被拒的编辑**让完成视图不报"已完成且成功"（真实 HTTP 复现）', async () => {
    const created = await postJson(main.baseUrl, '/api/deliverables', {
      sessionId: 'e2e-reject',
      deliverableId: 'd-reject',
      filename: '被拒编辑.xlsx',
      format: 'xlsx',
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const baseRevision = created.json['editRevision'] as number;
    const baseDigest = created.json['contentDigest'] as string;

    // 一次**成功**的交付（留下历史产物与一条已完成工作项）。
    const ok = await postJson(main.baseUrl, '/api/deliverables/e2e-reject/edits', {
      idempotencyKey: 'reject-ok',
      baseRevision,
      baseDigest,
      edit: { op: 'add_sheet', name: '甲' },
    });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);

    // 一次**被拒**的编辑：基线版本过期 ⇒ 409（内核不产出新版本）。
    const rejected = await postJson(main.baseUrl, '/api/deliverables/e2e-reject/edits', {
      idempotencyKey: 'reject-bad',
      baseRevision,
      baseDigest,
      edit: { op: 'add_sheet', name: '乙' },
    });
    expect(rejected.status).toBe(409);

    const completion = await getJson(main.baseUrl, '/api/deliverables/e2e-reject/completion');
    expect(completion.status).toBe(200);
    const view = completion.json;
    // 历史产物仍在（对照：不是"没有产物所以不成功"）。
    expect((view['flags'] as Json)['hasDeliveredArtifact']).toBe(true);
    // 但被拒的编辑**必须**让成功结论落空。
    expect(view['label'], '被拒的编辑不得推出"已完成且成功"').not.toBe('completed_and_successful');
    expect(view['label']).toBe('completed_with_unfinished_business');
    expect((view['flags'] as Json)['anyWorkItemFailed']).toBe(true);
    expect((view['counts'] as Json)['workItems']).toBe(2);
  });

  it('B-3 S-1026-01 字面复现：空工作集 + 历史产物 ⇒ 经 /api/tasks/:id/completion **不报成功**', async () => {
    const taskId = 'task-s1026-01';
    // 夹具：任务 + 一条**已发布**产物，**没有任何工作项 / 轮次 / 动作**。
    // 这正是 S-1026-01 的最小复现形状（旧实现会因 `[].every(...) === true` 误报成功）。
    main.demo.host.store.transact((tx) => {
      tx.putTask(
        createTaskRecord({
          task_id: asTaskId(taskId),
          goal: 'S-1026-01 空工作集复现任务',
          created_at: asLogicalTime(0),
          revision: asRevision(2),
        }),
      );
      tx.putArtifact(
        createArtifactRecord({
          artifact_id: asArtifactRef('A-s1026-01'),
          task_id: asTaskId(taskId),
          task_revision: asRevision(2),
          artifact_version: 1,
          template_kind: 'spreadsheet',
          byte_length: 4,
          content_digest: 'f'.repeat(64),
          source_fact_refs: [asFactRef('fact-s1026-01')],
          created_by_instance_id: asInstanceId('I-s1026-01'),
          status: 'published',
          // P1：已发布产物必须有至少一条交付前检查结果（"不得生成即交付"）。
          verifications: [
            { kind: 'version_match', outcome: 'pass', detail: 'S-1026-01 复现夹具（版本一致）' },
          ],
          receipt: {
            final_path: '/tmp/fixture.xlsx',
            readback_digest: 'f'.repeat(64),
            verifier: 'fa-e2e-product fixture',
            at: asLogicalTime(0),
          },
          created_at: asLogicalTime(0),
        }),
      );
    });

    const completion = await getJson(main.baseUrl, `/api/tasks/${taskId}/completion`);
    expect(completion.status).toBe(200);
    const view = completion.json;
    // 历史产物确实在（否则这条复现会被弱化成"本来就没产物"）。
    expect((view['flags'] as Json)['hasDeliveredArtifact']).toBe(true);
    expect((view['counts'] as Json)['artifactsDelivered']).toBe(1);
    // 但空工作集**不得**被当作"全部终态"。
    expect((view['predicates'] as Json)['allWorkItemsTerminal']).toBe(false);
    expect(view['completed']).toBe(false);
    expect(view['label']).not.toBe('completed_and_successful');
    expect(view['label']).toBe('not_completed');
  });
});

// ===========================================================================
// C. 适配器动作（进内核 Store.actions，并被完成视图读到）
// ===========================================================================

describe('C. 适配器动作经持久入口进内核账本，并被完成视图读到', () => {
  const TASK_ID = 'task-e2e-actions';

  it('建动作 → 无可信回执的 confirmed_complete 被拒（409）→ 可信回执才 200；全程可在完成视图读到', async () => {
    seedTask(main, TASK_ID, 1);

    const created = await postJson(main.baseUrl, '/api/adapters/actions', {
      tool: 'clock',
      actionKind: 'alarm.create',
      taskId: TASK_ID,
      taskRevision: 1,
      params: { hour: 7, minute: 30, label: '起床' },
      authorization: { source: 'user_bubble', userApproved: true },
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const actionId = (created.json['action'] as Json)['action_id'] as string;
    expect(actionId).toBeTruthy();

    // 未决动作必须在完成视图里看得见（证明完成视图读的是**内核 Store.actions**）。
    const whilePending = await getJson(main.baseUrl, `/api/tasks/${TASK_ID}/completion`);
    expect(whilePending.status).toBe(200);
    expect((whilePending.json['counts'] as Json)['actions']).toBe(1);
    expect((whilePending.json['predicates'] as Json)['noUnresolvedActions']).toBe(false);
    expect(whilePending.json['unresolvedActionIds']).toContain(actionId);

    // 先推进到已提交（`prepared → confirmed_complete` 不在转换表里）。
    const submitted = await postJson(
      main.baseUrl,
      `/api/adapters/actions/${actionId}/transition`,
      { to: 'submitted' },
    );
    expect(submitted.status).toBe(200);

    // **无可信回执**不得转 `confirmed_complete`。
    const noReceipt = await postJson(
      main.baseUrl,
      `/api/adapters/actions/${actionId}/transition`,
      { to: 'confirmed_complete' },
    );
    expect(noReceipt.status).toBe(409);
    expect(noReceipt.json['code']).toBe('missing_trusted_receipt');

    // **不可信**回执同样拒（R245）。
    const fakeReceipt = await postJson(
      main.baseUrl,
      `/api/adapters/actions/${actionId}/transition`,
      {
        to: 'confirmed_complete',
        receipt: { trusted: false, source: 'external_page', detail: '页面显示已完成' },
      },
    );
    expect(fakeReceipt.status).toBe(409);
    expect(fakeReceipt.json['code']).toBe('missing_trusted_receipt');

    // 回执被拒之后，动作仍未决（完成视图如实）。
    const stillPending = await getJson(main.baseUrl, `/api/tasks/${TASK_ID}/completion`);
    expect((stillPending.json['predicates'] as Json)['noUnresolvedActions']).toBe(false);

    // **可信回执**才允许确认完成。FA-TRUSTED-RECEIPT：可信性只能由服务端受控执行器建立，
    // 先 `…/execute` 拿执行器签发的令牌，再用令牌确认（客户端自报 trusted 一律不生效）。
    const executed = await postJson(
      main.baseUrl,
      `/api/adapters/actions/${actionId}/execute`,
      {},
    );
    expect(executed.status, JSON.stringify(executed.json)).toBe(200);
    const done = await postJson(
      main.baseUrl,
      `/api/adapters/actions/${actionId}/transition`,
      {
        to: 'confirmed_complete',
        receiptToken: executed.json['receiptToken'],
      },
    );
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect((done.json['action'] as Json)['state']).toBe('confirmed_complete');

    // 终态动作仍在完成视图里被读到（计数不归零 = 不是"内存里记了一笔"）。
    const settled = await getJson(main.baseUrl, `/api/tasks/${TASK_ID}/completion`);
    expect((settled.json['counts'] as Json)['actions']).toBe(1);
    expect((settled.json['predicates'] as Json)['noUnresolvedActions']).toBe(true);
    expect(settled.json['unresolvedActionIds']).toEqual([]);
  });
});

// ===========================================================================
// D. 重启（新 store 实例、同一运行目录）
// ===========================================================================

describe('D. 重启后动作与任务仍可读；换独立运行目录读不到', () => {
  it('同一运行目录：新 store 实例仍读得到动作与任务；独立目录 404', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'potbot-e2e-restart-'));
    const otherDir = mkdtempSync(join(tmpdir(), 'potbot-e2e-other-'));
    const TASK_ID = 'task-e2e-restart';
    let actionId = '';

    // ---- 进程 A：建任务 + 建动作，然后关服务 ----
    const processA = await startProduct(runDir);
    try {
      seedTask(processA, TASK_ID, 1);
      const created = await postJson(processA.baseUrl, '/api/adapters/actions', {
        tool: 'calendar',
        actionKind: 'event.create',
        taskId: TASK_ID,
        taskRevision: 1,
        params: { title: '组会', startMs: asLogicalTime(0) },
        authorization: { source: 'user_bubble', userApproved: true },
      });
      expect(created.status, JSON.stringify(created.json)).toBe(201);
      actionId = (created.json['action'] as Json)['action_id'] as string;
    } finally {
      await processA.close();
    }

    // ---- 进程 B：**全新 store 实例 + 全新服务**，只共享同一个运行目录 ----
    const processB = await startProduct(runDir);
    try {
      const readAction = await getJson(processB.baseUrl, `/api/adapters/actions/${actionId}`);
      expect(readAction.status, JSON.stringify(readAction.json)).toBe(200);
      expect((readAction.json['action'] as Json)['task_id']).toBe(TASK_ID);
      expect((readAction.json['action'] as Json)['state']).toBe('prepared');

      const readTask = await getJson(processB.baseUrl, `/api/tasks/${TASK_ID}/completion`);
      expect(readTask.status, JSON.stringify(readTask.json)).toBe(200);
      expect((readTask.json['counts'] as Json)['actions']).toBe(1);
      expect(readTask.json['unresolvedActionIds']).toContain(actionId);
    } finally {
      await processB.close();
    }

    // ---- 反例：**另一个**运行目录（独立树）里没有这条动作 ----
    const processC = await startProduct(otherDir);
    try {
      const missing = await getJson(processC.baseUrl, `/api/adapters/actions/${actionId}`);
      expect(missing.status).toBe(404);
      const noTask = await getJson(processC.baseUrl, `/api/tasks/${TASK_ID}/completion`);
      expect(noTask.status).toBe(404);
    } finally {
      await processC.close();
    }

    rmSync(runDir, { recursive: true, force: true });
    rmSync(otherDir, { recursive: true, force: true });
  }, 90_000);
});
