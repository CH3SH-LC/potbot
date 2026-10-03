/**
 * K04 连续对话 —— **落盘 schema、消息 / 事件形状、恢复契约与端口**（纯类型 + 纯常量）。
 *
 * 契约来源：`docs/other/ds-six-lanes-2026-10-03/KERNEL.md` 的 K04 行（连续对话、会话搜索 / 分页 /
 * 生命周期、幂等发送、重试、schema adapter；**新进程不先 GET 会话，直接续聊仍读到正确文件版本**）
 * 与总方案 README §2 的 P0（会话续聊直读绕过恢复访问器）。
 *
 * ## 与既有 `apps/demo/server/conversation-store.ts` 的关系（**如实登记**）
 *
 * 宿主侧那份（`potbot-conversation-store.v1`）是**电脑 Node 宿主**的持久状态机；它已经
 * 修过"当前文档只活在进程内 Map"的缺陷。本模块是**手机内核侧**的平台无关实现，
 * **不 import** 宿主运行时（避免 `apps/mobile-kernel → apps/demo` 的运行时倒挂），
 * 只是把同一套**语义**（幂等 `clientId`、五态 `state/phase`、单调 `seq`、重复命令返回原结果、
 * 跨进程续聊不读陈旧版本）在新 schema `potbot-mobile-conversation.v1` 下落一遍。
 * 二者**尚未收敛为一个真相源**——收敛路径与缺口记在交付说明里，本轮不做。
 *
 * ## 三块关注点
 *
 * | 关注点 | 承载 | 回答什么 |
 * |---|---|---|
 * | 一条会话里的消息 / 事件流 | {@link MobileConversationRecord} | 正文、单调 `seq`、幂等键 `clientId`、续取游标、五态、重启归位 |
 * | 会话头集合（供列表 / 搜索） | {@link MobileConversationSummary} | id / 标题 / 创建·更新时间 / 归档位 |
 * | 「本会话当前是哪份文档」 | {@link CurrentDocumentFact} + {@link ResumableArtifact} | 跨进程续聊读到**正确文件版本**（不读陈旧缓存、不猜） |
 */

// ---------------------------------------------------------------------------
// 状态词表（与合同 R209 五态、界面侧枚举分得开）
// ---------------------------------------------------------------------------

/** 界面侧认识的消息状态（超集：多一个 `completed`）。 */
export type MobileMessageState =
  | 'sending'
  | 'received'
  | 'streaming'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** **业务侧**口径的五态（合同 R209）。「已接收 ≠ 业务完成」靠 `state` + `phase` 两行区分。 */
export type MobileMessagePhase = 'accepted' | 'running' | 'completed' | 'failed' | 'cancelled';

export type MobileMessageRole = 'user' | 'assistant' | 'system';

/** 只有这两个阶段的消息允许重试（跑完的 / 在跑的都不行）。 */
export const RETRYABLE_PHASES: readonly MobileMessagePhase[] = Object.freeze(['failed', 'cancelled']);

// ---------------------------------------------------------------------------
// 落盘 schema 常量（**只增不改**：语义变了就换字符串，让旧快照走"拒绝加载"）
// ---------------------------------------------------------------------------

/** 一条会话的持久记录 schema。 */
export const MOBILE_CONVERSATION_SCHEMA = 'potbot-mobile-conversation.v1';

/** 「当前文档」持久事实的 schema。 */
export const CURRENT_DOCUMENT_FACT_SCHEMA = 'potbot-conversation-current-document.v1';

/** 分页默认每页条数。 */
export const MOBILE_MESSAGE_PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// 消息 / 事件
// ---------------------------------------------------------------------------

export interface MobileConversationMessage {
  readonly messageId: string;
  readonly conversationId: string;
  readonly role: MobileMessageRole;
  readonly text: string;
  /** 界面侧状态。 */
  readonly state: MobileMessageState;
  /** 业务侧状态（R209 五态）。 */
  readonly phase: MobileMessagePhase;
  /** 本会话内**单调递增**（从 1 起）；重启后继续，不重置。 */
  readonly seq: number;
  /** 幂等键。**重试复用同一个值**（同 `clientId` ⇒ 同一条消息，不重复建任务）。 */
  readonly clientId: string;
  readonly attempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly error: { readonly code: string; readonly message: string } | null;
}

