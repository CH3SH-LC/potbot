/**
 * **W-F2 / J1–J3：真实办公文件的产出、独立读回与"内容与任务版本一致"**。
 *
 * 归属：D02A-WF2。判据来自任务书与 `docs/design/design-02-真实办公文件与版本更新.md`
 * 的 P1（真实可编辑文件的产出与交付前验证），机器形状见合同 v1.4 R47–R53。
 *
 * ## 本文件断言的三条（每条都能真的失败）
 *
 * - **J1** 三类文件（DOCX / XLSX / PPTX）各至少 1 份真实产出；**版本化路径存在**且可读回；
 * - **J2** 每份经 `readback(path)`（Python `zipfile` + `xml.etree` + `unzip -t`）独立读回通过，
 *   且 `python` / `unzip` 的**实际解释器与版本**被记录（R53.2 / R53.8）；
 * - **J3** 每份的**关键内容与其记录的任务版本一致**：从读回的部件文本里取证人数/金额/日期，
 *   与 `ArtifactRecord.task_revision` 对应的那一版事实核对；并用"换一版事实 ⇒ 文本随之改变"
 *   证明内容**不是**写死的。
 *
 * ## 纪律
 *
 * - 断言只经夹具的**只读通道**（`artifacts()` / `artifactOf()` / `runFileOf()` / `readback()`）；
 * - **不代办内核步骤**：不拼 XML、不写 `staged` 记录、不绕过发布路径——一切经
 *   `buildOfficeScenario()` 的公开面；
 * - **不调用 `openWithOffice`**：目标软件打开属第三层，由专职包串行取证（R53.1 / R53.5）；
 * - 断言用**等号**；先断言夹具确实产生了数据（R22 纪律）。
 */

import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  TEMPLATE_KINDS,
  TEMPLATE_KIND_EXTENSIONS,
  asFactRef,
  asLogicalTime,
  createSharedFactRecord,
  isDeliveredArtifact,
  type ArtifactRecord,
  type LogicalTime,
  type SharedFactRecord,
  type SharedFactValue,
  type TemplateKind,
} from '../../../src/protocol/index.js';
import {
  OFFICE_INSTANCE_ID,
  OFFICE_SHARED_FACT_KEY,
  OFFICE_TASK_ID,
  OFFICE_TASK_REVISION,
  SCENARIO_EVIDENCE_DIR,
  buildOfficeScenario,
  type OfficeScenario,
} from './office-support.js';
import { allPartText } from './independent-readback.js';

// ---------------------------------------------------------------------------
// 产物根的**启动前清空**（不是判据，是让判据在脏环境下也成立）
// ---------------------------------------------------------------------------

/**
 * 本场景的产物根（与 `office-support` 的目录规则同源：`{证据位置}/products/{label}`）。
 *
 * 为什么要在建场景**之前**先清空：端口的幂等路径（R50.3）在"最终路径已存在且回读摘要一致"时
 * 会直接返回既有回执——上一次**中断**的运行留下的字节会让下一次运行读到旧结果，
 * 使"路径存在 / 内容一致"这类断言在**垃圾目录**上假绿（或让"必须重新物化"的断言假红）。
 * 清空的是本场景自己的产物根，不影响其它标签。
 */
function purgeProductsRoot(label: string): void {
  rmSync(join(EVIDENCE_DIR, 'products', label), {
    recursive: true,
    force: true,
  });
}

/**
 * 证据落盘位置。
 *
 * `evidenceOutputLocation()` 每次都**全量复算** `src/**` + `tests/**` 的 680 个 `.ts` 摘要
 * （实测单次 ≈ 0.4 s，`tests/acceptance/source-digest.ts` 无缓存）。一次运行之内工作树不变，
 * 该值是**只读快照**——故只在模块加载时取一次；原先每次清产物根都各付一次复算。
 * 判据未放宽：取到的仍是同一复算结果。
 *
 * 现在直接复用 `office-support` 那份**同一个模块级快照**推出的位置（`SCENARIO_EVIDENCE_DIR`，
 * 公式与本文件原先调用的完全相同），整棵树在一次运行里只复算一次；目录一字不差。
 */
const EVIDENCE_DIR = SCENARIO_EVIDENCE_DIR;

// ---------------------------------------------------------------------------
// 场景前置事实（**夹具不预置业务事实**；由本文件经 `registerFact()` 登记）
// ---------------------------------------------------------------------------

