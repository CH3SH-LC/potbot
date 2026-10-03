/**
 * F06 files —— 保存 / 分享容器状态（I6）。
 *
 * 容器状态受**字节证据**约束：没有字节就不能保存、也不能分享——否则界面会出现
 * 「已保存 / 已分享」却无内容可回读的假状态。
 *
 * 状态机（转移非法即抛错，不静默夹取）：
 *   save:  unsaved --beginSave--> saving --completeSave--> saved
 *                                     \----failSave----> failed --beginSave--> saving
 *   share: unavailable | ready --beginShare--> sharing --completeShare--> shared
 *                                                        \---failShare---> failed
 *   （`ready` 只在当前版本有字节时成立；无字节时是 `unavailable`。）
 */

import { assertBytes, hasBytes } from './bytes.js';
import { currentRevisionRecord } from './versions.js';
import { FileError, type FileEntry } from './types.js';

/** 保存容器状态。 */
export type SaveState = 'unsaved' | 'saving' | 'saved' | 'failed';

/** 分享容器状态。 */
export type ShareState = 'unavailable' | 'ready' | 'sharing' | 'shared' | 'failed';

export interface SaveContainer {
  readonly state: SaveState;
  /** 保存目标引用（只存引用，不存本地绝对路径）。未保存时为 null。 */
  readonly targetRef: string | null;
}

export interface ShareContainer {
  readonly state: ShareState;
  /** 分享通道引用（只存引用，不存凭据/密钥）。未分享时为 null。 */
  readonly channelRef: string | null;
}

/** 初始保存容器：未保存。 */
export function initialSaveContainer(): SaveContainer {
  return Object.freeze({ state: 'unsaved', targetRef: null });
}

/** 初始分享容器：有字节才 `ready`，否则 `unavailable`。 */
export function initialShareContainer(entry: FileEntry): ShareContainer {
  const state: ShareState = hasBytes(currentRevisionRecord(entry).bytes) ? 'ready' : 'unavailable';
  return Object.freeze({ state, channelRef: null });
}

function requireNonEmptyRef(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new FileError('invalid-save-state', `${field} 必须是非空字符串引用`);
  }
  return value.trim();
}

function assertSaveState(container: SaveContainer, allowed: readonly SaveState[], action: string): void {
  if (!allowed.includes(container.state)) {
    throw new FileError('invalid-save-state', `状态 ${container.state} 不允许${action}`, {
      state: container.state,
      allowed,
    });
  }
}

function assertShareState(
  container: ShareContainer,
  allowed: readonly ShareState[],
  action: string,
): void {
  if (!allowed.includes(container.state)) {
    throw new FileError('invalid-share-state', `状态 ${container.state} 不允许${action}`, {
      state: container.state,
      allowed,
    });
  }
}

/** 开始保存：当前版本必须有字节；状态须是 unsaved 或 failed。 */
export function beginSave(entry: FileEntry, container: SaveContainer): SaveContainer {
  assertSaveState(container, ['unsaved', 'failed'], '开始保存');
  assertBytes(currentRevisionRecord(entry).bytes, '开始保存');
  return Object.freeze({ state: 'saving', targetRef: null });
}

/** 保存完成：须在 saving 中，且当前版本有字节——否则 `missing-bytes`。 */
export function completeSave(
  entry: FileEntry,
  container: SaveContainer,
  targetRef: string,
): SaveContainer {
  assertSaveState(container, ['saving'], '完成保存');
  assertBytes(currentRevisionRecord(entry).bytes, '标记已保存');
  return Object.freeze({ state: 'saved', targetRef: requireNonEmptyRef(targetRef, 'targetRef') });
}

/** 保存失败。 */
export function failSave(container: SaveContainer): SaveContainer {
  assertSaveState(container, ['saving'], '标记保存失败');
  return Object.freeze({ state: 'failed', targetRef: null });
}

/** 开始分享：当前版本必须有字节；否则 `share-not-available`。 */
export function beginShare(entry: FileEntry, container: ShareContainer): ShareContainer {
  if (!hasBytes(currentRevisionRecord(entry).bytes)) {
    throw new FileError('share-not-available', '没有字节证据，不能开始分享', {
      fileId: entry.fileId,
    });
  }
  assertShareState(container, ['ready', 'failed'], '开始分享');
  return Object.freeze({ state: 'sharing', channelRef: null });
}

/** 分享完成：须在 sharing 中且当前版本有字节。 */
export function completeShare(
  entry: FileEntry,
  container: ShareContainer,
  channelRef: string,
): ShareContainer {
  assertShareState(container, ['sharing'], '完成分享');
  assertBytes(currentRevisionRecord(entry).bytes, '标记已分享');
  return Object.freeze({
    state: 'shared',
    channelRef: requireNonEmptyRef(channelRef, 'channelRef'),
  });
}

/** 分享失败。 */
export function failShare(container: ShareContainer): ShareContainer {
  assertShareState(container, ['sharing'], '标记分享失败');
  return Object.freeze({ state: 'failed', channelRef: null });
}
