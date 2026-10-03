/**
 * FA-VERIFY-WAVE-4 · I-1 闭环复核：`src/memory/recall-limits.ts` 的
 * 「整份历史复制」闸门 `assertNotHistoryDump()` **是否真的可达**。
 *
 * 本文件**不复用**实现者的用例与 fixture。判据由验证方独立构造：
 *
 * 1. `conforming`：任何**诚实**的 `MemoryRepository`（`recall()` 按 `limits` 截断）⇒
 *    穷举 (条数 × 上限) 采样，`full_history_copy` 恒 `false`，`assertNotHistoryDump` 恒不抛。
 * 2. `trigger`：验证方独立构造一个**不按 `limits` 截断**的仓库（模拟"上限没接到注入上"）⇒
 *    闸门抛。这是让闸门变红的**唯一**输入形态。
 * 3. 直接伪造 `injected` 计数调 `auditRecallIsolation()` ⇒ 判据为 true（说明判据只看一个数字）。
 *
 * 结论（见报告）：闸门**不是**在真实数据路径上可达的——诚实仓库永远不触发；
 * 只有"依赖违约（仓库不守契约）"才触发。**这一条是事实、不随接线改变，予以保留。**
 *
 * 【2026-10-03 更新】原探针另断言承载该闸门的 `buildInstanceRecallInjection()` 在
 * `src/**`、`apps/**` 的**非测试代码里没有任何调用方**——那是 **N-1 缺陷**，本轮已接线修复：
 * 产品路径 `apps/demo/server/memory-routes.ts`（两处）**确为**调用方。
 * 本文件下方 `it` 已翻转为"**确有**产品调用方"（接线被回退即变红）。
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MEMORY_LIMITS,
  asMemoryId,
  asOwnerId,
  createMemoryEntry,
  type MemoryEntry,
  type MemoryQueryLimits,
  type OwnerId,
  type SessionMessageMemory,
} from '../../../src/memory/types.js';
import {
  MemoryRepository,
  createMemoryRepository,
  type MemoryQuery,
  type MemoryRecallResult,
} from '../../../src/memory/repository.js';
import {
  INJECTION_CEILINGS,
  assertNotHistoryDump,
  auditRecallIsolation,
  buildInstanceRecallInjection,
} from '../../../src/memory/recall-limits.js';

const U1: OwnerId = asOwnerId('v4-user-a');

function sessionMessage(id: string, at: number): SessionMessageMemory {
  return createMemoryEntry({
    kind: 'session_message',
    memory_id: asMemoryId(id),
    owner_id: U1,
    scope: { kind: 'user', task_id: null, template_id: null },
    source: { kind: 'user_statement', detail: 'v4 会话消息' },
    confirmation: 'confirmed',
    created_at: at,
    updated_at: at,
    version: 0,
    status: 'active',
    conversation_id: 'v4-conv',
    role: 'user',
    text: `历史消息 ${id}`,
  }) as SessionMessageMemory;
}

function seedN(repo: MemoryRepository, count: number): void {
  for (let i = 0; i < count; i += 1) {
    const result = repo.remember(sessionMessage(`v4-${String(i).padStart(4, '0')}`, i));
    if (!result.ok) throw new Error(`seed 失败：${result.detail}`);
  }
}

/**
 * 验证方自造的**违约仓库**：`recall()` 无视调用方传入的 `limits`，一律按 1000 条返回。
 * 这正是闸门要抓的坏形态——"注入路径没把上限接上"。
 */
class IgnoresLimitsRepository extends MemoryRepository {
  override recall(query: MemoryQuery, _limits: MemoryQueryLimits = DEFAULT_MEMORY_LIMITS): MemoryRecallResult {
    return super.recall(query, { max_items: 1000, max_chars: 10_000_000 });
  }
}

/** 反向对照：一个**诚实**的仓库子类——严格把 `limits` 透传下去，不得触发闸门。 */
class HonestRepository extends MemoryRepository {
  override recall(query: MemoryQuery, limits: MemoryQueryLimits = DEFAULT_MEMORY_LIMITS): MemoryRecallResult {
    return super.recall(query, limits);
  }
}

