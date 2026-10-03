/**
 * K-I16 契约测试用的**最小 JSON Schema 子集求值器**（JSON Schema draft 2020-12 的极小子集）。
 *
 * 为什么在测试里自造：本仓库零依赖（无 `ajv`），而"把 `apps/mobile-kernel/dispatch/schema.ts`
 * 绑到冻结件 `contracts/mobile-v1/schemas/command.schema.json`"必须由一个**由该文件驱动**的
 * 通用求值器来裁判——否则只是把规则抄第二遍，仍是自证。
 *
 * 只实现 `command.schema.json` 实际用到的构造：
 * `$ref`（本地 `#/...` 指针）、`type`、`const`、`enum`、`required`、`properties`、
 * `additionalProperties:false`、`allOf`、`anyOf`、`oneOf`、`minLength`、`maxLength`、
 * `minimum`。**不是**通用 JSON Schema 实现，也不声称是；未识别的关键字一律忽略（放行）。
 * 求值器自身的正确性由 `01-contract-binding.test.ts` §F 的负例证明（不是恒真）。
 */

export type SchemaObject = Record<string, unknown>;

export interface SubsetValidation {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolvePointer(root: SchemaObject, pointer: string): unknown {
  if (!pointer.startsWith('#')) {
    throw new Error(`本求值器只支持本地 $ref，收到：${pointer}`);
  }
  const segments = pointer
    .slice(1)
    .split('/')
    .filter((part) => part.length > 0);
  let current: unknown = root;
  for (const rawSegment of segments) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isObject(current) && !Array.isArray(current)) {
      throw new Error(`$ref 无法解析（中途不是对象/数组）：${pointer}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function typeNameOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function typeMatches(expected: string, value: unknown): boolean {
  switch (expected) {
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number';
    case 'object':
      return isObject(value);
    default:
      return typeNameOf(value) === expected;
  }
}

/** 对一个值按给定 schema 求值；`root` 用于解析 `$ref`。 */
export function validateSubset(
  schema: SchemaObject,
  data: unknown,
  root: SchemaObject = schema,
): SubsetValidation {
  const errors: string[] = [];
  walk(schema, data, root, '$', errors);
  return { valid: errors.length === 0, errors: Object.freeze(errors) };
}

function walk(
  schema: unknown,
  data: unknown,
  root: SchemaObject,
  path: string,
  errors: string[],
): void {
  if (!isObject(schema)) {
    return; // `true` / `{}` 均放行
  }

  if (typeof schema.$ref === 'string') {
    const target = resolvePointer(root, schema.$ref);
    if (!isObject(target)) {
      errors.push(`${path}: $ref 目标不是 schema（${schema.$ref}）`);
    } else {
      walk(target, data, root, path, errors);
    }
  }

  if (typeof schema.type === 'string' && !typeMatches(schema.type, data)) {
    errors.push(`${path}: 期望 type=${schema.type}，实际 ${typeNameOf(data)}`);
    return;
  }

  if ('const' in schema && data !== schema.const) {
    errors.push(`${path}: 期望 const=${JSON.stringify(schema.const)}，实际 ${JSON.stringify(data)}`);
  }

  if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(data)) {
    errors.push(`${path}: 取值 ${JSON.stringify(data)} 不在 enum ${JSON.stringify(schema.enum)}`);
  }

  if (typeof data === 'string') {
    if (typeof schema.minLength === 'number' && data.length < schema.minLength) {
      errors.push(`${path}: 字符串长度 ${data.length} < minLength ${schema.minLength}`);
    }
    if (typeof schema.maxLength === 'number' && data.length > schema.maxLength) {
      errors.push(`${path}: 字符串长度 ${data.length} > maxLength ${schema.maxLength}`);
    }
  }

  if (typeof data === 'number' && typeof schema.minimum === 'number' && data < schema.minimum) {
    errors.push(`${path}: 数值 ${data} < minimum ${schema.minimum}`);
  }

  if (isObject(data)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required as unknown[]) {
        if (typeof key === 'string' && !(key in data)) {
          errors.push(`${path}: 缺必需属性 ${key}`);
        }
      }
    }
    const properties = isObject(schema.properties) ? schema.properties : {};
    for (const [key, subSchema] of Object.entries(properties)) {
      if (key in data) {
        walk(subSchema, data[key], root, `${path}.${key}`, errors);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(data)) {
        if (!(key in properties)) {
          errors.push(`${path}: 不允许的额外属性 ${key}`);
        }
      }
    }
  }

  for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const) {
    const branches = schema[keyword];
    if (!Array.isArray(branches)) {
      continue;
    }
    const branchErrors = branches.map((branch) => {
      const local: string[] = [];
      walk(branch, data, root, path, local);
      return local;
    });
    const passCount = branchErrors.filter((local) => local.length === 0).length;
    if (keyword === 'allOf' && passCount !== branchErrors.length) {
      errors.push(`${path}: allOf 有 ${branchErrors.length - passCount} 个子 schema 未通过`);
    }
    if (keyword === 'anyOf' && passCount === 0) {
      errors.push(`${path}: anyOf 没有任何子 schema 通过`);
    }
    if (keyword === 'oneOf' && passCount !== 1) {
      errors.push(`${path}: oneOf 需要恰 1 个子 schema 通过，实际 ${passCount}`);
      for (const local of branchErrors) {
        errors.push(...local);
      }
    }
  }
}
