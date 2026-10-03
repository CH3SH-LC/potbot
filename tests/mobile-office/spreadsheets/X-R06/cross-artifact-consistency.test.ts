/**
 * **X-R06** 独立验收：单位 / 金额 / 事实版本跨文档与幻灯片一致性（契约层）。
 *
 * 判据不照抄实现：权威是「同版事实快照」，每个车道必须**分别**对齐它；文档与幻灯片之间
 * 再由本层做**两两分歧**探测。金额一律以定点 `bigint` 比较，**不经过浮点**。
 *
 * 分组：
 * 1. 全绿正例（三车道对齐同版权威）；
 * 2. 版本错（过期 / 超前）；
 * 3. 单位 / 币种错（**反面对照，咬得住**）；
 * 4. 金额错（跨精度对齐后仍不同才判错；同值不同 scale 不得误报）；
 * 5. 缺失与未知键（**缺失不当零**：`claimed_display` 为 `null`）；
 * 6. 值类型错（金额 vs 文本）；
 * 7. 产物间两两分歧（文档 vs 幻灯片）；
 * 8. 确定性（输入顺序无关，摘要逐字节一致）；
 * 9. 车道契约状态（缺另组 ⇒ `contract-only`，不冒充 `wired`）；
 * 10. 发布通道接线探测（未接 ⇒ `not-wired`，`claimed_published` 恒 `false`）；
 * 11. 输入校验（重复权威键 / 非法 scale 必须抛 `ValidationError`）。
 */

import { describe, expect, it } from 'vitest';

import { ValidationError, asLogicalTime } from '../../../../src/protocol/index.js';
import { type Quantity, parseQuantity } from '../../../../src/spreadsheets/quantity.js';
import type { CrossTemplatePublishPort } from '../../../../src/spreadsheets/facts-binding.js';
import {
  type ArtifactFactClaim,
  type ExpectedFact,
  checkCrossArtifactConsistency,
  checkPublicationWiring,
  describeLaneContractStateViaReport,
} from './cross-artifact-consistency.js';

/* -------------------------------------------------------------------------
 * fixtures
 * ---------------------------------------------------------------------- */

/** 逻辑时间（无墙钟；测试内固定值）。 */
const T0 = asLogicalTime(0);

/** 权威金额事实：预算 19.99 元（CNY），版本 2。 */
function budgetExpected(): ExpectedFact {
  return {
    fact_key: 'budget.total',
    version: 2,
    value: { kind: 'amount', quantity: parseQuantity('19.99', 2, 'cny', 'CNY') },
  };
}

/** 权威文本事实：项目名，版本 1。 */
function projectExpected(): ExpectedFact {
  return { fact_key: 'project.name', version: 1, value: { kind: 'text', text: '海棠计划' } };
}

function amountClaim(
  target: ArtifactFactClaim['target'],
  version: number,
  quantity: Quantity,
  verification_mode: ArtifactFactClaim['verification_mode'] = 'fixture',
): ArtifactFactClaim {
  return {
    target,
    artifact_id: `${target}:primary`,
    fact_key: 'budget.total',
    fact_version: version,
    value: { kind: 'amount', quantity },
    verification_mode,
  };
}

function cny(amount: string, scale = 2): Quantity {
  return parseQuantity(amount, scale, 'cny', 'CNY');
}

/* -------------------------------------------------------------------------
 * 1. 全绿
 * ---------------------------------------------------------------------- */

describe('X-R06 §1 全绿正例', () => {
  it('三车道均对齐同版权威 ⇒ consistent，且每个 (target,fact) 都是 ok', () => {
    const report = checkCrossArtifactConsistency({
      snapshot_id: 'snap-1',
      generated_at: T0,
      expected: [budgetExpected(), projectExpected()],
      claims: [
        amountClaim('spreadsheet', 2, cny('19.99'), 'real'),
        amountClaim('docx', 2, cny('19.99')),
        amountClaim('pptx', 2, cny('19.99')),
        {
          target: 'docx',
          artifact_id: 'docx:primary',
          fact_key: 'project.name',
          fact_version: 1,
          value: { kind: 'text', text: '海棠计划' },
          verification_mode: 'fixture',
        },
        {
          target: 'pptx',
          artifact_id: 'pptx:primary',
          fact_key: 'project.name',
          fact_version: 1,
          value: { kind: 'text', text: '海棠计划' },
          verification_mode: 'fixture',
        },
        {
          target: 'spreadsheet',
          artifact_id: 'sheet:primary',
          fact_key: 'project.name',
          fact_version: 1,
          value: { kind: 'text', text: '海棠计划' },
          verification_mode: 'real',
        },
      ],
    });
    expect(report.consistent).toBe(true);
    expect(report.divergences.length).toBe(0);
    expect(report.violation_counts).toEqual({});
    expect(report.findings.every((finding) => finding.verdict === 'ok')).toBe(true);
  });
});

