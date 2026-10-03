/**
 * **文档工作流的产品端到端链路驱动器**（工作包 FA-DOC-PRODUCT-WORKFLOW）。
 *
 * ## 它解决什么问题
 *
 * `documents-routes.ts` 把 `src/documents/**` 的工作流模块接到了产品 HTTP 面上，但
 * "端点各自可达"与"产品上真能走完一条完整链路"是两件事。本文件把后者写成**可复算的一串步骤**：
 *
 * | # | 步骤 | 产品入口 |
 * |---|---|---|
 * | 1 | 导入真实 DOCX 字节 | `POST /api/documents/:id/import`（文档工作流链） |
 * | 2 | **改正文**（受约束意图作用在正文段落上） | `POST /api/sessions` → `/edits` → `/versions/:n/download`（字处理链） |
 * | 3 | 把改后的真实字节**写回**受管文档 | `POST /api/documents/:id/import` |
 * | 4 | 插表格 + 设列宽 + 合并 | `POST /api/documents/:id/table` |
 * | 5 | 加分页符 / 分节符类型 | `POST /api/documents/:id/pages` |
 * | 6 | 加页脚（页码**域**而非字面量） | `POST /api/documents/:id/header-footer` |
 * | 6.5 | 加自定义栏宽（**必须紧接导出**，原因见下） | `POST /api/documents/:id/pages` |
 * | 7 | 导出真实字节 | `GET /api/documents/:id/export?body=1` |
 * | 8 | 重新导入 + 再导出 | `POST .../import` + `GET .../export?body=1` |
 * | 9 | 读回核对 | 本文件自带的**独立 ZIP 解析器** + 产品读回端点 |
 *
 * ### 为什么"自定义栏宽"排在页脚之前（**实测出的产品行为，不是随手排的顺序**）
 *
 * `documents-routes.ts` 的**每一个**工作流请求都是 `从端口读字节 → importDocx → 操作 → exportDocx → 落端口`。
 * 加上"页脚一旦存在，`pages` 写操作必 500"（实测边界②），"设自定义栏宽"就只能排在**页脚之前**；
 * 而"设完栏宽之后的那个请求又会把栏宽丢掉"（实测边界①）⇒ 栏宽只可能出现在**加页脚前那一份导出**里，
 * 且实际上连那一份也没写出来（同边界①第 1 条）。本驱动器把这三件事都排进链路并逐条断言成事实。
 *
 * ### 为什么"改正文"走字处理链
 *
 * `/api/documents/**` 是**结构工作流**面（表格 / 页面 / 页眉页脚 / 图形 / 公式），它**没有**
 * 正文纯文本编辑入口；产品的正文编辑面是 `/api/sessions/**`（受约束编辑意图）。两条链在
 * **同一个服务进程、同一份运行目录**里，因此本驱动器把"改正文的真实字节"取回来后
 * **写回同一个受管文档**，让链路只有一个受管文档在往下走。这是如实的产品拓扑，不是绕路。
 *
 * ## 独立 ZIP 解析器（**不复用产品自检器**）
 *
 * 第 9 步的读数**不 import 本仓任何解析/自检模块**：EOCD（`0x06054b50`）→ 中央目录
 * （`0x02014b50`）→ 本地文件头（`0x04034b50`）→ `inflateRaw`。理由与既有纪律一致：
 * 若拿内核自己的读回器当量尺，则"读回器分不清容器 / 读不出某项"这类缺陷会同时污染
 * 被测对象与量尺。本文件只依赖字节布局与 `node:zlib`。
 *
 * ## ⚠️ 如实标注（结果不得编造）
 *
 * - **Word 打开核对本轮不做** ⇒ 一切"长什么样"标 **未验证（需消费端）**。
 * - 本文件只证明 **模型态 + 字节往返 + 落盘回读** 三件事。
 * - **实测边界①（自定义栏宽 —— 本轮实测到的产品级缺陷，未修）**：经产品 HTTP **设置自定义栏宽
 *   写不进文件**。两层原因，测试里各有一条用例分别钉住：
 *   1. 导出器 `collectParts()` 的"未改动 ⇒ 写原始字节"判据把 `section_columns` **同时**用在
 *      重建侧与"重解析原始字节"侧，于是"只改栏宽"这唯一的变化被两边同时施加而**互相抵消**
 *      （`rebuilt === reimported`）⇒ 直接写回原始字节，`w:cols` 一个都不写。
 *      对照：只要**同一次导出里正文也有变化**，`w:cols w:num/@w:equalWidth="0"` + 逐栏 `w:col`
 *      就正常写出——通道本身是好的，坏的是那条判据。
 *   2. 即便写进文件，导入器 `parseSectionProperties` 也只读 `w:cols/@w:num`、不读 `w:col`
 *      子元素，因此下一个工作流请求就会把它丢掉。
 *   ⇒ 本驱动器如实报出 {@link DocumentFlowResult.custom_columns_in_file}（**空**）与
 *   {@link DocumentFlowResult.pre_import_equal_columns}（**`null`**），不假装"双向可读回"。
 * - **实测边界②（页眉/页脚引用 ⇒ `pages` 写操作 500 —— 本轮实测到的产品级缺陷，未修）**：
 *   文档**一旦有页眉/页脚引用**，任何 `pages` 写操作都会以 **HTTP 500
 *   `documents_internal_error`** 失败（内核 `DocxError(missing_section_reference_part)`）。
 *   根因不在路由层：`page-workflow.ts` 的 `changedSectionIndices()` 为算 `changed_sections`
 *   去序列化 `w:sectPr`，而 `extrasOfSection()` 只给 `columnsOverride`、**不给
 *   `relationshipIdOf`**，于是带页眉/页脚引用的节在序列化时"找不到 r:id 落点"当场抛错。
 *   本驱动器据此把页脚排在**最后**（`custom_columns` 在它之前）。这是**被发现的事实**，不是设计；
 *   两处修复都在 `src/**`（本工作包无权改）。
 *
 * 【模型身份】交付说明：本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// 独立 ZIP 解析器（只依赖字节布局；不 import 本仓任何模块）
// ---------------------------------------------------------------------------

const EOCD_SIGNATURE = 0x06_05_4b_50;
const CENTRAL_SIGNATURE = 0x02_01_4b_50;
const LOCAL_SIGNATURE = 0x04_03_4b_50;
const EOCD_MIN_LENGTH = 22;
const MAX_COMMENT_LENGTH = 0xff_ff;
const CENTRAL_FIXED_LENGTH = 46;

/** 一个 ZIP 部件（已解压）。 */
export interface ZipEntry {
  readonly name: string;
  /** 压缩方法：`0` = 存储、`8` = deflate。其余方法本解析器**明确拒绝**。 */
  readonly compression: number;
  readonly compressed_size: number;
  readonly uncompressed_size: number;
  /** **解压后**的真实内容。 */
  readonly bytes: Uint8Array;
}

