/**
 * **产物字节的结构自检**（design-02 P1；合同 v1.4 R53.1 的**第 1 层**）。
 *
 * ## 这一层能证明什么、**证不了**什么（不得混淆，也不得在返回值里暗示更强的主张）
 *
 * | 层 | 由谁做 | 能证明 | **不能**证明 |
 * |---|---|---|---|
 * | **1 结构自检（本文件）** | 内核（提交前） | **构建器内部自洽**：中央目录可遍历、条目 CRC 自校、STORE 尺寸一致、XML 良构、关系引用有对应部件 | **不能**证明 Word / Excel / PowerPoint 能打开 |
 * | 2 独立读回 | 验收侧（Python `zipfile` + `xml.etree`、`unzip -t`） | 结构合法 + 关键内容与任务版本一致 | 不能证明目标软件能打开 |
 * | 3 目标软件打开 | 验收侧（`tests/acceptance/office/office-open-check.ts` 的 Office COM 打开） | "目标软件可打开"的**实测**证据 | 不证明编辑体验等价于办公套件 |
 *
 * **本文件只做第 1 层**。它与 ZIP / XML **写入器同源**（同一个 W-A 模块族），因此它挡住的是
 * "构建器明显坏了"（写歪了、CRC 对不上、标签不配平、关系引用了空气），**不是**容器格式的
 * 独立验证。任何"产物可打开 / 已交付"的主张都**必须**另找第 2、3 层的证据——第 3 层归
 * `tests/acceptance/office/office-open-check.ts`，本文件不跑、不引用、不代答。
 *
 * ## 为什么是极简读回器而不是解析库
 *
 * - 本项目 `src/**` 零新增依赖（合同 §9）；且这里要的不是"通用 ZIP 支持"，而是
 *   "把可疑字节挡在提交之前"。因此只支持**本批写出的形态**：全 STORE、无 ZIP64、
 *   无数据描述符、无加密（R51.1 / R51.2）。遇到不认识的形态（如 deflate）**如实报问题**，
 *   **不**假装通过（无法重算 CRC 就不能声称 CRC 对）。
 * - CRC 与关系目标解析**复用既有实现**（`ooxml/crc32.ts`、`ooxml/opc.ts`），
 *   不造第二套——"同一个校验器"恰恰是这一层该有的形状。
 *
 * ## 契约
 *
 * **不抛错**：输入哪怕是任意垃圾字节，也返回结构化结果 `{ ok, problems }`。
 * 调用方（物化端口 / 发布路径）据此落 `self_check_failed` 或继续。
 */

import { crc32 } from './ooxml/crc32.js';
import {
  CONTENT_TYPES_PART_PATH,
  ROOT_RELATIONSHIPS_PART_PATH,
  resolveRelationshipTarget,
} from './ooxml/opc.js';
import { XML_DECLARATION } from './ooxml/xml.js';

/** 本自检所属的验证层（R53.1）：恒为 1。报告里带上它，避免被当成第 2/3 层引用。 */
export const ARTIFACT_SELF_CHECK_LAYER = 1 as const;
export type ArtifactSelfCheckLayer = typeof ARTIFACT_SELF_CHECK_LAYER;

/**
 * 能力边界的**机器可读**陈述（证据文本直接引用它，免得有人把"自检通过"读成"能打开"）。
 */
export const SELF_CHECK_SCOPE_STATEMENT =
  '第 1 层结构自检只证明构建器内部自洽（ZIP 中央目录可遍历、CRC 自校、STORE 尺寸一致、' +
  'XML 良构、关系目标存在），**不能**证明 Word / Excel / PowerPoint 能打开；' +
  '后者是第 3 层（tests/acceptance/office/office-open-check.ts）。';

