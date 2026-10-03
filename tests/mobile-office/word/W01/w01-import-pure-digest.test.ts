/**
 * **W-I03 —— DOCX 导入链去 `node:crypto`（`document_id` 改用纯 TS SHA-256）**（`tests/mobile-office/word/W01/`）。
 *
 * ## 本文件盯什么
 *
 * W01 在 `integrationRequests` 里如实登记：`src/documents/docx/import.ts` 当时在
 * **无条件**调用 `src/artifacts/digest.ts:digestBytes`（其实现是 `node:crypto` 的
 * `createHash('sha256')`）来拼 `document_id`，于是**手机/APK 的 DOCX 导入链传递依赖
 * `node:crypto`**。本单元把这处调用切到 W01 已经交付的纯 TS 实现
 * `src/documents/docx/sha256.ts:sha256Hex`（零 `node:` 说明符、输出逐字节一致），并留下两条机器化判据：
 *
 * | 判据 | 本文件怎么证 |
 * |---|---|
 * | 导入闭包**零 `node:` 说明符** | 从 `import.ts` 出发，**从磁盘**递归解析全部相对 import/export 说明符，得到闭包文件集；断言其中每个文件都不含 `node:` 说明符，且 `import.ts` 自身不再引用 `digestBytes` / `artifacts/digest.ts` |
 * | **摘要口径不变**（同名 `document_id`） | 在 empty/55/56/64/65 字节向量与一整份**真实 DOCX**上，把 `sha256Hex` 与 `node:crypto` 的**独立实现**逐串比对；并直接对真实 DOCX 调 `importDocx`，断言产出的 `document_id` 与"旧实现（`node:crypto`）会算出的值"**完全相同** |
 *
 * ## 为什么这样"独立"
 *
 * - 闭包扫描**不用**被测代码的判定：测试自己解析 import、自己递归、自己收集文件集。
 * - 摘要对照用 `node:crypto` 作**参考实现**（测试侧允许 `node:*`；被守的是**产品路径**）。
 *   这正是"切换前后 `document_id` 不变"的判据——旧实现就是 `node:crypto`，若两者对本文件全部
 *   向量与整份 DOCX 都相等，则同一输入在两版实现下必然得到同一 `document_id`。
 * - 扫描器本身带**非空洞探针**（§C）：喂一份内存里的合成源码，其中一条链真的含 `node:crypto`，
 *   断言扫描器**报得出来**；再喂一条全相对链，断言**零误报**。若扫描器只会返回空集，这里会红。
 *
 * ## 边界（本文件**不**声称的）
 *
 * - 只证明 **DOCX 导入闭包**零 `node:`；`src/artifacts/digest.ts` 自身仍用 `node:crypto`
 *   （presentations / spreadsheets 等其它闭包还在用），那不在本单元范围。
 * - 只证明**静态相对 import 闭包**；动态按字符串拼出的模块名（本仓不存在）扫描不到。
 * - 不涉及真机/APK 运行时（未验证层）。
 */

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DOCX_MAIN_CONTENT_TYPE,
  OFFICE_DOCUMENT_RELATIONSHIP_TYPE,
  importDocx,
  importDocxDetailed,
} from '../../../../src/documents/docx/import.js';
import { sha256Hex } from '../../../../src/documents/docx/sha256.js';
import {
  RELATIONSHIPS_CONTENT_TYPE,
  assembleOpcPackage,
} from '../../../../src/artifacts/ooxml/opc.js';
import { writeZip } from '../../../../src/artifacts/ooxml/zip.js';

// ---------------------------------------------------------------------------
// 路径与源码读取
// ---------------------------------------------------------------------------

/** 仓根（本文件在 `<root>/tests/mobile-office/word/W01/`，从文件故上升 4 层目录）。 */
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** 被扫的入口：DOCX 导入模块。 */
const IMPORT_ENTRY = 'src/documents/docx/import.ts';

