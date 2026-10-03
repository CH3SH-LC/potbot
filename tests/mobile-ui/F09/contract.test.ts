/**
 * F09 验收：本包产出的 `keyRef` 用**真校验器** `contracts/mobile-v1/validate.mjs` 实跑。
 *
 * 证明设置页产出的密钥引用不是「自己说自己对」——它必须能放进契约的 ModelPort 请求，
 * 且**明文密钥**必须被 schema 拒绝（反向对照，证明校验器不是空转）。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  createKeyRegistry,
  type KeyImportIntent,
  type NativeImportResult,
  type NativeKeyImporter,
} from '../../../apps/mobile-ui/src/settings/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const VALIDATOR = join(REPO_ROOT, 'contracts', 'mobile-v1', 'validate.mjs');

const NOW = '2026-10-03T10:00:00Z';
const FAKE_KEY = 'sk-FAKE-not-a-real-credential-000000';

const IMPORTER: NativeKeyImporter = {
  importFromNative: (): NativeImportResult => ({
    ok: true,
    keyRef: 'keyref:deepseek-app-primary',
    importedAt: NOW,
    verificationMode: 'real',
  }),
};

const INTENT: KeyImportIntent = {
  provider: 'deepseek',
  nativeSource: 'content://demo/import/1',
  oneTimeToken: 'onetoken:demo-import-0001',
  requestedModel: 'deepseek-flash',
};

function runValidator(fixturesDir: string): { status: number; stdout: string } {
  try {
    const stdout = execFileSync(process.execPath, [VALIDATOR, fixturesDir], { encoding: 'utf8', stdio: 'pipe' });
    return { status: 0, stdout };
  } catch (error) {
    const err = error as { status?: number; stdout?: string };
    return { status: err.status ?? -1, stdout: err.stdout ?? '' };
  }
}

function withTempFixtures(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'f09-contract-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function modelPortRequest(keyRef: string): Record<string, unknown> {
  return {
    messages: [{ role: 'user', content: '帮我看看当前文档的改动' }],
    toolSchemas: [],
    cancellation: { token: 'cancel-1', cancelled: false },
    budget: { maxTokens: 2048, timeoutMs: 30000 },
    keyRef,
    model: 'deepseek-flash',
    stream: true,
  };
}

function writeFixture(dir: string, name: string, value: unknown): void {
  writeFileSync(
    join(dir, name),
    JSON.stringify({ $schemaRef: 'schemas/model-port.schema.json', note: name, value }, null, 2),
    'utf8',
  );
}

describe('F09 / keyRef 契约校验器实跑', () => {
  it('注册表导入产出的 keyRef 能通过 ModelPort schema', async () => {
    const registry = createKeyRegistry(IMPORTER);
    const imported = await registry.importKey(INTENT);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;

    withTempFixtures((dir) => {
      writeFixture(dir, 'model-port-request.json', modelPortRequest(imported.keyRef));
      const result = runValidator(dir);
      expect(result.status).toBe(0);
    });
  });

  it('反向对照：明文密钥当 keyRef ⇒ schema 必须 FAIL', () => {
    withTempFixtures((dir) => {
      writeFixture(dir, 'bad-keyref.json', modelPortRequest(FAKE_KEY));
      const result = runValidator(dir);
      expect(result.status).not.toBe(0);
    });
  });
});
