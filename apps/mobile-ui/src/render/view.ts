/**
 * F-I03 render —— 框架无关的**声明式视图节点**（ViewNode）。
 *
 * 本模块是 F 线渲染底座（render substrate）的**数据层**：只描述"界面长什么样"，
 * 不产生任何 DOM / Android View / 副作用，也不依赖任何前端框架（React/Vue/…）。
 * 手机端 `package.json` 的运行时依赖为零（仅 typescript/vitest/@types/node），
 * 因此这里的渲染器必须是**纯 TS**，由 shell / a11y / host 各自消费：
 *   - shell（应用外壳）-> `render-html.ts` 生成可预览的 HTML 字符串；
 *   - a11y（读屏/审计）-> `render-text.ts` 生成确定性的可访问性文本树；
 *   - host（Android 宿主编排）-> 读取 ViewNode 树与 `StyleTokens` 自行映射到原生 View。
 *
 * 设计原则（与 F01 foundation 一致）：
 *   1. **单一来源**：样式只能引用 `../foundation/tokens.js` 里已登记的令牌名/令牌值，
 *      渲染层不得自己编造颜色或字号；未知令牌名一律**失败**（fail-closed）。
 *   2. **确定性**：属性、样式声明的输出顺序由固定常量给出，不依赖对象的插入顺序，
 *      因而同一棵树的序列化结果**逐字节可复现**（byte-stable）。
 *   3. **只读**：所有 ViewNode / StyleTokens 都是只读类型；校验返回问题列表，不改输入。
 *
 * 本模块**未做**：布局求解（不产 dp 坐标）、真实样式表/CSS 文件、Android View 构造、
 * 事件绑定、图片解码、真机渲染——这些属 host / on-device 层，本包不冒充。
 */

import {
  colors,
  radius,
  spacing,
  typography,
  type ColorTokenName,
} from '../foundation/tokens.js';

/** 字号角色名（必须是 `typography.scale` 的键，防渲染层凭空定字号）。 */
export type TypeScaleName = keyof typeof typography.scale;

// ---------------------------------------------------------------------------
// 标签（tag）——白名单，防注入任意元素
// ---------------------------------------------------------------------------

/** 允许的宿主元素标签。只收录本渲染底座需要表达语义的元素。 */
export const VIEW_TAGS = [
  'div',
  'span',
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'button',
  'a',
  'input',
  'textarea',
  'label',
  'img',
  'section',
  'header',
  'footer',
  'nav',
  'main',
  'aside',
  'strong',
  'em',
  'code',
  'br',
  'hr',
] as const;

export type ViewTag = (typeof VIEW_TAGS)[number];

const TAG_SET: ReadonlySet<string> = new Set<string>(VIEW_TAGS);

/** 空元素（void element）：无子节点、无闭合标签。 */
export const VOID_TAGS: readonly ViewTag[] = ['img', 'input', 'br', 'hr'];
const VOID_TAG_SET: ReadonlySet<string> = new Set<string>(VOID_TAGS);

/** 是否为空元素（决定 HTML 序列化是否闭合）。 */
export function isVoidTag(tag: ViewTag): boolean {
  return VOID_TAG_SET.has(tag);
}

// ---------------------------------------------------------------------------
// 角色（role）——语义角色 + 到 ARIA role 的确定性映射
// ---------------------------------------------------------------------------

/**
 * 语义角色。这是本渲染底座自己的词汇，覆盖 design-07 的界面结构与 F-R02 审计
 * 所用的节点角色；`render-html.ts` 会把它映射成合法的 ARIA role 属性。
 */
export const VIEW_ROLES = [
  'screen',
  'navigation',
  'header',
  'main',
  'container',
  'list',
  'list-item',
  'card',
  'button',
  'link',
  'icon-button',
  'input',
  'text',
  'image',
  'decorative-image',
  'heading',
  'status',
  'overlay',
  'sheet',
] as const;

export type ViewRole = (typeof VIEW_ROLES)[number];

const ROLE_SET: ReadonlySet<string> = new Set<string>(VIEW_ROLES);

/**
 * 语义角色 -> ARIA role 属性值。`null` 表示该角色没有对应 ARIA role（如页面外壳
 * `screen`、纯文本 `text`），此时不输出 `role` 属性，交给标签本身表达语义。
 * 全部取值均为合法 ARIA role，避免输出无效的 `role="list-item"` 之类。
 */
