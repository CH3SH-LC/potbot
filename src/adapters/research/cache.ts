/**
 * RES-06 —— **带时间与失效规则的缓存**：过时主动刷新、下载/索引与摘要不丢来源。
 *
 * 三条纪律：
 * 1. **时间是注入的**：不读墙钟（`Date.now()` 是本仓 `src/**` 的禁用 token），
 *    一律经 `ClockPort.now()` 取"现在"，故缓存行为在测试里完全确定、可复现；
 * 2. **不丢来源**：外部内容（下载的页面、外部索引）**必须**携带来源出处
 *    （sourceId / 原地址 / 标题 / 获取时间）与摘要指向（summaryOfSourceId）才会入缓存；
 *    缺来源的入缓存请求被**拒绝**，且**绝不**静默写入；
 * 3. **过时主动刷新**：`refreshBeforeMs` 定义"临期"窗口，进入窗口即视为需要主动刷新；
 *    刷新失败**保留旧值**并如实报错，不把旧值当新值、也不丢缓存。
 *
 * 本文件不含 `node:fs` / 墙钟 / 随机。
 */
import type { ClockPort } from './ports.js';

/** 缓存内容类型：外部（联网/下载）或私有（用户资料）。 */
export type CacheKind = 'external' | 'private';

/** 来源出处 —— 外部内容入缓存的强制字段（RES-06「不丢来源」）。 */
export interface SourceRef {
  /** 内容寻址的来源 ID（与检索切片同一命名口径）。 */
  readonly sourceId: string;
  /** 原始地址（外部内容为 URL；私有资料可为 null）。 */
  readonly url: string | null;
  readonly title: string | null;
  /** 获取/入库时间（毫秒，来自注入时钟）。 */
  readonly fetchedAt: number;
}

/** 失效规则。 */
export interface CacheRule {
  /** 相对存活时间（毫秒），自 `storedAt` 起算。 */
  readonly ttlMs?: number;
  /** 绝对失效时刻（毫秒）；与 ttlMs 并存时取更早者。 */
  readonly expiresAt?: number;
  /** 临期窗口：距失效不足该值时，视为"需要主动刷新"。 */
  readonly refreshBeforeMs?: number;
}

export interface CacheEntry<T> {
  readonly key: string;
  readonly kind: CacheKind;
  readonly value: T;
  readonly storedAt: number;
  readonly rule: CacheRule;
  /** 外部内容必填；私有资料可为 null。 */
  readonly source: SourceRef | null;
  /** 若该条目是某个来源的**摘要/索引**，指向其来源 ID（摘要不丢来源）。 */
  readonly summaryOfSourceId: string | null;
}

export type PutResult =
  | { readonly ok: true; readonly entry: CacheEntry<never> }
  | { readonly ok: false; readonly reason: string };

export type Freshness<T> =
  | { readonly status: 'missing'; readonly key: string }
  | {
      readonly status: 'fresh';
      readonly entry: CacheEntry<T>;
      readonly ageMs: number;
      readonly expiresAt: number;
      readonly needsRefresh: boolean;
    }
  | {
      readonly status: 'stale';
      readonly entry: CacheEntry<T>;
      readonly ageMs: number;
      readonly expiresAt: number;
      readonly reason: string;
    };

export interface RefreshResult<T> {
  readonly value: T;
  /** 刷新得到的外部内容必须给出（或沿用）来源出处。 */
  readonly source?: SourceRef | null;
}

export type GetOrRefreshOutcome<T> =
  | { readonly status: 'fresh'; readonly entry: CacheEntry<T>; readonly refreshed: false }
  | { readonly status: 'refreshed'; readonly entry: CacheEntry<T>; readonly refreshed: true }
  | {
      readonly status: 'refresh-failed';
      readonly reason: string;
      /** 刷新失败时**保留**的旧条目（可能为 null）。 */
      readonly previous: CacheEntry<T> | null;
    }
  | { readonly status: 'missing'; readonly key: string };

export interface PutRequest<T> {
  readonly key: string;
  readonly kind: CacheKind;
  readonly value: T;
  readonly rule?: CacheRule;
  readonly source?: SourceRef | null;
  readonly summaryOfSourceId?: string | null;
}

/** 计算条目的失效时刻（ttl 与绝对时刻取更早者）。 */
export function expiresAtOf(entry: CacheEntry<unknown>): number {
  const fromTtl =
    entry.rule.ttlMs !== undefined ? entry.storedAt + entry.rule.ttlMs : Number.POSITIVE_INFINITY;
  const absolute =
    entry.rule.expiresAt !== undefined ? entry.rule.expiresAt : Number.POSITIVE_INFINITY;
  return Math.min(fromTtl, absolute);
}

/**
 * 缓存不丢来源的**强制校验**：外部内容必须有出处，摘要必须有来源指向。
 * @returns 不合规时为原因字符串，合规时为 null。
 */
