/**
 * P06 · 图表**内嵌工作簿**的部件清单（embedded workbook manifest）。
 *
 * ## 这一层解决什么
 *
 * 图表"数据可编辑"的落点是一份**真 XLSX**（`ppt/embeddings/**.xlsx`）。它本身又是一个
 * 小 OPC 包，至少要有：工作簿主部件 + 工作表 + 工作簿的 `_rels` + 包根 `_rels` + 内容类型
 * 默认项。少一份，Office 打开"编辑数据"时就是打不开的图。
 *
 * 本模块不谈 ZIP 字节（那是 `ooxml` 层的事），只产出**清单**：路径 / 角色 / 内容类型，
 * 并把"缺件"变成**具名错误**：
 *
 * - 清单缺角色（工作簿或缺工作表）⇒ `missing_embedded_workbook`；
 * - 清单同一角色登记两次 ⇒ `duplicate_workbook_role`；
 * - 在**外层登记图**里，图表部件的 `package` 关系没落到一个 `embedded_workbook` 部件
 *   ⇒ `missing_embedded_workbook`（缺件）或 `missing_relationship`（缺链），二者区分开。
 *
 * 内嵌包**相对外层**是一份部件；其内部件（`xl/**`）属于**内嵌包自己的根**，不与外层
 * 部件同处一个命名空间，因此清单是**独立**的一张表，而不是塞进外层 `PartGraph`。
 *
 * ## 未验证 / 边界
 *
 * - 只覆盖单工作表（`sheet1.xml`）形状，与 `charts.ts` 的 `renderEmbeddedWorkbookBytes`
 *   同口径；多表 / 定义名 / 共享字符串表本批不做；
 * - 不校验单元格内容与图表的数值一致——那是 `consistency.ts` 的事。
 */

import { TableChartPartsError } from './errors.js';
import {
  DEFAULT_EMBEDDED_WORKBOOK_PATH,
  RELATIONSHIP_TYPES,
  assertPartPath,
  findPart,
  outgoingRelationships,
  partDirectoryOf,
  resolveRelationshipTarget,
  type PartGraph,
} from './parts.js';

/** 内嵌工作簿内的部件角色。 */
export const WORKBOOK_PART_ROLES = ['workbook', 'worksheet', 'workbook_rels', 'content_types'] as const;

export type WorkbookPartRole = (typeof WORKBOOK_PART_ROLES)[number];

/** 必须存在的角色（缺一即"内嵌工作簿不完整"）。 */
export const REQUIRED_WORKBOOK_ROLES: readonly WorkbookPartRole[] = Object.freeze(['workbook', 'worksheet']);

/** 内嵌包头部件（`xl/workbook.xml`）与工作表（`xl/worksheets/sheet1.xml`）的固定内容类型。 */
export const WORKBOOK_CONTENT_TYPES: Readonly<Record<WorkbookPartRole, string>> = Object.freeze({
  workbook: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  worksheet: 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml',
  workbook_rels: 'application/vnd.openxmlformats-package.relationships+xml',
  content_types: 'application/vnd.openxmlformats-package.relationships+xml',
});

/** 清单里的一个内嵌部件（路径**相对于内嵌包根**）。 */
export interface WorkbookPartDescriptor {
  readonly path: string;
  readonly role: WorkbookPartRole;
  readonly content_type: string;
}

/** 内嵌工作簿的部件清单。 */
export interface EmbeddedWorkbookManifest {
  /** 外层包内，该工作簿的**部件路径**。 */
  readonly workbook_path: string;
  /** 外层包内，引用它的**图表部件**路径。 */
  readonly chart_path: string;
  readonly parts: readonly WorkbookPartDescriptor[];
  /** 内嵌包根关系：`_rels/.rels` → `xl/workbook.xml`。 */
  readonly root_relationships: readonly { readonly r_id: string; readonly type: string; readonly target: string }[];
  /** 内嵌包内容类型默认项（`rels`）。 */
  readonly content_type_defaults: readonly { readonly extension: string; readonly content_type: string }[];
}

/** 造一份清单（单一工作表形状；路径可覆写以便多图共存）。 */
export function embeddedWorkbookManifest(
  chartPath: string,
  workbookPath: string = DEFAULT_EMBEDDED_WORKBOOK_PATH,
): EmbeddedWorkbookManifest {
  assertPartPath(chartPath, '图表部件路径');
  assertPartPath(workbookPath, '内嵌工作簿路径');
  return Object.freeze({
    workbook_path: workbookPath,
    chart_path: chartPath,
    parts: Object.freeze([
      makeWorkbookPart('workbook', 'xl/workbook.xml'),
      makeWorkbookPart('worksheet', 'xl/worksheets/sheet1.xml'),
      makeWorkbookPart('workbook_rels', 'xl/_rels/workbook.xml.rels'),
      makeWorkbookPart('content_types', '[Content_Types].xml'),
    ]),
    root_relationships: Object.freeze([
      Object.freeze({ r_id: 'rId1', type: RELATIONSHIP_TYPES.office_document as string, target: 'xl/workbook.xml' }),
    ]),
    content_type_defaults: Object.freeze([
      Object.freeze({ extension: 'rels', content_type: 'application/vnd.openxmlformats-package.relationships+xml' }),
    ]),
  });
}

