/**
 * 工作包 **FA-A-ITEMS-PRODUCT** —— 把 `tests/full-app/e2e/**` 的 A01–A19 **搬到真实 HTTP 上复算**。
 *
 * ## 这一套与 `tests/full-app/e2e/**` 的分工
 *
 * `tests/full-app/e2e/**` 的 A01–A19 **大多数落在内核 / 模型层**（直接调 `src/**` 的纯函数）。
 * 本套件不重复那些；它只回答一个更窄、也更硬的问题：
 * **同一批判据里，哪些能在产品 HTTP 入口上真跑出来？跑不出来的，为什么？**
 *
 * 三态口径（与回报里的表一一对应）：
 * - `真跑`：本文件有**非 skip** 的 `it`，经 `createDemoServer` 起的真实 `node:http` 服务、
 *   真实落盘 store 打进去，断言具体值（且带反向对照）；
 * - `skip+原因`：本文件有**显式 `it.skip`**，标题里写明"为什么在本机不可复算"；
 * - `产品面不存在`：本机条件下产品 HTTP 上没有这条入口（同样以 `it.skip` 如实登记，
 *   但原因写"无入口"而不是"缺设备"）。
 *
 * | A 项 | 产品可达性 |
 * |---|---|
 * | A01 正常文件任务 | 真跑（三格式字节 + 独立 ZIP 读回）；消费端打开 skip |
 * | A02 多成员请求空闲实例 | 产品面不存在（调度执行器未接进 HTTP） |
 * | A03 运行中连续唤醒 | 产品面不存在（同上） |
 * | A04 重复消息送达 | 真跑（conversation-loop 幂等重发）；跨重启去重 skip |
 * | A05 循环依赖 | 产品面不存在（诊断 / 租约回收未接进 HTTP） |
 * | A06 缺少能力或权限 | 真跑（适配器就绪视图 + 模板实例签发具名拒绝） |
 * | A07 用户修改需求 | 真跑（再编辑升版 + 旧版本不计入交付 + 旧气泡失效）；多产物级联 skip |
 * | A08 旧轮次迟到 | 真跑（过期 baseRevision 发布被拒且当前版本原样） |
 * | A09 用户取消 | 真跑（取消 + 动作不可执行且记录不被删）；副作用字段 skip |
 * | A10 应用重启或实例释放 | 真跑（同 runDir 重启后动作 / 任务 / 记忆仍可读；异 runDir 读不到） |
 * | A11 外部结果未知 | 真跑（result_unknown 不得回退 / 不得当成功 + 部分结果口径）；真实适配器故障注入 skip |
 * | A12 从美团返回 | 真跑（美团产品入口如实阻塞）；真机跳转 skip |
 * | A13 条件冲突或费用缺失 | 产品面不存在（事实层无 HTTP 入口） |
 * | A14 注入伪指令或假批准 | 真跑（不可信回执 409） |
 * | A15 重复点击气泡 | 真跑（同 idempotencyKey 重发命中同一版本） |
 * | A16 两群组写同一资源 | 真跑（过期版本写被拒且原记录原样保留） |
 * | A17 经验污染与模板更新 | 真跑（在途不固化 / 未封存不固化 / 忘记后不再注入 / 回滚后不再命中） |
 * | A18 插件停用或权限撤销 | 真跑（停用 / 撤权后新建实例被拒且理由具名） |
 * | A19 预算耗尽或断网 | 真跑（部分结果 + 原因 + 未配模型时如实失败）；预算闸门在密封环境不可达 / 真实断网需网络，均 skip |
 *
 * ## 诚实边界（不得越界引用）
 *
 * - 全部 HTTP 命中都经**产品入口** `createDemoServer`（真 Host + 真落盘 FileStore / 真记忆文件），
 *   但**部分"起点行"是夹具注入的**（任务行 / 工作项行，与既有 `adapters-actions.test.ts` 的
 *   `seedTask` 同一手法）。夹具只造**起点状态**，断言全部落在 HTTP 的返回值上。
 * - 本套件**不含**真机（安卓 App）、消费端（Word / Excel / PowerPoint）打开、真实外部账号
 *   （美团登录）、真实断网 / 重连。这些一律显式 `it.skip`。
 * - 本套件**不跑全量套件**，也不调用真实模型（模型一律未配置 ⇒ 如实为 `null`）。
 * - 【模型身份】本文件由**子智能体**产出，**子智能体模型身份未确认为 DS**。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DOCX_TITLE_BODY_PRESENTATION, buildDocxTemplate } from '../../../src/artifacts/templates/docx.js';
import {
  asInstanceId,
  asLogicalTime,
  asRequestId,
  asRevision,
  asTaskId,
  createTaskRecord,
  createWorkItem,
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
// 常量与夹具（硬编码官方字面量：不从产品映射表读，避免"用产品的话证明产品"）
// ---------------------------------------------------------------------------

const OFFICIAL_MIME = Object.freeze({
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
});

const MAIN_PART = Object.freeze({
  docx: 'word/document.xml',
  xlsx: 'xl/workbook.xml',
  pptx: 'ppt/presentation.xml',
});

/** 会话 DOCX 夹具（三段正文，供 `第2段` 意图定位）。 */
function fixtureDocx(): Uint8Array {
  return buildDocxTemplate({
    requirement: {
      title: 'A 项产品套件文档',
      description: '',
      paragraphs: ['第一段内容', '第二段内容', '第三段内容'],
      presentation: DOCX_TITLE_BODY_PRESENTATION,
    },
    fact_snapshot: [],
    references: [{ label: '来源', detail: 'FA-A-ITEMS-PRODUCT 夹具' }],
  }).bytes;
}

/** 夹具：往内核落一条任务行（与 `e2e-product.test.ts` 的 `seedTask` 同一手法）。 */
function seedTask(running: RunningProduct, taskId: string, revision: number): void {
  running.demo.host.store.transact((tx) => {
    tx.putTask(
      createTaskRecord({
        task_id: asTaskId(taskId),
        goal: 'FA-A-ITEMS-PRODUCT 夹具任务',
        created_at: asLogicalTime(0),
        revision: asRevision(revision),
      }),
    );
  });
}

/** 夹具：落一条任务 + 一条**终态**工作项（让完成口径的谓词①能成立）。 */
function seedCompletedTask(running: RunningProduct, taskId: string, revision: number): void {
  running.demo.host.store.transact((tx) => {
    tx.putTask(
      createTaskRecord({
        task_id: asTaskId(taskId),
        goal: 'FA-A-ITEMS-PRODUCT 已完成夹具任务',
        created_at: asLogicalTime(0),
        revision: asRevision(revision),
      }),
    );
    tx.putWorkItem(
      createWorkItem({
        request_id: asRequestId(`req-${taskId}`),
        owner_instance_id: asInstanceId(`I-${taskId}`),
        task_id: asTaskId(taskId),
        task_revision: asRevision(revision),
        status: 'completed',
        created_at: asLogicalTime(1),
      }),
    );
  });
}

function newRunDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function statusIs(response: { status: number; json: Json }, expected: number): void {
  expect(response.status, JSON.stringify(response.json)).toBe(expected);
}

// ---------------------------------------------------------------------------
// 主套件：一个产品服务（除重启组外共用）
// ---------------------------------------------------------------------------

let workDir: string;
let main: RunningProduct;

beforeAll(async () => {
  workDir = newRunDir('potbot-a-items-');
  main = await startProduct(join(workDir, 'run-main'));
}, 60_000);

afterAll(async () => {
  await main.close();
  rmSync(workDir, { recursive: true, force: true });
});

