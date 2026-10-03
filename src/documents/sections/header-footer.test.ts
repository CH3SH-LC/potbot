/**
 * 页眉与页脚（WF-051/052）：**引用侧**的行为。
 *
 * 边界先说清楚：本包管"哪一节的哪一位指向哪个部件"，**不管部件里写什么**
 * （那是 `docx/**` 的活，R107 不让本包拼 XML）。所以下面所有用例都围绕
 * "引用能不能成立、链接状态对不对"，而不是"页眉里有没有那句文字"。
 */

import { describe, expect, it } from 'vitest';
import { DocumentModelError } from '../model/errors.js';
import { serializeSectionProperties } from '../docx/word-xml.js';
import { serializeXmlNode } from '../../artifacts/ooxml/xml.js';
import { DocxError } from '../docx/docx-error.js';
import {
  buildSectionsFixture,
  headerPart,
  headerRelationship,
  sectionAt,
  sectionWith,
} from './testing.js';
import {
  FOOTER_CONTENT_TYPE,
  FOOTER_RELATIONSHIP_TYPE,
  HEADER_CONTENT_TYPE,
  HEADER_RELATIONSHIP_TYPE,
  addHeaderFooterReference,
  applyEvenAndOddHeaders,
  applyTitlePageDifferent,
  contentTypeOf,
  headerFooterIssues,
  linkState,
  linkToPrevious,
  referenceOf,
  relationshipTypeOf,
  removeHeaderFooterReference,
  setHeaderFooterReference,
  setEvenAndOddHeaders,
  setTitlePageDifferent,
  unlinkFromPrevious,
  unsetEvenAndOddHeaders,
  unsetTitlePageDifferent,
} from './header-footer.js';
import type { DocumentModel } from '../model/types.js';

function expectModelError(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(DocumentModelError);
    expect((error as DocumentModelError).code).toBe(code);
    return;
  }
  throw new Error(`预期抛 DocumentModelError(${code})，但没有抛错`);
}

/** 两节文档，带一个页眉部件与它的关系（相对目标，与真实包一致）。 */
function fixture(): DocumentModel {
  return buildSectionsFixture({
    sections: [sectionWith({}), sectionWith({})],
    blocks_per_section: 1,
    opaque_parts: [headerPart('word/header1.xml'), headerPart('word/footer1.xml', 'footer')],
    relationships: [
      headerRelationship('rId9', 'header1.xml', 'header'),
      headerRelationship('rId10', 'footer1.xml', 'footer'),
    ],
  });
}

describe('WF-051 常量与规范一致（字面量钉住）', () => {
  it('关系类型与内容类型取值正确，且与 docx 的规则表同源', () => {
    expect(HEADER_RELATIONSHIP_TYPE).toBe(
      'http://schemas.openxmlformats.org/officeDocument/2006/relationships/header',
    );
    expect(FOOTER_RELATIONSHIP_TYPE).toBe(
      'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer',
    );
    expect(HEADER_CONTENT_TYPE).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml',
    );
    expect(FOOTER_CONTENT_TYPE).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml',
    );
    expect(relationshipTypeOf('header')).toBe(HEADER_RELATIONSHIP_TYPE);
    expect(relationshipTypeOf('footer')).toBe(FOOTER_RELATIONSHIP_TYPE);
    expect(contentTypeOf('header')).toBe(HEADER_CONTENT_TYPE);
    expect(contentTypeOf('footer')).toBe(FOOTER_CONTENT_TYPE);
  });
});

