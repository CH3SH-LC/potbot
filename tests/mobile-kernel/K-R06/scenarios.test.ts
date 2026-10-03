/**
 * K-R06 独立验证：以对手身份驱动 K07 授权账本，钉住四类攻击。
 *
 * 断言口径：
 * 1. 每条用例的**真实观测**必须满足它自己声明的预期（`passed`）——不满足即红；
 * 2. 额外对关键结局做**就地断言**（拒因码 / 状态 / 计数），避免"预期写错也一起绿";
 * 3. `open` 缺口集合必须**恰好**是当前已知集合（B1/B2/D2 封闭后为**空**）——集合变化会红，
 *    提醒维护者更新判定（而不是让缺口悄悄消失或悄悄新增）；
 * 4. 契约交叉核对（B4）：命令层要求 taskId/conversationId；确认层契约尚未同步 taskId
 *    （产品侧已加，契约同步是编排人交接）；
 * 5. 证物 `evidence.json` 与运行结果同源写出，并校验 schema。
 *
 * 本文件不访问网络、不读密钥、不写 allowlist 之外的路径。
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  AUTHORIZATION_ERROR_CODES,
  isAuthorizationError,
} from '../../../apps/mobile-kernel/actions/index.js';
import {
  PRODUCT_MODULE_PATH,
  SCENARIO_IDS,
  T0,
  runAllScenarios,
} from './scenarios.js';
import {
  assertAttackRun,
  type AttackRun,
  type ScenarioRecord,
} from './types.js';

const here = (name: string) => fileURLToPath(new URL(name, import.meta.url));

function readProductSource(): string {
  return readFileSync(here('../../../apps/mobile-kernel/actions/ledger.ts'), 'utf8');
}

function sha256(text: string): string {
  return 'sha256:' + createHash('sha256').update(text, 'utf8').digest('hex');
}

function baselineSha(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

/** 用例清单完整性：A 5 条 + B 3 条 + C 5 条 + D 5 条 = 18。 */
const EXPECTED_IDS = [
  'A1', 'A2', 'A3', 'A4', 'A5',
  'B1', 'B2', 'B3',
  'C1', 'C2', 'C3', 'C4', 'C5',
  'D1', 'D2', 'D3', 'D4', 'D5',
] as const;

async function buildRun(): Promise<AttackRun> {
  const source = readProductSource();
  return runAllScenarios({ productSourceSha256: sha256(source), baselineSha: baselineSha() });
}

function byId(run: AttackRun, id: string): ScenarioRecord {
  const found = run.scenarios.find((scenario) => scenario.id === id);
  if (found === undefined) {
    throw new Error(`缺用例 ${id}`);
  }
  return found;
}

