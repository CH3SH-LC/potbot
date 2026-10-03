/**
 * K-I27 模板 id 适配器 —— **目录 id ⇄ 契约 fixture id** 的**唯一收敛点**。
 *
 * ## 背景（K06 披露的 id 方案分叉）
 *
 * 手机内核的模板目录（`catalog.ts`，派生自既有 `src/plugins/catalog.ts`）发射的
 * mobile-v1 `TemplateManifest.id` 是**去前缀的插件 id**：
 * `document / spreadsheet / presentation / meituan / clock / calendar / research`。
 * 而 `contracts/mobile-v1` 已冻结的正例 fixture 里用的是另一套写法：
 *
 *   - `fixtures/success/template-manifest-word.json` → `id: "word-doc"`
 *   - `fixtures/success/template-manifest-meituan.json` → `id: "meituan-order"`
 *   - `fixtures/success/command-create.json` → `payload.templateId: "word-doc"`
 *
 * 契约 schema 对 `id` 只约束 `string, 1..128`，两套写法**都合法**——所以这不是
 * "schema 会拦住"的问题，而是**命名约定分叉**。若放任 W / X / P / M 各线自行给
 * manifest 起 id，四线会各写一套，跨线对不上。本文件把两套 id 的对应关系**收拢到一处**。
 *
 * ## 本文件做什么
 *
 * 1. `TEMPLATE_ID_TABLE`：7 条一一对应的映射行（单表单一来源）。
 * 2. `toContractTemplateId()` / `toCatalogTemplateId()`：**双向**换算，遇到**未知 id 抛错**
 *    （`TemplateIdMappingError`），不返回 `undefined` 让调用方静默降级。
 * 3. 构造期守卫 `assertTemplateIdMapping()`：
 *    - **满射 / 一一对应**：契约 id 不得重复（否则反向查表有歧义）；
 *    - **与目录不漂移**：表的目录 id 集合必须**恰好等于** `catalog.ts` 真实发射的
 *      `TEMPLATE_MANIFEST_IDS`；`src/plugins` 增删模板而没人更新本表 ⇒ **import 期直接抛错**。
 *
 * ## 诚实口径：哪些 id 有 fixture 背书，哪些只是**建议**
 *
 * 只有两条契约 id 有仓库内**真实 fixture 文件**背书（`document → word-doc`、
 * `meituan → meituan-order`），它们的 `provenance` 记为 `'fixture'` 并附 `fixtureRef`。
 * 其余五条（Excel / PPT / 时钟 / 日历 / 资料检索）**当前还没有契约 fixture**，本表按其真实
 * fixture 已显式体现的 `{产品族}-{产物}` 约定给出**建议 id**，`provenance` 记为 `'proposed'`，
 * `fixtureRef` 为 `null`。**建议不等于冻结**：契约冻结（总协调）时以本表为收敛点逐条确认，
 * 确认后把对应行改成 `'fixture'` 并填 `fixtureRef`。本文件**不声称**任何 manifest 已发布或已就绪。
 *
 * 零依赖纯 TS（只读地 import 同目录 `catalog.ts`），不 import node 内建、不读墙钟、无随机。
 */

import { TEMPLATE_MANIFEST_IDS } from './catalog.js';

// ---------------------------------------------------------------------------
// 错误类型与拒因词表
// ---------------------------------------------------------------------------

/** id 适配链路上**全部**可机读拒因（独立于 K06 的 `TEMPLATE_ERROR_CODES`，不共享错误类型）。 */
export const TEMPLATE_ID_MAPPING_ERROR_CODES = [
  /** 传入的 id 不在**目录侧** 7 个规范 id 里。 */
  'unknown_catalog_template_id',
  /** 传入的 id 不在**契约侧** 7 个规范 id 里。 */
  'unknown_contract_template_id',
  /** 表与 `catalog.ts` 的真实目录集合不一致（目录漂移，构造期抛出）。 */
  'mapping_incomplete',
  /** 同一个契约 id 被两行映射（双向映射必须一一对应，构造期抛出）。 */
  'mapping_not_bijective',
] as const;
export type TemplateIdMappingErrorCode = (typeof TEMPLATE_ID_MAPPING_ERROR_CODES)[number];

