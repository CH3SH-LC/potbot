/**
 * FA-N：`chat-transport.js` 与 `conversation-store.js` 的**接缝**必须严丝合缝。
 *
 * ## 为什么单独测这一层
 *
 * 这两个文件属于**两个包**（界面侧状态机是 FA-A 的、后端接线是 FA-N 的），
 * 它们的约定是一串**没有类型**的字符串与字段名：`available` / `send` / `resume` /
 * `{ok, status, data}` / `data.cursor` / `data.error.{code,message,retryable}`。
 * 两边各自"看起来对"是不够的——真正的判据是：**把这一边接到那一边，行为是对的**。
 *
 * 所以本文件不重复测后端（那是 `fa-n-conversation.test.ts` 的活），只测这件事：
 * `PotbotChatTransport` 造出来的返回形状，喂给 `PotbotConversation.classifySendOutcome`
 * 之后，落到的是**正确的那一态**——不要把失败读成成功（R209 的核心不变量）。
 */

import { describe, expect, it } from 'vitest';

import { loadWebGlobal } from './harness.js';

interface TransportModule {
  readonly available: boolean;
  readonly provider: string;
  send(input: unknown): Promise<{ ok: boolean; status: number; data: Record<string, unknown> | null }>;
  resume(input: unknown): Promise<{ ok: boolean; error?: { code: string; message: string } }>;
  retry(input: unknown): Promise<unknown>;
  cancel(input: unknown): Promise<unknown>;
}

interface ConversationModule {
  readonly SEND_STATES: Record<string, string>;
  classifySendOutcome(res: unknown): {
    readonly state: string;
    readonly cursor: string | null;
    readonly error: { readonly code: string; readonly message: string } | null;
  };
}

const Transport = loadWebGlobal<TransportModule>('chat-transport.js', 'PotbotChatTransport');
const Conversation = loadWebGlobal<ConversationModule>('conversation-store.js', 'PotbotConversation');

describe('FA-N chat-transport：与界面侧状态机的接缝', () => {
  it('暴露的正是 conversation-store.js 要求的形状（available / send / resume）', () => {
    expect(Transport.available).toBe(true);
    expect(typeof Transport.send).toBe('function');
    expect(typeof Transport.resume).toBe('function');
    /* 页面侧 `chatBackendReady()` 只认这两个条件，写错一个就整条链静默降级。 */
    const ready = Transport.available === true && typeof Transport.send === 'function';
    expect(ready).toBe(true);
  });

  it('没有会话 id 时**不发请求**，返回结构化失败（而不是抛异常或假成功）', async () => {
    const result = await Transport.send({ sessionId: '', clientId: 'c-1', text: '你好' });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    const error = (result.data?.['error'] ?? null) as { code: string } | null;
    expect(error?.code).toBe('no_session');
    const verdict = Conversation.classifySendOutcome(result);
    expect(verdict.state).toBe(Conversation.SEND_STATES['FAILED']);
    expect(verdict.cursor).toBeNull();
  });

  it('缺少幂等键（clientId）同样拒绝：重试必须复用同一个键，不能凭空发一条', async () => {
    const result = await Transport.send({ sessionId: 'conv-1', clientId: '', text: '你好' });
    expect(result.ok).toBe(false);
    const error = (result.data?.['error'] ?? null) as { code: string } | null;
    expect(error?.code).toBe('no_client_id');
    expect(Conversation.classifySendOutcome(result).state).toBe(Conversation.SEND_STATES['FAILED']);
  });

  it('没有会话 id 时续取也是结构化失败（不假装"已经续完了"）', async () => {
    const result = await Transport.resume({ sessionId: '', cursor: null, onEvent: () => undefined });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('no_session');
  });

  it('**核心不变量**：非 2xx 的返回形状一定被读成失败，绝不会读成"已接收"', () => {
    const cases: Array<{ ok: boolean; status: number; data: Record<string, unknown> }> = [
      { ok: false, status: 0, data: { error: { code: 'network', message: '断网', retryable: true } } },
      { ok: false, status: 503, data: { code: 'conversations_unavailable', message: '未接入' } },
      { ok: false, status: 409, data: { code: 'idempotency_conflict', message: '键冲突' } },
      { ok: true, status: 202, data: { error: { code: 'backend_error', message: '后端说这条没成' } } },
    ];
    for (const item of cases) {
      const verdict = Conversation.classifySendOutcome(item);
      expect(verdict.state, JSON.stringify(item)).toBe(Conversation.SEND_STATES['FAILED']);
      expect(verdict.cursor).toBeNull();
    }
  });

  it('**核心不变量**：202 + 合法游标才读成「已接收」，且游标被原样带回来', () => {
    const verdict = Conversation.classifySendOutcome({
      ok: true,
      status: 202,
      data: { messageId: 'c-1', phase: 'accepted', cursor: 'conv:conv-1:7' },
    });
    expect(verdict.state).toBe(Conversation.SEND_STATES['RECEIVED']);
    expect(verdict.cursor).toBe('conv:conv-1:7');
    expect(verdict.error).toBeNull();
    /* 注意：`received` 只是"服务端收下了"，**不是**业务完成——相位在 `data.phase` 上。 */
  });
});
