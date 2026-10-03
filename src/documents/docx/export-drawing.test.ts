/**
 * WCF-D30：**`DrawingNode` 的导出侧渲染**（design-05-P6 收口）。
 *
 * ## 这份测试回答什么
 *
 * | 判据 | 用例 |
 * |---|---|
 * | 能被渲染的图形**不再**落 `unsupported_drawing` | ① |
 * | 渲染结果真的是 Word 认的形状（`wp:inline` → `wp:extent`(EMU) → `a:blip@r:embed`） | ① |
 * | **无悬空引用**：`r:embed` 在 `.rels` 里、媒体部件在包里、内容类型已声明 | ① |
 * | **R106 新增关系不动老 rId** | ② |
 * | `wp:docPr@id` 不撞既有片段 | ③ |
 * | R105：带未建模片段的图形**原样写回**，不走渲染 | ④ |
 * | 四种"确实不支持 / 不能安全写出"的情形**明确拒绝**（R140/R154） | ⑤–⑧ |
 * | 入口边界（没有包级上下文就不猜着写） | ⑨ |
 * | **模型层仍造不出 `DrawingNode`**（D01 缺陷，本批只能绕过并登记） | ⑩ |
 *
 * ## 语料
 *
 * 用 `tests/word-acceptance/fixtures/corpus-a-independent-deflate.docx`（**独立** Python 构造、
 * 非生产写出器产物）作底座：它带了真实的 `rId10/styles`、`rId11/image`、`rId12/customXml`
 * 三条主部件关系与一个既有媒体部件，正好用来验证"新关系追加、老编号不动"。
 *
 * ## 为什么夹具要手工装配 `DrawingNode`（**这不是图省事**）
 *
 * 用例 ⑩ 证明：`createDocumentModel()` 目前**抛错**——`inlineKindOf()` 只允许
 * `run/break/field`，而同一个文件的 `materializeInline()` 却实现了 `'drawing'` 分支
 * （错误信息里也写着 "run/break/field/drawing"）。函数间自相矛盾（D01 的 `model/nodes.ts`）。
 * 因此本文件按**导出器能拿到的形状**装配节点：`DrawingNode` 在 `InlineNode` 联合里是合法的，
 * 导出器必须能处理它；模型工厂能不能造出来是另一个（已登记的）缺陷。
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readZip } from '../../artifacts/ooxml/zip-read.js';
import { createDocumentModel } from '../model/document.js';
import { drawingNode, paragraphNode, runNode } from '../model/nodes.js';
import type {
  DocumentModel,
  DrawingNode,
  InlineNode,
  ParagraphNode,
  RunNode,
} from '../model/types.js';
import { fakeImageBytes } from '../operations/drawing/fixtures.js';
import { registerImageMedia } from '../operations/drawing/media.js';
import { DocxError } from './docx-error.js';
import { drawingContext, isRenderableDrawing, renderDrawingNode } from './drawing-render.js';
import { exportDocx, serializeDocumentPart } from './export.js';
import { importDocx } from './import.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const CORPUS_A = join(
  REPO_ROOT,
  'tests',
  'word-acceptance',
  'fixtures',
  'corpus-a-independent-deflate.docx',
);

const MAIN_PART = 'word/document.xml';
const RELS_PART = 'word/_rels/document.xml.rels';

/** 一份真实（独立构造）包的模型。 */
function corpusModel(): DocumentModel {
  return importDocx(new Uint8Array(readFileSync(CORPUS_A)));
}

/** 导出 → 按路径取部件文本；读回用的是**独立**的 ZIP 读取器（不 import 生产写出器）。 */
function exportedParts(model: DocumentModel): {
  readonly text: (path: string) => string | null;
  readonly paths: readonly string[];
} {
  const archive = readZip(exportDocx(model));
  return {
    text: (path) => {
      const entry = archive.by_path.get(path);
      return entry === undefined ? null : new TextDecoder().decode(entry.data);
    },
    paths: archive.entries.map((entry) => entry.path),
  };
}

let drawingCounter = 0;

/** 造一个**成型**的 `DrawingNode`（补上 id / opaque；见文件头的说明）。 */
function drawingInstance(input: Parameters<typeof drawingNode>[0]): DrawingNode {
  drawingCounter += 1;
  const draft = drawingNode(input);
  return {
    ...draft,
    id: `test-drawing-${String(drawingCounter)}`,
    opaque: draft.opaque ?? [],
  } as DrawingNode;
}

