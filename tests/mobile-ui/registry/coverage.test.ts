/**
 * F-I20 —— 导航注册表覆盖核对：shell registry（F-I02）vs design-07 §2 页面地图。
 *
 * 这是「协调者维护的导航清单」的诚实性闸门：模块增删时，若某屏未登记 / 登记两次 /
 * 指向不存在的模块 / 与设计页地图漂移，此测试必须变红。它只读消费 F-I02 的公开 API
 * （`apps/mobile-ui/src/shell/index.js`），不复制、不重推注册表数据。
 *
 * 核对四件事：
 *   1. 注册表**按规范顺序**枚举每个模块屏幕 id，且**每屏恰好一次**（无重复 / 无遗漏），
 *      并与 design-07 §2 页面地图的 28 个页面 id **逐一相等**；
 *   2. **四个入口**（对话 / 群组 / 文件 / 我的）根屏幕 C01/T01/F01/M01 全部被登记；
 *   3. **settings 模块**（M07–M10）与**原型专属屏**（`settings`，见 F-R01 coverage-report）
 *      被如实处理：原型专属屏**不得**被误登记为设计屏幕 / 路由；
 *   4. 注册表**没有条目指向不存在的模块**（静态模块名单 + 文件系统目录存在性）。
 *
 * 设计权威与原型事实均为**只读解析**：
 *   - `docs/design/design-07-正式发布版App界面与交互.md` §2 表格 → 28 个页面 id；
 *   - `tests/mobile-ui/F-R01/coverage-report.json` 的 `prototypeOnlyScreens` → 原型专属屏。
 *
 * 未验证层：不渲染、不接触 `KernelClient`、不读设备；本测试不证明任何屏幕已实现或已真机可用。
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  MODULE_SCREENS,
  SCREEN_REGISTRY,
  canonicalScreenOrder,
  entryScreens,
  isRegisteredScreen,
  listScreens,
  moduleOfScreen,
  screensOfModule,
} from '../../../apps/mobile-ui/src/shell/index.js';
import { parseDesignPageMap } from '../F-R01/design-coverage.js';

// ---------------------------------------------------------------------------
// 路径与独立期望（独立复述，不用被测模块自己的常量）
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const DESIGN_DOC = resolve(REPO_ROOT, 'docs', 'design', 'design-07-正式发布版App界面与交互.md');
const COVERAGE_REPORT = resolve(REPO_ROOT, 'tests', 'mobile-ui', 'F-R01', 'coverage-report.json');
const UI_SRC_DIR = resolve(REPO_ROOT, 'apps', 'mobile-ui', 'src');

/** design-07 §2 的四个主入口。 */
const FOUR_ENTRIES = ['chat', 'group', 'file', 'mine'] as const;
/** 四入口根屏幕（规范顺序 C01 / T01 / F01 / M01）。 */
const FOUR_ENTRY_ROOTS = ['C01', 'T01', 'F01', 'M01'] as const;
/** 四入口屏幕数（C5 / T8 / F5 / M10）。 */
const ENTRY_SCREEN_COUNTS: Readonly<Record<string, number>> = Object.freeze({
  chat: 5,
  group: 8,
  file: 5,
  mine: 10,
});
/** 拥有屏幕的 mobile-ui 模块（= apps/mobile-ui/src/<module>/ 目录名），独立复述。 */
const EXPECTED_MODULES = [
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
] as const;

// ---------------------------------------------------------------------------
// 只读解析辅助
// ---------------------------------------------------------------------------

/** 解析 design-07 §2 页面地图，返回规范顺序的 28 个页面 id（复用 F-R01 的解析器，不重写）。 */
function readDesignPageIds(): readonly string[] {
  expect(existsSync(DESIGN_DOC), `design-07 页面地图不存在: ${DESIGN_DOC}`).toBe(true);
  const lines = readFileSync(DESIGN_DOC, 'utf8').split(/\r?\n/);
  return parseDesignPageMap(lines).map((p) => p.id);
}

/** 读取 F-R01 coverage-report 记录的原型专属屏名单（原型有、设计页地图无）。 */
function readPrototypeOnlyScreens(): readonly string[] {
  expect(existsSync(COVERAGE_REPORT), `F-R01 coverage-report 不存在: ${COVERAGE_REPORT}`).toBe(true);
  const raw = JSON.parse(readFileSync(COVERAGE_REPORT, 'utf8')) as { prototypeOnlyScreens?: unknown };
  expect(Array.isArray(raw.prototypeOnlyScreens), 'coverage-report.prototypeOnlyScreens 应为数组').toBe(true);
  return (raw.prototypeOnlyScreens as readonly unknown[]).map(String);
}

// ---------------------------------------------------------------------------
// 1. registry vs design-07 §2 页面地图
// ---------------------------------------------------------------------------

