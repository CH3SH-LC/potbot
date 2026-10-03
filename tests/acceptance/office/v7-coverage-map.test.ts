/**
 * **V7 覆盖映射（task-id D02A-V7）——design-02 的每一条验收标准 ↔ 现有验收套件对表**。
 *
 * ## 这份文件解决什么问题
 *
 * 「套件全绿」与「标准被覆盖」是两件事。G01–G05 那批的教训就是：746 项全绿，却**没有一条**
 * 覆盖跨任务越权。本文件把 design-02 的验收标准**逐条**映射到**具体的文件 + 用例名**，
 * 并把这份映射**机器化**——将来谁删掉/改名了那条覆盖，本文件会红。
 *
 * ## 三态（本文件是这三态的唯一机器化形式）
 *
 * - **已覆盖**：`COVERAGE` 表里的一条 —— 断言「该文件的用例名集合里存在含该片段的用例」。
 * - **部分覆盖**：同一标准下既有 `COVERAGE` 条目（被覆盖的那半），也有 `GAPS` 条目（缺的那半）。
 * - **未覆盖**：只出现在 `GAPS` 表里。
 *
 * `GAPS` 是**反向 tripwire**：断言「现有套件里**没有**匹配该模式的用例名」。一旦有人补上了
 * 那条覆盖，这条断言会红，提示把该缺口移进 `COVERAGE` 并更新清单——缺口清单不会悄悄过期。
 *
 * ## 口径（为什么这样做是可信的，不是自说自话）
 *
 * - **只看用例名，不看注释**：`extractTitles()` 只从 `it(` / `test(` / `describe(` 的**字符串字面量**
 *   里取标题。注释里写过什么不算覆盖——「覆盖」的判据是**有一条能失败的用例**。
 * - **不引用被测套件的任何实现**：本文件只读**源文本**，不 import 它们、不跑它们。
 * - **可失败性自证**：见「仪器自证」一节——把被断言的标题从源文本里删掉，同一匹配器当场变绿为红。
 * - **自我排除**：`GAPS` 的套件级扫描**排除本文件**（否则本文件自己的用例名里就写着「气泡」
 *   「两群组」这些缺口关键词，会把自己的负向断言踩红）。
 *
 * ## 判据来源
 *
 * `docs/design/design-02-真实办公文件与版本更新.md` 的「验收标准」全节（含**真实文件判据 /
 * 版本更新判据 / 气泡判据 / 不达标的情形 / 验证方式**五项）、§19 的 **A06 / A07 / A11 / A13 / A16**、
 * 合同 v1.4（R47–R61）。
 *
 * ## 纪律
 *
 * 本文件**只读**：不写任何产物、不调用 `openWithOffice`、不改被测套件。它在本目录里用 `node:fs`
 * 是 R50.4 明确允许的（`tests/acceptance/office/**` 是唯一允许文件 IO 的位置）。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// 路径与加载
// ---------------------------------------------------------------------------

/** 本文件所在目录 = `tests/acceptance/office/`（相对定位，不依赖 cwd）。 */
const OFFICE_DIR = dirname(fileURLToPath(import.meta.url));

/** 本文件名（用于把自己从套件级扫描里排除，见文件头「自我排除」）。 */
const SELF = 'v7-coverage-map.test.ts';

const sourceCache = new Map<string, string>();

/** 读一个被映射文件的源文本；读不到 ⇒ **硬失败**（映射的被断言对象不存在，映射不成立）。 */
function sourceOf(relativePath: string): string {
  const cached = sourceCache.get(relativePath);
  if (cached !== undefined) return cached;
  const absolute = resolve(OFFICE_DIR, relativePath);
  let text: string;
  try {
    text = readFileSync(absolute, 'utf8');
  } catch (error) {
    throw new Error(
      `覆盖映射的输入文件读不到：${absolute} —— ${String(error)}。` +
        '本映射断言的对象缺失，映射不成立（不得静默跳过）。',
    );
  }
  sourceCache.set(relativePath, text);
  return text;
}

/**
 * 从源文本里提取全部 `it` / `test` / `describe` 的**标题字面量**。
 *
 * 刻意**不**解析 TS AST：本判据只关心"用例名里有没有这个词"，裸正则足够且不会因语法演进失效。
 * 带 `(` 的分支要求标题紧跟左括号（可跨空白/换行，覆盖 `it(\n '名字',\n { timeout }, fn)` 形态）；
 * 注释里出现的 `it(name, ...)` 这类**不是字符串字面量**，因此不会被当成标题。
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

const titlesCache = new Map<string, readonly string[]>();

function titlesOf(relativePath: string): readonly string[] {
  const cached = titlesCache.get(relativePath);
  if (cached !== undefined) return cached;
  const titles = extractTitles(sourceOf(relativePath));
  titlesCache.set(relativePath, titles);
  return titles;
}

/** 「该文件里存在一个用例名含此**字面片段**」——这就是「已覆盖」的机器判据。 */
function hasTitle(relativePath: string, fragment: string): boolean {
  return titlesOf(relativePath).some((title) => title.includes(fragment));
}

