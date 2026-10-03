/**
 * **跨包动作状态对齐**（工作包 FA-UNIFY-ACTION-STATES；独立验证 FA-VERIFY-WAVE **I-4 / I-5**）。
 *
 * ## 问题（本模块要修的口径不一致）
 *
 * 本仓一度存在**两份"R242 七态"**：`src/adapters/clock/action-contract.ts` 与
 * `src/workledger/action-ledger.ts`。两侧**中文标签逐位相同**，但**机器键名不同**，
 * 且 `confirmed` 一处可被 `expired` 废止、另一处是死终态。同标签、不同机器键，
 * 会让"跨包传一个状态值"变成静默的口径漂移（标签对得上，语义却对不上）。
 *
 * ## 本模块做三件事
 *
 * 1. **权威映射表**：把 clock 侧键名与 workledger 侧键名**双向**映射，逐对登记
 *    是否同义（`equivalent`）与依据（`rationale`）；**非同义项必须为 `equivalent: false`
 *    并附"语义"差异登记**，绝不做硬映射（`assertEquivalentActionStates()` 会对非同义对抛错）。
 * 2. **一致性判据**：`assertActionStateAlignment()` / `checkActionStateAlignment()`
 *    ——任意一侧**新增**状态而另一侧没跟上即**失败**（不静默忽略）；且"声明等价"
 *    必须与**结构计算**（终态性 + 出边集合 + 标签）一致（因此判据**不是恒真**）。
 * 3. **幂等键收口**：权威推导算法只有一份——workledger 的 `deriveIdempotencyKey()`
 *    （绑定 `task_revision` + 参数摘要）。`deriveClockLedgerKey()` 只是把 clock 的
 *    `ActionRequest` **投影**成该算法的入参，供 `createActionLedger()` 注入使用，
 *    **不另立算法**。
 *
 * ## 分层说明
 *
 * 本文件位于 `src/workledger/**`，按工作包要求放在此处；它**单向**引用
 * `../adapters/clock/action-contract.js`（该文件是无 import 的纯数据/纯函数模块，
 * 不会形成环）。clock 侧**不**反向依赖 workledger：clock 的台账只接受**注入**的
 * 推导函数，桥接在本文件完成。
 */

import {
  ACTION_STATES as CLOCK_ACTION_STATES,
  ACTION_STATE_LABELS as CLOCK_ACTION_STATE_LABELS,
  assertTransition,
  isTerminal as isClockTerminal,
  type ActionReceipt as ClockActionReceipt,
  type ActionLedgerOptions,
  type ActionRequest as ClockActionRequest,
} from '../adapters/clock/action-contract.js';
import { asRevision, asTaskId } from '../protocol/index.js';
import {
  ACTION_STATES as WORKLEDGER_ACTION_STATES,
  ACTION_STATE_LABELS as WORKLEDGER_ACTION_STATE_LABELS,
  canTransitionAction,
  computeActionParamDigest,
  deriveIdempotencyKey,
  isTerminalActionState,
} from './action-ledger.js';

// 供调用方（含判据用例）拿到两侧**真实**状态列表，不必各自 import 上游。
export { CLOCK_ACTION_STATES, WORKLEDGER_ACTION_STATES };

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** clock 侧七态的键名（`src/adapters/clock/action-contract.ts`）。 */
export type ClockActionStateName = (typeof CLOCK_ACTION_STATES)[number];
/** workledger 侧七态的键名（`src/workledger/action-ledger.ts`）。 */
export type WorkledgerActionStateName = (typeof WORKLEDGER_ACTION_STATES)[number];

/** 差异类别：`meaning` = 含义不同（不得硬映射）；`strictness` = 含义同、达成该状态的证据强度不同。 */
export type ActionStateDifferenceKind = 'meaning' | 'strictness';

export interface ActionStateDifference {
  readonly kind: ActionStateDifferenceKind;
  readonly detail: string;
  /** 建议口径（怎么统一 / 在统一前怎么用）。 */
  readonly recommendation: string;
}

