/**
 * WCF-D52 **容量基线实测**的共享工具（合同 R163 / R159 / R164）。
 *
 * ## 这个目录在测什么
 *
 * R163 把一组数字写成**工程目标**：≥500 段 / ≥5 万汉字 / ≥100 图 / ≥10 MiB DOCX，
 * 并明确要求「达不到时报告**实际边界**，不隐藏截断」。D11 独立审查（N6）核实：
 * 这四条**一个都没量过**。本目录就是把这四个数字变成**实测数字**。
 *
 * ## 链路（与 `export-for-word.test.ts` 同构：驱动真实链路，判据交给独立工具）
 *
 * ```
 * corpus-builder.py  ──►  语料 DOCX（独立 Python 造，声明规模写在 stdout JSON）
 *        │
 *        ▼  真实链路（被测对象）
 *   importDocx → exportDocx
 *        │
 *        ▼  **独立**判据（不 import 生产 TS）
 *   scripts/demo/verify-docx.py  ──► ok / byteLength / zip.entries / format.paragraphs
 * ```
 *
 * **不拿实现当预期值（R167）**：段落数 / 图片数 / 汉字数 / 字节数一律由独立读回器复算；
 * 生产实现只作为"把语料搬过去"的通道。构建器的自报数字只用来做**交叉核对**
 * （"声明的量 vs 读回的量"——两者不符就说明导入/导出静默丢东西了）。
 *
 * ## 内存与耗时怎么量的（方法必须写在报告里，别只写结论）
 *
 * - 耗时：`performance.now()` 夹住每一步（导入 / 导出 / 独立读回）。
 * - 内存：`process.memoryUsage()`（rss / heapUsed / external / arrayBuffers）
 *   + `process.resourceUsage().maxRSS`（**进程生命周期**的常驻内存高水位，单位 KiB）。
 *   取"步前 / 步后"两值；`maxRSS` 单调不减，故只把它的**增量**归因于该步。
 *   `global.gc()` 存在时（`NODE_OPTIONS=--expose-gc`）在步前强制回收，让增量更干净；
 *   不存在时如实记录 `gc_forced: false`，不假装精确。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { exportDocx, importDocx } from '../../../src/documents/docx/index.js';

/** 仓库根（`tests/word-acceptance/capacity/support.ts` 向上三级）。 */
export const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');

/** 本目录（构建器所在）。 */
export const CAPACITY_DIR = resolve(import.meta.dirname);

/** 独立压力语料构建器。 */
export const CORPUS_BUILDER_PY = join(CAPACITY_DIR, 'corpus-builder.py');

/** 独立 DOCX 读回器（WCF-D10 产出；本任务只调用、不改写）。 */
export const VERIFY_DOCX_PY = join(REPO_ROOT, 'scripts', 'demo', 'verify-docx.py');

/** 本任务证据目录（`.dev-evidence` 已 gitignore）。 */
export const EVIDENCE_D52_DIR = join(
  REPO_ROOT, '.dev-evidence', 'word-common-features', 'WCF-20261002-A', 'D52',
);

/** 压力档开关。**默认关闭**——重压测试不进日常回归。 */
export const STRESS_ENABLED = process.env['POTBOT_CAPACITY_STRESS'] === '1';

/**
 * 跳过原因（**写进用例名**）。跳过 ≠ 通过：报告里"跳过了什么"与"开了开关实跑的结果"
 * 必须分开列，不许把 skip 当成 pass 汇总。
 */
export const STRESS_SKIP_REASON =
  '[未执行] 需显式开关：设 POTBOT_CAPACITY_STRESS=1 才真跑重压场景（默认跳过，跳过≠通过）';

/** 读侧默认上限（只读引用，供一致性核对；**本任务不改生产代码**）。 */
export const R163_BASELINE = Object.freeze({
  paragraphs: 500,
  hanzi: 50_000,
  images: 100,
  archiveBytes: 10 * 1024 * 1024,
});

// ---------------------------------------------------------------------------
// Python 定位（与本目录外的验收器同口径，但**本目录自持**）
// ---------------------------------------------------------------------------

export function pythonExecutable(): string {
  const fromEnv = process.env['DEMO_PYTHON'];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const known = 'C:/Users/<user>/AppData/Local/Programs/Python/Python313/python.exe';
  if (existsSync(known)) return known;
  return 'python';
}

function pythonEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
}

/** 缺工具**显式失败**（不 skip 计通过）——与 D10 同一条纪律。 */
export function assertCapacityToolsAvailable(): void {
  const python = pythonExecutable();
  if ((python.includes('/') || python.includes('\\')) && !existsSync(python)) {
    throw new Error(`找不到 Python 解释器：${python}（可设 DEMO_PYTHON 覆盖）`);
  }
  if (!existsSync(CORPUS_BUILDER_PY)) throw new Error(`找不到语料构建器：${CORPUS_BUILDER_PY}`);
  if (!existsSync(VERIFY_DOCX_PY)) throw new Error(`找不到独立读回器：${VERIFY_DOCX_PY}`);
}

