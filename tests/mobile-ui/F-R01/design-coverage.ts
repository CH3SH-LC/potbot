/**
 * F-R01 —— 最新设计逐页视觉对照 / 缺页清单（纯函数、零第三方依赖）。
 *
 * 目标（FRONTEND.md 备用包表 F-R01）：把「设计要求的页面清单」与「原型/实现里
 * 真正存在的东西」逐页比一遍，产出**缺页清单**与**截图覆盖差异**，而不是再画一套页面。
 *
 * 设计权威来源（解析，不硬编码）：
 *   - design-07 §2 页面地图表 → 28 个页面 ID 及其标题。
 * 对照对象（解析，不硬编码）：
 *   - `docs/design/release-ui/potbot-release.html`：`const screens={…}` 注册表、
 *     `function <name>(` 定义、点击分派里的 `case '<act>':` 处理器。
 *   - `docs/design/release-ui/prototype-checks.json`：记录的原型/品牌 SHA-256、
 *     视觉走查页面集合与历史截图说明。
 *
 * **本模块不产像素差异**：没有真实浏览器 / 真机，就没有真实截图可比。它做的是
 * 清单级与完整性级对照（设计页 ↔ 原型屏 ↔ 截图记录 ↔ 文件哈希）。真实像素/真机
 * 视觉差异必须在具备浏览器与设备的环节补做，本模块显式不宣称。
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 页面地图的四个分组：C 对话 / T 群组 · 任务 / F 文件 / M 我的。 */
export type DesignPageGroup = 'C' | 'T' | 'F' | 'M';

/** 从 design-07 §2 页面地图表解析出的一行。 */
export interface DesignPage {
  /** 页面 ID，如 `C01`、`M10`。 */
  readonly id: string;
  readonly group: DesignPageGroup;
  /** 页面标题，如 `对话主列表`。 */
  readonly title: string;
  /** 表格第二列「内容与主要动作」原文。 */
  readonly content: string;
  /** 表格第三列「返回目标」原文。 */
  readonly returnTarget: string;
  /** 1 起的原文行号。 */
  readonly line: number;
}

/** 原型里对某个设计页面的承载级别。 */
export type CoverageLevel =
  /** 有独立可导航屏幕承载。 */
  | 'screen'
  /** 没有独立屏幕，但作为另一屏的一段内容渲染（内嵌）。 */
  | 'embedded'
  /** 只以说明/操作弹层（sheet）出现，不是页面。见 design-07 §14：弹窗不是实现证据。 */
  | 'sheet'
  /** 原型里完全找不到承载。 */
  | 'absent';

/** 设计页 → 原型承载 的声明式映射；每条自带 basis 以便人工复核。 */
export interface CoverageMapping {
  readonly pageId: string;
  readonly level: CoverageLevel;
  /** level 为 screen/embedded 时，指向原型屏幕注册表键；否则为空。 */
  readonly screens: readonly string[];
  /** level 为 sheet 时，指向点击分派里的 `case '<act>'`；否则为空。 */
  readonly sheetActs: readonly string[];
  /** 该判定在原型里的依据（函数名 / 弹层标题 / DOM 结构），供人工核对。 */
  readonly basis: string;
}

/** 解析 `potbot-release.html` 得到的事实。 */
export interface PrototypeFacts {
  /** `const screens={…}` 的键（页面 id），保持声明顺序。 */
  readonly registry: readonly string[];
  /** registry 键 → 实际函数名（如 templates → templateList）。 */
  readonly aliases: Readonly<Record<string, string>>;
  /** 文件里 `function <name>(` 定义的所有函数名。 */
  readonly functionNames: readonly string[];
  /** 点击分派 `case '<act>':` 里的所有动作名。 */
  readonly sheetActs: readonly string[];
  /** 页面标题表 `const titles={…}` 的键。 */
  readonly titledPages: readonly string[];
}

