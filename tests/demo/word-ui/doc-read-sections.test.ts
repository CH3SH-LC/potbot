/**
 * WCF-D72：`doc-read.js` 的**节枚举**判据。
 *
 * 判据只有一条，但它是硬判据：页面枚举出来的节，必须与**内核真实导入器**
 * （`src/documents/docx/import.ts` 的 `importDocx`）在**同一份字节**上得到的
 * `model.sections` **同数量、同顺序**。否则页面上的「第 2 节」会指到服务端的另一节——
 * 那正是 R108 要挡的"改错节"。
 *
 * 因此这里不是断言"看起来对"，而是拿真实导入器当参照物逐节比对：
 * 每一节的纸张宽高 / 方向 / 页边距 / 页码格式，页面读到的都要与模型里的一致。
 */

import { describe, expect, it } from 'vitest';

import { importDocx } from '../../../src/documents/docx/import.js';
import { pageNumberFormatOf, pageNumberStartOf } from '../../../src/documents/sections/page-numbering.js';
import { marginsOf, orientationOf, pageSizeOf } from '../../../src/documents/sections/values.js';
import { lengthToTwips } from '../../../src/documents/units/index.js';
import {
  SECTPR_LANDSCAPE,
  SECTPR_PORTRAIT_PLAIN,
  SECTPR_PORTRAIT_ROMAN,
  buildDocx,
  buildDocxPackage,
  multiSectionBlocks,
  sampleBlocks,
  type FixtureBlock,
} from './docx-fixtures.js';
import { loadWebGlobal } from './harness.js';

interface SectionView {
  readonly index: number;
  readonly number: number;
  readonly pageSize: {
    readonly widthTwips: number | null;
    readonly heightTwips: number | null;
    readonly orientation: string | null;
    readonly orientationSource: string | null;
  } | null;
  readonly margins: Record<string, number | null> | null;
  readonly pageNumbering: { readonly format: string | null; readonly start: number | null } | null;
}

interface Preview {
  readonly paragraphCount: number;
  readonly sections: readonly SectionView[];
  readonly sectionCount: number;
}

interface DocReadModule {
  readDocxStructure(bytes: Uint8Array): Promise<
    { ok: true; preview: Preview } | { ok: false; code: string; message: string }
  >;
  describeSection(section: SectionView): string;
}

const DocRead = loadWebGlobal<DocReadModule>('doc-read.js', 'PotbotDocRead', {
  TextDecoder,
  DecompressionStream: (globalThis as { DecompressionStream?: unknown }).DecompressionStream,
  btoa,
  atob,
});

async function previewOf(blocks: readonly FixtureBlock[], options: { readonly deflate?: boolean; readonly bodySectPrXml?: string } = {}): Promise<Preview> {
  const result = await DocRead.readDocxStructure(buildDocx(blocks, options));
  if (!result.ok) throw new Error('夹具自检失败：' + result.code + ' / ' + result.message);
  return result.preview;
}

const MULTI_OPTIONS = { bodySectPrXml: SECTPR_PORTRAIT_PLAIN };