/** 造一个**成型**的 `RunNode`（经模型工厂物化，保证属性/opaque 形状正确）。 */
function runInstance(input: {
  readonly text: string;
  readonly opaque?: readonly unknown[];
}): RunNode {
  const materialized = createDocumentModel({
    document_id: 'export-drawing-run',
    blocks: [
      paragraphNode({
        source: 'user_request',
        inlines: [runNode({ text: input.text, source: 'imported', ...(input.opaque === undefined ? {} : { opaque: input.opaque }) })],
      }),
    ],
  });
  const paragraph = materialized.blocks[0];
  const inline = paragraph !== undefined && paragraph.kind === 'paragraph' ? paragraph.inlines[0] : undefined;
  if (inline === undefined || inline.kind !== 'run') {
    throw new Error('夹具错误：没能物化出 run');
  }
  return inline;
}

/** 造"装着给定行内节点的那一段"（块数组）。 */
function paragraphBlocks(inlines: readonly InlineNode[]): DocumentModel['blocks'] {
  const materialized = createDocumentModel({
    document_id: 'export-drawing-test',
    blocks: [paragraphNode({ source: 'user_request', inlines: [] })],
  });
  const paragraph = materialized.blocks[0];
  if (paragraph === undefined || paragraph.kind !== 'paragraph') {
    throw new Error('夹具错误：第一块不是段落');
  }
  const rebuilt: ParagraphNode = { ...paragraph, inlines };
  return [rebuilt];
}

/** 保留语料的包级事实，只把正文换成"一个装着给定行内节点的段落"。 */
function modelWithInlines(packageBase: DocumentModel, inlines: readonly InlineNode[]): DocumentModel {
  return { ...packageBase, blocks: paragraphBlocks(inlines), sections: [] };
}

/** 注册一张图片并返回"正文里放一个引用它的 DrawingNode"的模型。 */
function modelWithInsertedPicture(options?: { readonly existing_doc_pr_id?: number }): {
  readonly model: DocumentModel;
  readonly relationship_id: string;
  readonly part_path: string;
} {
  const base = corpusModel();
  const registered = registerImageMedia(base, {
    bytes: fakeImageBytes(),
    content_type: 'image/png',
  });
  const drawing = drawingInstance({
    drawing_type: 'picture',
    source: 'user_request',
    relationship_id: registered.relationship_id,
    extent: { width: { unit: 'pt', value: 100 }, height: { unit: 'pt', value: 50 } },
    alt_text: '一张测试图',
  });
  const existing = options?.existing_doc_pr_id;
  const inlines: InlineNode[] =
    existing === undefined
      ? [drawing]
      : [
          runInstance({
            text: '',
            opaque: [
              {
                kind: 'raw_at_char',
                offset: 0,
                xml:
                  '<w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">' +
                  `<wp:docPr id="${String(existing)}" name="既有图"/>` +
                  '</wp:inline></w:drawing>',
              },
            ],
          }),
          drawing,
        ];
  return {
    model: modelWithInlines(registered.model, inlines),
    relationship_id: registered.relationship_id,
    part_path: registered.part_path,
  };
}

