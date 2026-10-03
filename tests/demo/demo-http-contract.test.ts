/**
 * S6 验收用例 ③：**活服务的黑盒合同检查（只读）**。
 *
 * ## 默认 **跳过**，显式开关才真跑（与 S4 的 `apps/demo/model/live.test.ts` 同一模式）
 *
 * 这一组需要一个**真在跑的服务**（默认 `http://127.0.0.1:8765`）。在**全量回归**
 * （`node node_modules/vitest/vitest.mjs run --configLoader native`，其 `include` 覆盖
 * `tests/**`）里服务通常不在，所以它**必须默认跳过并写明原因**，否则会把全量回归永久打红。
 *
 * **跳过 ≠ 放宽**：设 `POTBOT_LIVE_SERVICE=1` 且服务在跑时，下面每一项都**真跑**；
 * 服务不可达则**失败**（不是跳过）—— 显式开启就意味着"我预期它在这里"。
 *
 *   POTBOT_LIVE_SERVICE=1 pnpm exec vitest run tests/demo/demo-http-contract.test.ts --config vitest.demo.config.ts
 *
 * 本文件**不提交生成请求**（不消耗 live 模型额度）；会调模型的端到端检查在
 * `scripts/demo/verify-demo.mjs` 与夹具套件 `demo-model-failure.test.ts`。
 */

import { beforeAll, describe, expect, it } from 'vitest';

const LIVE_ENABLED = process.env['POTBOT_LIVE_SERVICE'] === '1';
const BASE_URL = process.env['DEMO_BASE_URL'] ?? 'http://127.0.0.1:8765';

let reachable = false;
let health: Record<string, unknown> | null = null;
let probeError = '';

async function getJson(path: string, timeoutMs = 3000): Promise<{ status: number; body: unknown; raw: string }> {
  const response = await fetch(`${BASE_URL}${path}`, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json' },
  });
  const raw = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  return { status: response.status, body, raw };
}

beforeAll(async () => {
  if (!LIVE_ENABLED) return;
  try {
    const response = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(3000) });
    const raw = await response.text();
    health = JSON.parse(raw) as Record<string, unknown>;
    reachable = true;
  } catch (error) {
    probeError = String(error);
    reachable = false;
  }
});

describe.skipIf(!LIVE_ENABLED)(
  `[未执行] 活服务黑盒合同 —— 默认跳过：设 POTBOT_LIVE_SERVICE=1 且 ${BASE_URL} 有服务时才真跑`,
  () => {
    it('[前置] 显式开启后服务必须可达（不可达即失败，不静默跳过）', () => {
      expect(reachable, `[未通过] 已设 POTBOT_LIVE_SERVICE=1，但 ${BASE_URL} 不可达：${probeError}`).toBe(
        true,
      );
    });

    it('GET /health 形状符合合同 v1，且不泄漏密钥', () => {
      const body = health ?? {};
      for (const field of ['ready', 'modelConfigured', 'modelVerified']) {
        expect(typeof body[field], `health.${field} 必须是 boolean`).toBe('boolean');
      }
      expect(typeof body['buildId'], 'health.buildId 必须是 string').toBe('string');
      expect(typeof body['bootId'], 'health.bootId 必须是 string').toBe('string');

      // ready 只证明服务就绪；模型"已配置"不等于"实调通过"——两者必须可区分。
      const modelConfigured = body['modelConfigured'] === true;
      const modelVerified = body['modelVerified'] === true;
      expect(
        modelVerified && !modelConfigured,
        'modelVerified 为真而 modelConfigured 为假：语义矛盾',
      ).toBe(false);

      const secret = process.env['ANTHROPIC_AUTH_TOKEN'];
      if (secret && secret.length >= 8) {
        expect(JSON.stringify(body).includes(secret), 'health 响应回显了 AUTH_TOKEN').toBe(false);
      }
    });

    it('未知 taskId：返回 unknown，而不是成功或旧文件', async () => {
      const { status, body } = await getJson('/api/tasks/no-such-task-s6-probe');
      expect([200, 404]).toContain(status);
      if (status === 200) {
        const record = body as Record<string, unknown>;
        expect(record['status'], '未知任务不得报 ready/accepted/running').toBe('unknown');
        expect(record['artifact'] ?? null, '未知任务不得携带产物引用').toBeNull();
      }
    });

    it('未知 artifactId 下载：不得返回 200 + 旧文件', async () => {
      const response = await fetch(`${BASE_URL}/api/artifacts/no-such-artifact-s6-probe/download`, {
        signal: AbortSignal.timeout(3000),
      });
      expect(response.status, '未知产物必须 404；返回 200 意味着可能拿旧文件顶包').toBe(404);
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(bytes.byteLength, '404 响应不应携带产物字节').toBeLessThan(4096);
    });

    // 覆盖缺口（显式登记，不写空断言）：
    //  - 「同 requestId 不同输入 ⇒ 409」「同 requestId 同输入 ⇒ 不二次调模型」需要先有一条
    //    已存在的任务（提交会消耗 live 模型额度），故只在 scripts/demo/verify-demo.mjs
    //    与夹具套件 demo-model-failure.test.ts 里判。
  },
);
