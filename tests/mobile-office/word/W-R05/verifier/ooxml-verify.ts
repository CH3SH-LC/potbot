/**
 * **DOCX 包级完整性复核 + 部件级差异核对**（W-R05）。
 *
 * 目的：在**不复用被测实现**（`src/documents/docx/**`、`src/artifacts/ooxml/**`）解析代码的
 * 前提下，独立回答三件事：
 *
 * 1. **容器是否自洽**——逐条目 CRC-32 与中央目录记录**是否一致**（用本目录自研的
 *    `zip-crc32` 逐位实现，而非仓内查表实现）；
 * 2. **`[Content_Types].xml` 与实际条目是否对账**——缺声明 / 悬空 Override / 重复 Override；
 * 3. **`_rels/*.rels` 每条关系指向的部件是否真实存在**——悬空关系必须报出。
 *
 * 外加：**两份 DOCX 的部件级差异**——给出新增 / 删除 / 逐字节变化的部件清单，用于独立
 * 核验「未改部件逐字节不变」这一主张。
 *
 * 口径与判据都写成**可机读的 `kind`**，测试据此断言，不靠自然语言描述。
 */

import { crc32 } from './zip-crc32.js';
import {
  parseZip,
  ZipStructureError,
  type ZipEntry,
  type ZipParseOptions,
} from './zip-container.js';
import { scanStartTags } from './xml-tags.js';

/** `[Content_Types].xml` 的固定部件名。 */
export const CONTENT_TYPES_PART = '[Content_Types].xml';

export type VerifyIssueKind =
  /** 容器级解析失败（结构 / 截断 / 不支持的压缩）。 */
  | 'zip_error'
  /** 条目内容 CRC-32 与中央目录记录不符。 */
  | 'crc_mismatch'
  /** 解压后字节数与声明不符。 */
  | 'size_mismatch'
  /** 缺少 `[Content_Types].xml`。 */
  | 'missing_content_types_part'
  /** `[Content_Types].xml` 不是可解析的 `Types` 文档。 */
  | 'content_types_unreadable'
  /** 某部件既无对应 Override、其扩展名也无 Default 声明（缺声明）。 */
  | 'missing_content_type_declaration'
  /** 某 Override 的 PartName 在包内不存在（悬空 / 多声明）。 */
  | 'dangling_content_type_override'
  /** 同一 PartName 被两条 Override 重复声明。 */
  | 'duplicate_content_type_override'
  /** `*.rels` 里一条非 External 关系的目标部件不存在。 */
  | 'dangling_relationship'
  /** `*.rels` 不是可解析的 `Relationships` 文档。 */
  | 'relationship_unreadable';

export interface VerifyIssue {
  readonly kind: VerifyIssueKind;
  readonly detail: string;
}

export interface VerifyResult {
  /** 无任何 issue 才为 `true`。 */
  readonly ok: boolean;
  /** 包内部件（条目）总数，含 `[Content_Types].xml` 与 `*.rels`。 */
  readonly parts: number;
  /** 实际做过 CRC 比对的条目数。 */
  readonly crcChecked: number;
  readonly issues: readonly VerifyIssue[];
}

function utf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

function hex32(value: number): string {
  return `0x${(value >>> 0).toString(16).padStart(8, '0')}`;
}

/** 归一化包内部件名：去前导斜杠、反斜杠转正斜杠。ZIP 条目名无前导斜杠。 */
export function normalizePartName(name: string): string {
  return name.replace(/\\/g, '/').replace(/^\/+/, '');
}

/**
 * 取最后一段里最后一个 `.` 之后的扩展名（小写）。
 *
 * 注意 `.rels` 这种**点开头**的名字：OPC 口径下其扩展名就是 `rels`（`_rels/.rels` 正是靠
 * `Default Extension="rels"` 覆盖的）。故判据是 `dot >= 0` 而非 `dot > 0`——后者会把
 * `_rels/.rels` 误判成"无声明"，制造假阳。
 */
function extensionOf(name: string): string {
  const slash = name.lastIndexOf('/');
  const base = slash >= 0 ? name.slice(slash + 1) : name;
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
}

function isDirectoryEntry(name: string): boolean {
  return name.endsWith('/');
}

