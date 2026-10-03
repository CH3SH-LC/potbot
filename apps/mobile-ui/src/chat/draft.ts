/**
 * F02 chat —— 输入与草稿（未发送草稿可恢复）。
 *
 * 验收口径「未发送草稿恢复」：草稿（含正文与附件占位）必须能被序列化成可持久化的
 * 纯数据、并在下次启动时反序列化回**等价**结构；草稿与附件按会话隔离
 * （FRONTEND.md 行 9「每个会话独立保存草稿和附件」）。
 *
 * 本模块只做结构与字符串互转：不读真实文件、不碰 localStorage/磁盘、不引依赖。
 * 附件永远是**占位**（`bytesRead: false`），并且拒绝把本地路径当可访问引用。
 */

import type { AttachmentRef, ChatDraft, DraftStore } from './types.js';

/** 合法手机内容 URI 形状（与 contracts/mobile-v1 storage-port 的 ContentUri 一致）。 */
const CONTENT_URI_RE = /^(?:content|blob|app):\/\/.+/;

export interface AttachmentInput {
  readonly id: string;
  readonly name: string;
  /** 已经就绪的占位结构（恢复路径）；给定则直接规范化返回。 */
  readonly mime?: string | null;
  readonly byteLength?: number | null;
  readonly uri?: string | null;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function optionalCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * 构造附件占位。
 *
 * - **不读字节**：`bytesRead` 恒为 `false`，本模块没有任何文件访问。
 * - `uri` 只有匹配手机内容 URI 形状才保留；盘符路径 / POSIX 绝对路径 / 其他任意串
 *   一律置 `null` 且 `uriRejected: true`，不把本地路径伪装成可用引用。
 */
export function createAttachmentPlaceholder(input: AttachmentInput): AttachmentRef {
  const rawUri = optionalString(input.uri);
  const uriOk = rawUri !== null && CONTENT_URI_RE.test(rawUri);
  const name = optionalString(input.name) ?? '未命名附件';
  const id = optionalString(input.id) ?? name;
  return {
    id,
    name,
    mime: optionalString(input.mime),
    byteLength: optionalCount(input.byteLength),
    uri: uriOk ? rawUri : null,
    uriRejected: rawUri !== null && !uriOk,
    bytesRead: false,
  };
}

export function emptyDraft(conversationId: string): ChatDraft {
  return { conversationId, text: '', attachments: [] };
}

/** 从任意（可能损坏的）输入规范化出草稿；缺字段补空，不抛错。 */
export function normalizeDraft(input: unknown, conversationId: string): ChatDraft {
  const source = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const text = typeof source['text'] === 'string' ? source['text'] : '';
  const rawAttachments = Array.isArray(source['attachments']) ? source['attachments'] : [];
  const attachments: AttachmentRef[] = [];
  for (const item of rawAttachments) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const id = optionalString(record['id']);
    if (id === null) continue;
    attachments.push(
      createAttachmentPlaceholder({
        id,
        name: optionalString(record['name']) ?? id,
        mime: optionalString(record['mime']),
        byteLength: optionalCount(record['byteLength']),
        uri: optionalString(record['uri']),
      }),
    );
  }
  return { conversationId, text, attachments };
}

/**
 * 序列化为**定序** JSON：字段顺序固定、附件顺序保持输入顺序。
 * 同一草稿两次序列化结果逐字节相同（可用于「是否变更」比较与去重写入）。
 */
export function serializeDraft(draft: ChatDraft): string {
  return JSON.stringify({
    v: 1,
    conversationId: draft.conversationId,
    text: draft.text,
    attachments: draft.attachments.map((att) => ({
      id: att.id,
      name: att.name,
      mime: att.mime,
      byteLength: att.byteLength,
      uri: att.uri,
      uriRejected: att.uriRejected,
      bytesRead: false,
    })),
  });
}

/**
 * 反序列化草稿。**容错**：空串、非法 JSON、结构不符、会话不匹配都返回 `null`
 * （表示「没有可恢复的草稿」），而不是抛错把启动路径带崩。
 *
 * `expectedConversationId` 给定时，会话不一致也返回 null——不允许把 A 会话的草稿
 * 恢复进 B 会话。
 */
export function deserializeDraft(
  raw: string | null | undefined,
  expectedConversationId: string,
): ChatDraft | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const storedConversationId = optionalString(record['conversationId']);
  if (storedConversationId !== null && storedConversationId !== expectedConversationId) return null;
  return normalizeDraft(parsed, expectedConversationId);
}

// ---------------------------------------------------------------------------
// 多会话草稿存储（应用被杀后恢复）
// ---------------------------------------------------------------------------

export function putDraft(store: DraftStore, draft: ChatDraft): DraftStore {
  return { ...store, [draft.conversationId]: draft };
}

export function getDraft(store: DraftStore, conversationId: string): ChatDraft | null {
  const found = store[conversationId];
  return found === undefined ? null : found;
}

export function removeDraft(store: DraftStore, conversationId: string): DraftStore {
  if (store[conversationId] === undefined) return store;
  const next: Record<string, ChatDraft> = { ...store };
  delete next[conversationId];
  return next;
}

/** 只序列化**非空**草稿，避免持久化一堆空壳。 */
export function serializeDraftStore(store: DraftStore): string {
  const ids = Object.keys(store).sort();
  const entries: Array<[string, ChatDraft]> = [];
  for (const id of ids) {
    const draft = store[id];
    if (draft === undefined) continue;
    if (draft.text.length === 0 && draft.attachments.length === 0) continue;
    entries.push([id, draft]);
  }
  return JSON.stringify({
    v: 1,
    drafts: entries.map(([, draft]) => JSON.parse(serializeDraft(draft)) as unknown),
  });
}

/** 反序列化草稿存储；损坏条目被丢弃，绝不因为一条脏数据丢掉整份草稿。 */
export function deserializeDraftStore(raw: string | null | undefined): DraftStore {
  if (typeof raw !== 'string' || raw.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null) return {};
  const list = (parsed as Record<string, unknown>)['drafts'];
  if (!Array.isArray(list)) return {};
  let store: DraftStore = {};
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const conversationId = optionalString((item as Record<string, unknown>)['conversationId']);
    if (conversationId === null) continue;
    store = putDraft(store, normalizeDraft(item, conversationId));
  }
  return store;
}

/**
 * 恢复未发送草稿：优先用会话内联草稿，其次查持久化 store。
 * 返回 `null` 表示确实没有草稿可恢复（**不是**「恢复成全空」）。
 */
export function recoverDraft(
  store: DraftStore,
  conversationId: string,
  inline?: ChatDraft | null,
): ChatDraft | null {
  const fromStore = getDraft(store, conversationId);
  const candidate = inline ?? fromStore;
  if (candidate === null || candidate === undefined) return null;
  const normalized = normalizeDraft(candidate, conversationId);
  if (normalized.text.length === 0 && normalized.attachments.length === 0) return null;
  return normalized;
}
