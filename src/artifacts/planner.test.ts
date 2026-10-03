/**
 * 产物计划器（design-02 P1/P2）。
 *
 * 覆盖三项机器判据：
 * 1. **重放确定性**：同一输入两次 ⇒ id / 路径 / 期望摘要全等（并钉 golden 向量）；
 * 2. **版本化**：改 task_revision（或产物版本）⇒ 路径与 id **同时**变化；
 * 3. **路径纯净**：不含墙钟 / pid / 随机数 / 主机名 / 语言环境；`{n}` 只出现在临时路径。
 */

import { describe, expect, it } from 'vitest';

import { asRevision, asTaskId } from '../protocol/index.js';
import {
  ARTIFACT_ID_DIGEST_LENGTH,
  ARTIFACT_ID_PREFIX,
  artifactDirectoryOf,
  deriveArtifactId,
  planArtifact,
  stagingDirectoryOf,
} from './index.js';

const TASK = asTaskId('T1');
const ROOT = '/root/artifacts';
const DIGEST = 'sha256:expected';

function plan(overrides: Record<string, unknown> = {}) {
  return planArtifact({
    task_id: TASK,
    task_revision: asRevision(2),
    template_kind: 'document',
    artifact_version: 1,
    root_dir: ROOT,
    expected_content_digest: DIGEST,
    ...overrides,
  } as Parameters<typeof planArtifact>[0]);
}

describe('派生 id：确定性、无计数器', () => {
  it('golden 向量：id 只由 task_id + revision + 模板种类 + 产物版本决定', () => {
    expect(
      deriveArtifactId({
        task_id: TASK,
        task_revision: asRevision(2),
        template_kind: 'document',
        artifact_version: 1,
      }),
    ).toBe('art-8cad1650870a937f1a7d9734ac5f9098');
    expect(
      deriveArtifactId({
        task_id: TASK,
        task_revision: asRevision(2),
        template_kind: 'document',
        artifact_version: 2,
      }),
    ).toBe('art-9611eb2dbef585f4619d380dc0505c25');
    expect(
      deriveArtifactId({
        task_id: TASK,
        task_revision: asRevision(3),
        template_kind: 'document',
        artifact_version: 1,
      }),
    ).toBe('art-2b4f0b6d9e659fa1aa85e6a2a76e03da');
    expect(
      deriveArtifactId({
        task_id: TASK,
        task_revision: asRevision(2),
        template_kind: 'spreadsheet',
        artifact_version: 1,
      }),
    ).toBe('art-9d1cb0566fba72f5b12c081b8be3ec50');
  });

  it('id 形态固定：前缀 + 定长十六进制，可安全作为路径段', () => {
    const id = plan().artifact_id;
    expect(id.startsWith(ARTIFACT_ID_PREFIX)).toBe(true);
    expect(id.slice(ARTIFACT_ID_PREFIX.length)).toMatch(
      new RegExp(`^[0-9a-f]{${String(ARTIFACT_ID_DIGEST_LENGTH)}}$`),
    );
    expect(id).not.toContain('/');
    expect(id).not.toContain('\\');
  });

  it('重放同一计划 100 次 ⇒ id 全等（没有计数器 / 随机数参与）', () => {
    const ids = new Set(Array.from({ length: 100 }, () => plan().artifact_id));
    expect(ids.size).toBe(1);
  });
});

