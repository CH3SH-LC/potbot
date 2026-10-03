/**
 * F-APP 组合根 —— **屏幕视图装配**（registry + navigation + screens → ViewNode）。
 *
 * 这是把 F 线前端库真正「拼成一个页面」的地方。它**只做装配**，不重写任何兄弟模块：
 *
 * | 依赖 | 角色 |
 * | --- | --- |
 * | `shell/registry.ts` | 唯一屏幕注册表：28 个屏幕 id 与归属模块；组合根按它枚举屏幕 |
 * | `shell/screens.ts` | C01 首页屏幕模型（`buildHomeModel`）、四入口导航条（`buildEntryBar`） |
 * | `shell/navigation.ts` | 屏幕 → 路由语义（`screenDefOf().route`），导航栈由宿主持有 |
 * | `files/{versions,bytes,list}.ts` | F01 文件列表的**真实**列表视图（`createFile` → `listFiles`） |
 * | `render/view.ts` | `ViewNode` 数据层（fail-closed 校验） |
 *
 * ## 三条诚实纪律
 *
 * 1. **不虚构内容**：只有 C01（实时成果卡 + 近期对话）与 F01（文件列表）有夹具数据源；
 *    T01 用夹具群组；其余屏幕渲染**如实**的「未接线」状态（屏幕 id、归属模块、入口），
 *    不编造会话、任务、文件或权限内容。
 * 2. **不伪造成完成**：C01 头部带 `夹具数据 · 未接内核` 标签；未接线页明说「尚无页面视图模型」。
 * 3. **不重推颜色**：所有颜色 / 字号 / 字重 / 间距 / 圆角都走 `StyleTokens` 令牌名，
 *    序列化层解析为 `var(--pb-color-*)` 与 px；本文件不写死任何十六进制色值。
 *
 * 本模块**未做**（如实标注）：真实内核数据（未接 `KernelClient`）、事件与交互状态机
 * （`ViewNode` 只描述静态结构；导航靠 `<a href>` 整页跳转）、真机软键盘 / 系统 inset
 * （由宿主注入，见 `document.ts` 的查询参数）。
 */

import {
  ENTRY_ROOT_SCREEN,
  buildEntryBar,
  buildHomeModel,
  moduleOfScreen,
  screenDefOf,
  type EntryId,
  type ScreenDef,
  type ScreenId,
} from '../shell/index.js';
import type { SafeAreaInsets } from '../foundation/index.js';
import type { StyleTokens, ViewAttrs, ViewNode, ViewRole, ViewTag } from '../render/index.js';
import { withBytes } from '../files/bytes.js';
import { listFiles } from '../files/list.js';
import { createFile } from '../files/versions.js';
import {
  FIXTURE_CONVERSATIONS,
  FIXTURE_GROUP_STATUS_LABEL,
  FIXTURE_GROUPS,
  FIXTURE_PROVENANCE,
  FIXTURE_RESULTS,
} from './fixtures.js';

// ---------------------------------------------------------------------------
// 小工具（构造 ViewNode 的三件套：属性、样式、文本）
// ---------------------------------------------------------------------------

/** 类名拼装（去空）。 */
function cls(...names: readonly (string | false | undefined)[]): string {
  return names.filter((n): n is string => typeof n === 'string' && n.length > 0).join(' ');
}

/** 屏幕 id -> 页面 URL。带 `.html` 后缀，使同一份页面既能被 spike 服务动态渲染，
 *  也能**静态导出**后交给产品服务的静态目录（`POTBOT_WEB_DIR`）直接投递。 */
function screenHref(screen: ScreenId): string {
  return `/s/${screen}.html`;
}

/** 构造属性袋；`class` 为空串时不输出该键（属性值必须非空）。 */
function attrs(input: { readonly class?: string; readonly href?: string; readonly id?: string; readonly title?: string }): ViewAttrs {
  const out: { class?: string; href?: string; id?: string; title?: string } = {};
  if (input.class !== undefined && input.class.length > 0) out.class = input.class;
  if (input.href !== undefined) out.href = input.href;
  if (input.id !== undefined) out.id = input.id;
  if (input.title !== undefined) out.title = input.title;
  return out;
}

/** 容器节点（div）。 */
interface NodeExtras {
  readonly style?: StyleTokens;
  readonly role?: ViewRole;
  readonly ariaLabel?: string;
  readonly ariaHidden?: boolean;
}

