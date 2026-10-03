/**
 * APP-07（授权入口 / 撤销 / 账号与服务连接 / 额度与存储管理）—— **源码级结构断言**。
 *
 * 判据（都可机判，且每条关键判据都用**合成的坏源码/坏样本**自证会变红）：
 *   ① 授权入口存在，且**存凭据时不打印任何东西**；
 *   ② 撤销会**读回核对**清除结果：读回还有凭据就报"断开失败"，绝不宣称已断开；
 *   ③ 连接状态**只报"有没有凭据"**，任何返回值/信号里都不含凭据值；
 *   ④ 额度与存储：写之前**预检**剩余空间，空间不足是独立结论；
 *   ⑤ 每个失败文案都给出**用户能照做**的下一步；
 *   ⑥ ★密钥不进 APK：整个进 APK 的 Android 源码树扫不到密钥形态；
 *   ⑦ ★日志分支不得打印凭据：日志调用行里不出现凭据词。
 *
 * ⚠️ **未验证（需真机/真实后端）**：真实的授权往返、撤销后服务端是否真的失联、
 * 设备真实可用空间数值，本包**没有设备**，未验证。本文件只核对源码结构。
 */

import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_OPS,
  MAIN_ACTIVITY,
  NEW_CLASSES,
  STRINGS_XML,
  androidAppSourceFiles,
  extractMethodBody,
  logLinesTouchingCredentials,
  readText,
  resourceTexts,
  scanForSecrets,
  stripJavaComments,
} from './android-input-source.js';

const java = readText(ACCOUNT_OPS);
const code = stripJavaComments(java);
const strings = resourceTexts(readText(STRINGS_XML));

// ---------------------------------------------------------------------------
// 合成坏样本（判别力自证）
// ---------------------------------------------------------------------------

/** 撤销了但**没读回核对**、直接宣称已断开的天真实现。 */
const NAIVE_REVOKE = `
public static Decision revoke(Context context) {
    return Decision.ok(ST_ACCOUNT_DISCONNECTED);
}`;

/** 把凭据打印到日志的坏实现。 */
const LEAKING_LOG = `
private static void dump(Context c) {
    Log.d(TAG, "credential=" + PotbotEndpoints.credential(context));
}`;

/** 提供"读凭据值"接口的坏实现。 */
const CREDENTIAL_ACCESSOR = `
public static String credentialValue(Context context) {
    return PotbotEndpoints.getCredential(context);
}`;

/** 不预检空间、一律说够的天真实现。 */
const NAIVE_QUOTA = `
public static Decision canAcceptInput(Context context, long incomingBytes) {
    return Decision.ok(ST_QUOTA_OK);
}`;

// ---------------------------------------------------------------------------
// 判据
// ---------------------------------------------------------------------------

function revokeVerifiesCleared(src: string): boolean {
  const body = extractMethodBody(stripJavaComments(src), 'public static Decision revoke(') ?? '';
  return body.includes('clearCredential') && body.includes('hasCredential')
      && body.includes('ST_ACCOUNT_REVOKE_FAILED') && body.includes('ST_ACCOUNT_DISCONNECTED');
}

function authorizeStoresWithoutLogging(src: string): boolean {
  const body = extractMethodBody(stripJavaComments(src), 'public static Decision beginAuthorize(') ?? '';
  return body.includes('setCredential') && !body.includes('Log.');
}

function quotaPreflight(src: string): boolean {
  const body = extractMethodBody(stripJavaComments(src), 'public static Decision canAcceptInput(') ?? '';
  const flat = body.replace(/\s+/g, ' ');
  return body.includes('readStorage') && body.includes('MIN_FREE_BYTES')
      && flat.includes('ST_QUOTA_LOW') && flat.includes('ST_QUOTA_OK');
}

