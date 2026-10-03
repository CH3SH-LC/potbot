/**
 * FA-WIRE-INDEX-BARREL —— **`src/index.ts` 零引用的定位判据**（把"定位"机器化，不靠注释）。
 *
 * ## 结论（先说判定，再给依据）
 *
 * 第五轮产品可达性普查（`tests/full-app/verify-reach-final/reachability.test.ts`）把
 * `src/index.ts` 列为 54 个不可达里**唯一的"入口类"模块**。本文件处置它，判定是：
 *
 * > **`src/index.ts` 零引用是"有意的定位"，不是遗漏。** 它当前是
 * > ①`PACKAGE_VERSION` 的单一权威源；②内核**对外入口的候选位**。
 * > 产品（`apps/demo/**`）与内核各模块一律**直接经子模块 barrel / 具体模块文件** import，
 * > 不经它。**产品侧 NOT 经它进入内核，这就是产品的真实形状。**
 *
 * **依据（本文件 §1 逐条机器化）**：
 * - `package.json` 是 `private: true`，且**没有声明任何入口字段**
 *   （`main` / `module` / `types` / `exports` 全缺）⇒ 本文件**不是任何解析路径的终点**；
 * - `src/**` 与 `apps/**` 的静态 import 图里，**没有任何文件 import `src/index.ts`**（§4）；
 * - 全仓唯一消费者是 `tests/toolchain.test.ts`（读 `PACKAGE_VERSION` 做工具链自检），
 *   即它现在服务的角色是"版本号"，不是"入口路由"。
 *
 * **因此本判据钉住的不是"它必须被用起来"，而是"它的定位不得漂移"**：
 * - §2 入口字段一旦被声明，必须与 `src/index.ts` 一致（指向别处 ⇒ 报红）；
 * - §3 `src/index.ts` 的导出面不得与子模块 barrel **同名不同源**地冲突（⇒ 报红）；
 * - §4 "零引用"是**登记在册**的状态；真接线时必须同步更新本文件（否则本文件报红），
 *   不允许悄悄从"定位"变成"另一条没人知道的边"。
 *
 * 为什么 §3 值得单独立判据：TS 对 `export * from A; export * from B;` 里 A、B 同名的符号
 * 会判 ambiguous 并**静默从导出面里删掉**——不报错、不警告。所以"同名不同源"是
 * **静默丢符号**的前置条件，必须能报红。
 *
 * ## 反向对照（证明判据不是恒绿）
 * §0 用**自造最小树 + 被改过的 package.json 对象**证明两条判据都咬得动：
 * 把入口字段指向别的模块 ⇒ ①报红；把同名符号放到两个不同源的 barrel ⇒ ②报红。
 * §3.3 再用**真实仓库数据**钉一条已登记的同名不同源（`defaultRequiresWakeup`）。
 *
 * ## 未做的事（不许含糊）
 * 本工作包**没有**改 `apps/demo/**`：把产品侧改成经 `src/index.js` 进入内核，
 * 属于"真接线"，会落在**别人的写权范围**且必须配真服务冒烟证据。本文件只处置
 * "零引用的定位"这一件事。仓库级 barrel 间的同名不同源普查（`censusCrossBarrelConflicts`）
 * 本轮实测**非空**（见 §3.3），但**不**在本文件里硬钉总数——那不是本包能修的，
 * 钉死会让无关的并行变更误红。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import {
  censusCrossBarrelConflicts,
  collectSurface,
  collectSurfaces,
  findImportersOf,
  findSurfaceConflicts,
  listBarrels,
  type Surface,
} from './barrel-surface.js';
import {
  checkEntryFieldAgreement,
  declaredEntryFields,
  entrySpecifiers,
  KERNEL_SOURCE_ENTRY,
} from './entry-contract.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');

const REAL_INDEX = 'src/index.ts';

/**
 * 自造夹具里"从 `apps/demo/server/main.ts` 指向内核入口"的说明符。
 *
 * 刻意**拼接**而不是写成整串字面量：本扫描器（与仓库里既有的普查器一样）是**正则**实现的，
 * 会把本文件里的夹具源码字符串也当成真的 import。若这里写成一整串，本测试文件自己就会被
 * 算成 `src/index.ts` 的 importer（实测过：会把 §4.2 变成假红）。
 */
