/**
 * F-R06 system-actions —— 资料来源（C05 来源与依据）专属表单。
 *
 * design-07 行 48 C05：对应结论、证据片段、原址、时间、冲突和未知，来源可为
 * 原消息 / 文件 / 候选；行 204「来源卡」状态词表：已读取 / 部分读取 / 未读取 / 过期 /
 * 冲突 / 不可访问；行 193 RES-07–10：版本化事实、**私有资料和来源删除联动**、
 * 断网/空结果/不可读文件恢复、网页内容不能获得授权。
 *
 * 本模块把「来源诚实」落成可断言的类型（I-F）：
 *   - `read`/`partial` 必须有读取时间 + 证据片段，否则 `source-evidence-missing`；
 *   - `unread` **不得**携带证据或读取时间，否则 `unread-claims-evidence`（未读取不以空白掩盖、
 *     也不得装作已读取）；
 *   - `conflict` 必须列出冲突来源，否则 `missing-conflict-refs`；
 *   - 来源地址不得是电脑绝对路径，否则 `absolute-path-not-allowed`。
 * 另含**来源删除联动**计划：列出被删来源牵连的引用与派生事实，删除前必须显式给出范围。
 */

import { returnTargetFor, type ConversationReturnTarget } from './return.js';
import { requireIsoTimestamp } from './time.js';
import {
  SystemActionError,
  makeWarning,
  normalizeRefList,
  requireNonEmptyString,
  requireTitle,
  type FormWarning,
} from './types.js';

export type SourceState = 'read' | 'partial' | 'unread' | 'expired' | 'conflict' | 'inaccessible';
export const SOURCE_STATES: readonly SourceState[] = [
  'read',
  'partial',
  'unread',
  'expired',
  'conflict',
  'inaccessible',
];

/** 对用户的**诚实性**归类，直接由状态推导，不由调用方口头声明。 */
export type SourceHonesty = 'verifiable' | 'partial' | 'unknown' | 'expired' | 'conflicting' | 'inaccessible';

export type SourcePermission = 'granted' | 'denied' | 'unknown';

const ALLOWED_SCHEME = /^(?:https?|content|blob|app|ref):/i;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const UNC_PATH = /^\\\\/;

/** 拒绝电脑绝对路径（盘符 / UNC / POSIX 绝对路径）。 */
export function requireSourceUri(value: unknown): string {
  const uri = requireNonEmptyString(value, 'originUri', 'invalid-origin-uri', 'originUri 不能为空');
  if (WINDOWS_DRIVE.test(uri) || UNC_PATH.test(uri) || uri.startsWith('/')) {
    throw new SystemActionError('absolute-path-not-allowed', '来源地址不得是电脑绝对路径', {
      field: 'originUri',
    });
  }
  if (!ALLOWED_SCHEME.test(uri)) {
    throw new SystemActionError(
      'invalid-origin-uri',
      'originUri 必须是 http(s):// / content:// / blob:// / app:// / ref:// 引用',
      { field: 'originUri' },
    );
  }
  return uri;
}

export function honestyFor(state: SourceState): SourceHonesty {
  switch (state) {
    case 'read':
      return 'verifiable';
    case 'partial':
      return 'partial';
    case 'unread':
      return 'unknown';
    case 'expired':
      return 'expired';
    case 'conflict':
      return 'conflicting';
    case 'inaccessible':
      return 'inaccessible';
    default: {
      const never: never = state;
      throw new SystemActionError('invalid-source-state', `未知来源状态：${String(never)}`);
    }
  }
}

export interface ResearchSourceInput {
  readonly sourceId: string;
  readonly conversationId: string;
  readonly anchorMessageId?: string | null;
  readonly title: string;
  readonly originUri: string;
  readonly state: SourceState;
  /** read / partial 必填（来源时间）。 */
  readonly fetchedAt?: string;
  /** read / partial 必填（证据片段）；unread 不得携带。 */
  readonly evidenceSnippet?: string;
  /** conflict 必填。 */
  readonly conflictWith?: readonly string[];
  /** 是否为用户私有资料（影响删除联动范围）。 */
  readonly private?: boolean;
  readonly permission?: SourcePermission;
  readonly expectedRevision?: number;
}