const utf8Decoder = new TextDecoder('utf-8');

/** 在尾部窗口里找 EOCD 的偏移；找不到即抛（不猜）。 */
function findEndOfCentralDirectory(view: DataView, length: number): number {
  const scanFrom = Math.max(0, length - (EOCD_MIN_LENGTH + MAX_COMMENT_LENGTH));
  for (let offset = length - EOCD_MIN_LENGTH; offset >= scanFrom; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) return offset;
  }
  throw new Error('不是合法 ZIP：找不到 EOCD（0x06054b50）');
}

/**
 * 解析 ZIP 包内**全部**部件（含内容）。
 *
 * 只走中央目录（它是权威索引），再按其中的本地头偏移取数据；条目数 0xFFFF（ZIP64）
 * 明确拒绝——"假装支持 ZIP64"会把 64 位偏移读成 32 位垃圾。
 */
export function readZipEntries(bytes: Uint8Array): readonly ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(view, bytes.byteLength);
  const entryCount = view.getUint16(eocd + 10, true);
  if (entryCount === 0xff_ff) {
    throw new Error('ZIP64 的条目计数（0xFFFF）本解析器不支持：请用更小的包');
  }
  let cursor = view.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) {
      throw new Error(`中央目录第 ${String(index)} 条签名不符（不是合法 ZIP）`);
    }
    const compression = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const nameStart = cursor + CENTRAL_FIXED_LENGTH;
    const name = utf8Decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));

    if (view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) {
      throw new Error(`部件 ${name} 的本地文件头签名不符`);
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);

    let content: Uint8Array;
    if (compression === 0) {
      content = raw.slice();
    } else if (compression === 8) {
      content = new Uint8Array(inflateRawSync(Buffer.from(raw)));
    } else {
      throw new Error(`部件 ${name} 用了本解析器不支持的压缩方法 ${String(compression)}（只支持 0 / 8）`);
    }
    if (content.byteLength !== uncompressedSize) {
      throw new Error(
        `部件 ${name} 解压后长度 ${String(content.byteLength)} 与中央目录声明 ${String(uncompressedSize)} 不符`,
      );
    }
    entries.push({
      name,
      compression,
      compressed_size: compressedSize,
      uncompressed_size: uncompressedSize,
      bytes: content,
    });
    cursor = nameStart + nameLength + extraLength + commentLength;
  }
  return Object.freeze(entries);
}