/** 用仓根拼绝对路径（forward-slash 相对路径）。 */
function absolute(relativePath: string): string {
  return posix.join(REPO_ROOT.replaceAll('\\', '/'), relativePath);
}

// ---------------------------------------------------------------------------
// 相对 import 闭包扫描器（纯函数，可注入内存文件系统 ⇒ 可被单独证伪）
// ---------------------------------------------------------------------------

/** 扫描器依赖的最小文件系统：只读、以 forward-slash 相对路径为键。 */
interface SourceFileSystem {
  exists(path: string): boolean;
  read(path: string): string;
}

/** 闭包扫描结果。 */
interface ImportClosure {
  /** 参与闭包的全部文件（含入口），已排序。 */
  readonly files: readonly string[];
  /** 命中的 `node:` 说明符（`文件 -> 说明符`）。 */
  readonly nodeSpecifiers: readonly string[];
  /** 相对说明符解析不到文件（`文件 -> 说明符`）——非空即说明扫描器可能在"跳文件"。 */
  readonly unresolved: readonly string[];
  /** 非相对、非 `node:` 的说明符（裸包名 / URL），本仓内核应为空。 */
  readonly bare: readonly string[];
}

/**
 * 说明符识别：`from '…'`（import / export / import type 共用）、裸 `import '…'`、
 * 动态 `import('…')`。跨行匹配（本仓大量多行 import）。
 */
const SPECIFIER_PATTERN = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

/**
 * `spec`（相对）→ 实际文件路径；**保持相对**（不做 `posix.resolve`，否则会带上 CWD 变成绝对路径，
 * 内存 FS 的相对键就查不到了）。`.js` 映射到同名 `.ts`，再兜目录 `index.ts`。
 */
function resolveRelative(fromFile: string, spec: string, fs: SourceFileSystem): string | null {
  const base = posix.normalize(`${posix.dirname(fromFile)}/${spec}`);
  const candidates = [base.replace(/\.js$/, '.ts'), base, `${base}/index.ts`];
  for (const candidate of candidates) {
    if (fs.exists(candidate)) return candidate;
  }
  return null;
}

/** 从 `entry` 出发，递归收集相对 import 闭包，并登记违规/未解析/裸说明符。 */
function collectImportClosure(entry: string, fs: SourceFileSystem): ImportClosure {
  const visited = new Set<string>();
  const queue: string[] = [entry];
  const nodeSpecifiers: string[] = [];
  const unresolved: string[] = [];
  const bare: string[] = [];

  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (visited.has(file)) continue;
    visited.add(file);

    const source = fs.read(file);
    for (const match of source.matchAll(SPECIFIER_PATTERN)) {
      const spec = match[1];
      if (spec === undefined) continue;
      if (spec.startsWith('node:')) {
        nodeSpecifiers.push(`${file} -> ${spec}`);
        continue;
      }
      if (spec.startsWith('.')) {
        const resolved = resolveRelative(file, spec, fs);
        if (resolved === null) unresolved.push(`${file} -> ${spec}`);
        else queue.push(resolved);
        continue;
      }
      bare.push(`${file} -> ${spec}`);
    }
  }

  return {
    files: [...visited].sort(),
    nodeSpecifiers,
    unresolved,
    bare,
  };
}

