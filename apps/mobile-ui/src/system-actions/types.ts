/**
 * F-R06 system-actions —— 日历 / 提醒 / 资料来源三类「专属详情表单」的类型与不变量。
 *
 * 零依赖、纯 TS、框架无关：不渲染、不引框架、不读真实文件/网络、不持久化、不碰
 * `KernelClient`。命令形状只**只读消费** `contracts/mobile-v1/types.ts`（见 command.ts）。
 *
 * 设计来源（只读参考）：
 *   - design-07 行 54–55（T06 日程详情 / T07 提醒与计时）、行 48（C05 来源与依据）；
 *   - design-07 行 133：日程/提醒动作必须展示**明确日期、时间、时区、目标账号/应用、
 *     重复规则和影响范围**，**相对时间不得直接作为最终执行摘要**；
 *   - design-07 行 187：CLK-07–10 …… **不把 dismiss 都标为删除**；
 *   - design-07 行 204「来源卡」状态词表：已读取 / 部分读取 / 未读取 / 过期 / 冲突 / 不可访问。
 *
 * 核心不变量（由同目录 `system-actions.test.ts` 机器化断言）：
 *   I-A 绝对时间：日程与提醒的**执行摘要只能来自绝对时间**（UTC 瞬时 + IANA 时区）。
 *       只给出相对表达（「明天上午 9 点」）而未经解析时，构建表单/命令一律抛
 *       `relative-time-not-resolved`——绝不把相对表达当最终执行摘要（fail-closed）。
 *   I-B 重复范围显式：修改已存在的重复日程时，必须显式给出 `this` /
 *       `this-and-future` / `whole-series`；缺省或非法抛
 *       `missing-recurrence-scope` / `invalid-recurrence-scope`，不猜默认范围。
 *   I-C 账号是引用：目标账号/应用只能是 `acct:`/`cal:`/`ref:` 形式的引用，不接受明文。
 *   I-D 提醒归属与权限：`owner='system'` 必须带系统通道引用；权限 `denied`/`unknown`
 *       时表单**可构建但不得声称已武装**（`armed=false` + `blockedReason`），不假报已设置。
 *   I-E dismiss ≠ delete：动作效果表把「停止未来触发」与「删除记录」分开，dismiss 不删记录。
 *   I-F 来源诚实：`read`/`partial` 必须有读取时间与证据片段，否则 `source-evidence-missing`；
 *       `unread` 不得携带证据（`unread-claims-evidence`）；`conflict` 必须列出冲突来源；
 *       来源地址不得是电脑绝对路径（`absolute-path-not-allowed`）。
 *   I-G 回统一对话：每个详情表单都带 `ConversationReturnTarget`；缺失/非法抛
 *       `missing-return-target` / `invalid-return-anchor`，返回只回**同一个**统一会话。
 *   I-H 修订守卫：写操作（mutate）必须带 `expectedRevision`，否则 `missing-expected-revision`。
 *
 * 本包**未做**（如实标注，不算已完成）：
 *   - 不渲染 DOM / Android View；只产出状态与描述（`*FormView`）。
 *   - 不解析自然语言相对时间：相对→绝对的解析由内核/模型侧完成，本包只校验「已解析
 *     的不变量」并对未解析者 fail-closed。
 *   - 不执行重复规则（RRULE）：`rule` 由内核给出，本包只搬运并对编辑范围做守卫。
 *   - 未与真实 `KernelClient` 接线：命令对象通过构造器产出，未发往手机内核。
 *   - 真实日历账号读写、系统提醒通道、真实检索端口均未接入。
 */

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

export type SystemActionErrorCode =
  // 通用
  | 'invalid-title'
  | 'invalid-ref-list'
  | 'invalid-revision'
  | 'missing-expected-revision'
  | 'unknown-system-action-kind'
  // 时间
  | 'invalid-timestamp'
  | 'missing-timezone'
  | 'invalid-timezone'
  | 'relative-time-not-resolved'
  | 'end-before-start'
  // 重复
  | 'invalid-recurrence'
  | 'missing-recurrence-scope'
  | 'invalid-recurrence-scope'
  // 账号 / 引用
  | 'missing-account-ref'
  | 'invalid-account-ref'
  // 日历
  | 'invalid-invite-state'
  // 提醒
  | 'invalid-reminder-kind'
  | 'invalid-reminder-owner'
  | 'missing-system-channel'
  | 'missing-duration'
  | 'invalid-duration'
  | 'invalid-reminder-action'
  // 来源
  | 'invalid-source-state'
  | 'invalid-origin-uri'
  | 'absolute-path-not-allowed'
  | 'source-evidence-missing'
  | 'unread-claims-evidence'
  | 'missing-conflict-refs'
  | 'missing-delete-scope'
  | 'delete-scope-incomplete'
  | 'invalid-delete-scope'
  // 返回
  | 'missing-return-target'
  | 'invalid-return-anchor';

/**
 * 结构化错误：只带 code + 可读 message + 脱敏 details。
 * 不含密钥 / 凭据 / 明文账号 / 真实地址 / 本地绝对路径 / 文件字节。
 * 测试按 `code` 断言，避免只匹配文案。
 */