/** 包内部件路径清单（**只读中央目录**；不解压）。 */
export function zipEntryNames(bytes: Uint8Array): readonly string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(view, bytes.byteLength);
  const entryCount = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  const names: string[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) {
      throw new Error(`中央目录第 ${String(index)} 条签名不符（不是合法 ZIP）`);
    }
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const nameStart = cursor + CENTRAL_FIXED_LENGTH;
    names.push(utf8Decoder.decode(bytes.subarray(nameStart, nameStart + nameLength)));
    cursor = nameStart + nameLength + extraLength + commentLength;
  }
  return Object.freeze(names);
}

/** 取某个部件的**真实内容**；不存在返回 `null`（不猜、不造）。 */
export function readZipPart(bytes: Uint8Array, name: string): Uint8Array | null {
  const entry = readZipEntries(bytes).find((item) => item.name === name);
  return entry === undefined ? null : entry.bytes;
}

/** 取某个部件的文本内容；不存在返回 `null`。 */
export function readZipText(bytes: Uint8Array, name: string): string | null {
  const part = readZipPart(bytes, name);
  return part === null ? null : utf8Decoder.decode(part);
}

/** 匹配部件名的全部条目（如全部 `word/footerN.xml`）。 */
export function zipPartsMatching(bytes: Uint8Array, pattern: RegExp): readonly ZipEntry[] {
  return Object.freeze(readZipEntries(bytes).filter((entry) => pattern.test(entry.name)));
}

// ---------------------------------------------------------------------------
// 迷你 XML 读取器（**不 import 本仓 XML 解析器**；只做标签与属性扫描）
// ---------------------------------------------------------------------------

/** 扫出来的一个标签（自闭合与成对标签都可）。 */
export interface ScannedTag {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly self_closing: boolean;
}

const ATTRIBUTE_PATTERN = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*"([^"]*)"/g;

/** 扫出 XML 文本里**指定本地名**（可带前缀）的全部标签。 */
export function findTags(xml: string, qualifiedName: string): readonly ScannedTag[] {
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
    if (next === '/') {
      cursor = end + 1;
      continue;
    }
    const spaceAt = trimmed.search(/[\s/]/);
    const name = spaceAt < 0 ? trimmed : trimmed.slice(0, spaceAt);
    if (name === qualifiedName) {
      const attributes: Record<string, string> = {};
      ATTRIBUTE_PATTERN.lastIndex = 0;
      let match = ATTRIBUTE_PATTERN.exec(trimmed);
      while (match !== null) {
        const attributeName = match[1];
        const attributeValue = match[2];
        if (attributeName !== undefined && attributeValue !== undefined) {
          attributes[attributeName] = attributeValue;
        }
        match = ATTRIBUTE_PATTERN.exec(trimmed);
      }
      found.push({ name, attributes: Object.freeze(attributes), self_closing: selfClosing });
    }
    cursor = end + 1;
  }
  return Object.freeze(found);
}

/** 标签上某个属性的值（`null` = 没有该属性，不是空串）。 */
export function attributeOf(tag: ScannedTag, name: string): string | null {
  const value = tag.attributes[name];
  return value === undefined ? null : value;
}

