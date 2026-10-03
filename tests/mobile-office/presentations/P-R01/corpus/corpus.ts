/**
 * P-R01 · **外部语料构建器**：把 `descriptor.ts` 的每条声明落成真实 PPTX 字节。
 *
 * 四条语料覆盖 PPT.md 点名的三块（多母版 / 动画 / 备注）+ 一条单母版对照件。
 * 生成的字节可直接喂给 `importPresentation` / `readPresentationStructure`，也可由独立探针
 * (`probe.ts`) 检查——两条路互不依赖，才能构成"假设 vs 实测"的对照。
 */

import { assembleCorpus, notesMasterXml, notesSlideXml, presentationXml, rels, slideLayoutXml, slideMasterXml, slideXml, textShapeXml, themeXml, timingXml, type CorpusParts } from './ooxml-parts.js';
import { CORPUS_MANIFEST } from './descriptor.js';

const REL_SLIDE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';
const REL_SLIDE_LAYOUT =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout';
const REL_SLIDE_MASTER =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster';
const REL_THEME = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme';
const REL_NOTES_SLIDE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide';
const REL_NOTES_MASTER =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster';
const REL_OFFICE_DOCUMENT =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';

const CT_SLIDE_MASTER =
  'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml';
const CT_SLIDE_LAYOUT =
  'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml';
const CT_SLIDE = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';
const CT_NOTES_SLIDE =
  'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml';
const CT_NOTES_MASTER =
  'application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml';
const CT_THEME = 'application/vnd.openxmlformats-officedocument.theme+xml';
const CT_PRESENTATION =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml';

function titleShape(text: string) {
  return textShapeXml(2, 'Title 1', text, { x: 838200, y: 457200, cx: 10515600, cy: 1325563 });
}

const LAYOUT_REFS = { slideMaster1: '../slideMasters/slideMaster1.xml', slideMaster2: '../slideMasters/slideMaster2.xml' } as const;

function masterRels(masterPath: 'slideMaster1' | 'slideMaster2', layoutTarget: string, themeTarget: string) {
  return rels(`ppt/slideMasters/${masterPath}.xml`, [
    { type: REL_SLIDE_LAYOUT, target: layoutTarget },
    { type: REL_THEME, target: themeTarget },
  ]);
}

/** 单母版对照件：1 母版 / 1 主题 / 1 版式 / 2 页，无动画无备注。 */
function buildBaselineSingleMaster(): CorpusParts {
  return {
    parts: [
      { path: 'ppt/presentation.xml', content_type: CT_PRESENTATION, data: presentationXml({ masterRelIds: ['rId1'], slideRelIds: ['rId2', 'rId3'] }) },
      { path: 'ppt/slideMasters/slideMaster1.xml', content_type: CT_SLIDE_MASTER, data: slideMasterXml(['rId1']) },
      { path: 'ppt/slideLayouts/slideLayout1.xml', content_type: CT_SLIDE_LAYOUT, data: slideLayoutXml('Title Only') },
      { path: 'ppt/slides/slide1.xml', content_type: CT_SLIDE, data: slideXml({ shapes: [titleShape('单母版 · 第一页')] }) },
      { path: 'ppt/slides/slide2.xml', content_type: CT_SLIDE, data: slideXml({ shapes: [titleShape('单母版 · 第二页')] }) },
      { path: 'ppt/theme/theme1.xml', content_type: CT_THEME, data: themeXml('4472C4') },
    ],
    relationships: [
      rels(null, [{ type: REL_OFFICE_DOCUMENT, target: 'ppt/presentation.xml' }]),
      rels('ppt/presentation.xml', [
        { type: REL_SLIDE_MASTER, target: 'slideMasters/slideMaster1.xml' },
        { type: REL_SLIDE, target: 'slides/slide1.xml' },
        { type: REL_SLIDE, target: 'slides/slide2.xml' },
      ]),
      masterRels('slideMaster1', '../slideLayouts/slideLayout1.xml', '../theme/theme1.xml'),
      rels('ppt/slideLayouts/slideLayout1.xml', [{ type: REL_SLIDE_MASTER, target: LAYOUT_REFS.slideMaster1 }]),
      rels('ppt/slides/slide1.xml', [{ type: REL_SLIDE_LAYOUT, target: '../slideLayouts/slideLayout1.xml' }]),
      rels('ppt/slides/slide2.xml', [{ type: REL_SLIDE_LAYOUT, target: '../slideLayouts/slideLayout1.xml' }]),
    ],
  };
}

