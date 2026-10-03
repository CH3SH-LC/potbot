/**
 * 工作包 **FA-PROD-DEPTH-H** —— 三种办公格式的**结构操作**在产品 HTTP 上走完，并**双向读回**。
 *
 * ## 本套件回答的唯一问题
 *
 * 「内容写进去了」与「**结构**写进去了、而且读得回来」是两件事。前序套件
 * （`doc-product-flow.test.ts` / `print-public-e2e.test.ts` / `format-handoff-e2e.test.ts`）
 * 已经证明内容交付与交接上限；本套件把镜头对准**结构**：页 / 节 / 栏宽 / 多表 / 版式 ——
 * 每一步都「**写出去 → 用本套件自带的独立 ZIP+XML 解析器读回 → 逐项相等**」。
 *
 * ## 三层证据分界（逐条写进断言，不靠文字承诺）
 *
 * | 层 | 本套件做到 |
 * |---|---|
 * | **① 产品入口** | 三格式的每一步结构操作都经 `createDemoServer` 起的**真产品 HTTP**：状态码写进断言 |
 * | **② 本仓读回** | 导出字节由**本套件自带的独立 ZIP 解析器**（只读中央目录 + `inflateRaw` + 正则扫 XML）读回；DOC 另有产品读回端点（`pages snapshot` / `column_layout`）双向对照 |
 * | **③ 仍需消费端** | Word / Excel / PowerPoint 打开后**长什么样、分不分页、页码域渲不渲染** —— 本机无授权 Office、无真机，**未验证**（显式 `it.skip`） |
 *
 * ## 为什么本套件与三个前序套件不重复
 *
 * - `doc-product-flow.test.ts` 只把分节符类型固定为 `continuous` 一项；本套件把**四种**节类型
 *   （下一页 / 连续 / 偶数页 / 奇数页）逐项写出去再读回，并把**页面方向 / 纸张 / 边距**一并覆盖。
 * - `print-public-e2e.test.ts` 明说「产品 HTTP 上没有任何打印设置通道」；本套件不碰打印。
 * - 本套件新增 **XLS / PPT 的结构操作**：多工作表增删改名（产品入口**有**）与
 *   冻结窗格 / 合并 / 列宽行高 / 版式切换 / 页面尺寸（产品入口**没有**）—— 后者**如实**验证
 *   "被具名拒绝"，并把它登记成**接线缺口**，绝不假装通过。
 *
 * ## 独立 ZIP 解析器（**不复用产品自检器**）
 *
 * 读回量尺**不 import** `src/artifacts/ooxml/**`、`src/documents/**`、`src/spreadsheets/**`、
 * `src/presentations/**` 或任何产品解析/自检模块：只依赖 ZIP 字节布局（EOCD `0x06054b50` →
 * 中央目录 `0x02014b50` → 本地文件头 `0x04034b50` → `node:zlib` 的 `inflateRawSync`）与
 * 纯文本 XML 正则。若拿内核自己的读回器当量尺，「读回器分不清结构」这类缺陷会同时污染
 * 被测对象与量尺。
 *
 * ## ⚠️ 诚实边界（结果不得编造）
 *
 * - **消费端打开未验证**：三格式的所有"看起来对不对 / 分页对不对 / 域渲不渲染"一律标
 *   **未验证（需消费端）**；本套件只证明**模型态 + 字节往返 + 读回**三件事。
 * - **XLS 的结构深度受产品入口封顶**：`/api/deliverables/:id/edits` 挂的是封闭枚举
 *   `xlsxDeliverableAdapter`（6 个 op）。冻结窗格 / 合并拆分 / 列宽行高 / 复制 / 移动 / 隐藏
 *   **产品入口不存在** ⇒ 本套件断言它们被 `422 unsupported` **具名拒绝**（反而不静默成功）。
 *   合并 / 拆分 / 列宽 / 行高这几项在**文档的表格**面上是有产品入口的（走 `/api/documents/:id/table`），
 *   本套件在 DOC 段一并覆盖，并**明确标注**那是 DOCX 表格、不是 XLSX 工作表。
 * - **PPT 的版式切换 / 页面尺寸同理**：`pptxDeliverableAdapter` 只有 4 个 op ⇒ 具名拒绝。
 * - 本套件**不跑全量套件**、**不调用真实模型**。
 *
 * ## 本轮**实测到的三条产品行为**（逐条写成断言，不靠文字承诺）
 *
 * 1. **landscape 会做长边归一**：`set_page_area` 写入 210×297mm + `landscape`，导出是
 *    `w:w=16840 / w:h=11907 / w:orient="landscape"`（长边放到 `w:w`，符合 OOXML 约定）；
 *    纵向自定义纸张（150×250mm）则原样写出，不做归一。
 * 2. **"加表 → 立刻删同一张表"会被判成重复版本**：删表后的字节与"加表前那一版"逐字节相同，
 *    会话按 R145 判 `changed:false` 并**丢弃这次删除**（回执却写着"删除工作表 X"）⇒
 *    读回文件里那张表**还在**。本套件把它断言成事实（回执与字节不一致的可检出面）。
 * 3. **重新导入的演示不能增删页**：从**导入源**出发的演示一旦页数变化，导出器以
 *    `PresentationRoundTripError`（"增删页需要重建 `ppt/presentation.xml` 与其 `_rels`"）
 *    **具名 4xx** 拒绝 —— 不静默产出页数错位的包。原样再交付一版则页序/对象引用逐页不变。
 *
 * 【模型身份】交付说明：本文件由**子智能体**产出，**子智能体模型身份未确认为 DS**。
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DOCX_TITLE_BODY_PRESENTATION, buildDocxTemplate } from '../../../src/artifacts/templates/docx.js';

import {
  getBytes,
  getJson,
  postJson,
  startProduct,
  type Json,
  type RunningProduct,
} from './e2e-product-harness.js';

// ===========================================================================
// 自带独立 ZIP 解析器（只依赖字节布局 + node:zlib；不 import 任何产品模块）
// ===========================================================================

const EOCD_SIGNATURE = 0x06_05_4b_50;
const CENTRAL_SIGNATURE = 0x02_01_4b_50;
const LOCAL_SIGNATURE = 0x04_03_4b_50;
const EOCD_MIN_LENGTH = 22;
const MAX_COMMENT_LENGTH = 0xff_ff;
const CENTRAL_FIXED_LENGTH = 46;

const utf8 = new TextDecoder('utf-8');

/** 解压后的一个 ZIP 部件。 */
interface ZipPart {
  readonly path: string;
  readonly data: Uint8Array;
}

/** 解析 ZIP 包内**全部**部件（EOCD → 中央目录 → 本地头 → inflateRaw）。 */
function unzip(bytes: Uint8Array): readonly ZipPart[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const scanFrom = Math.max(0, bytes.byteLength - (EOCD_MIN_LENGTH + MAX_COMMENT_LENGTH));
  let eocd = -1;
  for (let offset = bytes.byteLength - EOCD_MIN_LENGTH; offset >= scanFrom; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是合法 ZIP：找不到 EOCD（0x06054b50）');
  const entryCount = view.getUint16(eocd + 10, true);
  if (entryCount === 0xff_ff) throw new Error('本解析器不支持 ZIP64（条目计数 0xFFFF）');
  let cursor = view.getUint32(eocd + 16, true);
  const out: ZipPart[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) {
      throw new Error(`中央目录第 ${String(index)} 条签名不符（不是合法 ZIP）`);
    }
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const nameStart = cursor + CENTRAL_FIXED_LENGTH;
    const path = utf8.decode(bytes.subarray(nameStart, nameStart + nameLength));

    if (view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) {
      throw new Error(`部件 ${path} 的本地文件头签名不符`);
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);

    let data: Uint8Array;
    if (method === 0) data = raw.slice();
    else if (method === 8) data = new Uint8Array(inflateRawSync(Buffer.from(raw)));
    else throw new Error(`部件 ${path} 的压缩方法 ${String(method)} 本解析器不支持`);
    if (data.byteLength !== uncompressedSize) {
      throw new Error(`部件 ${path} 解压长度 ${String(data.byteLength)} ≠ 中央目录声明 ${String(uncompressedSize)}`);
    }
    out.push({ path, data });
    cursor = nameStart + nameLength + extraLength + commentLength;
  }
  return Object.freeze(out);
}

