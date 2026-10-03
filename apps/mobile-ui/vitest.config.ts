/**
 * F 线（mobile UI）专用 vitest 配置 —— 只读用途，不修改仓根 `vitest.config.ts`。
 *
 * ## 为什么需要它
 *
 * 仓根 `vitest.config.ts` 的 `include` 是 `['src/**\/*.test.ts', 'tests/**\/*.test.ts']`，
 * **锚定在仓库根**。因此：
 *   - `tests/mobile-ui/**` 会被根配置收集（`tests/**` 命中）；
 *   - `apps/mobile-ui/**` **不会**被根配置收集（既不在 `src/` 也不在 `tests/` 下）——
 *     F-R06 曾实测：`npx vitest run apps/mobile-ui/src/system-actions/__probe.test.ts`
 *     返回 “No test files found”(exit 1)，只能靠包内局部配置绕过。
 *
 * 本文件把 F 线的**全部**测试收进**一条命令**：
 *   - `apps/mobile-ui/**\/*.test.ts` —— 与源码同目录的包内测试（如
 *     `apps/mobile-ui/src/system-actions/system-actions.test.ts`）；
 *   - `tests/mobile-ui/**\/*.test.ts` —— 本线 `tests/` 下的独立验收测试。
 *
 * 根配置属于受保护的公共文件，不在本单元写权内（见 F01 / F-R06 的 integrationRequests）。
 *
 * ## 跑法（仓根执行）
 *
 * ```
 * npx vitest run --config apps/mobile-ui/vitest.config.ts --reporter=basic
 * # 只跑一个文件：
 * npx vitest run --config apps/mobile-ui/vitest.config.ts apps/mobile-ui/src/system-actions/system-actions.test.ts --reporter=basic
 * ```
 *
 * ## 与根配置的取值一致性
 *
 * `root` 指回仓根，使 glob、路径解析、`contracts/mobile-v1/*` 子进程调用都与根配置同口径；
 * `environment: 'node'`、`fileParallelism: false` 与根配置保持一致（F-R04 的计时型用例
 * 依赖串行执行以保持确定性，不得在此开启文件级并发）。
 *
 * 注意：本文件**不设置用例级时限**（那会改变构建配置并破坏冻结点不变量，见
 * `tests/acceptance/office/v8-contract-conformance.test.ts` R53.6）；需要时限的用例自带。
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/** 本文件所在目录 = `apps/mobile-ui/`（相对定位，不依赖 cwd）。 */
const here = dirname(fileURLToPath(import.meta.url));
/** 仓库根 = 上溯两层。 */
const repoRoot = resolve(here, '..', '..');

export default defineConfig({
  root: repoRoot,
  test: {
    include: ['apps/mobile-ui/**/*.test.ts', 'tests/mobile-ui/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
  },
});
