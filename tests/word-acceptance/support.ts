/**
 * WCF-D10 独立验收的共享工具（**不是**被测实现的一部分）。
 *
 * 纪律（与 `tests/demo/support.ts` 同源，但**本目录自持**，不跨目录 import 别人正在改的文件）：
 * 本目录的用例**不 import** `apps/demo/**` 或 `src/**` 的任何函数当作预期值（合同 R167）；
 * 只做三件事——(1) 调用**独立 Python 读回器**读产物、(2) 跑 `--self-test`、
 * (3) 用同一读回器对**变异样本**验证"每个变异被对应判据抓住"（R168/T16）。
 *
 * **缺工具必须显式失败，不许 skip 计通过**：`assertToolAvailable()` 在 python 或读回器
 * 缺失时**抛错**，测试随之失败而不是被跳过。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** 仓库根（`tests/word-acceptance/support.ts` 向上两级）。 */
export const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

/** 独立 DOCX 读回器（本任务允许写入的唯一旧工具）。 */
export const VERIFY_DOCX_PY = join(REPO_ROOT, 'scripts', 'demo', 'verify-docx.py');

/** 语料与期望目录。 */
export const FIXTURES_DIR = join(REPO_ROOT, 'tests', 'word-acceptance', 'fixtures');
export const EXPECTATIONS_DIR = join(FIXTURES_DIR, 'expectations');

/** WCF-D10 专属证据工作目录（测试期临时产物；`.dev-evidence` 已 gitignore）。 */
export const EVIDENCE_DIR = join(
  REPO_ROOT, '.dev-evidence', 'word-common-features', 'WCF-20261002-A', 'D10',
);

/** 三份 fixture 与各自的期望文件。 */
export const FIXTURES = {
  corpusA: {
    docx: join(FIXTURES_DIR, 'corpus-a-independent-deflate.docx'),
    expectation: join(EXPECTATIONS_DIR, 'corpus-a.json'),
    label: 'corpus-a（手工拼 OOXML，DEFLATE）',
  },
  corpusB: {
    docx: join(FIXTURES_DIR, 'corpus-b-independent-deflate.docx'),
    expectation: join(EXPECTATIONS_DIR, 'corpus-b.json'),
    label: 'corpus-b（手工拼 OOXML，DEFLATE）',
  },
  /**
   * **真实 Microsoft Word 保存出来**的语料（WCF-D06 实测本机装有 Word 且 COM 可用）。
   * 冻结产物，构建脚本只校验摘要、不重生成——重生成需要 Word，而 Word 不是可依赖的构建前提。
   */
  wordCorpus: {
    docx: join(FIXTURES_DIR, 'corpus-c-word16-created.docx'),
    expectation: join(EXPECTATIONS_DIR, 'corpus-c.json'),
    label: 'corpus-c（本机 Microsoft Word 16.0.20430 经 COM 保存，DEFLATE）',
  },
  legacyGolden: {
    docx: join(FIXTURES_DIR, 'legacy-golden-potbot-store.docx'),
    expectation: join(EXPECTATIONS_DIR, 'legacy-golden.json'),
    label: 'legacy-golden（FREEZE-6 自产旧样本副本，STORE）',
  },
  /**
   * WCF-D71 新增：引用/审阅元素齐全的手拼语料（与 `reference_corpus_parts()` 同源）。
   * 覆盖书签 / 超链接 / 域 / 脚注尾注 / 批注 / 修订 / OMML / 图表部件。
   */
  referenceCorpus: {
    docx: join(FIXTURES_DIR, 'corpus-d-reference-elements.docx'),
    expectation: join(EXPECTATIONS_DIR, 'corpus-d.json'),
    label: 'corpus-d（手工拼 OOXML，引用/审阅元素齐全，DEFLATE）',
  },
  /**
   * WCF-D71 新增：**potbot 生成器真实产物**（WCF-D60 的 `annotations.docx`）的逐字节副本。
   * 用来证明独立读回器能按新判据读回**生产实现真的写出来的**引用/审阅元素。
   */
  annotationExport: {
    docx: join(FIXTURES_DIR, 'corpus-e-annotation-export.docx'),
    expectation: join(EXPECTATIONS_DIR, 'corpus-e.json'),
    label: 'corpus-e（potbot WCF-D60 产物副本：书签/超链接/域/注记/批注/修订/目录）',
  },
} as const;

