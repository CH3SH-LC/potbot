/**
 * FA-Q —— 三对「分别验收」的可执行判据（目录 §2.3 / 合同 R247–R252、R242、R246）
 *
 * 目录 §2.3 原文：
 *   「『创建』与『导入后修改』、『首次保存』与『重开后再编辑』、『跳转』与『写入完成』分别验证。」
 *
 * 「分别验证」= 每一对里的**两个主张各自**都要有独立证据；最容易被**静默降级**的正是：
 *   - 拿"新建一个文件"冒充"改了一份既有文件"；
 *   - 拿"内存里改过"冒充"存盘并可重开再改"；
 *   - 拿"打开了目标 App"冒充"写入了目标 App"。
 *
 * 因此每对给出**两个极性**的判据：强主张的判据 + 弱证据的判据。弱证据只要被当成强主张，
 * 强主张的判据就必须判**负**。
 *
 * 本模块只做**纯函数判据**，不 import 任何产品实现，不读盘、不起服务。
 */

export interface Verdict {
  readonly ok: boolean;
  readonly reasons: readonly string[];
}

const verdict = (r: string[]): Verdict => (r.length === 0 ? { ok: true, reasons: [] } : { ok: false, reasons: r });

// ---------------------------------------------------------------------------
// 对 1：创建  vs  导入后修改  —— 两个独立主张
// ---------------------------------------------------------------------------

/** 一份产物是「从零创建」还是「基于既有文件修改」的观测。 */
export interface ImportModifyObservation {
  /** 产物来源：created = 从零新建；imported = 基于一份既有文件。 */
  readonly origin: 'created' | 'imported';
  /** 导入时既有文件的引用（origin='imported' 时必填）。 */
  readonly source_ref?: string;
  /** 文件中**未被本次操作触碰**的部件（未知部件保留证据）。缺省 = 未记录，按"未证"处理。 */
  readonly preserved_unknown_parts?: readonly string[];
  /** 目标文件本身已声明"不含未知部件"——与上一字段二者必居其一，防"忘了记录"被当成"没有"。 */
  readonly declared_no_unknown_parts?: boolean;
  /** 本次实际改动的目标引用（非空）。 */
  readonly changed_refs: readonly string[];
  /** 改动目标的读回值。 */
  readonly readback_of_changed: Readonly<Record<string, string>>;
  /** 改动目标的期望值。 */
  readonly expected_of_changed: Readonly<Record<string, string>>;
}

function checkReadback(o: ImportModifyObservation, r: string[]): void {
  for (const ref of o.changed_refs) {
    const got = o.readback_of_changed[ref];
    const want = o.expected_of_changed[ref];
    if (got === undefined) r.push(`改动目标 ${ref} 无读回值：打开/存在≠写入`);
    else if (want === undefined) r.push(`改动目标 ${ref} 无期望值：无法断言`);
    else if (got !== want) r.push(`改动目标 ${ref} 读回「${got}」≠ 期望「${want}」`);
  }
}

/** 主张一：这是**从零创建**。导入过的证据不能充当"从零创建"。 */
export function checkFreshCreate(o: ImportModifyObservation): Verdict {
  const r: string[] = [];
  if (o.origin !== 'created') r.push('origin 不是 created：基于既有文件修改不能充当「从零创建」');
  if (o.source_ref) r.push('带 source_ref：这不是从零创建，而是基于既有文件');
  if (o.changed_refs.length === 0) r.push('changed_refs 为空：没有可核对的产物目标');
  checkReadback(o, r);
  return verdict(r);
}

/** 主张二：这是**导入既有文件后修改**。从零新建不能冒充。 */
export function checkImportThenModify(o: ImportModifyObservation): Verdict {
  const r: string[] = [];
  if (o.origin !== 'imported') r.push('origin 不是 imported：从零新建不能充当「导入后修改」');
  if (!o.source_ref) r.push('缺少 source_ref：无法证明基于既有文件修改');
  if ((o.preserved_unknown_parts?.length ?? 0) === 0 && o.declared_no_unknown_parts !== true) {
    r.push('既无 preserved_unknown_parts 又未声明 declared_no_unknown_parts：未知部件保留未证（缺失≠没有）');
  }
  if (o.changed_refs.length === 0) r.push('changed_refs 为空：没有可核对的改动目标');
  checkReadback(o, r);
  return verdict(r);
}

// ---------------------------------------------------------------------------
// 对 2：首次保存  vs  重开后再编辑  —— 两个独立检查点
// ---------------------------------------------------------------------------

/** 「存盘 → 关闭 → 重开 → 再编辑」的一次完整观测。 */
export interface ReopenEditObservation {
  /** 首次保存后，从磁盘重读到的内容。 */
  readonly after_first_save_readback: string;
  /** 关闭再重开后，从磁盘重读到的内容。 */
  readonly after_reopen_readback: string;
  /** 重开后又做了一次编辑，其目标引用。 */
  readonly post_reopen_edit_ref: string;
  /** 重开后编辑的期望值。 */
  readonly post_reopen_expected: string;
  /** 重开后编辑后的读回值。 */
  readonly post_reopen_readback: string;
  /** 编辑是否只发生在**同一进程内的内存副本**而未真正落盘。 */
  readonly in_memory_only: boolean;
}

