/**
 * 包级保留物的构造与不变量（合同 R105–R107、R159–R162）。
 *
 * ## 这一层保的是什么
 *
 * R105/R151：模型**之外**的部件（主题、字体表、设置、宏容器……）及其关系、内容类型与**字节**
 * 必须原样保留、导出时写回。所以 `opaque_parts` / `relationships` / `content_types` / `media`
 * 不是"可选装饰"——没有它们，任何一次往返都会把不认识的部件悄悄丢掉。
 *
 * ## 本模块负责的三件事
 *
 * 1. **路径安全**（R160）：部件路径不得路径穿越（`../`）、不得绝对路径、不得反斜杠或盘符。
 *    这条同时挡"读到任意磁盘路径"的口子。
 * 2. **关系 id 确定性**（R106）：新关系只能用**未占用**的 id，且不得重排既有 rId。
 *    `nextRelationshipId` 取"已用最大编号 + 1"（**不复用**被删除的编号），
 *    因为复用可能让残留在不透明部件里的旧引用**静默改指**到新对象。
 * 3. **外部关系不抓取**（R161）：`TargetMode="External"` 只记录，永远不解析成磁盘/网络访问。
 *
 * ## 关于与 `src/artifacts/ooxml/opc.ts` 的重复
 *
 * 那边另有一份 `resolveRelationshipTarget` / 部件路径校验，服务于**产物容器**（artifact）
 * 的装配；本模块服务于**导入的 DOCX 包**。二者语义一致但模型不同，且 R107 要求
 * "转换集中"指的是 XML ↔ 模型的转换，不是把 OPC 路径规则也并到一个模块。
 * 这里**刻意不 import** 另一模块：`src/documents/model/**` 是给 D02/D03/D04 共用的底座，
 * 反向依赖产物层会让"只读的类型骨架"变成一棵会被集成面拖动的大树。
 * 若协调者要求收敛成一处，把规则搬进 `src/documents/units/**` 那样的小模块即可。
 */

import { DocumentModelError, assertModel, valueLabel } from './errors.js';
import type { ContentTypeTable, MediaPart, OpaquePart, RelationshipRecord } from './types.js';

/** R105/R151 的保留口径声明（可写入证据文本）。 */
export const PRESERVATION_STATEMENT =
  '未知部件、关系、内容类型与字节原样保留并在导出时写回；未修改区域不做语义重建（R105/R151）。';

/** R161 的外部关系口径声明。 */
export const EXTERNAL_RELATIONSHIP_POLICY =
  'TargetMode="External" 的关系只记录，不抓取、不解析为本地路径（R161）。';

/** OPC 部件路径的字符面：可打印 ASCII、正斜杠分隔。 */
const ASCII_PRINTABLE = /^[\x20-\x7e]+$/;
/** 关系 id 的规范形态（`rId1`、`rId27`…）。 */
const RELATIONSHIP_ID = /^rId(\d+)$/;
/** 内容类型默认项的扩展名：纯字母数字（OOXML 约定小写，但不强制改写传入值）。 */
const CONTENT_TYPE_EXTENSION = /^[A-Za-z0-9]+$/;
/** URI 方案前缀（用于外部目标的粗判，不做完整 URI 解析）。 */
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

// ---------------------------------------------------------------------------
// 路径安全（R160）
// ---------------------------------------------------------------------------

function pathProblem(path: unknown): string | null {
  if (typeof path !== 'string' || path.length === 0) {
    return '部件路径必须是非空字符串';
  }
  if (!ASCII_PRINTABLE.test(path)) {
    return '部件路径只能是可打印 ASCII（不得含控制字符或非 ASCII）';
  }
  if (path.startsWith('/')) {
    return '部件路径不得以 / 开头（包内路径是相对的）';
  }
  if (path.includes('\\')) {
    return '部件路径必须用 / 分隔，不得含反斜杠';
  }
  const segments = path.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      return `部件路径含非法路径段 ${JSON.stringify(segment)}（R160 路径穿越检查）`;
    }
    if (segment.includes(':')) {
      return `部件路径段不得含 ':'（挡盘符与 URI 方案）：${JSON.stringify(segment)}`;
    }
  }
  return null;
}

/** 该字符串是否是可安全使用的包内部件路径。 */
export function isSafePartPath(path: unknown): boolean {
  return pathProblem(path) === null;
}

/** 断言部件路径安全；不安全即抛 `invalid_part_path`。 */
export function assertSafePartPath(path: unknown, detail: string): string {
  const problem = pathProblem(path);
  if (problem !== null) {
    throw new DocumentModelError('invalid_part_path', `${detail}：${problem}（收到 ${valueLabel(path)}）`);
  }
  return path as string;
}

// ---------------------------------------------------------------------------
// 关系（R106/R160/R161/R162）
// ---------------------------------------------------------------------------

