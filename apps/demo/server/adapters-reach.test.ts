/**
 * FA-WIRE-ADAPTERS-REACH —— 7 个"此前产品不可达"模块的**可达性自证 + 真实消费**测试。
 *
 * ## 覆盖的判据（每条都真跑）
 *
 * | 判据 | 用例组 |
 * |---|---|
 * | 逐模块 `import` + **真实调用**，且清单与实现一致 | M |
 * | barrel 真的把同一函数挂出来（`barrel.x === module.x`，不是"有个同名东西"） | M |
 * | 每个模块都有**真实 HTTP 消费点**且**产品路径可到达** | P / F |
 * | 未就绪 / 无端口 ⇒ **结构化拒绝**（不是 500、不是假装可用） | P |
 * | 每条至少一条**坏路径被拒**（R246 / MT-02 / MT-06 / CLK-07） | P / F |
 *
 * 全部经 `createDemoRequestHandler`（**产品入口**）而不是直连库函数 ——
 * 测的是"从产品能到达"，不是"函数存在"。
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDemoRequestHandler } from './http.js';
import { createAdaptersHost, type AdaptersHost } from './adapters-host.js';
import { ADAPTERS_MODULES_REACHABLE, EXTRA_ADAPTERS_ROOT } from './adapters-extra-routes.js';
import type { KernelHost } from './kernel.js';

// --- 逐模块直连导入（可达性自证的一半）--------------------------------------
import * as candidateModel from '../../../src/adapters/meituan/candidate-model.js';
import * as candidateDetail from '../../../src/adapters/meituan/candidate-detail.js';
import * as compareModule from '../../../src/adapters/meituan/compare.js';
import * as shareIntake from '../../../src/adapters/meituan/share-intake.js';
import * as factPublication from '../../../src/adapters/meituan/fact-publication.js';
import * as handoffVerify from '../../../src/adapters/meituan/handoff-verify.js';
import * as reminderRestore from '../../../src/adapters/clock/reminder-restore.js';

// --- barrel（"可达"的定义：barrel 少一条导出即编译失败）----------------------
import * as meituanBarrel from '../../../src/adapters/meituan/index.js';
import * as clockBarrel from '../../../src/adapters/clock/index.js';

import { createFixedZonePort, type AlarmRecord } from '../../../src/adapters/clock/index.js';
import type {
  AuthorizedMeituanDetailPort,
  AuthorizedMeituanSearchPort,
  Candidate,
  FactPublicationPort,
  HandoffLinkPort,
  KnownValue,
  MeituanHandoffPort,
  ShareExtractionPort,
  UserRules,
} from '../../../src/adapters/meituan/index.js';

// ---------------------------------------------------------------------------
// 固定时刻与夹具
// ---------------------------------------------------------------------------

/** 2026-10-03T08:00:00Z —— 固定墙钟，测试确定性。 */
const NOW_MS = Date.UTC(2026, 9, 3, 8, 0, 0);

type Json = Record<string, any>;

/** 让路由可被 `/health` 之外的东西调用；本套件只打 `/api/adapters/**`。 */
const stubHost = {
  health: () => ({ ready: true, bootId: 'test-boot' }),
} as unknown as KernelHost;

const MEITUAN_SOURCE = 'mt-source-1';

function known<T>(value: T): KnownValue<T> {
  return { known: true, value };
}

function candidateFixture(id: string, overrides: Partial<Candidate> = {}): Candidate {
  return {
    id,
    title: `店-${id}`,
    provenance: { sourceKind: 'authorized_interface', sourceRef: MEITUAN_SOURCE, fetchedAtMs: NOW_MS },
    price: known({ amountYuan: 88, currency: 'CNY', condition: null, isFinalPrice: false }),
    stock: known('充足'),
    businessHours: known('10:00-22:00'),
    route: known('步行 5 分钟'),
    distanceKm: known(1.2),
    structured: {},
    ...overrides,
  };
}

const NO_RULES: UserRules = Object.freeze({ hard: Object.freeze([]), soft: Object.freeze([]) });

/** 一条确定可调度的自管提醒（每天 17:00 Asia/Shanghai，绝对锚点 NOW+1h）。 */
const ALARM_RECORD: AlarmRecord = {
  id: 'alarm-reach-1',
  ownership: 'self_managed',
  label: '起床',
  zoneId: 'Asia/Shanghai',
  firstTriggerMs: NOW_MS + 3_600_000,
  repeat: { kind: 'daily', interval: 1 },
  enabled: true,
  revision: 1,
  createdAtMs: NOW_MS,
  skippedDates: [],
};

