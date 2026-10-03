/**
 * DOCX 模板构建器单测（design-02 **P6「文档」** 合同 / P1 / P3）。
 *
 * 覆盖五件事：
 * 1. **确定性**：golden 摘要向量（字节 sha256 写死）+ 同输入两次逐字节相等 + 改一个字节内容摘要就变；
 * 2. **不自行改写已确认数据**：正文里的人数 / 金额 / 日期原样出现，且正文里**每个数字串都能指认到快照**；
 *    并用两个负例证明该边界**真的会拒**（不是文字承诺）；
 * 3. **最小能力仍然成立**：空快照 / 只有一条事实 ⇒ 结构合法的文档，不崩、不臆造；
 * 4. **结构自检**：部件顺序与实测骨架一致、`[Content_Types].xml` 无 BOM、正文有 `w:sectPr`；
 * 5. **正文段落最小扩展（design-03 P3）**：不提供 `paragraphs` 时与 golden **逐字节相同**；
 *    提供时段落按序成段、替代 `description`；段数 / 空白段 / 控制字符 / 总字数各拒绝分支；
 *    以及**新段落同样受数字来源检查**（护栏不因扩展而放宽）。
 *
 * 本文件**不写盘**、不 import `node:fs`（`src/**` 零文件 IO）；字节自检靠解析 STORE 容器的本地文件头。
 * "Word 能不能打开"**不在这里断言**——那属第三层证据，由验收侧宿主实现（R53.1）。
 */

import { describe, expect, it } from 'vitest';

import { ValidationError, asFactRef } from '../../protocol/index.js';
import type { KnownFactSnapshotEntry } from '../ports.js';
import {
  DOCX_CUSTOM_PROPERTIES_PATH,
  DOCX_DOCUMENT_PART_PATH,
  DOCX_MAIN_CONTENT_TYPE,
  DOCX_MAX_BODY_CHARS,
  DOCX_MAX_BODY_PARAGRAPHS,
  DOCX_MIN_BODY_PARAGRAPHS,
  DOCX_PRESENTATION_PROPERTY,
  DOCX_TITLE_BODY_PRESENTATION,
  FACTS_SECTION_HEADING,
  OFFICE_DOCUMENT_RELATIONSHIP_TYPE,
  REFERENCES_SECTION_HEADING,
  buildDocxTemplate,
  digestBytes,
  renderDocxFactValue,
  snapshotDerivedStrings,
  untraceableDigitRuns,
  type DocxTemplateInput,
} from './docx.js';

// ---------------------------------------------------------------------------
// golden 常量（由本文件的一次真实运行产出后写死；R51.6）
// ---------------------------------------------------------------------------

/** 固定输入的容器字节长度。 */
const GOLDEN_BYTE_LENGTH = 1773;
/** 固定输入的容器字节 sha256（裸小写 hex）。 */
const GOLDEN_SHA256 = 'cf4254beb67ea789dc04d250cbdbd4c47c14325576626c9b5c849475e984d55d';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function fact(key: string, value: KnownFactSnapshotEntry['value']): KnownFactSnapshotEntry {
  return {
    fact_ref: asFactRef(`fact-${key}`),
    fact_key: key,
    value,
    source: { kind: 'user_confirmation', detail: '用户在前台确认' },
  };
}

/** 任务书 §18.2 演示场景的关键共享数据：人数 / 金额 / 日期（+ 一条文本事实）。 */
const SNAPSHOT: readonly KnownFactSnapshotEntry[] = Object.freeze([
  fact('headcount', { type: 'number', amount: 8, unit: '人', currency: null }),
  fact('budget.total', { type: 'number', amount: 600, unit: 'CNY', currency: 'CNY' }),
  fact('event.date', { type: 'date', iso_date: '2026-10-02', time_zone: 'Asia/Shanghai' }),
  fact('venue', { type: 'text', text: '图书馆三楼会议室', source: '场地确认单' }),
]);

/** 只有一条事实的快照。 */
const SINGLE: readonly KnownFactSnapshotEntry[] = Object.freeze([
  fact('headcount', { type: 'number', amount: 1, unit: '人', currency: null }),
]);

