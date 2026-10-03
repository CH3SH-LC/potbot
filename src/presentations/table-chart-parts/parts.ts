/**
 * P06 · **部件与关系登记表**（part / relationship registry）。
 *
 * ## 这一层解决什么
 *
 * 一份 PPTX 里，表格与图表落在包内的方式**不同**，混起来最容易出错：
 *
 * - **图表**是**独立部件**（`ppt/charts/chartN.xml`），由幻灯片经一条 `chart` 关系指过去，
 *   而图表部件又经一条 `package` 关系指向**内嵌工作簿**（`ppt/embeddings/**.xlsx`）；
 * - **表格**是**内联块**（就写在幻灯片 XML 里，没有独立部件、没有关系）。
 *
 * 上层（页操作 / 导入 / 导出）不该各自拼路径、各自猜内容类型、各自判断"这个 frame 要不要
 * 关系"。本模块把这件事收敛成**唯一来源**：
 *
 * 1. **内容类型**：按部件**类别**查表；未注册的类别 ⇒ 抛错（不猜、不默认八位位流）；
 * 2. **部件路径**：登记时校验（POSIX、无 `..`、无前导 `/`、非空）；同一路径登记两次 ⇒ 抛错；
 * 3. **关系**：同一 `(owner, rId)` 只允许一条；写进登记表**不等于**目标存在——
 *    `validatePartGraph` 才把相对 `Target` 解析成包内路径并检查**逐条落到真实部件**
 *    （悬挂关系 ⇒ 抛错）；
 * 4. **帧登记**：`registerChartFrame` / `registerTableFrame` 把"这页这帧是表还是图"记下来，
 *    并对**图表**额外要求：幻灯片刻要有指向图表部件的关系、图表部件要有指向内嵌工作簿的
 *    关系（缺一即抛错）。表格**不允许**挂外部关系（内联块挂关系 = 结构说反了）。
 *
 * ## 与既有模块的边界
 *
 * 本模块**不改** `tables.ts` / `charts.ts` / `roundtrip.ts` / `render.ts`，运行期也不 import
 * 它们；内容类型表在源码里**独立维护**，由用例与 `charts.ts` 的 `buildChartParts` 输出做
 * **交叉断言**（分叉会被当场抓红），而不是靠"看起来一样"。
 *
 * ## 未验证 / 边界
 *
 * - 只登记**描述符**（路径 / 内容类型 / 关系），**不**读写真 ZIP 字节——打包与拆包是
 *   `ooxml` 层的事；
 * - 关系目标只做**包内**解析：`TargetMode="External"`（超链接一类）本批不登记；
 * - 真机 PowerPoint / WPS 打开未验证。
 */

import { TableChartPartsError } from './errors.js';

// ---------------------------------------------------------------------------
// 部件类别与内容类型
// ---------------------------------------------------------------------------

/** 本层认识的部件类别。表格**不在**此列——它是内联块，不是独立部件。 */
export const PART_KINDS = ['slide', 'chart', 'embedded_workbook'] as const;

export type PartKind = (typeof PART_KINDS)[number];

/**
 * 部件类别 → 内容类型。
 *
 * **必须与 `charts.ts` 的 `buildChartParts` 产出一致**：两边分叉会让"本层登记通过"而
 * "整份装配报内容类型错"这种自相矛盾的结果。用例对两者做交叉断言。
 */
export const PART_CONTENT_TYPES: Readonly<Record<PartKind, string>> = Object.freeze({
  slide: 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
  chart: 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml',
  embedded_workbook: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
});

/**
 * 关系类型（与 `charts.ts` 的常量同口径，本层独立维护）。
 *
 * 以**字面量对象**声明（而非 `Record<string, string>`）：这样按已知键取（`RELATIONSHIP_TYPES.chart`）
 * 得到的是确定的 `string`，在 `noUncheckedIndexedAccess` 下不会退化成 `string | undefined`；
 * 需按任意字符串查表时走 `relationshipTypeOf`。
 */
export const RELATIONSHIP_TYPES = Object.freeze({
  office_document: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
  slide: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide',
  chart: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart',
  package: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/package',
});

export type RelationshipTypeKey = keyof typeof RELATIONSHIP_TYPES;

/** 取 `office_document` / `slide` / `chart` / `package` 之一的关系类型 URI。未知名 ⇒ 抛错。 */
export function relationshipTypeOf(key: string): string {
  const uri = (RELATIONSHIP_TYPES as Readonly<Record<string, string | undefined>>)[key];
  if (uri === undefined) {
    throw new TableChartPartsError(
      'unknown_relationship_type',
      `关系类型 ${key} 不在受支持表内（不猜 URI）`,
    );
  }
  return uri;
}

