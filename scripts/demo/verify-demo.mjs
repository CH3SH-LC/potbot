#!/usr/bin/env node
/**
 * S6 活服务端到端验证器（对**正在运行**的服务打 HTTP，黑盒）。
 *
 * 用法：
 *   node scripts/demo/verify-demo.mjs [--read-only] [--instruction="..."] [--timeout=90000]
 *                                     [--base=http://127.0.0.1:8765]
 *
 * **会消耗 live 模型额度**：默认会提交 1 次真实生成请求（主协调者已授权预算内）。
 * 用 `--read-only` 只做不调模型的检查。输出里**如实登记**本次真实请求次数与
 * 模型账本的调用数增量；脚本不能、也不会用 mock 结果冒充 live 结果。
 *
 * 退出码：0 = 全部检查通过；1 = 有检查未通过；2 = **服务不可达（未执行）**。
 * 「未执行」绝不记为通过。
 *
 * 判据对照（`docs/other/ds-mobile-word-demo-3h-2026-10-02.md` 验收表）：
 *   DOCX   —— 下载字节独立 sha256 + 独立 ZIP/XML 读回 + 正文等于发布草稿
 *   失败与重复 —— 同 requestId 重复提交不二次调用；超限请求被结构化拒绝
 *   内核   —— 任务状态与产物引用同源（同一 taskId 的 artifact 与下载字节一致）
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..', '..');
const VERIFY_DOCX = join(SCRIPT_DIR, 'verify-docx.py');
const EVIDENCE_DIR = join(REPO_ROOT, 'docs', 'other', 'review', 'mobile-word-demo', 'verification');
const RUNTIME_ROOT = join(REPO_ROOT, '.runtime', 'mobile-word-demo');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
};

const BASE_URL = String(flag('base', process.env.DEMO_BASE_URL ?? 'http://127.0.0.1:8765'));
const READ_ONLY = flag('read-only', false) === true;
const TIMEOUT_MS = Number(flag('timeout', 90_000));
const RUN_ID = String(flag('run', process.env.DEMO_RUN_ID ?? 'MWD-20261002-A'));

const checks = [];
const notes = [];
let liveRequestsIssued = 0;

function check(name, passed, detail) {
  checks.push({ name, passed: Boolean(passed), detail: String(detail ?? '') });
  const mark = passed ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function httpJson(method, path, body, timeoutMs = 15_000) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    signal: AbortSignal.timeout(timeoutMs),
    headers: body === undefined ? { accept: 'application/json' } : { 'content-type': 'application/json', accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed, raw };
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// ---------------------------------------------------------------------------
// 模型调用账本（脱敏）：尽力发现 + 计数，用于证明"重复提交没有二次调用模型"
// ---------------------------------------------------------------------------

function walkFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

/** 读宿主的应用索引（可能尚未落盘 ⇒ 返回 null）。 */
function readAppIndex() {
  const path = join(RUNTIME_ROOT, RUN_ID, 'app-index.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function countModelCalls() {
  const files = walkFiles(RUNTIME_ROOT).filter((p) => /ledger|calls|model/i.test(p));
  let count = 0;
  const sources = [];
  for (const path of files) {
    if (!/\.(json|jsonl|log)$/i.test(path)) continue;
    const text = readFileSync(path, 'utf8');
    let fileCount = 0;
    if (path.endsWith('.jsonl')) {
      fileCount = text.split('\n').filter((line) => line.trim().length > 0).length;
    } else {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) fileCount = parsed.length;
        else if (Array.isArray(parsed?.calls)) fileCount = parsed.calls.length;
        else if (Array.isArray(parsed?.entries)) fileCount = parsed.entries.length;
        else if (Array.isArray(parsed?.requests)) fileCount = parsed.requests.length;
        else if (typeof parsed?.call_count === 'number') fileCount = parsed.call_count;
        else fileCount = 1;
      } catch {
        fileCount = 0;
      }
    }
    count += fileCount;
    sources.push(`${relative(REPO_ROOT, path).replace(/\\/g, '/')}:${fileCount}`);
  }
  return { count, sources };
}

// ---------------------------------------------------------------------------
// 独立读回
// ---------------------------------------------------------------------------