function input(overrides: Partial<DocxTemplateInput> = {}): DocxTemplateInput {
  return {
    requirement: { title: '季度总结会安排', description: '根据已确认事实整理，供组内传阅。' },
    fact_snapshot: SNAPSHOT,
    references: [{ label: '场地确认单', detail: '由行政组提供' }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 容器解析（只读 STORE 容器的本地文件头；不写盘、不依赖 node:fs）
// ---------------------------------------------------------------------------

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;

interface LocalEntry {
  readonly name: string;
  readonly data: Buffer;
}

/** 按本地文件头顺序取出条目（顺序 = 字节顺序，因此也顺带验了定序）。 */
function localEntries(bytes: Buffer): LocalEntry[] {
  const entries: LocalEntry[] = [];
  let offset = 0;
  while (offset + 30 <= bytes.length && bytes.readUInt32LE(offset) === LOCAL_FILE_HEADER_SIGNATURE) {
    const size = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.toString('utf8', offset + 30, offset + 30 + nameLength);
    const dataStart = offset + 30 + nameLength + extraLength;
    entries.push({ name, data: bytes.subarray(dataStart, dataStart + size) });
    offset = dataStart + size;
  }
  return entries;
}

function partText(bytes: Buffer, path: string): string {
  const entry = localEntries(bytes).find((candidate) => candidate.name === path);
  if (entry === undefined) {
    throw new Error(`容器里没有部件：${path}`);
  }
  return entry.data.toString('utf8');
}

/** 文档的**可见正文文本**（每个 `w:t` 一段，按段落顺序用 `\n` 连接）。 */
function visibleText(bytes: Buffer): string {
  const xml = partText(bytes, DOCX_DOCUMENT_PART_PATH);
  const matches = [...xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)];
  return matches.map((match) => match[1] ?? '').join('\n');
}

const DIGIT_RUNS = /[0-9]+/g;

// ---------------------------------------------------------------------------
// 1. 确定性
// ---------------------------------------------------------------------------

describe('确定性：同一输入 ⇒ 同一字节', () => {
  it('golden 摘要向量（字节 sha256 与长度写死）', () => {
    const result = buildDocxTemplate(input());
    expect(result.entry_count).toBe(3);
    expect(result.bytes.length).toBe(GOLDEN_BYTE_LENGTH);
    expect(digestBytes(result.bytes)).toBe(GOLDEN_SHA256);
    // content_digest 必须是**真实字节**的摘要（I-1：回读摘要与内容摘要同源）。
    expect(result.content_digest).toBe(GOLDEN_SHA256);
  });

  it('同输入连跑两次 ⇒ 字节逐字节相等、摘要相等', () => {
    const first = buildDocxTemplate(input());
    const second = buildDocxTemplate(input());
    expect(Buffer.compare(first.bytes, second.bytes)).toBe(0);
    expect(first.content_digest).toBe(second.content_digest);
    expect(second.bytes.length).toBe(GOLDEN_BYTE_LENGTH);
  });

  it('改一个事实的值 ⇒ 摘要必变（向量不是"恒等函数"）', () => {
    const changed = buildDocxTemplate(
      input({
        fact_snapshot: [
          fact('headcount', { type: 'number', amount: 9, unit: '人', currency: null }),
          ...SNAPSHOT.slice(1),
        ],
      }),
    );
    expect(changed.content_digest).not.toBe(GOLDEN_SHA256);
    expect(visibleText(changed.bytes)).toContain('headcount: 9 人');
  });
});

describe('Demo 展示策略：标题正文与内部来源分离', () => {
  const requirement = {
    title: '读书会邀请函',
    description: '旧说明不作为正文',
    paragraphs: ['欢迎和我们一起读书。', '请带来喜欢的作品，与大家分享。'],
    presentation: DOCX_TITLE_BODY_PRESENTATION,
  } as const;

  it('只渲染标题和全部正文；非空事实与引用不自动追加，属性标记可独立识别', () => {
    const result = buildDocxTemplate(input({ requirement }));
    expect(visibleText(result.bytes)).toBe([requirement.title, ...requirement.paragraphs].join('\n'));
    expect(result.entry_count).toBe(4);
    const properties = partText(result.bytes, DOCX_CUSTOM_PROPERTIES_PATH);
    expect(properties).toContain(`name="${DOCX_PRESENTATION_PROPERTY}"`);
    expect(properties).toContain(`<vt:lpwstr>${DOCX_TITLE_BODY_PRESENTATION}</vt:lpwstr>`);
    expect(partText(result.bytes, '_rels/.rels')).toContain(`Target="${DOCX_CUSTOM_PROPERTIES_PATH}"`);
    expect(partText(result.bytes, '[Content_Types].xml')).toContain(`PartName="/${DOCX_CUSTOM_PROPERTIES_PATH}"`);
    expect(visibleText(result.bytes)).not.toContain(DOCX_TITLE_BODY_PRESENTATION);
  });

  it('用户正文中的事实、引用与模型说明词句原样保留，不做关键词删字', () => {
    const paragraphs = [
      '已确认事实与资料引用是本文讨论的主题。',
      '请把 source.user_request 作为示例名称；模型声明也是正文的一部分。',
      '资料引用：作者提供的原文节选。',
    ];
    const result = buildDocxTemplate(input({ requirement: { ...requirement, paragraphs } }));
    expect(visibleText(result.bytes)).toBe([requirement.title, ...paragraphs].join('\n'));
  });

  it('默认、显式 undefined 和 provenance 模式均保留 generic 旧 golden 字节', () => {
    for (const presentation of [undefined, 'provenance'] as const) {
      const base = input();
      const result = buildDocxTemplate({
        ...base,
        requirement: { ...base.requirement, presentation },
      });
      expect(result.content_digest).toBe(GOLDEN_SHA256);
      expect(result.bytes.length).toBe(GOLDEN_BYTE_LENGTH);
      expect(localEntries(result.bytes).some((entry) => entry.name === DOCX_CUSTOM_PROPERTIES_PATH)).toBe(false);
    }
  });

  it.each(['title-body', '', null, false, {}, []])('未知展示选项 %j 明确拒绝，不静默回退', (presentation) => {
    expect(() => buildDocxTemplate(input({
      requirement: { ...requirement, presentation } as unknown as DocxTemplateInput['requirement'],
    }))).toThrow(/requirement\.presentation/);
  });

  it('正文数字仍须有来源，且隐藏引用中的无来源数字仍拒绝', () => {
    expect(() => buildDocxTemplate(input({
      requirement: { ...requirement, paragraphs: ['本次活动有 12 人。', '欢迎到场。'] },
    }))).toThrow(/快照里没有的数字：12/);
    expect(() => buildDocxTemplate(input({
      requirement,
      references: [{ label: '引用', detail: '凭空写入 12 人' }],
    }))).toThrow(/快照里没有的数字：12/);
    const supported = buildDocxTemplate(input({
      requirement: { ...requirement, paragraphs: ['本次活动有 8 人。', '欢迎到场。'] },
    }));
    expect(visibleText(supported.bytes)).toContain('本次活动有 8 人。');
  });

  it('关闭展示仍要求有效的快照和引用输入', () => {
    expect(() => buildDocxTemplate(input({
      requirement, fact_snapshot: null as unknown as DocxTemplateInput['fact_snapshot'],
    }))).toThrow(/fact_snapshot 必须是数组/);
    expect(() => buildDocxTemplate(input({
      requirement, references: [{ label: '', detail: '说明' }],
    }))).toThrow(/references\[0\]\.label 必须是非空字符串/);
  });
});

// ---------------------------------------------------------------------------
// 2. 不自行改写已确认数据（P6 的边界）
// ---------------------------------------------------------------------------

describe('不自行改写已确认数据：数字必须能指认到快照', () => {
  it('已确认的人数 / 金额 / 日期在正文里原样出现', () => {
    const text = visibleText(buildDocxTemplate(input()).bytes);
    expect(text).toContain('headcount: 8 人');
    expect(text).toContain('budget.total: 600 CNY');
    expect(text).toContain('event.date: 2026-10-02 (Asia/Shanghai)');
    expect(text).toContain('venue: 图书馆三楼会议室');
    expect(text).toContain(FACTS_SECTION_HEADING);
    expect(text).toContain(REFERENCES_SECTION_HEADING);
    expect(text).toContain('场地确认单: 由行政组提供');
  });

  it('值渲染只做格式化、不做算术（三种值种类各一条）', () => {
    expect(renderDocxFactValue({ type: 'number', amount: 8, unit: '人', currency: null })).toBe('8 人');
    // 单位与币种相同 ⇒ 只写一次；不同 ⇒ 两个都写。
    expect(renderDocxFactValue({ type: 'number', amount: 600, unit: 'CNY', currency: 'CNY' })).toBe('600 CNY');
    expect(renderDocxFactValue({ type: 'number', amount: 600, unit: '元', currency: 'CNY' })).toBe('600 元 CNY');
    expect(renderDocxFactValue({ type: 'number', amount: 600.5, unit: '元', currency: null })).toBe('600.5 元');
    expect(
      renderDocxFactValue({ type: 'date', iso_date: '2026-10-02', time_zone: 'Asia/Shanghai' }),
    ).toBe('2026-10-02 (Asia/Shanghai)');
    expect(renderDocxFactValue({ type: 'text', text: '图书馆三楼会议室', source: '场地确认单' })).toBe(
      '图书馆三楼会议室',
    );
  });

  it('正文里出现的**每一个**数字串都能指认到快照（两种判法都成立）', () => {
    const text = visibleText(buildDocxTemplate(input()).bytes);
    const runs = text.match(DIGIT_RUNS) ?? [];
    // 具体清单写死：正文数字只可能来自快照（8 / 600 / 日期 2026-10-02）。
    expect([...new Set(runs)].sort()).toEqual(['02', '10', '2026', '600', '8']);
    // 判法一（严格）：掩掉快照派生的原子字符串后，剩余文本里不得再有数字。
    expect(untraceableDigitRuns(text, SNAPSHOT)).toEqual([]);
    // 判法二（独立实现）：每个数字串都必须是某个快照派生字符串的子串。
    const derived = snapshotDerivedStrings(SNAPSHOT);
    for (const run of runs) {
      expect(derived.some((source) => source.includes(run))).toBe(true);
    }
  });

  it('负例 1：任务要求里写了快照里没有的数字 ⇒ 拒绝构建', () => {
    expect(() =>
      buildDocxTemplate(
        input({ requirement: { title: '确认 12 人参会', description: '请提前十分钟到场。' } }),
      ),
    ).toThrow(/快照里没有的数字：12/);
  });

  it('负例 2：日期里的 "10" 不能给正文单独的 "10" 背书（原子掩码）', () => {
    // SNAPSHOT 里 event.date = 2026-10-02 含子串 "10"，但没有任何事实的**值**是 10。
    expect(
      untraceableDigitRuns('共 10 人参加', SNAPSHOT).length,
    ).toBe(1);
    expect(() =>
      buildDocxTemplate(
        input({ requirement: { title: '共 10 人参加', description: '请提前十分钟到场。' } }),
      ),
    ).toThrow(ValidationError);
  });

  it('负例 3：日期只能原样引用（2026-11-01 ≠ 快照的 2026-10-02）⇒ 拒绝构建', () => {
    expect(() =>
      buildDocxTemplate(
        input({ requirement: { title: '时间调整', description: '拟改到 2026-11-01 举行。' } }),
      ),
    ).toThrow(/快照里没有的数字/);
  });

  it('负例 4：金额只能原样引用，不得缩写（600 写不成 60）', () => {
    expect(() =>
      buildDocxTemplate(
        input({ requirement: { title: '确认安排', description: '本次预算 60 元。' } }),
      ),
    ).toThrow(/快照里没有的数字：60/);
  });

  it('负例 5：构建器没有"直接传数字"的参数位（未知字段被拒，而不是被静默忽略）', () => {
    const withNumber = { ...input(), headcount: 10 } as unknown as DocxTemplateInput;
    expect(() => buildDocxTemplate(withNumber)).toThrow(/未知字段：headcount/);
  });

  it('缺任务要求 / 空标题 ⇒ 显式失败（不产出半成品）', () => {
    expect(() =>
      buildDocxTemplate({ ...input(), requirement: undefined } as unknown as DocxTemplateInput),
    ).toThrow(/requirement\.title/);
    expect(() =>
      buildDocxTemplate(input({ requirement: { title: '', description: '说明' } })),
    ).toThrow(/requirement\.title/);
    expect(() =>
      buildDocxTemplate(input({ references: [{ label: '', detail: '说明' }] })),
    ).toThrow(/references\[0\]\.label/);
  });
});

// ---------------------------------------------------------------------------
// 3. 最小能力：空快照 / 只有一条事实
// ---------------------------------------------------------------------------

describe('最小能力：空快照与单条事实都能产出结构合法的文档', () => {
  it('空快照 ⇒ 三部件容器、正文无任何数字、不臆造占位值', () => {
    const result = buildDocxTemplate(
      input({
        fact_snapshot: [],
        references: [],
        requirement: { title: '会议安排', description: '待补全信息后重出正式版。' },
      }),
    );
    expect(result.entry_count).toBe(3);
    expect(digestBytes(result.bytes)).toBe(result.content_digest);

    const text = visibleText(result.bytes);
    expect(text).toContain('会议安排');
    // 没有任何事实 ⇒ 连小节标题都不写（不写"0 人""（无）"这类凭空内容）。
    expect(text).not.toContain(FACTS_SECTION_HEADING);
    expect(text.match(DIGIT_RUNS)).toBeNull();
    expect(untraceableDigitRuns(text, [])).toEqual([]);
  });

  it('只有一条事实 ⇒ 该事实原样出现，其余结构仍然合法', () => {
    const result = buildDocxTemplate(
      input({
        fact_snapshot: SINGLE,
        references: [],
        requirement: { title: '安排尚未确定', description: '先记录已确认的部分。' },
      }),
    );
    expect(result.entry_count).toBe(3);
    const text = visibleText(result.bytes);
    expect(text).toContain('headcount: 1 人');
    expect(untraceableDigitRuns(text, SINGLE)).toEqual([]);
    expect(localEntries(result.bytes).map((entry) => entry.name)).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      DOCX_DOCUMENT_PART_PATH,
    ]);
  });
});

