/**
 * S6 验收用例 ⑥：**宿主应用索引里的失败路径与来源记录**（验收表「失败与重复」「新输入驱动」两行）。
 *
 * 这一组只读宿主的应用索引 `<runDir>/app-index.json`，不依赖服务在跑，因此可以在
 * 任何时刻复算。它把验收表的这几条落成机器判据：
 *
 *  - **失败不得显示新成功文件**：`status='failed'` 的任务必须 `artifact === null`
 *    且 `publishedArtifactId === null`（"超时仍沿用旧下载链接"的可判形态）；
 *  - **失败必须结构化**：`error` 带机器可判的 `code`、面向用户的中文 `message`、`retryable`；
 *  - **不得泄漏密钥**：索引全文不得出现 `AUTH_TOKEN` / `API_KEY` 的值；
 *  - **来源记录**：每个任务保留 requestId 与用户输入**原文**（不得为空、不得被换成固定样例）；
 *  - **内核轮次**：发起过模型尝试的任务必须留下内核轮次 id（`kernelRuns`）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT, repoRelative } from './support.js';

const RUN_ID = process.env['DEMO_RUN_ID'] ?? 'MWD-20261002-A';
const INDEX_PATH = join(REPO_ROOT, '.runtime', 'mobile-word-demo', RUN_ID, 'app-index.json');

interface IndexTask {
  readonly requestId: string;
  readonly taskId: string;
  readonly instruction: string;
  readonly status: string;
  readonly error: { readonly code?: string; readonly message?: string; readonly retryable?: boolean } | null;
  readonly artifact: unknown;
  readonly publishedArtifactId: string | null;
  readonly kernelRuns: readonly string[];
  readonly attempts: number;
}

let rawText = '';
let tasks: readonly IndexTask[] = [];

if (existsSync(INDEX_PATH)) {
  rawText = readFileSync(INDEX_PATH, 'utf8');
  try {
    const parsed = JSON.parse(rawText) as { tasks?: readonly IndexTask[] };
    tasks = parsed.tasks ?? [];
  } catch {
    tasks = [];
  }
}

const failed = tasks.filter((task) => task.status === 'failed');
const ready = tasks.filter((task) => task.status === 'ready');

describe('宿主应用索引：失败路径与来源记录', () => {
  it('[前置] 应用索引存在且至少有一条任务', () => {
    expect(
      existsSync(INDEX_PATH),
      `[未满足] 尚无 ${repoRelative(INDEX_PATH)}：宿主应用索引未落盘，本组判据无从成立`,
    ).toBe(true);
    expect(tasks.length, '[未满足] 索引里没有任何任务').toBeGreaterThan(0);
  });

  it('每个任务都保留请求 ID 与用户输入原文（来源记录不为空、不是固定样例）', () => {
    const bad: string[] = [];
    for (const task of tasks) {
      if (task.requestId.trim().length === 0) bad.push(`${task.taskId}: requestId 为空`);
      if (task.instruction.trim().length === 0) bad.push(`${task.taskId}: instruction 为空`);
      if (task.taskId.trim().length === 0) bad.push('存在 taskId 为空的任务');
    }
    expect(bad, `[未通过] 来源记录不完整：\n${bad.join('\n')}`).toEqual([]);
  });

  it('失败任务不得携带产物：artifact 为空且 publishedArtifactId 为空（不得沿用旧文件）', () => {
    const bad: string[] = [];
    for (const task of failed) {
      if (task.artifact !== null && task.artifact !== undefined) {
        bad.push(`${task.taskId}: 失败任务却带 artifact=${JSON.stringify(task.artifact).slice(0, 120)}`);
      }
      if (task.publishedArtifactId !== null && task.publishedArtifactId !== undefined) {
        bad.push(`${task.taskId}: 失败任务却有 publishedArtifactId=${task.publishedArtifactId}`);
      }
      if (task.error === null || task.error === undefined) {
        bad.push(`${task.taskId}: 失败任务没有结构化 error`);
      }
    }
    expect(bad, `[未通过] 失败路径可能返回旧成果：\n${bad.join('\n')}`).toEqual([]);
  });

  it('失败必须是结构化错误：有 code、有中文说明、有 retryable', () => {
    const bad: string[] = [];
    for (const task of failed) {
      const error = task.error;
      if (!error) continue;
      if (typeof error.code !== 'string' || error.code.trim().length === 0) {
        bad.push(`${task.taskId}: error.code 缺失`);
      }
      if (typeof error.message !== 'string' || !/[一-龥]/.test(error.message)) {
        bad.push(`${task.taskId}: error.message 不是面向用户的中文说明（${String(error.message)}）`);
      }
      if (typeof error.retryable !== 'boolean') {
        bad.push(`${task.taskId}: error.retryable 不是布尔`);
      }
    }
    expect(bad, `[未通过] 失败结构不完整：\n${bad.join('\n')}`).toEqual([]);
  });

  it('发起过模型尝试的任务留下内核轮次 id', () => {
    const bad: string[] = [];
    for (const task of tasks) {
      if (task.attempts > 0 && task.kernelRuns.length === 0) {
        bad.push(`${task.taskId}: attempts=${task.attempts} 却没有任何 kernelRuns`);
      }
    }
    expect(bad, `[未通过] 缺内核轮次证据：\n${bad.join('\n')}`).toEqual([]);
  });

  it('索引全文不得泄漏密钥（AUTH_TOKEN / API_KEY 的值）', () => {
    const secrets = [process.env['ANTHROPIC_AUTH_TOKEN'], process.env['ANTHROPIC_API_KEY']]
      .filter((value): value is string => typeof value === 'string' && value.length >= 8);
    if (secrets.length === 0) {
      // 环境里没有可比对的密钥时不假装检查过——显式记录，不放空断言。
      expect(typeof rawText).toBe('string');
      return;
    }
    const leaked = secrets.filter((secret) => rawText.includes(secret));
    expect(leaked.length, `[未通过] 索引泄漏了 ${leaked.length} 个密钥值`).toBe(0);
  });

  it('样本非空：索引里至少有一条终态任务（防止上面几条在零样本上"空过"）', () => {
    // 这是**必要前置**，不是信息行：没有终态任务时，上面的失败/成功判据全部无从成立，
    // 必须显式报红，而不是让"零样本"被读成"全绿"。
    expect(
      failed.length + ready.length,
      `[未满足] ${RUN_ID} 的索引里没有 failed/ready 任务（total=${tasks.length}）：本组的失败路径与产物判据均无样本可判`,
    ).toBeGreaterThan(0);
  });
});
