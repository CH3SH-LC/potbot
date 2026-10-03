import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 单元测试与模块同目录（src/**），验收测试集中在 tests/acceptance/**
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    // 验收场景依赖确定性时序，禁止测试框架自身的并发干扰
    fileParallelism: false,
    // 注意：**本文件不得设置用例级时限**（R53.6，由 `v8-contract-conformance.test.ts` 机器化
    // 断言，且是**朴素字符串检查**——连注释里出现那个词都会让它变红）。构建配置是冻结身份的
    // 一部分；重型用例要时限就**自己带**（见 `tests/acceptance/office/v6-fixture-audit.test.ts`
    // 的 §E/§F：每个用例显式给 30 s）。
  },
});
