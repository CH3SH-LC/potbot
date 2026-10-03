/**
 * F-R02 —— 可访问性审计引擎（纯函数、零副作用）。
 *
 * 输入一份声明式 ScreenSpec，输出可机器断言的 Finding 列表。阈值来源：
 *   - 触区 48×48dp（design-07 行 105）——取自 F01 令牌 `touch.minTargetDp`，
 *     设计一改、这里跟着改，不再各自写死。
 *   - 焦点环 ≥2dp、不被卡片裁剪（行 95）。
 *   - 字体缩放 200% 走查、截断与双列退化（行 249）。
 *   - 读屏朗读卡片类型/名称/状态/动作后果、装饰图不重复、状态公告不过频（行 250）。
 *   - 焦点顺序与视觉顺序一致、浮层圈定焦点并返回触发控件、按钮泛称须有所属对象（行 251）。
 *   - 折叠/旋转保留状态、铰链/挖孔/手势区不放关键控制、双栏不产生第二个自然语言入口（行 256）。
 *
 * 本引擎不渲染、不连真机；真机 TalkBack / 系统字号 / 折叠屏实测属 on-device 层，
 * 本包不冒充（见 RUNBOOK.md）。
 */

import { touch } from '../../../apps/mobile-ui/src/foundation/tokens.js';
import type {
  AuditReport,
  Finding,
  FindingCode,
  NodeSpec,
  Rect,
  ScreenSpec,
  Severity,
} from './types.js';

// ---------------------------------------------------------------------------
// 阈值与出处
// ---------------------------------------------------------------------------

/** 有效触区最小边长 dp。取自 F01 设计令牌（design-07 行 105：至少 48×48dp）。 */
export const MIN_TARGET_DP = touch.minTargetDp;

/** 焦点环最小宽度 dp（design-07 行 95：至少 2dp）。 */
export const FOCUS_RING_MIN_DP = 2;
export const FOCUS_RING_REF = 'design-07 L95';

/** 双列退单列触发的大字号阈值（design-07 行 249：以 200% 字号走查）。 */
export const LARGE_FONT_SCALE = 2;

/** 实时公告频率上限（次/秒）；超过会打断阅读（design-07 行 250）。 */
export const MAX_ANNOUNCEMENTS_PER_SECOND = 3;

/** 无对象的泛称按钮名（design-07 行 251：按钮名称不能只有"查看""确定"而无所属对象）。 */
export const GENERIC_LABELS: readonly string[] = [
  '查看',
  '确定',
  '确认',
  '打开',
  '更多',
  '编辑',
  '删除',
  '详情',
  '取消',
  '好',
  'OK',
  'ok',
];

const DR_TOUCH = 'design-07 L105';
const DR_FOCUS_ORDER = 'design-07 L251';
const DR_CARDTALK = 'design-07 L250';
const DR_FONTSCALE = 'design-07 L249';
const DR_FOLD = 'design-07 L256';

// ---------------------------------------------------------------------------
// 几何
// ---------------------------------------------------------------------------

/** bounds 每侧外扩 hitSlop 后的命中区。 */
export function hitRect(node: NodeSpec): Rect {
  const slop = node.hitSlopDp ?? 0;
  return {
    x: node.bounds.x - slop,
    y: node.bounds.y - slop,
    w: node.bounds.w + slop * 2,
    h: node.bounds.h + slop * 2,
  };
}

/** 两矩形相交面积（不相交为 0）。 */
export function intersectArea(a: Rect, b: Rect): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  if (right <= left || bottom <= top) return 0;
  return (right - left) * (bottom - top);
}

/** outer 是否完全包含 inner（含边界相等）。 */
export function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

/** 是否进入焦点序列（显式 focusable 优先；否则可交互且未禁用）。 */
export function isFocusable(node: NodeSpec): boolean {
  if (node.focusable !== undefined) return node.focusable;
  if (node.interactive === true) return node.enabled !== false;
  return node.role === 'overlay' || node.role === 'sheet';
}

/**
 * 计算视觉阅读顺序（上→下，同带内左→右）。
 *
 * 分带规则：按上边排序后，若某节点与当前带垂直范围仍相交（重叠），并入同带；
 * 否则另起一带。同带内按左边界升序，左边界相同再按上边界。
 */
export function visualOrder(nodes: readonly NodeSpec[]): readonly string[] {
  const items = nodes.filter(isFocusable).slice();
  items.sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x);
  const bands: NodeSpec[][] = [];
  for (const node of items) {
    const band = bands[bands.length - 1];
    if (band === undefined) {
      bands.push([node]);
      continue;
    }
    const top = Math.min(...band.map((n) => n.bounds.y));
    const bottom = Math.max(...band.map((n) => n.bounds.y + n.bounds.h));
    const overlapsBand = node.bounds.y < bottom && node.bounds.y + node.bounds.h > top;
    if (overlapsBand) {
      band.push(node);
    } else {
      bands.push([node]);
    }
  }
  const order: string[] = [];
  for (const band of bands) {
    band.sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
    for (const node of band) order.push(node.id);
  }
  return order;
}

