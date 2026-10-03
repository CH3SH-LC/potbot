/**
 * F-R02 —— ScreenSpec 的运行时形状校验（操作模式）。
 *
 * 目的：外部 fixture / 真机 dump 转来的界面规格可能缺字段或类型错。审计前先校验，
 * 缺字段时抛**具体路径**的错误，而不是让后面的几何计算静默产出 NaN 或误判通过。
 * 这是"独立测试不吞错"的前提——坏输入必须显式失败。
 */

import type {
  NodeSpec,
  OcclusionRect,
  Rect,
  ScreenSpec,
  TextSpec,
  ViewportSpec,
} from './types.js';

/** 校验错误：带 code 与出错字段路径。 */
export class A11ySchemaError extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string, message: string) {
    super(`${code} @ ${path}: ${message}`);
    this.name = 'A11ySchemaError';
    this.code = code;
    this.path = path;
  }
}

const NODE_ROLES = new Set<string>([
  'screen',
  'header',
  'container',
  'list',
  'list-item',
  'card',
  'button',
  'icon-button',
  'input',
  'text',
  'image',
  'decorative-image',
  'heading',
  'status',
  'overlay',
  'sheet',
]);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function requireNumber(value: unknown, path: string): number {
  if (!isFiniteNumber(value)) {
    throw new A11ySchemaError('invalid-number', path, `期望有限数值，得到 ${String(value)}`);
  }
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new A11ySchemaError('invalid-string', path, `期望非空字符串，得到 ${String(value)}`);
  }
  return value;
}

function requireBool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new A11ySchemaError('invalid-boolean', path, `期望布尔，得到 ${String(value)}`);
  }
  return value;
}

function optionalBool(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  return requireBool(value, path);
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, path);
}

function parseRect(input: unknown, path: string): Rect {
  if (input === null || typeof input !== 'object') {
    throw new A11ySchemaError('invalid-rect', path, '期望矩形对象');
  }
  const r = input as Record<string, unknown>;
  return {
    x: requireNumber(r['x'], `${path}.x`),
    y: requireNumber(r['y'], `${path}.y`),
    w: requireNumber(r['w'], `${path}.w`),
    h: requireNumber(r['h'], `${path}.h`),
  };
}

function parseText(input: unknown, path: string): TextSpec {
  if (input === null || typeof input !== 'object') {
    throw new A11ySchemaError('invalid-text', path, '期望文本对象');
  }
  const t = input as Record<string, unknown>;
  const fontSizeSp = requireNumber(t['fontSizeSp'], `${path}.fontSizeSp`);
  const maxLines = requireNumber(t['maxLines'], `${path}.maxLines`);
  if (maxLines < 1) {
    throw new A11ySchemaError('invalid-max-lines', `${path}.maxLines`, `至少 1 行，得到 ${maxLines}`);
  }
  return {
    text: requireString(t['text'], `${path}.text`),
    fontSizeSp,
    maxLines,
    allowTruncate: requireBool(t['allowTruncate'], `${path}.allowTruncate`),
  };
}

function parseOcclusion(input: unknown, path: string): OcclusionRect {
  const rect = parseRect(input, path);
  const kind = requireString((input as Record<string, unknown>)['kind'], `${path}.kind`);
  if (kind !== 'hinge' && kind !== 'cutout' && kind !== 'gesture') {
    throw new A11ySchemaError('invalid-occlusion-kind', `${path}.kind`, `未知遮挡类型 ${kind}`);
  }
  return { ...rect, kind };
}

function parseNode(input: unknown, path: string): NodeSpec {
  if (input === null || typeof input !== 'object') {
    throw new A11ySchemaError('invalid-node', path, '期望节点对象');
  }
  const n = input as Record<string, unknown>;
  const role = requireString(n['role'], `${path}.role`);
  if (!NODE_ROLES.has(role)) {
    throw new A11ySchemaError('invalid-role', `${path}.role`, `未知角色 ${role}`);
  }
  const node: NodeSpec = {
    id: requireString(n['id'], `${path}.id`),
    role: role as NodeSpec['role'],
    bounds: parseRect(n['bounds'], `${path}.bounds`),
    ...(n['label'] !== undefined ? { label: optionalString(n['label'], `${path}.label`) } : {}),
    ...(n['objectName'] !== undefined
      ? { objectName: optionalString(n['objectName'], `${path}.objectName`) }
      : {}),
    ...(n['interactive'] !== undefined
      ? { interactive: optionalBool(n['interactive'], `${path}.interactive`) }
      : {}),
    ...(n['enabled'] !== undefined ? { enabled: optionalBool(n['enabled'], `${path}.enabled`) } : {}),
    ...(n['focusable'] !== undefined
      ? { focusable: optionalBool(n['focusable'], `${path}.focusable`) }
      : {}),
    ...(n['hitSlopDp'] !== undefined
      ? { hitSlopDp: requireNumber(n['hitSlopDp'], `${path}.hitSlopDp`) }
      : {}),
    ...(n['focusRingWidthDp'] !== undefined
      ? { focusRingWidthDp: requireNumber(n['focusRingWidthDp'], `${path}.focusRingWidthDp`) }
      : {}),
    ...(n['focusRingClipped'] !== undefined
      ? { focusRingClipped: optionalBool(n['focusRingClipped'], `${path}.focusRingClipped`) }
      : {}),
    ...(n['criticalControl'] !== undefined
      ? { criticalControl: optionalBool(n['criticalControl'], `${path}.criticalControl`) }
      : {}),
    ...(n['text'] !== undefined ? { text: parseText(n['text'], `${path}.text`) } : {}),
    ...(n['type'] !== undefined ? { type: optionalString(n['type'], `${path}.type`) } : {}),
    ...(n['status'] !== undefined ? { status: optionalString(n['status'], `${path}.status`) } : {}),
    ...(n['actionConsequence'] !== undefined
      ? { actionConsequence: optionalString(n['actionConsequence'], `${path}.actionConsequence`) }
      : {}),
    ...(n['announcementsPerSecond'] !== undefined
      ? {
          announcementsPerSecond: requireNumber(
            n['announcementsPerSecond'],
            `${path}.announcementsPerSecond`,
          ),
        }
      : {}),
    ...(n['interruptsReading'] !== undefined
      ? { interruptsReading: optionalBool(n['interruptsReading'], `${path}.interruptsReading`) }
      : {}),
    ...(n['nlEntry'] !== undefined ? { nlEntry: optionalBool(n['nlEntry'], `${path}.nlEntry`) } : {}),
    ...(n['trapsFocus'] !== undefined
      ? { trapsFocus: optionalBool(n['trapsFocus'], `${path}.trapsFocus`) }
      : {}),
    ...(n['returnsFocusTo'] !== undefined
      ? { returnsFocusTo: optionalString(n['returnsFocusTo'], `${path}.returnsFocusTo`) }
      : {}),
  };
  return node;
}