// ---------------------------------------------------------------------------
// 4. 结构自检
// ---------------------------------------------------------------------------

describe('结构自检：部件顺序 / 内容类型 / 关系 / sectPr / 无 BOM', () => {
  const bytes = buildDocxTemplate(input()).bytes;
  const entries = localEntries(bytes);

  it('部件顺序 = [Content_Types].xml → _rels/.rels → word/document.xml', () => {
    expect(entries.map((entry) => entry.name)).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      DOCX_DOCUMENT_PART_PATH,
    ]);
    expect(entries).toHaveLength(3);
  });

  it('[Content_Types].xml 覆盖 main+xml 且含 rels 默认项、无 BOM', () => {
    const contentTypes = partText(bytes, '[Content_Types].xml');
    expect(contentTypes).toContain(`PartName="/word/document.xml"`);
    expect(contentTypes).toContain(`ContentType="${DOCX_MAIN_CONTENT_TYPE}"`);
    expect(contentTypes).toContain('Extension="rels"');
    expect(contentTypes).not.toContain('﻿');
    // 部件数据的第一字节就是 '<'（0x3c），不是 UTF-8 BOM（0xef）。
    const first = entries[0];
    expect(first?.data[0]).toBe(0x3c);
  });

  it('包级关系指向 word/document.xml', () => {
    const rels = partText(bytes, '_rels/.rels');
    expect(rels).toContain(OFFICE_DOCUMENT_RELATIONSHIP_TYPE);
    expect(rels).toContain('Target="word/document.xml"');
  });

  it('正文根为 w:document，末尾是带 w:pgSz 的 w:sectPr', () => {
    const document = partText(bytes, DOCX_DOCUMENT_PART_PATH);
    expect(document).toContain('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">');
    expect(document).toContain('<w:sectPr>');
    expect(document).toContain('<w:pgSz w:w="11906" w:h="16838"/>');
    // 每个可见文本都包在 w:p / w:r / w:t 里。
    expect(document.match(/<w:p>/g)?.length).toBe(document.match(/<w:t>/g)?.length);
  });
});

