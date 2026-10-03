/**
 * P-I25 · **归属清单的部件序列化**（把 {@link ProvenanceManifest} 变成能随 PPTX 一起走的部件字节）。
 *
 * ## 这一层解决什么
 *
 * P-R06 的 provenance 层只在**内存**里判定来源 / 单位 / 版本；"导出成 PPTX 后，来源与版本
 * 还跟不跟着文件走"当时**未接**（见 P-R06 README「已知局限」）。本模块把清单落成一个
 * **确定性、可读回**的 OPC 部件：`customXml/potbot-provenance.json`。
 *
 * 选 JSON sidecar 而非自定义 XML 的理由：清单里既有自由文本（标题、引文）又有结构化数字，
 * 序列化 XML 需要一整套转义 / CDATA 规则，读回时任何一处不精确都会让"重开后再审计"失败；
 * JSON 用同一套 `JSON.parse` / `JSON.stringify` 往返，判据可判定。部件仍由**独立内容类型**
 * （`PROVENANCE_PART_CONTENT_TYPE`）标注，并挂一条**独立关系类型**
 * （`PROVENANCE_RELATIONSHIP_TYPE`）从 `ppt/presentation.xml` 指向它——因此它在包里是一个
 * 被显式声明的部件，不是"没人认领的野字节"。
 *
 * ## 确定性
 *
 * - `sources` 按**声明顺序**（`SourceRegistry.ids()` 的顺序）；
 * - `records` 按 `unit_id` 升序；
 * - 对象键顺序由构造顺序固定；`JSON.stringify(part, null, 2)` 逐字符稳定。
 * 同一份清单序列化两次 ⇒ 逐字节相同（用例断言）。
 *
 * ## 读回即校验
 *
 * {@link parseProvenancePart} 不直接把 JSON 当清单用：它逐条走回
 * {@link contentProvenance}（构造即校验）+ {@link buildProvenanceManifest}（查重 + 引用解析）。
 * 因此"读回后能审计"不是一句声明——读回失败或字段非法会具名抛 {@link ProvenancePartError}。
 *
 * 本模块零 IO、零墙钟、不读环境，纯函数。
 */

import {
  makeCitation,
  type CitationRef,
  type SourceDeclaration,
  type SourceOrigin,
} from './citations.js';
import {
  buildProvenanceManifest,
  contentProvenance,
  type ContentOrigin,
  type ContentProvenanceRecord,
  type FactVersion,
  type ProvenanceManifest,
} from './model.js';
import { parseQuantity, type Quantity } from './units.js';

// ---------------------------------------------------------------------------
// 部件身份常量
// ---------------------------------------------------------------------------

/** 归属清单部件的包内路径（OPC 正向斜杠、无前导斜杠）。 */
export const PROVENANCE_PART_PATH = 'customXml/potbot-provenance.json';

/** 归属清单部件的内容类型（写进 `[Content_Types].xml` 的 `Override`）。 */
export const PROVENANCE_PART_CONTENT_TYPE = 'application/vnd.potbot.presentation-provenance+json';

/** 指向归属清单部件的独立关系类型（挂在 `ppt/presentation.xml` 上）。 */
export const PROVENANCE_RELATIONSHIP_TYPE =
  'http://schemas.potbot.dev/officeDocument/2026/relationships/provenance';

/** 清单部件的 schema 标识（版本化，读回时精确核对）。 */
export const PROVENANCE_PART_SCHEMA = 'potbot.presentation.provenance/1';

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/** 部件序列化 / 读回错误的封闭原因集。 */
export const PROVENANCE_PART_ERROR_REASONS = [
  'malformed_json',
  'unknown_schema',
  'missing_target_version',
  'invalid_source',
  'invalid_record',
  'not_an_object',
  'part_missing',
  'conflicting_manifest',
] as const;
export type ProvenancePartErrorReason = (typeof PROVENANCE_PART_ERROR_REASONS)[number];

/** 部件序列化 / 读回错误。 */
export class ProvenancePartError extends Error {
  readonly reason: ProvenancePartErrorReason;