/** 默认部件路径（与 `charts.ts` 的默认值同口径，用例交叉断言）。 */
export const DEFAULT_CHART_PART_PATH = 'ppt/charts/chart1.xml';
export const DEFAULT_EMBEDDED_WORKBOOK_PATH = 'ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx';

// ---------------------------------------------------------------------------
// 路径校验与解析
// ---------------------------------------------------------------------------

const PATH_SEGMENT_OK = /^[^\\/]*$/;

/**
 * 部件路径必须是**包内 POSIX 相对路径**：非空、无前导 `/`、无 `\`、无 `.` / `..` 段、
 * 无空段。不合法 ⇒ 抛错（不"纠正"成看起来合法的路径）。
 */
export function assertPartPath(path: string, what = '部件路径'): void {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new TableChartPartsError('invalid_part_path', `${what}不能为空`);
  }
  if (path.startsWith('/') || path.endsWith('/')) {
    throw new TableChartPartsError('invalid_part_path', `${what} ${path} 不得以 / 开头或结尾`);
  }
  if (path.includes('\\')) {
    throw new TableChartPartsError('invalid_part_path', `${what} ${path} 必须用 POSIX 斜杠`);
  }
  for (const segment of path.split('/')) {
    if (!PATH_SEGMENT_OK.test(segment) || segment === '' || segment === '.' || segment === '..') {
      throw new TableChartPartsError('invalid_part_path', `${what} ${path} 含非法路径段 "${segment}"`);
    }
  }
}

/**
 * 把 `owner` 部件下的一条相对 `Target` 解析成包内绝对路径。
 *
 * - `owner_path = null` 表示**包根** `_rels/.rels`，`Target` 相对包根；
 * - 结果可能越过包根（`..` 把栈弹空）⇒ 抛错（越界目标不是包内部件）。
 */