// ===========================================================================
// A01 正常文件任务 —— 三格式各自经产品入口交付，下载字节由独立 ZIP 解析器读回
// ===========================================================================

describe('A01 正常文件任务：产品入口交付真实字节，格式互不冒充', () => {
  it('DOCX / XLSX / PPTX 各自交付；下载字节含本格式主部件、不含另两种主部件', async () => {
    // DOCX：走字处理链 `/api/sessions`。
    const createdDocx = await postJson(main.baseUrl, '/api/sessions', {
      sessionId: 'a01-docx',
      filename: '方案.docx',
      mode: 'new',
      docxBase64: Buffer.from(fixtureDocx()).toString('base64'),
    });
    statusIs(createdDocx, 201);
    const editedDocx = await postJson(main.baseUrl, '/api/sessions/a01-docx/edits', {
      idempotencyKey: 'a01-docx-1',
      baseRevision: createdDocx.json['editRevision'],
      baseDigest: createdDocx.json['contentDigest'],
      intent: { steps: [{ range: '第2段', operation: { kind: 'setAlignment', alignment: 'center' } }] },
    });
    statusIs(editedDocx, 200);

    // XLSX / PPTX：走交付链 `/api/deliverables`。
    const createdXlsx = await postJson(main.baseUrl, '/api/deliverables', {
      sessionId: 'a01-xlsx',
      deliverableId: 'd-a01-xlsx',
      filename: '台账.xlsx',
      format: 'xlsx',
    });
    statusIs(createdXlsx, 201);
    const editedXlsx = await postJson(main.baseUrl, '/api/deliverables/a01-xlsx/edits', {
      idempotencyKey: 'a01-xlsx-1',
      baseRevision: createdXlsx.json['editRevision'],
      baseDigest: createdXlsx.json['contentDigest'],
      edit: { op: 'add_sheet', name: '明细' },
    });
    statusIs(editedXlsx, 200);

    const createdPptx = await postJson(main.baseUrl, '/api/deliverables', {
      sessionId: 'a01-pptx',
      deliverableId: 'd-a01-pptx',
      filename: '汇报.pptx',
      format: 'pptx',
    });
    statusIs(createdPptx, 201);
    const editedPptx = await postJson(main.baseUrl, '/api/deliverables/a01-pptx/edits', {
      idempotencyKey: 'a01-pptx-1',
      baseRevision: createdPptx.json['editRevision'],
      baseDigest: createdPptx.json['contentDigest'],
      edit: { op: 'add_slide', title: '封面' },
    });
    statusIs(editedPptx, 200);

    const downloads = {
      docx: await getBytes(main.baseUrl, '/api/sessions/a01-docx/versions/1/download'),
      xlsx: await getBytes(main.baseUrl, '/api/deliverables/a01-xlsx/versions/1/download'),
      pptx: await getBytes(main.baseUrl, '/api/deliverables/a01-pptx/versions/1/download'),
    };

    // 每个格式：状态 200 + 官方 MIME + 包内主部件互斥。
    expect(downloads.docx.status).toBe(200);
    expect(downloads.docx.contentType).toBe(OFFICIAL_MIME.docx);
    expect(downloads.xlsx.status).toBe(200);
    expect(downloads.xlsx.contentType).toBe(OFFICIAL_MIME.xlsx);
    expect(downloads.pptx.status).toBe(200);
    expect(downloads.pptx.contentType).toBe(OFFICIAL_MIME.pptx);

    for (const format of ['docx', 'xlsx', 'pptx'] as const) {
      const entries = zipEntryNames(downloads[format].bytes);
      // 先证明解析器**真读到了结构**（否则"不含其它主部件"会是"解出空表"的假象）。
      expect(entries, `${format} 包必有 [Content_Types].xml`).toContain('[Content_Types].xml');
      expect(entries, `${format} 包必有 _rels/.rels`).toContain('_rels/.rels');
      expect(entries, `${format} 包应含主部件 ${MAIN_PART[format]}`).toContain(MAIN_PART[format]);
      for (const other of ['docx', 'xlsx', 'pptx'] as const) {
        if (other === format) continue;
        expect(entries, `${format} 包里不得出现 ${other} 的主部件`).not.toContain(MAIN_PART[other]);
      }
    }
  });

  it('反向对照：三份下载字节两两不同（不是同一份字节换个后缀）', async () => {
    const docx = await getBytes(main.baseUrl, '/api/sessions/a01-docx/versions/1/download');
    const xlsx = await getBytes(main.baseUrl, '/api/deliverables/a01-xlsx/versions/1/download');
    const pptx = await getBytes(main.baseUrl, '/api/deliverables/a01-pptx/versions/1/download');
    const { createHash } = await import('node:crypto');
    const digestOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
    expect(new Set([digestOf(docx.bytes), digestOf(xlsx.bytes), digestOf(pptx.bytes)]).size).toBe(3);
  });

  it('反向对照：不存在的会话版本一律 404（下载面不接受"猜一个"）', async () => {
    const missing = await getBytes(main.baseUrl, '/api/sessions/a01-docx/versions/99/download');
    expect(missing.status).toBe(404);
    const unknownSession = await getJson(main.baseUrl, '/api/deliverables/never-opened');
    expect(unknownSession.status).toBe(404);
  });

  it.skip('A01 剩余部分：手机 / 消费端**实际打开**文件 → 需真机 + 无授权 Office（第三层证据，本轮未做）', () => {
    // 目录 §9：本批只到"真实字节 + 独立 ZIP 读回"；"能被 Word/Excel/PPT 打开"未验证。
  });
});

// ===========================================================================
// A04 重复消息送达（产品入口：连续对话闭环的幂等键）
// ===========================================================================

describe('A04 重复消息送达：同一 client_id 不重复创建业务工作', () => {
  it('同 client_id + 同正文重发 → 同一条消息、不新建任务；换正文 → 409 冲突', async () => {
    const conv = 'conv-a04';
    const first = await postJson(main.baseUrl, '/api/conversation-loop/turns', {
      conversation_id: conv,
      client_id: 'a04-key-1',
      text: '帮我做一份十人晚宴的筹备方案',
    });
    statusIs(first, 200);
    expect(first.json['ok']).toBe(true);
    expect(first.json['task_created']).toBe(true);
    expect(first.json['duplicate']).toBe(false);
    const messageId = (first.json['message'] as Json)['message_id'];
    const taskId = (first.json['task'] as Json)['task_id'];

    const resend = await postJson(main.baseUrl, '/api/conversation-loop/turns', {
      conversation_id: conv,
      client_id: 'a04-key-1',
      text: '帮我做一份十人晚宴的筹备方案',
    });
    statusIs(resend, 200);
    expect(resend.json['duplicate'], '重发必须被判为重复').toBe(true);
    expect((resend.json['message'] as Json)['message_id'], '重发命中同一条消息').toBe(messageId);
    expect((resend.json['task'] as Json)['task_id'], '重发不新建第二个任务').toBe(taskId);
    expect(resend.json['task_created']).toBe(false);

    // 反向对照：同一 client_id 换正文不得覆盖既有消息，而是具名冲突。
    const conflict = await postJson(main.baseUrl, '/api/conversation-loop/turns', {
      conversation_id: conv,
      client_id: 'a04-key-1',
      text: '改成二十人',
    });
    expect(conflict.status).toBe(409);
    expect(conflict.json['code']).toBe('idempotency_conflict');
  });

  it.skip('A04 剩余部分：跨重连 / 跨重启的持久化去重 → conversation-loop 的 TurnModel 是进程内状态，重启即丢（无落盘幂等表）', () => {
    // 目录 §9：本批不复验消息去重的持久化（同进程去重见 tests/acceptance/a04/**）。
  });
});

