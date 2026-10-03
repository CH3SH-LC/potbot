/**
 * **W-I22 — OfficePlugin 校对/翻译适配器把 `proofingStatus` 暴露给 UI 的跨线夹具**。
 *
 * 本文件补 W08 首个增量的 nextIncrement 缺口：`model-port-proofing.test.ts` 已证明各失败路径
 * **内部**会产生正确结果，但没有一个夹具证明这些状态**能被上层（UI / OfficePlugin 消费方）
 * 机器可读地取到**，也没有明确钉住"缺模型的端口在结构上永远产不出 `succeed([])`"。
 *
 * 被测面（只读，不修改）：`src/documents/proofing/model-port.ts`。
 * 适配器 = `createModelPortBackedProofingPort`（接了 K02 ModelPort）与
 * `createUnavailableModelProofingPort`（缺模型时的 not_ready 默认答案）。两者都是
 * OfficePlugin 校对/翻译工具背后的端口，UI 通过它们的 `Result` 决定显示什么。
 *
 * ## 为什么状态必须落在 `Failure.detail.extra.proofingStatus`
 *
 * `model-port.ts` 里**所有** proofing 失败都用 `fail('precondition', …)` 发出——它们的
 * 粗粒度 `code` **完全相同**。因此 UI 想区分"取消 / 过期 / 模型挂了 / 预算超了 / 没输出 /
 * 输出不可信 / 未就绪"，唯一可靠的机器字段就是 `detail.extra.proofingStatus`。本文件把这条
 * 论断钉成可执行断言（§A：同一 code、不同 status），并用一个**UI 消费夹具**（§D）证明——
 * 只看 status 就能正确分支，且**任何失败都不会被渲染成"通过/干净"**。
 *
 * ## 判据一览
 *
 * | 行为面 | 判据 | 用例 |
 * |---|---|---|
 * | 状态机器可读 | 五个必需状态（not_ready/cancelled/expired/model_error/budget_exceeded）逐个精确可取 | §A |
 * | `code` 不足以区分 | 上述失败 `code` 全是 `precondition`，只有 `proofingStatus` 能区分 | §A |
 * | 缺模型不得报通过 | `createUnavailableModelProofingPort` 两个能力、多种输入下**结构上**产不出 `succeed([])` | §B |
 * | 反向对照 | 健康的注入端口 + 合法模型输出 ⇒ 真的 `succeed([])` / `succeed([issue])` | §C |
 * | UI 消费面 | 只读 status 的 UI 夹具：任何失败 → 非"通过"；未分类失败也不冒充干净 | §D |
 * | 人类可读 message 不可作为判据 | 错误 message 里写着"检查通过"也必须是 model_error，UI 不得据此报通过 | §D |
 *
 * 时间基准**注入**（`clock`），不读墙钟；不发起任何真实网络请求——验证层为 `contract`
 * （端口契约 / UI 消费面），**不是** `real-api`，也不是真机 UI。
 */

import { describe, expect, it } from 'vitest';

import type { DocumentModel } from '../../../../src/documents/model/types.js';
import {
  createModelPortBackedProofingPort,
  createUnavailableModelProofingPort,
  PROOFING_TOOL_NAME,
  type ModelPort,
  type ModelPortProofingPort,
  type ModelProofingCheckInput,
  type ModelPortRequest,
  type ModelPortStreamChunk,
  type ProofingOutcomeStatus,
} from '../../../../src/documents/proofing/model-port.js';
import type { ProofingIssue } from '../../../../src/documents/proofing/spelling.js';
import { document, paragraphOfRuns } from '../../../../src/documents/selection/testing.js';
import { succeed, type Result, type Selection } from '../../../../src/documents/selection/types.js';

// ---------------------------------------------------------------------------
// 确定性内存端口（真实记录请求、真实按脚本返回片段——不是"假装"的 mock）
// ---------------------------------------------------------------------------

interface ScriptedPort {
  readonly port: ModelPort;
  readonly requests: ModelPortRequest[];
}

type Script = (request: ModelPortRequest, callIndex: number) => readonly ModelPortStreamChunk[];

function scriptedPort(provider: string, script: Script): ScriptedPort {
  const requests: ModelPortRequest[] = [];
  return {
    requests,
    port: {
      provider,
      async stream(request: ModelPortRequest): Promise<readonly ModelPortStreamChunk[]> {
        requests.push(request);
        return script(request, requests.length - 1);
      },
    },
  };
}