/** 双母版 + 双主题：slide1 用母版1 的版式1，slide2 用母版2 的版式3。 */
function buildMultiMaster(): CorpusParts {
  return {
    parts: [
      { path: 'ppt/presentation.xml', content_type: CT_PRESENTATION, data: presentationXml({ masterRelIds: ['rId1', 'rId2'], slideRelIds: ['rId3', 'rId4'] }) },
      { path: 'ppt/slideMasters/slideMaster1.xml', content_type: CT_SLIDE_MASTER, data: slideMasterXml(['rId1']) },
      { path: 'ppt/slideMasters/slideMaster2.xml', content_type: CT_SLIDE_MASTER, data: slideMasterXml(['rId1']) },
      { path: 'ppt/slideLayouts/slideLayout1.xml', content_type: CT_SLIDE_LAYOUT, data: slideLayoutXml('Master1 Title') },
      { path: 'ppt/slideLayouts/slideLayout3.xml', content_type: CT_SLIDE_LAYOUT, data: slideLayoutXml('Master2 Title') },
      { path: 'ppt/slides/slide1.xml', content_type: CT_SLIDE, data: slideXml({ shapes: [titleShape('母版1 · 第一页')] }) },
      { path: 'ppt/slides/slide2.xml', content_type: CT_SLIDE, data: slideXml({ shapes: [titleShape('母版2 · 第二页')] }) },
      { path: 'ppt/theme/theme1.xml', content_type: CT_THEME, data: themeXml('4472C4') },
      { path: 'ppt/theme/theme2.xml', content_type: CT_THEME, data: themeXml('ED7D31') },
    ],
    relationships: [
      rels(null, [{ type: REL_OFFICE_DOCUMENT, target: 'ppt/presentation.xml' }]),
      rels('ppt/presentation.xml', [
        { type: REL_SLIDE_MASTER, target: 'slideMasters/slideMaster1.xml' },
        { type: REL_SLIDE_MASTER, target: 'slideMasters/slideMaster2.xml' },
        { type: REL_SLIDE, target: 'slides/slide1.xml' },
        { type: REL_SLIDE, target: 'slides/slide2.xml' },
      ]),
      masterRels('slideMaster1', '../slideLayouts/slideLayout1.xml', '../theme/theme1.xml'),
      masterRels('slideMaster2', '../slideLayouts/slideLayout3.xml', '../theme/theme2.xml'),
      rels('ppt/slideLayouts/slideLayout1.xml', [{ type: REL_SLIDE_MASTER, target: LAYOUT_REFS.slideMaster1 }]),
      rels('ppt/slideLayouts/slideLayout3.xml', [{ type: REL_SLIDE_MASTER, target: LAYOUT_REFS.slideMaster2 }]),
      rels('ppt/slides/slide1.xml', [{ type: REL_SLIDE_LAYOUT, target: '../slideLayouts/slideLayout1.xml' }]),
      rels('ppt/slides/slide2.xml', [{ type: REL_SLIDE_LAYOUT, target: '../slideLayouts/slideLayout3.xml' }]),
    ],
  };
}

/** 对象动画：slide1 带 p:transition + p:timing（两个点击组），slide2 干净。 */
function buildObjectAnimation(): CorpusParts {
  return {
    parts: [
      { path: 'ppt/presentation.xml', content_type: CT_PRESENTATION, data: presentationXml({ masterRelIds: ['rId1'], slideRelIds: ['rId2', 'rId3'] }) },
      { path: 'ppt/slideMasters/slideMaster1.xml', content_type: CT_SLIDE_MASTER, data: slideMasterXml(['rId1']) },
      { path: 'ppt/slideLayouts/slideLayout1.xml', content_type: CT_SLIDE_LAYOUT, data: slideLayoutXml('Title Only') },
      {
        path: 'ppt/slides/slide1.xml',
        content_type: CT_SLIDE,
        data: slideXml({
          shapes: [titleShape('动画 · 第一页'), textShapeXml(3, 'Body 1', '按点击出现', { x: 838200, y: 1800000, cx: 10515600, cy: 2000000 })],
          transitionXml: '<p:transition xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" spd="med" dur="700"><p:fade/></p:transition>',
          timingXml: timingXml({ targets: [2, 3] }),
        }),
      },
      { path: 'ppt/slides/slide2.xml', content_type: CT_SLIDE, data: slideXml({ shapes: [titleShape('动画 · 第二页')] }) },
      { path: 'ppt/theme/theme1.xml', content_type: CT_THEME, data: themeXml('4472C4') },
    ],
    relationships: [
      rels(null, [{ type: REL_OFFICE_DOCUMENT, target: 'ppt/presentation.xml' }]),
      rels('ppt/presentation.xml', [
        { type: REL_SLIDE_MASTER, target: 'slideMasters/slideMaster1.xml' },
        { type: REL_SLIDE, target: 'slides/slide1.xml' },
        { type: REL_SLIDE, target: 'slides/slide2.xml' },
      ]),
      masterRels('slideMaster1', '../slideLayouts/slideLayout1.xml', '../theme/theme1.xml'),
      rels('ppt/slideLayouts/slideLayout1.xml', [{ type: REL_SLIDE_MASTER, target: LAYOUT_REFS.slideMaster1 }]),
      rels('ppt/slides/slide1.xml', [{ type: REL_SLIDE_LAYOUT, target: '../slideLayouts/slideLayout1.xml' }]),
      rels('ppt/slides/slide2.xml', [{ type: REL_SLIDE_LAYOUT, target: '../slideLayouts/slideLayout1.xml' }]),
    ],
  };
}

