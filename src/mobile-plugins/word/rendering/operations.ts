/**
 * **WF-089 / WF-090 的操作契约（schemas + 校验器，纯 TS）**。
 *
 * 这一层是 W09 交给宿主（K 线）的**命令面**：宿主收到 `render_pdf` / `print_handoff`
 * 两个操作时，先用这里的校验器判**能不能做**，再交给排版/交接实现。校验器是
 * **fail-closed** 的：任何一条不过就 `ok:false` 并给出结构化 issue，**不猜、不放行**。
 *
 * ## 三条硬纪律（都是可测的判据，不是注释）
 *
 * 1. **不出现电脑路径**：引用（`documentRef` / `artifactRef`）必须是**不透明引用**
 *    （形如 `artifact:...` / `content://...` / `blob:...`），不得是 `C:\...`、`\\server\share`、
 *    `file:///D:/...`、`/home/...`、`/Users/...` 之类**桌面/主机路径**。见
 *    {@link findHostPathLeak}——它逐条命中最常见的伪造形态并返回**命中的片段**。
 * 2. **打印操作只能表达"交接"**：`print_handoff` 的 payload 里 `handoffOnly` 必须是字面量
 *    `true`——类型 + 运行时双重禁止把它当成"打印"。
 * 3. **schemaVersion 必须匹配**，否则拒绝（不静默升级、不猜旧版）。
 *
 * 与总协调 `contracts/mobile-v1` 的关系：本文件是 **Word 线自持的 v1 草案**，与公共
 * 信封字段（`schemaVersion, commandId, operation, idempotencyKey, payload`）同形；
 * 字段变更一律**追加可选字段**，不破坏既有调用方。
 */

import type { PageGeometry } from './types.js';

/** 本线操作契约版本。 */
export const WORD_RENDERING_SCHEMA_VERSION = 'potbot.word.rendering.v1';

/** W09 暴露的操作名（封闭枚举）。 */
export const WORD_RENDER_OPERATIONS = ['render_pdf', 'print_handoff'] as const;
export type WordRenderOperation = (typeof WORD_RENDER_OPERATIONS)[number];

// ---------------------------------------------------------------------------
// 信封与 payload
// ---------------------------------------------------------------------------

/** 公共命令信封（与 README §5 命令契约同形）。 */
export interface OperationEnvelope<P> {
  readonly schemaVersion: string;
  readonly commandId: string;
  readonly operation: WordRenderOperation;
  readonly idempotencyKey: string;
  readonly conversationId?: string;
  readonly taskId?: string;
  /** 变更既有对象时的期望修订；create 可缺省。 */
  readonly expectedRevision?: number;
  readonly payload: P;
}

/** WF-089：把文档渲染成 PDF（手机侧排版）。 */
export interface RenderPdfPayload {
  readonly title?: string;
  /** 不透明文档引用（**不得**是主机路径）。 */
  readonly documentRef: string;
  readonly geometry: PageGeometry;
  /** 排版超时（ms）；缺省由实现取 15000。 */
  readonly timeoutMs?: number;
}

/** WF-090：把**已独立读回核对通过**的 PDF 交给系统打印服务（**只交接**）。 */
export interface PrintHandoffPayload {
  /** 不透明产物引用（**不得**是主机路径）。 */
  readonly artifactRef: string;
  /** 读回核对通过时那份字节的 sha256（64 位十六进制）。 */
  readonly expectedSha256: string;
  /** 读回器报出的真实页数，必须 ≥1。 */
  readonly pageCount: number;
  readonly jobName?: string;
  /** **恒为 `true`**：本操作只表达"交接"，不是"打印"。 */
  readonly handoffOnly: true;
}

export type RenderPdfCommand = OperationEnvelope<RenderPdfPayload>;
export type PrintHandoffCommand = OperationEnvelope<PrintHandoffPayload>;
export type WordRenderCommand = RenderPdfCommand | PrintHandoffCommand;

// ---------------------------------------------------------------------------
// 结果 / 回执词表
// ---------------------------------------------------------------------------

export type OperationStatus = 'succeeded' | 'failed' | 'rejected';

/** **外部动作**的七态（README §5 ExternalReceipt）。 */
export const EXTERNAL_RECEIPT_STATES = [
  'prepared',
  'authorized',
  'submitting',
  'submitted',
  'unknown',
  'confirmed',
  'failed',
  'cancelled',
] as const;
export type ExternalReceiptState = (typeof EXTERNAL_RECEIPT_STATES)[number];

/**
 * 打印交接**允许**出现的状态子集。
 *
 * 关键：`confirmed`（外部确认）**不在**这里——打印机不返回可信回执，故打印交接
 * 不得冒用"已确认/已打印"。见 `print-state.ts`。
 */
