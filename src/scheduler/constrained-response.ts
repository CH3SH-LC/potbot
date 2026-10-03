/**
 * **受约束响应解析**（KRN-04 下半；合同 R221–R226）。
 *
 * ## 这一件修的是什么
 *
 * 真实模型工具循环里最常见的两种"看起来能跑"的实现：
 *
 * 1. **从自由文本里刨工具调用**——正则搜 `{...}`、找 `tool_name:`、"尽量猜"模型想调什么。
 *    猜错一次就是一次真实的越权执行，而且它**永远不会报错**：最坏情况是把一段
 *    "我可以帮你查天气"执行成了 `weather.get`。
 * 2. **把格式违约降级成默认值**——少了必填参数就当空串、多了字段就当没看见、
 *    工具名不认识就当普通回答。于是"模型输出不合规"这件事**在系统里不可见**，
 *    事后无法判定一次执行到底是被授权的还是被猜出来的。
 *
 * 本模块把模型输出解析成**封闭的动作 / 回答联合**（`kind` 判别式），并且：
 *
 * - **格式违约必须结构化拒绝**：返回值是 `ok: false` + **具名拒绝码**，不是异常、不是默认值，
 *   更不是"尽力而为的近似结果"。调用方**不能**把 `ok: false` 当成一次成功的解析。
 * - **未知工具名 / 越界参数 / 多余字段分别报具名错**（`unknown_tool` /
 *   `argument_out_of_range` / `unknown_argument`，信封级多余字段见 `unknown_envelope_field`）。
 * - **自由文本绝不当作工具调用执行**：不以 `{` 开头的输入直接判 `free_text_not_action`；
 *   以 `{` 开头但 JSON 不合法的判 `malformed_json`。两种都**不猜测、不修补**。
 * - **解析本身没有副作用**：成功结果上 `executed` 是**字面量 `false`**——
 *   解析出来的动作只是一个**待执行请求**，必须由工具循环按"请求-回执"走（见 `tool-loop.ts`）。
 *
 * ## 与 `src/adapters/clock/action-contract.ts` 的关系
 *
 * 参数类型词汇（`JsonType`）**复用**该文件的单一定义，不另造。但那里的 `ToolSchema`
 * 刻意只表达"字段 / 类型 / 必填 / 枚举"，**表达不了数值区间**——而"越界参数"正是本条要求
 * 报具名错的场景。因此 `ToolParameterSpec` 在 `JsonType` 之上**增加** `minimum` / `maximum`，
 * 是一个**增量**而非竞争定义（测试对两处同名的类型词汇做了一致性反向对照）。
 *
 * 本模块是**纯函数**：零 IO、不含墙钟、不含随机数。
 */

import { ValidationError } from '../protocol/index.js';
import type { JsonType } from '../adapters/clock/action-contract.js';

// ---------------------------------------------------------------------------
// 工具目录（解析的判据来源）
// ---------------------------------------------------------------------------

/** 一个工具参数的声明：类型 + 必填 + 枚举 + **数值区间**。 */
export interface ToolParameterSpec {
  readonly name: string;
  readonly type: JsonType;
  readonly required: boolean;
  readonly description: string;
  /** 取值受限于固定集合时列出。 */
  readonly enum_values?: readonly string[] | undefined;
  /** 仅数值型有效：下界（含）。 */
  readonly minimum?: number | undefined;
  /** 仅数值型有效：上界（含）。 */
  readonly maximum?: number | undefined;
}

/** 一个工具的声明。`tool_id` 是解析时唯一允许出现的名字（未登记 = `unknown_tool`）。 */
export interface ToolSpec {
  readonly tool_id: string;
  readonly summary: string;
  readonly parameters: readonly ToolParameterSpec[];
}

/** 这次循环**可用**的工具集合（封闭集合：目录之外的工具名一律不可执行）。 */
export interface ToolCatalog {
  readonly tools: readonly ToolSpec[];
}

/**
 * 构造工具目录。目录本身不自洽（重名工具 / 空名 / 重名参数 / 区间颠倒）时**抛错**，
 * 不静默丢弃——一个"缺了一半"的目录会把合规调用判成 `unknown_tool`，那是冤案。
 */