export interface ActionStateAlignmentEntry {
  readonly clock: ClockActionStateName;
  readonly workledger: WorkledgerActionStateName;
  /**
   * 是否为**同义项**（可安全互译）。
   * `false` ⇒ **不得**当同义词硬映射，必须附至少一条 `kind: 'meaning'` 的差异登记。
   */
  readonly equivalent: boolean;
  /** 等价 / 不等价的依据（写给复核者看，不靠注释约定）。 */
  readonly rationale: string;
  /** 差异登记；无差异为 `[]`。 */
  readonly differences: readonly ActionStateDifference[];
}

export interface ActionStateTranslation {
  readonly from_side: 'clock' | 'workledger';
  readonly from: string;
  readonly to_side: 'clock' | 'workledger';
  readonly to: string;
  readonly equivalent: boolean;
  /** 目标侧状态的中文标签（两侧标签逐字相同是"机器键名不同"之外唯一还对得上的东西）。 */
  readonly label: string;
  readonly rationale: string;
}

// ---------------------------------------------------------------------------
// 一、权威映射表（7 ↔ 7）
// ---------------------------------------------------------------------------

/**
 * clock 七态 ↔ workledger 七态。**顺序即 R242 的依赖顺序**（越靠后越"确定"）。
 *
 * 覆盖判据由 `checkActionStateAlignment()` 机器化：两侧任一状态未出现在此表 ⇒ 失败。
 */
export const ACTION_STATE_ALIGNMENT: readonly ActionStateAlignmentEntry[] = Object.freeze([
  {
    clock: 'prepared',
    workledger: 'prepared',
    equivalent: true,
    rationale:
      '两侧同义：参数/版本已绑定、尚未对外发出任何东西；出边集合（已交接 / 已提交 / 失效或失败）在映射下逐项相同。',
    differences: [],
  },
  {
    clock: 'handed_off',
    workledger: 'handed_off',
    equivalent: true,
    rationale:
      '两侧同义：参数已交给外部 App/页面、由外部负责执行，我们**没有**写入与回读能力；' +
      '出边集合（已提交 / 已确认完成 / 结果未知 / 用户报告完成 / 失效或失败）在映射下逐项相同。',
    differences: [],
  },
  {
    clock: 'submitted',
    workledger: 'submitted',
    equivalent: true,
    rationale:
      '两侧同义：接口已受理（acknowledgement 级回执）、等回读或超时；' +
      '出边集合（已确认完成 / 结果未知 / 用户报告完成 / 失效或失败）在映射下逐项相同。',
    differences: [],
  },
  {
    clock: 'confirmed',
    workledger: 'confirmed_complete',
    equivalent: false,
    rationale:
      '标签逐字相同（都叫「已确认完成」），但**生命周期不同**，不是同义词：' +
      'clock 的 `confirmed` **不是死终态**——`ALLOWED_TRANSITIONS.confirmed = [failed]`，' +
      '且只允许 `failureKind = expired`（"外部后来把它废掉"）离开；' +
      'workledger 的 `confirmed_complete` 是**死终态**（`ACTION_TRANSITIONS.confirmed_complete = []`），' +
      '任务版本推进时也因此被原样保留（`invalidateStaleActions` 只改非终态）。' +
      '因此"已确认完成"在两包中含义不同：一侧可被外部废止、一侧不可被任何东西改写。',
    differences: [
      {
        kind: 'meaning',
        detail:
          '可废止性不同：clock 允许 `confirmed --(expired)--> failed`；workledger 的 `confirmed_complete` 无出边。' +
          'R242 的"已失效"分支在两处落点不同——一处把废止写成状态转换，一处完全没有这条路。',
        recommendation:
          '建议统一到**可废止**口径（即 clock 侧现行为）：把"已确认完成后被外部废止"建模为一条**显式的后续事实/边**' +
          '（如 `confirmed_complete --(revoked_after_confirmation)--> invalidated_or_failed`，且只允许 revoked/expired 一种理由），' +
          '这样既保留"已确认完成确曾发生"的历史，又能如实表达外部废止。' +
          '在统一之前：两包互译时必须显式判 `equivalent: false`；展示层**不得**把两侧的「已确认完成」当作同一生命周期，' +
          'workledger 侧不得据此声称"确认完成后不可能失效"。',
      },
    ],
  },
  {
    clock: 'unknown',
    workledger: 'result_unknown',
    equivalent: true,
    rationale:
      '两侧同义：外部系统未给出可读回执的**如实**结局，不是"失败"，也**不得盲目重试**（R246/R217）；' +
      '出边集合（已确认完成 / 用户报告完成 / 失效或失败）在映射下逐项相同。',
    differences: [],
  },
  {
    clock: 'user_reported',
    workledger: 'user_reported_complete',
    equivalent: true,
    rationale:
      '两侧同义：用户口述完成 ≠ 可信回执确认；都是**非终态**，都只能被可信回执（confirmed / confirmed_complete）' +
      '证实、或被告失败/废止；出边集合在映射下逐项相同，且都不计入"成功"。' +
      '（此处的**严格度差异**见 differences——含义相同，达成该状态所需的证据强度不同。）',
    differences: [
      {
        kind: 'strictness',
        detail:
          '达成该状态所需的证据强度不同：workledger 的 `evaluateActionTransition()` 强制要求给出 `user_report`' +
          '（`{ message_id, note }`，缺则 `missing_user_report`）；clock 的 `assertTransition()` 不强制携带任何回执' +
          '（只禁止"非 confirmed 目标携带 readback"）。含义相同 → 判为等价；校验强度不同 → 登记在此。',
        recommendation:
          '建议 clock 侧也对齐 workledger：转「用户报告完成」必须给出用户报告的来源消息 id，' +
          '否则"用户口述"无从审计。在对齐前按"严格度差异"处理，不影响两侧互译。',
      },
    ],
  },
  {
    clock: 'failed',
    workledger: 'invalidated_or_failed',
    equivalent: true,
    rationale:
      '两侧同义：终态、无出边；既表示"已失效"（外部废止/过期）也表示"失败"（被拒/出错/取消），' +
      '时钟侧的 `FailureKind` 与之相容。',
    differences: [],
  },
]);

