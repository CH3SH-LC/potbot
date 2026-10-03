/**
 * K-I23 验证 ③：Service 承载打包后的 JS 运行时并接到桥上（静态核验）。
 *
 * 判据：
 *   - Service 声明了可嵌入 JS 运行时接缝（JsEngine / KernelHandle）与加载入口；
 *   - 打包产物 assets 路径与 K-I14 的 dist 产物同名（basename 必须一致）；
 *   - Service 通过 dispatcher 适配器把内核句柄接给桥；
 *   - fail-closed：dispatcher 只在引导层**加载成功**后注入，onCreate 不注入。
 *
 * 说明：Java 未编译（本机无 Android SDK），这里只核验**源码事实**，不代表真机行为。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BUILD_INFO_PATH,
  BUILD_INFO_PRESENT,
  JAVA_SERVICE_PATH,
  extractMethodBody,
  parseStringConstant,
  readSource,
} from './bridge-surface.js';

const JAVA_SERVICE = readSource(JAVA_SERVICE_PATH);
const ASSET_PATH = parseStringConstant(JAVA_SERVICE, 'BUNDLE_ASSET_PATH');

describe('K-I23 运行时承载：Service 接线点', () => {
  it('声明了 JS 运行时接缝（JsEngine）与内核句柄（KernelHandle）', () => {
    expect(JAVA_SERVICE).toMatch(/interface\s+JsEngine\b/);
    expect(JAVA_SERVICE).toMatch(/KernelHandle\s+loadBundle\s*\(/);
    expect(JAVA_SERVICE).toMatch(/interface\s+KernelHandle\b/);
    // 接缝由集成人按 arm64 spike 选型注入。
    expect(JAVA_SERVICE).toMatch(/void\s+setJsEngine\s*\(/);
  });

  it('从 assets 读取引导层并交给 JsEngine 求值', () => {
    expect(JAVA_SERVICE).toMatch(/void\s+loadBundle\s*\(/);
    expect(JAVA_SERVICE).toMatch(/engine\s*\.\s*loadBundle\s*\(/);
    expect(JAVA_SERVICE).toMatch(/getAssets\s*\(\s*\)/);
  });

  it('把内核句柄经 dispatcher 适配器接到桥上', () => {
    expect(JAVA_SERVICE).toMatch(/implements\s+KernelLocalUiBridge\s*\.\s*CommandDispatcher/);
    expect(JAVA_SERVICE).toMatch(/bridge\s*\.\s*setDispatcher\s*\(\s*new\s+BootstrapDispatcher\s*\(/);
  });

  it('桥白名单常量来自 KernelLocalUiBridge（唯一来源，不复制第二份）', () => {
    expect(JAVA_SERVICE).toMatch(/ALLOWED_ORIGINS\s*=\s*KernelLocalUiBridge\s*\.\s*DEFAULT_ALLOWED_ORIGINS/);
  });
});

describe('K-I23 运行时承载：打包产物路径对齐 K-I14', () => {
  it('BUNDLE_ASSET_PATH 指向 assets 下的 kernel/bootstrap.mjs', () => {
    expect(ASSET_PATH).toBe('kernel/bootstrap.mjs');
    expect(path.basename(ASSET_PATH ?? '')).toBe('bootstrap.mjs');
    expect(ASSET_PATH?.startsWith('kernel/')).toBe(true);
  });

  it('路径常量解析器反向对照：换个值必须被读成不同的字符串', () => {
    const synthetic = 'public static final String BUNDLE_ASSET_PATH = "other/thing.mjs";';
    expect(parseStringConstant(synthetic, 'BUNDLE_ASSET_PATH')).toBe('other/thing.mjs');
    expect(parseStringConstant(synthetic, 'BUNDLE_ASSET_PATH')).not.toBe(ASSET_PATH);
  });

  it('与 K-I14 dist 产物的文件名一致（若 build-info.json 存在）', () => {
    if (!BUILD_INFO_PRESENT) {
      // dist 由 K-I14 生成，可能尚未落盘；缺失时不虚报，只核对常量形状。
      expect(ASSET_PATH).toBe('kernel/bootstrap.mjs');
      return;
    }
    const info = JSON.parse(readFileSync(BUILD_INFO_PATH, 'utf8')) as { outfile?: string };
    expect(typeof info.outfile).toBe('string');
    expect(path.basename(info.outfile ?? '')).toBe(path.basename(ASSET_PATH ?? ''));
  });
});

describe('K-I23 运行时承载：fail-closed 注入', () => {
  it('setDispatcher 在 Service 里只出现一次（只在加载成功后注入）', () => {
    const occurrences = JAVA_SERVICE.match(/\.\s*setDispatcher\s*\(/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });

  it('onCreate 不注入 dispatcher（初始保持 EXECUTOR_UNAVAILABLE）', () => {
    const onCreateBody = extractMethodBody(JAVA_SERVICE, /void\s+onCreate\s*\(\s*\)/);
    expect(onCreateBody, '找不到 onCreate 方法体').not.toBeNull();
    expect(onCreateBody).not.toMatch(/setDispatcher\s*\(/);
    // 反向对照：抽取器确实拿到了方法体（不是空串带来的假绿灯）。
    expect(onCreateBody).toMatch(/super\s*\.\s*onCreate\s*\(/);
  });

  it('加载失败只记日志、不注入 dispatcher（桥保持 fail-closed）', () => {
    // loadBundle 的 catch 分支不得注入 dispatcher。
    const loadAt = JAVA_SERVICE.indexOf('void loadBundle()');
    const catchAt = JAVA_SERVICE.indexOf('catch (Exception', loadAt);
    expect(loadAt).toBeGreaterThanOrEqual(0);
    expect(catchAt).toBeGreaterThan(loadAt);
    const catchTail = JAVA_SERVICE.slice(catchAt, catchAt + 400);
    expect(catchTail).not.toMatch(/setDispatcher\s*\(/);
  });
});