// ===========================================================================
// A06 缺少能力或权限：如实报告，不编造能力
// ===========================================================================

describe('A06 缺少能力：产品入口具名报告"未就绪 / 阻塞"，不编造可用能力', () => {
  it('适配器就绪视图：未就绪 / 阻塞分开报，能力项一律不声称有真实执行器', async () => {
    const readiness = await getJson(main.baseUrl, '/api/adapters/readiness');
    expect(readiness.status, JSON.stringify(readiness.json)).toBe(200);

    const totals = readiness.json['totals'] as Json;
    // 三块都要在。
    const packages = readiness.json['packages'] as Json;
    for (const pkg of ['clock', 'calendar', 'meituan'] as const) {
      expect(packages[pkg], `${pkg} 就绪视图缺失`).toBeTruthy();
    }
    // 本机没接任何真实端口 ⇒ 必然存在"未就绪"，且"阻塞"（平台无合法通道）也要被分开报。
    expect(Number(totals['not_ready']), '至少要有一项未就绪').toBeGreaterThan(0);
    expect(Number(totals['blocked']), '平台无合法通道的情形必须单列，不混进未就绪').toBeGreaterThan(0);

    for (const pkg of ['clock', 'calendar', 'meituan'] as const) {
      const view = packages[pkg] as Json;
      const subitems = view['subitems'] as Json[];
      expect(subitems.length, `${pkg} 条目不得为空`).toBeGreaterThan(0);
      // R233：非"已实现"的条目必须显式标 stub、且不得标 realExecutor。
      for (const item of subitems) {
        const isImplemented = item['verdict'] === 'implemented';
        expect(item['stub'], `${pkg}/${String(item['id'])} 的 stub 标识与 verdict 不一致`).toBe(!isImplemented);
        expect(item['realExecutor']).toBe(isImplemented);
      }
      // 能力项**一律**不得声称有真实执行器（不编造能力）。
      const capabilities = view['capabilities'] as Json[];
      expect(capabilities.length, `${pkg} 应报告未就绪能力`).toBeGreaterThan(0);
      for (const cap of capabilities) {
        expect(cap['stub'], `${pkg}/${String(cap['id'])}`).toBe(true);
        expect(cap['realExecutor'], '能力项不得声称有真实执行器').toBe(false);
        expect(String(cap['reason']).length, '未就绪必须给出原因').toBeGreaterThan(0);
      }
    }

    // 反向对照：任何一条 claims-ready 的能力都会让上一条断言变红（本机没有真实执行器可接）。
  });

  it('模板实例签发被具名拒绝：理由是"缺什么"，不是笼统 500', async () => {
    const installed = await postJson(main.baseUrl, '/api/plugins/template.calendar/install', {});
    statusIs(installed, 201);
    const enabled = await postJson(main.baseUrl, '/api/plugins/template.calendar/enable', {});
    statusIs(enabled, 200);
    const authorized = await postJson(main.baseUrl, '/api/plugins/template.calendar/authorize', {});
    statusIs(authorized, 200);

    const issued = await postJson(main.baseUrl, '/api/plugins/template.calendar/instances', {
      instanceId: 'a06-inst',
    });
    expect(issued.status, JSON.stringify(issued.json)).toBe(409);
    expect(issued.json['code']).toBe('instance_rejected');
    const reasons = issued.json['reasons'] as string[];
    expect(Array.isArray(reasons)).toBe(true);
    expect(reasons.length, '缺能力必须逐条具名报因').toBeGreaterThan(0);
  });
});

// ===========================================================================
// A07 用户修改需求：相关产物更新 + 旧气泡失效
// ===========================================================================

describe('A07 用户修改需求：产物升版、旧版本不计入交付、旧气泡失效', () => {
  it('再编辑 → 新版本；完成视图只认**当前版本**的产物', async () => {
    const created = await postJson(main.baseUrl, '/api/deliverables', {
      sessionId: 'a07-cascade',
      deliverableId: 'd-a07',
      filename: '需求变更.xlsx',
      format: 'xlsx',
    });
    statusIs(created, 201);

    const first = await postJson(main.baseUrl, '/api/deliverables/a07-cascade/edits', {
      idempotencyKey: 'a07-1',
      baseRevision: created.json['editRevision'],
      baseDigest: created.json['contentDigest'],
      edit: { op: 'add_sheet', name: '明细' },
    });
    statusIs(first, 200);
    const firstVersion = first.json['version'] as Json;

    const second = await postJson(main.baseUrl, '/api/deliverables/a07-cascade/edits', {
      idempotencyKey: 'a07-2',
      baseRevision: first.json['editRevision'],
      baseDigest: (firstVersion['contentDigest'] as string) ?? first.json['contentDigest'],
      edit: { op: 'set_cell', sheet: 'Sheet1', address: 'A1', value: { kind: 'text', value: '十人' } },
    });
    statusIs(second, 200);
    const secondVersion = second.json['version'] as Json;
    expect(secondVersion['artifactId'], '再编辑必须产出新产物').not.toBe(firstVersion['artifactId']);

    const completion = await getJson(main.baseUrl, '/api/deliverables/a07-cascade/completion');
    statusIs(completion, 200);
    const view = completion.json;
    const counts = view['counts'] as Json;
    // 两版产物都在内核里，但只有**当前版本**那一版算"已交付"（R264 第 2 条）。
    expect(counts['artifacts']).toBe(2);
    expect(counts['artifactsDelivered']).toBe(1);
    expect(view['deliveredArtifactIds']).toEqual([secondVersion['artifactId']]);
    expect(view['deliveredArtifactIds']).not.toContain(firstVersion['artifactId']);
  });

  it('旧气泡失效：任务版本推进后，旧版本动作判过期且气泡不可执行', async () => {
    const taskId = 'task-a07-bubble';
    seedTask(main, taskId, 1);
    const created = await postJson(main.baseUrl, '/api/adapters/actions', {
      tool: 'calendar',
      actionKind: 'event.create',
      taskId,
      taskRevision: 1,
      params: { title: '筹备会', startMs: asLogicalTime(0) },
      authorization: { source: 'user_bubble', userApproved: true },
    });
    statusIs(created, 201);
    const action = created.json['action'] as Json;
    const actionId = action['action_id'] as string;

    const bubble = {
      bubbleId: 'bubble-a07',
      taskRevision: 1,
      paramDigest: action['param_digest'],
    };

    // 同版本：可执行、气泡可执行。
    const before = await postJson(main.baseUrl, `/api/adapters/actions/${actionId}/executable`, {
      bubble,
    });
    statusIs(before, 200);
    expect(before.json['expired']).toBe(false);
    expect(before.json['executable']).toBe(true);
    expect((before.json['bubbleCheck'] as Json)['ok']).toBe(true);

    // 任务升版（经产品入口 resume_task 真写内核版本）。
    const resumed = await postJson(main.baseUrl, '/api/roles/main-agent', {
      kind: 'resume_task',
      task_id: taskId,
    });
    statusIs(resumed, 200);

    const after = await postJson(main.baseUrl, `/api/adapters/actions/${actionId}/executable`, {
      bubble,
    });
    statusIs(after, 200);
    expect(after.json['expired'], '任务升版后旧动作必须判过期').toBe(true);
    expect(after.json['executable']).toBe(false);
    expect((after.json['bubbleCheck'] as Json)['ok']).toBe(false);
    expect((after.json['bubbleCheck'] as Json)['reason']).toBe('stale_bubble');
  });

  it.skip('A07 剩余部分：一句话改**多个关联产物**的级联编排 → 产品 HTTP 上没有该入口（`planMultiArtifactChange` 未挂 HTTP；模型层覆盖见 a07-cascade.test.ts）', () => {
    // `/api/conversation-loop/**` 只暴露 turns / references/resolve / explain，无多产物事务入口。
  });
});