/** 变异 kind → 必须抓住它的判据名（与 `verify-docx.py` 的 `MUTATIONS` 一致）。 */
export const MUTATIONS = {
  'drop-rpr': 'expect_run_properties',
  'resize-font': 'expect_run_properties',
  'indent-unit-swap': 'expect_paragraph_indent',
  'break-relationship': 'expect_relationships',
  'drop-unknown-part': 'expect_required_parts',
  'tamper-hash': 'expect_sha256',
} as const;

export type MutationKind = keyof typeof MUTATIONS;

/**
 * WCF-D71 新增：**引用/审阅类**变异 → 必须抓住它的判据。
 *
 * 与 `MUTATIONS` **分开一张表**是有意的：`--list-mutations` 的 `mutations` 键仍然只列原来的
 * 6 个（`mutation-discrimination.test.ts` 会逐条比对，多一个都会红），引用/审阅类出现在同一份
 * 输出里的 `reference_mutations` 键。两组共用 `--mutate <kind>`。
 */
export const REFERENCE_MUTATIONS = {
  'drop-bookmark-end': 'expect_bookmarks',
  'dangling-anchor': 'expect_hyperlinks',
  'drop-footnotes-part': 'expect_note_parts',
  'drop-comments-part': 'expect_comments',
  'unpair-comment-range': 'expect_comments',
  'strip-field-cache': 'expect_fields',
  'mark-field-refreshed': 'expect_fields',
  'flatten-math': 'expect_math_structure',
  'drop-chart-part': 'expect_chart_parts',
  'tamper-revision-author': 'expect_revisions',
  // FA-V 补的 3 个（任务书点名、WCF-D71 未覆盖）
  'drop-field-separate': 'expect_fields',
  'del-text-as-t': 'expect_revisions',
  'break-external-relationship': 'expect_hyperlinks',
} as const;

export type ReferenceMutationKind = keyof typeof REFERENCE_MUTATIONS;

/** 本机 Python 解释器：优先环境变量，其次工程实测路径，最后 PATH 上的 `python`。 */
export function pythonExecutable(): string {
  const fromEnv = process.env['DEMO_PYTHON'];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const known = 'C:/Users/<user>/AppData/Local/Programs/Python/Python313/python.exe';
  if (existsSync(known)) return known;
  return 'python';
}

/**
 * 缺工具就**显式失败**（不 skip、不静默降级）。
 *
 * 判据：python 解释器存在 + 读回器脚本存在 + 三份 fixture 与期望文件齐全。
 */
export function assertToolAvailable(): void {
  const python = pythonExecutable();
  if (python.includes('/') || python.includes('\\')) {
    if (!existsSync(python)) {
      throw new Error(`找不到 Python 解释器：${python}（可设 DEMO_PYTHON 覆盖）`);
    }
  }
  if (!existsSync(VERIFY_DOCX_PY)) {
    throw new Error(`找不到独立读回器：${VERIFY_DOCX_PY}`);
  }
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    if (!existsSync(fixture.docx)) throw new Error(`缺少 fixture ${name}：${fixture.docx}`);
    if (!existsSync(fixture.expectation)) {
      throw new Error(`缺少期望文件 ${name}：${fixture.expectation}`);
    }
  }
}

/** 一次读回器调用的原始结果（**失败也是结果**，不抛异常）。 */
export interface VerifierRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** 解析后的 JSON 载荷；无法解析时为 null（此时 `stdout` 里是原始输出，供报告贴原文）。 */
  readonly parsed: VerifyPayload | null;
  /** 完整命令行（报告里应逐字粘贴）。 */
  readonly command: string;
}

