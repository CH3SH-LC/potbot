/**
 * P-I25（由 P-R06 独立复核模块**提升**进 `src/`）· **模型生成内容的来源（provenance）记录**。
 *
 * ## 这一层解决什么
 *
 * 能力目录 §6："所有成品默认不自动添加'已确认事实：''资料引用'等过程栏目；**保留必要的来源
 * 数据与事实校验**"。演示里的每一处**生成内容**（一段正文、一个数字、一个图表点、一个表格格）
 * 都必须能被回答三个问题：
 *
 * 1. **它从哪来？**（{@link ContentOrigin}：模型运行 / 共享事实 / 导入资料 / 用户确认）
 * 2. **它的数字带什么单位？**（{@link Quantity}，见 `units.ts`）
 * 3. **它依据哪一版事实？**（`fact_version`，事实版本坐标）
 *
 * 本模块把这三件事钉成一条**逐内容单元**的记录（{@link ContentProvenanceRecord}），
 * `unit_id` 是内容单元的稳定身份（如 `slide2/shape5/run0`）。构造即校验：
 *
 * - **模型来源必须指名运行**：`provider` / `model_id` / `run_id` / `prompt_ref` 都非空——
 *   "某段文字是模型生成的"若说不出是哪一次运行，就无法追责、也无法复现（`invalid_origin`）；
 * - **事实来源必须带版本**：`fact` 来源必须携带 `fact_version`，且与 `origin.version` 一致；
 * - **无事实来源不得挂版本**：`fact_version` 只在 `fact` 来源下有意义，别处挂上即 `orphan_fact_version`；
 * - **引用非空且可解析**（解析在 {@link buildProvenanceManifest} / `audit.ts` 里做）。
 *
 * ## 与 `fact-sync.ts` 的关系
 *
 * `fact-sync.ts`（PPT-10/P10 域）解决的是"**同一份**演示里文本/表格/图表的数字**同版一致**"。
 * 本层不重复它；本层解决的是"**每一处内容**能不能说出自己的**来源与版本**"——即**归属**
 * （attribution），而不是**一致性**（consistency）。`FactVersion` 形状与 `fact-sync.ts` 的
 * 同名类型**逐字段一致**，因此结构上可互换（见用例交叉断言），但不硬依赖它。
 *
 * 本模块零 IO、零墙钟、不读环境，纯函数。
 */

import {
  buildSourceRegistry,
  formatCitation,
  type CitationRef,
  type SourceDeclaration,
  type SourceRegistry,
} from './citations.js';
import type { Quantity } from './units.js';

// ---------------------------------------------------------------------------
// 事实版本坐标
// ---------------------------------------------------------------------------

/**
 * 事实的**版本坐标**（任务 + 任务版本）。
 *
 * 与 `src/presentations/fact-sync.ts` 的 `FactVersion` **逐字段一致**（结构互换），
 * 此处独立声明以保持本模块零运行期依赖。
 */
export interface FactVersion {
  readonly task_id: string;
  readonly task_revision: number;
}

/** `task@r3` 形式的人类可读版本描述。 */
export function describeFactVersion(version: FactVersion): string {
  return `${version.task_id}@r${String(version.task_revision)}`;
}

/** 两个版本是否同一坐标。 */
export function sameFactVersion(left: FactVersion, right: FactVersion): boolean {
  return left.task_id === right.task_id && left.task_revision === right.task_revision;
}

// ---------------------------------------------------------------------------
// 来源（origin）
// ---------------------------------------------------------------------------

/** 内容来源（判别联合）。 */
export type ContentOrigin =
  | {
      readonly kind: 'model';
      readonly provider: string;
      readonly model_id: string;
      readonly run_id: string;
      readonly prompt_ref: string;
    }
  | {
      readonly kind: 'fact';
      readonly fact_key: string;
      readonly fact_ref: string;
      readonly version: FactVersion;
    }
  | {
      readonly kind: 'document';
      readonly source_id: string;
      readonly locator: string;
    }
  | {
      readonly kind: 'user';
      readonly confirmed_by: string;
      /** 逻辑时间（非墙钟）。 */
      readonly confirmed_at: number;
    };

/** 来源种类枚举（封闭）。 */
export const CONTENT_ORIGIN_KINDS = ['model', 'fact', 'document', 'user'] as const;
export type ContentOriginKind = (typeof CONTENT_ORIGIN_KINDS)[number];

