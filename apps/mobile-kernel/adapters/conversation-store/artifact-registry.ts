/**
 * K-I05 会话持久化适配层 —— **`ArtifactRegistryPort` 的存储端口实现**。
 *
 * ## 它回答什么
 *
 * 「这份可恢复产物**现在**是哪个版本 / 摘要 / 编辑修订 / 字节数」。K04 `resume.ts` 的判据是：
 * 版本字段（`revision` / `artifactVersion` / `digest` / `byteLength`）**一律取自产物登记处**，
 * 不是事实里的旧值、不是进程内缓存。
 *
 * ## "读到当前版本而不是陈旧缓存"是怎么落地的
 *
 * `find(artifactId)` **每次调用都从 `StoragePort` 重读**产物登记快照再按 id 定位——**不设
 * 进程内缓存**。因此即便同一个适配器实例先看过 v1，产物被重新发布为 v2 之后，下一次 `find`
 * 必然返回 v2。测试用"同一实例读两次"直接钉住这条（`list` / `loadAll` 同）。
 *
 * ## fail-closed（端口没有错误通道时的唯一诚实用法）
 *
 * K04 的 `ConversationResumeLedger.resolve()` 直接调用 `find()` 且**不包 try**，所以本方法
 * **不抛**：登记快照读不回来（损坏 / 形状不符）时返回 `undefined`，K04 据此报
 * `artifact_not_found`——**不回落**到任何默认文档。以"查不到"表达"不可信"，是 fail-closed 的
 * 正确方向（绝不会有"编造一个产物"的分支）。局限如实登记在 README：这样调用方分不清"确实没有"
 * 与"登记处坏了"，两者都失败关闭、都不编造。
 *
 * `save` 是**写侧接缝**（`ArtifactRegistryPort` 只有 `find`）：产物发布方在交付后调用它，
 * 把当前的 `{revision, artifactVersion, digest, byteLength, delivered, receiptId}` 登记进来。
 */

import type { ArtifactRegistryPort, ResumableArtifact } from '../../conversation/index.js';

import { isConversationAdapterError } from './errors.js';
import { isPlainObject } from './guards.js';
import { artifactRegistryUri, readSnapshot, upsertByKey, writeSnapshotCas } from './storage-snapshot.js';
import type { StoragePort } from '../../storage/index.js';

/** 产物登记处适配器：实现 K04 的 `ArtifactRegistryPort`，并附写侧接缝。 */
export interface StorageArtifactRegistry extends ArtifactRegistryPort {
  /** 登记 / 覆盖一条产物记录（同 `artifactId` 替换，其余保留）。 */
  readonly save: (artifact: ResumableArtifact) => void;
  /** 读回全部产物记录（原始 `unknown`）。`null` = 没有；快照不可信时抛错（原始读取，交给调用方判）。 */
  readonly loadAll: () => unknown;
  /** 读回全部产物记录（已过滤为对象）。与 `find` 同口径 fail-closed：快照不可信时返回空数组，**不抛**。 */
  readonly list: () => readonly ResumableArtifact[];
}

/** 造一个落在 `StoragePort` 上的产物登记处。 */
export function createStorageArtifactRegistry(storage: StoragePort): StorageArtifactRegistry {
  const uri = artifactRegistryUri();

  return Object.freeze({
    /**
     * 按 id 查**当前**产物记录。每次都从存储重读，无进程内缓存 ⇒ 不会返回陈旧版本。
     * 登记快照不可信时返回 `undefined`（fail-closed，见文件头）。
     */
    find(artifactId: string): ResumableArtifact | undefined {
      let snapshot;
      try {
        snapshot = readSnapshot(storage, uri);
      } catch (error) {
        if (isConversationAdapterError(error)) {
          return undefined;
        }
        throw error;
      }
      if (!snapshot.present || !Array.isArray(snapshot.value)) {
        return undefined;
      }
      for (const entry of snapshot.value) {
        if (isPlainObject(entry) && entry['artifactId'] === artifactId) {
          return entry as unknown as ResumableArtifact;
        }
      }
      return undefined;
    },
    save(artifact: ResumableArtifact): void {
      writeSnapshotCas(storage, uri, (current) => upsertByKey(current, 'artifactId', artifact.artifactId, artifact));
    },
    loadAll(): unknown {
      const snapshot = readSnapshot(storage, uri);
      return snapshot.present ? snapshot.value : null;
    },
    list(): readonly ResumableArtifact[] {
      let snapshot;
      try {
        snapshot = readSnapshot(storage, uri);
      } catch (error) {
        if (isConversationAdapterError(error)) {
          return Object.freeze([]);
        }
        throw error;
      }
      if (!snapshot.present || !Array.isArray(snapshot.value)) {
        return Object.freeze([]);
      }
      return Object.freeze(snapshot.value.filter(isPlainObject) as unknown as ResumableArtifact[]);
    },
  });
}
