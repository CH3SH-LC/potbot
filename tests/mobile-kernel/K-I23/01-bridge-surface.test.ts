/**
 * K-I23 验证 ①：Android 本地 UI 桥的 JS 面 == K01 `createLocalUiBridge` 契约。
 *
 * 判据（都读**真实**源码 / **真实**运行时导出，不采样、不硬编码猜测）：
 *   - 真实 `createLocalUiBridge` 返回对象的键 = ['cancel','subscribe','submit']；
 *   - Java 桥的 `@JavascriptInterface` 方法集 = 上述三项 + `unsubscribe`
 *     （对应 TS `Subscription.unsubscribe`）；**没有**第五个 JS 入口；
 *   - 每个 JS 入口都带 `origin` 参数且方法体调用 `isAllowedOrigin(...)`（本地 origin 门）；
 *   - 宿主接线口（setDispatcher / emitEvent ...）**不**暴露给 JS；
 *   - Service 自身**不**暴露任何 JS 接口（唯一注册点是桥）；
 *   - 桥的白名单常量与 K01 `DEFAULT_ALLOWED_ORIGINS` 逐项一致。
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ALLOWED_ORIGINS,
  createBootstrapRuntime,
  createLocalUiBridge,
  createManualClock,
} from '../../../apps/mobile-kernel/bootstrap/index.js';
import {
  HOST_ONLY_METHODS,
  JAVA_BRIDGE_PATH,
  JAVA_SERVICE_PATH,
  paramName,
  parseExposedMethods,
  parseStringArrayConstant,
  readSource,
} from './bridge-surface.js';

const JAVA_BRIDGE = readSource(JAVA_BRIDGE_PATH);
const JAVA_SERVICE = readSource(JAVA_SERVICE_PATH);
const EXPOSED = parseExposedMethods(JAVA_BRIDGE);
const EXPOSED_NAMES = EXPOSED.map((m) => m.name);

/** 真实 K01 桥的对外键（权威面，不是读源码猜的）。 */
function realBridgeSurface(): string[] {
  const runtime = createBootstrapRuntime({ clock: createManualClock() });
  const bridge = createLocalUiBridge(runtime);
  return Object.keys(bridge).sort();
}

describe('K-I23 桥面：与 K01 createLocalUiBridge 契约一致', () => {
  it('真实 K01 桥对外键恰为 submit / subscribe / cancel', () => {
    expect(realBridgeSurface()).toEqual(['cancel', 'submit', 'subscribe']);
  });

  it('Java 桥的 @JavascriptInterface 方法恰为 submit / subscribe / unsubscribe / cancel', () => {
    expect([...EXPOSED_NAMES].sort()).toEqual(['cancel', 'submit', 'subscribe', 'unsubscribe']);
  });

  it('K01 契约的每个方法在 Java 桥都有对应 JS 入口', () => {
    for (const method of realBridgeSurface()) {
      expect(EXPOSED_NAMES, `Java 桥缺少 JS 入口 ${method}`).toContain(method);
    }
  });

  it('Java 桥相对 K01 只多一个 unsubscribe（对应 Subscription.unsubscribe），无第五个入口', () => {
    const extra = [...EXPOSED_NAMES].filter((n) => !realBridgeSurface().includes(n)).sort();
    expect(extra).toEqual(['unsubscribe']);
  });

  it('三个原语返回类型与 TS 桥语义对应（submit→String 事件 JSON，cancel→boolean）', () => {
    const byName = new Map(EXPOSED.map((m) => [m.name, m]));
    expect(byName.get('submit')?.returnType).toBe('String');
    expect(byName.get('subscribe')?.returnType).toBe('String');
    expect(byName.get('cancel')?.returnType).toBe('boolean');
    expect(byName.get('unsubscribe')?.returnType).toBe('boolean');
  });
});

describe('K-I23 桥面：每个 JS 入口先过本地 origin 门', () => {
  it('四个 JS 入口都带名为 origin 的参数', () => {
    for (const method of EXPOSED) {
      const names = method.params.map(paramName);
      expect(names, `${method.name} 缺少 origin 参数`).toContain('origin');
    }
  });

  it('四个 JS 入口的方法体都调用 isAllowedOrigin(...)（拒绝非白名单调用方）', () => {
    for (const method of EXPOSED) {
      expect(method.body, `${method.name} 未做 origin 校验`).toMatch(/isAllowedOrigin\s*\(/);
    }
  });

  it('白名单常量与 K01 DEFAULT_ALLOWED_ORIGINS 逐项一致', () => {
    const javaOrigins = parseStringArrayConstant(JAVA_BRIDGE, 'DEFAULT_ALLOWED_ORIGINS');
    expect(javaOrigins).not.toBeNull();
    expect(javaOrigins).toEqual([...DEFAULT_ALLOWED_ORIGINS]);
    expect([...DEFAULT_ALLOWED_ORIGINS]).toEqual(['app://local', 'file:///android_asset', 'https://localhost']);
  });
});

describe('K-I23 桥面：宿主接线口不暴露给 JS', () => {
  for (const name of HOST_ONLY_METHODS) {
    it(`${name} 存在但不在 @JavascriptInterface 面内`, () => {
      expect(JAVA_BRIDGE, `桥源码里找不到宿主方法 ${name}`).toMatch(new RegExp(`\\b${name}\\s*\\(`));
      expect(EXPOSED_NAMES).not.toContain(name);
    });
  }

  it('Service 自身不暴露任何 @JavascriptInterface（唯一注册点是桥）', () => {
    expect(parseExposedMethods(JAVA_SERVICE)).toEqual([]);
    expect(/@JavascriptInterface/.test(JAVA_SERVICE)).toBe(false);
  });

  it('桥不自行调用 addJavascriptInterface（接线归 Android 集成人）', () => {
    expect(/addJavascriptInterface\s*\(/.test(JAVA_BRIDGE)).toBe(false);
    expect(/addJavascriptInterface\s*\(/.test(JAVA_SERVICE)).toBe(false);
  });
});
