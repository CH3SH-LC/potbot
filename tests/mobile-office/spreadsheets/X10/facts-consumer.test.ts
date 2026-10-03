/**
 * X10 / XLS-18：事实发布（有回执才算数）+ 同版消费（未接线不得声称同步）—— 定向套件。
 */
import { describe, expect, it } from 'vitest';

import { asLogicalTime } from '../../../../src/protocol/index.js';
import { emptyWorkbook } from '../../../../src/session/adapters/xlsx.js';
import {
  createSpreadsheetFactsHost,
  type SpreadsheetFactsHost,
} from '../../../../src/mobile-plugins/spreadsheets/session/facts.js';
import {
  checkSameVersionConsumption,
  consumeSharedFactSnapshot,
  EMPTY_BINDING_TABLE,
  bindCell,
  type SharedFactPublication,
  type SharedFactSnapshot,
  type SameVersionConsumePort,
} from '../../../../src/spreadsheets/facts-binding.js';
import { getSheet } from '../../../../src/spreadsheets/workbook.js';
import { getCellValue } from '../../../../src/spreadsheets/sheet.js';
import type { CellValue } from '../../../../src/spreadsheets/value.js';

const num = (value: number): CellValue => ({ kind: 'number', value });

const SNAPSHOT: SharedFactSnapshot = Object.freeze({
  snapshot_id: 'snap-1',
  revision: 3,
  source_refs: Object.freeze(['doc-1']),
  values: Object.freeze([Object.freeze({ fact_key: 'headcount', value: num(4), unit: '人' })]),
  at: asLogicalTime(10),
});

/** 一个会回带正确回执的同版消费端口。 */
const HONEST_PORT: SameVersionConsumePort = Object.freeze({
  consumer: 'xlsx',
  async consume(snapshot: SharedFactSnapshot) {
    return {
      ok: true as const,
      receipt: Object.freeze({
        consumer: 'xlsx',
        snapshot_id: snapshot.snapshot_id,
        revision: snapshot.revision,
        consumed_fact_keys: Object.freeze(['headcount']),
        receipt_ref: 'rcpt-1',
        consumed_at: snapshot.at,
      }),
    };
  },
});

describe('同版消费：未接线不得声称同步', () => {
  it('未装配端口 ⇒ not-wired、consumed=false、无回执', async () => {
    const result = await consumeSharedFactSnapshot(undefined, SNAPSHOT);
    expect(result.wire_state).toBe('not-wired');
    expect(result.consumed).toBe(false);
    expect(result.version_matched).toBe(false);
    expect(result.receipt).toBeNull();
    expect(checkSameVersionConsumption(SNAPSHOT, result)).toEqual([]);
  });

  it('装配且回执同版 ⇒ consumed=true、version_matched=true、违规为空', async () => {
    const result = await consumeSharedFactSnapshot(HONEST_PORT, SNAPSHOT);
    expect(result.wire_state).toBe('consumed');
    expect(result.consumed).toBe(true);
    expect(result.version_matched).toBe(true);
    expect(result.receipt?.receipt_ref).toBe('rcpt-1');
    expect(checkSameVersionConsumption(SNAPSHOT, result)).toEqual([]);
  });

  it('回执版本与快照不符 ⇒ failed、不认这次消费、报 version_mismatch', async () => {
    const skewed: SameVersionConsumePort = {
      consumer: 'xlsx',
      async consume(snapshot) {
        return {
          ok: true as const,
          receipt: {
            consumer: 'xlsx',
            snapshot_id: snapshot.snapshot_id,
            revision: snapshot.revision + 1,
            consumed_fact_keys: ['headcount'],
            receipt_ref: 'rcpt-skew',
            consumed_at: snapshot.at,
          },
        };
      },
    };
    const result = await consumeSharedFactSnapshot(skewed, SNAPSHOT);
    expect(result.wire_state).toBe('failed');
    expect(result.consumed).toBe(false);
    expect(result.version_matched).toBe(false);
    expect(checkSameVersionConsumption(SNAPSHOT, result).map((violation) => violation.code)).toContain(
      'version_mismatch',
    );
  });

  it('回执缺非空 receipt_ref ⇒ failed（没有引用号的回执不是证据）', async () => {
    const emptyReceipt: SameVersionConsumePort = {
      consumer: 'xlsx',
      async consume(snapshot) {
        return {
          ok: true as const,
          receipt: {
            consumer: 'xlsx',
            snapshot_id: snapshot.snapshot_id,
            revision: snapshot.revision,
            consumed_fact_keys: ['headcount'],
            receipt_ref: '   ',
            consumed_at: snapshot.at,
          },
        };
      },
    };
    const result = await consumeSharedFactSnapshot(emptyReceipt, SNAPSHOT);
    expect(result.wire_state).toBe('failed');
    expect(result.consumed).toBe(false);
  });

  it('反向对照：宣称已消费却无回执 ⇒ claimed_without_receipt', () => {
    const forged = {
      consumer: 'xlsx',
      wire_state: 'consumed' as const,
      consumed: true,
      receipt: null,
      reason: null,
      snapshot_id: 'snap-1',
      snapshot_revision: 3,
      version_matched: true,
      fact_count: 1,
    };
    const violations = checkSameVersionConsumption(SNAPSHOT, forged);
    expect(violations.map((violation) => violation.code)).toContain('claimed_without_receipt');
  });
});