export function createToolCatalog(tools: readonly ToolSpec[]): ToolCatalog {
  const seenTools = new Set<string>();
  for (const tool of tools) {
    if (tool.tool_id.trim().length === 0) {
      throw new ValidationError('工具目录里出现了空的 tool_id：工具必须有稳定名字');
    }
    if (seenTools.has(tool.tool_id)) {
      throw new ValidationError(`工具目录里 tool_id 重复：${tool.tool_id}（同一名字只能有一份声明）`);
    }
    seenTools.add(tool.tool_id);
    const seenParams = new Set<string>();
    for (const parameter of tool.parameters) {
      if (parameter.name.trim().length === 0) {
        throw new ValidationError(`工具 ${tool.tool_id} 的参数名为空`);
      }
      if (seenParams.has(parameter.name)) {
        throw new ValidationError(`工具 ${tool.tool_id} 的参数名重复：${parameter.name}`);
      }
      seenParams.add(parameter.name);
      if (
        parameter.minimum !== undefined &&
        parameter.maximum !== undefined &&
        parameter.minimum > parameter.maximum
      ) {
        throw new ValidationError(
          `工具 ${tool.tool_id} 的参数 ${parameter.name} 区间颠倒：` +
            `minimum=${String(parameter.minimum)} > maximum=${String(parameter.maximum)}`,
        );
      }
    }
  }
  return Object.freeze({ tools: Object.freeze([...tools]) });
}