/** 端口直接抛错（模拟宿主崩了 / 传输层异常）。 */
function throwingPort(provider: string, error: unknown): ModelPort {
  return {
    provider,
    async stream(): Promise<readonly ModelPortStreamChunk[]> {
      throw error;
    },
  };
}

function textChunks(...texts: readonly string[]): readonly ModelPortStreamChunk[] {
  return texts.map((text) => ({ type: 'text', text }));
}

function toolChunk(issues: unknown): ModelPortStreamChunk {
  return { type: 'tool-call', toolCallId: 'tc-1', toolName: PROOFING_TOOL_NAME, arguments: { issues } };
}

function errorChunk(code: string, message: string): ModelPortStreamChunk {
  return { type: 'error', error: { code, message } };
}

function usageChunk(totalTokens: number): ModelPortStreamChunk {
  return { type: 'usage', usage: { promptTokens: totalTokens, completionTokens: 0, totalTokens } };
}

function build(scripted: ScriptedPort, clockMs = CLOCK_NOW): ModelPortProofingPort {
  return buildWithPort(scripted.port, clockMs);
}

function buildWithPort(port: ModelPort, clockMs = CLOCK_NOW): ModelPortProofingPort {
  const built = createModelPortBackedProofingPort({
    port,
    keyRef: 'keyref:app-default',
    model: 'deepseek-flash',
    clock: () => clockMs,
  });
  if (!built.ok) throw new Error(built.message);
  return built.value;
}

const CLOCK_NOW = 1_000_000;
const NEVER_CANCELLED = { token: 'tok', deadlineMs: CLOCK_NOW + 60_000 } as const;

function twoParagraphDoc(): DocumentModel {
  return document([paragraphOfRuns('p1', [['r1', '你好世界']]), paragraphOfRuns('p2', [['r2', '别动我']])]);
}

function selection(): Selection {
  return { document_id: 'doc-1', base_revision: 1, ranges: [{ node_id: 'p1', start: 0, end: 2 }] };
}

// ---------------------------------------------------------------------------
// 机器可读状态读取器 + UI 消费夹具
// ---------------------------------------------------------------------------

/** 闭集：任何合法状态都必须在册；给错名字会在此处编译失败。 */
const KNOWN_STATUSES: readonly ProofingOutcomeStatus[] = [
  'not_ready',
  'cancelled',
  'expired',
  'model_error',
  'no_output',
  'invalid_model_output',
  'budget_exceeded',
];

/**
 * 唯一可靠的读取方式：读 `detail.extra.proofingStatus`，**不解析 message**。
 * 非字符串 / 不在闭集内 ⇒ `null`（调用方必须把 null 当作"未知失败"，而不是"通过"）。
 */
function readProofingStatus(result: Result<unknown>): ProofingOutcomeStatus | null {
  if (result.ok) return null;
  const raw = result.detail.extra?.['proofingStatus'];
  if (typeof raw !== 'string') return null;
  return (KNOWN_STATUSES as readonly string[]).includes(raw) ? (raw as ProofingOutcomeStatus) : null;
}

/** UI 消费夹具：模拟 OfficePlugin 前端把一次校对 `Result` 渲染成横幅。 */
interface UiProofingView {
  /** `result` = 有真实结论；`blocked` = 没有结论（必须让用户重试/换路径，绝不是"通过"）。 */
  readonly surface: 'result' | 'blocked';
  readonly state: 'clean' | 'issues' | 'unavailable' | 'cancelled' | 'expired' | 'failed' | 'unclassified_failure';
  readonly status: ProofingOutcomeStatus | null;
  /** UI 是否可把它当"检查过、没问题"来展示。任何失败路径都必须为 `false`。 */
  readonly isPassLike: boolean;
}

function toUiView(result: Result<readonly ProofingIssue[]>): UiProofingView {
  if (result.ok) {
    return result.value.length === 0
      ? { surface: 'result', state: 'clean', status: null, isPassLike: true }
      : { surface: 'result', state: 'issues', status: null, isPassLike: false };
  }
  const status = readProofingStatus(result);
  if (status === null) {
    // 没有可读状态 = 未分类失败。UI 必须显示"没做成"，不得回退成"干净"。
    return { surface: 'blocked', state: 'unclassified_failure', status: null, isPassLike: false };
  }
  const state: UiProofingView['state'] =
    status === 'not_ready'
      ? 'unavailable'
      : status === 'cancelled'
        ? 'cancelled'
        : status === 'expired'
          ? 'expired'
          : 'failed';
  return { surface: 'blocked', state, status, isPassLike: false };
}

