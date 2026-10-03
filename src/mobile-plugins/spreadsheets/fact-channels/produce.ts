/**
 * **X-I27 — 表格事实通道：从真实工作簿产出 X-R06 契约声明**。
 *
 * 读真实 `WorkbookState` 的数值格 → 按定点口径渲染 `Quantity` → 配上确定性的
 * `fact_key` / `fact_version` → 产出 {@link SpreadsheetFactClaim}（X-R06 契约形状）。
 * 于是 X-R06 的核对器可以对着**真实表格声明**跑，而不是只对着夹具；X-I17 / X-I18
 * 也可以经 {@link SpreadsheetFactReading.cell_value} 构造发布载荷，无需重读工作簿。
 *
 * ## 复用，不重写
 *
 * - 定点运算与单位 / 币种规约的**唯一实现**在 `src/spreadsheets/quantity.ts`：
 *   本模块只调用 {@link parseQuantity} / {@link formatQuantity}，**不另造一套**，
 *   也**不经过浮点还原**（数值格里的小数直接以十进制文本喂给 `parseQuantity`）。
 * - 单元格读取复用 `sheet.ts` 的 {@link getCellValue}（未设置 ⇒ `blank`，**不是 0**）。
 * - 摘要复用 `dependency/digest.ts` 的 {@link canonicalDigest}，排序复用
 *   `dependency/graph.ts` 的 {@link compareStrings}——与 X-R06 同一套确定性口径。
 *
 * ## 反例咬得住（不是口号）
 *
 * - 空白格 ⇒ `skipped: 'blank_cell'`，**不产出** `0` 的声明（R248 缺失不当零）；
 * - 文本 / 布尔 / 日期 / 错误值 / 公式格 ⇒ `skipped: 'not_numeric'`，不冒充数值；
 * - `19.999` 配 `scale: 2` ⇒ `skipped: 'not_representable'`，**不静默四舍五入**；
 * - 同一格被映射到两条事实 ⇒ 抛 `ValidationError`（一个格只允许一条事实键，宁失败不任取）。
 */

import { ValidationError } from '../../../protocol/index.js';
import { canonicalDigest } from '../../../dependency/digest.js';
import { compareStrings } from '../../../dependency/graph.js';
import { formatQuantity, parseQuantity, type Quantity } from '../../../spreadsheets/quantity.js';
import { formatCellAddress, parseCellAddress } from '../../../spreadsheets/reference.js';
import { getCellValue } from '../../../spreadsheets/sheet.js';
import { activeSheetName, getSheet } from '../../../spreadsheets/workbook.js';
import {
  SPREADSHEET_CLAIM_TARGET,
  type ProduceSpreadsheetClaimsRequest,
  type SkippedSpreadsheetFactSource,
  type SpreadsheetFactChannelReport,
  type SpreadsheetFactClaim,
  type SpreadsheetFactReading,
  type SpreadsheetFactSource,
} from './types.js';

// ---------------------------------------------------------------------------
// 校验原语（与 facts-binding.ts / X-R06 同口径）
// ---------------------------------------------------------------------------

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${field} 不能为空字符串（收到 ${JSON.stringify(value ?? null)}）`);
  }
  return value;
}

function requireVersion(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ValidationError(`${field} 必须是 ≥ 0 的整数，收到 ${String(value)}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// 确定性事实键
// ---------------------------------------------------------------------------

/**
 * 从一个单元格派生**确定性**事实键：`sheet:<表名>!<A1>`。
 *
 * 同一 (工作表, 地址) 恒得同一键；地址先经 {@link parseCellAddress} /
 * {@link formatCellAddress} 归一化（`b2` 与 `B2` 派生出同一个键）。非法地址显式失败。
 *
 * @throws {ValidationError} 表名为空 / 地址非法
 */
export function deriveFactKey(sheet: string, ref: string): string {
  const sheetName = requireNonEmptyString(sheet, 'deriveFactKey.sheet');
  const address = formatCellAddress(parseCellAddress(ref));
  return `sheet:${sheetName}!${address}`;
}