// ---------------------------------------------------------------------------
// 被测套件清单（**排除本文件**；见文件头「自我排除」）
// ---------------------------------------------------------------------------

const OFFICE_SUITE: readonly string[] = [
  'p1-real-files.test.ts',
  'p3-shared-facts.test.ts',
  'p6-template-contracts.test.ts',
  'office-negative.test.ts',
  'office-reproducibility.test.ts',
  'v1-ooxml-templates.test.ts',
  'v2-facts-independent.test.ts',
  'v3-publish-independent.test.ts',
  'v4-scheduler-artifact-flow.test.ts',
  'v5-mutation-sensitivity.test.ts',
  'w-disc-kernel-discipline.test.ts',
];

function suiteTitles(): readonly string[] {
  const all: string[] = [];
  for (const file of OFFICE_SUITE) all.push(...titlesOf(file));
  return all;
}

// ---------------------------------------------------------------------------
// 数据表：已覆盖 / 部分覆盖的「被覆盖的那半」
// ---------------------------------------------------------------------------

/** design-02 验收标准的封闭清单（用于"有没有哪条被整条漏掉"的自检）。 */
const STANDARDS: readonly string[] = [
  'A06',
  'A07',
  'A11',
  'A13',
  'A16',
  '真实文件判据',
  '版本更新判据',
  '气泡判据',
  '不达标的情形',
  '验证方式',
];

interface Coverage {
  readonly standard: string;
  /** 相对本目录（office/）的路径；跨套件佐证用 `../p4/...`。 */
  readonly file: string;
  /** 必须出现在某个用例名里的**字面片段**。 */
  readonly title: string;
  /** 这条映射主张什么（写给将来要改动它的人）。 */
  readonly note: string;
}