// ===========================================================================
// A08 旧轮次迟到 / A16 两群组写同一资源：版本闸门
// ===========================================================================

describe('A08 / A16 过期版本写被拒，且当前记录原样保留（不静默覆盖）', () => {
  it('A08：带着过期 baseRevision 的发布 → 409，当前版本与字节都不变', async () => {
    const created = await postJson(main.baseUrl, '/api/deliverables', {
      sessionId: 'a08-late',
      deliverableId: 'd-a08',
      filename: '迟到轮次.xlsx',
      format: 'xlsx',
    });
    statusIs(created, 201);
    const first = await postJson(main.baseUrl, '/api/deliverables/a08-late/edits', {
      idempotencyKey: 'a08-1',
      baseRevision: created.json['editRevision'],
      baseDigest: created.json['contentDigest'],
      edit: { op: 'add_sheet', name: '甲' },
    });
    statusIs(first, 200);
    const goodVersion = first.json['version'] as Json;
    const bytesBefore = await getBytes(main.baseUrl, '/api/deliverables/a08-late/versions/1/download');
    expect(bytesBefore.status).toBe(200);

    // 迟到的发布者拿着**开头的**版本还想写。
    const late = await postJson(main.baseUrl, '/api/deliverables/a08-late/edits', {
      idempotencyKey: 'a08-late',
      baseRevision: created.json['editRevision'],
      baseDigest: created.json['contentDigest'],
      edit: { op: 'add_sheet', name: '乙' },
    });
    expect(late.status, JSON.stringify(late.json)).toBe(409);

    const status = await getJson(main.baseUrl, '/api/deliverables/a08-late');
    statusIs(status, 200);
    expect(status.json['editRevision']).toBe(1);
    expect((status.json['versions'] as Json[]).length, '被拒的发布不得留下版本').toBe(1);
    expect((status.json['currentVersion'] as Json)['artifactId']).toBe(goodVersion['artifactId']);
    const bytesAfter = await getBytes(main.baseUrl, '/api/deliverables/a08-late/versions/1/download');
    expect(Buffer.from(bytesAfter.bytes).equals(Buffer.from(bytesBefore.bytes))).toBe(true);
  });

  it('A16：两个写者争同一资源，第二个拿过期版本 → 原记录原样保留；用当前版本重试才成立', async () => {
    const created = await postJson(main.baseUrl, '/api/deliverables', {
      sessionId: 'a16-two-writers',
      deliverableId: 'd-a16',
      filename: '争用.xlsx',
      format: 'xlsx',
    });
    statusIs(created, 201);

    // 写者 A 先成功。
    const writerA = await postJson(main.baseUrl, '/api/deliverables/a16-two-writers/edits', {
      idempotencyKey: 'a16-a',
      baseRevision: created.json['editRevision'],
      baseDigest: created.json['contentDigest'],
      edit: { op: 'add_sheet', name: 'A 的表' },
    });
    statusIs(writerA, 200);
    const digestAfterA = (writerA.json['version'] as Json)['contentDigest'] as string;

    // 写者 B 拿着**过期**的期望版本。
    const writerBStale = await postJson(main.baseUrl, '/api/deliverables/a16-two-writers/edits', {
      idempotencyKey: 'a16-b-stale',
      baseRevision: created.json['editRevision'],
      baseDigest: created.json['contentDigest'],
      edit: { op: 'add_sheet', name: 'B 的表' },
    });
    expect(writerBStale.status, JSON.stringify(writerBStale.json)).toBe(409);

    const after = await getJson(main.baseUrl, '/api/deliverables/a16-two-writers');
    statusIs(after, 200);
    expect(after.json['editRevision']).toBe(1);
    expect((after.json['currentVersion'] as Json)['contentDigest'], '被拒的写不得改动当前记录').toBe(
      digestAfterA,
    );

    // 用当前版本重试才成立，且版本推进。
    const writerBFresh = await postJson(main.baseUrl, '/api/deliverables/a16-two-writers/edits', {
      idempotencyKey: 'a16-b-fresh',
      baseRevision: after.json['editRevision'],
      baseDigest: digestAfterA,
      edit: { op: 'add_sheet', name: 'B 的表' },
    });
    statusIs(writerBFresh, 200);
    expect(writerBFresh.json['editRevision']).toBe(2);
  });
});

// ===========================================================================
// A09 用户取消：未提交动作不再执行，且取消 ≠ 没发生
// ===========================================================================

describe('A09 用户取消：动作不可再执行，记录不被删除', () => {
  it('取消任务 → 动作转终态、判不可执行、记录仍在；取消后不得续接', async () => {
    const taskId = 'task-a09-cancel';
    seedTask(main, taskId, 1);
    const created = await postJson(main.baseUrl, '/api/adapters/actions', {
      tool: 'calendar',
      actionKind: 'event.create',
      taskId,
      taskRevision: 1,
      params: { title: '筹备会（将被取消）' },
      authorization: { source: 'user_bubble', userApproved: true },
    });
    statusIs(created, 201);
    const actionId = (created.json['action'] as Json)['action_id'] as string;

    const before = await postJson(main.baseUrl, `/api/adapters/actions/${actionId}/executable`, {});
    statusIs(before, 200);
    expect(before.json['executable']).toBe(true);
    expect(before.json['terminal']).toBe(false);

    // 用户取消（经产品入口真写内核控制状态）。
    const cancelled = await postJson(main.baseUrl, '/api/roles/main-agent', {
      kind: 'cancel_task',
      task_id: taskId,
      reason: '用户取消：不办了',
    });
    statusIs(cancelled, 200);

    // 未提交的动作随取消落到终态。
    const invalidated = await postJson(main.baseUrl, `/api/adapters/actions/${actionId}/transition`, {
      to: 'invalidated_or_failed',
      invalidatedReason: '用户取消',
    });
    statusIs(invalidated, 200);
    expect((invalidated.json['action'] as Json)['state']).toBe('invalidated_or_failed');

    const after = await postJson(main.baseUrl, `/api/adapters/actions/${actionId}/executable`, {});
    statusIs(after, 200);
    expect(after.json['executable'], '终态动作不得再被执行').toBe(false);
    expect(after.json['terminal']).toBe(true);

    // 取消 ≠ 没发生：动作记录仍在（可读回）。
    const readback = await getJson(main.baseUrl, `/api/adapters/actions/${actionId}`);
    statusIs(readback, 200);
    expect((readback.json['action'] as Json)['state']).toBe('invalidated_or_failed');

    // 反向对照：已取消的任务不得续接。
    const resume = await postJson(main.baseUrl, '/api/roles/main-agent', {
      kind: 'resume_task',
      task_id: taskId,
    });
    expect(resume.status).toBe(422);
    expect(resume.json['code']).toBe('task_cancelled');
  });

  it.skip('A09 剩余部分：已发生外部副作用的 `reverted` 恒 false → 产品 HTTP 的 transition 面不接收 side_effect 写入（副作用账只在模型层构造）', () => {
    // `handleTransition` 只接受 receipt / userReport / failureReason / invalidatedReason / supersedeWith；
    // 没有 side_effect 入参，因此"已发生副作用如实保留"这一半在本机产品面上不可复算。
  });
});

// ===========================================================================
// A11 外部结果未知：不得回退、不得当成功
// ===========================================================================

