/**
 * **W-F2 / J4 · J9 · J10：交付判据的反面对照、版本闸门与结构化失败**。
 *
 * 归属：D02A-WF2。三条判据都来自"**必须先能失败**"的纪律（design-02「不达标的情形」：
 * 只在聊天里显示文件名不算交付；合同 v1.4 R49.1 / R50.2）。
 *
 * - **J4（本包最关键的一条）**：只在聊天里报出文件名 ⇒ **交付判据必须为假**
 *   （`artifacts()` 里没有任何 published 记录、`artifactOf(...)` 查不到可用记录）；
 *   同时给出"**带意图** ⇒ 真产出"的对照，证明两者判据**不同**、判据不是恒假。
 * - **J9 版本闸门**：物化前任务版本被超越 ⇒ 内核在**收尾入口**以 `stale_task_revision`
 *   **拒绝整个收尾**（`finishRun` 结局为拒绝），零产物记录、零写盘、端口零调用、工作项未被
 *   写成已完成。`superseded` 那条状态语义（R58）归 `publish.ts` 的**投影路径**，另见 J9 的说明。
 * - **J10 结构化失败**：端口返回结构化失败（`fs-artifact-port` 的可注入故障）⇒ 记录 `failed`、
 *   `detail` 非空、**绝不**冒充 `published`，且**盘上不得留下被误标通过的文件**。
 *
 * ## 纪律（与任务书逐条对应）
 *
 * - **不代办内核步骤**：`staged` 记录一律由**内核自己的** `stageArtifactInTransaction()`（事务 1）
 *   写入，本文件**不调用 `tx.putArtifact`**、不拼 XML、不走任何旁路；发布一律经
 *   `ArtifactPublicationProjection` 的公开投影；
 * - 断言用**等号**；先断言夹具/内核确实产生了数据（R22）；
 * - 不调用 `openWithOffice`（第三层由专职包串行取证，R53.1 / R53.5）。
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LogicalClock } from '../../../src/clock/index.js';
import { createMemoryStore } from '../../../src/storage/index.js';
import {
  TEMPLATE_KINDS,
  asFactRef,
  asLogicalTime,
  asRevision,
  createInstanceState,
  createSharedFactRecord,
  createTaskRecord,
  isDeliveredArtifact,
  snapshotSharedFacts,
  type ArtifactRecord,
  type ArtifactRef,
  type LogicalTime,
  type SharedFactRecord,
  type SharedFactValue,
  type Store,
  type TaskId,
  type TemplateKind,
} from '../../../src/protocol/index.js';
import {
  createArtifactPublicationProjection,
  createStagedArtifactFact,
  deriveArtifactId,
  planArtifact,
  stageArtifactInTransaction,
  type ArtifactPlan,
  type ArtifactPublicationIntent,
  type StagedArtifactFact,
} from '../../../src/artifacts/index.js';
import { buildFactSnapshot } from '../../../src/facts/index.js';
import {
  OFFICE_ARTIFACT_VERSION,
  OFFICE_FACT_KEYS_BY_KIND,
  OFFICE_GROUP_ID,
  OFFICE_INSTANCE_ID,
  OFFICE_SHARED_FACT_KEY,
  OFFICE_TASK_ID,
  OFFICE_TASK_REVISION,
  OFFICE_TEMPLATE_INPUTS,
  SCENARIO_EVIDENCE_DIR,
  buildOfficeScenario,
  type OfficeScenario,
} from './office-support.js';
import {
  FS_ARTIFACT_PORT_FAIL_AT,
  buildTemplateBytes,
  createFsArtifactMaterializationPort,
  type FsArtifactPortFailAt,
} from './fs-artifact-port.js';

// ---------------------------------------------------------------------------
// 前置事实（与 p1-real-files.test.ts 同口径的登记方式）
// ---------------------------------------------------------------------------

const FIXED_TIME = asLogicalTime(0);

function headcountValue(amount: number): SharedFactValue {
  return { kind: 'known', value: { type: 'number', amount, unit: '人', currency: null } };
}

function confirmedFact(factId: string, factKey: string, value: SharedFactValue): SharedFactRecord {
  return createSharedFactRecord({
    fact_id: asFactRef(factId),
    task_id: OFFICE_TASK_ID,
    task_revision: OFFICE_TASK_REVISION,
    fact_key: factKey,
    value,
    source: { kind: 'user_confirmation', detail: '用户在前台确认（场景前置数据）' },
    confirmed_by: OFFICE_INSTANCE_ID,
    confirmed_at: FIXED_TIME,
  });
}

function registerScenarioFacts(scenario: OfficeScenario, headcount: number): void {
  scenario.registerFact(confirmedFact('fact-headcount', OFFICE_SHARED_FACT_KEY, headcountValue(headcount)));
  scenario.registerFact(
    confirmedFact('fact-budget', 'budget.total', {
      kind: 'known',
      value: { type: 'number', amount: 600, unit: 'CNY', currency: 'CNY' },
    }),
  );
  scenario.registerFact(
    confirmedFact('fact-date', 'event.date', {
      kind: 'known',
      value: { type: 'date', iso_date: '2026-10-02', time_zone: 'Asia/Shanghai' },
    }),
  );
}

/** 宿主路径 → 正斜杠逻辑路径（`planArtifact` 的路径纪律）。 */
function toForwardSlashes(hostPath: string): string {
  return hostPath.split('\\').join('/');
}

