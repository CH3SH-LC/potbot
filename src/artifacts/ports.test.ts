/**
 * 物化端口（design-02 P1 的接缝）。
 *
 * 重点验三件事：
 * 1. **失败是结构化的**：端口不抛错、不静默；默认收集型端口**不给成功回执**（防伪造交付）；
 * 2. **请求与计划必须自洽**（否则回执路径与记录身份分叉）；
 * 3. **端口回执可以直接嵌进产物记录**，并满足 `published` 的构造期不变量（接缝可用）。
 */

import { describe, expect, it } from 'vitest';

import {
  ARTIFACT_FAILURE_KINDS,
  asArtifactRef,
  asFactRef,
  asInstanceId,
  asLogicalTime,
  asRevision,
  asTaskId,
  createArtifactRecord,
  isDeliveredArtifact,
  ValidationError,
} from '../protocol/index.js';
import {
  assertRequestPlanConsistency,
  createCollectingMaterializationPort,
  describeMaterializationResult,
  materializationFailure,
  materializationSuccess,
  planArtifact,
  type ArtifactMaterializationReceipt,
  type ArtifactMaterializationRequest,
} from './index.js';

const TASK = asTaskId('T1');
const INSTANCE = asInstanceId('I-A');
const R2 = asRevision(2);
const AT = asLogicalTime(11);

function request(overrides: Partial<ArtifactMaterializationRequest> = {}): ArtifactMaterializationRequest {
  const plan = planArtifact({
    task_id: TASK,
    task_revision: R2,
    template_kind: 'spreadsheet',
    artifact_version: 1,
    root_dir: '/root/artifacts',
    expected_content_digest: 'sha256:expected',
  });
  return {
    artifact_id: plan.artifact_id,
    task_id: TASK,
    task_revision: R2,
    template_kind: 'spreadsheet',
    fact_snapshot: [
      {
        fact_ref: asFactRef('fact-headcount'),
        fact_key: 'headcount',
        value: { type: 'number', amount: 10, unit: '人', currency: null },
        source: { kind: 'user_confirmation', detail: '用户确认十人' },
      },
    ],
    plan,
    expected_content_digest: 'sha256:expected',
    ...overrides,
  };
}

/** 与请求一致的合法回执（回读摘要由端口给出）。 */
function receiptFor(req: ArtifactMaterializationRequest): ArtifactMaterializationReceipt {
  return {
    artifact_id: req.artifact_id,
    final_path: req.plan.final_path,
    readback_digest: 'sha256:readback-abc',
    byte_length: 4096,
    entry_count: 7,
    verifier: 'fs-port',
    at: AT,
  };
}

describe('端口请求：事实快照只装"已知值"', () => {
  it('请求携带语义维度、事实快照、路径计划与期望摘要', () => {
    const req = request();
    expect(req.artifact_id).toBe(req.plan.artifact_id);
    expect(req.fact_snapshot[0]?.value).toEqual({
      type: 'number',
      amount: 10,
      unit: '人',
      currency: null,
    });
    expect(req.expected_content_digest).toBe(req.plan.expected_content_digest);
  });

  it('请求与计划自洽时静默', () => {
    expect(() => assertRequestPlanConsistency(request())).not.toThrow();
  });

  it('请求与计划不一致（版本 / 种类 / 摘要 / id 任一）⇒ 抛，不得静默分叉', () => {
    const base = request();
    expect(() =>
      assertRequestPlanConsistency({ ...base, task_revision: asRevision(3) }),
    ).toThrow(/task_revision/);
    expect(() =>
      assertRequestPlanConsistency({ ...base, template_kind: 'document' }),
    ).toThrow(/template_kind/);
    expect(() =>
      assertRequestPlanConsistency({ ...base, expected_content_digest: 'sha256:other' }),
    ).toThrow(/expected_content_digest/);
    expect(() =>
      assertRequestPlanConsistency({ ...base, artifact_id: asArtifactRef('art-other') }),
    ).toThrow(/artifact_id/);
  });
});