/** 问题种类（封闭枚举；具体定位在 `detail` 里，不靠种类名承载细节）。 */
export const ARTIFACT_SELF_CHECK_PROBLEM_KINDS = [
  /** 连 ZIP 尾部结构都找不到。 */
  'not_a_zip',
  /** 找得到 EOCD 但中央目录越界 / 被截断。 */
  'central_directory_truncated',
  /** 某条目在归档里越界（本地头或数据越界）。 */
  'entry_out_of_range',
  /** 条目路径不合法（非 ASCII、前导斜杠、`..` 段等）。 */
  'entry_name_invalid',
  /** 同一条路径出现两次（读侧无法确定指向哪一份）。 */
  'duplicate_entry',
  /** 压缩方法不是 STORE（本读回器无法重算 CRC，**如实报**，不假装通过）。 */
  'compression_not_store',
  /** 重算的 CRC 与中央目录记录的不符 —— 字节被改动过或构建器写错了。 */
  'crc_mismatch',
  /** STORE 条目的压缩长度 ≠ 原始长度（STORE 的定义就是两者相等）。 */
  'size_mismatch',
  /** 缺 `[Content_Types].xml`（OPC 包的必备部件）。 */
  'missing_content_types',
  /** 缺 `_rels/.rels`（包级关系的必备部件）。 */
  'missing_root_relationships',
  /** XML 部件带 BOM（写入器固定无 BOM；带 BOM 说明字节来源不是本构建器）。 */
  'xml_has_bom',
  /** XML 声明不是固定声明（版本 / 编码 / standalone 漂了）。 */
  'xml_declaration_invalid',
  /** XML 标签不配平 / 结构上不成立。 */
  'xml_not_well_formed',
  /** 关系目标解析失败（逃出包根 / 解析后为空）。 */
  'relationship_target_invalid',
  /** 关系的内部 `Target` 指向一份不存在的部件。 */
  'relationship_target_missing',
] as const;
export type ArtifactSelfCheckProblemKind = (typeof ARTIFACT_SELF_CHECK_PROBLEM_KINDS)[number];

export interface ArtifactSelfCheckProblem {
  readonly kind: ArtifactSelfCheckProblemKind;
  readonly detail: string;
}

/** 读回所见的一条条目（与中央目录**记录**的字段 + **重算**的字段并列，便于对照证据）。 */
export interface ArtifactSelfCheckEntry {
  readonly path: string;
  /** 中央目录记录的压缩方法。 */
  readonly method: number;
  /** 中央目录记录的 CRC32。 */
  readonly recorded_crc32: number;
  /** 对归档内实际字节**重算**的 CRC32（非 STORE 或越界时为 null）。 */
  readonly recomputed_crc32: number | null;
  readonly compressed_size: number;
  readonly uncompressed_size: number;
}

export interface ArtifactSelfCheckResult {
  /** `problems` 为空 ⇔ true。 */
  readonly ok: boolean;
  /** 恒为 1（R53.1）。 */
  readonly layer: ArtifactSelfCheckLayer;
  readonly problems: readonly ArtifactSelfCheckProblem[];
  /** 中央目录里读到的条目（顺序即字节顺序）。 */
  readonly entries: readonly ArtifactSelfCheckEntry[];
  /** 中央目录声明的条目数。 */
  readonly entry_count: number;
  readonly bytes_checked: number;
}

// ---------------------------------------------------------------------------
// ZIP 常量（读懂本批写出的形态即可，不求通用）
// ---------------------------------------------------------------------------

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const EOCD_SIZE = 22;
const CENTRAL_DIRECTORY_HEADER_SIZE = 46;
const LOCAL_FILE_HEADER_SIZE = 30;
const MAX_COMMENT_LENGTH = 0xffff;
const COMPRESSION_METHOD_STORE = 0;

interface CentralDirectoryEntry {
  readonly path: string;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
}

/** UTF-8 解码器（只用于把部件字节变成文本做良构性扫描；不参与任何判定口径）。 */
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: false });

function readUint16(view: DataView, offset: number): number | null {
  if (offset < 0 || offset + 2 > view.byteLength) return null;
  return view.getUint16(offset, true);
}

function readUint32(view: DataView, offset: number): number | null {
  if (offset < 0 || offset + 4 > view.byteLength) return null;
  return view.getUint32(offset, true);
}

/** 从尾部往前找 EOCD（注释长度必须与剩余字节吻合，避免撞上恰好同值的载荷字节）。 */
function findEndOfCentralDirectory(view: DataView): number | null {
  const minimum = Math.max(0, view.byteLength - (EOCD_SIZE + MAX_COMMENT_LENGTH));
  for (let offset = view.byteLength - EOCD_SIZE; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) !== EOCD_SIGNATURE) continue;
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + EOCD_SIZE + commentLength === view.byteLength) return offset;
  }
  return null;
}

