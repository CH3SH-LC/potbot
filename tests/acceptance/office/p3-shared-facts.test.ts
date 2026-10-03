/**
 * D02A-WF3 —— design-02 **P3**「关键共享数据单一来源 / 缺失不得当零」的**产物级**验收（J5 + J6）。
 *
 * 判据来源：合同 v1.4 **R48 全节**（尤其 R48.2 / R48.3 / R48.4）+ design-02 需求 3 /
 * 验收标准「不达标的情形：把缺失值当零算出好看的结果」+ 任务书 **§7.2**、**§13**
 * （「金额、人数、日期等关键共享数据不能由不同 Agent 各自重新猜测」「未知值必须与零值区分」）。
 *
 * 被测对象：**W-F1 交付的产物级场景夹具**（`office-support.ts`）+ 它背后的公开内核
 * （`src/facts/snapshot.ts` 的 `missing_fact` 阻塞 → `src/artifacts/publish.ts` 的发布投影）。
 * 本文件**不复述实现者结论、不代办内核步骤**：只经 `registerFact()` / `materializeAll()` /
 * `artifacts()` / `runFileOf()` / `readback()` 这几个公开面观察。
 *
 * ## 两个判据（逐条对应任务书的机器形式）
 *
 * - **J5**：缺失事实 ⇒ 该条发布被**结构化拒绝**（`missing_fact`，`detail` 非空）——
 *   ① 不产出产物（`artifacts()` 里没有该请求的 `published` / `staged` 记录）；
 *   ② 不产出**零值**产物（盘上不得出现该产物文件）；
 *   ③ 结局**不是"已完成"**、失败原因**可指认**。
 *   覆盖四种缺失形态：`unknown` / `not_applicable` / **未登记键** / **只登记了别的版本**。
 * - **J6**：三类产物（文档 / 表格 / 演示）的 `source_fact_refs` 指向**同一条**事实记录
 *   ——同一份事实被三类产物引用时，逐条断言含同一个 `fact_ref`。
 *
 * ## J5 判据的落点（D02A-WFIX3 改造后）
 *
 * W-FIX1 把夹具改成**走内核公开入口**（`onMessage → startRun → finishRun`）后，缺事实这条
 * 路径由内核的 `stagePublicationArtifact()` 处理：返回结构化失败 `missing_fact`、
 * 写一条 `publication_rejected` 观测、**拒绝该条发布**（R48.4/R56）——**一条 `ArtifactRecord`
 * 都不写**（旧夹具会自己伪造一条 `failed` 记录，现在没有了）。因此 J5 的四条断言改为：
 *
 * ① **没有任何产物记录**（三路判据：集合 `artifacts()` 为空 / 身份 `artifactOf()` 查不到本应
 *    派生的 id / 交付 `isDeliveredArtifact()` 过滤为空）；
 * ② **盘上零文件**（产物根根本没被创建）；
 * ③ **端口零调用**（没有任何物化尝试）；
 * ④ **内核如实留痕**：`kernel_events` 里的 `publication_rejected` 逐条可指认到
 *    `data.reason === 'missing_fact'` 与肇事事实键（补 V5 发现的空断言 M4b）；
 * ⑤ **工作项不是"已完成"**——经只读快照断言。任务书 J5 要求的「**工作项**如实上报"部分完成 /
 *    未知"」现在**真的**证到了 `WorkItem` 层（不再是 ②① 之外的"留待接线后补"）。
 *
 * ## 纪律
 *
 * 断言用等号（`toBe` / `toEqual` / `toHaveLength`）；每个用例**先断言夹具确实产生了数据**；
 * 不 `putArtifact`、不拼 XML、不走私有路径；不调用 `openWithOffice`；只跑本文件。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  TEMPLATE_KINDS,
  asArtifactRef,
  asFactRef,
  asInstanceId,
  asLogicalTime,
  asRevision,
  createArtifactRecord,
  createSharedFactRecord,
  isDeliveredArtifact,
  snapshotSharedFacts,
  ValidationError,
  type ArtifactRecord,
  type ArtifactRecordInput,
  type ArtifactRef,
  type FactRef,
  type FactSource,
  type SharedFactRecord,
  type SharedFactValue,
  type TemplateKind,
} from '../../../src/protocol/index.js';
import { deriveArtifactId } from '../../../src/artifacts/index.js';
import { allPartText } from './independent-readback.js';
import {
  OFFICE_ARTIFACT_VERSION,
  OFFICE_SHARED_FACT_KEY,
  OFFICE_TASK_ID,
  OFFICE_TASK_REVISION,
  buildOfficeScenario,
  type OfficeScenario,
} from './office-support.js';

// ---------------------------------------------------------------------------
// 场景常量与事实构造（**与夹具常量同源**：共享键取 `OFFICE_SHARED_FACT_KEY`）
// ---------------------------------------------------------------------------

const CONFIRMER = asInstanceId('inst-wf3');
const USER_SOURCE: FactSource = Object.freeze({
  kind: 'user_confirmation',
  detail: '用户在前台确认（WF3 场景）',
});

const HEADCOUNT_REF = asFactRef('fact-wf3-headcount');
const BUDGET_REF = asFactRef('fact-wf3-budget-total');
const DATE_REF = asFactRef('fact-wf3-event-date');

function makeFact(spec: {
  readonly id: FactRef;
  readonly key: string;
  readonly value: SharedFactValue;
  readonly revision?: ReturnType<typeof asRevision>;
}): SharedFactRecord {
  return createSharedFactRecord({
    fact_id: spec.id,
    task_id: OFFICE_TASK_ID,
    task_revision: spec.revision ?? OFFICE_TASK_REVISION,
    fact_key: spec.key,
    value: spec.value,
    source: USER_SOURCE,
    confirmed_by: CONFIRMER,
    confirmed_at: asLogicalTime(1),
    supersedes_fact_id: null,
  });
}

function knownHeadcount(amount: number): SharedFactValue {
  return { kind: 'known', value: { type: 'number', amount, unit: '人', currency: null } };
}

const KNOWN_BUDGET: SharedFactValue = {
  kind: 'known',
  value: { type: 'number', amount: 600, unit: '元', currency: 'CNY' },
};

const KNOWN_DATE: SharedFactValue = {
  kind: 'known',
  value: { type: 'date', iso_date: '2026-10-02', time_zone: 'Asia/Shanghai' },
};

const headcountFact = (value: SharedFactValue, revision?: ReturnType<typeof asRevision>) =>
  makeFact({ id: HEADCOUNT_REF, key: OFFICE_SHARED_FACT_KEY, value, revision });
const budgetFact = () => makeFact({ id: BUDGET_REF, key: 'budget.total', value: KNOWN_BUDGET });
const dateFact = () => makeFact({ id: DATE_REF, key: 'event.date', value: KNOWN_DATE });

// ---------------------------------------------------------------------------
// 夹具驱动与只读观察
// ---------------------------------------------------------------------------

/** 本用例开过的场景；`afterEach` 统一清理（R53.7 的重试删除在夹具里）。 */
const liveScenarios: OfficeScenario[] = [];

