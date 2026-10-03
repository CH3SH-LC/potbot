/**
 * R105 / R159–R162：包级保留物的构造与不变量。
 *
 * 判据分三层：
 * 1. **构造期**：非法路径、重复内容类型、错误关系类型一律抛（不产出半成品）；
 * 2. **整篇自检**：悬空 rId 必须被拒（且"没声明包范围"与"真悬空"是**两个**不同的码）；
 * 3. **保留性**：只改一段之后，不透明部件的字节与关系一个都没变（R105/R151）。
 *
 * 注意：要观察"不合法的模型会被报出什么"，必须**绕过** `createDocumentModel`
 * （它在构造期就抛）。做法是先造一份合法模型，再用展开语法换掉目标字段——
 * 这同时说明了"构造期自检"与"事后检查"是两道不同的闸。
 */

import { describe, expect, it } from 'vitest';

import { createDocumentModel } from './document.js';
import { DocumentModelError } from './errors.js';
import { textParagraphNode } from './nodes.js';
import {
  assertSafePartPath,
  createContentTypeTable,
  createMediaPart,
  createOpaquePart,
  createRelationship,
  EXTERNAL_RELATIONSHIP_POLICY,
  findContentType,
  isExternalTarget,
  isSafePartPath,
  nextRelationshipId,
  PRESERVATION_STATEMENT,
  relationshipTypeHasSuffix,
  resolveRelationshipTarget,
} from './preservation.js';
import { applyStructureEdit } from './structure.js';
import type { DocumentModel, RelationshipRecord } from './types.js';
import { validateDocument } from './validation.js';
import { errorCodes, paragraphBlockAt } from './fixtures.js';

const BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff]);
const IMAGE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const HYPERLINK_REL =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';
const OFFICE_DOCUMENT_REL =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';

const KNOWN_PARTS: readonly string[] = ['word/document.xml'];

function imageRelationship(id: string, target: string): RelationshipRecord {
  return createRelationship({
    id,
    type: IMAGE_REL,
    target,
    target_mode: 'Internal',
    owner_part_path: 'word/document.xml',
  });
}

/** 一份**合法**的保留物基线：一条图片关系 + 对应媒体 + 一个不透明主题部件。 */
function validPreservedModel(): DocumentModel {
  return createDocumentModel(
    {
      document_id: 'doc-preserve',
      blocks: [textParagraphNode({ text: '正文', source: 'imported' })],
      relationships: [imageRelationship('rId1', 'media/pic.png')],
      media: [
        createMediaPart({
          path: 'word/media/pic.png',
          content_type: 'image/png',
          relationship_id: 'rId1',
          bytes: BYTES,
        }),
      ],
      opaque_parts: [
        createOpaquePart({
          path: 'word/theme/theme1.xml',
          content_type: 'application/vnd.openxmlformats-officedocument.theme+xml',
          bytes: BYTES,
        }),
      ],
    },
    { known_part_paths: KNOWN_PARTS },
  );
}

describe('R160 部件路径安全（路径穿越 / 绝对路径 / 盘符）', () => {
  it('合法包内路径通过', () => {
    for (const path of ['word/document.xml', 'media/image1.png', 'customXml/item1.xml']) {
      expect(isSafePartPath(path)).toBe(true);
    }
  });

  it('穿越、绝对路径、反斜杠、盘符、空段一律不安全', () => {
    const bad = [
      '../evil.xml',
      'word/../../evil.xml',
      '/word/document.xml',
      'word\\document.xml',
      'C:/windows/system32/x.xml',
      'word//document.xml',
      'word/./document.xml',
      '',
    ];
    for (const path of bad) {
      expect(isSafePartPath(path)).toBe(false);
      expect(() => {
        assertSafePartPath(path, '测试');
      }).toThrow(DocumentModelError);
    }
  });

  it('不可打印字符（含 NUL）被拒', () => {
    expect(isSafePartPath(`word/${String.fromCodePoint(0)}.xml`)).toBe(false);
  });
});

describe('R106 关系 id：只用未占用 id，且不复用旧编号', () => {
  it('空表 ⇒ rId1', () => {
    expect(nextRelationshipId([])).toBe('rId1');
  });

  it('取已用最大编号 + 1（不复用被删掉的编号，避免旧引用静默改指）', () => {
    const existing: readonly RelationshipRecord[] = [
      imageRelationship('rId1', 'media/a.png'),
      imageRelationship('rId3', 'media/b.png'),
    ];
    // 2 号是空的，但**不**复用
    expect(nextRelationshipId(existing)).toBe('rId4');
  });

  it('非规范 id 不参与编号计算', () => {
    expect(nextRelationshipId([{ id: 'weird' }, { id: 'rId7' }])).toBe('rId8');
  });

  it('关系 id 重复会被自检拒绝', () => {
    const base = validPreservedModel();
    const broken: DocumentModel = {
      ...base,
      relationships: [imageRelationship('rId1', 'media/pic.png'), imageRelationship('rId1', 'media/pic.png')],
    };
    expect(errorCodes(validateDocument(broken, { known_part_paths: KNOWN_PARTS }))).toContain(
      'duplicate_relationship_id',
    );
  });
});