/* -------------------------------------------------------------------------
 * 2. 版本错
 * ---------------------------------------------------------------------- */

describe('X-R06 §2 版本一致性', () => {
  it('文档声明旧版本（v1 < v2）⇒ stale_version，且指明期望版本', () => {
    const report = checkCrossArtifactConsistency({
      snapshot_id: 'snap-1',
      generated_at: T0,
      expected: [budgetExpected()],
      claims: [
        amountClaim('spreadsheet', 2, cny('19.99'), 'real'),
        amountClaim('docx', 1, cny('18.00')),
        amountClaim('pptx', 2, cny('19.99')),
      ],
    });
    const docx = report.findings.find((finding) => finding.target === 'docx');
    expect(docx?.verdict).toBe('stale_version');
    expect(docx?.expected_version).toBe(2);
    expect(docx?.claimed_version).toBe(1);
    expect(report.violation_counts.stale_version).toBe(1);
    expect(report.consistent).toBe(false);
  });

  it('幻灯片声明超前版本（v3 > v2）⇒ ahead_version', () => {
    const report = checkCrossArtifactConsistency({
      snapshot_id: 'snap-1',
      generated_at: T0,
      expected: [budgetExpected()],
      claims: [
        amountClaim('spreadsheet', 2, cny('19.99'), 'real'),
        amountClaim('docx', 2, cny('19.99')),
        amountClaim('pptx', 3, cny('19.99')),
      ],
    });
    const pptx = report.findings.find((finding) => finding.target === 'pptx');
    expect(pptx?.verdict).toBe('ahead_version');
    expect(pptx?.claimed_version).toBe(3);
  });
});

/* -------------------------------------------------------------------------
 * 3. 单位 / 币种（反面对照）
 * ---------------------------------------------------------------------- */

describe('X-R06 §3 单位与币种（反面对照）', () => {
  it('单位不同（cny vs USD）⇒ unit_mismatch', () => {
    const report = checkCrossArtifactConsistency({
      snapshot_id: 'snap-1',
      generated_at: T0,
      expected: [budgetExpected()],
      claims: [
        amountClaim('spreadsheet', 2, cny('19.99'), 'real'),
        amountClaim('docx', 2, parseQuantity('19.99', 2, 'USD', null)),
        amountClaim('pptx', 2, cny('19.99')),
      ],
    });
    expect(report.findings.find((finding) => finding.target === 'docx')?.verdict).toBe('unit_mismatch');
  });

  it('单位同但币种不同（cny/CNY vs cny/USD）⇒ currency_mismatch（不误判成 ok）', () => {
    const report = checkCrossArtifactConsistency({
      snapshot_id: 'snap-1',
      generated_at: T0,
      expected: [budgetExpected()],
      claims: [
        amountClaim('spreadsheet', 2, cny('19.99'), 'real'),
        amountClaim('docx', 2, parseQuantity('19.99', 2, 'cny', 'USD')),
        amountClaim('pptx', 2, cny('19.99')),
      ],
    });
    expect(report.findings.find((finding) => finding.target === 'docx')?.verdict).toBe('currency_mismatch');
  });

  it('反面对照：数值相同、单位不同，绝不得被并成 ok', () => {
    const report = checkCrossArtifactConsistency({
      snapshot_id: 'snap-1',
      generated_at: T0,
      expected: [budgetExpected()],
      claims: [
        amountClaim('spreadsheet', 2, cny('19.99'), 'real'),
        amountClaim('docx', 2, parseQuantity('19.99', 2, 'usd', 'USD')),
        amountClaim('pptx', 2, cny('19.99')),
      ],
    });
    const docx = report.findings.find((finding) => finding.target === 'docx');
    expect(docx?.verdict).not.toBe('ok');
    expect(['unit_mismatch', 'currency_mismatch']).toContain(docx?.verdict);
  });
});

/* -------------------------------------------------------------------------
 * 4. 金额
 * ---------------------------------------------------------------------- */

