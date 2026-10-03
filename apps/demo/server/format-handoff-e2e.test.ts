/**
 * 工作包 **FA-PROD-DEPTH-F** —— 三种办公格式的「**交接给消费端**」在产品 HTTP 上走到边界，
 * 并**严格区分**「文件已产出」与「消费端已打开 / 已保存」。
 *
 * ## 本套件回答的唯一问题
 *
 * 前序套件（`a-items-product.test.ts` 的 A01）已经证明「三格式各交付真实字节、互不冒充」。
 * 本套件把镜头**前推一格**：把产出的文件「交出去」时，产品到底敢不敢说、能不能说
 * 「消费者打开了 / 保存了」？答案必须落在这条纪律上：
 *
 * > **没有消费端回执 ⇒ 最高只到「已交接」；绝不出现 `opened:true` / `saved_by_consumer:true`。**
 *
 * ## 三层证据分界（逐条写进断言，不靠文字承诺）
 *
 * | 层 | 本套件做到 |
 * |---|---|
 * | **① 本仓已产出并读回** | 三格式各自经产品 HTTP 交付，下载字节由**本套件自带的独立 ZIP 解析器**读回核对主部件 |
 * | **② 结构化交接（无消费端回执）** | 交接 / 打开编辑器类动作封顶 `handed_off`；执行器明说**无可信回执**；`confirmed_complete` 一律 409 |
 * | **③ 消费端真的打开 / 保存** | **未验证**：需真机 + 有授权的 Word / Excel / PowerPoint（本机无），显式 `it.skip` |
 *
 * ## 为什么自带独立 ZIP 解析器（不 import 内核自检器）
 *
 * 「格式互不冒充」的判据必须是**独立证据**：若拿内核自己的 `selfCheckArtifactBytes` 读回，
 * 「自检器分不清格式」这一缺陷会同时污染被测对象与量尺。本套件复用
 * `e2e-product-harness.ts` 的 `zipEntryNames()`——它只读 ZIP 中央目录（EOCD / 中央目录签名），
 * **不 import 本仓任何模块**，因此是可信的第三方量尺。
 *
 * ## 诚实边界（不得越界引用）
 *
 * - 全部 HTTP 命中经**产品入口** `createDemoServer`（真 Host + 真落盘 FileStore）。
 *   唯一例外：**起点任务行**由夹具经 `demo.host.store` 直接落库（与 `a-items-product.test.ts`
 *   的 `seedTask` 同一手法）——夹具只造**起点状态**，断言全部落在 HTTP 返回值上。走纯 curl 时
 *   可用 `/api/roles/main-agent {kind:'create_task'}` 造同一行（见回报里的真服务冒烟）。
 * - **消费端打开 / 另存 / 分享**这一层本机**做不到**：无真机、无授权 Office。凡涉及它一律
 *   `it.skip` 并写明原因，绝不以"模拟一次打开"冒充。
 * - 本套件**不跑全量套件**，**不调用真实模型**（模型一律未配置 ⇒ 如实为 `null`）。
 * - 【模型身份】本文件由**子智能体**产出，**子智能体模型身份未确认为 DS**。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHash } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DOCX_TITLE_BODY_PRESENTATION, buildDocxTemplate } from '../../../src/artifacts/templates/docx.js';
import {
  asLogicalTime,
  asRevision,
  asTaskId,
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
// 常量（硬编码官方字面量：不从产品映射表读，避免"用产品的话证明产品"）
// ---------------------------------------------------------------------------

const OFFICIAL_MIME = Object.freeze({
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
});

/** 三格式各自的**主部件**——互斥，缺一则不是该格式，多一则即冒充。 */
const MAIN_PART = Object.freeze({
  docx: 'word/document.xml',
  xlsx: 'xl/workbook.xml',
  pptx: 'ppt/presentation.xml',
});