export const PRINT_HANDOFF_ALLOWED_STATES: readonly PrintHandoffStateName[] = ['prepared', 'submitted'];
type PrintHandoffStateName = 'prepared' | 'submitted';

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

export interface OperationIssue {
  /** 机器可判的 issue 码。 */
  readonly code: string;
  /** 指向信封 / payload 的路径，如 `payload.pageCount`。 */
  readonly path: string;
  readonly message: string;
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly OperationIssue[] };

/** 主机/桌面路径的伪装形态（每条都能在真实泄露场景里命中）。 */
const HOST_PATH_PATTERNS: readonly { readonly code: string; readonly re: RegExp }[] = [
  { code: 'file_uri', re: /file:\/\//i },
  { code: 'windows_long_path', re: /\\\\\?\\/ },
  { code: 'unc_share', re: /\\\\[^\\/]+[\\/]/ },
  { code: 'windows_drive', re: /(^|[^A-Za-z0-9])[A-Za-z]:[\\/]/ },
  { code: 'posix_home', re: /(^|[^A-Za-z0-9])\/(home|Users)\// },
  { code: 'dev_marker', re: /(^|[\\/])\.(runtime|dev-evidence)([\\/]|$)/ },
];

/**
 * 在一个字符串里找**主机路径泄露**。返回命中的诊断串（含命中的模式码与被命中的子串），
 * 没有则返回 null。调用方据此 fail-closed。
 */
export function findHostPathLeak(text: string): { code: string; snippet: string } | null {
  for (const { code, re } of HOST_PATH_PATTERNS) {
    const m = re.exec(text);
    if (m !== null) return { code, snippet: m[0] };
  }
  return null;
}

/** 引用必须是**不透明**的：要么无 scheme，要么 scheme ∈ 白名单。 */
const ALLOWED_REF_SCHEMES = ['artifact', 'content', 'blob', 'urn', 'potbot'] as const;

function validateOpaqueRef(ref: unknown, path: string, issues: OperationIssue[]): void {
  if (typeof ref !== 'string' || ref.trim() === '') {
    issues.push({ code: 'ref_missing', path, message: '引用缺失或为空。' });
    return;
  }
  const leak = findHostPathLeak(ref);
  if (leak !== null) {
    issues.push({
      code: `ref_host_path_${leak.code}`,
      path,
      message: `引用是主机/桌面路径（命中 ${leak.code}："${leak.snippet}"），手机内核只接受不透明引用。`,
    });
    return;
  }
  // 形如 `xx:yy` 的 scheme：只有白名单 scheme 允许。
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(ref);
  if (schemeMatch !== null) {
    const scheme = (schemeMatch[1] as string).toLowerCase();
    if (!(ALLOWED_REF_SCHEMES as readonly string[]).includes(scheme)) {
      issues.push({
        code: 'ref_scheme_not_allowed',
        path,
        message: `引用 scheme "${scheme}" 不在白名单（允许：${ALLOWED_REF_SCHEMES.join('/')}）。`,
      });
    }
  }
}

function validateGeometry(geometry: unknown, path: string, issues: OperationIssue[]): void {
  if (geometry === null || typeof geometry !== 'object') {
    issues.push({ code: 'geometry_missing', path, message: '缺少页面几何。' });
    return;
  }
  const g = geometry as Partial<PageGeometry>;
  const m = g.marginsTwips;
  if (
    !isPositive(g.widthTwips) ||
    !isPositive(g.heightTwips) ||
    m === undefined ||
    typeof m !== 'object' ||
    m.top < 0 ||
    m.bottom < 0 ||
    m.left < 0 ||
    m.right < 0
  ) {
    issues.push({ code: 'geometry_invalid', path, message: '页面几何非法（宽/高须为正，边距非负）。' });
    return;
  }
  const contentW = g.widthTwips - m.left - m.right;
  const contentH =
    g.heightTwips - m.top - m.bottom - (g.headerHeightTwips ?? 0) - (g.footerHeightTwips ?? 0);
  if (contentW <= 0 || contentH <= 0) {
    issues.push({ code: 'geometry_no_content_box', path, message: '页面内容区宽或高不为正。' });
  }
}

function isPositive(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

const HEX64 = /^[0-9a-fA-F]{64}$/;

/** 校验 `render_pdf`。 */
export function validateRenderPdfCommand(input: unknown): ValidationResult<RenderPdfCommand> {
  const issues: OperationIssue[] = [];
  const envelope = validateEnvelope(input, 'render_pdf', issues);
  if (envelope === null) return { ok: false, issues };
  const payload = (input as { payload: unknown }).payload;
  if (payload === null || typeof payload !== 'object') {
    issues.push({ code: 'payload_missing', path: 'payload', message: '缺少 payload。' });
    return { ok: false, issues };
  }
  const p = payload as Partial<RenderPdfPayload>;
  validateOpaqueRef(p.documentRef, 'payload.documentRef', issues);
  validateGeometry(p.geometry, 'payload.geometry', issues);
  if (p.timeoutMs !== undefined && (!isPositive(p.timeoutMs) || p.timeoutMs > 600_000)) {
    issues.push({ code: 'timeout_out_of_range', path: 'payload.timeoutMs', message: 'timeoutMs 须为正且 ≤ 600000。' });
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: envelope as RenderPdfCommand };
}

/** 校验 `print_handoff`。 */
export function validatePrintHandoffCommand(input: unknown): ValidationResult<PrintHandoffCommand> {
  const issues: OperationIssue[] = [];
  const envelope = validateEnvelope(input, 'print_handoff', issues);
  if (envelope === null) return { ok: false, issues };
  const payload = (input as { payload: unknown }).payload;
  if (payload === null || typeof payload !== 'object') {
    issues.push({ code: 'payload_missing', path: 'payload', message: '缺少 payload。' });
    return { ok: false, issues };
  }
  const p = payload as Partial<PrintHandoffPayload>;
  validateOpaqueRef(p.artifactRef, 'payload.artifactRef', issues);
  if (typeof p.expectedSha256 !== 'string' || !HEX64.test(p.expectedSha256)) {
    issues.push({ code: 'digest_invalid', path: 'payload.expectedSha256', message: 'expectedSha256 须是 64 位十六进制。' });
  }
  if (typeof p.pageCount !== 'number' || !Number.isInteger(p.pageCount) || p.pageCount < 1) {
    issues.push({ code: 'page_count_invalid', path: 'payload.pageCount', message: 'pageCount 须是 ≥1 的整数。' });
  }
  if (p.handoffOnly !== true) {
    issues.push({
      code: 'print_is_not_a_print',
      path: 'payload.handoffOnly',
      message: 'handoffOnly 必须为 true：本操作只表达"交接"，不是"打印"。',
    });
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: envelope as PrintHandoffCommand };
}

/** 按 `operation` 分派校验。 */
export function validateWordRenderCommand(input: unknown): ValidationResult<WordRenderCommand> {
  const op = (input as { operation?: unknown } | null)?.operation;
  if (op === 'render_pdf') return validateRenderPdfCommand(input);
  if (op === 'print_handoff') return validatePrintHandoffCommand(input);
  return {
    ok: false,
    issues: [
      { code: 'unknown_operation', path: 'operation', message: `未知操作：${String(op)}。` },
    ],
  };
}

function validateEnvelope(
  input: unknown,
  expected: WordRenderOperation,
  issues: OperationIssue[],
): OperationEnvelope<unknown> | null {
  if (input === null || typeof input !== 'object') {
    issues.push({ code: 'not_an_object', path: '', message: '命令不是对象。' });
    return null;
  }
  const e = input as Partial<OperationEnvelope<unknown>>;
  if (e.schemaVersion !== WORD_RENDERING_SCHEMA_VERSION) {
    issues.push({
      code: 'schema_version_mismatch',
      path: 'schemaVersion',
      message: `schemaVersion 须为 "${WORD_RENDERING_SCHEMA_VERSION}"，实为 "${String(e.schemaVersion)}"。`,
    });
  }
  if (e.operation !== expected) {
    issues.push({ code: 'operation_mismatch', path: 'operation', message: `operation 须为 ${expected}。` });
  }
  if (typeof e.commandId !== 'string' || e.commandId.trim() === '') {
    issues.push({ code: 'command_id_missing', path: 'commandId', message: 'commandId 缺失。' });
  }
  if (typeof e.idempotencyKey !== 'string' || e.idempotencyKey.trim() === '') {
    issues.push({ code: 'idempotency_key_missing', path: 'idempotencyKey', message: 'idempotencyKey 缺失。' });
  }
  if (issues.length > 0) return null;
  return e as OperationEnvelope<unknown>;
}

/** 操作结果（成功携带产物引用 + 摘要 + 回执；失败携带结构化错误）。 */
export interface OperationResult {
  readonly status: OperationStatus;
  readonly commandId: string;
  readonly revision?: number;
  readonly artifactId?: string;
  readonly digest?: string;
  readonly mime?: string;
  /** 外部回执状态（仅外部动作）；打印交接**不得**出现 `confirmed`。 */
  readonly receiptState?: ExternalReceiptState;
  readonly error?: { readonly code: string; readonly message: string };
}

/** 打印交接结果是否**冒用**了不允许的状态（如 `confirmed`）。 */
export function isPrintStateAllowed(state: ExternalReceiptState): boolean {
  return (PRINT_HANDOFF_ALLOWED_STATES as readonly string[]).includes(state);
}
