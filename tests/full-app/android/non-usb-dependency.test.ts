/**
 * APP-06（日常使用不把 USB 调试连接当产品必需条件；界面资源、服务地址、认证、断线状态完整）
 * —— 源码级结构断言。
 *
 * 合同依据：`full-app-contract-v1.md` R254（USB 只用于开发验证，不是产品运行前提）、
 * R253（远程与本机工具边界明示；离线排队/恢复、通知/重连、URI 权限）、
 * R258（界面资源/服务地址/认证/断线状态完整；密钥不进 APK、网页或普通日志）、
 * R206（换地址不等于内核进手机）。
 *
 * 判据（都可机判）：
 *   ① 首页地址来自**可配置端点**，不再是写死的回环；写死的那一份只是"开发默认值"；
 *   ② 可信同源判定对**配置的那个源**做严格 scheme+host+port 全等（不放松边界）；
 *   ③ 地址有校验（非 http/https、含 userinfo、带查询串一律拒绝）；
 *   ④ 能判出"当前是回环/开发模式"并**如实标注**，不当成产品形态；
 *   ⑤ 认证凭据只存私有 prefs、只以请求头发送、**不暴露给页面**、不进日志；
 *   ⑥ 断线状态齐全（在线/离线/未知三态 + 页面加载失败/HTTP 错误），且文案在资源里。
 *
 * ⚠️ **未验证（需真机）**：脱离 adb reverse 后在真实网络/远程后端上能否打开并完成一次
 * 任务——**未在设备上验证**（本包不安装、不连真机）。本文件只核对源码结构。
 */

import { describe, expect, it } from 'vitest';

import {
  ANDROID_MANIFEST,
  JAVA_DIR,
  MAIN_ACTIVITY,
  NETWORK_SECURITY_CONFIG,
  STRINGS_XML,
  androidAppSourceFiles,
  allowlistedPermissionNames,
  declaredPermissions,
  extractMethodBody,
  readText,
  scanForSecrets,
  scanPermissionViolations,
} from './android-app-source.js';

const ENDPOINTS = `${JAVA_DIR}/PotbotEndpoints.java`;
const CONNECTIVITY = `${JAVA_DIR}/PotbotConnectivity.java`;

describe('密钥形态扫描器（判别力自证）', () => {
  it('抓得到写死的厂商密钥 / 授权头令牌 / 赋值字面密钥', () => {
    expect(scanForSecrets([{ path: 'Fake.java', text: 'String k = "' + 'sk' + '-' + 'abcdefghijklmnop0123' + '";' }]).join())
      .toContain('厂商密钥前缀');
    expect(scanForSecrets([{ path: 'Fake.js', text: 'h = "' + 'Be' + 'arer' + ' ' + 'eyJhbGciOiJIUzI1In0.abcdefgh' + '";' }]).join())
      .toContain('授权头令牌');
    expect(scanForSecrets([{ path: 'Fake.java', text: 'String token' + ' = "' + '0123456789abcdef' + '";' }]).join())
      .toContain('赋值字面密钥');
  });

  it('干净样本零违规（对照臂，防止扫描器恒真）', () => {
    expect(scanForSecrets([
      { path: 'Clean.java', text: 'String h = HEADER_AUTHORIZATION; // 已连接电脑服务\nlog("task-status");' },
      { path: 'Clean.java', text: 'private static final String SCHEME_BEARER = "Bearer";' },
    ])).toEqual([]);
  });
});

