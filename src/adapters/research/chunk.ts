/**
 * 分块 —— 以**定位器单元**为单位聚合。
 *
 * 单元粒度刻意选为：TXT/Markdown = 一行；DOCX = 一个段落；PDF = 一页。
 * 这样做的好处是每条引用都能**精确等于**其定位器上的原文（回读可逐字符核对），
 * 而不需要"页内字符偏移 ↔ 第三方解析器偏移"这种脆弱换算。
 *
 * 块**绝不切开**一个单元：宁可让某块超长，也不让引用落在半个单元上。
 */
import { digestText } from './digest.js';
import type { Chunk, NormalizedDoc, Segment } from './types.js';

export interface ChunkOptions {
  /** 目标块字符数上限；单个单元超过它时该单元独占一块。 */
  readonly maxChars?: number;
}

export const DEFAULT_MAX_CHARS = 600;

/**
 * 分块产物：**尚未绑定来源名与任务**。
 * 绑定由 `ResearchIndex.ingest` 完成（它才知道 taskId），避免分块层关心归属。
 */
export type DraftChunk = Omit<Chunk, 'taskId' | 'sourceName'>;

/** 把归一化文档切成块（保序、覆盖全部单元、不重叠）。 */
export function chunkDocument(doc: NormalizedDoc, options: ChunkOptions = {}): DraftChunk[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const chunks: DraftChunk[] = [];

  let current: Segment[] = [];
  let currentStart = -1;
  let currentEnd = -1;

  const flush = (): void => {
    if (current.length === 0) {
      return;
    }
    const text = doc.text.slice(currentStart, currentEnd);
    chunks.push({
      chunkId: digestText(`${doc.sourceId}:${currentStart}:${currentEnd}:${text}`),
      sourceId: doc.sourceId,
      text,
      start: currentStart,
      end: currentEnd,
      locators: current.map((s) => s.locator),
    });
    current = [];
    currentStart = -1;
    currentEnd = -1;
  };

  for (const segment of doc.segments) {
    const segmentLength = segment.end - segment.start;
    if (current.length === 0) {
      current = [segment];
      currentStart = segment.start;
      currentEnd = segment.end;
    } else {
      const wouldBe = segment.end - currentStart;
      if (wouldBe > maxChars) {
        flush();
        current = [segment];
        currentStart = segment.start;
        currentEnd = segment.end;
      } else {
        current.push(segment);
        currentEnd = segment.end;
      }
    }
    // 单个单元本身就超长：立刻独占成块，避免与后续单元合并后再超限。
    if (segmentLength > maxChars) {
      flush();
    }
  }
  flush();
  return chunks;
}
