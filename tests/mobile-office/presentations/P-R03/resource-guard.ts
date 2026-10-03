/**
 * P-R03 · 演示域**资源护栏**（大媒体 / 长文稿 / 低内存 / 取消 / 失败保旧）。
 *
 * ## 这一层解决什么
 *
 * 手机端演示内核要在**资源受限**（RAM / 存储 / 单份媒体体积）和**用户随时取消**的条件下
 * 编辑并写回 PPTX。既有的 `src/presentations/` 已经给出了正确的**写回语义**：
 *
 * - `savePresentationFile` / `savePresentationFileAs` 是**纯函数**（见 `roundtrip.ts` 文件头），
 *   "保存失败 ⇒ 旧字节仍在"是**结构性**的，而不是靠调用方回滚；
 * - `exportImportedPresentation` 只重渲染**确实变了的那几页**，其余部件**逐字节保留**
 *   （长文稿的增量写回因此不会把整份文件重造一遍）；
 * - `buildMediaDeck` 在返回字节**之前**做媒体成对校验，校验不过**不返回半成品**。
 *
 * 但把这些原语直接用在一个"大媒体 + 长文稿"的移动端会话里，还缺一层**准入/护栏**：
 * 什么时候**在分配输出之前**就拒绝、什么时候**拒绝采纳**一个已经生成但超预算的产物、
 * 取消发生在写之前/写之后分别该如何、以及失败时如何**可断言**地证明旧产物没被换掉。
 * 本模块只做这层护栏，**不重写**任何渲染/导出/部件保真逻辑（那些是 P01/P05 的唯一写者）。
 *
 * ## 与既有模块的边界（重要）
 *
 * - 本模块**不**修改 `src/presentations/**` 的任何文件；只调用其公开出口。
 * - 本模块**只**读 `src/presentations/`，把既有原语编排成"护栏下的一步"。
 * - 因此本模块**不**产生任何新的 PPTX 部件或关系——它只决定"这一步要不要做、产物要不要采纳"。
 *
 * ## 关键不变量
 *
 * 1. **失败保旧**：`guardedSave` 在任何失败分支返回的 `file` 与入参 `file` **字节摘要相等**
 *    （`preserved_old === true`）；若某次失败后摘要不等，本模块**抛内部错误**而不是返回一个
 *    被悄悄换掉的"旧"文件——把静默损坏变成可听见的错误。
 * 2. **低内存硬门**：产物字节数超过 `max_output_bytes` 时**不采纳**，即使它已经生成成功；
 *    旧文件保持可读（`roundtrip.ts` 的纯函数语义保证）。
 * 3. **大媒体先拦**：`guardedBuildDeck` 在**调用渲染之前**先按媒体目录判预算；这样"超大媒体"
 *    根本不会被编码进输出，而不是先撑爆内存再报错。
 * 4. **取消两处检查**：写之前（准入）+ 写之前再确认一次；写完成之后若调用方已取消，
 *    同样**不采纳**产物（产物不入会话）。
 */

import { digestBytes } from '../../../../src/artifacts/digest.js';
import { openPresentation } from '../../../../src/presentations/import.js';
import { buildMediaDeck } from '../../../../src/presentations/media.js';
import type { MediaCatalog } from '../../../../src/presentations/media.js';
import type { Presentation } from '../../../../src/presentations/model.js';
import {
  comparePresentationFiles,
  savePresentationFile,
} from '../../../../src/presentations/roundtrip.js';
import type { PresentationFile } from '../../../../src/presentations/roundtrip.js';

// ---------------------------------------------------------------------------
// 预算与错误
// ---------------------------------------------------------------------------

/** 一次演示写回/生成所允许的资源上限（全部为**硬上限**，超出即拒绝，不降级）。 */
export interface PresentationResourceBudget {
  /** 采纳的产物字节数上限（低内存硬门：超过就不进会话）。 */
  readonly max_output_bytes: number;
  /** 单个媒体部件字节数上限（大媒体先拦）。 */
  readonly max_media_part_bytes: number;
  /** 全部媒体部件字节数之和的上限。 */
  readonly max_media_total_bytes: number;
  /** 幻灯片页数上限（长文稿护栏）。 */
  readonly max_slides: number;
}

