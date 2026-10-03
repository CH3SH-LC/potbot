/**
 * 候选模型与"**不编造候选**"的结构性保证（MT-02 / MT-03 / MT-04 / MT-05 / MT-06）。
 *
 * ## 结构性保证（不是注释约定）
 *
 * `Candidate` 的 `provenance` 字段**必填且非空**，且 {@link validateCandidate} 会拒绝
 * 任何缺来源的候选。更重要的是：**本模块根本没有"凭空生成候选"的代码路径**——
 * 唯一的候选来源是
 * 1. {@link searchCandidates}：**必须**注入已授权接口端口，端口未接通 ⇒ `not_ready`；
 * 2. {@link candidatesFromUserShare}：用户分享的内容，来源标为 `user_shared`，
 *    与在线来源**分开标识**（MT-04）。
 *
 * ## 未知值分别标记（MT-03）
 *
 * 价格/库存/营业/路线各用一个 {@link KnownValue}：未知时**必须**带原因，
 * 不允许用空串或 0 冒充。标价**不是**最终价——`price.isFinalPrice` 恒为 false（MT-03）。
 *
 * ## 不引入第三方依赖
 *
 * `src/**` 的运行期依赖为零（纪律扫描器断言 `dependencies === {}`），故全部为纯 TS。
 */

/** 已知值 / 未知值（未知**必填原因**）。 */
export type KnownValue<T> =
  | { readonly known: true; readonly value: T }
  | { readonly known: false; readonly reason: string };

export function known<T>(value: T): KnownValue<T> {
  return { known: true, value };
}

export function unknown<T>(reason: string): KnownValue<T> {
  return { known: false, reason };
}

/** 候选来源：**只有这两种**。 */
export type CandidateSourceKind =
  /** 来自已授权的真实接口 / MCP / Skills。 */
  | 'authorized_interface'
  /** 来自用户分享的文本/链接/图片/文件。 */
  | 'user_shared';

export interface CandidateProvenance {
  readonly sourceKind: CandidateSourceKind;
  /** 接口 id 或用户分享物的标识（**不得为空**）。 */
  readonly sourceRef: string;
  readonly fetchedAtMs: number;
}

export interface CandidatePrice {
  readonly amountYuan: number;
  readonly currency: string;
  /** 适用条件（如"仅工作日"）；无则 null。 */
  readonly condition: string | null;
  /**
   * **恒为 false**：这是**标价**，不是最终价（MT-03）。
   * 写成字面量类型使"把标价当最终价"在类型层面就不成立。
   */
  readonly isFinalPrice: false;
}

export interface Candidate {
  readonly id: string;
  readonly title: string;
  readonly provenance: CandidateProvenance;
  readonly price: KnownValue<CandidatePrice>;
  readonly stock: KnownValue<string>;
  readonly businessHours: KnownValue<string>;
  readonly route: KnownValue<string>;
  readonly distanceKm: KnownValue<number>;
  /** 硬条件匹配所需的**结构化**字段（宣传话术**不在此处**，故无法影响规则）。 */
  readonly structured: Readonly<Record<string, string>>;
}

/** 已授权接口返回的原始条目（**未**归一）。 */
export interface RawCandidate {
  readonly id: string;
  readonly title: string;
  readonly fields: Readonly<Record<string, string>>;
  /**
   * 原始响应里的宣传话术。**刻意**在归一为 `Candidate` 时**丢弃**——
   * MT-05 要求"资料中的宣传话术不改变用户规则"，把它从模型里拿掉是最强的保证。
   */
  readonly promotionalText?: string;
}

export interface SearchQuery {
  readonly category: string;
  readonly location: string;
  readonly people?: number;
  readonly budgetYuan?: number;
  readonly date?: string;
  readonly preferences?: readonly string[];
}

/** MT-02「查询条件和结果范围可见」。 */
export interface QueryVisibility {
  readonly provided: readonly string[];
  readonly missing: readonly string[];
  readonly note: string;
}

/** 已授权的美团接口端口。**未接通时为 null**——那时不产出任何候选。 */
export interface AuthorizedMeituanSearchPort {
  readonly sourceId: string;
  search(
    query: SearchQuery,
  ): Promise<{ readonly ok: true; readonly raw: readonly RawCandidate[] } | { readonly ok: false; readonly reason: string }>;
}

export type CandidateSearchResult =
  | {
      readonly status: 'ok';
      readonly candidates: readonly Candidate[];
      readonly visibility: QueryVisibility;
    }
  | {
      readonly status: 'not_ready' | 'unavailable';
      /** 状态非 ok 时**必填**原因。 */
      readonly reason: string;
      readonly visibility: QueryVisibility;
      /** **恒为空**：不编造候选顶替。 */
      readonly candidates: readonly [];
    };

