/**
 * X-I04 验收：`assembleWorkbookPackage` 合并**两份外部包**时的
 * ① 关系 id 重编号（确定性、不冲突、引用被改写）
 * ② 部件重编号后**关系跟着走**（被改名的部件保留自己的 `.rels`）
 * ③ 未知部件**逐字节**保留
 *
 * 这不是"函数没抛错"的用例：所有判据都从整合结果的**真实 ZIP 字节**里读出来。
 */

import { describe, expect, it } from 'vitest';

import { readZip, type ReadZipArchive } from '../../../../src/artifacts/ooxml/zip-read.js';
import { utf8Bytes } from '../../../../src/artifacts/ooxml/xml.js';
import {
  childElements,
  parseXmlBytes,
} from '../../../../src/documents/docx/xml-parse.js';
import { openWorkbookDocument } from '../../../../src/spreadsheets/xls-io.js';
import { assembleWorkbookPackage } from '../../../../src/spreadsheets/package-assembly.js';
import { MARKERS_A, MARKERS_B, externalPackage } from './fixtures.js';

const PACKAGE_A = externalPackage(MARKERS_A);
const PACKAGE_B = externalPackage(MARKERS_B);
const MODEL = openWorkbookDocument('a.xlsx', PACKAGE_A).workbook;

function merge(sources: readonly { readonly label: string; readonly bytes: Uint8Array }[]) {
  return assembleWorkbookPackage(MODEL, { packages: sources });
}

const MERGED = merge([
  { label: 'ext-a', bytes: PACKAGE_A },
  { label: 'ext-b', bytes: PACKAGE_B },
]);
const ARCHIVE = readZip(MERGED.bytes);
const PATHS = ARCHIVE.entries.map((entry) => entry.path);

function entryBytes(archive: ReadZipArchive, path: string): Uint8Array {
  const entry = archive.by_path.get(path);
  if (entry === undefined) throw new Error(`包里没有 ${path}`);
  return entry.data;
}

function entryText(archive: ReadZipArchive, path: string): string {
  return Buffer.from(entryBytes(archive, path)).toString('utf8');
}

function relationshipElements(archive: ReadZipArchive, relsPath: string) {
  return childElements(parseXmlBytes(entryBytes(archive, relsPath))).filter(
    (child) => child.localName === 'Relationship',
  );
}

function attr(element: ReturnType<typeof relationshipElements>[number], name: string): string {
  return element.attributes.find((item) => item.name === name)?.value ?? '';
}

/** 每条内部关系都指向包里真实存在的部件；同一个 `.rels` 里 rId 不重复。 */
function assertRelationshipsResolve(archive: ReadZipArchive): void {
  for (const entry of archive.entries) {
    if (!entry.path.endsWith('.rels')) continue;
    const seen = new Set<string>();
    for (const relationship of relationshipElements(archive, entry.path)) {
      const id = attr(relationship, 'Id');
      expect(seen.has(id), `${entry.path} 里 ${id} 重复`).toBe(false);
      seen.add(id);
      if (attr(relationship, 'TargetMode') === 'External') continue;
      const owner =
        entry.path === '_rels/.rels' ? null : entry.path.replace(/\/_rels\/([^/]+)\.rels$/, '/$1');
      const base = owner === null ? '' : owner.slice(0, owner.lastIndexOf('/') + 1);
      const stack: string[] = [];
      for (const segment of `${base}${attr(relationship, 'Target')}`.split('/')) {
        if (segment === '' || segment === '.') continue;
        if (segment === '..') stack.pop();
        else stack.push(segment);
      }
      expect(archive.by_path.has(stack.join('/')), `${entry.path} → ${attr(relationship, 'Target')}`).toBe(true);
    }
  }
}

