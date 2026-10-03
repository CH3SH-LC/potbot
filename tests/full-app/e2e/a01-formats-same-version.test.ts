/**
 * FA-A-E2E —— 需求簇 1：**三格式同版**（A01 / A13 / A10 的重载部分）。
 *
 * 主张：同一个共享事实版本（R2：十人 / 预算 600）驱动 DOCX / XLSX / PPTX 三个产物，
 * 三者数值来自**同一事实版本**；不同版本的产物会被判冲突。
 *
 * ## 真跑的部分
 * - 用 `src/artifacts/templates/{docx,xlsx,pptx}.ts` 产**真实字节**；
 * - 用 `selfCheckArtifactBytes()` 做第一层结构自检；
 * - 用本套件**自己的** `readZipEntryText()` 独立读回每个部件的文本（不复用产品自检器）；
 * - 用 `findFactInvalidatedArtifacts()` 判"同一版本 vs 旧版本"的冲突。
 *
 * ## 显式跳过的部分
 * - 三文件在**手机/消费端实际打开** —— 需真机 + 无授权 Office（见每个 `it.skip` 的原因）。
 */
import { describe, expect, it } from 'vitest';

import { asFactRef, asInstanceId, asLogicalTime } from '../../../src/protocol/index.js';
import type { KnownFactSnapshotEntry } from '../../../src/artifacts/ports.js';
import { selfCheckArtifactBytes, digestBytes } from '../../../src/artifacts/index.js';
import { buildDocxTemplate } from '../../../src/artifacts/templates/docx.js';
import {
  buildXlsxTemplate,
  buildXlsxTable,
  computeLineTotal,
  type XlsxFactEntry,
  type XlsxSheetSpec,
} from '../../../src/artifacts/templates/xlsx.js';
import { buildPresentation } from '../../../src/artifacts/templates/pptx.js';
import { buildFactSnapshot } from '../../../src/facts/index.js';
import { currentFactByKey } from '../../../src/protocol/facts.js';
import { findFactInvalidatedArtifacts } from '../../../src/artifacts/publish.js';
import { createSharedFactRecord } from '../../../src/protocol/index.js';

import {
  DEMO_TASK,
  REV_10,
  T0,
  decimalNumbersIn,
  demoFactVersions,
  publishedArtifact,
  readZipEntryText,
  textRunsOf,
  toSnapshotEntries,
} from './harness.js';

const TEN_PEOPLE_SHEET: XlsxSheetSpec = {
  sheet_name: '预算',
  label_header: '项目',
  value_header: '金额',
  unit: '元',
  lines: [
    { label: '餐饮', fact_key: 'cost.food' },
    { label: '场地', fact_key: 'cost.venue' },
  ],
  total_label: '合计',
  scale: 2,
};

function numberEntry(key: string, amount: number, unit: string): XlsxFactEntry {
  return {
    fact_ref: asFactRef(`fact-${key}`),
    fact_key: key,
    value: { type: 'number', amount, unit, currency: null },
    source: { kind: 'user_confirmation', detail: '用户确认' },
  };
}

