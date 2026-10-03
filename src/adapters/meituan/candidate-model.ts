/**
 * MT-02：按品类 / 位置 / 人数 / 预算 / 日期 / 偏好查询**实际可得**候选。
 *
 * ## 本模块相对 `candidates.ts` 多出来的那道闸
 *
 * `candidates.ts` 已经保证「端口未接通 ⇒ 候选恒为空」。但"端口通了"并**不**等于
 * "回来的东西可信"：一个被错误装配的端口、一个被污染的响应，都可能塞进一条
 * **有 `sourceRef` 字符串、却不在任何已核实来源清单里**的条目——那正是 MT-02 想拦的
 * "看起来有来源的臆造"。因此本模块在端口之上再加一道 **来源白名单闸**：
 *
 * 1. 显式给出已核实来源清单时以显式为准（**排他**）；未显式给出时才信任注入端口的 `sourceId`；
 * 2. 端口返回的每一条候选，其 `provenance.sourceRef` **必须**命中白名单，
 *    否则**整批**判 `unavailable`，一条都不放行（宁可不给，也不给一条来路不明的）；
 * 3. `model_fabricated` 是**字面量 `false`**：本模块在类型层面就不存在
 *    "用模型知识生成候选"的返回路径。
 *
 * 查询条件（`describeVisibility`）与**结果范围**（`ResultScope`）随结果一并给出，
 * 使"这次到底看了什么、看到多少"是可见的，而不是一句"已为你找到最优"。
 *
 * ## 平台前置未就绪 = 如实未就绪（不伪造）
 *
 * 平台未登录 / 无工具清单时，本模块**不**退化成"凭常识推荐几家店"，
 * 而是返回结构化的 `not_ready`（`candidates: readonly []`）。
 */

import {
  describeVisibility,
  searchCandidates,
  type AuthorizedMeituanSearchPort,
  type Candidate,
  type CandidateSearchResult,
  type QueryVisibility,
  type SearchQuery,
} from './candidates.js';

/** 结果范围：本次结果**实际**覆盖到哪儿（MT-02「结果范围可见」）。 */
export interface ResultScope {
  /** 本次真正参与结果的来源 id（未就绪时为空）。 */
  readonly sourceIds: readonly string[];
  readonly candidateCount: number;
  /** 结果只代表"这些来源返回的这些条目"，**不**代表全平台。 */
  readonly limitedToReturned: true;
  readonly note: string;
}

/** 被白名单闸挡下的条目（连同它自称的来源）。 */
export interface RejectedCandidateEntry {
  readonly candidateId: string;
  readonly claimedSourceRef: string;
  readonly reason: string;
}

/** MT-02 的查询出口。 */
export interface CandidateQueryOutcome {
  readonly readiness: CandidateSearchResult['status'];
  readonly ready: boolean;
  /** 未就绪 / 不可用时**恒为空**。 */
  readonly candidates: readonly Candidate[];
  readonly visibility: QueryVisibility;
  readonly scope: ResultScope;
  /** 状态非 ok 时必填原因。 */
  readonly reason: string | null;
  /** 被白名单闸挡下的条目（可审计：为什么没给你这条）。 */
  readonly rejected: readonly RejectedCandidateEntry[];
  /**
   * **恒为 false**：本模块没有"用模型知识生成候选"的代码路径。
   * 写成字面量类型，使"返回模型臆造的店"在类型层面不成立。
   */
  readonly model_fabricated: false;
}

const NOT_READY_REASON =
  '平台未登录、未取得工具清单（见 not-ready.ts 的 MT-01）：没有已核实的来源，' +
  '按 MT-02 **不得**用模型知识生成候选，故不返回任何店。';

/**
 * 已登记（已核实）的来源白名单。
 *
 * - **显式给出**时以显式为准（**排他**）：这是配置里逐个核实过的来源清单，
 *   端口自己声称的 `sourceId` **不**自动获得信任——装配错端口 / 响应被污染即在此现形；
 * - **未显式给出**时退化为"信任注入端口的 `sourceId`"（方便默认用法），
 *   此时白名单闸只能拦"来源字符串为空"的条目。
 */
export function resolveRegisteredSources(
  port: AuthorizedMeituanSearchPort | null,
  explicit: readonly string[] | undefined,
): readonly string[] {
  if (explicit !== undefined) {
    const ids = new Set<string>();
    for (const id of explicit) if (id.trim() !== '') ids.add(id);
    return Object.freeze([...ids]);
  }
  return Object.freeze(port === null ? [] : [port.sourceId]);
}

/**
 * 逐条核对来源：`sourceRef` 必须命中白名单。
 * 这是"**看起来有来源**的臆造"被拦下的地方——仅有 `sourceRef` 字符串不算数。
 */
