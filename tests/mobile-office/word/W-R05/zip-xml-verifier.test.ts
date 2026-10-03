/**
 * **W-R05 — 独立 ZIP/XML 复核器 + 部件级差异核对器**的取证测试。
 *
 * ## 这个包在证明什么
 *
 * 「未改部件逐字节不变」「导出包结构完整」这类主张，如果只用**被测实现自己的读取器**去读，
 * 等于让嫌疑犯给自己做笔录。本包提供**第二套、独立实现**的包级复核：自研 CRC-32（逐位，
 * 非仓内查表）、自研中央目录解析（非 `zip-read`）、自研的 OPC 部件对账。测试用手工常量
 * 构造 DOCX 字节，**没有一份语料来自被测实现**。
 *
 * ## 反向对照（防"判据是空壳"）
 *
 * 每个坏包**只在正例的一处偏离**，其触发的判据必须**恰好**是预期的那一条：
 * | 坏包 | 期望触发的判据 |
 * |---|---|
 * | `badDanglingRelationship` | `dangling_relationship` |
 * | `badCrcMismatch`（头部 CRC 错） | `crc_mismatch` |
 * | `badCorruptedData`（数据坏、CRC 仍旧值） | `crc_mismatch` |
 * | `badMissingContentType` | `missing_content_type_declaration` |
 * | `badDanglingOverride` | `dangling_content_type_override` |
 * | `badDuplicateOverride` | `duplicate_content_type_override` |
 * | `badMissingContentTypesPart` | `missing_content_types_part` |
 * | `badTruncated` | `zip_error` |
 * 另有**假阳对照**：`goodDocxWithExternalRelationship`（外部关系）必须**零 issue**——防止
 * 「见谁都报」的空壳判据。
 *
 * ## 变异探针
 *
 * 见 README「变异探针」一节：临时反置一条关键判据会使本文件的用例转红，还原后复绿。
 */

import { crc32 as zlibCrc32, deflateRawSync, inflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
  crc32,
  diffOoxmlPackages,
  entryCrcMatches,
  parseZip,
  resolveRelationshipTarget,
  scanStartTags,
  verifyOoxmlPackage,
  type VerifyIssue,
  type VerifyIssueKind,
} from './verifier/index.js';
import {
  badCorruptedData,
  badCrcMismatch,
  badDanglingOverride,
  badDanglingRelationship,
  badDuplicateOverride,
  badMissingContentType,
  badMissingContentTypesPart,
  badTruncated,
  deflatedDocx,
  goodDocx,
  goodDocxWithEditedBody,
  goodDocxWithExternalRelationship,
  docxWithExtraPart,
} from './test-support/fixtures.js';

function kindsOf(issues: readonly VerifyIssue[]): VerifyIssueKind[] {
  return issues.map((issue) => issue.kind);
}

function issuesOfKind(
  issues: readonly VerifyIssue[],
  kind: VerifyIssueKind,
): VerifyIssue[] {
  return issues.filter((issue) => issue.kind === kind);
}

// ---------------------------------------------------------------------------
// §A 自研 CRC-32 的正确性（先证明尺子准，再拿它量东西）
// ---------------------------------------------------------------------------