// ---------------------------------------------------------------------------
// 语料构建（独立 Python）
// ---------------------------------------------------------------------------

export interface CorpusSpec {
  readonly paragraphs: number;
  readonly hanzi?: number;
  readonly images?: number;
  readonly imagePixels?: number;
  readonly minBytes?: number;
  readonly seed?: number;
  /** 承载汉字用同一个字重复（故意造高压缩比；用于测读侧的压缩比守卫边界）。 */
  readonly repetitive?: boolean;
}

export interface CorpusMeta {
  readonly out: string | null;
  readonly paragraphs: number;
  readonly hanzi: number;
  readonly images: number;
  readonly image_pixels: number;
  readonly body_bytes: number;
  readonly document_part_bytes: number;
  readonly declared_min_bytes: number;
  readonly padding_paragraphs_added: number;
  readonly paragraph_kinds: Record<string, number>;
  readonly seed: number;
  readonly repetitive: boolean;
  readonly compression: string;
}

export interface BuiltCorpus {
  readonly path: string;
  readonly meta: CorpusMeta;
  readonly command: string;
  readonly stdout: string;
}

/** 造一份压力语料。构建器自检不过（退出码非 0）时**抛错**，绝不"接着跑"。 */
export function buildCorpus(spec: CorpusSpec, outDir: string, name: string): BuiltCorpus {
  assertCapacityToolsAvailable();
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, name);
  const args = [
    CORPUS_BUILDER_PY,
    '--out', out,
    '--paragraphs', String(spec.paragraphs),
    '--hanzi', String(spec.hanzi ?? 0),
    '--images', String(spec.images ?? 0),
    '--image-pixels', String(spec.imagePixels ?? 32),
    '--min-bytes', String(spec.minBytes ?? 0),
    '--seed', String(spec.seed ?? 20261003),
    ...(spec.repetitive === true ? ['--repetitive'] : []),
  ];
  const python = pythonExecutable();
  let stdout: string;
  try {
    stdout = execFileSync(python, args, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 600_000, windowsHide: true, env: pythonEnv(),
      // `execFileSync` 默认 maxBuffer 只有 1 MiB。压力档的语料规模会让**读回结果**超出它，
      // 表现为 stdout 被截断、JSON 解析报 "Unterminated string … at position 1114112"。
      // 这是测量脚手架的限制，**不是**产品边界——必须显式放大，否则会把脚手架故障
      // 误报成"产品达不到基线"（第一轮实测就踩了这个坑，见 completion.md 的已知缺口）。
      maxBuffer: 512 * 1024 * 1024,
    });
  } catch (error) {
    const failure = error as { status?: number | null; stdout?: string; stderr?: string };
    throw new Error(
      `语料构建失败（退出码 ${String(failure.status ?? 'null')}）\n`
      + `命令：${[python, ...args].join(' ')}\n`
      + `stderr：${(failure.stderr ?? '').slice(0, 2000)}\n`
      + `stdout：${(failure.stdout ?? '').slice(0, 2000)}`,
    );
  }
  return {
    path: out,
    meta: JSON.parse(stdout.trim()) as CorpusMeta,
    command: [python, ...args].join(' '),
    stdout: stdout.trim(),
  };
}

// ---------------------------------------------------------------------------
// 真实链路 + 测量
// ---------------------------------------------------------------------------

export interface MemorySnapshot {
  readonly rss: number;
  readonly heapUsed: number;
  readonly external: number;
  readonly arrayBuffers: number;
  /** 进程生命周期常驻内存高水位（KiB；`process.resourceUsage().maxRSS`）。 */
  readonly maxRSS: number;
}

export interface StepMeasure {
  readonly ms: number;
  readonly before: MemorySnapshot;
  readonly after: MemorySnapshot;
  /** 该步是否在步前强制 GC（`--expose-gc` 时才为 true）。 */
  readonly gc_forced: boolean;
}

export interface PipelineResult {
  readonly ok: boolean;
  readonly inputBytes: number;
  readonly productBytes: number;
  readonly productPath: string;
  readonly import: StepMeasure | null;
  readonly export: StepMeasure | null;
  /** 失败时的**确切**错误（名字 / 消息 / `reason`，`DocxError` 有 reason）。 */
  readonly error: { readonly name: string; readonly message: string; readonly reason: string | null } | null;
}