describe('V4-I-1 · 闸门在诚实仓库上的可达性（穷举）', () => {
  it('任意 (条数 × 上限) 组合：full_history_copy 恒 false、闸门恒不抛', () => {
    const counts = [0, 1, 19, 20, 21, 49, 50, 51, 100, 300];
    const limitsList: MemoryQueryLimits[] = [
      { max_items: 1, max_chars: 8000 },
      { max_items: 5, max_chars: 8000 },
      { max_items: 20, max_chars: 8000 },
      { max_items: 50, max_chars: 8000 },
    ];
    let samples = 0;
    let threw = 0;
    let flagged = 0;

    for (const limits of limitsList) {
      for (const count of counts) {
        // 每个组合用一颗**全新**的仓库（避免上一轮残留影响计数）。
        const repo = new HonestRepository();
        seedN(repo, count);
        const injection = buildInstanceRecallInjection(repo, {
          owner_id: U1,
          instance_id: `sweep-${String(limits.max_items)}-${String(count)}`,
          requested_limits: limits,
        });
        samples += 1;
        if (injection.audit.full_history_copy) flagged += 1;
        expect(injection.audit.injected).toBeLessThanOrEqual(limits.max_items);
        try {
          assertNotHistoryDump(injection);
        } catch {
          threw += 1;
        }
      }
    }

    // 结论：诚实仓库上，闸门**没有任何输入能触发**（这正是"可达性"问题的判据）。
    expect(samples).toBe(counts.length * limitsList.length);
    expect(threw).toBe(0);
    expect(flagged).toBe(0);
  });

  it('反向对照：违约仓库（recall 无视 limits）⇒ 闸门**必抛**', () => {
    const repo = new IgnoresLimitsRepository();
    seedN(repo, 300);
    // 声明上限取默认（20），但仓库实际返回 300 条 ⇒ 越过声明上限。
    expect(() =>
      buildInstanceRecallInjection(repo, { owner_id: U1, instance_id: 'bad' }),
    ).toThrow(/整份历史复制|越过/);
  });

  it('直接伪造 injected 计数 ⇒ 判据为 true（判据只看一个数字，不看真实来源）', () => {
    const repo = createMemoryRepository();
    seedN(repo, 300);
    const audit = auditRecallIsolation(
      repo,
      { owner_id: U1, instance_id: 'forged' },
      100, // 验证方凭空给的"注入条数"，未经过任何真实注入路径
      { max_items: 20, max_chars: 8000 },
    );
    expect(audit.owner_visible_total).toBe(300);
    expect(audit.injected).toBe(100);
    expect(audit.full_history_copy).toBe(true);
  });

  it('判据仅与 (injected, limits.max_items) 有关：max_chars 不影响它', () => {
    const repo = createMemoryRepository();
    seedN(repo, 5);
    const wideChars = auditRecallIsolation(repo, { owner_id: U1, instance_id: 'x' }, 5, {
      max_items: 5,
      max_chars: 1,
    });
    const narrowChars = auditRecallIsolation(repo, { owner_id: U1, instance_id: 'x' }, 6, {
      max_items: 5,
      max_chars: 10_000_000,
    });
    expect(wideChars.full_history_copy).toBe(false);
    expect(narrowChars.full_history_copy).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 生产可达性：承载闸门的函数是否有调用方（源码级机器化断言）
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function listTsFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      if (entry.name.endsWith('.test.ts')) continue;
      out.push(absolute);
    }
  };
  walk(root);
  return out;
}

describe('V4-I-1 · 闸门的生产可达性（源码级）', () => {
  it('buildInstanceRecallInjection **确有**产品调用方（N-1 已闭环；原断言固化"无调用方"）', () => {
    const roots = [join(REPO_ROOT, 'src'), join(REPO_ROOT, 'apps')];
    const callers: string[] = [];
    for (const root of roots) {
      if (statSync(root, { throwIfNoEntry: false }) === undefined) continue;
      for (const file of listTsFiles(root)) {
        const rel = relative(REPO_ROOT, file).split(sep).join('/');
        const text = readFileSync(file, 'utf8');
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          // 跳过注释行与 import/export 行：只找**调用形态**。
          if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
          if (trimmed.startsWith('import') || trimmed.startsWith('export')) continue;
          if (trimmed.includes('buildInstanceRecallInjection(') || trimmed.includes('assertNotHistoryDump(')) {
            callers.push(`${rel}: ${trimmed}`);
          }
        }
      }
    }
    // 定义处（recall-limits.ts 自身）不算调用方：函数体里 assert 由 build 调用。
    const outsideDefinition = callers.filter(
      (entry) => !entry.startsWith('src/memory/recall-limits.ts:'),
    );
    // 【原断言 → 新断言】原断言 `outsideDefinition` 必须为空，固化 **N-1 缺陷**
    // （承载闸门的函数在生产代码里无人调用 ⇒ 闸门在生产上永不执行）。
    // N-1 修复后产品路由 `apps/demo/server/memory-routes.ts`（两处）调用它。
    // 若有人把产品路由的调用去掉，下面按文件名的断言会重新变红。
    const callerFiles = [...new Set(outsideDefinition.map((entry) => entry.slice(0, entry.indexOf(': '))))].sort();
    expect(callerFiles).toContain('apps/demo/server/memory-routes.ts');
    // 且确实**不止一处**（查看/搜索 + 实例注入两条产品路径都走它）。
    const fromProduct = outsideDefinition.filter((entry) =>
      entry.startsWith('apps/demo/server/memory-routes.ts:'),
    );
    expect(fromProduct.length).toBeGreaterThanOrEqual(2);
  });
});