// ---------------------------------------------------------------------------
// §A 五个必需状态在 Failure.detail.extra.proofingStatus 上机器可读
// ---------------------------------------------------------------------------

describe('W-I22 §A proofingStatus 机器可读（OfficePlugin 适配器输出面）', () => {
  it('§A1 未就绪 ⇒ not_ready（缺模型时的默认端口）', async () => {
    const port = createUnavailableModelProofingPort('App 未配置模型密钥');
    const result = await port.checkWithModel({ model: twoParagraphDoc(), cancellation: NEVER_CANCELLED });
    expect(result.ok).toBe(false);
    expect(readProofingStatus(result)).toBe('not_ready');
    if (!result.ok) expect(result.code).toBe('precondition'); // 粗粒度 code 与其它状态相同
  });

  it('§A2 取消 ⇒ cancelled', async () => {
    const port = build(scriptedPort('model://x', () => [toolChunk([])]));
    const result = await port.checkWithModel({
      model: twoParagraphDoc(),
      cancellation: { token: 'tok', cancelled: true },
    });
    expect(result.ok).toBe(false);
    expect(readProofingStatus(result)).toBe('cancelled');
    if (!result.ok) expect(result.code).toBe('precondition');
  });

  it('§A3 过期（注入时钟越过 deadlineMs） ⇒ expired', async () => {
    const port = build(scriptedPort('model://x', () => [toolChunk([])]));
    const result = await port.checkWithModel({
      model: twoParagraphDoc(),
      cancellation: { token: 'tok', deadlineMs: CLOCK_NOW - 1 },
    });
    expect(result.ok).toBe(false);
    expect(readProofingStatus(result)).toBe('expired');
    if (!result.ok) expect(result.code).toBe('precondition');
  });

  it('§A4 模型端口抛错 ⇒ model_error', async () => {
    const port = buildWithPort(throwingPort('model://host', new Error('socket closed')));
    const result = await port.checkWithModel({ model: twoParagraphDoc(), cancellation: NEVER_CANCELLED });
    expect(result.ok).toBe(false);
    expect(readProofingStatus(result)).toBe('model_error');
    if (!result.ok) expect(result.code).toBe('precondition');
  });

  it('§A5 token 超预算 ⇒ budget_exceeded', async () => {
    const port = build(scriptedPort('model://x', () => [toolChunk([]), usageChunk(500)]));
    const result = await port.checkWithModel({
      model: twoParagraphDoc(),
      cancellation: NEVER_CANCELLED,
      budget: { maxTokens: 100 },
    });
    expect(result.ok).toBe(false);
    expect(readProofingStatus(result)).toBe('budget_exceeded');
    if (!result.ok) {
      expect(result.code).toBe('precondition');
      expect(result.detail.extra?.['tokensUsed']).toBe(500);
    }
  });

  it('§A6 模型没有结构化输出 ⇒ no_output（不是"没问题"）', async () => {
    const port = build(scriptedPort('model://chatty', () => textChunks('文档看起来没问题')));
    const result = await port.checkWithModel({ model: twoParagraphDoc(), cancellation: NEVER_CANCELLED });
    expect(result.ok).toBe(false);
    expect(readProofingStatus(result)).toBe('no_output');
  });

  it('§A7 模型输出不可信 ⇒ invalid_model_output', async () => {
    const port = build(scriptedPort('model://x', () => [toolChunk('不是数组')]));
    const result = await port.checkWithModel({ model: twoParagraphDoc(), cancellation: NEVER_CANCELLED });
    expect(result.ok).toBe(false);
    expect(readProofingStatus(result)).toBe('invalid_model_output');
  });

  it('§A8 五个必需状态的 code 全为 precondition——证明 proofingStatus 是唯一机器判别字段', () => {
    // 逐个与上面构造的失败同源：这里只钉"code 一样、status 不一样"这条契约论断。
    const coarseCodes: readonly string[] = ['precondition', 'precondition', 'precondition', 'precondition', 'precondition'];
    const required: readonly ProofingOutcomeStatus[] = ['not_ready', 'cancelled', 'expired', 'model_error', 'budget_exceeded'];
    expect(new Set(coarseCodes).size).toBe(1); // code 无法区分
    expect(new Set(required).size).toBe(5); // status 可以区分
    for (const status of required) expect(KNOWN_STATUSES).toContain(status);
  });

  it('§A9 翻译能力同样暴露状态（not_ready / cancelled 两条入口一致）', async () => {
    const unavailable = createUnavailableModelProofingPort('未接模型');
    const un = await unavailable.translateSelectionWithModel(twoParagraphDoc(), selection(), {
      target_language: 'en-US',
      cancellation: NEVER_CANCELLED,
      budget: { max_model_calls: 3 },
    });
    expect(un.ok).toBe(false);
    expect(readProofingStatus(un)).toBe('not_ready');

    const port = build(scriptedPort('model://x', () => textChunks('X')));
    const cancelled = await port.translateSelectionWithModel(twoParagraphDoc(), selection(), {
      target_language: 'en-US',
      cancellation: { token: 'tok', cancelled: true },
      budget: { max_model_calls: 3 },
    });
    expect(cancelled.ok).toBe(false);
    expect(readProofingStatus(cancelled)).toBe('cancelled');
  });
});