export const ARIA_ROLE: Readonly<Record<ViewRole, string | null>> = {
  screen: null,
  navigation: 'navigation',
  header: 'banner',
  main: 'main',
  container: 'group',
  list: 'list',
  'list-item': 'listitem',
  card: 'group',
  button: 'button',
  link: 'link',
  'icon-button': 'button',
  input: 'textbox',
  text: null,
  image: 'img',
  'decorative-image': 'presentation',
  heading: 'heading',
  status: 'status',
  overlay: 'dialog',
  sheet: 'dialog',
};

/**
 * 未显式给 `role` 时，由标签推导的默认角色。用于可访问性树（`render-text.ts`）。
 * 无对应语义的标签回退为 `container`。
 */
export const DEFAULT_ROLE_BY_TAG: Readonly<Partial<Record<ViewTag, ViewRole>>> = {
  div: 'container',
  span: 'text',
  p: 'text',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  ul: 'list',
  ol: 'list',
  li: 'list-item',
  button: 'button',
  a: 'link',
  input: 'input',
  textarea: 'input',
  label: 'container',
  img: 'image',
  section: 'container',
  header: 'header',
  footer: 'container',
  nav: 'navigation',
  main: 'main',
  aside: 'container',
  strong: 'text',
  em: 'text',
  code: 'text',
  br: 'text',
  hr: 'container',
};

/** 标签 -> 默认角色（无则 `container`）。 */
export function defaultRoleForTag(tag: ViewTag): ViewRole {
  return DEFAULT_ROLE_BY_TAG[tag] ?? 'container';
}

// ---------------------------------------------------------------------------
// 样式令牌（style tokens）——只能引用已登记的令牌
// ---------------------------------------------------------------------------

/** 允许在 ViewNode 上出现的样式键（白名单）。 */
export const STYLE_KEYS = [
  'background',
  'borderColor',
  'color',
  'fontSize',
  'fontWeight',
  'gapDp',
  'paddingDp',
  'radiusDp',
] as const;

export type StyleKey = (typeof STYLE_KEYS)[number];
const STYLE_KEY_SET: ReadonlySet<string> = new Set<string>(STYLE_KEYS);

/**
 * 允许的间距值（dp）：取自 `tokens.spacing` 的 base 与 common，**不新增刻度**。
 * 输出 `padding` / `gap` 时用这些值。
 */
export const SPACING_STEPS: readonly number[] = [spacing.baseDp, ...spacing.commonDp];
const SPACING_STEP_SET: ReadonlySet<number> = new Set<number>(SPACING_STEPS);

/** 允许的字重：取自 `tokens.typography.weights`（400/500/600）。 */
export const FONT_WEIGHTS: readonly number[] = [
  typography.weights.body,
  typography.weights.buttonMin,
  typography.weights.buttonMax,
  typography.weights.title,
];
const FONT_WEIGHT_SET: ReadonlySet<number> = new Set<number>(FONT_WEIGHTS);

/** 允许圆角范围（dp）：0 或 `[radius.cardMinDp, radius.cardMaxDp]` 内整数。 */
export const RADIUS_ZERO_OR_RANGE = {
  zero: 0,
  min: radius.cardMinDp,
  max: radius.cardMaxDp,
} as const;

/**
 * 样式令牌集。所有颜色/字号/字重字段只允许**令牌名**，由序列化层解析成具体值，
 * 渲染层因此无法写入任意颜色（如 `#ff0000`）——只能引用 design-07 已登记的令牌。
 */
export interface StyleTokens {
  /** 文字色，取 `colors` 的键。 */
  readonly color?: ColorTokenName;
  /** 背景色，取 `colors` 的键。 */
  readonly background?: ColorTokenName;
  /** 边框色，取 `colors` 的键。 */
  readonly borderColor?: ColorTokenName;
  /** 字号角色，取 `typography.scale` 的键。 */
  readonly fontSize?: TypeScaleName;
  /** 字重，取 `FONT_WEIGHTS`（400/500/600）。 */
  readonly fontWeight?: number;
  /** 内边距（dp），取 `SPACING_STEPS`。 */
  readonly paddingDp?: number;
  /** 子项间距（dp），取 `SPACING_STEPS`。 */
  readonly gapDp?: number;
  /** 圆角（dp）：0 或 [12,20]。 */
  readonly radiusDp?: number;
}

// ---------------------------------------------------------------------------
// 安全属性（attrs）——白名单键 + 值校验
// ---------------------------------------------------------------------------

/** 允许透传的属性名（其余一律拒绝，杜绝 `onclick` / `style` 注入）。 */
export const VIEW_ATTR_NAMES = ['id', 'class', 'href', 'title'] as const;
export type ViewAttrName = (typeof VIEW_ATTR_NAMES)[number];
const ATTR_NAME_SET: ReadonlySet<string> = new Set<string>(VIEW_ATTR_NAMES);