describe('X-R06 §4 金额一致性（定点，无浮点）', () => {
  it('数值不同（20.00 vs 19.99）⇒ amount_mismatch', () => {
    const report = checkCrossArtifactConsistency({
      snapshot_id: 'snap-1',
      generated_at: T0,
      expected: [budgetExpected()],
      claims: [
        amountClaim('spreadsheet', 2, cny('19.99'), 'real'),
        amountClaim('docx', 2, cny('20.00')),
        amountClaim('pptx', 2, cny('19.99')),
      ],
    });
    const docx = report.findings.find((finding) => finding.target === 'docx');
    expect(docx?.verdict).toBe('amount_mismatch');
    expect(docx?.reason).toContain('19.99');
    expect(docx?.reason).toContain('20.00');
  });

  it('同值不同 scale（19.99@2 vs 19.990@3）⇒ ok，不得误报', () => {
    const report = checkCrossArtifactConsistency({
      snapshot_id: 'snap-1',
      generated_at: T0,
      expected: [budgetExpected()],
      claims: [
        amountClaim('spreadsheet', 2, cny('19.99'), 'real'),
        amountClaim('docx', 2, parseQuantity('19.990', 3, 'cny', 'CNY')),
        amountClaim('pptx', 2, cny('19.99')),
      ],
    });
    expect(report.consistent).toBe(true);
  });

  it('定点比较不受浮点污染：0.1+0.2 的十进制展开若被当输入应被 parseQuantity 拒绝', () => {
    // 调用方若已经在浮点里丢了精度，parseQuantity 会显式失败——这里核对本层沿用了该纪律。
    expect(() => parseQuantity(0.1 + 0.2, 2, 'cny', 'CNY')).toThrow(ValidationError);
  });
});

/* -------------------------------------------------------------------------
 * 5. 缺失与未知键
 * ---------------------------------------------------------------------- */

describe('X-R06 §5 缺失与未知键（缺失不当零）', () => {
  it('权威有事实、某车道无声明 ⇒ missing_claim，claimed_display 为 null（不是 "0"）', () => {
    const report = checkCrossArtifactConsistency({
      snapshot_id: 'snap-1',
      generated_at: T0,
      expected: [budgetExpected()],
      claims: [
        amountClaim('spreadsheet', 2, cny('19.99'), 'real'),
        amountClaim('docx', 2, cny('19.99')),
        // pptx 刻意缺席
      ],
    });
    const pptx = report.findings.find((finding) => finding.target === 'pptx');
    expect(pptx?.verdict).toBe('missing_claim');
    expect(pptx?.claimed_version).toBeNull();
    expect(pptx?.claimed_display).toBeNull();
    expect(pptx?.claimed_display).not.toBe('0');
    expect(report.violation_counts.missing_claim).toBe(1);
  });

  it('声明引用权威里没有的键 ⇒ unknown_fact', () => {
    const report = checkCrossArtifactConsistency({
      snapshot_id: 'snap-1',
      generated_at: T0,
      expected: [budgetExpected()],
      claims: [
        amountClaim('spreadsheet', 2, cny('19.99'), 'real'),
        amountClaim('docx', 2, cny('19.99')),
        amountClaim('pptx', 2, cny('19.99')),
        {
          target: 'docx',
          artifact_id: 'docx:extra',
          fact_key: 'ghost.fact',
          fact_version: 1,
          value: { kind: 'amount', quantity: cny('1.00') },
          verification_mode: 'fixture',
        },
      ],
    });
    expect(report.findings.find((finding) => finding.fact_key === 'ghost.fact')?.verdict).toBe('unknown_fact');
  });
});

/* -------------------------------------------------------------------------
 * 6. 值类型
 * ---------------------------------------------------------------------- */

describe('X-R06 §6 值类型一致性', () => {
  it('权威是金额、声明是文本 ⇒ value_kind_mismatch（不静默转字符串比较）', () => {
    const report = checkCrossArtifactConsistency({
      snapshot_id: 'snap-1',
      generated_at: T0,
      expected: [budgetExpected()],
      claims: [
        amountClaim('spreadsheet', 2, cny('19.99'), 'real'),
        {
          target: 'docx',
          artifact_id: 'docx:primary',
          fact_key: 'budget.total',
          fact_version: 2,
          value: { kind: 'text', text: '19.99' },
          verification_mode: 'fixture',
        },
        amountClaim('pptx', 2, cny('19.99')),
      ],
    });
    expect(report.findings.find((finding) => finding.target === 'docx')?.verdict).toBe('value_kind_mismatch');
  });
});

/* -------------------------------------------------------------------------
 * 7. 产物间两两分歧
 * ---------------------------------------------------------------------- */