describe('A11 结果未知：不判成功、不得盲目重试', () => {
  it('submitted → result_unknown 合法；回头再 submitted / handed_off 一律 409', async () => {
    const taskId = 'task-a11-unknown';
    seedTask(main, taskId, 1);
    const created = await postJson(main.baseUrl, '/api/adapters/actions', {
      tool: 'meituan',
      actionKind: 'handoff',
      taskId,
      taskRevision: 1,
      params: { candidateId: 'cand-1' },
      authorization: { source: 'user_bubble', userApproved: true },
    });
    statusIs(created, 201);
    const actionId = (created.json['action'] as Json)['action_id'] as string;

    const submitted = await postJson(main.baseUrl, `/api/adapters/actions/${actionId}/transition`, {
      to: 'submitted',
    });
    statusIs(submitted, 200);
    const unknown = await postJson(main.baseUrl, `/api/adapters/actions/${actionId}/transition`, {
      to: 'result_unknown',
    });
    statusIs(unknown, 200);
    expect((unknown.json['action'] as Json)['state']).toBe('result_unknown');

    // 不得盲目重试：回到在途状态是非法转换。
    const retry = await postJson(main.baseUrl, `/api/adapters/actions/${actionId}/transition`, {
      to: 'submitted',
    });
    expect(retry.status).toBe(409);
    const handoffRetry = await postJson(main.baseUrl, `/api/adapters/actions/${actionId}/transition`, {
      to: 'handed_off',
    });
    expect(handoffRetry.status).toBe(409);

    // 完成视图如实：未知动作不阻塞完成，但归类为"有未成之事"，绝不等于成功。
    const completion = await getJson(main.baseUrl, `/api/tasks/${taskId}/completion`);
    statusIs(completion, 200);
    const view = completion.json;
    expect((view['flags'] as Json)['anyResultUnknownAction']).toBe(true);
    const label = view['label'] as string;
    expect(label, '未知结果不得推出"已完成且成功"').not.toBe('completed_and_successful');
    expect(label).toBe('not_completed');
  });

  it('部分结果 + 原因：一次成功交付 + 一次被拒编辑 → "已完成但有未成之事"', async () => {
    const created = await postJson(main.baseUrl, '/api/deliverables', {
      sessionId: 'a11-partial',
      deliverableId: 'd-a11-partial',
      filename: '部分结果.xlsx',
      format: 'xlsx',
    });
    statusIs(created, 201);
    const ok = await postJson(main.baseUrl, '/api/deliverables/a11-partial/edits', {
      idempotencyKey: 'a11-ok',
      baseRevision: created.json['editRevision'],
      baseDigest: created.json['contentDigest'],
      edit: { op: 'add_sheet', name: '甲' },
    });
    statusIs(ok, 200);
    const rejected = await postJson(main.baseUrl, '/api/deliverables/a11-partial/edits', {
      idempotencyKey: 'a11-bad',
      baseRevision: created.json['editRevision'],
      baseDigest: created.json['contentDigest'],
      edit: { op: 'add_sheet', name: '乙' },
    });
    expect(rejected.status).toBe(409);

    const completion = await getJson(main.baseUrl, '/api/deliverables/a11-partial/completion');
    statusIs(completion, 200);
    const view = completion.json;
    // 部分结果**在**（不是"什么都没有所以失败"）。
    expect((view['flags'] as Json)['hasDeliveredArtifact']).toBe(true);
    expect((view['counts'] as Json)['artifactsDelivered']).toBe(1);
    // 但结论必须如实带上原因。
    expect((view['flags'] as Json)['anyWorkItemFailed']).toBe(true);
    expect(view['label']).toBe('completed_with_unfinished_business');
    expect(String(view['detail'])).toContain('有工作项失败');
  });

  it.skip('A11 剩余部分：真实适配器的"未知结果"故障注入 → 真实外部服务 / 账号未接入（模型层覆盖见 a11-fidelity.test.ts）', () => {});
});

// ===========================================================================
// A12 从美团返回：产品入口如实阻塞，不自动判购买完成
// ===========================================================================

describe('A12 美团：产品入口如实阻塞，候选恒空、封顶"已交接"', () => {
  it('工具声明自检干净且禁购；无账号搜索 → 具名未就绪且候选恒空；购买类动作 403', async () => {
    // ① 工具声明（纯数据面）：自检问题清单为空 = 无不可撤销副作用、无"交接却声明可回读"。
    const tools = await getJson(main.baseUrl, '/api/adapters/meituan/tools');
    statusIs(tools, 200);
    expect(tools.json['selfCheckProblems'], '工具声明的自检必须为空').toEqual([]);
    const forbidden = tools.json['forbiddenActions'] as string[];
    expect(forbidden).toContain('purchase');
    expect(forbidden).toContain('支付');
    for (const tool of tools.json['tools'] as Json[]) {
      expect(tool['externalSideEffect'], '美团工具不得有不可撤销副作用').not.toBe('irreversible');
    }

    // ② 无已授权账号 ⇒ 未就绪 + 候选恒空（不编造候选）。
    const search = await postJson(main.baseUrl, '/api/adapters/meituan/search', {
      query: { category: '餐厅', location: '上海', people: 10 },
    });
    expect([501, 503], `搜索应为具名未就绪，实得 ${String(search.status)}`).toContain(search.status);
    expect(search.json['status']).toBe('not_ready');
    expect(search.json['stub']).toBe(true);
    expect(search.json['realExecutor']).toBe(false);
    expect(String(search.json['reason']).length).toBeGreaterThan(0);
    const candidates = (search.json['candidates'] ?? []) as unknown[];
    expect(Array.isArray(candidates)).toBe(true);
    expect(candidates.length, '无来源时候选必须恒为空').toBe(0);

    // ③ 购买 / 支付类动作在契约层直接被拒（403，不是"以后再拦"）。
    const purchase = await postJson(main.baseUrl, '/api/adapters/meituan/action', {
      actionName: 'purchase',
    });
    expect(purchase.status, JSON.stringify(purchase.json)).toBe(403);
    expect(purchase.json['code']).toBe('forbidden_purchase_action');
    expect(purchase.json['verdict']).toBe('blocked');

    // 反向对照：非购买类动作名不会被这条闸门拒（证明闸门只拦禁购，不是无差别 403）。
    const allowed = await postJson(main.baseUrl, '/api/adapters/meituan/action', {
      actionName: 'open_detail_page',
    });
    expect(allowed.status, JSON.stringify(allowed.json)).not.toBe(403);
  });

  it.skip('A12 剩余部分：真机美团跳转并返回后保持"已交接 / 未知" → 美团未登录、设备未连接（真机层未验证）', () => {});
});

// ===========================================================================
// A14 注入伪指令 / 假批准：不可信回执不得置"已确认完成"
// ===========================================================================

