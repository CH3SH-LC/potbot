/**
 * 第 1 层结构自检（design-02 P1；合同 v1.4 R53.1）。
 *
 * 覆盖五条机器判据（**都是"挡住明显坏掉的构建器"**，不是"证明能打开"）：
 * 1. 好字节 ⇒ `ok: true`；
 * 2. 改一个字节 ⇒ CRC 不符被报出；
 * 3. 缺 `[Content_Types].xml` ⇒ 被报出；
 * 4. 带 BOM ⇒ 被报出；
 * 5. 标签不配平 ⇒ 被报出。
 *
 * 另加：关系目标缺失、非 ZIP 字节、以及**能力边界**（返回值/描述里不得暗示"能打开"）。
 */

import { describe, expect, it } from 'vitest';

import {
  RELATIONSHIPS_CONTENT_TYPE,
  assembleOpcPackage,
  attr,
  el,
  serializeXmlDocument,
  writeZip,
  type OpcPart,
} from './ooxml/index.js';
import {
  SELF_CHECK_SCOPE_STATEMENT,
  describeSelfCheckResult,
  selfCheckArtifactBytes,
  type ArtifactSelfCheckResult,
} from './verify.js';

const DOCUMENT_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';

const WORD_NAMESPACE = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const OFFICE_DOCUMENT_RELATIONSHIP =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';

const encoder = new TextEncoder();

function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

function sampleDocumentXml(): string {
  return serializeXmlDocument(el('w:document', [attr('xmlns:w', WORD_NAMESPACE)], [el('w:body', [], [])]));
}

/** 一份**好字节**的 OPC 包（单部件 + 包级关系，关系目标存在）。 */
function goodPackageBytes(): Uint8Array {
  const parts: OpcPart[] = [
    { path: 'word/document.xml', content_type: DOCUMENT_CONTENT_TYPE, data: sampleDocumentXml() },
  ];
  const assembled = assembleOpcPackage({
    parts,
    content_type_defaults: [{ extension: 'rels', content_type: RELATIONSHIPS_CONTENT_TYPE }],
    relationships: [
      {
        owner_part_path: null,
        declarations: [{ type: OFFICE_DOCUMENT_RELATIONSHIP, target: '/word/document.xml' }],
      },
    ],
  });
  return writeZip(assembled.entries);
}

/** 手工拼一份只含给定条目的 ZIP（用于制造"缺必备部件 / 坏 XML"等反例）。 */
function zipOf(entries: { path: string; data: Uint8Array }[]): Uint8Array {
  return writeZip(entries);
}

function problemKinds(result: ArtifactSelfCheckResult): readonly string[] {
  return result.problems.map((problem) => problem.kind);
}

describe('第 1 层结构自检：好字节', () => {
  it('自产的好字节 ⇒ ok: true，且如实标注层号与条目数', () => {
    const result = selfCheckArtifactBytes(goodPackageBytes());
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.layer).toBe(1);
    expect(result.entry_count).toBe(3);
    expect(result.entries.map((entry) => entry.path)).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'word/document.xml',
    ]);
    // 每个条目的 CRC 都被**重算**过（不是照抄中央目录）
    const document = result.entries[1];
    expect(document?.recomputed_crc32).toBe(document?.recorded_crc32);
    expect(document?.recomputed_crc32).not.toBeNull();
  });

  it('非 ZIP 字节 ⇒ 不抛错，报 not_a_zip', () => {
    for (const bytes of [new Uint8Array(0), utf8('not a zip at all'), new Uint8Array([1, 2, 3])]) {
      const result = selfCheckArtifactBytes(bytes);
      expect(result.ok).toBe(false);
      expect(problemKinds(result)).toContain('not_a_zip');
    }
  });
});

describe('第 1 层结构自检：改一个字节 ⇒ CRC 不符', () => {
  it('翻转条目数据里的一个字节 ⇒ crc_mismatch（重算是关键，照抄中央目录就发现不了）', () => {
    const bytes = goodPackageBytes();
    // 定序是 [Content_Types].xml → _rels/.rels → word/document.xml，因此中央目录的起点
    // 前 10 字节必然落在最后一个条目（document.xml）的数据区里。
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const centralDirectoryStart = view.getUint32(bytes.byteLength - 22 + 16, true);
    const mutated = Uint8Array.from(bytes);
    mutated[centralDirectoryStart - 10] = (mutated[centralDirectoryStart - 10] ?? 0) ^ 0x20;

    const result = selfCheckArtifactBytes(mutated);
    expect(result.ok).toBe(false);
    expect(problemKinds(result)).toContain('crc_mismatch');
    const mismatch = result.problems.find((problem) => problem.kind === 'crc_mismatch');
    expect(mismatch?.detail).toContain('word/document.xml');
    // 重算值确实与被记录值不同（证据可读）
    const entry = result.entries.find((candidate) => candidate.path === 'word/document.xml');
    expect(entry?.recomputed_crc32).not.toBe(entry?.recorded_crc32);
  });
});

describe('第 1 层结构自检：必备部件缺失', () => {
  it('缺 [Content_Types].xml ⇒ 被报出', () => {
    const bytes = zipOf([
      { path: '_rels/.rels', data: utf8(serializeXmlDocument(el('Relationships', [], []))) },
    ]);
    const result = selfCheckArtifactBytes(bytes);
    expect(result.ok).toBe(false);
    expect(problemKinds(result)).toContain('missing_content_types');
  });

  it('缺 _rels/.rels ⇒ 被报出', () => {
    const bytes = zipOf([
      { path: '[Content_Types].xml', data: utf8(serializeXmlDocument(el('Types', [], []))) },
    ]);
    const result = selfCheckArtifactBytes(bytes);
    expect(result.ok).toBe(false);
    expect(problemKinds(result)).toContain('missing_root_relationships');
  });
});

