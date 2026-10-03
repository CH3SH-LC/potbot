/**
 * F09 验收：密钥状态与**原生导入路径**（I1 / I2 / I3）。
 *
 * 反向对照（必须变红才说明闸门不是空壳）：
 *   - 没有原生端口 ⇒ 拒绝（不得退回网页收明文）；
 *   - 意图带 `plaintext` 字段 / `sk-...` 值 ⇒ 拒绝，且报错**只给路径不给值**；
 *   - 端口返回明文 keyRef ⇒ 拒绝（`invalid-result`）；
 *   - 撤销后 `statusOf`/`hasUsableKey` **立即**改变。
 */

import { describe, expect, it } from 'vitest';

import {
  createKeyRegistry,
  describeKey,
  findPlaintext,
  importKeyFromNative,
  isKeyUsable,
  isKeyRef,
  isValidSource,
  isValidToken,
  type KeyImportIntent,
  type NativeImportResult,
  type NativeKeyImporter,
  type OneTimeToken,
  type NativeSource,
} from '../../../apps/mobile-ui/src/settings/index.js';

const NOW = '2026-10-03T10:00:00Z';

// 明显是伪造的哨兵值，不是任何真实凭据。
const FAKE_KEY = 'sk-FAKE-not-a-real-credential-000000';

const SOURCE: NativeSource = 'content://com.android.providers.downloads/import/42';
const TOKEN: OneTimeToken = 'onetoken:demo-import-0001';

function makeImporter(result: NativeImportResult): NativeKeyImporter {
  return { importFromNative: () => result };
}

const OK_RESULT: NativeImportResult = {
  ok: true,
  keyRef: 'keyref:deepseek-app-primary',
  importedAt: NOW,
  verificationMode: 'real',
};

function intent(overrides: Partial<KeyImportIntent> = {}): KeyImportIntent {
  return { provider: 'deepseek', nativeSource: SOURCE, oneTimeToken: TOKEN, ...overrides };
}

describe('F09 / 明文探测器只报告路径，不回显值', () => {
  it('字段名命中被报告', () => {
    const findings = findPlaintext({ provider: 'deepseek', apiKey: 'anything' });
    expect(findings.map((f) => f.path)).toContain('apiKey');
    expect(findings[0]?.kind).toBe('field-name');
  });

  it('值形状命中被报告', () => {
    const findings = findPlaintext({ note: `Bearer ${FAKE_KEY}` });
    expect(findings.length).toBe(1);
    expect(findings[0]?.kind).toBe('value-shape');
  });

  it('反向对照：报告里绝不包含明文值本身', () => {
    const findings = findPlaintext({ token: FAKE_KEY });
    expect(JSON.stringify(findings)).not.toContain(FAKE_KEY);
  });

  it('干净输入无命中', () => {
    expect(findPlaintext({ provider: 'deepseek', host: 'api.deepseek.com' })).toEqual([]);
  });
});

