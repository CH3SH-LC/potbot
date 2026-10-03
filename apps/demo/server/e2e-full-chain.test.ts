/**
 * 工作包 **FA-E2E-FULL-CHAIN** —— 跨模板全链端到端（能力目录 **§9** 的验收链路）。
 *
 * ## 这一组用例要证明什么（全部经**真 `node:http` 服务** + 真落盘 + 产品入口）
 *
 * | # | 判据 | 用例组 |
 * |---|---|---|
 * | 1 | **一句话改共享事实（人数 8 → 10）**：用户原话经产品入口收下；共享事实按 supersede 语义换成新版本 | 0 |
 * | 2 | **三个产物同版**：DOCX / XLSX / PPTX **各自**经产品入口交付一次，**数值取自同一事实版本**（= 当前版本 10，且都不是旧版本 8）；下载字节由**自带独立 ZIP 读取器**分别读回，**格式互不冒充** | A |
 * | 3 | **不一致要被抓到**：人为让 **PPTX 用旧版本事实** ⇒ 被判冲突（`stale_fact_binding`，反向对照） | B |
 * | 4 | **无关内容不重写**：改一处后，未受影响的**段落 / 工作表 / 页**逐部件**字节不变**（真实 HTTP 下载后比字节）；事务视图侧另有"无关产物被重写 / 该改的没改 / 旧气泡被执行"三条反向对照 | A / C |
 * | 5 | **完成口径**：产物**绑当前版本**才算交付；**被拒的编辑**必须让完成视图**不报"已完成且成功"**（S-1026-01 最小复现，产品 HTTP） | D |
 * | 6 | **落盘**：换服务实例、**同运行目录** ⇒ 任务 / 动作 / 产物仍可读；换**独立目录** ⇒ 读不到（反向对照） | E |
 *
 * ## 独立证据与**如实登记**的边界（务必连着读）
 *
 * 1. **独立量尺**：ZIP 读取器在 `e2e-full-chain-harness.ts`，只依赖 ZIP 字节布局，
 *    **不 import 本仓任何模块**（否则"读取器与写者共用同一假设"会同时污染被测对象与量尺）。
 *    MIME / 主部件名用**硬编码官方字面量**，不从产品映射表里读。
 * 2. **哪几段是产品 HTTP、哪几段不是**（这一条是本文件最要紧的诚实边界）：
 *    - **是**产品 HTTP：三格式的交付 / 编辑 / 下载 / 状态 / 完成口径 / 适配器动作 / 会话恢复
 *      （`/api/sessions/**`、`/api/deliverables/**`、`/api/tasks/:id/completion`、
 *      `/api/adapters/actions/**`、`/api/conversation-loop/turns`），以及**共享事实的读写**
 *      （`/api/facts/**`：`GET /api/facts[?task_id=T]`、`GET /api/facts/:key`、
 *      `GET /api/facts/:key/history`、`POST /api/facts/:key`）。
 *      > 本文件 0-3 曾**如实登记**过"`GET /api/facts` → 404、产品面没有事实路由"。
 *      > `FA-FACTS-HTTP-ROUTE` 补齐了这条命名空间，0-3 因此翻正为**正例**：
 *      > 换版（8 → 10）现在走 `POST /api/facts/headcount`（带 `expected_revision`），
 *      > 旧版写入被 409 挡住、无版本写入被 400 挡住，读回与内核真相源一致。
 *    - **不是**产品 HTTP：**事实版本闸门**（`captureFactVersion` / `evaluateCommit` /
 *      `FactVersionGate`，见 B 组）。这些是内核判定，产品面没有独立端点；
 *      本套件用**内核真模块**与 `src/artifacts` 的 `findFactInvalidatedArtifacts` 直接驱动，
 *      **不手搓一份"看起来像"的闸门**。
 *      ⇒ 注意：B/C 组直驱内核判定时读的是**产品服务自己的内核真相源**
 *      （`demo.host.store`，即 `createDemoServer` 组装时交给内核持久化
 *      `<runDir>/kernel-store/store.json` 的那一份），与 0-3 的 HTTP 读写**同一份**。
 * 3. **两个交付宿主各有各的内核存储**：DOCX 走 `DocumentSessionHost`、XLSX/PPTX 走
 *    `DeliverableHost`，两处的内核存储都是**进程内**、与主内核存储**并存**（`http.ts` 的
 *    `/completion` 注释里写着这是事实）。本套件不把它们说成"同一份真相源"。
 * 4. **不使用模型、不连真机、不碰 Office**：`createDemoServer` 只给 `POTBOT_RUN_DIR`，
 *    模型未配置 ⇒ 模型端口如实为 `null`；**真机与消费端（手机 / Word / Excel / PowerPoint）
 *    打开验证未做** —— "文件能被目标软件打开"属第三层证据，本轮**未验证**。
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildDocxTemplate,
  DOCX_TITLE_BODY_PRESENTATION,
  renderDocxFactValue,
} from '../../../src/artifacts/templates/docx.js';
import { findFactInvalidatedArtifacts } from '../../../src/artifacts/index.js';
import {
  buildMultiArtifactTransaction,
  checkTransactionView,
  type SharedFactUpdate,
  type TransactionObservation,
} from '../../../src/facts/index.js';
import {
  captureFactVersion,
  createFactVersionGate,
  createMemoryFactVersionLedger,
  type FactVersionView,
} from '../../../src/scheduler/fact-version-gate.js';
import {
  asArtifactRef,
  asFactRef,
  asGroupId,
  asInstanceId,
  asLogicalTime,
  asRevision,
  asRunId,
  asTaskId,
  createArtifactRecord,
  createSharedFactRecord,
  createTaskRecord,
  currentFactByKey,
  type ArtifactRecord,
  type FactRef,
  type GroupId,
  type KnownFactValue,
  type RunId,
  type SharedFactRecord,
} from '../../../src/protocol/index.js';
import { createDecisionBubble, prepareAction } from '../../../src/workledger/index.js';
import {
  bytesEqual,
  getBytes,
  getJson,
  partText,
  postJson,
  sha256Of,
  startProduct,
  zipEntryMap,
  zipEntryNames,
  type Json,
  type RunningProduct,
} from './e2e-full-chain-harness.js';

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
  expect(entryNames, 'OOXML 包必有 [Content_Types].xml').toContain('[Content_Types].xml');
  expect(entryNames, 'OOXML 包必有包级关系 _rels/.rels').toContain('_rels/.rels');
  expect(entryNames, `${format} 包内应有主部件 ${MAIN_PART[format]}`).toContain(MAIN_PART[format]);
  for (const other of ['docx', 'xlsx', 'pptx'] as const) {
    if (other === format) continue;
    expect(
      entryNames,
      `${format} 包里不得出现 ${other} 的主部件 ${MAIN_PART[other]}（格式互不冒充）`,
    ).not.toContain(MAIN_PART[other]);
  }
}

// ---------------------------------------------------------------------------
// 夹具常量
// ---------------------------------------------------------------------------

const TASK = asTaskId('T-fullchain');
/** 共享事实登记在**同一个任务版本**上：`F8` 被 `F10` **取代**（supersede），这是本套件的事实版本语义。 */
const REV = asRevision(2);
const INSTANCE = asInstanceId('I-fullchain');
const F_HEAD_8 = asFactRef('F-fc-headcount-8');
const F_HEAD_10 = asFactRef('F-fc-headcount-10');
/** 与人数无关的另一条事实（"无关信息不重写"的反向对照用）。 */
const F_BUDGET = asFactRef('F-fc-budget');
const FACT_KEY = 'headcount';
const AT = asLogicalTime(10);

const DOCX_SESSION = 'fc-docx';
const XLSX_SESSION = 'fc-xlsx';
const PPTX_SESSION = 'fc-pptx';
const REJECT_SESSION = 'fc-xlsx-reject';

