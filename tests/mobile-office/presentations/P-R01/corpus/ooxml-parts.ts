/**
 * P-R01 · **外部语料的 OOXML 部件工厂**（多母版 / 动画 / 备注）。
 *
 * ## 这一层是什么
 *
 * 「外部语料」= 一份**部件图**（`[Content_Types].xml` + `_rels` + 各部件 XML），其形状按
 * PowerPoint / WPS 实际落盘的结构手工造出，用来把 `src/presentations` 的导入/往返行为
 * 钉在具体字节上。它**不是**本域 `render.ts` 的产物：母版数、`p:timing` 的 `p:bldLst`、
 * 备注母版等，恰恰是 `render.ts` 造不出（多母版会被 `multi_master_unsupported` 挡住）
 * 或从不产出（对象动画无 `p:timing` 产物）的形状。
 *
 * ## 诚实边界（**必须随语料一并读**）
 *
 * 这些部件是**按 OOXML 规范与已知 PowerPoint/WPS 落盘形状手工构造的**，本机无 Office 授权、
 * 无设备，**没有任何一份语料是 PowerPoint/WPS 真实导出的文件**。因此：
 * - 语料能证明的是"导入/往返对这类**形状**如何反应"；
 * - 语料**不能**证明"真实 PowerPoint/WPS 导出的文件长这样"——那需要消费端实测（见 RUNBOOK 的未验证层）。
 *
 * ## 依赖
 *
 * 只用 `src/artifacts/ooxml` 的**容器原语**（`el` / `attr` / `serializeXmlDocument` /
 * `assembleOpcPackage` / `writeZip`）——它们不是本包的被测对象，是共享的确定性 OOXML 底座。
 * 本模块**不** import `src/presentations/**`，以保证语料独立于被测实现。
 */

import {
  RELATIONSHIPS_CONTENT_TYPE,
  assembleOpcPackage,
  attr,
  el,
  formatInteger,
  serializeXmlDocument,
  writeZip,
  type AssembledOpcPackage,
  type ContentTypeDefault,
  type OpcPart,
  type RelationshipDeclaration,
  type RelationshipGroup,
} from '../../../../../src/artifacts/ooxml/index.js';

// ---------------------------------------------------------------------------
// 命名空间 / 内容类型 / 关系类型（与 PowerPoint 落盘一致的字面量）
// ---------------------------------------------------------------------------

export const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
export const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
export const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

export const CT_PRESENTATION =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml';
export const CT_SLIDE_MASTER =
  'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml';
export const CT_SLIDE_LAYOUT =
  'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml';
export const CT_SLIDE = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';
export const CT_NOTES_SLIDE =
  'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml';
export const CT_NOTES_MASTER =
  'application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml';
export const CT_THEME = 'application/vnd.openxmlformats-officedocument.theme+xml';

export const REL_OFFICE_DOCUMENT =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';
export const REL_SLIDE_MASTER =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster';
export const REL_SLIDE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';
export const REL_SLIDE_LAYOUT =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout';
export const REL_THEME = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme';
export const REL_NOTES_SLIDE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide';
export const REL_NOTES_MASTER =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster';

/** 16:9 与 4:3 的页尺寸（EMU）。 */
export const SLIDE_16_9 = { cx: 12192000, cy: 6858000 } as const;
export const NOTES_SIZE = { cx: 6858000, cy: 9144000 } as const;

/** 母版 / 版式 / 幻灯片 id 起点（与 PowerPoint 一致：母版用大整数、幻灯片从 256 起）。 */
export const FIRST_MASTER_ID = 2147483648;
export const FIRST_LAYOUT_ID = 2147483649;
export const FIRST_SLIDE_ID = 256;

const RELATIONSHIPS_DEFAULT: ContentTypeDefault = Object.freeze({
  extension: 'rels',
  content_type: RELATIONSHIPS_CONTENT_TYPE,
});

// ---------------------------------------------------------------------------
// 基础片段
// ---------------------------------------------------------------------------

/** `p:spTree` 的组形状前导（空形状树也必须有的两条）。 */
export function groupShapeTreePreamble() {
  return [
    el('p:nvGrpSpPr', [], [
      el('p:cNvPr', [attr('id', '1'), attr('name', '')]),
      el('p:cNvGrpSpPr'),
      el('p:nvPr'),
    ]),
    el('p:grpSpPr', [], [
      el('a:xfrm', [], [
        el('a:off', [attr('x', '0'), attr('y', '0')]),
        el('a:ext', [attr('cx', '0'), attr('cy', '0')]),
        el('a:chOff', [attr('x', '0'), attr('y', '0')]),
        el('a:chExt', [attr('cx', '0'), attr('cy', '0')]),
      ]),
    ]),
  ] as const;
}

