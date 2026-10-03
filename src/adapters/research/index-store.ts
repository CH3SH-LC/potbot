/**
 * 资料索引 —— 建库、检索、**删除联动**与持久化（RES-03/04/09）。
 *
 * 删除语义（RES-09 的核心，也是本合同 R205「删除与撤销语义分开」在本切片的落点）：
 * - 删除来源 ⇒ 该来源的**块全部移除**、正文缓存**一并丢弃**、写入**墓碑（tombstone）**；
 * - 持久化时**墓碑与块同一份快照落盘**，故"离线恢复"不会把已删除来源复活；
 * - 删除后，此前基于它产生的派生结果（回答）通过 `isDerivedResultStillValid` **判为失效**，
 *   不会被当作现役证据复用。
 *
 * 本切片**不做**任何网络出站；索引只在本进程内。
 */
import { chunkDocument, DEFAULT_MAX_CHARS } from './chunk.js';
import { digestBytes } from './digest.js';
import { detectConflicts, extractFromChunk, type Conflict } from './extract.js';
import { parseSource } from './parse/registry.js';
import { assertNoEgress, scanForInjection, scopeToTask, type InjectionFinding } from './privacy.js';
import { searchChunks, type SearchOptions, type SearchResult } from './search.js';
import type { Answer, Chunk, NormalizedDoc, ParseOutcome } from './types.js';

export interface IngestReport {
  readonly sourceId: string;
  readonly name: string;
  readonly outcome: ParseOutcome;
  readonly reason: string | null;
  readonly chunkCount: number;
  readonly injections: readonly InjectionFinding[];
}

export interface DeleteReport {
  readonly sourceId: string;
  readonly removedChunkIds: readonly string[];
  readonly tombstonedAt: number;
  /** 此前基于该来源产生的派生结果（chunkId 集合）全部失效。 */
  readonly invalidatedDerivedChunkIds: readonly string[];
}

export interface QueryResult {
  readonly search: SearchResult;
  readonly conflicts: readonly Conflict[];
  /** 每个来源的正文（供构造引用）。 */
  readonly docs: ReadonlyMap<string, NormalizedDoc>;
  readonly nameOfSource: (sourceId: string) => string;
}

interface SourceMeta {
  readonly sourceId: string;
  readonly name: string;
  readonly taskId: string;
  readonly kind: NormalizedDoc['kind'];
}

interface SnapshotShape {
  readonly version: 1;
  readonly sources: readonly SourceMeta[];
  readonly chunks: readonly Chunk[];
  readonly docs: readonly { sourceId: string; text: string; segments: NormalizedDoc['segments'] }[];
  readonly tombstones: readonly { sourceId: string; taskId: string; at: number }[];
}

/** 内存索引（可快照/还原）。 */
export class ResearchIndex {
  private sources = new Map<string, SourceMeta>();
  private chunks: Chunk[] = [];
  private docs = new Map<string, NormalizedDoc>();
  private tombstones = new Map<string, { taskId: string; at: number }>();
  /** 派生结果登记：回答引用了哪些块（用于删除后判失效）。 */
  private derived = new Map<string, readonly string[]>();

  constructor(private readonly maxChars: number = DEFAULT_MAX_CHARS) {}

  /** 建索引：解析 → 分块 → 入库。解析失败**如实上报**，不建空块。 */
  ingest(taskId: string, name: string, mediaType: string, bytes: Uint8Array): IngestReport {
    const sourceId = digestBytes(bytes);
    const parsed = parseSource(name, mediaType, bytes, sourceId);

    if (parsed.outcome !== 'parsed') {
      // 失败也要留元数据（便于诊断"为什么这份资料查不到"）。
      this.sources.set(sourceId, { sourceId, name, taskId, kind: 'txt' });
      return {
        sourceId,
        name,
        outcome: parsed.outcome,
        reason: parsed.reason,
        chunkCount: 0,
        injections: [],
      };
    }

    const doc = parsed.doc;
    const chunks = chunkDocument(doc, { maxChars: this.maxChars }).map((c) => ({
      ...c,
      sourceName: name,
      taskId,
    }));

    this.sources.set(sourceId, { sourceId, name, taskId, kind: doc.kind });
    this.docs.set(sourceId, doc);
    this.tombstones.delete(sourceId); // 重新入库清除墓碑
    this.chunks = this.chunks.filter((c) => c.sourceId !== sourceId).concat(chunks);

    return {
      sourceId,
      name,
      outcome: 'parsed',
      reason: null,
      chunkCount: chunks.length,
      injections: scanForInjection(doc.text),
    };
  }