function requireNonEmpty(value: string, field: string): void {
  if (value.length === 0) {
    throw new ProvenanceError('invalid_origin', `${field} 不得为空`);
  }
}

// ---------------------------------------------------------------------------
// 记录
// ---------------------------------------------------------------------------

/** 构造一条 provenance 记录的输入。 */
export interface ContentProvenanceInput {
  /** 内容单元的稳定身份（`slide2/shape5/run0`）。 */
  readonly unit_id: string;
  readonly origin: ContentOrigin;
  readonly citations?: readonly CitationRef[];
  /** 该内容的数值载荷（**带单位**）；纯文本内容为 `null`。 */
  readonly data?: Quantity | null;
  /** 该内容依据的事实版本；仅 `fact` 来源可非空。 */
  readonly fact_version?: FactVersion | null;
}

/** 一条 provenance 记录（构造即校验、冻结）。 */
export interface ContentProvenanceRecord {
  readonly unit_id: string;
  readonly origin: ContentOrigin;
  readonly citations: readonly CitationRef[];
  readonly data: Quantity | null;
  readonly fact_version: FactVersion | null;
}

/** provenance 错误的封闭原因集（结构层）。 */
export const PROVENANCE_ERROR_REASONS = [
  'empty_unit_id',
  'invalid_origin',
  'orphan_fact_version',
  'duplicate_unit_id',
  'citation_unresolved',
] as const;
export type ProvenanceErrorReason = (typeof PROVENANCE_ERROR_REASONS)[number];

/** provenance（来源归属）相关错误。 */
export class ProvenanceError extends Error {
  readonly reason: ProvenanceErrorReason;

  constructor(reason: ProvenanceErrorReason, message: string) {
    super(message);
    this.name = 'ProvenanceError';
    this.reason = reason;
  }
}

function freezeOrigin(origin: ContentOrigin): ContentOrigin {
  switch (origin.kind) {
    case 'model':
      requireNonEmpty(origin.provider, '模型来源的 provider');
      requireNonEmpty(origin.model_id, '模型来源的 model_id');
      requireNonEmpty(origin.run_id, '模型来源的 run_id（说不出哪一次运行即无法归属）');
      requireNonEmpty(origin.prompt_ref, '模型来源的 prompt_ref');
      return Object.freeze({ ...origin });
    case 'fact':
      requireNonEmpty(origin.fact_key, '事实来源的 fact_key');
      requireNonEmpty(origin.fact_ref, '事实来源的 fact_ref');
      requireNonEmpty(origin.version.task_id, '事实来源版本的 task_id');
      if (!Number.isSafeInteger(origin.version.task_revision) || origin.version.task_revision < 0) {
        throw new ProvenanceError(
          'invalid_origin',
          `事实来源版本号必须是非负整数，收到 ${String(origin.version.task_revision)}`,
        );
      }
      return Object.freeze({ ...origin, version: Object.freeze({ ...origin.version }) });
    case 'document':
      requireNonEmpty(origin.source_id, '文档来源的 source_id');
      requireNonEmpty(origin.locator, '文档来源的 locator');
      return Object.freeze({ ...origin });
    case 'user':
      requireNonEmpty(origin.confirmed_by, '用户来源的 confirmed_by');
      if (typeof origin.confirmed_at !== 'number' || !Number.isFinite(origin.confirmed_at)) {
        throw new ProvenanceError(
          'invalid_origin',
          `用户来源的 confirmed_at 必须是有限数（逻辑时间），收到 ${String(origin.confirmed_at)}`,
        );
      }
      return Object.freeze({ ...origin });
    default: {
      // 穷尽性守卫：外部传入未知 kind 时具名报错。
      const unknown = origin as { readonly kind?: unknown };
      throw new ProvenanceError(
        'invalid_origin',
        `未知来源种类 ${String(unknown.kind)}（必须是 ${CONTENT_ORIGIN_KINDS.join(' | ')} 之一）`,
      );
    }
  }
}

/**
 * 构造一条 provenance 记录（构造即校验）。
 *
 * @throws {ProvenanceError}
 * - `empty_unit_id`：`unit_id` 为空；
 * - `invalid_origin`：来源字段非法（模型来源缺 run 信息、事实来源缺键等）；
 * - `orphan_fact_version`：`fact_version` 非空但来源不是 `fact`。
 */