/**
 * 消费端「已打开 / 已保存」的**结构化字段名族**。
 *
 * 这些字段在产品 JSON 里**出现即为越界**（哪怕是 `false`）："打开页面 ≠ 写入"（R246），
 * 没有任何端点能拿到消费端回执，因此连一个 `opened` 字段都不该有——它只会诱使人填 `true`。
 */
const CONSUMER_CLAIM_KEYS: readonly string[] = Object.freeze([
  'opened',
  'opened_by_consumer',
  'consumer_opened',
  'saved_by_consumer',
  'consumer_saved',
  'opened_in_consumer',
]);

const FORMATS = ['docx', 'xlsx', 'pptx'] as const;

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function fixtureDocx(): Uint8Array {
  return buildDocxTemplate({
    requirement: {
      title: '交接边界套件文档',
      description: '',
      paragraphs: ['第一段内容', '第二段内容', '第三段内容'],
      presentation: DOCX_TITLE_BODY_PRESENTATION,
    },
    fact_snapshot: [],
    references: [{ label: '来源', detail: 'FA-PROD-DEPTH-F 夹具' }],
  }).bytes;
}

function newRunDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 夹具：往内核落一条任务行（起点状态；断言不落在它上面）。 */
function seedTask(running: RunningProduct, taskId: string, revision: number): void {
  running.demo.host.store.transact((tx) => {
    tx.putTask(
      createTaskRecord({
        task_id: asTaskId(taskId),
        goal: 'FA-PROD-DEPTH-F 夹具任务',
        created_at: asLogicalTime(0),
        revision: asRevision(revision),
      }),
    );
  });
}

function statusIs(response: { status: number; json: Json }, expected: number): void {
  expect(response.status, JSON.stringify(response.json)).toBe(expected);
}

/** 下载面的原始字节 + 头部（`x-potbot-file-format` 是产品**自己声明**的格式，与 MIME 互为佐证）。 */
interface Download {
  readonly status: number;
  readonly contentType: string | null;
  readonly declaredFormat: string | null;
  readonly bytes: Uint8Array;
}