  /** 检索：只在该任务的来源内（任务隔离）。 */
  query(taskId: string, query: string, options: SearchOptions = {}): QueryResult {
    const scoped = scopeToTask(this.chunks, taskId);
    const search = searchChunks(scoped, query, options);

    // 冲突检测只在本次命中的块范围内做（避免全库噪声）。
    const hitChunkIds = new Set(search.hits.map((h) => h.chunk.chunkId));
    const values = scoped
      .filter((c) => hitChunkIds.has(c.chunkId))
      .flatMap((c) => {
        const doc = this.docs.get(c.sourceId);
        return doc ? extractFromChunk(doc, c) : [];
      });
    const textOfChunk = (chunkId: string): string =>
      scoped.find((c) => c.chunkId === chunkId)?.text ?? '';
    const conflicts = detectConflicts(values, textOfChunk);

    const docsForHits = new Map<string, NormalizedDoc>();
    for (const h of search.hits) {
      const doc = this.docs.get(h.chunk.sourceId);
      if (doc) {
        docsForHits.set(h.chunk.sourceId, doc);
      }
    }

    return {
      search,
      conflicts,
      docs: docsForHits,
      nameOfSource: (sourceId: string): string => this.sources.get(sourceId)?.name ?? '(未知来源)',
    };
  }

  /** 删除来源 ⇒ 块移除、正文丢弃、写墓碑、派生结果失效。 */
  deleteSource(taskId: string, sourceId: string, at: number): DeleteReport {
    const meta = this.sources.get(sourceId);
    if (meta && meta.taskId !== taskId) {
      throw new Error(`任务隔离违例：任务 ${taskId} 不能删除任务 ${meta.taskId} 的来源 ${sourceId}`);
    }
    const removed = this.chunks.filter((c) => c.sourceId === sourceId).map((c) => c.chunkId);
    this.chunks = this.chunks.filter((c) => c.sourceId !== sourceId);
    this.docs.delete(sourceId);
    this.sources.delete(sourceId);
    this.tombstones.set(sourceId, { taskId, at });

    const invalidated = [...this.derived.entries()]
      .filter(([, chunkIds]) => chunkIds.some((id) => removed.includes(id)))
      .map(([key]) => key);

    return { sourceId, removedChunkIds: removed, tombstonedAt: at, invalidatedDerivedChunkIds: invalidated };
  }

  /** 登记一个派生结果（回答）引用了哪些块。 */
  registerDerived(key: string, chunkIds: readonly string[]): void {
    this.derived.set(key, [...chunkIds]);
  }

  /** 派生结果是否仍然有效（其依据的块必须**全部仍在索引中**）。 */
  isDerivedResultStillValid(key: string): boolean {
    const chunkIds = this.derived.get(key);
    if (!chunkIds) {
      return false;
    }
    const live = new Set(this.chunks.map((c) => c.chunkId));
    return chunkIds.every((id) => live.has(id));
  }

  /** 一个回答是否仍有效（依据的块都还在）。 */
  isAnswerStillValid(answer: Answer): boolean {
    const live = new Set(this.chunks.map((c) => c.chunkId));
    for (const claim of answer.claims) {
      for (const id of claim.derivedFrom) {
        if (!live.has(id)) {
          return false;
        }
      }
    }
    return true;
  }

  /** 是否已被删除（墓碑存在且当前不在索引中）。 */
  isDeleted(sourceId: string): boolean {
    return this.tombstones.has(sourceId) && !this.sources.has(sourceId);
  }

  /** 统计（供自检与证据）。 */
  stats(): { sources: number; chunks: number; tombstones: number } {
    return { sources: this.sources.size, chunks: this.chunks.length, tombstones: this.tombstones.size };
  }

  /** 快照（含墓碑）：删除在快照里**持久**，故离线恢复不复活。 */
  toSnapshot(): string {
    const shape: SnapshotShape = {
      version: 1,
      sources: [...this.sources.values()],
      chunks: this.chunks,
      docs: [...this.docs.entries()].map(([sourceId, doc]) => ({
        sourceId,
        text: doc.text,
        segments: doc.segments,
      })),
      tombstones: [...this.tombstones.entries()].map(([sourceId, t]) => ({
        sourceId,
        taskId: t.taskId,
        at: t.at,
      })),
    };
    return JSON.stringify(shape);
  }

  /** 从快照还原；**墓碑优先于来源**——快照里有墓碑的来源一律不复活。 */
  static fromSnapshot(json: string, maxChars: number = DEFAULT_MAX_CHARS): ResearchIndex {
    const shape = JSON.parse(json) as SnapshotShape;
    const index = new ResearchIndex(maxChars);
    for (const t of shape.tombstones) {
      index.tombstones.set(t.sourceId, { taskId: t.taskId, at: t.at });
    }
    for (const s of shape.sources) {
      if (index.tombstones.has(s.sourceId)) {
        continue; // 墓碑判定不得复活
      }
      index.sources.set(s.sourceId, s);
    }
    for (const d of shape.docs) {
      if (index.tombstones.has(d.sourceId)) {
        continue;
      }
      index.docs.set(d.sourceId, { sourceId: d.sourceId, kind: 'txt', text: d.text, segments: d.segments });
    }
    index.chunks = shape.chunks.filter((c) => !index.tombstones.has(c.sourceId));
    return index;
  }

  /** 可核对的"无出站"声明。 */
  egressDeclaration(): ReturnType<typeof assertNoEgress> {
    return assertNoEgress();
  }
}