// ---------------------------------------------------------------------------
// 5. 正文段落最小扩展（design-03 P3 / 合同 v1「DOCX 最小扩展」）
// ---------------------------------------------------------------------------

/** 三段正文（**不含任何数字**，因此不会与快照的"数字必须可指认"判据纠缠）。 */
const PARAGRAPHS: readonly string[] = Object.freeze([
  '亲爱的同学，欢迎参加本学期的新生读书会。',
  '我们会一起读一本书，聊一聊各自记住的句子。',
  '不需要提前准备，带着好奇心来就好。',
]);

describe('正文段落最小扩展：不提供 paragraphs 时逐字节不变', () => {
  it('不带 paragraphs ⇒ 与扩展前的 golden 摘要、字节长度完全一致', () => {
    const result = buildDocxTemplate(input());
    expect(result.bytes.length).toBe(GOLDEN_BYTE_LENGTH);
    expect(result.content_digest).toBe(GOLDEN_SHA256);
    // 正文仍只有"标题 + description"两段（旧形状），没有多出任何段落。
    expect(visibleText(result.bytes)).toBe(
      ['季度总结会安排', '根据已确认事实整理，供组内传阅。', FACTS_SECTION_HEADING].join('\n') +
        '\n' +
        [
          'headcount: 8 人',
          'budget.total: 600 CNY',
          'event.date: 2026-10-02 (Asia/Shanghai)',
          'venue: 图书馆三楼会议室',
          REFERENCES_SECTION_HEADING,
          '场地确认单: 由行政组提供',
        ].join('\n'),
    );
  });

  it('显式写 `paragraphs: undefined` 与整项省略**逐字节相同**（两条路径合一）', () => {
    const omitted = buildDocxTemplate(input());
    const explicit = buildDocxTemplate(
      input({ requirement: { title: '季度总结会安排', description: '根据已确认事实整理，供组内传阅。', paragraphs: undefined } }),
    );
    expect(Buffer.compare(omitted.bytes, explicit.bytes)).toBe(0);
    expect(explicit.content_digest).toBe(GOLDEN_SHA256);
  });

  it('旧路径不受新上限追溯：超长的单段 description 仍按旧行为产出（不因扩展而新拒绝）', () => {
    const longDescription = '旧路径的长说明。'.repeat(200);
    const result = buildDocxTemplate(
      input({ requirement: { title: '旧路径', description: longDescription } }),
    );
    expect(visibleText(result.bytes)).toContain(longDescription);
  });
});

