/**
 * 演示文稿构建器单测（**不碰磁盘、不起 Office**）。
 *
 * 覆盖四件：
 * 1. **golden 摘要向量**：固定输入 ⇒ 钉死的字节数 / 条目数 / sha256（R51.6）；
 * 2. **同输入两次逐字节相等**（Q8-c 确定性）；
 * 3. **「不另编数字」**：把幻灯片文本里的每个数字串逐一到事实快照里指认，
 *    并用"改快照里的数字 ⇒ 产物跟着变"的镜像用例交叉验证（**不用结构合法冒充语义正确**）；
 * 4. **空快照仍结构合法**：不产出零值、也不因为"没有数据"就崩掉。
 *
 * 容器是全 STORE 的 ZIP ⇒ 部件 XML **以明文**出现在字节里，故可用 `<a:t>` 直接取文本，
 * 无需解压器、也无需落盘。
 */

import { describe, expect, it } from 'vitest';

import { asFactRef, ValidationError } from '../../protocol/index.js';
import type { KnownFactSnapshotEntry } from '../ports.js';
import { buildPresentation, renderFactLine } from './pptx.js';

// ---------------------------------------------------------------------------
// 夹具（与 tests/acceptance/office/__probe-pptx.test.ts 的探针输入**逐字一致**，
// 因此下面的 golden 摘要就是那份被真 PowerPoint 打开过的产物）
// ---------------------------------------------------------------------------

const HEADCOUNT: KnownFactSnapshotEntry = {
  fact_ref: asFactRef('fact-headcount'),
  fact_key: 'headcount',
  value: { type: 'number', amount: 10, unit: '人', currency: null },
  source: { kind: 'user_confirmation', detail: '用户在前台确认' },
};

const BUDGET: KnownFactSnapshotEntry = {
  fact_ref: asFactRef('fact-budget'),
  fact_key: 'budget.total',
  value: { type: 'number', amount: 12800, unit: '元', currency: 'CNY' },
  source: { kind: 'user_confirmation', detail: '用户在前台确认' },
};

const EVENT_DATE: KnownFactSnapshotEntry = {
  fact_ref: asFactRef('fact-date'),
  fact_key: 'event.date',
  value: { type: 'date', iso_date: '2026-10-02', time_zone: 'Asia/Shanghai' },
  source: { kind: 'document', detail: '由已授权资料得出' },
};

const VENUE: KnownFactSnapshotEntry = {
  fact_ref: asFactRef('fact-venue'),
  fact_key: 'venue.name',
  value: { type: 'text', text: '上海交通大学闵行校区', source: '已授权资料' },
  source: { kind: 'document', detail: '由已授权资料得出' },
};

const SNAPSHOT: readonly KnownFactSnapshotEntry[] = Object.freeze([
  HEADCOUNT,
  BUDGET,
  EVENT_DATE,
  VENUE,
]);

const INPUT = Object.freeze({
  title: '年会筹备方案',
  goal: '向管理层说明筹备进展与资源需求',
  audience: '公司管理层',
  fact_snapshot: SNAPSHOT,
});

/** 部件链：13 条（8 份业务部件 + 5 份生成的 `*_rels/*.rels`）。缺一环 PowerPoint 就打不开。 */
const EXPECTED_ENTRY_COUNT = 13;

/**
 * golden 摘要向量（2026-10-02 本机实测值）。
 *
 * 取值来源：`buildPresentation(INPUT)` 的实际输出，且该输入已由
 * `tests/acceptance/office/__probe-pptx.test.ts` 交给真 PowerPoint 打开并读回事实
 * （`verdict=opened`，`slides=2`）——**不是**"结构看着对"就算。
 */
const GOLDEN_BYTE_LENGTH = 14335;
const GOLDEN_CONTENT_DIGEST = 'b0d40fb7dea956fa0a196377e57f9e711ba12235372703626b463f781087e260';

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 取出全部非零长的数字串（`10`、`12800`、`2026` …）。 */
function digitRuns(text: string): readonly string[] {
  return text.match(/[0-9]+/g) ?? [];
}