function pythonExecutable() {
  const fromEnv = process.env.DEMO_PYTHON;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const known = 'C:/Users/<user>/AppData/Local/Programs/Python/Python313/python.exe';
  return existsSync(known) ? known : 'python';
}

function readbackDocx(path) {
  try {
    const stdout = execFileSync(pythonExecutable(), [VERIFY_DOCX, path], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    });
    return { exitCode: 0, parsed: JSON.parse(stdout.trim()) };
  } catch (error) {
    const status = typeof error?.status === 'number' ? error.status : 1;
    let parsed = null;
    try {
      parsed = JSON.parse(String(error?.stdout ?? '').trim());
    } catch {
      parsed = null;
    }
    if (parsed === null) {
      notes.push(`独立读回器未能给出 JSON：${String(error?.stderr ?? error?.message ?? error).slice(0, 300)}`);
    }
    return { exitCode: status, parsed };
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const startedAt = new Date().toISOString();
  console.log(`# verify-demo.mjs — ${BASE_URL} @ ${startedAt}`);
  console.log(`# runId=${RUN_ID} readOnly=${READ_ONLY}`);
  if (!READ_ONLY) {
    console.log(
      '# 注意：本次将提交真实生成请求。**实测一次提交可能消耗 1–2 次模型调用**' +
        '（模型端口自身会重试一次，实测样本：首次提交 2 次调用），重复提交部分**不应**再产生调用。',
    );
  }

  // 0. 服务可达性
  let health = null;
  try {
    const probe = await httpJson('GET', '/health', undefined, 4000);
    if (probe.status !== 200 || typeof probe.body !== 'object' || probe.body === null) {
      check('health_reachable', false, `HTTP ${probe.status}`);
      return report('服务返回非 200 健康检查');
    }
    health = probe.body;
    check('health_reachable', true, JSON.stringify(health));
  } catch (error) {
    check('health_reachable', false, `${error}`);
    return report('服务不可达：按"未执行"记录，不得填成功');
  }

  check('health_shape', ['ready', 'modelConfigured', 'modelVerified', 'buildId', 'bootId'].every((k) => k in health), Object.keys(health).join(','));
  const secret = process.env.ANTHROPIC_AUTH_TOKEN;
  if (secret && secret.length >= 8) {
    check('health_no_secret_leak', !JSON.stringify(health).includes(secret), 'health 不含 AUTH_TOKEN');
  }

  // 1. 只读的坏输入路径
  const bogus = await httpJson('GET', '/api/artifacts/__s6_no_such_artifact__/download', undefined, 5000);
  check('unknown_artifact_404', bogus.status === 404, `HTTP ${bogus.status}`);

  const unknownTask = await httpJson('GET', '/api/tasks/__s6_no_such_task__', undefined, 5000);
  check(
    'unknown_task_not_ready',
    unknownTask.status === 404 || unknownTask.body?.status === 'unknown',
    `HTTP ${unknownTask.status} status=${unknownTask.body?.status ?? 'n/a'}`,
  );

  const before = countModelCalls();
  notes.push(`模型账本（提交前）：${before.sources.length ? before.sources.join(', ') : '未发现账本文件'}`);

  if (READ_ONLY) {
    notes.push('--read-only：跳过提交与产物核对（未消耗 live 模型额度）。');
    return report(null);
  }

  // 2. 提交真实请求
  const requestId = `s6-verify-${Date.now()}`;
  const instruction = String(
    flag(
      'instruction',
      '为新生读书会写一封温暖的邀请函，不编造时间地点和报名联系方式。',
    ),
  );
  const created = await httpJson('POST', '/api/documents', { requestId, instruction }, 15_000);
  liveRequestsIssued += 1;
  check('create_202', created.status === 202, `HTTP ${created.status}`);
  const taskId = created.body?.taskId;
  check('create_shape', typeof taskId === 'string' && created.body?.requestId === requestId, `taskId=${taskId ?? 'n/a'}`);
  if (typeof taskId !== 'string') return report('提交未返回 taskId');

  // 3. 轮询
  const deadline = Date.now() + TIMEOUT_MS;
  let task = null;
  while (Date.now() < deadline) {
    const poll = await httpJson('GET', `/api/tasks/${encodeURIComponent(taskId)}`, undefined, 10_000);
    task = poll.body;
    if (task && ['ready', 'failed', 'interrupted', 'unknown'].includes(task.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  check('task_terminal', task !== null && ['ready', 'failed'].includes(task?.status), `status=${task?.status ?? 'timeout'}`);

  // 4. 重复提交：同 requestId + 同输入 ⇒ 同一任务，且不得二次调用模型
  //
  // 口径修正（我的仪器 bug）：账本基线必须在**本次提交完成之后**再取，否则会把
  // 「第一次提交本身的调用」误算成「重复提交的第二次调用」。曾因此在真实服务上误报一次。
  const settle = () => new Promise((resolve) => setTimeout(resolve, 1200));
  await settle();
  const beforeDup = countModelCalls();
  const dup = await httpJson('POST', '/api/documents', { requestId, instruction }, 15_000);
  check('duplicate_same_task', dup.body?.taskId === taskId, `taskId=${dup.body?.taskId ?? 'n/a'} (期望 ${taskId})`);
  await settle();
  const afterDup = countModelCalls();
  if (afterDup.sources.length > 0) {
    check(
      'duplicate_no_extra_model_call',
      afterDup.count === beforeDup.count,
      `重复提交前后的账本增量 ${beforeDup.count} → ${afterDup.count}（本次提交自身共 ${beforeDup.count - before.count} 条）`,
    );
  } else {
    notes.push('未能发现模型账本文件：无法用账本证明"重复提交未二次调用"，该项记为未验证。');
  }

  // 4b. UTF-8 往返：应用索引里的 instruction 必须与**发送原文逐字符一致**
  //     （已观测到 CLI 探针把中文写入成乱码：这一条把"输入编码链路"变成可判据）。
  let indexed = null;
  for (let i = 0; i < 10; i += 1) {
    const index = readAppIndex();
    indexed = index?.tasks?.find((entry) => entry.taskId === taskId) ?? null;
    if (indexed) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (indexed === null) {
    notes.push('应用索引里找不到本次任务：UTF-8 往返与来源记录两项记为未验证。');
  } else {
    check('index_source_record', indexed.requestId === requestId, `requestId=${indexed.requestId}`);
    check(
      'utf8_roundtrip_instruction',
      indexed.instruction === instruction,
      indexed.instruction === instruction ? '逐字符一致' : `索引存的是 ${JSON.stringify(indexed.instruction).slice(0, 80)}`,
    );
  }

  // 5. 同 requestId + 不同输入 ⇒ 409
  const conflict = await httpJson('POST', '/api/documents', { requestId, instruction: `${instruction}（追加一句）` }, 15_000);
  check('conflict_409', conflict.status === 409, `HTTP ${conflict.status}`);

  // 6. 超限请求 ⇒ 结构化拒绝（4xx），不得返回 202 / 不得产出新文件
  const tooLong = await httpJson('POST', '/api/documents', { requestId: `${requestId}-long`, instruction: '啊'.repeat(4001) }, 15_000);
  check('oversize_rejected', tooLong.status >= 400 && tooLong.status < 500, `HTTP ${tooLong.status}`);
  check(
    'oversize_structured_error',
    typeof (tooLong.body?.code ?? tooLong.body?.error?.code) === 'string',
    JSON.stringify(tooLong.body)?.slice(0, 200) ?? 'n/a',
  );

  if (task?.status !== 'ready') {
    notes.push(`任务终态为 ${task?.status ?? 'unknown'}，未产出可下载产物：DOCX 三项判据记为未通过/未执行。`);
    return report(null);
  }

  // 7. DOCX：下载 → 独立 sha256 → 独立读回 → 正文等于发布草稿
  const artifact = task.artifact;
  check(
    'artifact_ref_shape',
    artifact &&
      typeof artifact.artifactId === 'string' &&
      typeof artifact.sha256 === 'string' &&
      typeof artifact.byteLength === 'number' &&
      typeof artifact.downloadPath === 'string',
    JSON.stringify(artifact)?.slice(0, 300) ?? 'n/a',
  );
  if (!artifact?.downloadPath) return report('ready 任务没有 artifact.downloadPath');

  const download = await fetch(`${BASE_URL}${artifact.downloadPath}`, { signal: AbortSignal.timeout(30_000) });
  check('download_200', download.status === 200, `HTTP ${download.status}`);
  const bytes = Buffer.from(await download.arrayBuffer());
  check('download_byte_length', bytes.byteLength === artifact.byteLength, `${bytes.byteLength} vs 声明 ${artifact.byteLength}`);
  check('download_sha256', sha256(bytes) === artifact.sha256, `${sha256(bytes)} vs 声明 ${artifact.sha256}`);
  check(
    'download_mime',
    (download.headers.get('content-type') ?? '').includes('wordprocessingml'),
    download.headers.get('content-type') ?? 'n/a',
  );

  mkdirSync(EVIDENCE_DIR, { recursive: true });
  // 文件名带上来源标记：防止把**假服务/自检**的下载字节误认成 live 产物。
  const saveTag = String(flag('tag', 'live'));
  const saved = join(EVIDENCE_DIR, `artifact-${saveTag}-${RUN_ID}-${Date.now()}.docx`);
  writeFileSync(saved, bytes);
  notes.push(`下载字节已留存：${relative(REPO_ROOT, saved).replace(/\\/g, '/')}（来源 ${BASE_URL}）`);

  const readback = readbackDocx(saved);
  check('independent_readback_ok', readback.exitCode === 0 && readback.parsed?.ok === true, `code=${readback.parsed?.error?.code ?? 'ok'}`);

  const docParagraphs = (readback.parsed?.document?.paragraphs ?? []).map((p) => p.trim()).filter((p) => p.length > 0);
  notes.push(`DOCX 实际结构（${docParagraphs.length} 段）：${docParagraphs.map((p, i) => `${i}=${p.slice(0, 24)}`).join(' | ')}`);

  const draft = task.draft;
  if (draft && Array.isArray(draft.paragraphs)) {
    // 本次新生成文件必须完整等于草稿：用户要求不追加系统事实/来源栏目。
    const expected = [String(draft.title).trim(), ...draft.paragraphs.map((p) => String(p.text).trim())].filter((p) => p.length > 0);
    const prefix = docParagraphs.slice(0, expected.length);
    const prefixEqual = prefix.length === expected.length && expected.every((line, i) => line === prefix[i]);
    check(
      'docx_paragraphs_equal_draft',
      prefixEqual && docParagraphs.length === expected.length,
      prefixEqual ? `前 ${expected.length} 段逐字等于草稿（标题 + ${draft.paragraphs.length} 段）` : `草稿 ${expected.length} 段 vs 文档前 ${prefix.length} 段`,
    );
    if (!prefixEqual) {
      notes.push(`草稿首段：${expected.slice(0, 2).join(' | ')}`);
      notes.push(`文档首段：${prefix.slice(0, 2).join(' | ')}`);
    }

    // 不靠关键词删正文；用户主动写出的「资料引用」等词仍完整保留。
    const extras = docParagraphs.slice(expected.length);
    check('docx_no_system_appendices', extras.length === 0, `系统附加段落数=${extras.length}`);
    check('draft_internal_provenance_retained', draft.provenance === 'model_generated', '来源性质留在任务记录中，不写进交付正文');
  } else {
    notes.push('任务响应未携带 draft：无法核对"段落部分等于发布草稿"，该子项记为未验证。');
  }

  return report(null);
}

function report(fatal) {
  const failed = checks.filter((c) => !c.passed);
  const summary = {
    baseUrl: BASE_URL,
    readOnly: READ_ONLY,
    liveModelRequestsIssuedByThisScript: liveRequestsIssued,
    fatal: fatal ?? null,
    checksTotal: checks.length,
    checksFailed: failed.length,
    checks,
    notes,
  };
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tag = String(flag('tag', ''));
  const outPath = join(
    EVIDENCE_DIR,
    `verify-demo-${tag ? `${tag}-` : ''}${READ_ONLY ? 'readonly' : 'live'}-${stamp}.json`,
  );
  writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log('');
  console.log(`# 检查 ${checks.length} 项，失败 ${failed.length} 项`);
  console.log(`# live 模型真实请求次数（本脚本发出）：${liveRequestsIssued}`);
  for (const note of notes) console.log(`# 备注：${note}`);
  console.log(`# 原始输出：${relative(REPO_ROOT, outPath).replace(/\\/g, '/')}`);

  if (fatal && !/不可达/.test(fatal)) return 1;
  if (fatal) return 2;
  return failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`[FATAL] ${error?.stack ?? error}`);
    process.exitCode = 1;
  });
