/**
 * 本包的**测试与证据用小工具**（不参与运行时逻辑，也**不**从 `index.ts` 导出）。
 *
 * 为什么放在 `src/documents/sections/` 而不是 `tests/`：本任务的写权只有
 * `src/documents/sections/**` 与 `.task-manifest/outputs/WCF-D51/**`，
 * 而多个测试文件都要用同一套"多节文档"夹具；夹具若各写一份，就会各自漂移。
 *
 * ## 这里的 `sectPrXml` 为什么必须是真的序列化
 *
 * R108 的判据是"其他节的 `sectPr` **逐字节不变**"。要证明这件事，不能只看模型对象，
 * 必须让**真正的导出器**（`docx/word-xml.ts` 的 `serializeSectionProperties`）把节属性
 * 渲染成 XML 字符串，再逐字符比较——否则"有人改了导出器的一个默认值"这类回归不会被发现。
 * 因此本文件调用的是**生产序列化函数**，而不是另写一个"看起来差不多"的渲染器（R167 的取向）。
 */

import { createDocumentModel } from '../model/document.js';
import { defaultSectionProperties, textParagraphNode } from '../model/nodes.js';
import { specified } from '../model/attributes.js';
import { TOGGLE_OFF, TOGGLE_ON } from '../model/types.js';
import { serializeSectionProperties } from '../docx/word-xml.js';
import { serializeXmlNode } from '../../artifacts/ooxml/xml.js';
import type {
  ContentTypeTable,
  DocumentModel,
  Length,
  OpaquePart,
  RelationshipRecord,
  SectionProperties,
} from '../model/types.js';
import type { DraftBlockNode } from '../model/nodes.js';
import type { HeaderFooterRole, MarginBox, PageSize } from './types.js';

// ---------------------------------------------------------------------------
// 长度构造
// ---------------------------------------------------------------------------

/** 毫米长度。 */
export function mm(value: number): Length {
  return { unit: 'mm', value };
}

/** 厘米长度。 */
export function cm(value: number): Length {
  return { unit: 'cm', value };
}

/** 磅长度。 */
export function pt(value: number): Length {
  return { unit: 'pt', value };
}

/** 英寸长度。 */
export function inch(value: number): Length {
  return { unit: 'inch', value };
}

/** 一套页边距（四边单位 cm + 装订线 cm）。 */
export function marginBox(top: number, right: number, bottom: number, left: number, gutter = 0): MarginBox {
  return { top: cm(top), right: cm(right), bottom: cm(bottom), left: cm(left), gutter: cm(gutter) };
}

/** A4（210 × 297 mm）。 */
export const A4: PageSize = Object.freeze({ width: mm(210), height: mm(297) });

/** 确定性的 id 分配器（本包的操作只要求"新节点拿到一个 id"，不校验唯一性）。 */
export function sequentialIds(prefix = 't'): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `${prefix}${String(counter)}`;
  };
}

// ---------------------------------------------------------------------------
// 节属性构造
// ---------------------------------------------------------------------------

/** 构造一份节属性（未给出的字段一律保持"未指定"）。 */
export function sectionWith(input: {
  readonly size?: PageSize;
  readonly orientation?: 'portrait' | 'landscape';
  readonly margins?: MarginBox;
  readonly columns?: number;
  readonly titlePage?: boolean;
  readonly evenAndOddHeaders?: boolean;
}): SectionProperties {
  const base = defaultSectionProperties();
  return {
    ...base,
    ...(input.size === undefined ? {} : { pageSize: specified(input.size) }),
    ...(input.orientation === undefined ? {} : { orientation: specified(input.orientation) }),
    ...(input.margins === undefined ? {} : { margins: specified(input.margins) }),
    ...(input.columns === undefined ? {} : { columns: specified(input.columns) }),
    ...(input.titlePage === undefined ? {} : { titlePage: input.titlePage ? TOGGLE_ON : TOGGLE_OFF }),
    ...(input.evenAndOddHeaders === undefined
      ? {}
      : { evenAndOddHeaders: input.evenAndOddHeaders ? TOGGLE_ON : TOGGLE_OFF }),
  };
}

// ---------------------------------------------------------------------------
// 多节文档夹具
// ---------------------------------------------------------------------------

