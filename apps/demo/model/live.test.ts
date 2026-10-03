/**
 * S4 —— **live 真实模型调用**（与 fixture 严格分开）。
 *
 * 默认**跳过**：只有显式设置 `POTBOT_LIVE=1` 才会执行，并且**消耗冲刺真实请求额度**，
 * 每次请求都写进 `.runtime/mobile-word-demo/<runId>/model-ledger.jsonl`。
 *
 * 按执行方案，真实请求由**主协调者统一触发**。触发命令：
 *   POTBOT_LIVE=1 pnpm exec vitest run apps/demo/model/live.test.ts --config vitest.demo.config.ts
 *
 * 降级阶梯（主协调者 2026-10-02 授权，最多 3 次真实请求）：
 *   1. 按合同参数（max_tokens=1600 / 45s / 每任务 ≤2 次尝试）先打；
 *   2. 若报 `model_response_truncated`，端口内部自动重试 1 次（第 2 次尝试）；
 *   3. 仍截断 → 才允许在**传输层**降级加 `thinking:{type:"disabled"}` 再打 1 次。
 *   合同三个数值（1600 tokens / 45s / ≤2 次尝试）**一律不动**。
 */

import { describe, expect, it } from 'vitest';
import { ModelCallError } from './errors.js';
import { createModelPort, describeModelConfig, type DraftInput } from './port.js';

const LIVE_ENABLED = process.env.POTBOT_LIVE === '1';
const INSTRUCTION = '为新生读书会写一封温暖的邀请函，不编造时间地点和报名联系方式。';

interface StageRecord {
  readonly stage: 'contract_params' | 'thinking_disabled';
  readonly ok: boolean;
  readonly code?: string;
  readonly message?: string;
  readonly titleChars?: number;
  readonly paragraphCount?: number;
  readonly paragraphChars?: readonly number[];
  readonly thinkingDisabled: boolean;
}

describe.skipIf(!LIVE_ENABLED)('live 真实模型调用（消耗额度）', () => {
  it(
    '分阶段真实生成：先合同参数，确认截断后才降级关闭 thinking',
    async () => {
      const before = describeModelConfig(process.env);
      expect(before.configured, `模型未配置，缺少：${before.missing.join('、')}`).toBe(true);

      const stages: StageRecord[] = [];
      let draft: DraftInput | null = null;
      let succeededAt: string | null = null;

      // —— 阶段 1：合同参数（端口内部最多 2 次尝试）——
      try {
        const port = createModelPort(process.env);
        draft = await port.generateDraft({
          requestId: `live-contract-${Date.now()}`,
          taskId: 'live-smoke-contract',
          instruction: INSTRUCTION,
        });
        succeededAt = 'contract_params';
        stages.push({
          stage: 'contract_params',
          ok: true,
          titleChars: draft.title.length,
          paragraphCount: draft.paragraphs.length,
          paragraphChars: draft.paragraphs.map((p) => p.text.length),
          thinkingDisabled: false,
        });
      } catch (error) {
        const failure = error instanceof ModelCallError ? error : null;
        stages.push({
          stage: 'contract_params',
          ok: false,
          ...(failure ? { code: failure.code } : {}),
          message: failure ? failure.message : String(error),
          thinkingDisabled: false,
        });

        // —— 阶段 2：**只在确认截断之后**才降级 ——
        if (!failure || failure.code !== 'model_response_truncated') {
          console.log(JSON.stringify({ live: true, stages, succeededAt }, null, 2));
          throw error;
        }

        const downgraded = createModelPort({
          ...process.env,
          POTBOT_MODEL_THINKING_DISABLED: '1',
        });
        try {
          draft = await downgraded.generateDraft({
            requestId: `live-downgrade-${Date.now()}`,
            taskId: 'live-smoke-thinking-disabled',
            instruction: INSTRUCTION,
          });
          succeededAt = 'thinking_disabled';
          stages.push({
            stage: 'thinking_disabled',
            ok: true,
            titleChars: draft.title.length,
            paragraphCount: draft.paragraphs.length,
            paragraphChars: draft.paragraphs.map((p) => p.text.length),
            thinkingDisabled: true,
          });
        } catch (downgradeError) {
          const failure2 = downgradeError instanceof ModelCallError ? downgradeError : null;
          stages.push({
            stage: 'thinking_disabled',
            ok: false,
            ...(failure2 ? { code: failure2.code } : {}),
            message: failure2 ? failure2.message : String(downgradeError),
            thinkingDisabled: true,
          });
          console.log(JSON.stringify({ live: true, stages, succeededAt }, null, 2));
          throw downgradeError;
        }
      }

      console.log(
        JSON.stringify(
          {
            live: true,
            provider: before.provider,
            model: before.model,
            baseUrlHost: before.baseUrlHost,
            authMode: before.authMode,
            apiShape: before.apiShape,
            finishedAt: new Date().toISOString(),
            succeededAt,
            stages,
          },
          null,
          2,
        ),
      );

      expect(succeededAt).not.toBeNull();
      expect(draft).not.toBeNull();
      const result = draft as DraftInput;
      expect(result.title.trim().length).toBeGreaterThan(0);
      expect(result.paragraphs.length).toBeGreaterThanOrEqual(2);
      expect(result.paragraphs.length).toBeLessThanOrEqual(4);
      for (const paragraph of result.paragraphs) {
        expect(paragraph.text.trim().length).toBeGreaterThan(0);
      }
    },
    180_000,
  );
});