/** 从容器字节里取出所有 `<a:t>` 的文本（全 STORE ⇒ XML 明文可见）。 */
function slideTexts(bytes: Buffer): readonly string[] {
  const raw = bytes.toString('utf8');
  const found: string[] = [];
  const pattern = /<a:t>([^<]*)<\/a:t>/g;
  let match = pattern.exec(raw);
  while (match !== null) {
    found.push(match[1] as string);
    match = pattern.exec(raw);
  }
  return found;
}

/** 「允许出现的数字」= 各条事实**自己**渲染出来的数字串；此外任何数字都算"另编"。 */
function allowedDigitRuns(snapshot: readonly KnownFactSnapshotEntry[]): ReadonlySet<string> {
  const allowed = new Set<string>();
  for (const entry of snapshot) {
    for (const run of digitRuns(renderFactLine(entry))) allowed.add(run);
  }
  return allowed;
}

// ---------------------------------------------------------------------------

describe('buildPresentation —— golden 摘要向量与确定性', () => {
  it('golden：固定输入 ⇒ 钉死的字节数、条目数与 sha256', () => {
    const built = buildPresentation({ ...INPUT });

    expect(built.bytes.length).toBe(GOLDEN_BYTE_LENGTH);
    expect(built.entry_count).toBe(EXPECTED_ENTRY_COUNT);
    expect(built.content_digest).toBe(GOLDEN_CONTENT_DIGEST);
    // 摘要是**对产物字节**取的（口径与 docx/xlsx 构建器一致）。
    expect(built.content_digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('同一输入连跑两次 ⇒ 逐字节相等、摘要相等', () => {
    const first = buildPresentation({ ...INPUT });
    const second = buildPresentation({ ...INPUT });

    expect(first.bytes.equals(second.bytes)).toBe(true);
    expect(first.content_digest).toBe(second.content_digest);
    expect(first.entry_count).toBe(second.entry_count);
  });

  it('改一条事实的数值 ⇒ 字节与摘要都变（不是"摘要写死"）', () => {
    const changed = buildPresentation({
      ...INPUT,
      fact_snapshot: [
        { ...HEADCOUNT, value: { type: 'number', amount: 12, unit: '人', currency: null } },
        BUDGET,
        EVENT_DATE,
        VENUE,
      ],
    });

    expect(changed.content_digest).not.toBe(GOLDEN_CONTENT_DIGEST);
    expect(changed.bytes.equals(buildPresentation({ ...INPUT }).bytes)).toBe(false);
  });
});

describe('buildPresentation —— 部件链与结构', () => {
  it('八份业务部件与五份关系部件都在容器里', () => {
    const built = buildPresentation({ ...INPUT });
    const raw = built.bytes.toString('utf8');

    for (const part of [
      '[Content_Types].xml',
      '_rels/.rels',
      'ppt/presentation.xml',
      'ppt/slideMasters/slideMaster1.xml',
      'ppt/slideLayouts/slideLayout1.xml',
      'ppt/slides/slide1.xml',
      'ppt/slides/slide2.xml',
      'ppt/theme/theme1.xml',
      'ppt/_rels/presentation.xml.rels',
      'ppt/slideMasters/_rels/slideMaster1.xml.rels',
      'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
      'ppt/slides/_rels/slide1.xml.rels',
      'ppt/slides/_rels/slide2.xml.rels',
    ]) {
      expect(raw).toContain(part);
    }
  });

  it('主题的四个样式列表各恰好 3 项，颜色方案恰好 12 项', () => {
    const raw = buildPresentation({ ...INPUT }).bytes.toString('utf8');
    const countOf = (pattern: RegExp): number => (raw.match(pattern) ?? []).length;

    expect(countOf(/<a:fillStyleLst>/g)).toBe(1);
    expect(countOf(/<a:gs pos=/g)).toBe(2 + 2 + 3); // fillStyleLst 两项渐变各 2 个 gs + bgFillStyleLst 3 个
    expect(countOf(/<a:ln w=/g)).toBe(3);
    expect(countOf(/<a:effectStyle>/g)).toBe(3);
    expect(countOf(/<a:bgFillStyleLst>/g)).toBe(1);

    for (const tag of [
      'a:dk1',
      'a:lt1',
      'a:dk2',
      'a:lt2',
      'a:accent1',
      'a:accent2',
      'a:accent3',
      'a:accent4',
      'a:accent5',
      'a:accent6',
      'a:hlink',
      'a:folHlink',
    ]) {
      expect(countOf(new RegExp(`<${tag}>`, 'g'))).toBe(1);
    }
  });
});

describe('「引用统一数据，不另编数字」（P6 明确边界）', () => {
  it('幻灯片文本里的每个数字串都能指认到快照里的某条事实', () => {
    const built = buildPresentation({ ...INPUT });
    const texts = slideTexts(built.bytes);
    expect(texts.length).toBeGreaterThan(0);

    const allowed = allowedDigitRuns(SNAPSHOT);
    const offenders: string[] = [];
    for (const text of texts) {
      for (const run of digitRuns(text)) {
        if (!allowed.has(run)) offenders.push(`${JSON.stringify(text)} → ${run}`);
      }
    }

    expect(offenders).toEqual([]);
    // 反向确认这条断言不是空的：产物里**确实**有来自快照的数字。
    const all = texts.flatMap((text) => digitRuns(text));
    expect(new Set(all)).toEqual(new Set(['10', '12800', '2026', '02']));
  });

  it('快照里没有的数字绝不出现（改数字 ⇒ 产物跟着改）', () => {
    const built = buildPresentation({
      ...INPUT,
      fact_snapshot: [
        { ...HEADCOUNT, value: { type: 'number', amount: 4242, unit: '人', currency: null } },
        BUDGET,
        EVENT_DATE,
        VENUE,
      ],
    });
    const texts = slideTexts(built.bytes).join('\n');

    expect(texts).toContain('4242');
    expect(texts).not.toContain('headcount：10 ');
  });

  it('非事实文本含数字 ⇒ 直接拒绝（不给"编一个数字"留位置）', () => {
    expect(() => buildPresentation({ ...INPUT, title: '2026 年会筹备方案' })).toThrow(
      ValidationError,
    );
    expect(() => buildPresentation({ ...INPUT, goal: '服务 8 个小组' })).toThrow(/含数字/);
    expect(() => buildPresentation({ ...INPUT, audience: '第 3 组' })).toThrow(/含数字/);
  });

  it('输入契约里没有数值参数位置：多传一个 amount 会被忽略，产物不因它变化', () => {
    // 走变量而不是对象字面量，正是为了让它真的**编译通过**——证明"多塞一个数字"没有落点。
    const smuggled = { ...INPUT, amount: 9999 };
    const withExtra = buildPresentation(smuggled);
    expect(withExtra.content_digest).toBe(GOLDEN_CONTENT_DIGEST);
  });
});

describe('空快照仍结构合法', () => {
  it('没有事实时照样产出可打开的结构，且不编造 0', () => {
    const built = buildPresentation({ ...INPUT, fact_snapshot: [] });

    expect(built.entry_count).toBe(EXPECTED_ENTRY_COUNT);
    expect(built.content_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(built.content_digest).not.toBe(GOLDEN_CONTENT_DIGEST);

    const texts = slideTexts(built.bytes);
    expect(texts.join('\n')).toContain('未引用事实数据');
    for (const text of texts) expect(digitRuns(text)).toEqual([]);
  });

  it('空快照也满足"两次逐字节相等"', () => {
    const first = buildPresentation({ ...INPUT, fact_snapshot: [] });
    const second = buildPresentation({ ...INPUT, fact_snapshot: [] });
    expect(first.bytes.equals(second.bytes)).toBe(true);
  });
});
