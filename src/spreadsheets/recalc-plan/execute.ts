/**
 * 表格域：重算计划（X04）的**实际执行**——把一张 {@link RecalcPlan} 落到确定数值上。
 *
 * ## 这一层补上的缺口
 *
 * `graph.ts` 只产出**计划**（谁依赖谁、什么顺序、哪有环）；`names.ts` 把命名引用展开成
 * 区域文本存在 `plan.formulaText` 里。但**没有任何东西**把这两样接起来去真正算数：
 *
 * - `recalc.ts`（XLS-08）走的是 `WorkbookState`，它的求值路径**不认识命名引用**——
 *   裸标识符在 `formula-parse.ts` 里直接解析失败；
 * - 于是 `=税额*2` 这类公式，此前只能"被计划"，不能"被计算"。
 *
 * 本模块把 plan 落到真实数值上：按 `plan.order`（依赖优先）逐格用
 * {@link evaluateWithFunctions} 求值 `plan.formulaText`（**命名引用已展开**），
 * 环成员与无法解析的格一律**阻塞**，绝不给数。这样命名引用、跨表引用、
 * 依赖顺序、环、错误传播**在手机端确实算出来**，而不是停留在计划结构里。
 *
 * ## 「手机实际算，不是只验证自身缓存」
 *
 * 输出是**当场算出的** {@link PlanExecution.values}，不读任何外存缓存。
 * 调用方（测试 / 预览器）拿它跟**独立手算的期望值**比对——见
 * `tests/mobile-office/spreadsheets/X04/`。
 *
 * ## 三条硬纪律
 *
 * 1. **环成员绝不产出数值**：进 `order` 前就被钉成 `circular_reference` 阻塞，
 *    依赖它的格子读到的正是这个阻塞（`resolveCell` 返回 `kind: 'blocked'`），
 *    因此"循环引用却算出一个数"在这条路径上**不可表达**。
 * 2. **无法解析的公式保留原文并阻塞**（`parse_error`），不进 `order`。
 * 3. **坏输入下游标记 `tainted`**：依赖了环 / 无法解析格的格子照常算，但结果不可信，
 *    显式列出而不是静默当作干净结果。这与 `dirty.ts` 的口径一致。
 */

import { ValidationError } from '../../protocol/index.js';
import type { CellResolution, EvalOutcome } from '../evaluate.js';
import { evaluateWithFunctions, type SpreadsheetFormulaContext } from '../functions.js';
import { getCellValue, sheetEntries, type SheetState } from '../sheet.js';
import type { CellAddress } from '../reference.js';
import { isFormula, type CellValue } from '../value.js';
import { getSheet, type WorkbookState } from '../workbook.js';
import { buildRecalcPlan, type PlanInput, type RecalcPlan } from './graph.js';
import { cellKey, parseCellKey, type CellKey } from './keys.js';
import type { NamedReference } from './names.js';

/** 读取任意单元格**原始**取值的端口（公式格返回其公式取值；执行器会覆盖已算结果）。 */
export type CellReader = (sheet: string, address: CellAddress) => CellValue;

/** 执行选项。 */
export interface ExecutePlanOptions {
  /** 读取原始单元格取值。 */
  readonly readCell: CellReader;
  /** `TODAY()` 需要的显式当前日期（Excel 序列号）。不提供 ⇒ 含 `TODAY()` 的公式阻塞。 */
  readonly today_serial?: number;
}

/** 执行结果。 */
export interface PlanExecution {
  /** 逐公式格的当场求值结论（`ok: false` 表示**该格没有数值**）。 */
  readonly values: ReadonlyMap<CellKey, EvalOutcome>;
  /** 全部被阻塞的公式格键（环 / 无法解析 / 求值阻塞），字典序。 */
  readonly blocked: readonly CellKey[];
  /** 环成员键 → 其 `plan.cycles` 下标（便于上层把结果对回环）。 */
  readonly cycleOf: ReadonlyMap<CellKey, number>;
  /** 算了数值、但传递依赖到坏输入（环 / 无法解析）的格：结果不可信。字典序。 */
  readonly tainted: readonly CellKey[];
  /** 本次的执行顺序（= `plan.order`，依赖在前，不含环 / 无法解析）。 */
  readonly order: readonly CellKey[];
}

function compareKeys(a: CellKey, b: CellKey): number {
  return a.localeCompare(b);
}

/**
 * 执行一张重算计划。
 *
 * 纯函数：同样的 `(plan, options)` 必得同样的 `values`（无墙钟、无随机、不看 `TODAY` 之外的状态）。
 *
 * @throws {ValidationError} `plan` 形状异常（缺 `formulaText` 等——不应发生，键来自计划自身）
 */
