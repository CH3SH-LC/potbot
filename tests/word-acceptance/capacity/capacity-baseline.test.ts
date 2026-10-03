/**
 * WCF-D52：**R163 容量基线实测**（≥500 段 / ≥5 万汉字 / ≥100 图 / ≥10 MiB DOCX）。
 *
 * ## 两档，别把它们的结论混起来
 *
 * | 档 | 何时跑 | 回答什么 |
 * |---|---|---|
 * | **默认档** | 每次回归 | 全链路（独立造语料 → `importDocx` → `exportDocx` → 独立 Python 读回）**跑得通**，且"构建器声明规模 = 独立读回规模"。**它不证明 R163 达标**，只是保证测量仪器可信。 |
 * | **压力档** | `POTBOT_CAPACITY_STRESS=1` | 四条基线的**实测数字与是否达标**。默认跳过。 |
 *
 * **跳过 ≠ 通过**：压力档用例名里带 `[未执行]` 与开关名；报告里必须把
 * "跳过了什么"与"开了开关实跑的结果"**分开列**，不许把 skip 汇总成 pass。
 *
 * ## 判据的来源（R167：不拿实现当预期值）
 *
 * - 段落 / 图片 / 汉字 / 字节数一律取**独立读回器**（`scripts/demo/verify-docx.py`，纯 Python）的结果；
 * - 生产实现只当"把语料搬过去"的通道；
 * - 构建器自报的数字只用于**交叉核对**——声明与读回不符 ⇒ 导入/导出**静默丢了东西**，直接红。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  EVIDENCE_D52_DIR,
  R163_BASELINE,
  STRESS_ENABLED,
  STRESS_SKIP_REASON,
  buildCorpus,
  countHanzi,
  fmtBytes,
  readback,
  recordRow,
  runPipeline,
  writeCapacityReport,
  type CapacityRow,
  type CorpusMeta,
  type CorpusSpec,
  type PipelineResult,
  type Readback,
} from './support.js';

const WORK_DIR = join(EVIDENCE_D52_DIR, 'work');
const PRODUCT_DIR = join(EVIDENCE_D52_DIR, 'products');

/** 默认档的"仪器自检"规模：小到不拖累回归，又覆盖全部段落种类与图片路径。 */
const SMOKE_SPEC: CorpusSpec = { paragraphs: 60, hanzi: 2_000, images: 4, imagePixels: 16 };

interface DimensionRun {
  readonly label: string;
  readonly row: CapacityRow;
  readonly declared: CorpusMeta | null;
  readonly pipeline: PipelineResult | null;
  readonly back: Readback | null;
  /** 本维度的**读回**指标值（段落数 / 汉字数 / 图片数 / 容器字节数）。 */
  readonly value: number | null;
  readonly baselineValue: number;
  readonly readbackParagraphs: number | null;
  readonly readbackImages: number | null;
  readonly readbackHanzi: number | null;
}

/** 把一次测量压成一行"维度 / 基线 / 实测 / 是否达标 / 失败原因"。 */
function diagnose(run: DimensionRun): string {
  if (run.pipeline !== null && !run.pipeline.ok && run.pipeline.error !== null) {
    return `真实链路失败于 ${run.pipeline.error.name}` +
      `${run.pipeline.error.reason === null ? '' : `(${run.pipeline.error.reason})`}：` +
      run.pipeline.error.message;
  }
  if (run.back !== null && !run.back.ok) {
    return `独立读回未通过：${JSON.stringify(run.back.error)}`;
  }
  if (run.value === null) return '没有任何实测值（测量未完成）';
  return `实测 ${String(run.value)}（基线 ${String(run.baselineValue)}）`;
}

/**
 * 跑一个维度的完整测量。**从不抛异常**：失败被记进行里，由调用方断言——
 * 因为"达不到基线"本身就是要报告的结论，不是测试基础设施故障。
 */
