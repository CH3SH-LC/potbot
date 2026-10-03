/**
 * P10 手机侧演示编辑会话的**操作模式与结果类型**（PPT-01 / PPT-14 / PPT-16 的产品面）。
 *
 * ## 这一层解决什么
 *
 * `src/presentations/**` 给的是**纯函数**原语（模型操作、撤销历史、事实同步、渲染/往返），
 * `src/session/adapters/pptx.ts` 给的是**格式接缝**（导出/导入 + 四 op 的封闭枚举）。
 * 手机端要的是把这三样收成**一次可持久化的编辑会话**：
 *
 * - **事务撤销**：每次 `apply` 要么整体成功（新版本）要么原样失败（失败保旧），可 `undo` / `redo`；
 * - **事实同步**：正文 / 表格 / 图表三处的数值必须来自**同一版事实**，保存前据实校验，冲突即拒绝交付；
 * - **保存 — 重开 — 再编辑**：`save` 出字节，`openSessionFromBytes` 读回成新会话，继续编辑再保存；
 * - **并发**：每次写入带 `expectedRevision`，版本对不上**拒绝**而不是"最后写入者赢"。
 *
 * 本文件只声明类型（无实现），是会话的操作 schema。
 */

import type { KnownFactValue } from '../../../protocol/index.js';
import type {
  FactBindings,
  FactSyncReport,
  FactVersion,
  VersionedFactSnapshot,
} from '../../../presentations/fact-sync.js';
import type { PresentationSession } from './session.js';

// ---------------------------------------------------------------------------
// 操作（封闭枚举）
// ---------------------------------------------------------------------------

/**
 * 一次演示编辑。**封闭枚举**——未知 `op` 在会话层被具名拒绝（`unsupported_op`）。
 *
 * 结构操作（前四项）复用 `pptxDeliverableAdapter` 的四 op，语义与它逐字一致；
 * 文本替换与事实操作走 `src/presentations/{undo-history,fact-sync}.ts`。
 * 说明：**导入件上的增 / 删页**在适配器接缝上不可持久化（`exportImportedPresentation`
 * 报 `slide_set_changed`），会话层在 `apply` 时即**预检拒绝**，不留"改得动、存不下"的假入口。
 */
export type PresentationSessionEdit =
  /** 新增一页（新页含一个标题文本框；页数由调用方决定，不是固定两页）。 */
  | { readonly op: 'add_slide'; readonly title: string; readonly at?: number }
  /** 改既有页首个文本框的文字。 */
  | { readonly op: 'set_slide_title'; readonly slide_id: number; readonly text: string }
  /** 删一页（`slide_id` 定位，不用会漂移的页码）。 */
  | { readonly op: 'remove_slide'; readonly slide_id: number }
  /** 设 / 清一页的备注（`text: null` = 删除）。 */
  | { readonly op: 'set_slide_notes'; readonly slide_id: number; readonly text: string | null }
  /** 字面量文本的全部替换（run 内非重叠；事实引用 run 不参与）。 */
  | { readonly op: 'replace_text'; readonly query: string; readonly replacement: string }
  /** 接入一版事实（并登记图表 / 表格绑定）。 */
  | { readonly op: 'attach_facts'; readonly target: VersionedFactSnapshot; readonly bindings?: FactBindings }
  /** 改一条事实的值 ⇒ 发布**新版本**，并把图表 / 表格的字面量刷成新值（三处同版）。 */
  | { readonly op: 'set_fact_value'; readonly fact_key: string; readonly value: KnownFactValue }
  /** 回退 / 前进到某个**已发布**的事实版本（重刷图表 / 表格字面量）。 */
  | { readonly op: 'use_fact_version'; readonly version: FactVersion };

/** 编辑 `op` 的名字集合（供负例穷举，避免漏一个分支）。 */
export const PRESENTATION_SESSION_OPS = [
  'add_slide',
  'set_slide_title',
  'remove_slide',
  'set_slide_notes',
  'replace_text',
  'attach_facts',
  'set_fact_value',
  'use_fact_version',
] as const;

export type PresentationSessionOpName = (typeof PRESENTATION_SESSION_OPS)[number];