/** 按名字查工具；**未登记返回 `null`**（调用方必须显式处理，不得拿 `undefined` 当"通过"）。 */
export function findToolSpec(catalog: ToolCatalog, toolId: string): ToolSpec | null {
  for (const tool of catalog.tools) {
    if (tool.tool_id === toolId) {
      return tool;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 拒绝码（具名）
// ---------------------------------------------------------------------------

export const RESPONSE_REJECTION_CODES = [
  // ---- 格式违约（结构就不对）----
  /** 输入是字符串、以 `{` 开头，但不是合法 JSON。 */
  'malformed_json',
  /** 输入是**自由文本**（不是对象、不是 JSON 对象字面量）。 */
  'free_text_not_action',
  /** JSON 合法但不是对象（数组 / 数字 / 字符串 / null）。 */
  'not_an_object',
  /** 缺少 `kind` 判别式：无法判定这是动作还是回答。 */
  'missing_kind',
  /** `kind` 不是 `action` / `answer` 之一。 */
  'unknown_kind',
  /** 信封里出现了该 `kind` 不接受的字段（多余字段）。 */
  'unknown_envelope_field',
  /** `answer` 的文本是空的：空回答不是回答。 */
  'empty_answer_text',
  // ---- 参数违约（结构对，内容不合法）----
  /** 工具名不在目录里（含缺失 / 非字符串的 `tool` 字段）。 */
  'unknown_tool',
  /** 缺少必填参数。 */
  'missing_required_argument',
  /** 参数名未在工具声明里出现（多余参数）。 */
  'unknown_argument',
  /** 参数类型不符。 */
  'argument_type_mismatch',
  /** 数值参数越界（超出声明的 `minimum` / `maximum`）。 */
  'argument_out_of_range',
  /** 参数取值不在枚举集合内。 */
  'argument_enum_violation',
] as const;
export type ResponseRejectionCode = (typeof RESPONSE_REJECTION_CODES)[number];

/** 格式违约码（结构层面）；其余为参数违约。 */
export const RESPONSE_FORMAT_CODES: readonly ResponseRejectionCode[] = Object.freeze([
  'malformed_json',
  'free_text_not_action',
  'not_an_object',
  'missing_kind',
  'unknown_kind',
  'unknown_envelope_field',
  'empty_answer_text',
]);

export type ResponseViolationKind = 'format' | 'argument';

export function rejectionViolationOf(code: ResponseRejectionCode): ResponseViolationKind {
  return RESPONSE_FORMAT_CODES.includes(code) ? 'format' : 'argument';
}

export const RESPONSE_REJECTION_LABELS: Readonly<Record<ResponseRejectionCode, string>> = Object.freeze({
  malformed_json: '不是合法 JSON（以 "{" 开头但解析失败）',
  free_text_not_action: '自由文本：不是受约束响应，不得当作工具调用执行',
  not_an_object: '不是 JSON 对象',
  missing_kind: '缺少 kind 判别式',
  unknown_kind: 'kind 不是 action / answer',
  unknown_envelope_field: '信封里有多余字段',
  empty_answer_text: '回答文本为空',
  unknown_tool: '工具名不在可用目录里',
  missing_required_argument: '缺少必填参数',
  unknown_argument: '参数未在工具声明里',
  argument_type_mismatch: '参数类型不符',
  argument_out_of_range: '参数越界',
  argument_enum_violation: '参数取值不在枚举内',
});

export function describeResponseRejection(code: ResponseRejectionCode): string {
  return RESPONSE_REJECTION_LABELS[code];
}

/** 一次**结构化拒绝**：不执行、不猜测、不接受。 */
export interface ResponseRejection {
  readonly ok: false;
  /** 恒 `false`：格式违约不得被当作"已接受"（同 `ValidationError.accepted`）。 */
  readonly accepted: false;
  /** 恒 `false`：解析从不执行任何工具。 */
  readonly executed: false;
  readonly code: ResponseRejectionCode;
  readonly violation: ResponseViolationKind;
  /** 违约在输入里的位置（如 `arguments.max_tokens`、`kind`；信封级为空串）。 */
  readonly path: string;
  readonly detail: string;
  readonly rejection: ResponseRejectionCode;
}

// ---------------------------------------------------------------------------
// 受约束响应（封闭联合）
// ---------------------------------------------------------------------------

/** 动作：模型**提出**要调用某个已声明工具。注意这是请求，不是执行。 */
export interface ParsedToolAction {
  readonly kind: 'action';
  readonly tool_id: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/** 回答：模型给出的收尾文本（自由文本**只能**经这个信封进入系统）。 */
export interface ParsedAnswer {
  readonly kind: 'answer';
  readonly text: string;
}

export type ConstrainedResponse = ParsedToolAction | ParsedAnswer;

export interface ConstrainedResponseSuccess {
  readonly ok: true;
  readonly accepted: true;
  /** 恒 `false`：解析没有副作用，动作仍需由工具循环按回执推进。 */
  readonly executed: false;
  readonly rejection: null;
  readonly response: ConstrainedResponse;
}

export type ConstrainedResponseOutcome = ConstrainedResponseSuccess | ResponseRejection;

export function isToolAction(response: ConstrainedResponse): response is ParsedToolAction {
  return response.kind === 'action';
}

export function isAnswer(response: ConstrainedResponse): response is ParsedAnswer {
  return response.kind === 'answer';
}

/** `action` 信封允许的字段（**封闭**：多一个都拒）。 */
export const ACTION_ENVELOPE_KEYS: readonly string[] = Object.freeze(['kind', 'tool', 'arguments']);
/** `answer` 信封允许的字段（**封闭**）。 */
export const ANSWER_ENVELOPE_KEYS: readonly string[] = Object.freeze(['kind', 'text']);

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

function reject(
  code: ResponseRejectionCode,
  path: string,
  detail: string,
): ResponseRejection {
  return Object.freeze({
    ok: false as const,
    accepted: false as const,
    executed: false as const,
    code,
    violation: rejectionViolationOf(code),
    path,
    detail,
    rejection: code,
  });
}

function typeName(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

function matchesJsonType(value: unknown, type: JsonType): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 把输入规整成 JSON 对象；**任何**不规整都返回结构化拒绝。
 *
 * 这里刻意**只**做一件事：判断"这是不是一个 JSON 对象"。它不尝试修复引号、
 * 不从散文里抽取片段、不把 `True` 当 `true`——每一条"友好"的修补都是一种猜测。
 */
function normalizeInput(
  raw: unknown,
): { readonly ok: true; readonly value: Record<string, unknown> } | ResponseRejection {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (text.length === 0) {
      return reject('free_text_not_action', '', '空字符串不是受约束响应（不得当作工具调用执行）');
    }
    let parsed: unknown;
    let parsedOk = false;
    try {
      parsed = JSON.parse(text) as unknown;
      parsedOk = true;
    } catch {
      parsedOk = false;
    }
    if (!parsedOk) {
      return text.startsWith('{')
        ? reject('malformed_json', '', '以 "{" 开头但不是合法 JSON：不猜测、不修补（含尾随文本也会被拒）')
        : reject(
            'free_text_not_action',
            '',
            '自由文本不是受约束响应：不得用正则/关键词猜测工具调用，也不得据此执行任何工具',
          );
    }
    value = parsed;
  }
  if (!isPlainObject(value)) {
    return reject('not_an_object', '', `受约束响应必须是 JSON 对象，收到 ${typeName(value)}`);
  }
  return { ok: true, value };
}

/**
 * 把模型输出解析成**封闭的动作 / 回答联合**。
 *
 * 成功 ⇒ 动作只是**待执行请求**（`executed: false`），必须交给工具循环走回执；
 * 失败 ⇒ 具名结构化拒绝，调用方**不得**退化成"当普通回答处理"。
 */
export function parseConstrainedResponse(raw: unknown, catalog: ToolCatalog): ConstrainedResponseOutcome {
  const normalized = normalizeInput(raw);
  if (!normalized.ok) {
    return normalized;
  }
  const value = normalized.value;

  if (!('kind' in value) || value.kind === undefined) {
    return reject('missing_kind', 'kind', '缺少 kind：无法判定这是动作还是回答（不得默认成回答）');
  }
  const kind = value.kind;
  if (typeof kind !== 'string') {
    return reject('unknown_kind', 'kind', `kind 必须是字符串，收到 ${typeName(kind)}`);
  }
  if (kind !== 'action' && kind !== 'answer') {
    return reject('unknown_kind', 'kind', `kind 只能是 action / answer，收到 ${JSON.stringify(kind)}`);
  }

  const allowed = kind === 'action' ? ACTION_ENVELOPE_KEYS : ANSWER_ENVELOPE_KEYS;
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      return reject(
        'unknown_envelope_field',
        key,
        `${kind} 信封不接受字段 ${key}（允许：${allowed.join(' / ')}）：多余字段一律拒，不做静默忽略`,
      );
    }
  }

  if (kind === 'answer') {
    const text = value.text;
    if (typeof text !== 'string') {
      return reject('argument_type_mismatch', 'text', `answer.text 必须是字符串，收到 ${typeName(text)}`);
    }
    if (text.trim().length === 0) {
      return reject('empty_answer_text', 'text', 'answer.text 是空白：空回答不是回答（不得当作完成）');
    }
    return Object.freeze({
      ok: true as const,
      accepted: true as const,
      executed: false as const,
      rejection: null,
      response: Object.freeze({ kind: 'answer' as const, text }),
    });
  }

  const toolId = value.tool;
  if (typeof toolId !== 'string' || toolId.trim().length === 0) {
    return reject(
      'unknown_tool',
      'tool',
      `缺少或非法的 tool 字段（收到 ${typeName(toolId)}）：无法确定要调用哪个工具`,
    );
  }
  const spec = findToolSpec(catalog, toolId);
  if (spec === null) {
    const known = catalog.tools.map((tool) => tool.tool_id).join(' / ');
    return reject('unknown_tool', 'tool', `工具 ${JSON.stringify(toolId)} 不在可用目录里（可用：${known || '（空目录）'}）`);
  }

  const rawArguments = value.arguments;
  if (rawArguments === undefined) {
    // 省略 arguments 视为空参数表：**仍**会走必填校验，不构成放宽。
  } else if (!isPlainObject(rawArguments)) {
    return reject(
      'argument_type_mismatch',
      'arguments',
      `arguments 必须是 JSON 对象，收到 ${typeName(rawArguments)}`,
    );
  }
  const args: Record<string, unknown> = isPlainObject(rawArguments) ? { ...rawArguments } : {};
  const declared = new Set(spec.parameters.map((parameter) => parameter.name));

  for (const key of Object.keys(args)) {
    if (!declared.has(key)) {
      return reject(
        'unknown_argument',
        `arguments.${key}`,
        `参数 ${key} 未在工具 ${spec.tool_id} 的声明里（声明：${[...declared].join(' / ') || '（无）'}）`,
      );
    }
  }

  for (const parameter of spec.parameters) {
    const present = Object.prototype.hasOwnProperty.call(args, parameter.name);
    const argument = args[parameter.name];
    const path = `arguments.${parameter.name}`;
    if (!present || argument === undefined) {
      if (parameter.required) {
        return reject('missing_required_argument', path, `${spec.tool_id} 缺少必填参数 ${parameter.name}`);
      }
      continue;
    }
    if (!matchesJsonType(argument, parameter.type)) {
      return reject(
        'argument_type_mismatch',
        path,
        `${spec.tool_id}.${parameter.name} 类型应为 ${parameter.type}，收到 ${typeName(argument)}`,
      );
    }
    if (
      parameter.enum_values !== undefined &&
      !parameter.enum_values.includes(String(argument))
    ) {
      return reject(
        'argument_enum_violation',
        path,
        `${spec.tool_id}.${parameter.name} 取值必须是 ${parameter.enum_values.join(' | ')} 之一，收到 ${JSON.stringify(argument)}`,
      );
    }
    if (typeof argument === 'number') {
      if (parameter.minimum !== undefined && argument < parameter.minimum) {
        return reject(
          'argument_out_of_range',
          path,
          `${spec.tool_id}.${parameter.name} 越界：${String(argument)} < 下界 ${String(parameter.minimum)}`,
        );
      }
      if (parameter.maximum !== undefined && argument > parameter.maximum) {
        return reject(
          'argument_out_of_range',
          path,
          `${spec.tool_id}.${parameter.name} 越界：${String(argument)} > 上界 ${String(parameter.maximum)}`,
        );
      }
    }
  }

  return Object.freeze({
    ok: true as const,
    accepted: true as const,
    executed: false as const,
    rejection: null,
    response: Object.freeze({
      kind: 'action' as const,
      tool_id: spec.tool_id,
      arguments: Object.freeze({ ...args }),
    }),
  });
}

/** 便于调用方在"解析必须成功"的地方使用：失败即抛错（**不得**静默继续）。 */
export function mustAcceptResponse(outcome: ConstrainedResponseOutcome): ConstrainedResponse {
  if (!outcome.ok) {
    throw new ValidationError(
      `受约束响应被结构化拒绝（${outcome.code}）：${describeResponseRejection(outcome.code)}` +
        `；位置 ${outcome.path || '(信封)'}；${outcome.detail}`,
    );
  }
  return outcome.response;
}
