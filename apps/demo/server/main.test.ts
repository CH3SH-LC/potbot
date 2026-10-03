/**
 * S3 —— 入口（`main.ts`）的**监听地址**与启动自检单测。
 *
 * 只测纯/半纯函数与"启动期就该失败"的路径，**不真起服务**（真起服务会占端口，
 * 且无模型时也要能起来是另一条断言，见最后一条）。
 *
 * 为什么把 `POTBOT_BIND` 的非法值当硬错误测：安全默认必须闭合——
 * "写错了就静默对外全开"是这类开关最典型的失效模式。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BIND,
  createJobIndex,
  reachableUrls,
  resolveBindAddress,
  resolveDemoPaths,
  wirePorts,
} from './main.js';

describe('POTBOT_BIND：安全默认闭合', () => {
  it('未设置时绑定 127.0.0.1（默认绝不开到局域网）', () => {
    expect(resolveBindAddress({})).toBe(DEFAULT_BIND);
    expect(resolveBindAddress({ POTBOT_BIND: '' })).toBe(DEFAULT_BIND);
    expect(resolveBindAddress({ POTBOT_BIND: '   ' })).toBe(DEFAULT_BIND);
    expect(DEFAULT_BIND).toBe('127.0.0.1');
  });

  it('显式给出 0.0.0.0 / 本机 LAN IP / localhost 时按值处理', () => {
    expect(resolveBindAddress({ POTBOT_BIND: '0.0.0.0' })).toBe('0.0.0.0');
    expect(resolveBindAddress({ POTBOT_BIND: '192.168.1.10' })).toBe('192.168.1.10');
    expect(resolveBindAddress({ POTBOT_BIND: '::1' })).toBe('::1');
    expect(resolveBindAddress({ POTBOT_BIND: 'localhost' })).toBe(DEFAULT_BIND);
    expect(resolveBindAddress({ POTBOT_BIND: ' 10.0.0.5 ' })).toBe('10.0.0.5');
  });

  it('非法值抛错并给出中文原因（**绝不**回落到 0.0.0.0）', () => {
    for (const bad of [
      'http://0.0.0.0',
      '0.0.0.0:8765',
      '999.1.1.1',
      '1.2.3',
      'not a host',
      '/tmp/socket',
      '0.0.0.0/0',
    ]) {
      expect(
        () => resolveBindAddress({ POTBOT_BIND: bad }),
        `期望 ${JSON.stringify(bad)} 被拒绝`,
      ).toThrow(/POTBOT_BIND/);
    }
  });

  it('reachableUrls 在 0.0.0.0 时给出本机与局域网两种可访问地址', () => {
    const urls = reachableUrls('0.0.0.0', 8765);
    expect(urls.some((url) => url.includes('127.0.0.1:8765'))).toBe(true);
    const local = reachableUrls('127.0.0.1', 8765);
    expect(local).toEqual(['http://127.0.0.1:8765/']);
  });
});

describe('宿主额度上限：与模型端口同源（POTBOT_MODEL_MAX_REQUESTS）', () => {
  it('显式设 24 ⇒ 宿主上限就是 24（对照臂：漏传 budgetLimit 时这里会是 12）', () => {
    const root = mkdtempSync(join(tmpdir(), 'potbot-budget-'));
    try {
      const paths = resolveDemoPaths({ POTBOT_REPO_ROOT: root, POTBOT_RUN_DIR: root });
      const wiring = wirePorts(paths, { POTBOT_MODEL_MAX_REQUESTS: '24' });
      expect(wiring.modelBudgetLimit).toBe(24);

      const jobs = createJobIndex(paths, wiring, { POTBOT_MODEL_MAX_REQUESTS: '24' });
      // **关键断言**：把 `budgetLimit` 传参去掉（或改成硬编码）时，这里会是 12，测试即红。
      expect(jobs.budgetLimit).toBe(24);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('不传 ⇒ 仍是模型模块的默认上限（默认不被悄悄改掉）', () => {
    const root = mkdtempSync(join(tmpdir(), 'potbot-budget-'));
    try {
      const paths = resolveDemoPaths({ POTBOT_REPO_ROOT: root, POTBOT_RUN_DIR: root });
      const wiring = wirePorts(paths, {});
      const jobs = createJobIndex(paths, wiring, {});
      // 默认值来自 S4 的 DEFAULT_MAX_REQUESTS（合同 v1 的 12），**不是**宿主自己另定的数。
      expect(wiring.modelBudgetLimit).toBe(12);
      expect(jobs.budgetLimit).toBe(12);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('非法值（非数字 / 负数）回落默认 12，不放大也不报错', () => {
    for (const bad of ['abc', '-5', '', '   ']) {
      const root = mkdtempSync(join(tmpdir(), 'potbot-budget-'));
      try {
        const paths = resolveDemoPaths({ POTBOT_REPO_ROOT: root, POTBOT_RUN_DIR: root });
        const wiring = wirePorts(paths, { POTBOT_MODEL_MAX_REQUESTS: bad });
        const jobs = createJobIndex(paths, wiring, { POTBOT_MODEL_MAX_REQUESTS: bad });
        expect(jobs.budgetLimit, `POTBOT_MODEL_MAX_REQUESTS=${JSON.stringify(bad)}`).toBe(12);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});

describe('resolveDemoPaths：运行目录与产物根', () => {
  it('默认落在 .runtime/mobile-word-demo/<runId>，产物根用正斜杠（planner 的路径纪律）', () => {
    const root = mkdtempSync(join(tmpdir(), 'potbot-paths-'));
    try {
      const paths = resolveDemoPaths({ POTBOT_REPO_ROOT: root });
      expect(paths.runDir).toBe(
        join(root, '.runtime', 'mobile-word-demo', 'MWD-20261002-A'),
      );
      expect(paths.artifactRootDir).toBe(
        `${paths.runDir.split('\\').join('/')}/artifacts`,
      );
      expect(paths.webDir).toBe(join(root, 'apps', 'demo', 'web'));
      expect(paths.artifactRootDir).not.toContain('\\');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('POTBOT_RUN_DIR 可改写本次运行目录', () => {
    const dir = mkdtempSync(join(tmpdir(), 'potbot-run-'));
    try {
      const paths = resolveDemoPaths({ POTBOT_RUN_DIR: dir });
      expect(paths.indexPath).toBe(join(dir, 'app-index.json'));
      expect(paths.artifactRootDir.endsWith('/artifacts')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
