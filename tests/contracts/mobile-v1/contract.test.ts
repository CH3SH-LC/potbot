import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

/**
 * mobile-v1 契约测试（C-contract 包）。
 *
 * 目标不是「校验器说 OK 就 OK」，而是**用负例证明校验器不是空壳**：
 * 每个 schema 至少一个正例 fixture 通过；至少 3 条反向对照（篡改必需字段 /
 * 塞入密钥明文字段 / fixture 模式冒充 confirmed）必须被真实拒绝；词表与 schema
 * enum 一致；没有孤儿 schema。
 *
 * 校验器 `validate.mjs` 是零依赖 ESM，由 vitest 以子进程方式调用真实 CLI，
 * 断言的是**真实退出码与真实输出**，而不是把校验逻辑在测试里复制一份。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACT_ROOT = resolve(HERE, '../../../contracts/mobile-v1');
const VALIDATOR = join(CONTRACT_ROOT, 'validate.mjs');
const SCHEMAS_DIR = join(CONTRACT_ROOT, 'schemas');
const FIXTURES_DIR = join(CONTRACT_ROOT, 'fixtures');
const VOCAB_PATH = join(CONTRACT_ROOT, 'vocab', 'status.json');

/** 需要逐字一致的核心词表词（README「关键不变量」与 §5 状态词表）。 */
const REQUIRED_RECEIPT_STATES = [
  'prepared',
  'authorized',
  'submitting',
  'submitted',
  'unknown',
  'confirmed',
  'failed',
  'cancelled',
];
const REQUIRED_LAYERS = [
  'unit',
  'contract',
  'real-api',
  'on-device',
  'consumer-reopen',
  'cross-lane',
];
const REQUIRED_MODES = ['fixture', 'real'];

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runValidator(fixturesDir?: string): RunResult {
  const args = [VALIDATOR];
  if (fixturesDir) args.push(fixturesDir);
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function listJsonFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (entry.endsWith('.json')) out.push(abs);
    }
  };
  walk(root);
  return out.sort();
}

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

/**
 * 把若干 fixture 信封写进一个临时目录并跑真实 CLI，返回运行结果。
 * 校验器按自身目录解析 `$schemaRef`，因此临时目录里的 fixture 仍指向正式 schema。
 */
function runWithFixtures(name: string, fixtures: Array<Record<string, unknown>>): RunResult {
  const dir = mkdtempSync(join(tmpdir(), `potbot-contract-${name}-`));
  tempDirs.push(dir);
  fixtures.forEach((fixture, index) => {
    writeFileSync(join(dir, `case-${index}.json`), JSON.stringify(fixture, null, 2), 'utf8');
  });
  return runValidator(dir);
}

interface SchemaDoc {
  $defs?: Record<string, { enum?: unknown }>;
}