// ---------------------------------------------------------------------------
// 文本度量（估算，用于 200% 字号截断走查）
// ---------------------------------------------------------------------------

function charWidthFactor(codePoint: number): number {
  // 空格
  if (codePoint === 0x20) return 0.3;
  // CJK 统一表意文字 / 全角标点 / 假名 / 谚文
  if (
    (codePoint >= 0x2e80 && codePoint <= 0x9fff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xff00 && codePoint <= 0xffef)
  ) {
    return 1;
  }
  return 0.55;
}

/** 估算一行文本宽度 dp。scale 为系统字体缩放倍率。 */
export function estimateTextWidthDp(text: string, fontSizeSp: number, scale: number): number {
  let units = 0;
  for (const ch of text) {
    units += charWidthFactor(ch.codePointAt(0) ?? 0);
  }
  return units * fontSizeSp * scale;
}

/** 估算在给定宽度内换行后的行数（至少 1）。 */
export function estimateLineCount(text: string, fontSizeSp: number, scale: number, widthDp: number): number {
  if (widthDp <= 0) return Number.POSITIVE_INFINITY;
  const width = estimateTextWidthDp(text, fontSizeSp, scale);
  return Math.max(1, Math.ceil(width / widthDp));
}

// ---------------------------------------------------------------------------
// 审计
// ---------------------------------------------------------------------------

interface Ctx {
  readonly findings: Finding[];
}

function add(
  ctx: Ctx,
  code: FindingCode,
  severity: Severity,
  designRef: string,
  message: string,
  nodeId?: string,
): void {
  ctx.findings.push({ code, severity, ...(nodeId !== undefined ? { nodeId } : {}), message, designRef });
}

function labelOf(node: NodeSpec): string {
  return (node.label ?? '').trim();
}

function isInteractive(node: NodeSpec): boolean {
  return node.interactive === true || node.role === 'button' || node.role === 'icon-button';
}

function auditTouchTargets(ctx: Ctx, nodes: readonly NodeSpec[]): void {
  const interactive = nodes.filter((n) => isInteractive(n) && n.enabled !== false);
  for (const node of interactive) {
    const rect = hitRect(node);
    if (rect.w < MIN_TARGET_DP || rect.h < MIN_TARGET_DP) {
      add(
        ctx,
        'A11Y_TARGET_TOO_SMALL',
        'error',
        DR_TOUCH,
        `有效触区 ${rect.w}×${rect.h}dp 小于 ${MIN_TARGET_DP}×${MIN_TARGET_DP}dp`,
        node.id,
      );
    }
  }
  for (let i = 0; i < interactive.length; i += 1) {
    for (let j = i + 1; j < interactive.length; j += 1) {
      const a = interactive[i];
      const b = interactive[j];
      if (a === undefined || b === undefined) continue;
      const ra = hitRect(a);
      const rb = hitRect(b);
      if (intersectArea(ra, rb) <= 0) continue;
      if (contains(ra, rb)) {
        add(
          ctx,
          'A11Y_NESTED_INTERACTIVE',
          'error',
          DR_TOUCH,
          `触区嵌套：${b.id} 完全落在可交互的 ${a.id} 内`,
          b.id,
        );
      } else if (contains(rb, ra)) {
        add(
          ctx,
          'A11Y_NESTED_INTERACTIVE',
          'error',
          DR_TOUCH,
          `触区嵌套：${a.id} 完全落在可交互的 ${b.id} 内`,
          a.id,
        );
      } else {
        add(
          ctx,
          'A11Y_TARGET_OVERLAP',
          'error',
          DR_TOUCH,
          `触区重叠：${a.id} 与 ${b.id} 相交 ${Math.round(intersectArea(ra, rb))}dp²`,
          b.id,
        );
      }
    }
  }
}