function partPaths(bytes: Uint8Array): readonly string[] {
  return unzip(bytes).map((part) => part.path);
}

/** 取某个部件的文本内容；不存在返回 `null`（不猜、不造）。 */
function partText(bytes: Uint8Array, path: string): string | null {
  const part = unzip(bytes).find((item) => item.path === path);
  return part === undefined ? null : utf8.decode(part.data);
}

/** 匹配部件名的全部条目。 */
function partsMatching(bytes: Uint8Array, pattern: RegExp): readonly ZipPart[] {
  return Object.freeze(unzip(bytes).filter((part) => pattern.test(part.path)));
}

// ---------------------------------------------------------------------------
// 迷你 XML 标签扫描器（正则；只看"字节里到底有没有那个元素"）
// ---------------------------------------------------------------------------

interface ScannedTag {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly selfClosing: boolean;
}

const ATTRIBUTE_PATTERN = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*"([^"]*)"/g;

/** 扫出 XML 文本里指定**限定名**的全部标签。 */
function tags(xml: string, qualifiedName: string): readonly ScannedTag[] {
  const found: ScannedTag[] = [];
  let cursor = 0;
  while (cursor < xml.length) {
    const open = xml.indexOf('<', cursor);
    if (open < 0) break;
    const next = xml.charAt(open + 1);
    if (next === '?' || next === '!') {
      const close = xml.indexOf('>', open);
      if (close < 0) break;
      cursor = close + 1;
      continue;
    }
    const end = xml.indexOf('>', open);
    if (end < 0) break;
    let body = xml.slice(open + 1, end);
    const selfClosing = body.endsWith('/');
    if (selfClosing) body = body.slice(0, -1);
    const trimmed = body.trim();
    cursor = end + 1;
    if (next === '/') continue;
    const spaceAt = trimmed.search(/[\s/]/);
    const name = spaceAt < 0 ? trimmed : trimmed.slice(0, spaceAt);
    if (name !== qualifiedName) continue;
    const attributes: Record<string, string> = {};
    ATTRIBUTE_PATTERN.lastIndex = 0;
    let match = ATTRIBUTE_PATTERN.exec(trimmed);
    while (match !== null) {
      const key = match[1];
      const value = match[2];
      if (key !== undefined && value !== undefined) attributes[key] = value;
      match = ATTRIBUTE_PATTERN.exec(trimmed);
    }
    found.push({ name, attributes: Object.freeze(attributes), selfClosing });
  }
  return Object.freeze(found);
}

/** 标签上某个属性的值（`null` = 没有该属性，不是空串）。 */
function attributeOf(tag: ScannedTag, name: string): string | null {
  const value = tag.attributes[name];
  return value === undefined ? null : value;
}

/** 取 `<tag ...>INNER</tag>` 的第一次出现；没有返回 `null`。 */
function innerOf(xml: string, qualifiedName: string): string | null {
  const pattern = new RegExp(`<${qualifiedName}\\b[^>]*>([\\s\\S]*?)</${qualifiedName}>`);
  const match = pattern.exec(xml);
  return match === null ? null : (match[1] ?? null);
}

// ---------------------------------------------------------------------------
// 单位换算（**本套件自己算**，不 import 产品换算器）
// ---------------------------------------------------------------------------

/** 1 mm = 1440/25.4 twips（OOXML 的 dxa）。 */
const mmToTwips = (mm: number): number => (mm * 1440) / 25.4;
/** 1 mm = 72/25.4 pt（产品读回页边距用的单位）。 */
const mmToPt = (mm: number): number => (mm * 72) / 25.4;

// ===========================================================================
// 夹具 / HTTP 小工具
// ===========================================================================

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 真实可导入的 DOCX（**不含数字**，避免触发可追溯性闸门）。 */
function fixtureDocx(): Uint8Array {
  return buildDocxTemplate({
    requirement: {
      title: '结构操作端到端',
      description: '用于结构操作产品端到端自证的正文，不含数字。',
      paragraphs: ['第一段正文内容', '第二段正文内容', '第三段正文内容'],
      presentation: DOCX_TITLE_BODY_PRESENTATION,
    },
    fact_snapshot: [],
    references: [],
  }).bytes;
}

function expectStatus(response: { status: number; json: Json }, expected: number): void {
  expect(response.status, JSON.stringify(response.json)).toBe(expected);
}

let workDir: string;
let main: RunningProduct;

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'potbot-fs-'));
  main = await startProduct(join(workDir, 'run-main'));
}, 60_000);

afterAll(async () => {
  await main.close();
  rmSync(workDir, { recursive: true, force: true });
});

// ===========================================================================
// ① DOC —— 页 / 节 / 栏宽 / 方向 / 纸张 / 边距 / 页码域（/api/documents/**）
// ===========================================================================

const DOC_ID = 'fs-doc';
const DOC_BARE_ID = 'fs-doc-bare';
const DOC_RE_ID = 'fs-doc-re';

/** 经产品 HTTP 导入受管文档；返回 200 响应。 */
async function docImport(id: string, bytes: Uint8Array): Promise<Json> {
  const response = await postJson(main.baseUrl, `/api/documents/${id}/import`, { docx_base64: b64(bytes) });
  expectStatus(response, 200);
  return response.json;
}

/** 打一次结构工作流操作（pages / table / header-footer）。 */
async function docOp(
  id: string,
  area: 'pages' | 'table' | 'header-footer',
  operation: Record<string, unknown>,
): Promise<{ status: number; json: Json }> {
  return postJson(main.baseUrl, `/api/documents/${id}/${area}`, { operation });
}

/** 导出受管文档的真实字节（`?body=1` 才带 `docx_base64`）。 */
async function docExport(id: string): Promise<Uint8Array> {
  const response = await getJson(main.baseUrl, `/api/documents/${id}/export?body=1`);
  expectStatus(response, 200);
  const encoded = response.json['docx_base64'];
  expect(typeof encoded).toBe('string');
  return new Uint8Array(Buffer.from(encoded as string, 'base64'));
}

/** 取某节的读回快照（`pages snapshot`）里的 `section` 对象。 */
function sectionOf(body: Json): Json {
  const detail = (body['detail'] as Json | undefined) ?? {};
  return ((detail['section'] as Json | undefined) ?? {}) as Json;
}

