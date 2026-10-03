/**
 * P-R01 · **独立探针**：直接从字节里读出语料的部件图，**不使用** `src/presentations` 的任何导入/
 * 结构读取函数。
 *
 * 独立性说明（避免"照抄实现自证"）：
 * - 容器层复用 `src/artifacts/ooxml` 的 `readZip`（共享底座，不是本包被测对象）；
 * - **OOXML 语义层全部自解析**：`[Content_Types].xml`、各级 `_rels`、`presentation.xml` 的
 *   母版/页 id 列表、幻灯片里的 `p:timing`，都用本文件自己的正则/扫描，不 import
 *   `roundtrip.ts` / `import.ts` / `readPresentationStructure`。
 *
 * 这样"语料的实际形状"与"被测实现如何看待它"是两条独立计算，可以对照。
 */

import { digestBytes } from '../../../../../src/artifacts/digest.js';
import { readZip } from '../../../../../src/artifacts/ooxml/index.js';

/** 一页的语序观察结果（独立正则，不解析 XML 树）。 */
export interface SlideTimingReport {
  readonly slide_path: string;
  readonly has_timing: boolean;
  /** `p:cTn@nodeType` 的取值计数（`mainSeq` / `clickEffect` / `afterEffect` / `tmRoot`…）。 */
  readonly node_type_counts: Readonly<Record<string, number>>;
  /** `p:spTgt@spid` 去重后的目标形状 id。 */
  readonly target_shape_ids: readonly number[];
  /** `p:bldP@spid` 去重后的构建形状 id。 */
  readonly build_shape_ids: readonly number[];
  /** `p:transition` 下直接子元素的本地名（如 `fade`）。 */
  readonly transition_kinds: readonly string[];
}

/** 一份语料的完整探针报告。 */
export interface CorpusProbeReport {
  readonly part_paths: readonly string[];
  readonly digest_by_path: Readonly<Record<string, string>>;
  /** `PartName`（含前导 `/`）→ 内容类型，来自 `[Content_Types].xml` 的 `Override`。 */
  readonly content_type_overrides: Readonly<Record<string, string>>;
  readonly master_paths: readonly string[];
  readonly theme_paths: readonly string[];
  readonly layout_paths: readonly string[];
  readonly slide_paths: readonly string[];
  readonly notes_slide_paths: readonly string[];
  readonly notes_master_paths: readonly string[];
  /** `p:sldMasterIdLst/p:sldMasterId@id` 的值（有序）。 */
  readonly presentation_sld_master_ids: readonly number[];
  /** `p:sldIdLst/p:sldId` 条数。 */
  readonly presentation_sld_id_count: number;
  /** 包级 `_rels/.rels` 里 officeDocument 关系的目标。 */
  readonly root_office_document_target: string | null;
  /** `presentation.xml.rels` 里 slideMaster 关系的目标（包内路径）。 */
  readonly presentation_master_targets: readonly string[];
  readonly timing: readonly SlideTimingReport[];
}

function textOf(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf8');
}

function overridesFromContentTypes(xml: string): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const match of xml.matchAll(/<Override\b[^>]*\/?>/g)) {
    const tag = match[0];
    const part = /\bPartName\s*=\s*"([^"]+)"/.exec(tag)?.[1];
    const ct = /\bContentType\s*=\s*"([^"]+)"/.exec(tag)?.[1];
    if (part !== undefined && ct !== undefined) {
      out[part] = ct;
    }
  }
  return out;
}

/** 独立解析 `_rels`：返回 `{type, target}` 列表（不 import 生产解析器）。 */
function relsEntries(xml: string): readonly { readonly type: string; readonly target: string }[] {
  const out: { type: string; target: string }[] = [];
  for (const match of xml.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const tag = match[0];
    const type = /\bType\s*=\s*"([^"]+)"/.exec(tag)?.[1];
    const target = /\bTarget\s*=\s*"([^"]+)"/.exec(tag)?.[1];
    if (type !== undefined && target !== undefined) {
      out.push({ type, target });
    }
  }
  return out;
}