describe('K-R06 对抗运行：清单、判定与 schema', () => {
  it('用例清单完整（18 条，覆盖四族），且每条观测满足其声明的预期', async () => {
    const run = await buildRun();
    expect(SCENARIO_IDS).toEqual([...EXPECTED_IDS]);
    expect(run.scenarios.map((entry) => entry.id)).toEqual([...EXPECTED_IDS]);

    const failed = run.scenarios.filter((entry) => !entry.passed);
    expect(
      failed.map((entry) => `${entry.id} 期望 ${entry.expectation.code}/${entry.expectation.state} 实得 ${entry.observation.code}/${entry.observation.state}`),
    ).toEqual([]);

    expect(run.summary.total).toBe(18);
    expect(run.summary.passed).toBe(18);
    expect(run.summary.closed).toBe(16);
    expect(run.summary.open).toBe(0);
    expect(run.summary.correctByDesign).toBe(2);
  });

  it('证据产物通过机器可验 schema，且身份摘要与基线齐备', async () => {
    const run = await buildRun();
    assertAttackRun(run);
    expect(run.productModule).toBe(PRODUCT_MODULE_PATH);
    expect(run.productSourceSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    // 身份钉住：同一份源码内容得到同一摘要（可复算）
    expect(run.productSourceSha256).toBe(sha256(readProductSource()));
    expect(typeof run.baselineSha).toBe('string');
    expect(run.baselineSha.length).toBeGreaterThan(0);
  });

  it('每条观测里的 code 都必须是登记过的拒因码或 NO_THROW（没有冒名错误码）', async () => {
    const run = await buildRun();
    const allowed = new Set<string>([...AUTHORIZATION_ERROR_CODES, 'NO_THROW']);
    for (const entry of run.scenarios) {
      expect(allowed.has(entry.observation.code)).toBe(true);
    }
  });
});

describe('A 族 · 重复确认：全部被挡住（closed）', () => {
  it('A1 第二张凭证换不到第二张授权，只有 1 张 grant', async () => {
    const run = await buildRun();
    const a1 = byId(run, 'A1');
    expect(a1.observation.code).toBe('grant_already_issued');
    expect(a1.observation.extra.grants).toBe(1);
  });

  it('A2 重复占用被拒，只留 1 条提交', async () => {
    const run = await buildRun();
    const a2 = byId(run, 'A2');
    expect(a2.observation.code).toBe('grant_already_consumed');
    expect(a2.observation.extra.submissions).toBe(1);
  });

  it('A3 重复发出被拒，执行器只被调用 1 次（重复下单不可表达）', async () => {
    const run = await buildRun();
    const a3 = byId(run, 'A3');
    expect(a3.observation.code).toBe('already_sent_query_only');
    expect(a3.observation.extra.executorCalls).toBe(1);
  });

  it('A4/A5 重复登记与串动作占用都被拒', async () => {
    const run = await buildRun();
    expect(byId(run, 'A4').observation.code).toBe('confirm_already_recorded');
    expect(byId(run, 'A5').observation.code).toBe('grant_binding_mismatch');
    expect(byId(run, 'A5').observation.extra.submissions).toBe(0);
  });
});

describe('B 族 · 跨任务授权：缺口已封闭（closed），修订漂移被挡（closed）', () => {
  it('B1 绑定与提交记录携带 taskId，且跨任务占用被机器拒绝', async () => {
    const run = await buildRun();
    const b1 = byId(run, 'B1');
    expect(b1.expectation.verdict).toBe('closed');
    expect(b1.observation.code).toBe('NO_THROW');
    expect(b1.observation.state).toBe('submitting');
    expect(b1.observation.extra).toMatchObject({
      confirmHasTaskId: true,
      grantHasTaskId: true,
      submissionHasTaskId: true,
      confirmTaskId: 'task-a',
      submissionTaskId: 'task-a',
      // 跨任务占用（任务 C 用任务 B 的授权）在 taskId 上逐项复核不符 ⇒ 拒，且零提交
      crossTaskCode: 'grant_binding_mismatch',
      crossTaskSubmissions: 0,
    });
  });

  it('B2 actionId 是任务内键：两个任务同名动作各自登记，不再全局冲突', async () => {
    const run = await buildRun();
    const b2 = byId(run, 'B2');
    expect(b2.expectation.verdict).toBe('closed');
    expect(b2.observation.code).toBe('NO_THROW');
    expect(b2.observation.state).toBe('prepared');
    expect(b2.observation.extra).toMatchObject({ confirms: 2, taskAState: 'prepared' });
  });

  it('B3 taskRevision 漂移被挡（修订号与任务身份各司其职）', async () => {
    const run = await buildRun();
    const b3 = byId(run, 'B3');
    expect(b3.observation.code).toBe('grant_binding_mismatch');
    expect(b3.observation.extra.submissions).toBe(0);
  });

  it('B4 契约交叉核对：命令层要求 taskId/conversationId；确认层尚未登记 taskId（待总协调同步）', () => {
    const command = JSON.parse(
      readFileSync(here('../../../contracts/mobile-v1/schemas/command.schema.json'), 'utf8'),
    ) as {
      $defs: { mutationBranch: { properties: { payload: { anyOf: Array<{ required?: string[] }> } } } };
    };
    const confirm = JSON.parse(
      readFileSync(here('../../../contracts/mobile-v1/schemas/confirm-action.schema.json'), 'utf8'),
    ) as {
      additionalProperties: boolean;
      required: string[];
      properties: Record<string, unknown>;
    };

    // 命令层：变更类 payload 必须带 conversationId 或 taskId（二选一）
    const mutationRequired = command.$defs.mutationBranch.properties.payload.anyOf.map((branch) => branch.required ?? []);
    expect(mutationRequired).toContainEqual(expect.arrayContaining(['conversationId']));
    expect(mutationRequired).toContainEqual(expect.arrayContaining(['taskId']));

    // 确认层：当前契约（本包只读，不在写权内）仍是 additionalProperties:false 且无 taskId。
    // 这一条**如实钉住产品与契约的暂时分歧**：产品侧 ActionBinding 已加 taskId（见 B1/B2），
    // 但 contracts/mobile-v1/schemas/confirm-action.schema.json 的同步是**编排人交接**；
    // 交接落地后本用例应随之更新（新增 taskId 属性 + required）。
    expect(confirm.required).not.toContain('taskId');
    expect(confirm.required).not.toContain('conversationId');
    expect(Object.keys(confirm.properties)).not.toContain('taskId');
    expect(Object.keys(confirm.properties)).not.toContain('conversationId');
    expect(confirm.additionalProperties).toBe(false);
  });
});

describe('C 族 · 过期授权：占用/发出/签发三处都被期限挡住', () => {
  it('C1 过期后占用：grant_expired 且 0 提交', async () => {
    const run = await buildRun();
    expect(byId(run, 'C1').observation.code).toBe('grant_expired');
    expect(byId(run, 'C1').observation.extra.submissions).toBe(0);
  });

  it('C2 占用后过期再发出：grant_expired，提交置 cancelled，执行器 0 次', async () => {
    const run = await buildRun();
    const c2 = byId(run, 'C2');
    expect(c2.observation.code).toBe('grant_expired');
    expect(c2.observation.state).toBe('cancelled');
    expect(c2.observation.extra.executorCalls).toBe(0);
  });

  it('C3/C4 过期后签凭证与发行都被拒，不留下任何 grant', async () => {
    const run = await buildRun();
    expect(byId(run, 'C3').observation.code).toBe('confirm_expired');
    expect(byId(run, 'C4').observation.code).toBe('grant_expired');
    expect(byId(run, 'C3').observation.extra.grants).toBe(0);
    expect(byId(run, 'C4').observation.extra.grants).toBe(0);
  });

  it('C5 有意设计：有效期内发出、过期后到达的真回执仍能收口为 confirmed', async () => {
    const run = await buildRun();
    const c5 = byId(run, 'C5');
    expect(c5.expectation.verdict).toBe('correct-by-design');
    expect(c5.observation.code).toBe('NO_THROW');
    expect(c5.observation.state).toBe('confirmed');
    expect(c5.observation.extra.executorCalls).toBe(1);
  });
});

describe('D 族 · 晚到结果：终态不可复活；重复投递为缺口；在途撤权不抹单', () => {
  it('D1 终态 cancelled 后的 confirmed 被拒，状态保持 cancelled', async () => {
    const run = await buildRun();
    const d1 = byId(run, 'D1');
    expect(d1.observation.code).toBe('illegal_submission_transition');
    expect(d1.observation.state).toBe('cancelled');
  });

  it('D2 同一 confirmed 回执重复投递：幂等空操作（缺口已关闭）', async () => {
    const run = await buildRun();
    const d2 = byId(run, 'D2');
    expect(d2.expectation.verdict).toBe('closed');
    expect(d2.observation.code).toBe('NO_THROW');
    expect(d2.observation.state).toBe('confirmed');
    expect(d2.observation.extra).toMatchObject({
      stateUnchanged: true,
      receiptUnchanged: true,
      submissions: 1,
    });
  });

  it('D3 串单回执（动作不符）被拒，状态保持 submitted', async () => {
    const run = await buildRun();
    const d3 = byId(run, 'D3');
    expect(d3.observation.code).toBe('receipt_action_mismatch');
    expect(d3.observation.state).toBe('submitted');
  });

  it('D4 有意设计：发出后撤权不抹掉在途单，晚到 confirmed 仍收口', async () => {
    const run = await buildRun();
    const d4 = byId(run, 'D4');
    expect(d4.expectation.verdict).toBe('correct-by-design');
    expect(d4.observation.code).toBe('NO_THROW');
    expect(d4.observation.extra.stateAfterRevoke).toBe('submitted');
    expect(d4.observation.state).toBe('confirmed');
  });

  it('D5 已 confirmed 的恢复是 settled，不另发授权、不另建提交', async () => {
    const run = await buildRun();
    const d5 = byId(run, 'D5');
    expect(d5.observation.extra).toMatchObject({
      recoveryKind: 'settled',
      allowedAction: 'none',
      mayIssueNewGrant: false,
      mayCreateNewSubmission: false,
      grants: 1,
      submissions: 1,
    });
  });
});

describe('K-R06 证物写出', () => {
  it('写出 evidence.json（与本次运行同源），并回报缺口清单', async () => {
    const run = await buildRun();
    assertAttackRun(run);
    writeFileSync(here('./evidence.json'), JSON.stringify(run, null, 2) + '\n', 'utf8');

    const openIds = run.scenarios.filter((entry) => entry.expectation.verdict === 'open').map((entry) => entry.id);
    // B1/B2/D2 的三条缺口已由 K07（K-I02 集成）封闭，open 集合必须为空；
    // 若将来又冒出 open（新增或回归），这里会红，提醒维护者显式更新判定。
    expect(openIds).toEqual([]);

    // 拒因码确实来自产品词表（自证 harness 没有伪造码）
    expect(isAuthorizationError({ code: 'grant_expired' })).toBe(true);
    expect(T0).toBe(1_700_000_000_000);
  });
});