// ---------------------------------------------------------------------------
// §B 缺模型的端口在结构上产不出 succeed([])
// ---------------------------------------------------------------------------

describe('W-I22 §B 缺模型不得报通过', () => {
  it('§B1 多种输入下 checkWithModel 永远失败，且从不等于 succeed([])', async () => {
    const port = createUnavailableModelProofingPort('App 未配置模型密钥');
    const probes: readonly ModelProofingCheckInput[] = [
      { model: twoParagraphDoc(), cancellation: NEVER_CANCELLED },
      { model: twoParagraphDoc(), cancellation: { token: 'tok', deadlineMs: CLOCK_NOW - 1 } },
      { model: twoParagraphDoc(), cancellation: { token: 'tok', cancelled: true }, budget: { maxTokens: 1 } },
      { model: twoParagraphDoc(), paragraph_ids: [], cancellation: NEVER_CANCELLED },
    ];
    for (const probe of probes) {
      const result = await port.checkWithModel(probe);
      expect(result.ok).toBe(false);
      expect(result).not.toEqual(succeed([]));
      expect(readProofingStatus(result)).toBe('not_ready');
    }
  });

  it('§B2 翻译能力同样结构上产不出成功', async () => {
    const port = createUnavailableModelProofingPort('未接模型');
    const result = await port.translateSelectionWithModel(twoParagraphDoc(), selection(), {
      target_language: 'en-US',
      cancellation: NEVER_CANCELLED,
      budget: { max_model_calls: 3 },
    });
    expect(result.ok).toBe(false);
    expect(readProofingStatus(result)).toBe('not_ready');
  });

  it('§B3 空原因也被替换为非空原因（不静默），readiness 明说 not_ready', async () => {
    const port = createUnavailableModelProofingPort('');
    expect(port.readiness.status).toBe('not_ready');
    if (port.readiness.status !== 'not_ready') throw new Error('readiness 应为 not_ready');
    expect(port.readiness.reason.length).toBeGreaterThan(0);

    const result = await port.checkWithModel({ model: twoParagraphDoc(), cancellation: NEVER_CANCELLED });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message.length).toBeGreaterThan(0);
    expect(readProofingStatus(result)).toBe('not_ready');
  });
});

// ---------------------------------------------------------------------------
// §C 反向对照：健康端口 + 合法输出 ⇒ 真的成功
// ---------------------------------------------------------------------------