describe('收集型端口：默认失败（防伪造交付）', () => {
  it('不注入应答器时返回结构化失败 builder_failed，而**不是**成功回执', () => {
    const port = createCollectingMaterializationPort();
    const req = request();
    const result = port.materialize(req);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('不应成功');
    expect(result.failure.kind).toBe('builder_failed');
    expect(result.failure.artifact_id).toBe(req.artifact_id);
    expect(result.failure.detail).toContain('不产出真实字节');
    expect(result.failure.at).toBe(0);
  });

  it('请求与结果都按到达顺序收集，clear() 清空', () => {
    const port = createCollectingMaterializationPort();
    port.materialize(request());
    port.materialize(request({ task_revision: asRevision(3) }));
    expect(port.requests).toHaveLength(2);
    expect(port.results).toHaveLength(2);
    expect(port.requests[1]?.task_revision).toBe(3);
    expect(Object.isFrozen(port.requests)).toBe(true);
    port.clear();
    expect(port.requests).toEqual([]);
    expect(port.results).toEqual([]);
  });

  it('显式注入应答器才能拿到成功路径（I-1：无回读不得称交付）', () => {
    const port = createCollectingMaterializationPort((req) =>
      materializationSuccess(receiptFor(req)),
    );
    const result = port.materialize(request());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('应成功');
    expect(result.receipt.final_path).toBe(request().plan.final_path);
    expect(result.receipt.readback_digest).toBe('sha256:readback-abc');
    expect(result.receipt.entry_count).toBe(7);
    expect(result.receipt.verifier).toBe('fs-port');
    expect(result.receipt.at).toBe(AT);
  });

  it('五种失败种类都能原样穿过端口（种类是与记录同源的封闭枚举）', () => {
    for (const kind of ARTIFACT_FAILURE_KINDS) {
      const port = createCollectingMaterializationPort((req) =>
        materializationFailure(req, kind, `模拟 ${kind}`, AT),
      );
      const result = port.materialize(request());
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('不应成功');
      expect(result.failure.kind).toBe(kind);
      expect(result.failure.at).toBe(AT);
    }
    expect([...ARTIFACT_FAILURE_KINDS]).toEqual([
      'missing_fact',
      'builder_failed',
      'write_failed',
      'version_stale',
      'self_check_failed',
    ]);
  });

  it('失败必须带说明：detail 为空 ⇒ 抛（不得静默失败）', () => {
    expect(() => materializationFailure(request(), 'write_failed', '', AT)).toThrow(
      /detail 不能为空/,
    );
  });

  it('端口实现不抛错：收集型端口对任何请求都返回结果对象', () => {
    const port = createCollectingMaterializationPort();
    expect(() => port.materialize(request())).not.toThrow();
    expect(port.results).toHaveLength(1);
  });
});

describe('回执可直接嵌进产物记录（接缝闭合）', () => {
  it('端口回执满足 published 的构造期不变量（含回读摘要与验证者）', () => {
    const req = request();
    const port = createCollectingMaterializationPort((r) => materializationSuccess(receiptFor(r)));
    const result = port.materialize(req);
    if (!result.ok) throw new Error('应成功');

    const record = createArtifactRecord({
      artifact_id: req.artifact_id,
      task_id: req.task_id,
      task_revision: req.task_revision,
      artifact_version: req.plan.artifact_version,
      template_kind: req.template_kind,
      byte_length: result.receipt.byte_length,
      content_digest: result.receipt.readback_digest,
      source_fact_refs: req.fact_snapshot.map((entry) => entry.fact_ref),
      created_by_instance_id: INSTANCE,
      status: 'published',
      verifications: [
        { kind: 'structural_self_check', outcome: 'pass', detail: '部件齐全' },
        { kind: 'independent_readback', outcome: 'pass', detail: 'zipfile + unzip -t 通过' },
      ],
      receipt: result.receipt,
      created_at: AT,
    });

    expect(isDeliveredArtifact(record)).toBe(true);
    expect(record.receipt?.final_path).toBe(req.plan.final_path);
    expect(record.source_fact_refs).toEqual([asFactRef('fact-headcount')]);
    expect(record.mime_type).toBe(req.plan.mime_type);
  });

  it('失败结果可以原样落成 failed 记录（failure_kind 与端口种类同枚举）', () => {
    const req = request();
    const port = createCollectingMaterializationPort();
    const result = port.materialize(req);
    if (result.ok) throw new Error('应失败');

    const record = createArtifactRecord({
      artifact_id: req.artifact_id,
      task_id: req.task_id,
      task_revision: req.task_revision,
      artifact_version: req.plan.artifact_version,
      template_kind: req.template_kind,
      byte_length: 0,
      content_digest: 'sha256:none',
      source_fact_refs: req.fact_snapshot.map((entry) => entry.fact_ref),
      created_by_instance_id: INSTANCE,
      status: 'failed',
      failure_kind: result.failure.kind,
      created_at: AT,
    });
    expect(record.status).toBe('failed');
    expect(record.failure_kind).toBe('builder_failed');
    expect(isDeliveredArtifact(record)).toBe(false);
  });
});

describe('可读描述（证据 / 断言失败信息用）', () => {
  it('成功与失败各给出可指认的一句话', () => {
    const req = request();
    const ok = materializationSuccess(receiptFor(req));
    const bad = materializationFailure(req, 'missing_fact', '人数未知', AT);
    expect(describeMaterializationResult(ok)).toContain(req.plan.final_path);
    expect(describeMaterializationResult(ok)).toContain('sha256:readback-abc');
    expect(describeMaterializationResult(bad)).toContain('missing_fact');
    expect(describeMaterializationResult(bad)).toContain('人数未知');
  });

  it('materializationSuccess 返回冻结结果', () => {
    const result = materializationSuccess(receiptFor(request()));
    expect(Object.isFrozen(result)).toBe(true);
    if (!result.ok) throw new Error('应成功');
    expect(Object.isFrozen(result.receipt)).toBe(true);
  });

  it('校验错误的类型是 ValidationError（与协议层一致）', () => {
    expect(() => materializationFailure(request(), 'write_failed', '', AT)).toThrow(
      ValidationError,
    );
  });
});