/** `prototype-checks.json` 里与视觉/截图相关的事实。 */
export interface PrototypeChecksFacts {
  readonly prototypeSha256: string;
  readonly brandSha256: string | null;
  /** 视觉走查过的页面/场景 id。 */
  readonly reviewed: readonly string[];
  /** 历史截图文件名（preview-*.png 等）。 */
  readonly savedScreenshotFiles: readonly string[];
  /** savedPngs 字段的原文说明（用于判定「历史 v5、非 v6 证据」）。 */
  readonly savedPngsNote: string;
  readonly designRevision: string;
}

export interface FileHashFact {
  readonly path: string;
  readonly expected: string | null;
  readonly actual: string | null;
  readonly match: boolean;
  /**
   * 是否存在可对照的 SHA-256 基线：
   *   - `recorded`   —— 有基线（如 prototype-checks.json 记录的 prototypeSha256），`match` 有意义；
   *   - `unrecorded` —— 无基线（如 design-07 正文没有哈希记录），`match` 恒 false，
   *                     仅钉住当前实际哈希，**不算漂移**。
   * 缺省视为 `recorded`（历史构造未带此字段）。
   */
  readonly baseline?: 'recorded' | 'unrecorded';
  /** 供人工复核的说明（基线来源 / 为何无基线）。 */
  readonly note?: string;
}

/** 一页的对照结果。 */
export interface PageCoverageRow {
  readonly pageId: string;
  readonly title: string;
  readonly level: CoverageLevel;
  readonly screens: readonly string[];
  readonly sheetActs: readonly string[];
  readonly basis: string;
  /** 该设计页是否有对应的已保存 v6 截图（文件名级）。 */
  readonly hasV6Screenshot: boolean;
}

export interface CoverageReport {
  readonly designPageCount: number;
  readonly prototypeScreenCount: number;
  readonly rows: readonly PageCoverageRow[];
  /** 有独立屏幕的页面 ID。 */
  readonly dedicatedScreenPages: readonly string[];
  /** 只在弹层里出现的页面 ID（不是页面）。 */
  readonly sheetOnlyPages: readonly string[];
  /** 只内嵌在别屏里的页面 ID。 */
  readonly embeddedPages: readonly string[];
  /** 完全找不到承载的页面 ID。 */
  readonly absentPages: readonly string[];
  /** 缺页清单 = absent ∪ sheetOnly ∪ embedded（无独立可导航屏幕者）。 */
  readonly missingPages: readonly string[];
  /** 原型屏幕里未被任何设计页映射到的键（反向缺口）。 */
  readonly prototypeOnlyScreens: readonly string[];
  /** 已声明的映射里指向不存在屏幕/动作的坏条目（应为空）。 */
  readonly danglingReferences: readonly string[];
  readonly hashes: readonly FileHashFact[];
  /** 视觉走查集合里不是注册屏幕的场景 id（如 offline-new-chat）。 */
  readonly reviewedScenarios: readonly string[];
  readonly reviewedUnknown: readonly string[];
  /**
   * shell（F-I02 / F-UI01）声明的 28 屏与设计页的逐页对照清单；
   * 调用方未提供 shell 屏事实时为 null。
   */
  readonly shellInventory: ShellInventory | null;
}

// ---------------------------------------------------------------------------
// 解析：design-07 §2 页面地图
// ---------------------------------------------------------------------------

