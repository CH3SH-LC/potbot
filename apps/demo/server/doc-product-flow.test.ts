/**
 * **文档工作流产品端到端**（工作包 FA-DOC-PRODUCT-WORKFLOW）。
 *
 * ## 本套件要证明的命题（逐条对应任务）
 *
 * 1. **经真实 HTTP 走完一条完整链路**：导入 → 改正文 → 写回 → 插表格 → 加分页符 →
 *    加分节符类型 → 加自定义栏宽 → 加页脚页码域 → 导出 → 重新导入 → 读回核对。
 *    每一步都有**真实字节与真实状态码**（记录在 `FlowStep` 里，逐条断言）。
 * 2. **分页符 / 分节符类型双向可读回成立**（导出 XML 有、重新导入后产品读回同一值）；
 *    **自定义栏宽成立**——曾实测到产品级缺陷：只改栏宽时导出器把唯一的变化吞掉，导出 XML 里
 *    连 `w:cols` 都没有。**该缺陷本轮已修**，本套件改用正例断言（`w:cols`（num=2/equalWidth=0）
 *    ＋两条 `w:col` 宽度），并在内核层把"只有栏宽变"这一支单独钉住。
 *    仍存在的**导入侧缺口**（未修，如实断言）：重新导入后 `w:cols/@w:num` 读得回、
 *    逐栏 `w:col` 宽度读不回模型。
 * 3. **页码必须是域而不是字面量**（断言导出包里是 `w:fldSimple/@w:instr` 或 `w:instrText`）。
 * 4. **反向对照**：越界合并 / 悬空引用必须被拒（结构化 4xx，不是"成功但没做"）。
 * 5. **落盘**：换一个服务实例、同一运行目录 ⇒ 同一份产物仍可读回（不是进程内存）。
 * 6. 读回用**本套件自带的独立 ZIP 解析器**（`doc-product-flow.ts`），**不复用产品自检器**。
 *
 * ## 为什么经 `createDemoServer`（而不是直接调路由模块）
 *
 * 任务要求"产品上真能走完"。`createDemoServer` 就是产品入口：它按 `POTBOT_RUN_DIR` 建
 * **落盘的内核存储**，装配会话 / 交付 / 文档产物端口，并把 `documentsRoutes` 交给
 * `createDemoRequestHandler`。本套件只把它 `listen(0, 127.0.0.1)`，**不替换任何一层**。
 *
 * ## ⚠️ 如实标注（结果不得编造）
 *
 * - **Word 打开核对本轮不做** ⇒ 渲染效果一律**未验证（需消费端）**。
 * - **实测边界（仍未修）**：自定义栏宽 `w:col` 在 `模型 → 文件` 方向成立，在 `文件 → 模型`
 *   （重新导入）方向**不成立**（导入器只读 `w:cols/@w:num`）。本套件把这条边界**断言出来**
 *   （`reimported_custom_columns === null`），而不是假装通过。
 * - 真机 / 浏览器 / 真实 Office **未验证**。
 *
 * 【模型身份】交付说明：本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { buildDocxTemplate, DOCX_TITLE_BODY_PRESENTATION } from '../../../src/artifacts/templates/docx.js';
import { exportDocx, importDocx } from '../../../src/documents/docx/index.js';
import { applyCustomColumns, insertPageBreakIn } from '../../../src/documents/page-workflow.js';
import { createDemoServer } from './main.js';
import {
  attributeOf,
  customColumnsSurviveReimport,
  findTags,
  pageFieldEvidence,
  readZipText,
  runDocumentProductFlow,
  sha256Of,
  zipEntryNames,
  zipPartsMatching,
  type DocumentFlowResult,
  type FlowStep,
} from './doc-product-flow.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** 真实可导入的 DOCX（**不含数字**，避免触发可追溯性闸门）。 */
function fixtureDocx(): Uint8Array {
  return buildDocxTemplate({
    requirement: {
      title: '文档工作流产品端到端',
      description: '这是一份用于文档工作流产品端到端自证的正文，不含数字。',
      paragraphs: ['第一段正文内容', '第二段正文内容', '第三段正文内容'],
      presentation: DOCX_TITLE_BODY_PRESENTATION,
    },
    fact_snapshot: [],
    references: [],
  }).bytes;
}

