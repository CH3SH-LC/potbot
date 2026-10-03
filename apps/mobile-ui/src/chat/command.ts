/**
 * F02 chat —— 把「发送一条用户消息」翻译成 v1 契约 `command`。
 *
 * 只用 `contracts/mobile-v1/types.ts` 的类型（只读消费，不复制字段定义）。
 *
 * 为什么是 `operation: 'create'`：
 *   发送一条消息 = 在既有会话下**新建**一条消息对象。契约的 create/import 分支允许
 *   `conversationId + content` 且不要求 `expectedRevision`，正好对应「自然语言入口提交」。
 *   而 mutation 分支强制 `expectedRevision`，会让每次发言都可能撞上 revision 冲突、
 *   把聊天变成乐观锁重试，不适合本入口。带 revision 守卫的 `mutate` 变体留给后续批次。
 *
 * 幂等键（I4）：
 *   `idempotencyKey` 由 (会话, 尝试消息, 正文) 确定性推导 ⇒ **同一逻辑发送重发得到同一键**，
 *   内核可依赖它去重；重试因尝试消息 id 不同 ⇒ 得到**不同**键 ⇒ 不会被内核幂等复用成旧结果。
 *   命令对象整体可复现：同输入两次构造结果 deep-equal。
 */

import type { Command, SchemaVersion } from '../../../../contracts/mobile-v1/types.js';
import { fnv1a64Hex } from './ids.js';
import type { AttachmentRef, ChatState } from './types.js';

/** 下发给内核的附件描述（只带描述，绝不含字节/本地路径；幂等键不含附件）。 */
export interface AttachmentDescriptor {
  readonly id: string;
  readonly name: string;
  readonly mime: string | null;
  readonly byteLength: number | null;
  readonly uri: string | null;
  readonly uriRejected: boolean;
}

function describeAttachments(attachments: readonly AttachmentRef[]): AttachmentDescriptor[] {
  return attachments.map((att) => ({
    id: att.id,
    name: att.name,
    mime: att.mime,
    byteLength: att.byteLength,
    uri: att.uri,
    uriRejected: att.uriRejected,
  }));
}

const SCHEMA_VERSION: SchemaVersion = 'mobile-v1';

export interface SendMessageCommandInput {
  readonly conversationId: string;
  /** 本次尝试的助手消息 id——幂等键的「尝试维度」。重试须传新的尝试消息 id。 */
  readonly attemptMessageId: string;
  /** 用户自然语言原文（唯一入口内容）。 */
  readonly content: string;
  /** 对应的用户消息 id，仅用于排障元数据。 */
  readonly userMessageId?: string;
  /** 随消息发送的附件**占位**（只带描述，绝不含字节/本地路径）。 */
  readonly attachments?: readonly AttachmentRef[];
}

/**
 * 构造发送命令。字段齐全：schemaVersion / commandId / operation / idempotencyKey / payload。
 * 通过 `node contracts/mobile-v1/validate.mjs` 对 command.schema.json 的校验。
 */
export function buildSendMessageCommand(input: SendMessageCommandInput): Command {
  const seed = [SCHEMA_VERSION, 'create', 'send', input.conversationId, input.attemptMessageId, input.content].join('\u0000');
  const commandId = `cmd-send-${fnv1a64Hex(`${seed}|commandId`)}`;
  const idempotencyKey = `idem-send-${fnv1a64Hex(`${seed}|idempotencyKey`)}`;
  return {
    schemaVersion: SCHEMA_VERSION,
    commandId,
    operation: 'create',
    idempotencyKey,
    payload: {
      conversationId: input.conversationId,
      content: input.content,
      // 唯一自然语言入口：入口类型随命令下行，内核无需猜测来源。
      args: { role: 'user', entry: 'natural-language' },
    },
    metadata: {
      entry: 'natural-language',
      attemptMessageId: input.attemptMessageId,
      ...(input.userMessageId === undefined ? {} : { userMessageId: input.userMessageId }),
      // 附件只进元数据，不参与幂等键；空数组时不写该键，保持既有命令逐字节不变。
      ...((input.attachments ?? []).length === 0
        ? {}
        : { attachments: describeAttachments(input.attachments ?? []) }),
    },
  };
}

/**
 * 从状态推导发送命令：取指定助手消息**之前最近的一条用户消息**作为正文。
 *
 * 找不到用户消息时返回 `null`——不编造正文，也不把空串当消息发出去。
 */
export function buildSendCommandForState(state: ChatState, attemptMessageId: string): Command | null {
  const assistantIndex = state.indexById[attemptMessageId];
  if (assistantIndex === undefined) return null;
  const assistant = state.messages[assistantIndex];
  if (assistant === undefined || assistant.role !== 'assistant') return null;
  for (let i = assistantIndex - 1; i >= 0; i -= 1) {
    const candidate = state.messages[i];
    if (candidate === undefined) continue;
    if (candidate.role !== 'user') continue;
    return buildSendMessageCommand({
      conversationId: state.conversationId,
      attemptMessageId,
      content: candidate.text,
      userMessageId: candidate.id,
      attachments: candidate.attachments ?? [],
    });
  }
  return null;
}

export interface CancelCommandInput {
  readonly conversationId: string;
  /** 被停止的助手消息 id（元数据，便于内核关联）。 */
  readonly messageId: string;
  readonly reason?: string;
}

/**
 * 构造停止命令（query 分支，指向已有会话）。
 * 停止必须落到事件流，而不是前端静默丢弃（与 fixtures/cancel/command-cancel.json 同形）。
 */
export function buildCancelCommand(input: CancelCommandInput): Command {
  const seed = [SCHEMA_VERSION, 'cancel', input.conversationId, input.messageId].join('\u0000');
  return {
    schemaVersion: SCHEMA_VERSION,
    commandId: `cmd-cancel-${fnv1a64Hex(`${seed}|commandId`)}`,
    operation: 'cancel',
    idempotencyKey: `idem-cancel-${fnv1a64Hex(`${seed}|idempotencyKey`)}`,
    payload: { conversationId: input.conversationId },
    metadata: {
      messageId: input.messageId,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    },
  };
}
