/**
 * 记忆持久端口的**文件落盘实现** —— `MemoryPersistencePort`（`memory-routes.ts` 定义）的生产后端。
 *
 * ## 它补的是哪块空白（R220）
 *
 * `memory-routes.ts` 只**消费**一个 `MemoryPersistencePort`；它自己**不落盘、不起进程**
 * （文件头"如实标注"已写明）。本文件把这个端口接到**真实文件**上，于是"忘记后重启不复活"
 * 那条链路不再依赖"以变量为后端"的易失端口。
 *
 * ## 五条判据（每条都有反向对照，见 `memory-persistence.test.ts`）
 *
 * 1. **原子写**：先写 `<file>.tmp-<pid>-<seq>` 并 `fsync`，再 `rename` 覆盖目标。
 *    读者**要么见旧版、要么见新版**，绝无半份状态（rename 是文件系统级的原子替换）。
 *    任一步失败 ⇒ 清掉未提交的 tmp，目标文件保持原样，并抛 `MemoryPersistenceError`。
 * 2. **损坏 / 畸形存量文件 ⇒ 拒绝启动端口**（`ok:false` + **具名原因**），
 *    **绝不当作"空记忆"静默清空**。缺文件是"不存在"（`load() === null`），
 *    坏文件是"拒绝"——这两者在 API 上是**两个不同分支**，不许合并。
 * 3. **schema 版本守卫**：复用 `planMemoryMigration` 的口径——不认识的版本一律**拒绝**
 *    （不猜转换）。load 与 save 两侧都过这道闸。
 * 4. **凭据不落盘（防御性第二道）**：落盘前把备份重开成仓库，再跑一次
 *    `planMemoryBackup`（与 `backup-plan` **同口径**）；只要检出夹带凭据的条目，
 *    就**抛错拒绝、一个字节都不写**。第一道（宿主备备份时剔除）之外再兜一层。
 * 5. **真实往返**：`save` → **新端口实例** `load` → `reopenMemoryStore` 后记忆仍在，
 *    且"忘记过的条目不复活"（墓碑与派生失效位随备份同行）。
 *
 * ## ⚠️ 如实标注（结果不得编造）
 *
 * - 本模块的往返测试是**同进程重开**：新建端口 / 仓库对象，但**不启动第二个进程**。
 *   因此它**不代表**已做真实跨进程验证——跨进程可见性属于 `src/storage/file-store.ts`
 *   的职责。跨重启后磁盘上确实有文件、新进程读回一致，这一步**未在本模块验证**（标"未验证"）。
 * - 崩溃窗口：本模块保证"rename 原子"，但**未** fsync 目录项；掉电后 rename 是否持久
 *   取决于文件系统，本模块**不宣称**掉电级持久性。
 * - IO **只**出现在本文件（`apps/demo/server/**`）；内核 `src/**` 不碰 IO。
 *
 * 【模型身份】交付说明：本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

import {
  MEMORY_BACKUP_SCHEMA,
  planMemoryBackup,
  planMemoryMigration,
  reopenMemoryStore,
  type MemoryBackupEnvelope,
} from '../../../src/memory/index.js';
import { asLogicalTime, type LogicalTime } from '../../../src/protocol/index.js';

import type { MemoryPersistencePort } from './memory-routes.js';

// ---------------------------------------------------------------------------
// 失败原因（具名、机器可判）
// ---------------------------------------------------------------------------

/**
 * 端口失败原因。
 *
 * - `unreadable`：读不出 / 不是合法 JSON；
 * - `bad_schema`：schema 版本不认识（复用 `planMemoryMigration` 的裁决）；
 * - `corrupt`：结构畸形（缺 `snapshot`、字段不是数组、顶层不是对象）；
 * - `credential_leak`：落盘前第二道凭据检查命中（**一个字节都不写**）；
 * - `write_failed`：原子写失败（不会留下半份）。
 */
export const MEMORY_PERSISTENCE_FAILURES = [
  'unreadable',
  'bad_schema',
  'corrupt',
  'credential_leak',
  'write_failed',
] as const;
export type MemoryPersistenceFailure = (typeof MEMORY_PERSISTENCE_FAILURES)[number];

