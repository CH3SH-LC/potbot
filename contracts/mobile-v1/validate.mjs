#!/usr/bin/env node
/**
 * contracts/mobile-v1/validate.mjs
 *
 * 零依赖的 JSON Schema **子集** 校验器 + fixtures 校验 CLI。
 *
 * 本仓库没有任何运行时依赖，也没有 ajv，因而这里手写一个够用的小校验器。
 * 它**不是**完整 JSON Schema 实现，只支持 README.md “支持的 JSON Schema 子集”一节
 * 列出的关键字；遇到未支持的关键字不会假装通过——`$ref` 只允许同文档 `#/$defs/...`，
 * 其它形式直接报错。
 *
 * 用法：
 *   node contracts/mobile-v1/validate.mjs [fixturesDir]
 *
 * 默认校验 `fixtures/**`；`$schemaRef` 相对本文件目录解析（形如
 * `schemas/command.schema.json` 或 `schemas/model-port.schema.json#/$defs/streamChunk`）。
 * 任一 fixture 失败 ⇒ exit 1；全部通过 ⇒ exit 0。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = join(HERE, 'schemas');
const DEFAULT_FIXTURES = join(HERE, 'fixtures');

// ---------------------------------------------------------------------------
// 加载与 $ref 解析
// ---------------------------------------------------------------------------

const SCHEMA_CACHE = new Map();

function loadSchemaDoc(absPath) {
  if (!SCHEMA_CACHE.has(absPath)) {
    SCHEMA_CACHE.set(absPath, JSON.parse(readFileSync(absPath, 'utf8')));
  }
  return SCHEMA_CACHE.get(absPath);
}

function pointer(doc, frag) {
  const segments = frag
    .split('/')
    .slice(1)
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cursor = doc;
  for (const seg of segments) {
    if (cursor === null || cursor === undefined) return undefined;
    cursor = cursor[seg];
  }
  return cursor;
}

/** 只支持同文档 `#` 或 `#/...` 指针；其它 $ref 直接抛错，不静默忽略。 */
function resolveRef(ref, doc) {
  if (typeof ref !== 'string') throw new Error('$ref must be a string');
  if (ref === '#') return doc;
  if (!ref.startsWith('#/')) {
    throw new Error(`unsupported $ref (只有同文档 #/$defs/... 被支持): ${ref}`);
  }
  const target = pointer(doc, ref.slice(1));
  if (target === undefined) throw new Error(`unresolvable $ref: ${ref}`);
  return target;
}

// ---------------------------------------------------------------------------
// 值工具
// ---------------------------------------------------------------------------

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value; // string | boolean | object | undefined | function | symbol | bigint
}