function resolve(ownerDir: string, target: string): string {
  const combined = target.startsWith('/') ? target.slice(1) : `${ownerDir}${target}`;
  const stack: string[] = [];
  for (const segment of combined.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return stack.join('/');
}

function probeSlideTiming(path: string, xml: string): SlideTimingReport {
  const nodeTypeCounts: Record<string, number> = {};
  const hasTiming = /<p:timing\b/.test(xml);
  if (hasTiming) {
    for (const match of xml.matchAll(/<p:cTn\b[^>]*\bnodeType="([^"]+)"/g)) {
      const key = match[1] as string;
      nodeTypeCounts[key] = (nodeTypeCounts[key] ?? 0) + 1;
    }
  }
  const targetIds = new Set<number>();
  for (const match of xml.matchAll(/<p:spTgt\b[^>]*\bspid="(\d+)"/g)) {
    targetIds.add(Number.parseInt(match[1] as string, 10));
  }
  const buildIds = new Set<number>();
  for (const match of xml.matchAll(/<p:bldP\b[^>]*\bspid="(\d+)"/g)) {
    buildIds.add(Number.parseInt(match[1] as string, 10));
  }
  const transitionKinds: string[] = [];
  const transitionBlock = /<p:transition\b[^>]*>([\s\S]*?)<\/p:transition>/.exec(xml)?.[1];
  if (transitionBlock !== undefined) {
    for (const match of transitionBlock.matchAll(/<p:([A-Za-z0-9]+)\b/g)) {
      transitionKinds.push(match[1] as string);
    }
  }
  return {
    slide_path: path,
    has_timing: hasTiming,
    node_type_counts: Object.freeze(nodeTypeCounts),
    target_shape_ids: Object.freeze([...targetIds].sort((a, b) => a - b)),
    build_shape_ids: Object.freeze([...buildIds].sort((a, b) => a - b)),
    transition_kinds: Object.freeze(transitionKinds),
  };
}

/** 探测一份 PPTX 字节的部件图。 */
export function probeCorpus(bytes: Uint8Array): CorpusProbeReport {
  const archive = readZip(bytes);
  const partPaths = archive.entries.map((entry) => entry.path);
  const digestByPath: Record<string, string> = {};
  for (const entry of archive.entries) {
    digestByPath[entry.path] = digestBytes(entry.data);
  }

  const contentTypesEntry = archive.by_path.get('[Content_Types].xml');
  if (contentTypesEntry === undefined) {
    throw new Error('语料缺少 [Content_Types].xml');
  }
  const contentTypes = overridesFromContentTypes(textOf(contentTypesEntry.data));

  const slidePaths = partPaths.filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path));
  const masterPaths = partPaths.filter((path) => /^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(path));
  const layoutPaths = partPaths.filter((path) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(path));
  const themePaths = partPaths.filter((path) => /^ppt\/theme\/theme\d+\.xml$/.test(path));
  const notesSlidePaths = partPaths.filter((path) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(path));
  const notesMasterPaths = partPaths.filter((path) => /^ppt\/notesMasters\/notesMaster\d+\.xml$/.test(path));

  const presentationEntry = archive.by_path.get('ppt/presentation.xml');
  if (presentationEntry === undefined) {
    throw new Error('语料缺少 ppt/presentation.xml');
  }
  const presentationXmlText = textOf(presentationEntry.data);
  const sldMasterIds: number[] = [];
  for (const match of presentationXmlText.matchAll(/<p:sldMasterId\b[^>]*\bid="(\d+)"/g)) {
    sldMasterIds.push(Number.parseInt(match[1] as string, 10));
  }
  const sldIdCount = [...presentationXmlText.matchAll(/<p:sldId\b/g)].length;

  const rootRelsEntry = archive.by_path.get('_rels/.rels');
  const rootTarget = rootRelsEntry === undefined
    ? null
    : relsEntries(textOf(rootRelsEntry.data)).find((entry) => entry.type.endsWith('/officeDocument'))?.target ?? null;

  const presentationRelsEntry = archive.by_path.get('ppt/_rels/presentation.xml.rels');
  const presentationMasterTargets: string[] = [];
  if (presentationRelsEntry !== undefined) {
    for (const entry of relsEntries(textOf(presentationRelsEntry.data))) {
      if (entry.type.endsWith('/slideMaster')) {
        presentationMasterTargets.push(resolve('ppt/', entry.target));
      }
    }
  }

  const timing = slidePaths
    .map((path) => {
      const entry = archive.by_path.get(path);
      return entry === undefined ? null : probeSlideTiming(path, textOf(entry.data));
    })
    .filter((value): value is SlideTimingReport => value !== null);

  return Object.freeze({
    part_paths: Object.freeze(partPaths),
    digest_by_path: Object.freeze(digestByPath),
    content_type_overrides: Object.freeze(contentTypes),
    master_paths: Object.freeze(masterPaths),
    theme_paths: Object.freeze(themePaths),
    layout_paths: Object.freeze(layoutPaths),
    slide_paths: Object.freeze(slidePaths),
    notes_slide_paths: Object.freeze(notesSlidePaths),
    notes_master_paths: Object.freeze(notesMasterPaths),
    presentation_sld_master_ids: Object.freeze(sldMasterIds),
    presentation_sld_id_count: sldIdCount,
    root_office_document_target: rootTarget,
    presentation_master_targets: Object.freeze(presentationMasterTargets),
    timing: Object.freeze(timing),
  });
}