/** id 适配唯一的错误类型。验收按 `code` 断言。 */
export class TemplateIdMappingError extends Error {
  readonly code: TemplateIdMappingErrorCode;

  /** 触发错误的 id（与目录漂移/非一一对应无关的构造期错误为 null）。 */
  readonly id: string | null;

  constructor(code: TemplateIdMappingErrorCode, detail: string, id: string | null = null) {
    super(`[${code}]${id === null ? '' : `[${id}]`} ${detail}`);
    this.name = 'TemplateIdMappingError';
    this.code = code;
    this.id = id;
  }
}

/** 类型守卫（跨模块 `instanceof` 在打包后可能失效，故同时看 `code`）。 */
export function isTemplateIdMappingError(value: unknown): value is TemplateIdMappingError {
  return (
    value instanceof TemplateIdMappingError ||
    (typeof value === 'object' &&
      value !== null &&
      'code' in value &&
      typeof (value as { code: unknown }).code === 'string' &&
      (TEMPLATE_ID_MAPPING_ERROR_CODES as readonly string[]).includes(
        (value as { code: string }).code,
      ))
  );
}

// ---------------------------------------------------------------------------
// 映射表（单一来源）
// ---------------------------------------------------------------------------

/** 一条映射的**证据等级**：有仓库内真实 fixture 背书，还是仅按约定给出的建议。 */
export type TemplateIdProvenance = 'fixture' | 'proposed';

export interface TemplateIdRow {
  /** 目录侧 id（`catalog.ts` 发射的 `TemplateManifest.id`）。 */
  readonly catalogId: string;
  /** 契约侧 id（W/X/P/M 发布 manifest 时应写入 `id` 与命令 `payload.templateId` 的写法）。 */
  readonly contractId: string;
  readonly provenance: TemplateIdProvenance;
  /** `provenance === 'fixture'` 时指向仓库内真实 fixture（相对仓库根）；否则为 null。 */
  readonly fixtureRef: string | null;
  /** 该行取值的依据（便于冻结时逐条复核）。 */
  readonly note: string;
}

const WORD_MANIFEST_FIXTURE = 'contracts/mobile-v1/fixtures/success/template-manifest-word.json';
const MEITUAN_MANIFEST_FIXTURE =
  'contracts/mobile-v1/fixtures/success/template-manifest-meituan.json';

/**
 * 7 条映射行。**这是本模块的唯一来源**：两侧 id 词表、双向查表、类型都由它导出。
 *
 * 约定（由两条真实 fixture 观察得出）：契约 id = `{产品族}-{产物}`，
 * 产品族取 `word / excel / ppt / meituan / clock / calendar / research`，
 * 产物取该模板实际交付的对象种类（doc / sheet / slides / order / …）。
 */
export const TEMPLATE_ID_TABLE = Object.freeze(
  [
    Object.freeze({
      catalogId: 'document',
      contractId: 'word-doc',
      provenance: 'fixture',
      fixtureRef: WORD_MANIFEST_FIXTURE,
      note: 'fixture 直接背书：template-manifest-word.json 的 id 与 command-create.json 的 payload.templateId 都是 word-doc。',
    }),
    Object.freeze({
      catalogId: 'spreadsheet',
      contractId: 'excel-sheet',
      provenance: 'proposed',
      fixtureRef: null,
      note: '建议（待契约冻结）：按 word-doc 的 {产品族}-{产物} 约定；X 线尚无 manifest fixture。',
    }),
    Object.freeze({
      catalogId: 'presentation',
      contractId: 'ppt-slides',
      provenance: 'proposed',
      fixtureRef: null,
      note: '建议（待契约冻结）：按 word-doc 的 {产品族}-{产物} 约定；P 线尚无 manifest fixture。',
    }),
    Object.freeze({
      catalogId: 'meituan',
      contractId: 'meituan-order',
      provenance: 'fixture',
      fixtureRef: MEITUAN_MANIFEST_FIXTURE,
      note: 'fixture 直接背书：template-manifest-meituan.json 的 id 是 meituan-order。',
    }),
    Object.freeze({
      catalogId: 'clock',
      contractId: 'clock-alarm',
      provenance: 'proposed',
      fixtureRef: null,
      note: '建议（待契约冻结）：时钟模板以闹钟/计时器为主交付物；尚无 fixture。',
    }),
    Object.freeze({
      catalogId: 'calendar',
      contractId: 'calendar-event',
      provenance: 'proposed',
      fixtureRef: null,
      note: '建议（待契约冻结）：日历模板以事件读写为主交付物；尚无 fixture。',
    }),
    Object.freeze({
      catalogId: 'research',
      contractId: 'research-notes',
      provenance: 'proposed',
      fixtureRef: null,
      note: '建议（待契约冻结）：资料检索以带来源的笔记/事实为主交付物；尚无 fixture。',
    }),
  ] as const satisfies readonly TemplateIdRow[],
);

