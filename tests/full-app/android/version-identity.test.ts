/**
 * APP-01（版本身份可核对）—— **源码级结构断言**。
 *
 * 合同依据：能力目录 APP-01「可安装、升级、冷启动、返回导航；旧数据迁移与升级失败处理；
 * 版本身份可核对」；`full-app-contract-v1.md` R206/R253。
 *
 * 判据（都可机判）：
 *   ① 版本身份只有**一个事实源** `apps/android/version.properties`；
 *   ② 打包用的 `versionCode`/`versionName` 由 `build.gradle` 从该文件读取，**不再各写一份**；
 *   ③ 运行时把"设备上实际安装的 versionName"与"由同一文件注入的产品版本资源"**对照**，
 *      只有相等才允许宣称一致（`PotbotAppVersion.isConsistent`）；
 *   ④ `productVersion` 与仓库根 `package.json` 的 version 一致（漂移即红——**这是刻意的**：
 *      改根版本时必须同步改这份文件）。
 *
 * ⚠️ **未验证（需真机）**：本文件只断言源码/配置结构。**没有**安装 APK、**没有**读真机
 * `PackageManager`、**没有**跑 Gradle，因此"设备上版本号真的等于产品版本"**未验证**。
 * 不得把这里的绿灯当作真机证据。
 */

import { describe, expect, it } from 'vitest';

import {
  APP_BUILD_GRADLE,
  JAVA_DIR,
  MAIN_ACTIVITY,
  PKG_JSON,
  STRINGS_XML,
  VERSION_PROPERTIES,
  deriveVersionCode,
  exists,
  readProperties,
  readText,
} from './android-app-source.js';

describe('版本号推导方案（判别力自证）', () => {
  it('按 major*1000000 + minor*1000 + patch 推导', () => {
    expect(deriveVersionCode('0.13.0')).toBe(13000);
    expect(deriveVersionCode('1.0.0')).toBe(1000000);
    expect(deriveVersionCode('2.5.7')).toBe(2005007);
    expect(deriveVersionCode('10.0.1')).toBe(10000001);
  });

  it('单调：patch/minor 增加时 versionCode 严格增大（系统才判得出"升级"）', () => {
    expect(deriveVersionCode('1.0.1')).toBeGreaterThan(deriveVersionCode('1.0.0'));
    expect(deriveVersionCode('1.1.0')).toBeGreaterThan(deriveVersionCode('1.0.9'));
    expect(deriveVersionCode('2.0.0')).toBeGreaterThan(deriveVersionCode('1.99.99'));
  });

  it('拒绝非三段式（不当成合法版本号）', () => {
    expect(() => deriveVersionCode('1.0')).toThrow();
    expect(() => deriveVersionCode('demo')).toThrow();
  });
});

describe('版本身份的事实源（apps/android/version.properties）', () => {
  it('文件存在且三个键齐备非空', () => {
    expect(exists(VERSION_PROPERTIES), `缺少 ${VERSION_PROPERTIES}`).toBe(true);
    const props = readProperties(VERSION_PROPERTIES);
    for (const key of ['productVersion', 'versionCode', 'versionName']) {
      expect(props[key], `version.properties 缺少 ${key}`).toBeTruthy();
    }
  });

  it('versionName === productVersion（同一个发布只有一个版本号）', () => {
    const props = readProperties(VERSION_PROPERTIES);
    expect(props['versionName']).toBe(props['productVersion']);
  });

  it('versionCode 与 versionName 按固定方案一致（不会各写一份而漂移）', () => {
    const props = readProperties(VERSION_PROPERTIES);
    const versionName = props['versionName'] ?? '';
    expect(Number(props['versionCode'])).toBe(deriveVersionCode(versionName));
  });

  it('versionCode 为正整数且在 Android 允许范围内', () => {
    const props = readProperties(VERSION_PROPERTIES);
    const code = Number(props['versionCode']);
    expect(Number.isInteger(code)).toBe(true);
    expect(code).toBeGreaterThan(0);
    expect(code).toBeLessThan(2_100_000_000);
  });

  it('★与产品版本一致：productVersion === package.json 的 version（漂移即红）', () => {
    const props = readProperties(VERSION_PROPERTIES);
    const pkg = JSON.parse(readText(PKG_JSON)) as { version?: string };
    expect(
      props['productVersion'],
      `版本漂移：${VERSION_PROPERTIES} 的 productVersion 与 ${PKG_JSON} 的 version 不一致——` +
        '改根版本时必须同步更新 version.properties（与 build.gradle 的 resValue 一起）。',
    ).toBe(pkg.version);
  });
});

describe('build.gradle 从事实源取版本（不再写死）', () => {
  const gradle = readText(APP_BUILD_GRADLE);

  it('读取 version.properties 并在缺失时直接失败（不允许回退默认版本号）', () => {
    expect(gradle).toContain("rootProject.file('version.properties')");
    expect(gradle).toContain('new Properties()');
    expect(gradle).toContain('GradleException');
  });

  it('versionCode / versionName 来自该文件', () => {
    expect(gradle).toContain("potbotVersion.getProperty('versionCode').toInteger()");
    expect(gradle).toContain("potbotVersion.getProperty('versionName')");
  });

  it('把产品版本注入为运行时资源 potbot_product_version', () => {
    expect(gradle).toMatch(/resValue\s+'string'\s*,\s*'potbot_product_version'/);
  });

  it('不再写死旧的 1.0-demo / versionCode 1', () => {
    expect(gradle).not.toMatch(/versionCode\s+1\b/);
    expect(gradle).not.toContain("1.0-demo");
  });

  it('strings.xml 不得再声明同名资源（否则重复定义、构建失败）', () => {
    expect(readText(STRINGS_XML)).not.toContain('name="potbot_product_version"');
  });
});

describe('运行时核对面（PotbotAppVersion）', () => {
  const java = readText(`${JAVA_DIR}/PotbotAppVersion.java`);

  it('从 PackageManager 读**设备上实际安装**的版本', () => {
    expect(java).toContain('getPackageManager()');
    expect(java).toContain('getPackageInfo(');
    expect(java).toContain('versionName');
    expect(java).toMatch(/getLongVersionCode\(\)|versionCode/);
  });

  it('读同一文件注入的产品版本资源，并做一致性判定', () => {
    expect(java).toContain('potbot_product_version');
    expect(java).toContain('getIdentifier');
    expect(java).toContain('isConsistent');
    expect(java).toMatch(/installedVersionName\.equals\(productVersion\)/);
  });

  it('读不到时如实标 readable=false，而不是编一个版本号', () => {
    expect(java).toContain('readable');
    expect(java).toContain('NameNotFoundException');
    expect(java).toContain('describe()');
  });

  it('MainActivity 在 onCreate 读一次并如实回报（不一致也报，不掩盖）', () => {
    const activity = readText(MAIN_ACTIVITY);
    const onCreate = activity.slice(activity.indexOf('protected void onCreate('));
    expect(onCreate).toContain('PotbotAppVersion.read(this)');
    expect(activity).toContain('ST_APP_VERSION_CONSISTENT');
    expect(activity).toContain('ST_APP_VERSION_MISMATCH');
  });

  it('桥上有只读的 appInfo()，页面据此核对版本身份', () => {
    const activity = readText(MAIN_ACTIVITY);
    expect(activity).toMatch(/public\s+String\s+appInfo\(\)/);
    const json = activity.slice(activity.indexOf('private String buildAppInfoJson()'));
    expect(json).toContain('"versionConsistent"');
    expect(json).toContain('"productVersion"');
  });
});