describe('第 1 层结构自检：XML 良构性', () => {
  it('带 BOM ⇒ 被报出', () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8(sampleDocumentXml())]);
    const bytes = zipOf([
      { path: '[Content_Types].xml', data: utf8(serializeXmlDocument(el('Types', [], []))) },
      { path: '_rels/.rels', data: utf8(serializeXmlDocument(el('Relationships', [], []))) },
      { path: 'word/document.xml', data: withBom },
    ]);
    const result = selfCheckArtifactBytes(bytes);
    expect(result.ok).toBe(false);
    expect(problemKinds(result)).toContain('xml_has_bom');
  });

  it('标签不配平 ⇒ 被报出（<a><b></a>）', () => {
    const broken = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document><w:body></w:document>';
    const bytes = zipOf([
      { path: '[Content_Types].xml', data: utf8(serializeXmlDocument(el('Types', [], []))) },
      { path: '_rels/.rels', data: utf8(serializeXmlDocument(el('Relationships', [], []))) },
      { path: 'word/document.xml', data: utf8(broken) },
    ]);
    const result = selfCheckArtifactBytes(bytes);
    expect(result.ok).toBe(false);
    expect(problemKinds(result)).toContain('xml_not_well_formed');
    const problem = result.problems.find((candidate) => candidate.kind === 'xml_not_well_formed');
    expect(problem?.detail).toContain('不配平');
  });

  it('未闭合标签 ⇒ 被报出（<a><b></b>）', () => {
    const broken = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document><w:body></w:body>';
    const bytes = zipOf([
      { path: '[Content_Types].xml', data: utf8(serializeXmlDocument(el('Types', [], []))) },
      { path: '_rels/.rels', data: utf8(serializeXmlDocument(el('Relationships', [], []))) },
      { path: 'word/document.xml', data: utf8(broken) },
    ]);
    const result = selfCheckArtifactBytes(bytes);
    expect(problemKinds(result)).toContain('xml_not_well_formed');
  });

  it('声明漂了 ⇒ 被报出（encoding 不是 UTF-8）', () => {
    const broken = '<?xml version="1.0" encoding="GBK"?>\n<w:document></w:document>';
    const bytes = zipOf([
      { path: '[Content_Types].xml', data: utf8(serializeXmlDocument(el('Types', [], []))) },
      { path: '_rels/.rels', data: utf8(serializeXmlDocument(el('Relationships', [], []))) },
      { path: 'word/document.xml', data: utf8(broken) },
    ]);
    expect(problemKinds(selfCheckArtifactBytes(bytes))).toContain('xml_declaration_invalid');
  });
});

describe('第 1 层结构自检：关系目标必须存在', () => {
  it('内部 Target 指向不存在的部件 ⇒ 被报出', () => {
    const relationships = serializeXmlDocument(
      el(
        'Relationships',
        [attr('xmlns', 'http://schemas.openxmlformats.org/package/2006/relationships')],
        [
          el('Relationship', [
            attr('Id', 'rId1'),
            attr('Type', OFFICE_DOCUMENT_RELATIONSHIP),
            attr('Target', '/word/missing.xml'),
          ]),
        ],
      ),
    );
    const bytes = zipOf([
      { path: '[Content_Types].xml', data: utf8(serializeXmlDocument(el('Types', [], []))) },
      { path: '_rels/.rels', data: utf8(relationships) },
    ]);
    const result = selfCheckArtifactBytes(bytes);
    expect(result.ok).toBe(false);
    expect(problemKinds(result)).toContain('relationship_target_missing');
  });

  it('外部 Target（TargetMode="External"）不参与存在性判定', () => {
    const relationships = serializeXmlDocument(
      el(
        'Relationships',
        [attr('xmlns', 'http://schemas.openxmlformats.org/package/2006/relationships')],
        [
          el('Relationship', [
            attr('Id', 'rId1'),
            attr('Type', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink'),
            attr('Target', 'https://example.invalid/x'),
            attr('TargetMode', 'External'),
          ]),
        ],
      ),
    );
    const bytes = zipOf([
      { path: '[Content_Types].xml', data: utf8(serializeXmlDocument(el('Types', [], []))) },
      { path: '_rels/.rels', data: utf8(relationships) },
    ]);
    const result = selfCheckArtifactBytes(bytes);
    expect(problemKinds(result)).not.toContain('relationship_target_missing');
    expect(problemKinds(result)).not.toContain('relationship_target_invalid');
  });
});

describe('第 1 层结构自检：能力边界不得被夸大', () => {
  it('层号恒为 1，且边界陈述写明"不能证明目标软件能打开"与第三层归属', () => {
    expect(SELF_CHECK_SCOPE_STATEMENT).toContain('不能');
    expect(SELF_CHECK_SCOPE_STATEMENT).toContain('office-open-check.ts');
    const description = describeSelfCheckResult(selfCheckArtifactBytes(goodPackageBytes()));
    expect(description).toContain('第 1 层结构自检通过');
    expect(description).toContain(SELF_CHECK_SCOPE_STATEMENT);
    // 通过 ≠ 能打开：描述里不得出现"可打开 / 已交付"这类更强主张
    expect(description).not.toContain('可打开');
    expect(description).not.toContain('已交付');
  });
});