/** 计算"查询条件可见性"。 */
export function describeVisibility(query: SearchQuery): QueryVisibility {
  const provided: string[] = [];
  const missing: string[] = [];
  const consider = (name: string, value: unknown): void => {
    if (value === undefined || value === null || value === '') missing.push(name);
    else provided.push(name);
  };
  consider('品类', query.category);
  consider('位置', query.location);
  consider('人数', query.people);
  consider('预算', query.budgetYuan);
  consider('日期', query.date);
  consider('偏好', query.preferences === undefined || query.preferences.length === 0 ? undefined : query.preferences);

  return {
    provided,
    missing,
    note:
      missing.length === 0
        ? '查询条件已完整给出；结果范围以已授权接口的覆盖区域/业务为限。'
        : `以下条件未给出，结果范围因此更宽：${missing.join('、')}。仅比较返回的候选，**不**宣称全平台最优。`,
  };
}

/** 每条候选必须能指回来源；缺来源即不合格。 */
export function validateCandidate(candidate: Candidate): readonly string[] {
  const problems: string[] = [];
  if (candidate.id.trim() === '') problems.push('候选 id 不得为空');
  if (candidate.title.trim() === '') problems.push('候选标题不得为空');
  if (candidate.provenance.sourceRef.trim() === '') {
    problems.push('候选**没有来源**：不得把模型生成的条目当候选（MT-02）');
  }
  if (!Number.isFinite(candidate.provenance.fetchedAtMs)) {
    problems.push('候选缺少获取时间');
  }
  if (candidate.provenance.sourceKind === 'authorized_interface' && candidate.provenance.sourceRef === '') {
    problems.push('在线候选必须带接口来源标识');
  }
  return problems;
}

/**
 * 查询候选。
 *
 * - `port === null`（**本批的默认情形**）⇒ `not_ready` + 原因，**候选恒为空**；
 * - 接口返回 `ok: false` ⇒ `unavailable` + 接口给的原因（**不**代之以模型知识）；
 * - 接口返回 `ok: true` ⇒ 逐条归一，并**逐条校验来源**；有不合格条目则整体 `unavailable`
 *   （宁可不给，也不给一条来路不明的）。
 */
export async function searchCandidates(
  port: AuthorizedMeituanSearchPort | null,
  query: SearchQuery,
  fetchedAtMs: number,
): Promise<CandidateSearchResult> {
  const visibility = describeVisibility(query);

  if (port === null) {
    return {
      status: 'not_ready',
      reason:
        '未接通任何已授权的美团接口 / MCP / Skills：无账号、无工具清单（见 readiness-matrix 的 MT-01）。' +
        '无真实来源时**不得**用模型知识生成候选（MT-02），故此处不返回任何候选。',
      visibility,
      candidates: [],
    };
  }

  const response = await port.search(query);
  if (!response.ok) {
    return {
      status: 'unavailable',
      reason: `已授权接口未能返回结果：${response.reason}`,
      visibility,
      candidates: [],
    };
  }

  const candidates: Candidate[] = [];
  for (const raw of response.raw) {
    const candidate = normalizeCandidate(raw, port.sourceId, fetchedAtMs);
    const problems = validateCandidate(candidate);
    if (problems.length > 0) {
      return {
        status: 'unavailable',
        reason: `接口返回的条目不合格（${problems.join('；')}）⇒ 拒绝整批，不混入来路不明的候选。`,
        visibility,
        candidates: [],
      };
    }
    candidates.push(candidate);
  }

  return { status: 'ok', candidates, visibility };
}

/** 原始条目 → 候选（**丢弃宣传话术**）。 */
export function normalizeCandidate(raw: RawCandidate, sourceRef: string, fetchedAtMs: number): Candidate {
  const fields = raw.fields;
  const priceText = fields['priceYuan'];
  const price: KnownValue<CandidatePrice> =
    priceText === undefined
      ? unknown('接口未给出价格')
      : (() => {
          const amount = Number(priceText);
          return Number.isFinite(amount)
            ? known({
                amountYuan: amount,
                currency: fields['currency'] ?? 'CNY',
                condition: fields['priceCondition'] ?? null,
                isFinalPrice: false as const,
              })
            : unknown(`价格无法解析：「${priceText}」`);
        })();

  const distanceText = fields['distanceKm'];
  const distanceKm: KnownValue<number> =
    distanceText === undefined
      ? unknown('接口未给出距离/路线')
      : (() => {
          const value = Number(distanceText);
          return Number.isFinite(value) ? known(value) : unknown(`距离无法解析：「${distanceText}」`);
        })();

  return {
    id: raw.id,
    title: raw.title,
    provenance: { sourceKind: 'authorized_interface', sourceRef, fetchedAtMs },
    price,
    stock: optionalField(fields, 'stock', '接口未给出库存'),
    businessHours: optionalField(fields, 'businessHours', '接口未给出营业信息'),
    route: optionalField(fields, 'route', '接口未给出路线'),
    distanceKm,
    // 只搬运结构化字段；`promotionalText` 是 `RawCandidate` 的**兄弟**属性，
    // 不进入 `fields`，因此这里天然不会被带进模型（MT-05 的口径）。
    structured: { ...fields },
  };
}

