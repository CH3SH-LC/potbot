/**
 * 公式单测（WF-091；判据：**公式是结构不是图片**）。
 *
 * 三条判据各自对应本文件的用例组：
 *
 * 1. **结构可读**——分式的分子分母、根式的被开方数、上下标的底数/指数都能从结构里取出来，
 *    且 `toOmmlShape` 给出的是 `m:f`/`m:rad`/`m:sSubSup` 这样的**结构元素**，
 *    而**不是**一个装着 `"1/2"` 文本的 `m:r`（那就是"把结构压平"+ "用图片代替结构"的同类错误）。
 * 2. **既有复杂公式保留不解析**（R105）——`preserved` 分支拒绝编辑、原样冻结。
 * 3. **线性记法封闭**——未知宏/括号不配对一律 `invalid_expression`，不猜结构。
 */

import { describe, expect, it } from 'vitest';

import type { Result } from '../selection/types.js';
import {
  fraction,
  mathRun,
  radical,
  sequence,
  subscript,
  subSuperscript,
  superscript,
  validateMathNode,
} from './build.js';
import {
  baseOf,
  degreeOf,
  denominatorOf,
  mathDepth,
  mathNodeCount,
  mathPlainText,
  mathText,
  numeratorOf,
  radicandOf,
  runTextOf,
  sequenceItemsOf,
  subscriptOf,
  superscriptOf,
} from './read.js';
import { ommlElementNames, ommlRunStyles, ommlRunTexts, toOmmlShape } from './omml.js';
import { equationFromLinear, parseMath } from './parse.js';
import {
  PRESERVED_EQUATION_REASON,
  assertEditable,
  describeEquationContent,
  editableEquation,
  editableOf,
  isPreserved,
  preserveExistingEquation,
} from './preserve.js';

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error(`期望成功，实际失败：${result.code} / ${result.message}`);
  }
  return result.value;
}

describe('结构的可读性：分式 / 根式 / 上下标（WF-091 判据一）', () => {
  it('分式能读出分子与分母，且映射到 m:f 而不是一个文本 run', () => {
    const eq = fraction(mathRun('1'), mathRun('2'));

    expect(runTextOf(numeratorOf(eq)!)!).toBe('1');
    expect(runTextOf(denominatorOf(eq)!)!).toBe('2');

    const shape = unwrap(toOmmlShape(eq));
    expect(shape.omml).toBe('m:f');
    // 关键反例：结构**没有**被压成一个 `m:r` 文本；分子分母各自是独立 run。
    expect(ommlElementNames(shape)).toEqual(['m:f', 'm:r', 'm:r']);
    expect(ommlRunTexts(shape)).toEqual(['1', '2']);
    expect(ommlRunTexts(shape)).not.toContain('1/2');
  });

  it('根式能读出被开方数；平方根的次数为空，带次数的根式能读出次数', () => {
    const sqrt = radical(mathRun('x+1'));
    expect(runTextOf(radicandOf(sqrt)!)!).toBe('x+1');
    expect(degreeOf(sqrt)).toBeNull();
    expect(unwrap(toOmmlShape(sqrt))).toEqual({ omml: 'm:rad', deg: null, e: { omml: 'm:r', text: 'x+1', style: 'italic' } });

    const cube = radical(mathRun('x'), mathRun('3'));
    expect(runTextOf(degreeOf(cube)!)!).toBe('3');
    expect(ommlElementNames(unwrap(toOmmlShape(cube)))).toEqual(['m:rad', 'm:r', 'm:r']);
  });

  it('上下标能读出底数/下标/上标，且元素名随形态变化（sSup / sSub / sSubSup）', () => {
    const sup = superscript(mathRun('x'), mathRun('2'));
    expect(runTextOf(baseOf(sup)!)!).toBe('x');
    expect(runTextOf(superscriptOf(sup)!)!).toBe('2');
    expect(subscriptOf(sup)).toBeNull();
    expect(unwrap(toOmmlShape(sup)).omml).toBe('m:sSup');

    const sub = subscript(mathRun('a'), mathRun('1'));
    expect(unwrap(toOmmlShape(sub)).omml).toBe('m:sSub');

    const both = subSuperscript(mathRun('a'), mathRun('1'), mathRun('2'));
    expect(unwrap(toOmmlShape(both)).omml).toBe('m:sSubSup');
    expect(ommlRunTexts(unwrap(toOmmlShape(both)))).toEqual(['a', '1', '2']);
  });

  it('复合结构：分式的分子本身是上下标时，两层都能读出（结构不塌陷）', () => {
    const eq = fraction(superscript(mathRun('x'), mathRun('2')), mathRun('2'));
    const num = numeratorOf(eq)!;
    expect(num.kind).toBe('script');
    expect(runTextOf(superscriptOf(num)!)!).toBe('2');
    expect(ommlElementNames(unwrap(toOmmlShape(eq)))).toEqual(['m:f', 'm:sSup', 'm:r', 'm:r', 'm:r']);
    expect(mathText(eq)).toBe('(x^2)/(2)');
    // 5 个节点：fraction + script + 底数 x + 上标 2 + 分母 2
    expect(mathNodeCount(eq)).toBe(5);
    expect(mathDepth(eq)).toBe(3);
  });

  it('线性投影（mathText）与纯文本投影（mathPlainText）各司其职', () => {
    const eq = unwrap(parseMath('H_{2}O'));
    expect(mathText(eq)).toBe('H_2 O');
    // 纯文本投影**丢掉上下标层级**，只留字符——这正是"投影"与"结构"的差别。
    expect(mathPlainText(eq)).toBe('H2O');
  });

  it('结构树里不存在任何图形节点字段（不是 DrawingNode）', () => {
    const eq = unwrap(parseMath('\\frac{1}{2}'));
    const serialized = JSON.stringify(eq);
    expect(serialized).not.toContain('drawing');
    expect(serialized).not.toContain('drawing_type');
    expect(serialized).not.toContain('relationship_id');
  });
});

