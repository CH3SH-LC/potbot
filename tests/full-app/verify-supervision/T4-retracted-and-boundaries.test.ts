/**
 * FA-VERIFY-SUPERVISION · T4 —— 复核监督「已撤回的三条旧判断」与「已写明的边界」。
 *
 * 【监督原文】README 第 3 行：
 * > 已撤回三条旧判断：**主聊天已接 scheduler，DeliverableHost 已接共享 Store 和恢复，
 * > 新预算已有生产消费者**；**DOC/RES 漏分派也已修**。
 *
 * 以及「已有成果与还不能声称的结论」表里的边界行：
 * > 真机 … **R169 明记 not_done；宿主 8766 与手机 8765 的 boot 身份不同**
 * > 门禁 … **12:35 基座 7169 passed、23 failed、28 skipped、BASE_EXIT=1**；全量尚不能报绿。
 * > **第七轮 7/8 变异有辨别力，B5 未咬红**；45 绿还包括确认已知缺口的断言。
 *
 * 【本文件的复核方式】能运行时核的**一律运行时核**（真 HTTP / 真内核 store），
 * 只有"历史设备/全量记录"这类**不可复现的既成事实**才读原件（读原件时把原件路径一并打印）。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { PRODUCT_BUDGET_ENV_KEYS } from '../../../apps/demo/server/budget-wiring.js';
import { ConversationHost } from '../../../apps/demo/server/conversation-host.js';
import { BUDGET_DIMENSIONS } from '../../../src/scheduler/budgets.js';
import { createDemoServer } from '../../../apps/demo/server/main.js';
import { getJson, listen, postJson, type Json, type Running } from './http-util.js';

const RUN_ROOT = mkdtempSync(join(tmpdir(), 'potbot-vsv-t4-'));
afterAll(() => {
  try {
    rmSync(RUN_ROOT, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响判据 */
  }
});

/** 主树根（`.dev-evidence` / `.task-manifest` 是**检出级**目录，工作树里没有）。 */
const WORKTREE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MAIN_ROOT = join(WORKTREE_ROOT, '..', '..', '..');

function budgetEnv(modelCalls = 100): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const dimension of BUDGET_DIMENSIONS) {
    env[PRODUCT_BUDGET_ENV_KEYS[dimension]] = String(dimension === 'model_calls' ? modelCalls : 10);
  }
  return env;
}

async function startProduct(name: string, env: NodeJS.ProcessEnv = {}): Promise<Running> {
  const demo = await createDemoServer({ POTBOT_RUN_DIR: join(RUN_ROOT, name), ...env });
  return listen(demo.server);
}

// ===========================================================================
// A. 已撤回的旧判断（逐条运行时可核）
// ===========================================================================

