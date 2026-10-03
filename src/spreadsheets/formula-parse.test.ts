/**
 * `formula-parse.ts` 的单元测试（design-06-P8 / XLS-08）。
 *
 * 判据是**语法树的形状**（不是"没抛错"）：优先级、结合性、跨表前缀、区域，都要在 AST 上看得见。
 * 反例覆盖"像引用其实是函数名"的经典陷阱与超出子集的构造。
 */

import { describe, expect, it } from 'vitest';

import { FormulaParseError, parseFormula, type FormulaNode } from './formula-parse.js';

function parsed(text: string): FormulaNode {
  return parseFormula(text);
}

describe('formula-parse：字面量与运算', () => {
  it('数值 / 文本 / 布尔', () => {
    expect(parsed('1.5')).toEqual({ kind: 'number', value: 1.5 });
    expect(parsed('.5')).toEqual({ kind: 'number', value: 0.5 });
    expect(parsed('1e3')).toEqual({ kind: 'number', value: 1000 });
    expect(parsed('"是"')).toEqual({ kind: 'text', value: '是' });
    expect(parsed('"a""b"')).toEqual({ kind: 'text', value: 'a"b' }); // 双引号转义
    expect(parsed('TRUE')).toEqual({ kind: 'boolean', value: true });
    expect(parsed('false')).toEqual({ kind: 'boolean', value: false });
  });

  it('优先级：2+3*4 ⇒ 2+(3*4)', () => {
    expect(parsed('2+3*4')).toEqual({
      kind: 'binary',
      op: '+',
      left: { kind: 'number', value: 2 },
      right: {
        kind: 'binary',
        op: '*',
        left: { kind: 'number', value: 3 },
        right: { kind: 'number', value: 4 },
      },
    });
  });

  it('`^` 右结合；一元负号比 `^` 结合更紧（Excel 怪癖）', () => {
    expect(parsed('2^3^2')).toEqual({
      kind: 'binary',
      op: '^',
      left: { kind: 'number', value: 2 },
      right: { kind: 'binary', op: '^', left: { kind: 'number', value: 3 }, right: { kind: 'number', value: 2 } },
    });
    expect(parsed('-2^2')).toEqual({
      kind: 'binary',
      op: '^',
      left: { kind: 'unary', op: '-', operand: { kind: 'number', value: 2 } },
      right: { kind: 'number', value: 2 },
    });
  });

  it('比较与连接运算符', () => {
    expect(parsed('1<>2')).toMatchObject({ kind: 'binary', op: '<>' });
    expect(parsed('1<=2')).toMatchObject({ kind: 'binary', op: '<=' });
    expect(parsed('"a"&"b"')).toMatchObject({ kind: 'binary', op: '&' });
  });
});