/**
 * 证据落盘位置。
 *
 * `evidenceOutputLocation()` 每次都**全量复算** `src/**` + `tests/**` 的 680 个 `.ts` 摘要
 * （实测单次 ≈ 0.4 s，`tests/acceptance/source-digest.ts` 无缓存）。一次运行之内工作树不变，
 * 该值是**只读快照**——故只在模块加载时取一次；原先每次产物根清理 / 建场景都各付一次复算。
 * 判据未放宽：取到的仍是同一复算结果。
 *
 * 现在直接复用 `office-support` 那份**同一个模块级快照**推出的位置（`SCENARIO_EVIDENCE_DIR`，
 * 公式与本文件原先调用的完全相同），整棵树在一次运行里只复算一次；目录一字不差。
 */
const EVIDENCE_DIR = SCENARIO_EVIDENCE_DIR;

/** 本场景产物根（目录规则与 `office-support` 同源：`{证据位置}/products/{label}`）。 */
function productsRootOf(label: string): string {
  return join(EVIDENCE_DIR, 'products', label);
}

/**
 * 建场景**之前**先清空本场景的产物根。
 *
 * 这不是"帮被测对象干活"：端口的幂等路径（R50.3）在"最终路径已存在且回读摘要一致"时
 * 会直接返回**既有回执**，于是一次**中断**的运行留下的字节会让"注入故障"这类反例
 * 悄悄走成 `published`（假绿），也会让"盘上不得留文件"的断言被旧垃圾污染。
 * 清空范围仅限本场景自己的标签目录。
 */