/** 预算被打破的一条事实：哪条上限、实际多少、上限多少。 */
export interface BudgetViolation {
  readonly limit: keyof PresentationResourceBudget;
  readonly actual: number;
  readonly max: number;
}

/** 护栏错误原因。 */
export type ResourceGuardErrorReason = 'cancelled' | 'budget_exceeded' | 'write_failed' | 'render_failed';

/** 护栏错误：凡护栏拦下的步骤都经此报出，**不静默降级**。 */
export class ResourceGuardError extends Error {
  readonly reason: ResourceGuardErrorReason;
  readonly violations: readonly BudgetViolation[];

  constructor(
    reason: ResourceGuardErrorReason,
    message: string,
    violations: readonly BudgetViolation[] = [],
    options?: { readonly cause?: unknown },
  ) {
    super(message);
    this.name = 'ResourceGuardError';
    this.reason = reason;
    this.violations = Object.freeze([...violations]);
    if (options !== undefined && 'cause' in options) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** 取消令牌：只读视图，供被编排的步骤查询。 */
export interface CancellationToken {
  readonly is_cancelled: boolean;
  /** 已取消则抛 `ResourceGuardError('cancelled')`，否则什么也不做。 */
  throw_if_cancelled(): void;
}

/** 取消控制器：持有令牌，调用方在任意时刻 `cancel()`。 */
export interface CancellationController {
  readonly token: CancellationToken;
  cancel(reason?: string): void;
}

/** 建一个取消控制器（与 AbortController 同形，但不依赖宿主环境）。 */
export function createCancellation(): CancellationController {
  let cancelled = false;
  let reason = '用户取消';
  const token: CancellationToken = Object.freeze({
    get is_cancelled(): boolean {
      return cancelled;
    },
    throw_if_cancelled(): void {
      if (cancelled) {
        throw new ResourceGuardError('cancelled', reason);
      }
    },
  });
  return Object.freeze({
    token,
    cancel(next = '用户取消'): void {
      cancelled = true;
      reason = next;
    },
  });
}

// ---------------------------------------------------------------------------
// 资源测量（**对真实字节**）
// ---------------------------------------------------------------------------

/** 一份 PPTX 的资源画像（全部来自真实部件，不是声明值）。 */
export interface PresentationResourceUsage {
  /** 整份文件的字节数（`bytes.length`）。 */
  readonly total_bytes: number;
  /** 归档条目数（部件数）。 */
  readonly part_count: number;
  /** 幻灯片部件数（= 页数）。 */
  readonly slide_count: number;
  /** `ppt/media/**` 部件数。 */
  readonly media_part_count: number;
  /** 全部媒体部件字节数之和。 */
  readonly media_total_bytes: number;
  /** 最大单个媒体部件的字节数。 */
  readonly largest_media_part_bytes: number;
}

/** 媒体目录的资源画像。 */
export interface MediaBudgetUsage {
  readonly part_count: number;
  readonly total_bytes: number;
  readonly largest_part_bytes: number;
}

/**
 * 测量一份 PPTX 的资源画像（页数 / 部件数 / 媒体字节）。
 *
 * 依赖 `openPresentation` 的真实解归档——同一份函数既用于"输入文件"也用于"输出产物"，
 * 因此护栏的前后测量口径一致。
 */
export function measurePresentationUsage(bytes: Uint8Array): PresentationResourceUsage {
  const opened = openPresentation(bytes);
  let mediaTotal = 0;
  let mediaCount = 0;
  let largest = 0;
  for (const path of opened.media_part_paths) {
    const entry = opened.by_path.get(path);
    if (entry === undefined) {
      continue;
    }
    const size = entry.data.length;
    mediaTotal += size;
    mediaCount += 1;
    if (size > largest) {
      largest = size;
    }
  }
  return Object.freeze({
    total_bytes: bytes.length,
    part_count: opened.entries.length,
    slide_count: opened.slide_part_paths.length,
    media_part_count: mediaCount,
    media_total_bytes: mediaTotal,
    largest_media_part_bytes: largest,
  });
}

/** 测量一份媒体目录（渲染**之前**就能算，是大媒体先拦的依据）。 */
export function measureMediaCatalog(catalog: MediaCatalog): MediaBudgetUsage {
  let total = 0;
  let largest = 0;
  for (const part of catalog.parts) {
    const size = part.bytes.length;
    total += size;
    if (size > largest) {
      largest = size;
    }
  }
  return Object.freeze({ part_count: catalog.parts.length, total_bytes: total, largest_part_bytes: largest });
}

// ---------------------------------------------------------------------------
// 预算判定（纯函数）
// ---------------------------------------------------------------------------

/** 参与预算判定的四个量（`PresentationResourceUsage` 结构上即满足）。 */
export interface BudgetSubject {
  readonly total_bytes: number;
  readonly slide_count: number;
  readonly media_total_bytes: number;
  readonly largest_media_part_bytes: number;
}

/** 把媒体目录画像伪装成预算主体（输出字节未知时 `total_bytes = 0`，不误判输出上限）。 */
export function mediaSubject(usage: MediaBudgetUsage, slideCount: number): BudgetSubject {
  return {
    total_bytes: 0,
    slide_count: slideCount,
    media_total_bytes: usage.total_bytes,
    largest_media_part_bytes: usage.largest_part_bytes,
  };
}

/** 逐条比较上限，返回全部被打破的项（空数组 = 通过）。 */
export function evaluateBudget(subject: BudgetSubject, budget: PresentationResourceBudget): readonly BudgetViolation[] {
  const violations: BudgetViolation[] = [];
  if (subject.total_bytes > budget.max_output_bytes) {
    violations.push({ limit: 'max_output_bytes', actual: subject.total_bytes, max: budget.max_output_bytes });
  }
  if (subject.slide_count > budget.max_slides) {
    violations.push({ limit: 'max_slides', actual: subject.slide_count, max: budget.max_slides });
  }
  if (subject.media_total_bytes > budget.max_media_total_bytes) {
    violations.push({ limit: 'max_media_total_bytes', actual: subject.media_total_bytes, max: budget.max_media_total_bytes });
  }
  if (subject.largest_media_part_bytes > budget.max_media_part_bytes) {
    violations.push({
      limit: 'max_media_part_bytes',
      actual: subject.largest_media_part_bytes,
      max: budget.max_media_part_bytes,
    });
  }
  return Object.freeze(violations);
}

function describeViolations(violations: readonly BudgetViolation[]): string {
  return violations.map((v) => `${v.limit}: 实际 ${String(v.actual)} > 上限 ${String(v.max)}`).join('；');
}

// ---------------------------------------------------------------------------
// 增量写回报告（长文稿：只有被改的页换字节）
// ---------------------------------------------------------------------------

/** 一次"导入—编辑—写回"实际换了哪些部件（对真实字节）。 */
export interface IncrementalWriteReport {
  readonly identical: boolean;
  readonly changed_part_paths: readonly string[];
  readonly unchanged_part_count: number;
  readonly before_slide_count: number;
  readonly after_slide_count: number;
}

/** 按部件字节给出增量写回报告（复用 `comparePresentationFiles` 的真实比对）。 */
export function incrementalWriteReport(before: Uint8Array, after: Uint8Array): IncrementalWriteReport {
  const comparison = comparePresentationFiles(before, after);
  return Object.freeze({
    identical: comparison.identical,
    changed_part_paths: comparison.changed_part_paths,
    unchanged_part_count: comparison.unchanged_part_count,
    before_slide_count: comparison.before_slide_count,
    after_slide_count: comparison.after_slide_count,
  });
}

// ---------------------------------------------------------------------------
// 护栏下的文件保存（失败保旧 / 取消 / 低内存硬门）
// ---------------------------------------------------------------------------

/** 一次护栏保存的结果。 */
export type GuardedSaveOutcome = 'saved' | 'cancelled' | 'budget_exceeded' | 'write_failed';

export interface GuardedSaveResult {
  /** 采纳后的文件（成功）或**原样旧文件**（失败/取消/超预算）。 */
  readonly file: PresentationFile;
  readonly adopted: boolean;
  /** 失败时旧产物是否**逐字节**保持（摘要相等）。成功时为 `false`。 */
  readonly preserved_old: boolean;
  readonly outcome: GuardedSaveOutcome;
  readonly error: ResourceGuardError | null;
  readonly usage_before: PresentationResourceUsage;
  readonly usage_after: PresentationResourceUsage | null;
}

export interface GuardedSaveInput {
  readonly file: PresentationFile;
  /** 编辑后的模型；缺省 = 当前模型（原样保存）。 */
  readonly edited?: Presentation;
  readonly budget: PresentationResourceBudget;
  readonly token?: CancellationToken;
}

/**
 * 护栏下保存一份演示文件。**永不抛出**护栏错误（作为结果返回），因此调用方总能看到
 * "旧文件还在不在"。
 *
 * 顺序：取消 → 按**编辑后页数 + 现有媒体**做准入 → 再确认取消 → 真实写回 → 输出预算硬门 →
 * （写后被取消则同样不采纳）→ 采纳。
 *
 * `write_failed` 覆盖底层导出器的具名拒绝（例如给导入件增删页 ⇒ `slide_set_changed`）；
 * 此时 `file` 是原样旧文件、`preserved_old === true`——这就是 PPT-14「失败保旧」在护栏层的落点。
 */
export function guardedSave(input: GuardedSaveInput): GuardedSaveResult {
  const oldBytes = input.file.bytes;
  const oldDigest = digestBytes(oldBytes);
  const usageBefore = measurePresentationUsage(oldBytes);

  const failure = (outcome: GuardedSaveOutcome, error: ResourceGuardError): GuardedSaveResult => {
    const preserved = digestBytes(input.file.bytes) === oldDigest;
    if (!preserved) {
      // 不变量 1：失败分支绝不允许旧字节被换掉。若发生，说明底层不再是纯函数语义。
      throw new Error('护栏内部不变量破坏：失败分支的旧文件字节摘要发生变化（底层写回不再是纯函数语义）');
    }
    return Object.freeze({
      file: input.file,
      adopted: false,
      preserved_old: true,
      outcome,
      error,
      usage_before: usageBefore,
      usage_after: null,
    });
  };

  try {
    input.token?.throw_if_cancelled();
  } catch (error) {
    return failure('cancelled', asGuardError(error, 'cancelled'));
  }

  // 准入：编辑后的页数 + 现有媒体规模。total_bytes 用**输入**大小（输出的下界）近似，
  // 真正对输出大小的硬门在写完成后（低内存硬门）。
  const editedSlides = (input.edited ?? input.file.presentation).slides.length;
  const admissionSubject: BudgetSubject = {
    total_bytes: usageBefore.total_bytes,
    slide_count: editedSlides,
    media_total_bytes: usageBefore.media_total_bytes,
    largest_media_part_bytes: usageBefore.largest_media_part_bytes,
  };
  const admissionViolations = evaluateBudget(admissionSubject, input.budget);
  if (admissionViolations.length > 0) {
    return failure(
      'budget_exceeded',
      new ResourceGuardError('budget_exceeded', `准入即超预算，未写回：${describeViolations(admissionViolations)}`, admissionViolations),
    );
  }

  // 写前再确认一次取消（长文稿的准备阶段可能耗时）。
  try {
    input.token?.throw_if_cancelled();
  } catch (error) {
    return failure('cancelled', asGuardError(error, 'cancelled'));
  }

  let next: PresentationFile;
  try {
    next = savePresentationFile(input.file, input.edited);
  } catch (error) {
    return failure(
      'write_failed',
      new ResourceGuardError('write_failed', `写回失败（旧产物保留）：${messageOf(error)}`, [], { cause: error }),
    );
  }

  // 低内存硬门：产物再大也不采纳。
  const usageAfter = measurePresentationUsage(next.bytes);
  const outputViolations = evaluateBudget(usageAfter, input.budget);
  if (outputViolations.length > 0) {
    return failure(
      'budget_exceeded',
      new ResourceGuardError(
        'budget_exceeded',
        `产物超预算，不采纳（旧产物保留）：${describeViolations(outputViolations)}`,
        outputViolations,
      ),
    );
  }

  // 写完成但调用方已取消：产物同样不入会话。
  if (input.token?.is_cancelled === true) {
    return failure('cancelled', new ResourceGuardError('cancelled', '写入完成后被取消，产物未采纳'));
  }

  return Object.freeze({
    file: next,
    adopted: true,
    preserved_old: false,
    outcome: 'saved',
    error: null,
    usage_before: usageBefore,
    usage_after: usageAfter,
  });
}

function asGuardError(error: unknown, fallbackReason: ResourceGuardErrorReason): ResourceGuardError {
  if (error instanceof ResourceGuardError) {
    return error;
  }
  return new ResourceGuardError(fallbackReason, messageOf(error), [], { cause: error });
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

// ---------------------------------------------------------------------------
// 护栏下的媒体文稿生成（大媒体先拦 / 低内存硬门 / 取消）
// ---------------------------------------------------------------------------

export type GuardedBuildOutcome = 'built' | 'cancelled' | 'budget_exceeded' | 'render_failed';

export interface GuardedBuildResult {
  /** 成功时的产物字节；任何失败/取消/超预算分支均为 `null`（**不返回半成品**）。 */
  readonly bytes: Buffer | null;
  readonly outcome: GuardedBuildOutcome;
  readonly error: ResourceGuardError | null;
  readonly usage: PresentationResourceUsage | null;
  readonly media_usage: MediaBudgetUsage;
}

export interface GuardedBuildInput {
  readonly presentation: Presentation;
  readonly catalog: MediaCatalog;
  readonly budget: PresentationResourceBudget;
  readonly token?: CancellationToken;
}

/**
 * 护栏下生成一份含媒体的演示。
 *
 * 与 `guardedSave` 的区别在于**输入侧还没有成品字节**：这里"旧产物"是调用方手上的上一版，
 * 本函数超预算/失败时**返回 `bytes: null`**，绝不返回一个超预算或半成品字节串。
 *
 * 大媒体先拦：媒体目录的**单件/合计**字节在**调用渲染之前**判定；即便文稿里引用了缺失媒体
 * （渲染本会失败），只要媒体目录已超预算，结果也是 `budget_exceeded` 而非 `render_failed`
 * ——这条顺序由测试里"有缺失媒体 + 超预算"的用例钉死。
 */
export function guardedBuildDeck(input: GuardedBuildInput): GuardedBuildResult {
  const mediaUsage = measureMediaCatalog(input.catalog);
  const slideCount = input.presentation.slides.length;

  const cancelled = (error: ResourceGuardError): GuardedBuildResult =>
    Object.freeze({ bytes: null, outcome: 'cancelled', error, usage: null, media_usage: mediaUsage });
  const overBudget = (violations: readonly BudgetViolation[]): GuardedBuildResult =>
    Object.freeze({
      bytes: null,
      outcome: 'budget_exceeded',
      error: new ResourceGuardError('budget_exceeded', `生成前超预算：${describeViolations(violations)}`, violations),
      usage: null,
      media_usage: mediaUsage,
    });

  try {
    input.token?.throw_if_cancelled();
  } catch (error) {
    return cancelled(asGuardError(error, 'cancelled'));
  }

  const preViolations = evaluateBudget(mediaSubject(mediaUsage, slideCount), input.budget);
  if (preViolations.length > 0) {
    return overBudget(preViolations);
  }

  try {
    input.token?.throw_if_cancelled();
  } catch (error) {
    return cancelled(asGuardError(error, 'cancelled'));
  }

  let built: ReturnType<typeof buildMediaDeck>;
  try {
    built = buildMediaDeck(input.presentation, input.catalog);
  } catch (error) {
    return Object.freeze({
      bytes: null,
      outcome: 'render_failed',
      error: new ResourceGuardError('render_failed', `渲染失败（无产物返回）：${messageOf(error)}`, [], { cause: error }),
      usage: null,
      media_usage: mediaUsage,
    });
  }

  const usage = measurePresentationUsage(built.bytes);
  const postViolations = evaluateBudget(usage, input.budget);
  if (postViolations.length > 0) {
    return overBudget(postViolations);
  }

  if (input.token?.is_cancelled === true) {
    return cancelled(new ResourceGuardError('cancelled', '渲染完成后被取消，产物未采纳'));
  }

  return Object.freeze({ bytes: built.bytes, outcome: 'built', error: null, usage, media_usage: mediaUsage });
}
