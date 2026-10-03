/**
 * **演示（PPTX）交付适配器**（design-06 P9；合同 R232 / R247 / R249 / R250）。
 *
 * 把 `src/presentations/**` 的能力接进通用交付会话：源 = 演示模型（+ 导入时保留的整包），
 * 导出 = `renderPresentation`（从零建）或 `exportImportedPresentation`（在既有包上只换被改页）。
 *
 * ## R250：不得固定两页
 *
 * 页数由**模型**决定，模型由调用方编辑决定。`add_slide` / `remove_slide` 是产品入口上的
 * 一等操作——"固定两页"因此在本适配器上不可能发生。
 *
 * ## R249：既有文件的未知部件保留
 *
 * 从字节导入时走 `importPresentation`（保留 `OpenedPresentation` 的**全部原始部件**），
 * 导出时走 `exportImportedPresentation`（**只有确实变了的那几页换字节**）。
 *
 * **如实登记的边界**：`exportImportedPresentation` 明确拒绝**增删页**
 * （`slide_set_changed`，见 `src/presentations/roundtrip.ts`：增删页要重建 `presentation.xml`
 * 与其 `_rels` 并登记新部件，该流程尚未封装）。因此"在**导入的**演示上增删页"会以
 * 结构化失败收场，而不是静默产出一份丢了未知部件的文件。
 *
 * 本适配器是**纯的**：零 IO、零墙钟、零随机数。
 */

import { digestBytes } from '../../artifacts/digest.js';
import type { TemplateKind } from '../../protocol/index.js';
import {
  type FactSnapshot,
  type ImportedPresentation,
  type Presentation,
  type TextBody,
  SLIDE_SIZE_4_3,
  addShape,
  addSlide,
  emptyPresentation,
  exportImportedPresentation,
  importPresentation,
  literalText,
  nextAvailableShapeId,
  openPresentation,
  removeSlide,
  renderPresentation,
  setShapeText,
  setSlideNotes,
  transform,
} from '../../presentations/index.js';
import type {
  AdapterEditResult,
  AdapterExportResult,
  AdapterImportResult,
  DeliverableAdapter,
} from '../adapter.js';
import type { FileFormat } from '../formats.js';

/**
 * 演示交付的源。
 *
 * `imported` 非空表示源来自一份既有 PPTX：导出必须走"只换被改页"的保留路径（R249）。
 * 从零新建的源为 `null`，导出按模型整体重建（页数由模型决定）。
 */
export interface PptxDeliverableSource {
  readonly presentation: Presentation;
  readonly imported: ImportedPresentation | null;
  /**
   * **事实快照**（PPT-16）：非空时导出会把文本/表格里的 `fact` 引用对着它求值，
   * 从而与图表、表格使用**同一版**事实。缺省（`undefined`）等价于空快照——与
   * `importPresentation` 的字面量口径一致，既有调用方行为不变（纯增量字段）。
   *
   * 该字段是**可选新增**：不改变四 op 的封闭枚举，也不改变 `exportBytes` 在缺省时的产物。
   */
  readonly factSnapshot?: FactSnapshot;
}

/** 标题框在 4:3 版面上的默认几何（EMU；0.5in 左边距、0.3in 上边距、9in × 1.25in）。 */
const TITLE_BOX = Object.freeze({
  x: 457200,
  y: 274638,
  cx: 8229600,
  cy: 1143000,
});

/** 新建一份空演示（0 页；**不是**固定两页）。 */
export function emptyPresentationSource(presentationId: string, title: string): PptxDeliverableSource {
  return Object.freeze({ presentation: emptyPresentation(presentationId, title), imported: null });
}

/**
 * **产品入口上的演示编辑**（封闭枚举）。
 *
 * 页用 `slide_id` 定位（模型里的稳定标识），不用页码——页码会随增删页漂移，
 * 而"改第 2 页"在一页被删掉之后会指向别的内容（静默改错地方是最难查的故障）。
 */