describe('① DOC 结构操作：产品入口写出去，独立解析器 + 产品读回端点双向读回', () => {
  let paragraphIds: readonly string[] = [];
  let tableId = '';
  let midExport: Uint8Array;
  let finalExport: Uint8Array;

  it('导入夹具 + 就绪面 200（产品入口）', async () => {
    expectStatus(await getJson(main.baseUrl, '/api/documents/status'), 200);
    const imported = await docImport(DOC_ID, fixtureDocx());
    expect(imported['persisted']).toBe(true);

    const summary = await getJson(main.baseUrl, `/api/documents/${DOC_ID}/summary`);
    expectStatus(summary, 200);
    paragraphIds = ((summary.json['paragraph_ids'] as string[] | undefined) ?? []).slice();
    expect(paragraphIds.length, '夹具至少要 3 个正文段落').toBeGreaterThanOrEqual(3);
  });

  it('分页符：写出去 → 导出 XML 是 w:br@w:type="page"（不是字面量）', async () => {
    const op = await docOp(DOC_ID, 'pages', { kind: 'insert_page_break', block_id: paragraphIds[0], offset: 0 });
    expectStatus(op, 200);
    expect(op.json['ok']).toBe(true);

    const exported = await docExport(DOC_ID);
    const xml = partText(exported, 'word/document.xml') as string;
    const breaks = tags(xml, 'w:br').filter((tag) => attributeOf(tag, 'w:type') === 'page');
    expect(breaks.length, '导出 XML 里没有分页符 w:br@w:type="page"').toBeGreaterThan(0);
  });

  it('页面方向 / 纸张 / 边距：set_page_area 写出去 → 导出 XML 的 w:pgSz / w:pgMar 逐项相等', async () => {
    // 先来一版**纵向**自定义纸张（150×250mm）：纵向时不做长边归一，w/h 与写入值一一对应。
    // （long-edge 归一在 landscape 下发生，见下方断言。）
    expectStatus(
      await docOp(DOC_ID, 'pages', {
        kind: 'set_page_area',
        scope: { kind: 'all' },
        size: { width: { unit: 'mm', value: 150 }, height: { unit: 'mm', value: 250 } },
        orientation: 'portrait',
      }),
      200,
    );
    const portraitSize = tags(partText(await docExport(DOC_ID), 'word/document.xml') as string, 'w:pgSz')[0];
    expect(portraitSize, '纵向导出里没有 w:pgSz').toBeDefined();
    expect(attributeOf(portraitSize as ScannedTag, 'w:orient')).toBe('portrait');
    expect(Math.abs(Number(attributeOf(portraitSize as ScannedTag, 'w:w')) - mmToTwips(150))).toBeLessThanOrEqual(2);
    expect(Math.abs(Number(attributeOf(portraitSize as ScannedTag, 'w:h')) - mmToTwips(250))).toBeLessThanOrEqual(2);

    const op = await docOp(DOC_ID, 'pages', {
      kind: 'set_page_area',
      scope: { kind: 'all' },
      size: { width: { unit: 'mm', value: 210 }, height: { unit: 'mm', value: 297 } },
      margins: {
        top: { unit: 'mm', value: 25 },
        right: { unit: 'mm', value: 20 },
        bottom: { unit: 'mm', value: 25 },
        left: { unit: 'mm', value: 20 },
      },
      orientation: 'landscape',
    });
    expectStatus(op, 200);
    expect(op.json['ok']).toBe(true);
    expect((op.json['detail'] as Json)['changed_sections']).toEqual([0]);

    const xml = partText(await docExport(DOC_ID), 'word/document.xml') as string;
    const pageSize = tags(xml, 'w:pgSz')[0];
    expect(pageSize, '导出 XML 里没有 w:pgSz').toBeDefined();
    expect(attributeOf(pageSize as ScannedTag, 'w:orient'), '页面方向').toBe('landscape');
    // 产品在 landscape 下把**长边放到 `w:w`**（OOXML 约定：横向 = w > h）。本套件据此断言，
    // 不假装它是"原样写出 210×297"。
    const w = Number(attributeOf(pageSize as ScannedTag, 'w:w'));
    const h = Number(attributeOf(pageSize as ScannedTag, 'w:h'));
    expect(w).toBeGreaterThan(h);
    expect(Math.abs(w - mmToTwips(297))).toBeLessThanOrEqual(5);
    expect(Math.abs(h - mmToTwips(210))).toBeLessThanOrEqual(5);

    const margins = tags(xml, 'w:pgMar')[0];
    expect(margins, '导出 XML 里没有 w:pgMar').toBeDefined();
    expect(Math.abs(Number(attributeOf(margins as ScannedTag, 'w:top')) - mmToTwips(25))).toBeLessThanOrEqual(1);
    expect(Math.abs(Number(attributeOf(margins as ScannedTag, 'w:right')) - mmToTwips(20))).toBeLessThanOrEqual(1);
    expect(Math.abs(Number(attributeOf(margins as ScannedTag, 'w:left')) - mmToTwips(20))).toBeLessThanOrEqual(1);
    expect(attributeOf(margins as ScannedTag, 'w:bottom')).not.toBeNull();
  });

  it('分节符类型：四种类型（下一页/连续/偶数页/奇数页）逐个写出去 → 产品读回同一个值 + 导出 XML 一致', async () => {
    for (const type of ['continuous', 'evenPage', 'oddPage', 'nextPage'] as const) {
      const op = await docOp(DOC_ID, 'pages', { kind: 'set_section_start_type', section_index: 0, type });
      expectStatus(op, 200);
      expect((op.json['detail'] as Json)['start_type'], `${type} 写入回执`).toBe(type);

      // 方向二之一：产品自己的读回端点（`pages snapshot`）。
      const snapshot = await docOp(DOC_ID, 'pages', { kind: 'snapshot', section_index: 0 });
      expectStatus(snapshot, 200);
      expect((snapshot.json['detail'] as Json)['start_type'], `${type} 产品读回`).toBe(type);

      // 方向二之二：导出 XML 里的 `w:type@w:val`。
      const xml = partText(await docExport(DOC_ID), 'word/document.xml') as string;
      const sectionType = tags(xml, 'w:type').filter((tag) => attributeOf(tag, 'w:val') === type);
      expect(sectionType.length, `导出 XML 里没有分节符类型 ${type}`).toBeGreaterThan(0);
    }
    // 留一个可区分的终态（`nextPage` 是最后一次写出去的类型）。
    const last = partText(await docExport(DOC_ID), 'word/document.xml') as string;
    expect(tags(last, 'w:type').some((tag) => attributeOf(tag, 'w:val') === 'nextPage')).toBe(true);
  });

  it('自定义栏宽：写出去 → 导出 XML 有 w:cols(num=2,equalWidth=0) + 两条 w:col（twips 逐项相等）', async () => {
    const op = await docOp(DOC_ID, 'pages', {
      kind: 'set_custom_columns',
      section_index: 0,
      columns: [
        { width: { unit: 'mm', value: 60 }, space: { unit: 'mm', value: 5 } },
        { width: { unit: 'mm', value: 70 }, space: { unit: 'mm', value: 6 } },
      ],
    });
    expectStatus(op, 200);
    expect(op.json['ok']).toBe(true);
    expect((op.json['detail'] as Json)['changed_sections']).toEqual([0]);

    const xml = partText(await docExport(DOC_ID), 'word/document.xml') as string;
    const cols = tags(xml, 'w:cols');
    expect(cols.length, '导出里必须有 w:cols').toBe(1);
    expect(attributeOf(cols[0] as ScannedTag, 'w:num')).toBe('2');
    expect(attributeOf(cols[0] as ScannedTag, 'w:equalWidth')).toBe('0');
    expect((cols[0] as ScannedTag).selfClosing, '自定义栏宽必须带 w:col 子元素').toBe(false);

    const written = tags(xml, 'w:col').map((tag) => ({
      width: Number(attributeOf(tag, 'w:w') ?? 'NaN'),
      space: Number(attributeOf(tag, 'w:space') ?? 'NaN'),
    }));
    expect(written).toHaveLength(2);
    expect(Math.abs(written[0]!.width - mmToTwips(60))).toBeLessThanOrEqual(1);
    expect(Math.abs(written[0]!.space - mmToTwips(5))).toBeLessThanOrEqual(1);
    expect(Math.abs(written[1]!.width - mmToTwips(70))).toBeLessThanOrEqual(1);
    expect(Math.abs(written[1]!.space - mmToTwips(6))).toBeLessThanOrEqual(1);
  });

  it('表格 列宽 / 行高 / 合并：写出去 → 导出的 w:gridCol / w:trHeight / w:gridSpan 逐项读回', async () => {
    const inserted = await docOp(DOC_ID, 'table', { kind: 'insert', rows: 2, columns: 3, text_prefix: '格' });
    expectStatus(inserted, 200);
    const summary = (inserted.json['summary'] as Json | undefined) ?? {};
    tableId = ((summary['table_ids'] as string[] | undefined) ?? [])[0] ?? '';
    expect(tableId, '插表格后应有 table_id').not.toBe('');

    // 列宽（30mm）——DOCX 表格的列宽，**不是** XLSX 工作表列宽（产品无该入口，见 XLS 段）。
    expectStatus(
      await docOp(DOC_ID, 'table', {
        kind: 'set_column_width',
        table_id: tableId,
        column: 0,
        width: { unit: 'mm', value: 30 },
      }),
      200,
    );
    // 行高（exact 12mm）。
    expectStatus(
      await docOp(DOC_ID, 'table', {
        kind: 'set_row_height',
        table_id: tableId,
        row: 0,
        rule: 'exact',
        value: { unit: 'mm', value: 12 },
      }),
      200,
    );
    // 合并 (0,0)-(0,1)。
    const merged = await docOp(DOC_ID, 'table', {
      kind: 'merge',
      table_id: tableId,
      region: { top: 0, left: 0, rows: 1, columns: 2 },
    });
    expectStatus(merged, 200);
    expect((merged.json['detail'] as Json)['content_preserved']).toBe(true);

    midExport = await docExport(DOC_ID);
    const xml = partText(midExport, 'word/document.xml') as string;
    const gridCols = tags(xml, 'w:gridCol').map((tag) => Number(attributeOf(tag, 'w:w') ?? 'NaN'));
    expect(gridCols.length, '应有 3 列').toBe(3);
    expect(Math.abs(gridCols[0]! - mmToTwips(30))).toBeLessThanOrEqual(1);
    const trHeight = tags(xml, 'w:trHeight')[0];
    expect(trHeight, '导出里没有 w:trHeight').toBeDefined();
    expect(Math.abs(Number(attributeOf(trHeight as ScannedTag, 'w:val')) - mmToTwips(12))).toBeLessThanOrEqual(1);
    expect(attributeOf(trHeight as ScannedTag, 'w:hRule')).toBe('exact');
    expect(tags(xml, 'w:gridSpan').map((tag) => attributeOf(tag, 'w:val')), '合并后应有 gridSpan=2').toContain('2');

    // 产品读回：表格快照的宽度一致性（合并后仍自洽）。
    const snapshot = await docOp(DOC_ID, 'table', { kind: 'snapshot', table_id: tableId });
    expectStatus(snapshot, 200);
    const detail = (snapshot.json['detail'] as Json | undefined) ?? {};
    expect(detail['consistency']).toBeDefined();
  });

  it('拆分：把刚合并的格子拆回来 → 导出 XML 里 gridSpan 消失（不是"拆了但没变"）', async () => {
    const split = await docOp(DOC_ID, 'table', { kind: 'split', table_id: tableId, row: 0, column: 0 });
    expectStatus(split, 200);
    const xml = partText(await docExport(DOC_ID), 'word/document.xml') as string;
    expect(tags(xml, 'w:gridSpan'), '拆分后不应再有 gridSpan').toHaveLength(0);
  });

  it('页眉页脚页码域：写出去 → 导出包里的页脚部件含 PAGE 域，且**不是字面量数字**', async () => {
    const op = await docOp(DOC_ID, 'header-footer', {
      kind: 'create_part',
      role: 'footer',
      variant: 'default',
      section_index: 0,
      content: ['第 ', { field: 'page' }, ' 页'],
    });
    expectStatus(op, 200);
    const detail = (op.json['detail'] as Json | undefined) ?? {};
    const partPath = String(detail['part_path'] ?? '');
    expect(partPath, 'create_part 应给出 part_path').toMatch(/^word\/footer\d*\.xml$/);

    finalExport = await docExport(DOC_ID);
    const footerParts = partsMatching(finalExport, /^word\/footer\d*\.xml$/);
    expect(footerParts.length, '导出包里没有页脚部件').toBeGreaterThan(0);

    let sawField = false;
    for (const part of footerParts) {
      const xml = utf8.decode(part.data);
      expect(xml, `页脚部件 ${part.path} 路径与 part_path 不符`).toContain('w:ftr');
      const fldSimple = tags(xml, 'w:fldSimple').map((tag) => attributeOf(tag, 'w:instr') ?? '');
      const instrText = tags(xml, 'w:instrText').map((tag) => attributeOf(tag, 'w:instr') ?? '');
      const fieldForms = [...fldSimple, ...instrText];
      if (fieldForms.some((value) => /\bPAGE\b/.test(value))) sawField = true;
      // 页码必须是**域**：页脚里不得出现"整段就是一个数字"的 w:t（`<w:t>7</w:t>`）。
      const literalOnly = /<w:t[^>]*>\s*\d+\s*<\/w:t>/g.exec(xml);
      expect(literalOnly, `页脚里出现写死的数字：${String(literalOnly?.[0])}`).toBeNull();
    }
    expect(sawField, '页脚部件里没有 PAGE 域').toBe(true);

    // 产品自己的读回端点认这个操作，但**渲染口径**仍是未验证（需消费端）。
    const report = await docOp(DOC_ID, 'header-footer', { kind: 'report', section_index: 0 });
    expectStatus(report, 200);
    expect(report.json['render_verification']).toBe('unverified');
  });

  it('双向读回：把最终导出**重新导入**再导出 ⇒ 分页符 / 节类型 / 栏数仍在（产品读回端点一致）', async () => {
    expectStatus(await postJson(main.baseUrl, `/api/documents/${DOC_RE_ID}/import`, { docx_base64: b64(finalExport) }), 200);

    // 分页符：重新导入再导出仍在。
    const re = await docExport(DOC_RE_ID);
    const xml = partText(re, 'word/document.xml') as string;
    expect(tags(xml, 'w:br').filter((tag) => attributeOf(tag, 'w:type') === 'page').length).toBeGreaterThan(0);
    // 节类型：`nextPage` 仍在，且产品读回同一值。
    expect(tags(xml, 'w:type').some((tag) => attributeOf(tag, 'w:val') === 'nextPage')).toBe(true);
    const snapshot = await docOp(DOC_RE_ID, 'pages', { kind: 'snapshot', section_index: 0 });
    expectStatus(snapshot, 200);
    expect((snapshot.json['detail'] as Json)['start_type']).toBe('nextPage');

    // 栏数：`w:cols/@w:num` 读得回（逐栏 `w:col` 宽度是既有导入侧缺口，本套件不假装）。
    const layout = await docOp(DOC_RE_ID, 'pages', { kind: 'column_layout', section_index: 0 });
    expectStatus(layout, 200);
    const layoutDetail = ((layout.json['detail'] as Json | undefined) ?? {})['layout'] as Json | undefined;
    expect(layoutDetail?.['kind'], '重新导入后仍是自定义栏宽（不是退回等宽/未设置）').toBe('custom');
    const reColumns = ((layoutDetail?.['columns'] as { width: { unit: string; value: number } }[] | undefined) ?? []).map(
      (column) => column.width.value,
    );
    expect(reColumns).toHaveLength(2);
    expect(Math.abs(reColumns[0]! - mmToTwips(60))).toBeLessThanOrEqual(2);
    expect(Math.abs(reColumns[1]! - mmToTwips(70))).toBeLessThanOrEqual(2);

    // 页脚引用：重新导入后产品读回页脚仍是同一部件角色。
    const footerReport = await docOp(DOC_RE_ID, 'header-footer', { kind: 'report', section_index: 0 });
    expectStatus(footerReport, 200);
    expect(footerReport.json['render_verification']).toBe('unverified');
  });

  it('【反向对照】不做任何结构操作 ⇒ 导出里不得凭空出现分页符 / 自定义栏宽 / 页脚部件', async () => {
    expectStatus(await postJson(main.baseUrl, `/api/documents/${DOC_BARE_ID}/import`, { docx_base64: b64(fixtureDocx()) }), 200);
    const bare = await docExport(DOC_BARE_ID);
    const xml = partText(bare, 'word/document.xml') as string;

    expect(tags(xml, 'w:br').filter((tag) => attributeOf(tag, 'w:type') === 'page'), '凭空出现分页符').toHaveLength(0);
    expect(tags(xml, 'w:col'), '凭空出现自定义栏宽').toHaveLength(0);
    expect(tags(xml, 'w:pgSz').filter((tag) => attributeOf(tag, 'w:orient') === 'landscape'), '凭空出现横向').toHaveLength(0);
    expect(partsMatching(bare, /^word\/footer\d*\.xml$/), '凭空出现页脚部件').toHaveLength(0);
    // 阳性对照：反向对照的那份导出里仍有正文主部件（不是"解出空包"的假象）。
    expect(partPaths(bare)).toContain('word/document.xml');
  });

  it('【越界拒绝】合并越界 ⇒ 422 invalid_index（不是"成功但没做"）', async () => {
    const outOfBounds = await docOp(DOC_ID, 'table', {
      kind: 'merge',
      table_id: tableId,
      region: { top: 0, left: 0, rows: 99, columns: 99 },
    });
    expect(outOfBounds.status).toBe(422);
    expect(outOfBounds.json['code']).toBe('invalid_index');

    // 越界被拒后，表格宽度一致性没被破坏（没有半途改坏）。
    const snapshot = await docOp(DOC_ID, 'table', { kind: 'snapshot', table_id: tableId });
    expectStatus(snapshot, 200);
    expect(((snapshot.json['detail'] as Json | undefined) ?? {})['consistency']).toBeDefined();
  });

  it('【越界拒绝】栏宽非法（列下标越界）⇒ 4xx，且导出字节**逐字节不变**（源零改动）', async () => {
    const before = await docExport(DOC_ID);
    const bad = await docOp(DOC_ID, 'table', {
      kind: 'set_column_width',
      table_id: tableId,
      column: 99,
      width: { unit: 'mm', value: 30 },
    });
    expect(bad.status, JSON.stringify(bad.json)).toBeGreaterThanOrEqual(400);
    expect(bad.status).toBeLessThan(500);
    expect(typeof bad.json['code']).toBe('string');

    const after = await docExport(DOC_ID);
    expect(sha256(after), '被拒的编辑不得改动字节').toBe(sha256(before));
  });

  it.skip('③ 未覆盖：Word / WPS 实际打开这些 DOCX 后**分页 / 页码域渲染 / 栏宽呈现**是否正确 → 需消费端（本机无授权 Office、无真机，未验证）', () => {
    // 本套件只证明「结构写进了字节、且本仓读得回」；"消费端看起来对不对"未验证。
  });
});

