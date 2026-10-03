/**
 * F08 / 内核适配层（F-I14）：`recordProbe` ↔ K06 探针事件流的接线，以及 KernelClient 模板命令构造器。
 *
 * 本文件**不 mock** 内核：探针路径直接跑**真实** K06 `createTemplateLifecycle(...).reportReadiness()`
 * 与**真实** K-I04 宿主模块 `createTemplatesModule(...).handle()`，把它们的真实产物喂进适配层；
 * 命令路径把构造出的 `Command` 交给**真实**冻结合约校验器 `contracts/mobile-v1/validate.mjs` 实跑。
 *
 * 反向对照（判据不是空壳）：
 *   - K06 报告缺任一态、或出现合并字段 `ready` ⇒ 适配层必须抛错；
 *   - 探针事件 resultRef 缺四态之一 / 取值非法 ⇒ 必须抛错；
 *   - 命令缺 `expectedRevision` / operation 非法 ⇒ `assertTemplateCommand` 必须抛错。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  applyProbeResultRef,
  applyReadinessReport,
  applyUpdate,
  assertFourStatesReported,
  assertTemplateCommand,
  authorizeTemplate,
  buildAuthorizeTemplateCommand,
  buildEnableTemplateCommand,
  buildInstallTemplateCommand,
  buildProbeTemplateCommand,
  buildUninstallTemplateCommand,
  buildUpdateTemplateCommand,
  catalogRows,
  createTemplatesState,
  enableTemplate,
  getTemplate,
  installTemplate,
  parseProbeResultRef,
  probeInputFromReadiness,
  readinessVerdicts,
  TEMPLATE_COMMAND_MAP,
  toF08TemplateId,
  toKernelTemplateId,
  type KernelReadinessReport,
  type TemplateCommandContext,
} from '../../../apps/mobile-ui/src/templates/index.js';
import {
  createManualClock,
  createTemplateLifecycle,
  type HostPlatform,
  type ProbeOutcome,
  type TemplateLifecycle,
  type TemplateManifest,
  type TemplateProbePort,
} from '../../../apps/mobile-kernel/templates/index.js';
import { createTemplatesModule } from '../../../apps/mobile-kernel/host/templates-module.js';
import type { BootstrapModule, Command, OperationContext } from '../../../apps/mobile-kernel/bootstrap/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const VALIDATOR = join(REPO_ROOT, 'contracts', 'mobile-v1', 'validate.mjs');
const COMMAND_SCHEMA_REF = 'schemas/command.schema.json';

// ---------------------------------------------------------------------------
// 装配真实 K06 生命周期 / K-I04 宿主模块（无 mock）
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000;

/** 标准 manifest：内核 id 空间（`meituan`，非 `template.meituan`）。 */
function manifest(): TemplateManifest {
  return {
    id: 'meituan',
    displayName: '美团下单模板',
    version: '1.0.0',
    capabilities: ['order.place', 'order.read'],
    schemas: ['external-receipt.schema.json'],
    permissions: ['network', 'external-order'],
    runtimeCompatibility: { os: 'android', minimumOs: 26, runtimes: ['quickjs'], abis: ['arm64-v8a'] },
    migration: { from: '', to: '1.0.0', strategy: 'none', reversible: true },
    probe: {
      installed: false,
      enabled: false,
      authorized: false,
      portReady: false,
      verificationMode: 'fixture',
      layers: ['unit', 'contract'],
    },
  };
}

type ProbeKind = 'installed' | 'enabled' | 'authorized' | 'ports';

