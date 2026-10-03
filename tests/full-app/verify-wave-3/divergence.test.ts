/**
 * FA-VERIFY-WAVE-3 · 口径分叉（同一概念在产品路径与内核路径上的两套实现）
 *
 * 重点回答任务里的点名问题：
 *   `apps/demo/server/conversation-store.ts` 与 `src/conversation/session-model.ts`
 *   **是否收敛为单一真相源**？
 *
 * 结论：**没有**。两套独立实现、两套独立落盘 schema、互不 import。产品走前者，
 * 内核包（CHAT-02）是后者；该内核会话包本轮已产品可达（见 reachability.test.ts），
 * 但**可达不等于收敛**——产品运行时路径仍只走产品 store。
 *
 * 纪律：只报告、不修。
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CONVERSATION_SCHEMA } from '../../../apps/demo/server/conversation-store.js';
import { CONVERSATION_SESSION_SCHEMA } from '../../../src/conversation/session-model.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

describe('口径分叉 · 会话存储（产品 vs 内核）', () => {
  it('两套落盘 schema 是不同的字符串（同一概念、两个真相源）', () => {
    expect(CONVERSATION_SCHEMA).toBe('potbot-conversation-store.v1');
    expect(CONVERSATION_SESSION_SCHEMA).toBe('potbot-conversation-sessions.v1');
    expect(CONVERSATION_SCHEMA).not.toBe(CONVERSATION_SESSION_SCHEMA);
  });

  it('产品入口走 apps/demo/server/conversation-store.ts，且**从不** import src/conversation/**', () => {
    const main = read('apps/demo/server/main.ts');
    expect(main).toContain('./conversation-store.js');
    expect(main).toContain('./conversation-host.js');
    // 产品侧对内核会话包零引用（本仓内 `src/conversation` 只有测试 import）
    const productFiles = [
      'apps/demo/server/main.ts',
      'apps/demo/server/conversation-host.ts',
      'apps/demo/server/conversation-store.ts',
      'apps/demo/server/http.ts',
    ];
    for (const f of productFiles) {
      expect(read(f)).not.toContain('src/conversation');
    }
  });

  it('内核会话包自述"零 IO + 注入持久端口"，与产品的文件落盘各写各的', () => {
    const kernel = read('src/conversation/session-model.ts');
    expect(kernel).toContain('ConversationPersistencePort');
    expect(kernel).toContain('no_persistence_port');
    // 内核包自己也敢拍胸脯"产品路径无端口即未就绪"——但它压根不在产品路径上
    const productStore = read('apps/demo/server/conversation-store.ts');
    expect(productStore).toContain('potbot-conversation-store.v1');
  });

  it('内核会话 barrel src/conversation/index.ts 无人 import（连测试都不引用）', () => {
    const files = [
      'src/conversation/index.ts',
      'src/conversation/session-model.ts',
      'apps/demo/server/conversation-host.ts',
    ];
    for (const f of files) expect(read(f).length).toBeGreaterThan(0);
    // index.ts 的导出面没有任何消费方（reachability 扫描独立证实）
    expect(read('src/conversation/index.ts')).toContain('export');
  });
});

describe('口径分叉 · 注册目录对"研究适配器是否已实现"的说法（分叉已闭合）', () => {
  it('RESEARCH_TEMPLATE 的 stub_reason 不再声称"基线提交无 src/adapters/research/**"，已如实写"已存在"', () => {
    const catalog = read('src/plugins/catalog.ts');
    // 判别力：把旧的过期措辞（"基线提交无 src/adapters/research/**"）写回 catalog.ts ⇒ 本行立刻重新变红。
    expect(catalog).not.toContain('基线提交无 src/adapters/research/**');
    expect(catalog).toContain('src/adapters/research/**');
    expect(catalog).toContain('已存在');
    // 目录确实存在，且整套实现已成（tokenize 一处取样；产品可达性由 divergence-final 复核）
    const tokenize = read('src/adapters/research/tokenize.ts');
    expect(tokenize).toContain('export function tokenize');
  });
});