export interface CheckRecord {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface ToggleRead {
  readonly present: boolean;
  readonly val: string | null;
  readonly effective: boolean | null;
}

export interface RunPropertiesRead {
  readonly b?: ToggleRead;
  readonly i?: ToggleRead;
  readonly strike?: ToggleRead;
  readonly u?: { readonly present: boolean; readonly val: string | null };
  readonly vertAlign?: string | null;
  readonly sz?: number | null;
  readonly szCs?: number | null;
  readonly rFonts?: Record<string, string | null> | null;
  readonly color?: { readonly val: string | null } | null;
  readonly highlight?: { readonly val: string | null } | null;
  readonly shd?: {
    readonly val: string | null;
    readonly color: string | null;
    readonly fill: string | null;
  } | null;
}

export interface ParagraphPropertiesRead {
  readonly pStyle?: string | null;
  readonly jc?: string | null;
  readonly spacing?: {
    readonly line: number | null;
    readonly lineRule: string | null;
    readonly before: number | null;
    readonly after: number | null;
    readonly beforeLines: number | null;
    readonly afterLines: number | null;
  } | null;
  readonly indent?: Record<string, number | null> | null;
  readonly outlineLvl?: number | null;
}

export interface ParagraphFormatRead {
  readonly index: number;
  readonly text: string;
  readonly properties: ParagraphPropertiesRead;
  readonly runs: readonly { readonly text: string; readonly properties: RunPropertiesRead }[];
}

export interface FormatRead {
  readonly paragraphs: readonly ParagraphFormatRead[];
  readonly tables: readonly {
    readonly grid: readonly (number | null)[];
    readonly rows: readonly (readonly { readonly text: string; readonly grid_span: number | null }[])[];
  }[];
  readonly sections: readonly {
    readonly page_size: { readonly w: number | null; readonly h: number | null; readonly orient: string | null } | null;
    readonly margins: Record<string, number | null> | null;
    readonly columns: number | null;
  }[];
}

/** OOXML `w:id` 读出来的样子：能解析成整数就是整数，否则原样字符串。 */
export type XmlId = number | string;

export interface BookmarksRead {
  readonly starts: readonly { readonly id: XmlId | null; readonly name: string | null }[];
  readonly ends: readonly XmlId[];
  readonly names: readonly string[];
  readonly paired: boolean;
  readonly unpaired_start_ids: readonly XmlId[];
  readonly unpaired_end_ids: readonly XmlId[];
  readonly duplicate_start_ids: readonly XmlId[];
}

export interface HyperlinkRead {
  readonly index: number;
  readonly kind: 'external' | 'internal' | 'relationship' | 'dangling_relationship' | 'unbound';
  readonly relationship_id: string | null;
  readonly anchor: string | null;
  readonly anchor_resolves: boolean | null;
  readonly tooltip: string | null;
  readonly target: string | null;
  readonly target_mode: string | null;
}

export interface FieldRead {
  readonly kind: 'simple' | 'complex';
  readonly instruction: string | null;
  readonly has_instruction: boolean;
  readonly cached_text: string | null;
  readonly has_cache: boolean;
  readonly dirty: boolean;
  readonly refreshed: boolean;
  readonly state: 'no_instruction' | 'instruction_no_cache' | 'cached_not_refreshed' | 'refreshed';
}

export interface NoteGroupRead {
  readonly part: string;
  readonly present: boolean;
  readonly relationship: boolean;
  readonly reference_ids: readonly XmlId[];
  readonly note_ids: readonly XmlId[];
  readonly has_separators: boolean;
  readonly dangling_reference_ids: readonly XmlId[];
  readonly unreferenced_note_ids: readonly XmlId[];
}

export interface CommentsRead {
  readonly part: string;
  readonly part_present: boolean;
  readonly relationship: boolean;
  readonly range_start_ids: readonly XmlId[];
  readonly range_end_ids: readonly XmlId[];
  readonly reference_ids: readonly XmlId[];
  readonly paired_range_ids: readonly XmlId[];
  readonly unpaired_range_start_ids: readonly XmlId[];
  readonly unpaired_range_end_ids: readonly XmlId[];
  readonly comment_ids: readonly XmlId[];
  readonly dangling_reference_ids: readonly XmlId[];
  readonly unreferenced_comment_ids: readonly XmlId[];
}

export interface RevisionEntryRead {
  readonly kind: 'ins' | 'del';
  readonly id: XmlId | null;
  readonly author: string | null;
  readonly date: string | null;
  readonly text: string;
  readonly uses_del_text: boolean;
}

export interface RevisionsRead {
  readonly ins: number;
  readonly del: number;
  readonly del_text: number;
  readonly del_without_del_text: number;
  readonly authors: readonly string[];
  readonly entries: readonly RevisionEntryRead[];
}

export interface MathRead {
  readonly count: number;
  readonly structures: readonly Record<string, string | null>[];
}

export interface ChartRead {
  readonly part: string;
  readonly relationship_id: string | null;
  readonly relationship: boolean;
  readonly series: number | null;
  readonly points: number | null;
}

export interface ReferencesRead {
  readonly bookmarks: BookmarksRead;
  readonly hyperlinks: readonly HyperlinkRead[];
  readonly external_rels: readonly { readonly id: string; readonly type: string | null; readonly target: string | null }[];
  readonly external_targets: readonly { readonly relationship_id: string | null; readonly target: string | null }[];
  readonly dangling_anchors: readonly string[];
  readonly unbound_hyperlinks: readonly number[];
  readonly fields: readonly FieldRead[];
  readonly field_pairing: {
    readonly begin: number;
    readonly separate: number;
    readonly end: number;
    readonly balanced: boolean;
    readonly unclosed: boolean;
  };
  readonly notes: {
    readonly footnote_references: readonly XmlId[];
    readonly endnote_references: readonly XmlId[];
    readonly footnotes: NoteGroupRead;
    readonly endnotes: NoteGroupRead;
  };
  readonly comments: CommentsRead;
  readonly revisions: RevisionsRead;
  readonly math: MathRead;
  readonly charts: readonly ChartRead[];
}

export interface VerifyPayload {
  readonly ok: boolean;
  readonly path: string;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly checks: readonly CheckRecord[];
  readonly parts: readonly string[];
  readonly byteLength?: number;
  readonly zip: {
    readonly entries: readonly string[];
    readonly bad_entry: string | null;
    readonly entry_details: Record<string, string>;
  } | null;
  readonly document: {
    readonly part: string;
    readonly paragraphs: readonly string[];
    readonly non_empty_count: number;
    readonly title: string | null;
    readonly body: readonly string[];
    readonly presentation?: string | null;
  } | null;
  readonly format: FormatRead | null;
  /** 引用/审阅读回（WCF-D71）。老调用方不读这个键，读回器始终给出。 */
  readonly references?: ReferencesRead | null;
  /** 未解析元素清单：`{部件: [元素 local name...]}`（只列**出现过**的）。 */
  readonly coverage?: Record<string, readonly string[]>;
  /** 已知的读回范围边界（写出来，不让它变成"没报错所以没问题"）。 */
  readonly coverage_notes?: readonly string[];
  readonly expectation: { readonly source: string | null; readonly label: string | null } | null;
}

/** 用 `--configLoader native` 之外的普通 execFileSync 跑读回器；任何退出码都如实返回。 */
function runVerifier(args: readonly string[], timeoutMs: number): VerifierRun {
  const python = pythonExecutable();
  const command = [python, VERIFY_DOCX_PY, ...args].join(' ');
  const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
  try {
    const stdout = execFileSync(python, [VERIFY_DOCX_PY, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      windowsHide: true,
      env,
    });
    return { exitCode: 0, stdout, stderr: '', parsed: parsePayload(stdout), command };
  } catch (error) {
    const withOutput = error as { status?: number | null; stdout?: unknown; stderr?: unknown };
    const exitCode = typeof withOutput.status === 'number' ? withOutput.status : 1;
    const stdout = typeof withOutput.stdout === 'string' ? withOutput.stdout : '';
    const stderr = typeof withOutput.stderr === 'string' ? withOutput.stderr : '';
    return { exitCode, stdout, stderr, parsed: parsePayload(stdout), command };
  }
}

function parsePayload(stdout: string): VerifyPayload | null {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed) as VerifyPayload;
  } catch {
    return null;
  }
}