const FIXED_TIME = asLogicalTime(0);

/** 一条"用户在前台确认"的共享事实。 */
function confirmedFact(
  factId: string,
  factKey: string,
  value: SharedFactValue,
  at: LogicalTime = FIXED_TIME,
): SharedFactRecord {
  return createSharedFactRecord({
    fact_id: asFactRef(factId),
    task_id: OFFICE_TASK_ID,
    task_revision: OFFICE_TASK_REVISION,
    fact_key: factKey,
    value,
    source: { kind: 'user_confirmation', detail: '用户在前台确认（场景前置数据）' },
    confirmed_by: OFFICE_INSTANCE_ID,
    confirmed_at: at,
  });
}

function headcountValue(amount: number): SharedFactValue {
  return { kind: 'known', value: { type: 'number', amount, unit: '人', currency: null } };
}

function budgetValue(amount: number): SharedFactValue {
  return { kind: 'known', value: { type: 'number', amount, unit: 'CNY', currency: 'CNY' } };
}

const EVENT_DATE_VALUE: SharedFactValue = {
  kind: 'known',
  value: { type: 'date', iso_date: '2026-10-02', time_zone: 'Asia/Shanghai' },
};

/** 登记场景需要的三条事实（三类产物共同消费 `headcount`，这正是 R48.3 的机器判据）。 */
function registerScenarioFacts(scenario: OfficeScenario, headcount: number): void {
  scenario.registerFact(confirmedFact('fact-headcount', OFFICE_SHARED_FACT_KEY, headcountValue(headcount)));
  scenario.registerFact(confirmedFact('fact-budget', 'budget.total', budgetValue(600)));
  scenario.registerFact(confirmedFact('fact-date', 'event.date', EVENT_DATE_VALUE));
}

// ---------------------------------------------------------------------------
// 一次完整流程：登记事实 → 放行投影（暂存 + 物化 + 发布）
// ---------------------------------------------------------------------------

interface PublishedSet {
  readonly scenario: OfficeScenario;
  readonly records: Readonly<Record<TemplateKind, ArtifactRecord>>;
  readonly paths: Readonly<Record<TemplateKind, string>>;
}

function buildAndPublish(label: string, headcount: number): PublishedSet {
  purgeProductsRoot(label);
  const scenario = buildOfficeScenario(label);
  registerScenarioFacts(scenario, headcount);
  scenario.mark('facts-confirmed');
  scenario.materializeAll();
  scenario.mark('published');

  const all = scenario.artifacts();
  const records = {} as Record<TemplateKind, ArtifactRecord>;
  const paths = {} as Record<TemplateKind, string>;

  for (const kind of TEMPLATE_KINDS) {
    const matching = all.filter((record) => record.template_kind === kind);
    // 先断言夹具确实产生了数据（R22）：每个模板种类恰好一条记录。
    expect(matching.length, `${kind} 的记录条数`).toBe(1);
    const record = matching[0];
    expect(record, `${kind} 的记录应存在`).toBeDefined();
    if (record === undefined) throw new Error(`${kind} 无记录`);
    records[kind] = record;
    paths[kind] = scenario.runFileOf(record);
  }

  return { scenario, records, paths };
}

// ---------------------------------------------------------------------------
// J1 / J2 / J3：主场景（人数 8）
// ---------------------------------------------------------------------------

const MAIN_LABEL = 'j1-j3-real-files-h8';
let main: PublishedSet;

beforeAll(() => {
  main = buildAndPublish(MAIN_LABEL, 8);
}, 120_000);

afterAll(() => {
  main.scenario.cleanup();
});