describe('发布边：通道状态如实', () => {
  const publications: readonly SharedFactPublication[] = [
    { fact_key: 'headcount', value: num(4), version: 1, source: 'doc-1', at: asLogicalTime(1) },
  ];

  it('无通道 ⇒ 两个目标都 not-wired，claimed_published 恒 false', async () => {
    const host = createSpreadsheetFactsHost({});
    const results = await host.publish(publications);
    expect(results.map((entry) => entry.target)).toEqual(['docx', 'pptx']);
    for (const entry of results) {
      expect(entry.wire_state).toBe('not-wired');
      expect(entry.acknowledged).toBe(false);
      expect(entry.claimed_published).toBe(false);
    }
    const report = host.report();
    expect(report.publisher_unwired_targets).toEqual(['docx', 'pptx']);
    expect(report.consumer_wired).toBe(false);
  });

  it('只装 docx 通道 ⇒ docx published(有回执)、pptx 仍 not-wired', async () => {
    const host = createSpreadsheetFactsHost({
      channels: [
        {
          target: 'docx',
          async publish() {
            return { ok: true as const, receipt_ref: 'doc-rcpt-9' };
          },
        },
      ],
    });
    const results = await host.publish(publications);
    const docx = results.find((entry) => entry.target === 'docx');
    const pptx = results.find((entry) => entry.target === 'pptx');
    expect(docx?.wire_state).toBe('published');
    expect(docx?.acknowledged).toBe(true);
    expect(docx?.receipt_ref).toBe('doc-rcpt-9');
    expect(docx?.claimed_published).toBe(false);
    expect(pptx?.wire_state).toBe('not-wired');

    const report = host.report();
    expect(report.publisher_wired_targets).toEqual(['docx']);
    expect(report.publisher_unwired_targets).toEqual(['pptx']);
    expect(report.consumer_wired).toBe(false);
  });

  it('通道失败 ⇒ failed，不冒充 published', async () => {
    const host = createSpreadsheetFactsHost({
      channels: [
        {
          target: 'docx',
          async publish() {
            return { ok: false as const, reason: '下游未就绪' };
          },
        },
      ],
    });
    const results = await host.publish(publications);
    const docx = results.find((entry) => entry.target === 'docx');
    expect(docx?.wire_state).toBe('failed');
    expect(docx?.claimed_published).toBe(false);
  });
});

describe('宿主：接线报告与事实应用', () => {
  it('report 说出消费者身份与绑定事实键', () => {
    const host = createSpreadsheetFactsHost({
      consumer: HONEST_PORT,
      bindings: bindCell(EMPTY_BINDING_TABLE, { sheet: 'S', ref: 'A1', fact_key: 'headcount', version: 0 }),
    });
    const report = host.report();
    expect(report.consumer_wired).toBe(true);
    expect(report.consumer_id).toBe('xlsx');
    expect(report.bound_fact_keys).toEqual(['headcount']);
    expect(report.summary).toContain('消费边：已接（xlsx）');
  });

  it('apply 只改写绑定格（无关格不动）', () => {
    const host: SpreadsheetFactsHost = createSpreadsheetFactsHost({
      bindings: bindCell(EMPTY_BINDING_TABLE, { sheet: 'S', ref: 'A1', fact_key: 'headcount', version: 0 }),
    });
    const source = emptyWorkbook('S');
    const applied = host.apply(source.workbook, [
      { fact_key: 'headcount', version: 1, value: num(7), source: 'doc-1', at: asLogicalTime(1) },
    ]);
    const sheet = getSheet(applied.workbook, 'S');
    expect(sheet).toBeDefined();
    if (sheet === undefined) return;
    expect(getCellValue(sheet, 'A1')).toEqual(num(7));
    expect(applied.application.rewritten_cell_keys).toEqual(['S!A1']);
  });

  it('宿主可对同版快照签发真实回执', async () => {
    const host = createSpreadsheetFactsHost({ consumer: HONEST_PORT });
    const result = await host.consume(SNAPSHOT);
    expect(result.consumed).toBe(true);
    expect(result.receipt?.receipt_ref).toBe('rcpt-1');
  });
});
