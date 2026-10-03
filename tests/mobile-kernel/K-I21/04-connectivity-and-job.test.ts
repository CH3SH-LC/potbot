/**
 * K-I21 契约④：ConnectivityManager 回调 + JobScheduler 接线。
 *
 * 断网/恢复必须**如实上报**：判不出"在线"时报离线并以 known=false 标出"未知"（fail-safe，
 * 未知绝不触发续跑）；恢复续跑交给系统调度器（不新增权限，不空转、不谎报已续跑）。
 */

import { describe, expect, it } from 'vitest';

import { TS_TYPES, methodBody, readJava, readText } from './fixtures.js';

const observer = readJava('ConnectivityObserver.java');
const job = readJava('ResumeJobService.java');
const constants = readJava('LifecycleConstants.java');

describe('K-I21 ④ 连通性回调与 JobScheduler', () => {
  it('ConnectivityObserver 注册/注销默认网络回调', () => {
    expect(observer).toContain('ConnectivityManager');
    expect(observer).toContain('registerDefaultNetworkCallback(');
    expect(observer).toContain('unregisterNetworkCallback(');
    expect(observer).toContain('NET_CAPABILITY_INTERNET');
  });

  it('未知不当在线：onUnavailable 报 offline 且 known=false', () => {
    const body = methodBody(observer, 'public void onUnavailable(');
    expect(body).toMatch(/emit\(LifecycleConstants\.NETWORK_OFFLINE,\s*false\)/);
    // 取不到系统服务时同样保守（未知 → 离线）。
    const start = methodBody(observer, 'public void start(');
    expect(start).toContain('LifecycleConstants.NETWORK_OFFLINE, false');
  });

  it('网络词表与 TS 的 NETWORK_STATES 逐字对齐', () => {
    expect(readText(TS_TYPES)).toContain("export const NETWORK_STATES = ['online', 'offline'] as const;");
    expect(constants).toMatch(/NETWORK_ONLINE\s*=\s*"online"/);
    expect(constants).toMatch(/NETWORK_OFFLINE\s*=\s*"offline"/);
  });

  it('ResumeJobService 是 JobService，用 JobScheduler 排期且不新增权限', () => {
    expect(job).toContain('class ResumeJobService extends JobService');
    expect(job).toContain('JobScheduler');
    expect(job).toContain('JobInfo.Builder');
    expect(job).toContain('setRequiredNetworkType(');
    expect(job).toContain('setPersisted(true)');
    expect(job).toContain('onStopJob(');
    // 权限/组件声明归清单：Java 侧不得出现清单权限标签（注释里解释性的“uses-permission”字样不算）。
    expect(job).not.toContain('<uses-permission');
  });

  it('续跑作业 id / 最小延迟由常量固定，取消路径存在', () => {
    expect(constants).toMatch(/RESUME_JOB_ID\s*=\s*0x706F21/);
    expect(constants).toContain('RESUME_JOB_MIN_LATENCY_MS');
    expect(job).toContain('scheduler.cancel(');
    expect(job).toContain('LifecycleConstants.RESUME_JOB_ID');
  });
});