// ---------------------------------------------------------------------------
// 编辑结果
// ---------------------------------------------------------------------------

/** 成功应用（`status: 'no_change'` = 幂等空转：源一字未动、版本未递增）。 */
export interface SessionEditOk {
  readonly ok: true;
  readonly status: 'applied' | 'no_change';
  readonly session: PresentationSession;
  readonly revision: number;
  readonly changed: boolean;
  readonly notes: readonly string[];
  /** 当前模型的字节摘要（对 UTF-8 序列化后的模型取 sha256）。 */
  readonly digest: string;
  /** 应用后的事实目标版本（未接入事实为 `null`）。 */
  readonly fact_version: FactVersion | null;
}

/** 并发冲突：`expectedRevision` 已不是当前版本 ⇒ 拒绝，会话原样返回。 */
export interface SessionEditStale {
  readonly ok: false;
  readonly status: 'stale_write';
  readonly expected: number;
  readonly current: number;
  readonly message: string;
  readonly session: PresentationSession;
}

/** 具名拒绝：`reason` 见 {@link PresentationSessionErrorReason}；会话原样返回（失败保旧）。 */
export interface SessionEditRejected {
  readonly ok: false;
  readonly status: 'rejected';
  readonly reason: string;
  readonly detail: string;
  readonly session: PresentationSession;
}

export type SessionEditOutcome = SessionEditOk | SessionEditStale | SessionEditRejected;

// ---------------------------------------------------------------------------
// 事实门禁 / 保存
// ---------------------------------------------------------------------------

/**
 * 同版事实门禁结果。
 *
 * - `ok`：三处数值都等于目标版本的值（`report.ok === true`）；
 * - `conflict`：存在冲突（旧版 / 错值 / 缺失 / 非数值 / 绑定对不上），`report` 里逐条列明；
 * - `not_ready`：**还没接入事实**（无目标版本）——不是"通过"，也不是"冲突"，是"无从判定"。
 */
export type SessionFactGate =
  | { readonly status: 'ok'; readonly report: FactSyncReport }
  | { readonly status: 'conflict'; readonly report: FactSyncReport }
  | { readonly status: 'not_ready'; readonly reason: 'no_facts_attached'; readonly detail: string };

/** 一次成功保存的回执。 */
export interface SessionSaveRecord {
  readonly bytes: Uint8Array;
  /** 会话**独立重算**的字节 sha256（与适配器自报一致才返回）。 */
  readonly digest: string;
  readonly entry_count: number;
  readonly revision: number;
  readonly fact_version: FactVersion | null;
  /** `ok` = 保存前同版事实校验通过；`not_verified` = 未接入事实，本次未做该校验。 */
  readonly fact_gate: 'ok' | 'not_verified';
  /** 需要转述给用户的提示（如"未接入事实"）。 */
  readonly warnings: readonly string[];
  /** 本仓无法验证的断言（原样带出，供上游如实转述；无消费端时非空）。 */
  readonly unverified: readonly { readonly claim: string; readonly requires: string }[];
}

/** 保存结果：同版事实冲突 ⇒ `blocked`；导出失败 ⇒ `export_failed`。两者都不产出字节。 */
export type SessionSaveOutcome =
  | { readonly ok: true; readonly record: SessionSaveRecord }
  | {
      readonly ok: false;
      readonly status: 'blocked';
      readonly reason: 'fact_conflict';
      readonly detail: string;
      readonly report: FactSyncReport;
    }
  | {
      readonly ok: false;
      readonly status: 'export_failed';
      readonly reason: string;
      readonly detail: string;
    };

// ---------------------------------------------------------------------------
// 摘要
// ---------------------------------------------------------------------------

/** 会话的一行摘要（供 UI 回显与审计定位）。 */
export interface SessionSummary {
  readonly revision: number;
  readonly label: string;
  readonly undo_depth: number;
  readonly redo_depth: number;
  readonly digest: string;
  readonly slide_count: number;
  readonly imported_origin: boolean;
  readonly fact_version: FactVersion | null;
  readonly fact_binding_counts: { readonly chart: number; readonly table: number };
}
