/**
 * K-I18 —— 运行期 JSON Schema（draft 2020-12 **子集**）校验器。
 *
 * ## 为什么自写而不引依赖
 *
 * 本仓库**没有任何运行时依赖**（package.json 只有 vitest / typescript / @types/node），
 * 没有 ajv。契约层已有一个零依赖子集校验器 `contracts/mobile-v1/validate.mjs`，但它是
 * CLI：`import` 它会在模块求值时执行 `main()` 并 `process.exit`，无法作为库复用，且它
 * 面向的是 contracts/ 目录下的 wire fixture。因此本单元自持一个**可复用、可 fail-closed**
 * 的小校验器，只服务 K-I18 的 schema。
 *
 * ## 与「永远通过」作对
 *
 * 1. **未知关键字直接抛** `UnsupportedSchemaError`——不静默忽略。schema 把 `enum` 写成
 *    `enm`、把 `oneOf` 写错，都会立刻炸，而不是"看起来通过了"。
 * 2. `$ref` 只允许同文档 `#` / `#/...` 指针；跨文档 `$ref` 抛错（不假装解析）。
 * 3. 校验结果按 `ValidationError[]` 返回；**空数组才是通过**。测试既打正例（必须空），
 *    也打负例（必须非空），因此把 schema 换成 `true`（恒真）会让负例集体变红。
 *
 * ## 支持的子集（只列会用到的）
 *
 * 断言类：`$ref` `type` `enum` `const` `required` `properties` `additionalProperties`
 * `items` `prefixItems` `minItems` `maxItems` `minimum` `maximum` `exclusiveMinimum`
 * `exclusiveMaximum` `pattern` `minLength` `maxLength` `minProperties` `maxProperties`
 * `propertyNames` `allOf` `anyOf` `oneOf` `not` `if` `then` `else`。
 * 注解类（不参与断言）：`$schema` `$id` `$anchor` `$defs` `title` `description`
 * `$comment` `examples` `default` `format` `deprecated` `readOnly` `writeOnly`。
 * 出现集合之外的关键字 ⇒ 抛错。
 *
 * ## 已知局限（如实记录，不假装是完整实现）
 *
 * - `pattern` 用 JS `RegExp`；`minLength`/`maxLength` 按 UTF-16 code unit 计（JSON Schema
 *   规范按 code point）——本 schema 的受控字符串均为 ASCII，差异不触发。
 * - `type` 不符时**不再对子关键字报错**（减少噪音），与契约层校验器同策略。
 */

import { readFileSync } from 'node:fs';

export interface ValidationError {
  readonly path: string;
  readonly message: string;
}

export type JsonSchema = boolean | JsonSchemaObject;

export interface JsonSchemaObject {
  readonly [keyword: string]: unknown;
}

/** schema 里出现了本校验器不支持的（或拼错的）关键字——fail-closed，不静默忽略。 */
export class UnsupportedSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedSchemaError';
  }
}

const ASSERTION_KEYWORDS = new Set<string>([
  '$ref',
  'type',
  'enum',
  'const',
  'required',
  'properties',
  'additionalProperties',
  'items',
  'prefixItems',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'pattern',
  'minLength',
  'maxLength',
  'minProperties',
  'maxProperties',
  'propertyNames',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'if',
  'then',
  'else',
]);

const ANNOTATION_KEYWORDS = new Set<string>([
  '$schema',
  '$id',
  '$anchor',
  '$defs',
  'title',
  'description',
  '$comment',
  'examples',
  'default',
  'format',
  'deprecated',
  'readOnly',
  'writeOnly',
]);

const MAX_DEPTH = 128;

// ---------------------------------------------------------------------------
// 值工具
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is JsonSchemaObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function matchesType(value: unknown, expected: string): boolean {
  const actual = typeOf(value);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  if (expected === 'integer') return actual === 'integer';
  return actual === expected;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const ta = typeOf(a);
  if (ta !== typeOf(b)) return false;
  if (ta === 'array') {
    const aa = a as readonly unknown[];
    const ba = b as readonly unknown[];
    if (aa.length !== ba.length) return false;
    return aa.every((item, index) => deepEqual(item, ba[index]));
  }
  if (ta === 'object') {
    const ao = a as JsonSchemaObject;
    const bo = b as JsonSchemaObject;
    const ka = Object.keys(ao);
    const kb = Object.keys(bo);
    if (ka.length !== kb.length) return false;
    return ka.every((key) => Object.prototype.hasOwnProperty.call(bo, key) && deepEqual(ao[key], bo[key]));
  }
  return false;
}

// ---------------------------------------------------------------------------
// 文档加载与指针解析
// ---------------------------------------------------------------------------

export function parseSchemaText(text: string): JsonSchema {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'boolean' && !isPlainObject(parsed)) {
    throw new UnsupportedSchemaError('schema 根必须是对象或布尔');
  }
  return parsed;
}