/**
 * 一条**增量事件**（续取游标就是 `seq`）。`eventsSince` 取**严格大于**游标的项 ⇒
 * 已消费内容不被重放（不靠客户端去重）。
 */
export interface MobileConversationEvent {
  readonly seq: number;
  readonly eventId: string;
  readonly at: string;
  readonly kind: string;
  readonly messageId: string | null;
  readonly state: MobileMessageState | null;
  readonly phase: MobileMessagePhase | null;
  /** 结构化细节：**只能是 JSON 可序列化的原语**（不含正文 / 密钥 / 地址）。 */
  readonly detail: Readonly<Record<string, string | number | boolean | null>> | null;
}

/** 一条会话的完整可序列化记录（端口存取的单位）。 */
export interface MobileConversationRecord {
  readonly schema: typeof MOBILE_CONVERSATION_SCHEMA;
  readonly conversationId: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archived: boolean;
  readonly messages: readonly MobileConversationMessage[];
  readonly events: readonly MobileConversationEvent[];
  /** 下一条消息应使用的序号（= 已用最大值 + 1；重启后从落盘继续）。 */
  readonly nextMessageSeq: number;
  readonly nextEventSeq: number;
}

/** 会话头（列表 / 搜索用；不含正文）。 */
export interface MobileConversationSummary {
  readonly conversationId: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archived: boolean;
  readonly messageCount: number;
}

// ---------------------------------------------------------------------------
// 发送 / 重试 / 分页 的结果
// ---------------------------------------------------------------------------

/**
 * `send` 的结论。
 *
 * `duplicate:true` ⇒ 这个 `clientId` 之前**已经**收过，返回**原消息**且
 * `started:false`——**不再起一次执行**（R207"重试不重复建任务"的落点）。
 */
export interface MobileSendOutcome {
  readonly message: MobileConversationMessage;
  readonly duplicate: boolean;
  readonly started: boolean;
}

export interface MobileMessagePage {
  readonly items: readonly MobileConversationMessage[];
  /** 实际使用的页码（从 1 起）。 */
  readonly page: number;
  readonly page_size: number;
  /** **过滤后**命中总数（分页前）。 */
  readonly total: number;
  readonly has_more: boolean;
}

export interface MobileMessageListQuery {
  readonly page?: number;
  readonly pageSize?: number;
}

export interface MobileMessageSearchQuery extends MobileMessageListQuery {
  /** 正文子串搜索（大小写不敏感的朴素匹配；空串 = 不过滤）。 */
  readonly query?: string;
  /** 只搜某一条会话；缺省 = 搜本 store 里所有会话。 */
  readonly conversationId?: string;
}

export interface MobileMessageHit {
  readonly conversationId: string;
  readonly messageId: string;
  readonly seq: number;
  readonly role: MobileMessageRole;
  readonly text: string;
}

// ---------------------------------------------------------------------------
// 端口：持久化（本模块不做 IO）
// ---------------------------------------------------------------------------

/**
 * 会话持久端口。实现方负责真正落盘 / 读回（手机侧由 K09 的存储端口承接）；
 * 本模块只交记录、只收 `unknown` 并自己核对形状。
 */
export interface MobileConversationPersistencePort {
  /** 覆盖写**一条**会话记录（含删除语义：由调用方决定是否落墓碑，本轮不做墓碑）。 */
  save(record: MobileConversationRecord): void;
  /** 读回**全部**会话记录（返回 `unknown`：形状核对在本模块做）。`null` = 首次运行。 */
  loadAll(): unknown;
}

/** 内存持久端口（测试 / 沙箱用；**产品路径不得**用它）。 */
export function createMemoryConversationPersistence(
  initial: readonly MobileConversationRecord[] | null = null,
): MobileConversationPersistencePort {
  let stored: MobileConversationRecord[] | null =
    initial === null ? null : initial.map((record) => structuredClone(record));
  return Object.freeze({
    save(record: MobileConversationRecord): void {
      const copy = structuredClone(record);
      const index = (stored ?? []).findIndex((row) => row.conversationId === copy.conversationId);
      if (stored === null) {
        stored = [copy];
        return;
      }
      if (index === -1) {
        stored = [...stored, copy];
        return;
      }
      const next = [...stored];
      next[index] = copy;
      stored = next;
    },
    loadAll(): unknown {
      return stored === null ? null : structuredClone(stored);
    },
  });
}