/** 建场景 → 登记事实 → `mark` → 放行发布投影（**全部经公开面**）。 */
function openScenario(label: string, facts: readonly SharedFactRecord[]): OfficeScenario {
  const scenario = buildOfficeScenario(label);
  liveScenarios.push(scenario);
  for (const fact of facts) scenario.registerFact(fact);
  scenario.mark(`注册 ${String(facts.length)} 条共享事实`);
  scenario.materializeAll();
  scenario.mark('放行产物发布投影');
  return scenario;
}

afterEach(() => {
  for (const scenario of liveScenarios.splice(0)) scenario.cleanup();
});

function publishedRecords(scenario: OfficeScenario): readonly ArtifactRecord[] {
  return scenario.artifacts().filter((record) => isDeliveredArtifact(record));
}

/** 递归列出目录下的全部文件（目录不存在 ⇒ 空集）；只用于**只读**观察产物盘面。 */
function listFilesUnder(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else files.push(absolute);
    }
  };
  walk(dir);
  return files;
}

/**
 * "若这轮真的产出了，产物 id 会是什么"（R51.4：id 只由 task / revision / kind / version 派生，
 * 与摘要、根目录无关）——用作 `artifactOf()` 的**身份判据**：查不到这个 id，就是没产出。
 */
function wouldBeArtifactId(kind: TemplateKind): ArtifactRef {
  return deriveArtifactId({
    task_id: OFFICE_TASK_ID,
    task_revision: OFFICE_TASK_REVISION,
    template_kind: kind,
    artifact_version: OFFICE_ARTIFACT_VERSION,
  });
}