const COVERAGE: readonly Coverage[] = [
  // ---- 真实文件判据：路径存在 / 三类各至少一份 ----
  {
    standard: '真实文件判据',
    file: 'p1-real-files.test.ts',
    title: '各恰好一份已发布记录',
    note: '三类（document / spreadsheet / presentation）各至少 1 份真实产出',
  },
  {
    standard: '真实文件判据',
    file: 'p1-real-files.test.ts',
    title: '版本化路径存在且形状正确',
    note: '「路径实际存在」+ 版本化形状 `{root}/{task}/r{rev}/{kind}/{id}.{ext}`',
  },
  {
    standard: '验证方式',
    file: 'p1-real-files.test.ts',
    title: '任务版本等于记录的 task_revision',
    note: '每份产物绑定的任务版本被显式断言（验证方式要求逐份输出任务版本）',
  },
  // ---- 真实文件判据：结构可解析（三类各自，第二层 + 第三层） ----
  {
    standard: '真实文件判据',
    file: 'p1-real-files.test.ts',
    title: '独立读回，结论全部为 ok',
    note: '三份产物经 Python zipfile + xml.etree + unzip -t 独立读回（第二层，遍历三类）',
  },
  {
    standard: '真实文件判据',
    file: 'p1-real-files.test.ts',
    title: '全部部件无 UTF-8 BOM',
    note: '结构合法性的一环（带 BOM 的 OOXML 会被拒绝）',
  },
  {
    standard: '真实文件判据',
    file: 'v1-ooxml-templates.test.ts',
    title: '两次 writeZip 逐字节相等，且中央目录常量全部命中',
    note: 'ZIP 结构常量按**每个模板标签**各断言一次（三类各自，不是只测一类）',
  },
  {
    standard: '真实文件判据',
    file: 'v1-ooxml-templates.test.ts',
    title: 'Python 独立解析（readbackArtifact）：testzip() 为 None 且 unzip -t 退出码 0',
    note: '第二层独立解析的独立复算',
  },
  // ---- 真实文件判据：关键内容与任务版本一致 ----
  {
    standard: '真实文件判据',
    file: 'p1-real-files.test.ts',
    title: 'document：人数与日期逐字出现在读回的部件文本里',
    note: 'DOCX 的关键内容与当前版本事实一致（且断言旧值不出现）',
  },
  {
    standard: '真实文件判据',
    file: 'p1-real-files.test.ts',
    title: 'spreadsheet：人数以数值单元格写入',
    note: 'XLSX 的关键内容与事实一致',
  },
  {
    standard: '真实文件判据',
    file: 'p1-real-files.test.ts',
    title: 'presentation：人数 / 预算 / 日期三行都来自事实快照',
    note: 'PPTX 的关键内容与事实一致',
  },
  {
    standard: '真实文件判据',
    file: 'p1-real-files.test.ts',
    title: '改一版事实 ⇒ 产物内容随之改变',
    note: '反硬编码：内容不是写死的（本条同时是「不达标的情形」中"模拟数据/硬编码冒充产出"的对照）',
  },
  // ---- 需求 3 / 真实文件判据：关键共享数据单一来源 ----
  {
    standard: '真实文件判据',
    file: 'p1-real-files.test.ts',
    title: '三类产物引用',
    note: 'R48.3 单一来源的机器判据：三类产物的 source_fact_refs 指向同一条事实',
  },
  {
    standard: '真实文件判据',
    file: 'p3-shared-facts.test.ts',
    title: '同一份 headcount 事实被三类产物引用',
    note: '产物级单一来源（J6）',
  },
  // ---- 不达标的情形：只在聊天里显示文件名 ----
  {
    standard: '不达标的情形',
    file: 'office-negative.test.ts',
    title: '负向臂：只在聊天里报出文件名',
    note: '「只在聊天里显示文件名的交付」必须判假（J4 负向臂）',
  },
  {
    standard: '不达标的情形',
    file: 'office-negative.test.ts',
    title: '正向臂（对照）：带意图走暂存 + 发布投影',
    note: 'J4 的正向对照：同一文件名在"带意图"下才真产出 ⇒ 判据不是恒假',
  },
  {
    standard: '不达标的情形',
    file: 'office-negative.test.ts',
    title: 'staged（已暂存但未发布）同样不构成交付',
    note: 'I-4：中间态不满足任何"已交付"判据',
  },
  // ---- 失败分支：资料缺失 / 工具失败，且如实报告 ----
  {
    standard: '真实文件判据',
    file: 'p3-shared-facts.test.ts',
    title: 'J5-a 值为 unknown',
    note: '失败分支 · 资料缺失（unknown）：结构化拒绝 missing_fact、不产出零值产物',
  },
  {
    standard: '真实文件判据',
    file: 'p3-shared-facts.test.ts',
    title: 'J5-b 值为 not_applicable',
    note: '失败分支 · not_applicable 同样不得当成 0',
  },
  {
    standard: '真实文件判据',
    file: 'p3-shared-facts.test.ts',
    title: 'J5-c 未登记键',
    note: '失败分支 · 未登记键 ⇒ 阻塞；失败记录不伪造 fact_ref',
  },
  {
    standard: '真实文件判据',
    file: 'p3-shared-facts.test.ts',
    title: 'J5-d 只登记了别的版本',
    note: '失败分支 · 更高版本的事实不算当前',
  },
  {
    standard: '不达标的情形',
    file: 'p3-shared-facts.test.ts',
    title: 'J5 对照：已知的 0 是合法值',
    note: '「把缺失值当零」的对照：证明判的是"缺失 vs 零"，不是"禁止 0"',
  },
  {
    standard: '真实文件判据',
    file: 'office-negative.test.ts',
    title: 'failed + detail 非空 + 盘上不留文件',
    note: '失败分支 · 工具失败（build / write / verify 三条注入）：failed + detail 非空 + 绝不冒充 published',
  },
  {
    standard: '真实文件判据',
    file: 'office-negative.test.ts',
    title: '对照（防恒假）：同一套装置、不开故障开关',
    note: 'J10 的正向对照：不开故障开关 ⇒ 同一 artifact_id 变 published 且有文件',
  },
  {
    standard: '真实文件判据',
    file: 'office-negative.test.ts',
    title: '开关集合与端口声明一致',
    note: 'J10 的覆盖自洽：三条分支都在写盘前短路',
  },
  {
    standard: '验证方式',
    file: 'v4-scheduler-artifact-flow.test.ts',
    title: '引用了**未登记**的事实键',
    note: '调度入口（finishRun）上的缺事实拒绝：rejected_publications + ledger_reason=missing_fact',
  },
  {
    standard: '不达标的情形',
    file: 'v4-scheduler-artifact-flow.test.ts',
    title: '事实**显式登记为 unknown**',
    note: '调度入口上的"不得把未知当零"',
  },
  // ---- A06：能力缺失 ⇒ 如实报告，不编造 ----
  {
    standard: 'A06',
    file: 'v4-scheduler-artifact-flow.test.ts',
    title: '未注入 artifact_root_dir ⇒ artifact_root_dir_unset',
    note: 'A06 的"能力/前置缺失 ⇒ 报告缺失而非编造"（未注入 ⇒ 拒绝，不猜落盘位置）',
  },
  {
    standard: 'A06',
    file: 'v4-scheduler-artifact-flow.test.ts',
    title: '未注入端口 ⇒ 产物停在 staged',
    note: '未注入能力（物化端口）⇒ 不得被当作已交付（I-4）',
  },
  {
    standard: 'A06',
    file: 'office-negative.test.ts',
    title: '绝不冒充 published',
    note: 'A06 的"不编造能力"：端口结构化失败 ⇒ failed，不谎称成功',
  },
  {
    standard: 'A06',
    file: '../p4/p4.work-commitment.test.ts',
    title: 'F01：取消目标越权（跨任务/跨群/错误接收者/旧版本）⇒ 整个入口失败且零业务变更',
    note: 'A06 的"不借成员越权"——**跨套件佐证**（属 G01–G05 批，不在 office 套件内；见缺口清单 G7）',
  },
  // ---- A11 的一半：没有回执/读回证据不得宣称完成 ----
  {
    standard: 'A11',
    file: 'v3-publish-independent.test.ts',
    title: '行为：端口未成功时，存储里任何记录都不得带回执',
    note: 'A11 的**产物侧**一半："没有回执不得宣称完成"（七态外部动作那半仍是缺口，见 G4）',
  },
  {
    standard: 'A11',
    file: 'v3-publish-independent.test.ts',
    title: '自造反例：端口报成功但回执缺/空回读摘要',
    note: 'A11 的产物侧：端口自称成功但无回读证据 ⇒ 不得成为 published',
  },
  {
    standard: 'A11',
    file: 'v3-publish-independent.test.ts',
    title: '源码级：publish.ts 里的 readback_digest 只来自端口回执',
    note: 'A11 的产物侧：不得自造回执',
  },
  // ---- A13 的一半：费用缺失 / 未知不得当零 ----
  {
    standard: 'A13',
    file: 'v2-facts-independent.test.ts',
    title: '四种情形逐一进不可用表、带原因，且可用表里没有任何零值条目',
    note: 'A13 的**费用缺失/未知**一半（条件冲突那半是缺口，见 G5）',
  },
  {
    standard: 'A13',
    file: 'p6-template-contracts.test.ts',
    title: '未知事实 ⇒ 值单元格整格不存在',
    note: 'A13 的产物侧：表格不把缺失当零（值格整格不存在、全文无 <v>0</v>）',
  },
  {
    standard: 'A13',
    file: 'p6-template-contracts.test.ts',
    title: '对照：已知的 0 是合法值 ⇒ 必须写出',
    note: 'A13 的反向对照（证明不是"禁止 0"）',
  },
  {
    standard: 'A13',
    file: 'v2-facts-independent.test.ts',
    title: '用 0 冒充未知',
    note: 'A13 的结构性判据：unknown 携带数值载荷 ⇒ unknown_carries_payload',
  },
  // ---- 版本更新判据：旧产物不得冒充当前结果 / 不得被覆盖 ----
  {
    standard: '版本更新判据',
    file: 'office-negative.test.ts',
    // 用例名曾为「记录绑 r1、任务已到 r2 ⇒ superseded」；W-FIX3 把夹具改走内核公开入口后，
    // 语义变成"收尾入口直接拒绝（stale_task_revision）"——`superseded` 那条**状态**语义
    // 归位到 `publish.ts` 的投影路径（由下面 v3 的两条覆盖）。两条合起来才是本判据的完整覆盖。
    title: '记录绑 r1、任务已到 r2 ⇒ finishRun 拒绝（stale_task_revision），一条记录都不写',
    note: 'J9：被超越的产物**不得交付**——收尾入口拒绝、零记录、零写盘、端口零调用',
  },
  {
    standard: '版本更新判据',
    file: 'v3-publish-independent.test.ts',
    title: '合同的终态是 superseded（不是 failed）',
    note: '旧产物保留为历史、不得冒充当前结果（R58）',
  },
  {
    standard: '版本更新判据',
    file: 'v3-publish-independent.test.ts',
    title: '只有 published 且带回执才算交付',
    note: '交付判据函数本身：staged / failed / superseded 都不算交付',
  },
  {
    standard: '版本更新判据',
    file: 'v4-scheduler-artifact-flow.test.ts',
    title: '两次公开入口发布各自物化到不同路径，第一次的文件 sha256 保持不变',
    note: '「旧产物不得被覆盖」：物化两次后旧文件字节的 sha256 不变（本条是**产物版本**递增形态）',
  },
  {
    standard: '版本更新判据',
    file: 'p1-real-files.test.ts',
    title: '三类产物的路径互不相同',
    note: '版本化 + 分目录 ⇒ 不互相覆盖',
  },
  {
    standard: '版本更新判据',
    file: 'v3-publish-independent.test.ts',
    title: '第二次投影：零事务、零记录写入、零端口调用',
    note: '产物级幂等（R49.1 段3）——是"重复点击不重复发起"在**产物**上的类比；气泡形态仍是缺口 G3',
  },
  // ---- 需求 6 / P6：三类模板各自的最小能力合同 ----
  {
    standard: '不达标的情形',
    file: 'p6-template-contracts.test.ts',
    title: '正例：正文里的关键值逐字来自事实快照',
    note: 'P6 文档：不自行改写已确认数据（正例走真实管线）',
  },
  {
    standard: '不达标的情形',
    file: 'p6-template-contracts.test.ts',
    title: '负例：正文出现快照外的数字',
    note: 'P6 文档：边界可失败（构建期拒绝）',
  },
  {
    standard: '不达标的情形',
    file: 'p6-template-contracts.test.ts',
    title: '正例：产物可见文本里每个数字都能指认到快照',
    note: 'P6 演示：不另编数字（正例）',
  },
  {
    standard: '不达标的情形',
    file: 'p6-template-contracts.test.ts',
    title: '负例：非事实文本含数字 ⇒ 构建期拒绝',
    note: 'P6 演示：边界可失败',
  },
  // ---- 不达标的情形：模拟数据 / 硬编码冒充真实产出 ----
  {
    standard: '不达标的情形',
    file: 'v5-mutation-sensitivity.test.ts',
    title: '至少覆盖提示词点名的 7 组变异',
    note: '变异敏感性矩阵：改一处实现必须变红 ⇒ 反"硬编码流程冒充真实产出"',
  },
  {
    standard: '不达标的情形',
    file: 'v5-mutation-sensitivity.test.ts',
    title: '"改了也不红"的记录必须如实标注 discriminated=false',
    note: '反作弊的诚实面：分不清的变异必须如实登记，不得假装有判据',
  },
  {
    standard: '不达标的情形',
    file: 'v1-ooxml-templates.test.ts',
    title: '正文里出现快照没有的数字 77 ⇒ 构建器抛错',
    note: 'P6 文档边界的独立复算（自造负例 ⇒ 真能抛）',
  },
  {
    standard: '不达标的情形',
    file: 'v3-publish-independent.test.ts',
    title: '提交前失败 ⇒ 存储零新增、端口零调用',
    note: '反"文件已生成但版本未登记"的窗口（info-006）',
  },
  // ---- 验证方式：确定性假 Agent 场景可重复执行 ----
  {
    standard: '验证方式',
    file: 'office-reproducibility.test.ts',
    title: '三类产物各构造两次 ⇒ 容器字节逐字节相等、sha256 相等',
    note: '「确定性假 Agent 场景脚本可重复执行」的机器判据（J8）',
  },
  {
    standard: '验证方式',
    file: 'office-reproducibility.test.ts',
    title: '跨进程：子 node 进程对已落盘字节算出的 sha256 与主进程一致',
    note: '可重复性跨进程复核',
  },
  {
    standard: '验证方式',
    file: 'office-reproducibility.test.ts',
    title: '产物可读回：readback.ok 且 sha256(落盘)',
    note: '端到端 I-1：落盘摘要 == 记录 content_digest == 回执 readback_digest',
  },
  {
    standard: '验证方式',
    file: 'w-disc-kernel-discipline.test.ts',
    title: 'src/**（非测试）的**代码**文本不含任何禁用 token',
    note: '内核零文件 IO / 零墙钟 ⇒ "真实文件由宿主写、场景可重复"的地基',
  },
  {
    standard: '验证方式',
    file: 'w-disc-kernel-discipline.test.ts',
    title: '对照（防假绿）：自造的违例代码 ⇒ 扫描器必须逐个命中',
    note: '上述纪律断言的可失败性对照',
  },
];

