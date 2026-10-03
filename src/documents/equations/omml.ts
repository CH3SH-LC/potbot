/**
 * 结构 → **OMML 语义形状**的映射（WF-091；R107）。
 *
 * ## 这里为什么只给"形状"而不写 XML
 *
 * R107 把"模型 ↔ OOXML 的转换"集中在 docx 子模块，其它模块**不得拼 XML 字符串**。
 * 但公式又必须在导出时变成 `m:oMath` 那一套元素——于是本包只产出**元素名做字段的普通对象**
 * （`{ omml: 'm:f', num, den }`）：导出器拿到它就知道该写 `<m:f><m:num>…`，
 * 而本包自己一个尖括号都不产生。这样"语义正确"与"字节正确"各自可被独立断言。
 *
 * ## 形状不是"随便的树"
 *
 * 形状的**结构**必须与 OMML 的元素嵌套一致，否则导出器会写出 Word 不认的 XML：
 * - 分式 ⇒ `m:f` 下面**必须**是 `m:num` 与 `m:den` 两个子形状（对应本包的 `num`/`den` 字段）；
 * - 根式 ⇒ `m:rad` 下 `m:deg`（可缺省）+ `m:e`（被开方数）；
 * - 上下标 ⇒ `m:sSup` / `m:sSub` / `m:sSubSup`（元素名随形态变化，不是恒定的一个名字）；
 * - 序列 ⇒ `m:oMath`（公式体的容器）。
 */

import { validateMathNode } from './build.js';
import { fail, succeed, type Result } from '../selection/types.js';
import type { MathNode, MathRunStyle, OmmlShape } from './types.js';

/** 结构 → OMML 语义形状。传入非法结构（空 run / 空序列）时返回 `Failure`。 */
export function toOmmlShape(node: MathNode): Result<OmmlShape> {
  const checked = validateMathNode(node);
  if (!checked.ok) return checked;

  switch (node.kind) {
    case 'math_run':
      return succeed({ omml: 'm:r', text: node.text, style: node.style });

    case 'sequence': {
      const children: OmmlShape[] = [];
      for (const item of node.items) {
        const mapped = toOmmlShape(item);
        if (!mapped.ok) return mapped;
        children.push(mapped.value);
      }
      return succeed({ omml: 'm:oMath', children });
    }

    case 'fraction': {
      const num = toOmmlShape(node.numerator);
      if (!num.ok) return num;
      const den = toOmmlShape(node.denominator);
      if (!den.ok) return den;
      return succeed({ omml: 'm:f', num: num.value, den: den.value });
    }

    case 'radical': {
      const e = toOmmlShape(node.radicand);
      if (!e.ok) return e;
      if (node.degree === null) {
        return succeed({ omml: 'm:rad', deg: null, e: e.value });
      }
      const deg = toOmmlShape(node.degree);
      if (!deg.ok) return deg;
      return succeed({ omml: 'm:rad', deg: deg.value, e: e.value });
    }

    case 'script': {
      const e = toOmmlShape(node.base);
      if (!e.ok) return e;
      if (node.sub !== null && node.sup !== null) {
        const sub = toOmmlShape(node.sub);
        if (!sub.ok) return sub;
        const sup = toOmmlShape(node.sup);
        if (!sup.ok) return sup;
        return succeed({ omml: 'm:sSubSup', e: e.value, sub: sub.value, sup: sup.value });
      }
      if (node.sup !== null) {
        const sup = toOmmlShape(node.sup);
        if (!sup.ok) return sup;
        return succeed({ omml: 'm:sSup', e: e.value, sup: sup.value });
      }
      if (node.sub !== null) {
        const sub = toOmmlShape(node.sub);
        if (!sub.ok) return sub;
        return succeed({ omml: 'm:sSub', e: e.value, sub: sub.value });
      }
      // `validateMathNode` 已挡死"两者皆空"；此处只是让类型系统满意。
      return fail('invalid_query', '上下标既无下标也无上标，无法映射到 OMML。', { extra: { slot: 'script' } });
    }
  }
}

/**
 * 形状 → 元素名的**深度优先展开**（含嵌套），便于测试与导出器做"元素清单"核对。
 * 例如分式给出 `['m:f', 'm:num' 子树…, 'm:den' 子树…]`——本函数只把 `omml` 字段提出来。
 */
export function ommlElementNames(shape: OmmlShape): readonly string[] {
  switch (shape.omml) {
    case 'm:r':
      return ['m:r'];
    case 'm:oMath':
      return ['m:oMath', ...shape.children.flatMap((child) => ommlElementNames(child))];
    case 'm:f':
      return ['m:f', ...ommlElementNames(shape.num), ...ommlElementNames(shape.den)];
    case 'm:rad':
      return ['m:rad', ...(shape.deg === null ? [] : ommlElementNames(shape.deg)), ...ommlElementNames(shape.e)];
    case 'm:sSup':
      return ['m:sSup', ...ommlElementNames(shape.e), ...ommlElementNames(shape.sup)];
    case 'm:sSub':
      return ['m:sSub', ...ommlElementNames(shape.e), ...ommlElementNames(shape.sub)];
    case 'm:sSubSup':
      return ['m:sSubSup', ...ommlElementNames(shape.e), ...ommlElementNames(shape.sub), ...ommlElementNames(shape.sup)];
  }
}

/** 形状里出现的全部数学 run 文本（按顺序）——供"公式内容确实进了 OMML 形状"的断言。 */
export function ommlRunTexts(shape: OmmlShape): readonly string[] {
  switch (shape.omml) {
    case 'm:r':
      return [shape.text];
    case 'm:oMath':
      return shape.children.flatMap((child) => ommlRunTexts(child));
    case 'm:f':
      return [...ommlRunTexts(shape.num), ...ommlRunTexts(shape.den)];
    case 'm:rad':
      return [...(shape.deg === null ? [] : ommlRunTexts(shape.deg)), ...ommlRunTexts(shape.e)];
    case 'm:sSup':
      return [...ommlRunTexts(shape.e), ...ommlRunTexts(shape.sup)];
    case 'm:sSub':
      return [...ommlRunTexts(shape.e), ...ommlRunTexts(shape.sub)];
    case 'm:sSubSup':
      return [...ommlRunTexts(shape.e), ...ommlRunTexts(shape.sub), ...ommlRunTexts(shape.sup)];
  }
}

/** 形状里出现的 run 样式集合（去重后按首次出现排序）——供"上下标字体样式"这类断言。 */
export function ommlRunStyles(shape: OmmlShape): readonly MathRunStyle[] {
  const seen: MathRunStyle[] = [];
  const visit = (s: OmmlShape): void => {
    switch (s.omml) {
      case 'm:r':
        if (!seen.includes(s.style)) seen.push(s.style);
        return;
      case 'm:oMath':
        s.children.forEach(visit);
        return;
      case 'm:f':
        visit(s.num);
        visit(s.den);
        return;
      case 'm:rad':
        if (s.deg !== null) visit(s.deg);
        visit(s.e);
        return;
      case 'm:sSup':
        visit(s.e);
        visit(s.sup);
        return;
      case 'm:sSub':
        visit(s.e);
        visit(s.sub);
        return;
      case 'm:sSubSup':
        visit(s.e);
        visit(s.sub);
        visit(s.sup);
        return;
    }
  };
  visit(shape);
  return seen;
}