const DEMO_TO_KERNEL_SPEC = ['..', '..', '..', 'src', 'index.js'].join('/');

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** 在临时目录里搭一棵最小树。 */
function makeTree(files: Readonly<Record<string, string>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'fa-index-barrel-'));
  tempDirs.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, text);
  }
  return dir;
}

const realIndexSource = readFileSync(join(ROOT, REAL_INDEX), 'utf8');
const realPkg: unknown = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

// ===========================================================================
// 0. 先证明判据咬得动（反向对照），再拿它去量真实仓库
// ===========================================================================

describe('0. 判据的辨别力（反向对照，自造数据）', () => {
  it('入口字段：指向 src/ 下别的模块 ⇒ 报红；指向内核入口（源码或构建产物）⇒ 放行', () => {
    const base = { name: 'potbot', version: '0.13.0' };

    // 未声明入口字段 ⇒ 无违规（这是被登记的现状，不是"检查器坏了"）
    expect(checkEntryFieldAgreement(base)).toEqual([]);

    // 正向：指向源码入口 / 构建产物入口 / 带子路径映射的 exports
    expect(checkEntryFieldAgreement({ ...base, main: './src/index.js' })).toEqual([]);
    expect(checkEntryFieldAgreement({ ...base, main: './src/index.ts' })).toEqual([]);
    expect(
      checkEntryFieldAgreement({ ...base, main: '.runtime/mobile-word-demo/build/src/index.js' }),
    ).toEqual([]);
    expect(
      checkEntryFieldAgreement({
        ...base,
        exports: { '.': './src/index.js', './package.json': './package.json' },
      }),
    ).toEqual([]);

    // 反向对照：指向 src/ 下**别的**模块 ⇒ 必须报红
    const wrongModule = checkEntryFieldAgreement({ ...base, main: './src/other.js' });
    expect(wrongModule.length, 'main 指向 src/other.js 必须报红').toBeGreaterThan(0);
    expect(wrongModule.join('\n')).toContain('src/other.js');

    // 反向对照：声明了入口字段，却没有任何说明符落在内核入口上 ⇒ 必须报红
    const noKernel = checkEntryFieldAgreement({ ...base, exports: { '.': './dist/entry.js' } });
    expect(noKernel.length, "exports 指向 dist/entry.js 必须报红").toBeGreaterThan(0);

    // 反向对照：条件导出（对象嵌套）也要能挖到里层的说明符
    const nested = checkEntryFieldAgreement({
      ...base,
      exports: { '.': { import: './src/adapters/index.js', default: './src/index.js' } },
    });
    expect(nested.length, '嵌套条件导出里混入别的 src 模块 ⇒ 报红').toBeGreaterThan(0);
  });

  it('导出面：同名不同源 ⇒ 报红（且必须跟随 `export *` 才挖得到）；同源 ⇒ 放行', () => {
    // 反例树：Shared 在 alpha 与 beta 各定义一次，index 从 beta 取。
    // alpha 的 barrel **只**用 `export * from './thing.js'`——不跟随 `export *` 就查不出来。
    const red = makeTree({
      'src/alpha/thing.ts': "export const Shared = 'alpha';\n",
      'src/alpha/index.ts': "export * from './thing.js';\n",
      'src/beta/thing.ts': "export const Shared = 'beta';\n",
      'src/beta/index.ts': "export { Shared } from './thing.js';\n",
      'src/index.ts': "export { Shared } from './beta/thing.js';\n",
    });
    const redIndex = collectSurface(red, REAL_INDEX);
    expect([...redIndex.keys()]).toEqual(['Shared']);
    expect(redIndex.get('Shared')).toEqual(['src/beta/thing.ts']);
    const redBarrels = collectSurfaces(red, ['src/alpha/index.ts', 'src/beta/index.ts']);
    expect(redBarrels.get('src/alpha/index.ts')?.get('Shared'), 'export * 必须被跟随').toEqual([
      'src/alpha/thing.ts',
    ]);
    const redConflicts = findSurfaceConflicts(redIndex, redBarrels);
    expect(redConflicts.map((c) => c.name)).toEqual(['Shared']);
    expect(redConflicts[0]?.barrel).toBe('src/alpha/index.ts');
    expect(redConflicts[0]?.barrelOrigins).toEqual(['src/alpha/thing.ts']);
    expect(redConflicts[0]?.referenceOrigins).toEqual(['src/beta/thing.ts']);

    // 正例树：同一个定义，经 index 与 barrel 两条路径导出 ⇒ 不算冲突
    const green = makeTree({
      'src/alpha/thing.ts': "export const Shared = 'alpha';\n",
      'src/alpha/index.ts': "export * from './thing.js';\n",
      'src/index.ts': "export { Shared } from './alpha/thing.js';\n",
    });
    const greenConflicts = findSurfaceConflicts(
      collectSurface(green, REAL_INDEX),
      collectSurfaces(green, ['src/alpha/index.ts']),
    );
    expect(greenConflicts).toEqual([]);
  });

  it('静态 import 图：自造树里能数出"谁 import 了入口"（判据不是恒空）', () => {
    const kernelSpec = DEMO_TO_KERNEL_SPEC;
    const tree = makeTree({
      'src/index.ts': 'export const PACKAGE_VERSION = "0.0.0";\n',
      'src/index.test.ts': "import { PACKAGE_VERSION } from './index.js';\nexport const t = PACKAGE_VERSION;\n",
      'apps/demo/server/main.ts':
        "import { PACKAGE_VERSION } from '" + kernelSpec + "';\nexport const x = PACKAGE_VERSION;\n",
    });
    const found = findImportersOf(tree, REAL_INDEX, ['src', 'apps']);
    expect(found.nonTest).toEqual(['apps/demo/server/main.ts']);
    expect(found.test).toEqual(['src/index.test.ts']);
    // 反向对照：把 import 行去掉 ⇒ 立刻数不到
    writeFileSync(join(tree, 'apps/demo/server/main.ts'), 'export const x = 1;\n');
    expect(findImportersOf(tree, REAL_INDEX, ['src', 'apps']).nonTest).toEqual([]);
  });
});