describe('formula-parse：引用、区域、跨表', () => {
  it('相对与绝对引用都带 `$` 标记', () => {
    expect(parsed('A1')).toEqual({
      kind: 'reference',
      sheet: null,
      reference: { column: 1, row: 1, abs_column: false, abs_row: false },
    });
    expect(parsed('$B$3')).toEqual({
      kind: 'reference',
      sheet: null,
      reference: { column: 2, row: 3, abs_column: true, abs_row: true },
    });
  });

  it('跨表引用：裸名与单引号名', () => {
    expect(parsed('Sheet2!A1')).toMatchObject({ kind: 'reference', sheet: 'Sheet2' });
    expect(parsed("'预算 表'!B2")).toMatchObject({ kind: 'reference', sheet: '预算 表' });
    expect(parsed("'it''s'!A1")).toMatchObject({ kind: 'reference', sheet: "it's" });
  });

  it('裸表名支持非 ASCII（汉字）——与 ASCII 表名走同一条 "ident + !" 路径（X-I06）', () => {
    // Excel 对纯字母（含汉字）的裸表名不强制加引号；`=明细!A1` 在真实 Excel 里合法。
    expect(parsed('明细!A1')).toEqual({
      kind: 'reference',
      sheet: '明细',
      reference: { column: 1, row: 1, abs_column: false, abs_row: false },
    });
    expect(parsed('预算表!B2')).toMatchObject({ kind: 'reference', sheet: '预算表' });
    expect(parsed('明细!A1:B3')).toMatchObject({ kind: 'range', sheet: '明细' });
    expect(parsed('SUM(明细!A1:A3)')).toMatchObject({ kind: 'call', name: 'SUM' });
    // ASCII + 汉字混排的表名同样裸写。
    expect(parsed('Sheet明细!A1')).toMatchObject({ kind: 'reference', sheet: 'Sheet明细' });
    expect(parsed('明细!$A$1')).toMatchObject({
      kind: 'reference',
      sheet: '明细',
      reference: { column: 1, row: 1, abs_column: true, abs_row: true },
    });
    // 反向对照：一个"只认 ASCII 起始字符"的词法器会在上面每一行抛 FormulaParseError。
    expect(parsed('明细!A1')).not.toMatchObject({ kind: 'ident' });
  });

  it('真正需要引号的表名（含空格）仍解析失败——不猜，也不拆成两个标识符', () => {
    // 空格在公式里是空白；`预算 表!A1` 词法上是两个标识符，必须在语法层显式失败。
    expect(() => parseFormula('预算 表!A1')).toThrow(FormulaParseError);
    // 纯汉字但**没有** `!` 的裸标识符仍是命名区域（本仓不支持），照样抛。
    expect(() => parseFormula('明细')).toThrow(FormulaParseError);
  });

  it('区域两端', () => {
    expect(parsed('A1:B3')).toMatchObject({ kind: 'range', sheet: null });
    expect(parsed('Sheet1!A1:B3')).toMatchObject({ kind: 'range', sheet: 'Sheet1' });
  });

  it('函数调用（含嵌套与多参）', () => {
    const call = parsed('SUM(A1:A3, B1, ABS(-2))');
    expect(call).toMatchObject({ kind: 'call', name: 'SUM' });
    if (call.kind !== 'call') throw new Error('unreachable');
    expect(call.args).toHaveLength(3);
    expect(call.args[0]).toMatchObject({ kind: 'range' });
    expect(call.args[2]).toMatchObject({ kind: 'call', name: 'ABS' });
  });
});

describe('formula-parse：**像引用其实是函数名**（`formula.ts` 里点名的经典陷阱）', () => {
  it('LOG10(100) 解析成**函数调用**，不是"列 LOG + 行 10 后跟括号"', () => {
    const node = parsed('LOG10(100)');
    expect(node).toMatchObject({ kind: 'call', name: 'LOG10' });
    if (node.kind !== 'call') throw new Error('unreachable');
    expect(node.args).toEqual([{ kind: 'number', value: 100 }]);
  });

  it('紧邻标识符字符的 `A1B2` 整体是标识符（不是引用 + 尾巴）', () => {
    expect(() => parsed('A1B2')).toThrow(FormulaParseError);
  });
});

describe('formula-parse：超出子集 ⇒ 抛 FormulaParseError（上层转成阻塞）', () => {
  it.each([
    ['1+', '尾部缺运算数'],
    ['SUM(A1', '未闭合括号'],
    ['{1,2,3}', '数组常量'],
    ['MYNAME', '命名区域'],
    ['50%', '百分比后缀'],
    ['"未闭合', '未闭合字符串'],
    ['1 2', '多余内容'],
  ])('%s（%s）', (text) => {
    expect(() => parseFormula(text)).toThrow(FormulaParseError);
  });

  it('跨表区域两端不同表 ⇒ 显式拒绝（本仓不做三维引用）', () => {
    expect(() => parseFormula('Sheet1!A1:Sheet2!B2')).toThrow(FormulaParseError);
  });

  it('错误带位置，便于定位到公式里的具体字符', () => {
    try {
      parseFormula('1+');
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(FormulaParseError);
      expect((error as FormulaParseError).position).toBe(2);
    }
  });
});
