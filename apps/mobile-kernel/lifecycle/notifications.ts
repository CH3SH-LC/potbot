/**
 * K10 通知端口 —— **内存夹具实现**（真机上是 `NotificationManagerCompat` 的适配层）。
 *
 * 夹具存在的意义不是"替代真机"，而是让**判据**可被独立驱动：
 * - `activeCount()` 让"任务结束/取消后通知被撤掉、没有泄漏的常驻通知"可被断言；
 * - `permission()` 可被设为 `denied`，用来验证"无通知权限时不得偷偷常驻"（fail-closed）；
 * - `posted()` 保留每次投递的**逐字段副本**，供测试逐字段核对（含脱敏）。
 *
 * 本实现**不读墙钟**：投递时间由调用方传入（与仓库注入时钟纪律一致）。
 */

import { LifecycleError } from './errors.js';
import { assertNoPlaintextSecret } from '../observability/redact.js';
import type {
  NotificationHandle,
  NotificationPermission,
  NotificationPort,
  NotificationRequest,
} from './types.js';

export interface PostedNotification {
  readonly notificationId: string;
  readonly title: string;
  readonly text: string;
  readonly ongoing: boolean;
  readonly postedAt: number;
  readonly updatedAt: number;
}

export interface MemoryNotificationPortOptions {
  /** 初始权限；默认 `granted`（测试显式设 `denied` 造负例）。 */
  readonly permission?: NotificationPermission;
}

export class MemoryNotificationPort implements NotificationPort {
  #permission: NotificationPermission;
  readonly #active = new Map<string, PostedNotification>();
  readonly #history: PostedNotification[] = [];

  constructor(options: MemoryNotificationPortOptions = {}) {
    this.#permission = options.permission ?? 'granted';
  }

  /** 测试用：改变系统通知权限（真机上由用户/系统决定）。 */
  setPermission(permission: NotificationPermission): void {
    this.#permission = permission;
  }

  permission(): NotificationPermission {
    return this.#permission;
  }

  post(request: NotificationRequest, at: number): NotificationHandle {
    if (typeof request !== 'object' || request === null) {
      throw new LifecycleError('notification_secret_detected', '通知请求必须是对象');
    }
    const notificationId = requireText(request.notificationId, 'notificationId');
    const title = requireText(request.title, 'title');
    const text = typeof request.text === 'string' ? request.text : '';
    // 脱敏判据在**端口入口**再挡一次：即使调用方绕过协调器直接投递，也无法把明文写进通知。
    guardNoSecret(title, '通知标题');
    guardNoSecret(text, '通知正文');

    const posted: PostedNotification = Object.freeze({
      notificationId,
      title,
      text,
      ongoing: request.ongoing === true,
      postedAt: at,
      updatedAt: at,
    });
    this.#active.set(notificationId, posted);
    this.#history.push(posted);
    return Object.freeze({ notificationId, postedAt: at });
  }

  update(handle: NotificationHandle, patch: { readonly text: string }, at: number): void {
    const current = this.#active.get(handle.notificationId);
    if (current === undefined) {
      throw new LifecycleError('unknown_task', `通知 ${handle.notificationId} 不存在或已撤销，无法更新`);
    }
    guardNoSecret(patch.text, '通知正文');
    const next: PostedNotification = Object.freeze({ ...current, text: patch.text, updatedAt: at });
    this.#active.set(handle.notificationId, next);
    this.#history.push(next);
  }

  stop(notificationId: string): void {
    this.#active.delete(notificationId);
  }

  activeCount(): number {
    return this.#active.size;
  }

  activeIds(): readonly string[] {
    return Object.freeze([...this.#active.keys()]);
  }

  /** 全量投递历史（含已撤销的），供测试核对"发过什么、有没有重复常驻"。 */
  history(): readonly PostedNotification[] {
    return Object.freeze([...this.#history]);
  }
}

/** 命中明文密钥 ⇒ 转成本包机读错误码（原文不回显）。 */
function guardNoSecret(value: unknown, what: string): void {
  try {
    assertNoPlaintextSecret(value, what);
  } catch {
    throw new LifecycleError(
      'notification_secret_detected',
      `${what}命中明文密钥特征：拒绝投递（原文已隐去，不落盘）`,
    );
  }
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new LifecycleError(
      'notification_secret_detected',
      `通知字段 ${field} 必须是非空字符串，收到 ${JSON.stringify(value)}`,
    );
  }
  return value;
}