function probePort(overrides: Partial<Record<ProbeKind, ProbeOutcome>> = {}): TemplateProbePort {
  const outcomes: Record<ProbeKind, ProbeOutcome> = {
    installed: { ok: true, evidenceRef: 'evidence://probe/installed' },
    enabled: { ok: true, evidenceRef: 'evidence://probe/enabled' },
    authorized: { ok: true, evidenceRef: 'evidence://probe/authorized' },
    ports: { ok: true, evidenceRef: 'evidence://probe/ports' },
    ...overrides,
  };
  return {
    identity: 'f08.adapter.fixture.probe',
    probeInstalled: () => outcomes.installed,
    probeEnabled: () => outcomes.enabled,
    probeAuthorized: () => outcomes.authorized,
    probePorts: () => outcomes.ports,
  };
}

function host(overrides: Partial<HostPlatform> = {}): HostPlatform {
  return {
    os: 'android',
    apiLevel: 34,
    runtimes: ['quickjs'],
    abis: ['arm64-v8a'],
    capabilities: ['order.place', 'order.read'],
    ...overrides,
  };
}

/** 装好 + 启用 + 授权的 1.0.0 美团，供 reportReadiness / 宿主 readiness 用。 */
function preparedLifecycle(probeOverrides: Partial<Record<ProbeKind, ProbeOutcome>> = {}): TemplateLifecycle {
  const lifecycle = createTemplateLifecycle({
    clock: createManualClock(T0),
    host: host(),
    probe: probePort(probeOverrides),
  });
  lifecycle.install(manifest());
  lifecycle.enable('meituan');
  lifecycle.authorize('meituan', undefined, ['network', 'external-order']);
  return lifecycle;
}

/** F08 侧：已安装但未授权 / 未启用的美团（状态由适配层只改 portReady）。 */
function f08StateWithMeituan() {
  return installTemplate(createTemplatesState(), 'template.meituan', '1.0.0');
}

function rowOf(state: ReturnType<typeof createTemplatesState>, id: string) {
  const row = catalogRows(state).find((candidate) => candidate.id === id);
  if (row === undefined) throw new Error(`目录行缺失：${id}`);
  return row;
}

const CTX: TemplateCommandContext = {
  commandId: 'cmd-template-0001',
  idempotencyKey: 'idem-template-0001',
  conversationId: 'conv-0001',
};

/** 直接驱动宿主模块处理器（K01 运行期才组装 ctx；这里给确定性最小 ctx）。 */
function invokeModule(module: BootstrapModule, command: Command) {
  const context: OperationContext = {
    command,
    signal: new AbortController().signal,
    now: new Date(T0).toISOString(),
    emit: () => {},
  };
  return module.handle(command, context);
}

// ---------------------------------------------------------------------------
// A4：id 空间桥接
// ---------------------------------------------------------------------------

describe('F08 / 内核适配：模板 id 空间桥接', () => {
  it('内核 id 补 `template.` 前缀；F08 id 去前缀；幂等', () => {
    expect(toF08TemplateId('meituan')).toBe('template.meituan');
    expect(toF08TemplateId('template.meituan')).toBe('template.meituan');
    expect(toKernelTemplateId('template.document')).toBe('document');
    expect(toKernelTemplateId('document')).toBe('document');
  });

  it('未知内核 id 抛 unknown-template，不静默返回原串', () => {
    try {
      toF08TemplateId('bogus-template');
      throw new Error('不应到达');
    } catch (error) {
      expect((error as { code: string }).code).toBe('unknown-template');
    }
  });
});

// ---------------------------------------------------------------------------
// A1：四态不合并（真实 K06 报告）
// ---------------------------------------------------------------------------