function extraFields(extra: NodeExtras): Partial<ViewNode> {
  return {
    ...(extra.role === undefined ? {} : { role: extra.role }),
    ...(extra.style === undefined ? {} : { style: extra.style }),
    ...(extra.ariaLabel === undefined ? {} : { ariaLabel: extra.ariaLabel }),
    ...(extra.ariaHidden === undefined ? {} : { ariaHidden: extra.ariaHidden }),
  };
}

function box(className: string, children: readonly ViewNode[], extra: NodeExtras = {}): ViewNode {
  return {
    tag: 'div',
    role: extra.role ?? 'container',
    attrs: attrs({ class: className }),
    children,
    ...extraFields(extra),
  };
}

/** 叶子文本节点。 */
function leaf(tag: ViewTag, className: string, text: string, extra: NodeExtras = {}): ViewNode {
  // role 未显式给出时交给标签推导（`render/view.ts` 的 DEFAULT_ROLE_BY_TAG）。
  const fields = extraFields(extra);
  return { tag, attrs: attrs({ class: className }), text, ...fields };
}

/** ISO 时间 → 确定性短标签（`MM-DD HH:mm`，按字符串切；**不读时钟**、不做时区换算）。 */
function shortStamp(iso: string): string {
  if (iso.length < 16 || iso[10] !== 'T') return iso;
  return `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
}

// ---------------------------------------------------------------------------
// 页头 / 四入口导航条 / 输入区
// ---------------------------------------------------------------------------

/** 首页页头：小尺寸品牌图标 + `potbot` 标识 + 轻量新建入口（design-07 §4 行 112）。 */
function homeHeader(): ViewNode {
  return {
    tag: 'header',
    role: 'header',
    attrs: attrs({ class: 'pb-header' }),
    children: [
      // 品牌图标：设计指定**引用原图**（不重绘）。`src` 不在 ViewNode 属性白名单内，
      // 因此用 CSS 背景引用 `/assets/brand.png`（同一张 `brand-user.png`），XML 保持比例。
      {
        tag: 'div',
        role: 'image',
        ariaLabel: 'potbot 图标',
        attrs: attrs({ class: 'pb-brand-mark' }),
      },
      leaf('span', 'pb-brand-title', 'potbot', {
        role: 'text',
        style: { color: 'text-primary', fontSize: 'section-title', fontWeight: 600 },
      }),
      leaf('span', 'pb-fixture-badge', FIXTURE_PROVENANCE.label, {
        role: 'status',
        style: { color: 'accent-text', fontSize: 'annotation-minor', fontWeight: 500 },
      }),
      {
        tag: 'a',
        role: 'link',
        ariaLabel: '新建对话',
        attrs: attrs({ class: 'pb-new-entry', href: screenHref(ENTRY_ROOT_SCREEN.chat) }),
        children: [
          leaf('span', 'pb-new-entry-label', '新建', {
            style: { color: 'accent-text', fontSize: 'auxiliary', fontWeight: 500 },
          }),
        ],
      },
    ],
  };
}

/** 二级页页头：品牌标记 + 屏幕标题 + 返回入口（design-07 §4：「详情页使用名称与返回入口」）。 */
function detailHeader(def: ScreenDef): ViewNode {
  return {
    tag: 'header',
    role: 'header',
    attrs: attrs({ class: 'pb-header pb-header--detail' }),
    children: [
      {
        tag: 'a',
        role: 'link',
        ariaLabel: '返回',
        attrs: attrs({ class: 'pb-back', href: screenHref(ENTRY_ROOT_SCREEN[def.entry]) }),
        children: [leaf('span', 'pb-back-label', '返回', { style: { color: 'accent-text', fontSize: 'body', fontWeight: 500 } })],
      },
      leaf('h1', 'pb-detail-title', def.title, {
        role: 'heading',
        style: { color: 'text-primary', fontSize: 'section-title', fontWeight: 600 },
      }),
    ],
  };
}

/**
 * 四入口导航条：文字导航 + **细橙色选中下划线**（design-07 §2 行 36）。
 * 下划线用 CSS `::after` 画 2px `--pb-color-brand`；design 未给出粗细 dp，故不在本层写死数值语义。
 */
function entryNavBar(activeEntry: EntryId): ViewNode {
  const bar = buildEntryBar(activeEntry);
  return {
    tag: 'nav',
    role: 'navigation',
    ariaLabel: '主要导航',
    attrs: attrs({ class: 'pb-tabbar' }),
    children: bar.items.map((item) => ({
      tag: 'a' as const,
      role: 'link' as const,
      ariaLabel: item.selected ? `${item.label}（当前）` : item.label,
      attrs: attrs({ class: cls('pb-tab', item.selected && 'pb-tab--on'), href: screenHref(item.screen) }),
      children: [leaf('span', 'pb-tab-label', item.label, { role: 'text' })],
    })),
  };
}

/**
 * 底部输入区（design-07 §4 行 117）：附件 + 文本区 + 发送。
 * 键盘/安全区偏移由宿主注入的 `keyboardHeightDp` / `insets` 经 `buildHomeModel().composer` 算出，
 * `document.ts` 把它写成 `--pb-composer-offset`（CSS 变量），本层不猜数值。
 */
function composerBar(keyboardVisible: boolean): ViewNode {
  return box(
    'pb-composer',
    [
      {
        tag: 'a',
        role: 'link',
        ariaLabel: '添加附件',
        attrs: attrs({ class: 'pb-attach', href: screenHref('C04') }),
        children: [leaf('span', 'pb-attach-glyph', '＋', { ariaHidden: true, style: { fontSize: 'section-title' } })],
      },
      box('pb-composer-field', [
        {
          tag: 'textarea',
          role: 'input',
          ariaLabel: '消息输入框，提示：说点什么…',
          attrs: attrs({ class: 'pb-composer-input', id: 'pb-composer-input' }),
        },
        leaf('span', 'pb-composer-hint', '说点什么…', {
          ariaHidden: true,
          style: { color: 'text-secondary', fontSize: 'body' },
        }),
      ]),
      {
        tag: 'button',
        role: 'button',
        ariaLabel: keyboardVisible ? '停止回复' : '发送',
        attrs: attrs({ class: cls('pb-send', keyboardVisible && 'pb-send--stop') }),
        children: [
          leaf('span', 'pb-send-label', keyboardVisible ? '停止回复' : '发送', {
            style: { color: 'action-foreground', fontSize: 'button', fontWeight: 500 },
          }),
        ],
      },
    ],
    { style: { background: 'input', borderColor: 'outline' } },
  );
}

// ---------------------------------------------------------------------------
// C01 首页主体
// ---------------------------------------------------------------------------

export interface PageOptions {
  /** 系统安全区（宿主注入；组合根不读系统 inset）。 */
  readonly insets: SafeAreaInsets;
  /** 软键盘高度（dp）；0 表示键盘不可见。 */
  readonly keyboardHeightDp: number;
  /** 视口宽度（dp）；决定断点与窄屏页边。 */
  readonly widthDp?: number;
}

/** 近期活动成果卡（`card` 控件规格；空则不伪造占位成果）。 */
function recentResultsSection(results: ReturnType<typeof buildHomeModel>['recentResults']): ViewNode {
  const rows: readonly ViewNode[] =
    results.items.length === 0
      ? [leaf('p', 'pb-empty', '暂无近期成果', { role: 'text', style: { color: 'text-secondary', fontSize: 'body' } })]
      : results.items.map((row) => ({
          tag: 'a' as const,
          role: 'link' as const,
          ariaLabel: `${row.title}，${row.kindLabel}${row.taskTitle === null ? '' : `，来自任务 ${row.taskTitle}`}`,
          attrs: attrs({ class: 'pb-result-row', href: screenHref('F02') }),
          children: [
            box('pb-result-main', [
              leaf('span', 'pb-result-title', row.title, {
                role: 'text',
                style: { color: 'text-primary', fontSize: 'body', fontWeight: 500 },
              }),
              leaf(
                'span',
                'pb-result-meta',
                row.taskTitle === null ? row.kindLabel : `${row.kindLabel} · ${row.taskTitle}`,
                { role: 'text', style: { color: 'text-secondary', fontSize: 'auxiliary' } },
              ),
            ]),
            leaf('span', 'pb-result-open', '打开', {
              role: 'text',
              style: { color: 'accent-text', fontSize: 'auxiliary', fontWeight: 500 },
            }),
          ],
        }));

  return box(
    'pb-section',
    [
      leaf('h2', 'pb-section-title', results.title, {
        role: 'heading',
        style: { color: 'text-primary', fontSize: 'section-title', fontWeight: 600 },
      }),
      box('pb-card', rows, {
        style: { background: 'surface', borderColor: 'outline', radiusDp: 20, paddingDp: 16, gapDp: 8 },
      }),
    ],
    { style: { gapDp: 8 } },
  );
}

/** 其余近期对话（`list-row` 规格；触区 ≥48dp 由 CSS 保证）。 */
function recentConversationsSection(rows: ReturnType<typeof buildHomeModel>['recentConversations']): ViewNode {
  const items: readonly ViewNode[] =
    rows.length === 0
      ? [leaf('p', 'pb-empty', '暂无其他对话', { role: 'text', style: { color: 'text-secondary', fontSize: 'body' } })]
      : rows.map((row) => ({
          tag: 'a' as const,
          role: 'link' as const,
          ariaLabel: `${row.title}，${row.snippet}${row.hasRunningTask ? '，有任务进行中' : ''}`,
          attrs: attrs({ class: 'pb-row', href: screenHref('C02') }),
          children: [
            box('pb-row-main', [
              leaf('span', 'pb-row-title', row.title, {
                role: 'text',
                style: { color: 'text-primary', fontSize: 'body', fontWeight: 500 },
              }),
              leaf('span', 'pb-row-snippet', row.snippet, {
                role: 'text',
                style: { color: 'text-secondary', fontSize: 'auxiliary' },
              }),
            ]),
            leaf('span', 'pb-row-time', shortStamp(row.lastActiveAt), {
              role: 'text',
              style: { color: 'text-secondary', fontSize: 'annotation-minor' },
            }),
          ],
        }));

  return box(
    'pb-section',
    [
      leaf('h2', 'pb-section-title', '其余近期对话', {
        role: 'heading',
        style: { color: 'text-primary', fontSize: 'section-title', fontWeight: 600 },
      }),
      box('pb-list', items),
    ],
    { style: { gapDp: 8 } },
  );
}

/** C01 主体：成果卡 + 其余近期对话。 */
function homeMain(options: PageOptions): ViewNode {
  const model = buildHomeModel({
    activeEntry: 'chat',
    results: FIXTURE_RESULTS,
    conversations: FIXTURE_CONVERSATIONS,
    insets: options.insets,
    keyboardHeightDp: options.keyboardHeightDp,
    mode: 'app',
    ...(options.widthDp === undefined ? {} : { widthDp: options.widthDp }),
  });

  return box(
    'pb-main',
    [recentResultsSection(model.recentResults), recentConversationsSection(model.recentConversations)],
    { style: { gapDp: 24 } },
  );
}

// ---------------------------------------------------------------------------
// T01 群组 / F01 文件 / M01 我的
// ---------------------------------------------------------------------------

/** 任务行（design-07 §5：只保留名称、必要状态和下一步）。 */
function groupRow(group: (typeof FIXTURE_GROUPS)[number]): ViewNode {
  return {
    tag: 'a',
    role: 'link',
    ariaLabel: `${group.title}，${FIXTURE_GROUP_STATUS_LABEL[group.status]}，${group.nextStep}`,
    attrs: attrs({ class: 'pb-row pb-row--group', href: screenHref('T02') }),
    children: [
      box('pb-row-main', [
        leaf('span', 'pb-row-title', group.title, {
          role: 'text',
          style: { color: 'text-primary', fontSize: 'body', fontWeight: 500 },
        }),
        leaf('span', 'pb-row-snippet', group.nextStep, {
          role: 'text',
          style: { color: 'text-secondary', fontSize: 'auxiliary' },
        }),
      ]),
      leaf('span', cls('pb-chip', `pb-chip--${group.status}`), FIXTURE_GROUP_STATUS_LABEL[group.status], {
        role: 'status',
        style: { fontSize: 'annotation-minor', fontWeight: 500 },
      }),
    ],
  };
}

/** T01 群组列表（三类夹具样例，非空）。 */
function groupsMain(): ViewNode {
  return box(
    'pb-main',
    [
      leaf('h2', 'pb-section-title', '群组', {
        role: 'heading',
        style: { color: 'text-primary', fontSize: 'page-title', fontWeight: 600 },
      }),
      box('pb-list', FIXTURE_GROUPS.map(groupRow), {
        role: 'list',
        style: { background: 'surface', borderColor: 'outline', radiusDp: 20, paddingDp: 8 },
      }),
    ],
    { style: { gapDp: 8 } },
  );
}

/**
 * F01 文件列表 —— 用 F06 `files` 包的**真实**列表函数：
 * `createFile` + `withBytes` 建条目 → `listFiles` 出列表行（状态由 `hasBytes` **推导**，不接受调用方传入）。
 */
function filesMain(): ViewNode {
  const entries = FIXTURE_RESULTS.flatMap((result) => {
    const kind = result.kind === 'word' || result.kind === 'excel' || result.kind === 'ppt' ? result.kind : null;
    if (kind === null) return [];
    return [
      createFile({
        fileId: result.id,
        kind,
        title: result.title,
        createdAt: result.updatedAt,
        // 夹具字节摘要：固定值（`sha256:` + 64 位小写十六进制），**不是**真实文件哈希。
        bytes: withBytes(2048, `sha256:${'a'.repeat(64)}`),
      }),
    ];
  });
  const rows = listFiles(entries);

  const items: readonly ViewNode[] =
    rows.length === 0
      ? [leaf('p', 'pb-empty', '暂无文件', { role: 'text', style: { color: 'text-secondary', fontSize: 'body' } })]
      : rows.map((row) => ({
          tag: 'a' as const,
          role: 'link' as const,
          ariaLabel: `${row.title}，${row.displayStatus === 'generated' ? '已生成' : '草稿'}，第 ${row.currentRevision} 版`,
          attrs: attrs({ class: 'pb-row', href: screenHref('F02') }),
          children: [
            box('pb-row-main', [
              leaf('span', 'pb-row-title', row.title, {
                role: 'text',
                style: { color: 'text-primary', fontSize: 'body', fontWeight: 500 },
              }),
              leaf('span', 'pb-row-snippet', `${row.kind} · v${row.currentRevision} · ${shortStamp(row.updatedAt)}`, {
                role: 'text',
                style: { color: 'text-secondary', fontSize: 'auxiliary' },
              }),
            ]),
            leaf(
              'span',
              cls('pb-chip', row.displayStatus === 'generated' ? 'pb-chip--running' : 'pb-chip--pending'),
              row.displayStatus === 'generated' ? '已生成' : '草稿',
              { role: 'status', style: { fontSize: 'annotation-minor', fontWeight: 500 } },
            ),
          ],
        }));

  return box(
    'pb-main',
    [
      leaf('h2', 'pb-section-title', '文件', {
        role: 'heading',
        style: { color: 'text-primary', fontSize: 'page-title', fontWeight: 600 },
      }),
      box('pb-list', items, {
        role: 'list',
        style: { background: 'surface', borderColor: 'outline', radiusDp: 20, paddingDp: 8 },
      }),
      leaf('p', 'pb-note', '列表来自 F06 files 包的真实 listFiles()（夹具条目，字节为夹具摘要）。', {
        role: 'text',
        style: { color: 'text-secondary', fontSize: 'annotation-minor' },
      }),
    ],
    { style: { gapDp: 8 } },
  );
}

/**
 * M01 我的 —— 直接由**注册表**导出二级入口（M02–M10 的设计标题即注册表里的 `title`），
 * 不编造计数、额度或权限状态。
 */
function mineMain(): ViewNode {
  const rows: readonly ViewNode[] = (['M02', 'M03', 'M04', 'M05', 'M06', 'M07', 'M08', 'M09', 'M10'] as const).map(
    (id) => {
      const def = screenDefOf(id);
      return {
        tag: 'a' as const,
        role: 'link' as const,
        ariaLabel: def.title,
        attrs: attrs({ class: 'pb-row', href: screenHref(id) }),
        children: [
          box('pb-row-main', [
            leaf('span', 'pb-row-title', def.title, {
              role: 'text',
              style: { color: 'text-primary', fontSize: 'body', fontWeight: 500 },
            }),
            leaf('span', 'pb-row-snippet', `${id} · ${moduleOfScreen(id)}`, {
              role: 'text',
              style: { color: 'text-secondary', fontSize: 'auxiliary' },
            }),
          ]),
        ],
      };
    },
  );

  return box(
    'pb-main',
    [
      leaf('h2', 'pb-section-title', '我的', {
        role: 'heading',
        style: { color: 'text-primary', fontSize: 'page-title', fontWeight: 600 },
      }),
      box('pb-list', rows, { role: 'list', style: { background: 'surface', borderColor: 'outline', radiusDp: 20, paddingDp: 8 } }),
      leaf('p', 'pb-note', '入口清单直接取自 shell 屏幕注册表；各页数据尚未接线，点开显示如实状态。', {
        role: 'text',
        style: { color: 'text-secondary', fontSize: 'annotation-minor' },
      }),
    ],
    { style: { gapDp: 8 } },
  );
}

// ---------------------------------------------------------------------------
// 未接线屏幕（如实状态，不编造内容）
// ---------------------------------------------------------------------------

/** 未接线屏幕主体：屏幕 id / 归属模块 / 入口 + 明确说明「本页尚无页面视图模型」。 */
function notWiredMain(def: ScreenDef): ViewNode {
  const moduleId = moduleOfScreen(def.id);
  return box(
    'pb-main',
    [
      leaf('h2', 'pb-section-title', def.title, {
        role: 'heading',
        style: { color: 'text-primary', fontSize: 'page-title', fontWeight: 600 },
      }),
      box(
        'pb-card',
        [
          leaf('p', 'pb-status-line', `屏幕 ID：${def.id}`, {
            role: 'text',
            style: { color: 'text-secondary', fontSize: 'auxiliary' },
          }),
          leaf('p', 'pb-status-line', `归属模块：${moduleId}`, {
            role: 'text',
            style: { color: 'text-secondary', fontSize: 'auxiliary' },
          }),
          leaf('p', 'pb-status-line', `原型覆盖层级：${def.designLevel}`, {
            role: 'text',
            style: { color: 'text-secondary', fontSize: 'auxiliary' },
          }),
          leaf('p', 'pb-status-line', '状态：未接线（本页尚无页面视图模型）', {
            role: 'status',
            style: { color: 'accent-text', fontSize: 'body', fontWeight: 500 },
          }),
        ],
        { style: { background: 'accent-surface', paddingDp: 16, gapDp: 4, radiusDp: 12 } },
      ),
      leaf(
        'p',
        'pb-note',
        `F 线的 ${moduleId} 包当前只提供状态层 / 命令层，尚未交付本页的视图模型；组合根不编造内容，故如实渲染本状态。`,
        { role: 'text', style: { color: 'text-secondary', fontSize: 'annotation-minor' } },
      ),
    ],
    { style: { gapDp: 8 } },
  );
}

// ---------------------------------------------------------------------------
// 整页装配
// ---------------------------------------------------------------------------

/** 有夹具主体的屏幕。其余 24 个屏幕渲染未接线状态。 */
const WIRED_SCREENS: ReadonlySet<ScreenId> = new Set<ScreenId>(['C01', 'T01', 'F01', 'M01']);

/**
 * 装配一个屏幕的完整视图树（`header` + `main` [+ `composer`] + `tabbar`）。
 * 纯函数：同输入同结果，不读时钟 / 随机数 / 网络 / 文件。
 */
export function buildScreenPage(screen: ScreenId, options: PageOptions): ViewNode {
  const def = screenDefOf(screen);
  const isHome = screen === 'C01';

  const main: ViewNode = isHome
    ? homeMain(options)
    : screen === 'T01'
      ? groupsMain()
      : screen === 'F01'
        ? filesMain()
        : screen === 'M01'
          ? mineMain()
          : notWiredMain(def);

  const keyboardVisible = options.keyboardHeightDp > 0;

  const children: readonly ViewNode[] = [
    isHome ? homeHeader() : detailHeader(def),
    main,
    ...(isHome ? [composerBar(keyboardVisible)] : []),
    entryNavBar(def.entry),
  ];

  return {
    tag: 'div',
    role: 'screen',
    ariaLabel: `potbot ${def.title}`,
    attrs: attrs({ class: 'pb-app' }),
    children,
  };
}

/**
 * C01 首页输入区的**底部偏移**（dp）：`max(安全区底, 键盘高)`（design-07 §4 行 117）。
 * 组合根把它交给 `document.ts` 写成 CSS 变量，不在此层拼 CSS。
 */
export function composerOffsetDp(options: PageOptions): number {
  const model = buildHomeModel({
    activeEntry: 'chat',
    results: [],
    conversations: [],
    insets: options.insets,
    keyboardHeightDp: options.keyboardHeightDp,
    mode: 'app',
  });
  return model.composer.bottomOffsetDp;
}

/** 屏幕是否已接夹具主体（供 `document.ts` 标注与测试断言）。 */
export function isWiredScreen(screen: ScreenId): boolean {
  return WIRED_SCREENS.has(screen);
}
