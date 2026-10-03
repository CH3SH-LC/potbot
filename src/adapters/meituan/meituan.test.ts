/**
 * 美团域用例（MT-01–08 的**不依赖真实接口与账号**部分）。
 *
 * 本文件是"**不编造候选**"（MT-02）与"**不直接购买/支付**"（MT-08 / R246）
 * 这两条硬约束的机器化证据。
 */

import { describe, expect, it } from 'vitest';

import {
  applyRules,
  candidatesFromUserShare,
  describeVisibility,
  exportCandidateFacts,
  normalizeCandidate,
  partitionBySource,
  rankCandidates,
  searchCandidates,
  validateCandidate,
  type AuthorizedMeituanSearchPort,
  type Candidate,
  type RawCandidate,
  type SearchQuery,
} from './candidates.js';
import {
  classifyHandoffTarget,
  handoffToTarget,
  recordExternalInvalidation,
  recordExternalOutcome,
  recordUserReport,
  type HandoffTarget,
} from './handoff.js';
import {
  FORBIDDEN_MEITUAN_ACTIONS,
  assertNotPurchaseAction,
  externalResultWithoutReadback,
  validateMeituanTools,
} from './contract.js';
import { MEITUAN_SUBITEMS, MEITUAN_NOT_READY } from './not-ready.js';
import { countVerdicts } from '../clock/readiness.js';

const T = 1_780_000_000_000;
const QUERY: SearchQuery = { category: '火锅', location: '徐汇区', people: 4, budgetYuan: 200 };

const RAW: readonly RawCandidate[] = [
  { id: 'c1', title: '甲店', fields: { priceYuan: '120', distanceKm: '1.5', stock: '有' } },
  { id: 'c2', title: '乙店', fields: { priceYuan: '80', distanceKm: '3' } },
];

function portOk(raw: readonly RawCandidate[]): AuthorizedMeituanSearchPort {
  return { sourceId: 'iface-1', search: () => Promise.resolve({ ok: true, raw }) };
}

describe('MT-02：**不编造候选**的结构性保证', () => {
  it('没有已授权接口 ⇒ not_ready，且**候选恒为空**', async () => {
    const result = await searchCandidates(null, QUERY, T);
    expect(result.status).toBe('not_ready');
    expect(result.candidates).toEqual([]);
    if (result.status !== 'not_ready') return;
    expect(result.reason).toMatch(/不得.*模型知识|未接通/);
  });

  it('接口不可用 ⇒ unavailable，且**不**用模型知识顶替', async () => {
    const failing: AuthorizedMeituanSearchPort = {
      sourceId: 'iface-1',
      search: () => Promise.resolve({ ok: false, reason: '配额用尽' }),
    };
    const result = await searchCandidates(failing, QUERY, T);
    expect(result.status).toBe('unavailable');
    expect(result.candidates).toEqual([]);
    if (result.status === 'ok') return;
    expect(result.reason).toContain('配额用尽');
  });

  it('接口可用 ⇒ 候选逐条带来源', async () => {
    const result = await searchCandidates(portOk(RAW), QUERY, T);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.candidates).toHaveLength(2);
    for (const candidate of result.candidates) {
      expect(candidate.provenance.sourceKind).toBe('authorized_interface');
      expect(candidate.provenance.sourceRef).toBe('iface-1');
      expect(validateCandidate(candidate)).toEqual([]);
    }
  });

  it('**负例对照**：缺来源的候选一律判不合格', () => {
    const orphan: Candidate = {
      id: 'x',
      title: '来路不明',
      provenance: { sourceKind: 'authorized_interface', sourceRef: '', fetchedAtMs: T },
      price: { known: false, reason: '无' },
      stock: { known: false, reason: '无' },
      businessHours: { known: false, reason: '无' },
      route: { known: false, reason: '无' },
      distanceKm: { known: false, reason: '无' },
      structured: {},
    };
    expect(validateCandidate(orphan).join()).toMatch(/没有来源/);
  });

  it('接口返回**不合格**条目 ⇒ 整批拒绝（宁可不给）', async () => {
    const bad: AuthorizedMeituanSearchPort = {
      sourceId: 'iface-1',
      search: () => Promise.resolve({ ok: true, raw: [{ id: '', title: '', fields: {} }] }),
    };
    const result = await searchCandidates(bad, QUERY, T);
    expect(result.status).toBe('unavailable');
    expect(result.candidates).toEqual([]);
  });

  it('查询条件可见性：缺哪些条件要说明（不宣称全平台最优）', () => {
    const visibility = describeVisibility({ category: '火锅', location: '徐汇区' });
    expect(visibility.missing).toEqual(['人数', '预算', '日期', '偏好']);
    expect(visibility.note).toMatch(/不.*宣称.*全平台最优/);
  });
});

