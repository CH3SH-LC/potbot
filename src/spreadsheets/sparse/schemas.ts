/**
 * **X-R03 → src**：大表 / 稀疏 / 预算操作的 v1 请求-结果 schema（类型 + 校验器）。
 *
 * 与六线总方案 §5「契约先行」同口径：公共输入含 `schemaVersion` 与 `operation`；
 * 未识别的字段**显式报错**（不静默丢弃——静默丢弃正是"看起来成功、其实没按你说的做"的温床）。
 *
 * 本模块只做**形状与取值校验**，不碰工作表；执行由 `run.ts` 的 `runSparseOperation` 完成。
 * 因此 schema 可以脱离数据被单测，执行器也用同一份类型，二者不会漂移。
 */

import { ValidationError } from '../../protocol/index.js';
import { parseRange } from '../reference.js';

/** 本批 schema 版本。 */
export const XR03_SCHEMA_VERSION = '1' as const;

/** 受支持的操作名。 */
export type SparseOperationName = 'sparse.scan' | 'sparse.materialize' | 'sparse.memory';

/** 预算字段（两维均可选）。 */
export interface BudgetSpec {
  readonly max_cells?: number;
  readonly max_milliseconds?: number;
}

interface BaseOperation {
  readonly schemaVersion: typeof XR03_SCHEMA_VERSION;
  readonly budget?: BudgetSpec;
}

/** 扫描：列出区域内全部已填格。`range` 缺省 = 整表。 */
export interface ScanOperation extends BaseOperation {
  readonly operation: 'sparse.scan';
  readonly range?: string;
}

/**
 * 实体化：把区域内全部格（含空格）摊成密集二维数组。
 *
 * `max_cells` 是**格数预算**（不再是硬编码的面积闸门）：按行累加，累计格数越过上限即抛
 * `BudgetExceededError`。缺省不设限——大区域应改用 `sparse.ts` 的流式接口，
 * 或在此显式给预算。
 */
export interface MaterializeOperation extends BaseOperation {
  readonly operation: 'sparse.materialize';
  readonly range: string;
  readonly max_cells?: number;
}

/** 内存估算：不返回值以外的任何格数据，只给驻留字节估计。 */
export interface MemoryOperation extends BaseOperation {
  readonly operation: 'sparse.memory';
}

/** 三类操作的判别联合。 */
export type SparseOperation = ScanOperation | MaterializeOperation | MemoryOperation;

// ---------------------------------------------------------------------------
// 结果类型
// ---------------------------------------------------------------------------

/** 扫描结果。 */
export interface ScanResult {
  readonly operation: 'sparse.scan';
  readonly populated: number;
  readonly cells: readonly { readonly ref: string; readonly row: number; readonly column: number }[];
}

/** 实体化结果（`grid[row][column]`，起点为区域内左上角）。 */
export interface MaterializeResult {
  readonly operation: 'sparse.materialize';
  readonly height: number;
  readonly width: number;
  readonly area: number;
  readonly grid: readonly (readonly { readonly kind: string }[])[];
}

/** 内存估算结果。 */
export interface MemoryResult {
  readonly operation: 'sparse.memory';
  readonly populated_cells: number;
  readonly estimated_bytes: number;
  readonly dense_grid_bytes: number;
  readonly sparse_ratio: number;
}

/** 操作结果判别联合。 */
export type SparseOperationResult = ScanResult | MaterializeResult | MemoryResult;

// ---------------------------------------------------------------------------
// 校验器
// ---------------------------------------------------------------------------

const OPERATION_NAMES: readonly SparseOperationName[] = Object.freeze([
  'sparse.scan',
  'sparse.materialize',
  'sparse.memory',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(obj: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new ValidationError(`${where} 含未知字段 ${JSON.stringify(key)}（不静默丢弃）`);
    }
  }
}

