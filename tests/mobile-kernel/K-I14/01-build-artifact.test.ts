/**
 * K-I14 验证 ①：打包脚本产出真实、自包含、可加载的单文件 ESM。
 *
 * 断言对象是 **运行 build.mjs 之后的磁盘产物**（不是源码）：
 *   - 子进程退出码 0（真实退出码，非编造）；
 *   - dist/bootstrap.mjs 存在且非空；
 *   - 产物内**没有任何静态 import**（"单文件 / 自包含"的硬判据）；
 *   - build-info.json 的体积与磁盘实际体积一致（元数据不撒谎）；
 *   - 产物可被 Node `import()` 且含全部必须导出键。
 *
 * 反向对照：一个刻意构造的"多文件"文本（含 static import）必须被判为外部依赖。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  BUILD_INFO_PATH,
  BUNDLE_PATH,
  bundleSize,
  loadBundle,
  readBuildInfo,
  runBuild,
  staticImports,
} from './fixtures.js';

const REQUIRED_EXPORTS = [
  'createBootstrapRuntime',
  'createLocalUiBridge',
  'createManualClock',
  'validateCommand',
  'scanPayload',
  'assertCaller',
  'isAllowedOrigin',
  'normalizeOrigin',
  'bootstrapError',
  'isBootstrapError',
  'BOOTSTRAP_ERROR_CODES',
  'COMMAND_OPERATIONS',
] as const;

describe('K-I14 打包脚本：真实产出', () => {
  it('`node build.mjs` 退出码为 0，并打印产物体积', async () => {
    const run = await runBuild();
    expect(run.stderr, run.stderr).toBe('');
    expect(run.code, `stderr=${run.stderr}`).toBe(0);
    expect(run.stdout).toMatch(/bootstrap\.mjs/);
    expect(run.stdout).toMatch(/bytes/);
  });

  it('产物 bootstrap.mjs 非空，且 build-info.json 的体积与磁盘一致', async () => {
    const size = await bundleSize();
    expect(size).toBeGreaterThan(1000);

    const info = await readBuildInfo();
    expect(info.bytes).toBe(size);
    expect(info.format).toBe('esm');
    expect(info.outfile).toBe('apps/mobile-kernel/bootstrap/dist/bootstrap.mjs');
    // 诚实标记：产物是宿主 Node 加载，不是真机。
    expect(info.hostLoad).toBe('node');
    expect(info.onDevice).toBe(false);
  });

  it('产物自包含：文本内无任何静态 import（单文件判据）', async () => {
    const source = await readFile(BUNDLE_PATH, 'utf8');
    expect(staticImports(source)).toEqual([]);
    // 反向对照：一段带 static import 的文本必须被同一个检测器判为非自包含。
    expect(staticImports("import { x } from './y.js';\nconst a = 1;")).toEqual([
      "import { x } from './y.js';",
    ]);
    // 动态 import() 不算静态依赖，不应被误报。
    expect(staticImports("await import('./z.js');")).toEqual([]);
  });

  it('产物可被 Node 加载，且含全部必须导出键', async () => {
    const bundle = await loadBundle();
    for (const key of REQUIRED_EXPORTS) {
      expect(key in bundle, `缺少导出键 ${key}`).toBe(true);
    }
    const info = await readBuildInfo();
    for (const key of info.requiredExports) {
      expect(info.exportKeys).toContain(key);
    }
  });

  it('build-info.json 记录的工具链是 esbuild 或 tsc-emit（二选一，不虚报）', async () => {
    const info = await readBuildInfo();
    expect(['esbuild', 'tsc-emit']).toContain(info.mode);
    expect(info.tool.length).toBeGreaterThan(0);
  });
});

describe('K-I14 打包脚本：产物路径常量健全', () => {
  it('BUILD_INFO_PATH 与 BUNDLE_PATH 同目录，均落在 dist/ 下', () => {
    expect(BUNDLE_PATH.endsWith('bootstrap.mjs')).toBe(true);
    expect(BUILD_INFO_PATH.endsWith('build-info.json')).toBe(true);
    expect(path.dirname(BUNDLE_PATH)).toBe(path.dirname(BUILD_INFO_PATH));
    expect(path.basename(path.dirname(BUNDLE_PATH))).toBe('dist');
  });
});