function auditTalkBack(ctx: Ctx, nodes: readonly NodeSpec[]): void {
  for (const node of nodes) {
    const label = labelOf(node);
    if (node.role === 'decorative-image') {
      if (label.length > 0) {
        add(
          ctx,
          'A11Y_DECORATIVE_ANNOUNCED',
          'error',
          DR_CARDTALK,
          `装饰图不应重复朗读，但给了名称「${label}」`,
          node.id,
        );
      }
      continue;
    }
    if (isInteractive(node) && node.enabled !== false) {
      if (label.length === 0) {
        add(ctx, 'A11Y_LABEL_MISSING', 'error', DR_CARDTALK, '可交互控件缺少读屏名称', node.id);
      } else if (
        (node.role === 'button' || node.role === 'icon-button') &&
        GENERIC_LABELS.includes(label) &&
        (node.objectName ?? '').trim().length === 0
      ) {
        add(
          ctx,
          'A11Y_LABEL_GENERIC',
          'error',
          DR_FOCUS_ORDER,
          `按钮名称「${label}」是泛称且无 objectName，读数无所属对象`,
          node.id,
        );
      }
    }
    if (node.role === 'card') {
      const missing: string[] = [];
      if ((node.type ?? '').trim().length === 0) missing.push('type');
      if (label.length === 0) missing.push('label');
      if ((node.status ?? '').trim().length === 0) missing.push('status');
      if ((node.actionConsequence ?? '').trim().length === 0) missing.push('actionConsequence');
      if (missing.length > 0) {
        add(
          ctx,
          'A11Y_CARD_ANNOUNCE_INCOMPLETE',
          'error',
          DR_CARDTALK,
          `卡片朗读信息不全，缺 ${missing.join('/')}`,
          node.id,
        );
      }
    }
    if (node.announcementsPerSecond !== undefined) {
      if (node.announcementsPerSecond > MAX_ANNOUNCEMENTS_PER_SECOND) {
        add(
          ctx,
          'A11Y_LIVE_REGION_TOO_NOISY',
          'warning',
          DR_CARDTALK,
          `实时公告 ${node.announcementsPerSecond} 次/秒超过 ${MAX_ANNOUNCEMENTS_PER_SECOND}，会打断阅读`,
          node.id,
        );
      }
      if (node.interruptsReading === true) {
        add(
          ctx,
          'A11Y_LIVE_REGION_TOO_NOISY',
          'warning',
          DR_CARDTALK,
          '状态公告声明为打断当前阅读，应改为适度公告',
          node.id,
        );
      }
    }
  }
}

function auditFocusOrder(ctx: Ctx, nodes: readonly NodeSpec[], focusOrder: readonly string[]): void {
  const expected = visualOrder(nodes);
  const expectedSet = new Set(expected);
  const seen = new Set<string>();
  for (const id of focusOrder) {
    if (seen.has(id)) {
      add(ctx, 'A11Y_FOCUS_NODE_DUPLICATE', 'error', DR_FOCUS_ORDER, `焦点顺序重复出现 ${id}`, id);
    }
    seen.add(id);
    if (!expectedSet.has(id)) {
      add(
        ctx,
        'A11Y_FOCUS_NODE_EXTRA',
        'error',
        DR_FOCUS_ORDER,
        `焦点顺序含不可聚焦/不存在的节点 ${id}`,
        id,
      );
    }
  }
  for (const id of expected) {
    if (!seen.has(id)) {
      add(ctx, 'A11Y_FOCUS_NODE_MISSING', 'error', DR_FOCUS_ORDER, `焦点顺序遗漏节点 ${id}`, id);
    }
  }
  // 只在节点集合一致时判定顺序是否与视觉顺序一致，避免与缺失/多余发现重复噪声。
  const declared = focusOrder.filter((id) => expectedSet.has(id));
  const expectedFiltered = expected.filter((id) => seen.has(id));
  if (declared.length === expectedFiltered.length) {
    const mismatch = declared.findIndex((id, i) => id !== expectedFiltered[i]);
    if (mismatch >= 0) {
      add(
        ctx,
        'A11Y_FOCUS_ORDER_MISMATCH',
        'error',
        DR_FOCUS_ORDER,
        `焦点顺序与视觉顺序不一致：声明 [${declared.join(', ')}] vs 视觉 [${expectedFiltered.join(', ')}]`,
      );
    }
  }
}

function auditOverlays(ctx: Ctx, nodes: readonly NodeSpec[]): void {
  const ids = new Set(nodes.map((n) => n.id));
  for (const node of nodes) {
    if (node.role !== 'overlay' && node.role !== 'sheet') continue;
    if (node.trapsFocus !== true) {
      add(
        ctx,
        'A11Y_OVERLAY_NO_TRAP',
        'error',
        DR_FOCUS_ORDER,
        '浮层未圈定焦点（trapsFocus !== true）',
        node.id,
      );
    }
    const target = node.returnsFocusTo;
    if (target === undefined || target.trim().length === 0) {
      add(ctx, 'A11Y_FOCUS_NOT_RETURNED', 'error', DR_FOCUS_ORDER, '浮层未声明关闭后焦点返回的触发控件', node.id);
    } else if (!ids.has(target)) {
      add(
        ctx,
        'A11Y_FOCUS_NOT_RETURNED',
        'error',
        DR_FOCUS_ORDER,
        `浮层 returnsFocusTo=${target} 不是本屏节点，焦点无处可回`,
        node.id,
      );
    }
  }
}