export function checkAttribution(request: PutRequest<unknown>): string | null {
  if (request.kind === 'external') {
    if (request.source === null || request.source === undefined) {
      return '外部内容入缓存必须携带来源出处（sourceId / url / 获取时间），拒绝无来源缓存';
    }
    if (typeof request.source.sourceId !== 'string' || request.source.sourceId.length === 0) {
      return '来源出处缺少 sourceId';
    }
    if (request.source.fetchedAt <= 0) {
      return '来源出处缺少获取时间（fetchedAt）';
    }
  }
  if (request.summaryOfSourceId !== undefined && request.summaryOfSourceId !== null) {
    if (request.summaryOfSourceId.length === 0) {
      return '摘要来源指向为空字符串';
    }
    if (request.kind === 'external' && request.source !== null && request.source !== undefined) {
      // 摘要必须指向它自己的来源，避免"摘要是别处的"。
      if (request.summaryOfSourceId !== request.source.sourceId) {
        return `摘要指向的来源 ${request.summaryOfSourceId} 与其自身来源 ${request.source.sourceId} 不一致`;
      }
    }
  }
  return null;
}

/**
 * 带时效的缓存。泛型 T 为缓存值类型（如页面正文、索引快照、摘要）。
 */
export class FreshnessCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  constructor(private readonly clock: ClockPort) {}

  /** 写入一条。不合规（丢来源）⇒ 拒绝且不写入。 */
  put(request: PutRequest<T>): PutResult {
    const breach = checkAttribution(request as PutRequest<unknown>);
    if (breach !== null) {
      return { ok: false, reason: breach };
    }
    const entry: CacheEntry<T> = {
      key: request.key,
      kind: request.kind,
      value: request.value,
      storedAt: this.clock.now(),
      rule: request.rule ?? {},
      source: request.source ?? null,
      summaryOfSourceId: request.summaryOfSourceId ?? null,
    };
    this.entries.set(request.key, entry);
    return { ok: true, entry: entry as unknown as CacheEntry<never> };
  }

  /** 读一条并判时效。 */
  get(key: string): Freshness<T> {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return { status: 'missing', key };
    }
    const now = this.clock.now();
    const expiresAt = expiresAtOf(entry);
    const ageMs = now - entry.storedAt;
    if (now >= expiresAt) {
      return {
        status: 'stale',
        entry,
        ageMs,
        expiresAt,
        reason: `已过失效时刻（now=${now} ≥ expiresAt=${expiresAt}）`,
      };
    }
    const refreshBefore = entry.rule.refreshBeforeMs ?? 0;
    const needsRefresh = refreshBefore > 0 && now >= expiresAt - refreshBefore;
    return { status: 'fresh', entry, ageMs, expiresAt, needsRefresh };
  }

  /** 直接取原始条目（不做时效判断；供展示层读取来源）。 */
  raw(key: string): CacheEntry<T> | null {
    return this.entries.get(key) ?? null;
  }

  /**
   * 读一条；缺失 / 过时 / 临期都触发**主动刷新**。
   * 刷新抛错 ⇒ 保留旧值并如实报 `refresh-failed`。
   */
  async getOrRefresh(
    key: string,
    refresher: (previous: CacheEntry<T> | null) => Promise<RefreshResult<T>>,
  ): Promise<GetOrRefreshOutcome<T>> {
    const view = this.get(key);
    if (view.status === 'fresh' && !view.needsRefresh) {
      return { status: 'fresh', entry: view.entry, refreshed: false };
    }

    const previous = view.status === 'missing' ? null : view.entry;
    let refreshed: RefreshResult<T>;
    try {
      refreshed = await refresher(previous);
    } catch (error) {
      return {
        status: 'refresh-failed',
        reason: `刷新失败：${(error as Error).message}`,
        previous,
      };
    }

    // 刷新出的外部内容必须能确定来源：新给的优先，否则沿用旧条目的来源。
    const source = refreshed.source ?? previous?.source ?? null;
    const summaryOfSourceId = previous?.summaryOfSourceId ?? null;
    const kind = previous?.kind ?? 'external';
    const put = this.put({
      key,
      kind,
      value: refreshed.value,
      rule: previous?.rule ?? {},
      source,
      summaryOfSourceId,
    });
    if (!put.ok) {
      return { status: 'refresh-failed', reason: `刷新结果丢来源：${put.reason}`, previous };
    }
    return { status: 'refreshed', entry: this.entries.get(key) as CacheEntry<T>, refreshed: true };
  }

  invalidate(key: string): boolean {
    return this.entries.delete(key);
  }

  /** 按来源失效（删除来源后，其下载内容与摘要一并失效）。 */
  invalidateBySource(sourceId: string): readonly string[] {
    const removed: string[] = [];
    for (const [key, entry] of this.entries) {
      if (entry.source?.sourceId === sourceId || entry.summaryOfSourceId === sourceId) {
        this.entries.delete(key);
        removed.push(key);
      }
    }
    return removed;
  }

  /** 列出全部条目（含来源），供"缓存不丢来源"的可审计视图。 */
  list(): readonly CacheEntry<T>[] {
    return [...this.entries.values()];
  }

  size(): number {
    return this.entries.size;
  }
}
