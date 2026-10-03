/**
 * K-I21 契约①：原生 Java 类**实现了 TS 端口**（NotificationPort / Clock）。
 *
 * 方法清单从 `apps/mobile-kernel/lifecycle/types.ts` **实时提取**——TS 端口新增一个方法而
 * Java 没跟上时本用例立刻变红，因此这不是"作者手抄"的自证。
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  EXPECTED_JAVA_FILES,
  JAVA_DIR,
  TS_TYPES,
  readJava,
  readText,
  tsInterfaceMethodNames,
} from './fixtures.js';

const tsTypes = readText(TS_TYPES);

function hasMethod(source: string, method: string): boolean {
  return new RegExp(`\\b${method}\\s*\\(`).test(source);
}

describe('K-I21 ① 端口实现：Java 实现 TS 端口', () => {
  it('原生包内应有全部接线文件', () => {
    for (const name of EXPECTED_JAVA_FILES) {
      expect(existsSync(join(JAVA_DIR, name)), `缺少 ${name}`).toBe(true);
    }
  });

  it('NotificationPort.java 复刻 TS NotificationPort 的每个方法', () => {
    const tsMethods = tsInterfaceMethodNames(tsTypes, 'NotificationPort');
    expect(tsMethods).toEqual(['permission', 'post', 'update', 'stop', 'activeCount']);
    const java = readJava('NotificationPort.java');
    expect(java).toContain('interface NotificationPort');
    for (const method of tsMethods) {
      expect(hasMethod(java, method), `接口缺方法 ${method}`).toBe(true);
    }
  });

  it('AndroidNotificationPort 声明 implements NotificationPort 并实现每个方法', () => {
    const tsMethods = tsInterfaceMethodNames(tsTypes, 'NotificationPort');
    const impl = readJava('AndroidNotificationPort.java');
    expect(impl).toContain('implements NotificationPort');
    for (const method of tsMethods) {
      expect(hasMethod(impl, method), `实现缺方法 ${method}`).toBe(true);
    }
    // 通道 + 权限闸门也必须在同一实现里（详见 02/03）。
    expect(impl).toContain('createNotificationChannel(');
    expect(impl).toMatch(/if\s*\(\s*permission\(\)\s*!=\s*NotificationPermission\.GRANTED\s*\)/);
  });

  it('Clock 端口：TS 的 now() 在原生侧有声明与实现', () => {
    const tsMethods = tsInterfaceMethodNames(tsTypes, 'Clock');
    expect(tsMethods).toContain('now');
    expect(hasMethod(readJava('Clock.java'), 'now')).toBe(true);
    const impl = readJava('AndroidClock.java');
    expect(impl).toContain('implements Clock');
    expect(impl).toContain('public long now(');
  });

  it('每个原生文件都声明正确的 package', () => {
    for (const { name, source } of EXPECTED_JAVA_FILES.map((n) => ({ name: n, source: readJava(n) }))) {
      expect(source, `${name} package 错误`).toContain('package com.potbot.kernel.lifecycle;');
    }
  });
});