describe('F-I20 registry vs design-07 §2 页面地图', () => {
  it('design-07 §2 解析出 28 个页面 id，与注册表规范顺序逐一相等', () => {
    const designIds = readDesignPageIds();
    expect(designIds).toHaveLength(28);
    expect(canonicalScreenOrder()).toEqual(designIds);
  });

  it('注册表恰好枚举 28 屏，每屏各登记一次（无重复 / 无遗漏）', () => {
    const declared = MODULE_SCREENS.flatMap((d) => d.screens);
    expect(declared).toHaveLength(28);
    expect(new Set(declared).size).toBe(28); // 跨模块无重复
    expect([...declared].sort()).toEqual([...canonicalScreenOrder()].sort());

    // 与设计页地图双向一致：注册表无表外 id，设计页无未登记 id。
    const designIds = readDesignPageIds();
    const designSet = new Set(designIds);
    const declaredAsStrings: readonly string[] = declared;
    expect(declaredAsStrings.every((id) => designSet.has(id))).toBe(true);
    expect(designIds.every((id) => declaredAsStrings.includes(id))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. 模块枚举：每模块一次，且无条目指向不存在的模块
// ---------------------------------------------------------------------------

describe('F-I20 模块枚举（每模块恰好一次；无条目指向不存在的模块）', () => {
  it('模块集合 == 已知 10 个拥有屏幕的 mobile-ui 模块，各登记一次', () => {
    const mods = MODULE_SCREENS.map((d) => d.module) as readonly string[];
    expect(new Set(mods).size).toBe(mods.length); // 无重复模块
    expect([...mods].sort()).toEqual([...EXPECTED_MODULES].sort());
  });

  it('无注册表条目指向不存在的模块（静态名单 + 文件系统目录）', () => {
    for (const decl of MODULE_SCREENS) {
      expect(EXPECTED_MODULES).toContain(decl.module);
      const dir = resolve(UI_SRC_DIR, decl.module);
      expect(existsSync(dir), `注册表指向的模块目录不存在: ${dir}`).toBe(true);
      expect(statSync(dir).isDirectory()).toBe(true);
    }
  });

  it('每个屏幕归属唯一模块，moduleOf 覆盖全部 28 屏', () => {
    const owner = new Map<string, string>();
    for (const decl of MODULE_SCREENS) {
      for (const screen of decl.screens) {
        expect(owner.has(screen), `屏幕被两个模块登记: ${screen}`).toBe(false);
        owner.set(screen, decl.module);
      }
    }
    expect(owner.size).toBe(28);
    for (const id of canonicalScreenOrder()) {
      expect(SCREEN_REGISTRY.moduleOf.get(id)).toBe(owner.get(id));
    }
  });

  it('每模块登记屏幕与 screensOfModule（规范顺序）一致，且顺序即声明顺序', () => {
    for (const decl of MODULE_SCREENS) {
      expect(screensOfModule(decl.module).map((s) => s.id)).toEqual([...decl.screens]);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. 四个入口
// ---------------------------------------------------------------------------

describe('F-I20 四个入口被登记', () => {
  it('四入口根屏幕 C01/T01/F01/M01 全部登记且顺序正确', () => {
    expect(entryScreens().map((s) => s.id)).toEqual([...FOUR_ENTRY_ROOTS]);
    for (const root of FOUR_ENTRY_ROOTS) {
      expect(isRegisteredScreen(root)).toBe(true);
    }
  });

  it('每个登记屏幕的 entry 属于四入口，且 id 前缀与 entry 一致', () => {
    const prefix: Readonly<Record<string, string>> = { C: 'chat', T: 'group', F: 'file', M: 'mine' };
    for (const s of listScreens()) {
      expect(FOUR_ENTRIES).toContain(s.entry);
      expect(prefix[s.id[0]!]).toBe(s.entry);
    }
  });

  it('四个入口各有屏幕覆盖（chat5/group8/file5/mine10），且根屏幕模块归属正确', () => {
    for (const entry of FOUR_ENTRIES) {
      expect(listScreens().filter((s) => s.entry === entry)).toHaveLength(ENTRY_SCREEN_COUNTS[entry]!);
    }
    expect(moduleOfScreen('C01')).toBe('chat');
    expect(moduleOfScreen('T01')).toBe('groups');
    expect(moduleOfScreen('F01')).toBe('files');
    expect(moduleOfScreen('M01')).toBe('shell');
  });
});

// ---------------------------------------------------------------------------
// 4. settings 模块与原型专属屏
// ---------------------------------------------------------------------------

describe('F-I20 settings 模块与原型专属屏被如实处理', () => {
  it('settings 模块登记 design-07 的 M07–M10 四页', () => {
    expect(screensOfModule('settings').map((s) => s.id)).toEqual(['M07', 'M08', 'M09', 'M10']);
  });

  it('原型专属屏（settings）未被误登记为设计屏幕 / 路由', () => {
    const protoOnly = readPrototypeOnlyScreens();
    expect(protoOnly).toContain('settings'); // 原型有、设计页地图无
    const designIds = new Set(readDesignPageIds());
    const routes = new Set(listScreens().map((s) => s.route));
    for (const name of protoOnly) {
      expect(designIds.has(name), `原型专属屏不应出现在设计页地图: ${name}`).toBe(false);
      expect(isRegisteredScreen(name), `原型专属屏不应注册为设计屏幕: ${name}`).toBe(false);
      expect(routes.has(name), `原型专属屏不应占用设计路由名: ${name}`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. 查询 API 与内置注册表一致
// ---------------------------------------------------------------------------

describe('F-I20 registry 查询一致性', () => {
  it('listScreens / canonicalScreenOrder / SCREEN_REGISTRY 相互一致', () => {
    expect(listScreens().map((s) => s.id)).toEqual(canonicalScreenOrder());
    expect(listScreens()).toHaveLength(28);
    expect(SCREEN_REGISTRY.modules).toEqual(MODULE_SCREENS);
    expect(SCREEN_REGISTRY.order).toEqual(canonicalScreenOrder());
    expect(SCREEN_REGISTRY.byId.size).toBe(28);
  });

  it('屏幕 route 唯一（无一路由名指向两屏）', () => {
    const routes = listScreens().map((s) => s.route);
    expect(new Set(routes).size).toBe(routes.length);
  });
});