/** 单个文本框形状（`p:sp`，含一段中文文本 run）。 */
export function textShapeXml(id: number, name: string, text: string, box: { x: number; y: number; cx: number; cy: number }) {
  return el('p:sp', [], [
    el('p:nvSpPr', [], [
      el('p:cNvPr', [attr('id', formatInteger(id)), attr('name', name)]),
      el('p:cNvSpPr', [attr('txBox', '1')]),
      el('p:nvPr'),
    ]),
    el('p:spPr', [], [
      el('a:xfrm', [], [
        el('a:off', [attr('x', formatInteger(box.x)), attr('y', formatInteger(box.y))]),
        el('a:ext', [attr('cx', formatInteger(box.cx)), attr('cy', formatInteger(box.cy))]),
      ]),
      el('a:prstGeom', [attr('prst', 'rect')], [el('a:avLst')]),
    ]),
    el('p:txBody', [], [
      el('a:bodyPr', [attr('wrap', 'square')]),
      el('a:lstStyle'),
      el('a:p', [], [
        el('a:r', [], [
          el('a:rPr', [attr('lang', 'zh-CN'), attr('dirty', '0')]),
          el('a:t', [], [text]),
        ]),
      ]),
    ]),
  ]);
}

/** 一份幻灯片部件（`p:sld`）；可选注入 `p:timing` / `p:transition` 片段（原样嵌入）。 */
export function slideXml(options: {
  readonly shapes: readonly ReturnType<typeof textShapeXml>[];
  readonly timingXml?: string;
  readonly transitionXml?: string;
  readonly hidden?: boolean;
}): string {
  const attrs = [
    attr('xmlns:a', NS_A),
    attr('xmlns:r', NS_R),
    attr('xmlns:p', NS_P),
    ...(options.hidden === true ? [attr('show', '0')] : []),
  ];
  // p:timing / p:transition 是 `p:sld` 的直接子元素，位置在 `p:cSld`/`p:clrMapOvr` 之后。
  // 这里用纯文本拼装，因为它们本就是"外部文件里的原样片段"。
  const tail = `${options.transitionXml ?? ''}${options.timingXml ?? ''}`;
  const head = serializeXmlNodeWithoutDeclaration(
    el('p:sld', attrs, [el('p:cSld', [], [el('p:spTree', [], [...groupShapeTreePreamble(), ...options.shapes])]), el('p:clrMapOvr', [], [el('a:masterClrMapping')])]),
  );
  // 把 tail 插到 </p:sld> 之前。
  const closing = '</p:sld>';
  return `${head.slice(0, head.lastIndexOf(closing))}${tail}${closing}`;
}

function serializeXmlNodeWithoutDeclaration(node: Parameters<typeof serializeXmlDocument>[0]): string {
  const full = serializeXmlDocument(node);
  return full.slice(full.indexOf('\n') + 1);
}

/** 母版部件（`p:sldMaster`）：clrMap + 版式 id 列表 + 空形状树。 */
export function slideMasterXml(layoutRelIds: readonly string[]): string {
  return serializeXmlDocument(
    el('p:sldMaster', [attr('xmlns:a', NS_A), attr('xmlns:r', NS_R), attr('xmlns:p', NS_P)], [
      el('p:cSld', [], [el('p:spTree', [], [...groupShapeTreePreamble()])]),
      el('p:clrMap', [
        attr('bg1', 'lt1'),
        attr('tx1', 'dk1'),
        attr('bg2', 'lt2'),
        attr('tx2', 'dk2'),
        attr('accent1', 'accent1'),
        attr('accent2', 'accent2'),
        attr('accent3', 'accent3'),
        attr('accent4', 'accent4'),
        attr('accent5', 'accent5'),
        attr('accent6', 'accent6'),
        attr('hlink', 'hlink'),
        attr('folHlink', 'folHlink'),
      ]),
      el('p:sldLayoutIdLst', [], [
        ...layoutRelIds.map((rid, index) =>
          el('p:sldLayoutId', [attr('id', formatInteger(FIRST_LAYOUT_ID + index)), attr('r:id', rid)]),
        ),
      ]),
    ]),
  );
}

/** 版式部件（`p:sldLayout`），含指回母版的关系与一个名称。 */
export function slideLayoutXml(name: string): string {
  return serializeXmlDocument(
    el('p:sldLayout', [attr('xmlns:a', NS_A), attr('xmlns:r', NS_R), attr('xmlns:p', NS_P), attr('type', 'blank')], [
      el('p:cSld', [attr('name', name)], [el('p:spTree', [], [...groupShapeTreePreamble()])]),
      el('p:clrMapOvr', [], [el('a:masterClrMapping')]),
    ]),
  );
}

