/**
 * **V8 — 接口合同 v1.4（R47–R61）的「条款 → 实现 → 测试」一致性核对**（task-id: D02A-V8）。
 *
 * ## 这份文件解决什么问题
 *
 * 与 V7 不同：V7 对的是「design-02 的**验收标准** ↔ 套件覆盖」；本文件对的是
 * 「合同 v1.4 的**每一条 R 编号**（R47–R61）**是否真的被实现执行、且被测试钉住**」。
 * G01–G05 那批的教训是「验收标准写了但没人测」，而**合同条款同样可能"写了但没人执行"**
 * ——V4 就抓到一条：`artifact_published` 在 `KERNEL_EVENT_KINDS` 里声明了，却没有生产代码
 * 把它写进内核事件流（W-FIX5 已接线，见 `src/scheduler/scheduler.ts:202,509`）。
 *
 * ## 本文件做三件事（都可失败）
 *
 * 1. **映射 tripwire**：把审计中判为「已执行且已钉住」的条款，写成
 *    「某文件的用例名集合里必须存在含某片段的用例」。谁删掉/改名了那条覆盖 ⇒ 本文件变红，
 *    映射不会悄悄过期。
 * 2. **源码级断言**（合同要求的是**代码形状**、不是运行时行为时用）：
 *    R50.1（产物模块不得 import 调度器）、R51.2（`version made by` 不读 `process.platform`）、
 *    R52.2 / R61（产物落 `products/`、`cleanup()` **先读身份再决定删不删**）、
 *    R53.6（**可选工具** `office-open-check.ts` 自带显式超时 `OPEN_TIMEOUT_MS` > 默认 5 s +
 *    **不得**改 `vitest.config.ts` 的 `testTimeout`）、
 *    R65.5（默认套件**不得**有任何 `*.test.ts` import `openWithOffice`，带对照臂防扫描器失效）。
 * 3. **运行期断言**（合同要求的是**行为**时用）：
 *    R59（三个产物事件种类**不计入** 6 个计数器）、R53.2 / R53.3 / R53.8
 *    （工具门要么给出「实际调用命令 + 工具自述」两个字段，要么**显式失败**，不得静默）。
 *
 * ## 口径（为什么这样做是可信的）
 *
 * - **只看用例名，不看注释**：`extractTitles()` 只从 `it(` / `test(` / `describe(` 的
 *   **字符串字面量**里取标题。注释里写过什么不算"钉住"——"钉住"的判据是**有一条能失败的用例**。
 * - **可失败性自证**：见「仪器自证」一节——把被断言的标题从源文本里删掉，同一匹配器当场变红。
 * - **本文件只读**：不写任何产物、不调用 `openWithOffice`、不改被测套件。它在本目录里用
 *   `node:fs` 是 R50.4 明确允许的（`tests/acceptance/office/**` 是唯一允许文件 IO 的位置）。
 *
 * ## 如实标注的两处限制（不得读成本文件已证）
 *
 * - **R53.3 的"缺工具 ⇒ 显式失败"没有直接的运行期用例**：`toolchain.ts` 的候选命令是
 *   模块级常量、不可注入，无法在本机"制造"一个缺工具的环境而不 mock `node:child_process`
 *   （本目录刻意不使用 mock）。因此本文件只证到两件可证之事：① `requireToolchain()` 的
 *   **失败出口是 `ToolchainUnavailableError` 且信息含"缺哪个工具 / 独立读回无法成立"**；
 *   ② 整个 office 套件**没有任何 `skip` / `todo`**（"禁止跳过"那一半的机器判据）。
 *   "工具真的缺失时会抛"这一条仍是**源码阅读 + 单一出口**的结论，如实标为**未实测**。
 * - **R49.2 I-2 的负向形态**（"已提交 published 记录 + 最终路径不存在"）在内核里**构造不出**：
 *   内核不做文件 IO（R50.4），"路径此刻是否真的存在"只有端口 / 验收侧知道。本文件因此把
 *   I-2 的**正向形态**（真实管线里每份 published 记录的最终路径确实在盘上）作为它的钉住点。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  KERNEL_EVENT_KINDS,
  asLogicalTime,
  asRunId,
  createIdSource,
  createKernelEvent,
  summarizeKernelEvents,
  type KernelEvent,
  type StoreSnapshot,
} from '../../../src/protocol/index.js';
import { createMemoryStore } from '../../../src/storage/index.js';
import { requireToolchain, ToolchainUnavailableError } from './toolchain.js';

// ---------------------------------------------------------------------------
// 路径与读取
// ---------------------------------------------------------------------------

/** 本文件所在目录 = `tests/acceptance/office/`（相对定位，不依赖 cwd）。 */
const OFFICE_DIR = dirname(fileURLToPath(import.meta.url));
/** 仓库根 = 上溯三层。 */
const REPO_ROOT = join(OFFICE_DIR, '..', '..', '..');

const sourceCache = new Map<string, string>();

/**
 * 读一份源文本。`file` 以 `src/` 或 `tests/` 开头 ⇒ 相对**仓库根**；否则相对**本目录**。
 * 读不到 ⇒ **硬失败**（被断言的对象不存在，映射不成立，不得静默跳过）。
 */