/** 目录侧规范 id（由映射表导出，与 `catalog.ts` 的发射集合做构造期对账）。 */
export type CatalogTemplateId = (typeof TEMPLATE_ID_TABLE)[number]['catalogId'];

/** 契约侧规范 id（由映射表导出）。 */
export type ContractTemplateId = (typeof TEMPLATE_ID_TABLE)[number]['contractId'];

/** 目录侧 7 个 id，按映射表顺序。 */
export const CATALOG_TEMPLATE_IDS: readonly CatalogTemplateId[] = Object.freeze(
  TEMPLATE_ID_TABLE.map((row) => row.catalogId),
);

/** 契约侧 7 个 id，按映射表顺序。 */
export const CONTRACT_TEMPLATE_IDS: readonly ContractTemplateId[] = Object.freeze(
  TEMPLATE_ID_TABLE.map((row) => row.contractId),
);

/** 目录 → 契约。 */
export const CATALOG_TO_CONTRACT_TEMPLATE_ID: Readonly<Record<CatalogTemplateId, ContractTemplateId>> =
  Object.freeze(
    TEMPLATE_ID_TABLE.reduce<Record<string, ContractTemplateId>>((acc, row) => {
      acc[row.catalogId] = row.contractId;
      return acc;
    }, {}),
  ) as Readonly<Record<CatalogTemplateId, ContractTemplateId>>;

/** 契约 → 目录。 */
export const CONTRACT_TO_CATALOG_TEMPLATE_ID: Readonly<Record<ContractTemplateId, CatalogTemplateId>> =
  Object.freeze(
    TEMPLATE_ID_TABLE.reduce<Record<string, CatalogTemplateId>>((acc, row) => {
      acc[row.contractId] = row.catalogId;
      return acc;
    }, {}),
  ) as Readonly<Record<ContractTemplateId, CatalogTemplateId>>;

/** 每条映射的证据引用（`proposed` 为 null）——未冻结的不得伪装成已冻结。 */
export const TEMPLATE_ID_PROVENANCE: Readonly<Record<CatalogTemplateId, TemplateIdProvenance>> =
  Object.freeze(
    TEMPLATE_ID_TABLE.reduce<Record<string, TemplateIdProvenance>>((acc, row) => {
      acc[row.catalogId] = row.provenance;
      return acc;
    }, {}),
  ) as Readonly<Record<CatalogTemplateId, TemplateIdProvenance>>;

// ---------------------------------------------------------------------------
// 构造期守卫：一一对应 + 与真实目录不漂移
// ---------------------------------------------------------------------------

const CATALOG_SET: ReadonlySet<string> = new Set(CATALOG_TEMPLATE_IDS);
const CONTRACT_SET: ReadonlySet<string> = new Set(CONTRACT_TEMPLATE_IDS);
const FORWARD_MAP: ReadonlyMap<string, ContractTemplateId> = new Map(
  TEMPLATE_ID_TABLE.map((row) => [row.catalogId, row.contractId]),
);
const REVERSE_MAP: ReadonlyMap<string, CatalogTemplateId> = new Map(
  TEMPLATE_ID_TABLE.map((row) => [row.contractId, row.catalogId]),
);

