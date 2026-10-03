/**
 * **内容类型 ↔ 关系一致性检查**测试（R162；WCF-D02）。
 *
 * ## 这份测试要钉死的东西
 *
 * 1. **D10 的真实最小可复现**（`docs/information/information-08`，真实 Word 16.0.20430 ⇒ 错误码 24601）：
 *    `_rels/.rels` 有 `…/metadata/core-properties` → `docProps/core.xml`，但
 *    `[Content_Types].xml` **没有**为它写 `Override`，于是落到 `Default Extension="xml"`
 *    → `application/xml`。**补上那一行即通过、去掉那一行即被拒**，且两包**只差那一行**。
 * 2. **不再"无告警地放行"**：修复前的行为是"接受并原样导出"（符合 R105/R151，但用户拿到
 *    一个 Word 打不开的包却没有被告知）。现在**默认拒绝**，错误信息能指认
 *    「哪条关系 / 哪个部件 / 期望什么 / 实际什么 / 来自哪」。
 * 3. **显式 opt-in 不吞诊断**：取证/往返场景可读入，但诊断必须**结构化返回**。
 * 4. **不过度拒绝**：真实 Word 16 写出的关系组合（`corpus-c` 的形状）必须零诊断；
 *    未知关系类型按 R162 **保留不拒**；`External` 关系不判。
 */

import { deflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { crc32 } from '../../artifacts/ooxml/crc32.js';
import { readZip } from '../../artifacts/ooxml/zip-read.js';
import { DocxError, importDocx, importDocxDetailed } from './index.js';

// ---------------------------------------------------------------------------
// 字节级构造器（与 D10 语料同形：DEFLATE + 手工内容类型表）
// ---------------------------------------------------------------------------

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_CT = 'application/vnd.openxmlformats-officedocument';
const PKG_CT = 'application/vnd.openxmlformats-package';

const MAIN_PART = 'word/document.xml';
const MAIN_CT = `${OFFICE_CT}.wordprocessingml.document.main+xml`;
const CORE_CT = `${PKG_CT}.core-properties+xml`;

interface BuilderPart {
  readonly path: string;
  readonly data: string | Uint8Array;
}

/** 手工拼一个 DEFLATE 的 ZIP（无第三方 ZIP 库；写路径不参与）。 */
function buildZip(parts: readonly BuilderPart[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  const offsets: number[] = [];
  let offset = 0;

  const encode = (part: BuilderPart): { raw: Buffer; compressed: Buffer; name: Buffer } => {
    const raw = Buffer.from(
      typeof part.data === 'string' ? new TextEncoder().encode(part.data) : part.data,
    );
    return { raw, compressed: deflateRawSync(raw), name: Buffer.from(part.path, 'latin1') };
  };

  for (const part of parts) {
    const { raw, compressed, name } = encode(part);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(compressed.byteLength, 18);
    local.writeUInt32LE(raw.byteLength, 22);
    local.writeUInt16LE(name.length, 26);
    offsets.push(offset);
    locals.push(local, name, compressed);
    offset += local.length + name.length + compressed.byteLength;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const [index, part] of parts.entries()) {
    const { raw, compressed, name } = encode(part);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(compressed.byteLength, 20);
    central.writeUInt32LE(raw.byteLength, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offsets[index] as number, 42);
    centrals.push(central, name);
    centralSize += central.length + name.length;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

/** 内容类型表：`defaults` 固定三条（rels / xml / png），`overrides` 由调用方给。 */
function contentTypesXml(overrides: readonly (readonly [string, string])[]): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="${CT}">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Default Extension="png" ContentType="image/png"/>` +
    overrides.map(([part, type]) => `<Override PartName="${part}" ContentType="${type}"/>`).join('') +
    `</Types>`
  );
}

function relsXml(
  relationships: readonly { readonly id: string; readonly type: string; readonly target: string; readonly mode?: string }[],
): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="${RELS}">` +
    relationships
      .map(
        (rel) =>
          `<Relationship Id="${rel.id}" Type="${rel.type}" Target="${rel.target}"` +
          `${rel.mode === undefined ? '' : ` TargetMode="${rel.mode}"`}/>`,
      )
      .join('') +
    `</Relationships>`
  );
}

const BODY_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<w:document xmlns:w="${W}" xmlns:r="${OFFICE_REL}"><w:body>` +
  `<w:p><w:r><w:t>正文</w:t></w:r></w:p>` +
  `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`;

const CORE_XML = `<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"/>`;

/** `docProps/core.xml` 那一行 `Override`——**就是 D10 实测的"缺了它 Word 就打不开"的那一行**。 */
const CORE_OVERRIDE: readonly [string, string] = ['/docProps/core.xml', CORE_CT];

const CORE_PROPERTIES_REL = {
  id: 'rId2',
  type: `${PKG_REL}/metadata/core-properties`,
  target: 'docProps/core.xml',
} as const;

const OFFICE_DOCUMENT_REL = {
  id: 'rId1',
  type: `${OFFICE_REL}/officeDocument`,
  target: MAIN_PART,
} as const;

/**
 * D10 最小可复现的形状：**两个变体只差 `docProps/core.xml` 那一行 `Override`**。
 *
 * @param coreOverride 是否写出那一行 `Override`。
 */
function buildCorePropertiesPackage(coreOverride: boolean): Buffer {
  return buildZip([
    {
      path: '[Content_Types].xml',
      data: contentTypesXml([
        ['/word/document.xml', MAIN_CT],
        ...(coreOverride ? [CORE_OVERRIDE] : []),
      ]),
    },
    { path: '_rels/.rels', data: relsXml([OFFICE_DOCUMENT_REL, CORE_PROPERTIES_REL]) },
    { path: MAIN_PART, data: BODY_XML },
    { path: 'docProps/core.xml', data: CORE_XML },
  ]);
}

/** 取出某个部件的解压文本（用本仓的读取器，避免再写一份解压）。 */
function partText(bytes: Uint8Array, path: string): string {
  const entry = readZip(bytes).by_path.get(path);
  return new TextDecoder().decode(entry?.data ?? new Uint8Array());
}

/** 两个包的 `[Content_Types].xml` 的文本 + "那一行 Override" 的字面量（定长元组，便于解构）。 */
function contentTypeDiff(
  bad: Buffer,
  good: Buffer,
): readonly [goodXml: string, badXml: string, override: string] {
  const override = `<Override PartName="${CORE_OVERRIDE[0]}" ContentType="${CORE_OVERRIDE[1]}"/>`;
  return [partText(good, '[Content_Types].xml'), partText(bad, '[Content_Types].xml'), override];
}

// ---------------------------------------------------------------------------
// 1. D10 的最小可复现：只差一行 Override
// ---------------------------------------------------------------------------

describe('R162 — core-properties 那一行 Override（D10 实测的 Word 24601 根因）', () => {
  const good = buildCorePropertiesPackage(true);
  const bad = buildCorePropertiesPackage(false);

  it('两个变体的 `[Content_Types].xml` **确实只差那一行 Override**', () => {
    const [goodXml, badXml, override] = contentTypeDiff(bad, good);
    // 逐条写清楚方向，别让读者去猜哪边是哪边：
    expect(badXml).not.toContain(override);
    expect(goodXml).toContain(override);
    expect(goodXml.replace(override, '')).toBe(badXml);
    expect(badXml).not.toContain('core-properties+xml');
  });

  it('**缺那一行 ⇒ 默认拒绝**，且错误信息能指认关系 / 目标 / 期望 / 实际', () => {
    try {
      importDocx(new Uint8Array(bad));
      throw new Error('期望抛出 DocxError');
    } catch (error) {
      expect(error).toBeInstanceOf(DocxError);
      const docxError = error as DocxError;
      expect(docxError.reason).toBe('inconsistent_content_type');
      expect(docxError.message).toContain('rId2');
      expect(docxError.message).toContain('docProps/core.xml');
      expect(docxError.message).toContain(CORE_CT);
      expect(docxError.message).toContain('application/xml');
      // 讲清"实际类型从哪来"（落到 Default 就说明缺的是 Override）
      expect(docxError.message).toContain('Default Extension="xml"');
      // 指路可用的容错入口
      expect(docxError.message).toContain('importDocxDetailed');
    }
  });

  it('**补上那一行 ⇒ 通过**（其余字节未动）', () => {
    const result = importDocxDetailed(new Uint8Array(good));
    expect(result.content_type_diagnostics).toEqual([]);
    expect(result.model.blocks).toHaveLength(1);
  });

  it('显式 opt-in：读得进来，且诊断**结构化返回**（不是静默吞掉）', () => {
    const result = importDocxDetailed(new Uint8Array(bad), {
      allowInconsistentContentTypes: true,
    });
    expect(result.model.blocks).toHaveLength(1);
    expect(result.content_type_diagnostics).toHaveLength(1);

    const diagnostic = result.content_type_diagnostics[0];
    expect(diagnostic?.reason).toBe('mismatch');
    expect(diagnostic?.relationship_id).toBe('rId2');
    expect(diagnostic?.relationship_type).toBe(CORE_PROPERTIES_REL.type);
    expect(diagnostic?.owner_part_path).toBeNull();
    expect(diagnostic?.target_path).toBe('docProps/core.xml');
    expect(diagnostic?.expected_content_type).toBe(CORE_CT);
    expect(diagnostic?.actual_content_type).toBe('application/xml');
    expect(diagnostic?.actual_source).toBe('default');
    expect(diagnostic?.actual_extension).toBe('xml');
  });

  it('`importDocx` 收到该选项会**显式报错并指路**（不留"容错读入 + 丢诊断"的路）', () => {
    expect(() =>
      importDocx(new Uint8Array(bad), { allowInconsistentContentTypes: true }),
    ).toThrowError(/importDocxDetailed/);
  });

  it('一个不相容的包在**默认模式下诊断数为 0 是不可能的**：拒绝而不是放行', () => {
    let produced: unknown = null;
    try {
      produced = importDocx(new Uint8Array(bad));
    } catch {
      produced = null;
    }
    expect(produced).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. 其余必须覆盖的相容性情形
// ---------------------------------------------------------------------------

describe('R162 — 其余关系类型的两面（正例 + 反例）', () => {
  /** 一个"关系集合与内容类型表"可自由组合的包。 */
  function build(
    overrides: readonly (readonly [string, string])[],
    packageRels: readonly { id: string; type: string; target: string; mode?: string }[],
    extraParts: readonly BuilderPart[],
  ): Buffer {
    return buildZip([
      { path: '[Content_Types].xml', data: contentTypesXml(overrides) },
      {
        path: '_rels/.rels',
        data: relsXml([OFFICE_DOCUMENT_REL, ...packageRels]),
      },
      { path: MAIN_PART, data: BODY_XML },
      ...extraParts,
    ]);
  }

  const IMAGE_REL = {
    id: 'rId2',
    type: `${OFFICE_REL}/image`,
    target: 'media/pic.png',
  } as const;

  it('图片关系指向非图片 ⇒ 拒绝', () => {
    const bytes = build(
      [['/word/document.xml', MAIN_CT]],
      [{ ...IMAGE_REL, target: 'media/pic.xml' }],
      [{ path: 'media/pic.xml', data: '<not-an-image/>' }],
    );
    try {
      importDocx(new Uint8Array(bytes));
      throw new Error('期望抛出 DocxError');
    } catch (error) {
      expect((error as DocxError).reason).toBe('inconsistent_content_type');
      expect((error as DocxError).message).toContain('image/*');
      expect((error as DocxError).message).toContain('application/xml');
    }
  });

  it('图片关系指向图片 ⇒ 通过（反向对照，证明上一条不是恒真）', () => {
    const bytes = build(
      [['/word/document.xml', MAIN_CT]],
      [IMAGE_REL],
      [{ path: 'media/pic.png', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }],
    );
    expect(importDocxDetailed(new Uint8Array(bytes)).content_type_diagnostics).toEqual([]);
  });

  it('officeDocument 指向非主部件 ⇒ 拒绝（由专门的主部件检查负责）', () => {
    const bytes = build(
      [
        ['/word/document.xml', MAIN_CT],
        ['/word/styles.xml', `${OFFICE_CT}.wordprocessingml.styles+xml`],
      ],
      [{ id: 'rId9', type: `${OFFICE_REL}/styles`, target: 'word/styles.xml' }],
      [{ path: 'word/styles.xml', data: '<w:styles xmlns:w="' + W + '"/>' }],
    );
    // 把包级 officeDocument 换成指向 styles.xml
    const tampered = buildZip([
      { path: '[Content_Types].xml', data: contentTypesXml([
        ['/word/document.xml', MAIN_CT],
        ['/word/styles.xml', `${OFFICE_CT}.wordprocessingml.styles+xml`],
      ]) },
      {
        path: '_rels/.rels',
        data: relsXml([{ ...OFFICE_DOCUMENT_REL, target: 'word/styles.xml' }]),
      },
      { path: MAIN_PART, data: BODY_XML },
      { path: 'word/styles.xml', data: `<w:styles xmlns:w="${W}"/>` },
    ]);
    void bytes;
    try {
      importDocx(new Uint8Array(tampered));
      throw new Error('期望抛出 DocxError');
    } catch (error) {
      expect((error as DocxError).reason).toBe('invalid_main_part_content_type');
    }
  });

  it('关系指向的部件根本不存在 ⇒ 拒绝（专属原因码，不是"类型不相容"）', () => {
    const bytes = build([['/word/document.xml', MAIN_CT]], [IMAGE_REL], []);
    try {
      importDocx(new Uint8Array(bytes));
      throw new Error('期望抛出 DocxError');
    } catch (error) {
      expect((error as DocxError).reason).toBe('relationship_target_missing');
    }
  });

  it('目标部件没有任何内容类型声明 ⇒ 拒绝，原因码是 missing_content_type', () => {
    const bytes = build(
      [['/word/document.xml', MAIN_CT]],
      [{ id: 'rId2', type: `${OFFICE_REL}/image`, target: 'media/pic.bin' }],
      [{ path: 'media/pic.bin', data: new Uint8Array([1, 2, 3]) }],
    );
    const result = importDocxDetailed(new Uint8Array(bytes), {
      allowInconsistentContentTypes: true,
    });
    expect(result.content_type_diagnostics).toHaveLength(1);
    expect(result.content_type_diagnostics[0]?.reason).toBe('missing_content_type');
    expect(result.content_type_diagnostics[0]?.actual_content_type).toBeNull();
  });

  it('未知关系类型 ⇒ **保留不拒**（R162：不知道相容规则就不猜）', () => {
    const bytes = build(
      [['/word/document.xml', MAIN_CT]],
      [{ id: 'rId7', type: 'https://example.com/relationships/whatever', target: 'customXml/x.xml' }],
      [{ path: 'customXml/x.xml', data: '<x/>' }],
    );
    const result = importDocxDetailed(new Uint8Array(bytes));
    expect(result.content_type_diagnostics).toEqual([]);
    // 关系本身仍然保留在模型里（R105/R106）
    expect(result.model.relationships.some((rel) => rel.id === 'rId7')).toBe(true);
  });

  it('External 关系不判（没有部件、也不抓取——R161）', () => {
    const bytes = build(
      [['/word/document.xml', MAIN_CT]],
      [{ id: 'rId8', type: `${OFFICE_REL}/hyperlink`, target: 'https://example.com/', mode: 'External' }],
      [],
    );
    expect(importDocxDetailed(new Uint8Array(bytes)).content_type_diagnostics).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. 不过度拒绝：真实 Word 16 的关系组合必须零诊断
// ---------------------------------------------------------------------------

describe('R162 — 真实 Word 16 的关系组合不被误伤', () => {
  it('corpus-c 形状（styles/settings/webSettings/fontTable/theme + core/app properties）零诊断', () => {
    const parts: { id: string; type: string; target: string }[] = [
      { id: 'rId1', type: `${OFFICE_REL}/styles`, target: 'styles.xml' },
      { id: 'rId2', type: `${OFFICE_REL}/settings`, target: 'settings.xml' },
      { id: 'rId3', type: `${OFFICE_REL}/webSettings`, target: 'webSettings.xml' },
      { id: 'rId4', type: `${OFFICE_REL}/fontTable`, target: 'fontTable.xml' },
      { id: 'rId5', type: `${OFFICE_REL}/theme`, target: 'theme/theme1.xml' },
    ];
    const overrides: (readonly [string, string])[] = [
      ['/word/document.xml', MAIN_CT],
      ['/word/styles.xml', `${OFFICE_CT}.wordprocessingml.styles+xml`],
      ['/word/settings.xml', `${OFFICE_CT}.wordprocessingml.settings+xml`],
      ['/word/webSettings.xml', `${OFFICE_CT}.wordprocessingml.webSettings+xml`],
      ['/word/fontTable.xml', `${OFFICE_CT}.wordprocessingml.fontTable+xml`],
      ['/word/theme/theme1.xml', `${OFFICE_CT}.theme+xml`],
      ['/docProps/core.xml', CORE_CT],
      ['/docProps/app.xml', `${OFFICE_CT}.extended-properties+xml`],
    ];
    const bytes = buildZip([
      { path: '[Content_Types].xml', data: contentTypesXml(overrides) },
      {
        path: '_rels/.rels',
        data: relsXml([
          { id: 'rId3', type: `${OFFICE_REL}/extended-properties`, target: 'docProps/app.xml' },
          { id: 'rId2', type: `${PKG_REL}/metadata/core-properties`, target: 'docProps/core.xml' },
          OFFICE_DOCUMENT_REL,
        ]),
      },
      {
        path: 'word/_rels/document.xml.rels',
        data: relsXml(parts),
      },
      { path: MAIN_PART, data: BODY_XML },
      { path: 'word/styles.xml', data: `<w:styles xmlns:w="${W}"/>` },
      { path: 'word/settings.xml', data: `<w:settings xmlns:w="${W}"/>` },
      { path: 'word/webSettings.xml', data: `<w:webSettings xmlns:w="${W}"/>` },
      { path: 'word/fontTable.xml', data: `<w:fonts xmlns:w="${W}"/>` },
      { path: 'word/theme/theme1.xml', data: '<a:theme/>' },
      { path: 'docProps/core.xml', data: CORE_XML },
      { path: 'docProps/app.xml', data: '<Properties/>' },
    ]);

    const result = importDocxDetailed(new Uint8Array(bytes));
    expect(result.content_type_diagnostics).toEqual([]);
    expect(result.model.relationships).toHaveLength(8);
  });
});