// ===========================================================================
// 1. 判定与依据：src/index.ts 导出什么、package.json 声明什么
// ===========================================================================

describe('1. 依据（先量事实，再下判定）', () => {
  it('src/index.ts 只导出一个东西：PACKAGE_VERSION（没有任何 `export ... from` 的 re-export）', () => {
    const exportLines = realIndexSource.match(/^export /gm) ?? [];
    expect(exportLines.length, '顶层 `export ` 行数').toBe(1);
    expect(realIndexSource).toContain("export const PACKAGE_VERSION = '");
    // 一条 re-export 都没有：入口没有把任何子模块挂出来
    expect(realIndexSource.includes('export * from')).toBe(false);
    expect(/^export\s+(?:type\s+)?\{[^}]*\}\s*from/m.test(realIndexSource)).toBe(false);
  });

  it('package.json **没有声明任何入口字段** ⇒ src/index.ts 不是任何解析路径的终点', () => {
    expect(declaredEntryFields(realPkg), 'main / module / types / exports 应全缺').toEqual([]);
    expect(entrySpecifiers(realPkg)).toEqual([]);
    const pkg = realPkg as Record<string, unknown>;
    expect(pkg['private'], '本包是 private，不发包').toBe(true);
    expect(checkEntryFieldAgreement(realPkg)).toEqual([]);
  });

  it('版本号单一权威源：PACKAGE_VERSION 与 package.json.version 逐字一致', () => {
    const version = (realPkg as Record<string, unknown>)['version'];
    const declared = /export const PACKAGE_VERSION = '([^']+)'/.exec(realIndexSource)?.[1];
    expect(declared).toBeDefined();
    expect(declared).toBe(version);
  });
});

// ===========================================================================
// 2. 定位判据 A：入口字段与本文件一致
// ===========================================================================

describe('2. 定位判据 A —— package.json 入口字段必须与 src/index.ts 一致', () => {
  it('真实 package.json：当前无入口字段 ⇒ 零违规（这就是被登记的现状）', () => {
    expect(checkEntryFieldAgreement(realPkg)).toEqual([]);
  });

  it('反向对照（承重证明）：把入口字段改成不一致 ⇒ 同一条判据立刻报红', () => {
    const drifted = { ...(realPkg as Record<string, unknown>), main: './src/kernel/other.js' };
    expect(checkEntryFieldAgreement(realPkg), '真实 package.json 是绿的').toEqual([]);
    expect(checkEntryFieldAgreement(drifted), '偏移后必须变红').not.toEqual([]);
  });
});

// ===========================================================================
// 3. 定位判据 B：导出面不得与子模块 barrel 同名不同源
// ===========================================================================