/** 无期望文件的读回（只跑基础判据 + 格式解析）。 */
export function verifyPlain(docxPath: string): VerifierRun {
  return runVerifier([docxPath], 60_000);
}

/** 带期望文件的读回（额外跑 `expect_*` 判据）。 */
export function verifyWithExpectation(docxPath: string, expectationPath: string): VerifierRun {
  return runVerifier([docxPath, '--expect', expectationPath], 60_000);
}

/** 跑工具自检：对照必须绿、6 个变异必须各自被对应判据抓住。 */
export function runSelfTest(): VerifierRun {
  return runVerifier(['--self-test'], 120_000);
}

/**
 * 对**任意** DOCX 施加具名变异，写到 `destination`。返回退出码 3 = 变异不可应用（非静默）。
 * 两组变异（基础组与引用/审阅组）共用这一个入口。
 */
export function mutate(
  kind: MutationKind | ReferenceMutationKind,
  source: string,
  destination: string,
): VerifierRun {
  return runVerifier(['--mutate', kind, source, destination], 60_000);
}

/** 读回器自己声明的变异登记表（用于校验本文件的 `MUTATIONS` 没和工具脱节）。 */
export function listMutations(): { readonly kind: string; readonly expected_check: string }[] {
  const run = runVerifier(['--list-mutations'], 60_000);
  if (run.exitCode !== 0 || run.parsed === null) {
    throw new Error(`--list-mutations 失败（退出码 ${run.exitCode}）：${run.stdout.slice(0, 400)}`);
  }
  return (run.parsed as unknown as {
    mutations: { kind: string; expected_check: string }[];
  }).mutations;
}

