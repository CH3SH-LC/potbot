/**
 * K-R05 独立审计器 —— **模版卸载撤权与在途版本冻结**（`mod-templates` 反例包）。
 *
 * ## 这包为什么独立存在
 *
 * 产品实现是 `apps/mobile-kernel/templates/lifecycle.ts`（K06）。K06 自带用例只走"正常路径"；
 * 本包不改产品源码（写权仅 `tests/mobile-kernel/K-R05/`），而是**独立**把 K-R05 的两条硬保证
 * 写成机器可核的**不变量**，用一条可复现的**操作轨迹**驱动真实生命周期，在每一步之后核对：
 *
 * 1. **在途版本冻结**（in-flight version freeze）：一个任务一旦钉住某模版版本，该版本此后
 *    **不得**被升级、卸载或重装静默换掉 / 悄悄移除；`resolve(taskId)` 必须一直取得到同一版本。
 * 2. **卸载撤权**（uninstall revocation）：卸载必须撤销已授予权限、停用、并拒绝新任务钉住该版本；
 *    被在途任务钉住的版本"撤权但保留"，释放后方可真正移除。
 *
 * 本模块**零 IO、零墙钟、零随机数**：只读被注入的生命周期快照并记账，结论全部来自调用方
 * 传入的 `TemplateLifecycle` 的**真实读回**，不采信任何"我应该没问题"的自述。
 *
 * ## 与其他 reserve 包的关系
 *
 * 这里只做**只读审计 + 反例**：命中即报告（`FreezeFinding`），修复由 K06 领。检测器本身
 * 也被 `03-audit-module.test.ts` 自证——用一个**故意损坏**的假探针证明"该报的真的会报"，
 * 避免判据退化成空壳。
 */

import type {
  InstalledTemplate,
  TemplateLifecycle,
  TemplateManifest,
  TemplatePermission,
} from '../../../apps/mobile-kernel/templates/index.js';

// ---------------------------------------------------------------------------
// 不变量词表（K-R05 的机器化口径；消费方可按 id 过滤）
// ---------------------------------------------------------------------------

export const K_R05_INVARIANTS = [
  {
    id: 'I1-pin-resolvable',
    severity: 'high',
    statement: '任何仍在册的钉住任务，其 resolve(taskId) 必须成功——在途版本不得消失',
  },
  {
    id: 'I2-retained-version-pinnedby-intact',
    severity: 'high',
    statement:
      '被钉住的版本必须始终可取回，且其 pinnedBy 必须包含该任务；被"保留供在途任务使用"的版本不得丢失 pin 记账',
  },
  {
    id: 'I3-uninstall-revokes-and-disables',
    severity: 'high',
    statement: '卸载过的版本（若仍存在）必须 grantedPermissions 为空、enabled=false，且不接受新 pin',
  },
  {
    id: 'I4-binding-frozen-version-stable',
    severity: 'high',
    statement: '钉住任务的绑定版本一经签发不得被改写——resolve 返回的版本必须恒等于签发时的版本',
  },
  {
    id: 'I5-new-pin-not-stale-fallback',
    severity: 'medium',
    statement: '未显式指定版本的新任务 pin，必须绑到当前在用版本；不得静默回退到已被取代的旧版本',
  },
] as const;
export type InvariantId = (typeof K_R05_INVARIANTS)[number]['id'];
export type FindingSeverity = 'high' | 'medium' | 'info';

// ---------------------------------------------------------------------------
// 操作轨迹 schema（供其他线/夹具生成可复现反例）
// ---------------------------------------------------------------------------

export const K_R05_OP_KINDS = [
  'install',
  'upgrade',
  'enable',
  'authorize',
  'pin',
  'release',
  'uninstall',
] as const;
export type OpKind = (typeof K_R05_OP_KINDS)[number];

export interface OpBase {
  readonly kind: OpKind;
  /** 人类可读的解释，会原样进入反例的 `repro` 便于复盘。 */
  readonly label?: string;
}

export type K_R05_Op =
  | (OpBase & { readonly kind: 'install'; readonly manifest: TemplateManifest })
  | (OpBase & { readonly kind: 'upgrade'; readonly id: string; readonly manifest: TemplateManifest; readonly manualConfirmed?: boolean })
  | (OpBase & { readonly kind: 'enable'; readonly id: string; readonly version?: string })
  | (OpBase & { readonly kind: 'authorize'; readonly id: string; readonly version?: string; readonly granted: readonly TemplatePermission[] })
  | (OpBase & { readonly kind: 'pin'; readonly taskId: string; readonly id: string; readonly version?: string })
  | (OpBase & { readonly kind: 'release'; readonly taskId: string })
  | (OpBase & { readonly kind: 'uninstall'; readonly id: string; readonly version?: string });