/** 磁盘文件系统适配器（只读）。 */
const DISK_FS: SourceFileSystem = {
  exists: (path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
  read: (path) => readFileSync(path, 'utf8'),
};

/** 内存文件系统（供扫描器自证用）：相对路径 → 源码。 */
function memoryFs(files: Readonly<Record<string, string>>): SourceFileSystem {
  return {
    exists: (path) => Object.prototype.hasOwnProperty.call(files, path),
    read: (path) => {
      const content = files[path];
      if (content === undefined) throw new Error(`内存 FS 里没有 ${path}`);
      return content;
    },
  };
}

// ---------------------------------------------------------------------------
// 最小真实 DOCX 构造（用本仓 OPC 组装器 + ZIP 写出器 ⇒ 真包，非磁盘 fixture）
// ---------------------------------------------------------------------------

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/** 一份可被 `importDocx` 接受的最小 DOCX（正文一段 + 一个节）。 */
function buildRealDocx(bodyText: string): Uint8Array {
  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
    `<w:document xmlns:w="${W_NS}"><w:body>` +
    `<w:p><w:r><w:t xml:space="preserve">${bodyText}</w:t></w:r></w:p>` +
    `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>` +
    `</w:body></w:document>`;
  const pkg = assembleOpcPackage({
    parts: [
      { path: 'word/document.xml', content_type: DOCX_MAIN_CONTENT_TYPE, data: documentXml },
    ],
    content_type_defaults: [
      { extension: 'rels', content_type: RELATIONSHIPS_CONTENT_TYPE },
      { extension: 'xml', content_type: 'application/xml' },
    ],
    relationships: [
      {
        owner_part_path: null,
        declarations: [
          { type: OFFICE_DOCUMENT_RELATIONSHIP_TYPE, target: 'word/document.xml' },
        ],
      },
    ],
  });
  return new Uint8Array(writeZip(pkg.entries));
}

/** 与旧实现（`artifacts/digest.ts`，即 `node:crypto`）逐字节等价的参考摘要。 */
function nodeDigest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 旧实现会据 `node:crypto` 摘要算出的 `document_id`。 */
function legacyDocumentId(bytes: Uint8Array): string {
  return `docx-${nodeDigest(bytes).slice(0, 16)}`;
}

/** 一段确定性字节（同样的 seed 必然同样的内容；覆盖分块边界）。 */
function deterministicBytes(length: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) bytes[i] = (i * 131 + seed * 17 + 7) & 0xff;
  return bytes;
}

// ===========================================================================
// A. 导入闭包 —— 零 node: 说明符
// ===========================================================================