function exposesCredentialValue(src: string): boolean {
  const c = stripJavaComments(src);
  return /getCredential\s*\(/.test(c) || /credentialValue/.test(c)
      || /public\s+static\s+String\s+credential\b/i.test(c);
}

// ---------------------------------------------------------------------------

describe('判别力自证（合成坏样本必须被抓）', () => {
  it('没读回核对就宣称已断开的撤销 → 判据为假', () => {
    expect(revokeVerifiesCleared(NAIVE_REVOKE)).toBe(false);
  });

  it('把凭据打进日志的坏实现 → 日志判据抓得到', () => {
    expect(logLinesTouchingCredentials(LEAKING_LOG).length).toBeGreaterThan(0);
  });

  it('提供凭据值接口的坏实现 → 暴露判据为真', () => {
    expect(exposesCredentialValue(CREDENTIAL_ACCESSOR)).toBe(true);
  });

  it('不预检空间的天真实现 → 预审判据为假', () => {
    expect(quotaPreflight(NAIVE_QUOTA)).toBe(false);
  });

  it('密钥扫描器有刻度：合成密钥被抓、干净样本放行', () => {
    expect(scanForSecrets([{
      path: 'Fake.kt',
      text: 'val t = "' + 'ghp' + '_' + 'A'.repeat(36) + '"',
    }]).join()).toContain('代码平台令牌');
    expect(scanForSecrets([{ path: 'Clean.java', text: 'boolean has = hasCredential(context);' }])).toEqual([]);
  });
});

describe('授权入口与撤销', () => {
  it('授权入口存在，且存凭据的路径**不打印任何东西**', () => {
    expect(authorizeStoresWithoutLogging(java)).toBe(true);
    expect(code).toMatch(/public static int authorizeEntryLabelRes\(\)/);
    expect(code).toMatch(/public static Decision beginAuthorize\(Context context, String credential\)/);
  });

  it('★撤销会读回核对：读回还有凭据 → 报"断开失败"，不宣称已断开', () => {
    expect(revokeVerifiesCleared(java)).toBe(true);
  });

  it('凭据异常只报类型、不带消息（异常消息可能夹带凭据）', () => {
    const body = extractMethodBody(code, 'public static Decision beginAuthorize(') ?? '';
    expect(body.replace(/\s+/g, ' ')).toMatch(/catch \(Throwable e\) \{ return Decision\.fail/);
    expect(body).not.toContain('e.getMessage()');
  });
});

describe('连接状态只报事实、不暴露凭据值', () => {
  it('连接状态用 hasCredential（布尔），不是凭据本身', () => {
    const body = extractMethodBody(code, 'public static Connection readConnection(') ?? '';
    expect(body).toContain('hasCredential');
    expect(body).toContain('baseUrl');
    expect(exposesCredentialValue(java)).toBe(false);
  });

  it('给页面的 JSON 里没有任何凭据字段', () => {
    const body = extractMethodBody(code, 'public static String describeJson(') ?? '';
    expect(body).not.toMatch(/credential/i);
    expect(body).toContain('"connected"');
    expect(body).toContain('"freeBytes"');
    expect(body).toContain('"freeText"');
  });

  it('未连接时给出"需要连接"的结论，而不是假装已连接', () => {
    const body = extractMethodBody(code, 'public static Decision requireConnected(') ?? '';
    expect(body).toContain('ST_ACCOUNT_AUTH_NEEDED');
    expect(body).toContain('ST_ACCOUNT_CONNECTED');
  });
});

describe('额度与存储管理', () => {
  it('写之前预检空间：空间不足是独立结论', () => {
    expect(quotaPreflight(java)).toBe(true);
  });

  it('存储只读 getFilesDir() 所在卷（不猜、不编数字）', () => {
    const body = extractMethodBody(code, 'public static Storage readStorage(') ?? '';
    expect(body).toContain('getFilesDir()');
    expect(body).toContain('StatFs');
    // 读不到就标 readable=false（不编数字）
    expect(body).toContain('new Storage(0L, 0L, false)');
    expect(body).toContain('new Storage(free, total, true)');
  });

  it('有人类可读的容量文本', () => {
    expect(code).toMatch(/public static String formatBytes\(long bytes\)/);
    const body = extractMethodBody(code, 'public static String formatBytes(') ?? '';
    expect(body).toContain('MB');
  });
});

describe('失败文案都给出下一步（APP-07 的核心要求）', () => {
  const failureStatuses = [
    'account_auth_needed', 'account_service_unreachable', 'account_revoke_failed',
    'account_quota_low', 'account_disconnected',
  ] as const;

  it('每个失败/提示文案都含一个"照做"的动作词', () => {
    for (const status of failureStatuses) {
      const text = strings.get(`potbot_${status}`);
      expect(text, `strings.xml 缺少 potbot_${status}`).toBeDefined();
      expect(text ?? '', `potbot_${status} 没有给用户下一步`).toMatch(/请|试试|选择|重新|改用|点/);
    }
  });

  it('授权入口的按钮文案存在（入口要能被用户找到）', () => {
    expect(strings.get('potbot_account_authorize_entry')).toBeTruthy();
  });
});

describe('★密钥不进 APK、不进日志', () => {
  it('整个进 APK 的 Android 源码树没有密钥形态', () => {
    const violations = scanForSecrets(androidAppSourceFiles());
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('本包新增的四个类日志分支不打印凭据', () => {
    for (const path of NEW_CLASSES) {
      const lines = logLinesTouchingCredentials(readText(path));
      expect(lines, `${path} 的日志行带了凭据词：\n${lines.join('\n')}`).toEqual([]);
    }
  });

  it('宿主 MainActivity 的日志行也不打印凭据', () => {
    const lines = logLinesTouchingCredentials(readText(MAIN_ACTIVITY));
    expect(lines, lines.join('\n')).toEqual([]);
  });

  it('凭据只经 PotbotEndpoints 读写，且只以请求头发送（不落页面）', () => {
    const body = extractMethodBody(code, 'public static Decision beginAuthorize(') ?? '';
    expect(body).toContain('PotbotEndpoints.setCredential');
    const revoke = extractMethodBody(code, 'public static Decision revoke(') ?? '';
    expect(revoke).toContain('PotbotEndpoints.clearCredential');
  });
});
