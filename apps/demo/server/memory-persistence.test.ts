/**
 * 文件落盘的记忆持久端口（`memory-persistence.ts`）的定向套件。
 *
 * 每条判据都配一条**反向对照**（题目要求）：
 *
 * | 判据 | 反向对照（本文件怎么把它打红） |
 * |---|---|
 * | 全新目录 ⇒ 空记忆 | 损坏文件**不得**走同一分支（必须 `ok:false`，且文件原样保留） |
 * | 真实往返（含忘记不复活） | 备份里**同时**有条目与墓碑时，重开后该条目**必须消失** |
 * | 凭据不落盘（第二道） | 带凭据的备份 save **必须抛**，且磁盘**一个字节都不变** |
 * | 原子写 | rename 前失败 ⇒ 目标文件仍是**旧版**，且**无 tmp 残留** |
 * | schema 守卫 | 未知版本 save / load 双侧都**拒绝**（复用 `planMemoryMigration` 口径） |
 *
 * ## ⚠️ 如实标注
 *
 * 本套件的"新端口实例"是**同进程重开**：新建端口 / 仓库对象，**不启动第二个进程**。
 * 因此它**不代表**已做真实跨进程验证（跨进程可见性属 `src/storage/file-store.ts` 职责）。
 * 全程用 `os.tmpdir()` 下的临时目录，**不碰 `.runtime/`**、不连真机。
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { asLogicalTime, asRevision, asTaskId, asTemplateId } from '../../../src/protocol/index.js';
import {
  MEMORY_BACKUP_SCHEMA,
  asMemoryId,
  asOwnerId,
  createMemoryEntry,
  createMemoryRepository,
  planMemoryMigration,
  reopenMemoryStore,
  serializeMemoryBackup,
  type MemoryRepository,
} from '../../../src/memory/index.js';

import { createMemoryRouteHost } from './memory-routes.js';
import {
  MemoryPersistenceError,
  openFileMemoryPersistence,
  type FileMemoryPersistencePort,
} from './memory-persistence.js';

// ---------------------------------------------------------------------------
// 夹具（临时目录用完即删，绝不碰 .runtime/）
// ---------------------------------------------------------------------------

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'potbot-mem-persist-'));
  dirs.push(dir);
  return join(dir, 'memory-backup.json');
}

const T = (n: number) => asLogicalTime(n);

/** 种子仓库：owner-a 四类各一条（均无凭据）。 */
function seedRepository(): MemoryRepository {
  const repo = createMemoryRepository();
  const add = (raw: Record<string, unknown>): void => {
    const result = repo.remember(createMemoryEntry(raw));
    if (!result.ok) throw new Error(`种子写入失败：${result.reason} ${result.detail}`);
  };
  const base = {
    source: { kind: 'user_statement', detail: '种子数据' },
    confirmation: 'confirmed',
    created_at: T(10),
    updated_at: T(10),
    version: asRevision(0),
    status: 'active',
  };
  const userScope = { kind: 'user', task_id: null, template_id: null };
  add({ ...base, kind: 'session_message', memory_id: 'sm-1', owner_id: 'owner-a', scope: userScope, conversation_id: 'conv-1', role: 'user', text: '周报要点：本周完成落盘端口' });
  add({ ...base, kind: 'preference', memory_id: 'pf-1', owner_id: 'owner-a', scope: userScope, preference_key: 'font', value_text: '宋体' });
  add({ ...base, kind: 'task_fact', memory_id: 'tf-1', owner_id: 'owner-a', scope: { kind: 'task', task_id: asTaskId('task-1'), template_id: null }, task_id: asTaskId('task-1'), fact_key: 'week', value_text: 'W40' });
  add({ ...base, kind: 'template_experience', memory_id: 'ex-1', owner_id: 'owner-a', scope: { kind: 'template', task_id: null, template_id: asTemplateId('tpl-1') }, template_id: asTemplateId('tpl-1'), lesson: '先写大纲再写正文', applies_to_version: 'v1' });
  return repo;
}

/** 一份**干净**的备份文本（种子仓库的序列化）。 */
function cleanBackup(): string {
  return serializeMemoryBackup(seedRepository(), { at: T(20) });
}

/** 一份**夹带凭据**的备份文本（`serializeMemoryBackup` 只 dump，不剔除）。 */
function credentialBackup(): string {
  const repo = createMemoryRepository();
  const result = repo.remember(
    createMemoryEntry({
      kind: 'preference',
      memory_id: 'pf-secret',
      owner_id: 'owner-a',
      scope: { kind: 'user', task_id: null, template_id: null },
      source: { kind: 'user_statement', detail: '凭据夹具' },
      confirmation: 'confirmed',
      created_at: T(10),
      updated_at: T(10),
      version: asRevision(0),
      status: 'active',
      preference_key: 'api_key',
      value_text: 'sk-ABCDEFGHIJKLMNOPQRSTUVWX',
    }),
  );
  if (!result.ok) throw new Error(`凭据夹具写入失败：${result.reason} ${result.detail}`);
  return serializeMemoryBackup(repo, { at: T(20) });
}

