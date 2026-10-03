/**
 * 可复现性检查（归属 D06，`src/fake/`）。
 *
 * 合同 Q8-c：**重现性是硬性前提**。验收要求「同一场景跑两次，事件序列逐字节或逐条一致」
 * （`docs/other/ds-development-guide.md`：用固定种子和固定调度顺序重放竞态，种子集合在测试前登记）。
 *
 * 本模块不做场景，只做「跑 N 次、逐字节比对、把第一处分歧定位到行」这一件事，
 * 并给出可写进证据的报告对象。比对的是 JSONL 文本（规范化 JSON，键序稳定），
 * 因此「逐字节一致」和「逐条一致」在这里是同一件事。
 */

import { contentDigest } from './digest.js';
import { ReproducibilityError } from './errors.js';

/** 一次可复现性检查的结果。 */
export interface ReproducibilityReport {
  readonly runs: number;
  /** 全部运行的事件序列是否逐字节一致。 */
  readonly identical: boolean;
  /** 每次运行的内容摘要（`sha256:...`）。 */
  readonly digests: readonly string[];
  /** 第一次与前一次不一致的运行序号（1 起）；全部一致时为 null。 */
  readonly divergentRun: number | null;
  /** 分歧的首行行号（1 起）；全部一致时为 null。 */
  readonly firstDivergentLine: number | null;
  /** 分歧处的期望行（前一次运行）与实际行。 */
  readonly expectedLine: string | null;
  readonly actualLine: string | null;
  /** 两次运行的条数（行数）。 */
  readonly lineCounts: readonly number[];
}

/** 生产一次运行的证据文本（通常是 `EventRecorder.toJSONL()`）。 */
export type ReproducibleProducer = (run: number) => string | Promise<string>;

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  // 末尾换行不算一行内容。
  const normalized = text.endsWith('\n') ? text.slice(0, -1) : text;
  return normalized.length === 0 ? [] : normalized.split('\n');
}

/**
 * 跑 `runs` 次并逐字节比对事件序列。
 *
 * @param produce 第 `run` 次（1 起）的生产函数。
 * @param runs 运行次数，至少 2。
 * @throws {ReproducibilityError} `runs < 2` 时（单次运行无法证明可复现，属用法错误）。
 */
export async function checkReproducible(
  produce: ReproducibleProducer,
  runs = 2,
): Promise<ReproducibilityReport> {
  if (!Number.isInteger(runs) || runs < 2) {
    throw new ReproducibilityError(`可复现性检查至少需要 2 次运行，收到 ${String(runs)}`);
  }

  const outputs: string[] = [];
  for (let run = 1; run <= runs; run += 1) {
    outputs.push(await produce(run));
  }

  const digests = outputs.map((text) => contentDigest(text));
  const lineCounts = outputs.map((text) => splitLines(text).length);

  let divergentRun: number | null = null;
  let firstDivergentLine: number | null = null;
  let expectedLine: string | null = null;
  let actualLine: string | null = null;

  for (let i = 1; i < outputs.length; i += 1) {
    const previous = outputs[i - 1] ?? '';
    const current = outputs[i] ?? '';
    if (previous === current) continue;

    divergentRun = i + 1;
    const previousLines = splitLines(previous);
    const currentLines = splitLines(current);
    const max = Math.max(previousLines.length, currentLines.length);
    for (let line = 0; line < max; line += 1) {
      const a = previousLines[line];
      const b = currentLines[line];
      if (a !== b) {
        firstDivergentLine = line + 1;
        expectedLine = a ?? null;
        actualLine = b ?? null;
        break;
      }
    }
    break;
  }

  return {
    runs,
    identical: divergentRun === null,
    digests,
    divergentRun,
    firstDivergentLine,
    expectedLine,
    actualLine,
    lineCounts,
  };
}

/**
 * 断言可复现。失败时抛出带完整定位信息的 `ReproducibilityError`
 * （器件自身出错必须显式抛出，验收要看到失败原因）。
 */
export function assertReproducible(report: ReproducibilityReport): void {
  if (report.identical) return;
  const lines = [
    `事件序列不可复现：第 ${String(report.divergentRun)} 次运行与上一次不一致`,
    `  摘要：${report.digests.join(' | ')}`,
    `  条数：${report.lineCounts.join(' | ')}`,
    `  首个分歧行：第 ${String(report.firstDivergentLine)} 行`,
    `  期望：${report.expectedLine ?? '（无）'}`,
    `  实际：${report.actualLine ?? '（无）'}`,
  ];
  throw new ReproducibilityError(lines.join('\n'));
}