function measureDimension(options: {
  readonly label: string;
  readonly slug: string;
  readonly baseline: string;
  readonly baselineValue: number;
  readonly spec: CorpusSpec;
  readonly extract: (back: Readback) => number;
  readonly declaredValue: (meta: CorpusMeta) => number;
  /**
   * 超限探针：**预期**这条语料被产品拒绝，并给出这个确切 `reason`。
   * 达标 = "真的以这个原因被拒"（不是"没报错"）——R163 要的"失败/超限时的确切错误"。
   */
  readonly expectRejection?: { readonly reason: string };
}): DimensionRun {
  const { label, slug, baseline, baselineValue, spec, extract, declaredValue } = options;
  let declared: CorpusMeta | null = null;
  let pipeline: PipelineResult | null = null;
  let back: Readback | null = null;
  let failure: string | null = null;

  // 三段分开 catch：语料构建失败 / 真实链路失败 / 独立读回失败**是三种不同的结论**，
  // 混成一句话会把"脚手架坏了"误报成"产品达不到基线"（第一轮实测踩过这个坑）。
  try {
    declared = buildCorpus(spec, WORK_DIR, `${slug}-corpus.docx`).meta;
  } catch (error) {
    failure = `语料构建失败（脚手架）：${(error as Error).message}`;
  }
  if (declared !== null) {
    try {
      pipeline = runPipeline(join(WORK_DIR, `${slug}-corpus.docx`), PRODUCT_DIR, `${slug}-product.docx`);
      if (pipeline.ok) {
        back = readback(pipeline.productPath);
      } else if (pipeline.error !== null) {
        failure = `真实链路失败（产品）：${pipeline.error.name}` +
          `${pipeline.error.reason === null ? '' : `(${pipeline.error.reason})`}: ` +
          pipeline.error.message;
      }
    } catch (error) {
      failure = `独立读回失败（脚手架）：${(error as Error).message}`;
    }
  }

  const value = back === null || !back.ok ? null : extract(back);
  const readbackParagraphs = back === null ? null : back.paragraphCount;
  const readbackImages = back === null ? null : back.mediaPaths.length;
  const readbackHanzi = back === null ? null
    : back.paragraphTexts.reduce((sum, text) => sum + countHanzi(text), 0);

  const importStep = pipeline?.import ?? null;
  const exportStep = pipeline?.export ?? null;
  const before = importStep?.before ?? null;
  const after = exportStep?.after ?? importStep?.after ?? null;

  const metrics: Record<string, unknown> = {
    spec,
    declared_paragraphs: declared?.paragraphs ?? null,
    declared_hanzi: declared?.hanzi ?? null,
    declared_images: declared?.images ?? null,
    declared_corpus_bytes: declared?.body_bytes ?? null,
    readback_paragraphs: readbackParagraphs,
    readback_hanzi: readbackHanzi,
    readback_images: readbackImages,
    zip_entries: back?.zip?.entries.length ?? null,
    product_bytes: pipeline?.productBytes ?? null,
    import_ms: importStep === null ? null : round(importStep.ms),
    export_ms: exportStep === null ? null : round(exportStep.ms),
    gc_forced: importStep?.gc_forced ?? false,
    // 测量方法：`process.memoryUsage()`（rss / heapUsed / external / arrayBuffers）
    // + `process.resourceUsage().maxRSS`（进程生命周期高水位，KiB）。
    // 同一进程内多个维度共用堆，故 `max_rss_delta_kib` 只在它增长时有归因意义；
    // 绝对值一并记录，避免只看增量得出"某维度不占内存"的错觉。
    rss_before_bytes: before?.rss ?? null,
    rss_after_bytes: after?.rss ?? null,
    heap_before_bytes: before?.heapUsed ?? null,
    heap_after_bytes: after?.heapUsed ?? null,
    rss_delta_bytes: before === null || after === null ? null : after.rss - before.rss,
    heap_delta_bytes: before === null || after === null ? null : after.heapUsed - before.heapUsed,
    external_delta_bytes: before === null || after === null ? null : after.external - before.external,
    max_rss_after_kib: after?.maxRSS ?? null,
    max_rss_delta_kib: before === null || after === null ? null : after.maxRSS - before.maxRSS,
    readback_command: back?.command ?? null,
  };

  const baselineMet = value !== null && value >= baselineValue;
  const crossCheckOk = declared !== null && readbackParagraphs !== null
    && declared.paragraphs === readbackParagraphs
    && declared.images === readbackImages
    && declared.hanzi === readbackHanzi;
  const expected = options.expectRejection;
  const rejectionMatched = expected !== undefined
    && pipeline !== null && !pipeline.ok && pipeline.error?.reason === expected.reason;
  const achieved = expected === undefined
    ? back !== null && back.ok && baselineMet
    : rejectionMatched;

  const row = recordRow({
    slug,
    dimension: label,
    baseline,
    achieved,
    declared: declared === null ? null : declaredValue(declared),
    readbackValue: value,
    notes: expected === undefined
      ? `声明 vs 读回交叉核对：${crossCheckOk ? '一致' : '**不一致**'}`
      : `超限探针：实际错误 = ${pipeline?.error?.name ?? '无'}`
        + `(${pipeline?.error?.reason ?? '无'})：${pipeline?.error?.message ?? '无'}`,
    failure: failure ?? (expected !== undefined
      ? (rejectionMatched ? null
        : `预期以 ${expected.reason} 被拒，实际：`
          + `${pipeline?.ok === true ? '导入成功（未触发守卫）' : String(pipeline?.error?.reason)}`)
      : (baselineMet ? null : diagnoseRow(value, baselineValue))),
    metrics,
  });

  return {
    label, row, declared, pipeline, back, value, baselineValue,
    readbackParagraphs, readbackImages, readbackHanzi,
  };
}