describe('MT-03：未知值分别标记，标价不是最终价', () => {
  it('缺字段 ⇒ 各自 unknown 且带原因', () => {
    const candidate = normalizeCandidate({ id: 'c9', title: '丙店', fields: { priceYuan: '50' } }, 'iface-1', T);
    expect(candidate.stock.known).toBe(false);
    expect(candidate.businessHours.known).toBe(false);
    expect(candidate.route.known).toBe(false);
    if (!candidate.stock.known) expect(candidate.stock.reason).toContain('库存');
  });

  it('价格恒为"标价"（isFinalPrice=false）', () => {
    const candidate = normalizeCandidate({ id: 'c9', title: '丙店', fields: { priceYuan: '50' } }, 'iface-1', T);
    expect(candidate.price.known).toBe(true);
    if (!candidate.price.known) return;
    expect(candidate.price.value.isFinalPrice).toBe(false);
  });
});

describe('MT-04：用户分享与在线来源**分开标识**', () => {
  it('分区结果互不混淆', () => {
    const online = normalizeCandidate(RAW[0] as RawCandidate, 'iface-1', T);
    const shared = candidatesFromUserShare([{ title: '朋友推荐', detail: '好吃', sourceRef: '聊天截图.png' }], T);
    const partition = partitionBySource([online, ...shared]);
    expect(partition.online.map((candidate) => candidate.id)).toEqual(['c1']);
    expect(partition.userShared.map((candidate) => candidate.id)).toEqual(['user-shared-1']);
    expect(partition.userShared[0]?.provenance.sourceKind).toBe('user_shared');
  });
});

describe('MT-05：规则筛选 / 排序 / 硬条件冲突，且**宣传话术不影响规则**', () => {
  const candidates = RAW.map((raw) => normalizeCandidate(raw, 'iface-1', T));

  it('硬条件：超预算被淘汰并给出原因', () => {
    const outcome = applyRules(candidates, { hard: [{ kind: 'maxPriceYuan', value: 100 }], soft: [] });
    expect(outcome.kept.map((candidate) => candidate.id)).toEqual(['c2']);
    expect(outcome.rejected[0]?.reason).toMatch(/超过上限/);
  });

  it('**缺资料不当零**：价格未知的候选不会"通过"预算条件', () => {
    const unknownPrice = candidatesFromUserShare([{ title: '未知价', detail: 'x', sourceRef: 'y' }], T);
    const outcome = applyRules(unknownPrice, { hard: [{ kind: 'maxPriceYuan', value: 999 }], soft: [] });
    expect(outcome.kept).toEqual([]);
    expect(outcome.rejected[0]?.reason).toMatch(/价格未知/);
  });

  it('硬条件把候选筛空 ⇒ 给出冲突说明（可解释）', () => {
    const outcome = applyRules(candidates, { hard: [{ kind: 'maxPriceYuan', value: 1 }], soft: [] });
    expect(outcome.kept).toEqual([]);
    expect(outcome.conflicts.length).toBeGreaterThan(0);
    expect(outcome.conflicts[0]?.reason).toMatch(/无候选剩余/);
  });

  it('排序只用结构化字段；未知值排最后且**不被丢弃**', () => {
    const unknownPrice = candidatesFromUserShare([{ title: '未知价', detail: 'x', sourceRef: 'y' }], T)[0] as Candidate;
    const ranked = rankCandidates([unknownPrice, ...candidates], [{ kind: 'preferCheaper' }]);
    expect(ranked).toHaveLength(3);
    expect(ranked[ranked.length - 1]?.id).toBe('user-shared-1');
  });

  it('**宣传话术不改变规则**：同样的结构化数据 + 不同话术 ⇒ 排序完全相同', () => {
    const plain = [
      { id: 'p1', title: 'A', fields: { priceYuan: '100', distanceKm: '2' } },
      { id: 'p2', title: 'B', fields: { priceYuan: '80', distanceKm: '5' } },
    ];
    const hyped = [
      { ...plain[0], promotionalText: '全市第一！排队三小时也值！' },
      { ...plain[1], promotionalText: '超级难吃，别去' },
    ];
    const rankedPlain = rankCandidates(
      plain.map((raw) => normalizeCandidate(raw, 'iface-1', T)),
      [{ kind: 'preferCheaper' }],
    );
    const rankedHyped = rankCandidates(
      hyped.map((raw) => normalizeCandidate(raw as RawCandidate, 'iface-1', T)),
      [{ kind: 'preferCheaper' }],
    );
    expect(rankedHyped.map((candidate) => candidate.id)).toEqual(rankedPlain.map((candidate) => candidate.id));
    // 并且话术根本没有进入模型。
    expect(Object.keys(rankedHyped[0]?.structured ?? {})).not.toContain('promotionalText');
  });
});