describe('F08 / 内核适配：四态独立（真实 K06 报告）', () => {
  it('四态全就绪时 readinessVerdicts 返回四个 true 且互不推导', async () => {
    const report = await preparedLifecycle().reportReadiness('meituan');
    expect(readinessVerdicts(report)).toEqual({
      installed: true,
      enabled: true,
      authorized: true,
      portReady: true,
    });
  });

  it('真实停用后 enabled 掉 false，另外三态仍 true（若压成一个布尔必红）', async () => {
    const lifecycle = preparedLifecycle();
    lifecycle.disable('meituan');
    const verdicts = readinessVerdicts(await lifecycle.reportReadiness('meituan'));
    expect(verdicts).toEqual({ installed: true, enabled: false, authorized: true, portReady: true });
  });

  it('反向对照：报告缺 portReady / 含合并字段 ready ⇒ 抛错', async () => {
    const report = await preparedLifecycle().reportReadiness('meituan');
    const missing = {
      id: report.id,
      installed: report.installed,
      enabled: report.enabled,
      authorized: report.authorized,
    } as unknown as KernelReadinessReport;
    expect(() => assertFourStatesReported(missing)).toThrowError(/缺状态 portReady/);

    const collapsed = { ...report, ready: true } as unknown as KernelReadinessReport;
    expect(() => assertFourStatesReported(collapsed)).toThrowError(/非契约字段/);
  });
});

// ---------------------------------------------------------------------------
// A2/A3：报告 → recordProbe
// ---------------------------------------------------------------------------