describe('R161/R162 关系形态与目标解析', () => {
  it('相对 owner 目录解析；/ 开头从包根算起', () => {
    expect(resolveRelationshipTarget('word/document.xml', 'media/image1.png')).toBe(
      'word/media/image1.png',
    );
    expect(resolveRelationshipTarget('word/document.xml', '../docProps/core.xml')).toBe(
      'docProps/core.xml',
    );
    expect(resolveRelationshipTarget('word/document.xml', '/word/styles.xml')).toBe(
      'word/styles.xml',
    );
    expect(resolveRelationshipTarget(null, 'word/document.xml')).toBe('word/document.xml');
  });

  it('逃出包根即抛（不产出半解析结果）', () => {
    expect(() => resolveRelationshipTarget('word/document.xml', '../../evil.xml')).toThrow(
      DocumentModelError,
    );
    expect(() => resolveRelationshipTarget(null, '../evil.xml')).toThrow(DocumentModelError);
  });

  it('外部目标可识别，但本模块不解析它（R161）', () => {
    expect(isExternalTarget('https://example.com/a.png')).toBe(true);
    expect(isExternalTarget('file:///tmp/a.png')).toBe(true);
    expect(isExternalTarget('media/a.png')).toBe(false);
    expect(EXTERNAL_RELATIONSHIP_POLICY.length).toBeGreaterThan(10);
  });

  it('Internal 关系不得写外部 URI（构造期即拒）', () => {
    expect(() => imageRelationship('rId1', 'https://example.com/a.png')).toThrow(DocumentModelError);
  });

  it('外部关系照原样保留（不抓取、不改写）', () => {
    const base = validPreservedModel();
    const withExternal: DocumentModel = {
      ...base,
      relationships: [
        ...base.relationships,
        createRelationship({
          id: 'rId9',
          type: HYPERLINK_REL,
          target: 'https://example.com',
          target_mode: 'External',
          owner_part_path: 'word/document.xml',
        }),
      ],
    };
    const report = validateDocument(withExternal, { known_part_paths: KNOWN_PARTS });
    expect(report.errors).toEqual([]);
    expect(withExternal.relationships[1]?.target).toBe('https://example.com');
  });

  it('关系类型按后缀匹配（完整 URI）', () => {
    expect(relationshipTypeHasSuffix(OFFICE_DOCUMENT_REL, 'officeDocument')).toBe(true);
    expect(relationshipTypeHasSuffix(OFFICE_DOCUMENT_REL, 'image')).toBe(false);
    expect(relationshipTypeHasSuffix('image', 'image')).toBe(true);
  });

  it('R162：officeDocument 指向非主部件 ⇒ 拒绝', () => {
    const base = validPreservedModel();
    const wrongMain: DocumentModel = {
      ...base,
      relationships: [
        ...base.relationships,
        createRelationship({
          id: 'rId5',
          type: OFFICE_DOCUMENT_REL,
          target: 'word/styles.xml',
          target_mode: 'Internal',
          owner_part_path: null,
        }),
      ],
    };
    expect(
      errorCodes(
        validateDocument(wrongMain, {
          known_part_paths: [...KNOWN_PARTS, 'word/styles.xml'],
          main_document_part_path: 'word/document.xml',
        }),
      ),
    ).toContain('invalid_relationship');
  });
});

