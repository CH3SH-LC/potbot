/**
 * WCF-D40：**图片的"类型化 `DrawingNode`"表示法端到端接通**（WF-065）。
 *
 * ## 这份测试回答什么
 *
 * | 判据 | 用例 |
 * |---|---|
 * | 插入图片产出**真正的** `DrawingNode`（带 `relationship_id`） | ① |
 * | 包级三件套（字节 / 关系 / 内容类型）在**模型层**就绪 | ② |
 * | **端到端**：导出的 `word/document.xml` 里真的有 `w:drawing`，`r:embed` 指向真实关系 | ③ |
 * | `r:embed` **无悬空**（关系在表里、部件在包里、类型已声明、目标可解析） | ③ |
 * | 反例：关系悬空 ⇒ 导出**结构化拒绝**（不产出坏包） | ④ |
 * | 反例：没有包级上下文 ⇒ 拒绝而不是猜着写 | ⑤ |
 * | D01 缺陷已关：`createDocumentModel()` 现在接受 `DrawingNode` | ⑥ |
 * | R105 不回归：段落里既有的未建模片段原样保留 | ⑦ |
 *
 * ## 与 `image.test.ts` 的分工（**两条表示法**）
 *
 * `image.test.ts` 覆盖"run + `opaque` 片段"表示法（导入来的图形、既有编辑操作）；
 * 本文件覆盖"类型化 `DrawingNode`"表示法（`insertImageDrawing` → 导出器重建 `w:drawing`）。
 * 两条表示法导出后都应产出可用的 `w:drawing`，但模型层的形状不同。
 *
 * ## 为什么导出时要显式给 `drawing_context`
 *
 * `serializeDocumentPart` 的第三参省略时**没有任何包级事实**，导出器对任何 `DrawingNode`
 * 都显式拒绝（`unsupported_drawing`）——"不知道关系表就不猜着写"。这里把模型自己的
 * 关系/部件/媒体喂进去（`drawingContext`），这正是 `exportDocx` 内部做的事。
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readZip } from '../../../artifacts/ooxml/zip-read.js';
import { createDocumentModel } from '../../model/document.js';
import { drawingNode, paragraphNode, runNode } from '../../model/nodes.js';
import { validateDocument } from '../../model/validation.js';
import { DocxError } from '../../docx/docx-error.js';
import { exportDocx, serializeDocumentPart } from '../../docx/export.js';
import { importDocx } from '../../docx/import.js';
import { drawingContext } from '../../docx/drawing-render.js';
import type { DocumentModel, Length } from '../../model/types.js';
import {
  OPAQUE_FRAGMENT_XML,
  ROOT_BYTES,
  documentXml,
  fakeImageBytes,
  firstParagraphId,
  paragraphModel,
} from './fixtures.js';
import { checkMediaIntegrity } from './media.js';
import { insertImageDrawing, mainPart } from './image.js';

const MM = (value: number): Length => ({ unit: 'mm', value });

// 本文件在 `src/documents/operations/drawing/`，距仓库根四层。
const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const CORPUS_A = join(
  REPO_ROOT,
  'tests',
  'word-acceptance',
  'fixtures',
  'corpus-a-independent-deflate.docx',
);

/** 真实语料（`exportDocx` 要求模型里有包级关系与主部件原字节，从零造的夹具满足不了）。 */
function corpusModel(): DocumentModel {
  return importDocx(new Uint8Array(readFileSync(CORPUS_A)));
}

/** 导出时喂给导出器的包级事实（= `exportDocx` 内部做的同一件事）。 */
function exportWithDrawingContext(model: DocumentModel): string {
  const partPaths = new Set<string>([
    ...model.media.map((part) => part.path),
    ...model.opaque_parts.map((part) => part.path),
  ]);
  return serializeDocumentPart(
    { blocks: model.blocks, sections: model.sections },
    ROOT_BYTES,
    {
      drawing_context: drawingContext(mainPart(model), model.relationships, partPaths, model.media),
    },
  );
}

function insert(model: DocumentModel, extra: Partial<Parameters<typeof insertImageDrawing>[1]> = {}) {
  return insertImageDrawing(model, {
    paragraph_id: firstParagraphId(model),
    bytes: fakeImageBytes(),
    content_type: 'image/png',
    width: MM(40),
    height: MM(30),
    ...extra,
  });
}