describe('正文段落最小扩展：提供 paragraphs 时的结构与顺序', () => {
  it('每段一个 w:p、按输入顺序出现，且不再渲染 description', () => {
    const description = '这段说明不应该出现在使用 paragraphs 的产出里。';
    const result = buildDocxTemplate(
      input({
        requirement: { title: '新生读书会邀请函', description, paragraphs: PARAGRAPHS },
      }),
    );
    const text = visibleText(result.bytes);
    expect(text.startsWith('新生读书会邀请函\n')).toBe(true);
    // 顺序 = 输入顺序（可见文本里按序出现）。
    const positions = PARAGRAPHS.map((paragraph) => text.indexOf(paragraph));
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(positions.every((position) => position >= 0)).toBe(true);
    // 替代语义：description 不再出现在正文里。
    expect(text).not.toContain(description);
    // 段落数 = 标题 + 3 段正文 + 小节标题与条目（与旧实现同一套"一段一个 w:p"）。
    const document = partText(result.bytes, DOCX_DOCUMENT_PART_PATH);
    expect(document).toContain('<w:p>');
    expect(result.entry_count).toBe(3);
    // 与旧输出不同（说明它真的走的是新路径，不是静默回退）。
    expect(result.content_digest).not.toBe(GOLDEN_SHA256);
  });

  it('不含快照与引用时：标题 + 三段正文，无任何数字、无小节标题', () => {
    const result = buildDocxTemplate(
      input({
        fact_snapshot: [],
        references: [],
        requirement: { title: '新生读书会邀请函', description: '（使用段落路径时不渲染）', paragraphs: PARAGRAPHS },
      }),
    );
    const text = visibleText(result.bytes);
    expect(text).toBe(['新生读书会邀请函', ...PARAGRAPHS].join('\n'));
    expect(text.match(DIGIT_RUNS)).toBeNull();
    expect(text).not.toContain(FACTS_SECTION_HEADING);
    expect(untraceableDigitRuns(text, [])).toEqual([]);
  });

  it('段数上下界（2 与 4）都产出结构合法的文档', () => {
    const two = buildDocxTemplate(
      input({ fact_snapshot: [], references: [], requirement: { title: '两段', description: '', paragraphs: [PARAGRAPHS[0] ?? '', PARAGRAPHS[1] ?? ''] } }),
    );
    const four = buildDocxTemplate(
      input({
        fact_snapshot: [],
        references: [],
        requirement: { title: '四段', description: '', paragraphs: [...PARAGRAPHS, '第四段同样只是普通文字。'] },
      }),
    );
    expect(visibleText(two.bytes).split('\n')).toHaveLength(3);
    expect(visibleText(four.bytes).split('\n')).toHaveLength(5);
  });

  it('正文恰好 2000 字（上限）仍接受；超出 1 字即拒绝', () => {
    const paragraph = '长'.repeat(500); // 无数字，避免与数字护栏纠缠
    const atLimit = buildDocxTemplate(
      input({
        fact_snapshot: [],
        references: [],
        requirement: { title: '上限', description: '', paragraphs: [paragraph, paragraph, paragraph, paragraph] },
      }),
    );
    expect(visibleText(atLimit.bytes)).toContain(paragraph);

    const overLimit = '长'.repeat(501);
    expect(() =>
      buildDocxTemplate(
        input({
          fact_snapshot: [],
          references: [],
          requirement: { title: '超限', description: '', paragraphs: [overLimit, overLimit, overLimit, overLimit] },
        }),
      ),
    ).toThrow(new RegExp(`正文共 2004 字，超出上限 ${String(DOCX_MAX_BODY_CHARS)} 字`));
  });
});