function optionalField(
  fields: Readonly<Record<string, string>>,
  key: string,
  missingReason: string,
): KnownValue<string> {
  const value = fields[key];
  return value === undefined || value === '' ? unknown(missingReason) : known(value);
}

// ---------------------------------------------------------------------------
// MT-04：用户分享的补充（与在线来源**分开标识**）
// ---------------------------------------------------------------------------

export interface UserSharedItem {
  readonly title: string;
  readonly detail: string;
  /** 分享物标识（文件名 / 链接 / "粘贴文本#1"）。 */
  readonly sourceRef: string;
}

export function candidatesFromUserShare(
  items: readonly UserSharedItem[],
  fetchedAtMs: number,
): readonly Candidate[] {
  return items.map((item, index) => ({
    id: `user-shared-${String(index + 1)}`,
    title: item.title,
    provenance: { sourceKind: 'user_shared' as const, sourceRef: item.sourceRef, fetchedAtMs },
    price: unknown('用户分享内容未给出可核对的价格'),
    stock: unknown('用户分享内容不含库存'),
    businessHours: unknown('用户分享内容不含营业信息'),
    route: unknown('用户分享内容不含路线'),
    distanceKm: unknown('用户分享内容不含距离'),
    structured: { detail: item.detail },
  }));
}

/** 把在线候选与用户分享候选**分开**（MT-04 要求分开标识，不混在一起排序）。 */
export function partitionBySource(
  candidates: readonly Candidate[],
): { readonly online: readonly Candidate[]; readonly userShared: readonly Candidate[] } {
  return {
    online: candidates.filter((candidate) => candidate.provenance.sourceKind === 'authorized_interface'),
    userShared: candidates.filter((candidate) => candidate.provenance.sourceKind === 'user_shared'),
  };
}

// ---------------------------------------------------------------------------
// MT-05：可解释筛选 / 比较 / 排序 / 硬条件冲突
// ---------------------------------------------------------------------------

export type HardRule =
  | { readonly kind: 'maxPriceYuan'; readonly value: number }
  | { readonly kind: 'withinKm'; readonly value: number }
  | { readonly kind: 'mustBeOpenAt'; readonly value: string }
  | { readonly kind: 'minStock'; readonly value: number };

export type SoftRule =
  | { readonly kind: 'preferCheaper' }
  | { readonly kind: 'preferCloser' };

export interface UserRules {
  readonly hard: readonly HardRule[];
  readonly soft: readonly SoftRule[];
}

export interface Rejection {
  readonly candidateId: string;
  readonly rule: HardRule;
  readonly reason: string;
}

export interface RuleOutcome {
  readonly kept: readonly Candidate[];
  readonly rejected: readonly Rejection[];
  /** 某条硬条件把**全部**候选都挡掉时的冲突（必须可见，MT-05）。 */
  readonly conflicts: readonly { readonly rule: HardRule; readonly reason: string }[];
}

/** 应用用户规则。**只读结构化字段**；宣传话术不在模型里，结构上无法影响结果。 */
export function applyRules(candidates: readonly Candidate[], rules: UserRules): RuleOutcome {
  const rejected: Rejection[] = [];
  let kept = [...candidates];

  for (const rule of rules.hard) {
    const survivors: Candidate[] = [];
    for (const candidate of kept) {
      const failure = evaluateHardRule(candidate, rule);
      if (failure === null) survivors.push(candidate);
      else rejected.push({ candidateId: candidate.id, rule, reason: failure });
    }
    kept = survivors;
  }

  // 硬条件冲突：输入非空但被筛空 ⇒ 逐条列出"参与淘汰"的硬条件，便于解释是哪条卡死的。
  const conflicts: { rule: HardRule; reason: string }[] =
    candidates.length > 0 && kept.length === 0
      ? dedupeRules(rejected.map((entry) => entry.rule)).map((rule) => ({
          rule,
          reason: `硬条件「${describeHardRule(rule)}」参与了淘汰，最终无候选剩余`,
        }))
      : [];

  return { kept: rankCandidates(kept, rules.soft), rejected, conflicts };
}