function makeWorkbookPart(role: WorkbookPartRole, path: string): WorkbookPartDescriptor {
  return Object.freeze({ path, role, content_type: WORKBOOK_CONTENT_TYPES[role] });
}

/** 清单里该角色的部件；无 ⇒ `undefined`。 */
export function workbookPartByRole(
  manifest: EmbeddedWorkbookManifest,
  role: WorkbookPartRole,
): WorkbookPartDescriptor | undefined {
  return manifest.parts.find((part) => part.role === role);
}

/**
 * 校验清单自身：同一角色不得登记两次（`duplicate_workbook_role`），必需角色必须齐备
 * （缺 ⇒ `missing_embedded_workbook`），角色必须在受支持表内（`unknown_workbook_role`），
 * 内嵌路径必须合法。
 */
export function validateEmbeddedWorkbookManifest(manifest: EmbeddedWorkbookManifest): void {
  const seen = new Set<WorkbookPartRole>();
  for (const part of manifest.parts) {
    if (!WORKBOOK_PART_ROLES.includes(part.role)) {
      throw new TableChartPartsError('unknown_workbook_role', `未注册的内嵌部件角色 ${String(part.role)}`);
    }
    if (seen.has(part.role)) {
      throw new TableChartPartsError('duplicate_workbook_role', `内嵌部件角色 ${part.role} 登记了两次`);
    }
    seen.add(part.role);
    assertPartPath(part.path, '内嵌部件路径');
    if (part.content_type !== WORKBOOK_CONTENT_TYPES[part.role]) {
      throw new TableChartPartsError(
        'missing_embedded_workbook',
        `内嵌部件 ${part.path} 的内容类型 ${part.content_type} 与角色 ${part.role} 的口径不符`,
      );
    }
  }
  for (const role of REQUIRED_WORKBOOK_ROLES) {
    if (!seen.has(role)) {
      throw new TableChartPartsError('missing_embedded_workbook', `内嵌工作簿缺少必需要素 ${role}`);
    }
  }
}

/**
 * 在**外层登记图**里要求：图表部件经一条 `package` 关系指向一个真实存在的
 * `embedded_workbook` 部件，返回该部件的路径。
 *
 * - 图表部件缺失 ⇒ `unknown_part`（由 `findPart` 调用点决定，这里明确抛 `missing_relationship`）；
 * - 缺 `package` 关系 ⇒ `missing_relationship`；
 * - 关系目标解析后不存在 / 类别不对 ⇒ `missing_embedded_workbook`。
 */
export function requireEmbeddedWorkbook(graph: PartGraph, chartPath: string): string {
  const chart = findPart(graph, chartPath);
  if (chart === undefined) {
    throw new TableChartPartsError('unknown_part', `登记表里没有图表部件 ${chartPath}`);
  }
  if (chart.kind !== 'chart') {
    throw new TableChartPartsError('wrong_part_kind', `部件 ${chartPath} 类别是 ${chart.kind}，不是 chart`);
  }
  const packageRel = outgoingRelationships(graph, chartPath).find(
    (relationship) => relationship.type === RELATIONSHIP_TYPES.package,
  );
  if (packageRel === undefined) {
    throw new TableChartPartsError(
      'missing_relationship',
      `图表部件 ${chartPath} 没有 package 关系指向内嵌工作簿`,
    );
  }
  const target = resolveRelationshipTarget(chartPath, packageRel.target);
  const part = findPart(graph, target);
  if (part === undefined) {
    throw new TableChartPartsError(
      'missing_embedded_workbook',
      `图表部件 ${chartPath} 指向 ${target}，但该内嵌工作簿部件不存在`,
    );
  }
  if (part.kind !== 'embedded_workbook') {
    throw new TableChartPartsError(
      'missing_embedded_workbook',
      `图表部件 ${chartPath} 指向 ${target}（类别 ${part.kind}），不是内嵌工作簿`,
    );
  }
  // 内嵌工作簿必须登记在 `embeddings` 目录下的 `.xlsx`（与 charts.ts 同口径；不猜别的落点）。
  if (partDirectoryOf(target) !== 'ppt/embeddings' || !target.toLowerCase().endsWith('.xlsx')) {
    throw new TableChartPartsError(
      'missing_embedded_workbook',
      `内嵌工作簿 ${target} 不在 ppt/embeddings/*.xlsx 落点上`,
    );
  }
  return target;
}
