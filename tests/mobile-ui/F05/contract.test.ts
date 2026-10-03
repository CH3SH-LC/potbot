/**
 * F05 验收：产出的 `ConfirmAction` / `ExternalReceipt` 交给**真校验器**实跑。
 *
 * 用冻结合入 main 的 `contracts/mobile-v1/validate.mjs`（按 schemas/*.json 实跑），
 * 证明本包构造的对象不是「自己说自己对」——附带反向对照，证明校验器不是空转：
 *   - 金额写坏 ⇒ ConfirmAction 必须 FAIL；
 *   - fixture + confirmed 的回执 ⇒ ExternalReceipt 必须 FAIL（契约 oneOf 禁止 fixture 冒充）。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  confirmCard,
  createConfirmCard,
  type ConfirmAction,
  type ExternalReceipt,
} from '../../../apps/mobile-ui/src/decisions/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const VALIDATOR = join(REPO_ROOT, 'contracts', 'mobile-v1', 'validate.mjs');

const NOW = '2026-10-03T10:00:00Z';
const DIGEST = `sha256:${'b'.repeat(64)}` as `sha256:${string}`;

function runValidator(fixturesDir: string): { status: number; stdout: string } {
  try {
    const stdout = execFileSync(process.execPath, [VALIDATOR, fixturesDir], { encoding: 'utf8' });
    return { status: 0, stdout };
  } catch (error) {
    const err = error as { status?: number; stdout?: string };
    return { status: err.status ?? -1, stdout: err.stdout ?? '' };
  }
}

function withTempFixtures(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'f05-contract-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeFixture(dir: string, name: string, schemaRef: string, value: unknown): void {
  writeFileSync(
    join(dir, name),
    JSON.stringify({ $schemaRef: schemaRef, note: name, value }, null, 2),
    'utf8',
  );
}

function buildAction(): ConfirmAction {
  const card = createConfirmCard({
    cardId: 'card-1',
    actionId: 'act-1',
    taskRevision: 3,
    subject: { objectRef: 'sku:coffee-1', objectLabel: '拿铁（大杯）' },
    scope: 'purchase',
    price: { amount: '29.90', currency: 'CNY' },
    expiresAt: '2026-10-03T10:10:00Z',
    paramsDigest: DIGEST,
    accountRef: 'acct:demo-0001',
    quoteRef: 'quote:2026-10-03-1',
  });
  const result = confirmCard(card, { actionId: 'act-1', taskRevision: 3, now: NOW });
  if (!result.ok) throw new Error(`应提交成功，实际原因：${result.reason}`);
  return result.action;
}

const CONFIRM_SCHEMA = 'schemas/confirm-action.schema.json';
const RECEIPT_SCHEMA = 'schemas/external-receipt.schema.json';

describe('F05 / 契约校验器实跑', () => {
  it('生成的 ConfirmAction 通过 validate.mjs', () => {
    expect(existsSync(VALIDATOR)).toBe(true);
    const action = buildAction();
    const fixture = join(REPO_ROOT, 'contracts', 'mobile-v1', 'fixtures');

    // 顺带确认契约自带的 confirm-action fixture 目录存在（校验器默认扫描点）。
    expect(existsSync(fixture)).toBe(true);

    withTempFixtures((dir) => {
      writeFixture(dir, 'confirm-action.json', CONFIRM_SCHEMA, action);
      const { status, stdout } = runValidator(dir);
      expect(stdout).toContain('PASS  confirm-action.json');
      expect(stdout).toContain('summary: 1 PASS, 0 FAIL');
      expect(status).toBe(0);
    });
  });

  it('反向对照：金额写坏的 ConfirmAction 必须被校验器拒绝', () => {
    const action = buildAction();
    const invalid: ConfirmAction = { ...action, amount: '29.9.9' };

    withTempFixtures((dir) => {
      writeFixture(dir, 'confirm-action-bad.json', CONFIRM_SCHEMA, invalid);
      const { status, stdout } = runValidator(dir);
      expect(status).toBe(1);
      expect(stdout).toContain('FAIL  confirm-action-bad.json');
      expect(stdout).toContain('amount');
    });
  });

  it('反向对照：缺 scope 的 ConfirmAction 必须被拒绝（必需字段）', () => {
    const action = buildAction();
    const { scope: _scope, ...withoutScope } = action;

    withTempFixtures((dir) => {
      writeFixture(dir, 'confirm-action-noscope.json', CONFIRM_SCHEMA, withoutScope);
      const { status, stdout } = runValidator(dir);
      expect(status).toBe(1);
      expect(stdout).toContain('FAIL  confirm-action-noscope.json');
      expect(stdout).toContain('scope');
    });
  });

  it('real + unknown 回执通过校验器，但展示层仍判为未完成', () => {
    const unknownReceipt: ExternalReceipt = {
      actionId: 'act-1',
      provider: 'demo-provider',
      requestRef: 'req-1',
      externalId: 'ext-1',
      observedState: 'unknown',
      observedAt: NOW,
      evidenceRef: 'ev-1',
      verificationMode: 'real',
    };

    withTempFixtures((dir) => {
      writeFixture(dir, 'receipt-unknown.json', RECEIPT_SCHEMA, unknownReceipt);
      const { status, stdout } = runValidator(dir);
      expect(stdout).toContain('PASS  receipt-unknown.json');
      expect(status).toBe(0);
    });
  });

  it('反向对照：fixture + confirmed 的回执必须被校验器拒绝（oneOf 禁止冒充）', () => {
    const fake: ExternalReceipt = {
      actionId: 'act-1',
      provider: 'demo-provider',
      requestRef: 'req-1',
      externalId: 'ext-1',
      observedState: 'confirmed',
      observedAt: NOW,
      evidenceRef: 'ev-1',
      verificationMode: 'fixture',
    };

    withTempFixtures((dir) => {
      writeFixture(dir, 'receipt-fake-confirmed.json', RECEIPT_SCHEMA, fake);
      const { status, stdout } = runValidator(dir);
      expect(status).toBe(1);
      expect(stdout).toContain('FAIL  receipt-fake-confirmed.json');
    });
  });
});
