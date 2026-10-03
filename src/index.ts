/**
 * potbot 内核包入口 —— **定位已登记（机器化），不是待补全的骨架**。
 *
 * ## 它现在是什么
 * - `PACKAGE_VERSION` 的**单一权威源**（与 `package.json` 的 `version`、`docs/PROGRESS.md`
 *   头部逐字一致；由 `tests/toolchain.test.ts` 引用校验）。这是它当前**唯一**的导出。
 * - 内核**对外入口的候选位**：将来若把内核作为包发布，`package.json` 的
 *   `main` / `exports` 应指向本文件（或其构建产物，见 `tsconfig.demo.json` 的
 *   outDir ⇒ `.runtime/mobile-word-demo/build/src/index.js`）。
 *
 * ## 它现在为什么"零引用"——有意的，不是遗漏
 * `package.json` **没有声明** `main` / `module` / `types` / `exports`（本包 `private: true`），
 * 所以本文件当前**不是任何解析路径的终点**；产品（`apps/demo/**`）与内核各模块一律
 * **直接经子模块 barrel 或具体模块文件**互相 import。全仓唯一引用者是
 * `tests/toolchain.test.ts`（读版本号做工具链自检）——即它现在的角色是"版本号"，
 * 不是"入口路由"。这条定位由 `tests/full-app/index-barrel/index-barrel.test.ts`
 * 机器化钉住，不是靠这段注释：
 * 1. 入口字段一旦被声明，必须与 `src/index.ts` 一致（指向别处 ⇒ 报红）；
 * 2. 本文件的导出面不得与子模块 barrel **同名不同源**地冲突（TS 会静默丢符号 ⇒ 报红）；
 * 3. "零引用"是登记在册的状态——真把产品接到本入口时，必须同步更新该判据，
 *    不允许悄悄从"定位"变成"另一条没人知道的边"。
 *
 * 归属：主智能体独占（工程入口 / 集成面）。子智能体不要修改本文件——
 * 需要对外暴露新模块时向主智能体提出，由主智能体统一在此登记。
 */

/** 与 package.json 的 version 及 docs/PROGRESS.md 头部保持一致的单一版本号。 */
export const PACKAGE_VERSION = '0.13.0';
