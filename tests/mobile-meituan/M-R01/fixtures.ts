/**
 * M-R01 fixture 装载器与**诚实性 + 脱敏**门禁（读 `./fixtures/*.json`）。
 *
 * 每个 fixture 文件是一层信封：
 * ```
 * { fixtureId, operation, protocolVersion, provenance, verificationMode, capturedAt, note, value }
 * ```
 * `value` 才是协议形状的载荷（`{ code, msg, data }` 等）。
 *
 * ## 门禁（{@link validateFixture}）
 *
 * 1. **形状**：上述字段齐全且类型正确；
 * 2. **诚实性**：`synthetic-*` 的 fixture 必须 `capturedAt === null` 且 `verificationMode === 'fixture'`；
 *    `real-captured-redacted` 必须有 ISO `capturedAt`。防止把合成 fixture 冒充实测捕获。
 * 3. **协议版本已登记**：`protocolVersion` 必须能在 `ENVELOPE_REGISTRY` 找到；
 *    `value` 必须含该版本规格的**全部必需字段**。
 * 4. **脱敏**：`value` 必须先过 {@link scanForPii}（空 = 通过）。
 *
 * 任何一条不过 ⇒ 测试变红。这是 fixture 入库/入证据的唯一出口。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { scanForPii } from './redaction.js';
import { lookupEnvelopeSpec, type ProtocolFieldSpec } from './protocol-schema.js';

export const PROVENANCE_KINDS = ['synthetic-unverified', 'synthetic-doc-shaped', 'real-captured-redacted'] as const;
export type FixtureProvenance = (typeof PROVENANCE_KINDS)[number];

export const FIXTURE_OPERATIONS = ['search', 'menu', 'preview', 'submit', 'query', 'cancel'] as const;
export type FixtureOperation = (typeof FIXTURE_OPERATIONS)[number];

export interface MeituanFixtureFile {
  readonly fixtureId: string;
  readonly operation: FixtureOperation;
  readonly protocolVersion: string;
  readonly provenance: FixtureProvenance;
  readonly verificationMode: 'fixture' | 'real';
  readonly capturedAt: string | null;
  readonly note: string;
  readonly value: unknown;
}

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));

export function listFixtureFiles(): readonly string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort();
}

export function fixturePath(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

export function loadFixture(name: string): MeituanFixtureFile {
  return JSON.parse(readFileSync(fixturePath(name), 'utf8')) as MeituanFixtureFile;
}

export function loadFixtures(): readonly MeituanFixtureFile[] {
  return listFixtureFiles().map((name) => loadFixture(name));
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** 对单个 fixture 做全部门禁检查，返回问题列表（空 = 通过）。 */
export function validateFixture(file: MeituanFixtureFile): readonly string[] {
  const problems: string[] = [];
  const raw = file as unknown as Record<string, unknown>;

  for (const key of ['fixtureId', 'operation', 'protocolVersion', 'provenance', 'verificationMode', 'note']) {
    if (typeof raw[key] !== 'string' || (raw[key] as string).length === 0) {
      problems.push(`字段 ${key} 缺失或非非空字符串`);
    }
  }
  if (!(FIXTURE_OPERATIONS as readonly string[]).includes(file.operation)) {
    problems.push(`operation 未登记：${String(file.operation)}`);
  }
  if (!(PROVENANCE_KINDS as readonly string[]).includes(file.provenance)) {
    problems.push(`provenance 未登记：${String(file.provenance)}`);
  }
  if (file.verificationMode !== 'fixture' && file.verificationMode !== 'real') {
    problems.push(`verificationMode 必须是 fixture/real，得到 ${String(file.verificationMode)}`);
  }

  // 诚实性：合成 fixture 不得自称实测捕获。
  if (file.provenance.startsWith('synthetic-')) {
    if (file.capturedAt !== null) {
      problems.push(`synthetic fixture 的 capturedAt 必须为 null，得到 ${String(file.capturedAt)}`);
    }
    if (file.verificationMode === 'real') {
      problems.push('synthetic fixture 不得声明 verificationMode=real');
    }
  }
  if (file.provenance === 'real-captured-redacted') {
    if (typeof file.capturedAt !== 'string' || !ISO_RE.test(file.capturedAt)) {
      problems.push('real-captured-redacted fixture 必须有 ISO-8601 capturedAt');
    }
  }

  // 协议版本与结构。
  const spec = lookupEnvelopeSpec(file.protocolVersion);
  if (spec === undefined) {
    problems.push(`protocolVersion 未在 ENVELOPE_REGISTRY 登记：${file.protocolVersion}`);
  } else if (typeof file.value !== 'object' || file.value === null || Array.isArray(file.value)) {
    problems.push('value 必须是协议信封对象');
  } else {
    const envelope = file.value as Record<string, unknown>;
    for (const field of spec.fields as readonly ProtocolFieldSpec[]) {
      if (field.required && !(field.name in envelope)) {
        problems.push(`信封缺少 ${spec.version} 的必需字段：${field.name}`);
      }
    }
  }

  // 脱敏。
  for (const violation of scanForPii(file.value)) {
    problems.push(`PII 残留（${violation.path}/${violation.kind}）：${violation.reason}`);
  }

  return problems;
}

export function assertFixtureValid(file: MeituanFixtureFile): void {
  const problems = validateFixture(file);
  if (problems.length > 0) {
    throw new Error(`[MR01_FIXTURE_INVALID] ${file.fixtureId}: ${problems.join('; ')}`);
  }
}

/** 按 operation 统计 fixture 数（用于断言覆盖面）。 */
export function fixtureCountsByOperation(): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const file of loadFixtures()) {
    counts[file.operation] = (counts[file.operation] ?? 0) + 1;
  }
  return Object.freeze(counts);
}
