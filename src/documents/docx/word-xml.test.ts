/**
 * 属性写出层的状态分流与**单位换算委派**测试（WCF-D02）。
 *
 * 这份测试盯三件事，每一件都是"看起来对了、其实错了"的高发区：
 *
 * 1. **四态必须分得开**（R117/R118）：`on` ⇒ `<w:b/>`、`off` ⇒ `<w:b w:val="false"/>`、
 *    `unspecified` / `inherit` ⇒ 无元素。特别是 **`inherit` 绝不能退化成 `off` 的字节**——
 *    "清除加粗"若写成 `w:val="false"`，语义就从"回落到样式的加粗"变成"显式不加粗"。
 * 2. **`unspecified` 与 `inherit` 在字节上相同是 OOXML 的约束，不是实现偷懒**：
 *    OOXML 没有"显式继承"标记，继承的表达方式**就是**没有该属性。要让两者产出不同字节，
 *    只能发明一个非标准写法，反而会写出别的软件读不懂的文档。这条"等价"被**显式固定**下来，
 *    免得后人误以为是遗漏而"修"成错的。
 * 3. **单位换算不在本层**（R128）：字面量断言证明数值正确；源码扫描证明
 *    `word-xml.ts` **没有**自己实现换算，而是调用 `src/documents/units/**`。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { serializeXmlNode, utf8Bytes } from '../../artifacts/ooxml/xml.js';
import type { ParagraphProperties, RunProperties } from '../model/types.js';
import { fontSizeToHalfPoints } from '../units/index.js';
import { parseXmlBytes } from './xml-parse.js';
import {
  W_NS,
  emptyParagraphProperties,
  emptyRunProperties,
  parseParagraphProperties,
  parseRunProperties,
  serializeParagraphPropertyChildren,
  serializeRunProperties,
} from './word-xml.js';

/** 序列化一组 run 属性（无属性可写时返回空串——**连 `w:rPr` 都不写**）。 */
function runXml(properties: RunProperties): string {
  const element = serializeRunProperties(properties);
  return element === null ? '' : serializeXmlNode(element);
}

/** 序列化一组段落属性（返回 `w:pPr` 的子元素串接）。 */
function paragraphXml(properties: ParagraphProperties): string {
  return serializeParagraphPropertyChildren(properties).map(serializeXmlNode).join('');
}

/**
 * 把 `runXml` 的产出（一个完整的 `w:rPr`，或空串）重新读回模型——
 * "写出了什么、读回是什么"的闭环断言。
 */
function reparseRunProperties(xml: string): RunProperties {
  if (xml.trim().length === 0) return emptyRunProperties();
  // 序列化产物里**没有**命名空间声明（它们挂在文档根上），因此这里补一个再解析。
  const withNamespace = xml.replace('>', ` xmlns:w="${W_NS}">`);
  return parseRunProperties(parseXmlBytes(utf8Bytes(withNamespace)));
}

// ---------------------------------------------------------------------------
// 1. 四态分流
// ---------------------------------------------------------------------------