/** 打开成功断言（顺带把 `ok:false` 变红，避免误用）。 */
function opened(filePath: string, hooks?: Parameters<typeof openFileMemoryPersistence>[0]['hooks']): FileMemoryPersistencePort {
  const result = openFileMemoryPersistence(hooks === undefined ? { filePath } : { filePath, hooks });
  if (!result.ok) throw new Error(`期望端口打开成功，实际被拒：${result.reason} ${result.detail}`);
  return result.port;
}

function tmpLeftovers(dir: string): readonly string[] {
  return readdirSync(dir).filter((name) => name.includes('.tmp-'));
}

// ---------------------------------------------------------------------------
// 1. 全新目录 / 真实往返
// ---------------------------------------------------------------------------

describe('端口打开与真实往返', () => {
  it('全新运行目录：无文件 ⇒ ok:true、load() 为 null（"不存在"，不是"损坏当空"）', () => {
    const file = tmpFile();
    const result = openFileMemoryPersistence({ filePath: file });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.loadReport.file_present).toBe(false);
    expect(result.loadReport.loaded).toBe(false);
    expect(result.loadReport.entries).toBeNull();
    expect(result.port.load()).toBeNull();
    expect(existsSync(file)).toBe(false);
  });

  it('save → 新端口实例 load → 记忆仍在，且忘记过的条目**不复活**', () => {
    const file = tmpFile();
    const repo = seedRepository();
    repo.forget(asMemoryId('pf-1'), asOwnerId('owner-a')); // 忘记一条

    const first = opened(file);
    const backup = serializeMemoryBackup(repo, { at: T(20) });
    first.save(backup);
    expect(existsSync(file)).toBe(true);

    // **新端口实例**（同进程重开；不等于真实跨进程）
    const second = opened(file);
    const raw = second.load();
    expect(raw).toBe(backup); // 字节保真
    expect(second.loadReport.entries).toBe(3);
    expect(second.loadReport.schema).toBe(MEMORY_BACKUP_SCHEMA);

    const store = reopenMemoryStore(raw as string);
    expect(store.kind).toBe('reopened');
    if (store.kind !== 'reopened') throw new Error('unreachable');
    expect(store.repository.get(asMemoryId('sm-1'))).toBeDefined();
    expect(store.repository.get(asMemoryId('tf-1'))).toBeDefined();
    expect(store.repository.get(asMemoryId('ex-1'))).toBeDefined();
    expect(store.repository.get(asMemoryId('pf-1'))).toBeUndefined(); // 忘记的不复活

    // 端口可直接喂给真实消费者（`memory-routes` 的宿主）
    const host = createMemoryRouteHost({ persistence: second });
    expect(host.ready).toBe(true);
  });

  it('反向对照：备份里**同时**有条目与墓碑 ⇒ 重开后该条目必须消失（墓碑优先）', () => {
    const file = tmpFile();
    const raw = JSON.parse(cleanBackup()) as { snapshot: { preferences: unknown[]; tombstones: string[] } };
    expect(raw.snapshot.preferences).toHaveLength(1); // 条目确在备份里
    raw.snapshot.tombstones.push('pf-1'); // 同一 id 又打了墓碑

    const port = opened(file);
    port.save(JSON.stringify(raw));

    const second = opened(file);
    const store = reopenMemoryStore(second.load() as string);
    expect(store.kind).toBe('reopened');
    if (store.kind !== 'reopened') throw new Error('unreachable');
    expect(store.repository.get(asMemoryId('pf-1'))).toBeUndefined();
    expect(store.report.skipped_tombstoned).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. 损坏 / 畸形 / 未知 schema ⇒ 拒绝启动（反向对照：不得当空）
// ---------------------------------------------------------------------------

describe('损坏与 schema 守卫（拒绝启动，绝不当空记忆）', () => {
  it('非法 JSON ⇒ ok:false / unreadable，且文件原样保留（未静默清空）', () => {
    const file = tmpFile();
    const garbage = '{ 这不是 JSON';
    writeFileSync(file, garbage, 'utf8');

    const result = openFileMemoryPersistence({ filePath: file });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('unreadable');
    // 关键反向断言：绝不是"ok:true 且 load()===null"这条"空记忆"分支
    expect(readFileSync(file, 'utf8')).toBe(garbage);
  });

  it('合法 JSON 但结构畸形（缺 snapshot）⇒ corrupt，文件保留', () => {
    const file = tmpFile();
    const malformed = JSON.stringify({ schema: MEMORY_BACKUP_SCHEMA, created_at: 0, owner_scope: [] });
    writeFileSync(file, malformed, 'utf8');

    const result = openFileMemoryPersistence({ filePath: file });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('corrupt');
    expect(readFileSync(file, 'utf8')).toBe(malformed);
  });

  it('snapshot 字段不是数组 ⇒ corrupt', () => {
    const file = tmpFile();
    const broken = JSON.parse(cleanBackup()) as { snapshot: Record<string, unknown> };
    broken.snapshot['tombstones'] = '不是数组';
    writeFileSync(file, JSON.stringify(broken), 'utf8');

    const result = openFileMemoryPersistence({ filePath: file });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('corrupt');
  });

  it('不认识的 schema 版本 ⇒ bad_schema（复用 planMemoryMigration 口径）', () => {
    const file = tmpFile();
    const future = JSON.parse(cleanBackup()) as { schema: string };
    future.schema = 'potbot-memory-backup.v99';
    writeFileSync(file, JSON.stringify(future), 'utf8');

    // 口径来源：planMemoryMigration 对未知版本一律 supported=false
    expect(planMemoryMigration('potbot-memory-backup.v99').supported).toBe(false);

    const result = openFileMemoryPersistence({ filePath: file });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('bad_schema');
  });

  it('save 侧同样拒绝未知 schema（不写半份）', () => {
    const file = tmpFile();
    const port = opened(file);
    const future = JSON.parse(cleanBackup()) as { schema: string };
    future.schema = 'potbot-memory-backup.v99';

    expect(() => {
      port.save(JSON.stringify(future));
    }).toThrow(MemoryPersistenceError);
    expect(existsSync(file)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. 凭据不落盘（防御性第二道）
// ---------------------------------------------------------------------------

describe('凭据不落盘（第二道）', () => {
  it('带凭据的备份 ⇒ save 抛 credential_leak，磁盘一个字节都不写', () => {
    const file = tmpFile();
    const port = opened(file);

    let caught: unknown;
    try {
      port.save(credentialBackup());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MemoryPersistenceError);
    expect((caught as MemoryPersistenceError).reason).toBe('credential_leak');
    expect(existsSync(file)).toBe(false); // 反向对照：凭据绝不落盘
  });

  it('反向对照：已存在旧版时，带凭据的 save 不得改动旧版', () => {
    const file = tmpFile();
    const port = opened(file);
    const good = cleanBackup();
    port.save(good); // 先落一版干净的

    expect(() => {
      port.save(credentialBackup());
    }).toThrow(/凭据|credential/);
    expect(readFileSync(file, 'utf8')).toBe(good); // 旧版原样
    expect(tmpLeftovers(dirname(file))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. 原子写：写失败不留半份
// ---------------------------------------------------------------------------

describe('原子写', () => {
  it('rename 前失败 ⇒ 目标仍是旧版，无 tmp 残留，抛出 write_failed', () => {
    const file = tmpFile();
    const good = cleanBackup();
    opened(file).save(good);
    const before = readFileSync(file, 'utf8');
    const dir = join(file, '..');

    const failing = opened(file, {
      beforeRename: () => {
        throw new Error('模拟 rename 前崩溃');
      },
    });

    let caught: unknown;
    try {
      failing.save(credentialFreeVariant(good)); // 内容不同、但结构合法
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MemoryPersistenceError);
    expect((caught as MemoryPersistenceError).reason).toBe('write_failed');
    // 反向对照：磁盘要么旧版、要么新版，**绝不半份**
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(tmpLeftovers(dir)).toHaveLength(0); // 未提交的 tmp 已清除
  });

  it('写前失败（全新目录）⇒ 不创建目标文件、无 tmp 残留', () => {
    const file = tmpFile();
    const failing = opened(file, {
      beforeWrite: () => {
        throw new Error('模拟磁盘不可写');
      },
    });
    expect(() => {
      failing.save(cleanBackup());
    }).toThrow(MemoryPersistenceError);
    expect(existsSync(file)).toBe(false);
    expect(tmpLeftovers(dirname(file))).toHaveLength(0);
  });

  it('成功 save 会整体替换为新版（rename 后无 tmp 残留）', () => {
    const file = tmpFile();
    const dir = join(file, '..');
    const good = cleanBackup();
    opened(file).save(good);
    const next = credentialFreeVariant(good);

    let renamed = false;
    const port = opened(file, { afterRename: () => { renamed = true; } });
    port.save(next);

    expect(renamed).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(next);
    expect(tmpLeftovers(dir)).toHaveLength(0);
  });
});

/** 同一份干净备份的**语义等价但字节不同**的变体（改 created_at 用来区分版本）。 */
function credentialFreeVariant(backup: string): string {
  const parsed = JSON.parse(backup) as { created_at: number };
  parsed.created_at = (parsed.created_at as number) + 1;
  return JSON.stringify(parsed);
}