describe('MT-06：导出获准事实保留来源与时间', () => {
  it('只导出**已知**的价格，且带来源与观测时间', () => {
    const candidates = RAW.map((raw) => normalizeCandidate(raw, 'iface-1', T));
    const facts = exportCandidateFacts(candidates);
    expect(facts.map((fact) => fact.key)).toEqual(['candidate:c1:priceYuan', 'candidate:c2:priceYuan']);
    for (const fact of facts) {
      expect(fact.sourceRef).toBe('iface-1');
      expect(fact.observedAtMs).toBe(T);
      expect(fact.kind).toBe('fact');
    }
    // 未知价格不导出（不编造事实）。
    const unknownPrice = candidatesFromUserShare([{ title: 'x', detail: 'd', sourceRef: 's' }], T);
    expect(exportCandidateFacts(unknownPrice)).toEqual([]);
  });
});

describe('MT-07：交接前的四种失败**分别处理**', () => {
  const target: HandoffTarget = {
    kind: 'deeplink',
    uri: 'meituan://shop/c1',
    candidateId: 'c1',
    selectionRevision: 3,
    expiresAtMs: T + 60_000,
  };
  const good = { appInstalled: true, linkValid: true, targetMatches: true };

  it('全部通过 ⇒ ready', () => {
    expect(classifyHandoffTarget(target, good, 3, T).kind).toBe('ready');
  });

  it('App 未安装 / 链接过期 / 目标不符 / 参数过期 分别给出不同 code', () => {
    const codes = [
      classifyHandoffTarget(target, { ...good, appInstalled: false }, 3, T),
      classifyHandoffTarget(target, { ...good, linkValid: false }, 3, T),
      classifyHandoffTarget(target, { ...good, targetMatches: false }, 3, T),
      classifyHandoffTarget(target, good, 4, T),
      classifyHandoffTarget(target, good, 3, T + 120_000),
    ].map((result) => (result.kind === 'failure' ? result.code : 'ready'));
    expect(codes).toEqual([
      'app_not_installed',
      'link_expired',
      'target_mismatch',
      'stale_selection',
      'link_expired',
    ]);
  });
});