/** 演讲备注：slide1 有 notesSlide1，slide2 无；含 notesMaster。 */
function buildSpeakerNotes(): CorpusParts {
  return {
    parts: [
      { path: 'ppt/presentation.xml', content_type: CT_PRESENTATION, data: presentationXml({ masterRelIds: ['rId1'], notesMasterRelId: 'rId2', slideRelIds: ['rId3', 'rId4'] }) },
      { path: 'ppt/slideMasters/slideMaster1.xml', content_type: CT_SLIDE_MASTER, data: slideMasterXml(['rId1']) },
      { path: 'ppt/slideLayouts/slideLayout1.xml', content_type: CT_SLIDE_LAYOUT, data: slideLayoutXml('Title Only') },
      { path: 'ppt/slides/slide1.xml', content_type: CT_SLIDE, data: slideXml({ shapes: [titleShape('备注 · 第一页')] }) },
      { path: 'ppt/slides/slide2.xml', content_type: CT_SLIDE, data: slideXml({ shapes: [titleShape('备注 · 第二页')] }) },
      { path: 'ppt/notesMasters/notesMaster1.xml', content_type: CT_NOTES_MASTER, data: notesMasterXml() },
      { path: 'ppt/notesSlides/notesSlide1.xml', content_type: CT_NOTES_SLIDE, data: notesSlideXml('这是演讲者备注：讲解要点一二三。') },
      { path: 'ppt/theme/theme1.xml', content_type: CT_THEME, data: themeXml('4472C4') },
    ],
    relationships: [
      rels(null, [{ type: REL_OFFICE_DOCUMENT, target: 'ppt/presentation.xml' }]),
      rels('ppt/presentation.xml', [
        { type: REL_SLIDE_MASTER, target: 'slideMasters/slideMaster1.xml' },
        { type: REL_NOTES_MASTER, target: 'notesMasters/notesMaster1.xml' },
        { type: REL_SLIDE, target: 'slides/slide1.xml' },
        { type: REL_SLIDE, target: 'slides/slide2.xml' },
      ]),
      masterRels('slideMaster1', '../slideLayouts/slideLayout1.xml', '../theme/theme1.xml'),
      rels('ppt/slideLayouts/slideLayout1.xml', [{ type: REL_SLIDE_MASTER, target: LAYOUT_REFS.slideMaster1 }]),
      rels('ppt/slides/slide1.xml', [
        { type: REL_SLIDE_LAYOUT, target: '../slideLayouts/slideLayout1.xml' },
        { type: REL_NOTES_SLIDE, target: '../notesSlides/notesSlide1.xml' },
      ]),
      rels('ppt/slides/slide2.xml', [{ type: REL_SLIDE_LAYOUT, target: '../slideLayouts/slideLayout1.xml' }]),
      rels('ppt/notesSlides/notesSlide1.xml', [
        { type: REL_SLIDE, target: '../slides/slide1.xml' },
        { type: REL_NOTES_MASTER, target: '../notesMasters/notesMaster1.xml' },
      ]),
      rels('ppt/notesMasters/notesMaster1.xml', [{ type: REL_THEME, target: '../theme/theme1.xml' }]),
    ],
  };
}

const BUILDERS: Readonly<Record<string, () => CorpusParts>> = Object.freeze({
  'baseline-single-master': buildBaselineSingleMaster,
  'multi-master': buildMultiMaster,
  'object-animation': buildObjectAnimation,
  'speaker-notes': buildSpeakerNotes,
});

/** 构建一条语料的字节。 */
export function buildCorpusBytes(id: string): Uint8Array {
  const builder = BUILDERS[id];
  if (builder === undefined) {
    throw new Error(`没有 id=${id} 的语料构建器`);
  }
  return assembleCorpus(builder()).bytes;
}

/** 构建清单里的全部语料（id → 字节）。 */
export function buildAllCorpora(): ReadonlyMap<string, Uint8Array> {
  const map = new Map<string, Uint8Array>();
  for (const descriptor of CORPUS_MANIFEST) {
    map.set(descriptor.id, buildCorpusBytes(descriptor.id));
  }
  return map;
}

export { CORPUS_MANIFEST, requireCorpusDescriptor, type CorpusDescriptor } from './descriptor.js';
