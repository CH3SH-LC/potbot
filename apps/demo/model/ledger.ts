/**
 * S4 —— 脱敏调用账本 + 额度登记。
 *
 * 位置：`.runtime/mobile-word-demo/<runId>/model-ledger.jsonl`
 *   （可用 `POTBOT_RUNTIME_DIR` 改写；测试用临时目录）
 *
 * 每行一条 JSON。**只记元数据**：绝不记录密钥，也不记录完整响应正文（只记长度）。
 *
 * 额度纪律（合同 v1）：全冲刺真实请求默认上限 12 次；每次**发出请求前**登记，
 * 失败与重试均计数；超预算抛结构化错误而不是继续打。
 * 额度以账本为准（进程重启后从 `budget_reserved` 行数恢复），避免重启白送额度。
 */

import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { ModelCallError } from './errors.js';

export const LEDGER_FILENAME = 'model-ledger.jsonl';

/** 全冲刺默认真实请求上限（合同 v1）。 */
export const DEFAULT_MAX_REQUESTS = 12;

export interface LedgerEntry {
  /**
   * `budget_reserved` —— 一次会消耗额度的请求（发请求前登记）；
   * `call_result`     —— 该次请求的结果；
   * `thinking_param_fallback` —— 代理拒绝了 `thinking:{type:"disabled"}`，
   *   代码自动改用不带该参数的请求体重发。**这条不占额度**：被拒的 POST 不产生任何
   *   模型输出，把它计进"真实请求"会虚增用量，也会在只剩 1 次额度时把回退本身卡死。
   */
  readonly kind: 'budget_reserved' | 'call_result' | 'thinking_param_fallback';
  readonly requestId: string;
  readonly taskId: string;
  readonly provider: string;
  readonly model: string;
  /** 第几次尝试（从 1 起）。 */
  readonly attemptIndex: number;
  readonly startedAt: string;
  /**
   * 本次请求体里是否带了 `thinking: {type:"disabled"}`。
   * 在 `call_result` 行上表示**实际生效**（成功返回）的那次形态。
   */
  readonly thinkingDisabled: boolean;
  /** `call_result` 行：本次逻辑请求是否发生过"代理拒绝 thinking 开关"的自动回退。 */
  readonly thinkingParamRejected?: boolean;
  /** `budget_reserved` 行没有时长。 */
  readonly durationMs?: number;
  /** `call_result` 行才有成败。 */
  readonly ok?: boolean;
  readonly promptChars?: number;
  readonly outputChars?: number;
  readonly errorCode?: string;
  /** 事后补记（例如 preflight 期间先发生、后接入账本的那一次）。 */
  readonly backfilled?: boolean;
  readonly note?: string;
}

/** 从 cwd 向上找含 `apps/demo/contracts.ts` 的目录。tsc 产物目录深度不同，不能只按相对层数推。 */
export function findRepoRoot(startDir: string = process.cwd()): string {
  let current = resolve(startDir);
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(current, 'apps', 'demo', 'contracts.ts'))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolve(startDir);
}

export function resolveRunId(env: NodeJS.ProcessEnv): string {
  const explicit = env.DEMO_RUN_ID?.trim();
  return explicit && explicit.length > 0 ? explicit : 'MWD-20261002-A';
}

export function resolveRuntimeDir(env: NodeJS.ProcessEnv): string {
  const explicit = env.POTBOT_RUNTIME_DIR?.trim();
  if (explicit && explicit.length > 0) return resolve(explicit);
  return join(findRepoRoot(), '.runtime', 'mobile-word-demo', resolveRunId(env));
}

export function resolveLedgerPath(env: NodeJS.ProcessEnv): string {
  const explicit = env.POTBOT_MODEL_LEDGER?.trim();
  if (explicit && explicit.length > 0) return resolve(explicit);
  return join(resolveRuntimeDir(env), LEDGER_FILENAME);
}

export function resolveMaxRequests(env: NodeJS.ProcessEnv): number {
  const raw = env.POTBOT_MODEL_MAX_REQUESTS?.trim();
  if (!raw) return DEFAULT_MAX_REQUESTS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_MAX_REQUESTS;
  return Math.floor(parsed);
}

/** 读账本里已经登记过多少次请求。文件不存在或读失败时返回 0（不静默放宽上限，只保守计数）。 */
export async function countReserved(ledgerPath: string): Promise<number> {
  try {
    const text = await readFile(ledgerPath, 'utf8');
    let count = 0;
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as { kind?: unknown };
        if (entry.kind === 'budget_reserved') count += 1;
      } catch {
        // 坏行不致命：当作没登记过，继续读后面的行。
      }
    }
    return count;
  } catch {
    return 0;
  }
}

/**
 * 额度台账。一次进程内共享一个实例即可；构造时按需从账本恢复已用次数。
 */
export class ModelBudget {
  readonly ledgerPath: string;
  readonly maxRequests: number;
  #used = 0;
  #loaded = false;
  #writeChain: Promise<void> = Promise.resolve();

  constructor(options: { ledgerPath: string; maxRequests: number }) {
    this.ledgerPath = options.ledgerPath;
    this.maxRequests = options.maxRequests;
  }

  static fromEnv(env: NodeJS.ProcessEnv): ModelBudget {
    return new ModelBudget({
      ledgerPath: resolveLedgerPath(env),
      maxRequests: resolveMaxRequests(env),
    });
  }

  /** 已用次数（含本进程内与账本里恢复的）。 */
  get used(): number {
    return this.#used;
  }

  get remaining(): number {
    return Math.max(0, this.maxRequests - this.#used);
  }

  async #ensureLoaded(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    this.#used = await countReserved(this.ledgerPath);
  }

  /**
   * 登记一次将要发出的请求。额度不足时抛 `model_budget_exhausted`（不可重试）。
   * 必须先于 HTTP 调用 await。
   */
  async reserve(entry: Omit<LedgerEntry, 'kind'>): Promise<void> {
    await this.#ensureLoaded();
    if (this.#used >= this.maxRequests) {
      throw new ModelCallError(
        'model_budget_exhausted',
        `模型调用预算已用尽（上限 ${this.maxRequests} 次，已登记 ${this.#used} 次）`,
        false,
      );
    }
    this.#used += 1;
    await this.#append({ kind: 'budget_reserved', ...entry });
  }

  /** 记录一次请求结果。写账本失败不影响主流程，但绝吞掉业务错误。 */
  async record(entry: Omit<LedgerEntry, 'kind'>): Promise<void> {
    await this.#append({ kind: 'call_result', ...entry });
  }

  /**
   * 记录一次「代理拒绝 thinking 开关 → 代码自动回退」。
   * **不占额度**：被拒的 POST 不产生模型输出，且若把它计进真实请求，
   * 在只剩 1 次额度时回退本身就会被预算卡死——那正是要避免的失败模式。
   */
  async noteFallback(entry: Omit<LedgerEntry, 'kind'>): Promise<void> {
    await this.#append({ kind: 'thinking_param_fallback', ...entry });
  }

  async #append(entry: LedgerEntry): Promise<void> {
    const line = `${JSON.stringify(entry)}\n`;
    this.#writeChain = this.#writeChain.then(async () => {
      try {
        await mkdir(dirname(this.ledgerPath), { recursive: true });
        await appendFile(this.ledgerPath, line, 'utf8');
      } catch {
        // 账本落盘失败不阻断生成；额度仍已在内存中扣减。
      }
    });
    await this.#writeChain;
  }
}