const PAGE_ROW_RE = /^\|\s*([CTFM]\d{2})\s+(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*$/;

/**
 * 解析 design-07 §2「页面 ID / 层级 | 内容与主要动作 | 返回目标」表。
 * 只认 `| <ID> <标题> | … | … |` 这种四段行，正文里的行内引用不会被误判。
 */
export function parseDesignPageMap(lines: readonly string[]): readonly DesignPage[] {
  const pages: DesignPage[] = [];
  lines.forEach((text, index) => {
    const m = PAGE_ROW_RE.exec(text);
    if (m === null) return;
    const [, id, title, content, returnTarget] = m;
    if (id === undefined || title === undefined || content === undefined || returnTarget === undefined) return;
    pages.push({
      id,
      group: id[0] as DesignPageGroup,
      title,
      content,
      returnTarget,
      line: index + 1,
    });
  });
  return pages;
}

// ---------------------------------------------------------------------------
// 解析：原型 HTML
// ---------------------------------------------------------------------------

/** 从 `const screens={home,chat,templates:templateList,…}` 抽出键与别名。 */
function parseScreenRegistry(html: string): { registry: string[]; aliases: Record<string, string> } {
  const m = /const screens=\{([^}]*)\}/.exec(html);
  if (m === null || m[1] === undefined) return { registry: [], aliases: {} };
  const registry: string[] = [];
  const aliases: Record<string, string> = {};
  for (const raw of m[1].split(',')) {
    const token = raw.trim();
    if (token.length === 0) continue;
    const [key, value] = token.split(':');
    const k = key?.trim();
    if (k === undefined || k.length === 0) continue;
    registry.push(k);
    aliases[k] = (value?.trim() ?? k);
  }
  return { registry, aliases };
}

/** 从 `case '<act>':` 抽出所有点击分派动作名。 */
function parseSheetActs(html: string): readonly string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/case '([a-z][a-z0-9-]*)':/g)) {
    const act = m[1];
    if (act !== undefined && !out.includes(act)) out.push(act);
  }
  return out;
}

/** 从 `function <name>(` 抽出所有顶层函数名。 */
function parseFunctionNames(html: string): readonly string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[1];
    if (name !== undefined && !out.includes(name)) out.push(name);
  }
  return out;
}

/** 从 `const titles={history:'全部对话',…}` 抽出被命名标题的页面键。 */
function parseTitledPages(html: string): readonly string[] {
  const m = /const titles=\{([^}]*)\}/.exec(html);
  if (m === null || m[1] === undefined) return [];
  const out: string[] = [];
  for (const raw of m[1].split(',')) {
    const k = raw.split(':')[0]?.trim();
    if (k !== undefined && /^[a-z][a-z0-9-]*$/.test(k)) out.push(k);
  }
  return out;
}

export function parsePrototypeFacts(html: string): PrototypeFacts {
  const { registry, aliases } = parseScreenRegistry(html);
  return {
    registry,
    aliases,
    functionNames: parseFunctionNames(html),
    sheetActs: parseSheetActs(html),
    titledPages: parseTitledPages(html),
  };
}

// ---------------------------------------------------------------------------
// 解析：prototype-checks.json
// ---------------------------------------------------------------------------

interface RawChecks {
  readonly prototypeSha256?: unknown;
  readonly designRevision?: unknown;
  readonly visualReview?: {
    readonly reviewed?: unknown;
    readonly savedPngs?: unknown;
    readonly brandOriginalSha256?: unknown;
  };
}

function asStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

export function parsePrototypeChecks(raw: unknown): PrototypeChecksFacts {
  const c = (raw ?? {}) as RawChecks;
  const vr = c.visualReview ?? {};
  const savedPngsNote = typeof vr.savedPngs === 'string' ? vr.savedPngs : '';
  // 记录里可能写 glob（如 `preview-*.png`）——保留通配符，由调用方对目录展开。
  const savedScreenshotFiles = [...savedPngsNote.matchAll(/([A-Za-z0-9_*-]+\.png)/g)]
    .map((m) => m[1])
    .filter((v): v is string => v !== undefined);
  return {
    prototypeSha256: typeof c.prototypeSha256 === 'string' ? c.prototypeSha256 : '',
    brandSha256: typeof vr.brandOriginalSha256 === 'string' ? vr.brandOriginalSha256 : null,
    reviewed: asStringArray(vr.reviewed),
    savedScreenshotFiles,
    savedPngsNote,
    designRevision: typeof c.designRevision === 'string' ? c.designRevision : '',
  };
}

// ---------------------------------------------------------------------------
// 声明式映射：设计页 → 原型承载
//
// 每条的 basis 都是原型里的可核对事实（函数、case 动作或 DOM 片段）。
// 判定规则：
//   screen   = `const screens` 里有独立键；
//   embedded = 渲染在另一屏内部的段落（如群组详情里的「进展」时间线）；
//   sheet    = 仅 `<act>` 弹层，design-07 §14 明确「弹窗不是实现证据」；
//   absent   = 找不到承载。
// ---------------------------------------------------------------------------

