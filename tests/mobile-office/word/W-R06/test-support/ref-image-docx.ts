/**
 * **W-R06 集成支撑**——在「引用 / 批注 / 公式 / 图片四类齐备」的组合包
 * （`combined-docx.ts`）**之上**再叠两件事所需的夹具与助手：
 *
 * 1. {@link buildReferenceIndex}：对**编辑后**的模型给出引用侧表输入
 *    （书签 / 外部超链接 / 内部超链接 / 脚注）。锚点只落在**单一纯文本段**
 *    （编辑目标段），避免与既有未建模元素的字节发生无谓纠缠——本片判据是
 *    "新关系只追加、既有不动"，锚点越干净，波及面越好定位。
 * 2. {@link insertExtraImage}：走产品入口 `insertImageDrawing`（WF-065 的**类型化**
 *    表示法），在组合包里**真插**第二张图片——媒体部件 / 主部件关系 / 内容类型声明三件齐。
 *
 * ## 为什么另起一个文件
 *
 * `combined-docx.ts` 是**四类齐备包**的夹具构造器（W-R06 的第一片）。本文件只做
 * "在它之上叠加"，**不改动它一个字节**——那正是"改一处、其余不变"这条判据得以成立的前提。
 *
 * ## 如实登记的分界
 *
 * - 这里**不跑**真实 Word/WPS 消费端打开；`consumer-reopen` 层未验证。
 * - 图片字节只是 "PNG 签名 + 少量字节" 的**占位**：往返判据比的是字节，不是它能不能解码。
 */

import { importDocx } from '../../../../../src/documents/docx/import.js';
import { insertImageDrawing } from '../../../../../src/documents/operations/drawing/image.js';
import type { DocumentModel, ParagraphNode } from '../../../../../src/documents/model/types.js';
import {
  addBookmark,
  addNote,
  emptyReferenceIndex,
  createHyperlink,
  type ReferenceIndex,
} from '../../../../../src/documents/references/index.js';
import {
  collectParagraphs,
  paragraphText,
} from '../../../../../src/documents/selection/structure.js';
import type { Result } from '../../../../../src/documents/selection/types.js';
import { TARGET_PARAGRAPH_TEXT, combinedDocx } from './combined-docx.js';

/** 编辑目标段落的**新文字**（测试里的 `replace` 必须逐字等于它）。 */
export const NEW_TARGET_TEXT = '正文段落甲，已被定点改写。';
/** 新增书签名——内部超链接的锚点。 */
export const BOOKMARK_NAME = '集成书签';

/** 第二张图片的字节：PNG 签名 + 与夹具不同的体（只关心字节，不关心是否为合法位图）。 */
export const EXTRA_IMAGE_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x02,
  0x00, 0x00, 0x00, 0x02, 0x08, 0x06, 0x00, 0x00, 0x00, 0x72, 0xb6, 0x0d, 0x24,
]);

/** 组合包的模型（经**真实导入路径**）。每个用例各自调用，互不共享可变状态。 */
export function combinedModel(): DocumentModel {
  return importDocx(combinedDocx());
}

/** 按段落**完整文字**逐字匹配取段落；找不到即具名抛错（不猜"最像的"）。 */
export function paragraphWithText(model: DocumentModel, text: string): ParagraphNode {
  const found = collectParagraphs(model.blocks).find(
    (paragraph) => paragraphText(paragraph) === text,
  );
  if (found === undefined) {
    throw new Error(`夹具错误：组合包里没有文字恰为「${text}」的段落。`);
  }
  return found;
}

/** 取 `Result` 成功分支的 `value`（失败即抛，避免测试里到处 `!`）。 */
function value<T>(result: Result<T>, what: string): T {
  if (!result.ok) {
    throw new Error(`${what} 失败：${result.code} ${result.message}`);
  }
  return result.value;
}