describe('DrawingNode 渲染（WF-065）', () => {
  it('① picture → wp:inline + wp:extent(EMU) + a:blip@r:embed；无悬空引用、内容类型已声明', () => {
    const fixture = modelWithInsertedPicture();
    const parts = exportedParts(fixture.model);
    const main = parts.text(MAIN_PART);
    expect(main).not.toBeNull();

    // 形状：默认（wrap 未设）是 inline，尺寸走 EMU（100pt = 1 270 000 EMU，50pt = 635 000）。
    expect(main).toContain('<w:drawing');
    expect(main).toContain('<wp:inline');
    expect(main).toContain('<wp:extent cx="1270000" cy="635000"/>');
    expect(main).toContain('uri="http://schemas.openxmlformats.org/drawingml/2006/picture"');
    expect(main).toContain('<pic:pic');
    expect(main).toContain(`<a:blip r:embed="${fixture.relationship_id}"`);
    expect(main).toContain('descr="一张测试图"');

    // 无悬空引用：r:embed 的 id 必须在主部件关系表里，且目标部件在包里。
    const rels = parts.text(RELS_PART);
    expect(rels).not.toBeNull();
    expect(rels).toContain(`Id="${fixture.relationship_id}"`);
    expect(rels).toContain('Target="media/image2.png"');
    expect(parts.paths).toContain('word/media/image2.png');

    // 内容类型已声明（.png 的 Default 来自导入，导出器把它写进了包）。
    expect(parts.text('[Content_Types].xml')).toContain('Extension="png"');
  });

  it('② R106：插一张图之后，既有 rId 的**编号与相对顺序**逐条不变，新关系只追加在末尾', () => {
    const beforeRels = exportedParts(corpusModel()).text(RELS_PART) ?? '';
    const beforeIds = [...beforeRels.matchAll(/Id="([^"]+)"/g)].map((match) => match[1]);
    expect(beforeIds).toEqual(['rId10', 'rId11', 'rId12']);

    const fixture = modelWithInsertedPicture();
    const afterRels = exportedParts(fixture.model).text(RELS_PART) ?? '';
    const afterIds = [...afterRels.matchAll(/Id="([^"]+)"/g)].map((match) => match[1]);
    // 前缀逐条相同（编号与顺序都没动），新关系落在**最后**。
    expect(afterIds.slice(0, beforeIds.length)).toEqual(beforeIds);
    expect(afterIds).toEqual(['rId10', 'rId11', 'rId12', 'rId13']);
  });

  it('③ wp:docPr@id 不与既有未建模片段里的图形撞号', () => {
    const fixture = modelWithInsertedPicture({ existing_doc_pr_id: 7 });
    const main = exportedParts(fixture.model).text(MAIN_PART) ?? '';
    // 既有片段的 id=7 必须原样保留，新图形取 8。
    expect(main).toContain('<wp:docPr id="7" name="既有图"/>');
    expect(main).toContain('<wp:docPr id="8"');
  });

  it('④ R105：带未建模片段的 DrawingNode 原样写回，**不**走渲染', () => {
    const base = corpusModel();
    const drawing = drawingInstance({
      drawing_type: 'chart',
      source: 'imported',
      opaque: [
        {
          kind: 'raw_at_char',
          offset: 0,
          xml: '<w:drawing><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram" r:dm="rId11"/></w:drawing>',
        },
      ],
    });
    const main = exportedParts(modelWithInlines(base, [drawing])).text(MAIN_PART) ?? '';
    expect(main).toContain(
      '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram" r:dm="rId11"/>',
    );
    // 没有被渲染成 wp:inline（保留优先于重建）。
    expect(main).not.toContain('<wp:inline');
  });

  /**
   * ⑤–⑧ 四种**确实不支持 / 不能安全写出**的情形。
   *
   * 每条都断言两件事：(a) 拒绝原因是**具体的那一个**（不是笼统的失败）；
   * (b) 抛出即"什么都没产出"——调用方拿不到半成品字节。
   */
  describe('确实不支持的情形必须显式拒绝（R140/R154）', () => {
    function expectRejection(model: DocumentModel, reason: string): void {
      let thrown: unknown = null;
      try {
        exportDocx(model);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, '应当拒绝而不是写出半成品').toBeInstanceOf(DocxError);
      expect((thrown as DocxError).reason).toBe(reason);
    }

    const SIZE = { width: { unit: 'pt', value: 100 }, height: { unit: 'pt', value: 50 } } as const;

    it('⑤ 形状 / 文本框 / 图表（模型没有形状预设这类字段）⇒ unsupported_drawing', () => {
      const base = corpusModel();
      const drawing = drawingInstance({
        drawing_type: 'textbox',
        source: 'user_request',
        relationship_id: 'rId11',
        extent: SIZE,
      });
      expectRejection(modelWithInlines(base, [drawing]), 'unsupported_drawing');
    });

    it('⑥ picture 没有 relationship_id ⇒ unsupported_drawing', () => {
      const base = corpusModel();
      const valid = drawingInstance({
        drawing_type: 'picture',
        source: 'user_request',
        relationship_id: 'rId11',
        extent: SIZE,
      });
      // 工厂不允许造出 picture + null rId（那本来就是坏节点），因此这里显式构造坏节点。
      const broken: DrawingNode = { ...valid, relationship_id: null };
      expectRejection(modelWithInlines(base, [broken]), 'unsupported_drawing');
    });

    it('⑦ relationship_id 悬空（关系表里没有）⇒ dangling_relationship_id', () => {
      const base = corpusModel();
      const drawing = drawingInstance({
        drawing_type: 'picture',
        source: 'user_request',
        relationship_id: 'rId99',
        extent: SIZE,
      });
      expectRejection(modelWithInlines(base, [drawing]), 'dangling_relationship_id');
    });

    it('⑧ picture 没有 extent（导出器不猜尺寸）⇒ unsupported_drawing', () => {
      const base = corpusModel();
      const drawing = drawingInstance({
        drawing_type: 'picture',
        source: 'user_request',
        relationship_id: 'rId11',
      });
      expectRejection(modelWithInlines(base, [drawing]), 'unsupported_drawing');
    });
  });

  it('⑨ 入口边界：直接用 serializeDocumentPart（没有包级上下文）时，图形被拒绝而不是猜着写', () => {
    const fixture = modelWithInsertedPicture();
    expect(() =>
      serializeDocumentPart(
        { blocks: fixture.model.blocks, sections: fixture.model.sections },
        new Uint8Array(0),
      ),
    ).toThrowError(/包级上下文/);
  });

  /**
   * ⑩ **D01 缺陷的实证**：模型工厂当前造不出 `DrawingNode`。
   *
   * `model/nodes.ts` 的 `materializeInline()` 实现了 `'drawing'` 分支、错误文本也写着
   * "run/break/field/drawing"，但 `inlineKindOf()`（物化段落时用它构造节点路径）只放行
   * `run/break/field` ⇒ 只要段落里有 `DrawingNode` 就抛 `invalid_node`。
   *
   * 这不是本批能修的（`src/documents/model/**` 不在本任务写权内），但必须**留证**：
   * 它意味着即便导出器已经能渲染，`DrawingNode` 这条路在端到端上仍然走不通——
   * 需要一行修复（`inlineKindOf` 放行 `'drawing'`）。
   */
  /**
   * ⑫ `isRenderableDrawing()` 必须与 `renderDrawingNode()` 的接受/拒绝**判断一致**。
   *
   * 这条不变量的价值：调用方常要"先问能不能，再决定说不说"。如果预判说"能"而渲染时抛，
   * 就变成"看起来支持"——那正是本项目最忌讳的一类谎。
   */
  it('⑫ isRenderableDrawing 与 renderDrawingNode 的判断一致（不出现"说能却抛"）', () => {
    const SIZE = { width: { unit: 'pt', value: 100 }, height: { unit: 'pt', value: 50 } } as const;
    const base = corpusModel();
    const registered = registerImageMedia(base, {
      bytes: fakeImageBytes(),
      content_type: 'image/png',
    });
    const context = drawingContext(
      MAIN_PART,
      registered.model.relationships,
      new Set<string>([
        ...registered.model.opaque_parts.map((part) => part.path),
        ...registered.model.media.map((part) => part.path),
      ]),
      registered.model.media,
    );
    let id = 100;

    const cases: readonly { readonly name: string; readonly drawing: DrawingNode }[] = [
      {
        name: '可渲染的图片',
        drawing: drawingInstance({
          drawing_type: 'picture',
          source: 'user_request',
          relationship_id: registered.relationship_id,
          extent: SIZE,
        }),
      },
      {
        name: '悬空关系',
        drawing: drawingInstance({
          drawing_type: 'picture',
          source: 'user_request',
          relationship_id: 'rId99',
          extent: SIZE,
        }),
      },
      {
        name: '没有 extent',
        drawing: drawingInstance({
          drawing_type: 'picture',
          source: 'user_request',
          relationship_id: registered.relationship_id,
        }),
      },
      {
        name: '形状（无预设字段）',
        drawing: drawingInstance({
          drawing_type: 'shape',
          source: 'user_request',
          relationship_id: registered.relationship_id,
          extent: SIZE,
        }),
      },
    ];

    for (const item of cases) {
      const predicted = isRenderableDrawing(item.drawing, context);
      let rendered = true;
      try {
        renderDrawingNode(item.drawing, context, () => {
          id += 1;
          return id;
        });
      } catch {
        rendered = false;
      }
      expect(predicted, `${item.name}：预判与渲染结果必须一致`).toBe(rendered);
    }
  });

  it('⑩ 模型工厂**可以**物化 DrawingNode（D01 缺陷已修复——由协调者补 `inlineKindOf` 的 drawing 分支）', () => {
    const drawing = drawingInstance({
      drawing_type: 'picture',
      source: 'user_request',
      relationship_id: 'rId11',
      extent: { width: { unit: 'pt', value: 100 }, height: { unit: 'pt', value: 50 } },
    });
    const model = createDocumentModel({
      document_id: 'd01-drawing-ok',
      blocks: [paragraphNode({ source: 'user_request', inlines: [drawing] })],
    });

    const block = model.blocks[0];
    if (block === undefined || block.kind !== 'paragraph') throw new Error('夹具：第一块不是段落');
    const inline = block.inlines[0];
    if (inline === undefined || inline.kind !== 'drawing') throw new Error('夹具：首个行内节点不是图形');
    // 关键：**建模 → 物化**这条路现在通了（此前 `inlineKindOf` 会在 `kind === 'drawing'` 时抛错）。
    expect(inline.drawing_type).toBe('picture');
    expect(inline.relationship_id).toBe('rId11');
  });
});