describe('F09 / 导入闸门（I2）', () => {
  it('反向对照：没有原生端口 ⇒ native-importer-required', async () => {
    const out = await importKeyFromNative(null, intent());
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('native-importer-required');
  });

  it('反向对照：意图带 plaintext 字段 ⇒ plaintext-not-accepted', async () => {
    const bad = { ...intent(), plaintext: FAKE_KEY } as unknown as KeyImportIntent;
    const out = await importKeyFromNative(makeImporter(OK_RESULT), bad);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe('plaintext-not-accepted');
      // 报错只给字段路径，不得回显明文。
      expect(out.detail).not.toContain(FAKE_KEY);
    }
  });

  it('反向对照：意图把 sk-... 塞进 oneTimeToken ⇒ plaintext-not-accepted', async () => {
    const bad = { ...intent(), oneTimeToken: FAKE_KEY } as unknown as KeyImportIntent;
    const out = await importKeyFromNative(makeImporter(OK_RESULT), bad);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('plaintext-not-accepted');
  });

  it('来源必须是 content:// / app://', async () => {
    expect(isValidSource('C:\\Users\\x\\ds.txt')).toBe(false);
    expect(isValidSource('https://evil.example/key')).toBe(false);
    expect(isValidSource(SOURCE)).toBe(true);
    const out = await importKeyFromNative(makeImporter(OK_RESULT), intent({ nativeSource: 'file:///tmp/x' as NativeSource }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('invalid-source');
  });

  it('一次性令牌必须是引用前缀', async () => {
    expect(isValidToken('onetoken:abc')).toBe(true);
    expect(isValidToken('grant:abc')).toBe(true);
    expect(isValidToken('deadbeef')).toBe(false);
    const out = await importKeyFromNative(makeImporter(OK_RESULT), intent({ oneTimeToken: 'nope' as OneTimeToken }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('invalid-token');
  });

  it('端口失败 ⇒ native-import-failed', async () => {
    const out = await importKeyFromNative(makeImporter({ ok: false, reason: 'uri-permission-denied', retryable: true }), intent());
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe('native-import-failed');
      expect(out.detail).toContain('uri-permission-denied');
    }
  });

  it('反向对照：端口返回明文 keyRef ⇒ invalid-result', async () => {
    const out = await importKeyFromNative(
      makeImporter({ ok: true, keyRef: FAKE_KEY, importedAt: NOW, verificationMode: 'real' }),
      intent(),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('invalid-result');
  });

  it('成功路径只产出 keyRef 与状态，无明文', async () => {
    const out = await importKeyFromNative(makeImporter(OK_RESULT), intent());
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.keyRef).toBe('keyref:deepseek-app-primary');
      expect(out.status).toBe('present');
      expect(JSON.stringify(out)).not.toContain('sk-');
    }
  });
});

describe('F09 / 密钥注册表与实时撤权（I3）', () => {
  it('导入后可用；撤销后立即不可用', async () => {
    const registry = createKeyRegistry(makeImporter(OK_RESULT));
    const imported = await registry.importKey(intent());
    expect(imported.ok).toBe(true);
    expect(registry.hasUsableKey('deepseek')).toBe(true);

    const revoked = registry.revoke('keyref:deepseek-app-primary', NOW);
    expect(revoked.status).toBe('revoked');
    expect(revoked.usable).toBe(false);
    // 无延迟：同一次调用后立即反映。
    expect(registry.statusOf('keyref:deepseek-app-primary')?.usable).toBe(false);
    expect(registry.hasUsableKey('deepseek')).toBe(false);
  });

  it('重复导入同一 keyRef ⇒ rotated', async () => {
    const registry = createKeyRegistry(makeImporter(OK_RESULT));
    await registry.importKey(intent());
    const second = await registry.importKey(intent());
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.status).toBe('rotated');
    expect(registry.statusOf('keyref:deepseek-app-primary')?.status).toBe('rotated');
  });

  it('撤销未知 keyRef 抛 unknown-key-ref', () => {
    const registry = createKeyRegistry(makeImporter(OK_RESULT));
    expect(() => registry.revoke('keyref:nope', NOW)).toThrowError(/未知的 keyRef/);
  });

  it('isKeyUsable / describeKey 只输出状态文案，不含明文', () => {
    expect(isKeyUsable('present')).toBe(true);
    expect(isKeyUsable('rotated')).toBe(true);
    expect(isKeyUsable('absent')).toBe(false);
    expect(isKeyUsable('revoked')).toBe(false);
    const line = describeKey({
      keyRef: 'keyref:deepseek-app-primary',
      provider: 'deepseek',
      status: 'present',
      updatedAt: NOW,
      verificationMode: 'real',
      model: 'deepseek-flash',
      usable: true,
    });
    expect(line).toContain('deepseek-flash');
    expect(isKeyRef('keyref:deepseek-app-primary')).toBe(true);
    expect(isKeyRef(FAKE_KEY)).toBe(false);
  });
});
