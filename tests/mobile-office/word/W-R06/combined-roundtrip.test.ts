/**
 * **W-R06 — 组合文档（引用 / 批注 / 公式 / 图片）往返，未改部件保持**的独立取证。
 *
 * ## 这个包补的缺口
 *
 * 仓里**没有任何一份语料四类齐备**（corpus-a 图片 / corpus-d 引用+批注+公式 / corpus-e 批注+图片），
 * 于是「四类共存、改一段，是否波及另一类」这条判据**无处可验**。本文件用手工构造的
 * **四类齐备**包（`test-support/combined-docx.ts`，DEFLATE，由本包自写的 ZIP 写出器产生）补上。
 *
 * ## 判据（每条都配一条可证伪的对照）
 *
 * | 判据 | 用例 |
 * |---|---|
 * | 组合包能被真实导入路径接受，四类要素都进模型/保留 | ① |
 * | 定点改写只改目标 run，**未见旧文本、见新文本** | ② |
 * | **未改部件逐字节不变**（主部件之外全部 `identical`） | ② |
 * | 主部件里四类要素的**锚点逐字保留**（`m:oMath` / `r:embed` / `w:commentRangeStart` / 书签 / `w:hyperlink`） | ② |
 * | **再导入**：批注数、媒体数、新文本都在，导出**幂等** | ③ |
 * | 操作 **fail-closed**：目标文字不存在 ⇒ 具名抛错，不产出字节 | ④ |
 * | **无悬空关系**：主部件里每个 `r:id` / `r:embed` 都在 `.rels` 里 | ⑤ |
 * | 独立读回器**自带 CRC 校验**：坏一个字节即被拒（证明比对不是空壳） | ⑤ |
 *
 * ## 独立读取器
 *
 * 部件的比对与读回走本包 `test-support/zip.ts`（自写 CRC / 自解析中央目录 / `node:zlib` DEFLATE），
 * **不**用被测实现的 `zip-read`。见该文件头部对独立性边界的如实说明。
 */

import { describe, expect, it } from 'vitest';

import { importDocx } from '../../../../src/documents/docx/import.js';
import { exportDocx } from '../../../../src/documents/docx/export.js';
import {
  applyCombinedEdit,
  reportPartText,
  roundtripCombined,
  unchangedParts,
} from './combined-roundtrip.js';
import {
  COMMENTED_TEXT,
  PART,
  TARGET_PARAGRAPH_TEXT,
  combinedDocx,
} from './test-support/combined-docx.js';
import { crc32, readZip } from './test-support/zip.js';

const NEW_TEXT = '正文段落甲，已被定点改写。';

/** 主部件里出现的所有 `r:id` / `r:embed` / `r:link` 取值。 */
function referencedRelIds(mainXml: string): readonly string[] {
  const out: string[] = [];
  const pattern = /\br:(?:id|embed|link)="([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(mainXml)) !== null) out.push(match[1]!);
  return out;
}

function relIdsInRels(relsXml: string): readonly string[] {
  const out: string[] = [];
  const pattern = /\bId="([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(relsXml)) !== null) out.push(match[1]!);
  return out;
}

// ---------------------------------------------------------------------------
// ① 夹具与导入
// ---------------------------------------------------------------------------

describe('① 组合 DOCX 夹具可被独立读取器与真实导入路径接受', () => {
  it('独立读取器能解析 13 个部件，且四类要素都在主部件里', () => {
    const archive = readZip(combinedDocx());
    expect(archive.entries.length).toBe(13);
    const main = new TextDecoder().decode(archive.by_path.get(PART.document)!.data);
    expect(main).toContain('<m:oMath>'); // 公式
    expect(main).toContain('r:embed="rId11"'); // 图片
    expect(main).toContain('<w:commentRangeStart w:id="1"/>'); // 批注
    expect(main).toContain('<w:bookmarkStart w:id="1" w:name="bm1"/>'); // 引用·书签
    expect(main).toContain('<w:hyperlink r:id="rId20"'); // 引用·超链接
  });

  it('真实导入路径接受该包：批注进模型、媒体进模型、不透明部件保留', () => {
    const model = importDocx(combinedDocx());
    expect(model.comments.length).toBe(1);
    expect(model.comments[0]!.text).toContain('这里需要补充来源');
    expect(model.media.length).toBe(1);
    const opaquePaths = model.opaque_parts.map((part) => part.path);
    for (const path of [PART.settings, PART.theme, PART.core, PART.customXml, PART.footnotes, PART.endnotes]) {
      expect(opaquePaths).toContain(path);
    }
  });
});

// ---------------------------------------------------------------------------
// ② 定点改写 + 未改部件不变
// ---------------------------------------------------------------------------

