/**
 * **V5 变异敏感性检验报告（task-id: D02A-V5）** —— 验收套件本身会不会说谎。
 *
 * ## 这份文件是什么
 *
 * 它**不测产品**，测的是**判据**：把被测行为按"一组定点变异"改坏，对应的验收用例是否**变红**。
 * "改了也不红"的判据就是**空断言**——那是本批最该修的东西。
 *
 * 实验**只在系统临时目录的副本里进行**（`node_modules` 以 junction 接入，实验结束已解除链接并
 * 删除副本）。仓库内**只新增本文件**；`src/**`、`tests/acceptance/office/**` 的其它文件一律未改。
 *
 * ## 结论摘要（2026-10-02）
 *
 * - **基线（未变异）**：`v1 / v2 / v3 / p1 / p3 / p6 / office-negative / office-reproducibility /
 *   w-disc-kernel-discipline` 共 **9 文件 136 用例全绿**——下面每一条"变红"都不是"本来就红"。
 * - **有判别力**：M1 / M2 / M3 / M4a / M5 / M6a / M8（含 M6c 对照）。逐条见 {@link MUTATION_MATRIX}。
 * - **空断言（改了也不红，3 条）**：M4b / M6b / M7，见 {@link EMPTY_ASSERTIONS} 与文件末尾的改进建议。
 * - 提示词提到的 `v4` 在本仓库**尚不存在**（`tests/acceptance/office/` 下只有 v1/v2/v3），
 *   因此"p3-shared-facts / v4 应红"的预期只测到 p3 一侧。
 *
 * ## 可复算的参数
 *
 * {@link MUTATION_MATRIX} 的每条 `recipe` 给出 `file` + `oldStr` + `newStr`：把 `file` 里**恰好
 * 出现一次**的 `oldStr` 原文替换为 `newStr`，即复现该变异。三条纪律：① 每条只改一处语义；
 * ② 替换前必须断言出现次数为 1（否则变异锚点漂移，结论作废）；③ 跑完立刻从副本还原。
 *
 * ## 本文件的纪律
 *
 * 断言只针对**这份报告自身的数据完整性**与**被变异文件仍然存在**，不针对 `src/**` 的当前字节——
 * 后者会被并发开发改动，把报告钉在源码文本上会制造假红。变异结论一旦需要重跑，按上面的
 * "可复算的参数"在**副本**里重做即可。
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// 仓库根（验收侧允许 node:fs —— 合同 R50.4 的豁免位置就是本目录）
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// ---------------------------------------------------------------------------
// 变异矩阵（结论 + 可复算参数）
// ---------------------------------------------------------------------------

/** 一条变异实验的记录。 */
export interface MutationRecord {
  /** 变异编号。 */
  readonly id: string;
  /** 一句话说明改了什么语义。 */
  readonly summary: string;
  /** 被改文件（仓库相对路径，正斜杠）。 */
  readonly file: string;
  /** 变异发生的位置（原始行号，副本取自本实验开始时的快照）。 */
  readonly location: string;
  /** 可复算参数：把 `oldStr`（恰好一处）换成 `newStr`。 */
  readonly oldStr: string;
  readonly newStr: string;
  /** 提示词/设计预期的"应变红"文件。 */
  readonly expectedRed: readonly string[];
  /** 实测是否出现红色用例。 */
  readonly observedRed: boolean;
  /** 实测的红色用例清单（原始输出摘要）。 */
  readonly observed: readonly string[];
  /** 该变异是否**真的**被验收套件判别（= observedRed 且非对照）。 */
  readonly discriminated: boolean;
  /** 备注 / 为什么绿（空断言时必填）。 */
  readonly note: string;
}

