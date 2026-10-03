/**
 * F09 验收：通知与后台说明（M09、I6）。
 *
 * 反向对照：
 *   - 提醒权限未授权 ⇒ `remindersEffective` 必须为 false，不得声称提醒可用；
 *   - 后台受限原因含路径/密钥 ⇒ 展示文案必须已脱敏；
 *   - 系统设置入口必须形如 settings:// 或 android.settings.*，否则拒绝。
 */

import { describe, expect, it } from 'vitest';

import {
  describeNotifications,
  isValidSettingsEntry,
  type NotificationInput,
} from '../../../apps/mobile-ui/src/settings/index.js';

const ENTRY = 'settings://app-details';

function input(overrides: Partial<NotificationInput> = {}): NotificationInput {
  return {
    progress: true,
    reminders: true,
    reminderPermission: 'granted',
    backgroundRestricted: false,
    backgroundReason: null,
    systemSettingsEntry: ENTRY,
    ...overrides,
  };
}

describe('F09 / 通知与后台说明（M09）', () => {
  it('提醒权限已授权 ⇒ 提醒生效', () => {
    const view = describeNotifications(input());
    expect(view.remindersEffective).toBe(true);
    expect(view.label).toContain('提醒：开');
  });

  it('反向对照：提醒权限被拒 ⇒ 不得声称提醒可用', () => {
    const view = describeNotifications(input({ reminderPermission: 'denied' }));
    expect(view.remindersEffective).toBe(false);
    expect(view.label).toContain('不可用');
    expect(view.label).toContain('denied');
  });

  it('未开启提醒时即使权限已授权也不生效', () => {
    const view = describeNotifications(input({ reminders: false }));
    expect(view.remindersEffective).toBe(false);
    expect(view.label).toContain('提醒：关');
  });

  it('后台受限：给出脱敏原因与系统设置入口', () => {
    const view = describeNotifications(
      input({
        backgroundRestricted: true,
        backgroundReason: '后台被限制：C:\\Users\\someone\\Desktop\\keys.txt 不可访问',
      }),
    );
    expect(view.backgroundRestricted).toBe(true);
    expect(view.backgroundNotice).not.toBeNull();
    expect(view.backgroundNotice).not.toContain('C:\\Users\\someone');
    expect(view.backgroundNotice).toContain(ENTRY);
    expect(view.backgroundRedactedCount).toBeGreaterThan(0);
  });

  it('不受限时不产生后台提示', () => {
    const view = describeNotifications(input());
    expect(view.backgroundNotice).toBeNull();
    expect(view.backgroundRedactedCount).toBe(0);
  });

  it('系统设置入口形状校验', () => {
    expect(isValidSettingsEntry('settings://app-details')).toBe(true);
    expect(isValidSettingsEntry('android.settings.APPLICATION_DETAILS_SETTINGS')).toBe(true);
    expect(isValidSettingsEntry('C:\\Users\\someone')).toBe(false);
    expect(() => describeNotifications(input({ systemSettingsEntry: 'https://example.com' }))).toThrowError(/系统设置入口/);
  });
});
