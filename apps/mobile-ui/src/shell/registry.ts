/**
 * F-UI01 shell —— 导航注册表（single screen registry）。
 *
 * 全 App **唯一**登记「模块 → 屏幕 id」的地方。要求（本单元验收）：
 *   1. 按**规范顺序**枚举每个模块的屏幕 id；
 *   2. 拒绝**重复** id（同一屏幕被两个模块/同一模块登记两次）；
 *   3. 拒绝**缺失** id（规范屏幕表里有、注册表没登记）；
 *   4. 拒绝**未登记**的 id（注册表里出现规范表外的 id）。
 *
 * 本模块零依赖（仅只读 screens.ts 的规范屏幕表），纯数据 + 纯函数；不渲染、不引框架、
 * 不碰 `KernelClient`、不读时钟/随机数。模块归属严格对齐 FRONTEND.md 的十个并行包
 * （F01–F10 + F-R06 system-actions），根屏幕 M01「我的」归壳层（shell）。
 */

import {
  CANONICAL_SCREEN_ORDER,
  ENTRY_ROOT_SCREEN,
  SCREEN_DEFS,
  ShellError,
  isScreenId,
  type ScreenDef,
  type ScreenId,
} from './screens.js';

// ---------------------------------------------------------------------------
// 模块
// ---------------------------------------------------------------------------

/** 拥有屏幕的 mobile-ui 模块（= `apps/mobile-ui/src/<module>/` 目录名）。 */
export type ModuleId =
  | 'shell'
  | 'chat'
  | 'conversations'
  | 'groups'
  | 'decisions'
  | 'system-actions'
  | 'files'
  | 'memory'
  | 'templates'
  | 'settings';

export interface ModuleScreenDeclaration {
  readonly module: ModuleId;
  /** 该模块拥有的规范屏幕 id，按模块内规范顺序排列。 */
  readonly screens: readonly ScreenId[];
}

/**
 * 内置注册表：模块 → 屏幕。覆盖 design-07 §2 页面地图全部 28 个页面 id，各登记一次。
 * 归属依据 FRONTEND.md 各包独占目录及包内含页（如 decisions 覆盖 T04/T05、files 覆盖 F01–F05）。
 */
export const MODULE_SCREENS: readonly ModuleScreenDeclaration[] = Object.freeze([
  { module: 'shell', screens: ['M01'] },
  { module: 'chat', screens: ['C01', 'C04', 'C05'] },
  { module: 'conversations', screens: ['C02', 'C03'] },
  { module: 'groups', screens: ['T01', 'T02', 'T03', 'T08'] },
  { module: 'decisions', screens: ['T04', 'T05'] },
  { module: 'system-actions', screens: ['T06', 'T07'] },
  { module: 'files', screens: ['F01', 'F02', 'F03', 'F04', 'F05'] },
  { module: 'memory', screens: ['M02', 'M03', 'M04'] },
  { module: 'templates', screens: ['M05', 'M06'] },
  { module: 'settings', screens: ['M07', 'M08', 'M09', 'M10'] },
]);

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

export type RegistryErrorCode =
  | 'duplicate-screen-id'
  | 'missing-screen-id'
  | 'unknown-screen-id'
  | 'unknown-module'
  | 'duplicate-module'
  | 'empty-registry';