function snapshot(): MemorySnapshot {
  const usage = process.memoryUsage();
  return {
    rss: usage.rss,
    heapUsed: usage.heapUsed,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
    maxRSS: process.resourceUsage().maxRSS,
  };
}

function forceGcIfAvailable(): boolean {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== 'function') return false;
  gc();
  return true;
}

export function describeError(error: unknown): { name: string; message: string; reason: string | null } {
  const err = error as { name?: string; message?: string; reason?: unknown };
  return {
    name: typeof err?.name === 'string' ? err.name : typeof error,
    message: typeof err?.message === 'string' ? err.message : String(error),
    reason: typeof err?.reason === 'string' ? err.reason : null,
  };
}

/**
 * 跑真实链路：语料 → `importDocx` → `exportDocx` → 落盘产物。
 *
 * **失败也是结果**：任何一步抛错都被抓住、原样记进 `error`，函数**不抛出**——
 * 因为"达不到基线"本身就是要报告的结论，不是测试基础设施故障。
 */
export function runPipeline(docxPath: string, outDir: string, name: string): PipelineResult {
  mkdirSync(outDir, { recursive: true });
  const productPath = join(outDir, name);
  const inputBytes = readFileSync(docxPath).byteLength;

  let importMeasure: StepMeasure | null = null;
  let exportMeasure: StepMeasure | null = null;
  try {
    const gcBeforeImport = forceGcIfAvailable();
    const importBefore = snapshot();
    const t0 = performance.now();
    const model = importDocx(new Uint8Array(readFileSync(docxPath)));
    const importMs = performance.now() - t0;
    const importAfter = snapshot();
    importMeasure = { ms: importMs, before: importBefore, after: importAfter, gc_forced: gcBeforeImport };

    const gcBeforeExport = forceGcIfAvailable();
    const exportBefore = snapshot();
    const t1 = performance.now();
    const product = exportDocx(model);
    const exportMs = performance.now() - t1;
    const exportAfter = snapshot();
    exportMeasure = { ms: exportMs, before: exportBefore, after: exportAfter, gc_forced: gcBeforeExport };

    writeFileSync(productPath, product);
    return {
      ok: true, inputBytes, productBytes: product.byteLength, productPath,
      import: importMeasure, export: exportMeasure, error: null,
    };
  } catch (error) {
    return {
      ok: false, inputBytes, productBytes: 0, productPath,
      import: importMeasure, export: exportMeasure, error: describeError(error),
    };
  }
}

// ---------------------------------------------------------------------------
// 独立读回（不 import 生产 TS）
// ---------------------------------------------------------------------------

export interface ReadbackZip {
  readonly entries: readonly string[];
  readonly bad_entry: string | null;
  readonly entry_details: Record<string, string>;
}

export interface ReadbackDocument {
  readonly part: string;
  readonly paragraphs: readonly string[];
  readonly non_empty_count: number;
  readonly title: string | null;
}

export interface Readback {
  readonly ok: boolean;
  readonly exitCode: number;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly byteLength: number | null;
  readonly parts: readonly string[];
  readonly zip: ReadbackZip | null;
  readonly document: ReadbackDocument | null;
  /** 全部段落（**含空段**）的文本，按文档顺序。 */
  readonly paragraphTexts: readonly string[];
  readonly paragraphCount: number;
  readonly mediaPaths: readonly string[];
  readonly raw: unknown;
  readonly command: string;
}

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu;

/** 独立复算汉字数（CJK 码点；不 import 生产实现）。 */
export function countHanzi(text: string): number {
  const matched = text.match(CJK);
  return matched === null ? 0 : matched.length;
}

/** 跑独立读回器。**任何退出码都如实返回**；输出无法解析时抛错（基础设施问题，不该静默）。 */
export function readback(docxPath: string): Readback {
  assertCapacityToolsAvailable();
  const python = pythonExecutable();
  const args = [VERIFY_DOCX_PY, docxPath];
  const command = [python, ...args].join(' ');
  let stdout = '';
  let exitCode = 0;
  try {
    stdout = execFileSync(python, args, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 600_000, windowsHide: true, env: pythonEnv(),
      // 同上：压力档下读回输出（`format.paragraphs` 逐段逐 run）会远超默认 1 MiB。
      maxBuffer: 512 * 1024 * 1024,
    });
  } catch (error) {
    const failure = error as { status?: number | null; stdout?: string };
    exitCode = typeof failure.status === 'number' ? failure.status : 1;
    stdout = failure.stdout ?? '';
  }
  if (stdout.trim().length === 0) {
    throw new Error(`独立读回器没有任何输出（退出码 ${String(exitCode)}）：${command}`);
  }
  const payload = JSON.parse(stdout.trim()) as {
    ok: boolean;
    error: { code: string; message: string } | null;
    byteLength?: number;
    parts?: string[];
    zip?: ReadbackZip | null;
    document?: { part: string; paragraphs: string[]; non_empty_count: number; title: string | null } | null;
    format?: { paragraphs: { index: number; text: string }[] } | null;
  };
  const formatParagraphs = payload.format?.paragraphs ?? [];
  const paragraphTexts = formatParagraphs.map((item) => item.text);
  const mediaPaths = (payload.zip?.entries ?? []).filter((entry) => entry.startsWith('word/media/'));
  return {
    ok: payload.ok === true,
    exitCode,
    error: payload.error,
    byteLength: payload.byteLength ?? null,
    parts: payload.parts ?? [],
    zip: payload.zip ?? null,
    document: payload.document ?? null,
    paragraphTexts,
    paragraphCount: paragraphTexts.length,
    mediaPaths,
    raw: payload,
    command,
  };
}