/** 端口层结构化错误（带 `reason`，调用方不必靠错误文本匹配）。 */
export class MemoryPersistenceError extends Error {
  readonly reason: MemoryPersistenceFailure;
  constructor(reason: MemoryPersistenceFailure, message: string) {
    super(message);
    this.name = 'MemoryPersistenceError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// 校验（load 与 save 共用）
// ---------------------------------------------------------------------------

type BackupInspection =
  | { readonly ok: true; readonly envelope: MemoryBackupEnvelope; readonly schema: string }
  | { readonly ok: false; readonly reason: MemoryPersistenceFailure; readonly detail: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function msg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const SNAPSHOT_ARRAY_FIELDS = [
  'session_messages',
  'task_facts',
  'preferences',
  'template_experiences',
  'tombstones',
  'derived',
] as const;

/**
 * 校验一段备份文本。**不认识的 schema 一律拒绝**（复用 `planMemoryMigration` 的口径）。
 * 纯函数：不碰文件系统。
 */
function inspectBackup(text: string): BackupInspection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: 'unreadable', detail: `不是合法 JSON（${msg(error)}）` };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, reason: 'corrupt', detail: `顶层不是对象（收到 ${typeof parsed}）` };
  }
  const schema = parsed['schema'];
  if (typeof schema !== 'string' || schema.length === 0) {
    return { ok: false, reason: 'corrupt', detail: `缺少 schema 字段（收到 ${JSON.stringify(schema)}）` };
  }
  if (!planMemoryMigration(schema).supported) {
    return {
      ok: false,
      reason: 'bad_schema',
      detail:
        `schema ${JSON.stringify(schema)} 不是已知版本（期望 ${JSON.stringify(MEMORY_BACKUP_SCHEMA)}）：` +
        '拒绝，不猜转换',
    };
  }
  const snapshot = parsed['snapshot'];
  if (!isPlainObject(snapshot)) {
    return { ok: false, reason: 'corrupt', detail: '缺少 snapshot 对象' };
  }
  for (const field of SNAPSHOT_ARRAY_FIELDS) {
    if (!Array.isArray(snapshot[field])) {
      return { ok: false, reason: 'corrupt', detail: `snapshot.${field} 不是数组` };
    }
  }
  return { ok: true, envelope: parsed as unknown as MemoryBackupEnvelope, schema };
}

/** 备份里四类条目总数（不含墓碑 / 派生）。 */
function countEntries(envelope: MemoryBackupEnvelope): number {
  return (
    envelope.snapshot.session_messages.length +
    envelope.snapshot.task_facts.length +
    envelope.snapshot.preferences.length +
    envelope.snapshot.template_experiences.length
  );
}

// ---------------------------------------------------------------------------
// 原子写
// ---------------------------------------------------------------------------

let tmpSeq = 0;

/** 物理写入的可注入接缝（**默认全部未设置**，只在隔离测试里赋值）。 */
export interface MemoryFilePersistenceHooks {
  /** tmp 打开 / 写入**之前**。抛错 ⇒ 复现"写不动"（磁盘满 / 权限）。 */
  readonly beforeWrite?: (temporary: string, target: string) => void;
  /** tmp 写完、`rename` **之前**。抛错 ⇒ 复现崩溃窗口"tmp 完整但未提交"。 */
  readonly beforeRename?: (temporary: string, target: string) => void;
  /** `rename` **之后**（新版本已可见）。 */
  readonly afterRename?: (target: string) => void;
}

/**
 * 原子落盘：写 tmp → fsync → rename（覆盖目标）。
 *
 * **半份状态不可能存在**：失败路径清掉未提交的 tmp 并抛错，目标文件原样保留
 * （`rename` 要么整体成功、要么整体没发生）。
 */