describe('X-R06 §7 产物间分歧（文档 vs 幻灯片）', () => {
  it('权威是第三个值时，两产物即便都 ≠ ok，彼此分歧仍被单独报出', () => {
    const expected: ExpectedFact = {
      fact_key: 'budget.total',
      version: 2,
      value: { kind: 'amount', quantity: cny('19.98') },
    };
    const report = checkCrossArtifactConsistency({
      snapshot_id: 'snap-1',
      generated_at: T0,
      expected: [expected],
      claims: [
        amountClaim('spreadsheet', 2, cny('19.98'), 'real'),
        amountClaim('docx', 2, cny('19.99')),
        amountClaim('pptx', 2, cny('20.00')),
      ],
    });
    expect(report.divergences.length).toBeGreaterThanOrEqual(2);
    const pairDocPpt = report.divergences.find(
      (divergence) =>
        (divergence.left_target === 'docx' && divergence.right_target === 'pptx') ||
        (divergence.left_target === 'pptx' && divergence.right_target === 'docx'),
    );
    expect(pairDocPpt).toBeDefined();
    expect(pairDocPpt?.fact_key).toBe('budget.total');
  });

  it('单位不同也算分歧（文档 cny vs 幻灯片 USD）', () => {
    const report = checkCrossArtifactConsistency({
      snapshot_id: 'snap-1',
      generated_at: T0,
      expected: [budgetExpected()],
      claims: [
        amountClaim('spreadsheet', 2, cny('19.99'), 'real'),
        amountClaim('docx', 2, cny('19.99')),
        amountClaim('pptx', 2, parseQuantity('19.99', 2, 'USD', null)),
      ],
    });
    expect(report.divergences.some((divergence) => divergence.fact_key === 'budget.total')).toBe(true);
    // 两条金额车道（docx / pptx）之间的单位分歧要被抓出来。
    expect(report.divergences.some((d) => d.reason.includes('unit_mismatch'))).toBe(true);
  });

  it('三车道完全一致 ⇒ 无分歧', () => {
    const report = checkCrossArtifactConsistency({
      snapshot_id: 'snap-1',
      generated_at: T0,
      expected: [budgetExpected()],
      claims: [
        amountClaim('spreadsheet', 2, cny('19.99'), 'real'),
        amountClaim('docx', 2, cny('19.99')),
        amountClaim('pptx', 2, cny('19.99')),
      ],
    });
    expect(report.divergences).toEqual([]);
  });
});

/* -------------------------------------------------------------------------
 * 8. 确定性
 * ---------------------------------------------------------------------- */

describe('X-R06 §8 确定性', () => {
  it('声明与权威顺序颠倒 ⇒ findings 与 review_digest 逐字节一致', () => {
    const expected = [budgetExpected(), projectExpected()];
    const claims: ArtifactFactClaim[] = [
      amountClaim('spreadsheet', 2, cny('19.99'), 'real'),
      amountClaim('docx', 2, cny('19.99')),
      amountClaim('pptx', 2, cny('19.99')),
    ];
    const forward = checkCrossArtifactConsistency({
      snapshot_id: 'snap-1',
      generated_at: T0,
      expected,
      claims,
    });
    const backward = checkCrossArtifactConsistency({
      snapshot_id: 'snap-1',
      generated_at: T0,
      expected: [...expected].reverse(),
      claims: [...claims].reverse(),
    });
    expect(backward.review_digest).toBe(forward.review_digest);
    expect(JSON.stringify(backward.findings)).toBe(JSON.stringify(forward.findings));
  });

  it('快照 id 变化 ⇒ 摘要变化（摘要有实质输入）', () => {
    const base = {
      generated_at: T0,
      expected: [budgetExpected()],
      claims: [amountClaim('spreadsheet', 2, cny('19.99'), 'real')],
    };
    const a = checkCrossArtifactConsistency({ snapshot_id: 'snap-a', ...base });
    const b = checkCrossArtifactConsistency({ snapshot_id: 'snap-b', ...base });
    expect(a.review_digest).not.toBe(b.review_digest);
  });
});

/* -------------------------------------------------------------------------
 * 9. 车道契约状态
 * ---------------------------------------------------------------------- */

