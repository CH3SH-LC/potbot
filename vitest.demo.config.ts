import { defineConfig } from 'vitest/config';

/**
 * Demo 专用测试配置：让 `apps/demo/**`、`tests/demo/**` 与 S5 的 DOCX 模板测试
 * 被测试运行器真正发现。原 `vitest.config.ts` 只覆盖 src/tests，不能拿来冒充
 * 新宿主已被检查。
 *
 * 保留原配置的 `fileParallelism: false` 纪律。
 */
export default defineConfig({
  test: {
    include: [
      'apps/demo/**/*.test.ts',
      'tests/demo/**/*.test.ts',
      'src/artifacts/templates/docx.test.ts',
    ],
    environment: 'node',
    fileParallelism: false,
  },
});