describe('W-I03 DOCX 导入闭包 —— 零 node: 说明符', () => {
  const closure = collectImportClosure(IMPORT_ENTRY, {
    exists: (path) => DISK_FS.exists(absolute(path)),
    read: (path) => DISK_FS.read(absolute(path)),
  });

  it('闭包非空洞：入口在内、文件数可观、全部相对说明符都解析得到', () => {
    expect(closure.files).toContain(IMPORT_ENTRY);
    expect(closure.files.length).toBeGreaterThanOrEqual(30);
    // 解析不到文件 = 扫描器可能在"跳文件"；必须为零，闭包才可信。
    expect(closure.unresolved).toEqual([]);
  });

  it('闭包里没有任何 node: 说明符（含 node:crypto）', () => {
    expect(closure.nodeSpecifiers).toEqual([]);
  });

  it('闭包是自足内核：没有任何裸包名 / URL 说明符', () => {
    expect(closure.bare).toEqual([]);
  });

  it('造成传递依赖的 artifacts/digest.ts 已掉出闭包', () => {
    expect(closure.files).not.toContain('src/artifacts/digest.ts');
    // 而纯实现 sha256.ts 确实在闭包里（说明切过去的调用真的接上了）。
    expect(closure.files).toContain('src/documents/docx/sha256.ts');
  });

  it('import.ts 不再从 artifacts/digest 导入，也不再调用 digestBytes（改接纯 sha256Hex）', () => {
    const source = DISK_FS.read(absolute(IMPORT_ENTRY));
    // 只盯**可执行**的引用：import 说明符与调用。注释里提旧模块名不算引用。
    expect(source).not.toMatch(/from\s+['"][^'"]*artifacts\/digest/);
    expect(source).not.toMatch(/\bdigestBytes\s*\(/);
    expect(source).toContain("from './sha256.js'");
    expect(source).toMatch(/\bsha256Hex\s*\(/);
  });
});

// ===========================================================================
// B. 非空洞探针 —— 扫描器真的报得出来（否则 §A 是假绿）
// ===========================================================================

describe('W-I03 闭包扫描器 —— 自证不空洞', () => {
  it('链上真的含 node:crypto 时，扫描器报出该说明符', () => {
    const fs = memoryFs({
      'entry.ts': "import { a } from './mid.js';\n",
      'mid.ts': "import { x } from './leaf.js';\n",
      'leaf.ts': "import { createHash } from 'node:crypto';\n",
    });
    const closure = collectImportClosure('entry.ts', fs);
    expect(closure.files).toEqual(['entry.ts', 'leaf.ts', 'mid.ts']);
    expect(closure.nodeSpecifiers).toEqual(['leaf.ts -> node:crypto']);
  });

  it('对照：全相对且无 node: 的链 ⇒ 零违规（不误报）', () => {
    const fs = memoryFs({
      'entry.ts': "export * from './a.js';\n",
      'a.ts': "import type { T } from './b.js';\n",
      'b.ts': 'export type T = number;\n',
    });
    const closure = collectImportClosure('entry.ts', fs);
    expect(closure.nodeSpecifiers).toEqual([]);
    expect(closure.unresolved).toEqual([]);
  });

  it('相对说明符解析不到时，扫描器如实登记（不静默跳过）', () => {
    const fs = memoryFs({ 'entry.ts': "import { a } from './missing.js';\n" });
    const closure = collectImportClosure('entry.ts', fs);
    expect(closure.unresolved).toEqual(['entry.ts -> ./missing.js']);
  });
});

// ===========================================================================
// C. 摘要口径不变 —— 纯实现 vs node:crypto，向量 + 真实 DOCX
// ===========================================================================

describe('W-I03 document_id 摘要口径 —— 与旧 node:crypto 实现逐串一致', () => {
  it('向量 empty/55/56/64/65 字节：纯实现摘要 = node:crypto 摘要，document_id 推导也一致', () => {
    for (const length of [0, 55, 56, 64, 65]) {
      const bytes = deterministicBytes(length, length);
      const pure = sha256Hex(bytes);
      const reference = nodeDigest(bytes);
      expect(pure, `长度 ${String(length)} 的摘要与 node:crypto 不符`).toBe(reference);
      // 旧路径 = `docx-${nodeDigest.slice(0,16)}`；新路径用纯摘要 ⇒ 必须同串。
      expect(`docx-${pure.slice(0, 16)}`, `长度 ${String(length)} 的 document_id 变了`).toBe(
        legacyDocumentId(bytes),
      );
    }
  });

  it('空串已知向量（FIPS 180-4）', () => {
    expect(sha256Hex(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('整份真实 DOCX：importDocx 产出的 document_id 与旧 node:crypto 口径**完全相同**', () => {
    const docx = buildRealDocx('W-I03 纯摘要导入链');
    // 纯摘要 = 参考实现。
    expect(sha256Hex(docx)).toBe(nodeDigest(docx));
    // 生产路径的 document_id 必须等于旧实现会算出的值。
    const model = importDocx(docx);
    expect(model.document_id).toBe(legacyDocumentId(docx));
    expect(model.document_id).toBe(`docx-${sha256Hex(docx).slice(0, 16)}`);
    // importDocxDetailed 走同一组装路径，随之同串。
    expect(importDocxDetailed(docx).model.document_id).toBe(model.document_id);
  });

  it('确定性：同一份字节导入两次 ⇒ 同一 document_id', () => {
    const docx = buildRealDocx('确定性');
    expect(importDocx(docx).document_id).toBe(importDocx(docx).document_id);
  });

  it('显式 document_id 覆盖仍然生效（切换未破坏调用方契约）', () => {
    const docx = buildRealDocx('显式 id');
    const model = importDocx(docx, { document_id: 'my-explicit-id' });
    expect(model.document_id).toBe('my-explicit-id');
  });
});
