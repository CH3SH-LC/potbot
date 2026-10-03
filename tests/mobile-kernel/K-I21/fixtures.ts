/**
 * K-I21 静态契约夹具 —— 读取原生 Java 源码与 TS 端口源码，做**跨语言契约**核对。
 *
 * 本单元不跑 Android 构建（无 SDK / gradle wrapper / 设备），因此"原生类是否真的实现了
 * TS 端口"只能靠**源码结构机判**：方法名、权限闸门的**先行**顺序、通道/类型常量的存在。
 * 这些是弱于真机编译的证据，但强于"作者声称"——且方法名清单**从 TS 源实时提取**，
 * 不是测试里手抄的副本，故 Java 漏实现一个方法会立刻变红。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 仓库根：tests/mobile-kernel/K-I21 → 上溯三层。 */
export const REPO_ROOT = join(HERE, '..', '..', '..');

/** 原生生命周期包（本单元独占写区）。 */
export const JAVA_DIR = join(
  REPO_ROOT,
  'apps',
  'android',
  'app',
  'src',
  'main',
  'java',
  'com',
  'potbot',
  'kernel',
  'lifecycle',
);

/** 被实现的 TS 端口定义处。 */
export const TS_TYPES = join(REPO_ROOT, 'apps', 'mobile-kernel', 'lifecycle', 'types.ts');

/** 本单元原生包内应有的 Java 文件（少一个即接线缺口）。 */
export const EXPECTED_JAVA_FILES = [
  'LifecycleConstants.java',
  'Clock.java',
  'NotificationPermission.java',
  'NotificationRequest.java',
  'NotificationHandle.java',
  'NotificationPort.java',
  'NotificationPermissionDeniedException.java',
  'UnknownNotificationException.java',
  'AndroidClock.java',
  'AndroidNotificationPort.java',
  'ConnectivityObserver.java',
  'ForegroundTaskService.java',
  'ResumeJobService.java',
] as const;

export function readJava(name: string): string {
  return readFileSync(join(JAVA_DIR, name), 'utf8');
}

export function readText(absolutePath: string): string {
  return readFileSync(absolutePath, 'utf8');
}

/**
 * 从 TS interface 体里提取方法名（按行首 `name(` 判定）。
 * 用于把"Java 是否实现 TS 端口的每个方法"变成实时比对，而不是硬编码清单。
 */
export function tsInterfaceMethodNames(source: string, interfaceName: string): string[] {
  const header = `export interface ${interfaceName}`;
  const start = source.indexOf(header);
  if (start < 0) {
    throw new Error(`未找到 TS interface ${interfaceName}`);
  }
  const open = source.indexOf('{', start);
  if (open < 0) {
    throw new Error(`interface ${interfaceName} 缺少 '{'`);
  }
  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) {
    throw new Error(`interface ${interfaceName} 花括号不平衡`);
  }
  const body = source.slice(open + 1, end);
  const names: string[] = [];
  for (const line of body.split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line);
    if (m && m[1] !== undefined) {
      names.push(m[1]);
    }
  }
  return names;
}

/**
 * 去掉 Java 块注释与行注释。
 *
 * 结构断言（"闸门在 notify 之前"）必须只看**代码**：否则一句"必须在 notify() 之前判定"
 * 的注释就会把顺序判反。本仓库 Java 的字符串字面量不含 `/*` 或 `//`，朴素剥离在此安全。
 */
export function stripJavaComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** 提取某个方法签名（含 `{...}` 体）的源码片段（已去注释）；用于断言方法体内的顺序/内容。 */
export function methodBody(source: string, signatureFragment: string): string {
  const cleaned = stripJavaComments(source);
  const start = cleaned.indexOf(signatureFragment);
  if (start < 0) {
    throw new Error(`未找到方法签名片段：${signatureFragment}`);
  }
  const open = cleaned.indexOf('{', start);
  if (open < 0) {
    throw new Error(`方法 ${signatureFragment} 缺少 '{'`);
  }
  let depth = 0;
  for (let i = open; i < cleaned.length; i += 1) {
    const ch = cleaned[i];
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return cleaned.slice(open, i + 1);
      }
    }
  }
  throw new Error(`方法 ${signatureFragment} 花括号不平衡`);
}

/** 断言 source 中 a 首次出现的位置严格早于 b；返回两者的下标便于诊断。 */
export function expectBefore(source: string, a: string, b: string): { aAt: number; bAt: number } {
  const aAt = source.indexOf(a);
  const bAt = source.indexOf(b);
  if (aAt < 0) {
    throw new Error(`未找到先行标记：${a}`);
  }
  if (bAt < 0) {
    throw new Error(`未找到后置标记：${b}`);
  }
  return { aAt, bAt };
}

/** 本单元所有原生 Java 源码（供脱敏/卫生检查）。 */
export function allJavaSources(): ReadonlyArray<{ name: string; source: string }> {
  return EXPECTED_JAVA_FILES.map((name) => ({ name, source: readJava(name) }));
}
