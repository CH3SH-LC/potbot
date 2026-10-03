/**
 * **W-R02 操作 schema / 类型**（`tests/mobile-office/word/W-R02/`）——长文、大图、多表、
 * 低内存、取消与崩溃恢复的**独立验证**用的形状定义。
 *
 * 本文件只放**数据形状**，不含实现。它的作用是把"这一包到底验什么"钉成可核验的类型：
 *
 * | 形状 | 用途 |
 * |---|---|
 * | {@link DocumentProfile} | 造多大一份文档（段数 / 表数 / 图片字节数） |
 * | {@link ResilienceScenario} | 四类负载 + 两类故障场景的枚举 |
 * | {@link CancelOutcome} | 一次"被取消的发布"之后，会话处于什么状态 |
 * | {@link CrashRecoveryOutcome} | 一次"杀进程重开"之后，能续到哪、会不会重放 |
 * | {@link ScenarioEvidence} | 每个场景留下的原始测量（供上层汇总，不替代断言） |
 * | {@link ResilienceReport} | 全部场景的证据汇总 |
 *
 * ## 为什么这些形状要显式写出来（而不是测试里就地断言）
 *
 * 规格（`docs/other/ds-six-lanes-2026-10-03/README.md` §5）要求 Office 线交出
 * `schemas`。W-R02 不是产品模块，但同样要有"这一包消费/产出的形状"可被别的包引用：
 * 证据结构统一后，汇总者不必读测试代码就能解析 `ResilienceReport`。
 *
 * ## 边界（如实）
 *
 * 这些形状**不是** v1 公共契约（`contracts/mobile-v1/` 由总协调冻结）的替代品。
 * 它们只是本测试包内部的证据/场景描述；不对外发布、不被产品代码 import。
 */

/** 本包证据的 schema 标识（写进证据文件，读回时核对）。 */
export const W_R02_SCHEMA = 'potbot.w-r02.resilience.v1' as const;

// ---------------------------------------------------------------------------
// 负载描述
// ---------------------------------------------------------------------------

/**
 * 一份待造文档的规模参数。
 *
 * 全部字段都是**正整数**，"零"在构造时会显式拒绝（`image_bytes: 0` 不能表达"没有图片"，
 * 那由 `with_image: false` 表达——两个字段各说各的话会造出"到底有没有图"分不清的夹具）。
 */
export interface DocumentProfile {
  /** 顶层正文段落数（不含表格内的段落）。 */
  readonly paragraphs: number;
  /** 表格数量（每张表 `table_rows × table_cols`）。 */
  readonly tables: number;
  readonly table_rows: number;
  readonly table_cols: number;
  /** 是否在正文里嵌入一张图片（真 `w:drawing` + `word/media/image1.png`）。 */
  readonly with_image: boolean;
  /** 图片字节数（`with_image=false` 时忽略）。 */
  readonly image_bytes: number;
}

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------

/** 本包覆盖的场景集合。 */
export type ResilienceScenario =
  /** 长文：段数多，验证导入/深段编辑/导出往返规模不变。 */
  | 'long-document'
  /** 多表：表数量多、单元格多，验证表格结构完整保留。 */
  | 'many-tables'
  /** 大图：媒体字节大，验证大二进制部件逐字节保留且不重复。 */
  | 'large-image'
  /** 低内存：反复编辑后状态体积与媒体份数**有界**（不随编辑次数线性膨胀）。 */
  | 'low-memory'
  /** 取消：发布被取消 ⇒ 会话**不前进**、旧字节完好。 */
  | 'cancellation'
  /** 崩溃恢复：持久化 → 丢弃进程内会话 → 从状态恢复 → 续编 + 幂等不重放。 */
  | 'crash-recovery';

// ---------------------------------------------------------------------------
// 取消
// ---------------------------------------------------------------------------

/**
 * 一次**被取消的发布**之后观测到的会话状态。
 *
 * 判据来自合同 R145（发布失败 ⇒ 原文档与既有版本均未改动）与规则 5
 * （外部动作未完成不得宣称完成）。取消是发布失败的一种结构化原因，
 * 因此它必须和"写盘失败"走同一条收口路径，而不是被当成"静默无操作"。
 */
export interface CancelOutcome {
  /** 端口是否真的被调用过（证明这次"取消"发生在发布点，而不是在编译期被挡）。 */
  readonly publish_attempted: boolean;
  /** 提交结果是否为失败（成功即违反"取消不改稿"）。 */
  readonly submit_failed: boolean;
  /** 失败码（期望 `publish_failed`）。 */
  readonly failure_code: string | null;
  /** 失败里带的发布失败种类（期望端口回传的 `cancelled`）。 */
  readonly failure_kind: string | null;
  /** 取消后**当前**编辑版本（必须与取消前相同）。 */
  readonly revision_after: number;
  /** 取消后已交付版本数（必须为 0：取消不产生交付）。 */
  readonly published_count: number;
  /** 取消后导出字节的摘要仍等于取消前的摘要（旧内容一个字节没变）。 */
  readonly export_digest_unchanged: boolean;
}

// ---------------------------------------------------------------------------
// 崩溃恢复
// ---------------------------------------------------------------------------

/** 一次"保存 → 杀进程 → 重开 → 续编"得到的结果。 */
export interface CrashRecoveryOutcome {
  /** 从持久化载体恢复是否成功。 */
  readonly restored: boolean;
  /** 恢复失败时的原因（成功时为 `null`）。 */
  readonly restore_reason: string | null;
  /** 恢复后的编辑版本（应等于崩溃前最后一次成功提交后的版本）。 */
  readonly revision_after_restore: number;
  /** 恢复后的已交付版本数。 */
  readonly published_count_after_restore: number;
  /** 用崩溃前那一次提交的幂等键重放：是否被判为 `replayed`（不得产生第二个版本）。 */
  readonly replay_is_replayed: boolean;
  /** 重放后的编辑版本（必须与 `revision_after_restore` 相同）。 */
  readonly revision_after_replay: number;
  /** 恢复后再提交一次**新的**编辑是否成功（证明会话确实可续用）。 */
  readonly resumed_edit_ok: boolean;
  /** 续编后的编辑版本（应为 `revision_after_restore + 1`）。 */
  readonly revision_after_resume: number;
}

// ---------------------------------------------------------------------------
// 证据
// ---------------------------------------------------------------------------

/** 一个场景留下的原始测量。 */
export interface ScenarioEvidence {
  readonly scenario: ResilienceScenario;
  /** 断言全部通过的净结果（**不是**断言内容本身，内容在测试里）。 */
  readonly passed: boolean;
  /** 该场景用到的规模参数。 */
  readonly profile: DocumentProfile;
  /** 关键测量（键 → 数值/布尔/字符串）。 */
  readonly measurements: Readonly<Record<string, number | boolean | string>>;
}

/** 全部场景的证据汇总（可 JSON 化，供独立复核解析）。 */
export interface ResilienceReport {
  readonly schema: typeof W_R02_SCHEMA;
  /** 本仓源码的身份（由调用方传入；本包不自己算全量源码摘要）。 */
  readonly source_sha: string;
  readonly scenarios: readonly ScenarioEvidence[];
}