/** 每个业务部件恰好一条 `Override`。 */
function assertContentTypesComplete(archive: ReadZipArchive): void {
  const counts = new Map<string, number>();
  for (const child of childElements(parseXmlBytes(utf8Bytes(entryText(archive, '[Content_Types].xml'))))) {
    if (child.localName !== 'Override') continue;
    const partName = child.attributes.find((item) => item.name === 'PartName')?.value ?? '';
    const path = partName.replace(/^\/+/, '');
    counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  for (const entry of archive.entries) {
    if (entry.path === '[Content_Types].xml' || entry.path.endsWith('.rels')) continue;
    expect(counts.get(entry.path), `${entry.path} 的 Override 数`).toBe(1);
  }
}

function businessPaths(archive: ReadZipArchive): readonly string[] {
  return archive.entries
    .map((entry) => entry.path)
    .filter((path) => path !== '[Content_Types].xml' && !path.endsWith('.rels'));
}

describe('X-I04 ①：合并两份外部包的关系 id 重编号', () => {
  it('确定性：同一输入两次合并 ⇒ 逐字节相同', () => {
    const again = merge([
      { label: 'ext-a', bytes: PACKAGE_A },
      { label: 'ext-b', bytes: PACKAGE_B },
    ]);
    expect(again.bytes.equals(MERGED.bytes)).toBe(true);
    expect(again.content_digest).toBe(MERGED.content_digest);
  });

  it('不冲突：每个 .rels 内 rId 唯一，且每条内部关系目标都在包里', () => {
    assertRelationshipsResolve(ARCHIVE);
    assertContentTypesComplete(ARCHIVE);
  });

  it('两份包各自的 sharedStrings 关系被重编号成不同目标（rId3 / rId4），而不是相互覆盖', () => {
    const rels = relationshipElements(ARCHIVE, 'xl/_rels/workbook.xml.rels');
    const shared = rels
      .filter((relationship) => attr(relationship, 'Type').endsWith('/sharedStrings'))
      .map((relationship) => ({ id: attr(relationship, 'Id'), target: attr(relationship, 'Target') }));
    // 第二条被部件重编号到 sharedStrings.xml2（分配器在原路径后追加递增编号）
    const targets = shared.map((entry) => entry.target).sort();
    expect(new Set([...shared.map((entry) => entry.id)]).size).toBe(2);
    expect(targets.some((target) => target.includes('sharedStrings.xml'))).toBe(true);
    expect(shared.some((entry) => entry.target === 'sharedStrings.xml2')).toBe(true);
  });
});

describe('X-I04 ②：被改名的部件，其关系跟着它走（不是挂到同名部件上）', () => {
  it('第二份 chart1.xml 被重编号为 chart2.xml，且它自己有独立的 chart2.xml.rels', () => {
    const charts = PATHS.filter((path) => /^xl\/charts\/chart\d+\.xml$/.test(path));
    expect(charts).toEqual(['xl/charts/chart1.xml', 'xl/charts/chart2.xml']);

    // 修复前：两份 chart 的关系都塞进 chart1.xml.rels，chart2.xml 没有任何 .rels。
    const chartRels = PATHS.filter((path) => /^xl\/charts\/_rels\/chart\d+\.xml\.rels$/.test(path)).sort();
    expect(chartRels).toEqual([
      'xl/charts/_rels/chart1.xml.rels',
      'xl/charts/_rels/chart2.xml.rels',
    ]);

    // 每份 chart 的 .rels 只声明**它自己**那条外部关系。
    for (const [path, marker] of [
      ['xl/charts/_rels/chart1.xml.rels', 'AAA'],
      ['xl/charts/_rels/chart2.xml.rels', 'BBB'],
    ] as const) {
      const rels = relationshipElements(ARCHIVE, path);
      expect(rels).toHaveLength(1);
      expect(attr(rels[0]!, 'Target')).toBe(`external-${marker}.xml`);
      expect(attr(rels[0]!, 'TargetMode')).toBe('External');
    }
  });

  it('绘图部件合并后两条 <c:chart> 各自指向真实存在的 chart 部件', () => {
    const drawing = entryText(ARCHIVE, 'xl/drawings/drawing1.xml');
    const chartRefs = [...drawing.matchAll(/<c:chart r:id="(rId\d+)"\/>/g)].map((match) => match[1]!);
    expect(chartRefs).toHaveLength(2);
    expect(new Set(chartRefs).size).toBe(2);

    // 绘图的两条关系分别指向 chart1.xml / chart2.xml，且 r:id 与上面引用一致。
    const rels = relationshipElements(ARCHIVE, 'xl/drawings/_rels/drawing1.xml.rels');
    const byId = new Map(rels.map((relationship) => [attr(relationship, 'Id'), attr(relationship, 'Target')]));
    const resolved = chartRefs.map((id) => byId.get(id)?.replace('../charts/', 'xl/charts/')).sort();
    expect(resolved).toEqual(['xl/charts/chart1.xml', 'xl/charts/chart2.xml']);
  });
});

describe('X-I04 ③：未知部件逐字节保留', () => {
  it('两份包的非 UTF-8 媒体部件都被重编号保留，且字节逐字节不变', () => {
    const media = businessPaths(ARCHIVE)
      .filter((path) => path.startsWith('xl/media/'))
      .sort();
    expect(media).toHaveLength(2);
    const payloads = media.map((path) => Buffer.from(entryBytes(ARCHIVE, path)).toString('hex')).sort();
    expect(payloads).toEqual([
      Buffer.from(MARKERS_A.mediaBytes).toString('hex'),
      Buffer.from(MARKERS_B.mediaBytes).toString('hex'),
    ].sort());
  });

  it('docProps/core.xml 与重编号后的第二份都逐字节保留', () => {
    expect(entryText(ARCHIVE, 'docProps/core.xml')).toContain('CORE-甲');
    const second = businessPaths(ARCHIVE).filter((path) => /^docProps\/core\.xml\d*$/.test(path));
    expect(second.length).toBe(2);
    const texts = second.map((path) => entryText(ARCHIVE, path));
    expect(texts.some((text) => text.includes('CORE-甲'))).toBe(true);
    expect(texts.some((text) => text.includes('CORE-乙'))).toBe(true);
  });

  it('合并未产生"引用了自己没声明的 rId"的告警（notes 为空）', () => {
    expect(MERGED.notes).toEqual([]);
  });
});