function readCentralDirectory(
  view: DataView,
  problems: ArtifactSelfCheckProblem[],
): readonly CentralDirectoryEntry[] | null {
  const eocd = findEndOfCentralDirectory(view);
  if (eocd === null) {
    problems.push({
      kind: 'not_a_zip',
      detail: `未找到中央目录结束记录（EOCD 签名 0x06054b50）：${String(view.byteLength)} 字节不构成 ZIP 归档`,
    });
    return null;
  }
  const declaredCount = readUint16(view, eocd + 10);
  const directorySize = readUint32(view, eocd + 12);
  const directoryOffset = readUint32(view, eocd + 16);
  if (declaredCount === null || directorySize === null || directoryOffset === null) {
    problems.push({ kind: 'central_directory_truncated', detail: 'EOCD 字段越界' });
    return null;
  }
  if (directoryOffset + directorySize > view.byteLength) {
    problems.push({
      kind: 'central_directory_truncated',
      detail:
        `中央目录越界：offset=${String(directoryOffset)} size=${String(directorySize)} ` +
        `但只有 ${String(view.byteLength)} 字节`,
    });
    return null;
  }

  const entries: CentralDirectoryEntry[] = [];
  let cursor = directoryOffset;
  for (let index = 0; index < declaredCount; index += 1) {
    const signature = readUint32(view, cursor);
    if (signature !== CENTRAL_DIRECTORY_SIGNATURE) {
      problems.push({
        kind: 'central_directory_truncated',
        detail: `中央目录第 ${String(index + 1)} 项签名不是 0x02014b50（cursor=${String(cursor)}）`,
      });
      return entries;
    }
    const method = readUint16(view, cursor + 10);
    const crc = readUint32(view, cursor + 16);
    const compressedSize = readUint32(view, cursor + 20);
    const uncompressedSize = readUint32(view, cursor + 24);
    const nameLength = readUint16(view, cursor + 28);
    const extraLength = readUint16(view, cursor + 30);
    const commentLength = readUint16(view, cursor + 32);
    const localHeaderOffset = readUint32(view, cursor + 42);
    if (
      method === null ||
      crc === null ||
      compressedSize === null ||
      uncompressedSize === null ||
      nameLength === null ||
      extraLength === null ||
      commentLength === null ||
      localHeaderOffset === null
    ) {
      problems.push({ kind: 'central_directory_truncated', detail: '中央目录项字段越界' });
      return entries;
    }
    const nameStart = cursor + CENTRAL_DIRECTORY_HEADER_SIZE;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > view.byteLength) {
      problems.push({ kind: 'central_directory_truncated', detail: '中央目录项文件名越界' });
      return entries;
    }
    const path = UTF8_DECODER.decode(
      new Uint8Array(view.buffer, view.byteOffset + nameStart, nameLength),
    );
    entries.push({
      path,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    cursor = nameEnd + extraLength + commentLength;
  }
  return entries;
}

/** ZIP 条目路径的合法性（与写入器同一条纪律：正斜杠、无前导斜杠、无 `.`/`..` 段）。 */
function isSaneEntryPath(path: string): boolean {
  if (path.length === 0 || path.startsWith('/') || path.includes('\\')) return false;
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return false;
  }
  return true;
}

/** 条目检查的内部产出：公开的条目记录 + **仅当 CRC 校验通过时**保留的原始数据。 */
interface CheckedEntries {
  readonly entries: readonly ArtifactSelfCheckEntry[];
  /** 路径 → 归档内实际字节（仅 STORE 且未越界的条目；供 XML 检查复用，不重复定位）。 */
  readonly dataByPath: ReadonlyMap<string, Uint8Array>;
}