export function contentProvenance(input: ContentProvenanceInput): ContentProvenanceRecord {
  if (input.unit_id.length === 0) {
    throw new ProvenanceError('empty_unit_id', '内容单元 id 不得为空');
  }
  const origin = freezeOrigin(input.origin);
  const factVersion = input.fact_version ?? null;
  if (origin.kind === 'fact') {
    if (factVersion === null) {
      throw new ProvenanceError(
        'invalid_origin',
        `事实来源（键 ${origin.fact_key}）必须携带 fact_version`,
      );
    }
    if (!sameFactVersion(factVersion, origin.version)) {
      throw new ProvenanceError(
        'invalid_origin',
        `事实来源的 fact_version（${describeFactVersion(factVersion)}）与 origin.version` +
          `（${describeFactVersion(origin.version)}）不一致`,
      );
    }
  } else if (factVersion !== null) {
    throw new ProvenanceError(
      'orphan_fact_version',
      `来源不是 fact（而是 ${origin.kind}）却挂了 fact_version ${describeFactVersion(factVersion)}` +
        '：事实版本只在事实来源下有意义',
    );
  }

  return Object.freeze({
    unit_id: input.unit_id,
    origin,
    citations: Object.freeze([...(input.citations ?? [])]),
    data: input.data ?? null,
    fact_version:
      factVersion === null ? null : Object.freeze({ ...factVersion }),
  });
}

// ---------------------------------------------------------------------------
// 清单
// ---------------------------------------------------------------------------

/** 一份 provenance 清单：全部记录 + 来源注册表。 */
export interface ProvenanceManifest {
  readonly records: readonly ContentProvenanceRecord[];
  readonly sources: SourceRegistry;
  /** `unit_id → 记录`；重复 id 在构建时已抛错，故这里是双射。 */
  readonly byUnitId: ReadonlyMap<string, ContentProvenanceRecord>;
}

/**
 * 组装 provenance 清单，并在构建时把**引用解析**也做完。
 *
 * @throws {ProvenanceError} `duplicate_unit_id`（同一 `unit_id` 两条）/ `citation_unresolved`
 *   （记录的某条引用指向未声明来源，而该来源既不在注册表、也不等于该记录文档来源的 `source_id`）。
 */
export function buildProvenanceManifest(
  records: readonly ContentProvenanceRecord[],
  declarations: readonly SourceDeclaration[],
): ProvenanceManifest {
  const sources = buildSourceRegistry(declarations);
  const byUnitId = new Map<string, ContentProvenanceRecord>();
  for (const record of records) {
    if (byUnitId.has(record.unit_id)) {
      throw new ProvenanceError(
        'duplicate_unit_id',
        `内容单元 ${record.unit_id} 登记了两次：必须显式失败而不是任取一条`,
      );
    }
    for (const citation of record.citations) {
      if (!sources.has(citation.source_id)) {
        throw new ProvenanceError(
          'citation_unresolved',
          `内容单元 ${record.unit_id} 的引用指向未声明来源 ${JSON.stringify(citation.source_id)}`,
        );
      }
    }
    byUnitId.set(record.unit_id, record);
  }
  return Object.freeze({
    records: Object.freeze([...records]),
    sources,
    byUnitId,
  });
}

/** 来源种类的人类可读描述（报告用）。 */
export function describeOrigin(origin: ContentOrigin): string {
  switch (origin.kind) {
    case 'model':
      return `model:${origin.provider}/${origin.model_id}#${origin.run_id}(prompt:${origin.prompt_ref})`;
    case 'fact':
      return `fact:${origin.fact_key}@${describeFactVersion(origin.version)}(${origin.fact_ref})`;
    case 'document':
      return `document:${origin.source_id}(${origin.locator})`;
    case 'user':
      return `user:${origin.confirmed_by}@${String(origin.confirmed_at)}`;
  }
}

/**
 * 一行确定性归属描述：`slide2/shape5/run0 ← fact:headcount@t1@r3(f1) · 8 人 · [年报 p.3]`。
 * 便于把 provenance 原样带进报告/日志（脱敏：只带来源身份与单位，不含任何密钥/地址）。
 */
export function formatProvenanceLine(
  record: ContentProvenanceRecord,
  sources: SourceRegistry,
): string {
  const parts = [record.unit_id, '←', describeOrigin(record.origin)];
  if (record.data !== null) {
    parts.push('·', `${record.data.value} ${record.data.unit}`);
  }
  for (const citation of record.citations) {
    parts.push('·', formatCitation(sources, citation));
  }
  return parts.join(' ');
}
