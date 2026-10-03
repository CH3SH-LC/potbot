/**
 * P-R01 · **语料清单与判据类型**（"operation schemas/types"）。
 *
 * 每个语料条目声明它**代表什么形状**、**预期导入结果**、以及**预期需保留的部件**。
 * 清单是机器可读的（测试逐条读取），不把判据散落在断言里。
 *
 * 这些声明是**假设**，不是真理：测试会把每条预期与实际运行结果对照，不一致就红——
 * 尤其是"预期导入失败"的条目，它记录的正是当前实现的**已知缺口**（例如多母版）。
 */

/** 语料特征标签（PPT 线的外部语料按此分类）。 */
export type CorpusFeature =
  | 'baseline_single_master'
  | 'multi_master'
  | 'object_animation'
  | 'speaker_notes';

/** 导入预期。 */
export type ImportExpectation =
  | { readonly kind: 'ok' }
  | { readonly kind: 'throws'; readonly reason: string };

/** 一条语料的声明。 */
export interface CorpusDescriptor {
  readonly id: string;
  readonly title: string;
  readonly feature: CorpusFeature;
  /** 母版部件数（>1 即多母版）。 */
  readonly master_count: number;
  /** 幻灯片部件数。 */
  readonly slide_count: number;
  /** 含 `p:timing` 的幻灯片部件路径（空 = 无语序）。 */
  readonly timing_slide_paths: readonly string[];
  /** 备注页部件路径（空 = 无备注）。 */
  readonly notes_slide_paths: readonly string[];
  readonly expected_import: ImportExpectation;
  /** 无论导入成败，这些部件在"打开→原样保存"往返里必须逐字节保留。 */
  readonly preservation_required: readonly string[];
}

/** 全部语料（测试的唯一数据源）。 */
export const CORPUS_MANIFEST: readonly CorpusDescriptor[] = Object.freeze([
  {
    id: 'baseline-single-master',
    title: '单母版对照件（确认基线与多母版失败无关）',
    feature: 'baseline_single_master',
    master_count: 1,
    slide_count: 2,
    timing_slide_paths: [],
    notes_slide_paths: [],
    expected_import: { kind: 'ok' },
    preservation_required: [
      'ppt/slideMasters/slideMaster1.xml',
      'ppt/slideLayouts/slideLayout1.xml',
      'ppt/theme/theme1.xml',
    ],
  },
  {
    id: 'multi-master',
    title: '双母版 + 双主题（Slide 引用不同母版的版式）',
    feature: 'multi_master',
    master_count: 2,
    slide_count: 2,
    timing_slide_paths: [],
    notes_slide_paths: [],
    // 当前实现明确拒绝多母版（roundtrip.ts 的具名错误）。这条断言记录缺口本身。
    expected_import: { kind: 'throws', reason: 'multi_master_unsupported' },
    preservation_required: [
      'ppt/slideMasters/slideMaster1.xml',
      'ppt/slideMasters/slideMaster2.xml',
      'ppt/theme/theme1.xml',
      'ppt/theme/theme2.xml',
    ],
  },
  {
    id: 'object-animation',
    title: '对象动画时序树（p:timing + p:bldLst，两个点击组）',
    feature: 'object_animation',
    master_count: 1,
    slide_count: 2,
    timing_slide_paths: ['ppt/slides/slide1.xml'],
    notes_slide_paths: [],
    expected_import: { kind: 'ok' },
    preservation_required: ['ppt/slides/slide1.xml', 'ppt/slides/slide2.xml'],
  },
  {
    id: 'speaker-notes',
    title: '演讲备注（notesSlide + notesMaster）',
    feature: 'speaker_notes',
    master_count: 1,
    slide_count: 2,
    timing_slide_paths: [],
    notes_slide_paths: ['ppt/notesSlides/notesSlide1.xml'],
    expected_import: { kind: 'ok' },
    preservation_required: ['ppt/notesSlides/notesSlide1.xml', 'ppt/notesMasters/notesMaster1.xml'],
  },
]);

/** 按 id 找一条声明；找不到抛错（不静默返回 undefined）。 */
export function requireCorpusDescriptor(id: string): CorpusDescriptor {
  const found = CORPUS_MANIFEST.find((entry) => entry.id === id);
  if (found === undefined) {
    throw new Error(`语料清单里没有 id=${id}`);
  }
  return found;
}