// ---------------------------------------------------------------------------
// 源归一化
// ---------------------------------------------------------------------------

interface NormalizedSource {
  readonly sheet: string;
  readonly ref: string;
  readonly fact_key: string;
  readonly version: number;
  readonly scale: number;
  readonly unit: string;
  readonly currency: string | null;
}

function normalizeSource(source: SpreadsheetFactSource, requestVersion: number): NormalizedSource {
  const sheet = requireNonEmptyString(source.sheet, 'SpreadsheetFactSource.sheet');
  const ref = formatCellAddress(parseCellAddress(source.ref));
  const factKey =
    source.fact_key === undefined
      ? deriveFactKey(sheet, ref)
      : requireNonEmptyString(source.fact_key, 'SpreadsheetFactSource.fact_key');
  const version = requireVersion(
    source.version ?? requestVersion,
    `SpreadsheetFactSource(${factKey}).version`,
  );
  const currency = source.currency ?? null;
  /* 复用 quantity.ts 的校验：探针量 '0' 走一遍 parseQuantity，scale/unit 非法即在此抛。 */
  parseQuantity('0', source.scale, source.unit, currency);
  return Object.freeze({
    sheet,
    ref,
    fact_key: factKey,
    version,
    scale: source.scale,
    unit: source.unit,
    currency,
  });
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

function readingSortKey(entry: { readonly fact_key: string; readonly sheet: string; readonly ref: string }): string {
  return `${entry.fact_key}\u0000${entry.sheet}\u0000${entry.ref}`;
}

/**
 * 从工作簿产出表格车道的事实声明（X-R06 契约形状）。
 *
 * 对每个事实源：定位工作表与格 → 读值 → 空白 / 非数值 / 不可定点表达的**如实登记为跳过**
 * （缺失不当零）；数值格则渲染 `Quantity` 并产出声明。返回的 `claims` 可直接喂进 X-R06 的
 * `checkCrossArtifactConsistency()`。
 *
 * @throws {ValidationError} 源形状非法（空表名 / 非法地址 / 负版本）、请求级版本非法、
 *   或**同一单元格被映射到两条事实**（一个格只允许一条事实键，宁失败不任取）
 */
export function produceSpreadsheetClaims(
  request: ProduceSpreadsheetClaimsRequest,
): SpreadsheetFactChannelReport {
  const workbook = request.workbook;
  const requestVersion =
    request.version === undefined
      ? 0
      : requireVersion(request.version, 'ProduceSpreadsheetClaimsRequest.version');
  const sources = request.sources ?? [];
  if (!Array.isArray(sources)) {
    throw new ValidationError('ProduceSpreadsheetClaimsRequest.sources 必须是数组');
  }
  const artifactId =
    request.artifact_id === undefined
      ? `spreadsheet:${activeSheetName(workbook)}`
      : requireNonEmptyString(request.artifact_id, 'ProduceSpreadsheetClaimsRequest.artifact_id');
  const snapshotId =
    request.snapshot_id === undefined
      ? null
      : requireNonEmptyString(request.snapshot_id, 'ProduceSpreadsheetClaimsRequest.snapshot_id');

  const cellToFact = new Map<string, string>();
  const readings: SpreadsheetFactReading[] = [];
  const skipped: SkippedSpreadsheetFactSource[] = [];

  for (const raw of sources) {
    const source = normalizeSource(raw, requestVersion);
    const cellKey = `${source.sheet}!${source.ref}`;
    const priorFact = cellToFact.get(cellKey);
    if (priorFact !== undefined) {
      throw new ValidationError(
        `同一单元格 ${cellKey} 被映射到两条事实（${JSON.stringify(priorFact)} 与 ${JSON.stringify(source.fact_key)}）：` +
          '一个格只允许一条事实键，必须显式失败而非任取一条',
      );
    }
    cellToFact.set(cellKey, source.fact_key);

    const sheetState = getSheet(workbook, source.sheet);
    if (sheetState === undefined) {
      const entry: SkippedSpreadsheetFactSource = Object.freeze({
        sheet: source.sheet,
        ref: source.ref,
        fact_key: source.fact_key,
        code: 'sheet_missing',
        detail: `源指向的工作表 ${JSON.stringify(source.sheet)} 在工作簿里不存在：无法读取取值`,
      });
      skipped.push(entry);
      continue;
    }

    const cell = getCellValue(sheetState, source.ref);
    if (cell.kind === 'blank') {
      const entry: SkippedSpreadsheetFactSource = Object.freeze({
        sheet: source.sheet,
        ref: source.ref,
        fact_key: source.fact_key,
        code: 'blank_cell',
        detail: `格 ${cellKey} 是空白：缺失不当零（R248），不产出值为 0 的声明`,
      });
      skipped.push(entry);
      continue;
    }
    if (cell.kind !== 'number') {
      const entry: SkippedSpreadsheetFactSource = Object.freeze({
        sheet: source.sheet,
        ref: source.ref,
        fact_key: source.fact_key,
        code: 'not_numeric',
        detail: `格 ${cellKey} 的类别是 ${cell.kind}，不是数值：本通道只产出金额 / 数量声明，不让它冒充数值`,
      });
      skipped.push(entry);
      continue;
    }

    let quantity: Quantity;
    try {
      quantity = parseQuantity(cell.value, source.scale, source.unit, source.currency);
    } catch (error) {
      if (!(error instanceof ValidationError)) {
        throw error;
      }
      const entry: SkippedSpreadsheetFactSource = Object.freeze({
        sheet: source.sheet,
        ref: source.ref,
        fact_key: source.fact_key,
        code: 'not_representable',
        detail:
          `格 ${cellKey} 的取值无法按 scale=${String(source.scale)} unit=${JSON.stringify(source.unit)} ` +
          `定点表达：${error.message}`,
      });
      skipped.push(entry);
      continue;
    }

    const claim: SpreadsheetFactClaim = Object.freeze({
      target: SPREADSHEET_CLAIM_TARGET,
      artifact_id: artifactId,
      fact_key: source.fact_key,
      fact_version: source.version,
      value: Object.freeze({ kind: 'amount' as const, quantity }),
      verification_mode: 'real' as const,
    });
    const reading: SpreadsheetFactReading = Object.freeze({
      artifact_id: artifactId,
      sheet: source.sheet,
      ref: source.ref,
      fact_key: source.fact_key,
      fact_version: source.version,
      quantity,
      cell_value: cell,
      claim,
    });
    readings.push(reading);
  }

  readings.sort((left, right) => compareStrings(readingSortKey(left), readingSortKey(right)));
  skipped.sort((left, right) => compareStrings(readingSortKey(left), readingSortKey(right)));

  /* 摘要分量先各自排序再拼——输入顺序不得影响摘要（确定性）。 */
  const readingLines = readings
    .map(
      (entry) =>
        `${entry.fact_key}@${String(entry.fact_version)}=${formatQuantity(entry.quantity)} ` +
        `${entry.quantity.unit}${entry.quantity.currency === null ? '' : ` ${entry.quantity.currency}`}`,
    )
    .sort(compareStrings);
  const skipLines = skipped
    .map((entry) => `skip:${entry.code}:${entry.sheet}!${entry.ref}:${entry.fact_key}`)
    .sort(compareStrings);
  const digest = canonicalDigest(
    [artifactId, snapshotId ?? '', ...readingLines, ...skipLines].join('\n'),
  );

  return Object.freeze({
    artifact_id: artifactId,
    snapshot_id: snapshotId,
    claims: Object.freeze(readings.map((entry) => entry.claim)),
    readings: Object.freeze([...readings]),
    skipped: Object.freeze([...skipped]),
    digest,
  });
}
