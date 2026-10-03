/**
 * **W01 — DOCX 导入的 fail-closed 拒绝**（`tests/mobile-office/word/W01/`）。
 *
 * 本文件是 W01 包对验收条件「**拒绝损坏/恶意压缩包**」与「未知节点不静默丢」的**独立**取证，
 * 不重复 `src/documents/docx/roundtrip.test.ts` 已有的那几例（条目数 / 重复条目 / 路径穿越 /
 * CRC / 悬空 rId / officeDocument 指错 / 缺 `[Content_Types].xml`）。
 *
 * ## 与既有覆盖的分界（如实）
 *
 * | 威胁 | 谁在挡 | 本文件的作用 |
 * |---|---|---|
 * | 压缩炸弹（压缩比 / 单条目 / 全包 / 条目数四条上限） | `artifacts/ooxml/zip-read.ts`（`zip-read.test.ts` 已逐条覆盖） | 从 `importDocx` **端到端**再验一次：真实 deflate 炸弹在**导入入口**被拒，调用方拿到的是有界 `ZipReadError`，不是 OOM |
 * | 路径穿越（`..` / 绝对路径 / 盘符 / 反斜杠） | 同上（`assertZipReadEntryPath`） | 端到端 + **反向对照**（把 `..` 换成合法段 ⇒ 同一流程导入成功） |
 * | 截断 / 非法 ZIP、缺关键部件 | 同上 + `import.ts` | 端到端各有界错误码 |
 * | **深层嵌套炸弹** | **本轮新增**（`import.ts` 的深度预扫描） | 改前是 `RangeError: Maximum call stack size exceeded`；改后 `DocxError('xml_too_deep')` |
 * | **畸形部件 XML**（billion laughs / 未闭合 / 未识别实体 / 空部件） | **本轮新增**（`import.ts` 的 `parsePartBytes`） | 改前是 `XmlParseError`（**未**从公开出口导出，调用方无从分类）；改后 `DocxError('malformed_part_xml')` |
 * | 未知部件 / 未知节点 | 既有能力（`opaque_parts` / `opaque` 锚点） | 本文件只做**可核验记录**，不改实现 |
 *
 * ## 反向对照（防"守卫是空壳"）
 *
 * 每一组拒绝都配一条**正例**：把恶意输入换成**同一构造流程**产出的良性等价物后必须导入成功。
 * 若哪天守卫退化成"见谁都拒"，这些正例会立刻变红；若守卫被拆成空壳，拒绝用例也会变红。
 * 另有专门两例钉住"深度判据不是见到深就拒"（500 层通过 / 600 层被拒）。
 *
 * ## 构造方式
 *
 * ZIP 由本文件的**最小构造器**拼装（STORE / DEFLATE 可选，字段可控）；DEFLATE 只为造
 * **真实**压缩炸弹（STORE 的压缩比恒为 1，造不出炸弹）。这里用 `node:zlib` 与仓库既有
 * `src/artifacts/ooxml/zip-read.test.ts` 同一先例——**测试侧**才用，产品路径不碰
 * （`src/**` 的 `node:*` 白名单由 `w-disc-kernel-discipline.test.ts` 机器化断言）。
 * 本文件不读磁盘、不联网、不依赖桌面 Node 文件系统能力。
 */

import { deflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { crc32 } from '../../../../src/artifacts/ooxml/crc32.js';
import { ZipReadError } from '../../../../src/artifacts/ooxml/zip-read.js';
import type { DocxErrorReason } from '../../../../src/documents/docx/docx-error.js';
import { DocxError } from '../../../../src/documents/docx/docx-error.js';
// `MAX_XML_ELEMENT_DEPTH` 目前只在 `import.ts` 导出（`index.ts` 的出口不在本包写权内），
// 故这里直接引模块本身：本文件要断言的是「深度上限这条判据的行为」，用**同一个常量**
// 才能让正例跟着上限走，而不是把 512 抄一份在测试里。
import { importDocx, MAX_XML_ELEMENT_DEPTH } from '../../../../src/documents/docx/import.js';
import { collectDocumentLevelRaws, layoutItems } from '../../../../src/documents/docx/layout.js';

// ---------------------------------------------------------------------------
// 常量与最小包骨架
// ---------------------------------------------------------------------------

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const OFFICE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const CT_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
  `<Types xmlns="${CT}">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Default Extension="png" ContentType="image/png"/>` +
  `<Override PartName="/word/document.xml" ` +
  `ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
  `</Types>`;

const ROOT_RELS_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
  `<Relationships xmlns="${RELS}">` +
  `<Relationship Id="rId1" Type="${OFFICE}/officeDocument" Target="word/document.xml"/>` +
  `</Relationships>`;

/** 主部件骨架：`body` 里塞 `inner`。 */
function documentXml(inner: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
    `<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${inner}</w:body></w:document>`
  );
}

/** 一个真正的最小正文（一个段落一个 run）。 */
const MINIMAL_BODY = '<w:p><w:r><w:t>你好</w:t></w:r></w:p>';

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

// ---------------------------------------------------------------------------
// 最小 ZIP 构造器（字段可控；只为造"坏包"）
// ---------------------------------------------------------------------------

interface ZipEntrySpec {
  readonly path: string;
  readonly data: Uint8Array;
  /** 0 = STORE（默认），8 = DEFLATE。 */
  readonly method?: number;
  /** 覆盖中央目录记录的 CRC（造"损坏包"）。 */
  readonly crcOverride?: number;
}

function buildZip(entries: readonly ZipEntrySpec[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  const offsets: number[] = [];
  let offset = 0;

  for (const entry of entries) {
    const method = entry.method ?? 0;
    const stored =
      method === 8 ? new Uint8Array(deflateRawSync(Buffer.from(entry.data))) : entry.data;
    const name = Buffer.from(entry.path, 'utf8');
    const crc = entry.crcOverride ?? crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 名字
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.byteLength, 18);
    local.writeUInt32LE(entry.data.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    offsets.push(offset);
    chunks.push(local, name, stored);
    offset += local.byteLength + name.byteLength + stored.byteLength;
  }

  const centralStart = offset;
  for (const [index, entry] of entries.entries()) {
    const method = entry.method ?? 0;
    const stored =
      method === 8 ? new Uint8Array(deflateRawSync(Buffer.from(entry.data))) : entry.data;
    const name = Buffer.from(entry.path, 'utf8');
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(entry.crcOverride ?? crc32(entry.data), 16);
    central.writeUInt32LE(stored.byteLength, 20);
    central.writeUInt32LE(entry.data.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE(offsets[index] as number, 42);
    centrals.push(central, name);
    offset += central.byteLength + name.byteLength;
  }
  const centralDirectory = Buffer.concat(centrals);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.byteLength, 12);
  eocd.writeUInt32LE(centralStart, 16);

  return new Uint8Array(Buffer.concat([...chunks, centralDirectory, eocd]));
}

/** 骨架 + 可替换的部件（默认给一份合法的最小包）。 */
function packageWith(overrides: {
  readonly contentTypes?: Uint8Array;
  readonly rootRels?: Uint8Array;
  readonly document?: Uint8Array;
  readonly extra?: readonly ZipEntrySpec[];
  readonly omitFields?: readonly ('contentTypes' | 'rootRels' | 'document')[];
}): Uint8Array {
  const omit = new Set(overrides.omitFields ?? []);
  const entries: ZipEntrySpec[] = [];
  if (!omit.has('contentTypes')) {
    entries.push({ path: '[Content_Types].xml', data: overrides.contentTypes ?? enc(CT_XML) });
  }
  if (!omit.has('rootRels')) {
    entries.push({ path: '_rels/.rels', data: overrides.rootRels ?? enc(ROOT_RELS_XML) });
  }
  if (!omit.has('document')) {
    entries.push({
      path: 'word/document.xml',
      data: overrides.document ?? enc(documentXml(MINIMAL_BODY)),
    });
  }
  entries.push(...(overrides.extra ?? []));
  return buildZip(entries);
}

/** 捕获导入失败，返回**有界的**错误对象（让断言能同时看类型与 reason）。 */
function captureError(bytes: Uint8Array): Error {
  try {
    importDocx(bytes);
  } catch (error) {
    return error as Error;
  }
  throw new Error('期望导入被拒绝，但它成功了（守卫可能是空壳）');
}

function expectDocxError(error: Error, reason: DocxErrorReason): void {
  expect(error).toBeInstanceOf(DocxError);
  expect((error as DocxError).reason).toBe(reason);
}

// ---------------------------------------------------------------------------
// A. 正例（反向对照：这些必须成功，否则"拒绝"分文不值）
// ---------------------------------------------------------------------------

describe('W01 正例 —— 良性输入必须导入成功（反向对照）', () => {
  it('最小 DOCX 导入成功，正文读得出文本', () => {
    const model = importDocx(packageWith({}));
    expect(model.blocks).toHaveLength(1);
    const paragraph = model.blocks[0];
    expect(paragraph?.kind).toBe('paragraph');
    expect(model.document_id.startsWith('docx-')).toBe(true);
  });

  it('未建模的顶层元素**不静默丢**：body 级片段留在块的 opaque 锚点里', () => {
    const unknown = '<w:customXml w:element="foo"><w:r><w:t>q</w:t></w:r></w:customXml>';
    const model = importDocx(packageWith({ document: enc(documentXml(MINIMAL_BODY + unknown)) }));
    const raws = collectDocumentLevelRaws(model.blocks);
    expect(raws).toHaveLength(1);
    expect(raws[0]?.xml).toContain('customXml');
    expect(raws[0]?.xml).toContain('foo');
    // 锚点在文档块序列里的位置也留住了（排在第 1 个块之前）。
    expect(raws[0]?.before).toBe(1);
  });

  it('未建模的 run 子元素**不静默丢**：留在 run 的 opaque（带字符偏移）里', () => {
    const withDrawing =
      '<w:p><w:r><w:t>前</w:t>' +
      `<w:drawing><a:blip xmlns:a="urn:potbot:test" r:embed="rIdX"/></w:drawing>` +
      `<w:t>后</w:t></w:r></w:p>`;
    const model = importDocx(
      packageWith({
        document: enc(documentXml(withDrawing)),
        // 造一条**主部件自己的**关系指向本地图片：`r:embed` 悬空会被包层拒，
        // 那属于另一条判据（R160），这条正例要验的是"未建模片段留得住"。
        extra: [
          {
            path: 'word/_rels/document.xml.rels',
            data: enc(
              `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
                `<Relationships xmlns="${RELS}">` +
                `<Relationship Id="rIdX" Type="${OFFICE}/image" Target="media/x.png"/>` +
                `</Relationships>`,
            ),
          },
          { path: 'word/media/x.png', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
        ],
      }),
    );
    const paragraph = model.blocks[0];
    if (paragraph?.kind !== 'paragraph') throw new Error('期望一个段落块');
    const run = paragraph.inlines.find((inline) => inline.kind === 'run');
    if (run === undefined) throw new Error('期望一个 run');
    const raws = layoutItems(run, 'raw_at_char');
    expect(raws).toHaveLength(1);
    expect(raws[0]?.xml).toContain('drawing');
    expect(raws[0]?.offset).toBe(1); // "前" 之后
    // 媒体部件也如实建模，且绑定到指它的那条关系。
    const media = model.media.find((part) => part.path === 'word/media/x.png');
    expect(media?.relationship_id).toBe('rIdX');
  });

  it('未被任何关系指到的未知部件**不丢**：逐字节留在 opaque_parts 里', () => {
    const payload = enc('<?xml version="1.0"?><x:weird xmlns:x="urn:potbot:weird"><x:a/></x:weird>');
    const model = importDocx(packageWith({ extra: [{ path: 'word/unmodelled-thing.xml', data: payload }] }));
    const kept = model.opaque_parts.find((part) => part.path === 'word/unmodelled-thing.xml');
    expect(kept).toBeDefined();
    expect(kept?.bytes).toEqual(payload);
  });

  it('DOCTYPE（含外部 SYSTEM 标识）被丢弃而不是外联：不联网也能导入', () => {
    // 若实现会去解析/抓取外部 DTD，这里就会挂（测试环境无网、也不该有网）。
    const withDoctype =
      `<?xml version="1.0"?>` +
      `<!DOCTYPE w:document SYSTEM "http://127.0.0.1:9/never-fetched.dtd">` +
      `<w:document xmlns:w="${W}"><w:body>${MINIMAL_BODY}</w:body></w:document>`;
    const model = importDocx(packageWith({ document: enc(withDoctype) }));
    expect(model.blocks).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// B. ZIP 层：恶意 / 损坏压缩包被拒（有界错误类型）
// ---------------------------------------------------------------------------

describe('W01 ZIP 层 —— 恶意 / 损坏包 fail-closed', () => {
  it('真实 deflate 压缩炸弹（1 MiB 零字节 ⇒ 压缩比 ≈1000）被拒，且是**有界** ZipReadError', () => {
    const bomb = new Uint8Array(1024 * 1024);
    const bytes = packageWith({
      extra: [{ path: 'word/bomb.bin', data: bomb, method: 8 }],
    });
    const error = captureError(bytes);
    expect(error).toBeInstanceOf(ZipReadError);
    expect((error as ZipReadError).reason).toBe('compression_ratio_exceeded');
    // 有界：不是栈溢出、不是 OOM 形状的 RangeError。
    expect(error).not.toBeInstanceOf(RangeError);
  });

  it('反向对照：同一构造流程里把炸弹换成**等长的 STORE 条目**（压缩比 1）⇒ 导入成功', () => {
    const benign = new Uint8Array(1024 * 1024);
    const model = importDocx(packageWith({ extra: [{ path: 'word/bomb.bin', data: benign }] }));
    expect(model.blocks).toHaveLength(1);
    // 该部件仍被保留（良性的未知部件不该被丢）。
    expect(model.opaque_parts.some((part) => part.path === 'word/bomb.bin')).toBe(true);
  });

  it('路径穿越条目名（`../escape.xml`）被拒', () => {
    const bytes = packageWith({ extra: [{ path: '../escape.xml', data: enc('<x/>') }] });
    const error = captureError(bytes);
    expect(error).toBeInstanceOf(ZipReadError);
    expect((error as ZipReadError).reason).toBe('invalid_path');
  });

  it('反向对照：把 `../` 换成合法路径段（`word/escape.xml`）⇒ 导入成功', () => {
    const model = importDocx(packageWith({ extra: [{ path: 'word/escape.xml', data: enc('<x/>') }] }));
    expect(model.blocks).toHaveLength(1);
  });

  it('绝对路径条目名（前导斜杠）被拒', () => {
    const error = captureError(packageWith({ extra: [{ path: '/word/abs.xml', data: enc('<x/>') }] }));
    expect(error).toBeInstanceOf(ZipReadError);
    expect((error as ZipReadError).reason).toBe('invalid_path');
  });

  it('截断的 ZIP 被拒（不是抛栈/挂起）', () => {
    const full = packageWith({});
    const error = captureError(full.subarray(0, 30));
    expect(error).toBeInstanceOf(ZipReadError);
    expect(error).not.toBeInstanceOf(RangeError);
  });

  it('归档体内被改坏（CRC 不符）被拒', () => {
    const error = captureError(packageWith({ extra: [{ path: 'word/broken.xml', data: enc('<x/>'), crcOverride: 1 }] }));
    expect(error).toBeInstanceOf(ZipReadError);
    expect((error as ZipReadError).reason).toBe('crc_mismatch');
  });

  it('缺 `[Content_Types].xml` 被拒（有界 DocxError）', () => {
    expectDocxError(captureError(packageWith({ omitFields: ['contentTypes'] })), 'missing_content_types');
  });

  it('缺 `word/document.xml`（主部件不在包里）被拒（有界 DocxError）', () => {
    const error = captureError(packageWith({ omitFields: ['document'] }));
    expect(error).toBeInstanceOf(DocxError);
    // 关系表指向它的那条关系先发现目标不存在 ⇒ relationship_target_missing；
    // 无论走哪条分支，都必须是**有界的 DocxError**而不是未处理异常。
    expect(['relationship_target_missing', 'main_part_missing']).toContain(
      (error as DocxError).reason,
    );
  });

  it('缺 `_rels/.rels` 被拒（有界 DocxError）', () => {
    expectDocxError(
      captureError(packageWith({ omitFields: ['rootRels'] })),
      'missing_root_relationships',
    );
  });
});

// ---------------------------------------------------------------------------
// C. XML 层：炸弹与畸形部件被拒（本轮新增的有界错误码）
// ---------------------------------------------------------------------------

describe('W01 XML 层 —— 炸弹 / 畸形部件 fail-closed（有界错误码）', () => {
  it('billion laughs（内部实体声明）被拒，不复现 OOM', () => {
    const bomb =
      `<?xml version="1.0"?><!DOCTYPE lolz [\n` +
      `<!ENTITY lol "lol">\n` +
      `<!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">\n` +
      `]><w:document xmlns:w="${W}"><w:body><w:p/></w:body></w:document>`;
    expectDocxError(captureError(packageWith({ document: enc(bomb) })), 'malformed_part_xml');
  });

  it('未识别的实体引用（不静默降级、不猜）被拒', () => {
    const withEntity = documentXml('<w:p><w:r><w:t>&potbotBomb;</w:t></w:r></w:p>');
    expectDocxError(captureError(packageWith({ document: enc(withEntity) })), 'malformed_part_xml');
  });

  it(`深层嵌套炸弹（${String(60000)} 层）被拒：改前是 RangeError 崩栈，改后是有界 xml_too_deep`, () => {
    const depth = 60000;
    const deep = documentXml(
      `<w:p>` + '<w:r>'.repeat(depth) + '</w:r>'.repeat(depth) + `</w:p>`,
    );
    const error = captureError(packageWith({ document: enc(deep) }));
    expectDocxError(error, 'xml_too_deep');
    expect(error).not.toBeInstanceOf(RangeError);
  });

  it(`反向对照：${String(MAX_XML_ELEMENT_DEPTH - 12)} 层（在上限内）⇒ 导入成功（判据不是"见深就拒"）`, () => {
    // body 下的元素深度 = 2（document + body）+ n；取 n 使其恰好落在上限之内。
    const depth = MAX_XML_ELEMENT_DEPTH - 12;
    const nested = documentXml(
      MINIMAL_BODY + '<w:box>' + '<w:inner>'.repeat(depth) + '</w:inner>'.repeat(depth) + '</w:box>',
    );
    const model = importDocx(packageWith({ document: enc(nested) }));
    expect(model.blocks).toHaveLength(1);
  });

  it('深层嵌套出现在**非主部件**（word/styles.xml）同样被有界拒绝（每处解析都过闸）', () => {
    const depth = 60000;
    const styles =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
      `<w:styles xmlns:w="${W}">` +
      '<w:style>' +
      '<w:x>'.repeat(depth) +
      '</w:x>'.repeat(depth) +
      '</w:style></w:styles>';
    const error = captureError(packageWith({ extra: [{ path: 'word/styles.xml', data: enc(styles) }] }));
    expectDocxError(error, 'xml_too_deep');
  });

  it('畸形的 `[Content_Types].xml` 也被归一成有界 DocxError（package-parts 调用点同样过闸）', () => {
    const error = captureError(
      packageWith({ contentTypes: enc('<?xml version="1.0"?><Types><broken') }),
    );
    expectDocxError(error, 'malformed_part_xml');
  });

  it('零字节主部件被拒（不是"读到空文档"）', () => {
    expectDocxError(captureError(packageWith({ document: new Uint8Array(0) })), 'malformed_part_xml');
  });

  it('属性值里的 `>`、注释里的 `<`、CDATA 里的尖括号**不**被误判成深层嵌套（不误杀）', () => {
    const tricky =
      '<w:p w:val="a>b">' +
      '<!-- <x><y><z><w> -->' +
      '<w:r><w:t><![CDATA[<a><b><c><d>]]></w:t></w:r>' +
      '</w:p>';
    const model = importDocx(packageWith({ document: enc(documentXml(tricky)) }));
    expect(model.blocks).toHaveLength(1);
  });
});