/** 轻量形状校验：轨迹来自外部（其他线/夹具）时先过这一关，避免坏输入被当成"通过了审计"。 */
export function validateOp(op: unknown): { readonly ok: true } | { readonly ok: false; readonly errors: readonly string[] } {
  const errors: string[] = [];
  if (typeof op !== 'object' || op === null) {
    return { ok: false, errors: ['op 不是对象'] };
  }
  const record = op as Record<string, unknown>;
  const kind = record['kind'];
  if (typeof kind !== 'string' || !(K_R05_OP_KINDS as readonly string[]).includes(kind)) {
    errors.push(`kind 非法：${String(kind)}`);
    return { ok: false, errors };
  }
  switch (kind) {
    case 'install':
    case 'upgrade':
      if (typeof record['manifest'] !== 'object' || record['manifest'] === null) errors.push(`${kind} 需要 manifest`);
      if (kind === 'upgrade' && typeof record['id'] !== 'string') errors.push('upgrade 需要 id');
      break;
    case 'enable':
    case 'uninstall':
      if (typeof record['id'] !== 'string') errors.push(`${kind} 需要 id`);
      break;
    case 'authorize':
      if (typeof record['id'] !== 'string') errors.push('authorize 需要 id');
      if (!Array.isArray(record['granted'])) errors.push('authorize 需要 granted 数组');
      break;
    case 'pin':
      if (typeof record['taskId'] !== 'string') errors.push('pin 需要 taskId');
      if (typeof record['id'] !== 'string') errors.push('pin 需要 id');
      break;
    case 'release':
      if (typeof record['taskId'] !== 'string') errors.push('release 需要 taskId');
      break;
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

// ---------------------------------------------------------------------------
// 审计端口（比 TemplateLifecycle 窄：便于用**故意损坏**的假探针自证检测器）
// ---------------------------------------------------------------------------

export interface FreezeProbePort {
  activeVersionOf(id: string): string | null;
  get(id: string, version?: string): InstalledTemplate | null;
  resolve(taskId: string): InstalledTemplate;
}

// ---------------------------------------------------------------------------
// 发现
// ---------------------------------------------------------------------------

export interface FreezeFinding {
  readonly invariant: InvariantId;
  readonly severity: FindingSeverity;
  readonly pluginId: string;
  readonly taskId: string | null;
  readonly pinnedVersion: string | null;
  readonly detail: string;
  /** 触发该发现的轨迹（操作 label / kind 序列），可原样重放。 */
  readonly repro: readonly string[];
}

interface PinRecord {
  readonly taskId: string;
  readonly id: string;
  readonly version: string;
  /** pin 时调用方是否显式给了版本。 */
  readonly explicitVersion: boolean;
  /** pin 当时该模版的在用版本（I5 对照面）。 */
  readonly activeAtPin: string | null;
}

// ---------------------------------------------------------------------------
// 审计器
// ---------------------------------------------------------------------------

export class FreezeAuditor {
  private readonly probe: FreezeProbePort;
  private readonly pins = new Map<string, PinRecord>();
  private readonly uninstalled = new Set<string>();
  private readonly trace: string[] = [];
  private readonly found: FreezeFinding[] = [];

  constructor(probe: FreezeProbePort) {
    this.probe = probe;
  }

  private record(label: string): void {
    this.trace.push(label);
  }

  private key(id: string, version: string): string {
    return `${id}@${version}`;
  }

  /** 记账：一个任务钉住了哪个版本（在**真实** pin 成功后调用）。 */
  notePin(taskId: string, id: string, version: string, explicitVersion: boolean, activeAtPin: string | null): void {
    this.record(`pin(${taskId}, ${id}${explicitVersion ? `@${version}` : ''})`);
    this.pins.set(taskId, { taskId, id, version, explicitVersion, activeAtPin });
  }

  /** 记账：一个任务被释放（此后不再要求它可被 resolve）。 */
  noteRelease(taskId: string): void {
    this.record(`release(${taskId})`);
    this.pins.delete(taskId);
  }

  /** 记账：卸载了某版本。 */
  noteUninstall(id: string, version: string): void {
    this.record(`uninstall(${id}@${version})`);
    this.uninstalled.add(this.key(id, version));
  }

  noteOther(label: string): void {
    this.record(label);
  }

  findings(): readonly FreezeFinding[] {
    return Object.freeze([...this.found]);
  }

  highSeverityFindings(): readonly FreezeFinding[] {
    return Object.freeze(this.found.filter((finding) => finding.severity === 'high'));
  }

  /** 在**当前**生命周期状态上跑全部不变量，把新发现并入台账。 */
  check(): readonly FreezeFinding[] {
    const fresh: FreezeFinding[] = [];
    for (const pin of this.pins.values()) {
      fresh.push(...this.checkPinResolvable(pin));
      fresh.push(...this.checkRetainedPinnedByIntact(pin));
      fresh.push(...this.checkBindingFrozen(pin));
      fresh.push(...this.checkNoStaleFallback(pin));
    }
    for (const key of this.uninstalled) {
      fresh.push(...this.checkUninstalledRevoked(key));
    }
    this.found.push(...fresh);
    return Object.freeze(fresh);
  }

  /** 所有不变量都干净时返回；否则抛错并把发现清单附在消息里（供测试当断言用）。 */
  assertClean(): void {
    if (this.found.length > 0) {
      const summary = this.found.map((finding) => `${finding.invariant}: ${finding.detail}`).join('\n');
      throw new Error(`K-R05 审计发现 ${String(this.found.length)} 条不变量违反：\n${summary}`);
    }
  }

  // --- 单条不变量 -----------------------------------------------------------

  private checkPinResolvable(pin: PinRecord): FreezeFinding[] {
    try {
      this.probe.resolve(pin.taskId);
      return [];
    } catch (error) {
      return [
        this.finding('I1-pin-resolvable', pin, `在途任务 ${pin.taskId} 的 resolve 失败：${msg(error)}`),
      ];
    }
  }

  private checkRetainedPinnedByIntact(pin: PinRecord): FreezeFinding[] {
    const snapshot = this.probe.get(pin.id, pin.version);
    if (snapshot === null) {
      return [
        this.finding(
          'I2-retained-version-pinnedby-intact',
          pin,
          `任务 ${pin.taskId} 仍钉着 ${pin.id}@${pin.version}，但该版本已不可取回（记录缺失）`,
        ),
      ];
    }
    if (!snapshot.pinnedBy.includes(pin.taskId)) {
      return [
        this.finding(
          'I2-retained-version-pinnedby-intact',
          pin,
          `任务 ${pin.taskId} 仍钉着 ${pin.id}@${pin.version}，但快照 pinnedBy=${JSON.stringify(snapshot.pinnedBy)} 不含该任务——pin 记账丢失`,
        ),
      ];
    }
    return [];
  }

  private checkBindingFrozen(pin: PinRecord): FreezeFinding[] {
    try {
      const snapshot = this.probe.resolve(pin.taskId);
      if (snapshot.version !== pin.version) {
        return [
          this.finding(
            'I4-binding-frozen-version-stable',
            pin,
            `任务 ${pin.taskId} 签发时为 ${pin.version}，现在 resolve 却返回 ${snapshot.version}——绑定被静默改写`,
          ),
        ];
      }
      return [];
    } catch {
      // I1 已就"取不到"报过，这里不重复。
      return [];
    }
  }

  private checkNoStaleFallback(pin: PinRecord): FreezeFinding[] {
    if (pin.explicitVersion) return [];
    if (pin.activeAtPin !== null && pin.version === pin.activeAtPin) return [];
    return [
      this.finding(
        'I5-new-pin-not-stale-fallback',
        pin,
        `任务 ${pin.taskId} 未指定版本，却在"在用版本=${String(pin.activeAtPin)}"时被绑到 ${pin.version}——静默回退到旧/非在用版本`,
      ),
    ];
  }

  private checkUninstalledRevoked(key: string): FreezeFinding[] {
    const observed = this.observedRecords.get(key);
    if (observed === undefined) {
      return []; // 卸载后已真正移除，无需再核（移除即最强撤权）。
    }
    if (observed.grantedPermissions.length !== 0 || observed.enabled) {
      return [
        {
          invariant: 'I3-uninstall-revokes-and-disables',
          severity: 'high',
          pluginId: observed.id,
          taskId: null,
          pinnedVersion: observed.version,
          detail: `卸载过的 ${key} 仍可观测到 enabled=${String(observed.enabled)} / grantedPermissions=${JSON.stringify(
            observed.grantedPermissions,
          )}——撤权不彻底`,
          repro: [...this.trace],
        },
      ];
    }
    return [];
  }

  /** 每次 check() 前由调用方刷新：把"当前可观测快照"喂进来（只针对卸载过的版本）。 */
  private observedRecords = new Map<string, InstalledTemplate>();

  observe(snapshot: InstalledTemplate): void {
    const key = this.key(snapshot.id, snapshot.version);
    if (this.uninstalled.has(key)) {
      this.observedRecords.set(key, snapshot);
    }
  }

  private finding(invariant: InvariantId, pin: PinRecord, detail: string): FreezeFinding {
    const severity = K_R05_INVARIANTS.find((entry) => entry.id === invariant)?.severity ?? 'high';
    return Object.freeze({
      invariant,
      severity,
      pluginId: pin.id,
      taskId: pin.taskId,
      pinnedVersion: pin.version,
      detail,
      repro: Object.freeze([...this.trace]),
    });
  }
}

function msg(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

// ---------------------------------------------------------------------------
// 轨迹驱动器：不改产品源码，只做"执行 + 记账 + 核对"
// ---------------------------------------------------------------------------

export interface TraceResult {
  readonly findings: readonly FreezeFinding[];
  /** 每步操作的真实结果或抛错（如实记录，不吞掉）。 */
  readonly journal: readonly { readonly label: string; readonly ok: boolean; readonly detail: string }[];
}

/**
 * 顺序执行一条操作轨迹，在每一步之后核对全部不变量。
 *
 * 若某步（如"应被拒"的新 pin）抛错，**如实记入 journal** 而**不中断**——反例的价值正在于
 * 把"该拒的没拒 / 不该败的败了"都留在账面。
 */
export function runTrace(lifecycle: TemplateLifecycle, ops: readonly K_R05_Op[]): TraceResult {
  const auditor = new FreezeAuditor(lifecycle);
  const journal: { label: string; ok: boolean; detail: string }[] = [];
  /** 本轨迹卸载过的 (id,version)：每步之后刷新它们的快照，供 I3 核对撤权是否彻底。 */
  const uninstalledKeys: { id: string; version: string }[] = [];

  const step = (label: string, fn: () => string): void => {
    try {
      journal.push({ label, ok: true, detail: fn() });
    } catch (error) {
      journal.push({ label, ok: false, detail: msg(error) });
    }
  };

  for (const op of ops) {
    const label = op.label ?? op.kind;
    switch (op.kind) {
      case 'install':
        step(label, () => {
          const snap = lifecycle.install(op.manifest);
          return `installed ${snap.id}@${snap.version}`;
        });
        break;
      case 'upgrade':
        step(label, () => {
          const snap = lifecycle.upgrade(op.id, op.manifest, { manualConfirmed: op.manualConfirmed });
          return `upgraded ${snap.id}@${snap.version}`;
        });
        break;
      case 'enable':
        step(label, () => {
          const snap = lifecycle.enable(op.id, op.version);
          return `enabled ${snap.id}@${snap.version}`;
        });
        break;
      case 'authorize':
        step(label, () => {
          const snap = lifecycle.authorize(op.id, op.version, op.granted);
          return `authorized ${snap.id}@${snap.version} [${snap.grantedPermissions.join(',')}]`;
        });
        break;
      case 'pin':
        step(label, () => {
          const activeBefore = lifecycle.activeVersionOf(op.id);
          const snap = lifecycle.pin(op.taskId, op.id, op.version);
          auditor.notePin(op.taskId, op.id, snap.version, op.version !== undefined, activeBefore);
          return `pinned ${op.taskId} -> ${snap.id}@${snap.version}`;
        });
        break;
      case 'release':
        step(label, () => {
          lifecycle.release(op.taskId);
          auditor.noteRelease(op.taskId);
          return `released ${op.taskId}`;
        });
        break;
      case 'uninstall':
        step(label, () => {
          const report = lifecycle.uninstall(op.id, op.version);
          auditor.noteUninstall(report.id, report.version);
          uninstalledKeys.push({ id: report.id, version: report.version });
          return `uninstalled ${report.id}@${report.version} (retained=${String(
            report.retainedForPinnedTasks,
          )}, removed=${String(report.removed)})`;
        });
        break;
    }
    // 刷新可观测快照（卸载过的版本），再核对。
    for (const key of uninstalledKeys) {
      const snapshot = lifecycle.get(key.id, key.version);
      if (snapshot !== null) auditor.observe(snapshot);
    }
    auditor.check();
  }

  return Object.freeze({ findings: auditor.findings(), journal: Object.freeze(journal) });
}

// ---------------------------------------------------------------------------
// 展示
// ---------------------------------------------------------------------------

export function formatFindings(findings: readonly FreezeFinding[]): string {
  if (findings.length === 0) return 'K-R05: 无不变量违反';
  return findings
    .map((finding) => `[${finding.severity}] ${finding.invariant} · ${finding.pluginId} · ${finding.detail}`)
    .join('\n');
}