function numberFact(factId: FactRef, amount: number, detail: string, supersedes: FactRef | null): SharedFactRecord {
  return createSharedFactRecord({
    fact_id: factId,
    task_id: TASK,
    task_revision: REV,
    fact_key: FACT_KEY,
    value: { kind: 'known', value: { type: 'number', amount, unit: '人', currency: null } },
    source: { kind: 'user_confirmation', detail },
    confirmed_by: INSTANCE,
    confirmed_at: AT,
    ...(supersedes === null ? {} : { supersedes_fact_id: supersedes }),
  });
}

/** 一条 `KnownFactSnapshotEntry`（模板构建器只吃这个形状，没有"顺手传个数"的位置）。 */
function snapshotEntryOf(fact: SharedFactRecord): {
  readonly fact_ref: FactRef;
  readonly fact_key: string;
  readonly value: KnownFactValue;
  readonly source: SharedFactRecord['source'];
} {
  if (fact.value.kind !== 'known') {
    throw new Error(`夹具事实 ${String(fact.fact_id)} 不是已知值：${fact.value.kind}`);
  }
  return { fact_ref: fact.fact_id, fact_key: fact.fact_key, value: fact.value.value, source: fact.source };
}

/** 产物的内核记录夹具（用**真实** `createArtifactRecord`；`source_fact_refs` 是本组的判据输入）。 */
function artifactFixture(input: {
  readonly id: string;
  readonly kind: 'document' | 'spreadsheet' | 'presentation';
  readonly facts: readonly FactRef[];
  readonly status?: 'published' | 'superseded';
}): ArtifactRecord {
  return createArtifactRecord({
    artifact_id: asArtifactRef(input.id),
    task_id: TASK,
    task_revision: REV,
    artifact_version: 1,
    template_kind: input.kind,
    byte_length: 1024,
    content_digest: 'd'.repeat(64),
    source_fact_refs: input.facts,
    created_by_instance_id: INSTANCE,
    status: input.status ?? 'published',
    verifications: [{ kind: 'structural_self_check', outcome: 'pass', detail: '夹具：结构自检通过' }],
    receipt: {
      final_path: `/out/${input.id}`,
      readback_digest: 'd'.repeat(64),
      verifier: 'fa-e2e-full-chain fixture',
      at: AT,
    },
    created_at: AT,
  });
}

/** 一次共享事实更新（一句话的机器形式）：`headcount` 从旧事实换成新事实。 */
const HEADCOUNT_UPDATE: readonly SharedFactUpdate[] = [
  { fact_key: FACT_KEY, previous_fact_id: F_HEAD_8, new_fact_id: F_HEAD_10 },
];

// ---------------------------------------------------------------------------
// 共享状态（本文件内的用例**按声明顺序**执行；跨组的判据依赖同一批产物）
// ---------------------------------------------------------------------------

let workDir: string;
let main: RunningProduct;

/** 当前事实的**渲染文本**（由内核自己的渲染器给出，不是夹具里手写的字符串）。 */
let headcountText = '';
/** 当前事实的数值（10）与旧事实的数值（8）。 */
let headcountNow = 0;
let headcountBefore = 0;
/**
 * 当前事实的 **id**：由产品 HTTP 路由**确定性派生**（`F-<20 位十六进制>`），
 * 不再等于夹具里手写的 `F_HEAD_10` —— 换版是经 `POST /api/facts/:key` 做的。
 */
const HEADCOUNT_NEW_FACT_UNSET = asFactRef('F-http-facts-unset');
let headcountNowFactId: FactRef = HEADCOUNT_NEW_FACT_UNSET;

/** 三格式的交付字节（下载面原始字节）。 */
const delivered: Record<'docx' | 'xlsxFinal' | 'xlsxBaseline' | 'pptxFinal' | 'pptxBaseline', Uint8Array> = {
  docx: new Uint8Array(0),
  xlsxFinal: new Uint8Array(0),
  xlsxBaseline: new Uint8Array(0),
  pptxFinal: new Uint8Array(0),
  pptxBaseline: new Uint8Array(0),
};
let docxSourceBytes: Uint8Array = new Uint8Array(0);
let docxFinalDigest = '';
/** 内核交付记录里的产物 id（从产品对象上读回来，证明"交付确实落了内核"）。 */
let docxArtifactId = '';
let xlsxFinalRevision = 0;

const notes: string[] = [];

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'potbot-e2e-full-chain-'));
  main = await startProduct(join(workDir, 'run-main'));
}, 60_000);

afterAll(async () => {
  if (main !== undefined) await main.close();
  if (workDir !== undefined) rmSync(workDir, { recursive: true, force: true });
}, 60_000);

// ===========================================================================
// 0. 一句话改共享事实（人数 8 → 10）
// ===========================================================================

