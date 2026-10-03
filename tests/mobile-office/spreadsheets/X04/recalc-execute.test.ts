/**
 * **X04**：函数矩阵 / 跨表与命名引用 / 依赖重算 / 循环与错误传播（design-06-P8 / XLS-06–08）。
 *
 * ## 判据从哪来（「独立预期值」的含义）
 *
 * 本文件的每一个期望值都是**手算的 Excel 语义结果**，写死成字面量——
 * **不**从被测引擎的输出、也不是从它自己的缓存反推。凡是引用 `values.get(...)`
 * 再去比 `values.get(...)` 的写法在这里一条都没有：那样只能证明"它等于它自己"。
 *
 * 六组：
 *
 * 1. **函数矩阵**：核心 13 + 扩展 19 里挑代表性函数，逐个对**手算值**（含边界：空聚合阻塞、
 *    IFERROR 不吞阻塞、TODAY 需注入、VLOOKUP 未命中 #N/A）；
 * 2. **跨表引用**：一张表的公式读另一张表的数据与公式，顺序必须依赖优先；
 * 3. **命名引用**：`Price*Tax` 这种公式**确实算出数**（此前只能被计划、不能被计算），
 *    并验证字符串字面量 / 表名前缀 / 子串三条守卫；
 * 4. **依赖重算**：`dirtyClosure` 的最小重算集一个不多一个不少，顺序依赖在前；
 * 5. **循环**：显式 / 交叉 / 跨表三类环被分类，成员**绝不产出数值**（结构上不可表达）；
 * 6. **错误传播**：`#DIV/0!` `#NUM!` `#N/A` `#REF!` 沿依赖链传播（是**值**，不是阻塞）。
 */

import { describe, expect, it } from 'vitest';

import { formatCellAddress, type CellAddress } from '../../../../src/spreadsheets/reference.js';
import {
  blank,
  booleanValue,
  numberValue,
  textValue,
  type CellValue,
} from '../../../../src/spreadsheets/value.js';
import type { EvalOutcome } from '../../../../src/spreadsheets/evaluate.js';
import { evaluateWithFunctions } from '../../../../src/spreadsheets/functions.js';
import { createSheet, setCellValue } from '../../../../src/spreadsheets/sheet.js';
import { createWorkbook } from '../../../../src/spreadsheets/workbook.js';
import { buildRecalcPlan, type PlanInput } from '../../../../src/spreadsheets/recalc-plan/graph.js';
import { cellKey } from '../../../../src/spreadsheets/recalc-plan/keys.js';
import {
  expandNamedReferences,
  normalizeNamedReferences,
  type NamedReference,
} from '../../../../src/spreadsheets/recalc-plan/names.js';
import {
  executeRecalcPlan,
  executeWorkbookWithNames,
  planInputFromWorkbook,
  type CellReader,
} from '../../../../src/spreadsheets/recalc-plan/execute.js';
import {
  CircularReferenceError,
  dirtyClosure,
  requireRecalcOrder,
  UnresolvedFormulaError,
} from '../../../../src/spreadsheets/recalc-plan/dirty.js';

// ---------------------------------------------------------------------------
// 取值小工具
// ---------------------------------------------------------------------------

/** 把一个求值结论压成裸值（number / text / boolean / 错误码字符串）。阻塞则抛（测试里视为失败）。 */
function scalarOf(outcome: EvalOutcome): number | string | boolean {
  if (!outcome.ok) throw new Error(`期待标量，实得阻塞：${outcome.reason} ${outcome.detail}`);
  const value = outcome.value;
  switch (value.kind) {
    case 'number':
      return value.value;
    case 'text':
      return value.value;
    case 'boolean':
      return value.value;
    case 'error':
      return value.code;
    default: {
      const never: never = value;
      throw new Error(`不是标量：${JSON.stringify(never)}`);
    }
  }
}

function blockedReason(outcome: EvalOutcome): string {
  return outcome.ok ? `<ok:${scalarOf(outcome)}>` : outcome.reason;
}

/** 从扁平数据表（键 `"表名!A1"`，值为 **原始** `CellValue`）造一个读取端口。 */
function readerFrom(data: Readonly<Record<string, CellValue>>): CellReader {
  return (sheet: string, address: CellAddress) => data[`${sheet}!${formatCellAddress(address)}`] ?? blank;
}

// ---------------------------------------------------------------------------
// 1. 函数矩阵：手算预期值
// ---------------------------------------------------------------------------