function diagnoseRow(value: number | null, baseline: number): string {
  return value === null
    ? '未取得读回值（见 metrics / 上层失败原因）'
    : `未达标：基线 ${String(baseline)}，实测 ${String(value)}`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 每个维度都要过的**共同**判据：链路通、独立读回通、声明与读回一致。 */
function assertHarnessInvariants(run: DimensionRun): void {
  if (run.pipeline !== null && !run.pipeline.ok) {
    throw new Error(`[${run.label}] 真实链路失败 —— ${diagnose(run)}`);
  }
  expect(run.back, `[${run.label}] 没有读回结果`).not.toBeNull();
  expect(run.back?.ok, `[${run.label}] 独立读回未通过：${JSON.stringify(run.back?.error)}`).toBe(true);
  // 声明规模必须与**独立读回**一致（不一致 = 导入/导出静默丢内容）
  expect(run.readbackParagraphs, `[${run.label}] 段落数：声明 ${String(run.declared?.paragraphs)} vs 读回 ${String(run.readbackParagraphs)}`)
    .toBe(run.declared?.paragraphs);
  expect(run.readbackImages, `[${run.label}] 图片数：声明 ${String(run.declared?.images)} vs 读回 ${String(run.readbackImages)}`)
    .toBe(run.declared?.images);
  expect(run.readbackHanzi, `[${run.label}] 汉字数：声明 ${String(run.declared?.hanzi)} vs 读回 ${String(run.readbackHanzi)}`)
    .toBe(run.declared?.hanzi);
}

// ---------------------------------------------------------------------------
// 默认档：仪器自检（不证明 R163 达标）
// ---------------------------------------------------------------------------

describe('容量基线（默认档：仪器自检，小规模、日常回归可承受）', () => {
  it('小规模全链路跑通，且"构建器声明"与"独立 Python 读回"逐项一致', () => {
    const run = measureDimension({
      label: '默认档仪器自检',
      slug: 'smoke',
      baseline: '（非基线；仅验证测量链路可信）',
      baselineValue: 1,
      spec: SMOKE_SPEC,
      extract: (back) => back.paragraphCount,
      declaredValue: (meta) => meta.paragraphs,
    });
    assertHarnessInvariants(run);
    expect(run.value).toBeGreaterThanOrEqual(SMOKE_SPEC.paragraphs);
    expect(run.pipeline?.productBytes ?? 0).toBeGreaterThan(0);
  });

  it('语料含全部要求的段落形态（空段 / 连续空格 / tab / 软换行 / 混合格式）', () => {
    const built = buildCorpus(SMOKE_SPEC, WORK_DIR, 'smoke-kinds-corpus.docx');
    const kinds = built.meta.paragraph_kinds;
    for (const kind of ['empty', 'spaces', 'tab', 'softbreak', 'mixed', 'plain']) {
      expect(kinds[kind], `语料缺少 "${kind}" 段落`).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 压力档：R163 四条基线的**实测**
// ---------------------------------------------------------------------------

const gate = STRESS_ENABLED ? '[已执行·压力档]' : STRESS_SKIP_REASON;

describe.skipIf(!STRESS_ENABLED)(`R163 容量基线压力档 ${STRESS_ENABLED ? '' : STRESS_SKIP_REASON}`, () => {
  it(`${gate} 维度 A：段落数 ≥ ${R163_BASELINE.paragraphs} 段`, { timeout: 900_000 }, () => {
    const run = measureDimension({
      label: '维度A-段落数',
      slug: 'dim-a-paragraphs',
      baseline: `≥ ${R163_BASELINE.paragraphs} 段（含空段/连续空格/tab/软换行/混合格式）`,
      baselineValue: R163_BASELINE.paragraphs,
      spec: { paragraphs: 600, hanzi: 600, images: 0 },
      extract: (back) => back.paragraphCount,
      declaredValue: (meta) => meta.paragraphs,
    });
    assertHarnessInvariants(run);
    expect(run.value, `[段落数] ${diagnose(run)}`).toBeGreaterThanOrEqual(R163_BASELINE.paragraphs);
  });

  it(`${gate} 维度 B：汉字数 ≥ ${R163_BASELINE.hanzi} 汉字`, { timeout: 900_000 }, () => {
    const run = measureDimension({
      label: '维度B-汉字数',
      slug: 'dim-b-hanzi',
      baseline: `≥ ${R163_BASELINE.hanzi} 汉字`,
      baselineValue: R163_BASELINE.hanzi,
      spec: { paragraphs: 500, hanzi: 50_000, images: 0 },
      extract: (back) => back.paragraphTexts.reduce((sum, text) => sum + countHanzi(text), 0),
      declaredValue: (meta) => meta.hanzi,
    });
    assertHarnessInvariants(run);
    expect(run.value, `[汉字数] ${diagnose(run)}`).toBeGreaterThanOrEqual(R163_BASELINE.hanzi);
  });

  it(`${gate} 维度 C：图片数 ≥ ${R163_BASELINE.images} 张有效 PNG`, { timeout: 900_000 }, () => {
    const run = measureDimension({
      label: '维度C-图片数',
      slug: 'dim-c-images',
      baseline: `≥ ${R163_BASELINE.images} 张程序生成的**有效** PNG`,
      baselineValue: R163_BASELINE.images,
      spec: { paragraphs: 200, images: 120, imagePixels: 32 },
      extract: (back) => back.mediaPaths.length,
      declaredValue: (meta) => meta.images,
    });
    assertHarnessInvariants(run);
    expect(run.value, `[图片数] ${diagnose(run)}`).toBeGreaterThanOrEqual(R163_BASELINE.images);
  });

  it(`${gate} 维度 D：容器 ≥ ${fmtBytes(R163_BASELINE.archiveBytes)} DOCX`, { timeout: 900_000 }, () => {
    const run = measureDimension({
      label: '维度D-容器大小',
      slug: 'dim-d-archive',
      baseline: `≥ ${fmtBytes(R163_BASELINE.archiveBytes)} 的 DOCX 容器`,
      baselineValue: R163_BASELINE.archiveBytes,
      spec: { paragraphs: 500, images: 120, imagePixels: 176, minBytes: 11 * 1024 * 1024 },
      extract: (back) => back.byteLength ?? 0,
      declaredValue: (meta) => meta.body_bytes,
    });
    assertHarnessInvariants(run);
    expect(run.value, `[容器] ${diagnose(run)}`).toBeGreaterThanOrEqual(R163_BASELINE.archiveBytes);
    expect(run.pipeline?.productBytes ?? 0).toBeGreaterThanOrEqual(R163_BASELINE.archiveBytes);
  });

  it(`${gate} 维度 E：四合一（≥500 段 + ≥5 万汉字 + ≥100 图 + ≥10 MiB 同一份文件）`,
    { timeout: 900_000 }, () => {
      const run = measureDimension({
        label: '维度E-四合一',
        slug: 'dim-e-combined',
        baseline: '≥500 段 且 ≥5 万汉字 且 ≥100 图 且 ≥10 MiB（同一份 DOCX）',
        baselineValue: R163_BASELINE.paragraphs,
        spec: {
          paragraphs: 600, hanzi: 50_000, images: 120, imagePixels: 176,
          minBytes: 11 * 1024 * 1024,
        },
        extract: (back) => back.paragraphCount,
        declaredValue: (meta) => meta.paragraphs,
      });
      assertHarnessInvariants(run);
      const bytes = run.back?.byteLength ?? 0;
      const hanzi = run.readbackHanzi ?? 0;
      const images = run.readbackImages ?? 0;
      expect(run.value, `[四合一·段落] ${diagnose(run)}`).toBeGreaterThanOrEqual(R163_BASELINE.paragraphs);
      expect(hanzi, `[四合一·汉字] 实测 ${String(hanzi)}`).toBeGreaterThanOrEqual(R163_BASELINE.hanzi);
      expect(images, `[四合一·图片] 实测 ${String(images)}`).toBeGreaterThanOrEqual(R163_BASELINE.images);
      expect(bytes, `[四合一·容器] 实测 ${fmtBytes(bytes)}`).toBeGreaterThanOrEqual(R163_BASELINE.archiveBytes);
    });

  it(`${gate} 维度 F：边界上探（4 倍段落 / 4 倍汉字 / 3 倍图片 / ~28 MiB，记录"已测到的最大规模"）`,
    { timeout: 900_000 }, () => {
      // **这不是基线判据**：R163 只要求 ≥ 那一组数。本用例把规模往上推，
      // 目的是把"达标"升级成"边界在哪"——记下**已测到的最大规模**与它的耗时/内存。
      // 它是"已测到的最大"，不是"已验证的天花板"（真正的天花板需要二分，不在本轮范围）。
      const run = measureDimension({
        label: '维度F-边界上探',
        slug: 'dim-f-boundary-probe',
        baseline: '（非基线；探"已测到的最大规模"）',
        baselineValue: R163_BASELINE.paragraphs,
        spec: { paragraphs: 2_000, hanzi: 200_000, images: 300, imagePixels: 176, minBytes: 24 * 1024 * 1024 },
        extract: (back) => back.paragraphCount,
        declaredValue: (meta) => meta.paragraphs,
      });
      assertHarnessInvariants(run);
      const bytes = run.back?.byteLength ?? 0;
      expect(run.value, `[边界上探·段落] ${diagnose(run)}`).toBeGreaterThanOrEqual(2_000);
      expect(run.readbackHanzi ?? 0).toBeGreaterThanOrEqual(200_000);
      expect(run.readbackImages ?? 0).toBeGreaterThanOrEqual(300);
      expect(bytes, `[边界上探·容器] 实测 ${fmtBytes(bytes)}`).toBeGreaterThanOrEqual(24 * 1024 * 1024);
    });

  it(`${gate} 维度 G：超限探针（高重复文本触发读侧压缩比守卫，记录**确切错误**）`,
    { timeout: 900_000 }, () => {
      // R159 的压缩比上限（默认 200）是"deflate 炸弹"守卫。本用例**故意**造一份
      // 合法但高度重复的中文文档，确认它在导入期被**明确拒绝**、且给出确切 reason，
      // 而不是被悄悄接受、更不是被截断。
      const run = measureDimension({
        label: '维度G-压缩比守卫',
        slug: 'dim-g-ratio-guard',
        baseline: '（超限探针：预期以 compression_ratio_exceeded 被拒）',
        baselineValue: 0,
        spec: { paragraphs: 200, hanzi: 60_000, repetitive: true },
        extract: () => 0,
        declaredValue: (meta) => meta.hanzi,
        expectRejection: { reason: 'compression_ratio_exceeded' },
      });
      expect(run.pipeline?.ok, `[压缩比守卫] 预期被拒，但导入成功了：${diagnose(run)}`).toBe(false);
      expect(run.pipeline?.error?.reason, `[压缩比守卫] 确切错误：${JSON.stringify(run.pipeline?.error)}`)
        .toBe('compression_ratio_exceeded');
      expect(run.pipeline?.error?.message ?? '').toContain('压缩比');
    });
});

// ---------------------------------------------------------------------------
// 报告：无论达标与否都落盘（"未达标"必须显式出现，不许只留一句 ok）
// ---------------------------------------------------------------------------

afterAll(() => {
  // 行由 `recordRow()` 累积在 support 模块里；这里把它们汇总落盘。
  const headline = STRESS_ENABLED
    ? 'R163 四条基线的实测（压力档已执行）'
    : '默认档（仅仪器自检；压力档未执行——跳过≠通过）';
  const path = writeCapacityReport(headline);
  // 原始输出里带上表格，便于把实测数字直接贴进报告，而不用另开文件。
  // eslint-disable-next-line no-console
  console.log(`[WCF-D52] 容量报告已落盘：${path}`);
  // eslint-disable-next-line no-console
  console.log(readFileSync(path, 'utf8'));
});
