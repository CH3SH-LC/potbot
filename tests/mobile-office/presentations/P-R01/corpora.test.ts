/**
 * P-R01 · PPT **外部语料定向验收**（多母版 / 动画 / 备注）。
 *
 * ## 判据来源
 *
 * 语料与判据都在本目录内独立构造：`corpus/descriptor.ts`（清单/预期）、
 * `corpus/corpus.ts`（构建）、`corpus/probe.ts`（独立探针，不 import 生产导入器）。
 * 生产侧只作为**被测对象**被调用（`importPresentation` / `exportImportedPresentation` /
 * `readPresentationStructure`），本文件不复用它们的内部解析来当"独立"证据。
 *
 * ## 三层对照
 *
 * 1. **语料形状 vs 声明**：探针读出的母版数 / 时序 / 备注部件必须等于 `descriptor` 声明；
 * 2. **预期 vs 实测**：逐条把 `expected_import` 与实际导入结果对照（含"预期失败"的多母版）；
 * 3. **保留 vs 丢失**：打开→原样保存，`preservation_required` 里的部件必须逐字节不变。
 *
 * ## 已闭合的边界（原缺口，现由集成交付补齐——测试钉住新行为）
 *
 * - 多母版：`importPresentation` 仍抛 `multi_master_unsupported`（PPT.md 点名的受限项，未变）；
 * - 对象动画：`p:timing` 现经 P08 `parseTimingXml` 读回 `Slide.animations`（原硬编码为空，§B 已更新）；
 *   **改过该页**后时序不再丢失——导出按模型动画重新注入时序块（§D 已更新）；
 * - 备注删除：原先 `notes_part_removal_unsupported` 具名拒绝，现由 `annotations/note-parts.ts`
 *   支持删净（含 notesMaster 清理，§E 已更新）。
 */

import { describe, expect, it } from 'vitest';

import {
  PresentationRoundTripError,
  exportImportedPresentation,
  importPresentation,
  readPresentationStructure,
} from '../../../../src/presentations/roundtrip.js';
import { setShapeText, setSlideNotes } from '../../../../src/presentations/operations.js';
import { literalText } from '../../../../src/presentations/model.js';

import { CORPUS_MANIFEST, requireCorpusDescriptor } from './corpus/descriptor.js';
import { buildAllCorpora, buildCorpusBytes } from './corpus/corpus.js';
import { probeCorpus } from './corpus/probe.js';

const CORPORA = buildAllCorpora();

function bytesOf(id: string): Uint8Array {
  const bytes = CORPORA.get(id);
  if (bytes === undefined) throw new Error(`缺语料 ${id}`);
  return bytes;
}

// ---------------------------------------------------------------------------
// §A 语料形状：探针 vs 清单声明
// ---------------------------------------------------------------------------