/** 允许的链接协议（相对路径/锚点/安全协议）。 */
const SAFE_HREF_SCHEMES: ReadonlySet<string> = new Set(['http', 'https', 'mailto', 'tel']);

/** 属性袋：只允许白名单键，值均为非空字符串。 */
export type ViewAttrs = Readonly<Partial<Record<ViewAttrName, string>>>;

// ---------------------------------------------------------------------------
// 节点（ViewNode）
// ---------------------------------------------------------------------------

/**
 * 声明式视图节点。
 *
 * - `text` 与 `children` **互斥**（叶子用 text，容器用 children）。
 * - `role` 省略时由标签推导（见 `defaultRoleForTag`）。
 * - `ariaLabel` 即可访问名称；`ariaHidden` 为真则读屏跳过（装饰性元素）。
 */
export interface ViewNode {
  /** 宿主元素标签（白名单）。 */
  readonly tag: ViewTag;
  /** 语义角色。省略则由标签推导。 */
  readonly role?: ViewRole;
  /** 可访问名称（accessibility label）。 */
  readonly ariaLabel?: string;
  /** 是否对读屏隐藏（装饰性）。`decorative-image` 默认隐藏。 */
  readonly ariaHidden?: boolean;
  /** 样式令牌（只引用令牌，不写死值）。 */
  readonly style?: StyleTokens;
  /** 安全透传属性（白名单键）。 */
  readonly attrs?: ViewAttrs;
  /** 叶子文本。与 `children` 互斥。 */
  readonly text?: string;
  /** 子节点。 */
  readonly children?: readonly ViewNode[];
}

// ---------------------------------------------------------------------------
// 校验（fail-closed）
// ---------------------------------------------------------------------------

/** 校验问题编码。测试按编码断言，不匹配文案。 */
export type ViewProblemCode =
  | 'invalid-node'
  | 'unknown-tag'
  | 'unknown-role'
  | 'unknown-style-key'
  | 'invalid-style-value'
  | 'invalid-field'
  | 'invalid-attrs'
  | 'unsafe-href'
  | 'text-and-children';

/** 一条校验问题，带出错字段路径。 */
export interface ViewProblem {
  readonly code: ViewProblemCode;
  /** 从根起的字段路径，形如 `children[1].style.paddingDp`。 */
  readonly path: string;
  readonly message: string;
}