function parseBudgetSpec(raw: unknown, where: string): BudgetSpec {
  if (!isPlainObject(raw)) {
    throw new ValidationError(`${where} 的 budget 必须是对象`);
  }
  rejectUnknownKeys(raw, ['max_cells', 'max_milliseconds'], `${where}.budget`);
  const spec: { max_cells?: number; max_milliseconds?: number } = {};
  if (raw.max_cells !== undefined) {
    if (typeof raw.max_cells !== 'number' || !Number.isInteger(raw.max_cells) || raw.max_cells < 0) {
      throw new ValidationError(`${where}.budget.max_cells 必须是非负整数，收到 ${JSON.stringify(raw.max_cells)}`);
    }
    spec.max_cells = raw.max_cells;
  }
  if (raw.max_milliseconds !== undefined) {
    if (
      typeof raw.max_milliseconds !== 'number' ||
      !Number.isFinite(raw.max_milliseconds) ||
      raw.max_milliseconds < 0
    ) {
      throw new ValidationError(
        `${where}.budget.max_milliseconds 必须是非负有限数，收到 ${JSON.stringify(raw.max_milliseconds)}`,
      );
    }
    spec.max_milliseconds = raw.max_milliseconds;
  }
  return spec;
}

/**
 * 校验并归一化一条 X-R03 操作请求。
 *
 * @throws {ValidationError} 非对象 / 版本不符 / 未知操作 / 未知字段 / 取值非法 / range 非法
 */
export function parseSparseOperation(input: unknown): SparseOperation {
  if (!isPlainObject(input)) {
    throw new ValidationError('操作请求必须是对象');
  }
  if (input.schemaVersion !== XR03_SCHEMA_VERSION) {
    throw new ValidationError(
      `schemaVersion 必须是 ${JSON.stringify(XR03_SCHEMA_VERSION)}，收到 ${JSON.stringify(input.schemaVersion)}`,
    );
  }
  const operation = input.operation;
  if (typeof operation !== 'string' || !OPERATION_NAMES.includes(operation as SparseOperationName)) {
    throw new ValidationError(
      `未知操作 ${JSON.stringify(operation)}；受支持：${OPERATION_NAMES.join(' / ')}`,
    );
  }
  const budget = input.budget === undefined ? undefined : parseBudgetSpec(input.budget, 'sparse');

  if (operation === 'sparse.memory') {
    rejectUnknownKeys(input, ['schemaVersion', 'operation', 'budget'], 'sparse.memory');
    return budget === undefined
      ? { schemaVersion: XR03_SCHEMA_VERSION, operation: 'sparse.memory' }
      : { schemaVersion: XR03_SCHEMA_VERSION, operation: 'sparse.memory', budget };
  }

  if (operation === 'sparse.scan') {
    rejectUnknownKeys(input, ['schemaVersion', 'operation', 'budget', 'range'], 'sparse.scan');
    if (input.range !== undefined) {
      if (typeof input.range !== 'string') {
        throw new ValidationError('sparse.scan.range 必须是字符串');
      }
      parseRange(input.range); // 非法即抛
      return budget === undefined
        ? { schemaVersion: XR03_SCHEMA_VERSION, operation: 'sparse.scan', range: input.range }
        : { schemaVersion: XR03_SCHEMA_VERSION, operation: 'sparse.scan', range: input.range, budget };
    }
    return budget === undefined
      ? { schemaVersion: XR03_SCHEMA_VERSION, operation: 'sparse.scan' }
      : { schemaVersion: XR03_SCHEMA_VERSION, operation: 'sparse.scan', budget };
  }

  // sparse.materialize
  rejectUnknownKeys(input, ['schemaVersion', 'operation', 'budget', 'range', 'max_cells'], 'sparse.materialize');
  if (typeof input.range !== 'string') {
    throw new ValidationError('sparse.materialize.range 必须是字符串（实体化必须显式给区域）');
  }
  parseRange(input.range);
  let maxCells: number | undefined;
  if (input.max_cells !== undefined) {
    if (typeof input.max_cells !== 'number' || !Number.isInteger(input.max_cells) || input.max_cells < 0) {
      throw new ValidationError(
        `sparse.materialize.max_cells 必须是非负整数，收到 ${JSON.stringify(input.max_cells)}`,
      );
    }
    maxCells = input.max_cells;
  }
  const result: MaterializeOperation = {
    schemaVersion: XR03_SCHEMA_VERSION,
    operation: 'sparse.materialize',
    range: input.range,
    ...(maxCells === undefined ? {} : { max_cells: maxCells }),
    ...(budget === undefined ? {} : { budget }),
  };
  return result;
}