/** 检查点一：**首次保存**真的落盘（内存副本不算保存）。 */
export function checkFirstSave(o: ReopenEditObservation): Verdict {
  const r: string[] = [];
  if (o.in_memory_only) r.push('in_memory_only=true：内存副本不能充当「已保存」');
  if (o.after_first_save_readback.length === 0) r.push('首次保存后读回为空：没有可核对的落盘内容');
  return verdict(r);
}

/** 检查点二：**重开后再编辑**——重开读回须与保存一致，且重开后的编辑生效。 */
export function checkReopenThenEdit(o: ReopenEditObservation): Verdict {
  const r: string[] = [];
  if (o.in_memory_only) r.push('in_memory_only=true：内存副本不能充当「重开后再编辑」');
  if (o.after_reopen_readback !== o.after_first_save_readback) {
    r.push('重开读回 ≠ 首次保存读回：要么没落盘，要么重开丢了内容');
  }
  if (!o.post_reopen_edit_ref) r.push('缺少 post_reopen_edit_ref');
  if (o.post_reopen_readback !== o.post_reopen_expected) {
    r.push(`重开后编辑读回「${o.post_reopen_readback}」≠ 期望「${o.post_reopen_expected}」`);
  }
  return verdict(r);
}

// ---------------------------------------------------------------------------
// 对 3：跳转（打开目标 App）  vs  写入完成  —— 弱证据 vs 强主张
// ---------------------------------------------------------------------------

/** 动作状态七态（合同 R242）。 */
export const ACTION_STATES = [
  'prepared', // 已准备
  'handed_off', // 已交接
  'submitted', // 已提交
  'confirmed_complete', // 已确认完成
  'unknown_result', // 结果未知
  'user_reported_complete', // 用户报告完成
  'failed_or_expired', // 已失效或失败
] as const;
export type ActionState = (typeof ACTION_STATES)[number];

/** 只有「已确认完成」是写入完成态；其余六态都不是。 */
export const COMPLETION_STATE: ActionState = 'confirmed_complete';

export interface WriteCompletionObservation {
  readonly action_state: ActionState;
  /** 跳转/打开目标 App 的证据（URL / intent / 页面打开）。 */
  readonly opened_target?: string;
  /** 可信回执的标识（与执行读同一对象，R243）。 */
  readonly receipt_ref?: string;
  /** 写入目标的独立读回值。 */
  readonly readback_of_target?: string;
  readonly readback_expected?: string;
  /** 是否仅为"用户报告完成"。 */
  readonly user_reported?: boolean;
}

/** 主张：**写入完成**。打开页面/交接/提交/未知/用户报告都不算。 */
export function checkWriteComplete(o: WriteCompletionObservation): Verdict {
  const r: string[] = [];
  if (o.action_state !== COMPLETION_STATE) {
    r.push(`动作状态为 ${o.action_state}：打开/交接/提交/未知都不等于写入完成（打开页面≠写入）`);
  }
  const hasReceipt = typeof o.receipt_ref === 'string' && o.receipt_ref.length > 0;
  const hasReadback = o.readback_of_target !== undefined && o.readback_expected !== undefined;
  const readbackConsistent = hasReadback && o.readback_of_target === o.readback_expected;
  if (!hasReceipt && !readbackConsistent) {
    r.push('既无可信回执，又无一致读回：不得宣称写入完成');
  }
  // 读回与期望矛盾是**硬伤**：即便有回执也必须暴露（R241 回执须与真实对象一致）。
  if (hasReadback && !readbackConsistent) {
    r.push(`读回「${o.readback_of_target}」≠ 期望「${o.readback_expected}」：宣称完成与读回矛盾`);
  }
  if (o.user_reported === true) {
    r.push('仅「用户报告完成」不得视为系统写入完成（R242 七态之一，非确认完成）');
  }
  return verdict(r);
}

/**
 * 对偶判据：**跳转被如实处理**——只打开目标 App 时，系统**自己**不得把它标成完成，
 * 且必须给出非完成态 + 可追溯的跳转证据。这是"打开≠写入"的正向护栏。
 */
export function checkJumpHandledHonestly(o: WriteCompletionObservation): Verdict {
  const r: string[] = [];
  if (o.action_state === COMPLETION_STATE) {
    r.push('只做了跳转却标为 confirmed_complete：打开了页面≠写入完成');
  }
  if (!o.opened_target) r.push('缺少 opened_target：无法证明确实发生了跳转');
  return verdict(r);
}

/** 把弱证据（仅跳转）当成写入完成的**反例观测**。 */
export function asJumpOnlyClaim(): WriteCompletionObservation {
  return {
    action_state: 'handed_off',
    opened_target: 'intent://calendar/insert',
  };
}
