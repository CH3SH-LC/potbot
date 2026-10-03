/**
 * `ArtifactRecord` 的构造期不变量（design-02 P1/P2/P3）。
 *
 * 每个用例对应一条"缺哪个字段 ⇒ 抛什么"，逐条写清；此外覆盖：
 * - `source_fact_refs` 空 ⇒ 抛（P3 机器判据）；
 * - `published` 无回执 ⇒ 抛（I-1）；
 * - `failed` 无失败种类 ⇒ 抛（镜像 WorkItem.failure_reason 的纪律）。
 */

import { describe, expect, it } from 'vitest';

import {
  ARTIFACT_FAILURE_KINDS,
  ARTIFACT_STATUSES,
  ARTIFACT_VERIFICATION_KINDS,
  ARTIFACT_VERIFICATION_OUTCOMES,
  asArtifactRef,
  asFactRef,
  asInstanceId,
  asLogicalTime,
  asRevision,
  asTaskId,
  assertArtifactInvariants,
  createArtifactRecord,
  isDeliveredArtifact,
  TEMPLATE_KIND_EXTENSIONS,
  TEMPLATE_KIND_MIME_TYPES,
  TEMPLATE_KINDS,
  ValidationError,
  type ArtifactReceipt,
  type ArtifactRecordInput,
} from './index.js';

const TASK = asTaskId('T1');
const INSTANCE = asInstanceId('I-A');
const R2 = asRevision(2);
const T0 = asLogicalTime(0);
const FACT_A = asFactRef('fact-headcount');
const FACT_B = asFactRef('fact-budget');

const BASE: ArtifactRecordInput = {
  artifact_id: asArtifactRef('art-1'),
  task_id: TASK,
  task_revision: R2,
  artifact_version: 1,
  template_kind: 'document',
  byte_length: 1234,
  content_digest: 'sha256:abc',
  source_fact_refs: [FACT_A],
  created_by_instance_id: INSTANCE,
  status: 'staged',
  created_at: T0,
};

/** 默认值先经类型检查；负向用例注入越界值时再显式转型（测试专用）。 */
function baseInput(overrides: Record<string, unknown> = {}): ArtifactRecordInput {
  return { ...BASE, ...overrides } as ArtifactRecordInput;
}

const RECEIPT: ArtifactReceipt = {
  final_path: '/root/T1/r2/document/art-1.docx',
  readback_digest: 'sha256:readback',
  verifier: 'I-A',
  at: T0,
};

function publishedInput(overrides: Record<string, unknown> = {}): ArtifactRecordInput {
  return baseInput({
    status: 'published',
    receipt: RECEIPT,
    verifications: [
      { kind: 'structural_self_check', outcome: 'pass', detail: '部件齐全' },
    ],
    ...overrides,
  });
}

describe('产物记录的封闭枚举（唯一字面量来源）', () => {
  it('模板种类恰为 文档 / 表格 / 演示 三类', () => {
    expect([...TEMPLATE_KINDS]).toEqual(['document', 'spreadsheet', 'presentation']);
  });

  it('模板种类 → 扩展名 / MIME 的映射齐全且固定', () => {
    expect(TEMPLATE_KIND_EXTENSIONS).toEqual({
      document: 'docx',
      spreadsheet: 'xlsx',
      presentation: 'pptx',
    });
    expect(Object.keys(TEMPLATE_KIND_MIME_TYPES)).toEqual([...TEMPLATE_KINDS]);
    expect(TEMPLATE_KIND_MIME_TYPES.presentation).toContain('presentationml.presentation');
  });

  it('状态恰为 五态，且只有 published 是"已交付"', () => {
    expect([...ARTIFACT_STATUSES]).toEqual([
      'staged',
      'published',
      'failed',
      'superseded',
      'expired',
    ]);
    expect(isDeliveredArtifact(createArtifactRecord(publishedInput()))).toBe(true);
    expect(isDeliveredArtifact(createArtifactRecord(baseInput()))).toBe(false);
    expect(
      isDeliveredArtifact(createArtifactRecord(baseInput({ status: 'superseded' }))),
    ).toBe(false);
  });

  it('失败种类恰为端口失败的五种，且检查种类四值、结论三值', () => {
    expect([...ARTIFACT_FAILURE_KINDS]).toEqual([
      'missing_fact',
      'builder_failed',
      'write_failed',
      'version_stale',
      'self_check_failed',
    ]);
    expect([...ARTIFACT_VERIFICATION_KINDS]).toEqual([
      'structural_self_check',
      'version_match',
      'independent_readback',
      'application_open',
    ]);
    expect([...ARTIFACT_VERIFICATION_OUTCOMES]).toEqual(['pass', 'fail', 'inconclusive']);
  });
});