function schemaFiles(): string[] {
  return readdirSync(SCHEMAS_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort();
}

function enumOf(schemaFile: string, defName: string): string[] | undefined {
  const doc = loadJson(join(SCHEMAS_DIR, schemaFile)) as SchemaDoc;
  const value = doc.$defs?.[defName]?.enum;
  return Array.isArray(value) ? (value as string[]) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 统计以 `FAIL` 开头的行——比 `toContain('FAIL')` 精确，避免命中 summary 行里的 `0 FAIL`。 */
function failLines(stdout: string): string[] {
  return stdout.split(/\r?\n/).filter((line) => line.startsWith('FAIL'));
}

function fixtureValue(schemaFile: string, predicate: (value: Record<string, unknown>) => boolean) {
  for (const file of listJsonFiles(FIXTURES_DIR)) {
    const envelope = loadJson(file);
    if (!isRecord(envelope) || typeof envelope.$schemaRef !== 'string') continue;
    if (envelope.$schemaRef.split('#')[0] !== `schemas/${schemaFile}`) continue;
    if (!isRecord(envelope.value)) continue;
    if (predicate(envelope.value)) return envelope.value;
  }
  return undefined;
}

// --------------------------------------------------------------------------
// 1. 正例：全部 fixture 通过（真实 CLI 退出码）
// --------------------------------------------------------------------------

describe('mobile-v1 契约：正例', () => {
  it('默认运行校验 fixtures/** 全部通过并 exit 0', () => {
    const run = runValidator();
    expect(run.stderr).toBe('');
    expect(failLines(run.stdout)).toEqual([]);
    expect(run.status).toBe(0);

    const fixtureCount = listJsonFiles(FIXTURES_DIR).length;
    expect(run.stdout).toContain(`summary: ${fixtureCount} PASS, 0 FAIL`);
    expect(fixtureCount).toBeGreaterThan(0);
  });

  it('每个 schemas/*.json 都被至少一个 fixture 引用（无孤儿 schema）', () => {
    const run = runValidator();
    const total = schemaFiles().length;
    // 冻结计数：注册表当前 11 个 schema（S06 追加 security-keystore / lifecycle-plan 后）。
    // 新增 schema 必须同时带正例 fixture 并同步本计数，否则孤儿检查会静默放过。
    expect(total).toBe(11);
    // CLI 输出覆盖率 n/n，且不打印“孤儿 schema”
    expect(run.stdout).toContain(`schema 覆盖: ${total}/${total}`);
    expect(run.stdout).not.toContain('孤儿 schema');

    // 再做一次独立复算，防止 CLI 覆盖统计本身写错
    const referenced = new Set<string>();
    for (const file of listJsonFiles(FIXTURES_DIR)) {
      const envelope = loadJson(file);
      if (!isRecord(envelope) || typeof envelope.$schemaRef !== 'string') continue;
      referenced.add(envelope.$schemaRef.split('#')[0] ?? '');
    }
    for (const name of schemaFiles()) {
      expect(referenced.has(`schemas/${name}`)).toBe(true);
    }
  });

  it('fixture 模式但状态为非 confirmed（prepared）是允许的——反证规则不是“一律拒绝 fixture”', () => {
    const value = fixtureValue(
      'external-receipt.schema.json',
      (v) => v.verificationMode === 'fixture' && v.observedState === 'prepared',
    );
    expect(value).toBeDefined();
    // 该正例能通过校验器（如果它反而失败，说明规则过宽/过严都错）
    const run = runValidator();
    expect(run.status).toBe(0);
  });
});

// --------------------------------------------------------------------------
// 2. 反向对照：负例必须被真实拒绝（防自证）
// --------------------------------------------------------------------------

describe('mobile-v1 契约：负例（校验器不得是空壳）', () => {
  it('篡改必需字段：删掉 command.commandId ⇒ FAIL', () => {
    const run = runWithFixtures('missing-required', [
      {
        $schemaRef: 'schemas/command.schema.json',
        note: 'neg: 缺少必需字段 commandId',
        value: {
          schemaVersion: 'mobile-v1',
          operation: 'create',
          idempotencyKey: 'idem-x',
          payload: {},
        },
      },
    ]);
    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain('FAIL');
    expect(run.stdout).toContain('required');
    expect(run.stdout).toContain('commandId');
  });

  it('篡改必需字段：event.status=succeeded 但不带 resultRef（fail-closed）⇒ FAIL', () => {
    const run = runWithFixtures('fail-closed', [
      {
        $schemaRef: 'schemas/event.schema.json',
        note: 'neg: 缺执行器却上报 succeeded',
        value: {
          eventId: 'evt-x',
          seq: 1,
          commandId: 'cmd-x',
          revision: 0,
          status: 'succeeded',
        },
      },
    ]);
    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain('FAIL');
    expect(run.stdout).toContain('resultRef');
  });

  it('塞入密钥明文字段：多出 apiKey ⇒ FAIL（additionalProperties=false）', () => {
    const run = runWithFixtures('secret-field', [
      {
        $schemaRef: 'schemas/model-port.schema.json',
        note: 'neg: 明文密钥字段',
        value: {
          messages: [{ role: 'user', content: 'hi' }],
          toolSchemas: [],
          cancellation: { token: 'cancel-1' },
          budget: { maxTokens: 128 },
          keyRef: 'keyref:deepseek-app-primary',
          model: 'deepseek-flash',
          apiKey: 'sk-0123456789abcdef',
        },
      },
    ]);
    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain('FAIL');
    expect(run.stdout).toContain('apiKey');
  });

  it('塞入密钥明文：keyRef 不是引用而是明文 key ⇒ FAIL（pattern）', () => {
    const run = runWithFixtures('secret-plaintext', [
      {
        $schemaRef: 'schemas/model-port.schema.json',
        note: 'neg: keyRef 放明文',
        value: {
          messages: [{ role: 'user', content: 'hi' }],
          toolSchemas: [],
          cancellation: { token: 'cancel-1' },
          budget: { maxTokens: 128 },
          keyRef: 'sk-0123456789abcdef',
          model: 'deepseek-flash',
        },
      },
    ]);
    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain('FAIL');
    expect(run.stdout).toContain('keyRef');
  });

  it('把 fixture 模式冒充 confirmed ⇒ FAIL（不变量 1）', () => {
    const run = runWithFixtures('fake-confirmed', [
      {
        $schemaRef: 'schemas/external-receipt.schema.json',
        note: 'neg: fixture 冒充真实完成',
        value: {
          actionId: 'act-x',
          provider: 'meituan',
          requestRef: 'req-x',
          externalId: 'order-x',
          observedState: 'confirmed',
          observedAt: '2026-10-03T08:00:00Z',
          evidenceRef: 'evidence:x',
          verificationMode: 'fixture',
        },
      },
    ]);
    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain('FAIL');
    expect(run.stdout).toContain('oneOf');
  });

  it('缺 verificationMode 的外部回执 ⇒ FAIL（模式必须声明）', () => {
    const run = runWithFixtures('missing-mode', [
      {
        $schemaRef: 'schemas/external-receipt.schema.json',
        note: 'neg: 没声明 verificationMode',
        value: {
          actionId: 'act-x',
          provider: 'meituan',
          requestRef: 'req-x',
          externalId: 'order-x',
          observedState: 'submitted',
          observedAt: '2026-10-03T08:00:00Z',
          evidenceRef: 'evidence:x',
        },
      },
    ]);
    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain('FAIL');
  });

  it('存储端口返回电脑绝对路径（Windows 盘符与 POSIX 绝对路径）⇒ FAIL', () => {
    for (const badUri of ['C:\\Users\\<user>\\Desktop\\a.docx', '/home/user/a.docx']) {
      const run = runWithFixtures('abs-path', [
        {
          $schemaRef: 'schemas/storage-port.schema.json',
          note: 'neg: 桌面绝对路径',
          value: { operation: 'readBack', status: 'ok', uri: badUri },
        },
      ]);
      expect(run.status).not.toBe(0);
      expect(run.stdout).toContain('FAIL');
      expect(run.stdout).toContain('uri');
    }
  });

  it('模板清单把四个就绪态合并成一个布尔 ⇒ FAIL', () => {
    const valid = fixtureValue('template-manifest.schema.json', (v) => v.id === 'word-doc');
    expect(valid).toBeDefined();
    const merged = { ...(valid as Record<string, unknown>), ready: true };
    const run = runWithFixtures('merged-ready', [
      { $schemaRef: 'schemas/template-manifest.schema.json', note: 'neg: 合并就绪态', value: merged },
    ]);
    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain('FAIL');
    expect(run.stdout).toContain('ready');
  });

  it('指向不存在的 schema 引用 ⇒ FAIL（不是静默跳过）', () => {
    const run = runWithFixtures('bad-ref', [
      {
        $schemaRef: 'schemas/does-not-exist.schema.json',
        note: 'neg: 悬空 schemaRef',
        value: {},
      },
    ]);
    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain('FAIL');
  });
});

// --------------------------------------------------------------------------
// 2b. 新增 schema（S06 追加注册）的反向对照：拒绝路径必须真实生效
//     security-keystore.schema.json / lifecycle-plan.schema.json 不只要「有正例」，
//     其 oneOf / required / pattern / not 不变量也要能挡住负例，否则覆盖是空壳。
// --------------------------------------------------------------------------

describe('mobile-v1 契约：新增 schema 负例（S06 追加注册）', () => {
  it('key.import 缺一次性通道 sourceRef ⇒ FAIL（required）', () => {
    const run = runWithFixtures('ks-missing-source', [
      {
        $schemaRef: 'schemas/security-keystore.schema.json',
        note: 'neg: key.import 缺 sourceRef',
        value: { operation: 'key.import', kind: 'model', keyRef: 'keyref:model-app-primary' },
      },
    ]);
    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain('FAIL');
    expect(run.stdout).toContain('sourceRef');
  });

  it('keyRef 是无 keyref: 前缀的明文形态 ⇒ FAIL（pattern）', () => {
    const run = runWithFixtures('ks-plaintext-keyref', [
      {
        $schemaRef: 'schemas/security-keystore.schema.json',
        note: 'neg: keyRef 放明文 sk-…',
        value: {
          operation: 'key.import',
          kind: 'model',
          sourceRef: 'oneshot-channel-1',
          keyRef: 'sk-live-abcdefghijklmn',
        },
      },
    ]);
    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain('FAIL');
    expect(run.stdout).toContain('keyRef');
  });

  it('外部副作用悬而未决却要续跑 ⇒ FAIL（不变量 1：not 禁止重做）', () => {
    const run = runWithFixtures('lp-external-resume', [
      {
        $schemaRef: 'schemas/lifecycle-plan.schema.json#/$defs/taskRecoveryPlan',
        note: 'neg: externalPending 却 resume-from-cursor',
        value: {
          taskId: 'task-x',
          state: 'unknown-external',
          action: 'resume-from-cursor',
          resumeFromStep: 2,
          totalSteps: 5,
          externalPending: true,
          mayRedoCompletedSteps: false,
          detail: 'x',
        },
      },
    ]);
    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain('FAIL');
    expect(run.stdout).toContain('命中了被禁止的子模式');
  });

  it('mayRedoCompletedSteps=true ⇒ FAIL（恒为 false 的 const）', () => {
    const run = runWithFixtures('lp-redo-completed', [
      {
        $schemaRef: 'schemas/lifecycle-plan.schema.json#/$defs/taskRecoveryPlan',
        note: 'neg: 允许重跑已完成步骤',
        value: {
          taskId: 'task-x',
          state: 'reclaimed',
          action: 'resume-from-cursor',
          resumeFromStep: 1,
          totalSteps: 5,
          externalPending: false,
          mayRedoCompletedSteps: true,
          detail: 'x',
        },
      },
    ]);
    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain('FAIL');
    expect(run.stdout).toContain('mayRedoCompletedSteps');
  });

  it('终态任务却安排动作 ⇒ FAIL（不变量 2：终态不重跑）', () => {
    const run = runWithFixtures('lp-terminal-action', [
      {
        $schemaRef: 'schemas/lifecycle-plan.schema.json#/$defs/taskRecoveryPlan',
        note: 'neg: completed 却 resume-from-cursor',
        value: {
          taskId: 'task-x',
          state: 'completed',
          action: 'resume-from-cursor',
          resumeFromStep: null,
          totalSteps: 4,
          externalPending: false,
          mayRedoCompletedSteps: false,
          detail: 'x',
        },
      },
    ]);
    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain('FAIL');
    expect(run.stdout).toContain('命中了被禁止的子模式');
  });
});

// --------------------------------------------------------------------------
// 3. 词表与 schema enum 一致
// --------------------------------------------------------------------------

describe('mobile-v1 契约：状态词表一致性', () => {
  it('vocab/status.json 精确包含要求的三组词，且无多余分组', () => {
    const vocab = loadJson(VOCAB_PATH) as Record<string, unknown>;
    expect(Object.keys(vocab).sort()).toEqual(
      ['$comment', 'externalReceiptStates', 'verificationLayers', 'verificationModes', 'version'].sort(),
    );
    expect(vocab.externalReceiptStates).toEqual(REQUIRED_RECEIPT_STATES);
    expect(vocab.verificationLayers).toEqual(REQUIRED_LAYERS);
    expect(vocab.verificationModes).toEqual(REQUIRED_MODES);
  });

  it('external-receipt 的 observedState enum 与词表逐字一致', () => {
    const observed = enumOf('external-receipt.schema.json', 'observedState');
    expect(observed).toBeDefined();
    expect(observed).toEqual(REQUIRED_RECEIPT_STATES);
  });

  it('所有 schema 中出现的 verificationMode / verificationLayer enum 都与词表一致', () => {
    const vocab = loadJson(VOCAB_PATH) as Record<string, unknown>;

    let modeCount = 0;
    let layerCount = 0;
    for (const name of schemaFiles()) {
      const modes = enumOf(name, 'verificationMode');
      if (modes) {
        modeCount += 1;
        expect(modes).toEqual(vocab.verificationModes);
      }
      const layers = enumOf(name, 'verificationLayer');
      if (layers) {
        layerCount += 1;
        expect(layers).toEqual(vocab.verificationLayers);
      }
    }
    // 词表若没被任何 schema 引用，一致性断言就成了空转
    expect(modeCount).toBeGreaterThanOrEqual(3);
    expect(layerCount).toBeGreaterThanOrEqual(2);
  });
});

// --------------------------------------------------------------------------
// 4. 覆盖度：每个 schema 都有正例
// --------------------------------------------------------------------------

describe('mobile-v1 契约：覆盖度', () => {
  it('schemas/ 下每个文件都至少有一个正例 fixture 通过校验', () => {
    const run = runValidator();
    expect(run.status).toBe(0);
    const referenced = new Set<string>();
    for (const file of listJsonFiles(FIXTURES_DIR)) {
      const envelope = loadJson(file);
      if (!isRecord(envelope) || typeof envelope.$schemaRef !== 'string') continue;
      referenced.add(envelope.$schemaRef.split('#')[0] ?? '');
    }
    for (const name of schemaFiles()) {
      expect(referenced.has(`schemas/${name}`)).toBe(true);
    }
  });

  it('types.ts 存在（与 schema 手工保持同步，见文件头一致性说明）', () => {
    const typesPath = join(CONTRACT_ROOT, 'types.ts');
    const source = readFileSync(typesPath, 'utf8');
    expect(source).toContain('SCHEMA_TYPES_SYNC_NOTE');
  });
});

// --------------------------------------------------------------------------
// 5. 目录卫生：契约必须自带 README 与词表
// --------------------------------------------------------------------------

describe('mobile-v1 契约：交付物齐全', () => {
  it('README.md / validate.mjs / types.ts / vocab/status.json 均存在', () => {
    for (const rel of ['README.md', 'validate.mjs', 'types.ts', join('vocab', 'status.json')]) {
      expect(statSync(join(CONTRACT_ROOT, rel)).isFile()).toBe(true);
    }
  });

  it('fixtures 四个语义目录 success/conflict/cancel/error 都存在且非空', () => {
    for (const dir of ['success', 'conflict', 'cancel', 'error']) {
      const abs = join(FIXTURES_DIR, dir);
      expect(statSync(abs).isDirectory()).toBe(true);
      expect(readdirSync(abs).length).toBeGreaterThan(0);
    }
  });
});