export class RegistryError extends Error {
  readonly code: RegistryErrorCode;
  readonly detail: readonly string[];
  constructor(code: RegistryErrorCode, message: string, detail: readonly string[] = []) {
    super(message);
    this.name = 'RegistryError';
    this.code = code;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// 校验 / 构建
// ---------------------------------------------------------------------------

const MODULE_IDS: readonly ModuleId[] = Object.freeze([
  'shell',
  'chat',
  'conversations',
  'groups',
  'decisions',
  'system-actions',
  'files',
  'memory',
  'templates',
  'settings',
]);

function isModuleId(value: unknown): value is ModuleId {
  return typeof value === 'string' && (MODULE_IDS as readonly string[]).includes(value);
}

interface Problem {
  readonly code: RegistryErrorCode;
  readonly message: string;
  readonly detail: readonly string[];
}

function collectProblems(declarations: readonly ModuleScreenDeclaration[]): readonly Problem[] {
  const problems: Problem[] = [];
  const moduleSeen = new Set<string>();
  const screenOwner = new Map<string, ModuleId>();

  for (const decl of declarations) {
    if (!isModuleId(decl.module)) {
      problems.push({ code: 'unknown-module', message: `未知模块: ${String(decl.module)}`, detail: [String(decl.module)] });
      continue;
    }
    if (moduleSeen.has(decl.module)) {
      problems.push({ code: 'duplicate-module', message: `模块重复登记: ${decl.module}`, detail: [decl.module] });
    }
    moduleSeen.add(decl.module);

    for (const screen of decl.screens) {
      if (!isScreenId(screen)) {
        problems.push({ code: 'unknown-screen-id', message: `未登记的屏幕 id: ${String(screen)}`, detail: [String(screen)] });
        continue;
      }
      const owner = screenOwner.get(screen);
      if (owner !== undefined) {
        problems.push({
          code: 'duplicate-screen-id',
          message: `屏幕 id 重复: ${screen}（已在 ${owner} 登记）`,
          detail: [screen, owner, decl.module],
        });
        continue;
      }
      screenOwner.set(screen, decl.module);
    }
  }

  const missing = CANONICAL_SCREEN_ORDER.filter((id) => !screenOwner.has(id));
  if (missing.length > 0) {
    problems.push({ code: 'missing-screen-id', message: `注册表缺失屏幕 id: ${missing.join(', ')}`, detail: missing });
  }

  return problems;
}

/**
 * 校验注册表声明，返回问题列表（空数组 = 通过）。
 * 不抛错，便于测试逐类断言；`buildRegistry` 会在此之上抛出结构化错误。
 */
export function validateRegistry(declarations: readonly ModuleScreenDeclaration[]): readonly RegistryError[] {
  if (declarations.length === 0) {
    return [new RegistryError('empty-registry', '注册表为空', [])];
  }
  return collectProblems(declarations).map((p) => new RegistryError(p.code, p.message, p.detail));
}

export interface ScreenRegistry {
  readonly modules: readonly ModuleScreenDeclaration[];
  /** 规范顺序的全量屏幕定义。 */
  readonly screens: readonly ScreenDef[];
  readonly byId: ReadonlyMap<ScreenId, ScreenDef>;
  readonly moduleOf: ReadonlyMap<ScreenId, ModuleId>;
  /** 规范屏幕顺序（28 项），与 `screens` 一致。 */
  readonly order: readonly ScreenId[];
}

function freezeDeclarations(declarations: readonly ModuleScreenDeclaration[]): readonly ModuleScreenDeclaration[] {
  return Object.freeze(
    declarations.map((d) => Object.freeze({ module: d.module, screens: Object.freeze([...d.screens]) as readonly ScreenId[] })),
  );
}

/**
 * 由模块声明构建注册表。任一不变量被破坏（重复 / 缺失 / 未登记 / 未知模块）即抛
 * `RegistryError`，绝不静默吞掉坏数据。
 */
export function buildRegistry(declarations: readonly ModuleScreenDeclaration[]): ScreenRegistry {
  if (declarations.length === 0) {
    throw new RegistryError('empty-registry', '注册表为空', []);
  }
  const problems = collectProblems(declarations);
  if (problems.length > 0) {
    const first = problems[0];
    if (first === undefined) throw new RegistryError('empty-registry', '注册表为空', []);
    throw new RegistryError(first.code, first.message, problems.flatMap((p) => p.detail));
  }

  const moduleOf = new Map<ScreenId, ModuleId>();
  for (const decl of declarations) {
    for (const screen of decl.screens) moduleOf.set(screen, decl.module);
  }

  const screens: readonly ScreenDef[] = Object.freeze(
    CANONICAL_SCREEN_ORDER.map((id) => {
      const def = SCREEN_DEFS.find((s) => s.id === id);
      if (def === undefined) throw new ShellError('unknown-screen', `规范屏幕表缺 ${id}`, [id]);
      return def;
    }),
  );
  const byId = new Map(screens.map((s) => [s.id, s]));

  return {
    modules: freezeDeclarations(declarations),
    screens,
    byId,
    moduleOf,
    order: CANONICAL_SCREEN_ORDER,
  };
}

/** 内置注册表（单例，已校验）。 */
export const SCREEN_REGISTRY: ScreenRegistry = buildRegistry(MODULE_SCREENS);

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

/** 规范顺序的全量屏幕定义。 */
export function listScreens(): readonly ScreenDef[] {
  return SCREEN_REGISTRY.screens;
}

/** 规范屏幕 id 顺序。 */
export function canonicalScreenOrder(): readonly ScreenId[] {
  return SCREEN_REGISTRY.order;
}

/** 某模块拥有的屏幕定义（按规范顺序）。 */
export function screensOfModule(module: ModuleId): readonly ScreenDef[] {
  return SCREEN_REGISTRY.screens.filter((s) => SCREEN_REGISTRY.moduleOf.get(s.id) === module);
}

/** 屏幕归属的模块；未登记 ⇒ 抛 `unknown-screen`。 */
export function moduleOfScreen(id: ScreenId): ModuleId {
  const owner = SCREEN_REGISTRY.moduleOf.get(id);
  if (owner === undefined) {
    throw new ShellError('unknown-screen', `未登记的屏幕 id: ${String(id)}`, [String(id)]);
  }
  return owner;
}

/** 屏幕是否已在注册表登记。 */
export function isRegisteredScreen(value: unknown): value is ScreenId {
  return typeof value === 'string' && SCREEN_REGISTRY.byId.has(value as ScreenId);
}

/** 取屏幕定义；未登记 ⇒ 抛 `unknown-screen`。 */
export function screenDefOf(id: ScreenId): ScreenDef {
  const found = SCREEN_REGISTRY.byId.get(id);
  if (found === undefined) {
    throw new ShellError('unknown-screen', `未登记的屏幕 id: ${String(id)}`, [String(id)]);
  }
  return found;
}

/** 四入口根屏幕（按规范顺序：C01 / T01 / F01 / M01）。 */
export function entryScreens(): readonly ScreenDef[] {
  const roots = new Set<ScreenId>(Object.values(ENTRY_ROOT_SCREEN));
  return SCREEN_REGISTRY.screens.filter((s) => roots.has(s.id));
}