export class SystemActionError extends Error {
  readonly code: SystemActionErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: SystemActionErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'SystemActionError';
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// 三类系统动作
// ---------------------------------------------------------------------------

export type SystemActionKind = 'calendar-event' | 'reminder' | 'research-source';

export const SYSTEM_ACTION_KINDS: readonly SystemActionKind[] = [
  'calendar-event',
  'reminder',
  'research-source',
];

// ---------------------------------------------------------------------------
// 表单告警：展示给用户的可见提示（冲突 / 权限 / 范围 / 诚实性）
// ---------------------------------------------------------------------------

export type WarningSeverity = 'info' | 'warn' | 'error';

export interface FormWarning {
  readonly code: string;
  readonly message: string;
  readonly severity: WarningSeverity;
}

/** 构造一条表单告警（不可变）。 */
export function makeWarning(code: string, message: string, severity: WarningSeverity = 'info'): FormWarning {
  return Object.freeze({ code, message, severity });
}

// ---------------------------------------------------------------------------
// 重复规则
// ---------------------------------------------------------------------------

/** 重复规则由内核给出（如 RFC 5545 RRULE 字符串）；本包不解析、只搬运。 */
export interface Recurrence {
  readonly rule: string;
  readonly count?: number;
}

/**
 * 修改已存在的重复日程/提醒时的作用范围：**分开确认**（design-07 行 189）。
 * 创建新系列时无需给出——整条系列正在被创建。
 */
export type RecurrenceScope = 'this' | 'this-and-future' | 'whole-series';

export const RECURRENCE_SCOPES: readonly RecurrenceScope[] = ['this', 'this-and-future', 'whole-series'];

// ---------------------------------------------------------------------------
// 通用校验小工具
// ---------------------------------------------------------------------------

/** 非空（去首尾空白后）字符串断言。 */
export function requireNonEmptyString(
  value: unknown,
  field: string,
  code: SystemActionErrorCode,
  message: string,
): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SystemActionError(code, message, { field });
  }
  return value.trim();
}

/** 标题规范化。 */
export function requireTitle(value: unknown, field = 'title'): string {
  return requireNonEmptyString(value, field, 'invalid-title', `${field} 必须是非空字符串`);
}

/** 可选引用列表 → 去空白后的字符串数组；非法元素抛 `invalid-ref-list`。 */
export function normalizeRefList(value: unknown, field: string): readonly string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new SystemActionError('invalid-ref-list', `${field} 必须是字符串数组`, { field });
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new SystemActionError('invalid-ref-list', `${field} 含非法引用`, { field });
    }
    out.push(item.trim());
  }
  return out;
}

/** 正整数断言（时长 ms 等）。 */
export function requirePositiveInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new SystemActionError('invalid-duration', `${field} 必须是正整数`, { field });
  }
  return value;
}

/** 非负整数断言（revision）。 */
export function requireRevision(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new SystemActionError('invalid-revision', `${field} 必须是非负整数`, { field });
  }
  return value;
}

/** 重复规则：`null` 表示不重复；对象必须带非空 `rule`。 */
export function requireRecurrence(value: unknown, field = 'recurrence'): Recurrence | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object') {
    throw new SystemActionError('invalid-recurrence', `${field} 必须是对象或 null`, { field });
  }
  const rec = value as { rule?: unknown; count?: unknown };
  if (typeof rec.rule !== 'string' || rec.rule.trim() === '') {
    throw new SystemActionError('invalid-recurrence', `${field}.rule 必须是非空字符串`, { field });
  }
  if (rec.count !== undefined && (typeof rec.count !== 'number' || !Number.isInteger(rec.count) || rec.count <= 0)) {
    throw new SystemActionError('invalid-recurrence', `${field}.count 必须是正整数`, { field });
  }
  return rec.count === undefined
    ? Object.freeze({ rule: rec.rule.trim() })
    : Object.freeze({ rule: rec.rule.trim(), count: rec.count });
}

/**
 * 重复范围守卫（I-B）。
 *
 * - 非重复对象：若给了 scope 只校验合法性，不作为必填。
 * - 创建新系列（`editing=false`）：scope 可缺省（整条系列正在被创建）。
 * - 修改已存在的重复对象（`editing=true`）：scope **必填**且必须合法。
 */
export function requireOccurrenceScope(opts: {
  readonly recurring: boolean;
  readonly editing: boolean;
  readonly provided: unknown;
}): RecurrenceScope | null {
  const provided = opts.provided;
  if (provided !== undefined && provided !== null) {
    if (typeof provided !== 'string' || !RECURRENCE_SCOPES.includes(provided as RecurrenceScope)) {
      throw new SystemActionError('invalid-recurrence-scope', `occurrenceScope 非法：${String(provided)}`, {
        provided: String(provided),
      });
    }
  }
  if (opts.recurring && opts.editing) {
    if (provided === undefined || provided === null) {
      throw new SystemActionError(
        'missing-recurrence-scope',
        '修改重复对象必须显式给出作用范围（this / this-and-future / whole-series）',
      );
    }
    return provided as RecurrenceScope;
  }
  return (provided ?? null) as RecurrenceScope | null;
}