export function loadSchemaDocument(absPath: string): JsonSchema {
  return parseSchemaText(readFileSync(absPath, 'utf8'));
}

function pointer(doc: JsonSchema, ref: string): JsonSchema {
  if (ref === '#' || ref === '') return doc;
  if (!ref.startsWith('#/')) {
    throw new UnsupportedSchemaError(`不支持的 $ref（只允许同文档 # / #/... 指针）：${ref}`);
  }
  const segments = ref
    .slice(2)
    .split('/')
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cursor: unknown = doc;
  for (const segment of segments) {
    if (!isPlainObject(cursor)) {
      throw new UnsupportedSchemaError(`$ref 指针越界（在 ${JSON.stringify(segment)} 处非对象）：${ref}`);
    }
    if (!Object.prototype.hasOwnProperty.call(cursor, segment)) {
      throw new UnsupportedSchemaError(`$ref 指针无法解析：${ref}`);
    }
    cursor = cursor[segment];
  }
  if (typeof cursor !== 'boolean' && !isPlainObject(cursor)) {
    throw new UnsupportedSchemaError(`$ref 指向的节点不是 schema：${ref}`);
  }
  return cursor;
}

export function resolveRef(ref: string, doc: JsonSchema): JsonSchema {
  return pointer(doc, ref);
}

// ---------------------------------------------------------------------------
// 校验核心
// ---------------------------------------------------------------------------

function collect(sub: unknown, instance: unknown, doc: JsonSchema, path: string, depth: number): ValidationError[] {
  const out: ValidationError[] = [];
  validateNode(instance, asSchema(sub), doc, path, out, depth);
  return out;
}

function asSchema(value: unknown): JsonSchema {
  if (typeof value === 'boolean') return value;
  if (isPlainObject(value)) return value;
  throw new UnsupportedSchemaError(`schema 节点必须是对象或布尔，收到 ${JSON.stringify(value)}`);
}

function validateNode(
  instance: unknown,
  schema: JsonSchema,
  doc: JsonSchema,
  path: string,
  errors: ValidationError[],
  depth: number,
): void {
  if (depth > MAX_DEPTH) {
    throw new UnsupportedSchemaError(`schema 递归过深（>${MAX_DEPTH}）：疑似循环 $ref`);
  }
  if (schema === true) return;
  if (schema === false) {
    errors.push({ path, message: 'schema is false：该值被禁止' });
    return;
  }
  if (!isPlainObject(schema)) {
    throw new UnsupportedSchemaError(`schema 节点必须是对象或布尔，收到 ${JSON.stringify(schema)}`);
  }
  for (const keyword of Object.keys(schema)) {
    if (!ASSERTION_KEYWORDS.has(keyword) && !ANNOTATION_KEYWORDS.has(keyword)) {
      throw new UnsupportedSchemaError(
        `不支持的 schema 关键字 "${keyword}"（fail-closed：不静默忽略，避免拼错关键字后『假装通过』）`,
      );
    }
  }

  // $ref（2020-12：作为 applicator，与兄弟关键字一起求值）。
  if (schema['$ref'] !== undefined) {
    const ref = schema['$ref'];
    if (typeof ref !== 'string') throw new UnsupportedSchemaError('$ref 必须是字符串');
    validateNode(instance, resolveRef(ref, doc), doc, path, errors, depth + 1);
  }

  if (schema['type'] !== undefined) {
    const declared = Array.isArray(schema['type']) ? schema['type'] : [schema['type']];
    const types = declared.filter((entry): entry is string => typeof entry === 'string');
    if (types.length !== declared.length || types.length === 0) {
      throw new UnsupportedSchemaError('type 必须是非空字符串或字符串数组');
    }
    if (!types.some((expected) => matchesType(instance, expected))) {
      errors.push({ path, message: `type: 期望 ${types.join('|')}，实际 ${typeOf(instance)}` });
      return; // 类型不符即止，避免对子关键字刷屏
    }
  }

  if (schema['const'] !== undefined && !deepEqual(instance, schema['const'])) {
    errors.push({ path, message: `const: 期望 ${JSON.stringify(schema['const'])}，实际 ${JSON.stringify(instance)}` });
  }

  if (schema['enum'] !== undefined) {
    if (!Array.isArray(schema['enum'])) throw new UnsupportedSchemaError('enum 必须是数组');
    if (!schema['enum'].some((candidate) => deepEqual(instance, candidate))) {
      errors.push({ path, message: `enum: ${JSON.stringify(instance)} 不在 ${JSON.stringify(schema['enum'])}` });
    }
  }

  if (typeof instance === 'number') {
    applyNumberBounds(instance, schema, path, errors);
  }

  if (typeof instance === 'string') {
    applyStringBounds(instance, schema, path, errors);
  }

  if (Array.isArray(instance)) {
    applyArrayBounds(instance, schema, doc, path, errors, depth);
  }

  if (isPlainObject(instance)) {
    applyObjectBounds(instance, schema, doc, path, errors, depth);
  }

  applyComposition(instance, schema, doc, path, errors, depth);
}