describe('三格式同版：同一事实版本产真实字节并独立读回', () => {
  it('DOCX / XLSX / PPTX 三产物都产出真实字节，且通过第一层结构自检', () => {
    const versions = demoFactVersions();
    const snapshot = buildFactSnapshot({
      facts: [versions.h10, versions.b10],
      task_id: DEMO_TASK,
      task_revision: REV_10,
      fact_keys: ['headcount', 'budget.total'],
    });
    expect(snapshot.usable.map((entry) => entry.fact_key)).toEqual(['headcount', 'budget.total']);
    const shared = toSnapshotEntries([versions.h10, versions.b10]);

    const docx = buildDocxTemplate({
      requirement: {
        title: '季度总结会安排',
        description: '根据已确认事实整理，供组内传阅。',
      },
      fact_snapshot: shared,
      references: [{ label: '场地确认单', detail: '由行政组提供' }],
    });
    const xlsx = buildXlsxTemplate(TEN_PEOPLE_SHEET, [
      numberEntry('cost.food', 360, '元'),
      numberEntry('cost.venue', 240, '元'),
    ]);
    const pptx = buildPresentation({
      title: '年会筹备方案',
      goal: '向管理层说明筹备进展',
      audience: '公司管理层',
      fact_snapshot: shared,
    });

    for (const [name, result] of [
      ['docx', docx],
      ['xlsx', xlsx],
      ['pptx', pptx],
    ] as const) {
      expect(result.bytes.byteLength, `${name} 字节为空`).toBeGreaterThan(0);
      expect(result.content_digest, `${name} 摘要与字节不符`).toBe(digestBytes(result.bytes));
      const check = selfCheckArtifactBytes(result.bytes);
      expect(check.ok, `${name} 第一层自检未通过：${check.problems.map((p) => p.kind).join(',')}`).toBe(true);
      expect(check.entry_count).toBe(result.entry_count);
    }
  });

  it('独立读回 DOCX 正文：人数 10 追得到共享事实（不是硬编码）', () => {
    const versions = demoFactVersions();
    const docx = buildDocxTemplate({
      requirement: { title: '季度总结会安排', description: '根据已确认事实整理。' },
      fact_snapshot: toSnapshotEntries([versions.h10, versions.b10]),
      references: [],
    });
    const xml = readZipEntryText(docx.bytes, 'word/document.xml');
    const text = textRunsOf(xml);
    expect(text).toContain('headcount');
    expect(text).toContain('10 人');
    // 正文里每个十进制数字都能追溯到快照的派生字符串（此处快照只有 10 与 600）。
    const known = new Set(['10', '600']);
    for (const run of decimalNumbersIn(text)) {
      expect(known.has(run), `正文出现无法追溯到事实的数字：${run}`).toBe(true);
    }
  });

  it('独立读回 XLSX：明细求和得到预算合计 600（预算公式在代码里算）', () => {
    const facts: XlsxFactEntry[] = [
      numberEntry('cost.food', 360, '元'),
      numberEntry('cost.venue', 240, '元'),
    ];
    const total = computeLineTotal(TEN_PEOPLE_SHEET, facts);
    expect(total).toEqual({ ok: true, amount: 600 });

    const xlsx = buildXlsxTemplate(TEN_PEOPLE_SHEET, facts);
    const sheet = textRunsOf(readZipEntryText(xlsx.bytes, 'xl/worksheets/sheet1.xml'));
    expect(sheet).toContain('600');
    expect(sheet).toContain('360');
    expect(sheet).toContain('240');
    const table = buildXlsxTable(TEN_PEOPLE_SHEET, facts);
    const values = table.flat().filter((cell) => cell.kind === 'number');
    expect(values.length).toBe(3); // 两行明细 + 合计
  });

  it('独立读回 PPTX：演示事实行含人数 10', () => {
    const versions = demoFactVersions();
    const pptx = buildPresentation({
      title: '年会筹备方案',
      goal: '向管理层说明筹备进展',
      audience: '公司管理层',
      fact_snapshot: toSnapshotEntries([versions.h10, versions.b10]),
    });
    // 事实行在第二张幻灯片（第一张是标题/目标/受众，构建器不允许它们含数字）。
    const slide = readZipEntryText(pptx.bytes, 'ppt/slides/slide2.xml');
    expect(slide).toContain('headcount');
    expect(slide).toContain('10 人');
  });

  it('三产物引用同一事实版本：都未被判失效；引用旧版本(八人)的产物被判冲突', () => {
    const versions = demoFactVersions();
    const fromR2 = ['fact-headcount-r2', 'fact-budget-r2'];
    const docs = [
      publishedArtifact({ artifact_id: 'art-doc-r2', template_kind: 'document', task_revision: REV_10, artifact_version: 2, source_fact_refs: fromR2, content_digest: 'd-doc' }),
      publishedArtifact({ artifact_id: 'art-xls-r2', template_kind: 'spreadsheet', task_revision: REV_10, artifact_version: 2, source_fact_refs: fromR2, content_digest: 'd-xls' }),
      publishedArtifact({ artifact_id: 'art-ppt-r2', template_kind: 'presentation', task_revision: REV_10, artifact_version: 2, source_fact_refs: fromR2, content_digest: 'd-ppt' }),
      // 一个仍引用"八人版本"的遗留产物 —— 与同版三者不同版本
      publishedArtifact({ artifact_id: 'art-doc-r1', template_kind: 'document', task_revision: REV_10, artifact_version: 1, source_fact_refs: ['fact-headcount-r1', 'fact-budget-r1'], content_digest: 'd-old' }),
    ];
    const invalidated = findFactInvalidatedArtifacts(docs, versions.all);
    expect(invalidated.map((record) => record.artifact_id)).toEqual(['art-doc-r1']);
  });

  it('事实重载后仍读到同一版本（A10 的记录恢复部分）', () => {
    const versions = demoFactVersions();
    const reloaded = JSON.parse(JSON.stringify(versions.all)) as typeof versions.all;
    const snapshot = buildFactSnapshot({
      facts: reloaded,
      task_id: DEMO_TASK,
      task_revision: REV_10,
      fact_keys: ['headcount'],
    });
    const headcount = snapshot.usable.find((entry) => entry.fact_key === 'headcount');
    expect(headcount?.fact_ref).toBe(asFactRef('fact-headcount-r2'));
    if (headcount !== undefined && headcount.value.type === 'number') {
      expect(headcount.value.amount).toBe(10);
    } else {
      throw new Error('headcount 不是数值事实');
    }
  });

  it('A13：同一事实键在同一版本出现两个当前值 → 显式冲突，不任取一条', () => {
    const versions = demoFactVersions();
    const rogue = createSharedFactRecord({
      fact_id: asFactRef('fact-headcount-r2-rogue'),
      task_id: DEMO_TASK,
      task_revision: REV_10,
      fact_key: 'headcount',
      value: { kind: 'known', value: { type: 'number', amount: 11, unit: '人', currency: null } },
      source: { kind: 'external', detail: '未经确认的外部来源' },
      confirmed_by: asInstanceId('instance-rogue'),
      confirmed_at: asLogicalTime(9),
    });
    expect(() =>
      currentFactByKey([versions.h10, rogue], {
        task_id: DEMO_TASK,
        task_revision: REV_10,
        fact_key: 'headcount',
      }),
    ).toThrowError(/单一来源被破坏/);
  });

  it('A13：未知/缺失事实不得当 0 —— 表格留空并给出明细理由', () => {
    const spec: XlsxSheetSpec = {
      sheet_name: '预算',
      label_header: '项目',
      value_header: '金额',
      unit: '元',
      lines: [
        { label: '餐饮', fact_key: 'cost.food' },
        { label: '未知项', fact_key: 'cost.unknown' },
      ],
      total_label: '合计',
      scale: 2,
    };
    const facts: XlsxFactEntry[] = [
      numberEntry('cost.food', 360, '元'),
      {
        fact_ref: asFactRef('fact-cost-unknown'),
        fact_key: 'cost.unknown',
        value: { kind: 'unknown', reason: '候选资料未给出该费用' },
        source: { kind: 'document', detail: '资料缺失' },
      },
    ];
    const total = computeLineTotal(spec, facts);
    expect(total.ok).toBe(false);
    if (!total.ok) expect(total.reason).toBe('unknown_fact');

    const table = buildXlsxTable(spec, facts);
    const blanks = table.flat().filter((cell) => cell.kind === 'blank');
    expect(blanks.length).toBeGreaterThan(0);
    for (const cell of blanks) {
      expect(cell.ref).not.toBe('');
    }
    // 没有任何一个金额单元格是 0（未知不得退化成 0）。
    for (const cell of table.flat()) {
      if (cell.kind === 'number') expect(cell.amount).not.toBe(0);
    }

    // unknown 事实若携带 value 载荷，构造期即拒（"用值冒充未知"）。
    expect(() =>
      createSharedFactRecord({
        fact_id: asFactRef('fact-bad-unknown'),
        task_id: DEMO_TASK,
        task_revision: REV_10,
        fact_key: 'cost.unknown',
        value: { kind: 'unknown', reason: '缺失', value: 0 } as never,
        source: { kind: 'document', detail: '资料缺失' },
        confirmed_by: asInstanceId('instance-x'),
        confirmed_at: T0,
      }),
    ).toThrowError(/不得携带 value 载荷|冒充/);
  });
});

describe('三格式同版 —— 显式跳过（需真机/消费端）', () => {
  it.skip('手机/消费端实际打开三个文件并核对关键字段 → 需真机 + 无授权 Office（合同 v1.4 R65）', () => {
    // 无设备连接、本机 Office 无授权；不以模拟打开冒充实测。
  });

  it.skip('手机保存 → 关闭 → 重开后继续编辑三个文件 → 需真机（另存重开链路未验证）', () => {
    // 见 docs/other/honor-usb-connection.md：真机已接通，但文档编辑另存重开仍未验证。
  });
});