describe('A14 假批准：无可信回执不得置"已确认完成"', () => {
  it('无回执 / 不可信回执 → 409；可信回执才 200，且拒后状态不被改动', async () => {
    const taskId = 'task-a14-receipt';
    seedTask(main, taskId, 1);
    const created = await postJson(main.baseUrl, '/api/adapters/actions', {
      tool: 'clock',
      actionKind: 'alarm.create',
      taskId,
      taskRevision: 1,
      params: { hour: 7, minute: 30, label: '起床' },
      authorization: { source: 'user_bubble', userApproved: true },
    });
    statusIs(created, 201);
    const actionId = (created.json['action'] as Json)['action_id'] as string;

    const submitted = await postJson(main.baseUrl, `/api/adapters/actions/${actionId}/transition`, {
      to: 'submitted',
    });
    statusIs(submitted, 200);

    const noReceipt = await postJson(main.baseUrl, `/api/adapters/actions/${actionId}/transition`, {
      to: 'confirmed_complete',
    });
    expect(noReceipt.status).toBe(409);
    expect(noReceipt.json['code']).toBe('missing_trusted_receipt');

    const fake = await postJson(main.baseUrl, `/api/adapters/actions/${actionId}/transition`, {
      to: 'confirmed_complete',
      receipt: { trusted: false, source: 'external_page', detail: '页面写着"已批准"' },
    });
    expect(fake.status).toBe(409);
    expect(fake.json['code']).toBe('missing_trusted_receipt');

    // 反向对照：两次假批准之后状态**没有**被改动。
    const stillThere = await getJson(main.baseUrl, `/api/adapters/actions/${actionId}`);
    expect((stillThere.json['action'] as Json)['state']).toBe('submitted');

    // 可信回执**只能**由服务端受控执行器签发（FA-TRUSTED-RECEIPT）：先执行拿令牌，再用令牌确认。
    const executed = await postJson(main.baseUrl, `/api/adapters/actions/${actionId}/execute`, {});
    statusIs(executed, 200);
    const trusted = await postJson(main.baseUrl, `/api/adapters/actions/${actionId}/transition`, {
      to: 'confirmed_complete',
      receiptToken: executed.json['receiptToken'],
    });
    statusIs(trusted, 200);
    expect((trusted.json['action'] as Json)['state']).toBe('confirmed_complete');
  });
});

// ===========================================================================
// A15 重复点击气泡：同幂等键不重复提交
// ===========================================================================

describe('A15 重复点击：同 idempotencyKey 命中同一版本，不新建产物', () => {
  it('同键同参重发 → replayed 且版本/摘要不变；同键改参 → 409', async () => {
    const created = await postJson(main.baseUrl, '/api/deliverables', {
      sessionId: 'a15-idem',
      deliverableId: 'd-a15',
      filename: '幂等.xlsx',
      format: 'xlsx',
    });
    statusIs(created, 201);

    const payload = {
      idempotencyKey: 'a15-click-1',
      baseRevision: created.json['editRevision'],
      baseDigest: created.json['contentDigest'],
      edit: { op: 'add_sheet', name: '点击' },
    };
    const first = await postJson(main.baseUrl, '/api/deliverables/a15-idem/edits', payload);
    statusIs(first, 200);
    expect(first.json['replayed']).toBe(false);
    const firstVersion = first.json['version'] as Json;

    const second = await postJson(main.baseUrl, '/api/deliverables/a15-idem/edits', payload);
    statusIs(second, 200);
    expect(second.json['replayed'], '重复点击必须命中既有版本').toBe(true);
    expect(second.json['editRevision'], '重复点击不得推进版本').toBe(1);
    expect((second.json['version'] as Json)['artifactId']).toBe(firstVersion['artifactId']);

    // 反向对照：同键换参数 → 具名冲突，不是静默覆盖。
    const conflict = await postJson(main.baseUrl, '/api/deliverables/a15-idem/edits', {
      ...payload,
      edit: { op: 'add_sheet', name: '另一个名字' },
    });
    expect(conflict.status).toBe(409);
  });

  it.skip('A15 剩余部分：手机重复点击的 UI 路径 → 需真机（HTTP 面已在上面真跑）', () => {});
});

// ===========================================================================
// A17 经验污染 / 固化 / 忘记 / 回滚
// ===========================================================================

const NEG_OWNER = 'user-neg-a17';
const POS_OWNER = 'user-pos-a17';
const TPL = 'template.document';

function evidence(lesson: string, overrides: Json = {}): Json {
  return {
    evidence_ref: `ev-${lesson}`,
    template_id: TPL,
    lesson,
    applies_to_version: '0.9.0',
    outcome: 'success',
    sealed: true,
    readback_verified: true,
    ...overrides,
  };
}

describe('A17 经验：在途不固化、未核验不固化、忘记后不再注入、回滚后不再命中', () => {
  it('在途任务（有非终态工作项）→ 422 具名拒绝，且一个字节都不写库', async () => {
    const taskId = 'task-a17-inflight';
    seedTask(main, taskId, 1);
    const rejected = await postJson(main.baseUrl, '/api/roles/experience/synthesize', {
      task_id: taskId,
      template_id: TPL,
      owner_id: NEG_OWNER,
      evidence: [evidence('在途任务不该固化这条')],
    });
    expect(rejected.status, JSON.stringify(rejected.json)).toBe(422);
    expect(rejected.json['code']).toBe('experience_trigger_rejected');
    expect(rejected.json['written'], '在途任务不得写库').toEqual([]);

    // 反向对照：库确实没变（同 owner 下检索不到）。
    const injection = await getJson(
      main.baseUrl,
      `/api/memory/injection?owner_id=${NEG_OWNER}&template_id=${TPL}&kind=template_experience`,
    );
    statusIs(injection, 200);
    expect(injection.json['status']).toBe('not_found');
    expect(injection.json['digest']).toBe('');
  });

  it('未封存证据 / 外部结果未知 → 不产出写入（未核验成功不得固化）', async () => {
    const taskId = 'task-a17-evidence';
    seedCompletedTask(main, taskId, 1);

    const unsealed = await postJson(main.baseUrl, '/api/roles/experience/synthesize', {
      task_id: taskId,
      template_id: TPL,
      owner_id: NEG_OWNER,
      evidence: [evidence('未封存的做法', { sealed: false })],
    });
    statusIs(unsealed, 200);
    const unsealedReport = unsealed.json['report'] as Json;
    expect(unsealedReport['written'], '未封存证据不得写库').toEqual([]);
    expect(
      (unsealedReport['evidence_rejections'] as Json[]).map((item) => item['code']),
      '未封存必须被具名记录，不静默丢弃',
    ).toContain('evidence_not_sealed');

    const unknownExternal = await postJson(main.baseUrl, '/api/roles/experience/synthesize', {
      task_id: taskId,
      template_id: TPL,
      owner_id: NEG_OWNER,
      evidence: [evidence('外部结果未知的做法', { outcome: 'unknown_external' })],
    });
    statusIs(unknownExternal, 200);
    const unknownReport = unknownExternal.json['report'] as Json;
    expect(unknownReport['written'], '外部结果未知不得固化成成功经验').toEqual([]);
    expect(unknownReport['blocked_unknown_external']).toContain('外部结果未知的做法');
  });

  it('已核验成功 → 写入；忘记后不再注入；回滚后不再命中且历史保留', async () => {
    const taskId = 'task-a17-write';
    seedCompletedTask(main, taskId, 1);

    const written = await postJson(main.baseUrl, '/api/roles/experience/synthesize', {
      task_id: taskId,
      template_id: TPL,
      owner_id: POS_OWNER,
      evidence: [evidence('图表与表格用同一套配色'), evidence('先自检再交付')],
    });
    statusIs(written, 200);
    const report = written.json['report'] as Json;
    const entries = report['written'] as Json[];
    expect(entries.length, '已核验成功的证据应被固化').toBe(2);

    const byLesson = new Map(entries.map((entry) => [entry['lesson'] as string, entry]));
    const forgetTarget = byLesson.get('图表与表格用同一套配色') as Json;
    const rollbackTarget = byLesson.get('先自检再交付') as Json;
    const forgetId = forgetTarget['memory_id'] as string;
    const rollbackId = rollbackTarget['memory_id'] as string;
    const rollbackVersion = rollbackTarget['version'] as number;

    // 注入面：两条都在。
    const beforeForget = await getJson(
      main.baseUrl,
      `/api/memory/injection?owner_id=${POS_OWNER}&template_id=${TPL}&kind=template_experience`,
    );
    statusIs(beforeForget, 200);
    expect(beforeForget.json['status']).toBe('found');
    expect(beforeForget.json['included_ids']).toContain(forgetId);
    expect(String(beforeForget.json['digest'])).toContain('图表与表格用同一套配色');

    // 忘记。
    const forgotten = await postJson(main.baseUrl, `/api/memory/entries/${forgetId}`, {
      owner_id: POS_OWNER,
      action: 'forget',
    });
    statusIs(forgotten, 200);
    expect(forgotten.json['ok']).toBe(true);

    const afterForget = await getJson(
      main.baseUrl,
      `/api/memory/injection?owner_id=${POS_OWNER}&template_id=${TPL}&kind=template_experience`,
    );
    expect(afterForget.json['included_ids'], '忘记后不得再注入').not.toContain(forgetId);
    expect(String(afterForget.json['digest'])).not.toContain('图表与表格用同一套配色');

    // 回滚一条具体写入（版本是必填的，杜绝"回滚最新那条"的模糊语义）。
    const rolledBack = await postJson(
      main.baseUrl,
      `/api/memory/experiences/${rollbackId}/rollback`,
      { owner_id: POS_OWNER, expected_version: rollbackVersion, reason: '做法已被取代' },
    );
    statusIs(rolledBack, 200);
    expect(rolledBack.json['kind']).toBe('rolled_back');
    expect(rolledBack.json['injectable_after'], '回滚后检索不再命中').toBe(false);
    expect(rolledBack.json['history_preserved'], '回滚只停用不删除').toBe(true);

    // 反向对照：拿过期版本号回滚 → 失败（不是"随便回滚一条"）。
    const staleRollback = await postJson(
      main.baseUrl,
      `/api/memory/experiences/${rollbackId}/rollback`,
      { owner_id: POS_OWNER, expected_version: rollbackVersion + 9, reason: '版本不符' },
    );
    expect(staleRollback.status).toBeGreaterThanOrEqual(400);

    // 反向对照：跨用户改不动（隔离键）。
    const crossUser = await postJson(main.baseUrl, `/api/memory/entries/${forgetId}`, {
      owner_id: 'user-someone-else',
      action: 'forget',
    });
    expect(crossUser.status).toBe(404);
  });

  it.skip('A17 剩余部分：真实实例在后续任务里被新规则改变行为 → 未接真实模型 / 执行器（模型层覆盖见 a10-memory-lifecycle.test.ts）', () => {});
});