// ---------------------------------------------------------------------------
// 报告表（维度 / 基线 / 实测 / 是否达标 / 失败原因）
// ---------------------------------------------------------------------------

export interface CapacityRow {
  /** ASCII 短名（用于证据文件名，避免中文文件名在 Windows 控制台下的编码噪声）。 */
  readonly slug: string;
  readonly dimension: string;
  readonly baseline: string;
  readonly achieved: boolean;
  readonly declared: number | null;
  readonly readbackValue: number | null;
  readonly notes: string;
  readonly failure: string | null;
  readonly metrics: Record<string, unknown>;
}

const rows: CapacityRow[] = [];

/** 记一行并立刻单独落盘（即便随后断言失败，这一行的实测数字也已经留在磁盘上）。 */
export function recordRow(row: CapacityRow): CapacityRow {
  rows.push(row);
  mkdirSync(EVIDENCE_D52_DIR, { recursive: true });
  writeFileSync(
    join(EVIDENCE_D52_DIR, `dimension-${row.slug}.json`),
    JSON.stringify(row, null, 2), 'utf8',
  );
  return row;
}

/** 已记录的全部行（`capacity-report.json` 里也有一份）。 */
export function allRows(): readonly CapacityRow[] {
  return rows;
}

function kpi(row: CapacityRow): string {
  const m = row.metrics as {
    import_ms?: number | null; export_ms?: number | null;
    product_bytes?: number | null; max_rss_delta_kib?: number | null;
  };
  return [
    `导入 ${fmt(m.import_ms)} ms`,
    `导出 ${fmt(m.export_ms)} ms`,
    `产物 ${fmtBytes(m.product_bytes ?? null)}`,
    `maxRSS 增量 ${fmt(m.max_rss_delta_kib === undefined || m.max_rss_delta_kib === null
      ? null : m.max_rss_delta_kib * 1024)}`,
  ].join(' / ');
}

/** 步未跑成时时序/内存字段是 `null`——报告里要显示 `n/a`，不能把 null 当 0 或让写报告本身崩掉。 */
function fmt(value: number | undefined | null): string {
  return value === undefined || value === null || !Number.isFinite(value)
    ? 'n/a' : value.toFixed(1);
}

export function fmtBytes(value: number | undefined | null): string {
  if (value === undefined || value === null) return 'n/a';
  if (value < 1024) return `${String(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MiB`;
}

/** 汇总报告落盘（JSON + Markdown 表），返回 Markdown 路径。 */
export function writeCapacityReport(headline: string): string {
  mkdirSync(EVIDENCE_D52_DIR, { recursive: true });
  const markdown = [
    `# WCF-D52 容量基线实测 — ${headline}`,
    '',
    `> 生成时间：${new Date().toISOString()}｜压力开关 POTBOT_CAPACITY_STRESS=${STRESS_ENABLED ? '1' : '0'}`,
    `> 基线出处：合同 R163（\`docs/other/prep/文档编辑合同-冻结v1（design-05批）.md\`）`,
    '',
    '| 维度 | 基线 | 实测（读回） | 是否达标 | 导入/导出耗时与产物 | 失败原因 |',
    '|---|---|---|---|---|---|',
    ...rows.map((row) => [
      row.dimension,
      row.baseline,
      row.readbackValue === null ? 'n/a' : String(row.readbackValue),
      row.achieved ? '达标' : '**未达标**',
      kpi(row),
      row.failure ?? '—',
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |')),
    '',
  ].join('\n');
  writeFileSync(join(EVIDENCE_D52_DIR, 'capacity-report.json'),
    JSON.stringify({ headline, generated: new Date().toISOString(), stress: STRESS_ENABLED, rows }, null, 2),
    'utf8');
  const markdownPath = join(EVIDENCE_D52_DIR, 'capacity-report.md');
  writeFileSync(markdownPath, markdown, 'utf8');
  return markdownPath;
}
