/**
 * F-UI01 shell —— 导航注册表的独立测试。
 *
 * 断言：按规范顺序枚举每个模块的屏幕 id，并**拒绝**重复 / 缺失 / 未登记 id。
 */

import { describe, expect, it } from 'vitest';

import {
  buildRegistry,
  canonicalScreenOrder,
  entryScreens,
  isRegisteredScreen,
  listScreens,
  moduleOfScreen,
  MODULE_SCREENS,
  RegistryError,
  screenDefOf,
  screensOfModule,
  SCREEN_REGISTRY,
  validateRegistry,
  type ModuleId,
  type ModuleScreenDeclaration,
  type ScreenId,
} from '../../../apps/mobile-ui/src/shell/index.js';

const mod = (module: ModuleId, screens: readonly ScreenId[]): ModuleScreenDeclaration => ({ module, screens });

const codeOf = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof RegistryError ? err.code : 'not-registry-error';
  }
};

describe('规范屏幕表', () => {
  it('28 个屏幕，顺序为 C01…C05 / T01…T08 / F01…F05 / M01…M10', () => {
    expect(listScreens()).toHaveLength(28);
    expect(canonicalScreenOrder()).toEqual([
      'C01', 'C02', 'C03', 'C04', 'C05',
      'T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T07', 'T08',
      'F01', 'F02', 'F03', 'F04', 'F05',
      'M01', 'M02', 'M03', 'M04', 'M05', 'M06', 'M07', 'M08', 'M09', 'M10',
    ]);
  });

  it('id 无重复，且 listScreens 与 canonicalScreenOrder 一致', () => {
    const ids = listScreens().map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(canonicalScreenOrder());
  });

  it('每个屏幕的 entry 与 id 前缀一致（C→chat / T→group / F→file / M→mine）', () => {
    const expected: Record<string, string> = { C: 'chat', T: 'group', F: 'file', M: 'mine' };
    for (const s of listScreens()) {
      expect(expected[s.id[0] ?? '']).toBe(s.entry);
    }
  });

  it('原型覆盖层级分布与设计页面地图一致（12 screen / 2 embedded / 8 sheet / 6 absent）', () => {
    const byLevel = (level: string): string[] => listScreens().filter((s) => s.designLevel === level).map((s) => s.id);
    expect(byLevel('screen')).toHaveLength(12);
    expect(byLevel('embedded').sort()).toEqual(['M03', 'T08']);
    expect(byLevel('sheet').sort()).toEqual(['C04', 'C05', 'F04', 'M04', 'M08', 'M09', 'T04', 'T07']);
    expect(byLevel('absent').sort()).toEqual(['C03', 'F05', 'M10', 'T03', 'T05', 'T06']);
  });
});

describe('内置注册表（模块 → 屏幕）', () => {
  it('已通过校验，覆盖全部 28 屏且各登记一次', () => {
    expect(validateRegistry(MODULE_SCREENS)).toEqual([]);
    const declared = MODULE_SCREENS.flatMap((d) => d.screens);
    expect(new Set(declared).size).toBe(28);
    expect([...declared].sort()).toEqual([...canonicalScreenOrder()].sort());
  });

  it('模块归属正确', () => {
    expect(moduleOfScreen('C01')).toBe('chat');
    expect(moduleOfScreen('C03')).toBe('conversations');
    expect(moduleOfScreen('T01')).toBe('groups');
    expect(moduleOfScreen('T04')).toBe('decisions');
    expect(moduleOfScreen('T07')).toBe('system-actions');
    expect(moduleOfScreen('F05')).toBe('files');
    expect(moduleOfScreen('M01')).toBe('shell');
    expect(moduleOfScreen('M03')).toBe('memory');
    expect(moduleOfScreen('M06')).toBe('templates');
    expect(moduleOfScreen('M10')).toBe('settings');
  });

  it('每模块屏幕数：shell 1 / chat 3 / conversations 2 / groups 4 / decisions 2 / system-actions 2 / files 5 / memory 3 / templates 2 / settings 4', () => {
    const count = (m: ModuleId): number => screensOfModule(m).length;
    expect(count('shell')).toBe(1);
    expect(count('chat')).toBe(3);
    expect(count('conversations')).toBe(2);
    expect(count('groups')).toBe(4);
    expect(count('decisions')).toBe(2);
    expect(count('system-actions')).toBe(2);
    expect(count('files')).toBe(5);
    expect(count('memory')).toBe(3);
    expect(count('templates')).toBe(2);
    expect(count('settings')).toBe(4);
  });

  it('四入口根屏幕为 C01/T01/F01/M01（规范顺序）', () => {
    expect(entryScreens().map((s) => s.id)).toEqual(['C01', 'T01', 'F01', 'M01']);
  });

  it('isRegisteredScreen / screenDefOf 行为正确', () => {
    expect(isRegisteredScreen('C01')).toBe(true);
    expect(isRegisteredScreen('Z99')).toBe(false);
    expect(isRegisteredScreen(123)).toBe(false);
    expect(screenDefOf('C01').route).toBe('home');
    expect(codeOf(() => screenDefOf('Z99' as ScreenId))).toBe('not-registry-error');
  });
});

describe('注册表拒绝坏数据', () => {
  it('重复屏幕 id → duplicate-screen-id', () => {
    // 把 C01 同时挂到 shell 与 chat：不新增模块，只制造屏幕 id 重复。
    const dup = MODULE_SCREENS.map((d) => (d.module === 'shell' ? mod('shell', ['M01', 'C01']) : d));
    expect(codeOf(() => buildRegistry(dup))).toBe('duplicate-screen-id');
  });

  it('重复模块 → duplicate-module', () => {
    expect(codeOf(() => buildRegistry([...MODULE_SCREENS, mod('shell', [])]))).toBe('duplicate-module');
  });

  it('缺失屏幕 id → missing-screen-id', () => {
    const missingT08 = MODULE_SCREENS.map((d) => (d.module === 'groups' ? mod('groups', ['T01', 'T02', 'T03']) : d));
    expect(codeOf(() => buildRegistry(missingT08))).toBe('missing-screen-id');
    const problems = validateRegistry(missingT08);
    expect(problems.some((p) => p.code === 'missing-screen-id')).toBe(true);
  });

  it('未登记的屏幕 id → unknown-screen-id', () => {
    // 用 chat 声明替换一个屏幕为规范表外的 'Z99'：既不新增重复模块，也把首条问题钉在 unknown-screen-id。
    const withUnknown = MODULE_SCREENS.map((d) =>
      d.module === 'chat' ? mod('chat', ['C01', 'C04', 'Z99' as unknown as ScreenId]) : d,
    );
    expect(codeOf(() => buildRegistry(withUnknown))).toBe('unknown-screen-id');
  });

  it('空注册表 → empty-registry', () => {
    expect(codeOf(() => buildRegistry([]))).toBe('empty-registry');
  });
});

describe('注册表查询', () => {
  it('SCREEN_REGISTRY 与内置声明一致', () => {
    expect(SCREEN_REGISTRY.modules).toEqual(MODULE_SCREENS);
    expect(SCREEN_REGISTRY.screens).toHaveLength(28);
    expect(SCREEN_REGISTRY.order).toEqual(canonicalScreenOrder());
  });

  it('未知屏幕查询抛 ShellError unknown-screen（经 registry 共享的错误码）', () => {
    let name: string | null = null;
    try {
      moduleOfScreen('Z99' as ScreenId);
    } catch (err) {
      name = err instanceof Error ? err.name : 'no-error';
    }
    expect(name).toBe('ShellError');
  });
});