// ===========================================================================
// A18 插件停用 / 权限撤销：即时生效
// ===========================================================================

describe('A18 模板停用 / 撤权：不再新建实例，且理由具名', () => {
  it('停用 → 理由含"停用"；重新启用后被撤销授权 → 理由含"撤销"', async () => {
    const pluginId = 'template.presentation';
    statusIs(await postJson(main.baseUrl, `/api/plugins/${pluginId}/install`, {}), 201);
    statusIs(await postJson(main.baseUrl, `/api/plugins/${pluginId}/enable`, {}), 200);
    statusIs(await postJson(main.baseUrl, `/api/plugins/${pluginId}/authorize`, {}), 200);

    const before = await postJson(main.baseUrl, `/api/plugins/${pluginId}/instances`, {
      instanceId: 'a18-inst-before',
    });
    const beforeText = JSON.stringify(before.json);

    // 停用：新建实例必须被拒，且**理由新增"停用"**（对照 before 里没有这一条）。
    statusIs(await postJson(main.baseUrl, `/api/plugins/${pluginId}/disable`, {}), 200);
    const afterDisable = await postJson(main.baseUrl, `/api/plugins/${pluginId}/instances`, {
      instanceId: 'a18-inst-disabled',
    });
    expect(afterDisable.status, JSON.stringify(afterDisable.json)).toBe(409);
    expect(beforeText, '停用前的理由里不该出现"停用"（否则本判据是真空的）').not.toContain('停用');
    expect(JSON.stringify(afterDisable.json)).toContain('停用');

    // 重新启用 + 授权，再撤销授权。
    statusIs(await postJson(main.baseUrl, `/api/plugins/${pluginId}/enable`, {}), 200);
    statusIs(await postJson(main.baseUrl, `/api/plugins/${pluginId}/authorize`, {}), 200);
    statusIs(await postJson(main.baseUrl, `/api/plugins/${pluginId}/revoke`, {}), 200);
    const afterRevoke = await postJson(main.baseUrl, `/api/plugins/${pluginId}/instances`, {
      instanceId: 'a18-inst-revoked',
    });
    expect(afterRevoke.status).toBe(409);
    expect(JSON.stringify(afterRevoke.json)).toContain('撤销');
  });

  it.skip('A18 剩余部分：App 上"停用 / 撤权"按钮点到即时生效的链路 → 需真机 App（HTTP 面已在上面真跑）', () => {});
});

// ===========================================================================
// A19 预算耗尽 / 断网 —— 部分结果真跑；预算闸门与断网显式跳过
// ===========================================================================

describe('A19 部分结果真跑；预算 / 断网显式跳过', () => {
  it('失败工作项 + 已交付产物：明确"部分结果 + 原因"，不是笼统失败', async () => {
    const created = await postJson(main.baseUrl, '/api/deliverables', {
      sessionId: 'a19-partial',
      deliverableId: 'd-a19',
      filename: '预算耗尽.xlsx',
      format: 'xlsx',
    });
    statusIs(created, 201);
    const ok = await postJson(main.baseUrl, '/api/deliverables/a19-partial/edits', {
      idempotencyKey: 'a19-ok',
      baseRevision: created.json['editRevision'],
      baseDigest: created.json['contentDigest'],
      edit: { op: 'add_sheet', name: '已完成的表' },
    });
    statusIs(ok, 200);
    const failed = await postJson(main.baseUrl, '/api/deliverables/a19-partial/edits', {
      idempotencyKey: 'a19-bad',
      baseRevision: created.json['editRevision'],
      baseDigest: created.json['contentDigest'],
      edit: { op: 'add_sheet', name: '没做成的表' },
    });
    expect(failed.status).toBe(409);

    const completion = await getJson(main.baseUrl, '/api/deliverables/a19-partial/completion');
    statusIs(completion, 200);
    const view = completion.json;
    expect(view['completed']).toBe(true);
    expect(view['label']).toBe('completed_with_unfinished_business');
    expect((view['flags'] as Json)['hasDeliveredArtifact'], '部分结果必须在').toBe(true);
    expect((view['flags'] as Json)['anyWorkItemFailed']).toBe(true);
    expect((view['counts'] as Json)['artifactsDelivered']).toBe(1);
  });

  it('密封环境下未配模型：生成任务如实失败，不伪造"已生成"', async () => {
    // 本套件起的服务只给 `POTBOT_RUN_DIR`，模型一律未配置 ⇒ 受理后必须**如实失败**。
    const submitted = await postJson(main.baseUrl, '/api/documents', {
      requestId: 'a19-no-model',
      instruction: 'write a dinner plan for ten people',
    });
    statusIs(submitted, 202);
    const taskId = submitted.json['taskId'] as string;

    const task = await getJson(main.baseUrl, `/api/tasks/${taskId}`);
    statusIs(task, 200);
    expect(task.json['status']).toBe('failed');
    expect((task.json['error'] as Json)['code']).toBe('model_not_configured');
  });

  it.skip('A19 预算耗尽（模型额度闸门）→ 本套件密封环境下不可达：模型未配置，"模型配置检查"排在额度闸门之前；真服务的可达性由冒烟实测（POTBOT_MODEL_MAX_REQUESTS=0 + 已配置模型 → 任务 error.code=budget_exhausted）', () => {
    // `kernel.ts#submit`：`this.#model === null` 先失败（model_not_configured），`reserveBudget`
    // 在 `#attempt` 内、模型检查之后。要把这条搬进 vitest 就必须给服务配上真实模型凭据——
    // 那会让"闸门一旦改序就会发出真实模型请求"，属于**故意把 live 调用留在测试里**，不做。
    // 因此：本文件不跑它；真服务冒烟的状态码与任务错误码记在交付说明里。
  });

  it.skip('A19 真实断网 / 重连：预算跨重启不清零、任务按可证明状态继续 → 需网络条件与真机', () => {});
});