/** XML 文本里某个标签是否**全部**出现次数都带指定属性值（用于"没有字面量"这类反向对照）。 */
export function countTags(xml: string, qualifiedName: string): number {
  return findTags(xml, qualifiedName).length;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 字节的 sha256（裸小写 hex）。 */
export function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ---------------------------------------------------------------------------
// 链路步骤记录
// ---------------------------------------------------------------------------

/** 链路里的**一条真实 HTTP 交换**（每一次都有方法 / 路径 / 状态码 / 字节数 / 摘要）。 */
export interface FlowStep {
  readonly step: string;
  readonly system: 'documents' | 'session';
  readonly method: string;
  readonly path: string;
  readonly status: number;
  /** 响应里的文档字节数；不返回字节的步骤为 `null`。 */
  readonly bytes: number | null;
  readonly digest: string | null;
}

/** 产品链路的结果（每一步的真相 + 三个关键字节）。 */
export interface DocumentFlowResult {
  readonly steps: readonly FlowStep[];
  readonly document_id: string;
  readonly reimport_document_id: string;
  readonly pre_import_document_id: string;
  readonly session_id: string;
  /** 字处理链**编辑后**下载的真实字节。 */
  readonly edited_bytes: Uint8Array;
  /** 文档工作流链**最终导出**的真实字节（含页脚 + 页码域 + 分页符 + 分节符类型）。 */
  readonly exported_bytes: Uint8Array;
  /** **加页脚之前**那一份导出字节（自定义栏宽只在这一份里活着）。 */
  readonly pre_footer_bytes: Uint8Array;
  /** 重新导入后再导出的真实字节。 */
  readonly reimported_bytes: Uint8Array;
  readonly paragraph_ids: readonly string[];
  readonly table_ids: readonly string[];
  readonly footer_part_path: string;
  /** 自定义栏宽在**加页脚前那份**导出 XML 里的 twips（**模型 → 文件**方向的读数）。 */
  readonly custom_columns_in_file: readonly { readonly width: number; readonly space: number }[];
  /** 重新导入后**模型侧**的栏数（`w:cols/@w:num` 读回）。 */
  readonly reimported_equal_columns: number | null;
  /** 重新导入后**模型侧**的自定义栏宽；**实测为 `null`**（导入器既有缺口，如实标注）。 */
  readonly reimported_custom_columns: readonly { readonly width: number; readonly space: number }[] | null;
  /** 把**加页脚前那份**重新导入后产品读回的栏数。 */
  readonly pre_import_equal_columns: number | null;
  /** 各步骤的原始响应体（按步骤名索引）。 */
  readonly responses: Readonly<Record<string, Record<string, unknown>>>;
}

export interface DocumentFlowInput {
  readonly base: string;
  readonly document_id: string;
  readonly reimport_document_id: string;
  /** 栏宽专项读回用的第三个受管文档 id。 */
  readonly pre_import_document_id: string;
  readonly session_id: string;
  readonly filename: string;
  readonly fixture: Uint8Array;
}

// ---------------------------------------------------------------------------
// HTTP 小工具
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

class FlowRecorder {
  private readonly steps: FlowStep[] = [];
  private readonly bodies: Record<string, Record<string, unknown>> = {};

  record(step: FlowStep, body: Record<string, unknown> = {}): void {
    this.steps.push(step);
    this.bodies[step.step] = body;
  }

  stepOf(name: string): FlowStep {
    const found = this.steps.find((item) => item.step === name);
    if (found === undefined) throw new Error(`链路里没有步骤 ${name}`);
    return found;
  }

  snapshot(): {
    readonly steps: readonly FlowStep[];
    readonly responses: Readonly<Record<string, Record<string, unknown>>>;
  } {
    return { steps: Object.freeze([...this.steps]), responses: Object.freeze({ ...this.bodies }) };
  }
}

interface Exchange {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly bytes: Uint8Array | null;
}

async function callJson(
  base: string,
  method: string,
  path: string,
  payload?: unknown,
): Promise<Exchange> {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(payload === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text.length === 0 ? null : JSON.parse(text);
  } catch {
    parsed = null;
  }
  const body = asRecord(parsed);
  const base64 = body['docx_base64'];
  return {
    status: response.status,
    body,
    bytes: typeof base64 === 'string' ? new Uint8Array(Buffer.from(base64, 'base64')) : null,
  };
}

async function callBytes(base: string, path: string): Promise<Exchange> {
  const response = await fetch(`${base}${path}`);
  const buffer = new Uint8Array(await response.arrayBuffer());
  return { status: response.status, body: {}, bytes: buffer };
}

function requireStatus(step: string, exchange: Exchange, expected: number | readonly number[]): void {
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(exchange.status)) {
    throw new Error(
      `链路步骤 ${step} 期望状态码 ${allowed.join('/')}，实到 ${String(exchange.status)}：` +
        JSON.stringify(exchange.body),
    );
  }
}

// ---------------------------------------------------------------------------
// 链路本体
// ---------------------------------------------------------------------------

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