describe('T4-A 已撤回的旧判断：逐条运行时复核', () => {
  it('A1 主聊天已接 scheduler：一轮对话在内核里留下真 Run / WorkItem', async () => {
    const run = await startProduct('chat-scheduler');
    try {
      const conversationId = 'conv-t4';
      const posted = await postJson(run.base, `/api/conversations/${conversationId}/messages`, {
        clientId: 'client-t4',
        text: '把这次会议记成一份 Word',
      });
      expect(posted.status, JSON.stringify(posted.json)).toBe(202);

      const taskId = String(ConversationHost.taskIdOf(conversationId));
      let completion: Json | undefined;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const probe = await getJson(run.base, `/api/tasks/${taskId}/completion`);
        const counts = probe.json['counts'] as Json | undefined;
        if (probe.status === 200 && (counts?.['workItems'] ?? 0) >= 1) {
          completion = probe.json;
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
      expect(completion, '会话任务在 60 次轮询后仍无工作项 ⇒ scheduler 未接线').toBeDefined();
      expect((completion?.['counts'] as Json)['runs']).toBe(1);
      expect((completion?.['counts'] as Json)['workItems']).toBe(1);
    } finally {
      await run.close();
    }
  }, 60000);

  it('A2 DeliverableHost 已接共享 Store 和恢复：内核任务落在 host.store；换服务实例读得回', async () => {
    const runDir = join(RUN_ROOT, 'deliverable-shared-store');
    const demo = await createDemoServer({ POTBOT_RUN_DIR: runDir });
    const run = await listen(demo.server);
    let kernelTaskId = '';
    let contentDigest = '';
    try {
      const opened = await postJson(run.base, '/api/deliverables', {
        sessionId: 'sess-t4',
        deliverableId: 'deliv-t4',
        filename: 't4.xlsx',
        format: 'xlsx',
        title: 'T4 共享 store 复核',
      });
      expect(opened.status, JSON.stringify(opened.json)).toBe(201);
      kernelTaskId = String(opened.json['kernelTaskId'] ?? '');
      contentDigest = String(opened.json['contentDigest'] ?? '');
      expect(kernelTaskId.length).toBeGreaterThan(0);

      // 从 **KernelHost 的 store** 读（不是从 DeliverableHost 自己的读口）：
      // 内核任务在这里 ⇒ 交付宿主与内核共用同一份 store（不是各写一本）。
      const inHostStore = demo.host.store
        .snapshot()
        .tasks.some((row) => String(row.task_id) === kernelTaskId);
      expect(inHostStore, '内核 store 里没有该任务 ⇒ DeliverableHost 没接共享 store').toBe(true);
      expect(demo.deliverables?.completionOf('sess-t4')).toBeDefined();
    } finally {
      await run.close();
    }

    // **恢复**：换一个全新的服务实例（同一个 runDir），交付会话仍读得回来。
    const demo2 = await createDemoServer({ POTBOT_RUN_DIR: runDir });
    const run2 = await listen(demo2.server);
    try {
      const read = await getJson(run2.base, '/api/deliverables/sess-t4');
      expect(read.status, JSON.stringify(read.json)).toBe(200);
      expect(read.json['sessionId']).toBe('sess-t4');
      expect(read.json['filename']).toBe('t4.xlsx');
      // 内容身份也读得回来（不是"只恢复了一个空会话壳"）。
      expect(String(read.json['contentDigest'])).toBe(contentDigest);
    } finally {
      await run2.close();
    }
  }, 60000);

  it('A3 新预算已有生产消费者：产品入口真装配闸门；缺配置时如实 503（不静默无限）', async () => {
    const withBudget = await startProduct('budget-wired', budgetEnv());
    try {
      const status = await getJson(withBudget.base, '/api/session-adapters/status');
      expect(status.status).toBe(200);
      expect(status.json['budget']?.['configured']).toBe(true);
      expect(typeof status.json['budget']?.['describe']).toBe('string');
    } finally {
      await withBudget.close();
    }

    const withoutBudget = await startProduct('budget-unwired');
    try {
      const status = await getJson(withoutBudget.base, '/api/session-adapters/status');
      expect(status.json['budget']?.['configured']).toBe(false);
      const call = await postJson(withoutBudget.base, '/api/session-adapters/tool-call', {
        charges: { model_calls: 1 },
      });
      expect(call.status).toBe(503);
      expect(call.json['code']).toBe('budget_not_configured');
    } finally {
      await withoutBudget.close();
    }
  }, 60000);

  it('A4 DOC/RES 漏分派已修：两条路由都真被派发（不是兜底 404）', async () => {
    const run = await startProduct('doc-res-dispatch');
    try {
      const documentsStatus = await getJson(run.base, '/api/documents/status');
      expect(documentsStatus.status, JSON.stringify(documentsStatus.json)).toBe(200);

      const research = await postJson(run.base, '/api/research/query', { query: '季度预算' });
      expect(research.status, JSON.stringify(research.json)).toBe(200);
      expect(research.json['outcome']?.['status']).toBe('not-ready');

      // 对照：真正未挂载的前缀仍是 404 not_found（证明上面两个 200 是"真派发"而不是兜底放行）。
      const missing = await getJson(run.base, '/api/definitely-not-mounted-vsv');
      expect(missing.status).toBe(404);
      expect(missing.json['code']).toBe('not_found');
    } finally {
      await run.close();
    }
  }, 60000);
});

// ===========================================================================
// B. 监督写明的边界（读原件；不可复现的既成事实）
// ===========================================================================

describe('T4-B 监督写明的边界：与原件逐条比对', () => {
  const smokePath = join(
    MAIN_ROOT,
    '.claude',
    'worktrees',
    'e2e-device-smoke',
    '.dev-evidence',
    'device-smoke',
    'smoke-summary.json',
  );
  const supervisionPath = join(MAIN_ROOT, '.dev-evidence', 'supervision', 'potbot-ds', '20261003-1328.json');

  it('B1 真机 R169 明记 not_done；宿主 8766 与手机 8765 的 boot 身份不同', () => {
    expect(existsSync(smokePath), `原件缺失：${smokePath}`).toBe(true);
    const smoke = JSON.parse(readFileSync(smokePath, 'utf8')) as Json;

    // R169 必须是 not_done（不是"没写"、更不是 ok）。
    expect(smoke['notes'].join('\n')).toContain('R169');
    expect(smoke['notes'].join('\n')).toContain('not_done');
    expect(String(smoke['r169Manual']?.['status'] ?? '')).toBe('not_done');

    // 宿主服务端口 8766（要的 8765 被占）。
    const device = smoke['steps']?.['device'] as Json;
    const hostServerBootId = String(smoke['steps']?.['server']?.['bootId']);
    expect(smoke['steps']?.['server']?.['port']).toBe(8766);
    expect(smoke['steps']?.['server']?.['conflict']?.['wanted']).toBe(8765);

    // 手机侧（8765 映射）读回的 boot 身份 —— 与宿主服务的身份**不同**。
    const phoneBootId = String(device?.['status2']?.['bootReadBack'] ?? '');
    expect(phoneBootId.length).toBeGreaterThan(0);
    expect(hostServerBootId).not.toBe(phoneBootId);
    expect(String(device?.['hostHealth']?.['bootId'] ?? '')).toBe(phoneBootId);

    // APK 摘要与安装读回一致（内容身份不是"大概齐"）。
    const apk = String(smoke['steps']?.['apkBuild']?.['apkSha256'] ?? '');
    expect(apk).toBe('0b2d9283fc7e00d230095d79222de2fa58d6bd3f55dc47d432b82d3252d4f36e');
    expect(String(device?.['install']?.['apkSha256'] ?? '')).toBe(apk);
    expect(device?.['install']?.['matchesLocal']).toBe(true);
  });

  it('B2 基座全量仍非绿（12:35：7169 passed / 23 failed / 28 skipped / exit 1）；第七轮 45 绿、B5 未咬红', () => {
    expect(existsSync(supervisionPath), `原件缺失：${supervisionPath}`).toBe(true);
    const record = JSON.parse(readFileSync(supervisionPath, 'utf8')) as Json;
    const base = record['gates']?.['base'] as Json;
    expect(base['passed']).toBe(7169);
    expect(base['failed']).toBe(23);
    expect(base['skipped']).toBe(28);
    expect(base['base_exit']).toBe(1);
    expect(String(base['finished_local'])).toBe('12:35');

    const wave7 = record['gates']?.['wave7'] as Json;
    expect(String(wave7['test_summary'])).toContain('45passed');
    // B5 记的是 **16 passed**（未咬红），其余七次各有 failed。
    expect(String(wave7['mutation_summary'])).toContain('B5:16passed');

    // 监督自己写的边界也必须如实（不把旧候选的失败当成"当前仍失败"）。
    expect(String(base['boundary'])).toContain('older failing candidate');
  });
});