function parseViewport(input: unknown, path: string): ViewportSpec {
  if (input === null || typeof input !== 'object') {
    throw new A11ySchemaError('invalid-viewport', path, '期望视口对象');
  }
  const v = input as Record<string, unknown>;
  const widthDp = requireNumber(v['widthDp'], `${path}.widthDp`);
  const heightDp = requireNumber(v['heightDp'], `${path}.heightDp`);
  if (widthDp <= 0 || heightDp <= 0) {
    throw new A11ySchemaError('invalid-viewport-size', path, `视口尺寸必须为正，得到 ${widthDp}×${heightDp}`);
  }
  const orientation = requireString(v['orientation'], `${path}.orientation`);
  if (orientation !== 'portrait' && orientation !== 'landscape') {
    throw new A11ySchemaError('invalid-orientation', `${path}.orientation`, `未知朝向 ${orientation}`);
  }
  const fontScale = requireNumber(v['fontScale'], `${path}.fontScale`);
  if (fontScale <= 0) {
    throw new A11ySchemaError('invalid-font-scale', `${path}.fontScale`, `缩放必须为正，得到 ${fontScale}`);
  }
  const columns = requireNumber(v['columns'], `${path}.columns`);
  if (columns !== 1 && columns !== 2) {
    throw new A11ySchemaError('invalid-columns', `${path}.columns`, `列数只能是 1 或 2，得到 ${columns}`);
  }
  const occlusionsRaw = v['occlusions'];
  if (!Array.isArray(occlusionsRaw)) {
    throw new A11ySchemaError('invalid-occlusions', `${path}.occlusions`, '期望遮挡区数组');
  }
  return {
    widthDp,
    heightDp,
    orientation,
    fontScale,
    occlusions: occlusionsRaw.map((o, i) => parseOcclusion(o, `${path}.occlusions[${i}]`)),
    columns,
    collapsesToSingleColumn: requireBool(
      v['collapsesToSingleColumn'],
      `${path}.collapsesToSingleColumn`,
    ),
  };
}

/** 校验并归一化一份 ScreenSpec。缺字段/类型错抛 A11ySchemaError。 */
export function parseScreenSpec(input: unknown): ScreenSpec {
  if (input === null || typeof input !== 'object') {
    throw new A11ySchemaError('invalid-screen', 'screen', '期望屏幕对象');
  }
  const s = input as Record<string, unknown>;
  const nodesRaw = s['nodes'];
  if (!Array.isArray(nodesRaw)) {
    throw new A11ySchemaError('invalid-nodes', 'screen.nodes', '期望节点数组');
  }
  const focusOrderRaw = s['focusOrder'];
  if (!Array.isArray(focusOrderRaw)) {
    throw new A11ySchemaError('invalid-focus-order', 'screen.focusOrder', '期望焦点顺序数组');
  }
  const nodes = nodesRaw.map((n, i) => parseNode(n, `screen.nodes[${i}]`));
  const seen = new Set<string>();
  for (const node of nodes) {
    if (seen.has(node.id)) {
      throw new A11ySchemaError('duplicate-node-id', 'screen.nodes', `节点 id 重复：${node.id}`);
    }
    seen.add(node.id);
  }
  const focusOrder = focusOrderRaw.map((id, i) =>
    requireString(id, `screen.focusOrder[${i}]`),
  );
  const requiredStateKeys = Array.isArray(s['requiredStateKeys'])
    ? (s['requiredStateKeys'] as unknown[]).map((k, i) =>
        requireString(k, `screen.requiredStateKeys[${i}]`),
      )
    : undefined;
  const preservedState = Array.isArray(s['preservedState'])
    ? (s['preservedState'] as unknown[]).map((k, i) =>
        requireString(k, `screen.preservedState[${i}]`),
      )
    : undefined;
  return {
    id: requireString(s['id'], 'screen.id'),
    viewport: parseViewport(s['viewport'], 'screen.viewport'),
    nodes,
    focusOrder,
    ...(requiredStateKeys !== undefined ? { requiredStateKeys } : {}),
    ...(preservedState !== undefined ? { preservedState } : {}),
  };
}
