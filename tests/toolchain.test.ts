import { describe, expect, it } from 'vitest';

import { PACKAGE_VERSION } from '../src/index.js';

/**
 * 工具链自检：只证明 TypeScript 能编译、vitest 能跑、ESM 解析（含 .js 后缀）正常。
 * 它不验证任何产品行为，不能作为 design-01 任何点的证据。
 */
describe('工具链自检', () => {
  it('能导入内核入口并读到版本号', () => {
    expect(PACKAGE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