describe('② 定点改写后，主部件之外逐字节不变，四类锚点保留', () => {
  const report = roundtripCombined(combinedDocx(), {
    kind: 'replace_text',
    find: TARGET_PARAGRAPH_TEXT,
    replace: NEW_TEXT,
  });

  it('编辑落地：见新文本、不见旧文本', () => {
    expect(report.newTextPresent).toBe(true);
    expect(report.oldTextPresent).toBe(false);
  });

  it('主部件之外的每个部件都 identical（未改即原字节）', () => {
    expect(unchangedParts(report)).toEqual([]);
    // 反向对照：主部件**确实**变了（否则"未改部件不变"是真空成立）。
    expect(report.parts.find((part) => part.path === PART.document)!.status).toBe('changed');
  });

  it('被批注文字、公式、图片引用、书签、超链接的锚点逐字保留', () => {
    const main = reportPartText(report, PART.document)!;
    expect(main).toContain(COMMENTED_TEXT);
    expect(main).toContain('<m:oMath><m:f><m:num><m:r><m:t>1</m:t></m:r></m:num><m:den><m:r><m:t>2</m:t></m:r></m:den></m:f></m:oMath>');
    expect(main).toContain('r:embed="rId11"');
    expect(main).toContain('<w:commentRangeStart w:id="1"/>');
    expect(main).toContain('<w:commentRangeEnd w:id="1"/>');
    expect(main).toContain('<w:commentReference w:id="1"/>');
    expect(main).toContain('<w:bookmarkStart w:id="1" w:name="bm1"/>');
    expect(main).toContain('<w:hyperlink r:id="rId20"');
  });

  it('批注正文部件与媒体部件字节原样（含批注文字与 PNG 签名）', () => {
    expect(reportPartText(report, PART.comments)).toContain('这里需要补充来源');
    const media = report.exported.by_path.get(PART.media)!.data;
    expect([...media.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });
});

// ---------------------------------------------------------------------------
// ③ 再导入 + 幂等
// ---------------------------------------------------------------------------

describe('③ 导出物可再导入，且导出幂等', () => {
  const report = roundtripCombined(combinedDocx(), {
    kind: 'replace_text',
    find: TARGET_PARAGRAPH_TEXT,
    replace: NEW_TEXT,
  });

  it('再导入后：批注仍在、媒体仍在、新文本仍在', () => {
    const reopened = importDocx(report.exportedBytes);
    expect(reopened.comments.length).toBe(1);
    expect(reopened.media.length).toBe(1);
    const main = new TextDecoder().decode(
      report.exported.by_path.get(PART.document)!.data,
    );
    expect(main).toContain(NEW_TEXT);
  });

  it('导出幂等：再导出主部件与原导出逐字节相同', () => {
    const reopened = importDocx(report.exportedBytes);
    const again = readZip(exportDocx(reopened));
    const first = report.exported.by_path.get(PART.document)!.data;
    const second = again.by_path.get(PART.document)!.data;
    expect([...second]).toEqual([...first]);
  });
});

// ---------------------------------------------------------------------------
// ④ fail-closed
// ---------------------------------------------------------------------------

describe('④ 操作 fail-closed：目标不存在即抛错，不产出字节', () => {
  it('找不到目标文字 ⇒ applyCombinedEdit 抛错', () => {
    const model = importDocx(combinedDocx());
    expect(() =>
      applyCombinedEdit(model, { kind: 'replace_text', find: '这段话不存在', replace: 'x' }),
    ).toThrow(/找不到文字恰为/);
  });

  it('同一操作走 roundtripCombined 也抛错（不返回半成品报告）', () => {
    expect(() =>
      roundtripCombined(combinedDocx(), {
        kind: 'replace_text',
        find: '这段话不存在',
        replace: 'x',
      }),
    ).toThrow(/找不到文字恰为/);
  });
});

// ---------------------------------------------------------------------------
// ⑤ 包完整性：无悬空关系 + 独立读回器真的在验 CRC
// ---------------------------------------------------------------------------

describe('⑤ 包级完整性由独立读取器核对', () => {
  it('主部件里每个 r:id / r:embed 都能在主部件关系表里找到', () => {
    const report = roundtripCombined(combinedDocx(), {
      kind: 'replace_text',
      find: TARGET_PARAGRAPH_TEXT,
      replace: NEW_TEXT,
    });
    const main = reportPartText(report, PART.document)!;
    const rels = reportPartText(report, PART.documentRels)!;
    const declared = new Set(relIdsInRels(rels));
    for (const id of referencedRelIds(main)) {
      expect(declared.has(id)).toBe(true);
    }
    // 反向对照：至少引用到了图片与超链接两条（否则上面是空集真）。
    expect(referencedRelIds(main)).toContain('rId11');
    expect(referencedRelIds(main)).toContain('rId20');
  });

  it('独立读回器自带 CRC 校验：改动一个字节即被拒（证明比对不是空转）', () => {
    const bytes = combinedDocx();
    const corrupted = bytes.slice();
    // 定位媒体部件的**本地头**（第一次出现该路径名的位置即本地头），再翻其数据区首字节
    // （本地头之后紧跟数据，写出器无 extra 字段）——必然让该部件 CRC 失配。
    const name = new TextEncoder().encode(PART.media);
    const headerAt = Buffer.from(corrupted).indexOf(Buffer.from(name));
    expect(headerAt).toBeGreaterThan(0);
    const dataStart = headerAt + name.length;
    corrupted[dataStart] = corrupted[dataStart]! ^ 0xff;
    let threw = false;
    try {
      readZip(corrupted);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    // 同一实现的 CRC 与 `node:zlib` 一致（避免"自写 CRC 错得自洽"）。
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});

// ---------------------------------------------------------------------------
// ⑥ 更深的一片：改**带要素的段落本身**，要素锚点不得被抹掉
// ---------------------------------------------------------------------------

describe('⑥ 改写携带要素的段落本身，该要素的锚点仍逐字保留', () => {
  it('改「被批注段落」的 run 文字：批注区间/引用仍配对，comments.xml 不变', () => {
    const report = roundtripCombined(combinedDocx(), {
      kind: 'replace_text',
      find: COMMENTED_TEXT,
      replace: '被批注的文字（已改写）',
    });
    const main = reportPartText(report, PART.document)!;
    expect(main).toContain('被批注的文字（已改写）');
    expect(main).not.toContain(`<w:t>${COMMENTED_TEXT}</w:t>`);
    // 锚点三件套原样：起点 / 终点 / 引用。
    expect(main).toContain('<w:commentRangeStart w:id="1"/>');
    expect(main).toContain('<w:commentRangeEnd w:id="1"/>');
    expect(main).toContain('<w:commentReference w:id="1"/>');
    // 批注正文部件仍是原字节。
    expect(unchangedParts(report)).toEqual([]);
  });

  it('改「公式段落」的 run 文字：`m:oMath` 结构整体保留', () => {
    // 公式在码位空间里占**且仅占 1 个 U+FFFC**（见 model/types.ts 的宽度契约），
    // 因此该段落的 `paragraphText` 是「行内公式：」+ 一个对象替换字符，find 必须带上它。
    const report = roundtripCombined(combinedDocx(), {
      kind: 'replace_text',
      find: '行内公式：￼',
      replace: '公式释义：￼',
    });
    const main = reportPartText(report, PART.document)!;
    expect(main).toContain('公式释义：');
    expect(main).toContain('<m:oMath><m:f>');
    expect(unchangedParts(report)).toEqual([]);
  });

  it('改「图片段落」的相邻段落：`w:drawing` 与 `r:embed` 不受波及其后段落', () => {
    // ④ 段（可编辑）位于图片段之前；这里改成图片段**之后**的一段的邻段：
    // 用脚注段落里的 "正文带注：" 作为目标。
    const report = roundtripCombined(combinedDocx(), {
      kind: 'replace_text',
      find: '正文带注：',
      replace: '正文加注：',
    });
    const main = reportPartText(report, PART.document)!;
    expect(main).toContain('r:embed="rId11"');
    expect(main).toContain('<w:footnoteReference w:id="1"/>');
    expect(main).toContain('<w:endnoteReference w:id="1"/>');
    expect(unchangedParts(report)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ⑦ 判据自证：谓词/状态集合不是"见谁都过"的空壳
// ---------------------------------------------------------------------------

describe('⑦ 判据自证：谓词与状态集合可区分对错', () => {
  it('unchangedParts 会**挑出**主部件之外被改动的部件（不是恒返回空）', () => {
    const report = roundtripCombined(combinedDocx(), {
      kind: 'replace_text',
      find: TARGET_PARAGRAPH_TEXT,
      replace: NEW_TEXT,
    });
    // 合成一份"媒体部件被动过"的报告，谓词必须把它标出。
    const poisoned = {
      ...report,
      parts: report.parts.map((part) =>
        part.path === PART.media ? { ...part, status: 'changed' as const } : part,
      ),
    };
    const flagged = unchangedParts(poisoned);
    expect(flagged.map((part) => part.path)).toEqual([PART.media]);
  });

  it('状态集合闭包：只有 identical / changed（无 add/remove 的意外结构变化）', () => {
    const report = roundtripCombined(combinedDocx(), {
      kind: 'replace_text',
      find: TARGET_PARAGRAPH_TEXT,
      replace: NEW_TEXT,
    });
    expect(report.parts.length).toBe(13);
    expect(report.parts.every((part) => part.status === 'identical' || part.status === 'changed')).toBe(true);
    const changed = report.parts.filter((part) => part.status === 'changed').map((part) => part.path);
    expect(changed).toEqual([PART.document]);
  });

  it('未知操作被拒（联合外输入不静默通过）', () => {
    const model = importDocx(combinedDocx());
    expect(() =>
      applyCombinedEdit(model, { kind: 'delete_everything' } as unknown as Parameters<typeof applyCombinedEdit>[1]),
    ).toThrow(/未知操作/);
  });
});
