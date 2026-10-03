/**
 * K-I21 契约③：前台服务类型声明 + 通知通道 + 有界常驻。
 *
 * 清单里的 `android:foregroundServiceType` / `<service>` / uses-permission 归集成人编辑，
 * 本单元**不得**碰 `AndroidManifest.xml`；因此这里只核验**运行期 Java 侧**确实声明了类型常量
 * 并用它调用 `startForeground(id, notification, type)`，以及通知通道用稳定 id 创建。
 */

import { describe, expect, it } from 'vitest';

import { methodBody, readJava } from './fixtures.js';

const fgs = readJava('ForegroundTaskService.java');
const impl = readJava('AndroidNotificationPort.java');
const constants = readJava('LifecycleConstants.java');

describe('K-I21 ③ 前台服务类型 / 通知通道 / 有界常驻', () => {
  it('ForegroundTaskService 是 Service，且前台化时传入类型', () => {
    expect(fgs).toContain('class ForegroundTaskService extends Service');
    const body = methodBody(fgs, 'public int onStartCommand(');
    expect(body).toContain('startForeground(');
    expect(body).toContain('LifecycleConstants.FOREGROUND_SERVICE_TYPE');
    // API 29+ 走三参重载，低版本走两参重载（类型不可用）。
    expect(body).toContain('Build.VERSION_CODES.Q');
  });

  it('前台服务类型常量映射到 dataSync（与清单需一致）', () => {
    expect(constants).toMatch(
      /FOREGROUND_SERVICE_TYPE\s*=\s*ServiceInfo\.FOREGROUND_SERVICE_TYPE_DATA_SYNC/,
    );
  });

  it('通知通道用稳定 id 创建，且 id 与运行期常量一致', () => {
    expect(impl).toContain('createNotificationChannel(');
    expect(impl).toMatch(/new NotificationChannel\(/);
    expect(impl).toContain('LifecycleConstants.NOTIFICATION_CHANNEL_ID');
    expect(constants).toMatch(/NOTIFICATION_CHANNEL_ID\s*=\s*"potbot\.kernel\.tasks"/);
    expect(constants).toContain('NOTIFICATION_CHANNEL_IMPORTANCE');
  });

  it('有界常驻：预算到点主动 stopForeground，不无限常驻、不自动复活', () => {
    expect(fgs).toContain('DEFAULT_RESIDENCY_BUDGET_MS');
    expect(fgs).toContain('stopForeground(');
    expect(fgs).toContain('removeCallbacks(budgetStop)');
    // 进程被回收/被杀后不承诺自动复活。
    expect(methodBody(fgs, 'public int onStartCommand(')).toContain('START_NOT_STICKY');
    expect(constants).toMatch(/DEFAULT_RESIDENCY_BUDGET_MS\s*=\s*10L\s*\*\s*60L\s*\*\s*1000L/);
  });
});