function auditFocusRing(ctx: Ctx, nodes: readonly NodeSpec[]): void {
  for (const node of nodes) {
    if (!isFocusable(node)) continue;
    const width = node.focusRingWidthDp;
    if (width !== undefined && width < FOCUS_RING_MIN_DP) {
      add(
        ctx,
        'A11Y_FOCUS_RING_TOO_THIN',
        'warning',
        FOCUS_RING_REF,
        `焦点环 ${width}dp 小于 ${FOCUS_RING_MIN_DP}dp`,
        node.id,
      );
    }
    if (node.focusRingClipped === true) {
      add(ctx, 'A11Y_FOCUS_RING_CLIPPED', 'warning', FOCUS_RING_REF, '焦点环被卡片裁剪', node.id);
    }
  }
}

function auditFontScale(ctx: Ctx, nodes: readonly NodeSpec[], spec: ScreenSpec): void {
  const scale = spec.viewport.fontScale;
  for (const node of nodes) {
    const text = node.text;
    if (text === undefined) continue;
    const lines = estimateLineCount(text.text, text.fontSizeSp, scale, node.bounds.w);
    if (lines > text.maxLines && !text.allowTruncate) {
      add(
        ctx,
        'A11Y_FONTSCALE_TRUNCATION',
        'error',
        DR_FONTSCALE,
        `${scale * 100}% 字号下文本需 ${lines} 行超出 ${text.maxLines} 行且不允许截断`,
        node.id,
      );
    }
  }
  if (scale >= LARGE_FONT_SCALE && spec.viewport.columns === 2 && !spec.viewport.collapsesToSingleColumn) {
    add(
      ctx,
      'A11Y_FONTSCALE_NO_COLLAPSE',
      'warning',
      DR_FONTSCALE,
      `${scale * 100}% 字号下仍为双列且未声明退化为单列`,
    );
  }
}

function auditFoldable(ctx: Ctx, nodes: readonly NodeSpec[], spec: ScreenSpec): void {
  const occlusions = spec.viewport.occlusions;
  if (occlusions.length > 0) {
    for (const node of nodes) {
      if (node.criticalControl !== true) continue;
      for (const occlusion of occlusions) {
        if (intersectArea(node.bounds, occlusion) > 0) {
          add(
            ctx,
            'A11Y_CRITICAL_IN_OCCLUSION',
            'error',
            DR_FOLD,
            `关键控制「${node.id}」落在${occlusion.kind} 遮挡区（x${occlusion.x}, y${occlusion.y}, ${occlusion.w}×${occlusion.h}）`,
            node.id,
          );
          break;
        }
      }
    }
  }
  const nlEntries = nodes.filter((n) => n.nlEntry === true);
  if (nlEntries.length > 1) {
    add(
      ctx,
      'A11Y_SECOND_NL_ENTRY',
      'error',
      DR_FOLD,
      `出现 ${nlEntries.length} 个自然语言入口（${nlEntries.map((n) => n.id).join(', ')}），双栏不得产生第二个`,
    );
  }
  if (spec.viewport.orientation === 'landscape') {
    const required = spec.requiredStateKeys ?? [];
    const preserved = new Set(spec.preservedState ?? []);
    for (const key of required) {
      if (!preserved.has(key)) {
        add(
          ctx,
          'A11Y_LANDSCAPE_STATE_LOST',
          'error',
          DR_FOLD,
          `横屏/折叠后未保留状态「${key}」`,
        );
      }
    }
  }
}

/** 审计一份界面规格，返回确定性排序的报告。 */
export function auditScreen(spec: ScreenSpec): AuditReport {
  const ctx: Ctx = { findings: [] };
  auditTouchTargets(ctx, spec.nodes);
  auditTalkBack(ctx, spec.nodes);
  auditFocusOrder(ctx, spec.nodes, spec.focusOrder);
  auditOverlays(ctx, spec.nodes);
  auditFocusRing(ctx, spec.nodes);
  auditFontScale(ctx, spec.nodes, spec);
  auditFoldable(ctx, spec.nodes, spec);

  const findings = ctx.findings.slice().sort((a, b) => {
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    const na = a.nodeId ?? '';
    const nb = b.nodeId ?? '';
    if (na !== nb) return na < nb ? -1 : 1;
    return a.message < b.message ? -1 : a.message > b.message ? 1 : 0;
  });
  const errorCount = findings.filter((f) => f.severity === 'error').length;
  const warningCount = findings.filter((f) => f.severity === 'warning').length;
  return {
    screenId: spec.id,
    ok: errorCount === 0,
    findings,
    errorCount,
    warningCount,
    checkedNodes: spec.nodes.length,
  };
}

/** 便捷：报告里是否有某编码的发现。 */
export function hasFinding(report: AuditReport, code: FindingCode): boolean {
  return report.findings.some((f) => f.code === code);
}