function numericKeyword(schema: JsonSchemaObject, key: string): number | undefined {
  const value = schema[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number') throw new UnsupportedSchemaError(`${key} 必须是数字`);
  return value;
}

function applyNumberBounds(instance: number, schema: JsonSchemaObject, path: string, errors: ValidationError[]): void {
  const minimum = numericKeyword(schema, 'minimum');
  if (minimum !== undefined && instance < minimum) errors.push({ path, message: `minimum: ${instance} < ${minimum}` });
  const maximum = numericKeyword(schema, 'maximum');
  if (maximum !== undefined && instance > maximum) errors.push({ path, message: `maximum: ${instance} > ${maximum}` });
  const exclusiveMinimum = numericKeyword(schema, 'exclusiveMinimum');
  if (exclusiveMinimum !== undefined && instance <= exclusiveMinimum) {
    errors.push({ path, message: `exclusiveMinimum: ${instance} <= ${exclusiveMinimum}` });
  }
  const exclusiveMaximum = numericKeyword(schema, 'exclusiveMaximum');
  if (exclusiveMaximum !== undefined && instance >= exclusiveMaximum) {
    errors.push({ path, message: `exclusiveMaximum: ${instance} >= ${exclusiveMaximum}` });
  }
}

function applyStringBounds(instance: string, schema: JsonSchemaObject, path: string, errors: ValidationError[]): void {
  const minLength = numericKeyword(schema, 'minLength');
  if (minLength !== undefined && instance.length < minLength) {
    errors.push({ path, message: `minLength: ${instance.length} < ${minLength}` });
  }
  const maxLength = numericKeyword(schema, 'maxLength');
  if (maxLength !== undefined && instance.length > maxLength) {
    errors.push({ path, message: `maxLength: ${instance.length} > ${maxLength}` });
  }
  const pattern = schema['pattern'];
  if (pattern !== undefined) {
    if (typeof pattern !== 'string') throw new UnsupportedSchemaError('pattern 必须是字符串');
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch {
      throw new UnsupportedSchemaError(`pattern 无法编译：${pattern}`);
    }
    if (!re.test(instance)) errors.push({ path, message: `pattern: ${JSON.stringify(instance)} 不匹配 ${JSON.stringify(pattern)}` });
  }
}

function applyArrayBounds(
  instance: readonly unknown[],
  schema: JsonSchemaObject,
  doc: JsonSchema,
  path: string,
  errors: ValidationError[],
  depth: number,
): void {
  const minItems = numericKeyword(schema, 'minItems');
  if (minItems !== undefined && instance.length < minItems) errors.push({ path, message: `minItems: ${instance.length} < ${minItems}` });
  const maxItems = numericKeyword(schema, 'maxItems');
  if (maxItems !== undefined && instance.length > maxItems) errors.push({ path, message: `maxItems: ${instance.length} > ${maxItems}` });
  const prefixItems = schema['prefixItems'];
  if (prefixItems !== undefined) {
    if (!Array.isArray(prefixItems)) throw new UnsupportedSchemaError('prefixItems 必须是数组');
    prefixItems.forEach((sub, index) => {
      if (index < instance.length) {
        errors.push(...collect(sub, instance[index], doc, `${path}[${index}]`, depth + 1));
      }
    });
  }
  const items = schema['items'];
  if (items !== undefined) {
    if (Array.isArray(items)) {
      // draft-07 位置式数组：兼容处理，但 2020-12 应用 prefixItems；此处如实支持。
      items.forEach((sub, index) => {
        if (index < instance.length) errors.push(...collect(sub, instance[index], doc, `${path}[${index}]`, depth + 1));
      });
    } else {
      instance.forEach((item, index) => errors.push(...collect(items, item, doc, `${path}[${index}]`, depth + 1)));
    }
  }
}

function applyObjectBounds(
  instance: JsonSchemaObject,
  schema: JsonSchemaObject,
  doc: JsonSchema,
  path: string,
  errors: ValidationError[],
  depth: number,
): void {
  const keys = Object.keys(instance);
  const minProperties = numericKeyword(schema, 'minProperties');
  if (minProperties !== undefined && keys.length < minProperties) {
    errors.push({ path, message: `minProperties: ${keys.length} < ${minProperties}` });
  }
  const maxProperties = numericKeyword(schema, 'maxProperties');
  if (maxProperties !== undefined && keys.length > maxProperties) {
    errors.push({ path, message: `maxProperties: ${keys.length} > ${maxProperties}` });
  }

  const required = schema['required'];
  if (required !== undefined) {
    if (!Array.isArray(required) || required.some((key) => typeof key !== 'string')) {
      throw new UnsupportedSchemaError('required 必须是字符串数组');
    }
    for (const key of required as readonly string[]) {
      if (!Object.prototype.hasOwnProperty.call(instance, key)) {
        errors.push({ path, message: `required: 缺少必需字段 "${key}"` });
      }
    }
  }

  const properties = schema['properties'];
  const subschemas: Record<string, unknown> = {};
  if (properties !== undefined) {
    if (!isPlainObject(properties)) throw new UnsupportedSchemaError('properties 必须是对象');
    for (const [key, sub] of Object.entries(properties)) {
      subschemas[key] = sub;
      if (Object.prototype.hasOwnProperty.call(instance, key)) {
        errors.push(...collect(sub, instance[key], doc, `${path}.${key}`, depth + 1));
      }
    }
  }

  const additional = schema['additionalProperties'];
  if (additional !== undefined && additional !== true) {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(subschemas, key)) continue;
      if (additional === false) {
        errors.push({ path, message: `additionalProperties: 不允许的字段 "${key}"` });
      } else {
        errors.push(...collect(additional, instance[key], doc, `${path}.${key}`, depth + 1));
      }
    }
  }

  const propertyNames = schema['propertyNames'];
  if (propertyNames !== undefined) {
    for (const key of keys) {
      errors.push(...collect(propertyNames, key, doc, `${path}[key=${key}]`, depth + 1));
    }
  }
}