  constructor(reason: ProvenancePartErrorReason, message: string) {
    super(message);
    this.name = 'ProvenancePartError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// 线上表示（可 JSON 化的镜像，字段名与内存模型逐字段一致）
// ---------------------------------------------------------------------------

/** 序列化后的量（与 {@link Quantity} 同字段）。 */
export interface SerializedQuantity {
  readonly value: number;
  readonly unit: string;
  readonly currency: string | null;
}

/** 序列化后的引用（与 {@link CitationRef} 同字段）。 */
export interface SerializedCitation {
  readonly source_id: string;
  readonly locator: string;
  readonly quote: string | null;
}

/** 序列化后的记录（`origin` 直接复用判别联合，天然可 JSON 化）。 */
export interface SerializedProvenanceRecord {
  readonly unit_id: string;
  readonly origin: ContentOrigin;
  readonly citations: readonly SerializedCitation[];
  readonly data: SerializedQuantity | null;
  readonly fact_version: FactVersion | null;
}

/** 归属清单部件的完整线上表示。 */
export interface SerializedProvenancePart {
  readonly schema: string;
  readonly target_version: FactVersion;
  readonly sources: readonly SourceDeclaration[];
  readonly records: readonly SerializedProvenanceRecord[];
}

/** 读回结果：重建出的清单 + 目标事实版本。 */
export interface ParsedProvenancePart {
  readonly manifest: ProvenanceManifest;
  readonly target_version: FactVersion;
}

// ---------------------------------------------------------------------------
// 序列化
// ---------------------------------------------------------------------------

/** 取清单里的来源声明（稳定顺序 = 注册表声明顺序）。 */
export function provenanceDeclarations(manifest: ProvenanceManifest): readonly SourceDeclaration[] {
  const declarations: SourceDeclaration[] = [];
  for (const id of manifest.sources.ids()) {
    const declaration = manifest.sources.get(id);
    if (declaration === undefined) {
      // 注册表自己保证 `ids()` 里的每个 id 都能 `get` 到；这里只是类型收敛。
      throw new ProvenancePartError('invalid_source', `来源注册表声称有 ${id}，却取不到声明`);
    }
    declarations.push(declaration);
  }
  return declarations;
}

function serializeQuantity(quantity: Quantity | null): SerializedQuantity | null {
  if (quantity === null) return null;
  return { value: quantity.value, unit: quantity.unit, currency: quantity.currency };
}

function serializeCitation(citation: CitationRef): SerializedCitation {
  return { source_id: citation.source_id, locator: citation.locator, quote: citation.quote };
}

function serializeRecord(record: ContentProvenanceRecord): SerializedProvenanceRecord {
  return {
    unit_id: record.unit_id,
    origin: record.origin,
    citations: record.citations.map(serializeCitation),
    data: serializeQuantity(record.data),
    fact_version: record.fact_version,
  };
}

/**
 * 把清单 + 目标事实版本序列化成部件文本（确定性、末尾带换行）。
 *
 * `records` 按 `unit_id` 升序稳定输出，`sources` 按声明顺序——同一输入逐字节可复现。
 */
export function serializeProvenanceManifest(
  manifest: ProvenanceManifest,
  targetVersion: FactVersion,
): string {
  const records = [...manifest.records]
    .sort((left, right) => (left.unit_id < right.unit_id ? -1 : left.unit_id > right.unit_id ? 1 : 0))
    .map(serializeRecord);
  const part: SerializedProvenancePart = {
    schema: PROVENANCE_PART_SCHEMA,
    target_version: { task_id: targetVersion.task_id, task_revision: targetVersion.task_revision },
    sources: provenanceDeclarations(manifest),
    records,
  };
  return `${JSON.stringify(part, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// 读回
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asFactVersion(value: unknown, context: string): FactVersion {
  if (!isRecord(value)) {
    throw new ProvenancePartError('missing_target_version', `${context} 不是对象`);
  }
  const taskId = value['task_id'];
  const revision = value['task_revision'];
  if (typeof taskId !== 'string' || taskId.length === 0 || typeof revision !== 'number') {
    throw new ProvenancePartError(
      'missing_target_version',
      `${context} 缺 task_id / task_revision（收到 ${JSON.stringify(value)}）`,
    );
  }
  return { task_id: taskId, task_revision: revision };
}

function asDeclaration(value: unknown, index: number): SourceDeclaration {
  if (!isRecord(value)) {
    throw new ProvenancePartError('invalid_source', `来源 #${String(index)} 不是对象`);
  }
  const sourceId = value['source_id'];
  const title = value['title'];
  const origin = value['origin'];
  const retrievedAt = value['retrieved_at'];
  if (typeof sourceId !== 'string' || typeof title !== 'string' || typeof origin !== 'string') {
    throw new ProvenancePartError(
      'invalid_source',
      `来源 #${String(index)} 缺 source_id / title / origin`,
    );
  }
  if (retrievedAt !== null && typeof retrievedAt !== 'string') {
    throw new ProvenancePartError(
      'invalid_source',
      `来源 ${sourceId} 的 retrieved_at 必须是字符串或 null`,
    );
  }
  return {
    source_id: sourceId,
    title,
    origin: origin as SourceOrigin,
    retrieved_at: retrievedAt,
  };
}

function asQuantity(value: unknown, unitId: string): Quantity | null {
  if (value === null) return null;
  if (!isRecord(value)) {
    throw new ProvenancePartError('invalid_record', `${unitId} 的 data 不是对象也不是 null`);
  }
  const amount = value['value'];
  const unit = value['unit'];
  const currency = value['currency'];
  if (typeof amount !== 'number' || typeof unit !== 'string') {
    throw new ProvenancePartError('invalid_record', `${unitId} 的 data 缺 value / unit`);
  }
  if (currency !== null && typeof currency !== 'string') {
    throw new ProvenancePartError('invalid_record', `${unitId} 的 data.currency 必须是字符串或 null`);
  }
  return parseQuantity(amount, unit, currency);
}

function asRecordInput(value: unknown, index: number): Parameters<typeof contentProvenance>[0] {
  if (!isRecord(value)) {
    throw new ProvenancePartError('invalid_record', `记录 #${String(index)} 不是对象`);
  }
  const unitId = value['unit_id'];
  const origin = value['origin'];
  const citations = value['citations'];
  if (typeof unitId !== 'string' || !isRecord(origin)) {
    throw new ProvenancePartError('invalid_record', `记录 #${String(index)} 缺 unit_id / origin`);
  }
  const citationList = Array.isArray(citations) ? citations : [];
  const parsedCitations: CitationRef[] = citationList.map((entry, citationIndex) => {
    if (!isRecord(entry)) {
      throw new ProvenancePartError(
        'invalid_record',
        `${unitId} 的引用 #${String(citationIndex)} 不是对象`,
      );
    }
    const sourceId = entry['source_id'];
    const locator = entry['locator'];
    const quote = entry['quote'];
    if (typeof sourceId !== 'string' || typeof locator !== 'string') {
      throw new ProvenancePartError(
        'invalid_record',
        `${unitId} 的引用 #${String(citationIndex)} 缺 source_id / locator`,
      );
    }
    return makeCitation({
      source_id: sourceId,
      locator,
      quote: typeof quote === 'string' ? quote : null,
    });
  });
  const factVersionRaw = value['fact_version'];
  const factVersion =
    factVersionRaw === null || factVersionRaw === undefined
      ? null
      : asFactVersion(factVersionRaw, `${unitId} 的 fact_version`);
  return {
    unit_id: unitId,
    origin: origin as unknown as ContentOrigin,
    citations: parsedCitations,
    data: asQuantity(value['data'] ?? null, unitId),
    fact_version: factVersion,
  };
}

/**
 * 从部件文本读回清单（读回即校验）。
 *
 * @throws {ProvenancePartError}
 * - `malformed_json`：不是合法 JSON；
 * - `not_an_object`：顶层不是对象；
 * - `unknown_schema`：`schema` 不等于 {@link PROVENANCE_PART_SCHEMA}；
 * - `missing_target_version`：缺 `target_version` 或缺字段；
 * - `invalid_source` / `invalid_record`：来源 / 记录字段非法；
 * - 记录级校验失败会**原样**抛出 `contentProvenance` / `parseQuantity` 的具名错误
 *   （`ProvenanceError` / `ProvenanceUnitError`），因为它们更精确。
 */
export function parseProvenancePart(text: string): ParsedProvenancePart {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ProvenancePartError('malformed_json', `归属部件不是合法 JSON：${detail}`);
  }
  if (!isRecord(parsed)) {
    throw new ProvenancePartError('not_an_object', '归属部件顶层必须是对象');
  }
  if (parsed['schema'] !== PROVENANCE_PART_SCHEMA) {
    throw new ProvenancePartError(
      'unknown_schema',
      `归属部件 schema 是 ${JSON.stringify(parsed['schema'])}，` +
        `期望 ${PROVENANCE_PART_SCHEMA}`,
    );
  }
  if (parsed['target_version'] === undefined) {
    throw new ProvenancePartError('missing_target_version', '归属部件缺 target_version');
  }
  const targetVersion = asFactVersion(parsed['target_version'], 'target_version');

  const rawSources = parsed['sources'];
  if (!Array.isArray(rawSources)) {
    throw new ProvenancePartError('invalid_source', '归属部件 sources 必须是数组');
  }
  const declarations = rawSources.map((entry, index) => asDeclaration(entry, index));

  const rawRecords = parsed['records'];
  if (!Array.isArray(rawRecords)) {
    throw new ProvenancePartError('invalid_record', '归属部件 records 必须是数组');
  }
  const records = rawRecords.map((entry, index) => contentProvenance(asRecordInput(entry, index)));

  const manifest = buildProvenanceManifest(records, declarations);
  return Object.freeze({ manifest, target_version: targetVersion });
}