// ---------------------------------------------------------------------------
// 二、结构等价计算（让判据**不恒真**）
// ---------------------------------------------------------------------------

/** 探针回执：只用于"这条边存在吗"的探测，不进入任何台账。 */
const PROBE_READBACK: ClockActionReceipt = Object.freeze({
  kind: 'readback',
  source: 'alignment-probe',
  detail: '对齐探针：仅用于探测 clock 侧转换表是否含该边',
  observed: Object.freeze({ probe: '1' }),
});

/**
 * 探测 clock 侧是否允许 `from → to`。
 *
 * clock **未导出** `ALLOWED_TRANSITIONS`，故用 `assertTransition()` 逐对探测并重建出边
 * （带合法 context：目标为 `confirmed` 时给 readback 回执；`confirmed → failed` 的**唯一**
 * 合法理由是 `expired`）。探测只回答"边是否存在"，不产生副作用。
 */
function clockTransitionAllowed(from: ClockActionStateName, to: ClockActionStateName): boolean {
  try {
    if (from === 'confirmed') {
      assertTransition(from, to, { failureKind: 'expired' });
      return true;
    }
    assertTransition(from, to, to === 'confirmed' ? { receipt: PROBE_READBACK } : {});
    return true;
  } catch {
    return false;
  }
}

function mappedWorkledgerOf(clockState: ClockActionStateName): WorkledgerActionStateName {
  const entry = ACTION_STATE_ALIGNMENT.find((candidate) => candidate.clock === clockState);
  if (entry === undefined) {
    throw new Error(`clock 侧状态「${clockState}」未登记映射：新增状态必须先补 ACTION_STATE_ALIGNMENT（新增即失败）`);
  }
  return entry.workledger;
}

export interface StructuralEquivalence {
  readonly equivalent: boolean;
  /** 判定不等价的具体理由（空 = 等价）。 */
  readonly reasons: readonly string[];
}