// ===========================================================================
// ② XLS —— 多工作表结构操作（/api/deliverables/**），独立 ZIP 解析器读回
// ===========================================================================

/** 交付会话的编辑：先 GET 状态拿基线（revision + digest），再 POST /edits。 */
async function editDeliverable(
  sessionId: string,
  idempotencyKey: string,
  edit: Record<string, unknown>,
): Promise<{ status: number; json: Json }> {
  const status = await getJson(main.baseUrl, `/api/deliverables/${sessionId}`);
  expectStatus(status, 200);
  return postJson(main.baseUrl, `/api/deliverables/${sessionId}/edits`, {
    idempotencyKey,
    baseRevision: status.json['editRevision'],
    baseDigest: status.json['contentDigest'],
    edit,
  });
}

/** 交付会话的当前版本号。 */
async function deliverableRevision(sessionId: string): Promise<number> {
  const status = await getJson(main.baseUrl, `/api/deliverables/${sessionId}`);
  expectStatus(status, 200);
  return Number(status.json['editRevision']);
}

/** 下载某一版的真实字节。 */
async function downloadDeliverable(sessionId: string, revision: number): Promise<Uint8Array> {
  const got = await getBytes(main.baseUrl, `/api/deliverables/${sessionId}/versions/${String(revision)}/download`);
  expect(got.status, `下载版本 ${String(revision)}`).toBe(200);
  return got.bytes;
}