function purgeProductsRoot(label: string): void {
  rmSync(productsRootOf(label), { recursive: true, force: true });
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ---------------------------------------------------------------------------
// J4：只在聊天里报文件名 ⇒ 假；带意图 ⇒ 真（对照）
// ---------------------------------------------------------------------------

describe('J4：只在聊天里报出文件名不构成交付；同一文件名在"带意图"下才是真产出', () => {
  const LABEL = 'j4-chat-line-vs-intent';
  let scenario: OfficeScenario;
  let plan: ArtifactPlan;

  // 负向臂与正向臂**共用同一个场景标签** ⇒ 同一个产物根、同一个最终路径。
  // 这样两次实测比较的是**同一个文件名**：判据的差别只可能来自"有没有走交付路径"。
  beforeAll(() => {
    purgeProductsRoot(LABEL);
    scenario = buildOfficeScenario(LABEL);
    registerScenarioFacts(scenario, 8);

    // 用**纯函数**算出"若交付，产物会叫什么"——id 只由 (task, revision, kind, version) 派生，
    // 与摘要 / 根目录无关（R51.4），故这里能在未暂存时就知道身份与路径。
    const snapshot = buildFactSnapshot({
      facts: snapshotSharedFacts(scenario.store.snapshot()),
      task_id: OFFICE_TASK_ID,
      task_revision: OFFICE_TASK_REVISION,
      fact_keys: OFFICE_FACT_KEYS_BY_KIND.document,
    });
    expect(snapshot.unusable.length, '前置事实应齐备（否则本对照无效）').toBe(0);
    const bytes = buildTemplateBytes('document', snapshot.usable, OFFICE_TEMPLATE_INPUTS);
    plan = planArtifact({
      task_id: OFFICE_TASK_ID,
      task_revision: OFFICE_TASK_REVISION,
      template_kind: 'document',
      artifact_version: 1,
      root_dir: toForwardSlashes(scenario.root()),
      expected_content_digest: sha256Hex(bytes),
    });
  });

  afterAll(() => {
    scenario.cleanup();
  });

  it('负向臂：只在聊天里报出文件名 ⇒ artifacts() 无该任务的 published 记录，artifactOf 查不到', () => {
    // "聊天里的一条消息"——只有文件名，没有走任何交付路径。
    const chatMessage = { kind: 'chat', text: `已经生成好了：${plan.final_path}` };
    expect(chatMessage.text.includes(plan.final_path), '聊天文本确实点名了这个文件').toBe(true);

    // 交付判据（R47.3）：查不到记录 = 占位引用、未交付。
    expect(scenario.artifacts()).toEqual([]);
    expect(scenario.artifactOf(plan.artifact_id)).toBeUndefined();
    expect(
      scenario.artifacts().filter((record) => isDeliveredArtifact(record)).length,
      'published 记录数',
    ).toBe(0);

    // 文件名指不到盘上的任何文件，也读不回来 ⇒ "交付"是假的。
    expect(existsSync(plan.final_path), '聊天里点名的文件不得存在').toBe(false);
    expect(scenario.materializeCalls(), '没有走交付路径 ⇒ 端口零调用').toBe(0);
  });

  it('正向臂（对照）：带意图走暂存 + 发布投影 ⇒ 同一个 artifact_id 真产出、真读回', () => {
    scenario.mark('intent');
    scenario.materializeAll();
    scenario.mark('published');

    const record = scenario.artifactOf(plan.artifact_id);
    expect(record, '同一个 artifact_id 现在应有记录（与负向臂是同一个身份）').toBeDefined();
    if (record === undefined) throw new Error('缺少记录');
    expect(record.status, '记录状态').toBe('published');
    expect(isDeliveredArtifact(record), '交付判据').toBe(true);
    expect(record.template_kind).toBe('document');
    expect(record.task_revision).toBe(OFFICE_TASK_REVISION);

    // 路径与负向臂里"聊天报出的文件名"**完全相同**（同一标签 ⇒ 同一产物根）。
    const path = scenario.runFileOf(record);
    expect(toForwardSlashes(path)).toBe(plan.final_path);
    expect(existsSync(path), '带意图后文件真的在盘上').toBe(true);

    // 读回通过 ⇒ 不是"文件存在但内容读不出来"。
    const readback = scenario.readback(path);
    expect(readback.ok).toBe(true);
    expect(readback.unzip_test.exit_code).toBe(0);

    // 端口被调用 3 次（三类产物），且三类都发布成功。
    expect(scenario.materializeCalls()).toBe(3);
    expect(scenario.artifacts().filter((row) => isDeliveredArtifact(row)).length).toBe(3);
  });

  it('staged（已暂存但未发布）同样不构成交付：无回执、盘上无文件', () => {
    // 用**内核自己的**暂存事务（R49.1 事务 1）拿一条 staged 记录 —— 不调用 tx.putArtifact。
    const label = 'j4-staged-not-delivered';
    purgeProductsRoot(label);
    const clock = new LogicalClock();
    const store = createMemoryStore({ clock: () => clock.now() });
    const root = productsRootOf(label);
    const at = asLogicalTime(clock.now());
    store.transact((tx) => {
      tx.putTask(
        createTaskRecord({
          task_id: OFFICE_TASK_ID,
          goal: 'staged 不构成交付（J4 的 I-4 形态）',
          current_group_id: OFFICE_GROUP_ID,
          revision: OFFICE_TASK_REVISION,
          created_at: at,
          updated_at: at,
        }),
      );
      tx.putSharedFact(confirmedFact('fact-headcount', OFFICE_SHARED_FACT_KEY, headcountValue(8)));
    });

    const staged = store.transact((tx) =>
      stageArtifactInTransaction(tx, {
        intent: {
          template_kind: 'spreadsheet',
          sheet: {
            sheet_name: '人数汇总',
            label_header: '项目',
            value_header: '数量',
            unit: '人',
            lines: [{ label: '参会人数', fact_key: OFFICE_SHARED_FACT_KEY }],
            total_label: '合计',
            scale: 0,
          },
        },
        task_id: OFFICE_TASK_ID,
        task_revision: OFFICE_TASK_REVISION,
        artifact_version: 1,
        fact_keys: [OFFICE_SHARED_FACT_KEY],
        root_dir: toForwardSlashes(root),
        created_by_instance_id: OFFICE_INSTANCE_ID,
        at,
      }),
    );

    expect(staged.ok, '暂存本身应成功（否则本条无法证明"staged 不是交付"）').toBe(true);
    if (!staged.ok) throw new Error(staged.detail);

    const records = store.snapshot().artifacts;
    expect(records.length, '存储里应有恰好一条记录').toBe(1);
    const record = records[0];
    expect(record?.status, '暂存后状态').toBe('staged');
    expect(record?.receipt, 'staged 不得有回执').toBe(null);
    expect(isDeliveredArtifact(record as ArtifactRecord), 'staged 的交付判据').toBe(false);
    expect(existsSync(toForwardSlashes(staged.request.plan.final_path)), '尚未发布 ⇒ 最终路径不存在').toBe(false);
    expect(existsSync(toForwardSlashes(staged.request.plan.staging_path)), '尚未物化 ⇒ 临时路径不存在').toBe(false);

    purgeProductsRoot(label);
  });
});

// ---------------------------------------------------------------------------
// J9：版本闸门（R49.1 段 2 第一步）——收尾入口的 stale 早退
// ---------------------------------------------------------------------------

/** 该模板种类下"若交付本会派生"的产物 id（R51.4：id 只由 task / revision / kind / version 派生）。 */
function wouldBeArtifactId(kind: TemplateKind): ArtifactRef {
  return deriveArtifactId({
    task_id: OFFICE_TASK_ID,
    task_revision: OFFICE_TASK_REVISION,
    template_kind: kind,
    artifact_version: OFFICE_ARTIFACT_VERSION,
  });
}

/**
 * 与夹具 `materializeAll()` **同形**的产物意图（Agent 只给"意图 + 事实键"，无数字、无版本）。
 *
 * 复用夹具**导出**的 `OFFICE_TEMPLATE_INPUTS` / `OFFICE_FACT_KEYS_BY_KIND`（单一来源），
 * 不复制它的私有表；重建它只是为了拿到 `finishRun` 的**返回值**（`materializeAll()` 吞掉了它）。
 */
function artifactIntentFor(kind: TemplateKind): ArtifactPublicationIntent {
  const fact_keys = OFFICE_FACT_KEYS_BY_KIND[kind];
  switch (kind) {
    case 'document': {
      const input = OFFICE_TEMPLATE_INPUTS.document;
      if (input === undefined) throw new Error('夹具的 OFFICE_TEMPLATE_INPUTS 缺 document 输入');
      return {
        intent: { template_kind: 'document', requirement: input.requirement, references: input.references },
        fact_keys,
      };
    }
    case 'spreadsheet': {
      const input = OFFICE_TEMPLATE_INPUTS.spreadsheet;
      if (input === undefined) throw new Error('夹具的 OFFICE_TEMPLATE_INPUTS 缺 spreadsheet 输入');
      return { intent: { template_kind: 'spreadsheet', sheet: input.spec }, fact_keys };
    }
    case 'presentation': {
      const input = OFFICE_TEMPLATE_INPUTS.presentation;
      if (input === undefined) throw new Error('夹具的 OFFICE_TEMPLATE_INPUTS 缺 presentation 输入');
      return {
        intent: {
          template_kind: 'presentation',
          title: input.title,
          goal: input.goal,
          audience: input.audience,
        },
        fact_keys,
      };
    }
  }
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

describe('J9：物化前任务版本被超越 ⇒ 内核在收尾入口拒绝整个轮次（零记录、零写盘、端口零调用）', () => {
  /**
   * ## 为什么这条用例不（也无法）经公开入口复现 `superseded`
   *
   * `superseded` 那条状态语义（**R58**：版本闸门的落库状态是 `superseded`，**不是** `failed`；
   * `failure_kind` 仍记 `version_stale`、`receipt` 为 `null`）由 **`src/artifacts/publish.ts`
   * 的提交后投影路径**承担——先暂存 `staged`、投影时才发现版本被超越、于是放弃物化并记
   * `superseded`。它服务于**恢复 / 重放**路径，已由 **`v3-publish-independent.test.ts`**
   * （§版本闸门，`记录绑 r1、任务已到 r2 ⇒ superseded`）独立覆盖。
   *
   * 经**公开完成入口**（`onMessage → startRun → finishRun`）**无法**复现那条路径：
   * `finishRunInTransaction` 在写任何记录**之前**就以 `stale_task_revision` 早退
   * （"陈旧轮次不得发布"），因此一条 `ArtifactRecord` 都不会产生。
   * **为"复现 superseded"去伪造 `current_task_revision` 是夹具操纵内核**——本用例**不做**。
   */
  it('记录绑 r1、任务已到 r2 ⇒ finishRun 拒绝（stale_task_revision），一条记录都不写', () => {
    const LABEL = 'j9-version-gate';
    purgeProductsRoot(LABEL);
    const scenario = buildOfficeScenario(LABEL);
    try {
      registerScenarioFacts(scenario, 8);
      scenario.mark('facts-confirmed');

      // 任务版本被超越（"用户改了需求"的可执行形式）。
      const bumpedAt = asLogicalTime(scenario.store.snapshot().tasks[0]?.revision ?? 0);
      scenario.store.transact((tx) => {
        tx.putTask(
          createTaskRecord({
            task_id: OFFICE_TASK_ID,
            goal: '场景：版本闸门（任务版本被超越）',
            current_group_id: OFFICE_GROUP_ID,
            revision: asRevision(2),
            created_at: bumpedAt,
            updated_at: bumpedAt,
          }),
        );
      });
      scenario.mark('task-revision-bumped');

      // 前置：场景装配时启动了一个轮次，三条工作项已被它认领（否则下面的断言可能是空集假绿）。
      const runs = scenario.snapshot().runs;
      expect(runs, '前置：恰好一个轮次').toHaveLength(1);
      const run = runs[0];
      if (run === undefined) throw new Error('断言保护：场景应已启动一个轮次');
      const workItems = scenario.snapshot().work_items;
      expect(workItems, '前置：三条工作项已被轮次认领').toHaveLength(TEMPLATE_KINDS.length);

      // 经**内核公开入口**收尾（`OfficeScenario` 的冻结接口暴露了 `scheduler`；
      // 夹具的 `materializeAll()` 只是它的薄包装，且吞掉了返回值——本用例要断言的正是这个结局）。
      // 发布带**产物意图**：否则"零产物记录"会是空断言——版本闸门若缺失，这三条发布本会
      // 产出 3 条 published 记录 + 3 次端口调用 + 3 个盘上文件。
      const publications = TEMPLATE_KINDS.map((kind, index) => ({
        kind: 'completed' as const,
        request_id: workItems[index]!.request_id,
        result_refs: [] as readonly ArtifactRef[],
        artifact: artifactIntentFor(kind),
      }));
      const outcome = scenario.scheduler.finishRun({ run_id: run.run_id, publications });
      scenario.mark('finish-rejected-stale');

      // ① 结局是**拒绝**，且拒因为 stale_task_revision。
      expect(outcome.accepted).toBe(false);
      expect(outcome.rejection_reason).toBe('stale_task_revision');
      expect(outcome.applied_request_ids).toEqual([]);

      // ② 零产物记录（三路判据：集合 / 身份 / 交付）。
      expect(scenario.artifacts()).toEqual([]);
      for (const kind of TEMPLATE_KINDS) {
        expect(scenario.artifactOf(wouldBeArtifactId(kind))).toBeUndefined();
      }
      expect(scenario.artifacts().filter((record) => isDeliveredArtifact(record))).toEqual([]);

      // ③ 端口零调用、零写盘（连产物根都不该被创建）。
      expect(scenario.materializeCalls()).toBe(0);
      expect(existsSync(scenario.root()), '未物化 ⇒ 产物根不应存在').toBe(false);
      expect(listFilesUnder(scenario.root())).toEqual([]);

      // ④ 工作项未被写成"已完成"：被拒的收尾不得把工作项从认领后的 processing 推进哪怕一步。
      expect(scenario.snapshot().work_items.map((item) => item.status)).toEqual(
        TEMPLATE_KINDS.map(() => 'processing'),
      );
    } finally {
      scenario.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// J10：端口返回结构化失败
// ---------------------------------------------------------------------------

const RIG_SHEET = {
  sheet_name: '人数汇总',
  label_header: '项目',
  value_header: '数量',
  unit: '人',
  lines: [{ label: '参会人数', fact_key: OFFICE_SHARED_FACT_KEY }],
  total_label: '合计',
  scale: 0,
} as const;

interface FailureRig {
  readonly store: Store;
  readonly plan: ArtifactPlan;
  readonly fact: StagedArtifactFact;
  readonly outcomes: ReturnType<
    ReturnType<typeof createArtifactPublicationProjection>['reconcile']
  >;
  readonly writes: number;
  readonly calls: number;
  readonly stagedStatus: string;
}

/** 用**内核自己的**暂存事务 + 真实发布投影跑一遍（端口注入故障）。 */
function runFailureRig(label: string, failAt: FsArtifactPortFailAt): FailureRig {
  purgeProductsRoot(label);
  const clock = new LogicalClock();
  const store = createMemoryStore({ clock: () => clock.now() });
  const root = productsRootOf(label);
  const at = asLogicalTime(clock.now());

  store.transact((tx) => {
    tx.putTask(
      createTaskRecord({
        task_id: OFFICE_TASK_ID,
        goal: '场景：端口结构化失败（J10）',
        current_group_id: OFFICE_GROUP_ID,
        revision: OFFICE_TASK_REVISION,
        created_at: at,
        updated_at: at,
      }),
    );
    tx.putInstance(
      createInstanceState({
        instance_id: OFFICE_INSTANCE_ID,
        group_id: OFFICE_GROUP_ID,
        updated_at: at,
      }),
    );
    tx.putSharedFact(confirmedFact('fact-headcount', OFFICE_SHARED_FACT_KEY, headcountValue(8)));
  });

  const port = createFsArtifactMaterializationPort({
    read_revision: (taskId: TaskId) => {
      const task = store.snapshot().tasks.find((row) => row.task_id === taskId);
      return task === undefined ? null : task.revision;
    },
    now: () => clock.now(),
    fail_at: failAt,
  });
  const projection = createArtifactPublicationProjection({ store, port });

  const staged = store.transact((tx) =>
    stageArtifactInTransaction(tx, {
      intent: { template_kind: 'spreadsheet', sheet: RIG_SHEET },
      task_id: OFFICE_TASK_ID,
      task_revision: OFFICE_TASK_REVISION,
      artifact_version: 1,
      fact_keys: [OFFICE_SHARED_FACT_KEY],
      root_dir: toForwardSlashes(root),
      created_by_instance_id: OFFICE_INSTANCE_ID,
      at,
    }),
  );
  if (!staged.ok) throw new Error(`暂存失败（${staged.kind}）：${staged.detail}`);

  const fact = createStagedArtifactFact(staged.record, staged.request);
  const outcomes = projection.reconcile([fact], asLogicalTime(clock.now()));

  return {
    store,
    plan: staged.request.plan,
    fact,
    outcomes,
    writes: port.writes,
    calls: port.calls,
    stagedStatus: staged.record.status,
  };
}

describe('J10：端口返回结构化失败 ⇒ 记录 failed、detail 非空、绝不冒充 published', () => {
  const EXPECTED_KIND: Readonly<Record<'build' | 'write' | 'verify', string>> = {
    build: 'builder_failed',
    write: 'write_failed',
    verify: 'self_check_failed',
  };

  it('开关集合与端口声明一致（三条分支都在写盘前短路）', () => {
    expect([...FS_ARTIFACT_PORT_FAIL_AT]).toEqual(['build', 'write', 'verify']);
  });

  for (const failAt of FS_ARTIFACT_PORT_FAIL_AT) {
    it(`fail_at=${failAt} ⇒ ${EXPECTED_KIND[failAt]}：failed + detail 非空 + 盘上不留文件`, () => {
      const rig = runFailureRig(`j10-injected-${failAt}`, failAt);
      try {
        // 先断言内核确实暂存了（否则"failed"可能只是因为什么都没发生）。
        expect(rig.stagedStatus, '暂存阶段的状态').toBe('staged');
        expect(rig.calls, '端口确实被调用过一次').toBe(1);
        expect(rig.outcomes.length, '投影结局条数').toBe(1);

        const outcome = rig.outcomes[0];
        expect(outcome?.kind, '投影结局').toBe('failed');
        expect((outcome?.detail.length ?? 0) > 0, 'detail 不得为空').toBe(true);
        expect(outcome?.failure_kind).toBe(EXPECTED_KIND[failAt]);

        const stored = rig.store.snapshot().artifacts;
        expect(stored.length, '存储里应有恰好一条记录').toBe(1);
        const record = stored[0];
        expect(record?.status, '记录终态').toBe('failed');
        expect(record?.failure_kind, '记录里的失败种类').toBe(EXPECTED_KIND[failAt]);
        expect(record?.receipt, '失败产物不得有回执').toBe(null);
        expect(isDeliveredArtifact(record as ArtifactRecord), '失败产物的交付判据').toBe(false);

        // **盘上不得留下被误标通过的文件**：最终路径与临时路径都不存在，且从未真正写过。
        expect(existsSync(toForwardSlashes(rig.plan.final_path)), '最终路径不得存在').toBe(false);
        expect(existsSync(toForwardSlashes(rig.plan.staging_path)), '临时路径不得残留').toBe(false);
        expect(rig.writes, '注入故障在写盘前短路 ⇒ 零次写入').toBe(0);
      } finally {
        // 无论断言结果如何都清掉本场景的产物根：否则残留字节会让**下一次**运行的
        // 幂等路径（R50.3）直接命中，把这条反例悄悄变成假绿。
        purgeProductsRoot(`j10-injected-${failAt}`);
      }
    });
  }

  it('对照（防恒假）：同一套装置、不开故障开关 ⇒ 同一 artifact_id 变 published 且有文件', () => {
    const rig = runFailureRig('j10-control-no-injection', null);
    try {
      expect(rig.stagedStatus).toBe('staged');
      expect(rig.outcomes.length).toBe(1);
      const outcome = rig.outcomes[0];
      expect(outcome?.kind).toBe('published');
      expect(outcome?.failure_kind).toBe(null);

      const stored = rig.store.snapshot().artifacts;
      expect(stored.length).toBe(1);
      const record = stored[0];
      expect(record?.status).toBe('published');
      expect(isDeliveredArtifact(record as ArtifactRecord)).toBe(true);

      const finalPath = toForwardSlashes(rig.plan.final_path);
      expect(existsSync(finalPath), '对照臂必须真的写出文件（否则失败臂的"无文件"无意义）').toBe(true);
      expect(rig.writes, '对照臂恰好写一次').toBe(1);
    } finally {
      purgeProductsRoot('j10-control-no-injection');
    }
  });
});