/**
 * 由**两侧真实导出**计算一对状态是否结构等价：标签、终态性、出边集合（映射后）。
 *
 * 这是"声明 `equivalent` 不是恒真"的依据——`checkActionStateAlignment()` 会把
 * 本函数结果与表中声明比对，不一致即失败。
 */
export function computeActionStateStructuralEquivalence(
  entry: ActionStateAlignmentEntry,
): StructuralEquivalence {
  const reasons: string[] = [];

  const clockLabel: string | undefined = CLOCK_ACTION_STATE_LABELS[entry.clock];
  const workledgerLabel: string | undefined = WORKLEDGER_ACTION_STATE_LABELS[entry.workledger];
  if (clockLabel !== workledgerLabel) {
    reasons.push(`标签不同：clock="${String(clockLabel)}" vs workledger="${String(workledgerLabel)}"`);
  }

  const clockTerminal = isClockTerminal(entry.clock);
  const workledgerTerminal = isTerminalActionState(entry.workledger);
  if (clockTerminal !== workledgerTerminal) {
    reasons.push(`终态性不同：clock.isTerminal=${String(clockTerminal)} vs workledger=${String(workledgerTerminal)}`);
  }

  const mappedClockTargets = new Set<string>(
    CLOCK_ACTION_STATES.filter((to) => clockTransitionAllowed(entry.clock, to)).map((to) =>
      mappedWorkledgerOf(to),
    ),
  );
  const workledgerTargets = new Set<string>(
    WORKLEDGER_ACTION_STATES.filter((to) => canTransitionAction(entry.workledger, to)),
  );
  const onlyClock = [...mappedClockTargets].filter((target) => !workledgerTargets.has(target)).sort();
  const onlyWorkledger = [...workledgerTargets].filter((target) => !mappedClockTargets.has(target)).sort();
  if (onlyClock.length > 0 || onlyWorkledger.length > 0) {
    reasons.push(
      `出边集合不同：仅 clock 有 → ${onlyClock.join(',') || '无'}；仅 workledger 有 → ${onlyWorkledger.join(',') || '无'}`,
    );
  }

  return { equivalent: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// 三、一致性判据（新增即失败）
// ---------------------------------------------------------------------------

/**
 * 检查两侧状态词汇是否对齐；返回问题清单（空 = 通过）。
 *
 * 参数可注入，便于用"人为加了一个状态"的列表做**可失败**的对照用例
 * （证明判据不是恒真）。
 */
export function checkActionStateAlignment(
  clockStates: readonly string[] = CLOCK_ACTION_STATES,
  workledgerStates: readonly string[] = WORKLEDGER_ACTION_STATES,
): readonly string[] {
  const problems: string[] = [];
  const clockSet = new Set<string>(clockStates);
  const workledgerSet = new Set<string>(workledgerStates);

  // 1. 映射表引用的状态必须在两侧真实存在（删除/改名即暴露）。
  for (const entry of ACTION_STATE_ALIGNMENT) {
    if (!clockSet.has(entry.clock)) problems.push(`映射表引用了 clock 侧不存在的状态：${entry.clock}`);
    if (!workledgerSet.has(entry.workledger)) {
      problems.push(`映射表引用了 workledger 侧不存在的状态：${entry.workledger}`);
    }
  }

  // 2. 双向覆盖：任一状态没登记 ⇒ **新增即失败**（不静默忽略）。
  const mappedClock = new Set<string>(ACTION_STATE_ALIGNMENT.map((entry) => entry.clock));
  const mappedWorkledger = new Set<string>(ACTION_STATE_ALIGNMENT.map((entry) => entry.workledger));
  for (const state of clockStates) {
    if (!mappedClock.has(state)) {
      problems.push(`clock 侧状态「${state}」未登记映射：另一侧没有跟上（新增即失败）`);
    }
  }
  for (const state of workledgerStates) {
    if (!mappedWorkledger.has(state)) {
      problems.push(`workledger 侧状态「${state}」未登记映射：另一侧没有跟上（新增即失败）`);
    }
  }

  // 3. 双向唯一：一对一，不允许两侧各自重复指向。
  for (const side of ['clock', 'workledger'] as const) {
    const seen = new Set<string>();
    for (const entry of ACTION_STATE_ALIGNMENT) {
      const key = entry[side];
      if (seen.has(key)) problems.push(`映射表中 ${side} 侧状态「${key}」重复出现：映射必须是一对一`);
      seen.add(key);
    }
  }

  // 4. 声明的等价性必须与结构计算一致（**非恒真**的落点），且不等价必须给出依据与建议。
  for (const entry of ACTION_STATE_ALIGNMENT) {
    if (!clockSet.has(entry.clock) || !workledgerSet.has(entry.workledger)) continue; // 已由 1 报出
    const structural = computeActionStateStructuralEquivalence(entry);
    if (structural.equivalent !== entry.equivalent) {
      problems.push(
        `等价性声明与结构计算不符：${entry.clock} ↔ ${entry.workledger} ` +
          `声明 equivalent=${String(entry.equivalent)}，结构计算=${String(structural.equivalent)}` +
          `（${structural.reasons.join('；')}）——不得硬映射，也不得把真实分歧标成等价`,
      );
    }
    const meaningDiffs = entry.differences.filter((difference) => difference.kind === 'meaning');
    if (!entry.equivalent) {
      if (meaningDiffs.length === 0) {
        problems.push(
          `不等价项 ${entry.clock} ↔ ${entry.workledger} 未登记「语义」差异：不得只置 equivalent=false 而不说明`,
        );
      }
      for (const difference of entry.differences) {
        if (difference.recommendation.trim().length === 0) {
          problems.push(`不等价项 ${entry.clock} ↔ ${entry.workledger} 的差异缺少「建议口径」`);
        }
      }
    } else if (meaningDiffs.length > 0) {
      problems.push(
        `项 ${entry.clock} ↔ ${entry.workledger} 声明等价（equivalent=true），却登记了「语义」差异：自相矛盾`,
      );
    }
  }

  return problems;
}

/** 判据的**断言**形式：任一侧新增/漂移即抛出（供 CI / 集成点调用）。 */
export function assertActionStateAlignment(
  clockStates: readonly string[] = CLOCK_ACTION_STATES,
  workledgerStates: readonly string[] = WORKLEDGER_ACTION_STATES,
): void {
  const problems = checkActionStateAlignment(clockStates, workledgerStates);
  if (problems.length > 0) {
    throw new Error(`动作状态跨包对齐失败（${problems.length} 项）：\n- ${problems.join('\n- ')}`);
  }
}

// ---------------------------------------------------------------------------
// 四、双向映射（非同义项**不硬映射**）
// ---------------------------------------------------------------------------

function translationOf(
  entry: ActionStateAlignmentEntry,
  side: 'clock' | 'workledger',
): ActionStateTranslation {
  const label = CLOCK_ACTION_STATE_LABELS[entry.clock];
  return {
    from_side: side,
    from: side === 'clock' ? entry.clock : entry.workledger,
    to_side: side === 'clock' ? 'workledger' : 'clock',
    to: side === 'clock' ? entry.workledger : entry.clock,
    equivalent: entry.equivalent,
    label,
    rationale: entry.rationale,
  };
}

/** clock 键名 → workledger 键名（带等价标记；未登记即抛，新增状态不可能静默通过）。 */
export function translateClockStateToWorkledger(state: ClockActionStateName): ActionStateTranslation {
  const entry = ACTION_STATE_ALIGNMENT.find((candidate) => candidate.clock === state);
  if (entry === undefined) {
    throw new Error(`clock 侧状态「${state}」未登记映射：新增状态必须先补 ACTION_STATE_ALIGNMENT（新增即失败）`);
  }
  return translationOf(entry, 'clock');
}

/** workledger 键名 → clock 键名（带等价标记；未登记即抛）。 */
export function translateWorkledgerStateToClock(state: WorkledgerActionStateName): ActionStateTranslation {
  const entry = ACTION_STATE_ALIGNMENT.find((candidate) => candidate.workledger === state);
  if (entry === undefined) {
    throw new Error(`workledger 侧状态「${state}」未登记映射：新增状态必须先补 ACTION_STATE_ALIGNMENT（新增即失败）`);
  }
  return translationOf(entry, 'workledger');
}

/**
 * **反向对照**：断言两个状态**同义**，允许互译。
 *
 * 非同义对（如 `confirmed` ↔ `confirmed_complete`）在此**抛错**——这就是"不得硬映射"的落点。
 * 判据不恒真：同义对（如 `prepared` ↔ `prepared`）不抛，且会再核一遍结构等价。
 */
export function assertEquivalentActionStates(
  clockState: ClockActionStateName,
  workledgerState: WorkledgerActionStateName,
): void {
  const entry = ACTION_STATE_ALIGNMENT.find((candidate) => candidate.clock === clockState);
  if (entry === undefined || entry.workledger !== workledgerState) {
    throw new Error(`没有登记的映射对：${clockState} ↔ ${workledgerState}`);
  }
  const structural = computeActionStateStructuralEquivalence(entry);
  if (!entry.equivalent || !structural.equivalent) {
    throw new Error(
      `「${CLOCK_ACTION_STATE_LABELS[clockState]}」在两侧**不等价**（${clockState} ↔ ${workledgerState}）：${entry.rationale}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 五、差异登记表（供展示层 / 复核引用）
// ---------------------------------------------------------------------------

export interface RegisteredActionStateDifference extends ActionStateDifference {
  readonly clock: ClockActionStateName;
  readonly workledger: WorkledgerActionStateName;
  /** 对应映射对是否等价（`meaning` 差异 ⇒ 必为 false）。 */
  readonly pair_equivalent: boolean;
}

/** 全部已登记差异（含 `strictness`），由映射表派生，避免两处各写一份。 */
export const ACTION_STATE_DIFFERENCES: readonly RegisteredActionStateDifference[] = Object.freeze(
  ACTION_STATE_ALIGNMENT.flatMap((entry) =>
    entry.differences.map((difference) =>
      Object.freeze({
        ...difference,
        clock: entry.clock,
        workledger: entry.workledger,
        pair_equivalent: entry.equivalent,
      }),
    ),
  ),
);

// ---------------------------------------------------------------------------
// 六、幂等键收口（I-5）
// ---------------------------------------------------------------------------

/**
 * clock 侧 `ActionRequest` → workledger **权威**幂等键。
 *
 * 唯一的键推导算法在 workledger（`deriveIdempotencyKey()`：绑定 `task_revision` + 参数摘要）；
 * 本函数只把 clock 的请求**投影**成该算法的入参，**不另立算法**：
 *
 * - `task_id`       ← `request.requestId`（clock 侧请求的稳定身份）
 * - `task_revision` ← `request.revision`   ← **这就是修 I-5 的关键**：版本进入键
 * - `action_kind`   ← `request.toolId`
 * - `param_digest`  ← `sha256([toolId, canonical({ requestId })])`
 *   （clock 的 `ActionRequest` **不含参数**，故以 requestId 的规范化摘要顶替；
 *   键里多一维只会把两个动作判**不同**，不会把不同动作误判为同一动作——宁多算、不可少算。）
 *
 * 于是：同 `requestId`、`revision` 1 vs 999 ⇒ **不同的键** ⇒ 不被判为同一动作。
 */
export function deriveClockLedgerKey(request: ClockActionRequest): string {
  return deriveIdempotencyKey({
    task_id: asTaskId(request.requestId),
    task_revision: asRevision(request.revision),
    action_kind: request.toolId,
    param_digest: computeActionParamDigest(request.toolId, { requestId: request.requestId }),
  });
}

/**
 * 供 `createActionLedger()` 直接使用的、**版本敏感**的台账选项。
 *
 * 用法：`createActionLedger(versionAwareClockLedgerOptions())`。
 * 不调用它（默认不注入）时，clock 台账只按 `requestId` 去重，**不校验版本**。
 */
export function versionAwareClockLedgerOptions(): ActionLedgerOptions {
  return { deriveIdempotencyKey: deriveClockLedgerKey };
}
