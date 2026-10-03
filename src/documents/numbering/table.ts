/**
 * 编号表的构造与修改（WF-039–042）。
 *
 * ## 列表隔离是这一层的**结构性**保证，不是"小心一点"
 *
 * WF-041 要求"重启一个列表**不影响**另一个列表"，判据直接写进了任务书。做到它靠两条设计：
 *
 * 1. **重启 = 新建实例**。`restartList` 返回一个**新的** `num_id`，起始值写在**新实例**
 *    的 `lvlOverride` 上；那个老实例的字节**一个都没动**。于是"另一个列表"不可能受影响
 *    ——不是"实现时记得别改"，而是"没有可改的路径"。
 * 2. **改符号遇共享抽象则克隆**。`updateLevelForInstance` 发现该抽象被多个实例共享时，
 *    把抽象**复制一份**给本次调用的实例用（`mutateLevelForInstance`）。否则"改 A 列表的
 *    符号"会顺着共享的 `abstractNum` 悄悄改掉 B 列表——这正是真实文档里最常见的一种串扰。
 *
 * ## 与段落层的关系
 *
 * 本文件只碰**编号表**；段落里的 `numbering` 引用由 `apply.ts` 改。两者分开，
 * 是因为"插入一个列表项"和"这份列表从几开始"是不同作用域的操作（R132 的操作类型区分）。
 */

import type { IndentAmount, Length } from '../model/types.js';
import {
  MAX_LIST_LEVEL,
  chars,
  cm,
  type AbstractNumbering,
  type CounterFormat,
  type LevelOverride,
  type ListKind,
  type ListLevelDefinition,
  type ListLevelFormat,
  type NumberingInstance,
  type NumberingTable,
} from './types.js';

// ---------------------------------------------------------------------------
// 结果类型
// ---------------------------------------------------------------------------

/** 编号表操作的失败码（封闭集合，供上层机械分支；R154）。 */
export type NumberingProblemCode =
  /** `num_id` 在表里不存在。 */
  | 'unknown_instance'
  /** 实例指向的抽象定义不存在（坏引用）。 */
  | 'unknown_abstract'
  /** 该级没有定义，且无法从抽象继承。 */
  | 'level_not_defined'
  /** 级别下标不在 0–8。 */
  | 'invalid_level'
  /** id 已被占用。 */
  | 'duplicate_id'
  /** 定义本身不合法（空级别表、起始值非正整数等）。 */
  | 'invalid_definition';

export interface NumberingFailure {
  readonly ok: false;
  readonly code: NumberingProblemCode;
  readonly detail: string;
}

export interface NumberingTableResult {
  readonly ok: true;
  readonly table: NumberingTable;
}

function fail(code: NumberingProblemCode, detail: string): NumberingFailure {
  return { ok: false, code, detail };
}