describe('3. 定位判据 B —— src/index.ts 的导出面不得与子模块 barrel 冲突', () => {
  // 子模块 barrel = `src/**/index.ts` **去掉内核入口自身**（自比自永远不冲突，留着会稀释判据）。
  const subBarrels = listBarrels(ROOT).filter((rel) => rel !== REAL_INDEX);
  const indexSurface: Surface = collectSurface(ROOT, REAL_INDEX);
  const subBarrelSurfaces = collectSurfaces(ROOT, subBarrels);

  it('src/index.ts 的导出面与全部子模块 barrel **零同名不同源冲突**', () => {
    expect(subBarrels.length, 'src/** 下应有子模块 barrel').toBeGreaterThan(0);
    expect(subBarrels).not.toContain(REAL_INDEX);
    const conflicts = findSurfaceConflicts(indexSurface, subBarrelSurfaces);
    expect(
      conflicts.map((c) => `${c.name} (index: ${c.referenceOrigins.join('+')} | ${c.barrel}: ${c.barrelOrigins.join('+')})`),
      '入口导出面与子模块 barrel 同名不同源 ⇒ 会静默丢符号，必须报红',
    ).toEqual([]);
  });

  it('入口的那个唯一导出（PACKAGE_VERSION）不被任何子模块 barrel 导出 ⇒ 无歧义', () => {
    expect([...indexSurface.keys()]).toEqual(['PACKAGE_VERSION']);
    const owners = [...subBarrelSurfaces].filter(([, surface]) => surface.has('PACKAGE_VERSION')).map(([rel]) => rel);
    expect(owners, 'PACKAGE_VERSION 只应由 src/index.ts 提供').toEqual([]);
  });

  it('真实仓库里"同名不同源"确实存在（本判据不是对着空集发誓）——已登记 1 条', () => {
    const census = censusCrossBarrelConflicts(ROOT);
    expect(census.size, '仓库级 barrel 间同名不同源应非空').toBeGreaterThan(0);

    // 已登记的、具体的、真实存在的一条：同名函数在两个包里各定义一次
    const registered = census.get('defaultRequiresWakeup');
    expect(registered, 'defaultRequiresWakeup 是已登记的同名不同源').toBeDefined();
    expect([...registered!.keys()].sort()).toEqual(['src/fake/delivery.ts', 'src/inbox/wakeup.ts']);
    expect(registered!.get('src/fake/delivery.ts')).toEqual(['src/fake/index.ts']);
    expect(registered!.get('src/inbox/wakeup.ts')).toEqual(['src/inbox/index.ts']);

    // 但**入口**不参与任何一条冲突：冲突全在子模块 barrel 之间
    const indexKeys = new Set(indexSurface.keys());
    const involvingIndex = [...census.keys()].filter((name) => indexKeys.has(name));
    expect(involvingIndex, '入口导出面不得卷入同名不同源').toEqual([]);
  });
});

// ===========================================================================
// 4. "零引用"是登记在册的定位，不是遗漏
// ===========================================================================

describe('4. 零引用：登记状态 + 唯一的真实消费者', () => {
  it('src/** 与 apps/** 的静态 import 图里，**没有任何文件** import src/index.ts', () => {
    const found = findImportersOf(ROOT, REAL_INDEX, ['src', 'apps']);
    expect(
      found.nonTest,
      '产品/内核若真要经包入口进入内核，这里必须非空；现在空 = 产品走的是子模块，这是登记的定位',
    ).toEqual([]);
    expect(found.test).toEqual([]);
  });

  it('全仓唯一消费者是 tests/toolchain.test.ts（读 PACKAGE_VERSION）——即它的角色是"版本号"，不是"路由"', () => {
    const fromTests = findImportersOf(ROOT, REAL_INDEX, ['tests']);
    expect(fromTests.nonTest).toEqual([]);
    expect(fromTests.test).toEqual(['tests/toolchain.test.ts']);
  });

  it('入口文件把这条定位**写在源码里**（不是只在测试注释里）', () => {
    // 注释与实现必须一致：历史上被独立复核点过名（"注释称统一 re-export，实际只导出版本号"）。
    expect(/零引用/.test(realIndexSource), '入口注释应写明"零引用"这条定位').toBe(true);
    expect(
      /tests\/full-app\/index-barrel/.test(realIndexSource),
      '入口注释应指向本判据文件，便于真接线时同步更新登记',
    ).toBe(true);
  });
});