/**
 * 走完整条文档工作流产品链路。
 *
 * **每一步都真的打产品 HTTP**（同一个 `createDemoServer` 起的服务），并且**状态码不符即抛**——
 * "静默继续"正是本工作包要消灭的失败模式。返回的每一步都带状态码与字节数，供测试逐条断言。
 */
export async function runDocumentProductFlow(input: DocumentFlowInput): Promise<DocumentFlowResult> {
  const {
    base,
    document_id: documentId,
    reimport_document_id: reimportId,
    pre_import_document_id: preImportId,
    session_id: sessionId,
  } = input;
  const recorder = new FlowRecorder();

  const record = (
    step: string,
    system: FlowStep['system'],
    method: string,
    path: string,
    exchange: Exchange,
    byteCount: number | null,
  ): void => {
    recorder.record(
      {
        step,
        system,
        method,
        path,
        status: exchange.status,
        bytes: byteCount,
        digest: byteCount === null ? null : null,
      },
      exchange.body,
    );
  };

  // 1) 就绪 -----------------------------------------------------------------
  const status = await callJson(base, 'GET', '/api/documents/status');
  requireStatus('documents.status', status, 200);
  record('documents.status', 'documents', 'GET', '/api/documents/status', status, null);

  // 2) 导入 -----------------------------------------------------------------
  const imported = await callJson(base, 'POST', `/api/documents/${documentId}/import`, {
    docx_base64: b64(input.fixture),
  });
  requireStatus('documents.import', imported, 200);
  if (imported.body['persisted'] !== true) {
    throw new Error('导入未落盘（persisted !== true）');
  }
  record('documents.import', 'documents', 'POST', `/api/documents/${documentId}/import`, imported, input.fixture.byteLength);

  // 3) 改正文：字处理链（受约束意图作用在正文段落上） -----------------------
  const opened = await callJson(base, 'POST', '/api/sessions', {
    sessionId,
    filename: input.filename,
    mode: 'import',
    docxBase64: b64(input.fixture),
  });
  requireStatus('session.open', opened, 201);
  record('session.open', 'session', 'POST', '/api/sessions', opened, null);

  const edit = await callJson(base, 'POST', `/api/sessions/${sessionId}/edits`, {
    idempotencyKey: `${sessionId}-body-1`,
    baseRevision: opened.body['editRevision'],
    baseDigest: opened.body['contentDigest'],
    intent: { steps: [{ range: '第2段', operation: { kind: 'setAlignment', alignment: 'center' } }] },
  });
  requireStatus('session.edit_body', edit, 200);
  if (edit.body['changed'] === false || edit.body['noOp'] === true) {
    throw new Error(`改正文没有真的改动正文：${JSON.stringify(edit.body)}`);
  }
  record('session.edit_body', 'session', 'POST', `/api/sessions/${sessionId}/edits`, edit, null);

  const editRevision = edit.body['editRevision'];
  if (typeof editRevision !== 'number') {
    throw new Error(`改正文响应缺少 editRevision：${JSON.stringify(edit.body)}`);
  }
  const edited = await callBytes(base, `/api/sessions/${sessionId}/versions/${String(editRevision)}/download`);
  requireStatus('session.download_body', edited, 200);
  const editedBytes = edited.bytes;
  if (editedBytes === null) throw new Error('改正文下载没有字节');
  record(
    'session.download_body',
    'session',
    'GET',
    `/api/sessions/${sessionId}/versions/${String(editRevision)}/download`,
    edited,
    editedBytes.byteLength,
  );

  // 4) 写回受管文档 ---------------------------------------------------------
  const writeBack = await callJson(base, 'POST', `/api/documents/${documentId}/import`, {
    docx_base64: b64(editedBytes),
  });
  requireStatus('documents.write_back', writeBack, 200);
  record('documents.write_back', 'documents', 'POST', `/api/documents/${documentId}/import`, writeBack, editedBytes.byteLength);

  // 5) 正文块 id（插分页符要用） --------------------------------------------
  const summaryBefore = await callJson(base, 'GET', `/api/documents/${documentId}/summary`);
  requireStatus('documents.summary', summaryBefore, 200);
  record('documents.summary', 'documents', 'GET', `/api/documents/${documentId}/summary`, summaryBefore, null);
  const paragraphIds = (summaryBefore.body['paragraph_ids'] as string[] | undefined) ?? [];
  if (paragraphIds.length === 0) throw new Error('受管文档没有正文段落，无法插分页符');

  // 6) 插表格 ---------------------------------------------------------------
  const table = await callJson(base, 'POST', `/api/documents/${documentId}/table`, {
    operation: { kind: 'insert', rows: 2, columns: 3, text_prefix: '格' },
  });
  requireStatus('documents.table_insert', table, 200);
  record('documents.table_insert', 'documents', 'POST', `/api/documents/${documentId}/table`, table, null);
  const tableIds = (asRecord(table.body['summary'])['table_ids'] as string[] | undefined) ?? [];
  const tableId = tableIds[0];
  if (tableId === undefined) throw new Error('插表格后没有 table_id');

  const columnWidth = await callJson(base, 'POST', `/api/documents/${documentId}/table`, {
    operation: { kind: 'set_column_width', table_id: tableId, column: 0, width: { unit: 'mm', value: 30 } },
  });
  requireStatus('documents.table_column_width', columnWidth, 200);
  record('documents.table_column_width', 'documents', 'POST', `/api/documents/${documentId}/table`, columnWidth, null);

  const merge = await callJson(base, 'POST', `/api/documents/${documentId}/table`, {
    operation: { kind: 'merge', table_id: tableId, region: { top: 0, left: 0, rows: 1, columns: 2 } },
  });
  requireStatus('documents.table_merge', merge, 200);
  if (asRecord(merge.body['detail'])['content_preserved'] !== true) {
    throw new Error(`合并未保住内容：${JSON.stringify(merge.body)}`);
  }
  record('documents.table_merge', 'documents', 'POST', `/api/documents/${documentId}/table`, merge, null);

  // 7) 分页符 ---------------------------------------------------------------
  const pageBreak = await callJson(base, 'POST', `/api/documents/${documentId}/pages`, {
    operation: { kind: 'insert_page_break', block_id: paragraphIds[0], offset: 0 },
  });
  requireStatus('documents.page_break', pageBreak, 200);
  record('documents.page_break', 'documents', 'POST', `/api/documents/${documentId}/pages`, pageBreak, null);

  // 8) 分节符类型 -----------------------------------------------------------
  const sectionType = await callJson(base, 'POST', `/api/documents/${documentId}/pages`, {
    operation: { kind: 'set_section_start_type', section_index: 0, type: 'continuous' },
  });
  requireStatus('documents.section_type', sectionType, 200);
  if (asRecord(sectionType.body['detail'])['start_type'] !== 'continuous') {
    throw new Error(`分节符类型没写进去：${JSON.stringify(sectionType.body)}`);
  }
  record('documents.section_type', 'documents', 'POST', `/api/documents/${documentId}/pages`, sectionType, null);

  // 9) 自定义栏宽（**必须紧接导出**：下一个工作流请求会因导入器不读 `w:col` 而丢宽） --
  //
  // 顺序说明见文件头"为什么自定义栏宽必须紧接导出"。这里排在**页脚之前**还有第二个理由：
  // 文档一旦有页眉/页脚引用，**任何 `pages` 写操作都会 500**（见文件头"实测边界②"）。
  const customColumns = await callJson(base, 'POST', `/api/documents/${documentId}/pages`, {
    operation: {
      kind: 'set_custom_columns',
      section_index: 0,
      columns: [
        { width: { unit: 'mm', value: 60 }, space: { unit: 'mm', value: 5 } },
        { width: { unit: 'mm', value: 60 }, space: { unit: 'mm', value: 5 } },
      ],
    },
  });
  requireStatus('documents.custom_columns', customColumns, 200);
  record('documents.custom_columns', 'documents', 'POST', `/api/documents/${documentId}/pages`, customColumns, null);

  // 10) 导出（加页脚之前的那一份；栏宽只在这一份里活着） ----------------------
  const preFooter = await callJson(base, 'GET', `/api/documents/${documentId}/export?body=1`);
  requireStatus('documents.export_pre_footer', preFooter, 200);
  const preFooterBytes = preFooter.bytes;
  if (preFooterBytes === null) throw new Error('加页脚前的导出没有字节');
  record(
    'documents.export_pre_footer',
    'documents',
    'GET',
    `/api/documents/${documentId}/export?body=1`,
    preFooter,
    preFooterBytes.byteLength,
  );

  // 11) 栏宽专项读回：把这**一份**重新导入，用产品读数核对栏数 ------------------
  const preImport = await callJson(base, 'POST', `/api/documents/${preImportId}/import`, {
    docx_base64: b64(preFooterBytes),
  });
  requireStatus('documents.pre_import', preImport, 200);
  record('documents.pre_import', 'documents', 'POST', `/api/documents/${preImportId}/import`, preImport, preFooterBytes.byteLength);

  const preColumns = await callJson(base, 'POST', `/api/documents/${preImportId}/pages`, {
    operation: { kind: 'column_layout', section_index: 0 },
  });
  requireStatus('documents.readback_columns_pre_footer', preColumns, 200);
  record(
    'documents.readback_columns_pre_footer',
    'documents',
    'POST',
    `/api/documents/${preImportId}/pages`,
    preColumns,
    null,
  );

  // 12) 页脚页码域（页眉/页脚部件 + 页码**域**） -----------------------------
  const footer = await callJson(base, 'POST', `/api/documents/${documentId}/header-footer`, {
    operation: {
      kind: 'create_part',
      role: 'footer',
      variant: 'default',
      section_index: 0,
      content: ['第 ', { field: 'page' }, ' 页'],
    },
  });
  requireStatus('documents.footer_page_field', footer, 200);
  record('documents.footer_page_field', 'documents', 'POST', `/api/documents/${documentId}/header-footer`, footer, null);
  const footerPartPath = footer.body['detail'];
  const footerPath =
    typeof asRecord(footerPartPath)['part_path'] === 'string'
      ? (asRecord(footerPartPath)['part_path'] as string)
      : '';

  // 13) 导出（最终那一份：页脚 + 页码域 + 分页符 + 分节符类型） ---------------
  const exported = await callJson(base, 'GET', `/api/documents/${documentId}/export?body=1`);
  requireStatus('documents.export', exported, 200);
  const exportedBytes = exported.bytes;
  if (exportedBytes === null) throw new Error('导出响应没有 docx_base64');
  record('documents.export', 'documents', 'GET', `/api/documents/${documentId}/export?body=1`, exported, exportedBytes.byteLength);

  // 14) 重新导入 + 再导出 --------------------------------------------------
  const reimport = await callJson(base, 'POST', `/api/documents/${reimportId}/import`, {
    docx_base64: b64(exportedBytes),
  });
  requireStatus('documents.reimport', reimport, 200);
  record('documents.reimport', 'documents', 'POST', `/api/documents/${reimportId}/import`, reimport, exportedBytes.byteLength);

  const reExported = await callJson(base, 'GET', `/api/documents/${reimportId}/export?body=1`);
  requireStatus('documents.reimport_export', reExported, 200);
  const reimportedBytes = reExported.bytes;
  if (reimportedBytes === null) throw new Error('重新导入后再导出没有字节');
  record(
    'documents.reimport_export',
    'documents',
    'GET',
    `/api/documents/${reimportId}/export?body=1`,
    reExported,
    reimportedBytes.byteLength,
  );

  // 13) 读回核对（独立 ZIP 解析器 + 产品读回端点） -------------------------
  const documentXml = readZipText(exportedBytes, 'word/document.xml');
  if (documentXml === null) throw new Error('导出包里没有 word/document.xml');
  const preFooterXml = readZipText(preFooterBytes, 'word/document.xml');
  if (preFooterXml === null) throw new Error('加页脚前的导出包里没有 word/document.xml');

  // 自定义栏宽从**加页脚前的那一份**读：最终那份里它已因导入器缺口丢掉（如实）。
  const colTags = findTags(preFooterXml, 'w:col').map((tag) => ({
    width: Number(attributeOf(tag, 'w:w') ?? 'NaN'),
    space: Number(attributeOf(tag, 'w:space') ?? 'NaN'),
  }));
  const customColumnsInFile = Object.freeze(colTags);

  const readBackSection = await callJson(base, 'POST', `/api/documents/${reimportId}/pages`, {
    operation: { kind: 'snapshot', section_index: 0 },
  });
  requireStatus('documents.readback_section', readBackSection, 200);
  record('documents.readback_section', 'documents', 'POST', `/api/documents/${reimportId}/pages`, readBackSection, null);

  const readBackColumns = await callJson(base, 'POST', `/api/documents/${reimportId}/pages`, {
    operation: { kind: 'column_layout', section_index: 0 },
  });
  requireStatus('documents.readback_columns', readBackColumns, 200);
  record('documents.readback_columns', 'documents', 'POST', `/api/documents/${reimportId}/pages`, readBackColumns, null);

  const readBackFooter = await callJson(base, 'POST', `/api/documents/${reimportId}/header-footer`, {
    operation: { kind: 'report', section_index: 0 },
  });
  requireStatus('documents.readback_footer', readBackFooter, 200);
  record('documents.readback_footer', 'documents', 'POST', `/api/documents/${reimportId}/header-footer`, readBackFooter, null);

  // 重新导入后的模型侧栏宽：`w:cols/@w:num` 会回来，`w:col` 不会（内核既有缺口）。
  const layout = asRecord(asRecord(readBackColumns.body['detail'])['layout']);
  const equalColumns = typeof layout['count'] === 'number' ? layout['count'] : null;
  const modelCustom: readonly { readonly width: number; readonly space: number }[] | null =
    layout['kind'] === 'custom' && Array.isArray(layout['columns'])
      ? (layout['columns'] as { readonly width: number; readonly space: number }[])
      : null;
  const preLayout = asRecord(asRecord(preColumns.body['detail'])['layout']);
  const preEqualColumns = typeof preLayout['count'] === 'number' ? preLayout['count'] : null;

  const snapshot = recorder.snapshot();
  const withDigests: readonly FlowStep[] = snapshot.steps.map((step) => {
    if (step.step === 'documents.export') return { ...step, digest: sha256Of(exportedBytes) };
    if (step.step === 'documents.export_pre_footer') return { ...step, digest: sha256Of(preFooterBytes) };
    if (step.step === 'documents.reimport_export') return { ...step, digest: sha256Of(reimportedBytes) };
    if (step.step === 'session.download_body') return { ...step, digest: sha256Of(editedBytes) };
    return step;
  });

  return Object.freeze({
    steps: Object.freeze(withDigests),
    document_id: documentId,
    reimport_document_id: reimportId,
    pre_import_document_id: preImportId,
    session_id: sessionId,
    edited_bytes: editedBytes,
    exported_bytes: exportedBytes,
    pre_footer_bytes: preFooterBytes,
    reimported_bytes: reimportedBytes,
    paragraph_ids: Object.freeze([...paragraphIds]),
    table_ids: Object.freeze([...tableIds]),
    footer_part_path: footerPath,
    custom_columns_in_file: customColumnsInFile,
    reimported_equal_columns: equalColumns,
    // 只有真的读回了自定义栏宽才有值；读不回就是 `null`（**不假装**）。
    reimported_custom_columns: modelCustom,
    pre_import_equal_columns: preEqualColumns,
    responses: snapshot.responses,
  });
}

