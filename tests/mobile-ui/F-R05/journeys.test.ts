/**
 * F-R05 验收：十二条设计旅程 ↔ 真实事件映射，且 fixture 不得冒充产品成功。
 *
 * 本测试的独立性来自**外部锚点**——用冻结合入 main 的
 * `contracts/mobile-v1/validate.mjs`（按 schemas/*.json 实跑）真实校验本包用到的产物：
 *   - fixture 产物**合法**（契约允许 fixture 声明非终态），但审计只能是 `fixture`，
 *     永远得不出 `productSuccess`——证明「fixture 无法冒充产品成功」不是靠把 fixture 判非法；
 *   - 本包判 masquerade 的产物，真实校验器**必须**报错（回执 fixture+confirmed /
 *     事件 succeeded 缺 resultRef / 清单合并四态就绪）；
 *   - 本包判 real 的成功产物，真实校验器**必须**通过。
 *
 * 所有产物在此显式构造，不读取任何密钥、不放手机号/地址。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  createBootstrapRuntime,
  createManualClock,
  type BootstrapRuntime,
  type Command,
  type OperationHandler,
  type OperationOutcome,
} from '../../../apps/mobile-kernel/bootstrap/index.js';
import {
  createKernelClient,
  createKernelClientFromBridge,
  type CallerIdentity,
  type Event as KernelEvent,
  type EventStatus as KernelEventStatus,
  type KernelTransport,
} from '../../../apps/mobile-ui/src/platform/index.js';

import type {
  Artifact,
  EventArtifact,
  FactsArtifact,
  JourneyId,
  ManifestArtifact,
  ReceiptArtifact,
  VerificationMode,
} from './types.js';
import {
  ALL_JOURNEY_IDS,
  JOURNEYS,
  JOURNEY_STREAM_PLANS,
  artifactId,
  audit,
  auditJourney,
  evaluateInvariant,
  evaluateSlot,
  getJourney,
  isMasquerade,
  plansCoverAllJourneys,
  recordJourneyStream,
  streamEventToArtifact,
  type JourneyCommand,
  type JourneyStreamPlan,
} from './journeys.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const VALIDATOR = join(REPO_ROOT, 'contracts', 'mobile-v1', 'validate.mjs');

// ---------------------------------------------------------------------------
// 产物构造器
// ---------------------------------------------------------------------------

function event(
  id: string,
  target: string,
  mode: VerificationMode,
  extra: Partial<EventArtifact> = {},
): EventArtifact {
  return {
    type: 'event',
    eventId: id,
    commandId: `cmd-${id}`,
    operation: 'mutate',
    status: 'succeeded',
    revision: 1,
    resultRef: `artifact:${id}@1`,
    verificationMode: mode,
    targetId: target,
    ...extra,
  };
}

function receipt(
  actionId: string,
  state: ReceiptArtifact['observedState'],
  mode: VerificationMode,
): ReceiptArtifact {
  return {
    type: 'receipt',
    actionId,
    observedState: state,
    verificationMode: mode,
    provider: 'meituan',
    requestRef: `req-${actionId}`,
    externalId: `ext-${actionId}`,
    evidenceRef: `evidence:${actionId}`,
  };
}

function facts(snapshotId: string, layer: 'real' | 'fixture'): FactsArtifact {
  return { type: 'facts', snapshotId, revision: 1, evidenceLayer: layer };
}

function manifest(id: string, mode: VerificationMode, mergedReady = false): ManifestArtifact {
  return {
    type: 'manifest',
    id,
    mergedReady,
    probe: {
      installed: true,
      enabled: true,
      authorized: true,
      portReady: true,
      verificationMode: mode,
    },
  };
}

/**
 * 覆盖全部十二条旅程槽位的产物集。唯一 target ⇒ 事件 revision 单调不变量成立。
 * 顺序即 seq 序。
 */
