/**
 * OPC 公共部分单测（W-A）。
 *
 * 锁定的语义：
 * - 部件定序唯一（内容类型 → 包级关系 → 业务部件声明顺序 → 部件级关系组声明顺序）；
 * - 关系 id **按声明顺序**分配，且可在造 XML 时用 `relationshipIdAt(i)` 直接算出；
 * - **内部关系的目标必须真实存在**（构造期检查，缺失即抛 `OpcError`，不产出"引用空气"的包）；
 * - 换声明顺序 ⇒ 字节不同（确定性防线）。
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  assembleOpcPackage,
  buildRelationshipsPart,
  buildRelsPartPath,
  CONTENT_TYPES_NAMESPACE,
  CONTENT_TYPES_PART_PATH,
  OpcError,
  RELATIONSHIPS_CONTENT_TYPE,
  RELATIONSHIPS_NAMESPACE,
  relationshipIdAt,
  resolveRelationshipTarget,
  ROOT_RELATIONSHIPS_PART_PATH,
  toPartName,
  toPartPath,
  type OpcPart,
} from './opc.js';
import { XML_DECLARATION } from './xml.js';
import { writeZip, type ZipEntry } from './zip.js';

const DOCUMENT_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const STYLES_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml';
const CORE_PROPERTIES_CONTENT_TYPE =
  'application/vnd.openxmlformats-package.core-properties+xml';

const OFFICE_DOCUMENT_REL =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';
const STYLES_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles';
const CORE_PROPERTIES_REL =
  'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties';

const RELS_DEFAULT = { extension: 'rels', content_type: RELATIONSHIPS_CONTENT_TYPE };

const DOC_PARTS: readonly OpcPart[] = [
  { path: 'word/document.xml', content_type: DOCUMENT_CONTENT_TYPE, data: '<w:document/>' },
  { path: 'word/styles.xml', content_type: STYLES_CONTENT_TYPE, data: '<w:styles/>' },
  { path: 'docProps/core.xml', content_type: CORE_PROPERTIES_CONTENT_TYPE, data: '<cp:core/>' },
];

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function assembleDocumentPackage() {
  return assembleOpcPackage({
    parts: DOC_PARTS,
    content_type_defaults: [RELS_DEFAULT],
    relationships: [
      {
        owner_part_path: null,
        declarations: [
          { type: OFFICE_DOCUMENT_REL, target: 'word/document.xml' },
          { type: CORE_PROPERTIES_REL, target: '/docProps/core.xml' },
        ],
      },
      {
        owner_part_path: 'word/document.xml',
        declarations: [{ type: STYLES_REL, target: 'styles.xml' }],
      },
    ],
  });
}

describe('opc —— 定序与 id 分配', () => {
  const assembled = assembleDocumentPackage();

  it('部件定序唯一：内容类型 → 包级关系 → 业务部件声明顺序 → 部件级关系组声明顺序', () => {
    expect(assembled.part_paths).toEqual([
      CONTENT_TYPES_PART_PATH,
      ROOT_RELATIONSHIPS_PART_PATH,
      'word/document.xml',
      'word/styles.xml',
      'docProps/core.xml',
      'word/_rels/document.xml.rels',
    ]);
    expect(assembled.entries.map((entry) => entry.path)).toEqual([...assembled.part_paths]);
  });

  it('关系 id 按声明顺序递增，且可在造 XML 前直接算出', () => {
    expect(assembled.relationships.map((r) => r.id)).toEqual(['rId1', 'rId2', 'rId1']);
    expect(relationshipIdAt(0)).toBe('rId1');
    expect(relationshipIdAt(1)).toBe('rId2');
    expect(relationshipIdAt(10)).toBe('rId11');
    expect(() => relationshipIdAt(-1)).toThrowError(OpcError);
  });

  it('关系部件路径推导正确', () => {
    expect(buildRelsPartPath(null)).toBe('_rels/.rels');
    expect(buildRelsPartPath('word/document.xml')).toBe('word/_rels/document.xml.rels');
    expect(buildRelsPartPath('document.xml')).toBe('_rels/document.xml.rels');
  });

  it('[Content_Types].xml：Default 全部在 Override 之前，PartName 带前导斜杠', () => {
    const xml = assembled.content_types.xml;
    expect(xml.startsWith(XML_DECLARATION)).toBe(true);
    expect(xml).toContain(`<Types xmlns="${CONTENT_TYPES_NAMESPACE}">`);
    expect(xml).toContain(
      `<Default Extension="rels" ContentType="${RELATIONSHIPS_CONTENT_TYPE}"/>`,
    );
    expect(xml).toContain(
      `<Override PartName="/word/document.xml" ContentType="${DOCUMENT_CONTENT_TYPE}"/>`,
    );
    expect(xml.indexOf('<Default')).toBeLessThan(xml.indexOf('<Override'));
    expect(xml.indexOf('/word/styles.xml')).toBeLessThan(xml.indexOf('docProps/core.xml'));
    expect(assembled.content_types.bytes[0]).toBe(0x3c); // 无 BOM
  });

  it('_rels/.rels：属性顺序固定 Id → Type → Target（Target 原样写出，不改写）', () => {
    const rootRels = assembled.entries.find(
      (entry) => entry.path === ROOT_RELATIONSHIPS_PART_PATH,
    ) as ZipEntry;
    const xml = new TextDecoder().decode(rootRels.data);
    expect(xml.startsWith(XML_DECLARATION)).toBe(true);
    expect(xml).toContain(`<Relationships xmlns="${RELATIONSHIPS_NAMESPACE}">`);
    expect(xml).toContain(
      `<Relationship Id="rId1" Type="${OFFICE_DOCUMENT_REL}" Target="word/document.xml"/>`,
    );
    expect(xml).toContain(
      `<Relationship Id="rId2" Type="${CORE_PROPERTIES_REL}" Target="/docProps/core.xml"/>`,
    );
    expect(xml).not.toContain('TargetMode');
  });

  it('外部关系带 TargetMode="External" 且不参与"目标必须存在"检查', () => {
    const assembledWithExternal = assembleOpcPackage({
      parts: DOC_PARTS,
      content_type_defaults: [RELS_DEFAULT],
      relationships: [
        {
          owner_part_path: null,
          declarations: [
            { type: OFFICE_DOCUMENT_REL, target: 'word/document.xml' },
            {
              type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink',
              target: 'https://example.com/中文',
              target_mode: 'External',
            },
          ],
        },
      ],
    });
    const external = assembledWithExternal.relationships[1];
    expect(external?.target_mode).toBe('External');
    expect(external?.resolved_path).toBeNull();
  });
});

describe('opc —— 确定性防线', () => {
  it('同输入连跑两次 ⇒ 字节相等', () => {
    const first = writeZip(assembleDocumentPackage().entries);
    const second = writeZip(assembleDocumentPackage().entries);
    expect(Buffer.compare(first, second)).toBe(0);
  });

  it('换部件声明顺序 ⇒ 字节不同（顺序真的进了字节）', () => {
    const swapped = assembleOpcPackage({
      parts: [DOC_PARTS[1] as OpcPart, DOC_PARTS[0] as OpcPart, DOC_PARTS[2] as OpcPart],
      content_type_defaults: [RELS_DEFAULT],
      relationships: [
        {
          owner_part_path: null,
          declarations: [
            { type: OFFICE_DOCUMENT_REL, target: 'word/document.xml' },
            { type: CORE_PROPERTIES_REL, target: 'docProps/core.xml' },
          ],
        },
      ],
    });
    const baseline = assembleDocumentPackage();
    expect(swapped.part_paths.slice(2, 5)).toEqual([
      'word/styles.xml',
      'word/document.xml',
      'docProps/core.xml',
    ]);
    expect(sha256(writeZip(swapped.entries))).not.toBe(sha256(writeZip(baseline.entries)));
  });

  it('改一个字节内容 ⇒ 摘要变', () => {
    const mutated = assembleOpcPackage({
      parts: [
        { path: 'word/document.xml', content_type: DOCUMENT_CONTENT_TYPE, data: '<w:document />' },
        DOC_PARTS[1] as OpcPart,
        DOC_PARTS[2] as OpcPart,
      ],
      content_type_defaults: [RELS_DEFAULT],
      relationships: [
        {
          owner_part_path: null,
          declarations: [
            { type: OFFICE_DOCUMENT_REL, target: 'word/document.xml' },
            { type: CORE_PROPERTIES_REL, target: 'docProps/core.xml' },
          ],
        },
      ],
    });
    const baseline = assembleDocumentPackage();
    expect(sha256(writeZip(mutated.entries))).not.toBe(sha256(writeZip(baseline.entries)));
  });
});

describe('opc —— 构造期校验（缺失即抛，不产出半成品）', () => {
  const parts = DOC_PARTS;
  const rootDeclarations = [
    { type: OFFICE_DOCUMENT_REL, target: 'word/document.xml' },
  ] as const;

  function expectReason(run: () => unknown, reason: string): void {
    try {
      run();
      expect.unreachable(`应当抛错：${reason}`);
    } catch (error) {
      expect(error).toBeInstanceOf(OpcError);
      expect((error as OpcError).reason).toBe(reason);
    }
  }

  it('关系目标不存在 ⇒ relationship_target_missing', () => {
    expectReason(
      () =>
        assembleOpcPackage({
          parts,
          content_type_defaults: [RELS_DEFAULT],
          relationships: [
            { owner_part_path: null, declarations: [{ type: OFFICE_DOCUMENT_REL, target: 'word/missing.xml' }] },
          ],
        }),
      'relationship_target_missing',
    );
  });

  it('目标用 / 或 .. 解析后越界 ⇒ invalid_relationship_target', () => {
    expectReason(
      () =>
        assembleOpcPackage({
          parts,
          content_type_defaults: [RELS_DEFAULT],
          relationships: [
            {
              owner_part_path: null,
              declarations: [{ type: STYLES_REL, target: '../outside.xml' }],
            },
          ],
        }),
      'invalid_relationship_target',
    );
  });

  it('缺少 rels 默认内容类型 ⇒ missing_rels_default', () => {
    expectReason(
      () =>
        assembleOpcPackage({
          parts,
          content_type_defaults: [{ extension: 'xml', content_type: 'application/xml' }],
          relationships: [{ owner_part_path: null, declarations: [...rootDeclarations] }],
        }),
      'missing_rels_default',
    );
  });

  it('没有包级关系组 ⇒ missing_root_relationships', () => {
    expectReason(
      () =>
        assembleOpcPackage({
          parts,
          content_type_defaults: [RELS_DEFAULT],
          relationships: [
            { owner_part_path: 'word/document.xml', declarations: [{ type: STYLES_REL, target: 'styles.xml' }] },
          ],
        }),
      'missing_root_relationships',
    );
  });

  it('同一持有者两组关系 ⇒ duplicate_owner_relationships', () => {
    expectReason(
      () =>
        assembleOpcPackage({
          parts,
          content_type_defaults: [RELS_DEFAULT],
          relationships: [
            { owner_part_path: null, declarations: [...rootDeclarations] },
            { owner_part_path: null, declarations: [...rootDeclarations] },
          ],
        }),
      'duplicate_owner_relationships',
    );
  });

  it('关系持有者不是已声明部件 ⇒ owner_part_missing', () => {
    expectReason(
      () =>
        assembleOpcPackage({
          parts,
          content_type_defaults: [RELS_DEFAULT],
          relationships: [
            { owner_part_path: null, declarations: [...rootDeclarations] },
            { owner_part_path: 'word/ghost.xml', declarations: [{ type: STYLES_REL, target: 'styles.xml' }] },
          ],
        }),
      'owner_part_missing',
    );
  });

  it('部件路径重复 ⇒ duplicate_part；占用保留路径 ⇒ reserved_part_path', () => {
    expectReason(
      () =>
        assembleOpcPackage({
          parts: [DOC_PARTS[1] as OpcPart, DOC_PARTS[1] as OpcPart],
          content_type_defaults: [RELS_DEFAULT],
          relationships: [{ owner_part_path: null, declarations: [...rootDeclarations] }],
        }),
      'duplicate_part',
    );
    expectReason(
      () =>
        assembleOpcPackage({
          parts: [
            { path: CONTENT_TYPES_PART_PATH, content_type: DOCUMENT_CONTENT_TYPE, data: '<x/>' },
          ],
          content_type_defaults: [RELS_DEFAULT],
          relationships: [{ owner_part_path: null, declarations: [...rootDeclarations] }],
        }),
      'reserved_part_path',
    );
    expectReason(
      () =>
        assembleOpcPackage({
          parts: [{ path: '中文.xml', content_type: DOCUMENT_CONTENT_TYPE, data: '<x/>' }],
          content_type_defaults: [RELS_DEFAULT],
          relationships: [{ owner_part_path: null, declarations: [...rootDeclarations] }],
        }),
      'invalid_part_path',
    );
  });
});

describe('opc —— 路径助手', () => {
  it('PartName ↔ 包内路径互转', () => {
    expect(toPartName('word/document.xml')).toBe('/word/document.xml');
    expect(toPartPath('/word/document.xml')).toBe('word/document.xml');
  });

  it('关系目标解析（相对 / 绝对 / 归一化）', () => {
    expect(resolveRelationshipTarget(null, 'word/document.xml')).toBe('word/document.xml');
    expect(resolveRelationshipTarget(null, '/word/document.xml')).toBe('word/document.xml');
    expect(resolveRelationshipTarget('word/document.xml', 'styles.xml')).toBe('word/styles.xml');
    expect(resolveRelationshipTarget('word/document.xml', '../docProps/core.xml')).toBe(
      'docProps/core.xml',
    );
    expect(resolveRelationshipTarget('word/document.xml', '/docProps/core.xml')).toBe(
      'docProps/core.xml',
    );
  });

  it('buildRelationshipsPart 可单独产出部件级关系（owner=null 即包级）', () => {
    const built = buildRelationshipsPart('word/document.xml', [
      { type: STYLES_REL, target: 'styles.xml' },
    ]);
    expect(built.part.path).toBe('word/_rels/document.xml.rels');
    expect(built.relationships[0]?.id).toBe('rId1');
    expect(new TextDecoder().decode(built.part.bytes)).toContain('Target="styles.xml"');
  });
});