const RUN_ROOT = mkdtempSync(join(tmpdir(), 'potbot-doc-product-flow-'));

interface Running {
  readonly runDir: string;
  readonly base: string;
  close(): Promise<void>;
}

/** 经**产品入口**起一个真实服务（`createDemoServer` + `listen(0, 127.0.0.1)`）。 */
async function startProduct(runDir: string): Promise<Running> {
  const demo = await createDemoServer({ POTBOT_RUN_DIR: runDir });
  const server: Server = demo.server;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    runDir,
    base: `http://127.0.0.1:${String(address.port)}`,
    close: (): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined || error === null ? resolve() : reject(error)));
      }),
  };
}

async function postJson(
  base: string,
  path: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

async function getJson(base: string, path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

const DOC_ID = 'flow-doc-1';
const REIMPORT_ID = 'flow-doc-1-re';
const PRE_IMPORT_ID = 'flow-doc-1-cols';
const SESSION_ID = 'flow-session-1';
const RUN_DIR = join(RUN_ROOT, 'documents');

/** twips 换算（1 mm = 1440/25.4 twips）；**本套件自己算**，不 import 产品换算器。 */
const mmToTwips = (mm: number): number => (mm * 1440) / 25.4;
/** 产品读回页边距用的是 pt（1 mm = 72/25.4 pt）；同样本套件自己算。 */
const mmToPt = (mm: number): number => (mm * 72) / 25.4;

let run: Running;
let result: DocumentFlowResult;

afterAll(() => {
  try {
    rmSync(RUN_ROOT, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响判据 */
  }
});

// ===========================================================================
// 1. 一条完整链路（真实 HTTP + 真实字节 + 真实状态码）
// ===========================================================================

describe('FA-DOC-PRODUCT-WORKFLOW：产品端到端一条完整链路', () => {
  it('导入 → 改正文 → 写回 → 插表格 → 分页符 → 节类型 → 栏宽 → 页脚域 → 导出 → 重新导入 → 读回', async () => {
    run = await startProduct(RUN_DIR);
    result = await runDocumentProductFlow({
      base: run.base,
      document_id: DOC_ID,
      reimport_document_id: REIMPORT_ID,
      pre_import_document_id: PRE_IMPORT_ID,
      session_id: SESSION_ID,
      filename: '端到端文档.docx',
      fixture: fixtureDocx(),
    });

    // 每一步都真的打过产品 HTTP。
    const byStep = new Map<string, FlowStep>(result.steps.map((step) => [step.step, step]));
    expect(byStep.get('documents.status')?.status).toBe(200);
    expect(byStep.get('documents.import')?.status).toBe(200);
    expect(byStep.get('session.open')?.status).toBe(201);
    expect(byStep.get('session.edit_body')?.status).toBe(200);
    expect(byStep.get('session.download_body')?.status).toBe(200);
    expect(byStep.get('documents.write_back')?.status).toBe(200);
    expect(byStep.get('documents.table_insert')?.status).toBe(200);
    expect(byStep.get('documents.table_column_width')?.status).toBe(200);
    expect(byStep.get('documents.table_merge')?.status).toBe(200);
    expect(byStep.get('documents.page_break')?.status).toBe(200);
    expect(byStep.get('documents.section_type')?.status).toBe(200);
    expect(byStep.get('documents.custom_columns')?.status).toBe(200);
    expect(byStep.get('documents.export_pre_footer')?.status).toBe(200);
    expect(byStep.get('documents.pre_import')?.status).toBe(200);
    expect(byStep.get('documents.readback_columns_pre_footer')?.status).toBe(200);
    expect(byStep.get('documents.footer_page_field')?.status).toBe(200);
    expect(byStep.get('documents.export')?.status).toBe(200);
    expect(byStep.get('documents.reimport')?.status).toBe(200);
    expect(byStep.get('documents.reimport_export')?.status).toBe(200);
    expect(byStep.get('documents.readback_section')?.status).toBe(200);
    expect(byStep.get('documents.readback_columns')?.status).toBe(200);
    expect(byStep.get('documents.readback_footer')?.status).toBe(200);

    // 每一步都有真实字节（有字节的步骤）与真实摘要。
    expect(result.edited_bytes.byteLength).toBeGreaterThan(0);
    expect(result.exported_bytes.byteLength).toBeGreaterThan(0);
    expect(result.reimported_bytes.byteLength).toBeGreaterThan(0);
    expect(byStep.get('documents.export')?.digest).toBe(sha256Of(result.exported_bytes));
    expect(byStep.get('documents.export')?.bytes).toBe(result.exported_bytes.byteLength);

    // 改正文确实改动了字节（下载字节 ≠ 夹具字节）。
    expect(sha256Of(result.edited_bytes)).not.toBe(sha256Of(fixtureDocx()));
    // 结构操作确实改动了字节（导出 ≠ 写回时的那一份）。
    expect(sha256Of(result.exported_bytes)).not.toBe(sha256Of(result.edited_bytes));

    // 导出的是**合法 DOCX 包**（独立 ZIP 解析器读数）。
    const names = zipEntryNames(result.exported_bytes);
    expect(names).toContain('[Content_Types].xml');
    expect(names).toContain('word/document.xml');
  }, 120000);

  it('落盘：换一个服务实例、同一运行目录 ⇒ 同一份产物仍读得回（不是进程内存）', async () => {
    const before = await getJson(run.base, `/api/documents/${DOC_ID}/export`);
    expect(before.status).toBe(200);
    const digestOnDisk = before.json['digest'] as string;
    expect(digestOnDisk).toBe(sha256Of(result.exported_bytes));

    await run.close();
    // 内存全空的第二个实例：只能靠落盘字节回答。
    const second = await startProduct(RUN_DIR);
    run = second;
    try {
      const summary = await getJson(second.base, `/api/documents/${DOC_ID}/summary`);
      expect(summary.status, JSON.stringify(summary.json)).toBe(200);
      expect(summary.json['digest']).toBe(digestOnDisk);

      const exported = await getJson(second.base, `/api/documents/${DOC_ID}/export?body=1`);
      expect(exported.status).toBe(200);
      const bytes = new Uint8Array(Buffer.from(exported.json['docx_base64'] as string, 'base64'));
      expect(sha256Of(bytes)).toBe(digestOnDisk);
      // 独立解析器再次核对：读回来的仍是合法 DOCX。
      expect(zipEntryNames(bytes)).toContain('word/document.xml');
    } finally {
      // 后续用例继续用这个实例。
    }
  }, 120000);
});

// ===========================================================================
// 2. 分页符 / 分节符类型：双向可读回成立；自定义栏宽：实测缺陷（如实断言 + 根因）
// ===========================================================================

describe('FA-DOC-PRODUCT-WORKFLOW：页/节双向可读回；栏宽与页脚相关缺陷（本轮已修，改断言正例）', () => {
  it('分页符：导出 XML 里是 w:br@w:type="page"；重新导入后仍在（双向）', () => {
    const exportedXml = readZipText(result.exported_bytes, 'word/document.xml');
    expect(exportedXml).not.toBeNull();
    const pageBreaks = findTags(exportedXml as string, 'w:br').filter(
      (tag) => attributeOf(tag, 'w:type') === 'page',
    );
    expect(pageBreaks.length, '导出 XML 里没有分页符').toBeGreaterThan(0);

    // 方向二：把导出的字节重新导入再导出，分页符**仍在**（模型 ↔ 文件两个方向都成立）。
    const reimportedXml = readZipText(result.reimported_bytes, 'word/document.xml');
    expect(reimportedXml).not.toBeNull();
    const reimportedBreaks = findTags(reimportedXml as string, 'w:br').filter(
      (tag) => attributeOf(tag, 'w:type') === 'page',
    );
    expect(reimportedBreaks.length, '重新导入后分页符丢了').toBeGreaterThan(0);
  });

  it('分节符类型：导出 XML 里是 w:type@w:val="continuous"；重新导入后产品读回同一值', () => {
    const exportedXml = readZipText(result.exported_bytes, 'word/document.xml');
    const sectionTypes = findTags(exportedXml as string, 'w:type').filter(
      (tag) => attributeOf(tag, 'w:val') === 'continuous',
    );
    expect(sectionTypes.length, '导出 XML 里没有分节符类型 continuous').toBeGreaterThan(0);

    // 方向二：产品自己重新导入后**读回**同一个类型（`pages snapshot` 的 `start_type`）。
    const snapshot = result.responses['documents.readback_section'] ?? {};
    const detail = (snapshot['detail'] as Record<string, unknown> | undefined) ?? {};
    expect(detail['start_type']).toBe('continuous');
    const section = (detail['section'] as Record<string, unknown> | undefined) ?? {};
    expect(section['start_type']).toBe('continuous');
  });

  it('自定义栏宽经产品 HTTP 真的写进文件：导出 XML 里有 w:cols（num=2, equalWidth=0）与两条 w:col 宽度', async () => {
    // 接口层仍报 200 + `changed_sections:[0]`（路由确实改了）。
    const setOp = result.responses['documents.custom_columns'] ?? {};
    expect(setOp['ok']).toBe(true);
    expect((setOp['detail'] as Record<string, unknown> | undefined)?.['changed_sections']).toEqual([0]);

    // 修复前（缺陷①）：只改栏宽时导出器把唯一的变化吞掉，导出 XML 里连 `w:cols` 都没有。
    // 现在**必须**真的落进文件：一个带子元素的 `w:cols`（`num=2`、`equalWidth=0`）＋两条 `w:col`。
    const preFooterXml = readZipText(result.pre_footer_bytes, 'word/document.xml') as string;
    const cols = findTags(preFooterXml, 'w:cols');
    expect(cols, '导出里必须有 w:cols（缺陷已修：不再被吞掉）').toHaveLength(1);
    expect(attributeOf(cols[0] as never, 'w:num')).toBe('2');
    expect(attributeOf(cols[0] as never, 'w:equalWidth')).toBe('0');
    expect(cols[0]?.self_closing, '自定义栏宽必须带 w:col 子元素，不能是空 w:cols').toBe(false);

    // 逐栏宽度按 twips 写出（本套件自己换算期望值，不用产品换算器）。
    const written = findTags(preFooterXml, 'w:col').map((tag) => ({
      width: Number(attributeOf(tag, 'w:w') ?? 'NaN'),
      space: Number(attributeOf(tag, 'w:space') ?? 'NaN'),
    }));
    expect(written, '两条自定义栏宽都要落盘').toHaveLength(2);
    for (const col of written) {
      expect(Math.abs(col.width - mmToTwips(60))).toBeLessThanOrEqual(1);
      expect(Math.abs(col.space - mmToTwips(5))).toBeLessThanOrEqual(1);
    }
    // 独立量尺读出的字节事实，与驱动器读出的同一份字节一致。
    expect(result.custom_columns_in_file).toEqual(written);
    expect(customColumnsSurviveReimport(result.pre_footer_bytes)).toBe(true);

    // 未变的既有边界（导入侧缺口，本轮未动）：`w:cols/@w:num` 读得回（count=2），
    // 但逐栏 `w:col` 宽度读不回模型 ⇒ `reimported_custom_columns` 仍为 `null`（不假装）。
    expect(result.pre_import_equal_columns).toBe(2);
    expect(result.reimported_equal_columns).toBe(2);
    expect(result.reimported_custom_columns).toBeNull();

    // 加页脚后的最终导出：栏数（`w:cols/@w:num`）仍在；逐栏 `w:col` 宽度仍不随附——
    // 这是上面那条导入侧缺口的**剩余面**，不是缺陷①（缺陷① 是"连 w:cols 都没有"）。
    const finalXml = readZipText(result.exported_bytes, 'word/document.xml') as string;
    const finalCols = findTags(finalXml, 'w:cols');
    expect(finalCols).toHaveLength(1);
    expect(attributeOf(finalCols[0] as never, 'w:num')).toBe('2');
    expect(findTags(finalXml, 'w:col')).toHaveLength(0);
  });

  it('内核层隔离：只有栏宽变（正文不动）时，w:cols 也一样写出（缺陷①的根因已被修）', () => {
    // 修复前：只有栏宽变 ⇒ 导出里没有 w:cols；栏宽 + 正文一起变 ⇒ 才有。根因在
    // `collectParts()` 的"未改动 ⇒ 写原始字节"判据——它把 `section_columns` 同时用在
    // 重建侧与重解析原始字节侧，两边互相抵消。
    // 修复后：**两个分支都必须写出 w:cols**——本条钉住"只有栏宽变"这一支。
    const columns = [
      { width: { unit: 'mm' as const, value: 60 }, space: { unit: 'mm' as const, value: 5 } },
      { width: { unit: 'mm' as const, value: 60 }, space: { unit: 'mm' as const, value: 5 } },
    ];
    const docXmlOf = (bytes: Uint8Array): string => readZipText(bytes, 'word/document.xml') as string;

    const onlyColumns = docXmlOf(exportDocx(applyCustomColumns(importDocx(fixtureDocx()), 0, columns)));
    const onlyCols = findTags(onlyColumns, 'w:cols').filter((tag) => attributeOf(tag, 'w:equalWidth') === '0');
    expect(onlyCols, '只改栏宽也必须写出 w:cols（缺陷①的根因已修）').toHaveLength(1);
    expect(attributeOf(onlyCols[0] as never, 'w:num')).toBe('2');
    const onlyWritten = findTags(onlyColumns, 'w:col').map((tag) => Number(attributeOf(tag, 'w:w') ?? 'NaN'));
    expect(onlyWritten).toHaveLength(2);
    for (const width of onlyWritten) {
      expect(Math.abs(width - mmToTwips(60))).toBeLessThanOrEqual(1);
    }

    const base = importDocx(fixtureDocx());
    const firstBlock = base.blocks[0];
    expect(firstBlock).toBeDefined();
    let counter = 0;
    const withBodyChange = insertPageBreakIn(base, (firstBlock as { id: string }).id, 0, () => `pb-${String(counter++)}`);
    const both = exportDocx(applyCustomColumns(withBodyChange, 0, columns));
    const cols = findTags(docXmlOf(both), 'w:cols').filter((tag) => attributeOf(tag, 'w:equalWidth') === '0');
    expect(cols.length).toBeGreaterThan(0);
    expect(attributeOf(cols[0] as never, 'w:num')).toBe('2');
    // 逐栏宽度按 twips 写出（本套件自己换算期望值）。
    const written = findTags(docXmlOf(both), 'w:col').map((tag) => Number(attributeOf(tag, 'w:w') ?? 'NaN'));
    expect(written).toHaveLength(2);
    for (const width of written) {
      expect(Math.abs(width - mmToTwips(60))).toBeLessThanOrEqual(1);
    }
  });

  it('【反向对照】越界合并被拒：结构化 422 invalid_index（不是"成功但没做"）', async () => {
    const tableId = result.table_ids[0];
    expect(tableId).toBeDefined();
    const outOfBounds = await postJson(run.base, `/api/documents/${REIMPORT_ID}/table`, {
      operation: { kind: 'merge', table_id: tableId, region: { top: 0, left: 0, rows: 99, columns: 99 } },
    });
    // 重新导入的文档里表还在（换个 id 也要能定位）。
    expect([200, 422]).toContain(outOfBounds.status);
    const original = await postJson(run.base, `/api/documents/${DOC_ID}/table`, {
      operation: { kind: 'merge', table_id: tableId, region: { top: 0, left: 0, rows: 99, columns: 99 } },
    });
    expect(original.status).toBe(422);
    expect(original.json['code']).toBe('invalid_index');
  });

  it('文档带页脚引用后，pages 写操作仍成功：200 + changed_sections 可读 + 真的改了页边距（缺陷②已修）', async () => {
    // 修复前：根因在内核 `page-workflow.ts`——`changedSectionIndices()` 会序列化 `w:sectPr`，
    // 而 `extrasOfSection()` 不给 `relationshipIdOf` ⇒ 带页眉/页脚引用的节当场抛
    // `DocxError(missing_section_reference_part)`，于是任何 pages 写操作都 500。
    // 修复后：这条序列化路径把关系引用一并带上，写操作必须成功且真的落盘。
    const sectionOf = (body: Record<string, unknown>): Record<string, unknown> =>
      ((body['detail'] as Record<string, unknown> | undefined)?.['section'] ?? {}) as Record<string, unknown>;

    // 写入前先读一次（既作基线，又证明"读取型"操作从来不受缺陷影响）。
    const snapshotBefore = await postJson(run.base, `/api/documents/${DOC_ID}/pages`, {
      operation: { kind: 'snapshot', section_index: 0 },
    });
    expect(snapshotBefore.status).toBe(200);
    const digestBefore = snapshotBefore.json['digest'];

    // 设一个**非默认**的页边距（30mm 恰好是默认值 ⇒ 那种写法即使"成功"也测不出有没有真写）。
    const afterFooterWrite = await postJson(run.base, `/api/documents/${DOC_ID}/pages`, {
      operation: {
        kind: 'set_margins',
        scope: { kind: 'current', index: 0 },
        margins: {
          top: { unit: 'mm', value: 37 },
          right: { unit: 'mm', value: 25 },
          bottom: { unit: 'mm', value: 25 },
          left: { unit: 'mm', value: 25 },
        },
      },
    });
    expect(afterFooterWrite.status).toBe(200);
    expect(afterFooterWrite.json['ok']).toBe(true);
    // 改动面可读（与「缺陷②」时响应体只有一个错误码形成对照）。
    const changedDetail = (afterFooterWrite.json['detail'] as Record<string, unknown> | undefined) ?? {};
    expect(changedDetail['changed_sections']).toEqual([0]);
    // 写操作真的产出了新字节（不是"成功但没做"）。
    expect(afterFooterWrite.json['bytes']).toBeGreaterThan(0);
    expect(afterFooterWrite.json['digest']).not.toBe(digestBefore);
    // 渲染口径没变：仍需消费端验证，产品不替它背书。
    expect(afterFooterWrite.json['render_verification']).toBe('unverified');

    // 读回核对：页边距就是刚设的那个值（产品单位是 pt，本套件自己换算）。
    const snapshotAfter = await postJson(run.base, `/api/documents/${DOC_ID}/pages`, {
      operation: { kind: 'snapshot', section_index: 0 },
    });
    expect(snapshotAfter.status).toBe(200);
    const marginsAfter = sectionOf(snapshotAfter.json)['margins'] as
      | Record<string, { unit: string; value: number } | undefined>
      | undefined;
    const marginValue = (edge: string): number => {
      const found = marginsAfter?.[edge];
      if (found === undefined) throw new Error(`读回的节快照里没有 ${edge} 页边距`);
      return found.value;
    };
    expect(Math.abs(marginValue('top') - mmToPt(37))).toBeLessThanOrEqual(0.5);
    expect(Math.abs(marginValue('left') - mmToPt(25))).toBeLessThanOrEqual(0.5);
    // 分节符类型在这一路上没被顺手改掉（缺陷② 只涉及"带引用也能序列化"）。
    expect(sectionOf(snapshotAfter.json)['start_type']).toBe('continuous');
  });

  it('【反向对照】悬空引用被拒：审计报 missing_target；挂不存在的页脚部件被结构化拒绝', async () => {
    const summary = await getJson(run.base, `/api/documents/${DOC_ID}/summary`);
    const paragraphId = (summary.json['paragraph_ids'] as string[])[0] as string;
    expect(paragraphId).toBeDefined();

    // ① 指向不存在书签的内部超链接 ⇒ 审计**报出来**（healthy=false，不是静默健康）。
    const audit = await postJson(run.base, `/api/documents/${DOC_ID}/references/audit`, {
      probe_bookmark: '不存在的书签',
      index: {
        hyperlinks: [
          {
            id: 'hl-dangling',
            range: { node_id: paragraphId, start: 0, end: 1 },
            target: { kind: 'internal', bookmark: '不存在的书签' },
            text: '跳转',
          },
        ],
      },
    });
    expect(audit.status).toBe(200);
    expect(audit.json['has_dangling']).toBe(true);
    expect(audit.json['healthy']).toBe(false);
    expect(audit.json['bookmark_resolvable']).toBe(false);
    const codes = (audit.json['dangling'] as { code: string }[]).map((item) => item.code);
    expect(codes).toContain('missing_target');

    // ② 挂一个**不存在**的页脚部件 ⇒ 结构化 4xx（"部件不在包里"必须当场拒绝）。
    const danglingAttach = await postJson(run.base, `/api/documents/${DOC_ID}/header-footer`, {
      operation: {
        kind: 'attach',
        role: 'footer',
        variant: 'default',
        part_path: 'word/footer-does-not-exist.xml',
        scope: { kind: 'current', index: 0 },
      },
    });
    expect(danglingAttach.status).toBeGreaterThanOrEqual(400);
    expect(danglingAttach.status).toBeLessThan(500);
    expect(typeof danglingAttach.json['code']).toBe('string');
  });
});

// ===========================================================================
// 3. 页码必须是域而不是字面量
// ===========================================================================

describe('FA-DOC-PRODUCT-WORKFLOW：页码必须是域（不是字面量）', () => {
  it('导出包里的页脚部件含 PAGE 域（w:fldSimple 或 w:instrText），且**不是**整段数字', () => {
    const footerParts = zipPartsMatching(result.exported_bytes, /^word\/footer\d*\.xml$/);
    expect(footerParts.length, '导出包里没有页脚部件').toBeGreaterThan(0);

    let anyField = false;
    for (const part of footerParts) {
      const xml = new TextDecoder('utf-8').decode(part.bytes);
      const evidence = pageFieldEvidence(xml);
      if (evidence.has_page_field) {
        anyField = true;
        // 两种合法写法之一：简单域 `w:fldSimple/@w:instr` 或复杂域 `w:instrText`。
        const forms = [...evidence.fldSimple, ...evidence.instrText];
        expect(forms.some((value) => /\bPAGE\b/.test(value))).toBe(true);
      }
      // **不是字面量**：页脚里不得出现"整段就是数字"的 w:t（`<w:t>7</w:t>`）。
      const literalOnly = /<w:t[^>]*>\s*\d+\s*<\/w:t>/g.exec(xml);
      expect(literalOnly, `页脚里有写死的数字：${String(literalOnly?.[0])}`).toBeNull();
    }
    expect(anyField, '页脚部件里没有 PAGE 域').toBe(true);

    // 产品自己读回也认这个域（`report` 操作）。
    const report = result.responses['documents.readback_footer'] ?? {};
    expect(report['render_verification']).toBe('unverified'); // 渲染口径：未验证（需消费端）
  });

  it('【反向对照】把页码**写死成数字**被产品挡下（litera page number guard）', async () => {
    const literal = await postJson(run.base, `/api/documents/${DOC_ID}/header-footer`, {
      operation: { kind: 'part_xml', role: 'footer', content: ['1'] },
    });
    expect(literal.status).toBe(200);
    const detail = (literal.json['detail'] as Record<string, unknown> | undefined) ?? {};
    expect(detail['literal_page_number_guard']).toBe('rejected:unsupported');

    // 对照组：真正的域**不会**被挡下。
    const field = await postJson(run.base, `/api/documents/${DOC_ID}/header-footer`, {
      operation: { kind: 'part_xml', role: 'footer', content: ['第 ', { field: 'page' }, ' 页'] },
    });
    expect(field.status).toBe(200);
    const fieldDetail = (field.json['detail'] as Record<string, unknown> | undefined) ?? {};
    expect(fieldDetail['literal_page_number_guard']).toBe('no_literal_page_number');
    expect(((fieldDetail['reading'] as Record<string, unknown> | undefined) ?? {})['has_page_field']).toBe(true);
  });
});

// ===========================================================================
// 4. 独立量尺自证（不复用产品自检器）
// ===========================================================================

describe('FA-DOC-PRODUCT-WORKFLOW：读回量尺独立于产品自检器', () => {
  const source = readFileSync(new URL('./doc-product-flow.test.ts', import.meta.url), 'utf8');
  const probe = readFileSync(new URL('./doc-product-flow.ts', import.meta.url), 'utf8');
  // 拼接构造标记，避免断言自身把字符串带进被测文本（那会变成自我指涉的恒真判据）。
  const bannedSelfChecker = `selfCheck${'ArtifactBytes'}`;
  const bannedVerifierModule = `artifacts/${'verify'}.js`;

  it('本套件与驱动器都不 import 产品自检器（字节读回量尺必须独立）', () => {
    for (const [name, text] of [
      ['doc-product-flow.ts', probe],
      ['doc-product-flow.test.ts', source],
    ] as const) {
      expect(text.includes(bannedSelfChecker), `${name} 引用了产品自检器`).toBe(false);
      expect(text.includes(bannedVerifierModule), `${name} import 了 products 自检模块`).toBe(false);
    }
  });

  it('独立 ZIP 解析器真的解压出了主部件（不是只列名字）', () => {
    const documentXml = readZipText(result.exported_bytes, 'word/document.xml');
    expect(typeof documentXml).toBe('string');
    expect((documentXml as string).includes('<w:document')).toBe(true);
  });
});