describe('F08 / 内核适配：K06 报告落到 recordProbe', () => {
  it('真实报告把 portReady 写进 F08 状态（探针是唯一来源）', async () => {
    const report = await preparedLifecycle().reportReadiness('meituan');
    const state = applyReadinessReport(f08StateWithMeituan(), report);
    expect(rowOf(state, 'template.meituan').readiness.portReady).toBe(true);
    expect(getTemplate(state, 'template.meituan').checkedAt).toBe(new Date(T0).toISOString());
  });

  it('探针报端口未就绪：portReady=false 且原因原样透传、出现 not-port-ready 阻断', async () => {
    const report = await preparedLifecycle({
      ports: { ok: false, reason: 'kernel port offline' },
    }).reportReadiness('meituan');
    const state = applyReadinessReport(f08StateWithMeituan(), report);
    const row = rowOf(state, 'template.meituan');
    expect(row.readiness.portReady).toBe(false);
    expect(getTemplate(state, 'template.meituan').portReason).toContain('kernel port offline');
    expect(row.blockers.some((blocker) => blocker.code === 'not-port-ready')).toBe(true);
  });

  it('宿主能力缺失（capability_unavailable）被如实提取为 unsupportedCapabilities', async () => {
    const lifecycle = createTemplateLifecycle({
      clock: createManualClock(T0),
      host: host({ capabilities: ['order.read'] }), // 缺 order.place
      probe: probePort(),
    });
    lifecycle.install(manifest());
    lifecycle.enable('meituan');
    lifecycle.authorize('meituan', undefined, ['network', 'external-order']);
    const report = await lifecycle.reportReadiness('meituan');
    expect(probeInputFromReadiness(report).unsupportedCapabilities).toEqual(['order.place']);

    const state = applyReadinessReport(f08StateWithMeituan(), report);
    expect(getTemplate(state, 'template.meituan').unsupportedCapabilities).toContain('order.place');
  });

  it('portReady=true 时探针输入原因恒为 null（与 recordProbe 自洽）', async () => {
    const report = await preparedLifecycle().reportReadiness('meituan');
    expect(probeInputFromReadiness(report).portReason).toBeNull();
  });

  it('探针只改 portReady 等探针维度，不动 F08 的安装/启停/授权态', async () => {
    const before = f08StateWithMeituan();
    const report = await preparedLifecycle().reportReadiness('meituan');
    const after = applyReadinessReport(before, report);
    const row = rowOf(after, 'template.meituan');
    // 内核报告 installed/enabled/authorized 三态为 ready，但 F08 状态里美团仍未启用/未授权——
    // 适配层不把报告的三态写回（那三态由 F08 的安装/启用/授权操作驱动）。
    expect(row.readiness.installed).toBe(true);
    expect(row.readiness.enabled).toBe(false);
    expect(row.readiness.authorized).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A6：探针事件流（真实 K-I04 宿主 export 事件）round-trip
// ---------------------------------------------------------------------------

describe('F08 / 内核适配：探针事件流 resultRef round-trip（真实宿主模块）', () => {
  it('真实宿主 export 事件的 resultRef 能被解析并落回 F08 状态', async () => {
    const lifecycle = preparedLifecycle();
    const module = createTemplatesModule({ lifecycle });
    const command = buildProbeTemplateCommand(CTX, f08StateWithMeituan(), 'template.meituan');
    const outcome = await invokeModule(module, command);
    expect(outcome.status).toBe('succeeded');
    const resultRef = outcome.resultRef;
    if (resultRef === undefined) throw new Error('宿主 readiness 未回 resultRef');

    const event = parseProbeResultRef(resultRef);
    expect(event.templateId).toBe('meituan');
    expect(event.version).toBe('1.0.0');
    expect(event.verdicts).toEqual({ installed: true, enabled: true, authorized: true, portReady: true });

    const state = applyProbeResultRef(f08StateWithMeituan(), resultRef);
    expect(rowOf(state, 'template.meituan').readiness.portReady).toBe(true);
  });

  it('端口未就绪的宿主事件：resultRef 的 portReady=not-ready 落为 false', async () => {
    const lifecycle = preparedLifecycle({ ports: { ok: false, reason: 'down' } });
    const module = createTemplatesModule({ lifecycle });
    const outcome = await invokeModule(
      module,
      buildProbeTemplateCommand(CTX, f08StateWithMeituan(), 'template.meituan'),
    );
    const resultRef = outcome.resultRef;
    if (resultRef === undefined) throw new Error('宿主 readiness 未回 resultRef');
    expect(parseProbeResultRef(resultRef).verdicts).toEqual({
      installed: true,
      enabled: true,
      authorized: true,
      portReady: false,
    });
    expect(rowOf(applyProbeResultRef(f08StateWithMeituan(), resultRef), 'template.meituan').readiness.portReady).toBe(
      false,
    );
  });

  it('反向对照：resultRef 缺态 / 取值非法 / 形状不符 ⇒ 抛错（不把残缺事件当就绪）', () => {
    expect(() =>
      parseProbeResultRef('template:meituan@1.0.0:installed=ready,enabled=ready,authorized=ready'),
    ).toThrowError(/缺状态 portReady/);
    expect(() =>
      parseProbeResultRef('template:meituan@1.0.0:installed=ready,enabled=ready,authorized=ready,portReady=maybe'),
    ).toThrowError(/取值非法/);
    expect(() => parseProbeResultRef('not-a-template-result-ref')).toThrowError(/无法解析/);
  });
});

// ---------------------------------------------------------------------------
// A5：KernelClient 命令构造器 + 真实合约校验器
// ---------------------------------------------------------------------------

function runValidator(fixturesDir: string): { status: number; stdout: string } {
  try {
    const stdout = execFileSync(process.execPath, [VALIDATOR, fixturesDir], { encoding: 'utf8' });
    return { status: 0, stdout };
  } catch (error) {
    const err = error as { status?: number; stdout?: string };
    return { status: err.status ?? -1, stdout: err.stdout ?? '' };
  }
}

function withTempFixtures(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'f08-adapter-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeFixture(dir: string, name: string, value: unknown): void {
  writeFileSync(
    join(dir, name),
    JSON.stringify({ $schemaRef: COMMAND_SCHEMA_REF, note: name, value }, null, 2),
    'utf8',
  );
}

describe('F08 / 内核适配：模板命令构造（真校验器实跑）', () => {
  it('六个命令都满足 command.schema.json（7 PASS 的一部分，反向对照见下）', () => {
    expect(existsSync(VALIDATOR)).toBe(true);
    const state = f08StateWithMeituan();
    const targetManifest = { ...manifest(), version: '1.1.0' };
    const commands = {
      install: buildInstallTemplateCommand(CTX, state, 'template.meituan', { manifest: manifest() }),
      enable: buildEnableTemplateCommand(CTX, state, 'template.meituan'),
      authorize: buildAuthorizeTemplateCommand(CTX, state, 'template.meituan', {
        permissions: ['network', 'external-order'],
      }),
      update: buildUpdateTemplateCommand(CTX, state, 'template.meituan', { manifest: targetManifest }),
      uninstall: buildUninstallTemplateCommand(CTX, state, 'template.meituan', { version: '1.0.0' }),
      probe: buildProbeTemplateCommand(CTX, state, 'template.meituan'),
    };
    for (const [name, command] of Object.entries(commands)) {
      expect(() => assertTemplateCommand(command)).not.toThrow();
      expect(command.schemaVersion).toBe('mobile-v1');
      expect(['redo', 'export']).toContain(command.operation);
      expect(command.idempotencyKey.length).toBeGreaterThan(0);
      expect(name.length).toBeGreaterThan(0);
    }
    // 宿主扩展槽：内核 id（去掉 template. 前缀）+ 子操作名。
    expect((commands.install.payload as { args: { id: string; op: string } }).args.id).toBe('meituan');
    expect((commands.update.payload as { args: { op: string } }).args.op).toBe('upgrade');
    expect((commands.probe.payload as { args: { op: string } }).args.op).toBe('readiness');
    expect((commands.enable.payload as { args: { op: string } }).args.op).toBe('enable');
    expect((commands.authorize.payload as { args: { op: string } }).args.op).toBe('authorize');
    expect((commands.uninstall.payload as { args: { op: string } }).args.op).toBe('uninstall');

    withTempFixtures((dir) => {
      Object.entries(commands).forEach(([name, command]) => writeFixture(dir, `command-${name}.json`, command));
      const { status, stdout } = runValidator(dir);
      expect(stdout).toContain('summary: 6 PASS, 0 FAIL');
      expect((stdout.match(/PASS {2}command-/g) ?? []).length).toBe(6);
      expect(stdout).not.toMatch(/FAIL {2}command-/);
      expect(status).toBe(0);
    });
  });

  it('expectedRevision 由 F08 本地视图派生（调用方不可自带）', () => {
    const state = installTemplate(createTemplatesState(), 'template.document', '1.0.0');
    const revision = getTemplate(state, 'template.document').revision;
    const command = buildEnableTemplateCommand(CTX, state, 'template.document');
    expect((command.payload as { expectedRevision: number }).expectedRevision).toBe(revision);
    // 每次 recordProbe 写操作 +1 后，命令带新 revision。
    const bumped = applyReadinessReport(state, {
      id: 'document',
      installed: { state: 'ready', reason: null },
      enabled: { state: 'not-ready', reason: 'disabled' },
      authorized: { state: 'not-ready', reason: 'permission_not_granted:model' },
      portReady: { state: 'ready', reason: null },
    });
    expect(
      (buildEnableTemplateCommand(CTX, bumped, 'template.document').payload as { expectedRevision: number })
        .expectedRevision,
    ).toBe(revision + 1);
  });

  it('反向对照：assertTemplateCommand 对缺 expectedRevision / 非法 operation 抛错', () => {
    const state = f08StateWithMeituan();
    const command = buildEnableTemplateCommand(CTX, state, 'template.meituan');
    const noRevision = {
      ...command,
      payload: { conversationId: 'conv-1', args: { op: 'enable' } },
    } as unknown as typeof command;
    expect(() => assertTemplateCommand(noRevision)).toThrowError(/expectedRevision/);

    const badOperation = { ...command, operation: 'query' } as unknown as typeof command;
    expect(() => assertTemplateCommand(badOperation)).toThrowError(/redo \/ export/);
  });

  it('TEMPLATE_COMMAND_MAP 恰好六个、映射到宿主 redo/export 约定（标记 proposed）', () => {
    expect(Object.keys(TEMPLATE_COMMAND_MAP).sort()).toEqual(
      ['authorize', 'enable', 'install', 'probe', 'uninstall', 'update'].sort(),
    );
    expect(TEMPLATE_COMMAND_MAP.install.hostOp).toBe('install');
    expect(TEMPLATE_COMMAND_MAP.update.hostOp).toBe('upgrade');
    expect(TEMPLATE_COMMAND_MAP.probe.v1Operation).toBe('export');
    for (const entry of Object.values(TEMPLATE_COMMAND_MAP)) {
      expect(entry.branch).toBe('mutation');
      expect(entry.proposed).toBe(true);
    }
  });

  it('非法参数被拒：manifest 非对象 / 权限为空或未知', () => {
    const state = f08StateWithMeituan();
    try {
      buildInstallTemplateCommand(CTX, state, 'template.meituan', { manifest: null });
      throw new Error('不应到达');
    } catch (error) {
      expect((error as { code: string }).code).toBe('invalid-transition');
    }
    try {
      buildAuthorizeTemplateCommand(CTX, state, 'template.meituan', { permissions: [] });
      throw new Error('不应到达');
    } catch (error) {
      expect((error as { code: string }).code).toBe('invalid-permissions');
    }
  });
});

// ---------------------------------------------------------------------------
// 既有不变量在适配层之后仍成立（七行恒可见 / 更新比对新增权限）
// ---------------------------------------------------------------------------

describe('F08 / 内核适配：既有不变量不回退', () => {
  it('适配后目录仍恒七行，未安装模板仍全 false', async () => {
    const report = await preparedLifecycle().reportReadiness('meituan');
    const state = applyReadinessReport(f08StateWithMeituan(), report);
    const rows = catalogRows(state);
    expect(rows).toHaveLength(7);
    expect(rows.map((row) => row.id)).toEqual([
      'template.document',
      'template.spreadsheet',
      'template.presentation',
      'template.meituan',
      'template.clock',
      'template.calendar',
      'template.research',
    ]);
    expect(rows.find((row) => row.id === 'template.clock')?.readiness).toEqual({
      installed: false,
      enabled: false,
      authorized: false,
      portReady: false,
    });
  });

  it('更新命令携带目标 manifest；F08 applyUpdate 仍按「新增权限需再授权」处理', () => {
    let state = installTemplate(createTemplatesState(), 'template.document', '1.0.0');
    state = authorizeTemplate(state, 'template.document', ['storage', 'file-write', 'model']);
    state = enableTemplate(state, 'template.document');
    expect(rowOf(state, 'template.document').readiness.authorized).toBe(true);

    const revisionBefore = getTemplate(state, 'template.document').revision;
    const targetPermissions = ['storage', 'file-write', 'model', 'external-order'] as const;
    const target = { ...manifest(), id: 'document', version: '1.1.0', permissions: [...targetPermissions] };
    const command = buildUpdateTemplateCommand(CTX, state, 'template.document', { manifest: target });
    expect((command.payload as { expectedRevision: number }).expectedRevision).toBe(revisionBefore);
    const args = (command.payload as { args: { op: string; manifest: { permissions: string[] } } }).args;
    expect(args.op).toBe('upgrade');
    expect(args.manifest.permissions).toContain('external-order');

    // 同一次更新落到本地视图：新增的 external-order 未自动授予 ⇒ authorized 掉回 false。
    const result = applyUpdate(state, 'template.document', { version: '1.1.0', permissions: [...targetPermissions] });
    expect(result.delta.added).toEqual(['external-order']);
    expect(result.delta.requiresReauthorization).toBe(true);
    const after = rowOf(result.state, 'template.document');
    expect(after.readiness.authorized).toBe(false);
    expect(after.blockers.some((blocker) => blocker.code === 'pending-authorization')).toBe(true);
  });
});