// ---------------------------------------------------------------------------
// 数据表：缺口（未覆盖 / 部分覆盖里缺失的那半）
// ---------------------------------------------------------------------------

interface Gap {
  readonly standard: string;
  /** 人可读的缺口名。 */
  readonly what: string;
  /** 若将来有**用例名**匹配它 ⇒ 说明缺口被补上了，本 tripwire 会红并要求更新清单。 */
  readonly titlePattern: RegExp;
  /** 缺什么 / 为什么现在不算覆盖 / 补什么 / 属本批还是下一批。 */
  readonly detail: string;
}

const GAPS: readonly Gap[] = [
  {
    standard: 'A16',
    what: '两群组写同一资源（并发写 / 资源锁 / 期望版本检查）',
    titlePattern: /两群组|并发写|资源锁|期望版本|静默覆盖|expected_version/,
    detail:
      '缺：本套件**没有**任何"同一资源被两处写"的用例，`src/**` 里也**没有**锁或期望版本检查的实现。' +
      '为什么不算覆盖：现有的版本闸门（J9 / v3-486）只处理"**自己**所绑版本已陈旧"⇒ superseded；' +
      'v3 的幂等（第二次投影只跳过）是**顺序**形态。二者都不是并发保护——R51.4 让同任务同种类的路径**稳定可派生**，' +
      '因此"两处并发写同一最终路径"在本设计下是**可能**的，且无任何用例阻止静默覆盖。' +
      '补什么：共享一个 root、两个场景/两个群对同一 artifact_id（或同一最终路径）并发物化，' +
      '断言第二处被锁 / 期望版本检查阻止，或幂等返回既有回执且**字节不变**。' +
      '属：**下一批**（合同 v1.4 §0 明确本批不做共享资源锁；需先有锁或期望版本的接口设计）。',
  },
  {
    standard: 'A07',
    what: '受影响产物更新、未受影响部分不重算（同时是版本更新判据的主判据）',
    titlePattern: /只重算|未受影响的产物|受影响的产物|受影响产物/,
    detail:
      '缺：**没有**"任务版本 r1→r2 后，受影响的产物被**重新生成**、未受影响的不重算"的用例。' +
      '为什么不算覆盖：`p1` J3 的"八人→十人"是**两个独立场景**（不同标签/不同根），任务版本**都是 r1**——' +
      '它证的是"内容跟着事实走"，不是"版本变更后重新生成"；J9 只证被超越的产物 **superseded 且端口零调用**' +
      '（即"旧的不重发"），**没有任何一条断言"新的被生成"**。' +
      '补什么：在 r1 发布后把 TaskRecord 版本升到 r2、登记 r2 事实，断言：受影响产物以 r2 重新生成' +
      '（task_revision = 2、内容取 r2 事实）、端口调用次数**只增受影响的份数**、未受影响的产物记录与字节**完全不动**。' +
      '属：**下一批**（design-02-P2「只重算受影响部分」不在本批，且需要产物依赖图）。',
  },
  {
    standard: '气泡判据',
    what: '旧气泡失效 / 三类气泡 / 参数指纹 / 重复点击不重复发起（A07 的气泡那半）',
    titlePattern: /气泡|参数指纹|动作对象/,
    detail:
      '缺：整套**气泡判据**（设计第 11 节 / design-02-P4）在本批内**一条都没有**：三类气泡各出现至少一次、' +
      '可指认的动作对象与参数指纹、同源显示、改需求后旧气泡不可再被确认。' +
      '为什么不算覆盖：A 批范围**不含**决策气泡（合同 §0）；套件里也没有 `ActionRecord`。' +
      '最接近的是 v3 的**产物**幂等（"重复点击不重复发起"在产物上的类比）——对象不同，不能顶替。' +
      '补什么：一类一个用例，断言 `ActionRecord` 的来源与显示同源、参数指纹可复算、版本不匹配的气泡不可确认。' +
      '属：**下一批**（P4）。',
  },
  {
    standard: 'A11',
    what: '外部结果未知 → 七态如实区分、不宣称完成、不以本地状态冒充外部撤销',
    titlePattern: /外部结果|外部交接|外部撤销|七态/,
    detail:
      '缺：§12 的**七态**（已准备/已交接/已提交/已确认完成/结果未知/用户报告完成/已失效失败取消）在本批内**无对象**。' +
      '为什么不算覆盖：本批没有外部动作适配器；已有的是**产物侧**的"没有回执不得宣称完成"（I-1，见 COVERAGE），' +
      '那是同一原则在文件交付上的形态，**不是**外部动作的七态。' +
      '补什么：外部交接/授权执行的动作对象 + 七态结局的用例（含"结果未知 ⇒ 不宣称完成、不盲目重试"）。' +
      '属：**下一批**（P5 / §12 适配器）。',
  },
  {
    standard: 'A13',
    what: '条件冲突（两条事实互相矛盾、单位 / 币种不一致）',
    titlePattern: /条件冲突|互相矛盾|币种不一致|单位不一致/,
    detail:
      '缺：**费用缺失**那半已覆盖（见 COVERAGE）；**条件冲突**那半无用例。' +
      '为什么不算覆盖：`src/facts/**` 只有"缺失"族的拒因（missing_unit / missing_currency / missing_time_zone…），' +
      '**没有**任何冲突检测；v2 判据1 的"同键两条当前事实 ⇒ 拒绝"是**单一来源**被破坏（同键重复），' +
      '不是"两条事实语义互相矛盾"（例如同一条预算在两个单位/币种下取值）。' +
      '补什么：登记两条语义冲突的事实（单位/币种不一致，或同键不同值且都自称当前）⇒ 断言结构化拒绝并点名冲突。' +
      '属：**下一批**（需先实现冲突检测并补合同拒因种类；本批合同无此条款）。',
  },
  {
    standard: '真实文件判据',
    what: '失败分支在**工作项**层如实报告"部分完成 / 未知"（可指认到缺失的事实键）',
    titlePattern: /部分完成/,
    detail:
      '缺：失败分支的"如实报告"目前只证到 **ArtifactRecord / rejected_publications / kernel_events** 层' +
      '（detail 非空、ledger_reason=missing_fact、事件 data 含缺失键名），**没有**一条断言工作项**自身**' +
      '带着可指认的原因。' +
      '为什么不算覆盖（D02A-WFIX6 **实测**，非阅读源码）：`v8-workitem-reporting.test.ts` 在公开入口' +
      '（onMessage→startRun→finishRun）上构造缺事实的完成发布，实测工作项的状态与原因字段——' +
      '它会停在 `processing`，`failure_reason` 为 `null`，`blocker_reason` **仍是认领时的通用占位**' +
      '（`kind: other`，detail 是"处理中：已由运行轮次认领"），既不提缺失键名也不提 `missing_fact`；' +
      '同一用例同时证明该键名**确实**出现在 `publication_rejected` 事件的 `data.message` 里' +
      '（⇒ 结论不是空转的"没找到"，而是"键名已被内核记录，但**不在工作项上**"）。' +
      '字段面是有的（`src/protocol/work-item.ts` 的 `blocker_reason` / `failure_reason`，且转换表允许' +
      '`processing → processing` 自环"只更新等待原因明细"），**是内核在该路径上没有写**：' +
      '`src/scheduler/runs.ts` 的产物暂存失败分支只做 `rejected.push(...) + continue`，不触发任何工作项转换。' +
      '补什么：在该失败分支里对工作项做一次转换（`processing` 自环更新 `blocker_reason`，或按口径改为' +
      '`waiting_dependency` / `failed`），使原因可指认到缺失的事实键；随后在 `v8` 上把判据 4 的' +
      '"断言现状"翻转为"断言原因可指认"。' +
      '属：**下一批**（本包**不可补**——它**必须动 `src/scheduler/runs.ts`**，而 D02A-WFIX6 的写入权' +
      '只有两个测试文件；且改前应先定 blocker kind 与文案口径）。' +
      '**补它的人注意**：本 tripwire 只扫 `OFFICE_SUITE`，而 `v8-workitem-reporting.test.ts` **不在**该名单内，' +
      '故本缺口若在 v8 之外被补上、或 v8 未被加入 `OFFICE_SUITE`，本 tripwire 察觉不到——' +
      '补上时请把该条搬进 `COVERAGE` 并把 v8 加入 `OFFICE_SUITE`。',
  },
  {
    standard: 'A06',
    what: 'office 套件内覆盖"不借成员越权"',
    titlePattern: /越权.*(产物|文件|发布)|借成员|member_privilege/,
    detail:
      '缺：A06 的"不借成员越权"在**本套件内**无用例（跨套件已由 p4 F01 覆盖，见 COVERAGE）。' +
      '为什么不算覆盖：p4 F01 证的是**取消目标**越权，属另一对象；office 套件里没有任何"越权成员不得产出/发布产物"的用例。' +
      '补什么：在 office 场景里让一个不属于该任务/该群的实例发起产物意图 ⇒ 断言被拒、零记录零写盘。' +
      '属：**本批可选补**（同型判据已有 p4 F01；不补则 A06 的这半只有跨套件佐证）。',
  },
  {
    standard: '真实文件判据',
    what: '第三层「目标软件可打开」（本机 Office COM 真打开并读回关键值）',
    titlePattern: /Word 打开并读回|Excel 打开并读回|PowerPoint 打开并读回|目标软件可打开/,
    detail:
      '缺：第三层（原 `office-open.test.ts`：本机 Word / Excel / PowerPoint 经 COM 真打开并读回关键值）' +
      '**已从本套件移除**，不再作为本批验收判据。' +
      '为什么不算覆盖（用户 2026-10-02 给出的两条**方向性事实**）：' +
      '① **平台错位**——目标平台是**安卓手机**，桌面 Office 打开**不是**目标形态；真正的"目标软件打开"' +
      '应在**真机**（安卓办公应用）上做，属 `docs/GOAL.md` 的**真机**范围，而本方案明确"当前不扩展' +
      '模型和真机实现"；② **环境不可得且不可重复**——本机（桌面 Windows）Office **无授权 / 无法使用**，' +
      '且实测还依赖本机 Office 进程状态（COM 留下的无窗口孤儿会让后续调用被附着护栏判 `inconclusive`，' +
      '仪器自毒）；③ **验收条件错位**——若留在默认套件，"套件是否全绿"就会依赖一台**有授权**的桌面 Office，' +
      '即把环境当判据（合同 v1.4 §8d / R65.2）。' +
      '落点：**真机验证**——在安卓目标设备上用安卓办公应用打开产物并读回关键内容；在那之前，' +
      '本项如实标注为**未验证**，**不得**用第二层（Python / `unzip` 独立读回）顶替：' +
      '第二层只能证"结构合法"，证不了目标软件能打开（R53.1）。' +
      '本批判据只有前两层（R65.1）；保留的 `office-open-check.ts` 是**可选工具、不参与默认套件**，' +
      '供将来具备授权桌面环境者使用（合同 §8d / R65.4）。' +
      '**补它的人注意**：本 tripwire 只扫 `OFFICE_SUITE`，而第三层现已**不在**该名单内；' +
      '若将来有真机 / 授权环境的用例，请把该条搬进 `COVERAGE` 并按需把该文件加入 `OFFICE_SUITE`。',
  },
];