describe('WCF-D72 doc-read：节枚举与内核导入器同序', () => {
  it('单节文档（body 级空 sectPr）⇒ 恰好 1 节，且页面不替文档补页面设置', async () => {
    const preview = await previewOf(sampleBlocks());
    expect(preview.sectionCount).toBe(1);
    const section = preview.sections[0] as SectionView;
    expect(section.index).toBe(0);
    expect(section.number).toBe(1);
    /* `<w:sectPr/>` 是空的：未指定就是未指定（R118），不猜一个 A4。 */
    expect(section.pageSize).toBeNull();
    expect(section.margins).toBeNull();
    expect(section.pageNumbering).toBeNull();
  });

  it('三节文档：节的**数量与顺序**与真实 `importDocx` 完全一致', async () => {
    const bytes = buildDocxPackage(multiSectionBlocks(), MULTI_OPTIONS);
    const preview = await DocRead.readDocxStructure(bytes);
    expect(preview.ok).toBe(true);
    if (preview.ok !== true) return;

    /* 参照物：内核真实导入器。 */
    const model = importDocx(bytes);
    expect(preview.preview.sectionCount).toBe(model.sections.length);
    expect(preview.preview.sectionCount).toBe(3);
    expect(preview.preview.sections.map((section) => section.index)).toEqual([0, 1, 2]);
    expect(preview.preview.sections.map((section) => section.number)).toEqual([1, 2, 3]);
  });

  it('每一节的页面设置：页面读到的与模型里的逐节一致', async () => {
    const bytes = buildDocxPackage(multiSectionBlocks(), MULTI_OPTIONS);
    const result = await DocRead.readDocxStructure(bytes);
    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    const model = importDocx(bytes);

    for (const [index, section] of result.preview.sections.entries()) {
      const kernel = model.sections[index];
      expect(kernel, `模型缺少第 ${String(index + 1)} 节`).toBeDefined();
      if (kernel === undefined) continue;

      /* 纸张宽高（缇）——用**内核自己的读取器**取值，不在这里重解释 ValuedState。 */
      const size = pageSizeOf(kernel);
      if (size === null) {
        expect(section.pageSize).toBeNull();
      } else {
        expect(section.pageSize).not.toBeNull();
        expect(section.pageSize?.widthTwips).toBe(lengthToTwips(size.width));
        expect(section.pageSize?.heightTwips).toBe(lengthToTwips(size.height));
        const declared = orientationOf(kernel);
        if (declared !== null) {
          expect(section.pageSize?.orientation).toBe(declared);
        } else {
          /* 模型没声明方向：页面**由宽高推断**并如实标 `inferred`。 */
          expect(section.pageSize?.orientationSource).toBe('inferred');
          const width = section.pageSize?.widthTwips ?? 0;
          const height = section.pageSize?.heightTwips ?? 0;
          expect(section.pageSize?.orientation).toBe(width > height ? 'landscape' : 'portrait');
        }
      }

      /* 页边距（缇，四边 + 装订线） */
      const kernelMargins = marginsOf(kernel);
      if (kernelMargins === null) {
        expect(section.margins).toBeNull();
      } else {
        expect(section.margins).not.toBeNull();
        expect(section.margins?.['top']).toBe(lengthToTwips(kernelMargins.top));
        expect(section.margins?.['right']).toBe(lengthToTwips(kernelMargins.right));
        expect(section.margins?.['bottom']).toBe(lengthToTwips(kernelMargins.bottom));
        expect(section.margins?.['left']).toBe(lengthToTwips(kernelMargins.left));
        expect(section.margins?.['gutter']).toBe(lengthToTwips(kernelMargins.gutter));
      }

      /* 页码格式与起始页 */
      const format = pageNumberFormatOf(kernel);
      if (format === null) {
        expect(section.pageNumbering).toBeNull();
      } else {
        expect(section.pageNumbering?.format).toBe(format);
        expect(section.pageNumbering?.start).toBe(pageNumberStartOf(kernel));
      }
    }
  });

  it('夹具确实造出了"三节各不相同"的输入（否则上面的比对是空转）', async () => {
    const preview = await previewOf(multiSectionBlocks(), MULTI_OPTIONS);
    const [first, second, third] = preview.sections as [SectionView, SectionView, SectionView];
    /* 第 1 节：横向由文档**声明**（有 w:orient） */
    expect(first.pageSize?.orientation).toBe('landscape');
    expect(first.pageSize?.orientationSource).toBe('attr');
    expect(first.margins?.['top']).toBe(1134);
    expect(first.pageNumbering).toBeNull();
    /* 第 2 节：纵向靠推断 + 罗马页码从 1 起 */
    expect(second.pageSize?.orientation).toBe('portrait');
    expect(second.pageSize?.orientationSource).toBe('inferred');
    expect(second.pageNumbering).toEqual({ format: 'upperRoman', start: 1 });
    /* 第 3 节：只声明了纸张，别的都没有 */
    expect(third.pageSize?.orientation).toBe('portrait');
    expect(third.margins).toBeNull();
    expect(third.pageNumbering).toBeNull();
    /* 三节的摘要都可读（显示层） */
    for (const section of preview.sections) {
      expect(DocRead.describeSection(section).length).toBeGreaterThan(0);
    }
  });

  it('DEFLATE 存储的同一份文档读出同样的节（真实 Word 走 DEFLATE）', async () => {
    const stored = await previewOf(multiSectionBlocks(), MULTI_OPTIONS);
    const deflated = await previewOf(multiSectionBlocks(), { ...MULTI_OPTIONS, deflate: true });
    expect(deflated.sections).toEqual(stored.sections);
  });

  it('段级 sectPr 只影响**它所在的那一节**，不把后面的段落也算进去', async () => {
    /* 反例判别力：把段级 sectPr 从第 1 段挪到第 3 段，节数不变（3），
       但节的**顺序**会变——第 1 节变成"body 级那一个"的位置之前的那一段。 */
    const moved: readonly FixtureBlock[] = [
      { kind: 'paragraph', text: 'A' },
      { kind: 'paragraph', text: 'B', sectPrXml: SECTPR_PORTRAIT_ROMAN },
      { kind: 'paragraph', text: 'C', sectPrXml: SECTPR_LANDSCAPE },
    ];
    const preview = await previewOf(moved, MULTI_OPTIONS);
    expect(preview.sectionCount).toBe(3);
    /* 第 1 节的页面设置现在来自"第 2 段末尾"的那个 sectPr */
    expect(preview.sections[0]?.pageNumbering).toEqual({ format: 'upperRoman', start: 1 });
    expect(preview.sections[1]?.pageSize?.orientation).toBe('landscape');
    expect(preview.sections[2]?.pageSize?.orientation).toBe('portrait');
  });
});