function observationArtifacts(mode: VerificationMode): Artifact[] {
  return [
    event('e01', 't01', mode, { operation: 'create' }), // J01 会话绑定
    event('e13', 't13', mode, { operation: 'apply', status: 'failed', resultRef: undefined, errorCode: 'permission-denied' }), // J01 拒绝权限 / J10 / J11 / J12
    event('e02', 't02', mode, { operation: 'export' }), // J02 三件套 #1
    event('e03', 't03', mode, { operation: 'export' }), // J02 三件套 #2
    facts('facts-j02', mode), // J02 同版事实
    event('e04', 't04', mode, { operation: 'mutate' }), // J03 修改
    event('e05', 't05', mode, { operation: 'mutate', status: 'conflict', resultRef: undefined }), // J03 迟到旧轮次
    event('e06', 't06', mode, { operation: 'import' }), // J04 导入
    event('e07', 't07', mode, { operation: 'apply', revision: 2 }), // J04 导入后修改
    receipt('act-j05-prepared', 'prepared', mode), // J05 交接
    receipt('act-j05-unknown', 'unknown', mode), // J05 未知
    receipt('act-j06-submit', 'submitted', mode), // J06 单次提交
    event('e11', 't11', mode, { operation: 'cancel', status: 'cancelled', resultRef: undefined }), // J06 取消 / J08 停止回复 / J12 归档前取消
    event('e08', 't08', mode, { operation: 'create' }), // J07 时钟创建
    event('e09', 't09', mode, { operation: 'mutate' }), // J07 日历修改
    event('e10', 't10', mode, { operation: 'create' }), // J08 并行任务
    event('e12', 't12', mode, { operation: 'query' }), // J09 重启续接
    receipt('act-j09-submit', 'submitted', mode), // J09 外部不重放
    manifest('word-doc', mode), // J10 模板四态就绪
    event('e14', 't14', mode, { operation: 'create' }), // J11 记忆写入
    event('e15', 't15', mode, { operation: 'export', status: 'failed', resultRef: undefined, errorCode: 'budget-exhausted' }), // J12 预算耗尽
  ];
}

function observe(mode: VerificationMode): Artifact[] {
  return observationArtifacts(mode);
}

const ALL = { journeys: ALL_JOURNEY_IDS };

// ---------------------------------------------------------------------------
// 契约校验器（真实子进程）
// ---------------------------------------------------------------------------

/** 把一个产物转成契约 fixture 信封（只含 schema 允许的字段）。 */
function toWireFixture(a: Artifact): { $schemaRef: string; value: unknown } {
  switch (a.type) {
    case 'event': {
      const value: Record<string, unknown> = {
        eventId: a.eventId,
        seq: 0,
        commandId: a.commandId,
        revision: a.revision,
        status: a.status,
        idempotentReplay: false,
      };
      if (a.resultRef !== undefined) value.resultRef = a.resultRef;
      if (a.verificationMode !== undefined) value.verificationMode = a.verificationMode;
      return { $schemaRef: 'schemas/event.schema.json', value };
    }
    case 'receipt':
      return {
        $schemaRef: 'schemas/external-receipt.schema.json',
        value: {
          actionId: a.actionId,
          provider: a.provider,
          requestRef: a.requestRef,
          externalId: a.externalId,
          observedState: a.observedState,
          observedAt: '2026-10-03T08:00:00Z',
          evidenceRef: a.evidenceRef,
          verificationMode: a.verificationMode,
        },
      };
    case 'facts':
      return {
        $schemaRef: 'schemas/facts-port.schema.json',
        value: {
          snapshotId: a.snapshotId,
          revision: a.revision,
          sourceRefs: ['artifact:x@1'],
          values: {},
          units: {},
        },
      };
    case 'manifest': {
      const value: Record<string, unknown> = {
        id: a.id,
        displayName: 'Word',
        version: '1.0.0',
        capabilities: ['doc-edit'],
        schemas: ['office-plugin.schema.json'],
        permissions: ['storage'],
        runtimeCompatibility: {
          os: 'android',
          minimumOs: 26,
          runtimes: ['quickjs'],
          abis: ['arm64-v8a'],
        },
        migration: { from: '0.9.0', to: '1.0.0', strategy: 'additive', reversible: true },
        probe: {
          installed: a.probe.installed,
          enabled: a.probe.enabled,
          authorized: a.probe.authorized,
          portReady: a.probe.portReady,
          verificationMode: a.probe.verificationMode,
          layers: ['unit', 'contract'],
          checkedAt: '2026-10-03T08:00:00Z',
        },
      };
      // 故意注入被契约拒绝的合并字段（masquerade 探针）。
      if (a.mergedReady === true) value.ready = true;
      return { $schemaRef: 'schemas/template-manifest.schema.json', value };
    }
  }
}