describe('构造期不变量：逐条"缺哪个字段 ⇒ 抛什么"', () => {
  it('source_fact_refs 为空 ⇒ 抛（P3 机器判据：产物必须能追溯到共享事实）', () => {
    expect(() => createArtifactRecord(baseInput({ source_fact_refs: [] }))).toThrow(
      ValidationError,
    );
    expect(() => createArtifactRecord(baseInput({ source_fact_refs: [] }))).toThrow(
      /source_fact_refs 不能为空/,
    );
  });

  it('published 缺回执 ⇒ 抛（I-1：无回读不得称交付）', () => {
    expect(() => createArtifactRecord(publishedInput({ receipt: null }))).toThrow(
      /published 产物必须有回执/,
    );
  });

  it('published 带 failure_kind ⇒ 抛（已交付与失败互斥）', () => {
    expect(() =>
      createArtifactRecord(publishedInput({ failure_kind: 'builder_failed' })),
    ).toThrow(/published 产物不得携带 failure_kind/);
  });

  it('published 无任何检查结果 ⇒ 抛（P1：生成即交付不算交付）', () => {
    expect(() => createArtifactRecord(publishedInput({ verifications: [] }))).toThrow(
      /published 产物必须有至少一条交付前检查结果/,
    );
  });

  it('failed 缺 failure_kind ⇒ 抛（镜像 WorkItem.failure_reason 的纪律）', () => {
    expect(() =>
      createArtifactRecord(baseInput({ status: 'failed', failure_kind: null })),
    ).toThrow(/failed 产物必须给出 failure_kind/);
  });

  it('failed 带回执 ⇒ 抛（失败与已交付互斥）', () => {
    expect(() =>
      createArtifactRecord(
        baseInput({ status: 'failed', failure_kind: 'missing_fact', receipt: RECEIPT }),
      ),
    ).toThrow(/failed 产物不得携带交付回执/);
  });

  it('staged 带回执 ⇒ 抛（I-4：中间态不得满足任何"已交付"判据）', () => {
    expect(() => createArtifactRecord(baseInput({ receipt: RECEIPT }))).toThrow(
      /staged 产物不得携带交付回执/,
    );
  });

  it('failed 且 status 与 failure_kind 一致时构造成功', () => {
    const record = createArtifactRecord(
      baseInput({ status: 'failed', failure_kind: 'missing_fact' }),
    );
    expect(record.status).toBe('failed');
    expect(record.failure_kind).toBe('missing_fact');
    expect(record.receipt).toBeNull();
  });

  it('artifact_version 必须 ≥ 1、byte_length 必须 ≥ 0', () => {
    expect(() => createArtifactRecord(baseInput({ artifact_version: 0 }))).toThrow(
      /artifact_version 必须是 ≥ 1 的整数/,
    );
    expect(() => createArtifactRecord(baseInput({ artifact_version: 1.5 }))).toThrow(
      ValidationError,
    );
    expect(() => createArtifactRecord(baseInput({ byte_length: -1 }))).toThrow(
      /byte_length 必须是 ≥ 0 的整数/,
    );
  });

  it('未知模板种类 / 未知状态 / 未知失败种类一律抛', () => {
    expect(() => createArtifactRecord(baseInput({ template_kind: 'pdf' }))).toThrow(
      /template_kind 必须是/,
    );
    expect(() => createArtifactRecord(baseInput({ status: 'delivered' }))).toThrow(
      /status 必须是/,
    );
    expect(() =>
      createArtifactRecord(baseInput({ status: 'failed', failure_kind: 'disk_full' })),
    ).toThrow(/failure_kind 必须是/);
  });

  it('同一种检查出现两次 ⇒ 抛（否则"检查过了"无法判定）', () => {
    expect(() =>
      createArtifactRecord(
        publishedInput({
          verifications: [
            { kind: 'version_match', outcome: 'pass', detail: 'a' },
            { kind: 'version_match', outcome: 'pass', detail: 'b' },
          ],
        }),
      ),
    ).toThrow(/出现了两次/);
  });

  it('检查结论为 inconclusive 是合法一等值（不得因为写不成 pass 就丢掉检查）', () => {
    const record = createArtifactRecord(
      publishedInput({
        verifications: [
          { kind: 'structural_self_check', outcome: 'pass', detail: '部件齐全' },
          { kind: 'application_open', outcome: 'inconclusive', detail: 'COM 超时，未取得证据' },
        ],
      }),
    );
    expect(record.verifications.map((entry) => entry.outcome)).toEqual(['pass', 'inconclusive']);
  });

  it('回执的路径 / 回读摘要 / 验证者都不能为空', () => {
    expect(() =>
      createArtifactRecord(publishedInput({ receipt: { ...RECEIPT, readback_digest: '' } })),
    ).toThrow(/readback_digest 不能为空/);
    expect(() =>
      createArtifactRecord(publishedInput({ receipt: { ...RECEIPT, verifier: '' } })),
    ).toThrow(/verifier 不能为空/);
  });
});