function applyComposition(
  instance: unknown,
  schema: JsonSchemaObject,
  doc: JsonSchema,
  path: string,
  errors: ValidationError[],
  depth: number,
): void {
  const allOf = schema['allOf'];
  if (allOf !== undefined) {
    if (!Array.isArray(allOf)) throw new UnsupportedSchemaError('allOf 必须是数组');
    for (const sub of allOf) errors.push(...collect(sub, instance, doc, path, depth + 1));
  }

  const anyOf = schema['anyOf'];
  if (anyOf !== undefined) {
    if (!Array.isArray(anyOf) || anyOf.length === 0) throw new UnsupportedSchemaError('anyOf 必须是非空数组');
    const matched = anyOf.some((sub) => collect(sub, instance, doc, path, depth + 1).length === 0);
    if (!matched) errors.push({ path, message: 'anyOf: 没有任何分支匹配' });
  }

  const oneOf = schema['oneOf'];
  if (oneOf !== undefined) {
    if (!Array.isArray(oneOf) || oneOf.length === 0) throw new UnsupportedSchemaError('oneOf 必须是非空数组');
    let matched = 0;
    const notes: string[] = [];
    oneOf.forEach((sub, index) => {
      const probe = collect(sub, instance, doc, path, depth + 1);
      if (probe.length === 0) matched += 1;
      else {
        const first = probe[0];
        notes.push(`[${index + 1}] ${first ? `${first.path}: ${first.message}` : '不匹配'}`);
      }
    });
    if (matched !== 1) {
      const detail = notes.length > 0 ? `；分支诊断 -> ${notes.join(' | ')}` : '';
      errors.push({ path, message: `oneOf: ${matched} 个分支匹配（期望恰好 1 个）${detail}` });
    }
  }

  const not = schema['not'];
  if (not !== undefined) {
    if (collect(not, instance, doc, path, depth + 1).length === 0) {
      errors.push({ path, message: 'not: 命中了被禁止的子模式' });
    }
  }

  const ifSchema = schema['if'];
  if (ifSchema !== undefined) {
    const matches = collect(ifSchema, instance, doc, path, depth + 1).length === 0;
    if (matches && schema['then'] !== undefined) {
      errors.push(...collect(schema['then'], instance, doc, path, depth + 1));
    } else if (!matches && schema['else'] !== undefined) {
      errors.push(...collect(schema['else'], instance, doc, path, depth + 1));
    }
  }
}

// ---------------------------------------------------------------------------
// 公共 API
// ---------------------------------------------------------------------------

/** 校验实例；**空数组 = 通过**。 */
export function validateInstance(instance: unknown, schema: JsonSchema, doc: JsonSchema): ValidationError[] {
  const errors: ValidationError[] = [];
  validateNode(instance, schema, doc, '$', errors, 0);
  return errors;
}

/** 按同文档指针（如 `#/$defs/recoveryPlan`）取出子 schema 后校验。 */
export function validateFragment(doc: JsonSchema, pointerRef: string, instance: unknown): ValidationError[] {
  return validateInstance(instance, resolveRef(pointerRef, doc), doc);
}

export function isValid(instance: unknown, schema: JsonSchema, doc: JsonSchema): boolean {
  return validateInstance(instance, schema, doc).length === 0;
}
