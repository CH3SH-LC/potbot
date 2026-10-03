/**
 * F09 验收：设置页屏幕装配 + 原生端口绑定（integration slice F-I13）。
 *
 * 覆盖三块：
 *   1. `buildSettingsScreenView` —— 六个分区齐全、顺序固定、横幅诚实、行触区单一来源；
 *   2. `createKernelKeyImporter` / `createKernelConnectionTester` / `bindSettingsPorts` ——
 *      两个端口经 `KernelClient` 结构面（`SettingsNativeCalls`）转发，不 import 原生桥；
 *   3. 契约校验器**实跑**：产出的命令能被 `contracts/mobile-v1/validate.mjs` 接受，
 *      且一条缺锚点的 `inspect` 命令必须 FAIL（反向对照，证明校验器不是空转）。
 *
 * 反向对照（必须变红才说明闸门不是空壳）：
 *   - `succeeded` 但 `resultRef` 非 `keyref:` ⇒ `invalid-result`；
 *   - `KernelClient` 关闭 ⇒ 导入报 `client-closed`、探测抛错；
 *   - 探测缺 `resultRef` / probe 非法 / host 带 scheme ⇒ 抛错；
 *   - 失败文案里的 Bearer 令牌展示前必须脱敏。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PORT_BINDINGS,
  SETTINGS_COMMAND_OPERATIONS,
  SETTINGS_SECTION_ORDER,
  bindSettingsPorts,
  buildConnectionProbeCommand,
  buildKeyImportCommand,
  buildSettingsScreenView,
  buildStubStatusBanner,
  computeBudgetUsage,
  createKernelConnectionTester,
  createKernelKeyImporter,
  createKeyRegistry,
  createPermissionRegistry,
  describeNotifications,
  describeStorageUsage,
  deriveConnectionView,
  exportDiagnostics,
  importKeyFromNative,
  isKeyRef,
  settingsScreenToViewNode,
  testConnection,
  type KeyImportIntent,
  type NativeImportResult,
  type NativeKeyImporter,
  type SettingsNativeCalls,
  type SettingsNativeReceipt,
  type SettingsPortBinding,
  type SettingsProbeAnchor,
} from '../../../apps/mobile-ui/src/settings/index.js';
import type { Command } from '../../../contracts/mobile-v1/types.js';
import type { KernelClient } from '../../../apps/mobile-ui/src/platform/index.js';
import { renderHtml, validateViewNode } from '../../../apps/mobile-ui/src/render/index.js';
import { getControl } from '../../../apps/mobile-ui/src/foundation/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const VALIDATOR = join(REPO_ROOT, 'contracts', 'mobile-v1', 'validate.mjs');

const NOW = '2026-10-03T10:00:00Z';

// 明显伪造的哨兵值，不是任何真实凭据/号码。
const FAKE_KEY = 'sk-FAKE-not-a-real-credential-000000';
const FAKE_BEARER = 'Bearer FAKE-not-real-credential-0000';

const SOURCE = 'content://com.android.providers.downloads/import/42';
const TOKEN = 'onetoken:demo-import-0001';
const INTENT: KeyImportIntent = {
  provider: 'deepseek',
  nativeSource: SOURCE,
  oneTimeToken: TOKEN,
  requestedModel: 'deepseek-flash',
};
const ANCHOR: SettingsProbeAnchor = { conversationId: 'conv-1' };
const PROBE = {
  state: 'connected',
  host: 'api.deepseek.com',
  model: 'deepseek-flash',
  checkedAt: NOW,
  verificationMode: 'real',
  failure: null,
} as const;

// ---------------------------------------------------------------------------
// 编译期：真实 KernelClient 结构满足设置页的原生调用面（不 import 桥 / 具体实现）。
// ---------------------------------------------------------------------------

const kernelClientSatisfiesSettingsCalls = (client: KernelClient): SettingsNativeCalls => client;
void kernelClientSatisfiesSettingsCalls;

// ---------------------------------------------------------------------------
// 假的原生调用面（捕获命令 + 返回受控回执）
// ---------------------------------------------------------------------------

type ReceiptFactory = (command: Command) => SettingsNativeReceipt | Promise<SettingsNativeReceipt>;

function makeCalls(
  receipt: SettingsNativeReceipt | ReceiptFactory,
  state: 'open' | 'closed' = 'open',
): { calls: SettingsNativeCalls; captured: Command[] } {
  const captured: Command[] = [];
  return {
    captured,
    calls: {
      state,
      async sendCommand(command: Command): Promise<SettingsNativeReceipt> {
        captured.push(command);
        return typeof receipt === 'function' ? await receipt(command) : receipt;
      },
    },
  };
}

function succeededReceipt(
  resultRef: string | null,
  options: { readonly metadata?: Record<string, unknown>; readonly verificationMode?: 'fixture' | 'real' } = {},
): SettingsNativeReceipt {
  const metadata = options.metadata;
  return {
    status: 'succeeded',
    resultRef,
    error: null,
    verificationMode: options.verificationMode ?? 'real',
    event: {
      eventId: 'evt-1',
      seq: 1,
      commandId: 'cmd-1',
      revision: 0,
      status: 'succeeded',
      ...(resultRef === null ? {} : { resultRef }),
      ...(metadata === undefined ? {} : { metadata }),
      verificationMode: options.verificationMode ?? 'real',
    },
  };
}

function failedReceipt(code: string, message: string, retryable = false): SettingsNativeReceipt {
  return {
    status: 'failed',
    resultRef: null,
    error: { code, message, retryable },
    verificationMode: 'fixture',
    event: { eventId: 'evt-1', seq: 1, commandId: 'cmd-1', revision: 0, status: 'failed' },
  };
}

const OK_IMPORTER: NativeKeyImporter = {
  importFromNative: (): NativeImportResult => ({
    ok: true,
    keyRef: 'keyref:deepseek-app-primary',
    importedAt: NOW,
    verificationMode: 'real',
  }),
};

// ---------------------------------------------------------------------------
// 屏幕装配输入
// ---------------------------------------------------------------------------

async function buildScreenFixture() {
  const keyRegistry = createKeyRegistry(OK_IMPORTER);
  await keyRegistry.importKey(INTENT);

  const permissions = createPermissionRegistry([
    { permission: 'network' },
    { permission: 'model' },
    { permission: 'device' },
  ]);
  permissions.grant('network', NOW, '主对话网络');
  permissions.deny('device', NOW);

  const connection = deriveConnectionView(
    {
      state: 'disconnected',
      host: 'api.deepseek.com',
      model: 'deepseek-flash',
      checkedAt: NOW,
      verificationMode: 'fixture',
      failure: { code: 'auth', message: `握手失败：Authorization: ${FAKE_BEARER}`, retryable: true },
    },
    { grantedPermissions: ['network'], keyUsable: true },
  );

  const budget = computeBudgetUsage({
    maxTokens: 1000,
    usedTokens: 200,
    maxCostMicros: null,
    usedCostMicros: 0,
    timeoutMs: null,
    verificationMode: 'fixture',
  });
  const storage = describeStorageUsage({
    measured: false,
    usedBytes: null,
    quotaBytes: null,
    cacheBytes: null,
    downloadsBytes: null,
    retentionDays: 7,
    verificationMode: 'fixture',
  });
  const notifications = describeNotifications({
    progress: true,
    reminders: true,
    reminderPermission: 'not-requested',
    backgroundRestricted: true,
    backgroundReason: `系统限制后台，原始头 Authorization: ${FAKE_BEARER}`,
    systemSettingsEntry: 'settings://app/notifications',
  });
  const diagnostics = exportDiagnostics({
    generatedAt: NOW,
    verificationMode: 'fixture',
    appVersion: '0.0.0-test',
    sections: { note: '干净说明', header: `Authorization: ${FAKE_BEARER}` },
  });

  return {
    keys: keyRegistry.snapshot(),
    connection,
    permissions: permissions.snapshot(),
    capabilities: [
      permissions.isCapabilityAllowed('model-call'),
      permissions.isCapabilityAllowed('device-info'),
    ],
    budget,
    storage,
    notifications,
    diagnostics,
  };
}

// ---------------------------------------------------------------------------
// 契约校验器
// ---------------------------------------------------------------------------

function runValidator(fixturesDir: string): { status: number; stdout: string } {
  try {
    const stdout = execFileSync(process.execPath, [VALIDATOR, fixturesDir], { encoding: 'utf8', stdio: 'pipe' });
    return { status: 0, stdout };
  } catch (error) {
    const err = error as { status?: number; stdout?: string };
    return { status: err.status ?? -1, stdout: err.stdout ?? '' };
  }
}

function withTempFixtures(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'f09-screen-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeCommandFixture(dir: string, name: string, value: unknown): void {
  writeFileSync(
    join(dir, name),
    JSON.stringify({ $schemaRef: 'schemas/command.schema.json', note: name, value }, null, 2),
    'utf8',
  );
}

// ===========================================================================
// 1. 屏幕装配
// ===========================================================================

describe('F09 / 设置页屏幕装配（S1 / S2 / S3）', () => {
  it('六个分区齐全且顺序固定', async () => {
    const model = buildSettingsScreenView(await buildScreenFixture());
    expect(model.screen).toBe('M01');
    expect(model.route).toBe('me');
    expect(model.sections.map((section) => section.id)).toEqual([...SETTINGS_SECTION_ORDER]);
    expect(model.sections.map((section) => section.title)).toEqual([
      '模型密钥',
      '连接',
      '权限',
      '额度与存储',
      '通知与后台',
      '应用信息与诊断',
    ]);
  });

  it('行触区取自 foundation list-row 规格（单一来源，不写死 48）', async () => {
    const model = buildSettingsScreenView(await buildScreenFixture());
    const expected = getControl('list-row').minTouchDp;
    expect(expected).toBeGreaterThanOrEqual(48);
    for (const section of model.sections) {
      expect(section.rows.length).toBeGreaterThan(0);
      for (const row of section.rows) expect(row.minTouchDp).toBe(expected);
    }
  });

  it('密钥分区只展示引用与状态（无明文）', async () => {
    const model = buildSettingsScreenView(await buildScreenFixture());
    const keySection = model.sections.find((section) => section.id === 'key');
    expect(keySection?.rows[0]?.value).toBe('已导入');
    expect(keySection?.rows[0]?.id).toBe('key.keyref:deepseek-app-primary');
    expect(JSON.stringify(model)).not.toContain(FAKE_KEY);
  });

  it('空密钥 → 明确「未导入」占位行，不编造', () => {
    return buildScreenFixture().then((fixture) => {
      const model = buildSettingsScreenView({ ...fixture, keys: [] });
      const keySection = model.sections.find((section) => section.id === 'key');
      expect(keySection?.rows[0]?.id).toBe('key.none');
      expect(keySection?.rows[0]?.value).toBe('未导入');
      expect(keySection?.rows[0]?.tone).toBe('warn');
    });
  });

  it('连接失败行展示前已脱敏（Bearer 令牌不出现在屏幕模型里）', async () => {
    const model = buildSettingsScreenView(await buildScreenFixture());
    const connectionSection = model.sections.find((section) => section.id === 'connection');
    expect(connectionSection?.rows.some((row) => row.id === 'connection.failure')).toBe(true);
    const failureRow = connectionSection?.rows.find((row) => row.id === 'connection.failure');
    expect(failureRow?.detail).toContain('已脱敏');
    expect(JSON.stringify(model)).not.toContain(FAKE_BEARER);
    expect(JSON.stringify(model)).not.toContain('FAKE-not-real-credential-0000');
  });

  it('权限分区用 recoveryHint 给出恢复入口', async () => {
    const model = buildSettingsScreenView(await buildScreenFixture());
    const permissionSection = model.sections.find((section) => section.id === 'permissions');
    const device = permissionSection?.rows.find((row) => row.id === 'perm.device');
    expect(device?.value).toBe('已拒绝');
    expect(device?.detail).toContain('系统设置');
    // 能力判定行也进来（model-call 缺 model 权限）
    expect(permissionSection?.rows.some((row) => row.id === 'cap.model-call' && row.value === '不可用')).toBe(true);
  });

  it('额度/存储不虚报：fixture 用量与未测量存储都如实标注', async () => {
    const model = buildSettingsScreenView(await buildScreenFixture());
    const quotaSection = model.sections.find((section) => section.id === 'quota');
    expect(quotaSection?.rows.find((row) => row.id === 'quota.budget')?.value).toBe('未知（非真实用量）');
    const storageRow = quotaSection?.rows.find((row) => row.id === 'quota.storage');
    expect(storageRow?.value).toBe('未知（未测量）');
    expect(storageRow?.tone).toBe('warn');
  });

  it('通知分区：提醒权限未授权 ⇒ 提醒不可用；后台受限给脱敏原因与入口', async () => {
    const model = buildSettingsScreenView(await buildScreenFixture());
    const notifySection = model.sections.find((section) => section.id === 'notifications');
    expect(notifySection?.rows.find((row) => row.id === 'notify.summary')?.value).toBe('提醒不可用');
    const background = notifySection?.rows.find((row) => row.id === 'notify.background');
    expect(background?.detail).toContain('已脱敏');
    expect(notifySection?.rows.find((row) => row.id === 'notify.entry')?.value).toBe('settings://app/notifications');
  });

  it('诊断分区只报告脱敏统计，不 dump sections 原文', async () => {
    const model = buildSettingsScreenView(await buildScreenFixture());
    const diagSection = model.sections.find((section) => section.id === 'diagnostics');
    const exportRow = diagSection?.rows.find((row) => row.id === 'diag.export');
    expect(exportRow?.value).toBe('已脱敏');
    expect(exportRow?.detail).toContain('替换 1 处');
    expect(JSON.stringify(model)).not.toContain('干净说明');
  });

  it('S3 fixture 横幅：默认绑定可见且 tone=warning，列出两个 fixture 端口', () => {
    const banner = buildStubStatusBanner(DEFAULT_PORT_BINDINGS);
    expect(banner.visible).toBe(true);
    expect(banner.tone).toBe('warning');
    expect(banner.fixturePorts).toEqual(['connection-tester', 'key-importer']);
    expect(banner.text).toContain('密钥导入');
    expect(banner.text).toContain('连接测试');
    expect(banner.text).toContain('不计入真实证据');
  });

  it('S3 全 native 绑定 ⇒ 横幅隐藏', () => {
    const native: readonly SettingsPortBinding[] = [
      { port: 'key-importer', kind: 'native', note: '' },
      { port: 'connection-tester', kind: 'native', note: '' },
    ];
    const banner = buildStubStatusBanner(native);
    expect(banner.visible).toBe(false);
    expect(banner.fixturePorts).toEqual([]);
  });

  it('屏幕模型默认带 fixture 横幅（未显式传入绑定声明时）', async () => {
    const model = buildSettingsScreenView(await buildScreenFixture());
    expect(model.banner.visible).toBe(true);
    expect(model.banner.tone).toBe('warning');
  });

  it('投影为 ViewNode 树：结构合法且渲染包含分区标题与横幅', async () => {
    const model = buildSettingsScreenView(await buildScreenFixture());
    const node = settingsScreenToViewNode(model);
    expect(validateViewNode(node)).toEqual([]);
    expect(node.attrs?.id).toBe('settings-screen');
    const html = renderHtml(node);
    expect(html).toContain('我的 / 设置');
    expect(html).toContain('模型密钥');
    expect(html).toContain('应用信息与诊断');
    expect(html).toContain('fixture');
    expect(html).not.toContain(FAKE_BEARER);
  });
});

// ===========================================================================
// 2. 原生端口绑定（经 KernelClient 结构面）
// ===========================================================================

describe('F09 / 密钥导入端口经 KernelClient 转发（S4 / S5）', () => {
  it('导入命令是合法 v1 import，载荷只带来源/令牌引用，不含明文', async () => {
    const { calls, captured } = makeCalls(
      succeededReceipt('keyref:deepseek-app-primary', { metadata: { importedAt: NOW } }),
    );
    const importer = createKernelKeyImporter(calls);
    const out = await importer.importFromNative(INTENT);

    expect(captured).toHaveLength(1);
    const command = captured[0]!;
    expect(command.schemaVersion).toBe('mobile-v1');
    expect(command.operation).toBe('import');
    const args = (command.payload as { args?: Record<string, unknown> }).args;
    expect(args).toEqual({
      provider: 'deepseek',
      nativeSource: SOURCE,
      oneTimeToken: TOKEN,
      requestedModel: 'deepseek-flash',
    });
    expect(JSON.stringify(command)).not.toContain('sk-');

    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.keyRef).toBe('keyref:deepseek-app-primary');
      expect(out.importedAt).toBe(NOW);
      expect(out.verificationMode).toBe('real');
    }
  });

  it('rotated 元数据映射为 rotated', async () => {
    const { calls } = makeCalls(
      succeededReceipt('keyref:deepseek-app-primary', { metadata: { importedAt: NOW, rotated: true } }),
    );
    const out = await createKernelKeyImporter(calls).importFromNative(INTENT);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.rotated).toBe(true);
  });

  it('反向对照：succeeded 但 keyRef 非法 ⇒ invalid-result，不回显明文', async () => {
    const { calls } = makeCalls(succeededReceipt(FAKE_KEY, { metadata: { importedAt: NOW } }));
    const out = await createKernelKeyImporter(calls).importFromNative(INTENT);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe('invalid-result');
      expect(JSON.stringify(out)).not.toContain(FAKE_KEY);
    }
  });

  it('反向对照：succeeded 但缺 importedAt ⇒ invalid-result', async () => {
    const { calls } = makeCalls(succeededReceipt('keyref:deepseek-app-primary'));
    const out = await createKernelKeyImporter(calls).importFromNative(INTENT);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('invalid-result');
  });

  it('内核失败回执映射为 error.code + retryable', async () => {
    const { calls } = makeCalls(failedReceipt('uri-permission-denied', 'URI 权限被拒', true));
    const out = await createKernelKeyImporter(calls).importFromNative(INTENT);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe('uri-permission-denied');
      expect(out.retryable).toBe(true);
    }
  });

  it('succeeded 缺 resultRef ⇒ invalid-result（绝不当作成功）', async () => {
    const { calls } = makeCalls(succeededReceipt(null, { metadata: { importedAt: NOW } }));
    const out = await createKernelKeyImporter(calls).importFromNative(INTENT);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('invalid-result');
  });

  it('反向对照：意图含明文 ⇒ plaintext-not-accepted（适配层再拦一次，不发命令）', async () => {
    const { calls, captured } = makeCalls(succeededReceipt('keyref:deepseek-app-primary', { metadata: { importedAt: NOW } }));
    const bad = { ...INTENT, plaintext: FAKE_KEY } as unknown as KeyImportIntent;
    const out = await createKernelKeyImporter(calls).importFromNative(bad);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('plaintext-not-accepted');
    expect(captured).toHaveLength(0);
  });

  it('反向对照：调用面关闭 ⇒ client-closed，不发命令', async () => {
    const { calls, captured } = makeCalls(succeededReceipt('keyref:x', { metadata: { importedAt: NOW } }), 'closed');
    const out = await createKernelKeyImporter(calls).importFromNative(INTENT);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe('client-closed');
      expect(out.retryable).toBe(true);
    }
    expect(captured).toHaveLength(0);
  });

  it('端到端：绑定后的导入器可驱动 createKeyRegistry（实时可用/撤销）', async () => {
    const { calls } = makeCalls(
      succeededReceipt('keyref:deepseek-app-primary', { metadata: { importedAt: NOW }, verificationMode: 'real' }),
    );
    const registry = createKeyRegistry(createKernelKeyImporter(calls));
    const imported = await registry.importKey(INTENT);
    expect(imported.ok).toBe(true);
    expect(registry.hasUsableKey('deepseek')).toBe(true);
    expect(isKeyRef('keyref:deepseek-app-primary')).toBe(true);
  });

  it('端到端：importKeyFromNative 经绑定导入器得到 keyRef', async () => {
    const { calls } = makeCalls(succeededReceipt('keyref:deepseek-app-primary', { metadata: { importedAt: NOW } }));
    const out = await importKeyFromNative(createKernelKeyImporter(calls), INTENT);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.keyRef).toBe('keyref:deepseek-app-primary');
  });
});

describe('F09 / 连接测试端口经 KernelClient 转发（S4 / S5）', () => {
  const probe = {
    state: 'connected',
    host: 'api.deepseek.com',
    model: 'deepseek-flash',
    checkedAt: NOW,
    verificationMode: 'real',
    failure: null,
  };

  it('inspect 命令带契约要求的会话锚点', async () => {
    const { calls, captured } = makeCalls(succeededReceipt('probe:1', { metadata: { probe } }));
    await createKernelConnectionTester(calls, { anchor: ANCHOR }).test();
    const command = captured[0]!;
    expect(command.operation).toBe('inspect');
    const payload = command.payload as { conversationId?: string; filters?: Record<string, unknown> };
    expect(payload.conversationId).toBe('conv-1');
    expect(payload.filters).toEqual({ probe: 'connection' });
  });

  it('succeeded 的 probe 直接可用于 testConnection 推导视图', async () => {
    const { calls } = makeCalls(succeededReceipt('probe:1', { metadata: { probe } }));
    const tester = createKernelConnectionTester(calls, { anchor: ANCHOR });
    const view = await testConnection(tester, { grantedPermissions: ['network', 'model'], keyUsable: true }, NOW);
    expect(view.state).toBe('connected');
    expect(view.host).toBe('api.deepseek.com');
  });

  it('反向对照：非 succeeded ⇒ 抛错，绝不伪造连接', async () => {
    const { calls } = makeCalls(failedReceipt('probe-timeout', '超时', true));
    const tester = createKernelConnectionTester(calls, { anchor: ANCHOR });
    await expect(tester.test()).rejects.toThrowError(/未取得结果/);
  });

  it('反向对照：succeeded 但缺 resultRef ⇒ 抛错', async () => {
    const { calls } = makeCalls(succeededReceipt(null, { metadata: { probe } }));
    await expect(createKernelConnectionTester(calls, { anchor: ANCHOR }).test()).rejects.toThrowError(/未取得结果/);
  });

  it('反向对照：probe.host 带 scheme ⇒ 抛 invalid-source', async () => {
    const { calls } = makeCalls(
      succeededReceipt('probe:1', { metadata: { probe: { ...probe, host: 'https://api.deepseek.com' } } }),
    );
    await expect(createKernelConnectionTester(calls, { anchor: ANCHOR }).test()).rejects.toThrowError(/host/);
  });

  it('反向对照：缺少 probe 对象 ⇒ 抛错', async () => {
    const { calls } = makeCalls(succeededReceipt('probe:1', { metadata: {} }));
    await expect(createKernelConnectionTester(calls, { anchor: ANCHOR }).test()).rejects.toThrowError(/probe/);
  });

  it('反向对照：失败文案里的 Bearer 令牌被脱敏后才抛出', async () => {
    const { calls } = makeCalls(failedReceipt('auth', `认证失败 Authorization: ${FAKE_BEARER}`, false));
    const tester = createKernelConnectionTester(calls, { anchor: ANCHOR });
    await expect(Promise.resolve(tester.test())).rejects.toThrowError(/未取得结果/);
    let thrown = '';
    try {
      await Promise.resolve(tester.test());
    } catch (error) {
      thrown = String(error);
    }
    expect(thrown).not.toContain('FAKE-not-real-credential-0000');
    expect(thrown).toContain('[redacted:auth-header]');
  });

  it('反向对照：调用面关闭 ⇒ 抛错', async () => {
    const { calls } = makeCalls(succeededReceipt('probe:1', { metadata: { probe } }), 'closed');
    await expect(createKernelConnectionTester(calls, { anchor: ANCHOR }).test()).rejects.toThrowError(/关闭/);
  });
});

describe('F09 / 一站式端口绑定声明诚实', () => {
  it('bindSettingsPorts 默认把两个端口都标 fixture', () => {
    const { calls } = makeCalls(succeededReceipt('keyref:x', { metadata: { importedAt: NOW } }));
    const bound = bindSettingsPorts(calls, { anchor: ANCHOR });
    expect(bound.bindings.map((binding) => binding.port).sort()).toEqual(['connection-tester', 'key-importer']);
    expect(bound.bindings.every((binding) => binding.kind === 'fixture')).toBe(true);
    expect(buildStubStatusBanner(bound.bindings).visible).toBe(true);
  });

  it('显式 native 绑定 ⇒ 横幅隐藏', () => {
    const { calls } = makeCalls(succeededReceipt('keyref:x', { metadata: { importedAt: NOW } }));
    const bound = bindSettingsPorts(calls, { anchor: ANCHOR, bindingKind: 'native' });
    expect(bound.bindings.every((binding) => binding.kind === 'native')).toBe(true);
    expect(buildStubStatusBanner(bound.bindings).visible).toBe(false);
  });

  it('SETTINGS_COMMAND_OPERATIONS 与构造出的操作一致', () => {
    expect(SETTINGS_COMMAND_OPERATIONS['key-importer']).toBe('import');
    expect(SETTINGS_COMMAND_OPERATIONS['connection-tester']).toBe('inspect');
    expect(buildKeyImportCommand(INTENT, 'c', 'i').operation).toBe('import');
    expect(buildConnectionProbeCommand(ANCHOR, 'c', 'i').operation).toBe('inspect');
  });
});

// ===========================================================================
// 3. 契约校验器实跑
// ===========================================================================

describe('F09 / 设置命令契约校验器实跑', () => {
  it('导入命令与探测命令都能通过 command.schema.json', async () => {
    const keyCalls = makeCalls(
      succeededReceipt('keyref:deepseek-app-primary', { metadata: { importedAt: NOW } }),
    );
    const keyOut = await createKernelKeyImporter(keyCalls.calls).importFromNative(INTENT);
    expect(keyOut.ok).toBe(true);

    const probeCalls = makeCalls(succeededReceipt('probe:1', { metadata: { probe: PROBE } }));
    const probe = await createKernelConnectionTester(probeCalls.calls, { anchor: ANCHOR }).test();
    expect(probe.host).toBe('api.deepseek.com');

    withTempFixtures((dir) => {
      writeCommandFixture(dir, 'command-import.json', keyCalls.captured[0]);
      writeCommandFixture(dir, 'command-inspect.json', probeCalls.captured[0]);
      const result = runValidator(dir);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('0 FAIL');
    });
  });

  it('反向对照：缺锚点的 inspect 命令必须 FAIL', () => {
    const bad: Command = {
      schemaVersion: 'mobile-v1',
      commandId: 'cmd-bad',
      operation: 'inspect',
      idempotencyKey: 'idem-bad',
      payload: { filters: { probe: 'connection' } },
    };
    withTempFixtures((dir) => {
      writeCommandFixture(dir, 'bad-inspect.json', bad);
      const result = runValidator(dir);
      expect(result.status).not.toBe(0);
    });
  });
});