/**
 * 造一份**多节**文档：每节 `blocks_per_section` 个段落。
 *
 * 节 i（`i < 节数 − 1`）的最后一个段落带 `{kind:'section_index', index:i}` 标记，
 * 最后一节由正文末尾的节属性承载。于是分节标记按文档顺序编号 `0,1,2,…`，
 * 与 `checkSectionMarkers` 的不变量一致（这正是 `section-breaks.ts` 依赖的模型形态）。
 */
export function buildSectionsFixture(input: {
  readonly document_id?: string;
  readonly sections: readonly SectionProperties[];
  readonly blocks_per_section?: number;
  readonly opaque_parts?: readonly OpaquePart[];
  readonly relationships?: readonly RelationshipRecord[];
  readonly content_types?: ContentTypeTable;
}): DocumentModel {
  const perSection = input.blocks_per_section ?? 2;
  const lastSection = input.sections.length - 1;
  const blocks: DraftBlockNode[] = [];

  input.sections.forEach((_section, sectionIndex) => {
    for (let within = 0; within < perSection; within += 1) {
      const endsSection = within === perSection - 1 && sectionIndex !== lastSection;
      const paragraph = textParagraphNode({
        text: `s${String(sectionIndex)}p${String(within)}`,
        source: 'imported',
      });
      blocks.push(
        endsSection
          ? { ...paragraph, opaque: [{ kind: 'section_index', index: sectionIndex }] }
          : paragraph,
      );
    }
  });

  return createDocumentModel({
    document_id: input.document_id ?? 'doc-test',
    blocks,
    sections: [...input.sections],
    ...(input.opaque_parts === undefined ? {} : { opaque_parts: [...input.opaque_parts] }),
    ...(input.relationships === undefined ? {} : { relationships: [...input.relationships] }),
    ...(input.content_types === undefined ? {} : { content_types: input.content_types }),
  });
}

/** 取第 `index` 节；越界即抛（`noUncheckedIndexedAccess` 下测试里不该到处写断言）。 */
export function sectionAt(model: DocumentModel, index: number): SectionProperties {
  const section = model.sections[index];
  if (section === undefined) {
    throw new Error(`夹具里没有第 ${String(index)} 节（共 ${String(model.sections.length)} 节）`);
  }
  return section;
}

/** 取正文第 `index` 个块；越界即抛。 */
export function blockAt(model: DocumentModel, index: number): DocumentModel['blocks'][number] {
  const block = model.blocks[index];
  if (block === undefined) {
    throw new Error(`夹具里没有第 ${String(index)} 个块（共 ${String(model.blocks.length)} 个）`);
  }
  return block;
}

// ---------------------------------------------------------------------------
// 逐字节对照（R108 的判据工具）
// ---------------------------------------------------------------------------

/**
 * 把一节渲染成 `w:sectPr` 的 **XML 字符串**（用的是生产序列化函数）。
 *
 * 字符串逐字符相等 ⇒ 序列化结果一致。这就是 R108 判据里"逐字节不变"的可执行形式。
 */
export function sectPrXml(section: SectionProperties): string {
  return serializeXmlNode(serializeSectionProperties(section));
}

/** 全部节的 `sectPr` 字符串（按节序）。 */
export function allSectPrXml(model: DocumentModel): readonly string[] {
  return model.sections.map((section) => sectPrXml(section));
}

// ---------------------------------------------------------------------------
// 页眉 / 页脚部件与关系
// ---------------------------------------------------------------------------

/**
 * 一个页眉/页脚部件（**字节为空**）。
 *
 * 内容得由 `docx/**` 生成（R107：本包不拼 XML），这里只提供"部件存在且内容类型正确"
 * 这一前提，好让引用侧的规则可被独立测试。
 */
export function headerPart(path: string, role: HeaderFooterRole = 'header'): OpaquePart {
  const kind = role === 'header' ? 'header' : 'footer';
  return {
    path,
    content_type: `application/vnd.openxmlformats-officedocument.wordprocessingml.${kind}+xml`,
    bytes: new Uint8Array(),
  };
}

/** 一条指向页眉/页脚部件的关系（归属主部件）。 */
export function headerRelationship(
  id: string,
  target: string,
  role: HeaderFooterRole = 'header',
): RelationshipRecord {
  return {
    id,
    type: `http://schemas.openxmlformats.org/officeDocument/2006/relationships/${role}`,
    target,
    target_mode: 'Internal',
    owner_part_path: 'word/document.xml',
  };
}