describe('插入图片为类型化 DrawingNode（WF-065；WCF-D40）', () => {
  it('① 段落里出现一个 DrawingNode（带 relationship_id / extent），既有 run 与 id 不变', () => {
    const model = paragraphModel('前文');
    const paragraph = model.blocks[0];
    if (paragraph === undefined || paragraph.kind !== 'paragraph') throw new Error('夹具异常');
    const beforeIds = paragraph.inlines.map((inline) => inline.id);

    const inserted = insert(model, { inline_index: 0 });
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;

    const after = inserted.model.blocks[0];
    if (after === undefined || after.kind !== 'paragraph') throw new Error('夹具异常');
    // 新节点在前，原来的 run 还在且 id 不变（R101）。
    expect(after.inlines.map((inline) => inline.id).slice(1)).toEqual(beforeIds);
    const node = after.inlines[0];
    expect(node?.kind).toBe('drawing');
    expect(node?.id).toBe(inserted.node_id);
    if (node?.kind !== 'drawing') return;
    expect(node.drawing_type).toBe('picture');
    expect(node.relationship_id).toBe(inserted.relationship_id);
    expect(node.extent).toEqual({ width: MM(40), height: MM(30) });
    expect(node.rotation_deg).toBe(0);
    expect(node.wrap).toBe('inline');
    // 类型化节点**不往 opaque 里塞图形 XML**（那正是 WCF-D05 的老路子）。
    expect(node.opaque).toEqual([]);
    expect(inserted.model.media.length).toBe(1);
  });

  it('② 包级三件套在模型层就绪：字节 + 关系 + 内容类型（无悬空）', () => {
    const inserted = insert(paragraphModel());
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;
    const model = inserted.model;
    const media = model.media.find((part) => part.relationship_id === inserted.relationship_id);
    expect(media?.path).toBe(inserted.part_path);
    expect(media?.bytes.length).toBe(fakeImageBytes().length);
    const relationship = model.relationships.find((record) => record.id === inserted.relationship_id);
    expect(relationship?.type.endsWith('/image')).toBe(true);
    expect(relationship?.target_mode).toBe('Internal');
    // 内容类型已声明（`checkMediaIntegrity` 的第 3 类问题就是它）。
    expect(checkMediaIntegrity(model)).toEqual([]);
  });

  it('③ 端到端：导出的 document.xml 里有 w:drawing，且 r:embed 指向真实、可解析的关系', () => {
    const model = paragraphModel('前文');
    const inserted = insert(model);
    if (!inserted.ok) throw new Error('应先成功');
    const xml = exportWithDrawingContext(inserted.model);

    expect(xml).toContain('<w:drawing');
    expect(xml).toContain('<wp:inline');
    expect(xml).toContain(`r:embed="${inserted.relationship_id}"`);
    // 尺寸按 EMU 写（40 mm × 30 mm）——模型给的是 Length，换算在 EMU 唯一入口。
    // 口径是 twips 量化后再折 EMU：40 mm = 2267.72 → 2268 twips → 2268 × 635 = 1440180 EMU；
    // 30 mm → 1701 twips → 1080135 EMU。（这是 `params.ts` 的既有换算口径，不是"差不多"。）
    expect(xml).toContain('<wp:extent cx="1440180" cy="1080135"/>');

    // **无悬空**：把 XML 里的 r:embed 抓出来，逐条落到关系表与媒体部件上。
    const ids = [...xml.matchAll(/r:embed="([^"]+)"/g)].map((match) => match[1] as string);
    expect(ids).toEqual([inserted.relationship_id]);
    for (const id of ids) {
      const relationship = inserted.model.relationships.find((record) => record.id === id);
      expect(relationship).toBeDefined();
      const media = inserted.model.media.filter((part) => part.relationship_id === id);
      expect(media.length).toBe(1);
    }
    // 没有包级上下文时导出器**拒绝**（见 ⑤），说明 ③ 的成功不是"猜出来的"。
    expect(() => documentXml(inserted.model)).toThrow(DocxError);
  });

  it('④ 反例：relationship_id 悬空 ⇒ 导出结构化拒绝（不产出坏包）', () => {
    // 手工装配一个引用不存在关系的图形（模型工厂只校验"非空"，落点由导出器把关）。
    const model = createDocumentModel({
      document_id: 'doc-wcf-d40-dangling',
      blocks: [
        paragraphNode({
          source: 'user_request',
          inlines: [
            runNode({ text: '前文', source: 'user_request' }),
            drawingNode({
              drawing_type: 'picture',
              relationship_id: 'rId99',
              extent: { width: MM(10), height: MM(10) },
              source: 'user_request',
            }),
          ],
        }),
      ],
    });
    let caught: unknown = null;
    try {
      exportWithDrawingContext(model);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DocxError);
    expect((caught as DocxError).reason).toBe('dangling_relationship_id');
  });

  it('⑤ 反例：没有包级上下文 ⇒ 拒绝而不是猜着写（入口边界）', () => {
    const inserted = insert(paragraphModel());
    if (!inserted.ok) throw new Error('应先成功');
    let caught: unknown = null;
    try {
      // 第三参省略 = 调用方没有提供任何包级事实。
      serializeDocumentPart({ blocks: inserted.model.blocks, sections: inserted.model.sections }, ROOT_BYTES);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DocxError);
    expect((caught as DocxError).reason).toBe('unsupported_drawing');
  });

  it('⑥ D01 缺陷已关：createDocumentModel() 现在接受 DrawingNode', () => {
    // WCF-D30 的记录：`inlineKindOf()` 曾只放行 run/break/field，段落里有 DrawingNode 就抛
    // `invalid_node`（用例只能绕过工厂装配）。现在这条已修，这里**直接用工厂**证明。
    const model = insert(paragraphModel());
    if (!model.ok) throw new Error('应先成功');
    const rebuilt = createDocumentModel({
      document_id: 'doc-wcf-d40-rebuild',
      blocks: model.model.blocks,
    });
    expect(validateDocument(rebuilt).errors).toEqual([]);
    const paragraph = rebuilt.blocks[0];
    expect(paragraph?.kind === 'paragraph' && paragraph.inlines.some((i) => i.kind === 'drawing')).toBe(
      true,
    );
  });

  it('⑦ 整包端到端：导出的 .docx 里 .rels / 媒体部件 / 内容类型三件齐全（独立 ZIP 读回）', () => {
    // 用真实语料做底座（`exportDocx` 要求模型里有包级 `officeDocument` 关系与主部件原字节）。
    const inserted = insert(corpusModel());
    if (!inserted.ok) throw new Error(`应先成功：${inserted.detail}`);
    const archive = readZip(exportDocx(inserted.model));
    const decoder = new TextDecoder();
    const text = (path: string): string | null => {
      const entry = archive.by_path.get(path);
      return entry === undefined ? null : decoder.decode(entry.data);
    };

    // ① 主部件里有 w:drawing，且 r:embed 是刚分配的那条关系。
    const main = text('word/document.xml') as string;
    expect(main).toContain('<w:drawing');
    expect(main).toContain(`r:embed="${inserted.relationship_id}"`);

    // ② 关系表里有这条 image 关系，目标指向那个媒体部件（**不是悬空**）。
    const rels = text('word/_rels/document.xml.rels') as string;
    expect(rels).toContain(`Id="${inserted.relationship_id}"`);
    expect(rels).toContain('/image');
    const fileName = inserted.part_path.slice(inserted.part_path.lastIndexOf('/') + 1);
    expect(rels).toContain(`Target="media/${fileName}"`);

    // ③ 媒体部件本身在包里，字节逐字节等于输入。
    expect(archive.by_path.has(inserted.part_path)).toBe(true);
    const stored = archive.by_path.get(inserted.part_path)?.data;
    expect(stored === undefined ? null : Array.from(stored)).toEqual(Array.from(fakeImageBytes()));

    // ④ 内容类型已声明（否则消费端不知道拿什么解码器打开它）。
    const contentTypes = text('[Content_Types].xml') as string;
    expect(contentTypes).toContain('image/png');
  });

  it('⑧ R105 不回归：并列的未建模片段原样留在 run 里', () => {
    // 既有 run 的 opaque 里带着一段导入保留的片段（bookmarkStart）。
    const model = createDocumentModel({
      document_id: 'doc-wcf-d40-r105',
      blocks: [
        paragraphNode({
          source: 'imported',
          inlines: [
            runNode({
              text: '带书签的文字',
              source: 'imported',
              opaque: [{ kind: 'raw_at_char', xml: OPAQUE_FRAGMENT_XML, offset: 0 }],
            }),
          ],
        }),
      ],
    });
    const inserted = insert(model);
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;
    const paragraph = inserted.model.blocks[0];
    if (paragraph === undefined || paragraph.kind !== 'paragraph') throw new Error('夹具异常');
    const survivor = paragraph.inlines.find((inline) => inline.kind === 'run');
    expect(JSON.stringify(survivor?.opaque)).toContain('bookmarkStart');
    // 片段被逐字写回导出结果里（R105：不丢、不改、不重排）。
    expect(exportWithDrawingContext(inserted.model)).toContain('bookmarkStart');
  });
});
