/**
 * F-I19 契约门禁：在**一处**用**真实的**冻结校验器
 * `contracts/mobile-v1/validate.mjs` 实跑 F 线全部命令/事件 fixture。
 *
 * 为什么要有这个用例：
 *   F 线各包（F03/F04/F07/F08/F10 + system-actions）各自保留了自己的定向契约断言。
 *   本波（integration wave）对源头做了编辑，各包**各自**证明自己没漂移，但没有任何单一入口
 *   证明「整批 fixture 在当前源码下仍然全部合法」。本用例补上这个入口。
 *
 * 数据来源（全部只读消费，不复制字段定义）：
 *   - F03 conversations：本包构造器产出的 6 条 v1 Command（create/rename/archive/unarchive/bind/delete）；
 *   - F04 groups：4 条 Command（pause/resume/cancel/conditions）+ 2 条 Event（stage/completed）；
 *   - F07 memory：磁盘上已提交的 4 个 fixture（mutate/query 分支）；
 *   - F08 templates：本包 `allManifests()` 产出的 7 份 TemplateManifest；
 *   - F10 food：4 条 Command（store/menu query + cart add_line/set_quantity）；
 *   - system-actions：磁盘上已提交的 5 个 fixture（calendar/reminder/research）。
 *
 * 校验口径：
 *   把以上 fixture 写进同一个临时目录，**只跑一次**真校验器，断言
 *   `summary: <N> PASS, 0 FAIL`（N = 实际写入的 fixture 数）且退出码 0。
 *   再配三个**必须失败**的反向对照，证明校验器不是空转：
 *     1) succeeded 事件缺 resultRef（fail-closed）；
 *     2) mutate 命令缺 expectedRevision（乐观锁）；
 *     3) 清单里塞合并就绪字段 ready（四态不得合并）。
 *
 * 定向运行：`npx vitest run tests/mobile-ui/contracts --reporter=basic`
 * 本波实测：见同目录 README.md。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// F03 conversations —— 命令构造器 + 该包自己的种子状态夹具。
import {
  buildArchiveConversationCommand,
  buildBindTaskCommand,
  buildCreateConversationCommand,
  buildDeleteConversationCommand,
  buildRenameConversationCommand,
  buildUnarchiveConversationCommand,
} from '../../../apps/mobile-ui/src/conversations/index.js';
import { IDS as F03_IDS, fullScope, seed as seedConversations } from '../F03/fixtures.js';

// F04 groups —— 命令构造器 + Event 构造器 + 该包自己的种子状态夹具。
import {
  buildCancelCommand,
  buildChangeConditionsCommand,
  buildPauseCommand,
  buildResumeCommand,
} from '../../../apps/mobile-ui/src/groups/index.js';
import { IDS as F04_IDS, makeEvent, seed as seedGroups } from '../F04/fixtures.js';

// F08 templates —— 清单产出 + 该包自己的四态夹具。
import { allManifests, manifestFor } from '../../../apps/mobile-ui/src/templates/index.js';
import { fixtureState } from '../F08/fixtures.js';

// F10 food —— 内核命令构造器。
import {
  buildCartMutationCommand,
  buildMenuQueryCommand,
  buildStoreQueryCommand,
} from '../../../apps/mobile-ui/src/food/index.js';

// ---------------------------------------------------------------------------
// 基础设施
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const VALIDATOR = join(REPO_ROOT, 'contracts', 'mobile-v1', 'validate.mjs');

const COMMAND_SCHEMA = 'schemas/command.schema.json';
const EVENT_SCHEMA = 'schemas/event.schema.json';
const MANIFEST_SCHEMA = 'schemas/template-manifest.schema.json';

/** 一个待校验 fixture：写盘后由真校验器按 schemaRef 解析。 */
interface Fixture {
  /** 文件名（在临时目录内唯一）。 */
  readonly name: string;
  /** `$schemaRef`，相对 `contracts/mobile-v1/`。 */
  readonly schemaRef: string;
  readonly value: unknown;
  /** 来源标签（分类计数与可读性），如 'F03'。 */
  readonly source: string;
}