// ===========================================================================
// A02 / A03 / A05 / A13 —— 本机产品面上不存在（显式登记，不假跑）
// ===========================================================================

describe('本机产品 HTTP 面上不存在入口的 A 项（显式 skip，禁止假跑）', () => {
  it.skip('A02 多成员请求空闲实例 → 产品面不存在：真实调度执行器未接进 HTTP（无"派发到空闲实例"入口）', () => {
    // 同进程内核覆盖见 tests/acceptance/a02a03/**。
  });

  it.skip('A03 运行中连续唤醒 → 产品面不存在：真实执行器未接进 HTTP（无"合并唤醒"入口）', () => {
    // 同进程内核覆盖见 tests/acceptance/a02a03/**。
  });

  it.skip('A05 循环依赖 → 产品面不存在：循环诊断 / 租约过期回收未接进 HTTP（产品面没有诊断入口）', () => {
    // FREEZE-6 登记为遗留；诊断逻辑覆盖见 tests/acceptance/a05/**。
  });

  it.skip('A13 条件冲突 / 费用缺失 → 产品面不存在：事实层（unknown 当零、同键冲突）在 HTTP 上没有任何入口', () => {
    // 产品路由只有 /api/sessions、/api/deliverables、/api/adapters/**、/api/memory/**、/api/plugins/**、
    // /api/conversation-loop/**、/api/roles/**；没有 /api/facts，也没有"以事实快照重建产物"的入口。
    // 模型层覆盖见 a01-formats-same-version.test.ts / a11-fidelity.test.ts。
  });
});

// ===========================================================================
// A10 应用重启或实例释放：同 runDir 可恢复；异 runDir 读不到
// ===========================================================================

describe('A10 重启恢复：从持久记录重建，不依赖原上下文仍在内存', () => {
  it('同 runDir 换一个服务实例：动作 / 任务 / 记忆仍可读；独立 runDir 一律读不到', async () => {
    const runDir = newRunDir('potbot-a10-same-');
    const otherDir = newRunDir('potbot-a10-other-');
    const taskId = 'task-a10-restart';
    const owner = 'user-a10';
    let actionId = '';
    let memoryId = '';

    // ---- 进程 A：落任务 + 动作 + 一条记忆（经宿主记忆端口真落盘）----
    const processA = await startProduct(runDir);
    try {
      seedTask(processA, taskId, 1);
      const created = await postJson(processA.baseUrl, '/api/adapters/actions', {
        tool: 'calendar',
        actionKind: 'event.create',
        taskId,
        taskRevision: 1,
        params: { title: '重启前创建的事件' },
        authorization: { source: 'user_bubble', userApproved: true },
      });
      statusIs(created, 201);
      actionId = (created.json['action'] as Json)['action_id'] as string;

      // 记忆：经宿主注入的文件落盘端口写入并持久化（产品入口的同一份仓库）。
      const { createMemoryEntry } = await import('../../../src/memory/index.js');
      const { asMemoryId, asOwnerId } = await import('../../../src/memory/index.js');
      const { asTemplateId } = await import('../../../src/protocol/index.js');
      memoryId = 'mem-a10-restart';
      const access = processA.demo.memoryRoutes.open();
      expect(access.ok, '记忆端口应已注入（产品入口是文件落盘端口）').toBe(true);
      if (!access.ok) throw new Error(access.message);
      const remembered = access.repository.remember(
        createMemoryEntry({
          kind: 'template_experience',
          memory_id: asMemoryId(memoryId),
          owner_id: asOwnerId(owner),
          scope: { kind: 'template', task_id: null, template_id: asTemplateId(TPL) },
          source: { kind: 'tool_result', detail: 'A10 重启夹具' },
          confirmation: 'confirmed',
          created_at: asLogicalTime(1),
          updated_at: asLogicalTime(1),
          version: 0,
          status: 'active',
          template_id: asTemplateId(TPL),
          lesson: '重启后这条经验仍应可检索',
          applies_to_version: '0.9.0',
        }),
      );
      expect(remembered.ok, JSON.stringify(remembered)).toBe(true);
      processA.demo.memoryRoutes.persist(asLogicalTime(2));
    } finally {
      await processA.close();
    }

    // ---- 进程 B：全新 store / 全新服务，只共享运行目录 ----
    const processB = await startProduct(runDir);
    try {
      const action = await getJson(processB.baseUrl, `/api/adapters/actions/${actionId}`);
      statusIs(action, 200);
      expect((action.json['action'] as Json)['task_id']).toBe(taskId);

      const completion = await getJson(processB.baseUrl, `/api/tasks/${taskId}/completion`);
      statusIs(completion, 200);
      expect((completion.json['counts'] as Json)['actions']).toBe(1);

      const injection = await getJson(
        processB.baseUrl,
        `/api/memory/injection?owner_id=${owner}&template_id=${TPL}&kind=template_experience`,
      );
      statusIs(injection, 200);
      expect(injection.json['status'], '记忆必须从落盘记录重建').toBe('found');
      expect(injection.json['included_ids']).toContain(memoryId);
    } finally {
      await processB.close();
    }

    // ---- 反例：另一个运行目录（独立树）里这些记录都不存在 ----
    const processC = await startProduct(otherDir);
    try {
      expect((await getJson(processC.baseUrl, `/api/adapters/actions/${actionId}`)).status).toBe(404);
      expect((await getJson(processC.baseUrl, `/api/tasks/${taskId}/completion`)).status).toBe(404);
      const foreignMemory = await getJson(
        processC.baseUrl,
        `/api/memory/injection?owner_id=${owner}&template_id=${TPL}&kind=template_experience`,
      );
      statusIs(foreignMemory, 200);
      expect(foreignMemory.json['status'], '独立运行目录不得看到别处的记忆').toBe('not_found');
    } finally {
      await processC.close();
    }

    rmSync(runDir, { recursive: true, force: true });
    rmSync(otherDir, { recursive: true, force: true });
  }, 120_000);

  it.skip('A10 剩余部分：真机 App 与后端进程分别重启（跨进程 + 真实租约 / 时钟高水位） → 需真机', () => {});
});

// ===========================================================================
// 冒烟：产品入口的健康 / 身份面
// ===========================================================================

describe('冒烟：健康与身份面如实', () => {
  it('/health 如实报未配置模型；/api/identity 报出运行目录与端口', async () => {
    const health = await getJson(main.baseUrl, '/health');
    statusIs(health, 200);
    expect(health.json['ready']).toBe(true);
    expect(health.json['modelConfigured'], '本机未配置模型，必须如实为 false').toBe(false);
    expect(health.json['modelVerified']).toBe(false);

    const identity = await getJson(main.baseUrl, '/api/identity');
    statusIs(identity, 200);
    expect(identity.json['runId']).toBe('run-main');
    expect(String(identity.json['runDir'])).toContain('run-main');
  });
});