export type PptxEdit =
  | {
      readonly op: 'add_slide';
      /** 新页上的标题文本框文字（空串 = 只要一个空白页，但**仍会建一个文本框**：空页渲染会报错）。 */
      readonly title: string;
      readonly at?: number;
    }
  | { readonly op: 'set_slide_title'; readonly slide_id: number; readonly text: string }
  | { readonly op: 'remove_slide'; readonly slide_id: number }
  | {
      readonly op: 'set_slide_notes';
      readonly slide_id: number;
      /** `null` = 删掉备注。 */
      readonly text: string | null;
    };

// ---------------------------------------------------------------------------
// 内部
// ---------------------------------------------------------------------------

function findSlide(presentation: Presentation, slideId: number) {
  return presentation.slides.find((slide) => slide.slide_id === slideId);
}

/** 在页内（含组合内部）按 z 序找第一个文本框的 shape_id。 */
function findFirstTextBoxId(shapes: readonly unknown[]): number | null {
  for (const raw of shapes) {
    const shape = raw as { readonly kind?: unknown; readonly shape_id?: unknown };
    if (shape.kind === 'text_box' && typeof shape.shape_id === 'number') return shape.shape_id;
  }
  for (const raw of shapes) {
    const children = (raw as { readonly children?: unknown }).children;
    if (Array.isArray(children)) {
      const nested = findFirstTextBoxId(children);
      if (nested !== null) return nested;
    }
  }
  return null;
}