// ---------------------------------------------------------------------------
// 端口：当前文档恢复（P0 的落点）
// ---------------------------------------------------------------------------

/**
 * 「本会话当前文档」的**持久事实**。
 *
 * 只记**哪一份 + 哪条任务 + 标题**：版本 / 摘要 / 字节数 / 文件名**不写进事实**——
 * 它们以**产物登记处**为准（写第二份就是第二个真相源，漂移时无法判断谁对）。
 */
export interface CurrentDocumentFact {
  readonly schema: typeof CURRENT_DOCUMENT_FACT_SCHEMA;
  readonly conversationId: string;
  readonly artifactId: string;
  /** 锚定这条事实的任务（恢复时产物必须归属同一任务）。 */
  readonly taskId: string;
  readonly title: string;
  readonly at: string;
}

export interface CurrentDocumentFactPort {
  save(fact: CurrentDocumentFact): void;
  /** 读回全部事实（`unknown`：形状核对在本模块做）。`null` = 没有。 */
  loadAll(): unknown;
}

/**
 * 产物登记处的一条**可恢复产物**。
 *
 * `delivered` + `receiptId` 是"已交付"的判据（与桌面宿主 `isDeliveredArtifact` 同口径）：
 * 没有可信回执的产物**不认**为可续聊的当前文档。
 */
export interface ResumableArtifact {
  readonly artifactId: string;
  readonly conversationId: string;
  readonly taskId: string;
  readonly fileName: string;
  /** 编辑修订号（每次编辑推进）。 */
  readonly revision: number;
  /** 产物版本号（每次重新发布推进）。 */
  readonly artifactVersion: number;
  /** `sha256:<64 位小写十六进制>`。 */
  readonly digest: string;
  readonly byteLength: number;
  readonly delivered: boolean;
  readonly receiptId: string | null;
}

export interface ArtifactRegistryPort {
  find(artifactId: string): ResumableArtifact | undefined;
}

/** 恢复出的当前文档：**版本字段一律来自产物登记处**，不是缓存里的旧值。 */
export interface ResolvedCurrentDocument {
  readonly conversationId: string;
  readonly artifactId: string;
  readonly taskId: string;
  readonly title: string;
  readonly fileName: string;
  readonly revision: number;
  readonly artifactVersion: number;
  readonly digest: string;
  readonly byteLength: number;
}

/** 恢复来源：`memory` = 本进程缓存命中；`persisted` = 从持久事实 + 产物登记处重建。 */
export type ResumeSource = 'memory' | 'persisted';

export interface ResumeOutcome {
  readonly document: ResolvedCurrentDocument;
  readonly source: ResumeSource;
}

/** 内存事实端口（测试 / 沙箱用）。 */
export function createMemoryCurrentDocumentFactPort(
  initial: readonly CurrentDocumentFact[] | null = null,
): CurrentDocumentFactPort {
  let stored: CurrentDocumentFact[] | null = initial === null ? null : initial.map((f) => structuredClone(f));
  return Object.freeze({
    save(fact: CurrentDocumentFact): void {
      const copy = structuredClone(fact);
      if (stored === null) {
        stored = [copy];
        return;
      }
      const index = stored.findIndex((row) => row.conversationId === copy.conversationId);
      if (index === -1) {
        stored = [...stored, copy];
        return;
      }
      const next = [...stored];
      next[index] = copy;
      stored = next;
    },
    loadAll(): unknown {
      return stored === null ? null : structuredClone(stored);
    },
  });
}

/** 内存产物登记处（测试 / 沙箱用）。 */
export function createMemoryArtifactRegistry(
  artifacts: readonly ResumableArtifact[] = [],
): ArtifactRegistryPort {
  const byId = new Map(artifacts.map((artifact) => [artifact.artifactId, artifact]));
  return Object.freeze({
    find(artifactId: string): ResumableArtifact | undefined {
      return byId.get(artifactId);
    },
  });
}