describe('0. 一句话改共享事实：人数 8 → 10', () => {
  it('0-1 任务与旧事实（headcount = 8）登记在产品服务的**内核真相源**上', () => {
    const store = main.demo.host.store;
    store.transact((tx) => {
      tx.putTask(
        createTaskRecord({
          task_id: TASK,
          goal: '跨模板全链：把人数由八人改为十人，三个产物同版、无关内容不重写',
          revision: REV,
          created_at: AT,
          updated_at: AT,
        }),
      );
      tx.putSharedFact(
        createSharedFactRecord({
          fact_id: F_BUDGET,
          task_id: TASK,
          task_revision: REV,
          fact_key: 'budget.total',
          value: { kind: 'known', value: { type: 'number', amount: 60000, unit: '元', currency: null } },
          source: { kind: 'user_confirmation', detail: '用户确认（与人数无关的对照事实）' },
          confirmed_by: INSTANCE,
          confirmed_at: AT,
        }),
      );
      tx.putSharedFact(numberFact(F_HEAD_8, 8, '用户确认：八人', null));
    });

    const facts = store.snapshot().shared_facts;
    const current = currentFactByKey(facts, { task_id: TASK, task_revision: REV, fact_key: FACT_KEY });
    expect(current, '旧事实应当是当前事实').toBeDefined();
    expect(current?.fact_id).toBe(F_HEAD_8);
    headcountBefore = (current?.value.kind === 'known' && current.value.value.type === 'number'
      ? current.value.value.amount
      : -1);
    expect(headcountBefore, '夹具基数是 8（不是 0，也不是缺省）').toBe(8);
    notes.push('0-1 内核真相源：task=T-fullchain r2，headcount=8 已登记');
  });

  it('0-2 用户原话经**产品入口**收下（POST /api/conversation-loop/turns → 200；同键重发不新建任务）', async () => {
    const text = '把人数从八人改成十人';
    const posted = await postJson(main.baseUrl, '/api/conversation-loop/turns', {
      conversation_id: 'conv-fullchain',
      client_id: 'fc-msg-1',
      text,
    });
    expect(posted.status, JSON.stringify(posted.json)).toBe(200);
    expect(posted.json['ok']).toBe(true);
    expect(posted.json['task_created']).toBe(true);
    const message = posted.json['message'] as Json;
    expect(typeof message['message_id']).toBe('string');
    notes.push(`0-2 POST /api/conversation-loop/turns → 200（收下原话「${text}」，task_created=true）`);

    const replayed = await postJson(main.baseUrl, '/api/conversation-loop/turns', {
      conversation_id: 'conv-fullchain',
      client_id: 'fc-msg-1',
      text,
    });
    expect(replayed.status, JSON.stringify(replayed.json)).toBe(200);
    expect(replayed.json['duplicate'], '同 client_id 重发 = 同一条消息').toBe(true);
    expect(replayed.json['task_created']).toBe(false);
    notes.push('0-2 同 client_id 重发 → 200 duplicate=true（不新建第二个任务）');
  });

  it('0-3 产品 HTTP 面**有**事实路由：GET 读当前版本，POST 版本化换版（8 → 10）', async () => {
    // 命名空间**存在**（不再是 404）：缺 task_id ⇒ 400「参数不全」。
    const noParams = await getJson(main.baseUrl, '/api/facts');
    expect(noParams.status, '缺 task_id ⇒ 400：/api/facts 命名空间存在').toBe(400);
    expect(noParams.json['code']).toBe('missing_task_id');
    // 反向对照：指名不存在的任务 ⇒ 404（不是"读到了空"）。
    const missingTask = await getJson(main.baseUrl, '/api/facts?task_id=T-no-such-task');
    expect(missingTask.status, '任务不存在 ⇒ 404').toBe(404);

    // 读：经**产品 HTTP** 读到当前版本下的 headcount = 8（同一份内核真相源）。
    const before = await getJson(main.baseUrl, `/api/facts/${FACT_KEY}?task_id=${TASK}`);
    expect(before.status, JSON.stringify(before.json)).toBe(200);
    expect(before.json['factId']).toBe(F_HEAD_8);
    expect(before.json['revision']).toBe(1);
    expect(before.json['current']).toBe(true);
    notes.push('0-3 GET /api/facts/headcount → 200（headcount=8，revision=1）');

    // 写：一句话的**机器形式**经产品入口做版本化更新（supersede 语义，旧记录保留）。
    const value10 = { kind: 'known', value: { type: 'number', amount: 10, unit: '人', currency: null } };
    const posted = await postJson(main.baseUrl, `/api/facts/${FACT_KEY}`, {
      task_id: TASK,
      expected_revision: 1,
      value: value10,
      source: { kind: 'user_confirmation', detail: '用户改口：十人' },
    });
    expect(posted.status, JSON.stringify(posted.json)).toBe(200);
    expect(posted.json['previousRevision']).toBe(1);
    expect(posted.json['revision']).toBe(2);
    expect(posted.json['supersededFactId'], '新事实的 supersedes 指向旧当前事实').toBe(F_HEAD_8);
    expect(posted.json['supersededArtifactIds'], '此刻还没有产物据此交付').toEqual([]);
    const postedFact = posted.json['fact'] as Json;
    // 产品经 HTTP 写的事实 id 是**确定性派生**（不是测试夹具里的手写常量）。
    headcountNowFactId = asFactRef(String(postedFact['factId']));
    expect(String(headcountNowFactId)).toMatch(/^F-[0-9a-f]{20}$/);
    expect(headcountNowFactId).not.toBe(F_HEAD_8);

    // 反向对照①：不带 expected_revision ⇒ 400（无版本绑定的更新一律被拒）。
    const noRevision = await postJson(main.baseUrl, `/api/facts/${FACT_KEY}`, {
      task_id: TASK,
      value: value10,
    });
    expect(noRevision.status, '无 expected_revision ⇒ 400').toBe(400);
    expect(noRevision.json['code']).toBe('missing_expected_revision');

    // 反向对照②：拿**过期版本**再写一次 ⇒ 409，且不静默覆盖（当前值仍是 10）。
    const staleWrite = await postJson(main.baseUrl, `/api/facts/${FACT_KEY}`, {
      task_id: TASK,
      expected_revision: 1,
      value: { kind: 'known', value: { type: 'number', amount: 99, unit: '人', currency: null } },
    });
    expect(staleWrite.status, '旧版本写入 ⇒ 409').toBe(409);
    expect(staleWrite.json['code']).toBe('revision_conflict');
    expect(staleWrite.json['currentRevision']).toBe(2);

    // 内核真相源里当前事实已换成 HTTP 写进来的那一条；旧事实仍在（历史不丢）。
    const facts = main.demo.host.store.snapshot().shared_facts;
    const current = currentFactByKey(facts, { task_id: TASK, task_revision: REV, fact_key: FACT_KEY });
    expect(current?.fact_id, '新事实取代旧事实 ⇒ 当前事实换成 HTTP 新写的那条').toBe(headcountNowFactId);
    expect(facts.find((fact) => fact.fact_id === F_HEAD_8), '旧事实仍保留在仓库里（历史不丢）').toBeDefined();

    // 读回：产品 HTTP 读到的当前版本与内核真相源一致（不是两条链各说各话）。
    const after = await getJson(main.baseUrl, `/api/facts/${FACT_KEY}?task_id=${TASK}`);
    expect(after.status).toBe(200);
    expect(after.json['factId']).toBe(headcountNowFactId);
    expect(after.json['revision']).toBe(2);
    const history = await getJson(main.baseUrl, `/api/facts/${FACT_KEY}/history?task_id=${TASK}`);
    expect(history.status).toBe(200);
    expect((history.json['versions'] as Json[]).map((entry) => entry['factId'])).toEqual([
      F_HEAD_8,
      headcountNowFactId,
    ]);
    const currentValue = ((after.json['value'] as Json)['value'] ?? {}) as Json;
    expect(currentValue['amount']).toBe(10);

    expect(current?.value.kind).toBe('known');
    if (current === undefined || current.value.kind !== 'known') throw new Error('当前事实不是已知值');
    expect(current.value.value.type).toBe('number');
    if (current.value.value.type !== 'number') throw new Error('当前事实不是数值');
    headcountNow = current.value.value.amount;
    headcountText = renderDocxFactValue(current.value.value);
    expect(headcountNow).toBe(10);
    expect(headcountText, '内核自己的渲染器给出当前事实的文本').toBe('10 人');
    notes.push(
      `0-3 POST /api/facts/headcount → 200（revision 1→2，supersedes=${String(F_HEAD_8)}）；` +
        `当前事实文本「${headcountText}」`,
    );
  });
});

// ===========================================================================
// A. 三种格式各自经产品入口交付（独立 ZIP 读回；格式互不冒充；数值同版）
// ===========================================================================

