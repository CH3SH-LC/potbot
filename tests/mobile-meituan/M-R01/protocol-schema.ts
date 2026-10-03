/**
 * M-R01 协议 schema 变化分类（零依赖、纯函数）。
 *
 * ## 为什么这块要单独做
 *
 * 平台会改响应信封（加字段、改类型、换枚举）。消费者如果只看"新响应还能解析成功"
 * 就认为兼容，会在**删字段 / 改类型 / 收紧枚举**时静默拿到错值。M-R01 把"两个版本之间
 * 的差异"做成**可机读判定**：{@link classifySchemaChange} 返回 `identical` / `compatible` /
 * `breaking` / `unknown-version`，并逐条给出 reason。
 *
 * 判定口径对齐 `contracts/mobile-v1/README.md` §兼容策略：
 * - **只增不改**：新增**可选**字段、放宽（required→optional）⇒ `compatible`；
 * - **删改必需字段 / 改类型 / 收紧（optional→required）/ 枚举变动 ⇒ `breaking`**；
 * - 同一 `version` 下字段却已漂移 ⇒ `breaking`（版本号没升却改了形状，是最阴的破坏）。
 *
 * ## 如实声明
 *
 * 这些版本号与字段形状是**示例规格**，不是从官方文档核验得到的契约（M01 未核验 endpoint）。
 * 本模块只提供**判定算法**，规格可替换。
 */

export const PROTOCOL_FIELD_TYPES = ['string', 'integer', 'number', 'boolean', 'object', 'array'] as const;
export type ProtocolFieldType = (typeof PROTOCOL_FIELD_TYPES)[number];

/** 单个字段规格。 */
export interface ProtocolFieldSpec {
  readonly name: string;
  readonly type: ProtocolFieldType;
  readonly required: boolean;
  /** 可选：字符串取值域。存在时参与"枚举变动"判定。 */
  readonly enumValues?: readonly string[];
}

/** 一个版本的完整形状规格。 */
export interface ProtocolSchemaSpec {
  readonly version: string;
  readonly fields: readonly ProtocolFieldSpec[];
}

export const SCHEMA_CHANGE_KINDS = ['identical', 'compatible', 'breaking', 'unknown-version'] as const;
export type SchemaChangeKind = (typeof SCHEMA_CHANGE_KINDS)[number];

export interface SchemaChangeVerdict {
  readonly from: string;
  readonly to: string;
  readonly kind: SchemaChangeKind;
  /** 逐条差异说明（空 = 无差异）。 */
  readonly reasons: readonly string[];
  /** 是否存在需要人工迁移的破坏性差异。 */
  readonly requiresMigration: boolean;
}

function byName(fields: readonly ProtocolFieldSpec[]): Map<string, ProtocolFieldSpec> {
  return new Map(fields.map((field) => [field.name, field]));
}

/**
 * 规格自洽性检查：字段名不得重复。返回问题列表（空 = 合法）。
 * 不合法的规格不得进入比较——否则"重复字段名"会掩盖真实差异。
 */
export function validateSchemaSpec(spec: ProtocolSchemaSpec): readonly string[] {
  const problems: string[] = [];
  if (spec.version.trim().length === 0) {
    problems.push('version 不得为空');
  }
  const seen = new Set<string>();
  for (const field of spec.fields) {
    if (seen.has(field.name)) {
      problems.push(`字段名重复：${field.name}`);
    }
    seen.add(field.name);
  }
  return problems;
}

function enumDiff(from: readonly string[] | undefined, to: readonly string[] | undefined): string[] {
  const notes: string[] = [];
  if (from === undefined && to === undefined) return notes;
  const fromSet = new Set(from ?? []);
  const toSet = new Set(to ?? []);
  for (const value of fromSet) {
    if (!toSet.has(value)) notes.push(`枚举值被删除：${value}`);
  }
  for (const value of toSet) {
    if (!fromSet.has(value)) notes.push(`枚举值新增（消费者可能未处理）：${value}`);
  }
  if (from === undefined && to !== undefined) notes.push('由无枚举收紧为枚举');
  if (from !== undefined && to === undefined) notes.push('由枚举放宽为无枚举');
  return notes;
}

/**
 * 比较两个版本规格。**任一 breaking reason ⇒ `breaking`**（breaking 优先于 compatible）；
 * 否则有 compatible reason ⇒ `compatible`；无差异 ⇒ `identical`。
 */
