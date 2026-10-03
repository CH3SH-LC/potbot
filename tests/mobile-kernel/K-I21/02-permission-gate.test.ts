/**
 * K-I21 契约②：`POST_NOTIFICATIONS` 运行时权限闸门 —— **fail-closed，拒绝即零通知**。
 *
 * 核心判据是**顺序**：权限判定必须发生在任何一次系统 `notify()` 之前，且句柄登记只能在
 * notify 成功之后。这样"未授权"路径下 {@code activeCount()} 恒为 0——不是靠人记得不投递，
 * 而是代码结构上投递不可达。
 */

import { describe, expect, it } from 'vitest';

import { methodBody, readJava } from './fixtures.js';

const impl = readJava('AndroidNotificationPort.java');

describe('K-I21 ② 通知权限闸门（fail-closed）', () => {
  it('post() 先过权限闸门，再调用系统 notify()', () => {
    const body = methodBody(impl, 'public NotificationHandle post(');
    const gateAt = body.indexOf('permission()');
    const notifyAt = body.indexOf('.notify(');
    expect(gateAt, 'post 缺少权限判定').toBeGreaterThanOrEqual(0);
    expect(notifyAt, 'post 未调用系统 notify').toBeGreaterThanOrEqual(0);
    expect(gateAt, '权限判定必须早于 notify').toBeLessThan(notifyAt);
    // 拒因机读可辨：非 GRANTED 即抛 NotificationPermissionDeniedException。
    expect(body).toMatch(/if\s*\(\s*permission\(\)\s*!=\s*NotificationPermission\.GRANTED\s*\)/);
    expect(body).toContain('throw new NotificationPermissionDeniedException');
  });

  it('句柄只在 notify 成功之后登记（拒绝路径不增加 activeCount）', () => {
    const body = methodBody(impl, 'public NotificationHandle post(');
    const notifyAt = body.indexOf('.notify(');
    const registerAt = body.indexOf('active.put(');
    expect(registerAt, 'post 未登记句柄').toBeGreaterThanOrEqual(0);
    expect(registerAt, '登记必须晚于 notify（拒因路径才可能为零通知）').toBeGreaterThan(notifyAt);
  });

  it('permission(): API<33 视为授予；33+ 非 GRANTED 一律 DENIED（不猜 not-determined）', () => {
    const body = methodBody(impl, 'public NotificationPermission permission(');
    expect(body).toContain('Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU');
    expect(body).toContain('PackageManager.PERMISSION_GRANTED');
    expect(body).toContain('return NotificationPermission.GRANTED;');
    expect(body).toContain('return NotificationPermission.DENIED;');
    // 不得把"判不出"当成 granted：唯一的 GRANTED 返回来自 API<33 或 ==PERMISSION_GRANTED 两支。
    const grantedReturns = body.match(/return NotificationPermission\.GRANTED;/g) ?? [];
    expect(grantedReturns).toHaveLength(2);
  });

  it('前台服务层同款 fail-closed：权限闸门早于任何 startForeground', () => {
    const fgs = readJava('ForegroundTaskService.java');
    const body = methodBody(fgs, 'public int onStartCommand(');
    const gateAt = body.indexOf('notifications.permission()');
    const startAt = body.indexOf('startForeground(');
    expect(gateAt, 'onStartCommand 缺少权限闸门').toBeGreaterThanOrEqual(0);
    expect(startAt, 'onStartCommand 未调用 startForeground').toBeGreaterThanOrEqual(0);
    expect(gateAt, '必须以权限闸门为前提才能前台化').toBeLessThan(startAt);
    expect(body).toContain('NotificationPermission.GRANTED');
    expect(body).toContain('stopSelf(startId)');
  });

  it('权限名以字面量常量声明，且拒因异常类型存在', () => {
    expect(readJava('LifecycleConstants.java')).toContain(
      'android.permission.POST_NOTIFICATIONS',
    );
    const ex = readJava('NotificationPermissionDeniedException.java');
    expect(ex).toContain('class NotificationPermissionDeniedException');
    expect(ex).toContain('extends IllegalStateException');
  });

  it('反面对照：三态枚举含 denied 且 wire() 与 TS 词表一致', () => {
    const perm = readJava('NotificationPermission.java');
    expect(perm).toContain('GRANTED');
    expect(perm).toContain('DENIED');
    expect(perm).toContain('NOT_DETERMINED');
    expect(perm).toContain('"not-determined"');
    expect(perm).toContain('"denied"');
    expect(perm).toContain('"granted"');
  });
});