export function resolveRelationshipTarget(ownerPath: string | null, target: string): string {
  if (typeof target !== 'string' || target.trim() === '') {
    throw new TableChartPartsError('invalid_part_path', '关系目标不能为空');
  }
  const base = target.startsWith('/')
    ? ''
    : ownerPath === null
      ? ''
      : `${ownerPath.slice(0, ownerPath.lastIndexOf('/') + 1)}`;
  const combined = target.startsWith('/') ? target.slice(1) : `${base}${target}`;
  const stack: string[] = [];
  for (const segment of combined.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (stack.length === 0) {
        throw new TableChartPartsError(
          'invalid_part_path',
          `关系目标 ${target}（owner=${ownerPath ?? '<package>'}）越过包根`,
        );
      }
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  if (stack.length === 0) {
    throw new TableChartPartsError('invalid_part_path', `关系目标 ${target} 解析后为空`);
  }
  return stack.join('/');
}

/** 取 `path` 所在目录（无斜杠则空串）。 */
export function partDirectoryOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

/** 取 `path` 的文件名（最后一段）。 */
export function partNameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** `owner` 部件的 `_rels` 部件路径。owner 为 `null` ⇒ 包根 `_rels/.rels`。 */
export function relsPartPathOf(ownerPath: string | null): string {
  if (ownerPath === null) return '_rels/.rels';
  const dir = partDirectoryOf(ownerPath);
  return dir === '' ? `_rels/${partNameOf(ownerPath)}.rels` : `${dir}/_rels/${partNameOf(ownerPath)}.rels`;
}

// ---------------------------------------------------------------------------
// 部件 / 关系描述符
// ---------------------------------------------------------------------------

/** 一个**部件描述符**。 */
export interface PartDescriptor {
  readonly path: string;
  readonly kind: PartKind;
  readonly content_type: string;
}

/** 造一个部件描述符：类别必须在表内（否则抛错），路径必须是合法包内路径。 */
export function makePart(kind: PartKind, path: string): PartDescriptor {
  const contentType = PART_CONTENT_TYPES[kind];
  if (contentType === undefined) {
    throw new TableChartPartsError('unknown_part_kind', `未注册的部件类别 ${String(kind)}`);
  }
  assertPartPath(path);
  return Object.freeze({ path, kind, content_type: contentType });
}

/** 一条**关系描述符**。`owner_path = null` 表示包根关系（`_rels/.rels`）。 */
export interface RelationshipDescriptor {
  readonly owner_path: string | null;
  readonly r_id: string;
  readonly type: string;
  readonly target: string;
}

/** rId 必须是 `rId` + 正整数的常规形态（本层不猜别的形态）。 */
const RID_PATTERN = /^rId[1-9][0-9]*$/;

function assertRelationshipId(rId: string): void {
  if (typeof rId !== 'string' || !RID_PATTERN.test(rId)) {
    throw new TableChartPartsError('invalid_relationship_id', `关系 id ${String(rId)} 必须形如 rId1、rId2 …`);
  }
}

/** 部件 + 关系的登记图（不可变；顺序 = 登记顺序）。 */
export interface PartGraph {
  readonly parts: readonly PartDescriptor[];
  readonly relationships: readonly RelationshipDescriptor[];
}

export const EMPTY_PART_GRAPH: PartGraph = Object.freeze({ parts: Object.freeze([]), relationships: Object.freeze([]) });

/** 取路径为 `path` 的部件；不存在 ⇒ `undefined`。 */
export function findPart(graph: PartGraph, path: string): PartDescriptor | undefined {
  return graph.parts.find((part) => part.path === path);
}

/** 要求部件存在，缺失即抛错（供"必须存在"的调用点，避免静默拿到 `undefined`）。 */
export function requirePart(graph: PartGraph, path: string): PartDescriptor {
  const found = findPart(graph, path);
  if (found === undefined) {
    throw new TableChartPartsError('unknown_part', `登记表里没有部件 ${path}`);
  }
  return found;
}

/** 要求部件存在**且**类别相符；类别不符 ⇒ 抛错（不静默当同类用）。 */
export function requirePartOfKind(graph: PartGraph, path: string, kind: PartKind): PartDescriptor {
  const part = requirePart(graph, path);
  if (part.kind !== kind) {
    throw new TableChartPartsError(
      'wrong_part_kind',
      `部件 ${path} 类别是 ${part.kind}，此处要求 ${kind}`,
    );
  }
  return part;
}

/** 登记一个部件。路径重复 ⇒ 抛错（不覆盖、不静默忽略）。 */
export function addPart(graph: PartGraph, part: PartDescriptor): PartGraph {
  assertPartPath(part.path);
  const expected = PART_CONTENT_TYPES[part.kind];
  if (expected === undefined) {
    throw new TableChartPartsError('unknown_part_kind', `未注册的部件类别 ${String(part.kind)}`);
  }
  if (part.content_type !== expected) {
    throw new TableChartPartsError(
      'unknown_part_kind',
      `部件 ${part.path} 的内容类型 ${part.content_type} 与类别 ${part.kind} 的口径 ${expected} 不符`,
    );
  }
  if (findPart(graph, part.path) !== undefined) {
    throw new TableChartPartsError('duplicate_part_path', `部件 ${part.path} 已登记过`);
  }
  return Object.freeze({ parts: Object.freeze([...graph.parts, part]), relationships: graph.relationships });
}

/** 登记一条关系。同一 `(owner, rId)` 重复 ⇒ 抛错。 */
export function addRelationship(graph: PartGraph, relationship: RelationshipDescriptor): PartGraph {
  assertRelationshipId(relationship.r_id);
  const clash = graph.relationships.find(
    (existing) => existing.owner_path === relationship.owner_path && existing.r_id === relationship.r_id,
  );
  if (clash !== undefined) {
    throw new TableChartPartsError(
      'duplicate_relationship_id',
      `${relationship.owner_path ?? '<package>'} 已有关系 ${relationship.r_id}`,
    );
  }
  return Object.freeze({ parts: graph.parts, relationships: Object.freeze([...graph.relationships, relationship]) });
}

/** `owner` 部件声明的关系（`owner = null` 取包根关系）。 */
export function outgoingRelationships(graph: PartGraph, ownerPath: string | null): readonly RelationshipDescriptor[] {
  return graph.relationships.filter((relationship) => relationship.owner_path === ownerPath);
}

/** 校验结果：每条关系解析出的包内目标路径。 */
export interface ResolvedRelationship {
  readonly relationship: RelationshipDescriptor;
  readonly target_path: string;
}

/**
 * 把**每一条**关系解析成包内路径，并要求目标**真实存在**。
 *
 * 目标部件缺失 ⇒ `dangling_relationship`（悬挂关系），**不是**"先记下回头再看"。
 * `owner_path` 非 `null` 时，owner 部件自身也必须存在，否则同样是悬挂。
 */
export function validatePartGraph(graph: PartGraph): readonly ResolvedRelationship[] {
  const resolved: ResolvedRelationship[] = [];
  for (const relationship of graph.relationships) {
    if (relationship.owner_path !== null) {
      requirePart(graph, relationship.owner_path);
    }
    const targetPath = resolveRelationshipTarget(relationship.owner_path, relationship.target);
    if (findPart(graph, targetPath) === undefined) {
      throw new TableChartPartsError(
        'dangling_relationship',
        `关系 ${relationship.owner_path ?? '<package>'} --(rId=${relationship.r_id})--> ${relationship.target} 解析为 ${targetPath}，但该部件不存在`,
      );
    }
    resolved.push(Object.freeze({ relationship, target_path: targetPath }));
  }
  return Object.freeze(resolved);
}

/** 登记表内全部部件路径（登记顺序）。 */
export function partPaths(graph: PartGraph): readonly string[] {
  return graph.parts.map((part) => part.path);
}

// ---------------------------------------------------------------------------
// 帧登记：这页这帧是"表"还是"图"
// ---------------------------------------------------------------------------

/** 幻灯片上的一个图形帧描述符。 */
export interface GraphicFrameDescriptor {
  readonly slide_path: string;
  readonly shape_id: number;
  readonly kind: 'table' | 'chart';
  /**
   * 表格：内联，值 = 所在幻灯片部件路径（**没有**独立部件、没有关系）；
   * 图表：值 = 图表部件路径（经一条 `chart` 关系指过去）。
   */
  readonly part_path: string;
  /** 图表才有；表格恒为 `null`（内联块挂关系 = 结构说反了）。 */
  readonly rel_id: string | null;
}

/** 登记结果：登记图 + 新登记的帧。 */
export interface FrameRegistration {
  readonly graph: PartGraph;
  readonly frame: GraphicFrameDescriptor;
}

function assertShapeId(shapeId: number): void {
  if (!Number.isSafeInteger(shapeId) || shapeId <= 0) {
    throw new TableChartPartsError('invalid_part_path', `形状 id 必须是正整数，收到 ${String(shapeId)}`);
  }
}

/**
 * 登记**表格帧**：表格内联在幻灯片里。
 *
 * 只要求幻灯片部件存在；**不接受**关系 id（传了即抛错——内联块不该有外部关系）。
 */
export function registerTableFrame(
  graph: PartGraph,
  spec: { readonly slide_path: string; readonly shape_id: number },
): FrameRegistration {
  assertShapeId(spec.shape_id);
  requirePartOfKind(graph, spec.slide_path, 'slide');
  const frame: GraphicFrameDescriptor = Object.freeze({
    slide_path: spec.slide_path,
    shape_id: spec.shape_id,
    kind: 'table' as const,
    part_path: spec.slide_path,
    rel_id: null,
  });
  return Object.freeze({ graph, frame });
}

/**
 * 登记**图表帧**：幻灯片 --`chart`--> 图表部件 --`package`--> 内嵌工作簿。
 *
 * 要求：幻灯片与图表部件都真实存在、并且图表部件**已经**有一条 `package` 关系指向
 * 真实存在的内嵌工作簿部件。任一环缺失 ⇒ 抛错（缺关系 `missing_relationship`，
 * 缺工作簿 `missing_embedded_workbook`），**不**自动补链。
 */
export function registerChartFrame(
  graph: PartGraph,
  spec: { readonly slide_path: string; readonly shape_id: number; readonly chart_path: string; readonly r_id: string },
): FrameRegistration {
  assertShapeId(spec.shape_id);
  requirePartOfKind(graph, spec.slide_path, 'slide');
  requirePartOfKind(graph, spec.chart_path, 'chart');
  assertRelationshipId(spec.r_id);

  const chartRels = outgoingRelationships(graph, spec.chart_path);
  const packageRel = chartRels.find((relationship) => relationship.type === RELATIONSHIP_TYPES.package);
  if (packageRel === undefined) {
    throw new TableChartPartsError(
      'missing_relationship',
      `图表部件 ${spec.chart_path} 没有 package 关系指向内嵌工作簿（缺链，不自动补）`,
    );
  }
  const targetPath = resolveRelationshipTarget(spec.chart_path, packageRel.target);
  const target = requirePart(graph, targetPath);
  if (target.kind !== 'embedded_workbook') {
    throw new TableChartPartsError(
      'missing_embedded_workbook',
      `图表部件 ${spec.chart_path} 的 package 关系指向 ${targetPath}（类别 ${target.kind}），不是内嵌工作簿`,
    );
  }

  const declared = graph.relationships.find(
    (relationship) => relationship.owner_path === spec.slide_path && relationship.r_id === spec.r_id,
  );
  if (declared === undefined) {
    throw new TableChartPartsError(
      'missing_relationship',
      `${spec.slide_path} 没有声明 ${spec.r_id} 指向图表部件（缺链，不自动补）`,
    );
  }
  if (declared.type !== RELATIONSHIP_TYPES.chart) {
    throw new TableChartPartsError(
      'unknown_relationship_type',
      `${spec.slide_path} 的 ${spec.r_id} 类型是 ${declared.type}，不是 chart`,
    );
  }
  if (resolveRelationshipTarget(spec.slide_path, declared.target) !== spec.chart_path) {
    throw new TableChartPartsError(
      'missing_relationship',
      `${spec.slide_path} 的 ${spec.r_id} 指向别处，不是图表部件 ${spec.chart_path}`,
    );
  }

  const frame: GraphicFrameDescriptor = Object.freeze({
    slide_path: spec.slide_path,
    shape_id: spec.shape_id,
    kind: 'chart' as const,
    part_path: spec.chart_path,
    rel_id: spec.r_id,
  });
  return Object.freeze({ graph, frame });
}