export const MUTATION_MATRIX: readonly MutationRecord[] = Object.freeze([
  Object.freeze({
    id: 'M1',
    summary: '去掉 ZIP 的确定性：DOS 时间取自运行环境（Date.now()），不再固定 0x0000',
    file: 'src/artifacts/ooxml/zip.ts',
    location: '本地文件头 DOS 时间写点；中央目录项 DOS 时间写点',
    oldStr: '    header.writeUInt16LE(ZIP_DOS_TIME, 10);',
    newStr: '    header.writeUInt16LE(Date.now() & 0xffff, 10);',
    expectedRed: ['v1-ooxml-templates', 'office-reproducibility'],
    observedRed: true,
    observed: [
      'v1 判据2（DOCX/XLSX/PPTX：两次 writeZip 逐字节相等 且 常量命中）全红——DOS 时间非 0',
      'v1 判据3（W-A / W-D1 / W-D2 / W-D3 / Python hashlib 复算）全红——golden sha256 全变',
      'v1 判据7（跨调用可复现）红',
      'office-reproducibility J8 字节相等红（spreadsheet）、J8 DOS 时间 0x0000 红',
      '合计 11 个用例红',
    ],
    discriminated: true,
    note: '中央目录项同一处（writeUInt16LE(ZIP_DOS_TIME, 12)）同步改为 Date.now()&0xffff；否则本地头与中央目录不一致。',
  }),
  Object.freeze({
    id: 'M2',
    summary: '让 XLSX 在"缺失事实"处写 0（unknown / not_applicable 也当 0）',
    file: 'src/artifacts/templates/xlsx.ts',
    location: 'readFactValue() 的不可用分支',
    oldStr: "  if ('kind' in value) {\n    return {\n      kind: 'unusable',\n      reason: value.kind === 'unknown' ? 'unknown_fact' : 'not_applicable_fact',\n    };\n  }",
    newStr: "  if ('kind' in value) {\n    return { kind: 'amount', amount: 0 };\n  }",
    expectedRed: ['p6-template-contracts', 'v1-ooxml-templates'],
    observedRed: true,
    observed: [
      'p6 J7-表格「未知事实 ⇒ 值单元格整格不存在，全文无 <v>0</v>」红',
      'p6 J7-表格「not_applicable 与被缺失的键同样留空」红',
      'v1 判据6b「未知事实 ⇒ 值单元格整格不写、全文无 <v>0</v>，合计也留空」红',
      'p3-shared-facts 保持绿（该场景在快照层就被 missing_fact 挡住，构建器根本收不到 unknown）',
    ],
    discriminated: true,
    note: '仅覆盖 unknown / not_applicable 分支；"快照里根本没有这个键"是另一条代码路径（buildXlsxTable 的 entry === undefined），本变异未触及，v1 判据6b 的第三条子断言因此不受影响。',
  }),
  Object.freeze({
    id: 'M3',
    summary: '让 DOCX 允许正文出现快照外的数字（移除构建期边界检查）',
    file: 'src/artifacts/templates/docx.ts',
    location: 'buildDocxTemplate() 内的 assertNoUntraceableNumbers 调用点',
    oldStr: "  assertNoUntraceableNumbers(lines.join('\\n'), snapshot);",
    newStr: '  void [lines, snapshot]; // MUTATION: 数字边界检查被移除',
    expectedRed: ['p6-template-contracts', 'v1-ooxml-templates'],
    observedRed: true,
    observed: [
      'p6 J7-文档「负例：正文出现快照外的数字 ⇒ 构建期拒绝」红',
      'v1 判据6a「正文里出现快照没有的数字 77 ⇒ 构建器抛错」红',
    ],
    discriminated: true,
    note: '只摘掉构建器调用点，检查器 untraceableDigitRuns 本身未动——因此两侧"检查器直测"断言仍绿，红的正是"构建期真的拒绝"这一条。',
  }),
  Object.freeze({
    id: 'M4a',
    summary: '让事实快照在缺事实时不再阻塞（isFactSnapshotUsable 恒真 ⇒ 照常产出）',
    file: 'src/facts/snapshot.ts',
    location: 'isFactSnapshotUsable() 函数体',
    oldStr: 'export function isFactSnapshotUsable(snapshot: FactSnapshot): boolean {\n  return snapshot.unusable.length === 0;\n}',
    newStr: 'export function isFactSnapshotUsable(snapshot: FactSnapshot): boolean {\n  return true; // MUTATION: 缺事实不再阻塞（照常产出）\n}',
    expectedRed: ['p3-shared-facts', 'v2-facts-independent'],
    observedRed: true,
    observed: [
      'p3 J5-a（unknown）/ J5-b（not_applicable）/ J5-c（未登记键）/ J5-d（只登记别的版本）四条全红',
      'v2 判据2「缺失不可退化成零：穷举四种情形」红',
    ],
    discriminated: true,
    note: '这是"缺事实照常产出"在**快照层**的可判别形式：产物被照常发布，J5 的"不产出产物 / 不产出零值产物"当场破功。',
  }),
  Object.freeze({
    id: 'M4b',
    summary: '让 stageArtifactInTransaction 在缺事实时照常产出一个产物（移除 missing_fact 阻塞）',
    file: 'src/artifacts/staging.ts',
    location: 'stageArtifactInTransaction() 的 !isFactSnapshotUsable 早退块 + sourceFactRefs 取值',
    oldStr: "  if (!isFactSnapshotUsable(snapshot)) {\n    // ② 缺失/未知 ⇒ 阻塞。**不产产物、不产零值产物**（R48.4）。\n    return {\n      ok: false,\n      kind: 'missing_fact',\n      detail: describeUnusableFacts(snapshot),\n      snapshot,\n    };\n  }",
    newStr: '  // MUTATION: 缺失不再阻塞（照常产出）',
    expectedRed: ['p3-shared-facts', 'v4（本仓库尚不存在）'],
    observedRed: false,
    observed: [
      'office-negative + p1-real-files + p3-shared-facts + v3 + p6-template-contracts 共 5 文件 65 用例**全绿**',
    ],
    discriminated: false,
    note:
      '**空断言**。变异是"活的"：配套探针（副本内临时用例，已删）直接调 stageArtifactInTransaction 并传一个未登记的 fact_key，' +
      '得到 ok=true / 存储新增 1 条 staged 记录；而未变异时同一调用返回 {ok:false, kind:"missing_fact"} 且零写入。' +
      '套件测不到的原因：p3-shared-facts 走的是 office-support.ts **夹具自建的事务 1**（buildFactSnapshotFor），' +
      '不是内核的 staging 入口；office-negative / p1 只在**事实齐备**时调用 stageArtifactInTransaction。' +
      '（第二处配套改动：sourceFactRefs 在 usable 为空时回退为一个占位 ref，否则 createArtifactRecord 会先抛。顺带实测：只移除早退块、不改 sourceFactRefs 时，staging 会抛 PersistenceError 掀翻调用方事务——同样没有被套件发现。）',
  }),
  Object.freeze({
    id: 'M5',
    summary: '让 publish 的版本闸门失效（不比较 task revision）',
    file: 'src/artifacts/publish.ts',
    location: 'ArtifactPublicationProjection.reconcileOne() 段2 的版本比较分支',
    oldStr: '    } else if (currentRevision !== record.task_revision) {',
    newStr: '    } else if (false) { // MUTATION: 版本闸门失效（不比较 revision）',
    expectedRed: ['office-negative (J9)', 'v3-publish-independent'],
    observedRed: true,
    observed: [
      'office-negative J9「记录绑 r1、任务已到 r2 ⇒ superseded，无回执、无文件、端口零调用」红（端口被调 3 次）',
      'v3 §版本闸门 三条红（端口零调用 / 终态 superseded / superseded 守卫留痕）',
    ],
    discriminated: true,
    note: '值得注意：终态仍是 superseded（因为验收侧端口自己也有版本闸门兜底），红的落点是"端口零调用"这条——它才是把闸门钉在**投影**里的那条判据。',
  }),
  Object.freeze({
    id: 'M6a',
    summary: '让 publish 自造回执：内容摘要 / 回读摘要改用计划里的期望摘要，而不是端口回读值',
    file: 'src/artifacts/publish.ts',
    location: 'publishedRecordOf() 的 content_digest 与 receipt.readback_digest 两个赋值点',
    oldStr: '    content_digest: receipt.readback_digest,',
    newStr: '    content_digest: fact.request.expected_content_digest,',
    expectedRed: ['v3-publish-independent (I-1)'],
    observedRed: true,
    observed: [
      'v3 I-1「正向：内容摘要取端口回读值，而不是计划里的期望摘要」红',
      'v3 I-1「自造反例：端口报成功但回执缺/空回读摘要 ⇒ 记录不得成为 published」红',
      'v3 §回执「源码级：publish.ts 里的 readback_digest 只来自端口回执」红',
    ],
    discriminated: true,
    note: '配套第二处：receipt.readback_digest 也改为 fact.request.expected_content_digest，否则记录里两个摘要自相矛盾反而会被 content_digest===receipt.readback_digest 先抓住。office-reproducibility 不受影响——它不经发布投影，直接调端口。',
  }),
  Object.freeze({
    id: 'M6b',
    summary: '让物化端口不回读，直接把期望摘要当回读摘要',
    file: 'tests/acceptance/office/fs-artifact-port.ts',
    location: '成功路径第 4 步：对最终路径回读并重算摘要处',
    oldStr: '    const readbackDigest = sha256Hex(readBack);',
    newStr: '    const readbackDigest = request.expected_content_digest; // MUTATION: 不回读，直接拿期望摘要当回读摘要',
    expectedRed: ['v3-publish-independent', 'office-reproducibility'],
    observedRed: false,
    observed: [
      'office-reproducibility + office-negative + p1-real-files 共 3 文件 26 用例**全绿**',
      'v3 本来就不受影响：v3 用自己用例内的 RecordingPort（回执就地自造），它的 I-1 敏感性落在 publish.ts（见 M6a）',
    ],
    discriminated: false,
    note:
      '**空断言 / 判据盲区**。J8-I1 的三方对齐是 sha256(落盘) == 记录 content_digest == receipt.readback_digest，' +
      '而端口写进 final_path 的正是 payload（== 期望字节）——"照抄期望摘要"天然满足三方相等，无需真的回读。' +
      '对照 M6c 证明该断言不是恒真：端口改成报一个**错**的摘要在同一用例上立刻变红。' +
      '所以 J8 能抓"报了假摘要的端口"，抓不住"根本没回读的端口"。',
  }),
  Object.freeze({
    id: 'M6c',
    summary: '【对照】端口报一个错误的回读摘要（留在原地的自检应当抓住）',
    file: 'tests/acceptance/office/fs-artifact-port.ts',
    location: '同 M6b 的一行',
    oldStr: '    const readbackDigest = sha256Hex(readBack);',
    newStr: "    const readbackDigest = 'not-a-real-readback-digest';",
    expectedRed: ['office-reproducibility (J8-I1)'],
    observedRed: true,
    observed: ['office-reproducibility J8-I1 红 1 条；该文件其余 3 条仍绿'],
    discriminated: true,
    note: '这是 M6b 的对照臂：证明 J8-I1 这一条断言**非空洞**，只是对"跳过回读"这一形态无鉴别力。',
  }),
  Object.freeze({
    id: 'M7',
    summary: '让 source_fact_refs 允许为空（移除构造期不变量）',
    file: 'src/protocol/artifact.ts',
    location: 'createArtifactRecord() 的 source_fact_refs 非空校验块',
    oldStr: "  if (sourceFactRefs.length === 0) {\n    throw new ValidationError(\n      'ArtifactRecord.source_fact_refs 不能为空：产物必须能追溯到它所依据的共享事实（P3 的机器判据）',\n    );\n  }",
    newStr: '  // MUTATION: 允许空的 source_fact_refs',
    expectedRed: ['p3-shared-facts', 'v2-facts-independent'],
    observedRed: false,
    observed: [
      'v2 + p3-shared-facts + v3 + office-negative + p1-real-files 共 5 文件 86 用例**全绿**',
    ],
    discriminated: false,
    note:
      '**空断言**。验收套件里对 source_fact_refs 只有**正向**断言（toContain / not.toContain），没有任何"空 ⇒ 抛"的独立反例；' +
      '覆盖该不变量的只有实现者自己的单测 src/protocol/artifact.test.ts（W-B 自测，不属独立验收）。' +
      'v2-facts-independent 全篇不构造 ArtifactRecord，所以"应红"的预期本就不成立。',
  }),
  Object.freeze({
    id: 'M8',
    summary: '让 OPC 部件的字节顺序不再由声明顺序决定，改由路径排序推导',
    file: 'src/artifacts/ooxml/opc.ts',
    location: 'assembleOpcPackage() 组装 entries 的数组字面量末尾',
    oldStr: '    ...nestedRelsParts.map((part) => ({ path: part.path, data: part.bytes })),\n  ];',
    newStr: '    ...nestedRelsParts.map((part) => ({ path: part.path, data: part.bytes })),\n  ].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)); // MUTATION: 顺序由路径排序推导',
    expectedRed: ['v1-ooxml-templates（判据3 / 判据8）'],
    observedRed: true,
    observed: [
      'v1 判据8「DOCX/XLSX/PPTX 的部件清单与内容类型覆盖一致，关键文本可回读」红（XLSX 声明顺序被打乱）',
      'v1 判据3（W-D2 / W-D3 / Python hashlib 复算）红——golden 摘要钉住了顺序',
      'office-reproducibility 保持绿：J8 只比"两次运行之间结构一致"，不钉**声明顺序**（该口径由 v1 判据8 覆盖）',
    ],
    discriminated: true,
    note: '这是"条目顺序不得由对象键序/排序推导"（R51.3）的可判别形式；p3 / p6 对顺序变化不敏感（它们只读内容）。',
  }),
]);