describe('构造期校验：退化结构根本构造不出来', () => {
  it('空 run 文本被拒', () => {
    const result = validateMathNode(mathRun(''));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_query');
  });

  it('空序列被拒（分式的分子、根式的被开方数、上下标的底数同理）', () => {
    expect(validateMathNode(sequence([])).ok).toBe(false);
    expect(validateMathNode(fraction(sequence([]), mathRun('2'))).ok).toBe(false);
    expect(validateMathNode(radical(sequence([]))).ok).toBe(false);
    expect(validateMathNode(superscript(sequence([]), mathRun('2'))).ok).toBe(false);
  });

  it('上下标两者都空被拒（应直接写底数）', () => {
    const bothNull = { kind: 'script', base: mathRun('x'), sub: null, sup: null } as const;
    const result = validateMathNode(bothNull);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('至少');
  });

  it('空的上标序列被拒；非法样式名被拒', () => {
    expect(validateMathNode(superscript(mathRun('x'), sequence([]))).ok).toBe(false);
    const badStyle = { kind: 'math_run', text: 'x', style: 'fraktur' } as unknown as Parameters<typeof validateMathNode>[0];
    expect(validateMathNode(badStyle).ok).toBe(false);
  });

  it('合法结构原样返回（不拷贝，便于上层做引用比较）', () => {
    const eq = fraction(mathRun('1'), mathRun('2'));
    const checked = validateMathNode(eq);
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.value).toBe(eq);
  });
});