describe('开关型属性：四态各自产出什么（R117/R118）', () => {
  const withBold = (state: RunProperties['bold']): RunProperties => ({
    ...emptyRunProperties(),
    bold: state,
  });

  it('`on` ⇒ `<w:b/>`', () => {
    expect(runXml(withBold({ state: 'on' }))).toBe('<w:rPr><w:b/></w:rPr>');
  });

  it('`off` ⇒ `<w:b w:val="false"/>`（**显式**关闭，带字节）', () => {
    expect(runXml(withBold({ state: 'off' }))).toBe('<w:rPr><w:b w:val="false"/></w:rPr>');
  });

  it('`unspecified` ⇒ 没有 `w:b`（未指定 ≠ 显式关闭）', () => {
    expect(runXml(withBold({ state: 'unspecified' }))).toBe('');
  });

  it('`inherit` ⇒ 没有 `w:b`（清除到继承）', () => {
    expect(runXml(withBold({ state: 'inherit' }))).toBe('');
  });

  it('**`inherit` 绝不能退化成 `off` 的字节**', () => {
    const off = runXml(withBold({ state: 'off' }));
    const inherit = runXml(withBold({ state: 'inherit' }));
    expect(inherit).not.toBe(off);
    expect(inherit).not.toContain('w:val="false"');
  });

  it('从 `off` 改成 `inherit`：元素**消失**，而不是变成"更弱的关闭"', () => {
    const before = runXml(withBold({ state: 'off' }));
    const after = runXml(withBold({ state: 'inherit' }));
    expect(before).toContain('w:val="false"');
    expect(after).toBe('');
  });

  it('写出的 `inherit` 读回来是 `unspecified`，**不是** `off`（清除不会被记成关闭）', () => {
    const reparsed = reparseRunProperties(runXml(withBold({ state: 'inherit' })));
    expect(reparsed.bold).toEqual({ state: 'unspecified' });
    expect(reparsed.bold).not.toEqual({ state: 'off' });
  });

  it('写出的 `off` 读回来仍是 `off`（反向对照：证明上一条不是恒真）', () => {
    const reparsed = reparseRunProperties(runXml(withBold({ state: 'off' })));
    expect(reparsed.bold).toEqual({ state: 'off' });
  });

  it('`unspecified` 与 `inherit` 的字节**有意**相同——OOXML 没有"显式继承"标记', () => {
    // 这条断言把"等价"固定成**已知的、有意的**行为。
    // 它不是遗漏：OOXML 里"继承"的表达方式就是"没有这个属性"。
    // 真正必须分开的是下面这条：
    expect(runXml(withBold({ state: 'unspecified' }))).toBe(runXml(withBold({ state: 'inherit' })));
    expect(runXml(withBold({ state: 'off' }))).not.toBe(runXml(withBold({ state: 'inherit' })));
  });
});

// ---------------------------------------------------------------------------
// 2. 「显式取消」与「继承」是两条不同的路
// ---------------------------------------------------------------------------

describe('带值属性：显式取消（set）与继承（inherit）走不同的路', () => {
  it('下划线：`set("none")` 有字节，`inherit` 没有', () => {
    const explicit = runXml({ ...emptyRunProperties(), underline: { state: 'set', value: 'none' } });
    const inherited = runXml({ ...emptyRunProperties(), underline: { state: 'inherit' } });
    expect(explicit).toContain('<w:u w:val="none"/>');
    expect(inherited).toBe('');
    expect(inherited).not.toBe(explicit);
  });

  it('高亮：`set("none")`（取消高亮）有字节，`inherit` 没有', () => {
    const explicit = runXml({ ...emptyRunProperties(), highlight: { state: 'set', value: 'none' } });
    const inherited = runXml({ ...emptyRunProperties(), highlight: { state: 'inherit' } });
    expect(explicit).toContain('<w:highlight w:val="none"/>');
    expect(inherited).toBe('');
  });

  it('底纹：`set({fill:null,…})` 写出 `w:fill="auto"`，`inherit` 不写元素', () => {
    const explicit = runXml({
      ...emptyRunProperties(),
      shading: { state: 'set', value: { fill_hex: null, pattern: null, color_hex: null } },
    });
    const inherited = runXml({ ...emptyRunProperties(), shading: { state: 'inherit' } });
    expect(explicit).toContain('<w:shd w:val="clear" w:color="auto" w:fill="auto"/>');
    expect(inherited).toBe('');
  });

  it('大纲级别：`set(null)`（显式"正文"）写出 `w:val="9"`，`unspecified` 什么都不写', () => {
    const bodyText = paragraphXml({
      ...emptyParagraphProperties(),
      outlineLevel: { state: 'set', value: null },
    });
    const unspecified = paragraphXml({
      ...emptyParagraphProperties(),
      outlineLevel: { state: 'unspecified' },
    });
    expect(bodyText).toContain('<w:outlineLvl w:val="9"/>');
    expect(unspecified).toBe('');
  });

  it('大纲级别往返：`w:val="9"` 读回 `set(null)`，不是"未指定"', () => {
    const root = parseXmlBytes(
      utf8Bytes(`<w:pPr xmlns:w="${W_NS}"><w:outlineLvl w:val="9"/></w:pPr>`),
    );
    expect(parseParagraphProperties(root).outlineLevel).toEqual({ state: 'set', value: null });
  });
});