describe('W-R05 §A 独立 CRC-32', () => {
  it('已知向量：空串 = 0，RFC 参考串 "123456789" = 0xCBF43926', () => {
    expect(crc32(new Uint8Array(0))).toBe(0x00000000);
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('与 node:zlib 的 CRC-32（第三方实现）在随机字节上一致', () => {
    // 用确定性伪随机（不读时钟），覆盖多字节 / 非 4 对齐长度。
    let state = 0x12345678;
    const next = (): number => {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0;
      return state;
    };
    for (let round = 0; round < 50; round += 1) {
      const length = 1 + (next() % 300);
      const bytes = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        bytes[index] = next() & 0xff;
      }
      expect(crc32(bytes)).toBe(zlibCrc32(bytes));
    }
  });

  it('翻转一个字节 CRC 必变（判据不是常数）', () => {
    const base = new TextEncoder().encode('the quick brown fox');
    const mutated = base.slice();
    mutated[0] = (mutated[0] ?? 0) ^ 0x01;
    expect(crc32(mutated)).not.toBe(crc32(base));
  });
});

// ---------------------------------------------------------------------------
// §B 独立 ZIP 中央目录解析
// ---------------------------------------------------------------------------

describe('W-R05 §B 独立 ZIP 解析', () => {
  it('正例包解析出 5 个条目、名称完全一致', () => {
    const zip = parseZip(goodDocx());
    expect(zip.entries.map((entry) => entry.name)).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'word/document.xml',
      'word/_rels/document.xml.rels',
      'word/styles.xml',
    ]);
  });

  it('每个条目的 CRC 都能被独立函数复核（entryCrcMatches）', () => {
    const zip = parseZip(goodDocx());
    expect(zip.entries.every((entry) => entryCrcMatches(entry))).toBe(true);
  });

  it('DEFLATE 条目：不注入解压器即显式拒绝，注入后可读且 CRC 复核通过', () => {
    const deflated = deflatedDocx(deflateRawSync);
    // 不注入 → 显式拒绝（不把"验不了"伪装成"通过"）。
    expect(() => parseZip(deflated)).toThrowError(/DEFLATE/);
    const zip = parseZip(deflated, { inflateRaw: inflateRawSync });
    expect(zip.entries).toHaveLength(5);
    expect(zip.entries.every((entry) => entryCrcMatches(entry))).toBe(true);
    const document = zip.entries.find((entry) => entry.name === 'word/document.xml');
    expect(new TextDecoder().decode(document?.content)).toContain('hello');
  });

  it('DEFLATE 包也能走完包级复核（正例零 issue）', () => {
    const result = verifyOoxmlPackage(deflatedDocx(deflateRawSync), {
      inflateRaw: inflateRawSync,
    });
    expect(result.ok).toBe(true);
    expect(result.parts).toBe(5);
    expect(result.crcChecked).toBe(5);
  });

  it('截断包在解析阶段即报结构错误（有界失败，不越界读）', () => {
    expect(() => parseZip(badTruncated())).toThrowError();
  });
});

// ---------------------------------------------------------------------------
// §C 包级完整性复核
// ---------------------------------------------------------------------------

