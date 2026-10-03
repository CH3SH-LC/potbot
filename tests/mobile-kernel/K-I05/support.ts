/**
 * K-I05 独立验证 —— 共用夹具 / 真磁盘适配器（**不含任何密钥 / 地址 / 手机号**）。
 *
 * - 合成标识只用 `conv-a` / `conv-b` / `T-1` / `doc-1` 等，时间戳固定可复现；
 * - `NodeFileSystem` 是 `FileSystemPort` 的 `node:fs` 实现，**只定义在测试里**——
 *   产品树不得依赖 node 内建（`FileStoragePort` 只提供接口，见 K09 `fs-port.ts`）。
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  MOBILE_CONVERSATION_SCHEMA,
  type MobileConversationRecord,
  type ResumableArtifact,
} from '../../../apps/mobile-kernel/conversation/index.js';
import type { FileSystemPort } from '../../../apps/mobile-kernel/storage/index.js';

export const CONV_A = 'conv-a';
export const CONV_B = 'conv-b';
export const TASK_1 = 'T-1';
export const TASK_2 = 'T-2';
export const FIXED_NOW_MS = 1_700_000_000_000;

/** 确定性的消息 / 事件 id 生成器。 */
export function seqIds(): (kind: 'message' | 'event', sequence: number) => string {
  return (kind, sequence) => `${kind === 'message' ? 'm' : 'e'}-${String(sequence)}`;
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

/** 固定时钟。 */
export function fixedClock(iso: string): () => string {
  return () => iso;
}

/** 可恢复产物：默认**已交付**、归属 `TASK_1`。 */
export function artifact(overrides: Partial<ResumableArtifact> = {}): ResumableArtifact {
  return Object.freeze({
    artifactId: 'doc-1',
    conversationId: CONV_A,
    taskId: TASK_1,
    fileName: 'report.docx',
    revision: 1,
    artifactVersion: 1,
    digest: `sha256:${'a'.repeat(64)}`,
    byteLength: 1234,
    delivered: true,
    receiptId: 'rcpt-1',
    ...overrides,
  });
}

/** 一条形状合法的会话记录（用于"在坏快照上写入必须被拒绝"的用例）。 */
export function sampleRecord(conversationId = CONV_A): MobileConversationRecord {
  return Object.freeze({
    schema: MOBILE_CONVERSATION_SCHEMA,
    conversationId,
    title: '样例',
    createdAt: '2026-10-03T00:00:00.000Z',
    updatedAt: '2026-10-03T00:00:00.000Z',
    archived: false,
    messages: Object.freeze([]),
    events: Object.freeze([]),
    nextMessageSeq: 1,
    nextEventSeq: 1,
  });
}

// ---------------------------------------------------------------------------
// 测试内的 `node:fs` 适配器：把平台动作接到真磁盘（供 FileStoragePort 用）
// ---------------------------------------------------------------------------

export class NodeFileSystem implements FileSystemPort {
  ensureDir(path: string): void {
    mkdirSync(path, { recursive: true });
  }
  exists(path: string): boolean {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  }
  readFile(path: string): Uint8Array {
    return new Uint8Array(readFileSync(path));
  }
  writeFile(path: string, bytes: Uint8Array): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
  rename(from: string, to: string): void {
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
  }
  removeFile(path: string): void {
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  listFiles(path: string): readonly string[] {
    try {
      return readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  }
  listDirs(path: string): readonly string[] {
    try {
      return readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  }
}

/** 建一个临时沙箱根，登记以便 `afterEach` 清理。 */
export function newFileStorageRoot(roots: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'k-i05-conv-'));
  roots.push(root);
  return root;
}

/** 删除所有登记的临时根。 */
export function cleanRoots(roots: string[]): void {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
}