function checkZipEntries(
  view: DataView,
  entries: readonly CentralDirectoryEntry[],
  problems: ArtifactSelfCheckProblem[],
): CheckedEntries {
  const seen = new Set<string>();
  const checked: ArtifactSelfCheckEntry[] = [];
  const dataByPath = new Map<string, Uint8Array>();

  for (const entry of entries) {
    if (!isSaneEntryPath(entry.path)) {
      problems.push({
        kind: 'entry_name_invalid',
        detail: `条目路径不合法：${JSON.stringify(entry.path)}`,
      });
    }
    if (seen.has(entry.path)) {
      problems.push({ kind: 'duplicate_entry', detail: `条目路径重复：${JSON.stringify(entry.path)}` });
    }
    seen.add(entry.path);

    if (entry.method !== COMPRESSION_METHOD_STORE) {
      // 无法重算 CRC ⇒ 如实报，不假装通过（R51.1 保证本批只会出现 STORE）。
      problems.push({
        kind: 'compression_not_store',
        detail:
          `条目 ${JSON.stringify(entry.path)} 的压缩方法为 ${String(entry.method)}（非 STORE）：` +
          '本读回器不解压，无法重算 CRC，因此不对其内容作任何断言',
      });
      checked.push({
        path: entry.path,
        method: entry.method,
        recorded_crc32: entry.crc,
        recomputed_crc32: null,
        compressed_size: entry.compressedSize,
        uncompressed_size: entry.uncompressedSize,
      });
      continue;
    }

    if (entry.compressedSize !== entry.uncompressedSize) {
      problems.push({
        kind: 'size_mismatch',
        detail:
          `条目 ${JSON.stringify(entry.path)} 是 STORE 却压缩长度(${String(entry.compressedSize)})` +
          ` ≠ 原始长度(${String(entry.uncompressedSize)})`,
      });
    }

    const localSignature = readUint32(view, entry.localHeaderOffset);
    if (localSignature !== LOCAL_FILE_HEADER_SIGNATURE) {
      problems.push({
        kind: 'entry_out_of_range',
        detail:
          `条目 ${JSON.stringify(entry.path)} 的本地头签名不是 0x04034b50` +
          `（offset=${String(entry.localHeaderOffset)}）`,
      });
      checked.push({
        path: entry.path,
        method: entry.method,
        recorded_crc32: entry.crc,
        recomputed_crc32: null,
        compressed_size: entry.compressedSize,
        uncompressed_size: entry.uncompressedSize,
      });
      continue;
    }
    const localNameLength = readUint16(view, entry.localHeaderOffset + 26);
    const localExtraLength = readUint16(view, entry.localHeaderOffset + 28);
    if (localNameLength === null || localExtraLength === null) {
      problems.push({ kind: 'entry_out_of_range', detail: `条目 ${entry.path} 的本地头字段越界` });
      continue;
    }
    const dataStart = entry.localHeaderOffset + LOCAL_FILE_HEADER_SIZE + localNameLength + localExtraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataStart > view.byteLength || dataEnd > view.byteLength) {
      problems.push({
        kind: 'entry_out_of_range',
        detail:
          `条目 ${JSON.stringify(entry.path)} 的数据区越界：` +
          `[${String(dataStart)}, ${String(dataEnd)}) 超出 ${String(view.byteLength)} 字节`,
      });
      checked.push({
        path: entry.path,
        method: entry.method,
        recorded_crc32: entry.crc,
        recomputed_crc32: null,
        compressed_size: entry.compressedSize,
        uncompressed_size: entry.uncompressedSize,
      });
      continue;
    }

    const data = new Uint8Array(view.buffer, view.byteOffset + dataStart, entry.compressedSize);
    dataByPath.set(entry.path, data);
    const recomputed = crc32(data) >>> 0;
    if (recomputed !== (entry.crc >>> 0)) {
      problems.push({
        kind: 'crc_mismatch',
        detail:
          `条目 ${JSON.stringify(entry.path)} 的 CRC32 不符：` +
          `中央目录记录 0x${entry.crc.toString(16).padStart(8, '0')}，` +
          `重算 0x${recomputed.toString(16).padStart(8, '0')}（字节被改动过，或构建器写错了）`,
      });
    }
    checked.push({
      path: entry.path,
      method: entry.method,
      recorded_crc32: entry.crc,
      recomputed_crc32: recomputed,
      compressed_size: entry.compressedSize,
      uncompressed_size: entry.uncompressedSize,
    });
  }
  return { entries: checked, dataByPath };
}

// ---------------------------------------------------------------------------
// XML 良构性（够用的最小扫描器：抓"标签不配平"，不替代 XML 解析器）
// ---------------------------------------------------------------------------

/** 引号感知地找标签结束的 `>`（属性值里的 `>` 由写入器转义，这里仍按引号走以防万一）。 */
function findTagEnd(text: string, from: number): number {
  let quote: string | null = null;
  for (let index = from; index < text.length; index += 1) {
    const character = text[index];
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '>') return index;
  }
  return -1;
}

/**
 * 标签配平扫描（**只做结构**：不查元素名对应的 OOXML 模式、不解析命名空间）。
 *
 * 处理 `<!-- 注释 -->`、`<![CDATA[…]]>`、`<?…?>`、`<!…>`（DOCTYPE）；元素名取 `<` 之后
 * 到空白 / `/` / `>` 之前的片段；自闭合 `<a/>` 不入栈。
 */
