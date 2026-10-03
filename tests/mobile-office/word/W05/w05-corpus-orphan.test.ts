/**
 * **W05 — 外部语料 corpus-a 的"文档化孤儿媒体"独立验证**（`tests/mobile-office/word/W05/`）。
 *
 * ## 这一份存在的原因（W05 首增量留的交接）
 *
 * W05 首增量（`w05-table-drawing-roundtrip.test.ts`）在语料标注里如实记下：
 * `tests/word-acceptance/fixtures/corpus-a-independent-deflate.docx`（**独立 Python 构造**，
 * 见同目录 `build-corpus.py`，**非**生产写出器产物）**自带一个孤儿媒体关系**——
 * `word/_rels/document.xml.rels` 写了 `rId11 → media/image1.png`，
 * 但 `word/document.xml` 正文里**没有任何 `r:embed` 引用它**。
 *
 * 后果：任何对**原始**语料跑 `checkPicturePairing(...)` 并断言 `=== []` 的测试都会**误报失败**。
 * 该事实只在 W05 首增量的文件头注释里被提到，**没有任何机器可判的独立测试把它钉住**。
 * 本文件就是那条钉桩，且**只读语料**——不修改 fixture、不写 `docs/`。
 *
 * ## 本文件断言什么（三条，全部可独立复算）
 *
 * | 组 | 断言 | 为什么不是多余的 |
 * |---|---|---|
 * | ① 原始语料 | `checkPicturePairing(corpus-a)` **不抛**，且**恰好** 1 条问题，恒为 `orphan_media`、`relationship_id='rId11'`、`part_path='word/media/image1.png'` | 把"1 条孤儿"从注释变成可判事实；同时钉死"不是 0 条、不是崩溃" |
 * | ① 源文件独立核对 | 直接读**原始 ZIP 字节**（`readZip`，非生产解析器）：rels 确有 `rId11→media/image1.png`，且 `word/document.xml` 里 `r:embed` 总数为 0 | 证明孤儿是**源文件本来就有**的，不是 `importDocx` 造的 |
 * | ② 活体反向对照 | 插入一张**真被引用**的图片后剥掉其 media + 关系 ⇒ `checkPicturePairing` 由"零悬空"翻成"有 `dangling_reference`" | 证明"无悬空"方向的口径**不是空断言**：真有悬空时守卫会亮 |
 * | ② 判别对照 | 对**孤儿本身**（rId11）做同样的剥离 ⇒ 问题数 **1 → 0**（孤儿消失），**不产生** `dangling_reference` | 反过来证明 rId11 **确实无人引用**——若它其实被引用，剥离会报悬空而不是清零 |
 *
 * ## 未验证（**不得当作已验证**）
 *
 * - 只证"模型态 + 过滤口径"；**渲染**（Word / 手机里长得对不对）**未验证**（本机无 Word 授权、真机未连接，R155/R156）。
 * - 未做真机 / 外部 Word 消费端重开；未做任何 `docs/**` 或语料文件的写入。
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readZip } from '../../../../src/artifacts/ooxml/zip-read.js';
import { importDocx } from '../../../../src/documents/docx/import.js';
import { fakeImageBytes } from '../../../../src/documents/operations/drawing/fixtures.js';
import type { DocumentModel, Length, MediaPart, RelationshipRecord } from '../../../../src/documents/model/types.js';
import {
  checkPicturePairing,
  insertPicture,
  type PicturePairingProblem,
} from '../../../../src/documents/image-workflow.js';

// 本文件在 `tests/mobile-office/word/W05/`，距仓库根四层。
const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const CORPUS_A = join(
  REPO_ROOT,
  'tests',
  'word-acceptance',
  'fixtures',
  'corpus-a-independent-deflate.docx',
);

/** 文档化的孤儿：源语料 rels 里的字段，逐字钉住。 */
const DOCUMENTED_ORPHAN = Object.freeze({
  relationship_id: 'rId11',
  part_path: 'word/media/image1.png',
});