/**
 * 对**编辑后**的模型构造引用侧表：
 *
 * | 项 | 锚点 | 期望的导出落点 |
 * |---|---|---|
 * | 书签 `BOOKMARK_NAME` | 目标段 [0,4) | `w:bookmarkStart/End`，**不新增关系** |
 * | 外部超链接 | 目标段 [0,2) | `w:hyperlink r:id` + **新增一条 External 关系** |
 * | 内部超链接 | 目标段 [4,6) | `w:hyperlink w:anchor`，**不新增关系** |
 * | 脚注 | 目标段末（零宽） | `w:footnoteReference` + 合并进既有 `footnotes.xml` |
 *
 * 全部锚点都落在**同一个纯文本段**上（目标段），因此只有这一段会被重建；
 * 段里没有未建模片段，`w:id` 分配只与"既有 bookmarkStart 的编号"有关。
 */
export function buildReferenceIndex(model: DocumentModel): ReferenceIndex {
  const target = paragraphWithText(model, NEW_TARGET_TEXT);
  const length = Array.from(NEW_TARGET_TEXT).length;

  let index = emptyReferenceIndex();
  index = value(
    addBookmark(index, {
      id: 'bm-r06',
      name: BOOKMARK_NAME,
      range: { node_id: target.id, start: 0, end: 4 },
    }),
    'addBookmark',
  );
  index = value(
    createHyperlink(index, {
      id: 'h-ext-r06',
      range: { node_id: target.id, start: 0, end: 2 },
      target: { kind: 'external', url: 'https://example.org/w-r06-ref', relationship_id: null },
      text: '正文',
    }),
    'createHyperlink(external)',
  );
  index = value(
    createHyperlink(index, {
      id: 'h-int-r06',
      range: { node_id: target.id, start: 4, end: 6 },
      target: { kind: 'internal', bookmark: BOOKMARK_NAME },
      text: '段落',
    }),
    'createHyperlink(internal)',
  );
  const notes = value(
    addNote([], {
      id: 'fn-r06',
      kind: 'footnote',
      marker: { node_id: target.id, start: length, end: length },
      text: '集成脚注正文。',
    }),
    'addNote',
  );

  return { ...index, notes };
}

/** 插入第二张图片的结果。 */
export interface ExtraImageResult {
  readonly model: DocumentModel;
  /** 主部件关系表里指向新图片的 id（须与正文 `r:embed` 逐字相同）。 */
  readonly relationship_id: string;
  /** 新媒体部件路径。 */
  readonly part_path: string;
}

/**
 * 在组合包里**真插入**第二张图片（WF-065 类型化表示法）。
 *
 * @param options.part_name 显式部件路径。省略 ⇒ 自动取号 `word/media/image2.png`；
 *   给**无扩展名**的路径时，`[Content_Types].xml` 无法用 `Default` 表达，只能落显式 `Override`。
 * @param options.content_type 图片内容类型（默认 `image/png`）。
 */
export function insertExtraImage(
  model: DocumentModel,
  options: {
    readonly paragraph_text?: string;
    readonly part_name?: string;
    readonly content_type?: string;
  } = {},
): ExtraImageResult {
  const paragraph = paragraphWithText(model, options.paragraph_text ?? TARGET_PARAGRAPH_TEXT);
  const outcome = insertImageDrawing(model, {
    paragraph_id: paragraph.id,
    bytes: EXTRA_IMAGE_PNG,
    content_type: options.content_type ?? 'image/png',
    ...(options.part_name === undefined ? {} : { part_name: options.part_name }),
    width: { unit: 'pt', value: 72 },
    height: { unit: 'pt', value: 72 },
    alt_text: '第二张图片',
  });
  if (!outcome.ok) {
    throw new Error(`insertImageDrawing 失败：${outcome.code} ${outcome.detail}`);
  }
  return {
    model: outcome.model,
    relationship_id: outcome.relationship_id,
    part_path: outcome.part_path,
  };
}