describe('MT-08：七态 —— 不把交接记为购买成功', () => {
  it('交接成功最高只到"已交接"，**永不**"已确认完成"', async () => {
    const result = await handoffToTarget(
      { open: () => Promise.resolve({ delivered: true, handlerLabel: '美团', detail: '已打开' }) },
      {
        kind: 'ready',
        target: { kind: 'deeplink', uri: 'meituan://x', candidateId: 'c1', selectionRevision: 1, expiresAtMs: null },
      },
    );
    expect(result.state).toBe('handed_off');
    expect(result.state).not.toBe('confirmed');
    expect(result.notes.join()).toMatch(/不等于写入/);
  });

  it('打开失败 ⇒ 判失败', async () => {
    const result = await handoffToTarget(
      { open: () => Promise.resolve({ delivered: false, handlerLabel: null, detail: '无应用' }) },
      {
        kind: 'ready',
        target: { kind: 'deeplink', uri: 'meituan://x', candidateId: 'c1', selectionRevision: 1, expiresAtMs: null },
      },
    );
    expect(result.state).toBe('failed');
  });

  it('外部结果不可读 ⇒ 结果未知（不记为购买成功、不盲目重试）', () => {
    const result = recordExternalOutcome('handed_off', { readable: false, detail: '页面没有可读回执' });
    expect(result.state).toBe('unknown');
    expect(result.notes.join()).toMatch(/不记为购买成功|不盲目重试/);
  });

  it('外部结果**可读回**且带观测 ⇒ 才可以确认完成', () => {
    const result = recordExternalOutcome('handed_off', {
      readable: true,
      detail: '订单已存在',
      observed: { orderId: 'o-1' },
    });
    expect(result.state).toBe('confirmed');
    expect(result.receipt.kind).toBe('readback');
  });

  it('用户口述 ⇒ 用户报告完成（不升级为系统确认）', () => {
    const result = recordUserReport('handed_off', '我下好了');
    expect(result.state).toBe('user_reported');
    expect(result.state).not.toBe('confirmed');
    expect(result.notes.join()).toMatch(/不是.*系统回执/);
  });

  it('已确认完成的事实在外部被废止 ⇒ 只能以 expired 失效', () => {
    const result = recordExternalInvalidation('confirmed', '商家取消了订单');
    expect(result.state).toBe('failed');
  });
});

describe('MT-08 / R246：不直接购买或支付', () => {
  it('工具集合自洽且无不可撤销副作用', () => {
    expect(validateMeituanTools()).toEqual([]);
  });

  it('**负例**：支付类动作名一律被拒', () => {
    for (const forbidden of FORBIDDEN_MEITUAN_ACTIONS) {
      expect(() => assertNotPurchaseAction(forbidden)).toThrow(/不直接购买\/支付/);
    }
    expect(() => assertNotPurchaseAction('search')).not.toThrow();
  });

  it('不可读的外部结果有既定的如实结论', () => {
    const conclusion = externalResultWithoutReadback();
    expect(conclusion.state).toBe('unknown');
    expect(conclusion.note).toMatch(/保留「结果未知」/);
  });
});

describe('MT 就绪度（R231 / R233）', () => {
  it('八个子项齐全且自洽', () => {
    expect(MEITUAN_SUBITEMS.map((entry) => entry.id)).toEqual([
      'MT-01',
      'MT-02',
      'MT-03',
      'MT-04',
      'MT-05',
      'MT-06',
      'MT-07',
      'MT-08',
    ]);
    for (const entry of MEITUAN_SUBITEMS) {
      if (entry.verdict === 'implemented') expect(entry.evidence.length).toBeGreaterThan(0);
      else expect(entry.reason).not.toBeNull();
    }
  });

  it('三态计数可复算；购买通道显式记**阻塞**（合同禁止，不是"以后做"）', () => {
    const counts = countVerdicts(MEITUAN_SUBITEMS);
    expect(counts.implemented + counts.not_ready + counts.blocked).toBe(8);
    const blocked = MEITUAN_NOT_READY.filter((entry) => entry.verdict === 'blocked').map((entry) => entry.id);
    expect(blocked).toContain('meituan_purchase_channel');
  });

  it('未就绪项都给了原因与解锁条件', () => {
    for (const capability of MEITUAN_NOT_READY) {
      expect(capability.reason.length).toBeGreaterThan(0);
      expect(capability.unblockedBy.length).toBeGreaterThan(0);
    }
  });
});