export const COVERAGE_MAPPING: readonly CoverageMapping[] = [
  // C —— 对话
  { pageId: 'C01', level: 'screen', screens: ['home', 'chat'], sheetActs: [], basis: 'home() 首页近期成果；chat() 连续消息主屏' },
  { pageId: 'C02', level: 'screen', screens: ['history'], sheetActs: [], basis: 'history()/historyResults() 全部对话列表与搜索' },
  { pageId: 'C03', level: 'absent', screens: [], sheetActs: [], basis: '原型只有列表级搜索（groups/history/files），无对话内关键字/日期/文件命中页' },
  { pageId: 'C04', level: 'sheet', screens: [], sheetActs: ['attach'], basis: "case 'attach' → sheet('添加附件')，仅示例附件，无解析状态/系统分享" },
  { pageId: 'C05', level: 'sheet', screens: [], sheetActs: ['sources'], basis: "case 'sources' → sheet('来源与依据')" },
  // T —— 群组 / 任务
  { pageId: 'T01', level: 'screen', screens: ['groups'], sheetActs: [], basis: 'groups() 群组列表 + 待处理/进行中/已结束 筛选' },
  { pageId: 'T02', level: 'screen', screens: ['group'], sheetActs: [], basis: 'group() 群组详情：状态、成员、文件、动作卡、进展' },
  { pageId: 'T03', level: 'absent', screens: [], sheetActs: [], basis: "改条件走 chat 内 'change-people' 内联动作，无独立改任务页" },
  { pageId: 'T04', level: 'sheet', screens: [], sheetActs: ['calendar-review'], basis: "case 'calendar-review' → sheet('确认日历安排')，含操作/标题/日期" },
  { pageId: 'T05', level: 'absent', screens: [], sheetActs: [], basis: '无候选比较页/无 compare 候选页（file 的 compare 是版本比较，非候选）' },
  { pageId: 'T06', level: 'absent', screens: [], sheetActs: [], basis: '无日程详情页；日历仅出现在动作弹层与群组详情的日程摘要' },
  { pageId: 'T07', level: 'sheet', screens: [], sheetActs: ['clock-info'], basis: "case 'clock-info' → sheet('提醒权限')，仅权限说明，无计时器/秒表/世界时钟" },
  { pageId: 'T08', level: 'embedded', screens: ['group'], sheetActs: [], basis: "group() 内嵌 <ol class=\"pb-timeline\">「进展」时间线，非独立页" },
  // F —— 文件
  { pageId: 'F01', level: 'screen', screens: ['files'], sheetActs: [], basis: 'files()/fileResults() 文件列表 + 格式筛选' },
  { pageId: 'F02', level: 'screen', screens: ['file'], sheetActs: [], basis: "file() 预览 tab（filePreview：文档/表格/演示示例）" },
  { pageId: 'F03', level: 'screen', screens: ['file'], sheetActs: [], basis: "file() 版本 tab（versions/restore）+ case 'compare' 版本比较弹层" },
  { pageId: 'F04', level: 'sheet', screens: [], sheetActs: ['handoff'], basis: "case 'handoff' → sheet('打开 / 分享')，明示未生成真实文件" },
  { pageId: 'F05', level: 'absent', screens: [], sheetActs: [], basis: "files() 的「导入文件」复用 act 'attach' 弹层，无导入检查页（格式/权限/保留限制）" },
  // M —— 我的
  { pageId: 'M01', level: 'screen', screens: ['me'], sheetActs: [], basis: 'me() 我的空间 + 模版/记忆/连接与权限/设置菜单' },
  { pageId: 'M02', level: 'screen', screens: ['memory'], sheetActs: [], basis: 'memory() 单条偏好呈现（列表与详情合并）' },
  { pageId: 'M03', level: 'embedded', screens: ['memory'], sheetActs: [], basis: 'memory() 内嵌来源/状态/范围/编辑（编辑走 edit-memory 弹层），非独立详情页' },
  { pageId: 'M04', level: 'sheet', screens: [], sheetActs: ['forget-memory'], basis: "case 'forget-memory' → sheet('忘记这条偏好？')，无索引/摘要/派生经验范围页" },
  { pageId: 'M05', level: 'screen', screens: ['templates'], sheetActs: [], basis: 'templateList() 七模板目录（templates 键别名）' },
  { pageId: 'M06', level: 'screen', screens: ['template'], sheetActs: [], basis: 'template() 模版详情：启用状态/连接/版本/访问范围' },
  { pageId: 'M07', level: 'screen', screens: ['permissions'], sheetActs: [], basis: 'permissions() 连接与按需授权（日历/美团）' },
  { pageId: 'M08', level: 'sheet', screens: [], sheetActs: ['storage'], basis: "case 'storage' → sheet('额度与存储')" },
  { pageId: 'M09', level: 'sheet', screens: [], sheetActs: ['notifications'], basis: "case 'notifications' → sheet('任务通知')" },
  { pageId: 'M10', level: 'absent', screens: [], sheetActs: [], basis: '设置页只有通知/显示/额度，无应用信息（版本/更新/迁移/脱敏诊断）页' },
];