const MM = (value: number): Length => ({ unit: 'mm', value });

/** 独立外部语料（Python 构造）导入成模型。 */
function corpusModel(): DocumentModel {
  const bytes = new Uint8Array(readFileSync(CORPUS_A));
  return importDocx(bytes);
}

/** 直接读**原始 ZIP 字节**取部件文本（`readZip`，不是写出器/解析器自己的实现）。 */
function rawPartText(path: string): string | null {
  const archive = readZip(new Uint8Array(readFileSync(CORPUS_A)));
  const entry = archive.by_path.get(path);
  return entry === undefined ? null : new TextDecoder().decode(entry.data);
}

/** 从 rels XML 抽 `Id → Target`（独立正则，不调生产解析器）。 */
function relTargets(relsXml: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of relsXml.matchAll(/<Relationship\b[^>]*\/>/g)) {
    const tag = match[0];
    const id = /Id="([^"]+)"/.exec(tag)?.[1];
    const target = /Target="([^"]+)"/.exec(tag)?.[1];
    if (id !== undefined && target !== undefined) {
      map.set(id, target);
    }
  }
  return map;
}

/** 正文里全部 `r:embed` 关系 id（独立正则）。 */
function embeddedIds(documentXml: string): string[] {
  return [...documentXml.matchAll(/r:embed="([^"]+)"/g)].map((match) => match[1] as string);
}

/** 把"真悬空"方向（引用 → 关系 → 部件断链）单独滤出来，算子集断言用。 */
function trulyDangling(problems: readonly PicturePairingProblem[]): readonly PicturePairingProblem[] {
  return problems.filter(
    (problem) => problem.kind === 'dangling_reference' || problem.kind === 'reference_without_media',
  );
}

/** 剥掉指定媒体部件与其关系（返回新模型，不改原对象）。 */
function stripMedia(
  model: DocumentModel,
  part: { readonly relationship_id: string; readonly part_path: string },
): DocumentModel {
  const media: readonly MediaPart[] = model.media.filter((m) => m.path !== part.part_path);
  const relationships: readonly RelationshipRecord[] = model.relationships.filter(
    (record) => record.id !== part.relationship_id,
  );
  return { ...model, media, relationships };
}

// ---------------------------------------------------------------------------
// ① 原始语料：恰好 1 条文档化的孤儿（不是 0、不是崩溃）
// ---------------------------------------------------------------------------

describe('W05 ① corpus-a 原始语料：checkPicturePairing 恰好报 1 条文档化的 orphan_media', () => {
  it('不抛异常，且恰好多报 1 条（== 文档化孤儿，不多不少）', () => {
    const model = corpusModel();

    let problems: readonly PicturePairingProblem[] = [];
    expect(() => {
      problems = checkPicturePairing(model);
    }).not.toThrow();

    // 恰好 1 条：不是 0（否则断言会假绿），也不是 >1（否则还有别的未登记问题）。
    expect(problems).toHaveLength(1);

    // 那一条逐字段等于文档化孤儿。
    expect(problems[0]).toMatchObject({
      kind: 'orphan_media',
      relationship_id: DOCUMENTED_ORPHAN.relationship_id,
      part_path: DOCUMENTED_ORPHAN.part_path,
    });

    // "真悬空"方向（引用 → 部件断链）必须为零——孤儿不等同悬空引用。
    expect(trulyDangling(problems)).toEqual([]);
  });

  it('导入模型里确有该媒体部件，且其 rId 不在任何正文引用集合里', () => {
    const model = corpusModel();
    const part = model.media.find((m) => m.path === DOCUMENTED_ORPHAN.part_path);
    expect(part).toBeDefined();
    expect(part?.relationship_id).toBe(DOCUMENTED_ORPHAN.relationship_id);

    // 关系表里 rId11 指向 media/image1.png（相对 word/ 解析后的部件路径）。
    const record = model.relationships.find((r) => r.id === DOCUMENTED_ORPHAN.relationship_id);
    expect(record).toBeDefined();
    expect(record?.target).toBe('media/image1.png');
  });

  it('源文件独立核对（直接读 ZIP 字节）：rels 确有 rId11→media/image1.png，正文 r:embed 总数为 0', () => {
    const relsXml = rawPartText('word/_rels/document.xml.rels');
    const mainXml = rawPartText('word/document.xml');
    expect(relsXml).not.toBeNull();
    expect(mainXml).not.toBeNull();

    // 孤儿关系确实写在源文件的 rels 里（不是解析器凭空造的）。
    const targets = relTargets(relsXml as string);
    expect(targets.get(DOCUMENTED_ORPHAN.relationship_id)).toBe('media/image1.png');

    // 正文里一个 r:embed 都没有 —— 所以 rId11 确实无人引用（孤儿的定义）。
    const embeds = embeddedIds(mainXml as string);
    expect(embeds).toEqual([]);
    expect(embeds).not.toContain(DOCUMENTED_ORPHAN.relationship_id);
  });
});

