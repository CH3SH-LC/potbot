/**
 * F-R06 system-actions —— 本包专用 vitest 配置（只读用途，不修改仓根 vitest.config.ts）。
 *
 * 为什么需要它：仓根 `vitest.config.ts` 的 `include` 是 `src/**` 与 `tests/**`，锚定在
 * **仓库根**；本包（`apps/mobile-ui/`）不在其内，故本包自带的独立测试默认不会被收集。
 * 根配置属于受保护的公共文件，不在本包写权内（见 integrationRequests）。
 *
 * 它只做一件事：把 `root` 指回仓库根，并把 `include` 收窄到本包目录下的 `*.test.ts`。
 * 不改用任何网络 / 设备 / 时钟依赖，和根配置保持一致的 `environment` 与串行策略。
 *
 * 跑法见同目录 `README.md`：
 *   npx vitest run --config apps/mobile-ui/src/system-actions/vitest.system-actions.config.ts --reporter=default
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: resolve(here, '../../../..'),
  test: {
    include: ['apps/mobile-ui/src/system-actions/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
  },
});
