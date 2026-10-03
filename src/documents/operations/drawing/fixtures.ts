/**
 * 图形测试夹具（**仅供测试**，不从 `index.ts` 导出；文件名不以 `.test.ts` 结尾，
 * vitest 不会收集它）。
 */

import { createHash } from 'node:crypto';
import { serializeDocumentPart } from '../../docx/export.js';
import { utf8Bytes } from '../../../artifacts/ooxml/xml.js';
import { createDocumentModel } from '../../model/document.js';
import { paragraphNode, runNode, textParagraphNode } from '../../model/nodes.js';
import type { DocumentModel, NodeId } from '../../model/types.js';

/** 假的图片字节（不参与解码；只用来验证"字节被原样保存/未被改动"）。 */
export function fakeImageBytes(seed = 1): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = (index * 7 + seed * 13) % 256;
  }
  // PNG 魔数（前 8 字节），让"这是一张 PNG"在字节层也说得通。
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return bytes;
}

/** 另一份不同内容的字节（用于"替换图片"后摘要必须变）。 */
export function otherImageBytes(): Uint8Array {
  return fakeImageBytes(9);
}

/** sha256（测试里现算，**不 import 生产实现**，与 D10 的验收口径一致）。 */
export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 一份只有一个段落的文档（"一段文字"里有 run 可插）。 */
export function paragraphModel(text = '这里要插图'): DocumentModel {
  return createDocumentModel({
    document_id: 'doc-drawing-fixture',
    blocks: [textParagraphNode({ text, source: 'user_request' })],
  });
}

/** 一份"两段 + 表格"的文档（验证图形操作不碰别的块）。 */
export function documentWithTable(): DocumentModel {
  return createDocumentModel({
    document_id: 'doc-drawing-table',
    blocks: [
      paragraphNode({ source: 'user_request', inlines: [runNode({ text: '第一段', source: 'user_request' })] }),
      textParagraphNode({ text: '第二段', source: 'user_request' }),
    ],
  });
}

/** 第一段的 id。 */
export function firstParagraphId(model: DocumentModel): NodeId {
  const block = model.blocks[0];
  if (block === undefined || block.kind !== 'paragraph') {
    throw new Error('夹具使用错误：第一块不是段落');
  }
  return block.id;
}

/** 主部件根字节（`serializeDocumentPart` 取命名空间声明用）。 */
export const ROOT_BYTES = utf8Bytes(
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><w:body/></w:document>',
);

/** 把模型重建为 `word/document.xml` 文本（端到端证据：图片到底有没有写进去）。 */
export function documentXml(model: DocumentModel): string {
  return serializeDocumentPart({ blocks: model.blocks, sections: model.sections }, ROOT_BYTES);
}

/** 一段"认不出的图形"XML（模拟 SmartArt/图表这类本包不建模的 drawing）。 */
export const UNKNOWN_DRAWING_XML =
  '<w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">' +
  '<wp:extent cx="1000000" cy="500000"/><wp:docPr id="77" name="SmartArt 1"/>' +
  '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
  '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram">' +
  '<dgm:relIds xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" r:dm="rId99"/>' +
  '</a:graphicData></a:graphic></wp:inline></w:drawing>';

/** 一段**完全解析不出来**的片段（不是 drawing，模拟其它未建模元素）。 */
export const OPAQUE_FRAGMENT_XML = '<w:bookmarkStart w:id="3" w:name="锚点"/>';