describe('服务地址可配置：不再把回环写死在宿主里', () => {
  const activity = readText(MAIN_ACTIVITY);
  const endpoints = readText(ENDPOINTS);

  it('MainActivity 不再有绝对 http 地址字面量，首页地址来自 startUrl()', () => {
    expect(activity).not.toMatch(/"http:\/\//);
    expect(activity).toContain('webView.loadUrl(startUrl())');
    const startUrl = extractMethodBody(activity, 'private String startUrl()') ?? '';
    expect(startUrl).toContain('PotbotEndpoints.baseUrl(this)');
  });

  it('产物下载的 base 也用**配置的**端点（否则部署模式下会去拉回环地址）', () => {
    const doSave = extractMethodBody(activity, 'private void doSave(') ?? '';
    expect(doSave, 'doSave 缺失').not.toBe('');
    expect(doSave).toContain('PotbotEndpoints.baseUrl(this) + downloadPath');
    expect(doSave).not.toMatch(/ORIGIN\s*\+\s*downloadPath/);
  });

  it('同源拒绝消息引用**当前配置的源**，不再写死回环', () => {
    expect(activity).not.toContain('"同源校验失败：当前页面不是来自 " + ORIGIN');
    expect(activity).toContain('configuredOrigin()');
  });

  it('公共常量 ORIGIN 只引用开发默认值（单一出处，不复制字面量）', () => {
    expect(activity).toContain('public static final String ORIGIN = PotbotEndpoints.DEV_USB_BASE_URL;');
  });

  it('开发默认地址只在 PotbotEndpoints 里出现一次，且注明"只是开发便利"', () => {
    const literals = [...endpoints.matchAll(/"http:\/\//g)];
    expect(literals.length, '绝对 http 地址字面量应当只有开发默认值一处').toBe(1);
    expect(endpoints).toContain('DEV_USB_BASE_URL = "http://127.0.0.1:8765"');
    expect(endpoints).toContain('isDevUsbMode');
  });

  it('地址有校验：非 http/https、含 userinfo、带查询串一律拒绝', () => {
    const normalize = extractMethodBody(endpoints, 'public static String normalizeBaseUrl(') ?? '';
    expect(normalize).toContain('"http"');
    expect(normalize).toContain('"https"');
    expect(normalize).toContain('getUserInfo()');
    expect(normalize).toContain('getQuery()');
    expect(normalize).toContain('getFragment()');
    const setter = extractMethodBody(endpoints, 'public static void setBaseUrl(') ?? '';
    expect(setter).toContain('IllegalArgumentException');
  });

  it('可信同源判定改成"配置的那个源"，但仍是严格 scheme+host+port 全等', () => {
    const match = extractMethodBody(endpoints, 'public static boolean matchesConfiguredOrigin(') ?? '';
    expect(match).toContain('getScheme()');
    expect(match).toContain('getHost()');
    expect(match).toContain('portOf(');
    expect(match).toMatch(/equalsIgnoreCase\(base\.getScheme\(\)\)/);
    expect(match).toMatch(/equalsIgnoreCase\(base\.getHost\(\)\)/);
    // 不得出现"子域放行"这类放松写法。
    expect(match).not.toMatch(/endsWith\(.*host/);
    expect(match).not.toContain('includeSubdomains');
  });

  it('宿主把 8 处以上保存/导出/打印的同源检查换成可信同源判定', () => {
    const calls = activity.split('isTrustedPageOrigin(').length - 1;
    expect(calls).toBeGreaterThanOrEqual(12);
    // 回环判定只在定义与"可信同源"里各出现一次。
    const devCalls = activity.split('isDevLoopbackOrigin(').length - 1;
    expect(devCalls).toBe(2);
  });

  it('能判出"当前是回环/开发模式"并如实暴露给页面（不当产品形态）', () => {
    const isDev = extractMethodBody(endpoints, 'public static boolean isDevUsbMode(') ?? '';
    expect(isDev).toContain('127.0.0.1');
    expect(isDev).toContain('localhost');
    const info = extractMethodBody(activity, 'private String buildAppInfoJson()') ?? '';
    expect(info).toContain('"devUsbMode"');
    expect(info).toContain('"baseUrl"');
  });
});

describe('认证：凭据不进 APK/网页/日志，页面拿不到值', () => {
  const endpoints = readText(ENDPOINTS);

  it('凭据只存应用私有 prefs；读凭据的方法**不是 public**（页面无法经桥拿到值）', () => {
    expect(endpoints).toContain('MODE_PRIVATE');
    expect(endpoints).toMatch(/\n\s*static\s+String\s+credential\(Context context\)/);
    expect(endpoints).not.toMatch(/public\s+static\s+String\s+credential\(/);
  });

  it('只以请求头发出，且头名/方案是常量（无写死密钥）', () => {
    expect(endpoints).toContain('HEADER_AUTHORIZATION = "Authorization"');
    expect(endpoints).toContain('SCHEME_BEARER = "Bearer"');
    const applyAuth = extractMethodBody(endpoints, 'public static void applyAuth(') ?? '';
    expect(applyAuth).toContain('setRequestProperty(HEADER_AUTHORIZATION');
    expect(applyAuth).toContain('SCHEME_BEARER');
  });

  it('对外摘要只报"有无凭据"，不含凭据值', () => {
    const describe = extractMethodBody(endpoints, 'public static String describe(Context context)') ?? '';
    expect(describe).toContain('hasCredential(context)');
    expect(describe).not.toContain('credential(context)');
    expect(endpoints).toContain('credentialConfigured');
  });

  it('进 APK 的源码/清单/资源未发现密钥形态（本地扫描）', () => {
    const files = androidAppSourceFiles();
    expect(files.length).toBeGreaterThan(0);
    const violations = scanForSecrets(files);
    expect(violations, `安卓侧发现密钥形态：\n${violations.join('\n')}`).toEqual([]);
  });
});

describe('断线状态与界面资源完整', () => {
  const activity = readText(MAIN_ACTIVITY);
  const strings = readText(STRINGS_XML);

  it('三态连通性判定（在线/离线/未知）不把未知折叠成离线', () => {
    const connectivity = readText(CONNECTIVITY);
    expect(connectivity).toContain('enum Tri');
    expect(connectivity).toContain('ONLINE');
    expect(connectivity).toContain('OFFLINE');
    expect(connectivity).toContain('UNKNOWN');
    const tri = extractMethodBody(connectivity, 'public static Tri isOnline(') ?? '';
    expect(tri).toContain('NET_CAPABILITY_INTERNET');
    expect(tri, '判不出来必须返回 UNKNOWN').toContain('Tri.UNKNOWN');
  });

  it('页面加载失败 / HTTP 错误单独报（不拿旧内容冒充已加载）', () => {
    expect(activity).toContain('onReceivedError(');
    expect(activity).toContain('onReceivedHttpError(');
    expect(activity).toContain('ST_APP_PAGE_LOAD_FAILED');
    expect(activity).toContain('ST_APP_PAGE_HTTP_ERROR');
    expect(activity).toContain('isForMainFrame()');
  });

  it('断线/认证/开发模式/升级 的文案都在资源里（不散落硬编码）', () => {
    for (const name of [
      'potbot_state_offline', 'potbot_state_online', 'potbot_state_unknown',
      'potbot_state_load_failed', 'potbot_state_http_error',
      'potbot_endpoint_dev_usb', 'potbot_endpoint_invalid',
      'potbot_auth_missing', 'potbot_auth_configured',
      'potbot_upgrade_failed', 'potbot_upgrade_downgrade',
      'potbot_notification_channel', 'potbot_notification_channel_desc',
      'potbot_progress_notification_title',
    ]) {
      expect(strings, `strings.xml 缺少 ${name}`).toContain(`name="${name}"`);
    }
    expect(activity).toContain('R.string.potbot_state_offline');
    expect(activity).toContain('R.string.potbot_upgrade_failed');
  });

  it('网络权限仍在（连通性判定需要），且权限只落在**具名白名单**内', () => {
    const manifest = readText(ANDROID_MANIFEST);
    const granted = declaredPermissions(manifest);
    expect(granted).toContain('android.permission.ACCESS_NETWORK_STATE');
    expect(granted).toContain('android.permission.INTERNET');
    // FA-APP-NOTIFY-PERM：白名单取代"固定两元集合"；白名单外仍然报红。
    expect(scanPermissionViolations(manifest)).toEqual([]);
    expect(granted.slice().sort()).toEqual([...allowlistedPermissionNames()]);
  });

  it('安全配置保持：明文只对回环放行，远程必须 HTTPS，未关闭 TLS 校验', () => {
    const nsc = readText(NETWORK_SECURITY_CONFIG);
    expect(nsc).toMatch(/<base-config cleartextTrafficPermitted="false">/);
    expect(nsc).toMatch(/<domain[^>]*>127\.0\.0\.1<\/domain>/);
    expect(nsc).toContain('<certificates src="system" />');
    expect(nsc).not.toMatch(/cleartextTrafficPermitted="true"[\s\S]*<\/base-config>/);
  });
});