// ---------------------------------------------------------------------------
// shell 声明清单（F-I02 / F-UI01 「壳 + 导航注册表」）
//
// 原型（potbot-release.html）只有 13 个注册屏，所以上一批的缺页清单是「原型缺页」。
// 本轮 F-I02 交付了 shell 的**唯一导航注册表**：`SCREEN_DEFS` 逐条声明了 design-07 §2
// 的全部 28 个页面 id（含 entry / route / designLevel），`MODULE_SCREENS` 给出模块归属。
// 因此「16 缺页 + 8 仅弹层」不再是「无人认领」——它们在 shell 里**都有** id、模块、
// 入口与可导航 route。本段把这份 shell 声明变成**可断言清单**，并逐页核对：
//   shell 的 `designLevel` 必须与 F-R01 从原型判出的承载级别**逐页一致**；
//   设计页地图与 shell 声明必须**互为子集**（不能多也不能少）。
//
// 注意：shell 声明「有 route」只表示导航可达，**不等于**该页已实现或已真机验证——
// 层级语义仍以设计-07 §14 为准（弹窗不是实现证据）。本段不宣称实现完成。
// ---------------------------------------------------------------------------

/** 从 shell 的 `SCREEN_DEFS`（+ `MODULE_SCREENS` 模块归属）取来的屏事实。 */
export interface ShellScreenFact {
  readonly id: string;
  readonly entry: string;
  readonly route: string;
  readonly title: string;
  /** shell 自报的原型承载层级（应 = F-R01 判定的 level）。 */
  readonly designLevel: CoverageLevel;
  /** 拥有该屏的 shell 模块（来自 `MODULE_SCREENS`）；未登记为 null。 */
  readonly module: string | null;
}

/** shell 声明 vs 设计页 的逐页对照行。 */
export interface ShellPageRow {
  readonly pageId: string;
  readonly title: string;
  /** F-R01 从原型判出的承载级别。 */
  readonly fr01Level: CoverageLevel;
  /** shell 自报的 designLevel；shell 未声明该 id 时为 null。 */
  readonly shellLevel: CoverageLevel | null;
  readonly shellDeclared: boolean;
  readonly module: string | null;
  readonly entry: string | null;
  readonly route: string | null;
  /** F-R01 层级与 shell designLevel 一致。 */
  readonly agrees: boolean;
}