describe('WF-051 添加 / 编辑 / 删除引用', () => {
  it('添加引用：落到该节的 headers 上，位为 default', () => {
    const model = fixture();
    const next = addHeaderFooterReference(
      model,
      { kind: 'current', index: 1 },
      'header',
      'default',
      'word/header1.xml',
    );
    const reference = referenceOf(sectionAt(next, 1), 'header', 'default');
    expect(reference).toEqual({ part_path: 'word/header1.xml', kind: 'default' });
    // R108：第 1 节一个字节没动。
    expect(next.sections[0]).toBe(model.sections[0]);
  });

  it('落成 w:headerReference 需要关系映射（与导出器的契约正好对得上）', () => {
    const model = fixture();
    const next = addHeaderFooterReference(
      model,
      { kind: 'current', index: 0 },
      'header',
      'default',
      'word/header1.xml',
    );
    const section = sectionAt(next, 0);

    // 不给关系映射 ⇒ 导出器**拒绝写悬空 r:id**（D30 的 missing_section_reference_part）。
    expect(() => serializeSectionProperties(section)).toThrow(DocxError);

    // 给出映射 ⇒ 写出 w:type + r:id，且 rId 就是关系表里那一条。
    const xml = serializeXmlNode(
      serializeSectionProperties(section, {
        relationshipIdOf: (partPath, role) =>
          partPath === 'word/header1.xml' && role === 'header' ? 'rId9' : null,
      }),
    );
    expect(xml).toContain('<w:headerReference w:type="default" r:id="rId9"/>');
  });

  it('每个位最多一条引用：重复添加被拒绝', () => {
    const model = fixture();
    const once = addHeaderFooterReference(
      model,
      { kind: 'current', index: 0 },
      'header',
      'default',
      'word/header1.xml',
    );
    expectModelError(
      () =>
        addHeaderFooterReference(once, { kind: 'current', index: 0 }, 'header', 'default', 'word/header1.xml'),
      'invalid_relationship',
    );
  });

  it('换部件（编辑）用 set：替换该位的引用而不是叠加', () => {
    const model = fixture();
    const withHeader = addHeaderFooterReference(
      model,
      { kind: 'current', index: 0 },
      'header',
      'default',
      'word/header1.xml',
    );
    const replaced = setHeaderFooterReference(
      withHeader,
      { kind: 'current', index: 0 },
      'header',
      'default',
      'word/header1.xml',
    );
    expect(sectionAt(replaced, 0).headers).toEqual([
      { part_path: 'word/header1.xml', kind: 'default' },
    ]);
  });

  it('删除引用：该位回落到"链接到前一节"（没有引用）', () => {
    const model = fixture();
    const withHeader = addHeaderFooterReference(
      model,
      { kind: 'current', index: 1 },
      'header',
      'default',
      'word/header1.xml',
    );
    const removed = removeHeaderFooterReference(
      withHeader,
      { kind: 'current', index: 1 },
      'header',
      'default',
    );
    expect(referenceOf(sectionAt(removed, 1), 'header', 'default')).toBeNull();
    expect(removed.sections[1]?.headers).toEqual([]);
  });

  it('删除不存在的引用是恒等的（不改模型）', () => {
    const model = fixture();
    const next = removeHeaderFooterReference(model, { kind: 'current', index: 0 }, 'header', 'default');
    expect(next.sections[0]).toBe(model.sections[0]);
  });

  it('三个位（default/first/even）互相独立', () => {
    const model = fixture();
    let next = addHeaderFooterReference(model, { kind: 'current', index: 0 }, 'header', 'default', 'word/header1.xml');
    next = addHeaderFooterReference(next, { kind: 'current', index: 0 }, 'header', 'first', 'word/header1.xml');
    const headers = sectionAt(next, 0).headers;
    expect(headers).toHaveLength(2);
    expect(referenceOf(sectionAt(next, 0), 'header', 'even')).toBeNull();
  });
});