// ---------------------------------------------------------------------------
// 空断言清单（本批最该修的东西）
// ---------------------------------------------------------------------------

/** 一条"改了也不红"的判据缺口 + 建议。 */
export interface EmptyAssertion {
  /** 对应的变异编号。 */
  readonly mutationId: string;
  /** 判据来源（合同条款 / 任务书条款）。 */
  readonly criterion: string;
  /** 哪条判据/哪个文件改了也不红。 */
  readonly blind: string;
  /** 实测证据。 */
  readonly evidence: string;
  /** 建议怎么改（它本该断言什么）。 */
  readonly suggestion: string;
}

export const EMPTY_ASSERTIONS: readonly EmptyAssertion[] = Object.freeze([
  Object.freeze({
    mutationId: 'M4b',
    criterion: '合同 v1.4 R48.4 / R56.1（stageArtifactInTransaction：缺事实 ⇒ 结构化失败、不写任何记录、不产零值产物）',
    blind: '无任何验收用例以"缺事实"驱动内核的 stage 入口（tests/acceptance/office/office-negative.test.ts 是唯一调用 stageArtifactInTransaction 的验收文件，两处调用都喂齐备事实）',
    evidence: '移除早退块后 5 个验收文件 65 用例全绿；副本内探针确认行为已从 {ok:false, missing_fact} 变为 ok=true 且写入 1 条 staged 记录',
    suggestion:
      '在 v4（或 p3 增补）里加两条：(1) 以未登记的 fact_key 调 stageArtifactInTransaction ⇒ expect(ok).toBe(false) && kind === "missing_fact" && 事务内 putArtifact 次数为 0 && 存储里该 artifact_id 查不到；(2) 以 unknown / not_applicable 事实重复同一条。' +
      '注意：不可用键的 fact_ref 为 null 时，缺省的 sourceFactRefs 为空，记录会先被构造期不变量拦下——用例应同时断言"抛在事务内"这一形态，或断言调用方拿到的结构化失败（不要让它以 PersistenceError 逃逸）。',
  }),
  Object.freeze({
    mutationId: 'M6b',
    criterion: '合同 v1.4 R49.2 I-1 / R50.3（回执摘要必须来自对最终路径的实际回读）',
    blind: 'office-reproducibility 的 J8-I1 三方对齐（sha256(落盘) == 记录 content_digest == receipt.readback_digest）在"端口照抄期望摘要"时恒真',
    evidence: '端口 readbackDigest 改为 request.expected_content_digest 后，office-reproducibility + office-negative + p1 共 26 用例全绿；改成报一个错的摘要（M6c）则同一断言立刻红',
    suggestion:
      '加一条**可判别**的用例：直接调 createFsArtifactMaterializationPort，传正确的 payload（合法 ZIP 字节）但传一个**故意错的** expected_content_digest。' +
      '真正回读的端口会得到 sha256(写出的字节) ≠ 期望 ⇒ 必须返回 {ok:false, kind:"self_check_failed"}；照抄期望的端口会返回 ok=true。' +
      '断言 expect(result.ok).toBe(false) 即把"必须实际回读"变成可证伪（现有用例因为 payload 与期望同源，永远分不开这两种端口）。',
  }),
  Object.freeze({
    mutationId: 'M7',
    criterion: '合同 v1.4 R47.4（source_fact_refs 为空 ⇒ 抛，构造期不变量，不得降级为运行期警告）',
    blind: '验收套件（v2 / p3 / v3 / negative / p1）对 source_fact_refs 只有正向断言；唯一覆盖"空 ⇒ 抛"的是实现者自测 src/protocol/artifact.test.ts',
    evidence: '移除该校验块后 5 个验收文件 86 用例全绿',
    suggestion:
      '在 v2（事实层独立验收，最贴近该不变量）加一条独立反例：expect(() => createArtifactRecord({ ...base, source_fact_refs: [] })).toThrow(ValidationError)；' +
      '并补一条**端到端形态**：缺事实且一条来源都指认不到时，夹具不得写出任何记录（p3 J5-c 已间接覆盖夹具侧，但未覆盖构造期不变量本身）。',
  }),
]);