function scanTagBalance(text: string, path: string, problems: ArtifactSelfCheckProblem[]): void {
  const stack: string[] = [];
  let index = 0;
  const reportAndStop = (detail: string): void => {
    problems.push({
      kind: 'xml_not_well_formed',
      detail: `部件 ${JSON.stringify(path)} ${detail}`,
    });
  };

  while (index < text.length) {
    const open = text.indexOf('<', index);
    if (open < 0) break;

    if (text.startsWith('<!--', open)) {
      const end = text.indexOf('-->', open + 4);
      if (end < 0) return reportAndStop('有未闭合的注释');
      index = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', open)) {
      const end = text.indexOf(']]>', open + 9);
      if (end < 0) return reportAndStop('有未闭合的 CDATA 段');
      index = end + 3;
      continue;
    }
    if (text.startsWith('<?', open) || text.startsWith('<!', open)) {
      const end = text.indexOf('>', open + 2);
      if (end < 0) return reportAndStop('有未闭合的处理指令 / 声明');
      index = end + 1;
      continue;
    }

    const close = findTagEnd(text, open + 1);
    if (close < 0) return reportAndStop('有未闭合的标签（找不到 ">"）');
    const raw = text.slice(open + 1, close);
    index = close + 1;

    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim();
      if (name.length === 0) return reportAndStop('出现空的结束标签 </>');
      const expected = stack.pop();
      if (expected === undefined) {
        return reportAndStop(`出现多余的结束标签 </${name}>（没有对应的开始标签）`);
      }
      if (expected !== name) {
        return reportAndStop(`标签不配平：</${name}> 对应的是 <${expected}>`);
      }
      continue;
    }

    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const nameEnd = body.search(/[\s/]/);
    const name = nameEnd < 0 ? body.trim() : body.slice(0, nameEnd).trim();
    if (name.length === 0) return reportAndStop('出现无名标签');
    if (!selfClosing) stack.push(name);
  }

  if (stack.length > 0) {
    reportAndStop(`标签未闭合（栈内剩余 ${stack.length} 个，最深为 <${stack[stack.length - 1] ?? ''}>）`);
  }
}

function checkXmlPart(
  path: string,
  bytes: Uint8Array,
  problems: ArtifactSelfCheckProblem[],
): string {
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    problems.push({
      kind: 'xml_has_bom',
      detail: `部件 ${JSON.stringify(path)} 以 UTF-8 BOM 开头（写入器固定不写 BOM）`,
    });
  }
  const text = UTF8_DECODER.decode(bytes);
  if (!text.startsWith(XML_DECLARATION)) {
    problems.push({
      kind: 'xml_declaration_invalid',
      detail:
        `部件 ${JSON.stringify(path)} 的 XML 声明不是固定声明 ${JSON.stringify(XML_DECLARATION)}，` +
        `实际开头为 ${JSON.stringify(text.slice(0, XML_DECLARATION.length + 8))}`,
    });
  }
  scanTagBalance(text, path, problems);
  return text;
}

/** `word/_rels/document.xml.rels` → `word/document.xml`；`_rels/.rels` → `null`（包级）。 */
function ownerPartPathOfRelationshipsPart(relsPath: string): string | null {
  if (relsPath === ROOT_RELATIONSHIPS_PART_PATH) return null;
  const match = /^(.*)_rels\/([^/]+)\.rels$/.exec(relsPath);
  if (match === null) return null;
  const directory = match[1] ?? '';
  const file = match[2] ?? '';
  return `${directory}${file}`;
}

interface RelationshipAttribute {
  readonly target: string;
  readonly targetMode: string | null;
}