/** 主题部件（`a:theme`），含 12 槽位配色——供 `readPresentationStructure` 读取。 */
export function themeXml(accent1: string, dk1 = '000000', lt1 = 'FFFFFF'): string {
  const slot = (tag: string, value: string) =>
    el(`a:${tag}`, [], [el('a:srgbClr', [attr('val', value)])]);
  return serializeXmlDocument(
    el('a:theme', [attr('xmlns:a', NS_A), attr('name', 'PotbotCorpusTheme')], [
      el('a:themeElements', [], [
        el('a:clrScheme', [attr('name', 'PotbotCorpus')], [
          el('a:dk1', [], [el('a:sysClr', [attr('val', 'windowText'), attr('lastClr', dk1)])]),
          slot('lt1', lt1),
          slot('dk2', '44546A'),
          slot('lt2', 'E7E6E6'),
          slot('accent1', accent1),
          slot('accent2', 'ED7D31'),
          slot('accent3', 'A5A5A5'),
          slot('accent4', 'FFC000'),
          slot('accent5', '5B9BD5'),
          slot('accent6', '70AD47'),
          slot('hlink', '0563C1'),
          slot('folHlink', '954F72'),
        ]),
        el('a:fontScheme', [attr('name', 'PotbotCorpus')], [
          el('a:majorFont', [], [el('a:latin', [attr('typeface', 'Calibri')]), el('a:ea', [attr('typeface', '等线')])]),
          el('a:minorFont', [], [el('a:latin', [attr('typeface', 'Calibri')]), el('a:ea', [attr('typeface', '等线')])]),
        ]),
        el('a:fmtScheme', [attr('name', 'PotbotCorpus')], [
          el('a:fillStyleLst', [], [el('a:solidFill', [], [el('a:schemeClr', [attr('val', 'phClr')])])]),
          el('a:lnStyleLst', [], [el('a:ln', [attr('w', '6350')], [el('a:solidFill', [], [el('a:schemeClr', [attr('val', 'phClr')])])])]),
          el('a:effectStyleLst', [], [el('a:effectStyle', [], [el('a:effectLst')])]),
          el('a:bgFillStyleLst', [], [el('a:solidFill', [], [el('a:schemeClr', [attr('val', 'phClr')])])]),
        ]),
      ]),
      el('a:objectDefaults'),
      el('a:extraClrSchemeLst'),
    ]),
  );
}

/** 备注母版（`p:notesMaster`），空形状树。 */
export function notesMasterXml(): string {
  return serializeXmlDocument(
    el('p:notesMaster', [attr('xmlns:a', NS_A), attr('xmlns:r', NS_R), attr('xmlns:p', NS_P)], [
      el('p:cSld', [], [el('p:spTree', [], [...groupShapeTreePreamble()])]),
      el('p:clrMap', [
        attr('bg1', 'lt1'),
        attr('tx1', 'dk1'),
        attr('bg2', 'lt2'),
        attr('tx2', 'dk2'),
        attr('accent1', 'accent1'),
        attr('accent2', 'accent2'),
        attr('accent3', 'accent3'),
        attr('accent4', 'accent4'),
        attr('accent5', 'accent5'),
        attr('accent6', 'accent6'),
        attr('hlink', 'hlink'),
        attr('folHlink', 'folHlink'),
      ]),
      el('p:notesStyle'),
    ]),
  );
}

/** 备注页部件（`p:notes`），含一个备注文本框。 */
export function notesSlideXml(text: string): string {
  return serializeXmlDocument(
    el('p:notes', [attr('xmlns:a', NS_A), attr('xmlns:r', NS_R), attr('xmlns:p', NS_P)], [
      el('p:cSld', [], [
        el('p:spTree', [], [
          ...groupShapeTreePreamble(),
          textShapeXml(2, 'Notes Placeholder', text, { x: 838200, y: 457200, cx: 7772400, cy: 3076575 }),
        ]),
      ]),
      el('p:clrMapOvr', [], [el('a:masterClrMapping')]),
    ]),
  );
}

/**
 * **动画时序树**（`p:timing`）——按 PowerPoint 落盘的形状手工构造。
 *
 * 与 `render.ts` 从不产出的形状一致的特征：带 `p:bldLst`（构建列表）、`p:spTgt`（按形状 id 定位）、
 * 多个点击组（`nodeType="clickEffect"`），以及一个 `afterEffect`。用途是让"外部动画文件"在
 * 导入/往返路径上有具体字节可比。**本片段不在本仓任何渲染路径里生成。**
 */