describe('A. DOCX / XLSX / PPTX 各自交付一次，数值取自同一事实版本', () => {
  it('A-1 DOCX：经 /api/sessions 交付；正文里的数值由**事实快照**渲染（不是夹具手写的数）', async () => {
    const facts = main.demo.host.store.snapshot().shared_facts;
    const current = currentFactByKey(facts, { task_id: TASK, task_revision: REV, fact_key: FACT_KEY });
    if (current === undefined) throw new Error('当前事实缺失：不得用 0 冒充（P3）');

    // 模板构建器**没有数字参数位**：正文里的数字只能指认到快照事实（P6 数字边界）。
    // 正文里那句话的值取自**当前事实的渲染结果**（`headcountText` 不是夹具里手写的字符串）。
    const source = buildDocxTemplate({
      requirement: {
        title: '季度人员汇报',
        description: '',
        paragraphs: [`本季度${FACT_KEY}: ${headcountText}`, '预算与排期另行说明', '请审阅后回复'],
        presentation: DOCX_TITLE_BODY_PRESENTATION,
      },
      fact_snapshot: [snapshotEntryOf(current)],
      references: [{ label: '来源', detail: '跨模板全链夹具' }],
    });
    docxSourceBytes = new Uint8Array(source.bytes);

    const created = await postJson(main.baseUrl, '/api/sessions', {
      sessionId: DOCX_SESSION,
      filename: '季度人员汇报.docx',
      mode: 'new',
      docxBase64: Buffer.from(source.bytes).toString('base64'),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    docxArtifactId = ''; // 交付后才会有

    const edited = await postJson(main.baseUrl, `/api/sessions/${DOCX_SESSION}/edits`, {
      idempotencyKey: 'fc-docx-1',
      baseRevision: created.json['editRevision'],
      baseDigest: created.json['contentDigest'],
      intent: { steps: [{ range: '第2段', operation: { kind: 'setAlignment', alignment: 'center' } }] },
    });
    expect(edited.status, JSON.stringify(edited.json)).toBe(200);
    const version = edited.json['version'] as Json;
    expect(version['editRevision']).toBe(1);
    docxArtifactId = String(version['artifactId']);
    docxFinalDigest = String(version['contentDigest']);

    const download = await getBytes(main.baseUrl, `/api/sessions/${DOCX_SESSION}/versions/1/download`);
    expect(download.status, 'DOCX 下载面').toBe(200);
    expect(download.contentType, 'Content-Type 必须是该版自己的 MIME').toBe(OFFICIAL_MIME.docx);
    expect(download.headers.get('x-content-sha256')).toBe(docxFinalDigest);
    delivered.docx = download.bytes;
    expect(sha256Of(delivered.docx), '响应体必须与响应头摘要一致').toBe(docxFinalDigest);

    const names = zipEntryNames(delivered.docx);
    expectFormatExclusive(names, 'docx');
    expect(partText(delivered.docx, MAIN_PART.docx), '正文含当前事实文本').toContain(headcountText);
    expect(partText(delivered.docx, MAIN_PART.docx), '正文不含旧事实文本').not.toContain('8 人');
    notes.push(
      `A-1 POST /api/sessions → 201；POST /edits → 200（rev=1，artifact=${docxArtifactId}）；` +
        `GET /versions/1/download → 200（${OFFICIAL_MIME.docx}，正文含「${headcountText}」）`,
    );
  });

  it('A-2 XLSX：经 /api/deliverables 交付；人数格写的是**当前事实的数值**', async () => {
    const created = await postJson(main.baseUrl, '/api/deliverables', {
      sessionId: XLSX_SESSION,
      deliverableId: 'fc-xlsx-1',
      filename: '季度台账.xlsx',
      format: 'xlsx',
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    expect(created.json['templateKind']).toBe('spreadsheet');
    let revision = created.json['editRevision'] as number;
    let digest = created.json['contentDigest'] as string;

    /** 逐步交付：每一步的基线都用**上一步回执**里的版本与摘要。 */
    const step = async (key: string, edit: unknown): Promise<Json> => {
      const outcome = await postJson(main.baseUrl, `/api/deliverables/${XLSX_SESSION}/edits`, {
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

    // 1) 建"明细"表并写一行 —— 这一张表之后**不该再被重写**（无关内容不重写的基线）。
    await step('fc-xlsx-1', { op: 'add_sheet', name: '明细' });
    await step('fc-xlsx-2', {
      op: 'set_cell',
      sheet: '明细',
      address: 'A1',
      value: { kind: 'text', value: '备注' },
    });
    delivered.xlsxBaseline = (
      await getBytes(main.baseUrl, `/api/deliverables/${XLSX_SESSION}/versions/${String(revision)}/download`)
    ).bytes;

    // 2) 只改 Sheet1：人数格写**当前事实的数值**。
    await step('fc-xlsx-3', {
      op: 'set_cell',
      sheet: 'Sheet1',
      address: 'A1',
      value: { kind: 'text', value: FACT_KEY },
    });
    const version = await step('fc-xlsx-4', {
      op: 'set_cell',
      sheet: 'Sheet1',
      address: 'B1',
      value: { kind: 'number', value: headcountNow },
    });
    expect(version['fileFormat']).toBe('xlsx');
    expect(version['mimeType']).toBe(OFFICIAL_MIME.xlsx);
    xlsxFinalRevision = revision;

    const download = await getBytes(main.baseUrl, `/api/deliverables/${XLSX_SESSION}/versions/${String(revision)}/download`);
    expect(download.status, 'XLSX 下载面').toBe(200);
    expect(download.contentType).toBe(OFFICIAL_MIME.xlsx);
    expect(download.contentType).not.toBe(OFFICIAL_MIME.pptx);
    expect(download.contentType).not.toBe(OFFICIAL_MIME.docx);
    expect(download.headers.get('x-potbot-file-format')).toBe('xlsx');
    delivered.xlsxFinal = download.bytes;
    expect(sha256Of(delivered.xlsxFinal)).toBe(String(version['contentDigest']));

    expectFormatExclusive(zipEntryNames(delivered.xlsxFinal), 'xlsx');
    const sheet1 = partText(delivered.xlsxFinal, 'xl/worksheets/sheet1.xml');
    expect(sheet1, '人数格的值 = 当前事实的数值').toContain(`>${String(headcountNow)}<`);
    expect(sheet1, 'A1 的标签是事实键').toContain(FACT_KEY);
    notes.push(
      `A-2 POST /api/deliverables → 201；4 次 POST /edits → 200（末版 rev=${String(revision)}）；` +
        `GET /versions/${String(revision)}/download → 200（xlsx；Sheet1!B1=${String(headcountNow)}）`,
    );
  });

  it('A-3 PPTX：经 /api/deliverables 交付；首页标题写的是**当前事实的文本**', async () => {
    const created = await postJson(main.baseUrl, '/api/deliverables', {
      sessionId: PPTX_SESSION,
      deliverableId: 'fc-pptx-1',
      filename: '季度汇报.pptx',
      format: 'pptx',
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    expect(created.json['templateKind']).toBe('presentation');
    let revision = created.json['editRevision'] as number;
    let digest = created.json['contentDigest'] as string;

    const step = async (key: string, edit: unknown): Promise<Json> => {
      const outcome = await postJson(main.baseUrl, `/api/deliverables/${PPTX_SESSION}/edits`, {
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

    await step('fc-pptx-1', { op: 'add_slide', title: `${FACT_KEY}: ${headcountText}` });
    await step('fc-pptx-2', { op: 'add_slide', title: '预算说明' });
    delivered.pptxBaseline = (
      await getBytes(main.baseUrl, `/api/deliverables/${PPTX_SESSION}/versions/${String(revision)}/download`)
    ).bytes;

    const version = await step('fc-pptx-3', { op: 'add_slide', title: '结论' });
    expect(version['fileFormat']).toBe('pptx');
    expect(version['mimeType']).toBe(OFFICIAL_MIME.pptx);

    const download = await getBytes(main.baseUrl, `/api/deliverables/${PPTX_SESSION}/versions/${String(revision)}/download`);
    expect(download.status, 'PPTX 下载面').toBe(200);
    expect(download.contentType).toBe(OFFICIAL_MIME.pptx);
    expect(download.contentType).not.toBe(OFFICIAL_MIME.xlsx);
    expect(download.contentType).not.toBe(OFFICIAL_MIME.docx);
    expect(download.headers.get('x-potbot-file-format')).toBe('pptx');
    delivered.pptxFinal = download.bytes;
    expect(sha256Of(delivered.pptxFinal)).toBe(String(version['contentDigest']));

    expectFormatExclusive(zipEntryNames(delivered.pptxFinal), 'pptx');
    const slide1 = partText(delivered.pptxFinal, 'ppt/slides/slide1.xml');
    expect(slide1, '首页标题含当前事实文本').toContain(headcountText);
    expect(slide1).not.toContain('8 人');
    notes.push(
      `A-3 POST /api/deliverables → 201；3 次 POST /edits → 200（末版 rev=${String(revision)}）；` +
        `GET /versions/${String(revision)}/download → 200（pptx；slide1 含「${headcountText}」）`,
    );
  });

  it('A-4 三个产物同版：数值都等于**当前事实版本**的值，且都不是旧版本的值；三份字节两两不同', () => {
    // 数值来源的**唯一**判据：与内核真相源里当前事实的渲染结果一致。
    expect(headcountText).toBe('10 人');
    const docxText = partText(delivered.docx, MAIN_PART.docx);
    const xlsxText = partText(delivered.xlsxFinal, 'xl/worksheets/sheet1.xml');
    const pptxText = partText(delivered.pptxFinal, 'ppt/slides/slide1.xml');
    for (const [format, text] of [['docx', docxText], ['xlsx', xlsxText], ['pptx', pptxText]] as const) {
      expect(text, `${format} 必须含当前事实值`).toContain(String(headcountNow));
      expect(text, `${format} 不得含旧事实值 8 人`).not.toContain('8 人');
    }
    // 三份字节互不相同（不是同一份字节换个名字）。
    const digests = new Set([sha256Of(delivered.docx), sha256Of(delivered.xlsxFinal), sha256Of(delivered.pptxFinal)]);
    expect(digests.size, '三份字节的摘要必须互不相同').toBe(3);
    notes.push('A-4 三格式数值均 = 当前事实版本（10 人）；三份字节摘要两两不同');
  });

  it('A-5 三个产物在内核交付存储里各有一条**已发布**记录，且都绑定了一条来源事实', () => {
    const records: readonly ArtifactRecord[] = [
      ...main.demo.sessions!.kernelArtifactList(),
      ...main.demo.deliverables!.kernelArtifactList(),
    ];
    const kinds = new Set(records.map((record) => record.template_kind));
    for (const kind of ['document', 'spreadsheet', 'presentation'] as const) {
      expect(kinds, `内核里应有 ${kind} 的产物记录`).toContain(kind);
    }
    const published = records.filter((record) => record.status === 'published');
    expect(published.length).toBeGreaterThanOrEqual(3);
    for (const record of published) {
      expect(
        record.source_fact_refs.length,
        `产物 ${String(record.artifact_id)} 必须绑定来源事实（内核要求 source_fact_refs 非空）`,
      ).toBeGreaterThan(0);
      expect(record.receipt, '已发布产物必须有回执').not.toBeNull();
    }
    notes.push(
      `A-5 内核交付存储：${String(published.length)} 条 published 记录，三条主记录各绑定来源事实 ` +
        `（docx=${String(main.demo.sessions!.kernelArtifactList().length)} 条 / xlsx+pptx=${String(
          main.demo.deliverables!.kernelArtifactList().length,
        )} 条）`,
    );
  });
});

// ===========================================================================
// B. 同版绑定与"旧版本事实"冲突（内核闸门；无产品 HTTP 路由 —— 如实登记）
// ===========================================================================

describe('B. 同版绑定（内核闸门）：旧版本事实必须被判冲突', () => {
  it('B-1 绑定捕获：旧版视图（headcount = F8）与当前视图（headcount = HTTP 新写的那条）摘要不同', () => {
    // 0-3 必须真的经 HTTP 换过版，否则这条会拿哨兵去比而**失败**（不允许静默通过）。
    expect(headcountNowFactId, '0-3 应已经由 POST /api/facts 换过版').not.toBe(HEADCOUNT_NEW_FACT_UNSET);
    const facts = main.demo.host.store.snapshot().shared_facts;
    // 产出者在换版**之前**读到的事实视图（旧版）：只看得见 F8。
    const staleView = captureFactVersion({
      task_id: TASK,
      task_revision: REV,
      facts: facts.filter((fact) => fact.fact_id === F_HEAD_8),
      dependency_digest: 'dep-1',
    });
    // 换版之后的事实视图（当前版）：当前事实是 F10。
    const currentView = captureFactVersion({
      task_id: TASK,
      task_revision: REV,
      facts,
      dependency_digest: 'dep-1',
    });
    const bindingOf = (view: FactVersionView, key: string): string | undefined =>
      view.facts.find((entry) => entry.fact_key === key)?.fact_id;
    expect(bindingOf(staleView, FACT_KEY), '旧版视图里 headcount 指向 F8').toBe(F_HEAD_8);
    expect(bindingOf(currentView, FACT_KEY), '当前视图里 headcount 指向换版后的那条事实').toBe(
      headcountNowFactId,
    );
    expect(staleView.facts.length, '旧版视图只看得见换版前那一条事实').toBe(1);
    expect(
      currentView.facts.map((entry) => entry.fact_key),
      '当前视图按 fact_key 升序带上了仓库里看得见的全部事实键',
    ).toEqual(['budget.total', FACT_KEY]);
    expect(staleView.digest).not.toBe(currentView.digest);
    notes.push(
      `B-1 旧版绑定 headcount=${String(F_HEAD_8)}（1 条）、当前绑定 headcount=${String(
        headcountNowFactId,
      )}（含 budget.total），两份摘要不同`,
    );
  });

  it('B-2 【反向对照】人为让 **PPTX 用旧版本事实** ⇒ 判冲突（stale_fact_binding）；三格式同版才放行', () => {
    const facts = main.demo.host.store.snapshot().shared_facts;
    const ledger = createMemoryFactVersionLedger();
    const gate = createFactVersionGate(undefined, ledger);
    const currentView = ledger.registerTask({
      task_id: TASK,
      task_revision: REV,
      facts,
      dependency_digest: 'dep-1',
    });
    // 产出者据以计算的**旧版**绑定（换版前读到的那个视图）。
    const staleBinding: FactVersionView = captureFactVersion({
      task_id: TASK,
      task_revision: REV,
      facts: facts.filter((fact) => fact.fact_id === F_HEAD_8),
      dependency_digest: 'dep-1',
    });

    const slotKeys = ['docx', 'xlsx', 'pptx'] as const;

    /**
     * 一次提交尝试：取锁 → 提交 → **释放锁**。
     *
     * 释放是必须的：被拒的提交**零状态变更**（含锁不自动释放），不释放会让下一次取同一槽位的锁失败。
     */
    const attempt = (
      artifactKey: string,
      binding: FactVersionView,
      artifactRef: string,
    ): ReturnType<typeof gate.commit> => {
      const key = { task_id: TASK, artifact_key: artifactKey };
      const fence = gate.acquire(key, { group_id: asGroupIdSafe(), instance_id: INSTANCE }, AT);
      expect(fence, `取得 ${artifactKey} 槽位的资源锁`).not.toBeNull();
      if (fence === null) throw new Error(`拿不到 ${artifactKey} 的锁`);
      try {
        return gate.commit({
          key,
          produced_by_group: asGroupIdSafe(),
          produced_by_instance: INSTANCE,
          round: { run_id: asRunIdSafe(), task_revision: REV },
          base_artifact_version: 0,
          binding,
          artifact_ref: asArtifactRef(artifactRef),
          fence,
          at: AT,
        });
      } finally {
        gate.release(fence);
      }
    };

    // ① **人为让 PPTX 用旧版本事实** ⇒ 必须被判冲突（这一条就是 §9 的反向对照）。
    const pptxStale = attempt('pptx', staleBinding, 'ppt-stale');
    expect(pptxStale.ok, 'PPTX 依据旧版本事实 ⇒ 必须被拒').toBe(false);
    if (pptxStale.ok) throw new Error('不该放行');
    expect(pptxStale.reason).toBe('stale_fact_binding');
    expect(pptxStale.detail).toContain(String(F_HEAD_8));

    // 三个槽位一律如此（不是只对 PPTX 特判）。
    for (const artifactKey of slotKeys) {
      const rejected = attempt(artifactKey, staleBinding, `stale-${artifactKey}`);
      expect(rejected.ok, `${artifactKey} 依据旧版本事实 ⇒ 必须被拒`).toBe(false);
      if (rejected.ok) throw new Error('不该放行');
      expect(rejected.reason, `${artifactKey} 的拒因`).toBe('stale_fact_binding');
    }

    // ② 三格式都用**同一份当前版绑定** ⇒ 全部放行，且绑定摘要唯一（"同版"）。
    const accepted: string[] = [];
    for (const artifactKey of slotKeys) {
      const committed = attempt(artifactKey, currentView, `current-${artifactKey}`);
      expect(committed.ok, `${artifactKey} 用当前版绑定应当放行`).toBe(true);
      if (!committed.ok) throw new Error(committed.detail);
      expect(committed.artifact_version).toBe(1);
      accepted.push(artifactKey);
    }
    notes.push(
      `B-2 【反向对照】旧版绑定对 docx/xlsx/pptx 三个槽位均被拒（reason=stale_fact_binding，detail 指认 ${String(
        F_HEAD_8,
      )}）；` +
        `当前版绑定（digest ${currentView.digest.slice(0, 12)}…）三槽位放行：${accepted.join('，')}`,
    );
  });

  it('B-3 事实改了 ⇒ 引用了被取代事实的产物可被标出；无关产物不在结果里', () => {
    const facts = main.demo.host.store.snapshot().shared_facts;
    const artifacts: readonly ArtifactRecord[] = [
      artifactFixture({ id: 'art-0-docx', kind: 'document', facts: [F_HEAD_8] }),
      artifactFixture({ id: 'art-1-xlsx', kind: 'spreadsheet', facts: [F_HEAD_8] }),
      artifactFixture({ id: 'art-2-pptx', kind: 'presentation', facts: [F_HEAD_8] }),
      artifactFixture({ id: 'art-3-unrelated', kind: 'spreadsheet', facts: [F_BUDGET] }),
    ];
    const invalidated = findFactInvalidatedArtifacts(artifacts, facts);
    expect(invalidated.map((record) => String(record.artifact_id))).toEqual([
      'art-0-docx',
      'art-1-xlsx',
      'art-2-pptx',
    ]);
    expect(invalidated.map((record) => String(record.artifact_id))).not.toContain('art-3-unrelated');
    notes.push('B-3 事实 → 产物失效索引：3 个引用旧事实的产物被标出，无关产物不在结果里');
  });
});

// ===========================================================================
// C. 无关内容不重写
// ===========================================================================

describe('C. 无关内容不重写', () => {
  it('C-1 DOCX：改了第 2 段之后，**除主部件外的每个部件逐字节不变**', () => {
    const before = zipPartsOf(docxSourceBytes);
    const after = zipPartsOf(delivered.docx);
    expect(before.has(MAIN_PART.docx)).toBe(true);
    expect(after.has(MAIN_PART.docx)).toBe(true);
    expect(
      bytesEqual(before.get(MAIN_PART.docx) ?? new Uint8Array(), after.get(MAIN_PART.docx) ?? new Uint8Array()),
      '主部件（正文）**必须**变了',
    ).toBe(false);

    let compared = 0;
    for (const [name, bytes] of before) {
      if (name === MAIN_PART.docx) continue;
      const other = after.get(name);
      expect(other, `部件 ${name} 在交付版里应当仍在（不得被丢掉）`).toBeDefined();
      expect(bytesEqual(bytes, other ?? new Uint8Array()), `部件 ${name} 必须逐字节不变`).toBe(true);
      compared += 1;
    }
    expect(compared, '至少要比对一个非主部件（否则"逐字节不变"是空话）').toBeGreaterThan(0);
    notes.push(`C-1 DOCX：主部件变更；其余 ${String(compared)} 个部件逐字节不变`);
  });

  it('C-2 XLSX：只改 Sheet1 之后，**明细表部件逐字节不变**（未受影响的工作表不被重写）', () => {
    const before = zipPartsOf(delivered.xlsxBaseline);
    const after = zipPartsOf(delivered.xlsxFinal);
    const unrelated = 'xl/worksheets/sheet2.xml';
    expect(before.get(unrelated), '基线里应有明细表部件').toBeDefined();
    expect(after.get(unrelated), '交付版里应有明细表部件').toBeDefined();
    expect(
      bytesEqual(before.get(unrelated) ?? new Uint8Array(), after.get(unrelated) ?? new Uint8Array()),
      '未受影响的工作表必须逐字节不变',
    ).toBe(true);
    expect(
      bytesEqual(
        before.get('xl/worksheets/sheet1.xml') ?? new Uint8Array(),
        after.get('xl/worksheets/sheet1.xml') ?? new Uint8Array(),
      ),
      '被改的那张表**必须**变了（否则这次编辑是空操作）',
    ).toBe(false);
    notes.push('C-2 XLSX：sheet1.xml 变更；无关的 sheet2.xml（明细）逐字节不变');
  });

  it('C-3 PPTX：加了第 3 页之后，**前两页部件逐字节不变**', () => {
    const before = zipPartsOf(delivered.pptxBaseline);
    const after = zipPartsOf(delivered.pptxFinal);
    for (const unrelated of ['ppt/slides/slide1.xml', 'ppt/slides/slide2.xml']) {
      expect(before.get(unrelated), `基线里应有 ${unrelated}`).toBeDefined();
      expect(after.get(unrelated), `交付版里应有 ${unrelated}`).toBeDefined();
      expect(
        bytesEqual(before.get(unrelated) ?? new Uint8Array(), after.get(unrelated) ?? new Uint8Array()),
        `未受影响的页 ${unrelated} 必须逐字节不变`,
      ).toBe(true);
    }
    expect(zipEntryNames(delivered.pptxFinal)).toContain('ppt/slides/slide3.xml');
    expect(zipEntryNames(delivered.pptxBaseline)).not.toContain('ppt/slides/slide3.xml');
    notes.push('C-3 PPTX：新增第 3 页；未受影响的前两页逐字节不变');
  });

  it('C-4 【反向对照】事务视图：无关产物被重写 / 该改的没改 / 旧气泡被执行 ⇒ 三条都被抓到', () => {
    const facts = main.demo.host.store.snapshot().shared_facts;
    const artifacts: readonly ArtifactRecord[] = [
      artifactFixture({ id: 'art-0-docx', kind: 'document', facts: [F_HEAD_8] }),
      artifactFixture({ id: 'art-1-xlsx', kind: 'spreadsheet', facts: [F_HEAD_8] }),
      artifactFixture({ id: 'art-2-pptx', kind: 'presentation', facts: [F_HEAD_8] }),
      artifactFixture({ id: 'art-3-unrelated', kind: 'spreadsheet', facts: [F_BUDGET] }),
    ];
    const action = prepareAction({
      action_id: 'act-fc-1',
      task_id: TASK,
      // 气泡绑在**旧版本**上（REV-1）⇒ 版本已推进 ⇒ stale_bubble ⇒ 过期。
      task_revision: asRevision(REV - 1),
      action_kind: 'send_document',
      params: { to: 'a@b.com' },
      authorization: {
        source: 'user_session',
        user_approved: true,
        task_revision: asRevision(REV - 1),
        revoked: false,
        subject_instance_id: INSTANCE,
        granted_at: AT,
      },
      at: AT,
    });
    const bubble = createDecisionBubble(action, 'bub-fc-old', AT);

    const view = buildMultiArtifactTransaction({
      instruction: {
        instruction_id: 'instr-fc-1',
        utterance: '把人数从八人改成十人',
        task_id: TASK,
        from_revision: asRevision(REV - 1),
        to_revision: REV,
        at: AT,
      },
      updates: HEADCOUNT_UPDATE,
      artifacts,
      bubbles: [bubble],
      actions: [action],
      facts,
    });

    expect(view.fact_changes.map((change) => change.fact_key)).toEqual([FACT_KEY]);
    expect(view.artifact_entries.map((entry) => String(entry.artifact_id))).toEqual([
      'art-0-docx',
      'art-1-xlsx',
      'art-2-pptx',
    ]);
    expect(view.untouched_artifact_ids.map(String)).toEqual(['art-3-unrelated']);
    expect(view.totals.artifacts_updated).toBe(3);
    expect(view.totals.artifacts_untouched).toBe(1);
    expect(view.totals.bubbles_expired).toBe(1);
    expect(view.bubble_entries[0]?.reason).toBe('stale_bubble');

    // 应然 vs 实然：干净的实然 ⇒ 零违规。
    const clean: TransactionObservation = {
      updated_artifact_ids: ['art-0-docx', 'art-1-xlsx', 'art-2-pptx'].map((id) => asArtifactRef(id)),
      executed_bubble_ids: [],
    };
    expect(checkTransactionView(view, clean)).toEqual([]);

    // 反例①：无关产物被重写。
    const rewrote = checkTransactionView(view, {
      updated_artifact_ids: [...clean.updated_artifact_ids, asArtifactRef('art-3-unrelated')],
    });
    expect(rewrote.map((entry) => entry.code)).toContain('unrelated_artifact_rewritten');

    // 反例②：受影响产物漏改（PPTX 没更新）。
    const missing = checkTransactionView(view, {
      updated_artifact_ids: ['art-0-docx', 'art-1-xlsx'].map((id) => asArtifactRef(id)),
    });
    expect(missing.map((entry) => entry.code)).toContain('affected_artifact_missing');

    // 反例③：旧气泡被执行。
    const executed = checkTransactionView(view, {
      updated_artifact_ids: clean.updated_artifact_ids,
      executed_bubble_ids: ['bub-fc-old'],
    });
    expect(executed.map((entry) => entry.code)).toContain('expired_bubble_executed');
    notes.push('C-4 事务视图：无关不重写（untouched=1）；三条反例（无关被重写/漏改/旧气泡被执行）全被抓到');
  });

  it('C-5 【反向对照】DOCX 数字边界：正文写 10 人、事实快照仍是 8 人 ⇒ 构建期即拒（旧版事实不得配新数字）', () => {
    const facts = main.demo.host.store.snapshot().shared_facts;
    const stale = facts.find((fact) => fact.fact_id === F_HEAD_8);
    if (stale === undefined) throw new Error('夹具缺旧事实');
    // 正文里的"10 人"指认不到旧快照（只有 8 人）⇒ 必须拒。
    expect(() =>
      buildDocxTemplate({
        requirement: {
          title: '季度人员汇报',
          description: '',
          paragraphs: ['当前人数为 10 人', '预算与排期另行说明', '请审阅后回复'],
        },
        fact_snapshot: [snapshotEntryOf(stale)],
        references: [{ label: '来源', detail: '跨模板全链夹具' }],
      }),
    ).toThrow(/[0-9]+|数字/);
    notes.push('C-5 反向对照：快照=旧版(8 人) 而正文=10 人 ⇒ DOCX 构建器拒绝（数字指认不到事实）');
  });
});

// ===========================================================================
// D. 完成口径（绑当前版本才算交付；S-1026-01 最小复现）
// ===========================================================================

describe('D. 完成口径：产物绑当前版本才算交付；被拒的编辑不得报"已完成且成功"', () => {
  it('D-1 连续交付 4 版 ⇒ 只有**当前版本**那一版算"已交付"，结论是"已完成且成功"', async () => {
    const view = await getJson(main.baseUrl, `/api/deliverables/${XLSX_SESSION}/completion`);
    expect(view.status, JSON.stringify(view.json)).toBe(200);
    expect(view.json['completed']).toBe(true);
    expect(view.json['label']).toBe('completed_and_successful');
    expect(view.json['labelText']).toBe('已完成且成功');
    const counts = view.json['counts'] as Json;
    expect(counts['workItems'], '4 次交付尝试 = 4 条工作项').toBe(4);
    expect(counts['artifactsDelivered'], '4 版产物里只有当前版本算"已交付"').toBe(1);
    const deliveredIds = view.json['deliveredArtifactIds'] as readonly string[];
    expect(deliveredIds.length).toBe(1);
    notes.push(
      `D-1 GET /api/deliverables/${XLSX_SESSION}/completion → 200 ` +
        `completed=true label=completed_and_successful；counts.artifactsDelivered=1（工作项 4 条）`,
    );
  });

  it('D-2 S-1026-01 最小复现：**被拒的编辑**让完成视图不报"已完成且成功"（真实 HTTP）', async () => {
    const created = await postJson(main.baseUrl, '/api/deliverables', {
      sessionId: REJECT_SESSION,
      deliverableId: 'fc-xlsx-reject-1',
      filename: '被拒编辑.xlsx',
      format: 'xlsx',
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const baseRevision = created.json['editRevision'] as number;
    const baseDigest = created.json['contentDigest'] as string;

    const ok = await postJson(main.baseUrl, `/api/deliverables/${REJECT_SESSION}/edits`, {
      idempotencyKey: 'fc-reject-ok',
      baseRevision,
      baseDigest,
      edit: { op: 'add_sheet', name: '甲' },
    });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);

    // 基线过期 ⇒ 409（内核不产出新版本）。
    const rejected = await postJson(main.baseUrl, `/api/deliverables/${REJECT_SESSION}/edits`, {
      idempotencyKey: 'fc-reject-bad',
      baseRevision,
      baseDigest,
      edit: { op: 'add_sheet', name: '乙' },
    });
    expect(rejected.status, '过期基线必须 409').toBe(409);

    const completion = await getJson(main.baseUrl, `/api/deliverables/${REJECT_SESSION}/completion`);
    expect(completion.status).toBe(200);
    const flags = completion.json['flags'] as Json;
    // 对照：历史产物确实在（不是"没有产物所以不成功"）。
    expect(flags['hasDeliveredArtifact']).toBe(true);
    // 但被拒的编辑必须让成功结论落空。
    expect(completion.json['label'], '被拒的编辑不得推出"已完成且成功"').not.toBe('completed_and_successful');
    expect(completion.json['label']).toBe('completed_with_unfinished_business');
    expect(flags['anyWorkItemFailed']).toBe(true);
    expect((completion.json['counts'] as Json)['workItems']).toBe(2);
    notes.push(
      `D-2 POST /edits 成功 → 200；过期基线 POST /edits → 409；` +
        `GET /completion → 200 label=completed_with_unfinished_business（anyWorkItemFailed=true）`,
    );
  });

  it('D-3 S-1026-01 字面复现：空工作集 + 历史产物 ⇒ 经 /api/tasks/:id/completion **不报成功**', async () => {
    const taskId = 'T-fc-s1026-01';
    // 夹具：任务 + 一条**已发布**产物，**没有任何工作项 / 轮次 / 动作**（旧实现会因 `[].every(...)` 误报）。
    main.demo.host.store.transact((tx) => {
      tx.putTask(
        createTaskRecord({
          task_id: asTaskId(taskId),
          goal: 'S-1026-01 空工作集复现任务',
          revision: REV,
          created_at: AT,
          updated_at: AT,
        }),
      );
      tx.putArtifact(
        createArtifactRecord({
          artifact_id: asArtifactRef('A-fc-s1026-01'),
          task_id: asTaskId(taskId),
          task_revision: REV,
          artifact_version: 1,
          template_kind: 'spreadsheet',
          byte_length: 4,
          content_digest: 'f'.repeat(64),
          source_fact_refs: [F_HEAD_10],
          created_by_instance_id: INSTANCE,
          status: 'published',
          verifications: [{ kind: 'version_match', outcome: 'pass', detail: '复现夹具（版本一致）' }],
          receipt: {
            final_path: '/tmp/fixture.xlsx',
            readback_digest: 'f'.repeat(64),
            verifier: 'fa-e2e-full-chain fixture',
            at: AT,
          },
          created_at: AT,
        }),
      );
    });

    const completion = await getJson(main.baseUrl, `/api/tasks/${taskId}/completion`);
    expect(completion.status, JSON.stringify(completion.json)).toBe(200);
    expect((completion.json['flags'] as Json)['hasDeliveredArtifact']).toBe(true);
    expect((completion.json['counts'] as Json)['artifactsDelivered']).toBe(1);
    expect((completion.json['predicates'] as Json)['allWorkItemsTerminal']).toBe(false);
    expect(completion.json['completed']).toBe(false);
    expect(completion.json['label']).toBe('not_completed');
    notes.push(
      'D-3 GET /api/tasks/T-fc-s1026-01/completion → 200 completed=false label=not_completed ' +
        '（历史产物在，但空工作集不被当作"全部终态"）',
    );
  });

  it('D-4 完成口径只读：写方法一律 405（没有"把任务置为完成"的入口）', async () => {
    const target = `/api/deliverables/${XLSX_SESSION}/completion`;
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const response = await fetch(`${main.baseUrl}${target}`, { method });
      expect(response.status, `${method} ${target} 不该被接受`).toBe(405);
    }
    notes.push('D-4 POST/PUT/DELETE → 405（完成是派生结论，不可写入）');
  });
});

// ===========================================================================
// E. 落盘（换服务实例）
// ===========================================================================

describe('E. 落盘：换服务实例、同运行目录仍可读；换独立目录读不到', () => {
  it('E-1 同一运行目录：任务 / 动作 / **DOCX 产物** / **XLSX 交付**在**全新服务实例**上仍可读', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'potbot-e2e-fc-persist-'));
    const otherDir = mkdtempSync(join(tmpdir(), 'potbot-e2e-fc-other-'));
    const TASK_ID = 'T-fc-persist';
    const SESSION_ID = 'fc-persist-docx';
    let actionId = '';
    let bytesInA: Uint8Array = new Uint8Array(0);
    // XLSX 交付链的落盘/重开判据（FA-DELIVERABLE-RESTART）：重启前后比字节与版本历史。
    let delivRevision = 0;
    let delivBytes: Uint8Array = new Uint8Array(0);

    const processA = await startProduct(runDir);
    try {
      processA.demo.host.store.transact((tx) => {
        tx.putTask(
          createTaskRecord({
            task_id: asTaskId(TASK_ID),
            goal: '跨实例落盘核对',
            revision: asRevision(1),
            created_at: AT,
            updated_at: AT,
          }),
        );
      });

      const created = await postJson(processA.baseUrl, '/api/adapters/actions', {
        tool: 'clock',
        actionKind: 'alarm.create',
        taskId: TASK_ID,
        taskRevision: 1,
        params: { hour: 7, minute: 30, label: '起床' },
        authorization: { source: 'user_bubble', userApproved: true },
      });
      expect(created.status, JSON.stringify(created.json)).toBe(201);
      actionId = String((created.json['action'] as Json)['action_id']);

      const session = await postJson(processA.baseUrl, '/api/sessions', {
        sessionId: SESSION_ID,
        filename: '落盘核对.docx',
        mode: 'new',
        docxBase64: Buffer.from(docxSourceBytes).toString('base64'),
      });
      expect(session.status, JSON.stringify(session.json)).toBe(201);
      const edit = await postJson(processA.baseUrl, `/api/sessions/${SESSION_ID}/edits`, {
        idempotencyKey: 'fc-persist-1',
        baseRevision: session.json['editRevision'],
        baseDigest: session.json['contentDigest'],
        intent: { steps: [{ range: '第1段', operation: { kind: 'setAlignment', alignment: 'center' } }] },
      });
      expect(edit.status, JSON.stringify(edit.json)).toBe(200);
      bytesInA = (await getBytes(processA.baseUrl, `/api/sessions/${SESSION_ID}/versions/1/download`)).bytes;
      expect(bytesInA.byteLength).toBeGreaterThan(0);

      // 交付会话（xlsx）也建一个 —— 与 DOCX 同一套落盘/重开判据（FA-DELIVERABLE-RESTART）。
      const deliv = await postJson(processA.baseUrl, '/api/deliverables', {
        sessionId: 'fc-persist-xlsx',
        deliverableId: 'fc-persist-xlsx-1',
        filename: '落盘核对.xlsx',
        format: 'xlsx',
      });
      expect(deliv.status, JSON.stringify(deliv.json)).toBe(201);
      const delivEdit = await postJson(processA.baseUrl, '/api/deliverables/fc-persist-xlsx/edits', {
        idempotencyKey: 'fc-persist-x',
        baseRevision: deliv.json['editRevision'],
        baseDigest: deliv.json['contentDigest'],
        edit: { op: 'add_sheet', name: '明细' },
      });
      expect(delivEdit.status, JSON.stringify(delivEdit.json)).toBe(200);
      delivRevision = delivEdit.json['editRevision'] as number;
      delivBytes = (
        await getBytes(
          processA.baseUrl,
          `/api/deliverables/fc-persist-xlsx/versions/${String(delivRevision)}/download`,
        )
      ).bytes;
      expect(delivBytes.byteLength).toBeGreaterThan(0);
    } finally {
      await processA.close();
    }

    // ---- 进程 B：**全新 store + 全新服务**，只共享同一个运行目录 ----
    const processB = await startProduct(runDir);
    try {
      const task = await getJson(processB.baseUrl, `/api/tasks/${TASK_ID}/completion`);
      expect(task.status, JSON.stringify(task.json)).toBe(200);
      const action = await getJson(processB.baseUrl, `/api/adapters/actions/${actionId}`);
      expect(action.status, JSON.stringify(action.json)).toBe(200);
      expect((action.json['action'] as Json)['task_id']).toBe(TASK_ID);

      const session = await getJson(processB.baseUrl, `/api/sessions/${SESSION_ID}`);
      expect(session.status, JSON.stringify(session.json)).toBe(200);
      expect(session.json['restoredFromDisk'], '这份状态是**从落盘恢复**的，不是内存里本来就有').toBe(true);
      const bytesInB = await getBytes(processB.baseUrl, `/api/sessions/${SESSION_ID}/versions/1/download`);
      expect(bytesInB.status).toBe(200);
      expect(bytesEqual(bytesInA, bytesInB.bytes), '重启后下载到的字节与重启前逐字节相同').toBe(true);

      // 交付会话（xlsx）与 DOCX **同一套**落盘/重开判据（FA-DELIVERABLE-RESTART）：
      // 曾经是"如实登记 404"（内核存储进程内），现在落盘到主内核存储 ⇒ 200 且字节逐字节相同。
      const delivAfter = await getJson(processB.baseUrl, '/api/deliverables/fc-persist-xlsx');
      expect(delivAfter.status, `交付会话必须随重启恢复: ${JSON.stringify(delivAfter.json)}`).toBe(200);
      expect((delivAfter.json['versions'] as readonly Json[]).length, '版本历史读得回来').toBe(delivRevision);
      const delivBytesInB = await getBytes(
        processB.baseUrl,
        `/api/deliverables/fc-persist-xlsx/versions/${String(delivRevision)}/download`,
      );
      expect(delivBytesInB.status).toBe(200);
      expect(bytesEqual(delivBytes, delivBytesInB.bytes), '重启后交付字节与重启前逐字节相同').toBe(true);
      notes.push(
        `E-1 同目录换实例：任务/动作/DOCX 产物/XLSX 交付均 200（DOCX 与 XLSX 的 versions/` +
          `${String(delivRevision)}/download 字节逐字节相同）；交付会话 ${String(delivAfter.status)}`,
      );
    } finally {
      await processB.close();
    }

    // ---- 反例：**另一个**运行目录（独立树）里没有这些东西 ----
    const processC = await startProduct(otherDir);
    try {
      const task = await getJson(processC.baseUrl, `/api/tasks/${TASK_ID}/completion`);
      expect(task.status).toBe(404);
      const action = await getJson(processC.baseUrl, `/api/adapters/actions/${actionId}`);
      expect(action.status).toBe(404);
      const session = await getJson(processC.baseUrl, `/api/sessions/${SESSION_ID}`);
      expect(session.status).toBe(404);
      notes.push('E-1 换独立目录：任务/动作/会话 均 404（读不到，反向对照成立）');
    } finally {
      await processC.close();
    }

    rmSync(runDir, { recursive: true, force: true });
    rmSync(otherDir, { recursive: true, force: true });
  }, 120_000);

  it('E-2 实测状态码汇总（证迹入口；本套件未验证的边界一并列出）', () => {
    // eslint-disable-next-line no-console
    console.log(['', '===== FA-E2E-FULL-CHAIN 实测记录 =====', ...notes, '', '===== 结束 ====='].join('\n'));
    expect(notes.length, '至少要有若干条实测记录').toBeGreaterThan(0);
    // 未验证边界（不得由本套件推出"已验证"）：真机 / 手机 App / Word·Excel·PowerPoint 打开。
    expect(OFFICIAL_MIME.docx.startsWith('application/vnd.openxmlformats')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 部件的原始字节表（独立 ZIP 读取器给出；此处只借用，不复制解析逻辑）。 */
function zipPartsOf(bytes: Uint8Array): ReadonlyMap<string, Uint8Array> {
  return zipEntryMap(bytes);
}

/** 槽位身份的合法品牌值（测试自造；闸门只要求非空）。 */
function asGroupIdSafe(): GroupId {
  return asGroupId('G-fc');
}
function asRunIdSafe(): RunId {
  return asRunId('R-fc');
}
