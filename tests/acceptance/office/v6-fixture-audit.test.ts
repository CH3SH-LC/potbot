/**
 * **V6 夹具自审（task-id: D02A-V6）** —— 把"**夹具不得替被测内核干活**"这条审计结论
 * **机器化**成可失败、可复核的断言。
 *
 * ## 这份文件审的不是功能，是"**证据的可信度**"
 *
 * 本项目的失效模式之一（见 `docs/information/information-02-修复批实证经验.md` 的 info-008 与
 * `p1-real-files.test.ts` 的历史）是：**夹具自己把内核的步骤做掉了**（曾自己写 `staged` 记录），
 * 于是"经内核产出"这一 claim 不成立，而全部用例照样绿。
 *
 * 因此这里只回答五个问题，每条都给**可机器判**的证据或**逐行引用**：
 *
 * | # | 问题 | 落点 |
 * |---|---|---|
 * | 1 | `office-support.ts` 是否还在代办内核步骤（写产物记录 / 造产物字节 / 置 published / 造 missing_fact 失败记录） | §A 源码扫描 |
 * | 2 | 从"登记事实"到"盘上出现文件"的实际调用链，逐跳归谁 | §A/§C/§E（本文件头"调用链"一节给出逐跳 `file:line`） |
 * | 3 | "夹具不得代办"的可失败断言 + **扫描器自身的可失败性自证** | §A / §C / §E |
 * | 4 | `office-negative.test.ts` 的 J4 反面对照是否**真的**走完了与正例相同的路径 | §D |
 * | 5 | 仍依赖夹具前置数据的地方 + 合法性判据 | §F |
 *
 * ## 本文件的用例自带显式超时（30 s）
 *
 * §E/§F 的用例都走**完整场景装配**（登记事实 → 经内核建轮次与工作项 → 物化到盘 → 复核），
 * 单跑约 2–4 s。全仓 3000+ 用例跑起来时机器负载高，默认 5 s 会**假红**
 * （实测：同一条单独跑 2.7 s，全量跑曾越过 5 s）。按 **R53.6** 的取向，
 * 重型用例**自带**显式超时，而**不去动** `vitest.config.ts` 的 `testTimeout`
 * （构建配置是冻结身份的一部分，由 v8-contract-conformance 机器化断言）。
 *
 * ## 判据来源
 *
 * 合同 v1.4 的 **R47.3**（读侧约定）、**R48.3 / R48.4**（单一来源 / 缺失不得当零）、
 * **R49.1–R49.2**（三段式与 I-1…I-4）、**R50.3 / R50.4**（端口幂等 / `node:fs` 只许在验收侧宿主实现）、
 * **R52.2 / R53.7**（产物落点与清理）、**R56 / R56.1 / R56.2**（产物意图、暂存入口、提交后投影）、
 * **R57**（请求携带已构建字节，存在时端口**必须**直接写它）、**R61**（落点与清理的裁定）。
 *
 * ## 纪律
 *
 * - **只新增本文件**：不改夹具、不改 `src/**`、不改其它测试；不调用 `openWithOffice`；
 * - 断言用**等号**；每条先断言"确实产生了数据"，再断言语义（R22）；
 * - 本文件**不调用 `scenario.cleanup()`**：那是 R52.2 的**证据登记**入口，而本文件不产出交付证据。
 *   它只按产物根规则**清空自己用过的标签目录**（与 p1 / office-negative 的 `purgeProductsRoot` 同源），
 *   以免把审计产物混进证据报告；
 * - **不编造**：凡是"看不出来"的地方（如"端口到底走了 payload 还是回退构建器"）就地标注
 *   **不可判别**并给出推断链，不写成结论。
 *
 * ## 被审快照（本审计针对的字节；这些文件在被审期间**正在被其它工作包改动**）
 *
 * | 文件 | sha256（本文件成型时） |
 * |---|---|
 * | `tests/acceptance/office/office-support.ts` | `0a25e58e2fc54e970f38eb6673d999bc838fbe28e7419aa51c16022e45b01d8c` |
 * | `tests/acceptance/office/fs-artifact-port.ts` | `e439530c1986335142f9dc1333b3c176456202cb0b5ada0eb17fdbab24f33a8b` |
 * | `src/artifacts/staging.ts` | `d3fca074a6325e9a802f7ef07587bcd1405f7e33f235e1801860edadf09e3b0e` |
 * | `src/artifacts/publish.ts` | `fe060b7a903c564cb16a9a6adacf3a8441db1e3967801cfe301e25b27410c068` |
 * | `src/scheduler/runs.ts` | `52825fae5ab15915a01131f0839b86992598bd2634151d79e3d4656466de0ec4` |
 * | `src/scheduler/scheduler.ts` | `2cd1d2a104a8a4de530424e996adc5e7110c7a99d5a8d6b6bbb692996b217454` |
 *
 * **审计期间实测到的漂移（如实登记，不掩盖）**：14:21 首次实测时
 * `p3-shared-facts.test.ts`（4 例）与 `office-negative.test.ts`（J9，1 例）为**红**——
 * 原因是它们仍按"缺事实 ⇒ 写一条 `failed` + `failure_kind='missing_fact'` 记录"与
 * "版本被超越 ⇒ 三条 `superseded` 记录"断言，而改造后的夹具/内核这两条路径都**不写记录**
 * （见 §B3 / §F4）。14:23–14:26 期间这些文件被其它工作包改写为与内核一致；
 * 本文件因此**不**把"某个兄弟文件当前写没写某句话"写成断言（那会在并发改动下制造假红），
 * 只钉住**内核/夹具的语义**（可重测）。
 *
 * ## 实测的调用链（问题 2 的答案；括号 = 归属）
 *
 * ```
 * 测试 registerFact(fact)
 *   └─ office-support.ts:522-526  tx.putSharedFact                 【夹具：场景前置输入】
 * 测试 materializeAll()
 *   └─ office-support.ts:538-551  scheduler.finishRun({publications})    【夹具，仅放行】
 *      └─ src/scheduler/scheduler.ts:363-375  #transactAndReconcile      【内核】
 *         └─ src/scheduler/runs.ts:626 finishRunInTransaction            【内核】
 *            └─ runs.ts:804-817  stagePublicationArtifact(runs.ts:1039)  【内核】
 *               └─ src/artifacts/staging.ts:162 stageArtifactInTransaction
 *                  ├─ staging.ts:167 buildFactSnapshot          【内核：事实从存储取，Agent 无数字】
 *                  ├─ staging.ts:174 !isFactSnapshotUsable ⇒ missing_fact，不写任何记录 【内核 R48.4】
 *                  ├─ staging.ts:136-154 buildBytes（纯构建器）   【内核：字节在事务 1 内算出】
 *                  ├─ staging.ts:198 planArtifact（派生 id / 路径）【内核 R51.4/R51.5】
 *                  ├─ staging.ts:212 createArtifactRecord(staged) 【内核】
 *                  └─ staging.ts:232 tx.putArtifact(record)       【内核：唯一写产物记录处】
 *            └─ runs.ts:1097-1103 artifact_staged 观测事件          【内核】
 *      └─（提交之后）scheduler.ts:369-371 #publishArtifacts(scheduler.ts:220) → publish.ts:381 【内核】
 *         ├─ publish.ts:424-440 版本闸门                                【内核】
 *         ├─ publish.ts:443 port.materialize(request)                   【内核调端口】
 *         │  └─ fs-artifact-port.ts:233 → :411 #bytesFor(:160 payloadOf)
 *         │     ├─ 写临时路径 fs-artifact-port.ts:301                    【验收侧宿主实现，R50.4 指定】
 *         │     ├─ 结构自检 :314 → 原子 rename :328 → 回读 :342 → 核对摘要 :352
 *         │     └─ 成功回执 :492
 *         └─ publish.ts:464-472 段 3 tx.putArtifact(published)          【内核：唯一置 published 处】
 * ```
 *
 * 结论：从"登记事实"到"盘上出现文件"共 **3 个夹具落点**——① `registerFact`（前置事实输入）、
 * ② `materializeAll`（只调 `finishRun`，不写任何记录）、③ 端口宿主实现（合同 R50.4 **要求**它落在
 * `tests/acceptance/office/**`）。**没有任何一跳是"夹具替内核写状态或造字节"**。
 * 唯一"看起来像"的是 `office-support.ts:431` 给端口注入的 `build_bytes` 回退构建器（R57 允许），
 * 见 §C：它在本场景路径上**不会被走到**（请求一律带 `payload`）。
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { LogicalClock } from '../../../src/clock/index.js';
import { createMemoryStore } from '../../../src/storage/index.js';
import {
  TEMPLATE_KINDS,
  asArtifactRef,
  asFactRef,
  asLogicalTime,
  asRevision,
  asRunId,
  asTaskId,
  createSharedFactRecord,
  isDeliveredArtifact,
  type SharedFactRecord,
  type SharedFactValue,
  type TaskId,
} from '../../../src/protocol/index.js';
import {
  deriveArtifactId,
  planArtifact,
  type ArtifactMaterializationRequest,
} from '../../../src/artifacts/index.js';
import type { KnownFactSnapshotEntry } from '../../../src/artifacts/ports.js';
import {
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
  buildTemplateBytes,
  createFsArtifactMaterializationPort,
} from './fs-artifact-port.js';

// ---------------------------------------------------------------------------
// 路径与文件读取
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** 被审对象（问题 1 / 5 的源码级证据）。 */
const OFFICE_SUPPORT_PATH = join(REPO_ROOT, 'tests/acceptance/office/office-support.ts');
const NEGATIVE_TEST_PATH = join(REPO_ROOT, 'tests/acceptance/office/office-negative.test.ts');
/** 扫描器的**正对照**：这两处本来就含被扫的 token（见 §A 的自证）。 */
const STAGING_SRC_PATH = join(REPO_ROOT, 'src/artifacts/staging.ts');
const PUBLISH_SRC_PATH = join(REPO_ROOT, 'src/artifacts/publish.ts');