export function timingXml(opts: { readonly targets: readonly number[] }): string {
  const clickGroups = opts.targets
    .map((spid, groupIndex) => {
      const base = (groupIndex + 1) * 10;
      return (
        `<p:par><p:cTn id="${base}" fill="hold" nodeType="clickEffect">` +
        `<p:stCondLst><p:cond delay="${groupIndex === 0 ? 'indefinite' : '0'}"/></p:stCondLst>` +
        `<p:childTnLst>` +
        `<p:par><p:cTn id="${base + 1}" fill="hold" nodeType="clickEffect">` +
        `<p:stCondLst><p:cond delay="0"/></p:stCondLst>` +
        `<p:childTnLst><p:set><p:cBhvr>` +
        `<p:cTn id="${base + 2}" dur="1" fill="hold"/>` +
        `<p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl>` +
        `<p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst>` +
        `</p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set></p:childTnLst>` +
        `</p:cTn></p:par>` +
        `<p:par><p:cTn id="${base + 3}" fill="hold" nodeType="afterEffect">` +
        `<p:stCondLst><p:cond delay="500"/></p:stCondLst>` +
        `<p:childTnLst><p:animEffect transition="in" filter="fade">` +
        `<p:cBhvr><p:cTn id="${base + 4}" dur="250"/>` +
        `<p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl></p:cBhvr>` +
        `</p:animEffect></p:childTnLst></p:cTn></p:par>` +
        `</p:childTnLst></p:cTn></p:par>`
      );
    })
    .join('');
  const blds = opts.targets.map((spid) => `<p:bldP spid="${spid}" grpId="0"/>`).join('');
  return (
    `<p:timing><p:tnLst><p:par>` +
    `<p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>` +
    `<p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq">` +
    `<p:childTnLst>${clickGroups}</p:childTnLst></p:cTn>` +
    `<p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst>` +
    `<p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst>` +
    `</p:seq></p:childTnLst></p:cTn></p:par></p:tnLst>` +
    `<p:bldLst>${blds}</p:bldLst></p:timing>`
  );
}

/** 切换片段（`p:transition`），位置在 `p:sld` 里、`p:timing` 之前。 */
export function transitionXml(kind: string, durationMs: number): string {
  return `<p:transition xmlns:p="${NS_P}" spd="med" dur="${formatInteger(durationMs)}"><p:${kind}/></p:transition>`;
}

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

/** 一份语料的原始部件清单（给测试直接断言部件图，不必解 ZIP）。 */
export interface CorpusParts {
  readonly parts: readonly OpcPart[];
  readonly relationships: readonly RelationshipGroup[];
}

/** 把部件清单组装成 PPTX 字节。 */
export function assembleCorpus(corpus: CorpusParts): {
  readonly bytes: Uint8Array;
  readonly assembled: AssembledOpcPackage;
} {
  const assembled = assembleOpcPackage({
    parts: corpus.parts,
    content_type_defaults: [RELATIONSHIPS_DEFAULT],
    relationships: corpus.relationships,
  });
  return { bytes: writeZip(assembled.entries), assembled };
}

/** 关系组构造小助手：`owner = null` 表示包级 `_rels/.rels`。 */
export function rels(
  ownerPartPath: string | null,
  declarations: readonly RelationshipDeclaration[],
): RelationshipGroup {
  return { owner_part_path: ownerPartPath, declarations };
}

/** presentation.xml（母版 id 列表可多条，支持多母版语料）。 */
export function presentationXml(opts: {
  readonly masterRelIds: readonly string[];
  readonly notesMasterRelId?: string | null;
  readonly slideRelIds: readonly string[];
}): string {
  return serializeXmlDocument(
    el('p:presentation', [attr('xmlns:a', NS_A), attr('xmlns:r', NS_R), attr('xmlns:p', NS_P)], [
      el('p:sldMasterIdLst', [], [
        ...opts.masterRelIds.map((rid, index) =>
          el('p:sldMasterId', [attr('id', formatInteger(FIRST_MASTER_ID + index)), attr('r:id', rid)]),
        ),
      ]),
      ...(opts.notesMasterRelId === undefined || opts.notesMasterRelId === null
        ? []
        : [
            el('p:notesMasterIdLst', [], [
              el('p:notesMasterId', [attr('r:id', opts.notesMasterRelId)]),
            ]),
          ]),
      el('p:sldIdLst', [], [
        ...opts.slideRelIds.map((rid, index) =>
          el('p:sldId', [attr('id', formatInteger(FIRST_SLIDE_ID + index)), attr('r:id', rid)]),
        ),
      ]),
      el('p:sldSz', [attr('cx', formatInteger(SLIDE_16_9.cx)), attr('cy', formatInteger(SLIDE_16_9.cy))]),
      el('p:notesSz', [attr('cx', formatInteger(NOTES_SIZE.cx)), attr('cy', formatInteger(NOTES_SIZE.cy))]),
    ]),
  );
}