function assertLevel(level: number, what: string): NumberingFailure | null {
  if (!Number.isInteger(level) || level < 0 || level > MAX_LIST_LEVEL) {
    return fail('invalid_level', `${what}必须是 0–${String(MAX_LIST_LEVEL)} 的整数，收到 ${JSON.stringify(level)}`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

export function findAbstract(table: NumberingTable, abstractNumId: string): AbstractNumbering | null {
  return table.abstract.find((entry) => entry.abstract_num_id === abstractNumId) ?? null;
}

export function findInstance(table: NumberingTable, numId: string): NumberingInstance | null {
  return table.instances.find((entry) => entry.num_id === numId) ?? null;
}

/** 引用了某抽象定义的实例数（>1 说明"改抽象会串扰"，`updateLevelForInstance` 据此克隆）。 */
export function instancesSharingAbstract(table: NumberingTable, abstractNumId: string): readonly string[] {
  return table.instances
    .filter((instance) => instance.abstract_num_id === abstractNumId)
    .map((instance) => instance.num_id);
}

/** 该实例某级的**有效**定义：优先用实例的整级覆盖，否则用抽象定义。 */
export function effectiveLevelDefinition(
  table: NumberingTable,
  numId: string,
  level: number,
): ListLevelDefinition | null {
  const instance = findInstance(table, numId);
  if (instance === null) {
    return null;
  }
  const override = instance.overrides.find((entry) => entry.level === level);
  if (override !== undefined && override.level_definition !== null) {
    return override.level_definition;
  }
  const abstract = findAbstract(table, instance.abstract_num_id);
  if (abstract === null) {
    return null;
  }
  return abstract.levels.find((entry) => entry.level === level) ?? null;
}

/** 该实例某级的**有效起始值**（实例覆盖优先）。 */
export function effectiveStart(table: NumberingTable, numId: string, level: number): number | null {
  const instance = findInstance(table, numId);
  if (instance === null) {
    return null;
  }
  const override = instance.overrides.find((entry) => entry.level === level);
  if (override !== undefined && override.start_override !== null) {
    return override.start_override;
  }
  return effectiveLevelDefinition(table, numId, level)?.start ?? null;
}

// ---------------------------------------------------------------------------
// id 分配（确定性：取未占用的最小正整数 / 最小可用后缀）
// ---------------------------------------------------------------------------

function nextNumericId(used: readonly string[], prefix = ''): string {
  const taken = new Set(used);
  for (let candidate = 1; ; candidate += 1) {
    const id = `${prefix}${String(candidate)}`;
    if (!taken.has(id)) {
      return id;
    }
  }
}

export function nextAbstractNumId(table: NumberingTable): string {
  return nextNumericId(table.abstract.map((entry) => entry.abstract_num_id), 'abs');
}

export function nextNumId(table: NumberingTable): string {
  return nextNumericId(table.instances.map((entry) => entry.num_id));
}

// ---------------------------------------------------------------------------
// 常规列表的默认几何（9 级）
// ---------------------------------------------------------------------------

/** Word 风格的默认符号序列（纯 Unicode，避免依赖 Symbol/Wingdings 字体可用性）。 */
export const DEFAULT_BULLET_SYMBOLS: readonly string[] = Object.freeze([
  '•', // •
  'o',
  '▪', // ▪
  '§', // §
  '•',
  'o',
  '▪',
  '§',
  '•',
]);

/** 默认缩进：第 n 级左缩进 0.74×(n+1) cm、悬挂 0.74 cm（Word 的经典几何）。 */
export function defaultLevelIndent(level: number): { left: Length; hanging: Length } {
  const leftCm = Math.round(0.74 * (level + 1) * 100) / 100;
  return { left: cm(leftCm), hanging: cm(0.74) };
}

/** 多级编号的默认模板：1 级 `%1.`、2 级 `%1.%2.`、3 级 `%1.%2.%3.` … */
export function defaultNumberTemplate(level: number): string {
  const parts: string[] = [];
  for (let index = 0; index <= level; index += 1) {
    parts.push(`%${String(index + 1)}`);
  }
  return `${parts.join('.')}.`;
}

/** 构造一个级别的默认定义（未给出的字段用 Word 默认几何补齐）。 */
export function levelDefinition(
  level: number,
  format: ListLevelFormat,
  overrides: Partial<Omit<ListLevelDefinition, 'level' | 'format'>> = {},
): ListLevelDefinition {
  return {
    level,
    format,
    text_template:
      overrides.text_template ??
      (format === 'bullet'
        ? (DEFAULT_BULLET_SYMBOLS[level] ?? '•')
        : format === 'none'
          ? ''
          : defaultNumberTemplate(level)),
    start: overrides.start ?? 1,
    indent_left: overrides.indent_left ?? defaultLevelIndent(level).left,
    indent_hanging: overrides.indent_hanging ?? defaultLevelIndent(level).hanging,
    style_ref: overrides.style_ref ?? null,
    alignment: overrides.alignment ?? 'left',
    bullet_font: overrides.bullet_font ?? (format === 'bullet' ? 'Symbol' : null),
    restart_after_level: overrides.restart_after_level ?? null,
  };
}

/** 生成 9 级标准定义（项目符号或编号）。`formats` 可逐级指定，缺省按 `kind` 推。 */
export function standardLevels(
  kind: ListKind,
  options: { readonly formats?: readonly ListLevelFormat[]; readonly start?: number } = {},
): readonly ListLevelDefinition[] {
  const levels: ListLevelDefinition[] = [];
  for (let level = 0; level <= MAX_LIST_LEVEL; level += 1) {
    const format: ListLevelFormat = options.formats?.[level] ?? (kind === 'bullet' ? 'bullet' : 'decimal');
    // 起始值只作用于第 1 级：多级列表里"从 5 开始"说的是顶层编号，
    // 子级各自由其上级重启规则决定（否则会出现 5.5. 这种两级同起的怪相）。
    const overrides = level === 0 && options.start !== undefined ? { start: options.start } : {};
    levels.push(levelDefinition(level, format, overrides));
  }
  return levels;
}

// ---------------------------------------------------------------------------
// 构造
// ---------------------------------------------------------------------------

export interface CreateListSpec {
  /** 便捷大类；给了 `levels` 时忽略。 */
  readonly kind?: ListKind;
  /** 显式级别定义；未给时按 `kind` 用 `standardLevels` 生成。 */
  readonly levels?: readonly ListLevelDefinition[];
  readonly formats?: readonly ListLevelFormat[];
  readonly start?: number;
  /** 指定抽象 id（缺省自动取号）。 */
  readonly abstract_num_id?: string;
  /** 指定实例 id（缺省自动取号）。 */
  readonly num_id?: string;
}

export interface CreateListResult extends NumberingTableResult {
  readonly num_id: string;
  readonly abstract_num_id: string;
}

/**
 * 新建一份列表定义（抽象 + 实例），返回新的编号表与新的 `num_id`。
 *
 * **不改动既有任何实例**——这是"新建列表不会误改旧列表"的结构性理由。
 */
export function createList(table: NumberingTable, spec: CreateListSpec = {}): CreateListResult | NumberingFailure {
  const abstractNumId = spec.abstract_num_id ?? nextAbstractNumId(table);
  const numId = spec.num_id ?? nextNumId(table);

  if (findAbstract(table, abstractNumId) !== null) {
    return fail('duplicate_id', `抽象定义 id ${JSON.stringify(abstractNumId)} 已被占用`);
  }
  if (findInstance(table, numId) !== null) {
    return fail('duplicate_id', `编号实例 id ${JSON.stringify(numId)} 已被占用`);
  }

  const levels = spec.levels ?? standardLevels(spec.kind ?? 'bullet', {
    ...(spec.formats === undefined ? {} : { formats: spec.formats }),
    ...(spec.start === undefined ? {} : { start: spec.start }),
  });

  if (levels.length === 0) {
    return fail('invalid_definition', '抽象编号定义至少要有一级');
  }
  const seen = new Set<number>();
  for (const level of levels) {
    const levelProblem = assertLevel(level.level, '级别下标');
    if (levelProblem !== null) {
      return levelProblem;
    }
    if (seen.has(level.level)) {
      return fail('invalid_definition', `级别 ${String(level.level)} 重复定义`);
    }
    seen.add(level.level);
    if (!Number.isInteger(level.start) || level.start < 1) {
      return fail('invalid_definition', `级别 ${String(level.level)} 的起始值必须是 ≥1 的整数，收到 ${JSON.stringify(level.start)}`);
    }
  }

  const abstract: AbstractNumbering = {
    abstract_num_id: abstractNumId,
    multi_level_type: levels.length > 1 ? 'multilevel' : 'singleLevel',
    levels: [...levels].sort((a, b) => a.level - b.level),
  };
  const instance: NumberingInstance = {
    num_id: numId,
    abstract_num_id: abstractNumId,
    overrides: [],
  };
  return {
    ok: true,
    table: {
      abstract: [...table.abstract, abstract],
      instances: [...table.instances, instance],
    },
    num_id: numId,
    abstract_num_id: abstractNumId,
  };
}

// ---------------------------------------------------------------------------
// 修改级别（含"共享抽象则克隆"的隔离）
// ---------------------------------------------------------------------------

/**
 * 改某实例某级的定义，**只影响该实例**。
 *
 * 三档处理：
 * 1. 该级已被本实例的 `lvlOverride` 整级替换 ⇒ 改那份替换；
 * 2. 抽象被**多个**实例共享 ⇒ 克隆抽象给本实例，改克隆；
 * 3. 否则直接改抽象（独占，无串扰风险）。
 */
export function updateLevelForInstance(
  table: NumberingTable,
  numId: string,
  level: number,
  mutate: (current: ListLevelDefinition) => ListLevelDefinition,
): NumberingTableResult | NumberingFailure {
  const levelProblem = assertLevel(level, '级别下标');
  if (levelProblem !== null) {
    return levelProblem;
  }
  const instance = findInstance(table, numId);
  if (instance === null) {
    return fail('unknown_instance', `编号实例 ${JSON.stringify(numId)} 不存在`);
  }
  const current = effectiveLevelDefinition(table, numId, level);
  if (current === null) {
    return fail('level_not_defined', `实例 ${JSON.stringify(numId)} 的第 ${String(level)} 级没有定义`);
  }
  const next = mutate(current);

  const existingOverride = instance.overrides.find((entry) => entry.level === level);
  if (existingOverride !== undefined && existingOverride.level_definition !== null) {
    // 档 1：改实例自己的整级覆盖。
    return {
      ok: true,
      table: replaceInstance(table, {
        ...instance,
        overrides: instance.overrides.map((entry) =>
          entry.level === level ? { ...entry, level_definition: next } : entry,
        ),
      }),
    };
  }

  const abstract = findAbstract(table, instance.abstract_num_id);
  if (abstract === null) {
    return fail('unknown_abstract', `实例 ${JSON.stringify(numId)} 指向的抽象定义 ${JSON.stringify(instance.abstract_num_id)} 不存在`);
  }

  const sharers = instancesSharingAbstract(table, abstract.abstract_num_id);
  if (sharers.length > 1) {
    // 档 2：克隆抽象，只把本实例指过去。
    const cloneId = nextAbstractNumId(table);
    const clone: AbstractNumbering = {
      ...abstract,
      abstract_num_id: cloneId,
      levels: abstract.levels.map((entry) => (entry.level === level ? next : entry)),
    };
    return {
      ok: true,
      table: {
        abstract: [...table.abstract, clone],
        instances: table.instances.map((entry) =>
          entry.num_id === numId ? { ...entry, abstract_num_id: cloneId } : entry,
        ),
      },
    };
  }

  // 档 3：独占抽象，直接改。
  return {
    ok: true,
    table: {
      abstract: table.abstract.map((entry) =>
        entry.abstract_num_id === abstract.abstract_num_id
          ? { ...entry, levels: entry.levels.map((item) => (item.level === level ? next : item)) }
          : entry,
      ),
      instances: table.instances,
    },
  };
}

function replaceInstance(table: NumberingTable, instance: NumberingInstance): NumberingTable {
  return {
    abstract: table.abstract,
    instances: table.instances.map((entry) => (entry.num_id === instance.num_id ? instance : entry)),
  };
}

/** 改列表符号（WF-039）：只影响这一份列表，**不伪造正文前缀**。 */
export function setLevelBulletSymbol(
  table: NumberingTable,
  numId: string,
  level: number,
  symbol: string,
  font: string | null = 'Symbol',
): NumberingTableResult | NumberingFailure {
  if (symbol.length === 0) {
    return fail('invalid_definition', '列表符号不能是空串（要取消列表请用 apply.ts 的 removeList）');
  }
  return updateLevelForInstance(table, numId, level, (current) => ({
    ...current,
    format: 'bullet',
    text_template: symbol,
    bullet_font: font,
  }));
}

/** 改某级缩进（WF-041）。 */
export function setLevelIndent(
  table: NumberingTable,
  numId: string,
  level: number,
  indent: { readonly left?: IndentAmount; readonly hanging?: IndentAmount },
): NumberingTableResult | NumberingFailure {
  return updateLevelForInstance(table, numId, level, (current) => ({
    ...current,
    indent_left: indent.left ?? current.indent_left,
    indent_hanging: indent.hanging ?? current.indent_hanging,
  }));
}

/** 把某级与一个段落样式关联（WF-041 的"样式关联"，OOXML `w:lvl/w:pStyle`）。 */
export function setLevelStyleRef(
  table: NumberingTable,
  numId: string,
  level: number,
  styleRef: string | null,
): NumberingTableResult | NumberingFailure {
  return updateLevelForInstance(table, numId, level, (current) => ({ ...current, style_ref: styleRef }));
}

/** 改某级定义里的**默认**起始值（抽象层）。要"这一处列表从头计数"请用 `restartList`。 */
export function setLevelStart(
  table: NumberingTable,
  numId: string,
  level: number,
  start: number,
): NumberingTableResult | NumberingFailure {
  if (!Number.isInteger(start) || start < 1) {
    return fail('invalid_definition', `起始值必须是 ≥1 的整数，收到 ${JSON.stringify(start)}`);
  }
  return updateLevelForInstance(table, numId, level, (current) => ({ ...current, start }));
}

// ---------------------------------------------------------------------------
// 重启 / 续编（WF-042）
// ---------------------------------------------------------------------------

/**
 * 重启编号：**新建一个实例**（新 `num_id`），起始值写在新实例的 `lvlOverride` 上。
 *
 * 原实例与其计数**原样保留**——这就是"重启一个列表不影响另一个列表"的结构性来源。
 * 调用方拿到新 `num_id` 后，把它设到要"重新从 1 开始"的那些段落上（`apply.ts`）。
 */
export function restartList(
  table: NumberingTable,
  numId: string,
  options: { readonly overrides?: readonly { readonly level: number; readonly start: number }[] } = {},
): CreateListResult | NumberingFailure {
  const source = findInstance(table, numId);
  if (source === null) {
    return fail('unknown_instance', `编号实例 ${JSON.stringify(numId)} 不存在，无法重启`);
  }
  if (findAbstract(table, source.abstract_num_id) === null) {
    return fail('unknown_abstract', `实例 ${JSON.stringify(numId)} 指向的抽象定义 ${JSON.stringify(source.abstract_num_id)} 不存在`);
  }
  const overrides = options.overrides ?? [{ level: 0, start: 1 }];
  const built: LevelOverride[] = [];
  for (const item of overrides) {
    const levelProblem = assertLevel(item.level, '重启级别');
    if (levelProblem !== null) {
      return levelProblem;
    }
    if (!Number.isInteger(item.start) || item.start < 1) {
      return fail('invalid_definition', `重启起始值必须是 ≥1 的整数，收到 ${JSON.stringify(item.start)}`);
    }
    built.push({ level: item.level, start_override: item.start, level_definition: null });
  }

  const numIdNew = nextNumId(table);
  const instance: NumberingInstance = {
    num_id: numIdNew,
    abstract_num_id: source.abstract_num_id,
    overrides: built,
  };
  return {
    ok: true,
    table: { abstract: table.abstract, instances: [...table.instances, instance] },
    num_id: numIdNew,
    abstract_num_id: source.abstract_num_id,
  };
}

/**
 * 续编：**复用同一个 `num_id`**，计数器沿着同一实例继续走。
 *
 * 这里没有"改表"的动作——"续"的语义就是"新段落指向旧的 numId"，
 * 所以本函数只做一次**存在性校验**（坏引用要明确拒绝，R154），
 * 并把 `num_id` 原样交还，避免调用方各写各的字符串拼装。
 */
export function continueList(
  table: NumberingTable,
  numId: string,
): { readonly ok: true; readonly num_id: string; readonly table: NumberingTable } | NumberingFailure {
  if (findInstance(table, numId) === null) {
    return fail('unknown_instance', `编号实例 ${JSON.stringify(numId)} 不存在，无法续编`);
  }
  return { ok: true, num_id: numId, table };
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

export interface NumberingProblem {
  readonly code: NumberingProblemCode;
  readonly detail: string;
}

/** 编号表自检：重复 id、坏抽象引用、越界级别、空级别集。供上层给出可解释反馈（R154）。 */
export function validateNumberingTable(table: NumberingTable): readonly NumberingProblem[] {
  const problems: NumberingProblem[] = [];
  const abstractIds = new Set<string>();
  for (const abstract of table.abstract) {
    if (abstractIds.has(abstract.abstract_num_id)) {
      problems.push({ code: 'duplicate_id', detail: `抽象定义 id ${JSON.stringify(abstract.abstract_num_id)} 重复` });
    }
    abstractIds.add(abstract.abstract_num_id);
    if (abstract.levels.length === 0) {
      problems.push({ code: 'invalid_definition', detail: `抽象定义 ${JSON.stringify(abstract.abstract_num_id)} 没有任何级别` });
    }
    for (const level of abstract.levels) {
      if (!Number.isInteger(level.level) || level.level < 0 || level.level > MAX_LIST_LEVEL) {
        problems.push({
          code: 'invalid_level',
          detail: `抽象定义 ${JSON.stringify(abstract.abstract_num_id)} 含越界级别 ${JSON.stringify(level.level)}`,
        });
      }
    }
  }
  const numIds = new Set<string>();
  for (const instance of table.instances) {
    if (numIds.has(instance.num_id)) {
      problems.push({ code: 'duplicate_id', detail: `编号实例 id ${JSON.stringify(instance.num_id)} 重复` });
    }
    numIds.add(instance.num_id);
    if (!abstractIds.has(instance.abstract_num_id)) {
      problems.push({
        code: 'unknown_abstract',
        detail: `编号实例 ${JSON.stringify(instance.num_id)} 指向不存在的抽象定义 ${JSON.stringify(instance.abstract_num_id)}`,
      });
    }
  }
  return problems;
}

/** 便捷：从 0 级开始、按 `formats` 建的常规列表（测试与 demo 的常用入口）。 */
export function createStandardList(
  table: NumberingTable,
  kind: ListKind,
  formats?: readonly ListLevelFormat[],
  start?: number,
): CreateListResult | NumberingFailure {
  return createList(table, {
    kind,
    ...(formats === undefined ? {} : { formats }),
    ...(start === undefined ? {} : { start }),
  });
}

/** 便捷：十进制 / 字母 / 罗马数字列表（WF-040 的三种编号）。 */
export function counterFormatsFor(kind: 'decimal' | 'lowerLetter' | 'upperLetter' | 'lowerRoman' | 'upperRoman'): readonly CounterFormat[] {
  return [kind];
}

/** 字符缩进的便捷再导出（`types.ts` 的 `chars`），避免调用方到处写 `{unit:'chars'}`。 */
export { chars };

/** 常用缩进：每级 2 字符、悬挂 2 字符（中文文档里更常见的一种）。 */
export function chineseLevelIndent(level: number): { left: IndentAmount; hanging: IndentAmount } {
  return { left: chars(2 * (level + 1)), hanging: chars(2) };
}
