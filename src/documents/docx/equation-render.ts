/**
 * **公式结构 → OMML 字节**（design-05-P9 / WF-091 的导出接线；R107）。
 *
 * ## 本文件是整个仓库里**唯一**产出 `m:oMath` 的地方
 *
 * `src/documents/equations/omml.ts` 依 R107 只产出**语义形状**（`OmmlShape`：元素名做字段的
 * 普通对象），一个尖括号都不写。把它变成字节是 `docx/**` 的职责——本文件就是那一处。
 * 于是"结构对不对"（equations 包的用例断言形状）与"字节对不对"（本文件的用例断言 XML）
 * 各自可被独立判据钉住。
 *
 * ## 判据：**公式是结构，不是图片、也不是装着 "1/2" 的文本**
 *
 * 分式必须落成 `m:f` 下**两个独立子元素** `m:num` / `m:den`，各自带自己的 `m:r`/`m:t`。
 * 读方（人、测试、Word）因此能分别读出分子与分母——把 `"1/2"` 塞进一个 `m:t` 里在
 * 本文件的类型层面就写不出来：`renderOmmlShape` 的每个分支都直接对应一个 OMML 元素，
 * **没有**"把子树拍平成一个字符串"的分支。
 *
 * ## 命名空间就地声明（与 `operations/drawing/drawing-xml.ts` 同一手法）
 *
 * `m:` 前缀在主部件的根元素上通常已经声明，但**合成语料**（如 `corpus-a`）的根上只有
 * `xmlns:w`。`export.ts` 的 `withRequiredNamespaceDeclarations` 只兜底 `r:`，因此本文件
 * 在 `m:oMath` 上**就地声明** `xmlns:m`——写出一个前缀未绑定的包是 XML 层面就不合法的文档。
 * 就地声明是自洽的，真实 Word 读得进去。
 *
 * ## 既有的复杂公式（R105）**不在这里**
 *
 * 导入文档里已有的公式若用到本仓未建模的构造（矩阵、积分号限……），它们在导入期就作为
 * 未建模片段（`raw_at_char`）落在 run 的 `opaque` 上，导出时**原样写回**——那是
 * `export.ts` 的"保留优先"路径，与本章无关。本文件只负责把**本仓建模的结构**（分式 /
 * 根式 / 上下标 / 序列 / 数学 run）渲染出来；`preserved` 分支**刻意**不被接受为导出输入，
 * 免得"把没看懂的公式重写一遍"（R105 的取向）。
 */

import { attr, el, type XmlElement } from '../../artifacts/ooxml/xml.js';
import { toOmmlShape } from '../equations/omml.js';
import type { MathNode, MathRunStyle, OmmlShape } from '../equations/types.js';

/** OMML 命名空间（`m:` 前缀）。 */
export const MATH_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/math';

/**
 * 数学 run 样式 → OMML 属性。
 *
 * | 模型值 | OMML 落点 | 值 |
 * |---|---|---|
 * | `italic` | `m:sty` | `i` |
 * | `bold` | `m:sty` | `b` |
 * | `normal` | `m:sty` | `p`（plain） |
 * | `double-struck` | `m:scr` | `double-struck` |
 * | `script` | `m:scr` | `script` |
 *
 * 为什么斜体/粗体走 `m:sty` 而花体/双线走 `m:scr`：ECMA-376 里 `m:sty`（`ST_Style`）只管
 * 直/斜/粗/粗斜，字形族（双线、手写、无衬线……）在 `m:scr`（`ST_Script`）。把双线写进
 * `m:sty` 会写出一个枚举外的值——那是"看着像、其实是坏文档"。
 */
function mathRunStyleElements(style: MathRunStyle): XmlElement[] {
  switch (style) {
    case 'italic':
      return [el('m:sty', [attr('m:val', 'i')])];
    case 'bold':
      return [el('m:sty', [attr('m:val', 'b')])];
    case 'normal':
      return [el('m:sty', [attr('m:val', 'p')])];
    case 'double-struck':
      return [el('m:scr', [attr('m:val', 'double-struck')])];
    case 'script':
      return [el('m:scr', [attr('m:val', 'script')])];
  }
}

