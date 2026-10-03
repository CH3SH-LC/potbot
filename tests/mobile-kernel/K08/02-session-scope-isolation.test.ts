/**
 * K08 独立验证 ②：**会话隔离 / 作用域隔离 / 长短期分类 / 注入上限**。
 *
 * 判据独立于实现：直接对产出文本与审计数字下断言，不看实现内部结构。
 * 反例纪律：跨会话的短期记忆若被注入，`digest` 会包含他会话的暗号 ⇒ 用例红。
 */

import { describe, expect, it } from 'vitest';

import { asTemplateId } from '../../../src/protocol/index.js';
import { asOwnerId } from '../../../src/memory/index.js';
import {
  DEFAULT_MEMORY_KEY,
  MemoryPersistenceBackend,
  classifyRetention,
  retentionBreakdown,
  RETENTION_BY_KIND,
  openPhoneMemory,
  type PhoneMemoryStore,
} from '../../../apps/mobile-kernel/memory/index.js';

const OWNER = 'u1';
const OTHER = 'u2';
const SESSION_A = 'conv-A';
const SESSION_B = 'conv-B';

async function emptyStore(): Promise<PhoneMemoryStore> {
  const port = new MemoryPersistenceBackend();
  const opened = await openPhoneMemory({ port, key: DEFAULT_MEMORY_KEY });
  if (opened.kind !== 'empty') throw new Error(`期望空库，实际 ${opened.kind}`);
  return opened.store;
}

describe('K08 ② 跨会话隔离（短期记忆锁在本会话）', () => {
  it('本会话注入只含本会话消息 + 长期偏好；他会话与他主体条目被排除并计数', async () => {
    const store = await emptyStore();
    store.rememberSessionMessage({ owner_id: OWNER, conversation_id: SESSION_A, role: 'user', text: '会话A暗号 ALPHA' });
    store.rememberSessionMessage({ owner_id: OWNER, conversation_id: SESSION_B, role: 'user', text: '会话B暗号 BETA' });
    store.rememberPreference({ owner_id: OWNER, preference_key: 'city', value_text: '上海' });
    // 他主体、同一会话 id：不得进入 u1 的注入
    store.rememberSessionMessage({ owner_id: OTHER, conversation_id: SESSION_A, role: 'user', text: '别人暗号 GAMMA' });

    const injection = store.sessionInjection({
      owner_id: asOwnerId(OWNER),
      instance_id: 'inst-1',
      session_id: SESSION_A,
    });

    expect(injection.status).toBe('found');
    expect(injection.digest).toContain('ALPHA');
    expect(injection.digest).toContain('上海'); // 长期偏好不理会话
    expect(injection.digest).not.toContain('BETA'); // 他会话被排除
    expect(injection.digest).not.toContain('GAMMA'); // 他主体被排除
    expect(injection.audit.session_scoped).toBe(true);
    expect(injection.audit.other_session_excluded).toBe(1);
    expect(injection.audit.foreign_excluded).toBe(1);
    expect(injection.included_ids).toHaveLength(2);
  });

  it('不给 session_id 时不做会话过滤，但审计如实标注 session_scoped=false', async () => {
    const store = await emptyStore();
    store.rememberSessionMessage({ owner_id: OWNER, conversation_id: SESSION_A, role: 'user', text: 'A 暗号 ALPHA' });
    store.rememberSessionMessage({ owner_id: OWNER, conversation_id: SESSION_B, role: 'user', text: 'B 暗号 BETA' });

    const injection = store.sessionInjection({ owner_id: asOwnerId(OWNER), instance_id: 'inst-2' });
    expect(injection.audit.session_scoped).toBe(false);
    expect(injection.audit.other_session_excluded).toBe(0);
    expect(injection.digest).toContain('ALPHA');
    expect(injection.digest).toContain('BETA');
  });

  it('本会话无匹配 ⇒ not_found 且摘要为空串（不编造）', async () => {
    const store = await emptyStore();
    store.rememberSessionMessage({ owner_id: OWNER, conversation_id: SESSION_B, role: 'user', text: '只在 B' });
    const injection = store.sessionInjection({
      owner_id: asOwnerId(OWNER),
      instance_id: 'inst-3',
      session_id: SESSION_A,
    });
    expect(injection.status).toBe('not_found');
    expect(injection.digest).toBe('');
    expect(injection.included_ids).toHaveLength(0);
  });
});