describe('WF-051 前置校验：引用必须落在真实部件与关系上（R106/R162）', () => {
  it('部件不存在 → 拒绝（本包不凭空造部件，那属 docx/**）', () => {
    const model = fixture();
    expectModelError(
      () =>
        addHeaderFooterReference(model, { kind: 'current', index: 0 }, 'header', 'default', 'word/header99.xml'),
      'dangling_relationship_target',
    );
  });

  it('内容类型不对 → 拒绝', () => {
    const model = buildSectionsFixture({
      sections: [sectionWith({})],
      blocks_per_section: 1,
      // 这个部件挂着"页脚"的内容类型，却当页眉用。
      opaque_parts: [headerPart('word/notAHeader.xml', 'footer')],
      relationships: [headerRelationship('rId1', 'notAHeader.xml', 'header')],
    });
    expectModelError(
      () =>
        addHeaderFooterReference(model, { kind: 'current', index: 0 }, 'header', 'default', 'word/notAHeader.xml'),
      'missing_content_type',
    );
  });

  it('关系缺失或类型不对 → 拒绝（写出去就是悬空 r:id）', () => {
    const model = buildSectionsFixture({
      sections: [sectionWith({})],
      blocks_per_section: 1,
      opaque_parts: [headerPart('word/header1.xml')],
      relationships: [],
    });
    expectModelError(
      () =>
        addHeaderFooterReference(model, { kind: 'current', index: 0 }, 'header', 'default', 'word/header1.xml'),
      'invalid_relationship',
    );
  });

  it('角色必须与内容类型一致：页眉部件不能当页脚用', () => {
    const model = buildSectionsFixture({
      sections: [sectionWith({})],
      blocks_per_section: 1,
      opaque_parts: [headerPart('word/hf.xml')], // 内容类型是 header
      relationships: [headerRelationship('rId1', 'hf.xml', 'header')],
    });
    const asHeader = addHeaderFooterReference(
      model,
      { kind: 'current', index: 0 },
      'header',
      'default',
      'word/hf.xml',
    );
    expect(referenceOf(sectionAt(asHeader, 0), 'header', 'default')).not.toBeNull();

    // 当页脚用：先被**内容类型**挡住（这个部件的类型是 header+xml）。
    expectModelError(
      () => addHeaderFooterReference(model, { kind: 'current', index: 0 }, 'footer', 'default', 'word/hf.xml'),
      'missing_content_type',
    );
  });

  it('按**角色**分别找关系：只有 footer 关系时，当页脚可以、当页眉被拒（R162）', () => {
    const model = buildSectionsFixture({
      sections: [sectionWith({})],
      blocks_per_section: 1,
      opaque_parts: [headerPart('word/footer1.xml', 'footer')],
      // 只有一条 **footer** 关系。若实现只按部件路径查关系，就会拿它去当页眉的 r:id。
      relationships: [headerRelationship('rId10', 'footer1.xml', 'footer')],
    });
    const asFooter = addHeaderFooterReference(
      model,
      { kind: 'current', index: 0 },
      'footer',
      'default',
      'word/footer1.xml',
    );
    expect(referenceOf(sectionAt(asFooter, 0), 'footer', 'default')).not.toBeNull();

    expectModelError(
      () => addHeaderFooterReference(model, { kind: 'current', index: 0 }, 'header', 'default', 'word/footer1.xml'),
      'missing_content_type', // 内容类型先挡（footer+xml 不是页眉的内容类型）
    );
  });

  it('角色选对了、但缺对应类型的关系 → invalid_relationship（不是"路径对就算过"）', () => {
    // 内容类型按页脚声明，却只给了 header 关系 ⇒ 内容类型过关，关系那关必须拦住。
    const model = buildSectionsFixture({
      sections: [sectionWith({})],
      blocks_per_section: 1,
      opaque_parts: [headerPart('word/f2.xml', 'footer')],
      relationships: [headerRelationship('rId11', 'f2.xml', 'header')],
    });
    expectModelError(
      () => addHeaderFooterReference(model, { kind: 'current', index: 0 }, 'footer', 'default', 'word/f2.xml'),
      'invalid_relationship',
    );
  });

  it('拒绝时文档不变（R140：操作前拒绝）', () => {
    const model = fixture();
    try {
      addHeaderFooterReference(model, { kind: 'current', index: 0 }, 'header', 'default', 'word/nope.xml');
    } catch {
      /* 预期 */
    }
    expect(model.sections[0]).toBe(model.sections[0]);
    expect(referenceOf(sectionAt(model, 0), 'header', 'default')).toBeNull();
  });
});