/**
 * J5 ①：缺失事实下内核**没有产出任何产物**。
 *
 * 三路判据缺一不可——任一独用都会留下空子：
 * - 集合判据 `artifacts()` 为空（防"记录在别处"）；
 * - 身份判据 `artifactOf(本应派生的 id)` 查不到（防"换了个 id 偷写一条"）；
 * - 交付判据 `isDeliveredArtifact()` 过滤后为空（防"记录在、但状态可疑"）。
 * 三条都是**等号 / 全等**断言（`toEqual([])`、`toBeUndefined`），不是"至多 0 条"。
 */
function expectNoArtifactProduced(scenario: OfficeScenario): void {
  expect(scenario.artifacts()).toEqual([]);
  for (const kind of TEMPLATE_KINDS) {
    expect(scenario.artifactOf(wouldBeArtifactId(kind))).toBeUndefined();
  }
  expect(scenario.artifacts().filter((record) => isDeliveredArtifact(record))).toEqual([]);
}

/**
 * J5 ④：内核**如实留痕**（补 V5 发现的空断言 M4b——"存储里没有记录"本身不足以证明
 * "内核拒绝了"，必须有内核自己写下的拒绝观测）。
 *
 * 每条被拒的完成发布各留一条 `publication_rejected`：
 * - `data.reason === 'missing_fact'`（结构化拒因，正是 `stageArtifactInTransaction` 的 `kind`）；
 * - `data.message` 非空，且点明**是哪条键、为什么不可用**（`describeUnusableFacts` 的格式）。
 *
 * `namesFactRef`：事实**已登记但不可用**（unknown / not_applicable）⇒ 内核必须点名它的
 * `fact_ref`；**未登记 / 只登记了别的版本**（`missing`）⇒ 绝不为缺失伪造一个 id。
 */
function expectMissingFactTrail(
  scenario: OfficeScenario,
  expected: {
    readonly unusableKind: 'unknown' | 'not_applicable' | 'missing';
    readonly namesFactRef: boolean;
  },
): void {
  const rejections = scenario
    .snapshot()
    .kernel_events.filter((event) => event.kind === 'publication_rejected');
  expect(rejections).toHaveLength(TEMPLATE_KINDS.length);
  for (const event of rejections) {
    expect(event.data.reason).toBe('missing_fact');
    expect(typeof event.data.message).toBe('string');
    const detail = event.data.message as string;
    expect(detail.length > 0).toBe(true);
    // 可指认到"哪条键、为什么不可用"——不是一句泛泛的"失败了"。
    expect(detail.includes(`${OFFICE_SHARED_FACT_KEY} [${expected.unusableKind}]`)).toBe(true);
    expect(detail.includes(String(HEADCOUNT_REF))).toBe(expected.namesFactRef);
    // 只点名**不可用**的键：本场景里 `event.date` / `budget.total` 都已登记为已知值，
    // 拒绝理由**不得**把它们也列进来——理由要精确到"谁挡住了这次交付"，
    // 而不是把输入键清单一遍（旧断言"失败记录仍指认可用来源"的这一面，在此收得更紧）。
    for (const usableKey of ['event.date', 'budget.total']) {
      expect(detail.includes(usableKey), `拒绝理由不得列出可用的键 ${usableKey}`).toBe(false);
    }
  }
}