/**
 * 解析内部关系的目标部件路径（相对 owner 所在目录；`/` 开头表示从包根算起）。
 *
 * **只对 `TargetMode="Internal"` 调用**——外部目标不得走这里（R161）。
 * `..` 越过包根即抛 `invalid_relationship_target`（不产出半解析结果）。
 */
export function resolveRelationshipTarget(ownerPartPath: string | null, target: string): string {
  // 关系目标**允许** `..`（如从 `word/document.xml` 指向 `../docProps/core.xml`）——
  // 它是相对于 owner 目录的引用，不是包内部件路径。逃出包根由下面的栈下溢检查兜住。
  // 这里只挡"绝不可能是包内引用"的形态：空串、非可打印字符、反斜杠、URI 方案/盘符。
  assertModel(
    typeof target === 'string' &&
      target.length > 0 &&
      ASCII_PRINTABLE.test(target) &&
      !target.includes('\\') &&
      !target.includes(':'),
    'invalid_relationship_target',
    `关系目标不是合法的包内引用：${valueLabel(target)}`,
  );
  const relativeToRoot = target.startsWith('/') || ownerPartPath === null;
  const base =
    relativeToRoot || ownerPartPath === null
      ? ''
      : ownerPartPath.slice(0, ownerPartPath.lastIndexOf('/') + 1);
  const combined = relativeToRoot ? target.replace(/^\/+/, '') : `${base}${target}`;

  const stack: string[] = [];
  for (const segment of combined.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (stack.length === 0) {
        throw new DocumentModelError(
          'invalid_relationship_target',
          `关系目标 ${JSON.stringify(target)} 逃出包根（owner=${valueLabel(ownerPartPath)}）`,
        );
      }
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  if (stack.length === 0) {
    throw new DocumentModelError(
      'invalid_relationship_target',
      `关系目标 ${JSON.stringify(target)} 解析后为空路径`,
    );
  }
  const resolved = stack.join('/');
  return assertSafePartPath(resolved, '关系解析结果');
}

/** 目标是否带 URI 方案（外部目标粗判；本模块**不**解析也不访问它）。 */
export function isExternalTarget(target: string): boolean {
  return URI_SCHEME.test(target);
}

/** 关系的类型是否属于某后缀（如 `officeDocument`）。类型是完整 URI，故按后缀匹配。 */
export function relationshipTypeHasSuffix(type: string, suffix: string): boolean {
  return type === suffix || type.endsWith(`/${suffix}`);
}

export function createRelationship(input: {
  readonly id: string;
  readonly type: string;
  readonly target: string;
  readonly target_mode: RelationshipRecord['target_mode'];
  readonly owner_part_path: string | null;
}): RelationshipRecord {
  assertModel(
    typeof input.id === 'string' && input.id.length > 0,
    'invalid_relationship',
    `关系 id 必须是非空字符串，收到 ${valueLabel(input.id)}`,
  );
  assertModel(
    typeof input.type === 'string' && input.type.length > 0,
    'invalid_relationship',
    `关系类型必须是非空字符串（关系 id=${input.id}）`,
  );
  assertModel(
    input.target_mode === 'Internal' || input.target_mode === 'External',
    'invalid_relationship',
    `target_mode 必须是 Internal/External，收到 ${valueLabel(input.target_mode)}`,
  );
  assertModel(
    typeof input.target === 'string' && input.target.length > 0,
    'invalid_relationship',
    `关系目标必须是非空字符串（关系 id=${input.id}）`,
  );
  const owner = input.owner_part_path;
  if (owner !== null) {
    assertSafePartPath(owner, `关系 ${input.id} 的归属部件`);
  }
  if (input.target_mode === 'Internal' && isExternalTarget(input.target)) {
    throw new DocumentModelError(
      'invalid_relationship',
      `Internal 关系的目标不得是外部 URI：${JSON.stringify(input.target)}（关系 id=${input.id}）`,
    );
  }
  return {
    id: input.id,
    type: input.type,
    target: input.target,
    target_mode: input.target_mode,
    owner_part_path: owner,
  };
}

/**
 * 下一个未占用的关系 id：**已用最大编号 + 1**（无既有关系则 `rId1`）。
 *
 * 为什么不是"最小空闲编号"：复用被删除的编号，会让残留在不透明部件里的旧引用
 * **静默指向新对象**（R105 要求未知部件的引用不得被无映射重排）。
 * 编号只增不改，代价是编号会变大——这正是 OOXML 里可接受的事实。
 */
export function nextRelationshipId(existing: readonly { readonly id: string }[]): string {
  let max = 0;
  for (const record of existing) {
    const match = RELATIONSHIP_ID.exec(record.id);
    if (match === null) {
      continue;
    }
    const parsed = Number(match[1]);
    if (Number.isFinite(parsed) && parsed > max) {
      max = parsed;
    }
  }
  return `rId${max + 1}`;
}

// ---------------------------------------------------------------------------
// 部件与内容类型
// ---------------------------------------------------------------------------

export function createOpaquePart(input: {
  readonly path: string;
  readonly content_type: string;
  readonly bytes: Uint8Array;
}): OpaquePart {
  assertSafePartPath(input.path, '不透明部件路径');
  assertModel(
    typeof input.content_type === 'string' && input.content_type.length > 0,
    'invalid_node',
    `不透明部件的内容类型必须是非空字符串（path=${input.path}）`,
  );
  assertModel(
    input.bytes instanceof Uint8Array,
    'invalid_node',
    `不透明部件必须携带原始字节（path=${input.path}）`,
  );
  return { path: input.path, content_type: input.content_type, bytes: input.bytes };
}

export function createMediaPart(input: {
  readonly path: string;
  readonly content_type: string;
  readonly relationship_id: string;
  readonly bytes: Uint8Array;
}): MediaPart {
  assertSafePartPath(input.path, '媒体部件路径');
  assertModel(
    typeof input.content_type === 'string' && input.content_type.length > 0,
    'invalid_node',
    `媒体部件的内容类型必须是非空字符串（path=${input.path}）`,
  );
  assertModel(
    typeof input.relationship_id === 'string' && input.relationship_id.length > 0,
    'invalid_node',
    `媒体部件必须绑定关系 id（path=${input.path}）`,
  );
  assertModel(
    input.bytes instanceof Uint8Array,
    'invalid_node',
    `媒体部件必须携带字节（path=${input.path}）`,
  );
  return {
    path: input.path,
    content_type: input.content_type,
    relationship_id: input.relationship_id,
    bytes: input.bytes,
  };
}

/**
 * 构造内容类型表（`defaults` + `overrides`）。
 *
 * 不变量：扩展名不得带前导点、不得重复；覆盖项必须是**绝对部件名**（`/word/document.xml`）
 * 且不重复。违反即抛——内容类型表是导出时"这个部件算什么"的唯一依据，含糊它会直接产出坏包。
 */
export function createContentTypeTable(input: {
  readonly defaults?: readonly { readonly extension: string; readonly content_type: string }[];
  readonly overrides?: readonly { readonly part_name: string; readonly content_type: string }[];
}): ContentTypeTable {
  const defaults = input.defaults ?? [];
  const overrides = input.overrides ?? [];

  const seenExtensions = new Set<string>();
  for (const entry of defaults) {
    assertModel(
      typeof entry.extension === 'string' && CONTENT_TYPE_EXTENSION.test(entry.extension),
      'invalid_content_type_table',
      `内容类型扩展名必须是纯字母数字且不带前导点，收到 ${valueLabel(entry.extension)}`,
    );
    assertModel(
      !seenExtensions.has(entry.extension),
      'invalid_content_type_table',
      `内容类型扩展名重复：${entry.extension}`,
    );
    seenExtensions.add(entry.extension);
    assertModel(
      typeof entry.content_type === 'string' && entry.content_type.length > 0,
      'invalid_content_type_table',
      `扩展名 ${entry.extension} 的内容类型必须是非空字符串`,
    );
  }

  const seenPartNames = new Set<string>();
  for (const entry of overrides) {
    assertModel(
      typeof entry.part_name === 'string' && entry.part_name.startsWith('/'),
      'invalid_content_type_table',
      `覆盖项必须是绝对部件名（以 / 开头），收到 ${valueLabel(entry.part_name)}`,
    );
    assertSafePartPath(entry.part_name.slice(1), '内容类型覆盖项的部件名');
    assertModel(
      !seenPartNames.has(entry.part_name),
      'invalid_content_type_table',
      `内容类型覆盖项重复：${entry.part_name}`,
    );
    seenPartNames.add(entry.part_name);
    assertModel(
      typeof entry.content_type === 'string' && entry.content_type.length > 0,
      'invalid_content_type_table',
      `覆盖项 ${entry.part_name} 的内容类型必须是非空字符串`,
    );
  }

  return { defaults: [...defaults], overrides: [...overrides] };
}

/** 查某个包内部件的内容类型：先查覆盖项，再按扩展名查默认项；都没有返回 `null`。 */
export function findContentType(table: ContentTypeTable, partPath: string): string | null {
  const override = table.overrides.find((entry) => entry.part_name === `/${partPath}`);
  if (override !== undefined) {
    return override.content_type;
  }
  const dotAt = partPath.lastIndexOf('.');
  if (dotAt === -1 || dotAt === partPath.length - 1) {
    return null;
  }
  const extension = partPath.slice(dotAt + 1);
  const fallback = table.defaults.find((entry) => entry.extension === extension);
  return fallback === undefined ? null : fallback.content_type;
}