export interface ShellInventory {
  readonly designPageCount: number;
  readonly shellScreenCount: number;
  /** shell 声明的屏幕 id（规范顺序）。 */
  readonly shellScreenIds: readonly string[];
  /** 设计页 → shell 声明 的逐页对照（按设计页地图顺序，28 行）。 */
  readonly rows: readonly ShellPageRow[];
  /** 设计页地图里有、shell 未声明（应为空）。 */
  readonly designPagesMissingFromShell: readonly string[];
  /** shell 声明了、不在设计页地图里（应为空）。 */
  readonly shellPagesNotInDesign: readonly string[];
  /** F-R01 层级 ≠ shell designLevel 的页 id（应为空）。 */
  readonly levelDisagreements: readonly string[];
  /** 16 缺页清单（absent ∪ sheet ∪ embedded）在 shell 里的登记行。 */
  readonly missingPageRows: readonly ShellPageRow[];
  /** 8 仅弹层页在 shell 里的登记行。 */
  readonly sheetOnlyRows: readonly ShellPageRow[];
  /** 缺页清单中 shell 已给可导航 route 的数量（应 = 缺页数）。 */
  readonly missingPagesWithRoute: number;
  /** 仅弹层页中 shell 已给可导航 route 的数量（应 = 仅弹层数）。 */
  readonly sheetOnlyPagesWithRoute: number;
}

export interface ShellInventoryInput {
  readonly designPages: readonly DesignPage[];
  /** `buildCoverageReport` 产出的逐页行（提供 F-R01 层级与标题）。 */
  readonly rows: readonly PageCoverageRow[];
  readonly shellScreens: readonly ShellScreenFact[];
  readonly missingPages: readonly string[];
  readonly sheetOnlyPages: readonly string[];
}

function hasRoute(row: ShellPageRow): boolean {
  return typeof row.route === 'string' && row.route.length > 0;
}

/** 把 shell 声明与设计页/缺页清单逐页对照，产出可断言清单。 */
export function buildShellInventory(input: ShellInventoryInput): ShellInventory {
  const shellById = new Map(input.shellScreens.map((s) => [s.id, s]));
  const coverageById = new Map(input.rows.map((r) => [r.pageId, r]));
  const designIds = input.designPages.map((p) => p.id);
  const shellIds = input.shellScreens.map((s) => s.id);

  const rows: ShellPageRow[] = designIds.map((id) => {
    const coverage = coverageById.get(id);
    const fr01Level: CoverageLevel = coverage?.level ?? 'absent';
    const shell = shellById.get(id);
    const shellLevel: CoverageLevel | null = shell?.designLevel ?? null;
    return {
      pageId: id,
      title: coverage?.title ?? shell?.title ?? '',
      fr01Level,
      shellLevel,
      shellDeclared: shell !== undefined,
      module: shell?.module ?? null,
      entry: shell?.entry ?? null,
      route: shell?.route ?? null,
      agrees: shellLevel !== null && shellLevel === fr01Level,
    };
  });

  const designSet = new Set(designIds);
  const rowById = new Map(rows.map((r) => [r.pageId, r]));
  const pick = (ids: readonly string[]): readonly ShellPageRow[] =>
    ids.map((id) => rowById.get(id)).filter((r): r is ShellPageRow => r !== undefined);

  const missingPageRows = pick(input.missingPages);
  const sheetOnlyRows = pick(input.sheetOnlyPages);

  return {
    designPageCount: designIds.length,
    shellScreenCount: input.shellScreens.length,
    shellScreenIds: shellIds,
    rows,
    designPagesMissingFromShell: designIds.filter((id) => !shellById.has(id)),
    shellPagesNotInDesign: shellIds.filter((id) => !designSet.has(id)),
    levelDisagreements: rows.filter((r) => !r.agrees).map((r) => r.pageId),
    missingPageRows,
    sheetOnlyRows,
    missingPagesWithRoute: missingPageRows.filter(hasRoute).length,
    sheetOnlyPagesWithRoute: sheetOnlyRows.filter(hasRoute).length,
  };
}

// ---------------------------------------------------------------------------
// 报告构建
// ---------------------------------------------------------------------------

export interface BuildReportInput {
  readonly designPages: readonly DesignPage[];
  readonly prototype: PrototypeFacts;
  readonly checks: PrototypeChecksFacts;
  readonly mappings?: readonly CoverageMapping[];
  readonly hashes?: readonly FileHashFact[];
  /** 已保存的 v6 截图文件名集合（用于每页截图覆盖）。 */
  readonly v6ScreenshotFiles?: readonly string[];
  /** shell（F-I02）声明的屏事实；提供后报告附带 `shellInventory`。 */
  readonly shellScreens?: readonly ShellScreenFact[];
}