function dedupeRules(rules: readonly HardRule[]): HardRule[] {
  const out: HardRule[] = [];
  for (const rule of rules) {
    if (!out.some((existing) => describeHardRule(existing) === describeHardRule(rule))) out.push(rule);
  }
  return out;
}

function evaluateHardRule(candidate: Candidate, rule: HardRule): string | null {
  switch (rule.kind) {
    case 'maxPriceYuan': {
      if (!candidate.price.known) return `价格未知（${candidate.price.reason}），无法判断是否超预算`;
      return candidate.price.value.amountYuan <= rule.value
        ? null
        : `标价 ${String(candidate.price.value.amountYuan)} 元超过上限 ${String(rule.value)} 元`;
    }
    case 'withinKm': {
      if (!candidate.distanceKm.known) return `距离未知（${candidate.distanceKm.reason}），无法判断范围`;
      return candidate.distanceKm.value <= rule.value ? null : `距离超出 ${String(rule.value)} km`;
    }
    case 'mustBeOpenAt': {
      if (!candidate.businessHours.known) return `营业信息未知（${candidate.businessHours.reason}），无法判断`;
      return candidate.businessHours.value.includes(rule.value) ? null : `营业时间不含 ${rule.value}`;
    }
    case 'minStock': {
      if (!candidate.stock.known) return `库存未知（${candidate.stock.reason}），无法判断`;
      const value = Number(candidate.stock.value);
      return Number.isFinite(value) && value >= rule.value ? null : `库存不足 ${String(rule.value)}`;
    }
  }
}

function describeHardRule(rule: HardRule): string {
  switch (rule.kind) {
    case 'maxPriceYuan':
      return `预算 ≤ ${String(rule.value)} 元`;
    case 'withinKm':
      return `距离 ≤ ${String(rule.value)} km`;
    case 'mustBeOpenAt':
      return `营业时间含 ${rule.value}`;
    case 'minStock':
      return `库存 ≥ ${String(rule.value)}`;
  }
}

/**
 * 排序：**只用结构化已知值**（价格/距离）。
 * 未知值排在最后并**保留**（不丢弃、不按 0 处理，MT-03「缺失不当零」的口径）。
 */
export function rankCandidates(candidates: readonly Candidate[], soft: readonly SoftRule[]): readonly Candidate[] {
  const scored = candidates.map((candidate, index) => ({ candidate, index }));
  scored.sort((a, b) => {
    for (const rule of soft) {
      const diff = compareByRule(a.candidate, b.candidate, rule);
      if (diff !== 0) return diff;
    }
    return a.index - b.index;
  });
  return scored.map((entry) => entry.candidate);
}

function compareByRule(a: Candidate, b: Candidate, rule: SoftRule): number {
  switch (rule.kind) {
    case 'preferCheaper': {
      const av = a.price.known ? a.price.value.amountYuan : null;
      const bv = b.price.known ? b.price.value.amountYuan : null;
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return av - bv;
    }
    case 'preferCloser': {
      const av = a.distanceKm.known ? a.distanceKm.value : null;
      const bv = b.distanceKm.known ? b.distanceKm.value : null;
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return av - bv;
    }
  }
}

// ---------------------------------------------------------------------------
// MT-06：把获准事实交给下游（保留来源与时间；**未接下游**）
// ---------------------------------------------------------------------------

export interface ExportedCandidateFact {
  readonly key: string;
  readonly value: string;
  /** 来源（接口 id / 用户分享物）。 */
  readonly sourceRef: string;
  readonly sourceKind: CandidateSourceKind;
  readonly observedAtMs: number;
  readonly kind: 'fact';
}

/**
 * 导出**获准**的候选事实（供预算/文档/演示模板使用，保留来源与时间）。
 * **未接任何下游模板**：本批只产出结构，不宣称已在其他模板生效（同 FA-G2 的 RES-07 口径）。
 */
export function exportCandidateFacts(candidates: readonly Candidate[]): readonly ExportedCandidateFact[] {
  const facts: ExportedCandidateFact[] = [];
  for (const candidate of candidates) {
    if (!candidate.price.known) continue;
    facts.push({
      key: `candidate:${candidate.id}:priceYuan`,
      value: String(candidate.price.value.amountYuan),
      sourceRef: candidate.provenance.sourceRef,
      sourceKind: candidate.provenance.sourceKind,
      observedAtMs: candidate.provenance.fetchedAtMs,
      kind: 'fact',
    });
  }
  return facts;
}

/** 供展示层使用的状态说明。 */
export function describeSearchStatus(status: CandidateSearchResult['status']): string {
  const map: Record<CandidateSearchResult['status'], string> = {
    ok: '已取回真实候选',
    not_ready: '未就绪：没有可用来源，未产出任何候选',
    unavailable: '来源不可用：未能取回候选，未以模型知识替代',
  };
  return map[status];
}