describe('WF-052 链接到前一节 / 取消链接', () => {
  it('没有引用 = 链接到前一节；linkState 如实反映', () => {
    const model = fixture();
    const state = linkState(sectionAt(model, 1));
    expect(state.header.default).toBe(true);
    expect(state.footer.even).toBe(true);
  });

  it('取消链接 = 为本节建立自己的引用（要求当前确实处于链接状态）', () => {
    const model = fixture();
    const next = unlinkFromPrevious(model, 1, 'header', 'default', 'word/header1.xml');
    expect(referenceOf(sectionAt(next, 1), 'header', 'default')).not.toBeNull();
    expect(linkState(sectionAt(next, 1)).header.default).toBe(false);
    // 未链接的节再"取消链接"是无意义的，直接拒绝。
    expectModelError(() => unlinkFromPrevious(next, 1, 'header', 'default', 'word/header1.xml'), 'invalid_relationship');
  });

  it('第 1 节没有"前一节"：链接与取消链接都拒绝（R140）', () => {
    const model = fixture();
    expectModelError(() => unlinkFromPrevious(model, 0, 'header', 'default', 'word/header1.xml'), 'unsupported');
    expectModelError(() => linkToPrevious(model, 0, 'header', 'default'), 'unsupported');
  });

  it('链接到前一节 = 删掉本节的引用；已经是链接状态时**幂等**（返回同一模型）', () => {
    const model = fixture();
    const withHeader = addHeaderFooterReference(
      model,
      { kind: 'current', index: 1 },
      'header',
      'default',
      'word/header1.xml',
    );
    const linked = linkToPrevious(withHeader, 1, 'header', 'default');
    expect(sectionAt(linked, 1).headers).toEqual([]);

    const again = linkToPrevious(linked, 1, 'header', 'default');
    expect(again).toBe(linked); // 幂等：同一个对象
  });

  it('链接与取消链接不碰别的节（R108）', () => {
    const model = fixture();
    const next = unlinkFromPrevious(model, 1, 'header', 'default', 'word/header1.xml');
    expect(next.sections[0]).toBe(model.sections[0]);
  });
});

describe('WF-052 首页 / 奇偶页不同', () => {
  it('两个开关各自四态分明：开 / 关 / 未指定（R118）', () => {
    const base = sectionWith({});
    expect(setTitlePageDifferent(base, true).titlePage).toEqual({ state: 'on' });
    expect(setTitlePageDifferent(base, false).titlePage).toEqual({ state: 'off' });
    expect(unsetTitlePageDifferent(setTitlePageDifferent(base, true)).titlePage).toEqual({
      state: 'unspecified',
    });
    expect(setEvenAndOddHeaders(base, true).evenAndOddHeaders).toEqual({ state: 'on' });
    expect(unsetEvenAndOddHeaders(setEvenAndOddHeaders(base, true)).evenAndOddHeaders).toEqual({
      state: 'unspecified',
    });
  });

  it('作用范围可以指定若干节', () => {
    const model = fixture();
    const next = applyTitlePageDifferent(model, { kind: 'indices', indices: [1] }, true);
    expect(next.sections[0]?.titlePage).toEqual({ state: 'unspecified' });
    expect(next.sections[1]?.titlePage).toEqual({ state: 'on' });

    const even = applyEvenAndOddHeaders(model, { kind: 'current', index: 0 }, true);
    expect(even.sections[0]?.evenAndOddHeaders).toEqual({ state: 'on' });
  });
});

describe('一致性问题提示（不拒绝，但要说出来）', () => {
  it('引用了「首页」页眉却没开首页不同 → 提示"这条引用不会生效"', () => {
    const model = fixture();
    const next = addHeaderFooterReference(model, { kind: 'current', index: 0 }, 'header', 'first', 'word/header1.xml');
    const issues = headerFooterIssues(next, 0);
    expect(issues.join('')).toContain('首页不同');

    // 开了首页不同之后，提示消失。
    const fixed = applyTitlePageDifferent(next, { kind: 'current', index: 0 }, true);
    expect(headerFooterIssues(fixed, 0)).toEqual([]);
  });

  it('引用了「偶数页」页眉却没开奇偶页不同 → 提示', () => {
    const model = fixture();
    const next = addHeaderFooterReference(model, { kind: 'current', index: 0 }, 'header', 'even', 'word/header1.xml');
    expect(headerFooterIssues(next, 0).join('')).toContain('奇偶页不同');
  });

  it('指向不存在的部件 → 报为硬问题（悬空引用，导出会失败）', () => {
    const model = fixture();
    const withRef = addHeaderFooterReference(model, { kind: 'current', index: 0 }, 'header', 'default', 'word/header1.xml');
    // 手工把部件从包里拿掉，模拟"引用还在、部件丢了"。
    const dangling: DocumentModel = { ...withRef, opaque_parts: [] };
    expect(headerFooterIssues(dangling, 0).join('')).toContain('悬空引用');
  });

  it('配置正常时没有任何提示', () => {
    const model = fixture();
    expect(headerFooterIssues(model, 0)).toEqual([]);
    expect(headerFooterIssues(model, 1)).toEqual([]);
  });
});
