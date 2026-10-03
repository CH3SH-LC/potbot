/**
 * **G1 纵向闭环验收**（design-05；场景见 `docs/other/prep/G1-纵向闭环验收场景.md`）。
 *
 * ## 这一条测的是什么（以及刻意不测什么）
 *
 * 把四个并行包串成一条真实链路，逐环留痕：
 * `importDocx`（WCF-D02）→ `resolveRangeExpression`（WCF-D03）→ 字符格式（D03）+
 * 段落排版（D04）经 `applyEditPlan`（协调者的共享集成适配层，R133/R135）→ `exportDocx`（D02）。
 *
 * **输入语料是独立于本仓生成器的**（`tests/word-acceptance/fixtures/`，WCF-D10 用 Python 手工构造、
 * 真实 DEFLATE 压缩、含 `customXml` / `media` / `styles` 等"未建模但要保留"的部件）。
 * 用自产文件当输入会让"导入保真"变成自证——本测试刻意不这么做（R167 的精神）。
 *
 * **本文件不是"格式正确"的最终判据**：真正的独立读回在
 * `scripts/demo/verify-docx.py`（WCF-D10，不 import 生产实现）。本文件里的 XML 字符串断言
 * 只是"写出器确实写了这些属性"的**快速旁证**，产物落盘供 Python 验收器复核。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { digestBytes } from '../../../src/artifacts/digest.js';
import { readZip } from '../../../src/artifacts/ooxml/index.js';
import { exportDocx, importDocx } from '../../../src/documents/docx/index.js';
import { applyEditPlan } from '../../../src/documents/edit/plan.js';
import type { EditPlan } from '../../../src/documents/edit/plan.js';
import type { DocumentModel, ParagraphNode } from '../../../src/documents/model/index.js';
import { collectParagraphs } from '../../../src/documents/selection/structure.js';
import { resolveRangeExpression } from '../../../src/documents/selection/resolve.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const FIXTURE = join(
  REPO_ROOT,
  'tests',
  'word-acceptance',
  'fixtures',
  'corpus-a-independent-deflate.docx',
);
const EVIDENCE_DIR = join(
  REPO_ROOT,
  '.dev-evidence',
  'word-common-features',
  'WCF-20261002-A',
  'G1',
);

/** 语料里的两个目标段落（逐字取自 WCF-D10 的构造脚本，见 fixtures/PROVENANCE.md）。 */
const BODY_PARAGRAPH = '分散对齐固定行距段落。';
const MIXED_PARAGRAPH = '第一段正文，首行缩进两个字符。';

const MAIN_PART = 'word/document.xml';

function loadFixture(): Uint8Array {
  return new Uint8Array(readFileSync(FIXTURE));
}

/** 按可见文本定位段落（测试内部用；生产侧走 R111 的范围表达式）。 */
function paragraphWithText(model: DocumentModel, text: string): ParagraphNode {
  const hit = collectParagraphs(model.blocks).find((paragraph) =>
    paragraph.inlines
      .filter((inline) => inline.kind === 'run')
      .some((run) => (run as { text: string }).text.includes(text)),
  );
  if (hit === undefined) {
    throw new Error(`语料里找不到含 "${text}" 的段落——夹具可能被改动过`);
  }
  return hit;
}

/** 语料的两次导入必须给出同一批节点 id（R101 的往返稳定性在真实文件上的体现）。 */
function stableIdOf(model: DocumentModel, text: string): string {
  return paragraphWithText(model, text).id;
}