describe('§A 语料形状与清单声明一致', () => {
  for (const descriptor of CORPUS_MANIFEST) {
    it(`${descriptor.id}：母版/页/时序/备注数量与声明相等`, () => {
      const report = probeCorpus(bytesOf(descriptor.id));

      expect(report.master_paths.length).toBe(descriptor.master_count);
      expect(report.slide_paths.length).toBe(descriptor.slide_count);
      expect(report.notes_slide_paths).toEqual([...descriptor.notes_slide_paths]);
      expect(report.presentation_sld_id_count).toBe(descriptor.slide_count);
      expect(report.root_office_document_target).toBe('ppt/presentation.xml');
      expect(report.presentation_master_targets.length).toBe(descriptor.master_count);

      const timingPaths = report.timing.filter((entry) => entry.has_timing).map((entry) => entry.slide_path);
      expect(timingPaths).toEqual([...descriptor.timing_slide_paths]);
    });
  }

  it('每条语料都声明了保留部件，且都在包内真实存在', () => {
    for (const descriptor of CORPUS_MANIFEST) {
      const report = probeCorpus(bytesOf(descriptor.id));
      expect(descriptor.preservation_required.length).toBeGreaterThan(0);
      for (const path of descriptor.preservation_required) {
        expect(report.digest_by_path[path]).toBeDefined();
      }
    }
  });

  it('多母版语料确有两条 sldMasterId，单母版语料只有一条', () => {
    const multi = probeCorpus(bytesOf('multi-master'));
    expect(multi.presentation_sld_master_ids.length).toBe(2);
    expect(multi.theme_paths.length).toBe(2);
    const single = probeCorpus(bytesOf('baseline-single-master'));
    expect(single.presentation_sld_master_ids.length).toBe(1);
  });

  it('动画语料含真实时序树（mainSeq + 两个点击组 + 构建列表）', () => {
    const report = probeCorpus(bytesOf('object-animation'));
    const slide1 = report.timing.find((entry) => entry.slide_path === 'ppt/slides/slide1.xml');
    expect(slide1).toBeDefined();
    expect(slide1?.has_timing).toBe(true);
    expect(slide1?.node_type_counts['mainSeq']).toBe(1);
    // 两个目标各出一个点击组；组内 clickEffect 节点 ≥ 2。
    expect(slide1?.target_shape_ids).toEqual([2, 3]);
    expect(slide1?.build_shape_ids).toEqual([2, 3]);
    expect(slide1?.node_type_counts['clickEffect']).toBeGreaterThanOrEqual(2);
    expect(slide1?.transition_kinds).toContain('fade');
    // 第二页无时序：证明"有时序/无时序"在同一文件里被区分。
    const slide2 = report.timing.find((entry) => entry.slide_path === 'ppt/slides/slide2.xml');
    expect(slide2?.has_timing).toBe(false);
  });

  it('语料内容类型表使用 PowerPoint 的标准 MIME（独立字面量对照）', () => {
    const report = probeCorpus(bytesOf('speaker-notes'));
    expect(report.content_type_overrides['/ppt/notesSlides/notesSlide1.xml']).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml',
    );
    expect(report.content_type_overrides['/ppt/slides/slide1.xml']).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
    );
    const animated = probeCorpus(bytesOf('object-animation'));
    expect(animated.content_type_overrides['/ppt/slideMasters/slideMaster1.xml']).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml',
    );
  });

  it('语料构建是确定性的（同 id 两次构建逐字节相等）', () => {
    for (const descriptor of CORPUS_MANIFEST) {
      const a = Buffer.from(buildCorpusBytes(descriptor.id));
      const b = Buffer.from(buildCorpusBytes(descriptor.id));
      expect(a.equals(b)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// §B 预期 vs 实测导入结果
// ---------------------------------------------------------------------------

describe('§B 导入结果与清单预期一致', () => {
  it('单母版对照件导入成功，页数与声明一致', () => {
    const imported = importPresentation(bytesOf('baseline-single-master'));
    expect(imported.presentation.slides.length).toBe(2);
    expect(imported.bindings.map((binding) => binding.slide_id)).toEqual([256, 257]);
  });

  it('多母版语料导入**按预期失败**，且原因是 multi_master_unsupported', () => {
    const descriptor = requireCorpusDescriptor('multi-master');
    expect(descriptor.expected_import).toEqual({ kind: 'throws', reason: 'multi_master_unsupported' });
    let caught: unknown;
    try {
      importPresentation(bytesOf('multi-master'));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PresentationRoundTripError);
    expect((caught as PresentationRoundTripError).reason).toBe('multi_master_unsupported');
  });

  it('动画语料导入成功，p:timing 被建模进 animations（原缺口已闭合）', () => {
    const imported = importPresentation(bytesOf('object-animation'));
    expect(imported.presentation.slides.length).toBe(2);
    // 行为变更：roundtrip 现经 P08 parseTimingXml 把 p:timing 读进 Slide.animations（原先硬编码为空）。
    const animations = imported.presentation.slides[0]?.animations ?? [];
    expect(animations.length).toBeGreaterThan(0);
    // 语料里两个目标各出一个点击组 ⇒ 独立探针读到 target [2,3]；建模结果的目标集必须一致。
    const probeShapes = probeCorpus(bytesOf('object-animation')).timing.find(
      (entry) => entry.slide_path === 'ppt/slides/slide1.xml',
    )?.target_shape_ids;
    expect([...new Set(animations.map((shape) => shape.shape_id))].sort()).toEqual([...(probeShapes ?? [])].sort());
    expect(animations.some((animation) => animation.trigger === 'on_click')).toBe(true);
    // 切换（p:transition）是可表达的，导入应读到。
    expect(imported.presentation.slides[0]?.transition).not.toBeNull();
  });

  it('备注语料导入成功，备注文本被读出', () => {
    const imported = importPresentation(bytesOf('speaker-notes'));
    expect(imported.presentation.slides.length).toBe(2);
    const notes = imported.presentation.slides[0]?.notes;
    expect(notes).not.toBeNull();
    const text = notes?.paragraphs[0]?.runs[0]?.source;
    expect(text).toBeDefined();
    expect(text?.kind === 'literal' ? text.text : '').toBe('这是演讲者备注：讲解要点一二三。');
    // 第二页无备注部件。
    expect(imported.presentation.slides[1]?.notes).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §C 打开 → 原样保存：保留语义
// ---------------------------------------------------------------------------

describe('§C 无改动往返逐字节保留', () => {
  for (const descriptor of CORPUS_MANIFEST) {
    if (descriptor.expected_import.kind !== 'ok') {
      continue; // 多母版导入即失败，无法进入保存路径。
    }
    it(`${descriptor.id}：原样保存不改任何部件，保留清单逐字节不变`, () => {
      const source = bytesOf(descriptor.id);
      const imported = importPresentation(source);
      const saved = exportImportedPresentation(imported, imported.presentation);

      expect(saved.changed_part_paths).toEqual([]);
      expect(saved.replaced_part_count).toBe(0);

      const before = probeCorpus(source);
      const after = probeCorpus(saved.bytes);
      for (const path of descriptor.preservation_required) {
        expect(after.digest_by_path[path]).toBe(before.digest_by_path[path]);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// §D 动画语料的编辑边界：改一页后时序是被保留还是被丢弃
// ---------------------------------------------------------------------------

describe('§D 动画语料被编辑后，p:timing 的去留（外部语料逼出的边界）', () => {
  it('改动第一页文本后再保存：记录 p:timing 的实际去留', () => {
    const imported = importPresentation(bytesOf('object-animation'));
    const slide1 = imported.presentation.slides[0];
    expect(slide1).toBeDefined();
    const shapeId = slide1?.shapes[0]?.shape_id as number;

    const edited = setShapeText(
      imported.presentation,
      slide1?.slide_id as number,
      shapeId,
      literalText('改动后的标题'),
    );
    const saved = exportImportedPresentation(imported, edited);

    // 改过的页必须换字节，未改的页（slide2）不动。
    expect(saved.changed_part_paths).toContain('ppt/slides/slide1.xml');
    expect(saved.changed_part_paths).not.toContain('ppt/slides/slide2.xml');

    const before = probeCorpus(bytesOf('object-animation'));
    const after = probeCorpus(saved.bytes);
    const beforeSlide1 = before.timing.find((entry) => entry.slide_path === 'ppt/slides/slide1.xml');
    const afterSlide1 = after.timing.find((entry) => entry.slide_path === 'ppt/slides/slide1.xml');
    expect(beforeSlide1?.has_timing).toBe(true);

    // —— 实测口径（不预设立场）：把实际结果钉住。——
    // 行为变更：被改页重渲染后，导出按模型动画（roundtrip 从 p:timing 读回的 Slide.animations）
    // **重新注入**时序块，因此改文本不再静默丢动画——时序保留。
    expect(afterSlide1?.has_timing).toBe(true);
    // slide2 未改，其时序状态与改动前一致（无时序）。
    expect(after.timing.find((entry) => entry.slide_path === 'ppt/slides/slide2.xml')?.has_timing).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §E 备注语料的编辑与"删备注需重建关系图"边界
// ---------------------------------------------------------------------------

describe('§E 备注语料的原地编辑与删除边界', () => {
  it('原地改备注文本：只换备注部件，其余保留', () => {
    const imported = importPresentation(bytesOf('speaker-notes'));
    const slide1 = imported.presentation.slides[0];
    const edited = setSlideNotes(
      imported.presentation,
      slide1?.slide_id as number,
      literalText('更新后的备注'),
    );
    const saved = exportImportedPresentation(imported, edited);

    expect(saved.changed_part_paths).toEqual(['ppt/notesSlides/notesSlide1.xml']);

    const before = probeCorpus(bytesOf('speaker-notes'));
    const after = probeCorpus(saved.bytes);
    // 幻灯片本体、母版、主题不受影响。
    expect(after.digest_by_path['ppt/slides/slide1.xml']).toBe(before.digest_by_path['ppt/slides/slide1.xml']);
    expect(after.digest_by_path['ppt/slideMasters/slideMaster1.xml']).toBe(
      before.digest_by_path['ppt/slideMasters/slideMaster1.xml'],
    );
    expect((after.digest_by_path['ppt/slides/slide1.xml'] as string).length).toBeGreaterThan(0);
  });

  it('删除备注（置 null）：导出成功，备注部件被删净（原缺口已闭合）', () => {
    const imported = importPresentation(bytesOf('speaker-notes'));
    const slide1 = imported.presentation.slides[0];
    const edited = setSlideNotes(imported.presentation, slide1?.slide_id as number, null);

    // 行为变更：原先具名拒绝 `notes_part_removal_unsupported`，现删备注走 note-parts 逆向删净
    // （含 notesMaster 清理），导出不再抛错。
    const saved = exportImportedPresentation(imported, edited);

    const before = probeCorpus(bytesOf('speaker-notes'));
    const after = probeCorpus(saved.bytes);
    // 备注部件不再在包里。
    expect(after.notes_slide_paths).toEqual([]);
    // 幻灯片本体不受影响。
    expect(after.digest_by_path['ppt/slides/slide1.xml']).toBe(before.digest_by_path['ppt/slides/slide1.xml']);
  });
});

// ---------------------------------------------------------------------------
// §F 结构读取对多母版的反应（比导入更宽的一侧）
// ---------------------------------------------------------------------------

describe('§F readPresentationStructure 对多母版语料的反应', () => {
  it('单母版语料：读到母版路径 / 版式 / 主题配色', () => {
    const structure = readPresentationStructure(bytesOf('baseline-single-master'));
    expect(structure.master_part_path).toBe('ppt/slideMasters/slideMaster1.xml');
    expect(structure.theme_part_path).toBe('ppt/theme/theme1.xml');
    expect(structure.layout_part_paths).toContain('ppt/slideLayouts/slideLayout1.xml');
    expect(structure.theme_color_scheme?.accent1).toBe('4472C4');
  });

  it('多母版语料：结构读取**不**拒绝多母版，且只报第一套母版（与导入口径不一致）', () => {
    // 实测：`readPresentationStructure` 不数母版数，只取 presentation.xml.rels 里第一条 slideMaster。
    // 因此它对同一份文件"读得出结构"，而 `importPresentation` 却拒收——这是两条入口的口径差异，
    // 由外部语料暴露。断言钉住该实际行为。
    const structure = readPresentationStructure(bytesOf('multi-master'));
    expect(structure.size.cx_emu).toBe(12192000);
    expect(structure.size.cy_emu).toBe(6858000);
    expect(structure.master_part_path).toBe('ppt/slideMasters/slideMaster1.xml');
    // 只报第一套主题配色（accent1 来自 theme1），不反映 theme2。
    expect(structure.theme_color_scheme?.accent1).toBe('4472C4');
  });
});