/**
 * 语义形状 → OMML 元素（递归）。
 *
 * 每个 `omml` 分支对应**一个** OMML 元素，子元素顺序照 ECMA-376 的 `CT_F` / `CT_Rad` /
 * `CT_SSub` / `CT_SSup` / `CT_SSubSup` 序列（`Pr` → 操作数）。顺序不是审美问题：
 * OOXML 的这些类型是**序列**，乱序对严格校验器就是非法文档。
 */
export function renderOmmlShape(shape: OmmlShape): XmlElement {
  switch (shape.omml) {
    case 'm:r': {
      const children: XmlElement[] = [];
      const properties = mathRunStyleElements(shape.style);
      if (properties.length > 0) children.push(el('m:rPr', [], properties));
      // `xml:space="preserve"` 与 `w:t` 同口径（R104）：数学 run 里的空白同样不得折叠。
      children.push(el('m:t', [attr('xml:space', 'preserve')], [shape.text]));
      return el('m:r', [], children);
    }
    case 'm:oMath':
      return el('m:oMath', [], shape.children.map((child) => renderOmmlShape(child)));
    case 'm:f':
      return el('m:f', [], [
        el('m:num', [], [renderOmmlShape(shape.num)]),
        el('m:den', [], [renderOmmlShape(shape.den)]),
      ]);
    case 'm:rad': {
      // 平方根（`deg === null`）在 OMML 里**不是**"省略 `m:deg`"，而是 `m:degHide`
      // ——两者读起来一样，写对了才与 Word 一致。
      const children: XmlElement[] = [];
      if (shape.deg === null) {
        children.push(el('m:radPr', [], [el('m:degHide', [attr('m:val', '1')])]));
        children.push(el('m:deg'));
      } else {
        children.push(el('m:deg', [], [renderOmmlShape(shape.deg)]));
      }
      children.push(el('m:e', [], [renderOmmlShape(shape.e)]));
      return el('m:rad', [], children);
    }
    case 'm:sSup':
      return el('m:sSup', [], [
        el('m:e', [], [renderOmmlShape(shape.e)]),
        el('m:sup', [], [renderOmmlShape(shape.sup)]),
      ]);
    case 'm:sSub':
      return el('m:sSub', [], [
        el('m:e', [], [renderOmmlShape(shape.e)]),
        el('m:sub', [], [renderOmmlShape(shape.sub)]),
      ]);
    case 'm:sSubSup':
      return el('m:sSubSup', [], [
        el('m:e', [], [renderOmmlShape(shape.e)]),
        el('m:sub', [], [renderOmmlShape(shape.sub)]),
        el('m:sup', [], [renderOmmlShape(shape.sup)]),
      ]);
  }
}

/**
 * 结构树 → `<m:oMath>` 元素（**行内对象的落点**）。
 *
 * 结构树根**不是** `sequence` 时（例如整条公式就是一个分式），`toOmmlShape` 给回来的是
 * `m:f` 形状；公式体容器 `m:oMath` 由本函数补上。根**是** `sequence` 时形状本身就是
 * `m:oMath`，直接用（不再套一层，免得写出 `m:oMath` 套 `m:oMath`）。
 *
 * @throws {Error} 结构非法（空 run / 空序列）——`toOmmlShape` 会拒绝，本函数把
 *   `Failure` 转成异常。调用方（`export.ts`）在写出前先做这一步，因此**不产出半成品**（R140）。
 */
export function equationElement(equation: MathNode): XmlElement {
  const shape = toOmmlShape(equation);
  if (!shape.ok) {
    throw new Error(
      `公式结构非法，无法渲染成 OMML：${shape.message}` +
        `（拒绝码 ${shape.code}；公式是结构不是文本，非法结构不写出半成品）。`,
    );
  }
  const root = shape.value;
  const body = root.omml === 'm:oMath' ? root : null;
  const children = body === null ? [renderOmmlShape(root)] : body.children.map((child) => renderOmmlShape(child));
  // `xmlns:m` **就地声明**：合成语料的根元素上可能没有它（见文件头）。
  return el('m:oMath', [attr('xmlns:m', MATH_NS)], children);
}