/** 稳定排序：按页面 ID 的字母+数字次序。 */
function byPageId(a: string, b: string): number {
  return a.localeCompare(b);
}

export function buildCoverageReport(input: BuildReportInput): CoverageReport {
  const mappings = input.mappings ?? COVERAGE_MAPPING;
  const byId = new Map(input.designPages.map((p) => [p.id, p]));
  const screenSet = new Set(input.prototype.registry);
  const actSet = new Set(input.prototype.sheetActs);
  const v6 = new Set(input.v6ScreenshotFiles ?? []);

  const rows: PageCoverageRow[] = [];
  const dangling: string[] = [];
  const mappedScreens = new Set<string>();

  for (const page of input.designPages) {
    const mapping = mappings.find((m) => m.pageId === page.id);
    if (mapping === undefined) continue;
    for (const s of mapping.screens) {
      if (!screenSet.has(s)) dangling.push(`${page.id}: 映射屏幕 '${s}' 不在 screens 注册表`);
      else mappedScreens.add(s);
    }
    for (const a of mapping.sheetActs) {
      if (!actSet.has(a)) dangling.push(`${page.id}: 映射动作 '${a}' 不在点击分派`);
    }
    rows.push({
      pageId: page.id,
      title: page.title,
      level: mapping.level,
      screens: mapping.screens,
      sheetActs: mapping.sheetActs,
      basis: mapping.basis,
      hasV6Screenshot: v6.has(page.id),
    });
  }

  // 未映射的设计页（防止静默丢失）——以 absent 记录并提示。
  for (const page of input.designPages) {
    if (!mappings.some((m) => m.pageId === page.id)) {
      rows.push({
        pageId: page.id,
        title: page.title,
        level: 'absent',
        screens: [],
        sheetActs: [],
        basis: '未声明映射',
        hasV6Screenshot: v6.has(page.id),
      });
      dangling.push(`${page.id}: 设计页面地图里有，但 COVERAGE_MAPPING 未声明`);
    }
  }

  const levelOf = (id: string): CoverageLevel => rows.find((r) => r.pageId === id)?.level ?? 'absent';
  const ids = input.designPages.map((p) => p.id).sort(byPageId);

  const dedicated = ids.filter((id) => levelOf(id) === 'screen');
  const embedded = ids.filter((id) => levelOf(id) === 'embedded');
  const sheetOnly = ids.filter((id) => levelOf(id) === 'sheet');
  const absent = ids.filter((id) => levelOf(id) === 'absent');
  const missing = [...absent, ...sheetOnly, ...embedded].sort(byPageId);

  const prototypeOnly = input.prototype.registry.filter((s) => !mappedScreens.has(s));

  const reviewedScenarios = input.checks.reviewed.filter((r) => !screenSet.has(r));
  const allKnown = new Set([...input.prototype.registry, ...reviewedScenarios]);
  const reviewedUnknown = input.checks.reviewed.filter((r) => !allKnown.has(r));

  const shellInventory: ShellInventory | null =
    input.shellScreens === undefined
      ? null
      : buildShellInventory({
          designPages: input.designPages,
          rows,
          shellScreens: input.shellScreens,
          missingPages: missing,
          sheetOnlyPages: sheetOnly,
        });

  return {
    designPageCount: input.designPages.length,
    prototypeScreenCount: input.prototype.registry.length,
    rows,
    dedicatedScreenPages: dedicated,
    sheetOnlyPages: sheetOnly,
    embeddedPages: embedded,
    absentPages: absent,
    missingPages: missing,
    prototypeOnlyScreens: prototypeOnly,
    danglingReferences: dangling,
    hashes: input.hashes ?? [],
    reviewedScenarios,
    reviewedUnknown,
    shellInventory,
  };
}