describe('版本化路径计划（P2）', () => {
  it('最终路径 = {根}/{task_id}/r{revision}/{模板种类}/{artifact_id}.{ext}', () => {
    const p = plan();
    expect(p.final_path).toBe(`/root/artifacts/T1/r2/document/${p.artifact_id}.docx`);
    expect(p.file_extension).toBe('docx');
    expect(p.mime_type).toContain('wordprocessingml.document');
  });

  it('临时路径在最终文件同目录的 .staging/ 下，形如 {artifact_id}.tmp-{n}', () => {
    const p = plan();
    expect(p.staging_path).toBe(
      `/root/artifacts/T1/r2/document/.staging/${p.artifact_id}.tmp-1`,
    );
    expect(artifactDirectoryOf(p)).toBe('/root/artifacts/T1/r2/document');
    expect(stagingDirectoryOf(p)).toBe('/root/artifacts/T1/r2/document/.staging');
  });

  it('三类模板只改目录段与扩展名（同一任务版本下相互隔离）', () => {
    const doc = plan({ template_kind: 'document' });
    const sheet = plan({ template_kind: 'spreadsheet' });
    const deck = plan({ template_kind: 'presentation' });
    expect(doc.final_path).toContain('/r2/document/');
    expect(sheet.final_path).toContain('/r2/spreadsheet/');
    expect(deck.final_path).toContain('/r2/presentation/');
    expect(sheet.final_path.endsWith('.xlsx')).toBe(true);
    expect(deck.final_path.endsWith('.pptx')).toBe(true);
    expect(new Set([doc.artifact_id, sheet.artifact_id, deck.artifact_id]).size).toBe(3);
  });

  it('改 task_revision ⇒ 路径与 id 同时变化（旧版本产物不会被覆盖）', () => {
    const r2 = plan({ task_revision: asRevision(2) });
    const r3 = plan({ task_revision: asRevision(3) });
    expect(r3.final_path).not.toBe(r2.final_path);
    expect(r3.artifact_id).not.toBe(r2.artifact_id);
    expect(r3.final_path).toContain('/r3/');
    expect(r2.final_path).toContain('/r2/');
  });

  it('同版本的产物版本递增 ⇒ 路径与 id 同时变化（重生成不覆盖上一版）', () => {
    const v1 = plan({ artifact_version: 1 });
    const v2 = plan({ artifact_version: 2 });
    expect(v2.artifact_id).not.toBe(v1.artifact_id);
    expect(v2.final_path).not.toBe(v1.final_path);
  });

  it('{n} 只在临时路径：改 n 不影响 id 与最终路径', () => {
    const n1 = plan({ staging_attempt: 1 });
    const n2 = plan({ staging_attempt: 7 });
    expect(n2.artifact_id).toBe(n1.artifact_id);
    expect(n2.final_path).toBe(n1.final_path);
    expect(n2.staging_path).not.toBe(n1.staging_path);
    expect(n2.staging_path.endsWith('.tmp-7')).toBe(true);
    expect(n1.final_path).not.toContain('.tmp-');
    expect(n1.artifact_id).not.toContain('tmp');
  });

  it('根目录末尾斜杠被规范化（同一根写法不同不产生两条路径）', () => {
    expect(plan({ root_dir: '/root/artifacts/' }).final_path).toBe(plan().final_path);
    expect(plan({ root_dir: '/root/artifacts///' }).final_path).toBe(plan().final_path);
  });
});

describe('路径纯净：不含墙钟 / pid / 随机数 / 主机名 / 语言环境', () => {
  it('重复构造的路径逐字节相等（无隐藏的时间或随机来源）', () => {
    const paths = new Set(Array.from({ length: 50 }, () => plan().final_path));
    expect(paths.size).toBe(1);
  });

  it('路径里不出现进程 id，也不出现四位年份', () => {
    const p = plan();
    expect(p.final_path).not.toContain(String(process.pid));
    expect(p.staging_path).not.toContain(String(process.pid));
    expect(p.final_path).not.toMatch(/\b(19|20)\d{2}\b/);
  });

  it('路径分隔符固定为 /，不含反斜杠与控制字符（不受平台 / locale 影响）', () => {
    const p = plan();
    for (const path of [p.final_path, p.staging_path]) {
      expect(path).not.toContain('\\');
      expect(path).toMatch(/^[ -~]+$/);
    }
  });

  it('task_id 进入路径前被校验：含分隔符 / 控制字符 / 点段一律拒绝', () => {
    expect(() => plan({ task_id: asTaskId('seed/task-1') })).toThrow(/路径分隔符或控制字符/);
    expect(() => plan({ task_id: asTaskId('a\\b') })).toThrow(/路径分隔符或控制字符/);
    expect(() => plan({ task_id: asTaskId('..') })).toThrow(/路径段歧义/);
  });

  it('非法输入一律抛 ValidationError：模板种类 / 版本号 / 期望摘要 / 根目录', () => {
    expect(() => plan({ template_kind: 'pdf' })).toThrow(/template_kind 必须是/);
    expect(() => plan({ task_revision: -1 })).toThrow(/task_revision 必须是 ≥ 0 的整数/);
    expect(() => plan({ artifact_version: 0 })).toThrow(/artifact_version 必须是 ≥ 1 的整数/);
    expect(() => plan({ staging_attempt: 0 })).toThrow(/staging_attempt 必须是 ≥ 1 的整数/);
    expect(() => plan({ expected_content_digest: '' })).toThrow(
      /expected_content_digest 不能为空字符串/,
    );
    expect(() => plan({ root_dir: '' })).toThrow(/root_dir 不能为空字符串/);
  });

  it('计划是冻结的，且期望摘要在计划里原样携带（真实字节由构建器给）', () => {
    const p = plan();
    expect(Object.isFrozen(p)).toBe(true);
    expect(p.expected_content_digest).toBe(DIGEST);
    expect(p.task_revision).toBe(2);
    expect(p.artifact_version).toBe(1);
  });
});