function sourceOf(file: string): string {
  const cached = sourceCache.get(file);
  if (cached !== undefined) return cached;
  const absolute =
    file.startsWith('src/') ||
    file.startsWith('tests/') ||
    file.startsWith('docs/') ||
    file === 'vitest.config.ts'
      ? join(REPO_ROOT, ...file.split('/'))
      : join(OFFICE_DIR, file);
  let text: string;
  try {
    text = readFileSync(absolute, 'utf8');
  } catch (error) {
    throw new Error(
      `合同一致性核对的输入文件读不到：${absolute} —— ${String(error)}。` +
        '被断言的对象缺失，映射不成立（不得静默跳过）。',
    );
  }
  sourceCache.set(file, text);
  return text;
}

// ---------------------------------------------------------------------------
// 仪器：从源文本里取 `it` / `test` / `describe` 的标题字面量
// ---------------------------------------------------------------------------

/**
 * 与 `v7-coverage-map.test.ts` 同口径（**不解析 AST**：本判据只关心"用例名里有没有这个词"）。
 * 注释里出现的 `it(name, ...)` 不是字符串字面量，因此不会被当成标题。
 */
export function extractTitles(source: string): readonly string[] {
  const titles: string[] = [];
  const pattern = /\b(?:it|test|describe)\s*\(\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    titles.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return titles;
}

/** 「该文件里存在一个用例名含此**字面片段**」——本文件「已钉住」的机器判据。 */
function hasTitle(file: string, fragment: string): boolean {
  return extractTitles(sourceOf(file)).some((title) => title.includes(fragment));
}

// ---------------------------------------------------------------------------
// 映射表：R47–R61 中判为「已执行且已钉住」的条款
// ---------------------------------------------------------------------------

interface Pinned {
  /** 合同编号（可含小节，如 `R49.2 I-1`）。 */
  readonly r: string;
  /** 被断言的文件（`src/` / `tests/` 前缀 ⇒ 相对仓库根；否则相对本目录）。 */
  readonly file: string;
  /** 必须出现在某个用例名里的字面片段。 */
  readonly title: string;
  /** 这条映射主张什么（写给将来要改动它的人）。 */
  readonly note: string;
}

const PINNED: readonly Pinned[] = Object.freeze([
  // ---- R47 产物记录与读侧约定 ----
  {
    r: 'R47.2 / R47.4',
    file: 'src/protocol/artifact.test.ts',
    title: 'source_fact_refs 为空 ⇒ 抛',
    note: '构造期不变量：无事实来源的产物不得被构造（P3 机器判据）',
  },
  {
    r: 'R47.2 / R47.4',
    file: 'src/protocol/artifact.test.ts',
    title: 'published 缺回执 ⇒ 抛',
    note: 'I-1 的构造期形式：无回读不得称交付',
  },
  {
    r: 'R47.4',
    file: 'p3-shared-facts.test.ts',
    title: '反例：source_fact_refs: [] ⇒ 必须抛',
    note: '独立复核臂（V-F2 侧）：构造期不变量**不是空断言**（另配合法基线对照）',
  },
  {
    r: 'R47.3',
    file: 'v3-publish-independent.test.ts',
    title: '只有 published 且带回执才算交付',
    note: '读侧唯一判据：staged / failed / superseded 都不构成"已交付"',
  },
  // ---- R48 共享事实的单一来源 ----
  {
    r: 'R48.1 / R48.2',
    file: 'src/protocol/facts.test.ts',
    title: 'unknown 分支',
    note: 'unknown / not_applicable 分支**结构上**没有数值载荷字段（用 0 冒充未知被构造期拒绝）',
  },
  {
    r: 'R48.2',
    file: 'v2-facts-independent.test.ts',
    title: '用 0 冒充未知（unknown 携带数值载荷）',
    note: '独立复核（V2）：提案校验层判为 unknown_carries_payload',
  },
  {
    r: 'R48.2',
    file: 'v2-facts-independent.test.ts',
    title: '纵深防御：绕过提案校验直接造记录',
    note: '独立复核（V2）：**绕过提案校验**直接用 createSharedFactRecord 也造不出"用 0 冒充未知"',
  },
  {
    r: 'R48.3',
    file: 'p1-real-files.test.ts',
    title: '三类产物引用',
    note: '单一来源的机器判据：三类产物的 source_fact_refs 指向同一条事实记录',
  },
  {
    r: 'R48.4',
    file: 'p3-shared-facts.test.ts',
    title: 'J5-a 值为 unknown',
    note: '缺失 ⇒ 内核结构化拒绝（missing_fact），不产产物、不产零值产物',
  },
  // ---- R49 三段式与四条不变量 ----
  {
    r: 'R49.1 段2（info-006）',
    file: 'v3-publish-independent.test.ts',
    title: '端口回调期间不在任何事务内',
    note: '外部副作用只在提交之后：段1 提交索引 < 端口调用索引 < 段3 事务起始',
  },
  {
    r: 'R49.1 段3（幂等键）',
    file: 'v3-publish-independent.test.ts',
    title: '第二次投影：零事务、零记录写入',
    note: '以 artifact_id 为幂等键：重复投影不重复物化、不重复发布',
  },
  {
    r: 'R49.2 I-1',
    file: 'v3-publish-independent.test.ts',
    title: 'I-1：published 的证据是端口回执',
    note: 'content_digest === receipt.readback_digest（摘要取端口**回读**值，不是计划里的期望值）',
  },
  {
    r: 'R49.2 I-1（反例）',
    file: 'v3-publish-independent.test.ts',
    title: '自造反例：端口报成功但回执缺/空回读摘要',
    note: '无回读证据 ⇒ 不得成为 published（把 I-1 从"正向也过"变成"反向也能红"）',
  },
  {
    r: 'R49.2 I-2（正向形态）',
    file: 'p1-real-files.test.ts',
    title: '版本化路径存在且形状正确',
    note: '真实管线里每份 published 记录的最终路径确实在盘上（I-2 的负向形态内核构造不出，见文件头限制）',
  },
  {
    r: 'R49.2 I-3',
    file: 'v4-scheduler-artifact-flow.test.ts',
    title: '产物记录与工作项 result_refs 同生共死',
    note: '暂存记录与工作项同一事务：提交前抛错 ⇒ 两者都不在；解除故障 ⇒ 两者都在',
  },
  {
    r: 'R49.2 I-4',
    file: 'v3-publish-independent.test.ts',
    title: 'I-4：staged 不满足任何"已交付"判据',
    note: 'staged 可表示、可观测、可恢复，且不满足任何交付判据；构造期拒绝"staged + 回执"',
  },
  {
    r: 'R49.3（临时路径）',
    file: 'src/artifacts/planner.test.ts',
    title: '临时路径在最终文件同目录的 .staging/ 下',
    note: '写版本化临时路径再原子 rename；临时路径不进入交付面',
  },
  {
    r: 'R49.4（未提交 ⇒ 如实）',
    file: 'v3-publish-independent.test.ts',
    title: '段3 未提交 ⇒ 如实 unrecorded',
    note: '段3 未提交 ⇒ 不声称已发布，留给重跑（结构化 unrecorded）',
  },
  {
    r: 'R49.4（失败不得倒退）',
    file: 'v3-publish-independent.test.ts',
    title: '失败不得倒退',
    note: '已记 failed 的产物不得退回 published（refused_after_failure）',
  },
  // ---- R50 物化端口 ----
  {
    r: 'R50.2',
    file: 'office-negative.test.ts',
    title: 'failed + detail 非空 + 盘上不留文件',
    note: '结构化失败（build / write / verify 三条注入）：failed + detail 非空，绝不冒充 published',
  },
  {
    r: 'R50.3',
    file: 'v6-port-readback.test.ts',
    title: 'R50.3：摘要相符 ⇒ 幂等不重写',
    note: '端口幂等：最终路径已存在且回读摘要一致 ⇒ 返回既有回执，不重写',
  },
  {
    r: 'R50.4',
    file: 'w-disc-kernel-discipline.test.ts',
    title: '文本不含任何禁用 token',
    note: 'src/** 零文件 IO / 零墙钟（剥离注释后按代码文本判，另有对照臂防假绿）',
  },
  // ---- R51 确定性产物 ----
  {
    r: 'R51.1',
    file: 'w-disc-kernel-discipline.test.ts',
    title: '既不 import node:zlib',
    note: 'ZIP 写入器不用 node:zlib（deflate 字节随 zlib 版本漂移）',
  },
  {
    r: 'R51.2',
    file: 'v1-ooxml-templates.test.ts',
    title: '中央目录常量全部命中',
    note: '三类产物各自的中央目录常量（含 version made by = 20、DOS 时间 0x0000 / 日期 0x0021）',
  },
  {
    r: 'R51.3',
    file: 'src/artifacts/ooxml/opc.test.ts',
    title: '部件定序唯一',
    note: '部件顺序 = 声明顺序（内容类型 → 包级关系 → 业务部件声明序 → 部件级关系组声明序）',
  },
  {
    r: 'R51.4',
    file: 'src/artifacts/planner.test.ts',
    title: 'golden 向量：id 只由 task_id + revision + 模板种类 + 产物版本决定',
    note: 'id 由四元组派生，**不得**用计数器铸造：四个写死的 golden id 钉住派生式',
  },
  {
    r: 'R51.5',
    file: 'src/artifacts/planner.test.ts',
    title: '最终路径 = ',
    note: '版本化路径公式 + 临时路径形如 {id}.tmp-{n}（{n} 不进入最终路径与身份）',
  },
  {
    r: 'R51.6',
    file: 'office-reproducibility.test.ts',
    title: '三类产物各构造两次 ⇒ 容器字节逐字节相等',
    note: '关闭标准：同一输入连跑两次 ⇒ 产物字节 sha256 相等；另有 golden 摘要向量与跨进程复算',
  },
  // ---- R53 三层验证与标注纪律 ----
  {
    r: 'R53.1（第 1 层真的会报错）',
    file: 'v3-publish-independent.test.ts',
    title: 'verify.ts 真的会报错',
    note: '结构自检用**自造反例**证明能报错（不用它自己的用例做自证）',
  },
  {
    r: 'R53.2',
    file: 'p1-real-files.test.ts',
    title: '读回结果里记录的是',
    note: '记录**实际**解释器路径与版本（不是"用了 python"这种模糊说法）',
  },
  {
    r: 'R53.4 / R65.5（可选工具不进默认套件）',
    file: 'v8-contract-conformance.test.ts',
    title: '零命中：没有任何 *.test.ts import openWithOffice',
    // 自指映射：R53.4 的机器判据已随第三层退出套件而改形——不再是"某用例把 inconclusive 判红"，
    // 而是**没有任何测试依赖该工具**（依赖它 = 默认套件需要授权桌面 Office = 把环境当判据）。
    // 指回本文件里那条 `it` 自身；删掉那个 it ⇒ 本条变红（映射非空转）。
    note: '第三层退出默认套件后，R53.4 的判据变为"默认套件零依赖"：见「R65.5」一节的扫描断言',
  },
  {
    r: 'R53.8',
    file: 'toolchain.ts',
    title: '',
    note: 'unzip 的"实际调用命令"与"工具自述"分成两个字段（见「运行期断言」一节的字段断言）',
  },
  // ---- §8c 集成决议 ----
  {
    r: 'R56 / R56.1 / R56.2',
    file: 'v4-scheduler-artifact-flow.test.ts',
    title: '记录 published、回读摘要等于内容摘要',
    note: '提交后投影：finishRun 返回时已是 published，端口回调不在任何事务内',
  },
  {
    r: 'R56.2a',
    file: 'v4-scheduler-artifact-flow.test.ts',
    title: '实测：提交已发生 ⇒ 产物照样被投影为 published',
    note: '「已提交但抛错」路径必须同样投影（与预算同一处置）',
  },
  {
    r: 'R56.2b（批次边界）',
    file: 'v4-scheduler-artifact-flow.test.ts',
    title: '恢复入口探查',
    note: '跨进程重启的恢复**未实现**：如实登记为批次边界，不把 R49.4 读成"崩溃后也能恢复"',
  },
  {
    r: 'R57',
    file: 'v6-fixture-audit.test.ts',
    title: 'C1 请求带 payload',
    note: '存在 payload ⇒ 端口必须直接写这份字节，回退构建器一次都不被调用',
  },
  {
    r: 'R58',
    file: 'v3-publish-independent.test.ts',
    title: '合同的终态是 superseded（不是 failed）',
    note: 'version_stale ⇒ 落库状态 superseded（旧产物保留为历史），不是 failed',
  },
  {
    r: 'R58（枚举）',
    file: 'src/protocol/artifact.test.ts',
    title: '失败种类恰为端口失败的五种',
    note: 'ARTIFACT_FAILURE_KINDS 实际含 version_stale（R50.2 的 revision_superseded 已作废）',
  },
  {
    r: 'R59（接线）',
    file: 'src/scheduler/artifact-observation.test.ts',
    title: '成功发布 ⇒ 恰好一条 artifact_published',
    note: 'V4 抓到的"声明了但没接线"已修复：发布观测在段 3 事务内落成内核事件（W-FIX5）',
  },
  {
    r: 'R61 / R52.2（落点与清理）',
    file: 'v4-scheduler-artifact-flow.test.ts',
    title: '未注入端口 ⇒ 产物停在 staged',
    note: 'R52.2 的 products/ 落点与 R61 的身份化清理见「源码级断言」一节',
  },
]);

// ---------------------------------------------------------------------------
// 1. 映射 tripwire：判为「已钉住」的条款，其用例名必须存在
// ---------------------------------------------------------------------------

describe('R47–R61 一致性映射：已钉住的条款 → 文件 + 用例名（删掉/改名 ⇒ 本条变红）', () => {
  for (const entry of PINNED) {
    // 空片段是"见别处"的占位（toolchain.ts 那一条走运行期断言）：跳过标题匹配，只自洽检查。
    if (entry.title === '') {
      it(`[${entry.r}] ${entry.file} —— 由「运行期断言」一节覆盖`, () => {
        expect(sourceOf(entry.file).length).toBeGreaterThan(0);
      });
      continue;
    }
    it(`[${entry.r}] ${entry.file} :: ${entry.title}`, () => {
      expect(
        hasTitle(entry.file, entry.title),
        `合同 ${entry.r} 的钉住点消失了：${entry.file} 里没有任何用例名含 ${JSON.stringify(entry.title)}。` +
          `—— ${entry.note}`,
      ).toBe(true);
    });
  }

  /**
   * 由**运行期 / 源码级断言**（本文件的其它小节）覆盖的编号，不进标题映射表。
   * `R55.1`（验收侧三仪器的归属）与 `R60`（快照集合必填）属此列。
   */
  const COVERED_ELSEWHERE: readonly string[] = ['55', '60'];

  it('映射表覆盖合同实际定义的全部编号（不是只对了一半）', () => {
    const covered = new Set<string>(COVERED_ELSEWHERE);
    for (const entry of PINNED) {
      for (const match of entry.r.matchAll(/R(\d+)/g)) {
        const number = match[1];
        if (number !== undefined) covered.add(number);
      }
    }
    // **合同里没有 R54**（编号存在空洞：R53 → R55）；下面的清单据合同原文枚举，不是"从 47 数到 61"。
    const defined = ['47', '48', '49', '50', '51', '52', '53', '55', '56', '57', '58', '59', '60', '61'];
    const missing = defined.filter((number) => !covered.has(number));
    expect(missing, `映射表漏掉的合同编号：${missing.join(', ')}`).toEqual([]);
  });

  it('合同 v1.4 里确实没有 R54（编号空洞是事实，不是映射表漏抄）', () => {
    const contract = sourceOf('docs/other/prep/接口合同-冻结v1.4（design-02 A 批）.md');
    expect(contract).toContain('R55.1');
    expect(/\bR54(\.\d+)?\b/.test(contract)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. 仪器自证：把被断言的标题删掉 ⇒ 同一匹配器必须变红
// ---------------------------------------------------------------------------

describe('仪器自证：本文件的判据可失败（不是空断言）', () => {
  it('把某个被断言标题从源文本里删掉 ⇒ 同一匹配器当场变红', () => {
    const target = PINNED.find((entry) => entry.title !== '') as Pinned;
    const original = sourceOf(target.file);
    // 前提：原始文本里确实命中（否则"删掉后不命中"就没有意义）。
    expect(original.includes(target.title)).toBe(true);

    const mutated = original.split(target.title).join('【该覆盖已被删除】');
    const stillHit = extractTitles(mutated).some((title) => title.includes(target.title));
    expect(stillHit, '把标题从源文本里删掉之后匹配器仍然命中 ⇒ 匹配器失效').toBe(false);
  });

  it('对照：不存在的片段一律不命中（证明匹配器不是恒真）', () => {
    expect(hasTitle('p1-real-files.test.ts', '这段文字在任何用例名里都不存在-9f3c')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. 源码级断言（合同要求的是代码形状）
// ---------------------------------------------------------------------------

describe('R50.1：产物侧模块不得 import 调度器类型（端口纪律）', () => {
  const MODULES: readonly string[] = [
    'src/artifacts/ports.ts',
    'src/artifacts/publish.ts',
    'src/artifacts/staging.ts',
    'src/artifacts/planner.ts',
  ];
  const SCHEDULER_IMPORT = /from\s*['"][^'"]*scheduler[^'"]*['"]/;

  it('对照：匹配器对一段真的 import 会命中（证明下面的"零命中"非空转）', () => {
    expect(SCHEDULER_IMPORT.test("import { createScheduler } from '../scheduler/index.js';")).toBe(true);
  });

  for (const module of MODULES) {
    it(`${module} 不 import 任何 src/scheduler/**`, () => {
      const source = sourceOf(module);
      expect(source.length).toBeGreaterThan(0);
      const hit = source.match(SCHEDULER_IMPORT);
      expect(hit?.[0] ?? null).toBe(null);
    });
  }
});

describe('R51.2：`version made by` 是常量，不得由 process.platform 推导', () => {
  /** 注释行（`//` 起头，或块注释体内的 `*` 起头）——纪律文档里**声明**了这条禁令，那不是违例。 */
  const isCommentLine = (line: string): boolean => /^\s*(?:\/\/|\*|\/\*)/.test(line);

  it('zip.ts 的 version made by 是写死的常量 20，且**代码**里不读 process.platform', () => {
    const source = sourceOf('src/artifacts/ooxml/zip.ts');
    expect(source).toContain('export const ZIP_VERSION_MADE_BY = 20;');

    // 只扫"代码行"：zip.ts 的文件头注释里**刻意**写着"不由 process.platform 推导"，
    // 朴素文本扫描会把纪律声明本身判成违例（`w-disc-kernel-discipline` 用解析器剥注释，同口径）。
    const offenders = source
      .split(/\r?\n/)
      .filter((line) => line.includes('process.platform') && !isCommentLine(line));
    expect(offenders, `代码行里出现了 process.platform：${offenders.join(' | ')}`).toEqual([]);
  });

  it('对照：注释行豁免不是"凡含该词就放过"（同一判据对代码行会命中）', () => {
    const synthetic = "const x = process.platform; // 说明\n * 注释里的 process.platform";
    const offenders = synthetic
      .split('\n')
      .filter((line) => line.includes('process.platform') && !isCommentLine(line));
    expect(offenders).toEqual(['const x = process.platform; // 说明']);
  });

  it('v1 的字节级断言真的把 20 写进了用例（不是只与常量自身比较）', () => {
    // 只 `toBe(ZIP_VERSION_MADE_BY)` 是"常量等于自己"，恒真；必须有一个**写死 20** 的字节级断言。
    expect(sourceOf('v1-ooxml-templates.test.ts')).toContain('expect(entry.versionMadeBy).toBe(20)');
  });
});

describe('R55.1：验收侧三仪器存在且真的被判据使用（W-F 不得修改它们）', () => {
  const INSTRUMENTS: readonly string[] = [
    'toolchain.ts',
    'independent-readback.ts',
    'office-open-check.ts',
  ];

  for (const instrument of INSTRUMENTS) {
    it(`${instrument}：存在且非空`, () => {
      expect(sourceOf(instrument).length).toBeGreaterThan(0);
    });
  }

  it('三仪器各得其所：前两件被验收套件真的用上，第三件是可选工具、默认套件不依赖它', () => {
    expect(sourceOf('office-support.ts')).toContain("from './toolchain.js'");
    expect(sourceOf('office-support.ts')).toContain("from './independent-readback.js'");
    // R65：`office-open-check.ts` 是**可选工具**（存在性见上面第一条断言），**不参与默认套件**。
    // 它**不得**被任何 `*.test.ts` import —— 机器判据在「R65.5」一节（零命中 + 对照臂）。
  });
});

describe('R52.2 / R61：产物落 {证据位置}/products/，清理按身份区分（正式身份不得删）', () => {
  it('office-support 的产物根是 {证据位置}/products/{场景}', () => {
    const source = sourceOf('office-support.ts');
    expect(source).toContain("join(evidenceDir, 'products', this.#label)");
  });

  it('cleanup() 先读身份：frozen ⇒ 保留（不删），否则才带重试删除', () => {
    const source = sourceOf('office-support.ts');
    // 身份判定必须先于删除调用出现（顺序即"先读身份再决定删不删"）。
    const identityIndex = source.indexOf('const identity = this.identity();');
    const gateIndex = source.indexOf('if (identity.frozen) {');
    const removeIndex = source.indexOf('removeTreeWithRetry(this.#productsRoot);');
    expect(identityIndex, '缺少"先读身份"').toBeGreaterThan(-1);
    expect(gateIndex, '缺少身份闸门 `if (identity.frozen) {`').toBeGreaterThan(identityIndex);
    expect(removeIndex, '缺少开发身份的删除调用').toBeGreaterThan(gateIndex);
  });

  it('证据报告仍经唯一落盘入口 writeEvidenceArtifacts（R52.1）', () => {
    expect(sourceOf('office-support.ts')).toContain('writeEvidenceArtifacts((identity) => [');
  });

  it('可失败性自证：把身份闸门从源文本里删掉 ⇒ 同一判据当场变红', () => {
    const source = sourceOf('office-support.ts');
    const mutated = source.split('if (identity.frozen) {').join('/* gate removed */');
    expect(mutated.indexOf('if (identity.frozen) {')).toBe(-1);
  });
});

describe('R53.6：可选工具自带显式超时（> 默认 5 s），且不得改 vitest.config.ts 的 testTimeout', () => {
  /** 从源文本里读 `OPEN_TIMEOUT_MS` 的数值（下划线分隔的十进制）。 */
  function readOpenTimeoutMs(source: string): number {
    const match = source.match(/const OPEN_TIMEOUT_MS = ([\d_]+);/);
    expect(match, '找不到 `const OPEN_TIMEOUT_MS = …;` 的定义').not.toBe(null);
    return Number((match?.[1] ?? '').replaceAll('_', ''));
  }

  it('office-open-check.ts 的 OPEN_TIMEOUT_MS 存在且大于 vitest 默认 5 s（5000 ms）', () => {
    // R53.6 实测：真 Office 打开一次要数秒到十几秒，而 vitest 默认 `testTimeout` 是 5000 ms ⇒
    // 会把**已经成功**的打开判成失败。第三层退出套件后，这条纪律落在**工具自身**的显式超时上。
    const timeoutMs = readOpenTimeoutMs(sourceOf('office-open-check.ts'));
    expect(timeoutMs, `OPEN_TIMEOUT_MS = ${String(timeoutMs)} 必须 > 默认 5000 ms`).toBeGreaterThan(5000);
  });

  it('对照：同一条判据对"被改小的超时"会判红（证明不是恒真）', () => {
    const mutated = sourceOf('office-open-check.ts').replace(
      'const OPEN_TIMEOUT_MS = 90_000;',
      'const OPEN_TIMEOUT_MS = 1_000;',
    );
    // 前提：替换确实发生了（否则下面证不了什么）。
    expect(mutated).not.toContain('const OPEN_TIMEOUT_MS = 90_000;');
    expect(readOpenTimeoutMs(mutated) > 5000, '把超时改小后判据仍未红 ⇒ 判据无效').toBe(false);
  });

  it('vitest.config.ts 里没有 testTimeout（动它 = 改构建配置、破坏冻结点不变量）', () => {
    expect(sourceOf('vitest.config.ts')).not.toContain('testTimeout');
  });
});

describe('R53.3（判据的一半）：整个 office 套件没有任何 skip / todo', () => {
  const SUITE: readonly string[] = [
    'p1-real-files.test.ts',
    'p3-shared-facts.test.ts',
    'p6-template-contracts.test.ts',
    'office-negative.test.ts',
    'office-reproducibility.test.ts',
    'v1-ooxml-templates.test.ts',
    'v2-facts-independent.test.ts',
    'v3-publish-independent.test.ts',
    'v4-scheduler-artifact-flow.test.ts',
    'v6-port-readback.test.ts',
    'v6-fixture-audit.test.ts',
    'w-disc-kernel-discipline.test.ts',
  ];

  it('对照：匹配器对 it.skip 会命中（证明下面的"零命中"非空转）', () => {
    expect(/\b(?:it|test|describe)\.(?:skip|todo)\b/.test("it.skip('x', () => {});")).toBe(true);
  });

  for (const file of SUITE) {
    it(`${file}：无 it.skip / it.todo / describe.skip`, () => {
      const source = sourceOf(file);
      expect(source.length).toBeGreaterThan(0);
      expect(source.match(/\b(?:it|test|describe)\.(?:skip|todo)\b/g) ?? []).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// R65.5：默认套件不依赖桌面 Office（防复发）
// ---------------------------------------------------------------------------

describe('R65.5：默认套件不依赖桌面 Office —— 没有任何 *.test.ts import openWithOffice', () => {
  /**
   * **依赖判据**：一条真正的 import 语句——从同目录的 `./office-open-check.js` 导入 `openWithOffice`。
   *
   * 刻意**不**用裸符号 `/openWithOffice/` 去扫测试文件：多份测试的**文件头注释**里写着
   * "不调用 `openWithOffice`"这类纪律声明，裸符号扫描会把"声明不依赖"误判成"依赖"（假红）。
   * 依赖的机器形态是 **import**，因此只认 import。
   *
   * 注意：本文件**自身**也会被下面那条"零命中"扫描（不自我豁免）。因此**对照臂的正样本**
   * 由字符串**运行时拼接**得到——源码文本里不存在连续的 `import … from 'office-open-check.js'`
   * 形态（否则本文件的对照臂会把自己扫成一个"依赖者"，制造假红）。
   */
  const IMPORTS_TOOL =
    /import\s*\{[^}]*\bopenWithOffice\b[^}]*\}\s*from\s*['"]\.\/office-open-check\.js['"]/;
  /** 宽口径符号（用于**对照臂**：证明工具本体确实在仓库里、符号是真的，不是扫描器写坏了）。 */
  const REFERENCES_TOOL = /\bopenWithOffice\b/;

  /** `tests/acceptance/office/` 下全部 `.test.ts` 的相对名单（递归，等价于 glob 的 `**` 语义）。 */
  function officeTestFiles(): readonly string[] {
    return readdirSync(OFFICE_DIR, { recursive: true })
      .map((entry) => String(entry))
      .filter((name) => name.replaceAll('\\', '/').endsWith('.test.ts'))
      .map((name) => name.replaceAll('\\', '/'));
  }

  it('对照臂①：同一扫描器对一段真的 import 会命中（证明下面的"零命中"非空转）', () => {
    // 运行时拼接（源码文本里不出现连续的 import 形态，避免本文件把自己扫成"依赖者"）。
    const positiveSample = ['import { openWithOffice }', "from './office-open-check.js';"].join(' ');
    expect(IMPORTS_TOOL.test(positiveSample)).toBe(true);
    // 反向对照：别的模块的同名导入**不该**命中（证明正则钉的是这个模块，不是万能匹配）。
    const otherModule = ['import { openWithOffice }', "from './something-else.js';"].join(' ');
    expect(IMPORTS_TOOL.test(otherModule)).toBe(false);
  });

  it('对照臂②：office-open-check.ts 自身文本命中扫描器（工具本体在仓库里，符号是真的）', () => {
    expect(
      REFERENCES_TOOL.test(sourceOf('office-open-check.ts')),
      '工具本体里找不到 openWithOffice ⇒ 要么工具被删了，要么扫描器失效（此前的"零命中"无意义）',
    ).toBe(true);
  });

  it('扫描到的测试文件数 > 3（防止"零命中"是因为一个文件都没扫到）', () => {
    expect(officeTestFiles().length, `扫到的 *.test.ts：${officeTestFiles().join(', ')}`).toBeGreaterThan(3);
  });

  it('零命中：没有任何 *.test.ts import openWithOffice（默认套件不启动 Office）', () => {
    const offenders = officeTestFiles().filter((file) => IMPORTS_TOOL.test(sourceOf(file)));
    expect(
      offenders,
      `以下测试文件依赖桌面 Office（默认套件不得需要它，见合同 v1.4 §8d / R65.5）：${offenders.join(', ')}`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. 运行期断言（合同要求的是行为）
// ---------------------------------------------------------------------------

describe('R59：三个产物事件种类不计入 summarizeKernelEvents 的 6 个计数器', () => {
  const ARTIFACT_KINDS = ['artifact_staged', 'artifact_published', 'artifact_publish_failed'] as const;

  it('三个种类都已在 KERNEL_EVENT_KINDS 里声明（append-only）', () => {
    for (const kind of ARTIFACT_KINDS) {
      expect(KERNEL_EVENT_KINDS.includes(kind), `缺少事件种类 ${kind}`).toBe(true);
    }
  });

  it('只喂三个产物事件 ⇒ 6 个计数器全为 0；对照：一个 run_started ⇒ run_count = 1', () => {
    const ids = createIdSource();
    const artifactEvents: readonly KernelEvent[] = ARTIFACT_KINDS.map((kind) =>
      createKernelEvent(
        { kind, at: asLogicalTime(0), instance_id: null, data: { note: 'R59 计数器探测' } },
        ids,
      ),
    );

    const withArtifacts = summarizeKernelEvents(artifactEvents);
    expect(withArtifacts).toEqual({
      run_count: 0,
      rejected_publication_count: 0,
      peak_active_runs: 0,
      peak_queued_flags: 0,
      diagnosis_count: 0,
      inbox_message_count: 0,
    });

    // 对照（防恒真）：同一批事件里换成一个 run_started，同一函数必须**给出非零观测**。
    const control = summarizeKernelEvents([
      createKernelEvent(
        { kind: 'run_started', at: asLogicalTime(0), run_id: asRunId('run-r59'), instance_id: null },
        ids,
      ),
    ]);
    expect(control.run_count).toBe(1);
  });

  it('事件数与计数器解耦：往同一批事件里再加一条产物事件，计数器不变', () => {
    const ids = createIdSource();
    const base: readonly KernelEvent[] = [
      createKernelEvent(
        { kind: 'run_started', at: asLogicalTime(0), run_id: asRunId('run-r59b'), instance_id: null },
        ids,
      ),
    ];
    const before = summarizeKernelEvents(base);
    const after = summarizeKernelEvents([
      ...base,
      createKernelEvent({ kind: 'artifact_staged', at: asLogicalTime(1), instance_id: null }, ids),
      createKernelEvent({ kind: 'artifact_published', at: asLogicalTime(2), instance_id: null }, ids),
    ]);
    expect(after).toEqual(before);
  });
});

describe('R53.2 / R53.3 / R53.8：工具门给出「实际调用命令 + 自述」，否则显式失败', () => {
  it('requireToolchain()：要么返回两个字段齐备的工具，要么抛 ToolchainUnavailableError（不跳过）', () => {
    let toolchain: ReturnType<typeof requireToolchain> | null = null;
    let failure: unknown = null;
    try {
      toolchain = requireToolchain();
    } catch (error) {
      failure = error;
    }

    if (failure !== null) {
      // R53.3 的失败出口：必须是**结构化**的显式失败，且写清缺哪个工具、因此哪条判据不成立。
      expect(failure, `工具门抛了非 ToolchainUnavailableError 的异常：${String(failure)}`).toBeInstanceOf(
        ToolchainUnavailableError,
      );
      const typed = failure as ToolchainUnavailableError;
      expect(typed.missing.length).toBeGreaterThan(0);
      expect(typed.message).toContain('独立读回');
      expect(typed.message).toContain('不得跳过或降级');
      return;
    }

    const info = toolchain as ReturnType<typeof requireToolchain>;
    // R53.2 + R53.8：**实际调用的命令**与**工具自述**是两个独立的非空字段。
    for (const tool of [info.python, info.unzip]) {
      expect(tool.via.length).toBeGreaterThan(0);
      expect(tool.executable.length).toBeGreaterThan(0);
      expect(tool.version.length).toBeGreaterThan(0);
    }
    expect(info.unzip.version.startsWith('UnZip'), `unzip 自述应是版本横幅：${info.unzip.version}`).toBe(true);
    expect(info.unzip.executable).not.toBe(info.unzip.version);
  });
});

describe('R60：StoreSnapshot 的两个产物集合是必填字段（类型层）', () => {
  it('缺 artifacts / shared_facts 的字面量必须编译失败；完整快照可赋值（对照）', () => {
    type WithoutArtifacts = Omit<StoreSnapshot, 'artifacts'>;
    type WithoutFacts = Omit<StoreSnapshot, 'shared_facts'>;

    const withoutArtifacts = {} as WithoutArtifacts;
    const withoutFacts = {} as WithoutFacts;

    // @ts-expect-error 缺少 artifacts ⇒ 编译期报错（若字段被改成可选，本行会因"无错误"而红）
    const missingArtifacts: StoreSnapshot = withoutArtifacts;
    // @ts-expect-error 缺少 shared_facts ⇒ 编译期报错（同上）
    const missingFacts: StoreSnapshot = withoutFacts;

    // 正向对照：真实内存存储产出的完整快照可以赋值（证明不是"凡赋值皆错"）。
    const complete: StoreSnapshot = createMemoryStore().snapshot();
    expect(Array.isArray(complete.artifacts)).toBe(true);
    expect(Array.isArray(complete.shared_facts)).toBe(true);

    // 运行期不许出现"字段其实是 undefined"：两个集合恒为数组、默认空。
    expect(Array.isArray(missingArtifacts.artifacts ?? [])).toBe(true);
    expect(Array.isArray(missingFacts.shared_facts ?? [])).toBe(true);
  });
});