/**
 * J5 ⑤：工作项**不是"已完成"**（R48.4 的"如实上报部分完成 / 未知"在只读快照上的可判定形式）。
 *
 * 断言的是**精确状态** `processing`（轮次认领后的形态），不是"≠ completed"——被拒的发布
 * 不得把工作项推进哪怕一步。
 */
function expectWorkItemsNotCompleted(scenario: OfficeScenario): void {
  const statuses = scenario.snapshot().work_items.map((item) => item.status);
  expect(statuses).toHaveLength(TEMPLATE_KINDS.length);
  expect(statuses).toEqual(TEMPLATE_KINDS.map(() => 'processing'));
}

/** J5 ②/③：盘上零文件（产物根根本没被创建）＋端口零调用（没有任何物化尝试）。 */
function expectNothingOnDiskAndPortUntouched(scenario: OfficeScenario): void {
  expect(existsSync(scenario.root())).toBe(false);
  expect(listFilesUnder(scenario.root())).toEqual([]);
  expect(scenario.materializeCalls()).toBe(0);
}

// ---------------------------------------------------------------------------
// J5 —— 缺失事实 ⇒ 结构化拒绝（四种缺失形态）
// ---------------------------------------------------------------------------

describe('J5 缺失事实 ⇒ 内核结构化拒绝（missing_fact）：零记录、零写盘、端口零调用、留痕可指认、工作项非已完成', () => {
  it('J5-a 值为 unknown：该条发布被拒，不产出产物、不产出零值产物', () => {
    const unknownHeadcount: SharedFactValue = {
      kind: 'unknown',
      reason: '用户尚未确认到场人数',
    };
    const scenario = openScenario('p3-j5-unknown', [
      headcountFact(unknownHeadcount),
      budgetFact(),
      dateFact(),
    ]);

    // 先断言夹具确实产生了数据：3 条事实入库（否则"缺 fact"可能是空场景假绿）。
    expect(snapshotSharedFacts(scenario.store.snapshot())).toHaveLength(3);

    // ① 没有任何产物记录（三路判据）。
    expectNoArtifactProduced(scenario);
    // ④ 内核如实留痕：unknown 的事实**仍可指认**（点名 fact_ref），且键与不可用种类可读。
    expectMissingFactTrail(scenario, { unusableKind: 'unknown', namesFactRef: true });
    // ⑤ 工作项不是"已完成"（轮次认领后的 processing 原样保留）。
    expectWorkItemsNotCompleted(scenario);
    // ②③ 盘上零文件、端口零调用。
    expectNothingOnDiskAndPortUntouched(scenario);
  });

  it('J5-b 值为 not_applicable：同样被拒，不得当成 0', () => {
    const notApplicable: SharedFactValue = {
      kind: 'not_applicable',
      reason: '本任务为单人事务，不统计人数',
    };
    const scenario = openScenario('p3-j5-not-applicable', [
      headcountFact(notApplicable),
      budgetFact(),
      dateFact(),
    ]);

    expect(snapshotSharedFacts(scenario.store.snapshot())).toHaveLength(3);

    expectNoArtifactProduced(scenario);
    expectMissingFactTrail(scenario, { unusableKind: 'not_applicable', namesFactRef: true });
    expectWorkItemsNotCompleted(scenario);
    expectNothingOnDiskAndPortUntouched(scenario);
  });

  it('J5-c 未登记键：该键没有当前事实 ⇒ 被拒；留痕不得为缺失伪造 fact_ref', () => {
    // `headcount` 从未登记；另两条用于证明"缺失的是键，不是整个事实层"。
    const scenario = openScenario('p3-j5-missing-key', [budgetFact(), dateFact()]);

    expect(snapshotSharedFacts(scenario.store.snapshot())).toHaveLength(2);
    // 只登记 2 条事实（都不是 headcount）——夹具确实产出了"缺 headcount 的存储状态"。
    expect(
      snapshotSharedFacts(scenario.store.snapshot()).filter(
        (fact) => fact.fact_key === OFFICE_SHARED_FACT_KEY,
      ),
    ).toEqual([]);

    expectNoArtifactProduced(scenario);
    // `missing` = 没有任何当前事实可指 ⇒ 内核**不为缺失伪造 id**（`namesFactRef: false`）。
    expectMissingFactTrail(scenario, { unusableKind: 'missing', namesFactRef: false });
    expectWorkItemsNotCompleted(scenario);
    expectNothingOnDiskAndPortUntouched(scenario);
  });

  it('J5-d 只登记了别的版本：更高版本的事实不算当前 ⇒ 被拒，且不得冒充来源', () => {
    // headcount 只登记在 r2；任务当前是 r1 ⇒ 在 r1 下"没有当前事实"。
    const scenario = openScenario('p3-j5-other-revision', [
      headcountFact(knownHeadcount(8), asRevision(2)),
      budgetFact(),
      dateFact(),
    ]);

    // 先断言夹具确实产出了数据：那条 r2 的 headcount 确实在存储里。
    const stored = snapshotSharedFacts(scenario.store.snapshot());
    expect(stored).toHaveLength(3);
    expect(
      stored
        .filter((fact) => fact.fact_key === OFFICE_SHARED_FACT_KEY)
        .map((fact) => fact.task_revision),
    ).toEqual([asRevision(2)]);
    expect(stored.filter((fact) => fact.fact_key === OFFICE_SHARED_FACT_KEY).map((fact) => fact.fact_id)).toEqual([
      HEADCOUNT_REF,
    ]);

    expectNoArtifactProduced(scenario);
    // **只登记了别的版本**的键在 r1 下按 `missing` 计、且不得被点名为来源（不被冒充）。
    expectMissingFactTrail(scenario, { unusableKind: 'missing', namesFactRef: false });
    expectWorkItemsNotCompleted(scenario);
    expectNothingOnDiskAndPortUntouched(scenario);
  });

  it('J5 对照：已知的 0 是合法值 ⇒ 不得当作缺失，必须写出', () => {
    const scenario = openScenario('p3-j5-known-zero', [
      headcountFact(knownHeadcount(0)),
      budgetFact(),
      dateFact(),
    ]);

    // "0" 不是缺失：三类产物照常产出。
    expect(snapshotSharedFacts(scenario.store.snapshot())).toHaveLength(3);
    expect(scenario.materializeCalls()).toBe(3);
    const published = publishedRecords(scenario);
    expect(published).toHaveLength(3);

    // 对照组必须**真的在盘上留下文件**——否则 J5-a~d 里"盘上找不到文件"就是空断言。
    expect(listFilesUnder(scenario.root())).toHaveLength(3);

    const sheet = published.find((record) => record.template_kind === 'spreadsheet');
    expect(sheet?.status).toBe('published');
    if (sheet === undefined) throw new Error('断言保护：表格产物应已发布');
    const bytes = readFileSync(scenario.runFileOf(sheet));
    // 容器为全 STORE（R51.1），工作表 XML 原样在字节里 ⇒ 可直接判"0 写出去了"。
    expect(bytes.includes('<v>0</v>')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// J6 —— 单一来源：三类产物引用同一条事实记录（R48.3 / 任务书 §7.2）
// ---------------------------------------------------------------------------

describe('J6 单一来源：三类产物的 source_fact_refs 指向同一条事实记录', () => {
  it('同一份 headcount 事实被三类产物引用 ⇒ 逐条断言含同一个 fact_ref', () => {
    const scenario = openScenario('p3-j6-single-source', [
      headcountFact(knownHeadcount(8)),
      budgetFact(),
      dateFact(),
    ]);

    // 先断言夹具确实产生了数据：端口被调 3 次、3 条已发布记录、三种模板种类齐备。
    expect(snapshotSharedFacts(scenario.store.snapshot())).toHaveLength(3);
    expect(scenario.materializeCalls()).toBe(3);
    const published = publishedRecords(scenario);
    expect(published).toHaveLength(3);
    expect(new Set(published.map((record) => record.template_kind)).size).toBe(3);
    expect(new Set(published.map((record) => String(record.artifact_id))).size).toBe(3);

    for (const record of published) {
      expect(record.task_revision).toBe(OFFICE_TASK_REVISION);
      // 机器判据：三类产物的 source_fact_refs 都含**同一个** fact_ref。
      expect(record.source_fact_refs).toContain(HEADCOUNT_REF);
    }

    // 正向交叉核对（第 2 层独立读回）：三份产物里的关键值都是同一份事实的 8。
    const texts = published.map((record) => {
      const readback = scenario.readback(scenario.runFileOf(record));
      expect(readback.ok).toBe(true);
      return allPartText(readback);
    });
    expect(texts).toHaveLength(3);
    for (const text of texts) expect(text).toContain('8');
  });
});

// ---------------------------------------------------------------------------
// M7（V5 发现的第二条空断言）——R47.4 的"非空"构造期不变量：独立反例
// ---------------------------------------------------------------------------

/**
 * R47.4 把 `source_fact_refs` 非空定为**构造期不变量**（"空 ⇒ 抛"，**不得**降级为运行期警告）。
 *
 * 在此之前，这条不变量只有**正向**断言（产物记录的 `source_fact_refs` 指向某条事实）——
 * 那是"影子"而非判据：即使把空数组放行，正向断言照样成立。这里补一条**独立反例**：
 * 一条**完全合法**的基线记录（先证明构造器不是恒抛、堵住"假绿"）把 `source_fact_refs` 换成
 * `[]` 之后**必须抛 `ValidationError`**。两个用例成对出现，正向的"合法基线可构造"是反例的
 * **对照臂**——只有反例、没有对照臂时，"抛错"可能仅仅因为基线本身非法。
 */
describe('M7 · R47.4 构造期不变量：source_fact_refs 为空 ⇒ 抛 ValidationError（非空不变量只有正向断言时是空断言）', () => {
  /** 合法基线：`staged`（不要求回执 / 失败种类 / 检查列表），只留一个可覆盖的字段。 */
  function baselineInput(
    overrides: Partial<ArtifactRecordInput> = {},
  ): ArtifactRecordInput {
    return {
      artifact_id: asArtifactRef('artifact-wf3-baseline'),
      task_id: OFFICE_TASK_ID,
      task_revision: OFFICE_TASK_REVISION,
      artifact_version: OFFICE_ARTIFACT_VERSION,
      template_kind: 'document',
      byte_length: 128,
      content_digest: 'wf3-baseline-content-digest',
      source_fact_refs: [HEADCOUNT_REF],
      created_by_instance_id: CONFIRMER,
      status: 'staged',
      created_at: asLogicalTime(1),
      ...overrides,
    };
  }

  it('对照臂：合法基线可构造（证明反例不是"构造器恒抛"造成的假绿）', () => {
    const record = createArtifactRecord(baselineInput());
    expect(record.status).toBe('staged');
    expect(record.source_fact_refs).toEqual([HEADCOUNT_REF]);
    expect(record.receipt).toBeNull();
  });

  it('反例：source_fact_refs: [] ⇒ 必须抛 ValidationError（空产物不得被持久化）', () => {
    expect(() => createArtifactRecord(baselineInput({ source_fact_refs: [] }))).toThrow(ValidationError);
  });
});