export interface ResearchFormView {
  readonly kind: 'research-source';
  readonly conversationId: string;
  readonly sourceId: string;
  readonly title: string;
  readonly originUri: string;
  readonly state: SourceState;
  readonly honesty: SourceHonesty;
  readonly fetchedAt: string | null;
  readonly evidenceSnippet: string | null;
  readonly conflicts: readonly string[];
  readonly isPrivate: boolean;
  readonly permission: SourcePermission;
  readonly warnings: readonly FormWarning[];
  readonly returnTarget: ConversationReturnTarget;
  readonly expectedRevision: number | null;
}

/** 校验并构造资料来源详情表单。 */
export function buildResearchForm(input: ResearchSourceInput): ResearchFormView {
  const title = requireTitle(input.title);
  const sourceId = requireNonEmptyString(input.sourceId, 'sourceId', 'invalid-origin-uri', 'sourceId 不能为空');
  const originUri = requireSourceUri(input.originUri);
  const returnTarget = returnTargetFor(input.conversationId, input.anchorMessageId);

  if (typeof input.state !== 'string' || !SOURCE_STATES.includes(input.state as SourceState)) {
    throw new SystemActionError('invalid-source-state', `source state 非法：${String(input.state)}`, {
      field: 'state',
    });
  }
  const state = input.state as SourceState;
  const honesty = honestyFor(state);

  const hasEvidence = input.evidenceSnippet !== undefined && input.evidenceSnippet !== null;
  const hasFetchedAt = input.fetchedAt !== undefined && input.fetchedAt !== null;
  const conflicts = normalizeRefList(input.conflictWith, 'conflictWith');

  let fetchedAt: string | null = null;
  let evidenceSnippet: string | null = null;

  if (state === 'read' || state === 'partial') {
    if (!hasEvidence || !hasFetchedAt) {
      throw new SystemActionError(
        'source-evidence-missing',
        `${state} 来源必须同时给出 fetchedAt 与 evidenceSnippet`,
        { field: hasFetchedAt ? 'evidenceSnippet' : 'fetchedAt' },
      );
    }
    fetchedAt = requireIsoTimestamp(input.fetchedAt, 'fetchedAt');
    evidenceSnippet = requireNonEmptyString(
      input.evidenceSnippet,
      'evidenceSnippet',
      'source-evidence-missing',
      '证据片段必须是非空字符串',
    );
  } else if (state === 'unread') {
    if (hasEvidence || hasFetchedAt) {
      throw new SystemActionError(
        'unread-claims-evidence',
        'unread 来源不得携带证据或读取时间——未读取不得伪装为已读取',
      );
    }
  } else {
    // expired / conflict / inaccessible：可带证据（历史读取过），字段可选但需合法。
    if (hasFetchedAt) fetchedAt = requireIsoTimestamp(input.fetchedAt, 'fetchedAt');
    if (hasEvidence) {
      evidenceSnippet = requireNonEmptyString(
        input.evidenceSnippet,
        'evidenceSnippet',
        'source-evidence-missing',
        '证据片段必须是非空字符串',
      );
    }
  }

  if (state === 'conflict' && conflicts.length === 0) {
    throw new SystemActionError('missing-conflict-refs', 'conflict 来源必须列出冲突来源', {
      field: 'conflictWith',
    });
  }

  let permission: SourcePermission = 'unknown';
  if (input.permission !== undefined) {
    if (input.permission !== 'granted' && input.permission !== 'denied' && input.permission !== 'unknown') {
      throw new SystemActionError('invalid-origin-uri', `permission 非法：${String(input.permission)}`, {
        field: 'permission',
      });
    }
    permission = input.permission;
  }

  const warnings: FormWarning[] = [];
  if (honesty === 'unknown') warnings.push(makeWarning('source-unread', '来源尚未读取，结论可指向的证据为空', 'warn'));
  if (honesty === 'partial') warnings.push(makeWarning('source-partial', '仅部分读取，结论证据不完整', 'warn'));
  if (honesty === 'expired') warnings.push(makeWarning('source-expired', '来源已过期，需重新读取', 'warn'));
  if (honesty === 'conflicting') {
    warnings.push(makeWarning('source-conflict', `与 ${conflicts.length} 个来源冲突，需并列展示`, 'warn'));
  }
  if (honesty === 'inaccessible') {
    warnings.push(makeWarning('source-inaccessible', '来源不可访问，不能以空白掩盖', 'error'));
  }
  if (input.private === true) {
    warnings.push(makeWarning('source-private', '私有资料：删除将联动其引用与派生事实', 'info'));
  }

  return Object.freeze({
    kind: 'research-source' as const,
    conversationId: returnTarget.conversationId,
    sourceId,
    title,
    originUri,
    state,
    honesty,
    fetchedAt,
    evidenceSnippet,
    conflicts,
    isPrivate: input.private === true,
    permission,
    warnings: Object.freeze(warnings),
    returnTarget,
    expectedRevision:
      input.expectedRevision === undefined ? null : requireRevisionValue(input.expectedRevision),
  });
}

