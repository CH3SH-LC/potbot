/**
 * WCF-D50：**真实产物生成**（供独立工具复核）。
 *
 * 用的是 `tests/word-acceptance/fixtures/corpus-a-independent-deflate.docx`——
 * 一份**独立构造的真实 DEFLATE 包**（有 `styles.xml`、`Heading1`、媒体、`customXml`、无 `numbering.xml`），
 * 不是本仓写入器的产物。于是"改样式后输出里真的变了"这句话有真实文件作证。
 *
 * 本文件**只负责把产物摆好**（只要 Node）。判据（XML 良构、部件真的变了）由
 * **独立工具**复核：`.task-manifest/outputs/WCF-D50/independent-verify.py` + 其输出日志。
 * 这里刻意**不**用生产实现自证——那正是 R166/R167 要挡的事。
 *
 * 产物：
 * - `wcf-d50-styles-changed.docx` —— 改 `Heading1` 的字号与对齐（`styles.xml` 必须变，其它部件不变）；
 * - `wcf-d50-numbering-created.docx` —— 原包**没有** `numbering.xml`，本批新建它并给段落挂 `w:numPr`。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readZip } from '../../artifacts/ooxml/zip-read.js';
import type { DocumentModel } from '../model/types.js';
import { applyBullet } from '../numbering/apply.js';
import { createList } from '../numbering/table.js';
import { EMPTY_NUMBERING_TABLE } from '../numbering/types.js';
import { modifyNamedStyle } from '../styles/named.js';
import { exportDocx } from './export.js';
import { importDocx } from './import.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const CORPUS_A = join(
  REPO_ROOT,
  'tests',
  'word-acceptance',
  'fixtures',
  'corpus-a-independent-deflate.docx',
);
const ARTIFACTS = join(REPO_ROOT, '.task-manifest', 'outputs', 'WCF-D50', 'artifacts');

const corpus = (): DocumentModel => importDocx(new Uint8Array(readFileSync(CORPUS_A)));

function emit(name: string, bytes: Uint8Array): Uint8Array {
  mkdirSync(ARTIFACTS, { recursive: true });
  writeFileSync(join(ARTIFACTS, name), bytes);
  return bytes;
}

describe('WCF-D50 产物生成（真实语料 → 改样式 / 新建编号 → 落盘）', () => {
  it('R151 实测：corpus-a 原样往返 ⇒ 每一个部件逐字节不变', () => {
    const before = readZip(new Uint8Array(readFileSync(CORPUS_A)));
    const after = readZip(exportDocx(corpus()));

    // 部件集合不变（没有凭空多一个、也没有少一个）。
    expect([...after.by_path.keys()].sort()).toEqual([...before.by_path.keys()].sort());
    // 逐部件逐字节。
    for (const [path, entry] of before.by_path) {
      expect(Array.from(after.by_path.get(path)?.data ?? []), `部件 ${path} 应逐字节不变`).toEqual(
        Array.from(entry.data),
      );
    }
  });

  it('改 Heading1 的字号与对齐 ⇒ 写出 wcf-d50-styles-changed.docx', () => {
    const model = corpus();
    const changed = modifyNamedStyle(model.styles, 'Heading1', {
      run_properties: {
        ...(model.styles.styles.find((style) => style.style_id === 'Heading1')?.run_properties ?? {}),
        size: { state: 'set', value: { kind: 'pt', value: 20 } },
      },
      paragraph_properties: {
        ...(model.styles.styles.find((style) => style.style_id === 'Heading1')?.paragraph_properties ?? {}),
        alignment: { state: 'set', value: 'left' },
      },
    });
    if (!changed.ok) throw new Error(`改样式失败：${changed.detail}`);

    const bytes = emit('wcf-d50-styles-changed.docx', exportDocx({ ...model, styles: changed.table }));
    const exported = readZip(bytes);

    // 产物层面的最小自检（细判据交给独立脚本）：styles.xml 确实换了、序号 40 半点 = 20pt。
    const styles = new TextDecoder().decode(exported.by_path.get('word/styles.xml')?.data as Uint8Array);
    expect(styles).toContain('<w:sz w:val="40"/>');
    expect(styles).toContain('<w:jc w:val="left"/>');
  });

  it('原包没有 numbering.xml ⇒ 新建部件并给段落挂 numPr，写出 wcf-d50-numbering-created.docx', () => {
    const model = corpus();
    const created = createList(EMPTY_NUMBERING_TABLE, { kind: 'bullet' });
    if (!created.ok) throw new Error('构造列表失败');

    const carried = model.blocks.map((block, index) => {
      if (index !== 1 || block.kind !== 'paragraph') return block;
      const applied = applyBullet(block, created.table, { num_id: created.num_id, level: 0 });
      if (!applied.ok) throw new Error(`应用项目符号失败：${applied.detail}`);
      return applied.paragraph;
    });

    const bytes = emit(
      'wcf-d50-numbering-created.docx',
      exportDocx({ ...model, blocks: carried }, { numbering: created.table }),
    );
    const exported = readZip(bytes);

    expect(exported.by_path.has('word/numbering.xml')).toBe(true);
    const body = new TextDecoder().decode(exported.by_path.get('word/document.xml')?.data as Uint8Array);
    expect(body).toContain('<w:numPr>');
  });
});