function runValidator(fixturesDir: string): { status: number; stdout: string } {
  try {
    const stdout = execFileSync(process.execPath, [VALIDATOR, fixturesDir], { encoding: 'utf8' });
    return { status: 0, stdout };
  } catch (error) {
    const err = error as { status?: number; stdout?: string };
    return { status: err.status ?? -1, stdout: err.stdout ?? '' };
  }
}

/** 把 fixtures 写进一个临时目录跑真校验器，跑完即清理。 */
function validateBatch(fixtures: readonly Fixture[]): { status: number; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), 'f-i19-contracts-'));
  try {
    for (const fixture of fixtures) {
      writeFileSync(
        join(dir, fixture.name),
        JSON.stringify({ $schemaRef: fixture.schemaRef, note: `${fixture.source}:${fixture.name}`, value: fixture.value }, null, 2),
        'utf8',
      );
    }
    return runValidator(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 从磁盘上的 fixture 目录读取 {@link Fixture}（envelope：`$schemaRef` + `value`）。 */
function diskFixtures(relDir: string, source: string): Fixture[] {
  const absDir = join(REPO_ROOT, relDir);
  expect(existsSync(absDir)).toBe(true);
  return readdirSync(absDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const envelope = JSON.parse(readFileSync(join(absDir, name), 'utf8')) as {
        $schemaRef: unknown;
        value: unknown;
      };
      if (typeof envelope.$schemaRef !== 'string') {
        throw new Error(`${relDir}/${name} 缺少字符串 $schemaRef`);
      }
      return { name: `${source}__${basename(name)}`, schemaRef: envelope.$schemaRef, value: envelope.value, source };
    });
}

// ---------------------------------------------------------------------------
// 各来源的 fixture 收集
// ---------------------------------------------------------------------------

const F03_CTX = { commandId: 'cmd-f-i19-f03', idempotencyKey: 'idem-f-i19-f03' } as const;

function f03Fixtures(): Fixture[] {
  const state = seedConversations();
  const commands: Record<string, unknown> = {
    'conv-create.json': buildCreateConversationCommand(F03_CTX, { goal: '把周报改成一页', templateId: 'word-doc' }),
    'conv-rename.json': buildRenameConversationCommand(F03_CTX, state, { conversationId: F03_IDS.pitch, title: '路演终版' }),
    'conv-archive.json': buildArchiveConversationCommand(F03_CTX, state, F03_IDS.pitch),
    'conv-unarchive.json': buildUnarchiveConversationCommand(F03_CTX, state, F03_IDS.archived),
    'conv-bind.json': buildBindTaskCommand(F03_CTX, state, {
      conversationId: F03_IDS.pitch,
      task: { taskId: 'task-i19', title: '新任务', status: 'pending' },
    }),
    'conv-delete.json': buildDeleteConversationCommand(F03_CTX, state, { conversationId: F03_IDS.pitch, scope: fullScope() }),
  };
  return Object.entries(commands).map(([name, value]) => ({ name: `F03__${name}`, schemaRef: COMMAND_SCHEMA, value, source: 'F03' }));
}

const F04_BASE = { taskId: F04_IDS.weeklyTask, conversationId: F04_IDS.convWeekly, expectedRevision: 1 } as const;

function f04Fixtures(): Fixture[] {
  const seedState = seedGroups();
  // seed() 的任务只用于确认夹具可构造；命令直接按协议基线构造。
  expect(seedState.tasks.length).toBeGreaterThan(0);

  const commands: Record<string, unknown> = {
    'grp-pause.json': buildPauseCommand({ ...F04_BASE, reason: '用户暂离' }),
    'grp-resume.json': buildResumeCommand(F04_BASE),
    'grp-cancel.json': buildCancelCommand({ ...F04_BASE, reason: '用户取消' }),
    'grp-conditions.json': buildChangeConditionsCommand({ ...F04_BASE, changes: [{ field: 'budget', value: '已增加' }] }),
  };
  const events: Record<string, unknown> = {
    'grp-evt-stage.json': makeEvent(
      { taskId: F04_IDS.weeklyTask, kind: 'stage', at: '2026-10-03T10:40:00Z', stageId: 'review', stageStatus: 'active' },
      { revision: 2, seq: 1 },
    ),
    'grp-evt-completed.json': makeEvent(
      { taskId: F04_IDS.weeklyTask, kind: 'state', at: '2026-10-03T10:41:00Z', to: 'completed' },
      { revision: 3, seq: 2, status: 'succeeded', resultRef: 'artifact:art-draft@2', verificationMode: 'real' },
    ),
  };
  return [
    ...Object.entries(commands).map(([name, value]) => ({ name: `F04__${name}`, schemaRef: COMMAND_SCHEMA, value, source: 'F04' })),
    ...Object.entries(events).map(([name, value]) => ({ name: `F04__${name}`, schemaRef: EVENT_SCHEMA, value, source: 'F04' })),
  ];
}

function f07Fixtures(): Fixture[] {
  return diskFixtures('tests/mobile-ui/F07/fixtures/contract', 'F07');
}

function f08Fixtures(): Fixture[] {
  const manifests = allManifests(fixtureState());
  expect(manifests).toHaveLength(7);
  return manifests.map((manifest, index) => ({
    name: `F08__manifest-${index}-${manifest.id.replace('.', '_')}.json`,
    schemaRef: MANIFEST_SCHEMA,
    value: manifest,
    source: 'F08',
  }));
}

function f10Fixtures(): Fixture[] {
  const identity = { conversationId: 'conv-f10' } as const;
  const commands: Record<string, unknown> = {
    'food-store-query.json': buildStoreQueryCommand({ commandId: 'cmd-i19-store', idempotencyKey: 'idem-i19-store', storeId: 'store-1', ...identity }),
    'food-menu-query.json': buildMenuQueryCommand({ commandId: 'cmd-i19-menu', idempotencyKey: 'idem-i19-menu', storeId: 'store-1', ...identity }),
    'food-cart-add.json': buildCartMutationCommand({
      commandId: 'cmd-i19-add',
      idempotencyKey: 'idem-i19-add',
      operation: 'cart.add_line',
      args: { dishId: 'dish-a', skuId: 'sku-a', specs: [{ groupId: 'spiciness', optionId: 'mild' }], quantity: 2 },
      expectedRevision: 3,
      ...identity,
    }),
    'food-cart-qty.json': buildCartMutationCommand({
      commandId: 'cmd-i19-qty',
      idempotencyKey: 'idem-i19-qty',
      operation: 'cart.set_quantity',
      args: { lineId: 'line-1', quantity: 2 },
      expectedRevision: 4,
      ...identity,
    }),
  };
  return Object.entries(commands).map(([name, value]) => ({ name: `F10__${name}`, schemaRef: COMMAND_SCHEMA, value, source: 'F10' }));
}

function systemActionsFixtures(): Fixture[] {
  return diskFixtures('apps/mobile-ui/src/system-actions/contract-fixtures', 'system-actions');
}

function allFixtures(): Fixture[] {
  return [
    ...f03Fixtures(),
    ...f04Fixtures(),
    ...f07Fixtures(),
    ...f08Fixtures(),
    ...f10Fixtures(),
    ...systemActionsFixtures(),
  ];
}

/** 解析 `summary: <N> PASS, <M> FAIL`；解析不到直接抛，避免静默通过。 */
function parseSummary(stdout: string): { pass: number; fail: number } {
  const match = /summary: (\d+) PASS, (\d+) FAIL/.exec(stdout);
  if (match === null) throw new Error(`校验器输出里找不到 summary 行:\n${stdout}`);
  return { pass: Number(match[1]), fail: Number(match[2]) };
}

// ---------------------------------------------------------------------------
// 正向门禁
// ---------------------------------------------------------------------------

describe('F-I19 / 冻结契约门禁：全部 F fixture 一次实跑', () => {
  it('校验器存在（路径/冻结身份正确）', () => {
    expect(existsSync(VALIDATOR)).toBe(true);
  });

  it('六个来源都贡献了 fixture（避免收集器静默变空）', () => {
    const fixtures = allFixtures();
    for (const source of ['F03', 'F04', 'F07', 'F08', 'F10', 'system-actions']) {
      const count = fixtures.filter((fixture) => fixture.source === source).length;
      expect(count, `来源 ${source} 没有产出任何 fixture`).toBeGreaterThan(0);
    }
    // 文件名唯一——写进同一目录不能互相覆盖。
    expect(new Set(fixtures.map((fixture) => fixture.name)).size).toBe(fixtures.length);
  });

  it('真校验器对全部 fixture 报 N PASS, 0 FAIL 且退出码 0', () => {
    const fixtures = allFixtures();
    const { status, stdout } = validateBatch(fixtures);

    const summary = parseSummary(stdout);
    expect(summary.fail).toBe(0);
    expect(summary.pass).toBe(fixtures.length);
    expect(status).toBe(0);

    // 逐条 PASS：每条 fixture 名都出现且没有任何 FAIL 行。
    for (const fixture of fixtures) {
      expect(stdout, `${fixture.name} 未 PASS`).toContain(`PASS  ${fixture.name}`);
    }
    expect(stdout).not.toMatch(/^FAIL {2}/m);
  });
});

// ---------------------------------------------------------------------------
// 反向对照：这些 fixture 必须失败，证明校验器不是空转
// ---------------------------------------------------------------------------

describe('F-I19 / 反向对照（必须失败）', () => {
  it('succeeded 事件缺 resultRef ⇒ FAIL（fail-closed）', () => {
    const bad: Fixture = {
      name: 'neg-evt-succeeded-no-result.json',
      schemaRef: EVENT_SCHEMA,
      source: 'negative',
      value: { eventId: 'evt-neg-1', seq: 1, commandId: 'cmd-neg-1', revision: 1, status: 'succeeded' },
    };
    const { status, stdout } = validateBatch([bad]);
    const summary = parseSummary(stdout);
    expect(summary.pass).toBe(0);
    expect(summary.fail).toBe(1);
    expect(status).toBe(1);
    expect(stdout).toContain(`FAIL  ${bad.name}`);
  });

  it('mutate 命令缺 expectedRevision ⇒ FAIL（乐观锁）', () => {
    const bad: Fixture = {
      name: 'neg-cmd-mutate-no-revision.json',
      schemaRef: COMMAND_SCHEMA,
      source: 'negative',
      value: {
        schemaVersion: 'mobile-v1',
        commandId: 'cmd-neg-2',
        operation: 'mutate',
        idempotencyKey: 'idem-neg-2',
        payload: { conversationId: 'conv-1' },
      },
    };
    const { status, stdout } = validateBatch([bad]);
    const summary = parseSummary(stdout);
    expect(summary.pass).toBe(0);
    expect(summary.fail).toBe(1);
    expect(status).toBe(1);
    expect(stdout).toContain(`FAIL  ${bad.name}`);
  });

  it('清单塞入合并就绪字段 ready ⇒ FAIL（四态不得合并）', () => {
    const manifest = manifestFor(fixtureState(), 'template.document');
    const polluted = { ...manifest, ready: true };
    const bad: Fixture = { name: 'neg-manifest-merged-ready.json', schemaRef: MANIFEST_SCHEMA, source: 'negative', value: polluted };

    const { status, stdout } = validateBatch([bad]);
    const summary = parseSummary(stdout);
    expect(summary.pass).toBe(0);
    expect(summary.fail).toBe(1);
    expect(status).toBe(1);
    expect(stdout).toContain(`FAIL  ${bad.name}`);
    expect(stdout).toContain('ready');
  });
});