function tryDecodeUri(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * 把一条关系 Target 相对**其源部件所在目录**解析成包内部件名（无前导斜杠）。
 * 处理 `#fragment`、`%XX`、`/` 绝对路径与 `..` 回退。
 */
export function resolveRelationshipTarget(baseDir: string, target: string): string {
  const withoutFragment = target.split('#')[0] ?? '';
  const decoded = tryDecodeUri(withoutFragment);
  const segments: string[] = [];
  if (!decoded.startsWith('/') && baseDir.length > 0) {
    for (const seg of baseDir.split('/')) {
      if (seg.length > 0) {
        segments.push(seg);
      }
    }
  }
  for (const seg of decoded.split('/')) {
    if (seg === '' || seg === '.') {
      continue;
    }
    if (seg === '..') {
      segments.pop();
      continue;
    }
    segments.push(seg);
  }
  return segments.join('/');
}

/** `_rels/.rels` → 包根（`''`）；`word/_rels/document.xml.rels` → `word`。 */
function relationshipBaseDir(relsName: string): string {
  const marker = '/_rels/';
  if (relsName.startsWith('_rels/')) {
    return '';
  }
  const at = relsName.lastIndexOf(marker);
  return at >= 0 ? relsName.slice(0, at) : '';
}

function isRelationshipsPart(name: string): boolean {
  if (!name.endsWith('.rels')) {
    return false;
  }
  return name.startsWith('_rels/') || name.includes('/_rels/');
}

interface Relationship {
  readonly target: string;
  readonly external: boolean;
}

function parseRelationships(content: Uint8Array): Relationship[] {
  const out: Relationship[] = [];
  for (const tag of scanStartTags(utf8(content))) {
    if (tag.localName !== 'Relationship') {
      continue;
    }
    const mode = tag.attributes.get('TargetMode');
    out.push({
      target: tag.attributes.get('Target') ?? '',
      external: mode === 'External',
    });
  }
  return out;
}

interface ContentTypesDeclaration {
  readonly defaults: ReadonlyMap<string, string>;
  readonly overrides: ReadonlyMap<string, string>;
  readonly duplicateOverrides: readonly string[];
}

function parseContentTypes(content: Uint8Array): ContentTypesDeclaration {
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  const duplicates: string[] = [];
  for (const tag of scanStartTags(utf8(content))) {
    if (tag.localName === 'Default') {
      const extension = (tag.attributes.get('Extension') ?? '').toLowerCase();
      if (extension.length > 0) {
        defaults.set(extension, tag.attributes.get('ContentType') ?? '');
      }
    } else if (tag.localName === 'Override') {
      const partName = normalizePartName(tag.attributes.get('PartName') ?? '');
      if (partName.length === 0) {
        continue;
      }
      if (overrides.has(partName)) {
        duplicates.push(partName);
      }
      overrides.set(partName, tag.attributes.get('ContentType') ?? '');
    }
  }
  return { defaults, overrides, duplicateOverrides: duplicates };
}

/**
 * 复核一个 DOCX / OOXML 包的包级完整性。
 *
 * @param bytes 整个包的字节。
 * @param options 解压器（DEFLATE 条目需要）。
 */
export function verifyOoxmlPackage(
  bytes: Uint8Array,
  options: ZipParseOptions = {},
): VerifyResult {
  const issues: VerifyIssue[] = [];

  let entries: readonly ZipEntry[];
  try {
    entries = parseZip(bytes, options).entries;
  } catch (error) {
    const reason = error instanceof ZipStructureError ? error.reason : 'unknown';
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      parts: 0,
      crcChecked: 0,
      issues: [{ kind: 'zip_error', detail: `${reason}: ${message}` }],
    };
  }

  const fileEntries = entries.filter((entry) => !isDirectoryEntry(entry.name));
  const names = new Set(fileEntries.map((entry) => entry.name));

  // ── (a) 逐条目 CRC ────────────────────────────────────────────────────────
  let crcChecked = 0;
  for (const entry of fileEntries) {
    const actual = crc32(entry.content);
    crcChecked += 1;
    if (actual !== entry.storedCrc) {
      issues.push({
        kind: 'crc_mismatch',
        detail: `${entry.name}: stored=${hex32(entry.storedCrc)} actual=${hex32(actual)}`,
      });
    }
    if (entry.content.length !== entry.uncompressedSize) {
      issues.push({
        kind: 'size_mismatch',
        detail: `${entry.name}: declared=${entry.uncompressedSize} actual=${entry.content.length}`,
      });
    }
  }

  // ── (b) [Content_Types].xml 对账 ──────────────────────────────────────────
  const contentTypesEntry = entries.find((entry) => entry.name === CONTENT_TYPES_PART);
  if (!contentTypesEntry) {
    issues.push({ kind: 'missing_content_types_part', detail: CONTENT_TYPES_PART });
  } else {
    let declaration: ContentTypesDeclaration | undefined;
    try {
      declaration = parseContentTypes(contentTypesEntry.content);
    } catch (error) {
      issues.push({
        kind: 'content_types_unreadable',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    if (declaration) {
      for (const name of names) {
        if (name === CONTENT_TYPES_PART) {
          continue;
        }
        if (declaration.overrides.has(name)) {
          continue;
        }
        const extension = extensionOf(name);
        if (extension.length > 0 && declaration.defaults.has(extension)) {
          continue;
        }
        issues.push({ kind: 'missing_content_type_declaration', detail: name });
      }
      for (const partName of declaration.overrides.keys()) {
        if (!names.has(partName)) {
          issues.push({ kind: 'dangling_content_type_override', detail: partName });
        }
      }
      for (const partName of declaration.duplicateOverrides) {
        issues.push({ kind: 'duplicate_content_type_override', detail: partName });
      }
    }
  }

  // ── (c) 关系目标存在性 ─────────────────────────────────────────────────────
  for (const entry of entries) {
    if (!isRelationshipsPart(entry.name)) {
      continue;
    }
    const baseDir = relationshipBaseDir(entry.name);
    let relationships: Relationship[];
    try {
      relationships = parseRelationships(entry.content);
    } catch (error) {
      issues.push({
        kind: 'relationship_unreadable',
        detail: `${entry.name}: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    for (const relationship of relationships) {
      if (relationship.external) {
        continue;
      }
      const resolved = resolveRelationshipTarget(baseDir, relationship.target);
      if (!names.has(resolved)) {
        issues.push({
          kind: 'dangling_relationship',
          detail: `${entry.name} -> "${relationship.target}" (resolved "${resolved}")`,
        });
      }
    }
  }

  return { ok: issues.length === 0, parts: fileEntries.length, crcChecked, issues };
}

// ---------------------------------------------------------------------------
// 部件级差异
// ---------------------------------------------------------------------------

export interface PartChange {
  readonly name: string;
  readonly beforeBytes: number;
  readonly afterBytes: number;
}

export interface PartDiff {
  /** 仅出现在 after 的部件名（升序）。 */
  readonly added: readonly string[];
  /** 仅出现在 before 的部件名（升序）。 */
  readonly removed: readonly string[];
  /** 两边都有、但内容逐字节不同的部件（按名升序）。 */
  readonly changed: readonly PartChange[];
  /** 两边都有、且内容逐字节相同的部件名（升序）。 */
  readonly unchanged: readonly string[];
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) {
      return false;
    }
  }
  return true;
}

function contentMap(bytes: Uint8Array, options: ZipParseOptions): Map<string, Uint8Array> {
  const map = new Map<string, Uint8Array>();
  for (const entry of parseZip(bytes, options).entries) {
    if (isDirectoryEntry(entry.name)) {
      continue;
    }
    map.set(entry.name, entry.content);
  }
  return map;
}

/**
 * 逐**部件**比较两个包（比较的是解压后的部件字节——同一份内容在不同压缩器下压缩流可以
 * 不同，但部件字节相同，这正是「未改部件逐字节不变」要断言的对象）。
 */
export function diffOoxmlPackages(
  before: Uint8Array,
  after: Uint8Array,
  options: ZipParseOptions = {},
): PartDiff {
  const beforeMap = contentMap(before, options);
  const afterMap = contentMap(after, options);

  const added: string[] = [];
  const removed: string[] = [];
  const changed: PartChange[] = [];
  const unchanged: string[] = [];

  for (const [name, afterContent] of afterMap) {
    const beforeContent = beforeMap.get(name);
    if (beforeContent === undefined) {
      added.push(name);
      continue;
    }
    if (bytesEqual(beforeContent, afterContent)) {
      unchanged.push(name);
    } else {
      changed.push({
        name,
        beforeBytes: beforeContent.length,
        afterBytes: afterContent.length,
      });
    }
  }
  for (const name of beforeMap.keys()) {
    if (!afterMap.has(name)) {
      removed.push(name);
    }
  }

  added.sort();
  removed.sort();
  unchanged.sort();
  changed.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return { added, removed, changed, unchanged };
}