/** 同一份 `--list-mutations` 输出里的**引用/审阅组**（WCF-D71 新增）。 */
export function listReferenceMutations(): { readonly kind: string; readonly expected_check: string }[] {
  const run = runVerifier(['--list-mutations'], 60_000);
  if (run.exitCode !== 0 || run.parsed === null) {
    throw new Error(`--list-mutations 失败（退出码 ${run.exitCode}）：${run.stdout.slice(0, 400)}`);
  }
  const payload = run.parsed as unknown as {
    reference_mutations?: { kind: string; expected_check: string }[];
  };
  if (payload.reference_mutations === undefined) {
    throw new Error('--list-mutations 输出里没有 reference_mutations 键（读回器版本过旧？）');
  }
  return payload.reference_mutations;
}

/** 读 JSON（期望文件 / 构建清单）。 */
export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** 取某条判据；不存在则抛错（判据缺失本身即失败，不得当作 pass）。 */
export function checkByName(run: VerifierRun, name: string): CheckRecord {
  const checks = run.parsed?.checks ?? [];
  const found = checks.find((item) => item.name === name);
  if (found === undefined) {
    throw new Error(
      `判据 ${name} 不存在于读回结果里。实际判据：${checks.map((item) => item.name).join(', ')}`
      + `（退出码 ${run.exitCode}）\n原始输出：${run.stdout.slice(0, 800)}`,
    );
  }
  return found;
}

/** 失败判据名（升序）。 */
export function failedChecks(run: VerifierRun): string[] {
  return (run.parsed?.checks ?? []).filter((item) => !item.passed).map((item) => item.name).sort();
}

/** 取第 index 段（越界抛错，绝不返回 undefined 当通过）。 */
export function paragraphAt(format: FormatRead | null, index: number): ParagraphFormatRead {
  const found = format?.paragraphs[index];
  if (found === undefined) {
    throw new Error(`格式读回里没有第 ${index} 段（共 ${format?.paragraphs.length ?? 0} 段）`);
  }
  return found;
}

/** 取第 paragraphIndex 段的第 runIndex 个 run（越界抛错）。 */
export function runAt(paragraph: ParagraphFormatRead, runIndex: number) {
  const found = paragraph.runs[runIndex];
  if (found === undefined) {
    throw new Error(`第 ${paragraph.index} 段没有第 ${runIndex} 个 run（共 ${paragraph.runs.length} 个）`);
  }
  return found;
}

/**
 * 测试自动落盘的证据子目录（`<D10>/auto/`）。
 *
 * **刻意只清 `auto/` 子目录，不碰 D10 根**：根目录还放着手工捕获的命令原始输出
 * （`cmd1-*.txt` / `cmd2-*.txt`），清根会把它们连同"正在重定向到根目录的这次运行的日志"
 * 一起删掉——这个坑已经踩过一次。
 */
export const EVIDENCE_AUTO_DIR = join(EVIDENCE_DIR, 'auto');

/**
 * 清空并重建 `auto/` 子目录，返回其路径。
 *
 * 带重试：Windows 上刚结束的测试进程可能仍持有该目录下的句柄，一次性 `rmSync` 会偶发
 * EPERM/EBUSY，进而让**整个测试文件**在 `beforeAll` 阶段失败（踩过一次，表现为
 * `FAIL <file> [ <file> ]`）。验收套件不允许这种抖动。
 */
export function resetEvidenceAutoDir(): string {
  rmSync(EVIDENCE_AUTO_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  mkdirSync(EVIDENCE_AUTO_DIR, { recursive: true });
  return EVIDENCE_AUTO_DIR;
}