describe('J1：三类文件各至少 1 份真实产出，版本化路径存在且可读回', () => {
  it('三类（document / spreadsheet / presentation）各恰好一份已发布记录', () => {
    const published = main.scenario
      .artifacts()
      .filter((record) => isDeliveredArtifact(record));
    expect(published.length).toBe(3);
    expect([...published.map((record) => record.template_kind)].sort()).toEqual([
      'document',
      'presentation',
      'spreadsheet',
    ]);
  });

  it('每份的终态是 published、有回执、且任务版本等于记录的 task_revision', () => {
    for (const kind of TEMPLATE_KINDS) {
      const record = main.records[kind];
      expect(record.status, `${kind}.status`).toBe('published');
      expect(isDeliveredArtifact(record), `${kind} 交付判据`).toBe(true);
      expect(record.task_revision, `${kind}.task_revision`).toBe(OFFICE_TASK_REVISION);
      expect(record.receipt === null, `${kind} 应有回执`).toBe(false);
      expect(record.receipt?.final_path, `${kind}.receipt.final_path`).toBe(
        main.scenario.runFileOf(record).split('\\').join('/'),
      );
      expect(record.receipt?.readback_digest.length, `${kind} 回读摘要长度`).toBe(64);
      expect(record.receipt?.readback_digest, `${kind} 内容摘要应等于回读摘要`).toBe(
        record.content_digest,
      );
    }
  });

  it('版本化路径存在且形状正确：{root}/{task}/r{revision}/{kind}/{id}.{ext}', () => {
    for (const kind of TEMPLATE_KINDS) {
      const hostPath = main.paths[kind];
      // `runFileOf()` 给的是宿主路径（Windows 上是反斜杠）；形状判据按逻辑路径（正斜杠）做。
      const logicalPath = hostPath.split('\\').join('/');
      expect(existsSync(hostPath), `${kind} 的产物路径应真实存在于盘上：${hostPath}`).toBe(true);
      expect(
        logicalPath.includes(
          `/${String(OFFICE_TASK_ID)}/r${String(OFFICE_TASK_REVISION)}/${kind}/`,
        ),
        `${kind} 的版本化分目录`,
      ).toBe(true);
      expect(logicalPath.endsWith(`.${TEMPLATE_KIND_EXTENSIONS[kind]}`), `${kind} 扩展名`).toBe(true);
      expect(
        logicalPath.endsWith(`/${String(main.records[kind].artifact_id)}.${TEMPLATE_KIND_EXTENSIONS[kind]}`),
        `${kind} 文件名 = artifact_id`,
      ).toBe(true);
    }
  });

  it('三类产物的路径互不相同（版本化 + 分目录，不互相覆盖）', () => {
    const distinct = new Set(TEMPLATE_KINDS.map((kind) => main.paths[kind].toLowerCase()));
    expect(distinct.size).toBe(3);
  });

  it('物化端口被调用了恰好 3 次（三类各一次，无重复物化）', () => {
    expect(main.scenario.materializeCalls()).toBe(3);
  });
});

describe('J2：逐份独立读回通过，且实际解释器 / 版本已记入证据', () => {
  it('三份产物经 Python zipfile + xml.etree + unzip -t 独立读回，结论全部为 ok', () => {
    for (const kind of TEMPLATE_KINDS) {
      const result = main.scenario.readback(main.paths[kind]);
      expect(result.ok, `${kind} 独立读回结论：bad=${String(result.bad_entry)} xml=${String(result.xml_problems.length)} unzip=${String(result.unzip_test.exit_code)}`).toBe(true);
      expect(result.bad_entry, `${kind} 坏条目`).toBe(null);
      expect(result.xml_problems.length, `${kind} XML 解析问题数`).toBe(0);
      expect(result.unzip_test.exit_code, `${kind} unzip -t 退出码`).toBe(0);
      expect(result.entries.length > 0, `${kind} 条目数应大于 0`).toBe(true);
    }
  });

  it('读回结果里记录的是**实际**解释器路径与版本（不是"用了 python"这种模糊说法）', () => {
    for (const kind of TEMPLATE_KINDS) {
      const result = main.scenario.readback(main.paths[kind]);

      // python：记录"怎么解析到的 + 实际解释器 + 版本"（R53.2）。
      expect(result.python.via.length > 0, `${kind}.python.via`).toBe(true);
      expect(result.python.executable.length > 0, `${kind}.python.executable`).toBe(true);
      expect(/^\d+\.\d+/.test(result.python.version), `${kind}.python.version=${result.python.version}`).toBe(true);
      // 本机合同钉死的是 `python`（3.13.13）；落回 `py -3` 也必须是如实记录的另一种。
      expect(['python', 'py'].includes(result.python.executable), `${kind}.python.executable=${result.python.executable}`).toBe(true);

      // unzip：首行是版本横幅，**不是**可执行路径（R53.8）——故两者分别记录。
      expect(result.unzip.executable.length > 0, `${kind}.unzip.executable`).toBe(true);
      expect(result.unzip.version.startsWith('UnZip'), `${kind}.unzip.version=${result.unzip.version}`).toBe(true);

      console.log(
        `[J2] ${kind}：python ${result.python.via} → ${result.python.executable} (${result.python.version})；` +
          `unzip ${result.unzip.via} → ${result.unzip.executable} [${result.unzip.version}]；` +
          `条目 ${String(result.entries.length)}，unzip 退出码 ${String(result.unzip_test.exit_code)}`,
      );
    }
  });

  it('全部部件无 UTF-8 BOM（带 BOM 的 OOXML 会被拒绝）', () => {
    for (const kind of TEMPLATE_KINDS) {
      const result = main.scenario.readback(main.paths[kind]);
      const flagged = Object.entries(result.part_has_bom).filter(([, value]) => value);
      expect(flagged.map(([name]) => name), `${kind} 带 BOM 的部件`).toEqual([]);
    }
  });
});