/** 视图树非法时抛出。`problems` 给出全部问题，便于一次修完。 */
export class ViewError extends Error {
  readonly code = 'invalid-view-node';
  readonly problems: readonly ViewProblem[];
  constructor(problems: readonly ViewProblem[]) {
    super(`视图树非法（${problems.length} 处）：${problems.map((p) => `${p.path}: ${p.message}`).join('; ')}`);
    this.name = 'ViewError';
    this.problems = problems;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function problem(
  out: ViewProblem[],
  code: ViewProblemCode,
  path: string,
  message: string,
): void {
  out.push({ code, path, message });
}

/** 链接协议是否安全（拒绝 `javascript:` / `data:` 等）。 */
export function isSafeHref(href: string): boolean {
  const trimmed = href.trim();
  if (trimmed.length === 0) return false;
  // 锚点与相对路径。
  if (trimmed.startsWith('#') || trimmed.startsWith('/') || trimmed.startsWith('./') || trimmed.startsWith('../')) {
    return true;
  }
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed);
  if (m === null) return true; // 形如 `page.html` 的相对路径。
  return SAFE_HREF_SCHEMES.has(m[1]!.toLowerCase());
}

function validateStyle(style: unknown, path: string, out: ViewProblem[]): void {
  if (!isRecord(style)) {
    problem(out, 'invalid-field', path, '样式必须是对象');
    return;
  }
  for (const key of Object.keys(style)) {
    if (!STYLE_KEY_SET.has(key)) {
      problem(out, 'unknown-style-key', `${path}.${key}`, `未登记的样式键 "${key}"`);
      continue;
    }
    const value = style[key];
    switch (key) {
      case 'color':
      case 'background':
      case 'borderColor':
        if (typeof value !== 'string' || !Object.prototype.hasOwnProperty.call(colors, value)) {
          problem(out, 'invalid-style-value', `${path}.${key}`, `颜色令牌 "${String(value)}" 未在 tokens.colors 登记`);
        }
        break;
      case 'fontSize':
        if (typeof value !== 'string' || !Object.prototype.hasOwnProperty.call(typography.scale, value)) {
          problem(out, 'invalid-style-value', `${path}.${key}`, `字号角色 "${String(value)}" 未在 typography.scale 登记`);
        }
        break;
      case 'fontWeight':
        if (typeof value !== 'number' || !FONT_WEIGHT_SET.has(value)) {
          problem(out, 'invalid-style-value', `${path}.${key}`, `字重 ${String(value)} 不在 [${FONT_WEIGHTS.join(', ')}]`);
        }
        break;
      case 'paddingDp':
      case 'gapDp':
        if (typeof value !== 'number' || !SPACING_STEP_SET.has(value)) {
          problem(out, 'invalid-style-value', `${path}.${key}`, `间距 ${String(value)}dp 不在 [${SPACING_STEPS.join(', ')}]`);
        }
        break;
      case 'radiusDp':
        if (
          typeof value !== 'number' ||
          !Number.isInteger(value) ||
          (value !== RADIUS_ZERO_OR_RANGE.zero &&
            (value < RADIUS_ZERO_OR_RANGE.min || value > RADIUS_ZERO_OR_RANGE.max))
        ) {
          problem(
            out,
            'invalid-style-value',
            `${path}.${key}`,
            `圆角 ${String(value)}dp 必须为 0 或 [${RADIUS_ZERO_OR_RANGE.min},${RADIUS_ZERO_OR_RANGE.max}] 内整数`,
          );
        }
        break;
      default:
        break;
    }
  }
}

function validateAttrs(attrs: unknown, path: string, out: ViewProblem[]): void {
  if (!isRecord(attrs)) {
    problem(out, 'invalid-field', path, '属性必须是对象');
    return;
  }
  for (const key of Object.keys(attrs)) {
    if (!ATTR_NAME_SET.has(key)) {
      problem(out, 'invalid-attrs', `${path}.${key}`, `不允许的属性名 "${key}"`);
      continue;
    }
    const value = attrs[key];
    if (!isNonEmptyString(value)) {
      problem(out, 'invalid-field', `${path}.${key}`, '属性值必须是非空字符串');
      continue;
    }
    if (key === 'href' && !isSafeHref(value)) {
      problem(out, 'unsafe-href', `${path}.href`, `不安全的链接协议：${value}`);
    }
  }
}

function validateNode(node: unknown, path: string, out: ViewProblem[]): void {
  if (!isRecord(node)) {
    problem(out, 'invalid-node', path, '节点必须是对象');
    return;
  }
  const tag = node['tag'];
  if (typeof tag !== 'string' || !TAG_SET.has(tag)) {
    problem(out, 'unknown-tag', `${path}.tag`, `未登记的标签 "${String(tag)}"`);
  }
  const role = node['role'];
  if (role !== undefined && (typeof role !== 'string' || !ROLE_SET.has(role))) {
    problem(out, 'unknown-role', `${path}.role`, `未登记的角色 "${String(role)}"`);
  }
  const ariaLabel = node['ariaLabel'];
  if (ariaLabel !== undefined && !isNonEmptyString(ariaLabel)) {
    problem(out, 'invalid-field', `${path}.ariaLabel`, '可访问名称必须是非空字符串');
  }
  const ariaHidden = node['ariaHidden'];
  if (ariaHidden !== undefined && typeof ariaHidden !== 'boolean') {
    problem(out, 'invalid-field', `${path}.ariaHidden`, 'ariaHidden 必须是布尔');
  }
  const text = node['text'];
  if (text !== undefined && typeof text !== 'string') {
    problem(out, 'invalid-field', `${path}.text`, 'text 必须是字符串');
  }
  if (node['style'] !== undefined) validateStyle(node['style'], `${path}.style`, out);
  if (node['attrs'] !== undefined) validateAttrs(node['attrs'], `${path}.attrs`, out);

  const children = node['children'];
  if (children !== undefined) {
    if (!Array.isArray(children)) {
      problem(out, 'invalid-field', `${path}.children`, 'children 必须是数组');
    } else {
      if (children.length > 0 && text !== undefined) {
        problem(out, 'text-and-children', path, 'text 与 children 互斥（叶子用 text，容器用 children）');
      }
      children.forEach((child, i) => validateNode(child, `${path}.children[${i}]`, out));
    }
  }
}

/** 校验一棵视图树，返回**全部问题**（空数组 = 通过）。纯函数，不改输入。 */
export function validateViewNode(node: unknown): readonly ViewProblem[] {
  const out: ViewProblem[] = [];
  validateNode(node, 'root', out);
  return out;
}

/** 校验失败即抛 `ViewError`（带全部问题）。序列化器入口会调用它。 */
export function assertViewNode(node: unknown): asserts node is ViewNode {
  const problems = validateViewNode(node);
  if (problems.length > 0) throw new ViewError(problems);
}
