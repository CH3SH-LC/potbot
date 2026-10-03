/**
 * K-I14 验证 ③：tsc-emit 回退路径是**活的**，不是死代码。
 *
 * 场景：本机根 node_modules 未直接链接 esbuild（它只是 vite/vitest 的传递依赖）。
 * 若某天 esbuild 不可用，build.mjs 会退回 `tsc emit + 工厂注册表打包`。这条回退必须
 * 同样产出**可加载、可驱动**的单文件 ESM，否则"回退"只是名义存在。
 *
 * 为避免扰动主产物（dist/bootstrap.mjs 走 esbuild），本用例用 KERNEL_BUILD_OUT 把
 * 回退产物写到临时目录，只在临时目录里断言，跑完删除。
 *
 * 诚实边界：同样是宿主 Node 加载，非 arm64 真机。
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  loadBundle,
  makeCommand,
  recordingModule,
  runBuild,
  staticImports,
  type LoadedBundle,
} from './fixtures.js';

let workDir = '';
let fallbackPath = '';
let fallbackInfoPath = '';
let bundle: LoadedBundle;

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'ki14-tsc-'));
  fallbackPath = path.join(workDir, 'bootstrap.mjs');
  fallbackInfoPath = path.join(workDir, 'build-info.json');

  const run = await runBuild({
    KERNEL_BUILD_FORCE_TSC: '1',
    KERNEL_BUILD_OUT: fallbackPath,
  });
  expect(run.code, `stderr=${run.stderr}`).toBe(0);
  bundle = await loadBundle(fallbackPath);
});

afterAll(async () => {
  if (workDir.length > 0) await rm(workDir, { recursive: true, force: true });
});

describe('K-I14 tsc 回退：产出单文件 ESM 且可加载驱动', () => {
  it('回退产物自包含（无静态 import）', async () => {
    const source = await readFile(fallbackPath, 'utf8');
    expect(staticImports(source)).toEqual([]);
  });

  it('回退产物记录 mode=tsc-emit', async () => {
    const info = JSON.parse(await readFile(fallbackInfoPath, 'utf8')) as { mode: string; bytes: number };
    expect(info.mode).toBe('tsc-emit');
    expect(info.bytes).toBeGreaterThan(1000);
  });

  it('回退产物可加载，且能驱动 start -> submit -> event -> stop', async () => {
    const runtime = bundle.createBootstrapRuntime({ clock: bundle.createManualClock() });
    const { module, calls } = recordingModule('ki14-tsc-echo', ['create']);
    runtime.registerModule(module);
    runtime.start();

    const bridge = bundle.createLocalUiBridge(runtime);
    const event = await bridge.submit({ origin: 'app://local', kind: 'ui-webview' }, makeCommand());

    expect(event.status).toBe('succeeded');
    expect(event.resultRef).toBe('artifact:ki14-tsc-echo@1');
    expect(calls).toHaveLength(1);

    runtime.stop();
    expect(runtime.state).toBe('stopped');
  });

  it('回退产物对同名符号不串扰（validate 的 MUTATION_OPERATIONS 与 runtime 内部常量各用各的）', async () => {
    // validate 导出 MUTATION_OPERATIONS；runtime 内部另有一个同名的模块级 Set。
    // 扁平拼接会 "Identifier already declared"；工厂注册表把两者隔在不同作用域。
    const mutations = bundle.validateCommand({
      schemaVersion: 'mobile-v1',
      commandId: 'cmd-mut',
      operation: 'mutate',
      idempotencyKey: 'idem-mut',
      payload: { taskId: 'task-1' },
    });
    // 缺 expectedRevision ⇒ mutate 分支校验必须失败，证明 validate 的常量真的生效。
    expect(mutations.ok).toBe(false);
  });
});