// ---------------------------------------------------------------------------
// 仪器自证（在断言任何覆盖之前，先证明这套匹配器**能红**）
// ---------------------------------------------------------------------------

describe('仪器自证：提取器与匹配器可失败', () => {
  it('控制组：每个被映射文件都提取到多个标题，且杜撰片段不命中', () => {
    for (const file of OFFICE_SUITE) {
      expect(titlesOf(file).length, `${file} 提取到的标题数`).toBeGreaterThan(3);
    }
    // 本文件也不该是空的（否则"自我排除"就是空话）。
    expect(extractTitles(sourceOf(SELF)).length).toBeGreaterThan(3);
    // 反向控制：杜撰的片段一个都不命中（证明 hasTitle 不是恒真）。
    expect(hasTitle('p1-real-files.test.ts', '这是杜撰的片段-9f3a-覆盖映射自证')).toBe(false);
    expect(suiteTitles().some((title) => title.includes('这是杜撰的片段-9f3a-覆盖映射自证'))).toBe(false);
  });

  it('可失败性自证：把被断言的标题从源文本里删掉 ⇒ 同一匹配器当场变红', () => {
    const probes: readonly { readonly file: string; readonly fragment: string }[] = [
      { file: 'p1-real-files.test.ts', fragment: '版本化路径存在且形状正确' },
      { file: 'office-negative.test.ts', fragment: 'failed + detail 非空 + 盘上不留文件' },
      {
        file: 'office-reproducibility.test.ts',
        fragment: '三类产物各构造两次 ⇒ 容器字节逐字节相等',
      },
    ];
    for (const probe of probes) {
      expect(hasTitle(probe.file, probe.fragment), `前置：${probe.file} 现在确实有这条覆盖`).toBe(true);

      // 模拟"有人把这条覆盖删掉/改名"：在内存里的源文本上抹掉该片段，再走**同一套**匹配器。
      const mutated = sourceOf(probe.file).split(probe.fragment).join('【该覆盖已被删除】');
      const mutatedTitles = extractTitles(mutated);
      expect(
        mutatedTitles.some((title) => title.includes(probe.fragment)),
        `${probe.file}：删掉「${probe.fragment}」后匹配器仍然命中 ⇒ 匹配器不可失败（本映射无意义）`,
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 表自洽：每一条验收标准都在映射里有位置
// ---------------------------------------------------------------------------

describe('映射表的自洽性', () => {
  it('design-02 的每条验收标准都至少出现在 COVERAGE 或 GAPS 里', () => {
    const covered = new Set<string>([...COVERAGE, ...GAPS].map((row) => row.standard));
    for (const standard of STANDARDS) {
      expect(
        covered.has(standard),
        `标准「${standard}」在映射表里整条缺失 ⇒ 对表不完整，请补齐`,
      ).toBe(true);
    }
    // 反向：表里不得出现标准清单外的名字（防止拼写漂移把某条标准悄悄拆散）。
    for (const standard of covered) {
      expect(STANDARDS).toContain(standard);
    }
  });

  it('每条 COVERAGE 的片段在其文件里都能命中（表不是从别处抄来的）', () => {
    const misses = COVERAGE.filter((row) => !hasTitle(row.file, row.title)).map(
      (row) => `${row.file} :: ${row.title}`,
    );
    expect(misses, `COVERAGE 表里有 ${String(misses.length)} 条自相矛盾（片段在文件里找不到）`).toEqual([]);
  });

  it('每条 GAP 的缺口模式在当前套件里确实一个都不命中', () => {
    const all = suiteTitles();
    for (const gap of GAPS) {
      const hits = all.filter((title) => gap.titlePattern.test(title));
      expect(hits, `缺口「${gap.what}」的模式 ${String(gap.titlePattern)} 命中了：${hits.join('；')}`).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// 逐条展开：已覆盖 —— 每条一个用例，删掉哪条覆盖就红哪条
// ---------------------------------------------------------------------------

describe('已覆盖：每条标准的覆盖点必须存在（删除/改名 ⇒ 本条变红）', () => {
  for (const entry of COVERAGE) {
    it(`[${entry.standard}] ${entry.file} :: ${entry.title}`, () => {
      expect(
        hasTitle(entry.file, entry.title),
        `未找到覆盖用例：${entry.file} 里没有任何 it/describe 名含「${entry.title}」。\n` +
          `本条主张：${entry.note}\n` +
          '若这条覆盖被删除或改名，请补回覆盖，或据实更新本映射表（不得让它悄悄消失）。',
      ).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// 逐条展开：缺口 —— 未覆盖 / 部分覆盖里缺失的那半（补上覆盖就红）
// ---------------------------------------------------------------------------

describe('缺口（未覆盖 / 部分覆盖缺失的那半）：不得被悄悄补上而不更新本清单', () => {
  for (const gap of GAPS) {
    it(`[${gap.standard}] 缺口未覆盖：${gap.what}`, () => {
      const hits = suiteTitles().filter((title) => gap.titlePattern.test(title));
      expect(
        hits,
        `本项此前判定为"${gap.what}"**未覆盖**，但套件里出现了匹配 ${String(gap.titlePattern)} 的用例名：` +
          `${hits.join('；')}。\n若这是新补的覆盖 ⇒ 请把它移进 COVERAGE 表并更新缺口清单；` +
          '若是误判 ⇒ 请修正本表。\n明细：' +
          gap.detail,
      ).toEqual([]);
    });
  }
});