// ---------------------------------------------------------------------------
// 本文件的自洽性断言（报告数据完整性 + 被变异文件仍存在）
// ---------------------------------------------------------------------------

describe('V5 报告自洽性：变异矩阵完整、字段齐备、可复算参数不缺失', () => {
  it('至少覆盖提示词点名的 7 组变异（外加自增补的 M4a / M6a / M6c / M8）', () => {
    const ids = MUTATION_MATRIX.map((record) => record.id);
    for (const required of ['M1', 'M2', 'M3', 'M4a', 'M4b', 'M5', 'M6a', 'M6b', 'M7']) {
      expect(ids, `缺少变异 ${required}`).toContain(required);
    }
    expect(ids.length).toBeGreaterThanOrEqual(9);
  });

  it('每条记录都有非空的 file / location / oldStr / newStr / expectedRed / observed / note', () => {
    for (const record of MUTATION_MATRIX) {
      expect(record.summary.length, record.id).toBeGreaterThan(0);
      expect(record.file.length, record.id).toBeGreaterThan(0);
      expect(record.location.length, record.id).toBeGreaterThan(0);
      expect(record.oldStr.length, record.id).toBeGreaterThan(0);
      expect(record.newStr.length, record.id).toBeGreaterThan(0);
      expect(record.oldStr, `${record.id}：newStr 必须与 oldStr 不同`).not.toBe(record.newStr);
      expect(record.expectedRed.length, record.id).toBeGreaterThan(0);
      expect(record.observed.length, record.id).toBeGreaterThan(0);
      expect(record.note.length, record.id).toBeGreaterThan(0);
    }
  });

  it('"改了也不红"的记录必须如实标注 discriminated=false，且同时出现在空断言清单里', () => {
    const notDiscriminated = MUTATION_MATRIX.filter((record) => !record.discriminated);
    // 对照组（M6c）是"应当被抓住"的臂，不属空断言。
    const nonControl = notDiscriminated.filter((record) => record.id !== 'M6c');
    expect(nonControl.map((record) => record.id).sort()).toEqual(['M4b', 'M6b', 'M7']);
    for (const record of nonControl) {
      expect(record.observedRed, `${record.id}：未判别 ⇒ observedRed 必须为 false`).toBe(false);
      expect(
        EMPTY_ASSERTIONS.some((entry) => entry.mutationId === record.id),
        `${record.id} 未写进空断言清单`,
      ).toBe(true);
    }
  });

  it('被变异文件在仓库里都还存在（锚点未因改名 / 移动而失效）', () => {
    const files = [...new Set(MUTATION_MATRIX.map((record) => record.file))].sort();
    for (const file of files) {
      expect(existsSync(join(REPO_ROOT, file)), `被变异文件不存在：${file}`).toBe(true);
    }
    if (process.env['V5_REPORT_VERBOSE'] === '1') {
      console.log('[D02A-V5] 变异锚点文件', JSON.stringify(files));
    }
  });

  it('空断言清单每条都给出判据来源 + 实测证据 + 改进建议', () => {
    expect(EMPTY_ASSERTIONS.length).toBe(3);
    for (const entry of EMPTY_ASSERTIONS) {
      expect(entry.criterion.length).toBeGreaterThan(0);
      expect(entry.blind.length).toBeGreaterThan(0);
      expect(entry.evidence.length).toBeGreaterThan(0);
      expect(entry.suggestion.length).toBeGreaterThan(0);
    }
  });
});
