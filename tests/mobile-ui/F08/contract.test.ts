/**
 * F08 验收：把本包产出的 `TemplateManifest` 交给**真校验器**实跑
 * （冻结合入 main 的 `contracts/mobile-v1/validate.mjs`），证明清单形状不是「自己说自己对」。
 *
 * 附带反向对照，证明校验器不是空转：
 *   - probe 里塞合并字段 `ready` ⇒ 必须 FAIL（契约 additionalProperties:false）；
 *   - probe 缺 `portReady` ⇒ 必须 FAIL（rest）。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  allManifests,
  applyUpdate,
  manifestFor,
  type TemplateManifest,
} from '../../../apps/mobile-ui/src/templates/index.js';
import { fixtureState } from './fixtures.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const VALIDATOR = join(REPO_ROOT, 'contracts', 'mobile-v1', 'validate.mjs');
const SCHEMA_REF = 'schemas/template-manifest.schema.json';

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
  const dir = mkdtempSync(join(tmpdir(), 'f08-contract-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeFixture(dir: string, name: string, value: unknown): void {
  writeFileSync(
    join(dir, name),
    JSON.stringify({ $schemaRef: SCHEMA_REF, note: name, value }, null, 2),
    'utf8',
  );
}

describe('F08 / 契约校验器实跑', () => {
  it('校验器存在，且七模板的清单全部通过', () => {
    expect(existsSync(VALIDATOR)).toBe(true);
    const manifests = allManifests(fixtureState());
    expect(manifests).toHaveLength(7);

    withTempFixtures((dir) => {
      manifests.forEach((manifest, index) => {
        writeFixture(dir, `manifest-${index}-${manifest.id.replace('.', '_')}.json`, manifest);
      });
      const { status, stdout } = runValidator(dir);
      expect(stdout).toContain('summary: 7 PASS, 0 FAIL');
      // 逐条 PASS，且没有任何一条 FAIL 行（FAIL 行形如 `FAIL  <name>`）。
      expect((stdout.match(/PASS {2}manifest-/g) ?? []).length).toBe(7);
      expect(stdout).not.toMatch(/FAIL {2}manifest-/);
      expect(status).toBe(0);
    });
  });

  it('反向对照：probe 含合并就绪字段 ready ⇒ 必须 FAIL', () => {
    const manifest = manifestFor(fixtureState(), 'template.document');
    const polluted = {
      ...manifest,
      probe: { ...manifest.probe, ready: true },
    } as unknown as TemplateManifest;

    withTempFixtures((dir) => {
      writeFixture(dir, 'manifest-collapsed.json', polluted);
      const { status, stdout } = runValidator(dir);
      expect(status).toBe(1);
      expect(stdout).toContain('FAIL  manifest-collapsed.json');
      expect(stdout).toContain('ready');
    });
  });

  it('反向对照：probe 缺 portReady ⇒ 必须 FAIL（四态不可省略）', () => {
    const manifest = manifestFor(fixtureState(), 'template.document');
    const { portReady: _omit, ...probeWithoutPort } = manifest.probe;
    const broken = { ...manifest, probe: probeWithoutPort } as unknown as TemplateManifest;

    withTempFixtures((dir) => {
      writeFixture(dir, 'manifest-missing-port.json', broken);
      const { status, stdout } = runValidator(dir);
      expect(status).toBe(1);
      expect(stdout).toContain('FAIL  manifest-missing-port.json');
      expect(stdout).toContain('portReady');
    });
  });

  it('更新后（新增权限待授权）的清单仍通过契约：authorized=false 是合法四态之一', () => {
    let state = fixtureState();
    state = applyUpdate(state, 'template.document', {
      version: '1.1.0',
      permissions: ['storage', 'file-write', 'model', 'external-order'],
    }).state;
    const manifest = manifestFor(state, 'template.document');
    expect(manifest.probe.authorized).toBe(false);
    expect(manifest.probe.installed).toBe(true);

    withTempFixtures((dir) => {
      writeFixture(dir, 'manifest-updated.json', manifest);
      const { status, stdout } = runValidator(dir);
      expect(stdout).toContain('PASS  manifest-updated.json');
      expect(status).toBe(0);
    });
  });
});