export function classifySchemaChange(from: ProtocolSchemaSpec, to: ProtocolSchemaSpec): SchemaChangeVerdict {
  const reasons: string[] = [];
  const problems = [...validateSchemaSpec(from), ...validateSchemaSpec(to)];
  if (problems.length > 0) {
    return Object.freeze({
      from: from.version,
      to: to.version,
      kind: 'unknown-version',
      reasons: Object.freeze([...problems.map((p) => `规格非法：${p}`), '规格非法不得比较']),
      requiresMigration: true,
    });
  }

  const sameVersion = from.version === to.version;
  const fromMap = byName(from.fields);
  const toMap = byName(to.fields);

  const removals: string[] = [];
  const additions: string[] = [];
  const compatibleNotes: string[] = [];
  const breakingNotes: string[] = [];

  for (const field of from.fields) {
    const next = toMap.get(field.name);
    if (next === undefined) {
      removals.push(`删除字段：${field.name}`);
      continue;
    }
    if (field.type !== next.type) {
      breakingNotes.push(`字段类型改变：${field.name}（${field.type} → ${next.type}）`);
    }
    if (!field.required && next.required) {
      breakingNotes.push(`字段收紧为必需：${field.name}`);
    }
    if (field.required && !next.required) {
      compatibleNotes.push(`字段放宽为可选：${field.name}`);
    }
    for (const note of enumDiff(field.enumValues, next.enumValues)) {
      breakingNotes.push(`字段 ${field.name} ${note}`);
    }
  }
  for (const field of to.fields) {
    if (!fromMap.has(field.name)) {
      if (field.required) {
        breakingNotes.push(`新增必需字段（旧消费者会缺字段）：${field.name}`);
      } else {
        compatibleNotes.push(`新增可选字段：${field.name}`);
      }
      additions.push(field.name);
    }
  }

  if (removals.length > 0) {
    breakingNotes.unshift(...removals);
  }

  let kind: SchemaChangeKind;
  if (breakingNotes.length > 0) {
    kind = 'breaking';
  } else if (compatibleNotes.length > 0 || (sameVersion && (additions.length > 0 || removals.length > 0))) {
    kind = 'compatible';
  } else if (!sameVersion) {
    // 版本号变了但字段完全相同：不算破坏，但值得记一笔。
    kind = 'compatible';
    compatibleNotes.push(`版本号由 ${from.version} 变为 ${to.version}，字段形状未变`);
  } else {
    kind = 'identical';
  }

  if (sameVersion && (breakingNotes.length > 0 || compatibleNotes.length > 0 || additions.length > 0)) {
    // 同版本漂移本身是最危险的一类：版本号没升却改了形状。
    if (!breakingNotes.some((n) => n.startsWith('同版本'))) {
      breakingNotes.unshift(`同版本（${from.version}）下字段形状发生漂移，消费者无法据版本号防御`);
    }
    kind = 'breaking';
  }

  reasons.push(...breakingNotes, ...compatibleNotes);
  return Object.freeze({
    from: from.version,
    to: to.version,
    kind,
    reasons: Object.freeze(reasons),
    // unknown-version 已在上面提前返回，此处 kind 只可能是 identical/compatible/breaking。
    requiresMigration: kind === 'breaking',
  });
}

// ---------------------------------------------------------------------------
// 示例规格登记（可替换；不是从官方文档核验的契约）
// ---------------------------------------------------------------------------

/** 示例：v1 响应信封。 */
export const ENVELOPE_V1: ProtocolSchemaSpec = Object.freeze({
  version: 'wmh5-envelope-v1',
  fields: Object.freeze([
    Object.freeze({ name: 'code', type: 'integer', required: true }),
    Object.freeze({ name: 'msg', type: 'string', required: true }),
    Object.freeze({ name: 'data', type: 'object', required: true }),
  ]),
});

/** 示例：v1.1 —— 新增两个可选字段，属兼容演进。 */
export const ENVELOPE_V1_1: ProtocolSchemaSpec = Object.freeze({
  version: 'wmh5-envelope-v1.1',
  fields: Object.freeze([
    Object.freeze({ name: 'code', type: 'integer', required: true }),
    Object.freeze({ name: 'msg', type: 'string', required: true }),
    Object.freeze({ name: 'data', type: 'object', required: true }),
    Object.freeze({ name: 'traceId', type: 'string', required: false }),
    Object.freeze({ name: 'ext', type: 'object', required: false }),
  ]),
});

/** 示例：v2 —— 改 `code` 类型并新增必需 `requestId`，属破坏性。 */
export const ENVELOPE_V2_BREAKING: ProtocolSchemaSpec = Object.freeze({
  version: 'wmh5-envelope-v2',
  fields: Object.freeze([
    Object.freeze({ name: 'code', type: 'string', required: true }),
    Object.freeze({ name: 'msg', type: 'string', required: true }),
    Object.freeze({ name: 'data', type: 'object', required: true }),
    Object.freeze({ name: 'requestId', type: 'string', required: true }),
  ]),
});

export const ENVELOPE_REGISTRY: readonly ProtocolSchemaSpec[] = Object.freeze([
  ENVELOPE_V1,
  ENVELOPE_V1_1,
  ENVELOPE_V2_BREAKING,
]);

/** 按版本号取规格；未登记返回 undefined（调用方不得据此假设兼容）。 */
export function lookupEnvelopeSpec(version: string): ProtocolSchemaSpec | undefined {
  return ENVELOPE_REGISTRY.find((spec) => spec.version === version);
}
