/**
 * K04 独立验证 —— 共用夹具（**不含任何密钥 / 地址 / 手机号**）。
 *
 * 夹具刻意只用合成标识（`conv-a`、`T-1`、`doc-1`）与固定 ISO 时间，保证用例可复现且
 * 不泄露任何私密值。
 */

import {
  createMemoryArtifactRegistry,
  createMemoryConversationPersistence,
  createMemoryCurrentDocumentFactPort,
  type MobileConversationPersistencePort,
  type ResumableArtifact,
} from '../../../apps/mobile-kernel/conversation/index.js';

export const CONV_A = 'conv-a';
export const CONV_B = 'conv-b';
export const TASK_1 = 'T-1';
export const TASK_2 = 'T-2';

/** 固定时钟：每次调用返回给定 ISO（可换）。 */
export function fixedClock(iso: string): () => string {
  return () => iso;
}

/** 推进一个"秒"的确定性时钟（不读墙钟）。 */
export function tickingClock(startMs = 1_700_000_000_000, stepMs = 1000): () => string {
  let current = startMs;
  return () => {
    const value = current;
    current += stepMs;
    return new Date(value).toISOString();
  };
}

/** 确定性的消息 / 事件 id 生成器。 */
export function seqIds(): (kind: 'message' | 'event', sequence: number) => string {
  return (kind, sequence) => `${kind === 'message' ? 'm' : 'e'}-${String(sequence)}`;
}

/** 可恢复产物：默认**已交付**、归属 TASK_1。 */
export function artifact(overrides: Partial<ResumableArtifact> = {}): ResumableArtifact {
  return Object.freeze({
    artifactId: 'doc-1',
    conversationId: CONV_A,
    taskId: TASK_1,
    fileName: 'report.docx',
    revision: 1,
    artifactVersion: 1,
    digest: 'sha256:' + 'a'.repeat(64),
    byteLength: 1234,
    delivered: true,
    receiptId: 'rcpt-1',
    ...overrides,
  });
}

export { createMemoryArtifactRegistry, createMemoryConversationPersistence, createMemoryCurrentDocumentFactPort };
export type { MobileConversationPersistencePort };