/**
 * 校验映射表自洽且与真实目录一致。**在模块 import 期以默认参数调用一次**；任一条不满足即抛错，
 * 使"目录改了、映射没跟上"或"契约 id 撞车"这类问题在加载期暴露，而不是运行期静默错配。
 *
 * 参数可注入（供测试用篡改过的表做反向对照），默认即本模块的真实表与真实目录集合。
 *
 * @throws {TemplateIdMappingError} `mapping_not_bijective` 或 `mapping_incomplete`。
 */
export function assertTemplateIdMapping(
  table: readonly TemplateIdRow[] = TEMPLATE_ID_TABLE,
  emittedCatalogIds: readonly string[] = TEMPLATE_MANIFEST_IDS,
): void {
  // (1) 契约 id 不得重复（双向映射要求一一对应；重复会让 toCatalogTemplateId 有歧义）。
  const seen = new Set<string>();
  for (const row of table) {
    if (seen.has(row.contractId)) {
      throw new TemplateIdMappingError(
        'mapping_not_bijective',
        `契约 id ${row.contractId} 被多行映射：双向映射要求目录 id 与契约 id 一一对应`,
        row.contractId,
      );
    }
    seen.add(row.contractId);
  }

  // (2) 与 catalog.ts 真实发射的目录集合**恰好相等**（多一个/少一个都算漂移）。
  const tableCatalog = new Set<string>(table.map((row) => row.catalogId));
  const emitted = new Set<string>(emittedCatalogIds);
  const missing = [...emitted].filter((id) => !tableCatalog.has(id));
  const extra = [...tableCatalog].filter((id) => !emitted.has(id));
  if (missing.length > 0 || extra.length > 0) {
    throw new TemplateIdMappingError(
      'mapping_incomplete',
      '目录 id 与本适配器不一致：' +
        `目录有而表缺 [${missing.join(', ') || '-'}]；` +
        `表有而目录无 [${extra.join(', ') || '-'}]` +
        '（src/plugins 目录变更后必须同步更新 TEMPLATE_ID_TABLE）',
    );
  }
}

assertTemplateIdMapping();

// ---------------------------------------------------------------------------
// 查询与换算
// ---------------------------------------------------------------------------

/** 是否为规范**目录** id。 */
export function isCatalogTemplateId(id: string): id is CatalogTemplateId {
  return CATALOG_SET.has(id);
}

/** 是否为规范**契约** id。 */
export function isContractTemplateId(id: string): id is ContractTemplateId {
  return CONTRACT_SET.has(id);
}

/**
 * 目录 id → 契约 id。
 *
 * @throws {TemplateIdMappingError} `unknown_catalog_template_id`（不在 7 个规范目录 id 内）。
 */
export function toContractTemplateId(catalogId: string): ContractTemplateId {
  const mapped = FORWARD_MAP.get(catalogId);
  if (mapped === undefined) {
    throw new TemplateIdMappingError(
      'unknown_catalog_template_id',
      `未知的目录模板 id：${catalogId}；已知目录 id 仅 [${CATALOG_TEMPLATE_IDS.join(', ')}]`,
      catalogId,
    );
  }
  return mapped;
}

/**
 * 契约 id → 目录 id。
 *
 * @throws {TemplateIdMappingError} `unknown_contract_template_id`（不在 7 个规范契约 id 内）。
 */
export function toCatalogTemplateId(contractId: string): CatalogTemplateId {
  const mapped = REVERSE_MAP.get(contractId);
  if (mapped === undefined) {
    throw new TemplateIdMappingError(
      'unknown_contract_template_id',
      `未知的契约模板 id：${contractId}；已知契约 id 仅 [${CONTRACT_TEMPLATE_IDS.join(', ')}]`,
      contractId,
    );
  }
  return mapped;
}

/** 取某目录 id 对应映射行（用于核对 `provenance` / `fixtureRef`；未知 id 抛错）。 */
export function templateIdRow(catalogId: string): TemplateIdRow {
  const contractId = toContractTemplateId(catalogId); // 未知 id 立即抛错，不静默降级
  const row = TEMPLATE_ID_TABLE.find((candidate) => candidate.contractId === contractId);
  if (row === undefined) {
    // 构造期守卫已保证不会发生；此处只是类型收窄。
    throw new TemplateIdMappingError(
      'unknown_catalog_template_id',
      `取不到映射行：${catalogId}`,
      catalogId,
    );
  }
  return row;
}