/** 重新导入后的包里是否还残留 `w:col` 子元素（用于如实报出导入侧缺口）。 */
export function customColumnsSurviveReimport(bytes: Uint8Array): boolean {
  const documentXml = readZipText(bytes, 'word/document.xml');
  return documentXml !== null && findTags(documentXml, 'w:col').length > 0;
}

/**
 * 导出的包内存不存在**页码域**（`w:fldSimple/@w:instr` 或 `w:instrText`）。
 *
 * 两种写法都算域（与 `header-footer-workflow` 的两种形式对应）；**字面量不算**。
 */
export function pageFieldEvidence(partXml: string): {
  readonly fldSimple: readonly string[];
  readonly instrText: readonly string[];
  readonly has_page_field: boolean;
  readonly has_numpages_field: boolean;
} {
  const fldSimple = findTags(partXml, 'w:fldSimple')
    .map((tag) => attributeOf(tag, 'w:instr'))
    .filter((value): value is string => value !== null);
  const instrText = findTags(partXml, 'w:instrText').length;
  const instrTextValues: string[] = [];
  // `w:instrText` 的文本是元素内容：用最小扫描取出 `<w:instrText ...>TEXT</w:instrText>` 的 TEXT。
  const pattern = /<w:instrText\b[^>]*>([^<]*)<\/w:instrText>/g;
  let match = pattern.exec(partXml);
  while (match !== null) {
    const value = match[1];
    if (value !== undefined && value.length > 0) instrTextValues.push(value);
    match = pattern.exec(partXml);
  }
  const all = [...fldSimple, ...instrTextValues];
  return {
    fldSimple: Object.freeze(fldSimple),
    instrText: Object.freeze(instrTextValues),
    has_page_field: all.some((value) => /\bPAGE\b/.test(value)),
    has_numpages_field: all.some((value) => /\bNUMPAGES\b/.test(value)),
  };
}