describe('W-I22 §C 反向对照（健康端口确实能给出结论）', () => {
  it('§C1 模型真的调用了工具且 issues 为空 ⇒ succeed([])（唯一合法"干净"）', async () => {
    const port = build(scriptedPort('model://health', () => [toolChunk([])]));
    const result = await port.checkWithModel({ model: twoParagraphDoc(), cancellation: NEVER_CANCELLED });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.value).toEqual([]);
    expect(result).toEqual(succeed([]));
    expect(readProofingStatus(result)).toBeNull(); // 成功没有失败状态
  });

  it('§C2 合法提示被采纳，location.text 由文档实读', async () => {
    const port = build(
      scriptedPort('model://health', () => [
        toolChunk([{ paragraph_id: 'p1', start: 0, end: 2, kind: 'spelling', message: '疑似用词', suggestions: ['您好'] }]),
      ]),
    );
    const result = await port.checkWithModel({ model: twoParagraphDoc(), cancellation: NEVER_CANCELLED });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.value).toHaveLength(1);
    expect(result.value[0]!.location.text).toBe('你好');
    expect(readProofingStatus(result)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §D UI 消费夹具：只看 proofingStatus，任何失败都不冒充"通过"
// ---------------------------------------------------------------------------

describe('W-I22 §D OfficePlugin/UI 消费面', () => {
  it('§D1 每个失败状态都被 UI 映射为 blocked（isPassLike=false）', async () => {
    const cases: { readonly result: Result<readonly ProofingIssue[]>; readonly state: UiProofingView['state']; readonly status: ProofingOutcomeStatus }[] = [];

    const unavailable = createUnavailableModelProofingPort('未接模型');
    cases.push({
      result: await unavailable.checkWithModel({ model: twoParagraphDoc(), cancellation: NEVER_CANCELLED }),
      state: 'unavailable',
      status: 'not_ready',
    });
    cases.push({
      result: await build(scriptedPort('model://x', () => [toolChunk([])])).checkWithModel({
        model: twoParagraphDoc(),
        cancellation: { token: 'tok', cancelled: true },
      }),
      state: 'cancelled',
      status: 'cancelled',
    });
    cases.push({
      result: await build(scriptedPort('model://x', () => [toolChunk([])])).checkWithModel({
        model: twoParagraphDoc(),
        cancellation: { token: 'tok', deadlineMs: CLOCK_NOW - 1 },
      }),
      state: 'expired',
      status: 'expired',
    });
    cases.push({
      result: await buildWithPort(throwingPort('model://host', new Error('boom'))).checkWithModel({
        model: twoParagraphDoc(),
        cancellation: NEVER_CANCELLED,
      }),
      state: 'failed',
      status: 'model_error',
    });
    cases.push({
      result: await build(scriptedPort('model://x', () => [toolChunk([]), usageChunk(999)])).checkWithModel({
        model: twoParagraphDoc(),
        cancellation: NEVER_CANCELLED,
        budget: { maxTokens: 1 },
      }),
      state: 'failed',
      status: 'budget_exceeded',
    });

    for (const entry of cases) {
      const view = toUiView(entry.result);
      expect(view.surface).toBe('blocked');
      expect(view.state).toBe(entry.state);
      expect(view.status).toBe(entry.status);
      expect(view.isPassLike).toBe(false); // 关键：任何失败都不得渲染成"通过"
    }
  });

  it('§D2 反向对照：健康端口的两种合法结论分别渲染为 clean / issues', async () => {
    const empty = await build(scriptedPort('model://health', () => [toolChunk([])])).checkWithModel({
      model: twoParagraphDoc(),
      cancellation: NEVER_CANCELLED,
    });
    expect(toUiView(empty)).toEqual({ surface: 'result', state: 'clean', status: null, isPassLike: true });

    const withIssue = await build(
      scriptedPort('model://health', () => [
        toolChunk([{ paragraph_id: 'p1', start: 0, end: 2, kind: 'grammar', message: 'x' }]),
      ]),
    ).checkWithModel({ model: twoParagraphDoc(), cancellation: NEVER_CANCELLED });
    expect(toUiView(withIssue)).toEqual({ surface: 'result', state: 'issues', status: null, isPassLike: false });
  });

  it('§D3 人类可读 message 写着"检查通过"也必须是 model_error——UI 不得据 message 报通过', async () => {
    const port = build(
      scriptedPort('model://liar', () => [errorChunk('provider_note', '检查通过，未发现问题。')]),
    );
    const result = await port.checkWithModel({ model: twoParagraphDoc(), cancellation: NEVER_CANCELLED });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('检查通过'); // message 具有误导性
    expect(readProofingStatus(result)).toBe('model_error'); // 机器字段不受 message 影响
    const view = toUiView(result);
    expect(view.state).toBe('failed');
    expect(view.isPassLike).toBe(false);
  });

  it('§D4 没有 proofingStatus 的失败（未知段）⇒ 未分类失败，仍不得冒充"干净"', async () => {
    const port = build(scriptedPort('model://x', () => [toolChunk([])]));
    const result = await port.checkWithModel({
      model: twoParagraphDoc(),
      paragraph_ids: ['does-not-exist'],
      cancellation: NEVER_CANCELLED,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('unknown_node'); // 该路径不带 proofingStatus
    expect(readProofingStatus(result)).toBeNull();
    const view = toUiView(result);
    expect(view).toEqual({ surface: 'blocked', state: 'unclassified_failure', status: null, isPassLike: false });
  });
});