describe('X-R06 §9 车道契约状态（缺另组只关契约层）', () => {
  it('未接线时 docx/pptx 标 contract-only，spreadsheet 标 wired', () => {
    const report = checkCrossArtifactConsistency({
      snapshot_id: 'snap-1',
      generated_at: T0,
      expected: [budgetExpected()],
      claims: [amountClaim('spreadsheet', 2, cny('19.99'), 'real')],
    });
    const byTarget = describeLaneContractStateViaReport(report);
    expect(byTarget.get('spreadsheet')).toBe('wired');
    expect(byTarget.get('docx')).toBe('contract-only');
    expect(byTarget.get('pptx')).toBe('contract-only');
  });

  it('显式声明 docx 已接线 ⇒ 该车道标 wired', () => {
    const report = checkCrossArtifactConsistency({
      snapshot_id: 'snap-1',
      generated_at: T0,
      expected: [budgetExpected()],
      claims: [amountClaim('spreadsheet', 2, cny('19.99'), 'real')],
      wired_targets: ['docx'],
    });
    const byTarget = describeLaneContractStateViaReport(report);
    expect(byTarget.get('docx')).toBe('wired');
    expect(byTarget.get('pptx')).toBe('contract-only');
  });
});

/* -------------------------------------------------------------------------
 * 10. 发布通道接线探测
 * ---------------------------------------------------------------------- */

describe('X-R06 §10 发布通道接线探测', () => {
  it('无通道 ⇒ docx/pptx 均 not-wired，claimed_published 恒 false', async () => {
    const wiring = await checkPublicationWiring([]);
    expect(wiring.map((entry) => entry.target)).toEqual(['docx', 'pptx']);
    expect(wiring.every((entry) => entry.wire_state === 'not-wired')).toBe(true);
    expect(wiring.every((entry) => entry.acknowledged === false)).toBe(true);
    expect(wiring.every((entry) => entry.claimed_published === false)).toBe(true);
  });

  it('提供返回回执的通道 ⇒ published 且 acknowledged=true，但 claimed_published 仍 false', async () => {
    const channel: CrossTemplatePublishPort = {
      target: 'docx',
      publish: () => Promise.resolve({ ok: true, receipt_ref: 'rcpt-1' }),
    };
    const wiring = await checkPublicationWiring([channel]);
    const docx = wiring.find((entry) => entry.target === 'docx');
    expect(docx?.wire_state).toBe('published');
    expect(docx?.acknowledged).toBe(true);
    // 受理回执 ≠ 已在用户可见处生效。
    expect(docx?.claimed_published).toBe(false);
    expect(wiring.find((entry) => entry.target === 'pptx')?.wire_state).toBe('not-wired');
  });

  it('通道失败 ⇒ failed，且不产生回执', async () => {
    const channel: CrossTemplatePublishPort = {
      target: 'pptx',
      publish: () => Promise.resolve({ ok: false, reason: 'pool offline' }),
    };
    const wiring = await checkPublicationWiring([channel]);
    const pptx = wiring.find((entry) => entry.target === 'pptx');
    expect(pptx?.wire_state).toBe('failed');
    expect(pptx?.acknowledged).toBe(false);
    expect(pptx?.claimed_published).toBe(false);
  });
});

/* -------------------------------------------------------------------------
 * 11. 输入校验
 * ---------------------------------------------------------------------- */

describe('X-R06 §11 输入校验', () => {
  it('权威键重复 ⇒ ValidationError（单一来源）', () => {
    expect(() =>
      checkCrossArtifactConsistency({
        snapshot_id: 'snap-1',
        generated_at: T0,
        expected: [budgetExpected(), budgetExpected()],
        claims: [],
      }),
    ).toThrow(ValidationError);
  });

  it('非法 scale ⇒ ValidationError', () => {
    expect(() =>
      checkCrossArtifactConsistency({
        snapshot_id: 'snap-1',
        generated_at: T0,
        expected: [
          {
            fact_key: 'bad',
            version: 1,
            value: { kind: 'amount', quantity: { amount_minor: 1n, scale: 99, unit: 'x', currency: null } },
          },
        ],
        claims: [],
      }),
    ).toThrow(ValidationError);
  });

  it('非法目标车道 ⇒ ValidationError', () => {
    expect(() =>
      checkCrossArtifactConsistency({
        snapshot_id: 'snap-1',
        generated_at: T0,
        expected: [budgetExpected()],
        claims: [
          {
            target: 'keynote' as unknown as ArtifactFactClaim['target'],
            artifact_id: 'x',
            fact_key: 'budget.total',
            fact_version: 1,
            value: { kind: 'amount', quantity: cny('1.00') },
            verification_mode: 'fixture',
          },
        ],
      }),
    ).toThrow(ValidationError);
  });

  it('空 snapshot_id ⇒ ValidationError', () => {
    expect(() =>
      checkCrossArtifactConsistency({ snapshot_id: '', generated_at: T0, expected: [], claims: [] }),
    ).toThrow(ValidationError);
  });
});