// ---------------------------------------------------------------------------
// ② 活体反向对照：剥离"真被引用"的 media+rel ⇒ dangling_reference 出现
// ---------------------------------------------------------------------------

describe('W05 ② 反向对照（活）：剥离真被引用的 media+rel ⇒ dangling_reference；剥离孤儿 ⇒ 清零', () => {
  /** 在语料里插一张真被引用的图片（`insertPicture` 会写正文 r:embed + 关系 + 媒体）。 */
  function withReferencedPicture(): {
    readonly baseline: DocumentModel;
    readonly inserted: ReturnType<typeof insertPicture>;
  } {
    const baseline = corpusModel();
    const firstParagraph = baseline.blocks.find((block) => block.kind === 'paragraph');
    if (firstParagraph === undefined) throw new Error('夹具：语料里没有段落');
    const inserted = insertPicture(baseline, {
      paragraph_id: firstParagraph.id,
      bytes: fakeImageBytes(),
      content_type: 'image/png',
      width: MM(40),
      height: MM(30),
    });
    return { baseline, inserted };
  }

  it('剥离前：无悬空引用（守卫此刻是"灭"的）；剥离后：出现 dangling_reference（守卫是活的）', () => {
    const { inserted } = withReferencedPicture();
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;

    // —— 剥离前：真悬空方向为空（此刻守卫应当"灭"）——
    const before = checkPicturePairing(inserted.model);
    expect(trulyDangling(before)).toEqual([]);

    // —— 剥掉这张真被引用的图片的 media + 关系 ——
    const stripped = stripMedia(inserted.model, {
      relationship_id: inserted.relationship_id,
      part_path: inserted.part_path,
    });
    const after = checkPicturePairing(stripped);

    // —— 剥离后：必须翻成有悬空引用，且指向被剥掉的 rId ——
    const dangling = trulyDangling(after);
    expect(dangling.length).toBeGreaterThanOrEqual(1);
    expect(dangling.map((problem) => problem.kind)).toContain('dangling_reference');
    expect(
      dangling.some(
        (problem) => problem.relationship_id === inserted.relationship_id,
      ),
    ).toBe(true);

    // 前后对比：真悬空从 0 条变成 >=1 条 —— 这个断言不是空的。
    expect(trulyDangling(before).length).toBe(0);
    expect(trulyDangling(after).length).toBeGreaterThan(trulyDangling(before).length);
  });

  it('判别对照：剥离**孤儿本身**（rId11）⇒ 问题数 1→0，且**不**产生 dangling_reference', () => {
    const model = corpusModel();
    expect(checkPicturePairing(model)).toHaveLength(1);

    const stripped = stripMedia(model, DOCUMENTED_ORPHAN);
    const after = checkPicturePairing(stripped);

    // 孤儿被移除后，一个配对问题都不剩 —— 证明 rId11 确实无人引用。
    expect(after).toEqual([]);
    // 若 rId11 其实被引用，剥掉它反而会报 dangling_reference；这里必须**没有**。
    expect(trulyDangling(after)).toEqual([]);
  });
});