describe('正文段落最小扩展：拒绝分支（结构化拒绝，不静默截断 / 不回退）', () => {
  /** 统一的拒绝构造：只换 paragraphs，其余走最小输入（空快照 / 空引用）。 */
  function withParagraphs(paragraphs: unknown): DocxTemplateInput {
    return input({
      fact_snapshot: [],
      references: [],
      requirement: {
        title: '拒绝分支',
        description: '（使用段落路径时不渲染）',
        paragraphs: paragraphs as readonly string[],
      },
    });
  }

  it('空数组 ⇒ 拒绝（且说明给出允许区间）', () => {
    expect(() => buildDocxTemplate(withParagraphs([]))).toThrow(
      new RegExp(`段数必须在 ${String(DOCX_MIN_BODY_PARAGRAPHS)}–${String(DOCX_MAX_BODY_PARAGRAPHS)} 之间，收到 0 段`),
    );
  });

  it('少于下限（1 段）⇒ 拒绝', () => {
    expect(() => buildDocxTemplate(withParagraphs(['只有一段正文。']))).toThrow(/收到 1 段/);
  });

  it('多于上限（5 段）⇒ 拒绝', () => {
    expect(() =>
      buildDocxTemplate(withParagraphs(['一。', '二。', '三。', '四。', '五。'])),
    ).toThrow(/收到 5 段/);
  });

  it('空白段（空串 / 纯空白）⇒ 拒绝', () => {
    expect(() => buildDocxTemplate(withParagraphs(['正常一段。', '']))).toThrow(/空段或纯空白段/);
    expect(() => buildDocxTemplate(withParagraphs(['正常一段。', '   \t  ']))).toThrow(/空段或纯空白段/);
    expect(() => buildDocxTemplate(withParagraphs(['正常一段。', '　']))).toThrow(/空段或纯空白段/);
  });

  it('非字符串元素 / 非数组 ⇒ 拒绝（不把数字或对象当段落）', () => {
    expect(() => buildDocxTemplate(withParagraphs(['正常一段。', 42]))).toThrow(/必须是字符串/);
    expect(() => buildDocxTemplate(withParagraphs('不是数组'))).toThrow(/必须是字符串数组/);
  });

  it('段内含换行 / 制表 / 控制字符 ⇒ 拒绝（渲染层不写 w:br，写了会无声消失）', () => {
    expect(() => buildDocxTemplate(withParagraphs(['第一行\n第二行', '第二段。']))).toThrow(/控制字符（U\+000A）/);
    expect(() => buildDocxTemplate(withParagraphs(['含\t制表符', '第二段。']))).toThrow(/控制字符（U\+0009）/);
  });

  it('**数字护栏不因扩展而放宽**：新段落里出现快照外的数字 ⇒ 拒绝', () => {
    // SNAPSHOT 里有 headcount = 8 人，但没有任何事实的值是 12。
    expect(() =>
      buildDocxTemplate(
        input({
          requirement: {
            title: '邀请函',
            description: '（使用段落路径时不渲染）',
            paragraphs: ['本次活动共 12 人参加。', '请提前十分钟到场。'],
          },
        }),
      ),
    ).toThrow(/快照里没有的数字：12/);
  });

  it('**数字护栏不因扩展而放宽**：新段落里的数字能指认到快照 ⇒ 接受', () => {
    const result = buildDocxTemplate(
      input({
        requirement: {
          title: '邀请函',
          description: '（使用段落路径时不渲染）',
          paragraphs: ['本次活动共 8 人参加。', 'budget.total: 600 CNY 已在会前确认。'],
        },
      }),
    );
    const text = visibleText(result.bytes);
    expect(untraceableDigitRuns(text, SNAPSHOT)).toEqual([]);
  });
});