function readSource(path: string): string {
  return readFileSync(path, 'utf8');
}

// ---------------------------------------------------------------------------
// 源码扫描器（**可失败性自证**见 §A 的"正对照"用例）
// ---------------------------------------------------------------------------

interface TokenHit {
  readonly token: string;
  /** 1 起的行号。 */
  readonly line: number;
  /** 该行原文（去掉行尾）。 */
  readonly text: string;
}

/** 命中一处 token ⇒ 一行记录（逐行给证据）。 */
function scanTokens(text: string, tokens: readonly string[]): readonly TokenHit[] {
  const lines = text.split('\n');
  const hits: TokenHit[] = [];
  for (const [index, line] of lines.entries()) {
    for (const token of tokens) {
      if (line.includes(token)) {
        hits.push(Object.freeze({ token, line: index + 1, text: line.trim() }));
      }
    }
  }
  return Object.freeze(hits);
}

/** 该行是否只是注释 / 文档（`*` / `//` / `/*` 开头）。 */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*');
}

/** 只保留**代码行**上的命中（注释里的提及不算代办）。 */
function codeHitsOnly(hits: readonly TokenHit[]): readonly TokenHit[] {
  return Object.freeze(hits.filter((hit) => !isCommentLine(hit.text)));
}

/** `tx.putXxx(` 的调用点（要求 `tx` 前不是字母，避免命中 `pptx.js`）。 */
function scanTxPuts(text: string): readonly string[] {
  const matches = text.match(/(?:^|[^A-Za-z])tx\.put[A-Za-z]+\(/gm) ?? [];
  return Object.freeze(
    matches
      .map((entry) => {
        const start = entry.indexOf('tx.');
        return entry.slice(start, entry.indexOf('('));
      })
      .sort(),
  );
}

/**
 * 证据落盘位置。
 *
 * `evidenceOutputLocation()` 每次都**全量复算** `src/**` + `tests/**` 的 680 个 `.ts` 摘要
 * （实测单次 ≈ 0.4 s，`tests/acceptance/source-digest.ts` 无缓存）。而一次运行之内工作树
 * **不会变**，该值因此是**只读快照**——本文件原先在**模块加载时**取一次，把原先每个用例
 * （建场景 / 清产物根）各付一次的复算降为一次。这不是放宽判据：取到的仍是同一复算结果。
 *
 * 现在更进一步：直接复用 `office-support` 那份**同一个模块级快照**推出的位置
 * （`SCENARIO_EVIDENCE_DIR` 由 `SCENARIO_STAMP` 取出，公式与本文件原先调用的完全相同），
 * 于是"整棵树在一次运行里只复算一次"——目录一字不差（`evidenceOutputLocation` 与其
 * `FromStamp` 版同源）。
 */
const EVIDENCE_DIR = SCENARIO_EVIDENCE_DIR;

/** 产物根（目录规则与 `office-support` 同源：`{证据位置}/products/{label}`）。 */
function productsRootOf(label: string): string {
  return join(EVIDENCE_DIR, 'products', label);
}

const liveLabels: string[] = [];

/** 建场景前先清空本标签的产物根：不让上一次中断运行的字节经端口幂等路径（R50.3）混进来。 */
function freshScenario(label: string): OfficeScenario {
  rmSync(productsRootOf(label), { recursive: true, force: true });
  liveLabels.push(label);
  return buildOfficeScenario(label);
}

afterEach(() => {
  for (const label of liveLabels.splice(0)) {
    rmSync(productsRootOf(label), { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 共享的"齐备事实 + 已放行物化"场景（只读复用；不改断言，只去掉重复装配）
// ---------------------------------------------------------------------------
//
// §C4 / §D3 / §E1b / §E2 / §E3 五条用例**只**对"事实齐备且已放行"之后的**只读状态**做断言
// （记录集 / 内核事件 / 内核派生身份 / 盘上字节），既不改场景状态、也不删产物根，彼此独立。
// 它们原先各自从头装配 + 物化一遍；这里改为共用**同一次**装配与物化。
//
// **不共享**的是所有带副作用 / 依赖"放行前"状态的用例：§B1–§B5（放行前计数为 0）、
// §D2 / §D2b（自定义收尾）、§E1（放行前要求零暂存事件）、§F2–§F4（另行构造）——它们**各自新开**，
// 以免用例之间互相污染（判定标准：该装配是否被用例修改）。断言数量与内容一条未动。

const SHARED_LABEL = 'v6-shared-complete-readonly';

let sharedComplete: OfficeScenario | null = null;

/** 齐备事实 + 已放行的共享场景（惰性建一次；本文件结束时清掉它的产物根）。 */
function sharedCompleteScenario(): OfficeScenario {
  if (sharedComplete === null) {
    rmSync(productsRootOf(SHARED_LABEL), { recursive: true, force: true });
    const scenario = buildOfficeScenario(SHARED_LABEL);
    registerCompleteFacts(scenario, 8);
    scenario.materializeAll();
    sharedComplete = scenario;
  }
  return sharedComplete;
}

beforeAll(() => {
  sharedCompleteScenario();
});

afterAll(() => {
  rmSync(productsRootOf(SHARED_LABEL), { recursive: true, force: true });
  sharedComplete = null;
});

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
    source: { kind: 'user_confirmation', detail: '用户在前台确认（V6 审计前置数据）' },
    // 确认者就是场景实例本身（只读引用夹具常量，不改夹具）。
    confirmed_by: OFFICE_INSTANCE_ID,
    confirmed_at: FIXED_TIME,
  });
}

/** 登记三类产物都齐备的事实（正例）或只登记部分（缺事实反例）。 */
function registerCompleteFacts(scenario: OfficeScenario, headcount: number): void {
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

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ---------------------------------------------------------------------------
// §A 问题 1 / 3：源码级"不得代办"断言 + 扫描器自证
// ---------------------------------------------------------------------------

/** 被禁的直接调用（夹具若调用它们，就是"替内核干活"）。 */
const FORBIDDEN_IN_FIXTURE = Object.freeze([
  // ① 自己写产物记录
  'putArtifact(',
  'createArtifactRecord(',
  // ② 自己造产物字节（模板构建器的**直接调用**）
  'buildDocxTemplate(',
  'buildXlsxTemplate(',
  'buildPresentation(',
  'buildTemplateBytes(',
  // ③ 自己走暂存 / 发布（绕过 finishRun / publish.ts 的公开入口）
  'stageArtifactInTransaction(',
  'createArtifactPublicationProjection(',
  // ④ 自己判定缺事实
  'isFactSnapshotUsable(',
  // ⑤ 自己置终态
  "status: 'published'",
  "status: 'failed'",
]);

describe('§A 夹具不得代办内核步骤（源码级扫描 + 扫描器自证）', () => {
  const supportText = readSource(OFFICE_SUPPORT_PATH);

  it('office-support.ts 的代码里不出现任何被禁调用（命中一律为 0）', () => {
    const allHits = scanTokens(supportText, FORBIDDEN_IN_FIXTURE);
    const codeHits = codeHitsOnly(allHits);
    // 逐行给出证据（空数组 = 零命中）。
    expect(
      codeHits.map((hit) => `${hit.line}: ${hit.token} → ${hit.text}`),
      'office-support.ts 代码行上的被禁调用',
    ).toEqual([]);
    // 注释里的提及是**允许**的（本文件的审计恰恰依赖它们可读）——但必须如实列出。
    expect(
      allHits.map((hit) => hit.token).sort(),
      '注释里的提及（非代办，仅记录）',
    ).toEqual([]);
  });

  it('扫描器**不是空转**：同一函数在正对照上必须报出命中（否则上一条的"0"无意义）', () => {
    // 正对照 1：合成文本（证明 token 判定逻辑真的会红）。
    const synthetic = "tx.putArtifact(record);\n// createArtifactRecord(x)";
    const syntheticHits = codeHitsOnly(scanTokens(synthetic, FORBIDDEN_IN_FIXTURE));
    expect(syntheticHits.map((hit) => hit.token)).toEqual(['putArtifact(']);
    // 注意：`createArtifactRecord(x)` 在合成文本里位于行尾注释中 ⇒ 被 codeOnly 过滤，符合设计。
    expect(
      scanTokens(synthetic, ['createArtifactRecord(']).length,
      '裸扫描（不过滤注释）应能报出注释里的命中',
    ).toBe(1);

    // 正对照 2：**真实文件**——内核自己就这么写（staging.ts 落 staged、publish.ts 落 published）。
    const stagingHits = codeHitsOnly(scanTokens(readSource(STAGING_SRC_PATH), FORBIDDEN_IN_FIXTURE));
    const publishHits = codeHitsOnly(scanTokens(readSource(PUBLISH_SRC_PATH), FORBIDDEN_IN_FIXTURE));
    expect(
      stagingHits.some((hit) => hit.token === 'createArtifactRecord('),
      'staging.ts 应有 createArtifactRecord( 的代码命中',
    ).toBe(true);
    expect(
      stagingHits.some((hit) => hit.token === 'putArtifact('),
      'staging.ts 应有 putArtifact( 的代码命中',
    ).toBe(true);
    expect(
      publishHits.some((hit) => hit.token === 'putArtifact('),
      'publish.ts 应有 putArtifact( 的代码命中',
    ).toBe(true);
    // 结论：同一扫描器在"确实代办的文件"上会命中 ⇒ office-support.ts 的 0 命中是**有信息量**的。

    // 正对照 3（**必然为假的检查**）：把一行"代办"塞进 office-support 的源码文本，扫描器必须报红。
    // 这是"如果夹具退化成自己写产物记录，本文件会红"的直接证明（不改磁盘上的任何文件）。
    const mutated = `${supportText}\nfunction regression(): void { tx.putArtifact(record); }\n`;
    const mutatedHits = codeHitsOnly(scanTokens(mutated, FORBIDDEN_IN_FIXTURE));
    expect(
      mutatedHits.map((hit) => hit.token),
      '注入一行代办后扫描器必须命中（否则本节的"0 命中"就是空断言）',
    ).toEqual(['putArtifact(']);
  });

  it('A6 唯一的"造字节"痕迹是被注入的回退构建器（R57 允许），且它在本场景路径上走不到', () => {
    // 事实：office-support 只**引用** `createTemplateBytesBuilder`（转交给端口当 build_bytes），
    // 不直接调用任何模板构建器 —— §C1/C3 证明带 payload 时端口根本不碰回退构建器。
    expect(scanTokens(supportText, ['createTemplateBytesBuilder(']).length, '引用次数').toBe(1);
    expect(codeHitsOnly(scanTokens(supportText, ['createTemplateBytesBuilder('])).length).toBe(1);
    // 该 token 的**定义**在 fs-artifact-port（验收侧宿主实现，R50.4 指定的唯一落盘位置）。
    const portText = readSource(join(REPO_ROOT, 'tests/acceptance/office/fs-artifact-port.ts'));
    expect(portText.includes('export function createTemplateBytesBuilder(')).toBe(true);
    expect(portText.includes('export function buildTemplateBytes(')).toBe(true);
  });

  it('夹具对存储的**全部**写入只有 4 种，且都是"开工前就有的前置记录"', () => {
    expect([...new Set(scanTxPuts(supportText))].sort()).toEqual([
      'tx.putGroupMember',
      'tx.putInstance',
      'tx.putSharedFact',
      'tx.putTask',
    ]);
    // 逐条：不写产物记录、不写工作项、不写轮次、不写事件、不写收件箱。
    for (const forbiddenWrite of [
      'putArtifact',
      'putWorkItem',
      'putRun',
      'putKernelEvent',
      'putDeliveryEvent',
      'putInboxEntry',
      'putMessage',
    ]) {
      expect(
        supportText.includes(`${forbiddenWrite}(`),
        `office-support.ts 不得出现 ${forbiddenWrite}(`,
      ).toBe(false);
    }
  });

  it('夹具的产物记录面只导出**只读**读取（artifacts/artifactOf），没有任何写入面', () => {
    const writeFacing = ['ArtifactRecord', 'saveArtifact', 'recordArtifact', 'setArtifact'];
    for (const token of writeFacing) {
      if (token === 'ArtifactRecord') continue; // 只读投影里会用到这个类型名
      expect(supportText.includes(`${token}(`), `夹具不得暴露写入口 ${token}(`).toBe(false);
    }
    // 只读面确实存在（否则上面的"没有写入口"可能只是文件不存在）。
    expect(supportText.includes('artifacts(): readonly ArtifactRecord[]')).toBe(true);
    expect(supportText.includes('materializeCalls(): number')).toBe(true);
  });

  it('夹具头注释里关于 missing_fact 的三处提及全在注释内（代码里没有缺事实判定）', () => {
    const raw = scanTokens(supportText, ['missing_fact']);
    expect(raw.length, '注释里应有 3 处提及').toBe(3);
    expect(raw.every((hit) => isCommentLine(hit.text)), '全部位于注释行').toBe(true);
    expect(raw.map((hit) => hit.line)).toEqual([36, 40, 67]);
  });
});

// ---------------------------------------------------------------------------
// §B 问题 3：materializeCalls() 的敏感性（只在**内核经注入端口**调用时增长）
// ---------------------------------------------------------------------------

describe('§B materializeCalls() 只在被测内核调用注入端口时增长（配对反例）', () => {
  it('B1 装配本身不调端口：建场景 + 登记事实后，计数仍为 0、无记录、盘上无文件', () => {
    const label = 'v6-b1-assembly-only';
    const scenario = freshScenario(label);
    registerCompleteFacts(scenario, 8);

    expect(scenario.materializeCalls(), '装配/登记事实都不得碰端口').toBe(0);
    expect(scenario.artifacts(), '装配阶段不得有任何产物记录').toEqual([]);
    expect(existsSync(scenario.root()), '装配阶段不得建产物根').toBe(false);
  });

  it('B2 未知 run_id 的 finishRun 被拒 ⇒ 计数仍为 0、无记录（反例不是恒真）', () => {
    const label = 'v6-b2-bogus-run';
    const scenario = freshScenario(label);
    registerCompleteFacts(scenario, 8);

    const outcome = scenario.scheduler.finishRun({
      run_id: asRunId('run-does-not-exist'),
      publications: [],
    });
    expect(outcome.accepted, '未知 run 必须被拒').toBe(false);
    expect(outcome.rejection_reason).toBe('unknown_run');
    expect(scenario.materializeCalls(), '被拒的收尾不得调端口').toBe(0);
    expect(scenario.artifacts()).toEqual([]);
  });

  it('B3 缺事实 ⇒ 内核拒绝且**不写任何产物记录**（夹具不再造 missing_fact 失败记录）', () => {
    const label = 'v6-b3-missing-fact';
    const scenario = freshScenario(label);
    // 只登记 budget：三类产物都消费 headcount ⇒ 三类都缺。
    scenario.registerFact(
      confirmedFact('fact-budget', 'budget.total', {
        kind: 'known',
        value: { type: 'number', amount: 600, unit: 'CNY', currency: 'CNY' },
      }),
    );
    scenario.materializeAll();

    // 内核的处置（runs.ts:1066）：三条发布各自被拒，事件里可见 reason=missing_fact。
    const rejections = scenario
      .snapshot()
      .kernel_events.filter((event) => event.kind === 'publication_rejected');
    expect(rejections.length, '三条带意图的发布应各记一条拒绝').toBe(3);
    expect(rejections.map((event) => String(event.data['reason']))).toEqual([
      'missing_fact',
      'missing_fact',
      'missing_fact',
    ]);

    // R48.4：不产产物、不产零值产物 ⇒ 记录集合为空（**没有**夹具伪造的 failed 记录）。
    expect(scenario.artifacts()).toEqual([]);
    expect(
      scenario.artifacts().filter((record) => record.failure_kind === 'missing_fact').length,
      '不得存在 failure_kind=missing_fact 的产物记录（夹具不得代办失败记录）',
    ).toBe(0);
    expect(scenario.materializeCalls(), '缺事实时端口零调用').toBe(0);
    expect(existsSync(scenario.root()), '缺事实不得建产物根').toBe(false);
  });

  it('B4 事实齐备 ⇒ 计数从 0 变 3、三条记录 published（计数**敏感**，非恒真非恒假）', () => {
    const label = 'v6-b4-complete';
    const scenario = freshScenario(label);
    registerCompleteFacts(scenario, 8);
    expect(scenario.materializeCalls()).toBe(0); // 前置：0

    scenario.materializeAll();

    expect(scenario.materializeCalls(), '三类产物各物化一次').toBe(3);
    const records = scenario.artifacts();
    expect(records.length).toBe(3);
    expect(records.every((record) => record.status === 'published')).toBe(true);
    expect(records.every((record) => isDeliveredArtifact(record))).toBe(true);
    // 再次放行：夹具短路（office-support.ts:539），不重复物化。
    scenario.materializeAll();
    expect(scenario.materializeCalls(), '重复放行不得增加物化次数').toBe(3);
  });

  it('B5 计数器是**按注入端口**计的：外部端口的调用不会污染场景计数', () => {
    // 另建一个独立端口并在其上调用一次 —— 场景的计数器必须纹丝不动。
    const tempRoot = mkdtempSync(join(tmpdir(), 'potbot-v6-counter-'));
    const clock = new LogicalClock();
    const store = createMemoryStore({ clock: () => clock.now() });
    const payload = buildTemplateBytes(
      'document',
      [factEntry()],
      OFFICE_TEMPLATE_INPUTS,
    );
    const plan = planArtifact({
      task_id: asTaskId('T-v6-counter'),
      task_revision: asRevision(1),
      template_kind: 'document',
      artifact_version: 1,
      root_dir: tempRoot.split('\\').join('/'),
      expected_content_digest: sha256Hex(payload),
    });
    const foreignPort = createFsArtifactMaterializationPort({
      read_revision: () => asRevision(1),
      now: () => clock.now(),
    });
    const foreignResult = foreignPort.materialize({ ...requestFor(plan, asTaskId('T-v6-counter'), payload) });
    expect(foreignResult.ok, '外部端口应能自行物化（证明它确实被调过）').toBe(true);
    expect(foreignPort.calls).toBe(1);
    rmSync(tempRoot, { recursive: true, force: true });

    // 场景侧的计数不受外部端口影响。
    const scenario = freshScenario('v6-b5-counter-scope');
    registerCompleteFacts(scenario, 8);
    expect(scenario.materializeCalls(), '场景计数器与外部端口互不相干').toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §C 问题 1（②）/ 3：产物字节来自内核的 payload（R57），不是夹具回退构建器
// ---------------------------------------------------------------------------

function factEntry(): KnownFactSnapshotEntry {
  return {
    fact_ref: asFactRef('fact-headcount'),
    fact_key: 'headcount',
    value: { type: 'number', amount: 8, unit: '人', currency: null },
    source: { kind: 'user_confirmation', detail: '用户确认（V6 审计）' },
  };
}

function requestFor(
  plan: ReturnType<typeof planArtifact>,
  taskId: TaskId,
  payload?: Uint8Array,
): ArtifactMaterializationRequest {
  return {
    artifact_id: plan.artifact_id,
    task_id: taskId,
    task_revision: plan.task_revision,
    template_kind: plan.template_kind,
    fact_snapshot: [factEntry()],
    plan,
    expected_content_digest: plan.expected_content_digest,
    ...(payload === undefined ? {} : { payload }),
  };
}

describe('§C 端口取字节：payload（内核事务 1 算好的）优先，回退构建器不被走到', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function tempRootOf(tag: string): string {
    const root = mkdtempSync(join(tmpdir(), `potbot-v6-${tag}-`));
    roots.push(root);
    return root;
  }

  it('C1 请求带 payload ⇒ 回退构建器**一次都不被调用**，落盘字节 = payload 字节', () => {
    const root = tempRootOf('payload');
    const taskId = asTaskId('T-v6-payload');
    const payload = buildTemplateBytes('document', [factEntry()], OFFICE_TEMPLATE_INPUTS);
    const plan = planArtifact({
      task_id: taskId,
      task_revision: asRevision(1),
      template_kind: 'document',
      artifact_version: 1,
      root_dir: root.split('\\').join('/'),
      expected_content_digest: sha256Hex(payload),
    });

    let fallbackCalls = 0;
    const port = createFsArtifactMaterializationPort({
      read_revision: () => asRevision(1),
      now: () => asLogicalTime(0),
      build_bytes: () => {
        fallbackCalls += 1;
        throw new Error('回退构建器不应被调用：请求已带 payload（R57）');
      },
    });

    const result = port.materialize(requestFor(plan, taskId, payload));
    expect(result.ok, '带 payload 时应成功（回退构建器抛错也影响不到）').toBe(true);
    expect(fallbackCalls, '回退构建器调用次数').toBe(0);
    if (!result.ok) throw new Error('前置失败：端口未成功物化');
    const finalPath = result.receipt.final_path.split('\\').join('/');
    expect(existsSync(finalPath), '最终路径应真的落盘').toBe(true);
    expect(result.receipt.readback_digest, '回读摘要 = payload 摘要').toBe(sha256Hex(payload));
    expect(fallbackCalls, '回读之后再确认一次：仍未调用回退构建器').toBe(0);
  });

  it('C2 请求既无 payload 又无回退构建器 ⇒ 结构化失败 builder_failed（端口不自行造字节）', () => {
    const root = tempRootOf('no-payload');
    const taskId = asTaskId('T-v6-no-payload');
    const plan = planArtifact({
      task_id: taskId,
      task_revision: asRevision(1),
      template_kind: 'spreadsheet',
      artifact_version: 1,
      root_dir: root.split('\\').join('/'),
      expected_content_digest: 'a'.repeat(64),
    });
    const port = createFsArtifactMaterializationPort({
      read_revision: () => asRevision(1),
      now: () => asLogicalTime(0),
    });
    const result = port.materialize({
      artifact_id: plan.artifact_id,
      task_id: taskId,
      task_revision: plan.task_revision,
      template_kind: plan.template_kind,
      fact_snapshot: [factEntry()],
      plan,
      expected_content_digest: plan.expected_content_digest,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('前置失败：应当失败');
    expect(result.failure.kind).toBe('builder_failed');
    expect(result.failure.detail.length > 0).toBe(true);
    expect(existsSync(plan.final_path.split('\\').join('/')), '失败不得留下最终文件').toBe(false);
  });

  it('C3 源码顺序：fs-artifact-port 先看 payload、后看回退构建器（确定性而非约定）', () => {
    const text = readSource(join(REPO_ROOT, 'tests/acceptance/office/fs-artifact-port.ts'));
    const payloadCheck = text.indexOf('if (payload !== undefined) {');
    const fallbackCheck = text.indexOf('if (this.#buildBytes === undefined) {');
    expect(payloadCheck > 0, '应有 payload 分支').toBe(true);
    expect(fallbackCheck > 0, '应有回退分支').toBe(true);
    expect(payloadCheck < fallbackCheck).toBe(true);
    // 内核侧必须**确实**把字节挂在请求上（否则 C1 的前提在场景路径上不成立）。
    const stagingText = readSource(STAGING_SRC_PATH);
    expect(stagingText.includes('payload: built.bytes')).toBe(true);
  });

  it('C4 场景路径的字节与内核记录一致（盘上字节 == staged 记录里的 content_digest == 回读摘要）', () => {
    const scenario = sharedCompleteScenario();

    const records = scenario.artifacts();
    expect(records.length).toBe(3);
    for (const record of records) {
      const path = scenario.runFileOf(record);
      const bytes = readFileSync(path);
      expect(sha256Hex(bytes), `${record.template_kind}：盘上字节摘要应等于记录 content_digest`).toBe(
        record.content_digest,
      );
      expect(record.receipt?.readback_digest, `${record.template_kind}：回执摘要`).toBe(
        record.content_digest,
      );
      expect(record.byte_length, `${record.template_kind}：字节长度`).toBe(bytes.byteLength);
    }
  });
});

// ---------------------------------------------------------------------------
// §D 问题 4：J4 的反面对照到底走没走"同一路径"
// ---------------------------------------------------------------------------

describe('§D J4 反面对照的有效性（源码切片 + 补上真正的对照臂）', () => {
  it('D1 源码事实：office-negative 的负向臂里没有 materializeAll / finishRun，正向臂里有', () => {
    const text = readSource(NEGATIVE_TEST_PATH);
    const negativeStart = text.indexOf('负向臂：只在聊天里报出文件名');
    const positiveStart = text.indexOf('正向臂（对照）');
    const stagedStart = text.indexOf('staged（已暂存但未发布）');
    expect(negativeStart > 0 && positiveStart > negativeStart && stagedStart > positiveStart).toBe(true);

    const negativeArm = text.slice(negativeStart, positiveStart);
    const positiveArm = text.slice(positiveStart, stagedStart);
    const prologue = text.slice(text.indexOf('beforeAll('), negativeStart);

    // 负向臂：**没有**任何放行/收尾调用 ⇒ 它没有走交付路径，只是"什么都没做"。
    expect(negativeArm.includes('materializeAll('), '负向臂不得调用 materializeAll').toBe(false);
    expect(negativeArm.includes('finishRun('), '负向臂不得调用 finishRun').toBe(false);
    expect(negativeArm.includes('chatMessage'), '负向臂的输入是聊天文本').toBe(true);

    // 前置事实**确实**登记过（否则"没有产物"可能只是因为压根没有数据）。
    expect(
      prologue.includes('registerScenarioFacts(scenario'),
      'beforeAll 里应登记了事实（否则负向臂的空集是"没数据"而非"没交付"）',
    ).toBe(true);

    // 正向臂：确实走了交付路径（证明上面的切片器**能**看见这类调用 ⇒ D1 不是空断言）。
    expect(positiveArm.includes('materializeAll('), '正向臂应调用 materializeAll').toBe(true);
  });

  it('D2 补齐真正的对照臂：同一装配 + 同一事实 + 同一轮次，**只差 artifact 意图**', () => {
    const label = 'v6-d2-no-artifact-intent';
    const scenario = freshScenario(label);
    registerCompleteFacts(scenario, 8);

    const snapshot = scenario.snapshot();
    const run = snapshot.runs.find((candidate) => candidate.status === 'running');
    expect(run, '装配后应有活动轮次').toBeDefined();
    if (run === undefined) throw new Error('前置失败：没有活动轮次');
    const requestIds = snapshot.work_items.map((item) => item.request_id);
    expect(requestIds.length, '装配应有 3 个工作项').toBe(3);

    // **与 materializeAll 的唯一差别**：不给 `artifact` 意图 —— Agent 只"报出"一个 id。
    // 内核的工作承诺表要求 completed 至少带一个结果引用（ledger: missing_result_ref），
    // 所以"纯声明"在账本层根本落不了地；能落地的形态只能是**自称产出了某个 id**。
    // 这个 `asArtifactRef('art-claimed-only')` 正是 J4 负向臂里"聊天报出的文件名"的账本形态。
    const claimedRef = asArtifactRef('art-claimed-only');
    const outcome = scenario.scheduler.finishRun({
      run_id: run.run_id,
      publications: requestIds.map((requestId) => ({
        kind: 'completed' as const,
        request_id: requestId,
        result_refs: [claimedRef],
      })),
    });

    expect(outcome.accepted, '收尾本身应被接受').toBe(true);
    expect(outcome.applied_request_ids.length, '三条发布都落进了账本').toBe(3);
    expect(outcome.rejected_publications).toEqual([]);
    // Agent 自称产出了 `art-claimed-only`……但**存储里没有任何产物记录**（R47.3：占位引用 = 未交付）。
    expect(scenario.artifacts(), '没有产物意图 ⇒ 不得有产物记录').toEqual([]);
    expect(scenario.artifactOf(claimedRef), '自称的 id 查不到任何记录').toBeUndefined();
    expect(scenario.materializeCalls(), '没有产物意图 ⇒ 端口零调用').toBe(0);
    expect(existsSync(scenario.root()), '盘上不得出现产物根').toBe(false);
    // 工作项确实变成了 completed（证明这条路径真的走完了，不是被拒后空转）。
    const after = scenario.snapshot();
    expect(after.work_items.length).toBe(3);
    expect(after.work_items.map((item) => item.status)).toEqual([
      'completed',
      'completed',
      'completed',
    ]);
    expect(after.work_items.map((item) => item.result_refs.map(String))).toEqual([
      ['art-claimed-only'],
      ['art-claimed-only'],
      ['art-claimed-only'],
    ]);
    // 内核事件里没有 artifact_staged（内核从未暂存）。
    expect(
      after.kernel_events.filter((event) => event.kind === 'artifact_staged').length,
    ).toBe(0);
  });

  it('D2b 账本自身的门槛：completed 必须带结果引用（"纯声明"在账本层就落不了地）', () => {
    const scenario = freshScenario('v6-d2b-empty-result-refs');
    registerCompleteFacts(scenario, 8);
    const snapshot = scenario.snapshot();
    const run = snapshot.runs.find((candidate) => candidate.status === 'running');
    if (run === undefined) throw new Error('前置失败：没有活动轮次');
    const requestIds = snapshot.work_items.map((item) => item.request_id);

    const outcome = scenario.scheduler.finishRun({
      run_id: run.run_id,
      publications: requestIds.map((requestId) => ({
        kind: 'completed' as const,
        request_id: requestId,
        result_refs: [],
      })),
    });

    expect(outcome.accepted, '收尾被接受').toBe(true);
    expect(outcome.applied_request_ids, '空的 result_refs 不允许落到 completed').toEqual([]);
    expect(outcome.rejected_publications.map((row) => row.ledger_reason)).toEqual([
      'missing_result_ref',
      'missing_result_ref',
      'missing_result_ref',
    ]);
    expect(scenario.artifacts()).toEqual([]);
    expect(scenario.materializeCalls()).toBe(0);
  });

  it('D3 D2 的配对正例：同装配给上 artifact 意图 ⇒ 三条 published（对照臂非恒假）', () => {
    const scenario = sharedCompleteScenario();

    const published = scenario.artifacts().filter((record) => isDeliveredArtifact(record));
    expect(published.length).toBe(3);
    expect(scenario.materializeCalls()).toBe(3);
    expect(scenario.artifacts().every((record) => record.status === 'published')).toBe(true);
  });

  it('D4 判定记录：J4 负向臂是"什么都没做"的零对照，不是"同一路径缺意图"的对照', () => {
    // 机器化上面的判定：负向臂的断言集合里，唯一"能区分"的量是 materializeCalls()===0 与
    // artifactOf 查不到 —— 二者在"从未收尾"时**必然成立**。真正的判别形态由 §D2 提供。
    const text = readSource(NEGATIVE_TEST_PATH);
    const negativeArm = text.slice(
      text.indexOf('负向臂：只在聊天里报出文件名'),
      text.indexOf('正向臂（对照）'),
    );
    expect(negativeArm.includes('materializeCalls()'), '负向臂确实断言了端口零调用').toBe(true);
    expect(negativeArm.includes('artifacts()'), '负向臂确实断言了产物集合为空').toBe(true);
    expect(negativeArm.includes('chatMessage'), '负向臂的输入是聊天文本，不是内核路径').toBe(true);
    // ⇒ 结论：J4 负向臂 = 聊天文本 + 零路径；D2 才补上了"同路径缺意图"。
  });
});

// ---------------------------------------------------------------------------
// §E 问题 2 / 3：记录来自内核（内核事件与记录集互相印证）
// ---------------------------------------------------------------------------

describe('§E "记录由内核写入"的证据（内核事件 × 记录集 × 内核派生身份）', () => {
  it('E1 三条记录各对应一条内核的 artifact_staged 事件（夹具自写的记录不会有这个）', () => {
    const scenario = freshScenario('v6-e1-kernel-events');
    registerCompleteFacts(scenario, 8);
    expect(
      scenario.snapshot().kernel_events.filter((event) => event.kind === 'artifact_staged').length,
      '放行前不得有暂存事件',
    ).toBe(0);

    scenario.materializeAll();

    const staged = scenario
      .snapshot()
      .kernel_events.filter((event) => event.kind === 'artifact_staged');
    expect(staged.length, '内核为三条产物各写一条暂存事件（runs.ts:1097）').toBe(3);
    const recordIds = scenario.artifacts().map((record) => String(record.artifact_id)).sort();
    expect(
      staged.map((event) => String(event.data['artifact_id'])).sort(),
      '事件的 artifact_id 与记录集一一对应',
    ).toEqual(recordIds);
    // 事件如实写明"此刻还没有文件"（I-4 的取证面）。
    expect(
      staged.every((event) => String(event.data['note']).includes('staged')),
      '暂存事件应标注 staged 形态',
    ).toBe(true);
  }, 30_000);

  it('E1b 三条记录的落库还有内核的 artifact_published 事件背书（段 3 事务内写）', () => {
    const scenario = sharedCompleteScenario();

    const events = scenario
      .snapshot()
      .kernel_events.filter((event) => event.kind === 'artifact_published');
    const published = scenario.artifacts().filter((record) => record.status === 'published');
    expect(published.length, '前置：三条 published 记录').toBe(3);
    expect(events.length, '内核为三条发布各写一条 artifact_published（R59 / scheduler.ts:509 的钩子）').toBe(3);
    // 事件里的 artifact_id 与记录集一一对应 ⇒ "已交付"是内核持久化的事实，不是夹具的说法。
    expect(
      events.map((event) => String(event.data['artifact_id'])).sort(),
      '发布事件的 id 应与记录一致',
    ).toEqual(published.map((record) => String(record.artifact_id)).sort());
    // 缺事实路径（§B3）里不应出现任何发布成功事件。
    const empty = freshScenario('v6-e1b-no-facts');
    empty.materializeAll();
    expect(
      empty.snapshot().kernel_events.filter((event) => event.kind === 'artifact_published').length,
      '零事实 ⇒ 不得有发布成功事件',
    ).toBe(0);
  }, 30_000);

  it('E2 记录身份由内核派生（deriveArtifactId），不是夹具自造', () => {
    const scenario = sharedCompleteScenario();

    for (const record of scenario.artifacts()) {
      const derived = deriveArtifactId({
        task_id: record.task_id,
        task_revision: record.task_revision,
        template_kind: record.template_kind,
        artifact_version: record.artifact_version,
      });
      expect(String(record.artifact_id), `${record.template_kind} 的 id 应符合 R51.4 派生规则`).toBe(
        String(derived),
      );
      expect(String(record.artifact_id).startsWith('art-')).toBe(true);
      expect(record.task_revision).toBe(OFFICE_TASK_REVISION);
      expect(record.artifact_version).toBe(1); // 内核按"同类既有产物数 + 1"派生（R56 第 2 条）
    }
    expect(new Set(scenario.artifacts().map((record) => record.template_kind)).size).toBe(3);
    expect(TEMPLATE_KINDS.length).toBe(3);
  }, 30_000);

  it('E3 没有"夹具代办的 failed 记录"：正例下 failed 记录数为 0', () => {
    const scenario = sharedCompleteScenario();

    const records = scenario.artifacts();
    expect(records.length).toBe(3);
    expect(records.filter((record) => record.status === 'failed').length).toBe(0);
    expect(records.filter((record) => record.receipt === null).length).toBe(0);
    expect(records.every((record) => record.source_fact_refs.length > 0)).toBe(true);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// §F 问题 5：仍依赖夹具前置数据的地方 + 已知分歧（如实登记）
// ---------------------------------------------------------------------------

describe('§F 前置数据清单与合法性判据', () => {
  it('F1 夹具自己登记的前置数据只有"任务 / 实例 / 成员"三类 + 由用例登记的事实', () => {
    const text = readSource(OFFICE_SUPPORT_PATH);
    // 构造期的事务体只写这三条（office-support.ts:396-421）。
    const puts = scanTxPuts(text);
    expect(puts.filter((entry) => entry !== 'tx.putSharedFact').sort()).toEqual([
      'tx.putGroupMember',
      'tx.putInstance',
      'tx.putTask',
    ]);
    // 事实由**调用方**登记（夹具不预置业务事实）：`registerFact` 是公开面。
    expect(text.includes('registerFact(fact: SharedFactRecord): void')).toBe(true);
    expect(puts.filter((entry) => entry === 'tx.putSharedFact').length).toBe(1);
    // 轮次与工作项由**内核公开入口**建立，不由夹具写。
    expect(text.includes('this.#scheduler.onMessage(')).toBe(true);
    expect(text.includes('this.#scheduler.startRun(')).toBe(true);
    expect(text.includes('this.#scheduler.finishRun(')).toBe(true);
  }, 30_000);

  it('F2 场景装配**确实**经内核建立了 3 个工作项与 1 个轮次（前置不是"手搓状态"）', () => {
    const scenario = freshScenario('v6-f2-kernel-assembly');
    const snapshot = scenario.snapshot();
    expect(snapshot.work_items.length, 'onMessage × 3 建了 3 个工作项').toBe(3);
    expect(snapshot.work_items.every((item) => item.status === 'processing')).toBe(true);
    const running = snapshot.runs.filter((run) => run.status === 'running');
    expect(running.length, 'startRun 建了 1 个活动轮次').toBe(1);
    expect(running[0]?.task_revision, '轮次冻结了任务版本（J9 的构造基础）').toBe(OFFICE_TASK_REVISION);
    expect(snapshot.artifacts, '装配阶段零产物记录').toEqual([]);
    expect(snapshot.instances.length).toBe(1);
    expect(snapshot.group_members.length).toBe(1);
  }, 30_000);

  it('F3 夹具不预置业务事实：一条事实都不登记 ⇒ 三类全被 missing_fact 拒、零记录零写盘', () => {
    const scenario = freshScenario('v6-f3-no-preset-facts');
    // 刻意**不调** registerFact：若夹具预置了业务事实，这里就会产出产物。
    expect(scenario.snapshot().shared_facts, '装配后事实层应为空').toEqual([]);

    scenario.materializeAll();

    expect(scenario.artifacts(), '无事实 ⇒ 零产物记录').toEqual([]);
    expect(scenario.materializeCalls()).toBe(0);
    expect(existsSync(scenario.root())).toBe(false);
    const reasons = scenario
      .snapshot()
      .kernel_events.filter((event) => event.kind === 'publication_rejected')
      .map((event) => String(event.data['reason']));
    expect(reasons).toEqual(['missing_fact', 'missing_fact', 'missing_fact']);
  }, 30_000);

  it('F4 版本被超越 ⇒ 内核在归属核验处拒绝整轮（零记录、零端口调用）', () => {
    // 说明：这条路径**不是**发布投影的 `superseded`（R58）——`finishRunInTransaction` 在写任何
    // 记录之前就以 `stale_task_revision` 早退（runs.ts:763-783），因此经公开入口**无法**复现
    // 投影侧的 superseded；那条语义由 v3-publish-independent.test.ts 独立覆盖。
    // 本用例只钉住"经公开入口时版本被超越会发生什么"，作为夹具前置（任务版本）的合法用法证据。
    const scenario = freshScenario('v6-f4-version-gate');
    registerCompleteFacts(scenario, 8);
    scenario.store.transact((tx) => {
      const task = scenario.store.snapshot().tasks[0];
      if (task === undefined) throw new Error('前置失败：没有任务');
      tx.putTask({ ...task, revision: asRevision(2) });
    });
    scenario.materializeAll();
    expect(scenario.artifacts().length, '版本被超越 ⇒ 整轮被拒 ⇒ 零产物记录').toBe(0);
    expect(scenario.materializeCalls()).toBe(0);
    expect(
      scenario
        .snapshot()
        .kernel_events.filter(
          (event) => event.kind === 'publication_rejected' && event.rejection_reason !== null,
        ).length,
      '整轮被拒时也应留一条可指认的拒绝事件',
    ).toBeGreaterThan(0);
  }, 30_000);
});