function requireRevisionValue(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new SystemActionError('invalid-revision', 'expectedRevision 必须是非负整数', {
      field: 'expectedRevision',
    });
  }
  return value;
}

// ---------------------------------------------------------------------------
// 来源删除联动（RES-07–10「私有资料和来源删除联动」）
// ---------------------------------------------------------------------------

/**
 * 删除范围：删除来源前**必须**逐类声明关联对象的处理方式。
 * 缺字段或非法 ⇒ 拒绝删除，绝不猜默认范围。
 */
export interface SourceDeletionScope {
  readonly index: 'cascade' | 'retain';
  readonly snippet: 'cascade' | 'retain';
  readonly citations: 'cascade' | 'retain';
  readonly derivedFacts: 'cascade' | 'retain';
}

export interface SourceDeletionPlan {
  readonly sourceId: string;
  readonly title: string;
  readonly isPrivate: boolean;
  /** 引用该来源的结论/候选 id，删除前需展示影响范围。 */
  readonly citationRefs: readonly string[];
  /** 由该来源派生的事实 id。 */
  readonly factRefs: readonly string[];
  readonly requiresExplicitScope: true;
}

/** 构造删除影响预览（不执行删除）。 */
export function planSourceDeletion(
  source: Pick<ResearchFormView, 'sourceId' | 'title' | 'isPrivate'>,
  refs: { readonly citationRefs?: readonly string[]; readonly factRefs?: readonly string[] } = {},
): SourceDeletionPlan {
  return Object.freeze({
    sourceId: source.sourceId,
    title: source.title,
    isPrivate: source.isPrivate,
    citationRefs: normalizeRefList(refs.citationRefs, 'citationRefs'),
    factRefs: normalizeRefList(refs.factRefs, 'factRefs'),
    requiresExplicitScope: true as const,
  });
}

/** 校验删除范围四项齐全且合法；缺整体抛 `missing-delete-scope`，缺字段抛 `delete-scope-incomplete`。 */
export function requireSourceDeletionScope(scope: unknown): SourceDeletionScope {
  if (scope === undefined || scope === null || typeof scope !== 'object') {
    throw new SystemActionError('missing-delete-scope', '删除来源必须先声明删除范围');
  }
  const s = scope as Record<string, unknown>;
  const fields = ['index', 'snippet', 'citations', 'derivedFacts'] as const;
  for (const field of fields) {
    const v = s[field];
    if (v !== 'cascade' && v !== 'retain') {
      throw new SystemActionError('delete-scope-incomplete', `删除范围缺字段或非法：${field}`, { field });
    }
  }
  return Object.freeze({
    index: s.index as 'cascade' | 'retain',
    snippet: s.snippet as 'cascade' | 'retain',
    citations: s.citations as 'cascade' | 'retain',
    derivedFacts: s.derivedFacts as 'cascade' | 'retain',
  });
}