describe('G1 纵向闭环：真实导入 → 局部字符/段落格式 → 导出 → 未改部件字节保留', () => {
  it('环节 1：导入独立语料，段落 / 表格 / 未建模部件都在', () => {
    const model = importDocx(loadFixture());

    const paragraphs = collectParagraphs(model.blocks);
    expect(paragraphs.length).toBeGreaterThanOrEqual(3);

    const tables = model.blocks.filter((block) => block.kind === 'table');
    expect(tables).toHaveLength(1);

    // 未建模但要**原样保留**的部件（R105）：主题外的样式表、自定义 XML、媒体。
    const opaquePaths = model.opaque_parts.map((part) => part.path);
    expect(opaquePaths).toContain('word/styles.xml');
    expect(opaquePaths).toContain('customXml/item1.xml');
    expect(model.media.map((part) => part.path)).toContain('word/media/image1.png');

    // 两个目标段落确实在语料里（否则后面的步骤测的是别的东西）。
    expect(() => paragraphWithText(model, BODY_PARAGRAPH)).not.toThrow();
    expect(() => paragraphWithText(model, MIXED_PARAGRAPH)).not.toThrow();
  });

  it('环节 2/3/5：复合计划一次事务，字符格式与段落排版同时落地且 revision 只 +1', () => {
    const model = importDocx(loadFixture());

    const plan: EditPlan = {
      steps: [
        // 「字体字号」：给斜体那半段设 14pt（原为 12pt）。
        {
          range: `指定文本:斜体下划线补充。`,
          operation: {
            domain: 'character',
            operation: { kind: 'setValue', property: 'size', value: { kind: 'pt', value: 14 } },
          },
        },
        // 「加粗」：整段原先不是粗体。
        {
          range: `指定文本:${BODY_PARAGRAPH}`,
          operation: {
            domain: 'character',
            operation: { kind: 'setToggle', property: 'bold', value: true },
          },
        },
        // 用户点名的段落排版四项 + 一个对齐。
        {
          range: `指定文本:${BODY_PARAGRAPH}`,
          operation: { domain: 'paragraph', operation: { kind: 'setAlignment', alignment: 'center' } },
        },
        {
          range: `指定文本:${BODY_PARAGRAPH}`,
          operation: {
            domain: 'paragraph',
            operation: { kind: 'setLineSpacing', spacing: { kind: 'oneAndHalf' } },
          },
        },
        {
          range: `指定文本:${BODY_PARAGRAPH}`,
          operation: {
            domain: 'paragraph',
            operation: { kind: 'setSpacingAfter', spacing: { kind: 'pt', value: 6 } },
          },
        },
        {
          range: `指定文本:${BODY_PARAGRAPH}`,
          operation: {
            domain: 'paragraph',
            operation: { kind: 'setFirstLineIndent', amount: { unit: 'chars', value: 2 } },
          },
        },
      ],
    };

    const applied = applyEditPlan(model, plan);
    if (!applied.ok) {
      throw new Error(`计划被拒绝：${applied.code} / ${applied.message}`);
    }
    const { model: edited, steps, previous_revision } = applied.value;

    // R141/R138：一次复合指令 = 一次事务 = revision 只 +1（不是每步 +1）。
    expect(previous_revision).toBe(model.revision);
    expect(edited.revision).toBe(model.revision + 1);
    expect(steps).toHaveLength(plan.steps.length);
    expect(steps.every((step) => step.hitCount >= 1)).toBe(true);
    expect(steps.every((step) => step.changed)).toBe(true);

    // 段落属性确实落到了模型上。
    const editedBody = paragraphWithText(edited, BODY_PARAGRAPH);
    expect(editedBody.properties.alignment).toEqual({ state: 'set', value: 'center' });
    expect(editedBody.properties.lineSpacing).toEqual({
      state: 'set',
      value: { kind: 'oneAndHalf' },
    });
    expect(editedBody.properties.spacingAfter).toEqual({ state: 'set', value: { kind: 'pt', value: 6 } });
    expect(editedBody.properties.indent.firstLine).toEqual({
      state: 'set',
      value: { unit: 'chars', value: 2 },
    });

    // **R130**：2 字缩进不等于 2 cm——长度单位那条线没有被顺手写进去。
    const anyCmIndent = JSON.stringify(editedBody.properties.indent).includes('"unit":"cm"');
    expect(anyCmIndent).toBe(false);

    // 加粗落在被选中的 run 上，且是**显式 on**（不是删元素回落，R118）。
    const boldRuns = editedBody.inlines.filter(
      (inline) => inline.kind === 'run' && inline.properties.bold.state === 'on',
    );
    expect(boldRuns.length).toBeGreaterThanOrEqual(1);

    // 未受影响的段落一个属性都没被改（只改选区，R113）。
    const untouched = paragraphWithText(edited, MIXED_PARAGRAPH);
    const untouchedBefore = paragraphWithText(model, MIXED_PARAGRAPH);
    expect(untouched.properties).toEqual(untouchedBefore.properties);

    // **R101 在真实文件上的体现**：同一份语料两次导入给出同一节点 id。
    const again = importDocx(loadFixture());
    expect(stableIdOf(again, BODY_PARAGRAPH)).toBe(stableIdOf(model, BODY_PARAGRAPH));

    // 产物落盘，供独立 Python 验收器复核（本文件不 import 它，也不复算它的判据）。
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const out = exportDocx(edited);
    writeFileSync(join(EVIDENCE_DIR, 'g1-vertical.docx'), out);
    writeFileSync(
      join(EVIDENCE_DIR, 'g1-vertical.json'),
      JSON.stringify(
        {
          scenario: 'G1 纵向闭环',
          fixture: 'tests/word-acceptance/fixtures/corpus-a-independent-deflate.docx',
          // 输入身份的**当场复算**（不留 null 占位）：证据要能自证读的是哪一份输入。
          fixture_sha256: digestBytes(loadFixture()),
          output_sha256: digestBytes(out),
          previous_revision,
          revision: edited.revision,
          steps,
          note: 'DEV-UNFROZEN；产物由 tests/acceptance/word/g1-vertical.test.ts 生成',
        },
        null,
        2,
      ),
    );
  });

  it('环节 4：只改一段 ⇒ 其余部件解压后逐字节不变（R151）', () => {
    const original = loadFixture();
    const model = importDocx(original);

    const applied = applyEditPlan(model, {
      steps: [
        {
          range: `指定文本:${BODY_PARAGRAPH}`,
          operation: { domain: 'paragraph', operation: { kind: 'setAlignment', alignment: 'right' } },
        },
      ],
    });
    if (!applied.ok) throw new Error(`计划被拒绝：${applied.message}`);

    const out = exportDocx(applied.value.model);
    const before = readZip(original);
    const after = readZip(out);

    const editedPaths: string[] = [];
    for (const entry of before.entries) {
      const other = after.by_path.get(entry.path);
      expect(other, `导出后缺少部件 ${entry.path}`).toBeDefined();
      const same =
        other !== undefined &&
        Buffer.from(other.data).equals(Buffer.from(entry.data));
      if (!same) editedPaths.push(entry.path);
    }

    // 允许变的**只有**主部件本身；样式/媒体/自定义 XML/内容类型/关系全部原样。
    expect(editedPaths).toEqual([MAIN_PART]);

    // 旁证：写出器确实把右对齐写进了 XML（真正的判据在 Python 验收器）。
    const documentXml = Buffer.from(after.by_path.get(MAIN_PART)!.data).toString('utf8');
    expect(documentXml).toMatch(/w:jc[^>]*w:val="right"/);
  });

  it('环节 7：非法范围 ⇒ 结构化拒绝，且文档一个字节都没动（R136/R140）', () => {
    const model = importDocx(loadFixture());
    const before = paragraphWithText(model, BODY_PARAGRAPH);
    const beforeProps = before.properties;

    const rejected = applyEditPlan(model, {
      steps: [
        {
          range: `指定文本:${BODY_PARAGRAPH}`,
          operation: { domain: 'paragraph', operation: { kind: 'setAlignment', alignment: 'center' } },
        },
        // 第二步必然失败：语料只有 7 段。
        {
          range: '第99段',
          operation: { domain: 'paragraph', operation: { kind: 'setAlignment', alignment: 'left' } },
        },
      ],
    });

    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(['not_found', 'invalid_range', 'empty_range']).toContain(rejected.code);
    // 失败结果**不带模型**（R136 在类型上禁止半成品）。
    expect(Object.hasOwn(rejected, 'value')).toBe(false);

    // 原子性：原模型的段落属性**引用都没变**（不是"值相等"）。
    expect(paragraphWithText(model, BODY_PARAGRAPH).properties).toBe(beforeProps);
  });

  it('环节 6 的输入侧：导出字节可被重新导入，且格式仍在', () => {
    const model = importDocx(loadFixture());
    const applied = applyEditPlan(model, {
      steps: [
        {
          range: `指定文本:${BODY_PARAGRAPH}`,
          operation: {
            domain: 'paragraph',
            operation: { kind: 'setLineSpacing', spacing: { kind: 'double' } },
          },
        },
      ],
    });
    if (!applied.ok) throw new Error(applied.message);

    const out = exportDocx(applied.value.model);
    const reimported = importDocx(out);
    const paragraph = paragraphWithText(reimported, BODY_PARAGRAPH);

    expect(paragraph.properties.lineSpacing).toEqual({ state: 'set', value: { kind: 'double' } });

    // 往返后范围表达式仍能命中（范围解析不依赖"重新编号出来的位置"）。
    const resolved = resolveRangeExpression(reimported, `指定文本:${BODY_PARAGRAPH}`);
    expect(resolved.status).toBe('ok');
  });
});