function matchesType(value, expected) {
  const actual = typeOf(value);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  if (expected === 'integer') return actual === 'integer';
  return actual === expected;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepEqual(a, b) {
  if (a === b) return true;
  const ta = typeOf(a);
  if (ta !== typeOf(b)) return false;
  if (ta === 'array') {
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (ta === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

// ---------------------------------------------------------------------------
// 校验核心（支持的子集见 README）
// ---------------------------------------------------------------------------

function validate(instance, schema, doc, path, errors) {
  if (schema === true || schema === undefined) return;
  if (schema === false) {
    errors.push({ path, message: 'schema is false：该值被禁止' });
    return;
  }
  if (!isPlainObject(schema)) {
    errors.push({ path, message: `非法 schema 节点（期望对象）: ${JSON.stringify(schema)}` });
    return;
  }

  // $ref：只做同文档指针替换，不合并兄弟关键字（与 draft 一致）。
  if (schema.$ref !== undefined) {
    let target;
    try {
      target = resolveRef(schema.$ref, doc);
    } catch (err) {
      errors.push({ path, message: err.message });
      return;
    }
    validate(instance, target, doc, path, errors);
    return;
  }

  if (schema.type !== undefined) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!expected.some((t) => matchesType(instance, t))) {
      errors.push({
        path,
        message: `type: 期望 ${expected.join('|')}，实际 ${typeOf(instance)}`,
      });
      return; // 类型不符时不再对子关键字报错，避免噪音
    }
  }

  if (schema.const !== undefined && !deepEqual(instance, schema.const)) {
    errors.push({ path, message: `const: 期望 ${JSON.stringify(schema.const)}` });
  }

  if (schema.enum !== undefined) {
    if (!schema.enum.some((candidate) => deepEqual(instance, candidate))) {
      errors.push({
        path,
        message: `enum: ${JSON.stringify(instance)} 不在 ${JSON.stringify(schema.enum)}`,
      });
    }
  }

  if (typeof instance === 'number') {
    if (schema.minimum !== undefined && instance < schema.minimum) {
      errors.push({ path, message: `minimum: ${instance} < ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && instance > schema.maximum) {
      errors.push({ path, message: `maximum: ${instance} > ${schema.maximum}` });
    }
  }

  if (typeof instance === 'string') {
    if (schema.minLength !== undefined && instance.length < schema.minLength) {
      errors.push({ path, message: `minLength: ${instance.length} < ${schema.minLength}` });
    }
    if (schema.maxLength !== undefined && instance.length > schema.maxLength) {
      errors.push({ path, message: `maxLength: ${instance.length} > ${schema.maxLength}` });
    }
    if (schema.pattern !== undefined) {
      let re;
      try {
        re = new RegExp(schema.pattern);
      } catch (err) {
        errors.push({ path, message: `pattern 无法编译: ${schema.pattern}` });
        re = null;
      }
      if (re && !re.test(instance)) {
        errors.push({
          path,
          message: `pattern: ${JSON.stringify(instance)} 不匹配 ${JSON.stringify(schema.pattern)}`,
        });
      }
    }
  }

  if (Array.isArray(instance)) {
    if (schema.minItems !== undefined && instance.length < schema.minItems) {
      errors.push({ path, message: `minItems: ${instance.length} < ${schema.minItems}` });
    }
    if (schema.maxItems !== undefined && instance.length > schema.maxItems) {
      errors.push({ path, message: `maxItems: ${instance.length} > ${schema.maxItems}` });
    }
    if (schema.items !== undefined) {
      if (Array.isArray(schema.items)) {
        schema.items.forEach((sub, i) => {
          if (i < instance.length) validate(instance[i], sub, doc, `${path}[${i}]`, errors);
        });
      } else {
        instance.forEach((item, i) => validate(item, schema.items, doc, `${path}[${i}]`, errors));
      }
    }
  }

  if (isPlainObject(instance)) {
    if (schema.required !== undefined) {
      for (const key of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(instance, key)) {
          errors.push({ path, message: `required: 缺少必需字段 "${key}"` });
        }
      }
    }
    if (schema.properties !== undefined) {
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (Object.prototype.hasOwnProperty.call(instance, key)) {
          validate(instance[key], sub, doc, `${path}.${key}`, errors);
        }
      }
    }
    if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
      const known = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(instance)) {
        if (known.has(key)) continue;
        if (schema.additionalProperties === false) {
          errors.push({ path, message: `additionalProperties: 不允许的字段 "${key}"` });
        } else {
          validate(instance[key], schema.additionalProperties, doc, `${path}.${key}`, errors);
        }
      }
    }
  }

  if (schema.allOf !== undefined) {
    for (const sub of schema.allOf) validate(instance, sub, doc, path, errors);
  }

  if (schema.anyOf !== undefined) {
    const ok = schema.anyOf.some((sub) => {
      const probe = [];
      validate(instance, sub, doc, path, probe);
      return probe.length === 0;
    });
    if (!ok) errors.push({ path, message: 'anyOf: 没有任何分支匹配' });
  }

  if (schema.oneOf !== undefined) {
    let matched = 0;
    const notes = [];
    schema.oneOf.forEach((sub, index) => {
      const probe = [];
      validate(instance, sub, doc, path, probe);
      if (probe.length === 0) matched += 1;
      else notes.push(`[${index + 1}] ${probe[0].path}: ${probe[0].message}`);
    });
    if (matched !== 1) {
      // 附上每个分支的首条失败原因，否则排障只能看到“0 个分支匹配”。
      const detail = notes.length > 0 ? `；分支诊断 -> ${notes.join(' | ')}` : '';
      errors.push({ path, message: `oneOf: ${matched} 个分支匹配（期望恰好 1 个）${detail}` });
    }
  }

  if (schema.not !== undefined) {
    const probe = [];
    validate(instance, schema.not, doc, path, probe);
    if (probe.length === 0) {
      errors.push({ path, message: 'not: 命中了被禁止的子模式' });
    }
  }
}

// ---------------------------------------------------------------------------
// fixtures CLI
// ---------------------------------------------------------------------------

function listJsonFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (entry.endsWith('.json')) out.push(abs);
    }
  };
  if (statSync(root).isDirectory()) walk(root);
  return out.sort();
}

function listSchemaFiles() {
  return readdirSync(SCHEMA_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => join(SCHEMA_DIR, name))
    .sort();
}

function resolveSchemaRef(ref) {
  if (typeof ref !== 'string' || ref.length === 0) {
    throw new Error('$schemaRef 缺失或不是字符串');
  }
  const hashIndex = ref.indexOf('#');
  const filePart = hashIndex >= 0 ? ref.slice(0, hashIndex) : ref;
  const frag = hashIndex >= 0 ? ref.slice(hashIndex + 1) : '';
  const abs = resolve(HERE, filePart);
  const schemaDirWithSep = SCHEMA_DIR + sep;
  if (abs !== SCHEMA_DIR && !abs.startsWith(schemaDirWithSep)) {
    throw new Error(`$schemaRef 必须指向 schemas/ 目录内: ${ref}`);
  }
  const doc = loadSchemaDoc(abs);
  const schema = frag === '' ? doc : pointer(doc, frag.startsWith('/') ? frag : `/${frag}`);
  if (schema === undefined) throw new Error(`$schemaRef 片段无法解析: ${ref}`);
  return { abs, ref, schema, doc };
}

function main() {
  const args = process.argv.slice(2);
  const fixturesDir = args[0] ? resolve(process.cwd(), args[0]) : DEFAULT_FIXTURES;
  const isDefaultRun = fixturesDir === DEFAULT_FIXTURES;

  const fixtureFiles = listJsonFiles(fixturesDir);
  const referenced = new Set();
  let pass = 0;
  const failures = [];

  console.log('mobile-v1 契约校验器（零依赖 JSON Schema 子集）');
  console.log(`fixtures 根目录: ${fixturesDir}`);
  console.log('');

  for (const file of fixtureFiles) {
    const relLabel = relative(fixturesDir, file).split(sep).join('/');
    let envelope;
    try {
      envelope = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      failures.push({ label: relLabel, ref: '-', errors: [{ path: '$', message: `JSON 解析失败: ${err.message}` }] });
      console.log(`FAIL  ${relLabel}  (JSON 解析失败)`);
      continue;
    }
    let resolved;
    try {
      resolved = resolveSchemaRef(envelope.$schemaRef);
    } catch (err) {
      failures.push({ label: relLabel, ref: String(envelope.$schemaRef), errors: [{ path: '$schemaRef', message: err.message }] });
      console.log(`FAIL  ${relLabel}  ($schemaRef 无效)`);
      continue;
    }
    referenced.add(resolved.abs);
    if (!Object.prototype.hasOwnProperty.call(envelope, 'value')) {
      failures.push({ label: relLabel, ref: resolved.ref, errors: [{ path: '$', message: 'fixture 信封缺少 value 字段' }] });
      console.log(`FAIL  ${relLabel}  ->  ${resolved.ref}  (缺少 value)`);
      continue;
    }
    const errors = [];
    validate(envelope.value, resolved.schema, resolved.doc, '$', errors);
    if (errors.length === 0) {
      pass += 1;
      console.log(`PASS  ${relLabel}  ->  ${resolved.ref}`);
    } else {
      failures.push({ label: relLabel, ref: resolved.ref, errors });
      console.log(`FAIL  ${relLabel}  ->  ${resolved.ref}`);
      for (const err of errors) console.log(`        ${err.path} : ${err.message}`);
    }
  }

  const schemaFiles = listSchemaFiles();
  const orphans = isDefaultRun ? schemaFiles.filter((abs) => !referenced.has(abs)) : [];

  console.log('');
  if (isDefaultRun) {
    console.log(`schema 覆盖: ${schemaFiles.length - orphans.length}/${schemaFiles.length} 个 schemas/*.json 被 fixture 引用`);
    for (const abs of orphans) {
      console.log(`FAIL  (孤儿 schema)  schemas/${relative(SCHEMA_DIR, abs).split(sep).join('/')}`);
    }
  } else {
    console.log('（自定义 fixtures 目录：跳过孤儿 schema 检查）');
  }

  const failCount = failures.length + orphans.length;
  console.log('');
  console.log(`summary: ${pass} PASS, ${failCount} FAIL`);
  process.exit(failCount === 0 ? 0 : 1);
}

main();