function applyPptxEdit(
  source: PptxDeliverableSource,
  edit: unknown,
): AdapterEditResult<PptxDeliverableSource> {
  if (typeof edit !== 'object' || edit === null) {
    return { ok: false, kind: 'invalid_edit', detail: '编辑必须是一个对象' };
  }
  const record = edit as Record<string, unknown>;
  const op = record['op'];
  const presentation = source.presentation;
  try {
    switch (op) {
      case 'add_slide': {
        const title = typeof record['title'] === 'string' ? record['title'] : '';
        const at = record['at'];
        if (at !== undefined && (typeof at !== 'number' || !Number.isInteger(at))) {
          return { ok: false, kind: 'invalid_edit', detail: 'at 必须是整数页码下标' };
        }
        const added = addSlide(presentation, at === undefined ? {} : { at });
        const shapeId = nextAvailableShapeId(added.presentation, added.slide_id);
        const withBox = addShape(added.presentation, added.slide_id, {
          kind: 'text_box',
          shape_id: shapeId,
          name: '标题',
          transform: transform(TITLE_BOX.x, TITLE_BOX.y, TITLE_BOX.cx, TITLE_BOX.cy),
          text: literalText(title),
        });
        return {
          ok: true,
          source: { ...source, presentation: withBox },
          changed: true,
          notes: Object.freeze([`新增第 ${String(withBox.slides.length)} 页（slide_id=${String(added.slide_id)}）`]),
        };
      }
      case 'set_slide_title': {
        const slideId = record['slide_id'];
        const text = record['text'];
        if (typeof slideId !== 'number' || !Number.isInteger(slideId)) {
          return { ok: false, kind: 'invalid_edit', detail: 'slide_id 必须是整数' };
        }
        if (typeof text !== 'string') {
          return { ok: false, kind: 'invalid_edit', detail: 'text 必须是字符串' };
        }
        const slide = findSlide(presentation, slideId);
        if (slide === undefined) {
          return { ok: false, kind: 'unknown_slide', detail: `没有 slide_id=${String(slideId)} 这一页` };
        }
        const shapeId = findFirstTextBoxId(slide.shapes);
        if (shapeId === null) {
          return {
            ok: false,
            kind: 'no_text_box',
            detail: `第 ${String(slideId)} 页没有文本框：本操作只改既有文本框，不替用户决定版面`,
          };
        }
        const next = setShapeText(presentation, slideId, shapeId, literalText(text));
        return {
          ok: true,
          source: { ...source, presentation: next },
          changed: true,
          notes: Object.freeze([`slide_id=${String(slideId)} 的标题已更新`]),
        };
      }
      case 'remove_slide': {
        const slideId = record['slide_id'];
        if (typeof slideId !== 'number' || !Number.isInteger(slideId)) {
          return { ok: false, kind: 'invalid_edit', detail: 'slide_id 必须是整数' };
        }
        if (findSlide(presentation, slideId) === undefined) {
          return { ok: false, kind: 'unknown_slide', detail: `没有 slide_id=${String(slideId)} 这一页` };
        }
        return {
          ok: true,
          source: { ...source, presentation: removeSlide(presentation, slideId) },
          changed: true,
          notes: Object.freeze([`删除 slide_id=${String(slideId)}`]),
        };
      }
      case 'set_slide_notes': {
        const slideId = record['slide_id'];
        const text = record['text'];
        if (typeof slideId !== 'number' || !Number.isInteger(slideId)) {
          return { ok: false, kind: 'invalid_edit', detail: 'slide_id 必须是整数' };
        }
        if (text !== null && typeof text !== 'string') {
          return { ok: false, kind: 'invalid_edit', detail: 'text 必须是字符串或 null' };
        }
        if (findSlide(presentation, slideId) === undefined) {
          return { ok: false, kind: 'unknown_slide', detail: `没有 slide_id=${String(slideId)} 这一页` };
        }
        const notes: TextBody | null = text === null ? null : literalText(text);
        return {
          ok: true,
          source: { ...source, presentation: setSlideNotes(presentation, slideId, notes) },
          changed: true,
          notes: Object.freeze([`slide_id=${String(slideId)} 的备注已更新`]),
        };
      }
      default:
        return {
          ok: false,
          kind: 'unsupported_op',
          detail: `不支持的演示操作 ${JSON.stringify(String(op))}（封闭枚举：add_slide / set_slide_title / remove_slide / set_slide_notes）`,
        };
    }
  } catch (error) {
    return { ok: false, kind: 'invalid_edit', detail: describe(error) };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** 演示交付适配器（唯一实例）。 */
export const pptxDeliverableAdapter: PptxDeliverableAdapter = Object.freeze({
  format: 'pptx' as FileFormat,
  template_kind: 'presentation' as TemplateKind,
  describe(source: PptxDeliverableSource): string {
    const pages = source.presentation.slides.length;
    const origin = source.imported === null ? '新建' : '导入的既有演示';
    return `${String(pages)} 页（${origin}）`;
  },
  exportBytes(source: PptxDeliverableSource): AdapterExportResult {
    try {
      const factOptions =
        source.factSnapshot === undefined ? undefined : { fact_snapshot: source.factSnapshot };
      if (source.imported === null) {
        const rendered = renderPresentation(source.presentation, factOptions);
        return {
          ok: true,
          bytes: rendered.bytes,
          entry_count: rendered.entry_count,
          digest: rendered.content_digest,
        };
      }
      const saved = exportImportedPresentation(source.imported, source.presentation, factOptions);
      return {
        ok: true,
        bytes: saved.bytes,
        entry_count: saved.entry_count,
        digest: saved.content_digest,
      };
    } catch (error) {
      return {
        ok: false,
        kind: reasonOf(error),
        detail: describe(error),
      };
    }
  },
  applyEdit: applyPptxEdit,
  importBytes(bytes: Uint8Array): AdapterImportResult<PptxDeliverableSource> {
    try {
      const imported = importPresentation(bytes);
      return {
        ok: true,
        source: Object.freeze({ presentation: imported.presentation, imported }),
      };
    } catch (error) {
      return { ok: false, kind: reasonOf(error), detail: describe(error) };
    }
  },
  guardedSave(source: PptxDeliverableSource, options: PptxGuardedSaveOptions): GuardedPptxSaveResult {
    return guardedSavePptx({ source, ...options });
  },
});

/**
 * 会话层可登记的**护栏保存操作种类**（封闭枚举；P-I23）。
 *
 * `guarded_save` = 一次受预算 / 取消护栏约束的保存；`cancel_save` = 在保存前 / 保存中取消。
 * 这两个名字是**给会话层的注册表用的稳定标识**（`src/session/session.ts` /
 * `src/mobile-plugins/presentations/session/**` 的操作登记待接线——见文件尾残差）。
 */
export const PPTX_GUARDED_SAVE_OPERATIONS = Object.freeze(['guarded_save', 'cancel_save'] as const);

/** {@link PPTX_GUARDED_SAVE_OPERATIONS} 的元素类型。 */
export type PptxGuardedSaveOperation = (typeof PPTX_GUARDED_SAVE_OPERATIONS)[number];

// ---------------------------------------------------------------------------
// 资源护栏（P-I23：采纳 P-R03 `guardedSave` 语义到交付适配器的保存路径）
// ---------------------------------------------------------------------------
//
// P-R03 在 `tests/mobile-office/presentations/P-R03/resource-guard.ts` 里给出并验证了护栏语义，
// 但那是**测试域**的探针，`src/**` 不得反向依赖 `tests/**`。本段把那层语义**落到适配器自身**：
// 预算 / 取消 / 失败保旧 / 低内存硬门，全部围绕本适配器的 `exportBytes` 保存路径。
//
// 关键不变量（与 P-R03 逐条一致）：
// 1. **失败保旧**：任何失败分支的 `bytes` 为 `null`（不采纳半成品），且入参 `previous_bytes`
//    **逐字节不变**；若变，抛内部错误而不是返回一个被悄悄换掉的"旧"文件。
// 2. **低内存硬门**：产物字节数超过 `max_output_bytes` 时**不采纳**，即使它已经生成成功。
// 3. **准入先于渲染**：取消 + 页数 / 媒体预算在**调用导出之前**判定，超大件根本不会被编码。
// 4. **取消两处检查**：写之前（准入）+ 写之前再确认；写完成后若已取消，产物同样不入会话。

/**
 * 一次演示保存所允许的资源上限（全部为**硬上限**，超出即拒绝，**不降级**）。
 *
 * 与 P-R03 `PresentationResourceBudget` **同形**（本适配器即其在 `src/**` 的落点）。
 */
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

/** 建一个取消控制器（与 `AbortController` 同形，但不依赖宿主环境）。 */
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

/** 一份 PPTX 的资源画像（全部来自真实部件字节，不是声明值）。 */
export interface PptxResourceUsage {
  readonly total_bytes: number;
  readonly part_count: number;
  readonly slide_count: number;
  readonly media_part_count: number;
  readonly media_total_bytes: number;
  readonly largest_media_part_bytes: number;
}

/**
 * 测量一份 PPTX 的资源画像（页数 / 部件数 / 媒体字节）。
 *
 * 复用 `openPresentation` 的真实解归档：同一函数既用于"旧产物"也用于"新产物"，
 * 因此护栏的前后测量口径一致。非 PPTX 字节会抛 `PresentationImportError`。
 */
export function measurePptxUsage(bytes: Uint8Array): PptxResourceUsage {
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

/** 参与预算判定的四个量（`PptxResourceUsage` 结构上即满足）。 */
export interface PptxBudgetSubject {
  readonly total_bytes: number;
  readonly slide_count: number;
  readonly media_total_bytes: number;
  readonly largest_media_part_bytes: number;
}

/** 逐条比较上限，返回全部被打破的项（空数组 = 通过）。 */
export function evaluateBudget(
  subject: PptxBudgetSubject,
  budget: PresentationResourceBudget,
): readonly BudgetViolation[] {
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

/** 一次护栏保存的结果。 */
export type GuardedPptxSaveOutcome = 'saved' | 'cancelled' | 'budget_exceeded' | 'write_failed';

export interface GuardedPptxSaveResult {
  /**
   * 采纳后的**新字节**（成功）或 `null`（取消 / 超预算 / 写失败）。
   * 失败分支**绝不**返回半成品：调用方据 `null` 保持旧产物。
   */
  readonly bytes: Uint8Array | null;
  readonly adopted: boolean;
  /** 失败时旧产物是否**逐字节**保持（摘要相等）。成功时为 `false`。 */
  readonly preserved_old: boolean;
  readonly outcome: GuardedPptxSaveOutcome;
  readonly error: ResourceGuardError | null;
  /** 旧产物摘要（调用前）；无旧产物时为 `null`。 */
  readonly previous_digest_before: string | null;
  /** 旧产物摘要（调用后）；无旧产物时为 `null`。恒等于 `previous_digest_before`。 */
  readonly previous_digest_after: string | null;
  readonly usage_before: PptxResourceUsage | null;
  readonly usage_after: PptxResourceUsage | null;
}

export interface GuardedPptxSaveInput {
  readonly source: PptxDeliverableSource;
  /** 当前已采纳的旧产物字节（首版为 `null` / 缺省）。失败时**逐字节保留**。 */
  readonly previous_bytes?: Uint8Array | null;
  readonly budget: PresentationResourceBudget;
  readonly token?: CancellationToken;
}

/**
 * 护栏下保存一份演示。**永不抛出**护栏错误（作为结果返回），因此调用方总能看到
 * "旧产物还在不在"。
 *
 * 顺序：取消 → 按**编辑后页数 + 旧产物媒体规模**做准入 → 再确认取消 → 真实导出 →
 * 输出预算硬门（低内存）→（导出后被取消则同样不采纳）→ 采纳。
 *
 * `write_failed` 覆盖底层导出器的具名拒绝（例如给导入件增删页 ⇒ `slide_set_changed`）；
 * 此时 `bytes` 为 `null`、`preserved_old === true`——这就是 PPT-14「失败保旧」在适配器护栏层的落点。
 */
export function guardedSavePptx(input: GuardedPptxSaveInput): GuardedPptxSaveResult {
  const previous = input.previous_bytes ?? null;
  const previousDigestBefore = previous === null ? null : digestBytes(previous);
  let usageBefore: PptxResourceUsage | null = null;
  if (previous !== null) {
    try {
      usageBefore = measurePptxUsage(previous);
    } catch (error) {
      return {
        bytes: null,
        adopted: false,
        preserved_old: true,
        outcome: 'write_failed',
        error: new ResourceGuardError('write_failed', `旧产物字节无法解析为 PPTX：${messageOf(error)}`, [], {
          cause: error,
        }),
        previous_digest_before: previousDigestBefore,
        previous_digest_after: previous === null ? null : digestBytes(previous),
        usage_before: null,
        usage_after: null,
      };
    }
  }

  const failure = (outcome: GuardedPptxSaveOutcome, error: ResourceGuardError): GuardedPptxSaveResult => {
    const digestAfter = previous === null ? null : digestBytes(previous);
    const preserved = digestAfter === previousDigestBefore;
    if (!preserved) {
      // 不变量 1：失败分支绝不允许旧字节被换掉。若发生，说明底层不再是纯函数语义。
      throw new Error('护栏内部不变量破坏：失败分支的旧产物字节摘要发生变化（底层保存不再是纯函数语义）');
    }
    return Object.freeze({
      bytes: null,
      adopted: false,
      preserved_old: true,
      outcome,
      error,
      previous_digest_before: previousDigestBefore,
      previous_digest_after: digestAfter,
      usage_before: usageBefore,
      usage_after: null,
    });
  };

  try {
    input.token?.throw_if_cancelled();
  } catch (error) {
    return failure('cancelled', asGuardError(error, 'cancelled'));
  }

  // 准入：编辑后的页数 + 旧产物的媒体规模。`total_bytes` 用**旧产物**大小近似（输出的下界，
  // 首版为 0），真正的输出大小硬门在导出完成之后（低内存硬门）。
  const admissionSubject: PptxBudgetSubject = {
    total_bytes: usageBefore?.total_bytes ?? 0,
    slide_count: input.source.presentation.slides.length,
    media_total_bytes: usageBefore?.media_total_bytes ?? 0,
    largest_media_part_bytes: usageBefore?.largest_media_part_bytes ?? 0,
  };
  const admissionViolations = evaluateBudget(admissionSubject, input.budget);
  if (admissionViolations.length > 0) {
    return failure(
      'budget_exceeded',
      new ResourceGuardError(
        'budget_exceeded',
        `准入即超预算，未导出：${describeViolations(admissionViolations)}`,
        admissionViolations,
      ),
    );
  }

  // 导出前再确认一次取消（长文稿的准备阶段可能耗时）。
  try {
    input.token?.throw_if_cancelled();
  } catch (error) {
    return failure('cancelled', asGuardError(error, 'cancelled'));
  }

  const exported = pptxDeliverableAdapter.exportBytes(input.source);
  if (!exported.ok) {
    return failure(
      'write_failed',
      new ResourceGuardError('write_failed', `导出失败（旧产物保留）：${exported.detail}`, [], {
        cause: exported,
      }),
    );
  }

  // 低内存硬门：产物再大也不采纳。
  let usageAfter: PptxResourceUsage;
  try {
    usageAfter = measurePptxUsage(exported.bytes);
  } catch (error) {
    return failure(
      'write_failed',
      new ResourceGuardError('write_failed', `产物字节无法解析为 PPTX（旧产物保留）：${messageOf(error)}`, [], {
        cause: error,
      }),
    );
  }
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

  // 导出完成但调用方已取消：产物同样不入会话。
  if (input.token?.is_cancelled === true) {
    return failure('cancelled', new ResourceGuardError('cancelled', '导出完成后被取消，产物未采纳'));
  }

  return Object.freeze({
    bytes: exported.bytes,
    adopted: true,
    preserved_old: false,
    outcome: 'saved',
    error: null,
    previous_digest_before: previousDigestBefore,
    previous_digest_after: previous === null ? null : digestBytes(previous),
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

/** 护栏保存的调用参数（`source` 由适配器方法给出，其余由会话层给出）。 */
export interface PptxGuardedSaveOptions {
  readonly budget: PresentationResourceBudget;
  readonly token?: CancellationToken;
  readonly previous_bytes?: Uint8Array | null;
}

/** 演示交付适配器：通用四 op 接缝 + 护栏保存（P-I23）。 */
export interface PptxDeliverableAdapter extends DeliverableAdapter<PptxDeliverableSource> {
  /**
   * 护栏下保存本适配器的源（预算 + 取消），失败 / 取消 / 超预算时 `bytes` 为 `null`、
   * 旧产物逐字节保留。见 {@link guardedSavePptx}。
   */
  guardedSave(source: PptxDeliverableSource, options: PptxGuardedSaveOptions): GuardedPptxSaveResult;
}

/** 取领域错误的具名 reason（两个错误类都有 `reason`；不是的话退回错误名）。 */
function reasonOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const reason = (error as { readonly reason?: unknown }).reason;
    if (typeof reason === 'string') return reason;
  }
  return error instanceof Error ? error.name : 'unknown_error';
}

/** 4:3 版式常量（产品入口建页时用；导出给调用方以便与 `emptyPresentation` 一致）。 */
export const PPTX_DEFAULT_SLIDE_SIZE = SLIDE_SIZE_4_3;