// ---------------------------------------------------------------------------
// 3. 数值来自 units 的换算（字面量钉死口径）
// ---------------------------------------------------------------------------

describe('属性数值：口径与 units 一致（R128）', () => {
  it('字号：12pt ⇒ `w:sz=24` 与 `w:szCs=24`（半点值）', () => {
    const xml = runXml({ ...emptyRunProperties(), size: { state: 'set', value: { kind: 'pt', value: 12 } } });
    expect(xml).toContain('<w:sz w:val="24"/>');
    expect(xml).toContain('<w:szCs w:val="24"/>');
  });

  it('中文字号名：五号（10.5pt）⇒ `w:sz=21`，证明字号表来自 units 而不是本层另存一份', () => {
    const xml = runXml({
      ...emptyRunProperties(),
      size: { state: 'set', value: { kind: 'chinese', name: '五号' } },
    });
    expect(xml).toContain('<w:sz w:val="21"/>');
  });

  it('行距：1.5 倍 ⇒ `w:line=360 lineRule=auto`；固定 20pt ⇒ `w:line=400 lineRule=exact`', () => {
    const oneAndHalf = paragraphXml({
      ...emptyParagraphProperties(),
      lineSpacing: { state: 'set', value: { kind: 'oneAndHalf' } },
    });
    expect(oneAndHalf).toContain('<w:spacing w:line="360" w:lineRule="auto"/>');

    const exact = paragraphXml({
      ...emptyParagraphProperties(),
      lineSpacing: { state: 'set', value: { kind: 'exact', value: { unit: 'pt', value: 20 } } },
    });
    expect(exact).toContain('w:line="400"');
    expect(exact).toContain('w:lineRule="exact"');
  });

  it('段前：12pt ⇒ `w:before=240`，并按 units 的约定显式写 `w:beforeAutospacing="0"`', () => {
    const xml = paragraphXml({
      ...emptyParagraphProperties(),
      spacingBefore: { state: 'set', value: { kind: 'pt', value: 12 } },
    });
    expect(xml).toContain('w:before="240"');
    expect(xml).toContain('w:beforeAutospacing="0"');
  });

  it('段前「按行」：1.5 行 ⇒ `w:beforeLines=150`（1/100 行刻度，与 twips 不混）', () => {
    const xml = paragraphXml({
      ...emptyParagraphProperties(),
      spacingBefore: { state: 'set', value: { kind: 'lines', value: 1.5 } },
    });
    expect(xml).toContain('w:beforeLines="150"');
    expect(xml).not.toContain('w:before="');
  });

  it('缩进：首行 2 字 ⇒ `w:firstLineChars=200`（**不是**长度属性）', () => {
    const xml = paragraphXml({
      ...emptyParagraphProperties(),
      indent: {
        ...emptyParagraphProperties().indent,
        firstLine: { state: 'set', value: { unit: 'chars', value: 2 } },
      },
    });
    expect(xml).toContain('w:firstLineChars="200"');
    expect(xml).not.toContain('w:firstLine="');
  });

  it('缩进：左 2cm ⇒ `w:left=1134`（长度属性，且 `*Chars` 不出现）', () => {
    const xml = paragraphXml({
      ...emptyParagraphProperties(),
      indent: {
        ...emptyParagraphProperties().indent,
        left: { state: 'set', value: { unit: 'cm', value: 2 } },
      },
    });
    expect(xml).toContain('w:left="1134"');
    expect(xml).not.toContain('leftChars');
  });

  it('制表位：1cm ⇒ `w:pos=567`，且按 units 的规则升序排列', () => {
    const xml = paragraphXml({
      ...emptyParagraphProperties(),
      tabStops: {
        state: 'set',
        value: [
          { position: { unit: 'cm', value: 3 }, alignment: 'right', leader: 'dot' },
          { position: { unit: 'cm', value: 1 }, alignment: 'left', leader: 'none' },
        ],
      },
    });
    expect(xml).toContain('w:pos="567"');
    expect(xml).toContain('w:pos="1701"');
    expect(xml.indexOf('w:pos="567"')).toBeLessThan(xml.indexOf('w:pos="1701"'));
  });
});