export function executeRecalcPlan(plan: RecalcPlan, options: ExecutePlanOptions): PlanExecution {
  if (typeof options !== 'object' || options === null || typeof options.readCell !== 'function') {
    throw new ValidationError('executeRecalcPlan 需要 { readCell: (sheet, address) => CellValue }');
  }
  const sheetSet = new Set(plan.sheetOrder);
  const values = new Map<CellKey, EvalOutcome>();

  // 环成员：**先**钉成阻塞，依赖它们的格子读到的就是这个结论。
  for (const cycle of plan.cycles) {
    const detail = `循环引用：${cycle.path.join(' → ')}（${cycle.kind === 'explicit' ? '显式' : '交叉'}循环）`;
    for (const member of cycle.members) {
      values.set(member, { ok: false, reason: 'circular_reference', detail });
    }
  }
  // 无法解析的公式格：保留原文、阻塞（依赖未知 ⇒ 绝不按零依赖算）。
  for (const [key, detail] of plan.unresolved) {
    values.set(key, { ok: false, reason: 'parse_error', detail });
  }

  for (const key of plan.order) {
    const parsed = parseCellKey(key);
    const text = plan.formulaText.get(key);
    if (text === undefined) {
      throw new ValidationError(`executeRecalcPlan：计划缺少 ${key} 的公式文本`);
    }
    const context: SpreadsheetFormulaContext = {
      current_sheet: parsed.sheet,
      ...(options.today_serial === undefined ? {} : { today_serial: options.today_serial }),
      hasSheet: (name) => sheetSet.has(name),
      resolveCell: (sheet, address) => {
        const targetSheet = sheet ?? parsed.sheet;
        const targetKey = cellKey(targetSheet, address);
        const computed = values.get(targetKey);
        if (computed !== undefined) {
          return computed.ok
            ? { kind: 'value', value: computed.value }
            : {
                kind: 'blocked',
                reason: computed.reason,
                detail: `依赖格 ${targetKey}：${computed.detail}`,
              };
        }
        if (!sheetSet.has(targetSheet)) {
          const blocked: CellResolution = {
            kind: 'blocked',
            reason: 'unknown_sheet',
            detail: `工作簿里没有工作表 ${JSON.stringify(targetSheet)}`,
          };
          return blocked;
        }
        return { kind: 'value', value: options.readCell(targetSheet, address) };
      },
    };
    values.set(key, evaluateWithFunctions(text, context));
  }

  const blocked = [...values]
    .filter(([, outcome]) => !outcome.ok)
    .map(([key]) => key)
    .sort(compareKeys);

  // tainted：从坏输入出发，沿 `precedents`（谁依赖它）反向可达的**已算出数值**的格子。
  const brokenSet = new Set<CellKey>(blocked);
  const tainted = new Set<CellKey>();
  const frontier: CellKey[] = [...blocked];
  while (frontier.length > 0) {
    const current = frontier.pop();
    /* c8 ignore next -- 循环条件已保证非空 */
    if (current === undefined) continue;
    for (const dependent of plan.precedents.get(current) ?? []) {
      if (brokenSet.has(dependent) || tainted.has(dependent)) continue;
      tainted.add(dependent);
      frontier.push(dependent);
    }
  }

  return Object.freeze({
    values,
    blocked: Object.freeze(blocked),
    cycleOf: plan.cycleOf,
    tainted: Object.freeze([...tainted].sort(compareKeys)),
    order: plan.order,
  });
}

/**
 * 从 `WorkbookState` + 命名引用定义构造 {@link PlanInput}，供
 * {@link buildRecalcPlan} 使用。
 *
 * 这样手机端能直接用**真实工作簿**（导入的 XLSX 模型）走命名引用 / 依赖重算 / 环检测，
 * 而不必手工拼 `PlanInput`。公式格取其 `text`（前导 `=` 由计划层剥掉）。
 */
export function planInputFromWorkbook(
  workbook: WorkbookState,
  names: readonly NamedReference[] = [],
): PlanInput {
  const sheets = workbook.sheets.map((sheet) => ({
    name: sheet.name,
    cells: sheetEntries(sheet).map((entry) =>
      isFormula(entry.value)
        ? { ref: entry.ref, formula: entry.value.text }
        : { ref: entry.ref },
    ),
  }));
  return { sheets, names };
}

/**
 * 便捷：从工作簿直接执行一次完整重算（构建计划 → 执行）。
 *
 * 等价于 `executeRecalcPlan(buildRecalcPlan(planInputFromWorkbook(workbook, names)), { readCell, today_serial })`，
 * 但内部只用工作簿自身作为取值源。
 *
 * @throws {ValidationError} 工作簿形状异常
 */
export function executeWorkbookWithNames(
  workbook: WorkbookState,
  names: readonly NamedReference[] = [],
  todaySerial?: number,
): { readonly plan: RecalcPlan; readonly execution: PlanExecution } {
  const plan = buildRecalcPlan(planInputFromWorkbook(workbook, names));
  const readCell: CellReader = (sheetName, address) => {
    const sheet: SheetState | undefined = getSheet(workbook, sheetName);
    if (sheet === undefined) {
      throw new ValidationError(`executeWorkbookWithNames：工作簿里没有工作表 ${JSON.stringify(sheetName)}`);
    }
    return getCellValue(sheet, address);
  };
  const execution = executeRecalcPlan(plan, {
    readCell,
    ...(todaySerial === undefined ? {} : { today_serial: todaySerial }),
  });
  return Object.freeze({ plan, execution });
}