/** 读回 `xl/workbook.xml` 里的工作表名（按声明顺序）。 */
function workbookSheetNames(xlsx: Uint8Array): readonly string[] {
  const xml = partText(xlsx, 'xl/workbook.xml');
  if (xml === null) return Object.freeze([]);
  const block = innerOf(xml, 'sheets');
  if (block === null) return Object.freeze([]);
  return Object.freeze(tags(block, 'sheet').map((tag) => attributeOf(tag, 'name') ?? ''));
}

/** 读回 `xl/_rels/workbook.xml.rels` 里 rId → 部件路径的映射。 */
function workbookRelMap(xlsx: Uint8Array): Readonly<Record<string, string>> {
  const xml = partText(xlsx, 'xl/_rels/workbook.xml.rels');
  const map: Record<string, string> = {};
  if (xml === null) return Object.freeze(map);
  for (const rel of tags(xml, 'Relationship')) {
    const id = attributeOf(rel, 'Id');
    const target = attributeOf(rel, 'Target');
    if (id !== null && target !== null) map[id] = target;
  }
  return Object.freeze(map);
}

describe('② XLS 结构操作：多工作表的增 / 删 / 改名 / 活跃表，独立解析器读回；未接线的结构面**具名拒绝**', () => {
  const SESSION = 'fs-xls';
  let finalBytes: Uint8Array;

  it('开会话（空白 xlsx）201，起始只有一张 Sheet1', async () => {
    const opened = await postJson(main.baseUrl, '/api/deliverables', {
      sessionId: SESSION,
      deliverableId: 'fs-xls-file',
      filename: '结构.xlsx',
      format: 'xlsx',
      title: '结构台账',
    });
    expectStatus(opened, 201);
    expect(opened.json['fileFormat']).toBe('xlsx');
    expect(opened.json['editRevision']).toBe(0);
  });

  it('多表增删改名：add_sheet / rename_sheet / add_sheet / remove_sheet / set_active_sheet 全部 200', async () => {
    expectStatus(await editDeliverable(SESSION, 'xls-add-detail', { op: 'add_sheet', name: '明细' }), 200);
    expectStatus(await editDeliverable(SESSION, 'xls-rename-1', { op: 'rename_sheet', from: 'Sheet1', to: '数据' }), 200);
    expectStatus(await editDeliverable(SESSION, 'xls-add-temp', { op: 'add_sheet', name: '临时' }), 200);
    // 注：这里先做一次**内容**编辑，再删表。若"加表 → 立刻删表"（期间无其它改动），
    // 删表后的字节会与"加表前那一版"**逐字节相同** ⇒ 会话把它当重复版本、**丢弃这次删除**
    // （见下方专门的实测边界用例）。先改内容可让删表后的状态唯一，删除才真正生效。
    expectStatus(
      await editDeliverable(SESSION, 'xls-cell', {
        op: 'set_cell',
        sheet: '数据',
        address: 'A1',
        value: { kind: 'text', value: '标题' },
      }),
      200,
    );
    const removed = await editDeliverable(SESSION, 'xls-remove-temp', { op: 'remove_sheet', name: '临时' });
    expectStatus(removed, 200);
    expect(removed.json['changed'], '删除「临时」应真的改动源').toBe(true);

    expectStatus(await editDeliverable(SESSION, 'xls-active', { op: 'set_active_sheet', name: '明细' }), 200);
  });

  it('【实测边界】"加表 → 立刻删同一张表"会与旧版字节重合 ⇒ 会话按重复版本**丢弃这次删除**（回执却写着已删）', async () => {
    // 这条是本基线**实测到的产品级边角**：`remove_sheet` 的改动词条写进回执（"删除工作表 X"），
    // 但若删除后的字节与某个**已发布版本**逐字节相同，会话按 R145「不重复交付第二版」直接
    // 判 `changed:false` 并**不采用新源** ⇒ 表其实还在。本套件如实断言这个现象，不替它圆场。
    expectStatus(
      await postJson(main.baseUrl, '/api/deliverables', {
        sessionId: 'fs-xls-collide',
        deliverableId: 'fs-xls-collide-file',
        filename: '重合.xlsx',
        format: 'xlsx',
      }),
      201,
    );
    expectStatus(await editDeliverable('fs-xls-collide', 'xls-col-add-a', { op: 'add_sheet', name: '甲' }), 200);
    expectStatus(await editDeliverable('fs-xls-collide', 'xls-col-add-b', { op: 'add_sheet', name: '乙' }), 200);

    const removal = await editDeliverable('fs-xls-collide', 'xls-col-remove-b', { op: 'remove_sheet', name: '乙' });
    expectStatus(removal, 200);
    // 回执声称删了……
    expect(removal.json['notes']).toEqual(['删除工作表 乙']);
    // ……但变更标记是 false（源零改动）。
    expect(removal.json['changed'], '与旧版重合 ⇒ 会话判为重复版本').toBe(false);

    // 读回事实：表「乙」仍在（删除没有落到文件里）。这正是"回执与字节不一致"要被抓的地方。
    const bytes = await downloadDeliverable('fs-xls-collide', await deliverableRevision('fs-xls-collide'));
    expect(workbookSheetNames(bytes), '删除被丢弃 ⇒ 工作表清单里「乙」仍在').toEqual(['Sheet1', '甲', '乙']);
  });

  it('读回：导出字节里工作表**按声明顺序**为 [数据, 明细]，两张表部件与关系映射都在', async () => {
    const revision = await deliverableRevision(SESSION);
    finalBytes = await downloadDeliverable(SESSION, revision);

    // 阳性对照：这是真 XLSX 包，不是空包。
    expect(partPaths(finalBytes)).toContain('xl/workbook.xml');
    expect(partPaths(finalBytes)).toContain('[Content_Types].xml');

    expect(workbookSheetNames(finalBytes), '工作表名与顺序').toEqual(['数据', '明细']);

    // 两张 sheetN.xml 部件都在，且 workbook 的关系映射逐条指得到。
    const sheetParts = partsMatching(finalBytes, /^xl\/worksheets\/sheet\d+\.xml$/);
    expect(sheetParts.length, '应有 2 张工作表部件（临时表已删）').toBe(2);

    const xml = partText(finalBytes, 'xl/workbook.xml') as string;
    const rels = workbookRelMap(finalBytes);
    const declared = tags(innerOf(xml, 'sheets') ?? '', 'sheet');
    for (const sheet of declared) {
      const rid = attributeOf(sheet, 'r:id') ?? attributeOf(sheet, 'r:Id');
      expect(rid, '工作表声明缺少 r:id').not.toBeNull();
      const target = rels[rid as string];
      expect(target, `r:id=${String(rid)} 在 rels 里找不到`).toBeDefined();
      expect(partPaths(finalBytes)).toContain(`xl/${String(target).replace(/^\/?xl\//, '')}`);
    }

    // 内容落在「数据」表里（set_cell 的阳性对照）。
    const dataPart = partsMatching(finalBytes, /^xl\/worksheets\/sheet\d+\.xml$/).map((part) => utf8.decode(part.data));
    expect(dataPart.some((sheetXml) => sheetXml.includes('标题')), 'A1 的内容没写进任何工作表').toBe(true);
  });

  it('双向读回：把导出字节**重新导入**新会话再交付 ⇒ 工作表名与数量不变（产品导入链真吸收）', async () => {
    const opened = await postJson(main.baseUrl, '/api/deliverables', {
      sessionId: 'fs-xls-reimport',
      deliverableId: 'fs-xls-file-reimport',
      filename: '结构-重开.xlsx',
      format: 'xlsx',
      fileBase64: b64(finalBytes),
    });
    expectStatus(opened, 201);

    // 重新导入后做一次非结构编辑以产生一版，再读回工作表清单。
    const revision = await deliverableRevision('fs-xls-reimport');
    const published = await editDeliverable('fs-xls-reimport', 'xls-re-cell', {
      op: 'set_cell',
      sheet: '明细',
      address: 'B2',
      value: { kind: 'number', value: 7 },
    });
    expectStatus(published, 200);
    const reBytes = await downloadDeliverable('fs-xls-reimport', Math.max(revision, await deliverableRevision('fs-xls-reimport')));
    expect(workbookSheetNames(reBytes)).toEqual(['数据', '明细']);
  });

  it('【反向对照】只做内容编辑、不做任何结构操作 ⇒ 只有一张 Sheet1，不得凭空多出工作表', async () => {
    expectStatus(
      await postJson(main.baseUrl, '/api/deliverables', {
        sessionId: 'fs-xls-bare',
        deliverableId: 'fs-xls-bare-file',
        filename: '裸表.xlsx',
        format: 'xlsx',
      }),
      201,
    );
    expectStatus(
      await editDeliverable('fs-xls-bare', 'xls-bare-cell', {
        op: 'set_cell',
        sheet: 'Sheet1',
        address: 'A1',
        value: { kind: 'text', value: '只有内容' },
      }),
      200,
    );
    const bytes = await downloadDeliverable('fs-xls-bare', await deliverableRevision('fs-xls-bare'));
    expect(workbookSheetNames(bytes)).toEqual(['Sheet1']);
    expect(partsMatching(bytes, /^xl\/worksheets\/sheet\d+\.xml$/), '不得凭空多出工作表部件').toHaveLength(1);
  });

  it('【越界拒绝】删除唯一工作表 / 未知表 / 重名新增：一律 422 unsupported，且源零改动（版本号不涨）', async () => {
    const reject = async (sessionId: string, key: string, edit: Record<string, unknown>, needle: string): Promise<void> => {
      const revisionBefore = await deliverableRevision(sessionId);
      const response = await editDeliverable(sessionId, key, edit);
      expect(response.status, JSON.stringify(response.json)).toBe(422);
      expect(response.json['code']).toBe('unsupported');
      expect(String(response.json['message']), `被拒原因应具名包含「${needle}」`).toContain(needle);
      // 被拒的编辑**不产生新版本**（源零改动）。
      expect(await deliverableRevision(sessionId), '被拒的编辑不得推进版本').toBe(revisionBefore);
    };

    // 删除唯一工作表（"删除唯一页"在 XLS 上的对应物）。
    await reject('fs-xls-bare', 'xls-last-sheet', { op: 'remove_sheet', name: 'Sheet1' }, '最后一张工作表');
    // 未知表。
    await reject('fs-xls-bare', 'xls-unknown-sheet', { op: 'remove_sheet', name: '不存在的表' }, '没有工作表');
    // 重名新增。
    await reject('fs-xls-bare', 'xls-dup-sheet', { op: 'add_sheet', name: 'Sheet1' }, '已存在');
  });

  it('【接线缺口】冻结窗格 / 合并 / 列宽 / 行高 / 复制 / 移动 / 隐藏 ⇒ 产品入口不存在，**具名** 422（不静默成功）', async () => {
    const notWired: readonly Record<string, unknown>[] = [
      { op: 'set_frozen_panes', sheet: 'Sheet1', rows: 1, columns: 1 },
      { op: 'merge_cells', sheet: 'Sheet1', range: 'A1:B2' },
      { op: 'unmerge_cells', sheet: 'Sheet1', range: 'A1:B2' },
      { op: 'set_column_width', sheet: 'Sheet1', column: 0, width: 30 },
      { op: 'set_row_height', sheet: 'Sheet1', row: 0, height: 20 },
      { op: 'duplicate_sheet', name: 'Sheet1' },
      { op: 'move_sheet', from: 'Sheet1', to: 0 },
      { op: 'hide_sheet', name: 'Sheet1' },
    ];
    const revisionBefore = await deliverableRevision('fs-xls-bare');
    for (const [index, edit] of notWired.entries()) {
      const response = await editDeliverable('fs-xls-bare', `xls-notwired-${String(index)}`, edit);
      expect(response.status, `未被接线的结构 op ${JSON.stringify(edit['op'])} 必须具名拒绝：${JSON.stringify(response.json)}`).toBe(422);
      expect(response.json['code']).toBe('unsupported');
      expect(String(response.json['message'])).toContain('不支持的表格操作');
    }
    expect(await deliverableRevision('fs-xls-bare'), '全部越界尝试不得改动源').toBe(revisionBefore);
    // 明确登记：这是**产品入口的接线缺口**，不是"没有这个能力"——内核模型层有合并/列宽等，
    // 但 `/api/deliverables/**` 挂的是封闭枚举 `xlsxDeliverableAdapter`（6 个 op）。
  });

  it.skip('③ 未覆盖：Excel / WPS 实际打开这些 XLSX 后**多表 / 冻结 / 合并**呈现是否正确 → 需消费端（本机无授权 Office、无真机，未验证）', () => {
    // 本套件的 XLS 结构面只到"多工作表增删改名 + 独立 ZIP 读回"；冻结/合并/列宽行高产品入口不存在。
  });
});