// ---------------------------------------------------------------------------
// 3b. 字号可表示性：**拒绝**而不是静默取整（R131/R136；协调者裁定）
// ---------------------------------------------------------------------------

describe('字号：不可表示时拒绝，不静默改用户给的值（R131/R136）', () => {
  const withSize = (points: number): RunProperties => ({
    ...emptyRunProperties(),
    size: { state: 'set', value: { kind: 'pt', value: points } },
  });

  it('12.3pt 被**拒绝**（不是悄悄变成 12.5pt）', () => {
    expect(() => runXml(withSize(12.3))).toThrowError(/无法表示/);
  });

  it('对照：落在半点格点上的 12.5pt 照常写出（`w:sz=25`），证明拒绝不是"凡小数就拦"', () => {
    expect(runXml(withSize(12.5))).toContain('<w:sz w:val="25"/>');
  });

  it('对照：units 的换算函数**确实会**把 12.3 取整成 25——我们刻意不采用那种做法', () => {
    // 这一条把"两种策略的差别"写死在测试里：units 取整，本层拒绝。
    // 若将来 units 改成抛错，这条会红——那时应当同步本层并更新策略说明。
    expect(fontSizeToHalfPoints({ kind: 'pt', value: 12.3 })).toBe(25);
    expect(() => runXml(withSize(12.3))).toThrowError();
    // 因此本层**不可能**产出那个被取整的值
    expect(runXml(withSize(12.5))).not.toBe('');
  });

  it('小于 w:sz 最小可表达值（0.5pt）的字号被拒绝', () => {
    expect(() => runXml(withSize(0.4))).toThrowError(/0\.5 pt/);
  });

  it('半个点（0.5pt）本身是合法的（`w:sz=1`）', () => {
    expect(runXml(withSize(0.5))).toContain('<w:sz w:val="1"/>');
  });
});

// ---------------------------------------------------------------------------
// 4. 结构性判据：本层**没有**自己的换算实现
// ---------------------------------------------------------------------------

describe('单位换算委派（R128）', () => {
  it('`word-xml.ts` 从 units 包导入换算，且不再自己声明任何换算函数/常量', () => {
    const source = readFileSync(fileURLToPath(new URL('./word-xml.ts', import.meta.url)), 'utf8');
    // 先剥掉块注释：文件头把"不许出现这些"讲了一遍，那些字面量出现在注释里是**合规**的。
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '');

    expect(code).toContain("from '../units/index.js'");

    const forbiddenDeclarations = [
      'TWIPS_PER_POINT',
      'HALF_POINTS_PER_POINT',
      'HUNDREDTHS_PER_CHAR',
      'HUNDREDTHS_PER_LINE',
      'AUTO_LINE_UNIT',
      'lengthToTwips',
      'twipsToPoints',
      'twipsToLength',
      'lineSpacingToOoxml',
      'lineSpacingFromOoxml',
      'paragraphSpacingToOoxml',
      'paragraphSpacingFromOoxml',
      'indentToOoxml',
      'fontSizeToHalfPoints',
    ];
    for (const name of forbiddenDeclarations) {
      const declaration = new RegExp(`^\\s*(?:export\\s+)?(?:const|function)\\s+${name}\\b`, 'm');
      expect(
        declaration.test(code),
        `word-xml.ts 不应再自己声明 ${name}（换算必须调用 src/documents/units/**）`,
      ).toBe(false);
    }
  });

  it('换算魔数（20 / 240 / 1440 / 100）不再出现在 `word-xml.ts` 的**代码**里', () => {
    const source = readFileSync(fileURLToPath(new URL('./word-xml.ts', import.meta.url)), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '');
    // 只认"乘法/除法里出现的换算魔数"，避免误伤 `0x20` 之类的无关数字。
    for (const pattern of [/\*\s*20\b/, /\/\s*20\b/, /\*\s*240\b/, /\*\s*1440\b/, /\*\s*100\b/, /\/\s*100\b/]) {
      expect(pattern.test(code), `不该出现换算魔数：${String(pattern)}`).toBe(false);
    }
  });
});
