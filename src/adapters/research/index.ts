/**
 * FA-G2 资料检索纵切片 —— **产品可调用的入口**。
 *
 * 宿主（App / 后台内核，B 流）只需提供 `ResearchPorts`（读字节、落盘、时钟），
 * 即可获得"用户私有资料 → 可回读引用 → 四类分明的回答"的完整能力。
 *
 * ⚠️ 边界（任务书硬性区别 1）：本文件**不是**共用合同层。协议与 Demo 契约由总协调独占；
 * 本切片只消费。缺失的跨层接口写进 `outputs/FA-G2/interface-requests.md`。
 * ⚠️ 未接通项（联网检索 / OCR / 美团 / 时钟 / 日历）见 `not-ready.ts` 与 `not-ready-reasons.md`。
 */
import { buildAnswer, type AnswerOptions } from './answer.js';
import { verifyCitation } from './citation.js';
import { ResearchIndex, type DeleteReport, type IngestReport } from './index-store.js';
import { capabilityReport, type NotReadyItem } from './not-ready.js';
import type { ResearchPorts } from './ports.js';
import type { SearchOptions } from './search.js';
import type { DuplicateNote } from './search.js';
import type { Answer, Hit } from './types.js';
import type { Conflict } from './extract.js';
import type { EgressDeclaration } from './privacy.js';
import { assertNoEgress } from './privacy.js';

export interface ResearchAdapterOptions {
  readonly ports: ResearchPorts;
  readonly maxChars?: number;
}

export interface CitationCheck {
  readonly ok: boolean;
  /** 回读失败的引用说明（逐条）。 */
  readonly failures: readonly string[];
  /** 实际回读核对过的引用条数。 */
  readonly checked: number;
}

export interface AskResult {
  readonly answer: Answer;
  readonly hits: readonly Hit[];
  readonly duplicates: readonly DuplicateNote[];
  readonly filteredOut: number;
  readonly conflicts: readonly Conflict[];
  /** 回答中每条事实性引用的**回读核对**结果；ok=false 时该回答不得当作有效证据。 */
  readonly citationCheck: CitationCheck;
  readonly egress: EgressDeclaration;
}

/** 产品入口。 */
export interface ResearchAdapter {
  /** 纳入一份用户资料并建索引；解析失败如实上报原因。 */
  ingest(taskId: string, name: string, mediaType: string, bytes: Uint8Array): IngestReport;
  /** 检索并组装回答；**回答中的引用会在返回前逐条回读核对**。 */
  ask(taskId: string, query: string, options?: SearchOptions & AnswerOptions): Promise<AskResult>;
  /** 删除来源：块移除、正文丢弃、墓碑落盘、派生结果失效。 */
  deleteSource(taskId: string, sourceId: string, at: number): DeleteReport;
  /** 派生结果是否仍有效。 */
  isDerivedResultStillValid(key: string): boolean;
  /** 未就绪能力清单（R231 五态）。 */
  capabilityReport(): readonly NotReadyItem[];
  /** 把索引快照写入宿主存储（含墓碑）。 */
  persist(key: string): Promise<void>;
  /** 从宿主存储还原索引；墓碑优先，已删除来源不复活。 */
  restore(key: string): Promise<boolean>;
  stats(): { sources: number; chunks: number; tombstones: number };
}

export function createResearchAdapter(options: ResearchAdapterOptions): ResearchAdapter {
  const { ports } = options;
  let index = new ResearchIndex(options.maxChars);

  return {
    ingest(taskId, name, mediaType, bytes) {
      return index.ingest(taskId, name, mediaType, bytes);
    },

    async ask(taskId, query, opts = {}) {
      const { search, conflicts, docs, nameOfSource } = index.query(taskId, query, opts);
      const answer = buildAnswer(query, search, docs, nameOfSource, conflicts, opts);

      // 产品路径内强制回读：回答里的每条事实引用都要能从**原始字节**取回。
      const failures: string[] = [];
      let checked = 0;
      for (const claim of answer.claims) {
        for (const citation of claim.citations) {
          checked += 1;
          let bytes: Uint8Array;
          try {
            bytes = await ports.sources.read(citation.sourceId);
          } catch (error) {
            failures.push(`来源 ${citation.sourceId} 无法读取：${(error as Error).message}`);
            continue;
          }
          const verified = verifyCitation(citation, bytes);
          if (!verified.ok) {
            failures.push(`来源 ${citation.sourceId}：${verified.reason}`);
          }
        }
      }

      index.registerDerived(
        `answer:${taskId}:${query}`,
        answer.claims.flatMap((c) => c.derivedFrom),
      );

      return {
        answer,
        hits: search.hits,
        duplicates: search.duplicates,
        filteredOut: search.filteredOut,
        conflicts,
        citationCheck: { ok: failures.length === 0, failures, checked },
        egress: assertNoEgress(),
      };
    },

    deleteSource(taskId, sourceId, at) {
      return index.deleteSource(taskId, sourceId, at);
    },

    isDerivedResultStillValid(key) {
      return index.isDerivedResultStillValid(key);
    },

    capabilityReport() {
      return capabilityReport();
    },

    async persist(key) {
      await ports.blobs.put(key, index.toSnapshot());
    },

    async restore(key) {
      const json = await ports.blobs.get(key);
      if (json === null) {
        return false;
      }
      index = ResearchIndex.fromSnapshot(json, options.maxChars);
      return true;
    },

    stats() {
      return index.stats();
    },
  };
}

export { ResearchIndex } from './index-store.js';
export { parseSource, detectKind } from './parse/registry.js';
export { capabilityReport, NOT_READY, LOCAL_CORPUS_CAPABILITY } from './not-ready.js';
export {
  createMemoryBlobPort,
  createMemorySourcePort,
  createFixedClock,
} from './ports.js';
export type { ResearchPorts, BlobPort, SourceBytePort, ClockPort } from './ports.js';
export type {
  Answer,
  Answer as ResearchAnswer,
  Chunk,
  Claim,
  Citation,
  CitationPart,
  ClaimKind,
  ExportedFact,
  Hit,
  Locator,
  NormalizedDoc,
  ParseOutcome,
} from './types.js';

export * from './query-port.js';
export * from './fetch.js';
export * from './citation-support.js';
export * from './cache.js';
export * from './private-index.js';

export * from './private-corpus.js';
export * from './relevance.js';
export * from './refresh.js';

export * from './answer-compose.js';
export * from './failure-modes.js';

export * from './port-wiring.js';