function atomicWrite(
  target: string,
  payload: string,
  hooks: MemoryFilePersistenceHooks | undefined,
): void {
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${String(process.pid)}-${String(tmpSeq++)}`;
  try {
    hooks?.beforeWrite?.(temporary, target);
    const fd = openSync(temporary, 'w');
    try {
      writeSync(fd, payload);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    hooks?.beforeRename?.(temporary, target);
    renameSync(temporary, target);
    hooks?.afterRename?.(target);
  } catch (error) {
    // **不留半份**：未提交的 tmp 一律清掉；目标文件保持原样（rename 未发生）。
    try {
      if (existsSync(temporary)) rmSync(temporary, { force: true });
    } catch {
      // 清理失败也不掩盖原始错误
    }
    if (error instanceof MemoryPersistenceError) throw error;
    throw new MemoryPersistenceError('write_failed', `原子写失败（目标 ${target}）：${msg(error)}`);
  }
}

// ---------------------------------------------------------------------------
// 端口
// ---------------------------------------------------------------------------

/** 端口打开时对存量文件的**如实自检**（应接进 boot 输出，而不是丢掉）。 */
export interface MemoryLoadReport {
  readonly file_path: string;
  /** 文件是否存在（不存在 = 全新运行目录，不是错误）。 */
  readonly file_present: boolean;
  /** 是否真把一份**通过校验**的备份读进了端口（全新目录 ⇒ `false`）。 */
  readonly loaded: boolean;
  /** 备份 schema（无文件 ⇒ `null`）。 */
  readonly schema: string | null;
  /** 备份内四类条目总数（无文件 ⇒ `null`）。 */
  readonly entries: number | null;
  readonly reason: string;
}

/** 文件落盘端口：在 `MemoryPersistencePort` 之上补端口自检与文件路径。 */
export interface FileMemoryPersistencePort extends MemoryPersistencePort {
  readonly filePath: string;
  /** 打开端口时的存量自检报告。 */
  readonly loadReport: MemoryLoadReport;
}

export interface OpenFileMemoryPersistenceOptions {
  /** 备份文件绝对路径（目录不存在会自动建）。 */
  readonly filePath: string;
  /** 物理写入接缝（测试用）。 */
  readonly hooks?: MemoryFilePersistenceHooks;
  /** 逻辑时间源：落盘第二道凭据检查调用 `planMemoryBackup` 时用（默认 0）。 */
  readonly at?: () => LogicalTime;
}

export type OpenFileMemoryPersistenceResult =
  | { readonly ok: true; readonly port: FileMemoryPersistencePort; readonly loadReport: MemoryLoadReport }
  | { readonly ok: false; readonly reason: MemoryPersistenceFailure; readonly detail: string };

/**
 * 打开一个**文件落盘**的记忆持久端口。
 *
 * 打开时即对存量文件做一次校验：
 * - 文件不存在 ⇒ `ok:true`，`load()` 返回 `null`（**全新**，不是"损坏当空"）；
 * - 文件存在但损坏 / schema 不认识 ⇒ **`ok:false` + 具名原因**，**不返回端口**
 *   （调用方不得据此构造"空记忆"仓库；文件也**不被改写 / 删除**）。
 */
export function openFileMemoryPersistence(
  options: OpenFileMemoryPersistenceOptions,
): OpenFileMemoryPersistenceResult {
  const filePath = options.filePath;
  const hooks = options.hooks;
  const at = options.at ?? ((): LogicalTime => asLogicalTime(0));

  let stored: string | null = null;
  let loadReport: MemoryLoadReport;

  if (!existsSync(filePath)) {
    loadReport = Object.freeze({
      file_path: filePath,
      file_present: false,
      loaded: false,
      schema: null,
      entries: null,
      reason: '全新运行目录：无存量备份文件，按"空记忆"起步（这是**不存在**，不是"损坏当空"）',
    });
  } else {
    let text: string;
    try {
      text = readFileSync(filePath, 'utf8');
    } catch (error) {
      return {
        ok: false,
        reason: 'unreadable',
        detail: `存量备份文件读取失败：${msg(error)}（拒绝启动端口，绝不当作"空记忆"）`,
      };
    }
    const inspected = inspectBackup(text);
    if (!inspected.ok) {
      return {
        ok: false,
        reason: inspected.reason,
        detail:
          `存量备份文件 ${filePath} 未通过校验：${inspected.detail}` +
          '（拒绝启动端口，绝不当作"空记忆"静默清空）',
      };
    }
    stored = text;
    const entries = countEntries(inspected.envelope);
    loadReport = Object.freeze({
      file_path: filePath,
      file_present: true,
      loaded: true,
      schema: inspected.schema,
      entries,
      reason: `已读入存量备份（schema=${inspected.schema}，四类共 ${String(entries)} 条）：端口就绪`,
    });
  }

  const port: FileMemoryPersistencePort = {
    filePath,
    loadReport,
    load(): string | null {
      return stored;
    },
    save(backup: string): void {
      // schema / 结构守卫（save 侧同样拒绝，不写半份）。
      const inspected = inspectBackup(backup);
      if (!inspected.ok) {
        throw new MemoryPersistenceError(inspected.reason, `拒绝落盘：${inspected.detail}`);
      }

      // 凭据**第二道**（与 `backup-plan` 同口径）：重开成仓库 → planMemoryBackup。
      const reopened = reopenMemoryStore(backup);
      if (reopened.kind === 'failed') {
        throw new MemoryPersistenceError(
          'bad_schema',
          `拒绝落盘：备份无法重开（${reopened.reason}）${reopened.detail}`,
        );
      }
      const plan = planMemoryBackup(reopened.repository, { at: at() });
      if (plan.credential_leak_detected) {
        const named = plan.credential_exclusions.map((item) => String(item.memory_id)).join('、');
        throw new MemoryPersistenceError(
          'credential_leak',
          `拒绝落盘：备份仍夹带凭据（${named}，共 ${String(plan.credential_exclusions.length)} 条）——` +
            '密钥与凭据一律不落盘（防御性第二道）。一个字节都未写入。',
        );
      }

      atomicWrite(filePath, backup, hooks);
      stored = backup;
    },
  };

  return { ok: true, port, loadReport };
}