describe('内容类型表（defaults + overrides）', () => {
  it('构造与查询：覆盖项优先于扩展名默认项', () => {
    const table = createContentTypeTable({
      defaults: [{ extension: 'png', content_type: 'image/png' }],
      overrides: [{ part_name: '/word/document.xml', content_type: 'application/docx-main' }],
    });
    expect(findContentType(table, 'word/media/a.png')).toBe('image/png');
    expect(findContentType(table, 'word/document.xml')).toBe('application/docx-main');
    expect(findContentType(table, 'word/unknown')).toBeNull();
    expect(findContentType(table, 'word/no-extension')).toBeNull();
  });

  it('扩展名重复 / 带前导点 / 覆盖项非绝对名 / 覆盖项重复 ⇒ 抛', () => {
    expect(() =>
      createContentTypeTable({
        defaults: [
          { extension: 'png', content_type: 'image/png' },
          { extension: 'png', content_type: 'image/png' },
        ],
      }),
    ).toThrow(DocumentModelError);
    expect(() =>
      createContentTypeTable({ defaults: [{ extension: '.png', content_type: 'image/png' }] }),
    ).toThrow(DocumentModelError);
    expect(() =>
      createContentTypeTable({ overrides: [{ part_name: 'word/document.xml', content_type: 'x' }] }),
    ).toThrow(DocumentModelError);
    expect(() =>
      createContentTypeTable({
        overrides: [
          { part_name: '/a.xml', content_type: 'x' },
          { part_name: '/a.xml', content_type: 'y' },
        ],
      }),
    ).toThrow(DocumentModelError);
  });

  it('部件与媒体构造期校验', () => {
    expect(() => createOpaquePart({ path: '../x', content_type: 'x', bytes: BYTES })).toThrow(
      DocumentModelError,
    );
    expect(() =>
      createMediaPart({ path: 'media/a.png', content_type: '', relationship_id: 'rId1', bytes: BYTES }),
    ).toThrow(DocumentModelError);
    expect(() =>
      createMediaPart({
        path: 'media/a.png',
        content_type: 'image/png',
        relationship_id: '',
        bytes: BYTES,
      }),
    ).toThrow(DocumentModelError);
  });
});

describe('R160 关系完整性：悬空 rId 必须拒绝', () => {
  /** 把合法基线的图片关系改成指向一个不存在的部件。 */
  function withDanglingTarget(): DocumentModel {
    return { ...validPreservedModel(), relationships: [imageRelationship('rId1', 'media/missing.png')] };
  }

  it('声明了包范围而目标不在其中 ⇒ dangling_relationship_target（拒绝）', () => {
    const report = validateDocument(withDanglingTarget(), { known_part_paths: KNOWN_PARTS });
    expect(report.ok).toBe(false);
    expect(errorCodes(report)).toContain('dangling_relationship_target');
  });

  it('**没声明**包范围 ⇒ package_scope_undeclared（不把"没查"记成"查过了"）', () => {
    const report = validateDocument(withDanglingTarget());
    expect(report.ok).toBe(false);
    expect(errorCodes(report)).toContain('package_scope_undeclared');
    expect(errorCodes(report)).not.toContain('dangling_relationship_target');
  });

  it('构造期就挡住（createDocumentModel 自检，不产出半成品）', () => {
    expect(() =>
      createDocumentModel(
        {
          document_id: 'doc-bad',
          blocks: [textParagraphNode({ text: 'x', source: 'imported' })],
          relationships: [imageRelationship('rId1', 'media/missing.png')],
        },
        { known_part_paths: KNOWN_PARTS },
      ),
    ).toThrow(DocumentModelError);
  });

  it('目标存在（媒体部件）⇒ 通过：媒体 ↔ 关系双向一致', () => {
    const report = validateDocument(validPreservedModel(), { known_part_paths: KNOWN_PARTS });
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('媒体的关系指向别处 ⇒ media_relationship_mismatch（拒绝）', () => {
    const base = validPreservedModel();
    const broken: DocumentModel = { ...base, relationships: [imageRelationship('rId1', 'media/other.png')] };
    expect(errorCodes(validateDocument(broken, { known_part_paths: KNOWN_PARTS }))).toContain(
      'media_relationship_mismatch',
    );
  });

  it('媒体绑定的关系不存在 ⇒ 也算悬空（拒绝）', () => {
    const base = validPreservedModel();
    const broken: DocumentModel = { ...base, relationships: [] };
    expect(errorCodes(validateDocument(broken, { known_part_paths: KNOWN_PARTS }))).toContain(
      'media_relationship_mismatch',
    );
  });
});

describe('R105/R151 保留性：只改一段，不透明部件与关系原样保留', () => {
  it('字节、内容类型、关系在结构编辑后逐项不变', () => {
    const before = validPreservedModel();
    const outcome = applyStructureEdit(before, {
      kind: 'insert_block',
      container: { kind: 'body' },
      index: 0,
      block: textParagraphNode({ text: '新段', source: 'user_request' }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }

    expect(outcome.model.opaque_parts).toEqual(before.opaque_parts);
    expect(outcome.model.opaque_parts[0]?.bytes).toEqual(BYTES);
    expect(outcome.model.relationships).toEqual(before.relationships);
    expect(outcome.model.content_types).toEqual(before.content_types);
    expect(outcome.model.media).toEqual(before.media);
    // 正文确实变了（否则这条用例证明不了什么）
    expect(outcome.model.blocks.length).toBe(before.blocks.length + 1);
    expect(paragraphBlockAt(outcome.model, 0).id).not.toBe(paragraphBlockAt(before, 0).id);
  });

  it('口径声明非空（供证据文本引用）', () => {
    expect(PRESERVATION_STATEMENT.length).toBeGreaterThan(10);
  });
});
