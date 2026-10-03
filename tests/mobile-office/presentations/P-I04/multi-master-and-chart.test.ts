/**
 * P-I04 · 集成单元：`src/presentations/import.ts` 的多母版 / 多主题携带与图表 graphicFrame 建模。
 *
 * 判据（与 dispatch 的验收口径一致）：
 * 1. **no-op 往返逐字节**：喂入 P-R01 就绪的 `multi-master` 外部语料（2 母版 + 2 主题），
 *    `openPresentation` → `savePresentation` 不解包重建，**每个部件逐字节不变**，
 *    两套母版与两套主题都在；
 * 2. **口径一致**：`readPresentationImportStructure`（import.ts 的结构读取）与
 *    `openPresentationPackage`（import.ts 的容器读取）对同一多母版文件**计数一致**，
 *    且逐对给出母版 → 主题 → 版式（**不重编号、不丢弃**）。
 *
 * 语料来源：`tests/mobile-office/presentations/P-R01/corpus/corpus.ts` 的手工外部语料
 * （P-R01 已实测 `importPresentation`/`render.ts` 拒绝它，本单测落在 import.ts 的部件级原语与
 * 结构读取上，不消费 `roundtrip.ts`——那是另一位写者的写区）。
 */

import { describe, expect, it } from 'vitest';

import { buildCorpusBytes } from '../P-R01/corpus/corpus.js';
import { readZip } from '../../../../src/artifacts/ooxml/index.js';
import {
  openPresentation,
  openPresentationPackage,
  readPresentationImportStructure,
  savePresentation,
} from '../../../../src/presentations/import.js';

function bytesOf(archive: ReturnType<typeof readZip>, path: string): Uint8Array {
  const entry = archive.by_path.get(path);
  if (entry === undefined) {
    throw new Error(`包内没有部件 ${path}`);
  }
  return entry.data;
}

describe('P-I04：外部多母版 / 多主题语料（P-R01 multi-master）', () => {
  it('openPresentation 接受多母版并暴露全部母版 / 主题（不拒绝、不重编号）', () => {
    const opened = openPresentation(buildCorpusBytes('multi-master'));
    expect(opened.master_part_paths).toEqual([
      'ppt/slideMasters/slideMaster1.xml',
      'ppt/slideMasters/slideMaster2.xml',
    ]);
    expect(opened.theme_part_paths).toEqual(['ppt/theme/theme1.xml', 'ppt/theme/theme2.xml']);
    expect(opened.slide_part_paths).toEqual(['ppt/slides/slide1.xml', 'ppt/slides/slide2.xml']);
  });

  it('no-op 往返：两套母版与两套主题逐字节保留，零替换', () => {
    const bytes = buildCorpusBytes('multi-master');
    const opened = openPresentation(bytes);
    const saved = savePresentation(opened);

    expect(saved.replaced_part_count).toBe(0);
    expect(saved.preserved_part_count).toBe(opened.entries.length);

    const after = readZip(saved.bytes);
    // 全部件逐字节相等（含两套母版、两套主题、两份版式、两页、关系与内容类型）。
    for (const entry of opened.entries) {
      expect(Buffer.compare(bytesOf(after, entry.path), entry.data)).toBe(0);
    }
    // 再次明确点名：两套母版 + 两套主题都在且字节一致。
    for (const path of [
      'ppt/slideMasters/slideMaster1.xml',
      'ppt/slideMasters/slideMaster2.xml',
      'ppt/theme/theme1.xml',
      'ppt/theme/theme2.xml',
    ]) {
      expect(after.by_path.has(path)).toBe(true);
      const original = opened.by_path.get(path);
      if (original === undefined) {
        throw new Error(`源里应有 ${path}`);
      }
      expect(Buffer.compare(bytesOf(after, path), original.data)).toBe(0);
    }
  });

  it('结构读取与容器读取对同一多母版文件计数一致（2 母版 / 2 主题）', () => {
    const bytes = buildCorpusBytes('multi-master');
    const pkg = openPresentationPackage(bytes);
    const structure = readPresentationImportStructure(bytes);

    expect(pkg.master_part_paths).toHaveLength(2);
    expect(pkg.theme_part_paths).toHaveLength(2);
    expect(structure.master_part_paths).toHaveLength(2);
    expect(structure.theme_part_paths).toHaveLength(2);
    expect(structure.master_part_paths.length).toBe(pkg.master_part_paths.length);
    expect(structure.theme_part_paths.length).toBe(pkg.theme_part_paths.length);
  });

  it('逐对给出母版 → 主题 → 版式（母版1→主题1/版式1；母版2→主题2/版式3）', () => {
    const structure = readPresentationImportStructure(buildCorpusBytes('multi-master'));
    expect(structure.master_theme_pairs).toHaveLength(2);

    const [first, second] = structure.master_theme_pairs;
    expect(first?.master_part_path).toBe('ppt/slideMasters/slideMaster1.xml');
    expect(first?.theme_part_path).toBe('ppt/theme/theme1.xml');
    expect(first?.layout_part_paths).toEqual(['ppt/slideLayouts/slideLayout1.xml']);
    expect(second?.master_part_path).toBe('ppt/slideMasters/slideMaster2.xml');
    expect(second?.theme_part_path).toBe('ppt/theme/theme2.xml');
    expect(second?.layout_part_paths).toEqual(['ppt/slideLayouts/slideLayout3.xml']);

    // 每对都带真实字节摘要（语料的两套母版由同一构造器产出，故母版摘要可相同；主题不同）。
    expect(first?.master_part_digest).not.toBe('');
    expect(second?.master_part_digest).not.toBe('');
    expect(first?.theme_part_digest).not.toBeNull();
    expect(second?.theme_part_digest).not.toBeNull();
    expect(first?.theme_part_digest).not.toBe(second?.theme_part_digest);
  });

  it('单母版对照件（baseline-single-master）同样给出 1 对', () => {
    const structure = readPresentationImportStructure(buildCorpusBytes('baseline-single-master'));
    expect(structure.master_theme_pairs).toHaveLength(1);
    expect(structure.master_part_paths).toHaveLength(1);
    expect(structure.theme_part_paths).toHaveLength(1);
  });
});