describe('J3：关键内容与记录的任务版本一致（人数 / 金额 / 日期）', () => {
  it('document：人数与日期逐字出现在读回的部件文本里', () => {
    const text = allPartText(main.scenario.readback(main.paths.document));
    expect(text.includes(`headcount: 8 人`), `docx 正文应含 "headcount: 8 人"`).toBe(true);
    expect(text.includes(`event.date: 2026-10-02 (Asia/Shanghai)`), `docx 正文应含日期事实`).toBe(true);
    // 反证：同一版本的事实只有一个来源，"10 人"不得出现。
    expect(text.includes('10 人'), 'docx 不得出现"10 人"').toBe(false);
  });

  it('spreadsheet：人数以数值单元格写入，标签与值都来自同一版事实', () => {
    const text = allPartText(main.scenario.readback(main.paths.spreadsheet));
    expect(text.includes('参会人数'), 'xlsx 应含分项标签').toBe(true);
    expect(text.includes('合计'), 'xlsx 应含合计行').toBe(true);
    expect(text.includes('8'), 'xlsx 应含人数 8').toBe(true);
    expect(text.includes('10'), 'xlsx 不得含 10').toBe(false);
  });

  it('presentation：人数 / 预算 / 日期三行都来自事实快照', () => {
    const text = allPartText(main.scenario.readback(main.paths.presentation));
    expect(text.includes('headcount：8 人'), 'pptx 应含 headcount：8 人').toBe(true);
    expect(text.includes('budget.total：600 CNY'), 'pptx 应含预算行').toBe(true);
    expect(text.includes('event.date：2026-10-02（Asia/Shanghai）'), 'pptx 应含日期行').toBe(true);
  });

  it('三类产物引用**同一条**人数事实（R48.3 单一来源的机器判据）', () => {
    const refs = TEMPLATE_KINDS.map((kind) => {
      const refsOfKind = main.records[kind].source_fact_refs;
      // R47.4：source_fact_refs 非空是构造期不变量；这里再确认三类都指到了 headcount。
      expect(refsOfKind.length > 0, `${kind} 应有事实来源`).toBe(true);
      return refsOfKind;
    });
    const headcountRefs = refs.map((list) => list.filter((ref) => ref === asFactRef('fact-headcount')));
    expect(headcountRefs.map((list) => list.length)).toEqual([1, 1, 1]);
    // 三份记录的 headcount 来源是同一个 id（单一来源）。
    expect(new Set(headcountRefs.map((list) => String(list[0]))).size).toBe(1);
  });

  it('改一版事实 ⇒ 产物内容随之改变（证明内容不是写死的）', () => {
    const other = buildAndPublish('j3-real-files-h10', 10);
    try {
      const docText = allPartText(other.scenario.readback(other.paths.document));
      const xlsxText = allPartText(other.scenario.readback(other.paths.spreadsheet));
      const pptxText = allPartText(other.scenario.readback(other.paths.presentation));

      // 新值进入三类产物……
      expect(docText.includes('headcount: 10 人'), 'docx 应含 10 人').toBe(true);
      expect(xlsxText.includes('10'), 'xlsx 应含 10').toBe(true);
      expect(pptxText.includes('headcount：10 人'), 'pptx 应含 10 人').toBe(true);
      // ……旧值不再出现（同一任务版本 + 同一事实键只有一个当前值）。
      expect(docText.includes('8 人'), 'docx 不得仍含 8 人').toBe(false);
      expect(xlsxText.includes('8'), 'xlsx 不得仍含 8').toBe(false);
      expect(pptxText.includes('8 人'), 'pptx 不得仍含 8 人').toBe(false);
    } finally {
      other.scenario.cleanup();
    }
  }, 30_000);
});