export function screenCandidates(
  registeredSourceIds: readonly string[],
  candidates: readonly Candidate[],
): { readonly accepted: readonly Candidate[]; readonly rejected: readonly RejectedCandidateEntry[] } {
  const accepted: Candidate[] = [];
  const rejected: RejectedCandidateEntry[] = [];
  for (const candidate of candidates) {
    const sourceRef = candidate.provenance.sourceRef;
    if (sourceRef.trim() === '') {
      rejected.push({
        candidateId: candidate.id,
        claimedSourceRef: sourceRef,
        reason: '条目**没有任何来源**：拒绝（MT-02：不得把模型生成的条目当候选）',
      });
      continue;
    }
    if (!registeredSourceIds.includes(sourceRef)) {
      rejected.push({
        candidateId: candidate.id,
        claimedSourceRef: sourceRef,
        reason: `来源「${sourceRef}」**不在已核实来源清单**里：拒绝该条，不放进结果`,
      });
      continue;
    }
    accepted.push(candidate);
  }
  return { accepted, rejected };
}

/** 组装"结果范围"。 */
export function buildResultScope(
  sourceIds: readonly string[],
  candidateCount: number,
  visibility: QueryVisibility,
): ResultScope {
  const note =
    candidateCount === 0
      ? '本次没有取回任何候选（未就绪或全部被来源闸挡下）：**不**以模型知识补位。'
      : `结果来自 ${sourceIds.join('、')} 共 ${String(candidateCount)} 条；` +
        `仅代表这些来源返回的这些条目，**不**代表全平台（${visibility.missing.length > 0 ? `且缺 ${visibility.missing.join('、')} 等条件` : '条件已完整给出'}）。`;
  return {
    sourceIds,
    candidateCount,
    limitedToReturned: true,
    note,
  };
}

/**
 * 查询实际可得候选。
 *
 * - 未注入端口 ⇒ `not_ready`，候选恒为空（**不伪造**）；
 * - 端口返回失败 ⇒ `unavailable`，用接口给的原因（**不**代之以模型知识）；
 * - 端口有返回但来源不白 ⇒ 整批 `unavailable`，候选恒为空。
 */
export async function queryCandidates(
  port: AuthorizedMeituanSearchPort | null,
  query: SearchQuery,
  fetchedAtMs: number,
  explicitRegisteredSourceIds?: readonly string[],
): Promise<CandidateQueryOutcome> {
  const visibility = describeVisibility(query);
  const registered = resolveRegisteredSources(port, explicitRegisteredSourceIds);

  if (port === null) {
    return {
      readiness: 'not_ready',
      ready: false,
      candidates: [],
      visibility,
      scope: buildResultScope([], 0, visibility),
      reason: NOT_READY_REASON,
      rejected: [],
      model_fabricated: false,
    };
  }

  const searched = await searchCandidates(port, query, fetchedAtMs);

  if (searched.status !== 'ok') {
    return {
      readiness: searched.status,
      ready: false,
      candidates: [],
      visibility: searched.visibility,
      scope: buildResultScope([], 0, searched.visibility),
      reason: searched.reason,
      rejected: [],
      model_fabricated: false,
    };
  }

  const screened = screenCandidates(registered, searched.candidates);
  if (screened.rejected.length > 0) {
    return {
      readiness: 'unavailable',
      ready: false,
      candidates: [],
      visibility,
      scope: buildResultScope([], 0, visibility),
      reason:
        `端口返回了 ${String(screened.rejected.length)} 条**来源未被核实**的条目 ⇒ 拒绝整批：` +
        `${screened.rejected.map((entry) => `${entry.candidateId}（自称来源「${entry.claimedSourceRef}」）`).join('、')}。` +
        '不允许把来源不明的条目混进候选（MT-02）。',
      rejected: screened.rejected,
      model_fabricated: false,
    };
  }

  return {
    readiness: 'ok',
    ready: true,
    candidates: screened.accepted,
    visibility,
    scope: buildResultScope(registered, screened.accepted.length, visibility),
    reason: null,
    rejected: [],
    model_fabricated: false,
  };
}

/**
 * 供展示层使用的状态说明（**不**说"已为你找到最优"）。
 */
export function describeQueryReadiness(readiness: CandidateQueryOutcome['readiness']): string {
  const map: Record<CandidateQueryOutcome['readiness'], string> = {
    ok: '已取回真实候选（来源与范围见 scope）',
    not_ready: '未就绪：平台未登录 / 无工具清单，未产出任何候选',
    unavailable: '来源不可用或来源未被核实：未产出任何候选，未以模型知识替代',
  };
  return map[readiness];
}