describe('形状与默认值', () => {
  it('mime 省略时按模板种类取默认值', () => {
    const doc = createArtifactRecord(baseInput({ template_kind: 'document' }));
    const sheet = createArtifactRecord(baseInput({ template_kind: 'spreadsheet' }));
    const deck = createArtifactRecord(baseInput({ template_kind: 'presentation' }));
    expect(doc.mime_type).toBe(TEMPLATE_KIND_MIME_TYPES.document);
    expect(sheet.mime_type).toBe(TEMPLATE_KIND_MIME_TYPES.spreadsheet);
    expect(deck.mime_type).toBe(TEMPLATE_KIND_MIME_TYPES.presentation);
  });

  it('可选的依赖与检查列表默认为空，updated_at 默认等于 created_at', () => {
    const record = createArtifactRecord(baseInput());
    expect(record.dependency_artifact_refs).toEqual([]);
    expect(record.verifications).toEqual([]);
    expect(record.updated_at).toBe(T0);
  });

  it('构造结果是冻结的（下游不得就地改写记录）', () => {
    const record = createArtifactRecord(baseInput());
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.source_fact_refs)).toBe(true);
  });

  it('assertArtifactInvariants 对合法记录静默，对越界记录抛错（与构造期同源）', () => {
    const record = createArtifactRecord(publishedInput());
    expect(() => assertArtifactInvariants(record)).not.toThrow();
    const broken = { ...record, source_fact_refs: [] };
    expect(() => assertArtifactInvariants(broken)).toThrow(/source_fact_refs 不能为空/);
  });

  it('source_fact_refs 可以引用多条事实（如人数 + 预算来自不同键）', () => {
    const record = createArtifactRecord(baseInput({ source_fact_refs: [FACT_A, FACT_B] }));
    expect(record.source_fact_refs).toEqual([FACT_A, FACT_B]);
  });
});