describe('K08 ② 作用域隔离（模板范围）与注入上限', () => {
  it('模板范围按 template_id 收窄：查 t2 时 t1 的经验被记为越范围', async () => {
    const store = await emptyStore();
    store.rememberTemplateExperience({
      owner_id: OWNER,
      template_id: 't1',
      lesson: 't1 的教训',
      applies_to_version: '1.0.0',
    });

    const injection = store.sessionInjection({
      owner_id: asOwnerId(OWNER),
      instance_id: 'inst-4',
      template_id: asTemplateId('t2'),
    });
    expect(injection.digest).not.toContain('t1 的教训');
    expect(injection.audit.out_of_scope_excluded).toBe(1);
    expect(injection.status).toBe('not_found');
  });

  it('注入受 max_items 上限截断，truncated 如实上报', async () => {
    const store = await emptyStore();
    for (let i = 0; i < 3; i += 1) {
      store.rememberSessionMessage({
        owner_id: OWNER,
        conversation_id: SESSION_A,
        role: 'user',
        text: `消息 ${String(i)}`,
      });
    }
    const injection = store.sessionInjection({
      owner_id: asOwnerId(OWNER),
      instance_id: 'inst-5',
      session_id: SESSION_A,
      requested_limits: { max_items: 2, max_chars: 8000 },
    });
    expect(injection.included_ids).toHaveLength(2);
    expect(injection.truncated).toBe(true);
    expect(injection.limits.max_items).toBe(2);
    expect(injection.audit.owner_visible_total).toBe(3);
  });

  it('越天花板的上限申请 ⇒ 抛（不静默夹取）', async () => {
    const store = await emptyStore();
    expect(() =>
      store.sessionInjection({
        owner_id: asOwnerId(OWNER),
        instance_id: 'inst-6',
        requested_limits: { max_items: 10_000, max_chars: 10_000 },
      }),
    ).toThrow();
  });
});

describe('K08 ② 长 / 短期分类与来源版本', () => {
  it('四类记忆的保留分类是结构性的，不靠调用方标注', () => {
    expect(RETENTION_BY_KIND.session_message).toBe('short_term');
    expect(RETENTION_BY_KIND.task_fact).toBe('short_term');
    expect(RETENTION_BY_KIND.preference).toBe('long_term');
    expect(RETENTION_BY_KIND.template_experience).toBe('long_term');
  });

  it('classifyRetention / retentionBreakdown 与条目形状一致', async () => {
    const store = await emptyStore();
    store.rememberSessionMessage({ owner_id: OWNER, conversation_id: SESSION_A, role: 'user', text: '短期' });
    const pref = store.rememberPreference({ owner_id: OWNER, preference_key: 'k', value_text: '长期' });
    expect(pref.ok).toBe(true);
    if (!pref.ok) throw new Error('unreachable');

    expect(classifyRetention(pref.entry)).toBe('long_term');
    const breakdown = retentionBreakdown(store.allEntries());
    expect(breakdown).toEqual({ short_term: 1, long_term: 1 });
  });

  it('provenance 带来源与版本；跨主体取来源返回 null', async () => {
    const store = await emptyStore();
    const written = store.rememberPreference({
      owner_id: OWNER,
      preference_key: 'city',
      value_text: '上海',
      memory_id: 'pref-1',
    });
    expect(written.ok).toBe(true);
    if (!written.ok) throw new Error('unreachable');

    const provenance = store.provenance(written.entry.memory_id, asOwnerId(OWNER));
    expect(provenance?.source_kind).toBe('user_statement');
    expect(provenance?.version).toBe(0);
    expect(provenance?.retention).toBe('long_term');
    // 他主体取同一条 ⇒ null（不泄漏）
    expect(store.provenance(written.entry.memory_id, asOwnerId('someone-else'))).toBeNull();
  });
});