// ---------------------------------------------------------------------------
// 假端口（**只存在于测试**；产品路径一个都不注入）
// ---------------------------------------------------------------------------

const searchPort: AuthorizedMeituanSearchPort = {
  sourceId: MEITUAN_SOURCE,
  async search() {
    return {
      ok: true,
      raw: [
        { id: 'c-1', title: '火锅A', fields: { priceYuan: '88', distanceKm: '1.2' }, promotionalText: '全网最低！' },
        { id: 'c-2', title: '火锅B', fields: { priceYuan: '128', distanceKm: '0.8' } },
      ],
    };
  },
};

const detailPort: AuthorizedMeituanDetailPort = {
  sourceId: 'mt-detail-1',
  async fetchDetail(candidateId) {
    return {
      ok: true,
      detail: {
        candidateId,
        fields: { priceYuan: '66', finalPriceYuan: '60', stock: '充足' },
        claimsFinalPrice: true,
      },
    };
  },
};

const linkPort: HandoffLinkPort = {
  sourceId: 'link-1',
  async buildTarget(selection) {
    return {
      ok: true,
      kind: 'deeplink',
      uri: `meituan://deal/${selection.candidateId}`,
      expiresAtMs: null,
    };
  },
};

const handoffPort: MeituanHandoffPort = {
  async open(uri) {
    return { delivered: true, handlerLabel: 'MeituanTest', detail: `opened ${uri}` };
  },
};

const extractionPort: ShareExtractionPort = {
  sourceId: 'ocr-1',
  async extract() {
    return { ok: true, text: '海底捞 徐家汇 5F' };
  },
};

const budgetChannel: FactPublicationPort = {
  template: 'budget',
  async publish() {
    return { ok: true, receiptRef: 'receipt-budget-1' };
  },
};

// ---------------------------------------------------------------------------
// 服务夹具
// ---------------------------------------------------------------------------

interface RunningServer {
  readonly server: Server;
  readonly baseUrl: string;
}