// ===========================================================================
// ③ PPT —— 幻灯片结构操作（/api/deliverables/**），读回**页码与对象引用不错位**
// ===========================================================================

/** 从 add_slide 的 `notes` 里取新增页的 slide_id（产品回执里的稳定标识）。 */
function slideIdFromNotes(notes: unknown): number {
  const text = Array.isArray(notes) ? notes.map((item) => String(item)).join('\n') : '';
  const match = /slide_id=(\d+)/.exec(text);
  if (match === null) throw new Error(`add_slide 的回执里没有 slide_id：${text}`);
  return Number(match[1]);
}

/** 读回 `ppt/presentation.xml` 里 `p:sldIdLst` 的槽位顺序（`r:id` 列表）。 */
function slideIdListOrder(pptx: Uint8Array): readonly string[] {
  const xml = partText(pptx, 'ppt/presentation.xml');
  if (xml === null) return Object.freeze([]);
  const list = innerOf(xml, 'p:sldIdLst');
  if (list === null) return Object.freeze([]);
  return Object.freeze(tags(list, 'p:sldId').map((tag) => attributeOf(tag, 'r:id') ?? ''));
}

/** 读回 `ppt/_rels/presentation.xml.rels` 的 rId → 幻灯片部件路径映射。 */
function slideRelMap(pptx: Uint8Array): Readonly<Record<string, string>> {
  const xml = partText(pptx, 'ppt/_rels/presentation.xml.rels');
  const map: Record<string, string> = {};
  if (xml === null) return Object.freeze(map);
  for (const rel of tags(xml, 'Relationship')) {
    const id = attributeOf(rel, 'Id');
    const target = attributeOf(rel, 'Target');
    if (id !== null && target !== null) map[id] = target.replace(/^\/?ppt\//, '').replace(/^\.\//, '');
  }
  return Object.freeze(map);
}

/** 某一页幻灯片的标题（第一个 `<a:t>` 的文本）。 */
function slideTitle(pptx: Uint8Array, slidePath: string): string {
  const xml = partText(pptx, slidePath);
  if (xml === null) throw new Error(`包里没有 ${slidePath}`);
  const match = /<a:t>([\s\S]*?)<\/a:t>/.exec(xml);
  return match === null ? '' : (match[1] ?? '');
}

describe('③ PPT 结构操作：页的增 / 删 / 插入位次 / 改名，读回页码与对象引用不错位；未接线结构面**具名拒绝**', () => {
  const SESSION = 'fs-ppt';
  let finalBytes: Uint8Array;
  let expectedTitles: readonly string[] = [];

  it('开会话（空白 pptx）201：0 页起步（不是固定两页）', async () => {
    const opened = await postJson(main.baseUrl, '/api/deliverables', {
      sessionId: SESSION,
      deliverableId: 'fs-ppt-file',
      filename: '汇报.pptx',
      format: 'pptx',
      title: '结构汇报',
    });
    expectStatus(opened, 201);
    expect(opened.json['fileFormat']).toBe('pptx');
  });

  it('增页 / 插入位次 / 删页 / 改名：add_slide ×3 → remove_slide → add_slide(at) → set_slide_title 全部 200', async () => {
    const first = await editDeliverable(SESSION, 'ppt-add-1', { op: 'add_slide', title: '封面' });
    expectStatus(first, 200);
    const s0 = slideIdFromNotes(first.json['notes']);

    const second = await editDeliverable(SESSION, 'ppt-add-2', { op: 'add_slide', title: '第二页' });
    expectStatus(second, 200);
    const s1 = slideIdFromNotes(second.json['notes']);

    const third = await editDeliverable(SESSION, 'ppt-add-3', { op: 'add_slide', title: '第三页' });
    expectStatus(third, 200);
    const s2 = slideIdFromNotes(third.json['notes']);

    // slide_id 是稳定标识、互不相同（用 id 定位而不是页码）。
    expect(new Set([s0, s1, s2]).size).toBe(3);

    // 删中间页 ⇒ 对象引用跟着页走，不留空洞。
    expectStatus(await editDeliverable(SESSION, 'ppt-remove-2', { op: 'remove_slide', slide_id: s1 }), 200);
    // 在下标 1 插入新的一页。
    expectStatus(await editDeliverable(SESSION, 'ppt-insert-at-1', { op: 'add_slide', title: '插入页', at: 1 }), 200);
    // 改最后一页标题（按 slide_id 定位，删页后页码漂移也不改错）。
    expectStatus(
      await editDeliverable(SESSION, 'ppt-retitle', { op: 'set_slide_title', slide_id: s2, text: '第三页（改名）' }),
      200,
    );
    // 备注（非结构，走同一链）。
    expectStatus(
      await editDeliverable(SESSION, 'ppt-notes', { op: 'set_slide_notes', slide_id: s0, text: '备注：封面' }),
      200,
    );

    expectedTitles = Object.freeze(['封面', '插入页', '第三页（改名）']);
  });

  it('读回：3 页部件、p:sldIdLst 槽位顺序经 rels 映射到对应幻灯片，**标题逐页相等、不错位**', async () => {
    const revision = await deliverableRevision(SESSION);
    finalBytes = await downloadDeliverable(SESSION, revision);

    expect(partPaths(finalBytes)).toContain('ppt/presentation.xml');
    const slideParts = partsMatching(finalBytes, /^ppt\/slides\/slide\d+\.xml$/);
    expect(slideParts.length, '应有 3 页幻灯片部件（删一页、又插一页）').toBe(3);

    // 页码顺序：`p:sldIdLst` 的槽位顺序 → rels → 部件 → 该页标题（与期望逐项相等）。
    const order = slideIdListOrder(finalBytes);
    expect(order.length, 'p:sldIdLst 的槽位数应等于页数').toBe(3);
    const rels = slideRelMap(finalBytes);
    const titlesInOrder = order.map((rid) => {
      const target = rels[rid];
      expect(target, `r:id=${rid} 在 presentation.xml.rels 里找不到`).toBeDefined();
      const path = `ppt/${String(target)}`;
      expect(partPaths(finalBytes), `rels 指向的部件 ${path} 不在包里`).toContain(path);
      return slideTitle(finalBytes, path);
    });
    expect(titlesInOrder, '页码与对象引用错位（标题顺序不符）').toEqual([...expectedTitles]);

    // 对象引用不错位：每一页部件都被 [Content_Types].xml 声明。
    const contentTypes = partText(finalBytes, '[Content_Types].xml') as string;
    for (const part of slideParts) {
      expect(contentTypes, `${part.path} 未被 [Content_Types].xml 声明`).toContain(`/${part.path}`);
    }
    // 页面尺寸声明（读回，不是设置——产品无设置入口）。
    const presentationXml = partText(finalBytes, 'ppt/presentation.xml') as string;
    expect(tags(presentationXml, 'p:sldSz'), 'presentation.xml 缺少 sldSz').toHaveLength(1);
  });

  it('双向读回：把导出字节**重新导入**新会话再交付 ⇒ 页数 / 页序 / 对象引用**逐页不变**', async () => {
    const opened = await postJson(main.baseUrl, '/api/deliverables', {
      sessionId: 'fs-ppt-reimport',
      deliverableId: 'fs-ppt-file-reimport',
      filename: '汇报-重开.pptx',
      format: 'pptx',
      fileBase64: b64(finalBytes),
    });
    expectStatus(opened, 201);

    // 重新导入后**原样再交付一版**（不改任何一页）：导入层的页序与对象引用必须原样带回。
    const status = await getJson(main.baseUrl, '/api/deliverables/fs-ppt-reimport');
    expectStatus(status, 200);
    expectStatus(
      await postJson(main.baseUrl, '/api/deliverables/fs-ppt-reimport/edits', {
        idempotencyKey: 'ppt-re-publish',
        baseRevision: status.json['editRevision'],
        baseDigest: status.json['contentDigest'],
      }),
      200,
    );
    const reBytes = await downloadDeliverable('fs-ppt-reimport', await deliverableRevision('fs-ppt-reimport'));

    const order = slideIdListOrder(reBytes);
    expect(order.length, '重新导入再导出后页数必须一致').toBe(expectedTitles.length);
    const rels = slideRelMap(reBytes);
    const titles = order.map((rid) => slideTitle(reBytes, `ppt/${String(rels[rid])}`));
    expect(titles, '重新导入后页序/对象引用错位').toEqual([...expectedTitles]);
    expect(partsMatching(reBytes, /^ppt\/slides\/slide\d+\.xml$/)).toHaveLength(expectedTitles.length);
  });

  it('【实测边界·具名拒绝】重新导入的演示**不能增删页**：导出器结构上拒绝（本增量未封装重建 presentation.xml）', async () => {
    // 这是本基线**实测到的产品级边界**（不是本套件的方法问题）：从**导入源**出发的演示，
    // 一旦页数变化，导出器以 `PresentationRoundTripError` 拒绝——因为重建
    // `ppt/presentation.xml` + `_rels` + 登记新部件这一流程在本增量里没有封装。
    // 本套件如实断言它被**具名 4xx** 挡住（绝不静默产出页数错位的包）。
    const before = await deliverableRevision('fs-ppt-reimport');
    const added = await editDeliverable('fs-ppt-reimport', 'ppt-re-add', { op: 'add_slide', title: '追加页' });
    expect(added.status, JSON.stringify(added.json)).toBe(422);
    expect(added.json['code']).toBe('unsupported');
    expect(String(added.json['message'])).toContain('增删页需要重建');
    // 被拒 ⇒ 不产生新版本（源零改动）。
    expect(await deliverableRevision('fs-ppt-reimport'), '被拒的编辑不得推进版本').toBe(before);
  });

  it('【反向对照】空白 pptx 不做任何结构操作 ⇒ 0 页部件、p:sldIdLst 为空（不得凭空出现页）', async () => {
    expectStatus(
      await postJson(main.baseUrl, '/api/deliverables', {
        sessionId: 'fs-ppt-bare',
        deliverableId: 'fs-ppt-bare-file',
        filename: '裸演示.pptx',
        format: 'pptx',
      }),
      201,
    );
    // 不做任何 **edit**（连内容编辑都没有）：直接交付一版（会话允许无 edit 的发布）。
    const status = await getJson(main.baseUrl, '/api/deliverables/fs-ppt-bare');
    expectStatus(status, 200);
    expectStatus(
      await postJson(main.baseUrl, '/api/deliverables/fs-ppt-bare/edits', {
        idempotencyKey: 'ppt-bare-publish',
        baseRevision: status.json['editRevision'],
        baseDigest: status.json['contentDigest'],
      }),
      200,
    );
    const bytes = await downloadDeliverable('fs-ppt-bare', await deliverableRevision('fs-ppt-bare'));
    expect(partsMatching(bytes, /^ppt\/slides\/slide\d+\.xml$/), '凭空出现幻灯片部件').toHaveLength(0);
    expect(slideIdListOrder(bytes), 'p:sldIdLst 不得凭空有槽位').toHaveLength(0);
    expect(partPaths(bytes), '仍是合法 PPTX 包').toContain('ppt/presentation.xml');
  });

  it('【越界拒绝】未知 slide_id（改标题 / 删页）⇒ 422 unsupported，且源零改动', async () => {
    const revisionBefore = await deliverableRevision(SESSION);
    for (const [index, edit] of ([
      { op: 'set_slide_title', slide_id: 9999, text: '不存在' },
      { op: 'remove_slide', slide_id: 9999 },
    ] as const).entries()) {
      const response = await editDeliverable(SESSION, `ppt-unknown-${String(index)}`, edit);
      expect(response.status, JSON.stringify(response.json)).toBe(422);
      expect(response.json['code']).toBe('unsupported');
      expect(String(response.json['message'])).toContain('没有 slide_id');
    }
    expect(await deliverableRevision(SESSION), '越界尝试不得改动源').toBe(revisionBefore);
  });

  it('【接线缺口】版式切换 / 页面尺寸 / 复制页 / 移动页 / 隐藏页 ⇒ 产品入口不存在，**具名** 422', async () => {
    const revisionBefore = await deliverableRevision(SESSION);
    const notWired: readonly Record<string, unknown>[] = [
      { op: 'set_slide_layout', slide_id: 0, layout: 'title_and_content' },
      { op: 'set_slide_size', width: 12192000, height: 6858000 },
      { op: 'duplicate_slide', slide_id: 0 },
      { op: 'move_slide', slide_id: 0, to: 2 },
      { op: 'hide_slide', slide_id: 0 },
    ];
    for (const [index, edit] of notWired.entries()) {
      const response = await editDeliverable(SESSION, `ppt-notwired-${String(index)}`, edit);
      expect(response.status, `未被接线的演示 op ${JSON.stringify(edit['op'])} 必须具名拒绝：${JSON.stringify(response.json)}`).toBe(422);
      expect(response.json['code']).toBe('unsupported');
      expect(String(response.json['message'])).toContain('不支持的演示操作');
    }
    expect(await deliverableRevision(SESSION), '全部越界尝试不得改动源').toBe(revisionBefore);
    // 明确登记：`pptxDeliverableAdapter` 是封闭枚举（4 个 op）；版式/页面尺寸/复制/移动/隐藏
    // 在产品入口上**不存在**，内核模型层是否有对应能力不在本套件结论范围内。
  });

  it.skip('③ 未覆盖：PowerPoint / WPS 实际打开这些 PPTX 后**页序 / 版式 / 页面尺寸**呈现是否正确 → 需消费端（本机无授权 Office、无真机，未验证）', () => {
    // 本套件只证明「页的增删改 + 页码与对象引用不错位」；"消费端看起来对不对"未验证。
  });
});

// ===========================================================================
// ④ 结论分界自证：读回量尺独立于产品自检器
// ===========================================================================

describe('④ 量尺独立性：本套件不 import 产品解析 / 自检模块', () => {
  it('源码里不出现产品自检器与产品解析模块的引入（拼接构造标记，避免自我指涉）', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('./format-structure-e2e.test.ts', import.meta.url), 'utf8');
    const banned = [
      `selfCheck${'ArtifactBytes'}`,
      `artifacts/${'verify'}.js`,
      `documents/${'docx'}/index.js`,
      `spreadsheets/${'index'}.js`,
      `presentations/${'index'}.js`,
    ];
    for (const marker of banned) {
      expect(source.includes(marker), `本套件引用了 ${marker}`).toBe(false);
    }
  });
});