interface Grid {
  readonly [sheet: string]: Readonly<Record<string, CellValue>>;
}

function makeContext(grid: Grid, currentSheet = 'Sheet1', todaySerial?: number) {
  const sheets = new Map<string, ReadonlyMap<string, CellValue>>(
    Object.entries(grid).map(([name, cells]) => [name, new Map(Object.entries(cells))]),
  );
  return {
    current_sheet: currentSheet,
    ...(todaySerial === undefined ? {} : { today_serial: todaySerial }),
    hasSheet: (name: string) => sheets.has(name),
    resolveCell: (sheet: string | null, address: CellAddress) => {
      const name = sheet ?? currentSheet;
      const map = sheets.get(name);
      if (map === undefined) {
        return { kind: 'blocked' as const, reason: 'unknown_sheet' as const, detail: `无表 ${name}` };
      }
      return { kind: 'value' as const, value: map.get(formatCellAddress(address)) ?? blank };
    },
  };
}

describe('X04 / XLS-06–08：函数矩阵（对独立手算值）', () => {
  // A1=10 A2=20 A3=30 A4="text" A5=空白 A6=TRUE；题面里的每个预期值都由 Excel 语义手推。
  const GRID: Grid = {
    Sheet1: {
      A1: numberValue(10),
      A2: numberValue(20),
      A3: numberValue(30),
      A4: textValue('text'),
      A6: booleanValue(true),
      D1: textValue('a'),
      E1: numberValue(1),
      D2: textValue('b'),
      E2: numberValue(2),
      D3: textValue('c'),
      E3: numberValue(3),
    },
  };

  function evalCell(formula: string, todaySerial?: number): number | string | boolean {
    return scalarOf(evaluateWithFunctions(formula, makeContext(GRID, 'Sheet1', todaySerial)));
  }

  it('聚合与计数', () => {
    expect(evalCell('SUM(A1:A3)')).toBe(60);
    expect(evalCell('AVERAGE(A1:A3)')).toBe(20);
    expect(evalCell('MIN(A1:A3)')).toBe(10);
    expect(evalCell('MAX(A1:A3)')).toBe(30);
    expect(evalCell('COUNT(A1:A3)')).toBe(3);
    expect(evalCell('COUNTA(A1:A6)')).toBe(5); // 3 数 + 1 文本 + 1 布尔；A5 空白跳过
  });

  it('逻辑与惰性 IF', () => {
    expect(evalCell('IF(A1>5,"yes","no")')).toBe('yes');
    expect(evalCell('IF(A1>50,"yes","no")')).toBe('no');
    expect(evalCell('AND(A1>5,A2>15)')).toBe(true);
    expect(evalCell('AND(A1>5,A2>25)')).toBe(false);
    expect(evalCell('OR(A1>100,A2>15)')).toBe(true);
    expect(evalCell('NOT(A1>5)')).toBe(false);
  });

  it('数学', () => {
    expect(evalCell('ABS(-3)')).toBe(3);
    expect(evalCell('ROUND(2.5)')).toBe(3); // half away from zero
    expect(evalCell('ROUND(3.14159,2)')).toBe(3.14);
    expect(evalCell('SQRT(16)')).toBe(4);
    expect(evalCell('SQRT(-1)')).toBe('#NUM!');
  });

  it('IFERROR 抓错误值；但不吞"本仓不支持"的阻塞', () => {
    expect(evalCell('IFERROR(1/0,-1)')).toBe(-1);
    expect(evalCell('IFERROR(10/2,-1)')).toBe(5);
    const notSupported = evaluateWithFunctions('NOSUCHFN(1)', makeContext(GRID));
    expect(blockedReason(notSupported)).toBe('unsupported_function');
  });

  it('条件聚合与查表', () => {
    expect(evalCell('SUMIF(A1:A3,">10")')).toBe(50);
    expect(evalCell('COUNTIF(A1:A3,">10")')).toBe(2);
    expect(evalCell('VLOOKUP("b",D1:E3,2,FALSE)')).toBe(2);
    expect(evalCell('VLOOKUP("z",D1:E3,2,FALSE)')).toBe('#N/A');
    expect(evalCell('INDEX(A1:A3,2)')).toBe(20);
    expect(evalCell('MATCH(20,A1:A3,0)')).toBe(2);
  });

  it('文本与格式化', () => {
    expect(evalCell('LEFT("hello",2)')).toBe('he');
    expect(evalCell('RIGHT("hello",2)')).toBe('lo');
    expect(evalCell('MID("hello",2,3)')).toBe('ell');
    expect(evalCell('LEN("hello")')).toBe(5);
    expect(evalCell('CONCAT("a","b",1)')).toBe('ab1');
    expect(evalCell('TEXT(1234.5678,"#,##0.00")')).toBe('1,234.57');
  });

  it('日期函数锚在 Excel 序列号语义上', () => {
    expect(evalCell('DATE(2024,3,15)')).toBe(45366);
    expect(evalCell('YEAR(45366)')).toBe(2024);
    expect(evalCell('MONTH(45366)')).toBe(3);
    expect(evalCell('DAY(45366)')).toBe(15);
  });

  it('TODAY 只有显式注入才求值（本仓不读墙钟）', () => {
    expect(evalCell('TODAY()', 45366)).toBe(45366);
    const notInjected = evaluateWithFunctions('TODAY()', makeContext(GRID));
    expect(notInjected.ok).toBe(false);
  });

  it('空聚合按 R248 阻塞，不返回 0', () => {
    const out = evaluateWithFunctions('SUM(A4:A4)', makeContext(GRID)); // A4 是文本，无数值贡献
    expect(blockedReason(out)).toBe('empty_aggregate');
  });

  it('空白格参与标量运算按 R248 阻塞，不当 0', () => {
    const out = evaluateWithFunctions('A5+1', makeContext(GRID));
    expect(blockedReason(out)).toBe('blank_operand');
  });
});