async function startServer(adapters: AdaptersHost): Promise<RunningServer> {
  const server = createServer(
    createDemoRequestHandler({ host: stubHost, webDir: process.cwd(), adapters }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${String(address.port)}` };
}

async function closeServer(running: RunningServer): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    running.server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}

async function get(baseUrl: string, path: string): Promise<{ status: number; body: Json }> {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, body: (await response.json()) as Json };
}

async function post(baseUrl: string, path: string, payload: unknown): Promise<{ status: number; body: Json }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: (await response.json()) as Json };
}

/** "被拒"的统一口径：不是 500、不是 2xx、也没有 `ok: true`。 */
function expectRejected(status: number, body: Json): void {
  expect(status).not.toBe(500);
  expect(status).toBeGreaterThanOrEqual(400);
  expect(body.ok).not.toBe(true);
}

/** "未就绪"的统一口径：结构化（stub 显式标识 + 原因 + 解锁条件），不是假装可用。 */
function expectStructuredNotReady(body: Json): void {
  expect(body.stub).toBe(true);
  expect(body.realExecutor).toBe(false);
  expect(typeof body.reason).toBe('string');
  expect((body.reason as string).length).toBeGreaterThan(0);
  expect((body.unblockedBy as string).length).toBeGreaterThan(0);
  expect(['not_ready', 'blocked', 'unavailable']).toContain(body.status);
}

let product: RunningServer; // 无端口 = 产品路径的真实情形
let fixture: RunningServer; // 注入假端口 = 语义正确性

beforeAll(async () => {
  const productHost = createAdaptersHost({ now: () => NOW_MS });
  product = await startServer(productHost);

  const fixtureHost = createAdaptersHost({
    now: () => NOW_MS,
    idSource: (() => {
      let counter = 0;
      return () => {
        counter += 1;
        return `reach-alarm-${String(counter)}`;
      };
    })(),
    extraPorts: {
      meituanSearch: searchPort,
      meituanDetail: detailPort,
      meituanHandoff: handoffPort,
      handoffLink: linkPort,
      shareExtraction: extractionPort,
      publicationChannels: [budgetChannel],
    },
  });
  fixture = await startServer(fixtureHost);
});

afterAll(async () => {
  await closeServer(product);
  await closeServer(fixture);
});

// ---------------------------------------------------------------------------
// M. 逐模块 import + 真实调用 + 清单一致性
// ---------------------------------------------------------------------------

const NAMESPACES: Readonly<Record<string, Record<string, unknown>>> = Object.freeze({
  'src/adapters/meituan/candidate-model.ts': candidateModel as unknown as Record<string, unknown>,
  'src/adapters/meituan/candidate-detail.ts': candidateDetail as unknown as Record<string, unknown>,
  'src/adapters/meituan/compare.ts': compareModule as unknown as Record<string, unknown>,
  'src/adapters/meituan/share-intake.ts': shareIntake as unknown as Record<string, unknown>,
  'src/adapters/meituan/fact-publication.ts': factPublication as unknown as Record<string, unknown>,
  'src/adapters/meituan/handoff-verify.ts': handoffVerify as unknown as Record<string, unknown>,
  'src/adapters/clock/reminder-restore.ts': reminderRestore as unknown as Record<string, unknown>,
});

describe('M. 逐模块 import + 真实调用 + 清单与实现一致', () => {
  it('清单恰好是那 7 个模块，且每一项的 exportsUsed 都能在模块命名空间里取到（真函数）', () => {
    expect(ADAPTERS_MODULES_REACHABLE).toHaveLength(7);
    const listed = new Set(ADAPTERS_MODULES_REACHABLE.map((entry) => entry.module));
    expect(listed).toEqual(new Set(Object.keys(NAMESPACES)));

    for (const entry of ADAPTERS_MODULES_REACHABLE) {
      const namespace = NAMESPACES[entry.module];
      expect(namespace).toBeDefined();
      for (const symbol of entry.exportsUsed) {
        expect(typeof namespace?.[symbol]).toBe('function');
      }
      expect(entry.route.startsWith(EXTRA_ADAPTERS_ROOT)).toBe(true);
      expect(entry.methods.length).toBeGreaterThan(0);
      expect(entry.capability.length).toBeGreaterThan(0);
    }
  });

  it('barrel 挂的就是同一个函数（可达性的定义，不是"有个同名东西"）', () => {
    expect(meituanBarrel.queryCandidates).toBe(candidateModel.queryCandidates);
    expect(meituanBarrel.resolveRegisteredSources).toBe(candidateModel.resolveRegisteredSources);
    expect(meituanBarrel.readCandidateDetail).toBe(candidateDetail.readCandidateDetail);
    expect(meituanBarrel.describePriceLabel).toBe(candidateDetail.describePriceLabel);
    expect(meituanBarrel.compareCandidates).toBe(compareModule.compareCandidates);
    expect(meituanBarrel.withStructuredNoise).toBe(compareModule.withStructuredNoise);
    expect(meituanBarrel.intakeSharedCandidates).toBe(shareIntake.intakeSharedCandidates);
    expect(meituanBarrel.publishCandidateFacts).toBe(factPublication.publishCandidateFacts);
    expect(meituanBarrel.generateHandoffBubble).toBe(handoffVerify.generateHandoffBubble);
    expect(meituanBarrel.verifyAndHandoff).toBe(handoffVerify.verifyAndHandoff);
    expect(clockBarrel.restoreStore).toBe(reminderRestore.restoreStore);
    expect(clockBarrel.planNextTrigger).toBe(reminderRestore.planNextTrigger);
  });

  it('逐模块**真实调用**（不是只看导出存在）', async () => {
    const zone = createFixedZonePort({ 'Asia/Shanghai': 480 });

    // ① candidate-model：无端口 ⇒ not_ready，候选恒空。
    const query = await candidateModel.queryCandidates(null, { category: '火锅', location: '徐汇' }, NOW_MS);
    expect(query.readiness).toBe('not_ready');
    expect(query.candidates).toEqual([]);
    expect(query.model_fabricated).toBe(false);
    expect(candidateModel.resolveRegisteredSources(searchPort, undefined)).toEqual([MEITUAN_SOURCE]);

    // ② candidate-detail：无端口 ⇒ not_ready，detail 恒 null。
    const detail = await candidateDetail.readCandidateDetail(null, 'c-1', NOW_MS);
    expect(detail.status).toBe('not_ready');
    expect(detail.detail).toBeNull();

    // ③ compare：纯逻辑真算一次，出解释与排序键。
    const comparison = compareModule.compareCandidates(
      { label: 'snap', candidates: [candidateFixture('c-1')], capturedAtMs: NOW_MS, promotionalNotes: [] },
      { hard: [], soft: [{ kind: 'preferCheaper' }] },
      1,
    );
    expect(comparison.revision).toBe(1);
    expect(comparison.kept.map((entry) => entry.id)).toEqual(['c-1']);
    expect(comparison.promotionalTextIgnored).toBe(true);
    expect(comparison.explanations[0]?.sortKeys).toHaveLength(1);

    // ④ share-intake：文本分享真产出一条候选，且**不**宣称全平台最优。
    const shared = await shareIntake.intakeSharedCandidates(
      [{ kind: 'text', label: '粘贴#1', content: '海底捞 徐家汇' }],
      null,
      NOW_MS,
    );
    expect(shared.accepted).toHaveLength(1);
    expect(shared.accepted[0]?.provenance.sourceKind).toBe('user_shared');
    expect(shared.optimized_over_all_platforms).toBe(false);

    // ⑤ fact-publication：无通道 ⇒ 三个模板全 not-wired，acknowledged 全 false。
    const publication = await factPublication.publishCandidateFacts([], [candidateFixture('c-1')]);
    expect(publication.map((entry) => entry.wireState)).toEqual(['not-wired', 'not-wired', 'not-wired']);
    expect(publication.every((entry) => entry.acknowledged === false)).toBe(true);
    expect(publication.every((entry) => entry.claimed_published === false)).toBe(true);

    // ⑥ handoff-verify：无受控链接来源 ⇒ 不产出气泡（不自造 meituan:// 深链）。
    const bubble = await handoffVerify.generateHandoffBubble(null, { candidateId: 'c-1', revision: 1 }, 'b-1');
    expect(bubble.status).toBe('not_ready');
    expect(bubble.bubble).toBeNull();

    // ⑦ reminder-restore：算出**绝对时刻**调度计划（pollIntervalMs 恒 null）。
    const plan = reminderRestore.planNextTrigger(ALARM_RECORD, zone, NOW_MS);
    expect(plan).not.toBeNull();
    if (plan === null || plan.basis !== 'absolute_instant') {
      throw new Error('预期产出绝对时刻调度计划');
    }
    expect(plan.pollIntervalMs).toBeNull();
    expect(reminderRestore.assertAbsoluteScheduling(plan).triggerMs).toBeGreaterThan(NOW_MS);
  });
});

// ---------------------------------------------------------------------------
// P. 产品路径（无端口）：每个模块的坏路径都必须**结构化拒绝**
// ---------------------------------------------------------------------------

describe('P. 产品路径无端口：坏路径被结构化拒绝（不是 500、不是假装可用）', () => {
  it('extra 根列出 7 个模块与各自的真实消费点', async () => {
    const { status, body } = await get(product.baseUrl, EXTRA_ADAPTERS_ROOT);
    expect(status).toBe(200);
    expect(body.modules).toHaveLength(7);
    for (const entry of body.modules as Json[]) {
      expect((entry.route as string).startsWith(EXTRA_ADAPTERS_ROOT)).toBe(true);
      expect((entry.exportsUsed as string[]).length).toBeGreaterThan(0);
    }
  });

  it('MT-02 candidate-model：无搜索端口 ⇒ 503 not_ready 且候选恒空', async () => {
    const { status, body } = await post(product.baseUrl, `${EXTRA_ADAPTERS_ROOT}/meituan/query`, {
      query: { category: '火锅', location: '徐汇' },
    });
    expect(status).toBe(503);
    expect(body.code).toBe('meituan_candidate_query_not_ready');
    expect(body.candidates).toEqual([]);
    expect(body.model_fabricated).toBe(false);
    expectStructuredNotReady(body);
  });

  it('MT-03 candidate-detail：无详情端口 ⇒ 503 not_ready 且 detail 恒 null', async () => {
    const { status, body } = await post(product.baseUrl, `${EXTRA_ADAPTERS_ROOT}/meituan/detail`, {
      candidateId: 'c-1',
    });
    expect(status).toBe(503);
    expect(body.code).toBe('meituan_detail_not_ready');
    expect(body.detail).toBeNull();
    expectStructuredNotReady(body);
  });

  it('MT-04 share-intake：图片分享 + 无抽取通道 ⇒ 503，结构化跳过（不"看图说话"）', async () => {
    const { status, body } = await post(product.baseUrl, `${EXTRA_ADAPTERS_ROOT}/meituan/share`, {
      shares: [{ kind: 'image', label: '聊天截图.png', content: '(binary)' }],
    });
    expect(status).toBe(503);
    expect(body.code).toBe('share_extraction_not_ready');
    expect(body.accepted).toEqual([]);
    expect(body.extractionPortWired).toBe(false);
    expect((body.skipped as Json[])[0]?.kind).toBe('image');
    expectStructuredNotReady(body);

    // 反向对照：同为"无端口"，但**文本**分享不需要抽取通道 ⇒ 不该被拒。
    const ok = await post(product.baseUrl, `${EXTRA_ADAPTERS_ROOT}/meituan/share`, {
      shares: [{ kind: 'text', label: '粘贴#1', content: '海底捞 徐家汇' }],
    });
    expect(ok.status).toBe(200);
    expect(ok.body.accepted).toHaveLength(1);
  });

  it('MT-05 compare：非法规则 400；硬条件筛空 422（两条坏路径都当场拒）', async () => {
    const badRules = await post(product.baseUrl, `${EXTRA_ADAPTERS_ROOT}/meituan/compare`, {
      snapshot: { label: 's', candidates: [candidateFixture('c-1')], capturedAtMs: NOW_MS },
      rules: { hard: [{ kind: 'notARule', value: 1 }], soft: [] },
    });
    expect(badRules.status).toBe(400);
    expectRejected(badRules.status, badRules.body);
    expect(badRules.body.code).toBe('invalid_rules');

    const conflict = await post(product.baseUrl, `${EXTRA_ADAPTERS_ROOT}/meituan/compare`, {
      snapshot: { label: 's', candidates: [candidateFixture('c-1')], capturedAtMs: NOW_MS },
      rules: { hard: [{ kind: 'maxPriceYuan', value: 1 }], soft: [] },
    });
    expect(conflict.status).toBe(422);
    expectRejected(conflict.status, conflict.body);
    expect(conflict.body.code).toBe('hard_rule_conflict');
    expect((conflict.body.conflicts as unknown[]).length).toBeGreaterThan(0);
  });

  it('MT-06 fact-publication：无下游模板 ⇒ 503 not_wired，且**不**宣称已发布', async () => {
    const { status, body } = await post(product.baseUrl, `${EXTRA_ADAPTERS_ROOT}/meituan/publish`, {
      candidates: [candidateFixture('c-1')],
    });
    expect(status).toBe(503);
    expect(body.code).toBe('fact_publication_not_wired');
    expect(body.claimed_published).toBe(false);
    expect(body.unwiredTemplates).toEqual(['budget', 'document', 'presentation']);
    expectStructuredNotReady(body);
  });

  it('MT-07 handoff-verify：无受控链接来源 ⇒ 503 not_ready，bubble 恒 null', async () => {
    const { status, body } = await post(product.baseUrl, `${EXTRA_ADAPTERS_ROOT}/meituan/handoff-verify`, {
      op: 'handoff',
      selection: { candidateId: 'c-1', revision: 1 },
      bubbleId: 'b-product',
    });
    expect(status).toBe(503);
    expect(body.code).toBe('meituan_handoff_link_not_ready');
    expect(body.bubble).toBeNull();
    expectStructuredNotReady(body);
  });

  it('CLK-07 reminder-restore：状态如实 unknown；轮询计划 / 版本不符 / 记录读不懂**分别**被拒', async () => {
    // 状态视图：无设备 ⇒ 四项 unknown、不承诺准点。
    const statusView = await get(product.baseUrl, `${EXTRA_ADAPTERS_ROOT}/clock/reminder`);
    expect(statusView.status).toBe(200);
    expect(statusView.body.preciseStatus.verdict).toBe('unknown');
    expect(statusView.body.preciseStatus.canGuaranteeOnTime).toBe(false);
    expect(statusView.body.preciseStatus.reason).toContain('未验证');
    expect(statusView.body.restoreSnapshotVersion).toBe(reminderRestore.RESTORE_SNAPSHOT_VERSION);
    expect(typeof statusView.body.schedulingDiscipline).toBe('string');

    // 坏路径①：轮询计划 ⇒ 409（CLK-07 明令不得用轮询保证准点）。
    const polling = await post(product.baseUrl, `${EXTRA_ADAPTERS_ROOT}/clock/reminder`, {
      op: 'assert-scheduling',
      plan: { basis: 'poll_interval', alarmId: 'a-1', intervalMs: 1000, triggerMs: null },
    });
    expect(polling.status).toBe(409);
    expectRejected(polling.status, polling.body);
    expect(polling.body.code).toBe('polling_not_allowed');

    // 坏路径②：快照版本不符 ⇒ 409 version_mismatch（**不**静默恢复半成品）。
    const versionMismatch = await post(product.baseUrl, `${EXTRA_ADAPTERS_ROOT}/clock/reminder`, {
      op: 'restore',
      snapshot: { version: 999, capturedAtMs: NOW_MS, storeJson: JSON.stringify({ records: [], idempotency: {} }) },
    });
    expect(versionMismatch.status).toBe(409);
    expect(versionMismatch.body.code).toBe('reminder_restore_rejected');
    expect((versionMismatch.body.problems as Json[])[0]?.kind).toBe('version_mismatch');

    // 坏路径③：快照不是合法 JSON ⇒ 409 unparsable_snapshot。
    const unparsable = await post(product.baseUrl, `${EXTRA_ADAPTERS_ROOT}/clock/reminder`, {
      op: 'restore',
      snapshot: { version: 1, capturedAtMs: NOW_MS, storeJson: '{not json' },
    });
    expect(unparsable.status).toBe(409);
    expect((unparsable.body.problems as Json[])[0]?.kind).toBe('unparsable_snapshot');

    // 坏路径④：个别记录读不懂 ⇒ 409 record_unreadable（**不**静默当成"没有这条"）。
    const badRecord = await post(product.baseUrl, `${EXTRA_ADAPTERS_ROOT}/clock/reminder`, {
      op: 'restore',
      snapshot: {
        version: 1,
        capturedAtMs: NOW_MS,
        storeJson: JSON.stringify({
          records: [
            { id: 'x-1', ownership: 'self_managed', label: 'a', zoneId: 'UTC', firstTriggerMs: 'nope', enabled: true, revision: 1, repeat: { kind: 'daily', interval: 1 } },
          ],
          idempotency: {},
        }),
      },
    });
    expect(badRecord.status).toBe(409);
    expect((badRecord.body.problems as Json[])[0]?.kind).toBe('record_unreadable');
    expect(badRecord.body.restoredIds).toEqual([]);
  });

  it('未知补充端点 ⇒ 404（不假装有）', async () => {
    const { status, body } = await post(product.baseUrl, `${EXTRA_ADAPTERS_ROOT}/meituan/nope`, {});
    expect(status).toBe(404);
    expectRejected(status, body);
  });
});

// ---------------------------------------------------------------------------
// F. 夹具端口：7 个模块的正常路径真的可用
// ---------------------------------------------------------------------------

describe('F. 注入夹具端口：7 个模块的正常路径真实可用', () => {
  it('MT-02 query：有端口 ⇒ 200 取回候选；来源不白 ⇒ 整批拒绝', async () => {
    const ok = await post(fixture.baseUrl, `${EXTRA_ADAPTERS_ROOT}/meituan/query`, {
      query: { category: '火锅', location: '徐汇', people: 2 },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.ready).toBe(true);
    expect((ok.body.candidates as Json[]).length).toBe(2);
    expect(ok.body.registeredSources).toEqual([MEITUAN_SOURCE]);
    expect(ok.body.model_fabricated).toBe(false);
    expect(ok.body.scope.limitedToReturned).toBe(true);

    // 反向对照：白名单排他 ⇒ 端口来源不在清单里 ⇒ unavailable，一条都不放行。
    const rejected = await post(fixture.baseUrl, `${EXTRA_ADAPTERS_ROOT}/meituan/query`, {
      query: { category: '火锅', location: '徐汇' },
      registeredSourceIds: ['someone-else'],
    });
    expect(rejected.status).toBe(503);
    expect(rejected.body.ready).toBe(false);
    expect(rejected.body.candidates).toEqual([]);
    expect(rejected.body.registeredSources).toEqual(['someone-else']);
    expect(rejected.body.readiness).toBe('unavailable');
  });

  it('MT-03 detail：有端口 ⇒ 200，且**永远**标"非最终价"、自称最终价被记不采纳', async () => {
    const { status, body } = await post(fixture.baseUrl, `${EXTRA_ADAPTERS_ROOT}/meituan/detail`, {
      candidateId: 'c-9',
    });
    expect(status).toBe(200);
    expect(body.price_is_final).toBe(false);
    expect(body.detail.price_is_final).toBe(false);
    expect((body.priceLabel as string)).toContain('非最终价');
    expect((body.detail.claims_not_adopted as string[]).length).toBeGreaterThan(0);
  });

  it('MT-04 share：图片分享 + 有抽取通道 ⇒ 200 产出候选（来源标 user_shared）', async () => {
    const { status, body } = await post(fixture.baseUrl, `${EXTRA_ADAPTERS_ROOT}/meituan/share`, {
      shares: [{ kind: 'image', label: '截图.png', content: '(binary)' }],
    });
    expect(status).toBe(200);
    expect(body.extractionPortWired).toBe(true);
    expect((body.accepted as Json[]).length).toBe(1);
    expect(body.accepted[0].provenance.sourceKind).toBe('user_shared');
    expect(body.optimized_over_all_platforms).toBe(false);
  });

  it('MT-05 compare：200 出解释；改了条件可重算（revision+1）；话术噪声下排序逐项不变', async () => {
    const snapshot = {
      label: 's',
      candidates: [candidateFixture('c-1'), candidateFixture('c-2', { price: known({ amountYuan: 40, currency: 'CNY', condition: null, isFinalPrice: false }) })],
      capturedAtMs: NOW_MS,
      promotionalNotes: ['分享原文'],
    };
    const rules = { hard: [], soft: [{ kind: 'preferCheaper' }] };
    const base = await post(fixture.baseUrl, `${EXTRA_ADAPTERS_ROOT}/meituan/compare`, { snapshot, rules });
    expect(base.status).toBe(200);
    expect(base.body.noiseInvariant).toBe(true);
    expect(base.body.promotionalTextIgnored).toBe(true);
    expect((base.body.explanations as Json[]).length).toBe(2);

    const recomputed = await post(fixture.baseUrl, `${EXTRA_ADAPTERS_ROOT}/meituan/compare`, {
      snapshot,
      rules,
      recomputeFrom: 3,
    });
    expect(recomputed.status).toBe(200);
    expect(recomputed.body.revision).toBe(4);
  });

  it('MT-06 publish：接了 budget 通道 ⇒ 该模板 published（带回执），其余 not-wired；坏事实 ⇒ failed', async () => {
    const ok = await post(fixture.baseUrl, `${EXTRA_ADAPTERS_ROOT}/meituan/publish`, {
      candidates: [candidateFixture('c-1')],
    });
    expect(ok.status).toBe(200);
    const byTemplate = Object.fromEntries((ok.body.results as Json[]).map((row) => [row.template, row]));
    expect(byTemplate['budget'].wireState).toBe('published');
    expect(byTemplate['budget'].acknowledged).toBe(true);
    expect(byTemplate['budget'].receiptRef).toBe('receipt-budget-1');
    expect(byTemplate['budget'].claimed_published).toBe(false);
    expect(byTemplate['document'].wireState).toBe('not-wired');
    expect(ok.body.unwiredTemplates).toEqual(['document', 'presentation']);

    // 反向对照：事实缺来源 ⇒ 整批拒绝发布（wireState failed），不"补默认值再发"。
    const failed = await post(fixture.baseUrl, `${EXTRA_ADAPTERS_ROOT}/meituan/publish`, {
      candidates: [
        candidateFixture('c-bad', {
          provenance: { sourceKind: 'authorized_interface', sourceRef: '', fetchedAtMs: NOW_MS },
        }),
      ],
    });
    expect(failed.status).toBe(200);
    const failedBudget = (failed.body.results as Json[]).find((row) => row.template === 'budget');
    expect(failedBudget?.wireState).toBe('failed');
    expect(failedBudget?.acknowledged).toBe(false);
    expect((failed.body.screen.notPublishable as Json[]).length).toBeGreaterThan(0);
  });

  it('MT-08 handoff-verify：正常交接最高"已交接"；重复点击不重开；过期气泡 409；返回结算保留未知', async () => {
    const attempt = {
      op: 'handoff',
      selection: { candidateId: 'c-1', revision: 1 },
      bubbleId: 'b-f1',
      currentSelection: { candidateId: 'c-1', revision: 1 },
      check: { appInstalled: true, linkValid: true, targetMatches: true },
    };
    const first = await post(fixture.baseUrl, `${EXTRA_ADAPTERS_ROOT}/meituan/handoff-verify`, attempt);
    expect(first.status).toBe(200);
    expect(first.body.state).toBe('handed_off');
    expect(first.body.purchase_confirmed).toBe(false);
    expect(first.body.duplicate).toBe(false);

    // 重复点击：同一 bubbleId + 同一 revision ⇒ 命中台账，**不重新打开**。
    const again = await post(fixture.baseUrl, `${EXTRA_ADAPTERS_ROOT}/meituan/handoff-verify`, attempt);
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    expect(again.body.result).toBeNull();

    // 过期气泡（选择已变）⇒ 409 stale_selection，且**不触碰外部**。
    const stale = await post(fixture.baseUrl, `${EXTRA_ADAPTERS_ROOT}/meituan/handoff-verify`, {
      op: 'handoff',
      selection: { candidateId: 'c-1', revision: 1 },
      bubbleId: 'b-f2',
      currentSelection: { candidateId: 'c-1', revision: 2 },
      check: { appInstalled: true, linkValid: true, targetMatches: true },
    });
    expect(stale.status).toBe(409);
    expectRejected(stale.status, stale.body);
    expect(stale.body.code).toBe('stale_selection');

    // 目标 App 未安装 ⇒ 409 app_not_installed（四种失败**分别**处理）。
    const notInstalled = await post(fixture.baseUrl, `${EXTRA_ADAPTERS_ROOT}/meituan/handoff-verify`, {
      op: 'handoff',
      selection: { candidateId: 'c-1', revision: 1 },
      bubbleId: 'b-f3',
      currentSelection: { candidateId: 'c-1', revision: 1 },
      check: { appInstalled: false, linkValid: true, targetMatches: true },
    });
    expect(notInstalled.status).toBe(409);
    expect(notInstalled.body.code).toBe('app_not_installed');

    // 返回结算：外部不可读 ⇒ 结果未知，purchase_confirmed 恒 false。
    const settled = await post(fixture.baseUrl, `${EXTRA_ADAPTERS_ROOT}/meituan/handoff-verify`, {
      op: 'settle',
      from: 'handed_off',
      readable: false,
      detail: '用户直接返回，未截图',
    });
    expect(settled.status).toBe(200);
    expect(settled.body.state).toBe('unknown');
    expect(settled.body.purchase_confirmed).toBe(false);
  });

  it('CLK-07 reminder-restore：真实自管提醒走通 快照 → 恢复 → 调度 → 时区变化', async () => {
    // 先经**既有**时钟入口创建一条自管提醒（快照的输入是真实仓库，不是造的）。
    const created = await post(fixture.baseUrl, '/api/adapters/clock/alarms', {
      draft: {
        label: '喝水',
        zoneId: 'Asia/Shanghai',
        firstTriggerMs: NOW_MS + 1_800_000,
        repeat: { kind: 'daily', interval: 1 },
      },
      idempotencyKey: 'reach-key-1',
    });
    expect(created.status).toBe(201);
    const alarmId = created.body.record.id as string;

    // 快照。
    const snapshot = await post(fixture.baseUrl, `${EXTRA_ADAPTERS_ROOT}/clock/reminder`, { op: 'snapshot' });
    expect(snapshot.status).toBe(200);
    expect(snapshot.body.snapshot.version).toBe(reminderRestore.RESTORE_SNAPSHOT_VERSION);
    expect((snapshot.body.alarms as Json[]).some((entry) => entry.id === alarmId)).toBe(true);

    // 恢复：真实快照 ⇒ ok，且恢复出的 id 与创建的一致。
    const restored = await post(fixture.baseUrl, `${EXTRA_ADAPTERS_ROOT}/clock/reminder`, {
      op: 'restore',
      snapshot: snapshot.body.snapshot,
    });
    expect(restored.status).toBe(200);
    expect(restored.body.restoredIds).toContain(alarmId);
    expect(restored.body.problems).toEqual([]);

    // 调度：绝对时刻计划，pollIntervalMs 恒 null。
    const plan = await post(fixture.baseUrl, `${EXTRA_ADAPTERS_ROOT}/clock/reminder`, {
      op: 'plan',
      record: ALARM_RECORD,
    });
    expect(plan.status).toBe(200);
    expect(plan.body.plan.basis).toBe('absolute_instant');
    expect(plan.body.plan.pollIntervalMs).toBeNull();
    expect(plan.body.asserted.triggerMs).toBeGreaterThan(NOW_MS);

    // 时区变化：本地显示变了 ⇒ 如实要求用户确认，**不**自动改时间。
    const rebase = await post(fixture.baseUrl, `${EXTRA_ADAPTERS_ROOT}/clock/reminder`, {
      op: 'rebase',
      record: ALARM_RECORD,
      afterOffsets: { 'Asia/Shanghai': 300 },
    });
    expect(rebase.status).toBe(200);
    expect(rebase.body.report.requiresUserConfirmation).toBe(true);
    expect(rebase.body.report.localDisplayChanged).toBe(true);
    expect(rebase.body.report.nextTriggerLocalBefore).not.toBe(rebase.body.report.nextTriggerLocalAfter);
  });
});