/** 真实运行共享校验器；返回真实退出码。 */
function validatorExitFor(artifact: Artifact): number {
  const dir = mkdtempSync(join(tmpdir(), 'fr05-contract-'));
  try {
    const fixture = toWireFixture(artifact);
    writeFileSync(join(dir, 'fixture.json'), JSON.stringify(fixture, null, 2), 'utf8');
    try {
      execFileSync(process.execPath, [VALIDATOR, dir], { encoding: 'utf8' });
      return 0;
    } catch (error) {
      const err = error as { status?: number };
      return err.status ?? -1;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe('F-R05 十二条旅程注册表', () => {
  it('恰好十二条、id 唯一且与 design-07 §11 顺序一致', () => {
    expect(JOURNEYS).toHaveLength(12);
    expect(ALL_JOURNEY_IDS).toEqual([
      'J01', 'J02', 'J03', 'J04', 'J05', 'J06', 'J07', 'J08', 'J09', 'J10', 'J11', 'J12',
    ]);
    expect(new Set(ALL_JOURNEY_IDS).size).toBe(12);
  });

  it('每条旅程都有槽位、槽位 id 唯一；无成功断言槽的旅程恰为 J05/J06/J12', () => {
    // J05（选择与外部交接，止于「已交接/未知」）、J06（授权双击取消，止于 unknown/取消）
    // 与 J12（失败与退出语义）按 design-07 §11 **本就不以成功为终点**——它们的产物成功
    // 恰恰是如实表达非成功态。其余旅程必须含至少一个受保护成功断言槽，否则 masquerade
    // 检查会缺锚点。
    const DELIBERATELY_NON_SUCCESS = new Set(['J05', 'J06', 'J12']);
    for (const j of JOURNEYS) {
      expect(j.slots.length, j.id).toBeGreaterThan(0);
      expect(new Set(j.slots.map((s) => s.id)).size, `${j.id} 槽位 id 重复`).toBe(j.slots.length);
      const hasGuard = j.slots.some((s) => s.guard);
      expect(hasGuard, `${j.id} 成功断言槽缺失情况`).toBe(!DELIBERATELY_NON_SUCCESS.has(j.id));
    }
  });
});

describe('F-R05 fixture 无法冒充产品成功', () => {
  const report = audit({ ...ALL, artifacts: observe('fixture'), note: '全 fixture 产物' });

  it('全部产物都通过真实契约校验（合法性 ≠ 产品成功）', () => {
    for (const a of observe('fixture')) {
      expect(validatorExitFor(a), `${artifactId(a)} 应合法`).toBe(0);
    }
  }, 60000);

  it('审计结果为：无 real、无 masquerade、productSuccess=false', () => {
    expect(report.realCount).toBe(0);
    expect(report.masqueradeCount).toBe(0);
    expect(report.masqueradeArtifacts).toEqual([]);
    expect(report.fixtureOnlyCount).toBeGreaterThan(0);
    expect(report.productSuccess).toBe(false);
  });

  it('凡是匹配到槽位的旅程状态都不是 real', () => {
    for (const j of report.journeys) {
      expect(j.status, `${j.journeyId} 不应为 real`).not.toBe('real');
      expect(j.productSuccess, `${j.journeyId} 不应为产品成功`).toBe(false);
    }
  });
});

describe('F-R05 真实事件可证成的产品成功', () => {
  const artifacts = observe('real');
  const report = audit({ ...ALL, artifacts, note: '全 real 产物' });

  it('real 产物全部通过真实契约校验', () => {
    for (const a of artifacts) {
      expect(validatorExitFor(a), `${artifactId(a)} 应合法`).toBe(0);
    }
  }, 60000);

  it('十二条旅程全部 real，productSuccess=true，无 masquerade', () => {
    expect(report.realCount).toBe(12);
    expect(report.masqueradeCount).toBe(0);
    expect(report.masqueradeArtifacts).toEqual([]);
    expect(report.productSuccess).toBe(true);
    for (const j of report.journeys) {
      expect(j.status, j.journeyId).toBe('real');
      expect(j.productSuccess, j.journeyId).toBe(true);
    }
  });

  it('空缺证据时降级为 missing（反向对照：判据真会咬）', () => {
    // 去掉唯一的 conflict 事件 ⇒ J03 的 stale-round-rejected 槽缺证据。
    const withoutConflict = artifacts.filter(
      (a) => !(a.type === 'event' && a.eventId === 'e05'),
    );
    const j03 = auditJourney(getJourney('J03'), withoutConflict);
    expect(j03.status).toBe('missing');
    expect(j03.productSuccess).toBe(false);
  });
});

describe('F-R05 masquerade 被真实校验器独立确认非法', () => {
  const fixtureConfirmed = receipt('act-masq', 'confirmed', 'fixture');
  const noResultRef = event('e-masq', 't-masq', 'real', { status: 'succeeded', resultRef: undefined });
  const mergedReady = manifest('word-doc', 'real', true);
  const realConfirmed = receipt('act-real', 'confirmed', 'real');

  it('回执 fixture + confirmed：本包判 masquerade，校验器 exit≠0', () => {
    expect(isMasquerade(fixtureConfirmed)).toBe(true);
    expect(validatorExitFor(fixtureConfirmed)).not.toBe(0);
  });

  it('事件 succeeded 缺 resultRef：本包判 masquerade，校验器 exit≠0', () => {
    expect(isMasquerade(noResultRef)).toBe(true);
    expect(validatorExitFor(noResultRef)).not.toBe(0);
  });

  it('清单合并四态就绪：本包判 masquerade，校验器 exit≠0', () => {
    expect(isMasquerade(mergedReady)).toBe(true);
    expect(validatorExitFor(mergedReady)).not.toBe(0);
  });

  it('real + confirmed 回执是合法终态（对照：真成功不被误伤）', () => {
    expect(isMasquerade(realConfirmed)).toBe(false);
    expect(validatorExitFor(realConfirmed)).toBe(0);
  });

  it('一条孤立 masquerade 回执即可否决整份观察（报告级扫描）', () => {
    const artifacts = [...observe('real'), fixtureConfirmed];
    const report = audit({ ...ALL, artifacts });
    expect(report.masqueradeArtifacts).toContain('act-masq');
    expect(report.productSuccess).toBe(false);
  });

  it('受保护成功槽命中 masquerade 产物时，该槽与旅程均为 masquerade', () => {
    const slot = getJourney('J01').slots[0]!;
    const verdict = evaluateSlot(slot, [noResultRef]);
    expect(verdict.status).toBe('masquerade');
  });
});

describe('F-R05 旅程级不变量', () => {
  it('重复提交（同 actionId 两次 submitted）⇒ J06 判 masquerade', () => {
    const dup = [
      receipt('act-dup', 'submitted', 'real'),
      receipt('act-dup', 'submitted', 'real'),
    ];
    const inv = evaluateInvariant({ kind: 'no-duplicate-submission' }, dup);
    expect(inv.ok).toBe(false);

    const j06 = auditJourney(getJourney('J06'), [
      ...observe('real').filter((a) => a.type !== 'receipt' || a.actionId !== 'act-j06-submit'),
      ...dup,
    ]);
    expect(j06.status).toBe('masquerade');
    expect(j06.productSuccess).toBe(false);
  });

  it('迟到旧轮次（同 target revision 回退）⇒ J03 不变量失败、降级为 missing', () => {
    const late = [
      event('fresh', 't-shared', 'real', { revision: 5 }),
      event('stale', 't-shared', 'real', { revision: 2 }),
    ];
    const inv = evaluateInvariant({ kind: 'monotonic-events' }, late);
    expect(inv.ok).toBe(false);
    const j03 = auditJourney(getJourney('J03'), [...late, event('c', 't-c', 'real', { status: 'conflict', resultRef: undefined })]);
    expect(j03.status).toBe('missing');
    expect(j03.productSuccess).toBe(false);
  });

  it('单调不减序列通过（对照：正常轮次不被误伤）', () => {
    const ok = [
      event('r1', 't-shared', 'real', { revision: 1 }),
      event('r2', 't-shared', 'real', { revision: 2 }),
    ];
    expect(evaluateInvariant({ kind: 'monotonic-events' }, ok).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F-I01 KernelClient 事件流：十二条旅程的真实事件驱动
// ---------------------------------------------------------------------------

const UI_CALLER: CallerIdentity = { origin: 'app://local', kind: 'ui-webview', packageName: 'com.potbot.demo' };
const ALLOWED_ORIGINS = ['app://local', 'file:///android_asset', 'https://localhost'] as const;

/** 运行时应答：这些命令如实返回 failed（失败路径不得假报成功）。 */
const FAILING_OUTCOMES: ReadonlyMap<string, OperationOutcome> = new Map([
  ['cmd-j01-denied', { status: 'failed', error: { code: 'permission-denied', message: '用户拒绝权限' } }],
  ['cmd-j10-revoke', { status: 'failed', error: { code: 'REVOKED_MID_RUN', message: '运行中撤权，部分结果如实上报' } }],
  ['cmd-j11-forget', { status: 'failed', error: { code: 'FORGET_FAILED', message: '遗忘失败需如实上报' } }],
  ['cmd-j12-budget', { status: 'failed', error: { code: 'BUDGET_EXHAUSTED', message: '预算耗尽，给部分结果与原因' } }],
]);

/** 一个真实的 K01 运行时（真实桥的另一端），按 verificationMode 决定事件模式。 */
function bridgeRuntime(verificationMode: VerificationMode): BootstrapRuntime {
  const runtime = createBootstrapRuntime({ clock: createManualClock(), verificationMode });
  const handle: OperationHandler = (command) => {
    const failure = FAILING_OUTCOMES.get(command.commandId);
    if (failure !== undefined) return failure;
    return { status: 'succeeded', resultRef: `artifact:${command.commandId}@1` };
  };
  for (const operation of ['create', 'import', 'mutate', 'apply', 'export', 'query'] as const) {
    runtime.registerModule({ id: `fr05-${operation}`, operations: [operation], handle });
  }
  runtime.start();
  return runtime;
}

/** 真实运行时 + 真实桥 + F-I01 `KernelClient` 的一站式装配（已启动）。 */
function startBridge(verificationMode: VerificationMode) {
  const runtime = bridgeRuntime(verificationMode);
  const bundle = createKernelClientFromBridge({
    runtime,
    caller: UI_CALLER,
    allowedOrigins: ALLOWED_ORIGINS,
    allowedKinds: ['ui-webview'],
  });
  bundle.start();
  return bundle;
}

function allStreamCommands(): readonly JourneyCommand[] {
  return JOURNEY_STREAM_PLANS.flatMap((p) => p.commands);
}

/** 从旅程命令元数据构造符合 v1 契约的形状（mutation 分支补 expectedRevision）。 */
function buildStreamCommand(c: JourneyCommand): Command {
  const shared = {
    ...(c.conversationId === undefined ? {} : { conversationId: c.conversationId }),
    ...(c.targetId === undefined ? {} : { targetId: c.targetId }),
  };
  const head = {
    schemaVersion: 'mobile-v1' as const,
    commandId: c.commandId,
    operation: c.operation,
    idempotencyKey: `idem-${c.commandId}`,
  };
  if (c.operation === 'mutate' || c.operation === 'apply' || c.operation === 'export' || c.operation === 'undo' || c.operation === 'redo') {
    return { ...head, payload: { ...shared, expectedRevision: c.expectedRevision ?? 0 } };
  }
  return { ...head, payload: shared };
}

/**
 * 十二条旅程的完整计划：事件槽来自 F-I01 流，回执 / 事实 / 清单由**各自端口**提供。
 * 这里如实把非事件产物标成 `fixture`——它们尚未接到真实生产者，本包不为它们背书。
 */
function augmentedPlans(): readonly JourneyStreamPlan[] {
  const external: Partial<Record<JourneyId, readonly Artifact[]>> = {
    J02: [facts('facts-j02-port', 'fixture')],
    J05: [receipt('act-j05-prepared', 'prepared', 'fixture'), receipt('act-j05-unknown', 'unknown', 'fixture')],
    J06: [receipt('act-j06-submit', 'submitted', 'fixture')],
    J09: [receipt('act-j09-submit', 'submitted', 'fixture')],
    J10: [manifest('word-doc', 'fixture')],
  };
  return JOURNEY_STREAM_PLANS.map((p) => {
    const extra = external[p.journeyId];
    return extra === undefined ? p : { ...p, artifacts: extra };
  });
}

/** 确定性事件流：手动 emit 事件，不经过真实运行时（覆盖真实运行时难制造的坏终局）。 */
function scriptedStream(): { transport: KernelTransport; emit(event: KernelEvent): void } {
  const listeners = new Set<(event: KernelEvent) => void>();
  const transport: KernelTransport = {
    submit: () => Promise.resolve(streamEvent(0, 'unused', 'failed')),
    subscribe(listener) {
      listeners.add(listener);
      return {
        unsubscribe: () => {
          listeners.delete(listener);
        },
      };
    },
    cancel: () => false,
    onBreak() {
      return { unsubscribe: () => {} };
    },
  };
  return {
    transport,
    emit(event) {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

function streamEvent(
  seq: number,
  commandId: string,
  status: KernelEventStatus,
  extra: Partial<KernelEvent> = {},
): KernelEvent {
  return { eventId: `evt-${commandId}-${seq}`, seq, commandId, revision: 0, status, ...extra };
}

describe('F-R05 十二条旅程订阅 F-I01 KernelClient 事件流', () => {
  it('事件流计划 1:1 覆盖全部十二条旅程，且每条至少一条命令、命令 id 全局唯一', () => {
    expect(plansCoverAllJourneys()).toBe(true);
    expect(JOURNEY_STREAM_PLANS.map((p) => p.journeyId)).toEqual([...ALL_JOURNEY_IDS]);
    for (const p of JOURNEY_STREAM_PLANS) {
      expect(p.commands.length, p.journeyId).toBeGreaterThan(0);
    }
    const ids = allStreamCommands().map((c) => c.commandId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('真实桥 + 真实运行时（verificationMode=real）：事件槽记成 real，masquerade=0，非事件端口未接线故不判产品成功', async () => {
    const bundle = startBridge('real');
    const recording = recordJourneyStream(bundle.client, augmentedPlans());
    const commands = allStreamCommands();
    for (const c of commands) {
      const receipt = await bundle.client.sendCommand(buildStreamCommand(c));
      expect(receipt.commandId).toBe(c.commandId);
    }

    const observation = recording.observation();
    const streamed = observation.artifacts.filter((a): a is EventArtifact => a.type === 'event');
    // 每条命令恰好投递一条终局事件（处理器不发中间进度）。
    expect(streamed).toHaveLength(commands.length);
    expect(streamed.every((a) => a.verificationMode === 'real')).toBe(true);
    // 12 条旅程的命令 id 全被流覆盖。
    expect(new Set(streamed.map((a) => a.commandId))).toEqual(new Set(commands.map((c) => c.commandId)));

    const report = audit(observation);
    expect(report.masqueradeCount).toBe(0);
    expect(report.masqueradeArtifacts).toEqual([]);
    expect(report.productSuccess).toBe(false);
    // 事件类旅程可为 real（7 条）；含回执/事实/清单槽的 5 条停在 fixture（端口未接线）。
    expect(report.realCount).toBe(7);
    expect(report.fixtureOnlyCount).toBe(5);
    recording.unsubscribe();
    bundle.stop();
  });

  it('同一事件流改为 verificationMode=fixture：realCount 恒为 0（fixture 不冒充产品成功不变量保持）', async () => {
    const bundle = startBridge('fixture');
    const recording = recordJourneyStream(bundle.client, augmentedPlans());
    for (const c of allStreamCommands()) {
      await bundle.client.sendCommand(buildStreamCommand(c));
    }
    const observation = recording.observation();
    const streamed = observation.artifacts.filter((a): a is EventArtifact => a.type === 'event');
    expect(streamed).toHaveLength(allStreamCommands().length);
    expect(streamed.every((a) => a.verificationMode === 'fixture')).toBe(true);

    const report = audit(observation);
    expect(report.realCount).toBe(0);
    expect(report.productSuccess).toBe(false);
    recording.unsubscribe();
    bundle.stop();
  });

  it('J05/J06 终局证据来自外部回执端口（未接线 ⇒ fixture）：保持非成功', async () => {
    const bundle = startBridge('real');
    const recording = recordJourneyStream(bundle.client, augmentedPlans());
    for (const c of allStreamCommands()) {
      await bundle.client.sendCommand(buildStreamCommand(c));
    }
    const report = audit(recording.observation());
    for (const id of ['J05', 'J06'] as const) {
      const journey = report.journeys.find((j) => j.journeyId === id);
      expect(journey, id).toBeDefined();
      expect(journey?.status, id).toBe('fixture');
      expect(journey?.productSuccess, id).toBe(false);
    }
    recording.unsubscribe();
    bundle.stop();
  });
});

describe('F-R05 事件流最坏情况：坏终局 / fixture 不落成 real 槽', () => {
  const J04_PLAN: JourneyStreamPlan = {
    journeyId: 'J04',
    commands: [
      { commandId: 'cmd-fr05-a', operation: 'import', targetId: 'tj04-a', conversationId: 'conv-fr05-a' },
      { commandId: 'cmd-fr05-b', operation: 'mutate', targetId: 'tj04-b', conversationId: 'conv-fr05-b' },
    ],
  };

  it('坏终局事件（succeeded 缺 resultRef）被 KernelClient 折成 invalid-terminal 断流，绝不落成 real 槽', () => {
    const s = scriptedStream();
    const client = createKernelClient({ transport: s.transport, caller: UI_CALLER });
    const recording = recordJourneyStream(client, [J04_PLAN]);

    s.emit(streamEvent(1, 'cmd-fr05-a', 'succeeded', { resultRef: 'artifact:a@1', verificationMode: 'real' }));
    s.emit(streamEvent(2, 'cmd-fr05-b', 'succeeded', { verificationMode: 'real' })); // 缺 resultRef

    expect(recording.breaks.map((b) => b.reason)).toEqual(['invalid-terminal']);
    expect(recording.events).toHaveLength(1); // 坏终局不落成事件
    const verdict = auditJourney(getJourney('J04'), recording.artifacts());
    expect(verdict.status).toBe('missing');
    expect(verdict.productSuccess).toBe(false);

    // 对照：若绕过客户端直接映射，这条事件本就是 masquerade —— 证明「流不落」真的防住了。
    const raw = streamEventToArtifact(
      streamEvent(2, 'cmd-fr05-b', 'succeeded', { verificationMode: 'real' }),
      J04_PLAN.commands[1]!,
    );
    expect(isMasquerade(raw)).toBe(true);
    recording.unsubscribe();
  });

  it('real 事件带 resultRef：两条成功事件即可把 J04 判为 real（对照：真成功不被误伤）', () => {
    const s = scriptedStream();
    const client = createKernelClient({ transport: s.transport, caller: UI_CALLER });
    const recording = recordJourneyStream(client, [J04_PLAN]);
    s.emit(streamEvent(1, 'cmd-fr05-a', 'succeeded', { resultRef: 'artifact:a@1', verificationMode: 'real' }));
    s.emit(streamEvent(2, 'cmd-fr05-b', 'succeeded', { resultRef: 'artifact:b@1', verificationMode: 'real' }));
    expect(recording.breaks).toEqual([]);
    const verdict = auditJourney(getJourney('J04'), recording.artifacts());
    expect(verdict.status).toBe('real');
    expect(verdict.productSuccess).toBe(true);
    recording.unsubscribe();
  });

  it('fixture 事件流：同一计划下 J04 判 fixture、productSuccess=false', () => {
    const s = scriptedStream();
    const client = createKernelClient({ transport: s.transport, caller: UI_CALLER });
    const recording = recordJourneyStream(client, [J04_PLAN]);
    s.emit(streamEvent(1, 'cmd-fr05-a', 'succeeded', { resultRef: 'artifact:a@1', verificationMode: 'fixture' }));
    s.emit(streamEvent(2, 'cmd-fr05-b', 'succeeded', { resultRef: 'artifact:b@1', verificationMode: 'fixture' }));
    const verdict = auditJourney(getJourney('J04'), recording.artifacts());
    expect(verdict.status).toBe('fixture');
    expect(verdict.productSuccess).toBe(false);
    recording.unsubscribe();
  });
});

describe('F-R05 J05/J06/J12 永久钉在非成功终点', () => {
  it('三条旅程的槽位一律为非成功断言（guard 全 false，且无 succeeded / confirmed 断言）', () => {
    for (const id of ['J05', 'J06', 'J12'] as const) {
      const journey = getJourney(id);
      for (const slot of journey.slots) {
        expect(slot.guard, `${id}.${slot.id}`).toBe(false);
        expect(slot.eventStatus, `${id}.${slot.id}`).not.toBe('succeeded');
        expect(slot.receiptState, `${id}.${slot.id}`).not.toBe('confirmed');
      }
    }
  });

  it('注入一条 real succeeded 事件也翻不动它们的非成功终点（无成功断言槽可锚）', () => {
    const injected = event('injected-success', 't-injected', 'real');
    for (const id of ['J05', 'J06', 'J12'] as const) {
      const verdict = auditJourney(getJourney(id), [injected]);
      expect(verdict.status, id).not.toBe('real');
      expect(verdict.productSuccess, id).toBe(false);
    }
  });
});