async function download(baseUrl: string, path: string): Promise<Download> {
  const response = await fetch(`${baseUrl}${path}`);
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    declaredFormat: response.headers.get('x-potbot-file-format'),
    bytes: new Uint8Array(await response.arrayBuffer()),
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * 递归断言：任意产品 JSON 里**不得出现**消费端「已打开 / 已保存」字段族。
 *
 * 这是"文件已产出 ≠ 消费端已打开"的**机器可核对**守卫：一旦哪天有人把 `opened:true`
 * 塞进任一交接响应，本断言当场变红。
 */
function assertNoConsumerClaims(value: unknown, label: string): void {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    if (current !== null && typeof current === 'object') {
      for (const [key, val] of Object.entries(current as Record<string, unknown>)) {
        expect(CONSUMER_CLAIM_KEYS.includes(key), `${label} 出现消费端字段 "${key}"（不得出现）`).toBe(false);
        if (key === 'purchase_confirmed') {
          expect(val, `${label} 的 purchase_confirmed 不得为真`).not.toBe(true);
        }
        stack.push(val);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 主服务（三格式产物 + 交接面共用）
// ---------------------------------------------------------------------------

let workDir: string;
let main: RunningProduct;

beforeAll(async () => {
  workDir = newRunDir('potbot-fhf-');
  main = await startProduct(join(workDir, 'run-main'));
}, 60_000);

afterAll(async () => {
  await main.close();
  rmSync(workDir, { recursive: true, force: true });
});

// ===========================================================================
// 第 ① 层：文件**已产出并读回**（三格式各自交付，独立 ZIP 解析器核对主部件）
// ===========================================================================

describe('① 本仓已产出并读回：三格式各自交付，主部件互不冒充', () => {
  it('DOCX / XLSX / PPTX 各自交付一版；下载字节只含本格式主部件，且头部自报格式一致', async () => {
    // --- 产出：DOCX 走字处理链 ---
    const createdDocx = await postJson(main.baseUrl, '/api/sessions', {
      sessionId: 'fhf-docx',
      filename: '方案.docx',
      mode: 'new',
      docxBase64: Buffer.from(fixtureDocx()).toString('base64'),
    });
    statusIs(createdDocx, 201);
    const editedDocx = await postJson(main.baseUrl, '/api/sessions/fhf-docx/edits', {
      idempotencyKey: 'fhf-docx-1',
      baseRevision: createdDocx.json['editRevision'],
      baseDigest: createdDocx.json['contentDigest'],
      intent: { steps: [{ range: '第2段', operation: { kind: 'setAlignment', alignment: 'center' } }] },
    });
    statusIs(editedDocx, 200);

    // --- 产出：XLSX / PPTX 走交付链 ---
    const createdXlsx = await postJson(main.baseUrl, '/api/deliverables', {
      sessionId: 'fhf-xlsx',
      deliverableId: 'd-fhf-xlsx',
      filename: '台账.xlsx',
      format: 'xlsx',
    });
    statusIs(createdXlsx, 201);
    statusIs(
      await postJson(main.baseUrl, '/api/deliverables/fhf-xlsx/edits', {
        idempotencyKey: 'fhf-xlsx-1',
        baseRevision: createdXlsx.json['editRevision'],
        baseDigest: createdXlsx.json['contentDigest'],
        edit: { op: 'add_sheet', name: '明细' },
      }),
      200,
    );

    const createdPptx = await postJson(main.baseUrl, '/api/deliverables', {
      sessionId: 'fhf-pptx',
      deliverableId: 'd-fhf-pptx',
      filename: '汇报.pptx',
      format: 'pptx',
    });
    statusIs(createdPptx, 201);
    statusIs(
      await postJson(main.baseUrl, '/api/deliverables/fhf-pptx/edits', {
        idempotencyKey: 'fhf-pptx-1',
        baseRevision: createdPptx.json['editRevision'],
        baseDigest: createdPptx.json['contentDigest'],
        edit: { op: 'add_slide', title: '封面' },
      }),
      200,
    );

    // --- 读回：三份下载字节 ---
    const downloads: Record<(typeof FORMATS)[number], Download> = {
      docx: await download(main.baseUrl, '/api/sessions/fhf-docx/versions/1/download'),
      xlsx: await download(main.baseUrl, '/api/deliverables/fhf-xlsx/versions/1/download'),
      pptx: await download(main.baseUrl, '/api/deliverables/fhf-pptx/versions/1/download'),
    };

    for (const format of FORMATS) {
      const got = downloads[format];
      expect(got.status, `${format} 下载状态`).toBe(200);
      expect(got.contentType, `${format} 官方 MIME`).toBe(OFFICIAL_MIME[format]);
      // 自报格式头：交付链（xlsx/pptx，`/api/deliverables`）会带 `x-potbot-file-format`；
      // 字处理链（docx，`/api/sessions`）的下载面当前**不**带该头（两条链的下载头部不对称，
      // 如实登记，不替它补一条产品没发的头）。MIME + 主部件才是两链共有的判据。
      if (format === 'docx') {
        expect(got.declaredFormat, 'docx 下载面当前不带 x-potbot-file-format（如实登记的不对称）').toBeNull();
      } else {
        expect(got.declaredFormat, `${format} 自报格式头`).toBe(format);
      }

      const entries = zipEntryNames(got.bytes);
      // 先证明解析器**真读到了结构**（否则"不含其它主部件"会退化成"解出空表"的假象）。
      expect(entries, `${format} 包必有 [Content_Types].xml`).toContain('[Content_Types].xml');
      expect(entries, `${format} 包必有 _rels/.rels`).toContain('_rels/.rels');
      expect(entries, `${format} 应含本格式主部件`).toContain(MAIN_PART[format]);
      for (const other of FORMATS) {
        if (other === format) continue;
        expect(entries, `${format} 包不得含 ${other} 的主部件`).not.toContain(MAIN_PART[other]);
      }
    }

    // 反向对照：三份字节两两不同（不是"同一份字节换个后缀 / 换个 MIME"）。
    expect(new Set(FORMATS.map((f) => sha256(downloads[f].bytes))).size, '三格式字节必须两两不同').toBe(3);
  });

  it('反向对照：不存在的版本一律 404（下载面不接受"猜一个"）', async () => {
    expect((await getBytes(main.baseUrl, '/api/sessions/fhf-docx/versions/99/download')).status).toBe(404);
    expect((await getBytes(main.baseUrl, '/api/deliverables/fhf-xlsx/versions/99/download')).status).toBe(404);
  });

  it.skip('① 未覆盖：消费端（Word / Excel / PowerPoint）**实际打开**这些字节 → 需真机 + 有授权 Office（本机无，第三层证据未做）', () => {
    // 目录 §9 口径：本批只到"真实字节 + 独立 ZIP 读回"；"能被 Office 打开"未验证。
  });
});

// ===========================================================================
// 第 ② 层：结构化交接 —— 无消费端回执 ⇒ 封顶"已交接"
// ===========================================================================

describe('② 交接面：结构化"已交接"封顶，绝无"已打开 / 已保存"', () => {
  it('交接类动作最高只到 handed_off；在此之上的输入一律被**具名**拒绝，不留任何消费端字段', async () => {
    const taskId = 'task-fhf-handoff';
    seedTask(main, taskId, 1);

    // 日历"打开编辑页"是最接近"交给消费端"的动作（把内容交给系统日历 / 编辑器）。
    const created = await postJson(main.baseUrl, '/api/adapters/actions', {
      tool: 'calendar',
      actionKind: 'event.open_editor',
      taskId,
      taskRevision: 1,
      params: { title: '打开编辑页' },
      authorization: { source: 'user_bubble', userApproved: true },
    });
    statusIs(created, 201);
    const actionId = (created.json['action'] as Json)['action_id'] as string;
    assertNoConsumerClaims(created.json, '创建交接动作');

    // 交接动作的**产品事实面**：把内容交出去了（prepared → handed_off）。
    const handed = await postJson(main.baseUrl, `/api/adapters/actions/${actionId}/transition`, {
      to: 'handed_off',
    });
    statusIs(handed, 200);
    expect((handed.json['action'] as Json)['state']).toBe('handed_off');
    assertNoConsumerClaims(handed.json, '交接 sealed 到 handed_off');

    // ① 试图直接"确认完成"（= 声称消费端已打开/已保存）而无可信回执 → 具名拒绝。
    const noReceipt = await postJson(main.baseUrl, `/api/adapters/actions/${actionId}/transition`, {
      to: 'confirmed_complete',
    });
    expect(noReceipt.status, JSON.stringify(noReceipt.json)).toBe(409);
    expect(noReceipt.json['code']).toBe('missing_trusted_receipt');
    assertNoConsumerClaims(noReceipt.json, '无回执确认完成');

    // ② 伪造 `receipt.trusted:true`（冒充"消费端打开了"）→ 同样被拒（R245）。
    const forged = await postJson(main.baseUrl, `/api/adapters/actions/${actionId}/transition`, {
      to: 'confirmed_complete',
      receipt: { trusted: true, source: 'consumer_word', detail: 'Word 已打开并保存' },
    });
    expect(forged.status, JSON.stringify(forged.json)).toBe(409);
    expect(forged.json['code']).toBe('missing_trusted_receipt');
    assertNoConsumerClaims(forged.json, '伪造消费端回执');

    // 反向对照：两次越界尝试之后，动作**仍在** handed_off（记录未被改动）。
    const readback = await getJson(main.baseUrl, `/api/adapters/actions/${actionId}`);
    statusIs(readback, 200);
    expect((readback.json['action'] as Json)['state'], '越界尝试不得改动状态').toBe('handed_off');
  });

  it('受控执行器对"打开编辑器 / 交接"类动作如实报未知：不给回执令牌（无消费端回执可发）', async () => {
    const taskId = 'task-fhf-exec';
    seedTask(main, taskId, 1);
    const created = await postJson(main.baseUrl, '/api/adapters/actions', {
      tool: 'calendar',
      actionKind: 'event.open_editor',
      taskId,
      taskRevision: 1,
      params: { title: '打开编辑页（执行面）' },
      authorization: { source: 'user_bubble', userApproved: true },
    });
    statusIs(created, 201);
    const actionId = (created.json['action'] as Json)['action_id'] as string;

    // 进在途态后执行：交接类动作**没有可信回执可发** ⇒ 执行器返回 unknown ⇒ 409，且**无令牌**。
    statusIs(await postJson(main.baseUrl, `/api/adapters/actions/${actionId}/transition`, { to: 'submitted' }), 200);
    const executed = await postJson(main.baseUrl, `/api/adapters/actions/${actionId}/execute`, {});
    expect(executed.status, JSON.stringify(executed.json)).toBe(409);
    expect(executed.json['code'], '交接类动作执行器不得签发回执').toBe('receipt_unavailable');
    expect(executed.json['receiptToken'], '不得出现任何回执令牌').toBeUndefined();
    assertNoConsumerClaims(executed.json, '交接类执行');
  });

  it('美团"目标页交接"未接通受控链接来源 ⇒ 503 具名未就绪，且不产出任何气泡 / 消费端字段', async () => {
    const verify = await postJson(main.baseUrl, '/api/adapters/extra/meituan/handoff-verify', {
      op: 'handoff',
      selection: { candidateId: 'cand-1', revision: 1 },
    });
    expect(verify.status, JSON.stringify(verify.json)).toBe(503);
    expect(verify.json['code']).toBe('meituan_handoff_link_not_ready');
    expect(verify.json['status']).toBe('not_ready');
    expect(verify.json['stub'], '未就绪必须显式标 stub').toBe(true);
    expect(verify.json['realExecutor'], '未就绪不得声称有真实执行器').toBe(false);
    expect(verify.json['bubble'], '未接通链接来源时不得产出气泡').toBeNull();
    expect(String(verify.json['reason']).length, '未就绪必须给出原因').toBeGreaterThan(0);
    assertNoConsumerClaims(verify.json, '美团交接未就绪');
  });
});

// ===========================================================================
// 第 ③ 层之反面：失败与未知 —— 具名报因、未知保留未知
// ===========================================================================

describe('失败与未知：具名报因；未知保留未知，不得当成功', () => {
  it('返回后外部结果不可读 ⇒ 结果保留「未知」，purchase_confirmed 恒 false', async () => {
    const settled = await postJson(main.baseUrl, '/api/adapters/extra/meituan/handoff-verify', {
      op: 'settle',
      from: 'submitted',
      readable: false,
      detail: '返回后外部状态不可读',
    });
    statusIs(settled, 200);
    expect(settled.json['state'], '不可读 ⇒ 保留未知，不得升级为已确认').toBe('unknown');
    expect(settled.json['purchase_confirmed']).toBe(false);
    assertNoConsumerClaims(settled.json, '返回结算（不可读）');
  });

  it('未知态不得盲目重试回在途：result_unknown → handed_off / submitted 一律 409', async () => {
    const taskId = 'task-fhf-unknown';
    seedTask(main, taskId, 1);
    const created = await postJson(main.baseUrl, '/api/adapters/actions', {
      tool: 'meituan',
      actionKind: 'handoff',
      taskId,
      taskRevision: 1,
      params: { candidateId: 'cand-unknown' },
      authorization: { source: 'user_bubble', userApproved: true },
    });
    statusIs(created, 201);
    const actionId = (created.json['action'] as Json)['action_id'] as string;
    statusIs(await postJson(main.baseUrl, `/api/adapters/actions/${actionId}/transition`, { to: 'submitted' }), 200);
    statusIs(await postJson(main.baseUrl, `/api/adapters/actions/${actionId}/transition`, { to: 'result_unknown' }), 200);

    for (const to of ['submitted', 'handed_off'] as const) {
      const retry = await postJson(main.baseUrl, `/api/adapters/actions/${actionId}/transition`, { to });
      expect(retry.status, `未知态回到 ${to} 必须被拒`).toBe(409);
    }
  });

  it('失败必须具名：过期版本动作不得交接（stale_task_revision），非法 op 具名拒绝', async () => {
    const taskId = 'task-fhf-stale';
    seedTask(main, taskId, 1);
    const created = await postJson(main.baseUrl, '/api/adapters/actions', {
      tool: 'meituan',
      actionKind: 'handoff',
      taskId,
      taskRevision: 1,
      params: { candidateId: 'cand-stale' },
      authorization: { source: 'user_bubble', userApproved: true },
    });
    statusIs(created, 201);
    const actionId = (created.json['action'] as Json)['action_id'] as string;

    // 任务升版 ⇒ 旧动作过期，交接不得带着过期版本"悄悄交出去"。
    statusIs(await postJson(main.baseUrl, '/api/roles/main-agent', { kind: 'resume_task', task_id: taskId }), 200);
    const stale = await postJson(main.baseUrl, `/api/adapters/actions/${actionId}/execute`, {});
    expect(stale.status, JSON.stringify(stale.json)).toBe(409);
    expect(stale.json['code'], '过期版本必须具名').toBe('stale_task_revision');

    // 具名拒绝非法 op（不吞成笼统 500）。
    const badOp = await postJson(main.baseUrl, '/api/adapters/extra/meituan/handoff-verify', { op: 'nonsense' });
    expect(badOp.status).toBe(400);
    expect(badOp.json['code']).toBe('unknown_op');
  });
});

// ===========================================================================
// 反向对照：格式不可冒充 + 消费端声明必须被拒
// ===========================================================================

describe('反向对照：把 DOCX 的内容当 XLSX 交付必须被挡住；声称消费端已打开必须被拒', () => {
  it('拿 DOCX 字节去开一个 xlsx 交付 ⇒ **具名 4xx**（导入字节与格式不符），绝不静默丢弃、也不留下空白会话', async () => {
    // 把 DOCX 的字节当 xlsx 的导入源送进去（format=xlsx）。
    const created = await postJson(main.baseUrl, '/api/deliverables', {
      sessionId: 'fhf-forged',
      deliverableId: 'd-fhf-forged',
      filename: '冒充.xlsx',
      format: 'xlsx',
      fileBase64: Buffer.from(fixtureDocx()).toString('base64'),
    });
    // 改前（FA-DELIVERABLE-INPUT-BYTES 记录）：这里返回 **201**，且起始摘要与**空白 xlsx 逐字节一致**
    // ——`fileBase64` 被静默丢弃（潜在"假成功"）。改后：字节与格式不符 ⇒ 具名 400。
    statusIs(created, 400);
    expect(created.json['code'], '导入字节与格式不符必须具名报因（不是 500、不是静默）').toBe('import_failed');

    // 静默丢弃的旧行为会**留下一个空白会话**；具名拒绝则什么都不建。
    const status = await getJson(main.baseUrl, '/api/deliverables/fhf-forged');
    expect(status.status, '被拒的会话不得被创建').toBe(404);

    // "DOCX 主部件绝不落入 xlsx 包"这条不变量改由**阳性对照**钉住：一份真 xlsx 交付的包里
    // 只该有 xlsx 自己的主部件。（非空字节的真吸收覆盖见 `deliverable-input-bytes.test.ts`。）
    const blank = await postJson(main.baseUrl, '/api/deliverables', {
      sessionId: 'fhf-blank',
      deliverableId: 'd-fhf-blank',
      filename: '空白.xlsx',
      format: 'xlsx',
    });
    statusIs(blank, 201);
    // 开会话本身不产出发布版本；先出一版再读回。
    statusIs(
      await postJson(main.baseUrl, '/api/deliverables/fhf-blank/edits', {
        idempotencyKey: 'fhf-blank-1',
        baseRevision: blank.json['editRevision'],
        baseDigest: blank.json['contentDigest'],
        edit: { op: 'add_sheet', name: 'X' },
      }),
      200,
    );
    const delivered = await download(main.baseUrl, '/api/deliverables/fhf-blank/versions/1/download');
    expect(delivered.status).toBe(200);
    expect(delivered.declaredFormat).toBe('xlsx');
    const entries = zipEntryNames(delivered.bytes);
    expect(entries, '交付的 xlsx 必须有自己的主部件').toContain(MAIN_PART.xlsx);
    expect(entries, 'DOCX 的内容**绝不**能落进一个 xlsx 包').not.toContain(MAIN_PART.docx);
    expect(delivered.contentType).toBe(OFFICIAL_MIME.xlsx);
  });

  it('声称"消费端已打开"必须被拒：无法送达的 opens 声明不留痕、不改状态', async () => {
    const taskId = 'task-fhf-claim';
    seedTask(main, taskId, 1);
    const created = await postJson(main.baseUrl, '/api/adapters/actions', {
      tool: 'calendar',
      actionKind: 'event.open_editor',
      taskId,
      taskRevision: 1,
      params: { title: '打开编辑页（声明面）' },
      authorization: { source: 'user_bubble', userApproved: true },
    });
    statusIs(created, 201);
    const actionId = (created.json['action'] as Json)['action_id'] as string;
    // 先到「已交接」（这是本动作能到的**最高**状态），使 `confirmed_complete` 在转换表上**可达**，
    // 于是接下来被拒的理由只可能是"缺可信回执"，而不是"非法转换"。
    statusIs(await postJson(main.baseUrl, `/api/adapters/actions/${actionId}/transition`, { to: 'handed_off' }), 200);

    // 客户端在请求体里塞"消费端已打开"的字段——产品**不读**它，也不据此推进状态。
    const claim = await postJson(main.baseUrl, `/api/adapters/actions/${actionId}/transition`, {
      to: 'confirmed_complete',
      opened: true,
      saved_by_consumer: true,
      receipt: { trusted: true, source: 'consumer', detail: '已打开' },
    });
    expect(claim.status).toBe(409);
    expect(claim.json['code'], '可达转换被拒的唯一理由＝缺可信回执').toBe('missing_trusted_receipt');
    assertNoConsumerClaims(claim.json, '客户端自报消费端已打开');

    // 状态原样：仍是 handed_off（越界声明没有把它推向"已确认"）。
    const readback = await getJson(main.baseUrl, `/api/adapters/actions/${actionId}`);
    statusIs(readback, 200);
    expect((readback.json['action'] as Json)['state']).toBe('handed_off');
  });
});

// ===========================================================================
// 明确登记：本机产品面上不存在 / 需真机的部分（禁止假跑）
// ===========================================================================

describe('明确登记：产品 HTTP 面不存在 / 需真机的部分（禁止假跑）', () => {
  it.skip('办公文件（DOCX/XLSX/PPTX）的**结构化交接**（打开 / 另存 / 分享）端点 → 产品 HTTP 面不存在：只有下载面（/versions/:rev/download）能"把文件交出去"，没有任何"在消费端打开 / 另存 / 分享"的端点。', () => {
    // 产品路由只有 /api/sessions、/api/deliverables、/api/documents、/api/artifacts、/api/adapters/**、
    // /api/memory/**、/api/plugins/**、/api/conversation-loop/**、/api/roles/**；
    // 这些面上的"交接"仅是**适配器动作**（meituan / clock / calendar），与本套件交付的三种办公格式**无绑定**。
  });

  it.skip('③ 消费端**实际打开 / 另存 / 分享**交付文件 → 需真机（安卓 App）+ 有授权的 Word / Excel / PowerPoint（本机无授权、无真机，未验证）', () => {
    // 这是"文件已产出"与"消费端已打开"之间的**最后一段**：本仓只能产生字节并读回结构，
    // 无法证明任何消费端真的打开了它。绝不以"模拟一次打开"冒充。
  });
});