// ---------------------------------------------------------------------------
// 2. 跨表引用：依赖优先地算出数
// ---------------------------------------------------------------------------

describe('X04：跨表引用', () => {
  function crossSheetWorkbook() {
    let data = createSheet('Data');
    data = setCellValue(data, 'A1', numberValue(10));
    data = setCellValue(data, 'A2', numberValue(20));
    data = setCellValue(data, 'A3', numberValue(30));
    data = setCellValue(data, 'B1', { kind: 'formula', text: 'A1+1' }); // 公式格，= 11

    let calc = createSheet('Calc');
    calc = setCellValue(calc, 'A1', { kind: 'formula', text: 'SUM(Data!A1:A3)' }); // 60
    calc = setCellValue(calc, 'A2', { kind: 'formula', text: 'Data!A1*2' }); // 20
    calc = setCellValue(calc, 'A3', { kind: 'formula', text: 'A1+A2' }); // 80
    calc = setCellValue(calc, 'A4', { kind: 'formula', text: 'SUM(A1:A3)' }); // 160
    calc = setCellValue(calc, 'A5', { kind: 'formula', text: 'Data!B1' }); // 11（跨表读公式格）

    return createWorkbook([data, calc]);
  }

  it('跨表数据引用与跨表公式链都算出确定值', () => {
    const { execution } = executeWorkbookWithNames(crossSheetWorkbook());
    const at = (key: string) => scalarOf(execution.values.get(key)!);
    expect(at(cellKey('Calc', 'A1'))).toBe(60);
    expect(at(cellKey('Calc', 'A2'))).toBe(20);
    expect(at(cellKey('Calc', 'A3'))).toBe(80);
    expect(at(cellKey('Calc', 'A4'))).toBe(160);
    expect(at(cellKey('Calc', 'A5'))).toBe(11);
    expect(at(cellKey('Data', 'B1'))).toBe(11);
  });

  it('求值顺序依赖优先（A3 依赖 A1/A2；A4 依赖 A1..A3）', () => {
    const { plan } = executeWorkbookWithNames(crossSheetWorkbook());
    const pos = new Map(plan.order.map((key, index) => [key, index]));
    const p = (key: string) => pos.get(cellKey('Calc', key))!;
    expect(p('A1')).toBeLessThan(p('A3'));
    expect(p('A2')).toBeLessThan(p('A3'));
    expect(p('A3')).toBeLessThan(p('A4'));
    // 跨表：Data!B1 必须在 Calc!A5 之前被算。
    expect(pos.get(cellKey('Data', 'B1'))!).toBeLessThan(pos.get(cellKey('Calc', 'A5'))!);
  });

  it('跨表依赖边被显式记录（公式格 → 公式格，跨表）', () => {
    const { plan } = executeWorkbookWithNames(crossSheetWorkbook());
    expect(plan.crossSheetDependencies).toEqual([
      { from: cellKey('Calc', 'A5'), to: cellKey('Data', 'B1') },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 3. 命名引用：确实算出数 + 三条守卫
// ---------------------------------------------------------------------------

describe('X04：命名引用', () => {
  const NAMES: readonly NamedReference[] = [
    { name: 'Price', sheet: 'Data', ref: 'A1' },
    { name: 'Tax', sheet: 'Rates', ref: 'B1' },
    { name: 'Total', sheet: 'Data', ref: 'A1:A3' },
  ];

  function namedWorkbook() {
    let data = createSheet('Data');
    data = setCellValue(data, 'A1', numberValue(10));
    data = setCellValue(data, 'A2', numberValue(20));
    data = setCellValue(data, 'A3', numberValue(30));

    let rates = createSheet('Rates');
    rates = setCellValue(rates, 'B1', numberValue(0.5));

    let calc = createSheet('Calc');
    calc = setCellValue(calc, 'A1', { kind: 'formula', text: 'Price*2' }); // 20
    calc = setCellValue(calc, 'A2', { kind: 'formula', text: 'Price*Tax' }); // 5
    calc = setCellValue(calc, 'A3', { kind: 'formula', text: 'Price+Tax' }); // 10.5
    calc = setCellValue(calc, 'A4', { kind: 'formula', text: '"Tax"&Price' }); // "Tax10"（字面量不替换）
    calc = setCellValue(calc, 'A5', { kind: 'formula', text: 'SUM(Total)' }); // 60（区域命名）

    return createWorkbook([data, rates, calc]);
  }

  it('命名引用（单格 + 跨表 + 区域）在手机端确实算出数', () => {
    const { execution } = executeWorkbookWithNames(namedWorkbook(), NAMES);
    const at = (ref: string) => scalarOf(execution.values.get(cellKey('Calc', ref))!);
    expect(at('A1')).toBe(20);
    expect(at('A2')).toBe(5);
    expect(at('A3')).toBe(10.5);
    expect(at('A4')).toBe('Tax10');
    expect(at('A5')).toBe(60);
  });

  it('计划记录每个格子用到的命名引用', () => {
    const plan = buildRecalcPlan(planInputFromWorkbook(namedWorkbook(), NAMES));
    expect(plan.namedUsage.get(cellKey('Calc', 'A1'))).toEqual(['Price']);
    expect(plan.namedUsage.get(cellKey('Calc', 'A2'))).toEqual(['Price', 'Tax']);
    expect(plan.namedUsage.get(cellKey('Calc', 'A4'))).toEqual(['Price']);
  });

  it('守卫：字符串字面量 / 表名前缀 / 更长词前缀都不替换', () => {
    const table = normalizeNamedReferences(NAMES);
    // 引号内的 Tax 一律不动。
    expect(expandNamedReferences('"Tax"&A1', table, 'Calc').text).toBe('"Tax"&A1');
    // `Tax!B1` 里的 Tax 是表名前缀，不动。
    expect(expandNamedReferences('Tax!B1', table, 'Calc').text).toBe('Tax!B1');
    // `TaxRate1` 里的 Tax 是更长词前缀，不动。
    expect(expandNamedReferences('TaxRate1', table, 'Calc').text).toBe('TaxRate1');
    // 小写仍命中（大小写不敏感），且替换成带引号的跨表前缀。
    const lowered = expandNamedReferences('tax*2', table, 'Calc');
    expect(lowered.text).toBe("'Rates'!B1*2");
    expect(lowered.used).toEqual(['Tax']);
  });
});

// ---------------------------------------------------------------------------
// 4. 依赖重算：最小重算集一个不多一个不少
// ---------------------------------------------------------------------------

describe('X04：依赖重算（dirtyClosure）', () => {
  const CHAIN: PlanInput = {
    sheets: [
      {
        name: 'S',
        cells: [
          { ref: 'A1' }, // 数据格 = 1
          { ref: 'A2', formula: 'A1+1' }, // 2
          { ref: 'A3', formula: 'A2+1' }, // 3
          { ref: 'A4', formula: 'A1*10' }, // 10
          { ref: 'A5', formula: 'A3+A4' }, // 13
          { ref: 'A6', formula: '100' }, // 常量，不依赖任何东西
        ],
      },
    ],
  };

  it('改数据格 A1：重算集合 = 传递依赖它的全部公式格，且不含 A6', () => {
    const plan = buildRecalcPlan(CHAIN);
    const batch = dirtyClosure(plan, [cellKey('S', 'A1')]);
    expect(batch.dataSeeds).toEqual([cellKey('S', 'A1')]);
    expect([...batch.order].sort()).toEqual(
      [cellKey('S', 'A2'), cellKey('S', 'A3'), cellKey('S', 'A4'), cellKey('S', 'A5')].sort(),
    );
    expect(batch.order).not.toContain(cellKey('S', 'A6'));
  });

  it('顺序依赖在前（A2<A3<A5，A4<A5）', () => {
    const plan = buildRecalcPlan(CHAIN);
    const batch = dirtyClosure(plan, [cellKey('S', 'A1')]);
    const pos = new Map(batch.order.map((key, index) => [key, index]));
    expect(pos.get(cellKey('S', 'A2'))!).toBeLessThan(pos.get(cellKey('S', 'A3'))!);
    expect(pos.get(cellKey('S', 'A3'))!).toBeLessThan(pos.get(cellKey('S', 'A5'))!);
    expect(pos.get(cellKey('S', 'A4'))!).toBeLessThan(pos.get(cellKey('S', 'A5'))!);
  });

  it('把这份顺序真正执行，得到手算值', () => {
    const plan = buildRecalcPlan(CHAIN);
    const batch = dirtyClosure(plan, [cellKey('S', 'A1')]);
    const execution = executeRecalcPlan(plan, { readCell: readerFrom({ 'S!A1': numberValue(1) }) });
    const at = (ref: string) => scalarOf(execution.values.get(cellKey('S', ref))!);
    // 脏子集的顺序必须是全量计划的**子序列**（相对顺序不变）。
    const full = plan.order;
    let cursor = -1;
    for (const key of batch.order) {
      const position = full.indexOf(key);
      expect(position).toBeGreaterThan(cursor);
      cursor = position;
    }
    expect(at('A2')).toBe(2);
    expect(at('A3')).toBe(3);
    expect(at('A4')).toBe(10);
    expect(at('A5')).toBe(13);
    expect(at('A6')).toBe(100);
  });

  it('坏输入的下游被标 tainted，环成员则被 requireRecalcOrder 报错', () => {
    const withCycle: PlanInput = {
      sheets: [
        {
          name: 'S',
          cells: [
            { ref: 'B1', formula: 'B1+1' }, // 显式自引用环
            { ref: 'C1', formula: 'B1+A2' }, // 依赖环成员
            { ref: 'A2', formula: 'A1+1' },
            { ref: 'A1' },
          ],
        },
      ],
    };
    const plan = buildRecalcPlan(withCycle);
    const batch = dirtyClosure(plan, [cellKey('S', 'B1')]);
    expect(batch.blocked).toEqual([cellKey('S', 'B1')]);
    expect(batch.tainted).toEqual([cellKey('S', 'C1')]);
    expect(() => requireRecalcOrder(plan, [cellKey('S', 'B1')])).toThrow(CircularReferenceError);
    // 干净的种子不涉及环 ⇒ 不报错。
    expect(() => requireRecalcOrder(plan, [cellKey('S', 'A1')])).not.toThrow();
  });

  it('语法过不去的公式进 unresolved，requireRecalcOrder 抛 UnresolvedFormulaError', () => {
    const broken: PlanInput = {
      sheets: [{ name: 'S', cells: [{ ref: 'A1', formula: '1+' }] }],
    };
    const plan = buildRecalcPlan(broken);
    expect([...plan.unresolved.keys()]).toEqual([cellKey('S', 'A1')]);
    expect(() => requireRecalcOrder(plan, [cellKey('S', 'A1')])).toThrow(UnresolvedFormulaError);
  });
});

// ---------------------------------------------------------------------------
// 5. 循环：分类 + 绝不产出数值
// ---------------------------------------------------------------------------

describe('X04：循环引用', () => {
  it('显式环（自引用）被识别并阻塞，不给数', () => {
    const plan = buildRecalcPlan({
      sheets: [{ name: 'S', cells: [{ ref: 'A1', formula: 'A1+1' }] }],
    });
    expect(plan.cycles).toHaveLength(1);
    expect(plan.cycles[0]!.kind).toBe('explicit');
    expect(plan.cycles[0]!.members).toEqual([cellKey('S', 'A1')]);
    expect(plan.cycles[0]!.path).toEqual([cellKey('S', 'A1'), cellKey('S', 'A1')]);
    expect(plan.order).not.toContain(cellKey('S', 'A1'));

    const execution = executeRecalcPlan(plan, { readCell: readerFrom({}) });
    const outcome = execution.values.get(cellKey('S', 'A1'))!;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('circular_reference');
  });

  it('交叉环（A ↔ B）分类为 cross，成员都不产出数值', () => {
    const plan = buildRecalcPlan({
      sheets: [
        {
          name: 'S',
          cells: [
            { ref: 'A1', formula: 'B1+1' },
            { ref: 'B1', formula: 'A1+1' },
          ],
        },
      ],
    });
    expect(plan.cycles).toHaveLength(1);
    expect(plan.cycles[0]!.kind).toBe('cross');
    expect(plan.cycles[0]!.crossSheet).toBe(false);
    expect(plan.order).toEqual([]);
  });

  it('跨表环分类为 cross 且 crossSheet=true', () => {
    const plan = buildRecalcPlan({
      sheets: [
        { name: 'S1', cells: [{ ref: 'A1', formula: 'S2!B1' }] },
        { name: 'S2', cells: [{ ref: 'B1', formula: 'S1!A1' }] },
      ],
    });
    expect(plan.cycles).toHaveLength(1);
    expect(plan.cycles[0]!.kind).toBe('cross');
    expect(plan.cycles[0]!.crossSheet).toBe(true);
    expect([...plan.cycles[0]!.members].sort()).toEqual([cellKey('S1', 'A1'), cellKey('S2', 'B1')].sort());
  });

  it('「循环却算出一个数」在结构上不可表达：环成员的结论永远是阻塞', () => {
    const plan = buildRecalcPlan({
      sheets: [
        {
          name: 'S',
          cells: [
            { ref: 'A1', formula: 'A1+1' },
            { ref: 'C1', formula: 'A1+5' }, // 下游：能算，但结果不可信
          ],
        },
      ],
    });
    const execution = executeRecalcPlan(plan, { readCell: readerFrom({}) });
    expect(execution.values.get(cellKey('S', 'A1'))!.ok).toBe(false);
    // C1 的数值必须"继承"上游的阻塞，不得凭空得出 6。
    const c1 = execution.values.get(cellKey('S', 'C1'))!;
    expect(c1.ok).toBe(false);
    if (!c1.ok) expect(c1.reason).toBe('circular_reference');
  });
});

// ---------------------------------------------------------------------------
// 6. 错误传播：错误值是**值**，沿依赖链传播
// ---------------------------------------------------------------------------

describe('X04：错误传播', () => {
  const ERRS: PlanInput = {
    sheets: [
      {
        name: 'S',
        cells: [
          { ref: 'A1', formula: '1/0' }, // #DIV/0!
          { ref: 'A2', formula: 'A1+1' }, // 传播 #DIV/0!
          { ref: 'A3', formula: 'IFERROR(A1,-1)' }, // 兜底 -1
          { ref: 'A4', formula: 'SQRT(-1)' }, // #NUM!
          { ref: 'A5', formula: 'VLOOKUP("zzz",B1:C2,2,FALSE)' }, // #N/A
          { ref: 'A6', formula: 'A5&"x"' }, // 传播 #N/A
          { ref: 'A7', formula: 'INDEX(B1:B2,99)' }, // #REF!
          { ref: 'A8', formula: 'SUM(A1,A4)' }, // 传播首个错误 #DIV/0!
          { ref: 'B1', formula: '"a"' },
          { ref: 'B2', formula: '"b"' },
          { ref: 'C1', formula: '1' },
          { ref: 'C2', formula: '2' },
        ],
      },
    ],
  };

  it('错误值沿依赖链传播（是 ok:true 的错误值，不是阻塞）', () => {
    const plan = buildRecalcPlan(ERRS);
    const execution = executeRecalcPlan(plan, { readCell: readerFrom({}) });
    const at = (ref: string) => execution.values.get(cellKey('S', ref))!;
    expect(scalarOf(at('A1'))).toBe('#DIV/0!');
    expect(at('A2').ok).toBe(true);
    expect(scalarOf(at('A2'))).toBe('#DIV/0!');
    expect(scalarOf(at('A3'))).toBe(-1);
    expect(scalarOf(at('A4'))).toBe('#NUM!');
    expect(scalarOf(at('A5'))).toBe('#N/A');
    expect(scalarOf(at('A6'))).toBe('#N/A');
    expect(scalarOf(at('A7'))).toBe('#REF!');
    expect(scalarOf(at('A8'))).toBe('#DIV/0!');
  });
});