describe('线性记法解析：常见形态能进结构，看不懂的一律拒绝', () => {
  it('分式 / 根式 / 带次数根式', () => {
    const frac = unwrap(parseMath('\\frac{1}{2}'));
    expect(frac.kind).toBe('fraction');
    expect(mathText(frac)).toBe('(1)/(2)');

    const sqrt = unwrap(parseMath('\\sqrt{x+1}'));
    expect(sqrt.kind).toBe('radical');
    expect(degreeOf(sqrt)).toBeNull();
    expect(mathText(sqrt)).toBe('√(x+1)');

    const cube = unwrap(parseMath('\\sqrt[3]{x}'));
    expect(runTextOf(degreeOf(cube)!)!).toBe('3');
    expect(mathText(cube)).toBe('(3)√(x)');
  });

  it('上下标：花括号与单字符两种写法都支持，且合并成 sSubSup', () => {
    expect(mathText(unwrap(parseMath('x^{2}')))).toBe('x^2');
    expect(mathText(unwrap(parseMath('x^2')))).toBe('x^2');
    expect(mathText(unwrap(parseMath('a_1')))).toBe('a_1');
    const both = unwrap(parseMath('a_1^{2}'));
    expect(both.kind).toBe('script');
    expect(unwrap(toOmmlShape(both)).omml).toBe('m:sSubSup');
  });

  it('多元素自动组成序列；分组不产生额外节点；运算符不切分 run', () => {
    // 有结构（上标）与纯文本并列时才成为序列
    const seq = unwrap(parseMath('x^{2}+y'));
    expect(seq.kind).toBe('sequence');
    expect(sequenceItemsOf(seq)!.length).toBe(2);
    expect(mathPlainText(seq)).toBe('x2+y');

    const plain = unwrap(parseMath('x+y'));
    // 运算符不是保留字符：`x+y` 是**一个** run（OMML 里运算符本就是 run 的文本）
    expect(plain.kind).toBe('math_run');
    expect(mathPlainText(plain)).toBe('x+y');

    const grouped = unwrap(parseMath('{x}'));
    expect(grouped.kind).toBe('math_run');
  });

  it('反例：未知宏 / 括号不配对 / 缺参数 / 重复上下标 / 空输入，全部 invalid_expression', () => {
    const cases = ['\\int_0^1 x', '\\frac{1}', '{x', 'x^{2', '\\frac{}{2}', 'x^2^3', '', '\\sqrt'];
    for (const source of cases) {
      const result = parseMath(source);
      expect(result.ok, `应被拒绝：${source}`).toBe(false);
      if (!result.ok) expect(result.code, `失败码应为 invalid_expression：${source}`).toBe('invalid_expression');
    }
  });

  it('equationFromLinear 直接给出可编辑的公式内容', () => {
    const content = unwrap(equationFromLinear('\\frac{1}{2}'));
    expect(content.kind).toBe('editable');
    expect(isPreserved(content)).toBe(false);
  });
});

describe('既有复杂公式：保留而不解析（WF-091 判据二 / R105）', () => {
  const existingOmml = { 'm:oMath': { 'm:func': { fname: 'sin' } } };

  it('保留分支原样冻结、可编辑分支为空、断言编辑被 unsupported 拒绝', () => {
    const content = preserveExistingEquation({ omml: existingOmml });

    expect(isPreserved(content)).toBe(true);
    expect(editableOf(content)).toBeNull();
    if (content.kind === 'preserved') {
      expect(content.omml).toBe(existingOmml); // 原样，不重建
      expect(Object.isFrozen(content.omml)).toBe(true);
      expect(content.reason).toBe(PRESERVED_EQUATION_REASON);
    }

    const gate = assertEditable(content);
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.code).toBe('unsupported'); // 不是 failed：明确不支持，且文档不变
      expect(gate.message).toContain('R105');
    }
  });

  it('自定义原因会替换默认原因；可编辑内容能过闸门', () => {
    const content = preserveExistingEquation({ omml: {}, reason: '矩阵公式本轮不解析' });
    expect(describeEquationContent(content)).toBe('公式[保留]：矩阵公式本轮不解析');

    const editable = editableEquation(mathRun('x'));
    const gate = assertEditable(editable);
    expect(gate.ok).toBe(true);
    expect(describeEquationContent(editable)).toBe('公式[可编辑]：math_run');
  });

  it('run 样式在 OMML 形状里保留（斜体/加粗/正体）', () => {
    const eq = sequence([mathRun('a', 'italic'), mathRun('b', 'normal'), mathRun('c', 'bold')]);
    expect(ommlRunStyles(unwrap(toOmmlShape(eq)))).toEqual(['italic', 'normal', 'bold']);
  });
});