function readRelationshipDeclarations(text: string): readonly RelationshipAttribute[] {
  const declarations: RelationshipAttribute[] = [];
  const elementPattern = /<Relationship\b([^>]*?)\/?>/g;
  for (const element of text.matchAll(elementPattern)) {
    const attributes: Record<string, string> = {};
    const attributePattern = /([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"/g;
    for (const attribute of (element[1] ?? '').matchAll(attributePattern)) {
      const name = attribute[1];
      const value = attribute[2];
      if (name === undefined || value === undefined) continue;
      attributes[name] = value;
    }
    const target = attributes.Target;
    if (target === undefined) continue;
    declarations.push({ target, targetMode: attributes.TargetMode ?? null });
  }
  return declarations;
}

function checkRelationshipTargets(
  relsPath: string,
  text: string,
  entryPaths: ReadonlySet<string>,
  problems: ArtifactSelfCheckProblem[],
): void {
  const owner = ownerPartPathOfRelationshipsPart(relsPath);
  for (const declaration of readRelationshipDeclarations(text)) {
    if (declaration.targetMode === 'External') continue;
    let resolved: string;
    try {
      resolved = resolveRelationshipTarget(owner, declaration.target);
    } catch (error) {
      problems.push({
        kind: 'relationship_target_invalid',
        detail:
          `关系部件 ${JSON.stringify(relsPath)} 的目标 ${JSON.stringify(declaration.target)} 无法解析：` +
          `${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    if (!entryPaths.has(resolved)) {
      problems.push({
        kind: 'relationship_target_missing',
        detail:
          `关系部件 ${JSON.stringify(relsPath)} 的内部目标 ${JSON.stringify(declaration.target)} ` +
          `解析为 ${JSON.stringify(resolved)}，但包内没有这份部件`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

function collectProblems(bytes: Uint8Array): {
  problems: readonly ArtifactSelfCheckProblem[];
  entries: readonly ArtifactSelfCheckEntry[];
  entryCount: number;
} {
  const problems: ArtifactSelfCheckProblem[] = [];
  if (bytes.byteLength === 0) {
    problems.push({ kind: 'not_a_zip', detail: '字节为空，不构成 ZIP 归档' });
    return { problems: Object.freeze(problems), entries: Object.freeze([]), entryCount: 0 };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const directory = readCentralDirectory(view, problems);
  if (directory === null) {
    return { problems: Object.freeze(problems), entries: Object.freeze([]), entryCount: 0 };
  }

  const checked = checkZipEntries(view, directory, problems);
  const { entries, dataByPath } = checked;
  const entryPaths = new Set(entries.map((entry) => entry.path));

  if (!entryPaths.has(CONTENT_TYPES_PART_PATH)) {
    problems.push({
      kind: 'missing_content_types',
      detail: `包内缺少 ${JSON.stringify(CONTENT_TYPES_PART_PATH)}（OPC 包的必备部件）`,
    });
  }
  if (!entryPaths.has(ROOT_RELATIONSHIPS_PART_PATH)) {
    problems.push({
      kind: 'missing_root_relationships',
      detail: `包内缺少 ${JSON.stringify(ROOT_RELATIONSHIPS_PART_PATH)}（包级关系的必备部件）`,
    });
  }

  for (const entry of entries) {
    const isXml = entry.path.endsWith('.xml') || entry.path.endsWith('.rels');
    if (!isXml) continue;
    const data = dataByPath.get(entry.path);
    if (data === undefined) continue; // 非 STORE 或越界：上面已如实报过，此处不重复断言
    const text = checkXmlPart(entry.path, data, problems);
    if (entry.path.endsWith('.rels')) {
      checkRelationshipTargets(entry.path, text, entryPaths, problems);
    }
  }

  return {
    problems: Object.freeze(problems),
    entries: Object.freeze(entries),
    entryCount: entries.length,
  };
}

/**
 * 对**自产字节**做第 1 层结构自检。**不抛错**（任何输入都返回结构化结果）。
 *
 * @param bytes 产物字节（DOCX / XLSX / PPTX 的容器字节）。
 */
export function selfCheckArtifactBytes(bytes: Uint8Array): ArtifactSelfCheckResult {
  let collected: ReturnType<typeof collectProblems>;
  try {
    collected = collectProblems(bytes);
  } catch (error) {
    // 自检自身崩了也必须如实上报，不能把"没查成"说成"查过了"。
    collected = {
      problems: Object.freeze([
        {
          kind: 'not_a_zip',
          detail: `结构自检自身抛出异常（按不可信字节处理）：${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      ]),
      entries: Object.freeze([]),
      entryCount: 0,
    };
  }
  return Object.freeze({
    ok: collected.problems.length === 0,
    layer: ARTIFACT_SELF_CHECK_LAYER,
    problems: collected.problems,
    entries: collected.entries,
    entry_count: collected.entryCount,
    bytes_checked: bytes.byteLength,
  });
}

/** 人可读描述（证据 / 断言失败信息用）。**含能力边界原文**，避免被读成"能打开"。 */
export function describeSelfCheckResult(result: ArtifactSelfCheckResult): string {
  const header = result.ok
    ? `第 ${String(result.layer)} 层结构自检通过：${String(result.entry_count)} 个条目、` +
      `${String(result.bytes_checked)} 字节（构建器内部自洽）`
    : `第 ${String(result.layer)} 层结构自检不通过：${String(result.problems.length)} 个问题`;
  const lines = result.problems.map((problem) => `- [${problem.kind}] ${problem.detail}`);
  return [header, ...lines, `边界：${SELF_CHECK_SCOPE_STATEMENT}`].join('\n');
}