describe('W-R05 §C 包级复核', () => {
  it('正例：零 issue，parts = crcChecked = 5', () => {
    const result = verifyOoxmlPackage(goodDocx());
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.parts).toBe(5);
    expect(result.crcChecked).toBe(5);
  });

  it('假阳对照：外部关系（TargetMode="External"）不得被判为悬空', () => {
    const result = verifyOoxmlPackage(goodDocxWithExternalRelationship());
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('反向：悬空关系被抓（dangling_relationship），且只报这一条', () => {
    const result = verifyOoxmlPackage(badDanglingRelationship());
    expect(result.ok).toBe(false);
    expect(kindsOf(result.issues)).toEqual(['dangling_relationship']);
    expect(result.issues[0]?.detail).toContain('missing-styles.xml');
  });

  it('反向：头部 CRC 不符被抓（crc_mismatch），且只报这一条', () => {
    const result = verifyOoxmlPackage(badCrcMismatch());
    expect(result.ok).toBe(false);
    expect(kindsOf(result.issues)).toEqual(['crc_mismatch']);
    expect(result.issues[0]?.detail).toContain('word/document.xml');
  });

  it('反向：数据被改坏、CRC 残留旧值也被抓（真实损坏形态）', () => {
    const result = verifyOoxmlPackage(badCorruptedData());
    expect(result.ok).toBe(false);
    expect(kindsOf(result.issues)).toEqual(['crc_mismatch']);
    expect(result.issues[0]?.detail).toContain('word/styles.xml');
  });

  it('反向：内容类型缺声明被抓（missing_content_type_declaration）', () => {
    const result = verifyOoxmlPackage(badMissingContentType());
    expect(result.ok).toBe(false);
    expect(kindsOf(result.issues)).toEqual(['missing_content_type_declaration']);
    expect(result.issues[0]?.detail).toBe('word/media/image1.png');
  });

  it('反向：悬空 Override 被抓（dangling_content_type_override）', () => {
    const result = verifyOoxmlPackage(badDanglingOverride());
    expect(result.ok).toBe(false);
    expect(kindsOf(result.issues)).toEqual(['dangling_content_type_override']);
    expect(result.issues[0]?.detail).toBe('word/ghost.xml');
  });

  it('反向：重复 Override 被抓（duplicate_content_type_override）', () => {
    const result = verifyOoxmlPackage(badDuplicateOverride());
    expect(result.ok).toBe(false);
    expect(kindsOf(result.issues)).toEqual(['duplicate_content_type_override']);
    expect(result.issues[0]?.detail).toBe('word/document.xml');
  });

  it('反向：整份缺 [Content_Types].xml 被抓', () => {
    const result = verifyOoxmlPackage(badMissingContentTypesPart());
    expect(result.ok).toBe(false);
    expect(issuesOfKind(result.issues, 'missing_content_types_part')).toHaveLength(1);
  });

  it('反向：截断包报 zip_error（容器级失败，不做部件判断）', () => {
    const result = verifyOoxmlPackage(badTruncated());
    expect(result.ok).toBe(false);
    expect(kindsOf(result.issues)).toEqual(['zip_error']);
    expect(result.parts).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §D 关系目标解析（独立单测，判据可追溯）
// ---------------------------------------------------------------------------

describe('W-R05 §D 关系目标解析', () => {
  it('相对目标 = 源部件目录 + 目标段', () => {
    expect(resolveRelationshipTarget('word', 'styles.xml')).toBe('word/styles.xml');
    expect(resolveRelationshipTarget('', 'word/document.xml')).toBe('word/document.xml');
  });

  it('`..` 回退与绝对路径 `/` 从包根解析', () => {
    expect(resolveRelationshipTarget('word', '../media/image1.png')).toBe('media/image1.png');
    expect(resolveRelationshipTarget('word', '/docProps/core.xml')).toBe('docProps/core.xml');
  });

  it('剥掉 `#fragment` 与百分号转义', () => {
    expect(resolveRelationshipTarget('word', 'styles.xml#top')).toBe('word/styles.xml');
    expect(resolveRelationshipTarget('word', 'my%20style.xml')).toBe('word/my style.xml');
  });
});

// ---------------------------------------------------------------------------
// §E XML 标记扫描器
// ---------------------------------------------------------------------------

describe('W-R05 §E XML 标记扫描器', () => {
  it('属性顺序无关、自闭合可识别、实体被还原', () => {
    const tags = scanStartTags(
      '<a:Root><x Target="a&amp;b" Mode="E"/><y Mode="I" Target="c"></y><!-- <fake/> --></a:Root>',
    );
    expect(tags.map((tag) => tag.localName)).toEqual(['Root', 'x', 'y']);
    const x = tags[1];
    expect(x?.attributes.get('Target')).toBe('a&b');
    expect(x?.attributes.get('Mode')).toBe('E');
    expect(x?.selfClosing).toBe(true);
    expect(tags[2]?.selfClosing).toBe(false);
  });

  it('注释与 PI 里的假标记不被采信', () => {
    const tags = scanStartTags('<?pi Override PartName="/x"?><!-- <Override PartName="/y"/> -->');
    expect(tags).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §F 部件级差异
// ---------------------------------------------------------------------------

describe('W-R05 §F 部件级差异', () => {
  it('新增部件：只进 added，其它为空', () => {
    const diff = diffOoxmlPackages(goodDocx(), docxWithExtraPart());
    expect(diff.added).toEqual(['word/footer1.xml']);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.unchanged).toHaveLength(5);
  });

  it('删除部件（方向反转）只进 removed', () => {
    const diff = diffOoxmlPackages(docxWithExtraPart(), goodDocx());
    expect(diff.removed).toEqual(['word/footer1.xml']);
    expect(diff.added).toEqual([]);
    expect(diff.changed).toEqual([]);
  });

  it('改一个词：document.xml 进 changed 且字节数如实，其余部件 unchanged', () => {
    const diff = diffOoxmlPackages(goodDocx(), goodDocxWithEditedBody());
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed.map((change) => change.name)).toEqual(['word/document.xml']);
    const [change] = diff.changed;
    expect(change?.beforeBytes).toBeGreaterThan(0);
    expect(change?.afterBytes).toBe(change?.beforeBytes); // hello→HELLO 等长，只换字节
    expect(diff.unchanged).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'word/_rels/document.xml.rels',
      'word/styles.xml',
    ]);
  });

  it('同一份包自比：全 unchanged，三张差异表都空', () => {
    const diff = diffOoxmlPackages(goodDocx(), goodDocx());
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.unchanged).toHaveLength(5);
  });

  it('反向对照：把"改动"还原，changed 必须清空（判据不是恒报）', () => {
    const before = goodDocx();
    const after = goodDocxWithEditedBody();
    expect(diffOoxmlPackages(before, after).changed).toHaveLength(1);
    // 再与自身比：同一判据必须给空——证明它真的在比字节，而非恒报变化。
    expect(diffOoxmlPackages(before, before).changed).toEqual([]);
  });
});
