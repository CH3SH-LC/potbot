#!/usr/bin/env node
/**
 * scripts/demo/model-preflight.mjs
 * S4 —— 真实模型配置预检（三小时手机 Word Demo）
 *
 * 目标：把三件事**分开**说清楚，不许互相冒充
 *   1) configPresent   —— 环境变量是否给了 base url / 认证 / model
 *   2) endpointReachable —— HTTP 上这些端点是否真的存在（错误形状可辨识）
 *   3) generationVerified —— 是否真的拿回了一段**可用正文**
 *
 * 额度纪律（全冲刺真实请求上限 12 次，脚本约定 1 次）：
 *   本脚本最多发 1 次**真实生成请求**（默认开启，`--no-live` 关闭）。
 *   其余探测都带「空 / 非法」请求体，只会拿到 4xx 校验错误，不产生生成结果。
 *   若首个形状返回 404/405（端点根本不存在），允许对另一形状再试一次；
 *   脚本如实分开统计「HTTP 提交次数」与「真正产生正文的生成次数」。
 *
 * 安全：只读环境变量；不打印、不落盘任何密钥值。所有输出经 sanitize()。
 *
 * 用法：
 *   node scripts/demo/model-preflight.mjs            # 探测 + 1 次真实生成
 *   node scripts/demo/model-preflight.mjs --no-live  # 只探测，不生成（0 次额度）
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const PROBE_TIMEOUT_MS = 10_000;
const LIVE_TIMEOUT_MS = 45_000;
// 与合同默认值一致（曾是 600，正是这个探测量太小导致了"假截断"，见 S4.md §3.2）。
// 可用 POTBOT_MODEL_MAX_TOKENS 覆盖，但默认必须与端口一致。
const LIVE_MAX_TOKENS = (() => {
  const raw = (process.env.POTBOT_MODEL_MAX_TOKENS || '').trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 1600;
})();
// 与端口默认一致：带 thinking:{type:"disabled"}，把输出预算留给正文。
const LIVE_THINKING_DISABLED = (() => {
  const raw = (process.env.POTBOT_MODEL_THINKING_DISABLED || '').trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no');
})();
const RUN_ID = process.env.DEMO_RUN_ID || 'MWD-20261002-A';
const PREFLIGHT_TASK_ID = 'preflight';

/** 全冲刺真实请求上限（与 apps/demo/model/ledger.ts 同口径）。 */
const MAX_REQUESTS = (() => {
  const raw = (process.env.POTBOT_MODEL_MAX_REQUESTS || '').trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 12;
})();

const args = new Set(process.argv.slice(2));
const DO_LIVE = !args.has('--no-live');

/* ------------------------------------------------------------------ *
 * 脱敏
 * ------------------------------------------------------------------ */

const SECRET_VALUES = [
  process.env.ANTHROPIC_AUTH_TOKEN,
  process.env.ANTHROPIC_API_KEY,
].filter((v) => typeof v === 'string' && v.length >= 8);

function sanitize(input) {
  let s = typeof input === 'string' ? input : String(input ?? '');
  for (const secret of SECRET_VALUES) {
    s = s.split(secret).join('***REDACTED***');
  }
  s = s.replace(/\bsk-[A-Za-z0-9_-]{6,}/g, 'sk-***');
  s = s.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***');
  s = s.replace(/("(?:api_?key|auth_?token|authorization|x-api-key)"\s*:\s*")[^"]{4,}(")/gi, '$1***$2');
  return s;
}

/* ------------------------------------------------------------------ *
 * 仓库根定位（tsc 产物目录深度与源码目录不同，不能只靠相对层数）
 * ------------------------------------------------------------------ */

async function looksLikeRepoRoot(dir) {
  try {
    const { access } = await import('node:fs/promises');
    await access(join(dir, 'apps', 'demo', 'contracts.ts'));
    return true;
  } catch {
    return false;
  }
}

async function findRepoRoot() {
  const starts = [process.cwd(), dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))];
  for (const start of starts) {
    let cur = resolve(start);
    for (let i = 0; i < 8; i += 1) {
      if (await looksLikeRepoRoot(cur)) return cur;
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  return resolve(process.cwd());
}

/* ------------------------------------------------------------------ *
 * 配置读取
 * ------------------------------------------------------------------ */

const env = process.env;
const rawBase = (env.ANTHROPIC_BASE_URL || '').trim().replace(/\/+$/, '');
const authToken = (env.ANTHROPIC_AUTH_TOKEN || '').trim();
const apiKey = (env.ANTHROPIC_API_KEY || '').trim();
const model = (env.ANTHROPIC_MODEL || '').trim();

const config = {
  baseUrl: rawBase,
  baseUrlHost: (() => {
    try {
      return new URL(rawBase).host;
    } catch {
      return '<unparseable>';
    }
  })(),
  baseUrlScheme: (() => {
    try {
      return new URL(rawBase).protocol.replace(':', '');
    } catch {
      return '<unparseable>';
    }
  })(),
  model,
  authTokenSet: authToken.length > 0,
  authTokenLength: authToken.length,
  apiKeySet: apiKey.length > 0,
  authMode: authToken ? 'bearer_authorization_header (ANTHROPIC_AUTH_TOKEN)' : apiKey ? 'x-api-key (ANTHROPIC_API_KEY)' : 'none',
  configPresent: rawBase.length > 0 && model.length > 0 && (authToken.length > 0 || apiKey.length > 0),
};

function authHeaders() {
  const h = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
  if (authToken) h.authorization = `Bearer ${authToken}`;
  else if (apiKey) h['x-api-key'] = apiKey;
  return h;
}

/* ------------------------------------------------------------------ *
 * 探测
 * ------------------------------------------------------------------ */

async function probe(name, { method, url, headers, body, timeoutMs = PROBE_TIMEOUT_MS }) {
  const started = Date.now();
  const record = { name, method, url, status: null, durationMs: 0, jsonErrorShape: null, bodyHead: '', error: null };
  try {
    const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    record.status = res.status;
    record.contentType = res.headers.get('content-type');
    record.durationMs = Date.now() - started;
    const safe = sanitize(text);
    record.bodyHead = safe.slice(0, 500);
    try {
      const parsed = JSON.parse(text);
      record.jsonErrorShape = classifyErrorShape(parsed);
    } catch {
      record.jsonErrorShape = 'not_json';
    }
  } catch (err) {
    record.durationMs = Date.now() - started;
    record.error = sanitize(`${err?.name || 'Error'}: ${err?.message || err}`);
  }
  return record;
}

/** 判定错误响应属于哪种 API 家族。只看形状，不看内容语义。 */
function classifyErrorShape(parsed) {
  if (!parsed || typeof parsed !== 'object') return 'not_object';
  if (parsed.type === 'error' && parsed.error && typeof parsed.error === 'object') return 'anthropic_error';
  if (parsed.error && typeof parsed.error === 'object' && !Array.isArray(parsed.error)) return 'openai_error';
  if (typeof parsed.message === 'string') return 'bare_message';
  return 'other_json';
}

/* ------------------------------------------------------------------ *
 * 额度账本（与 apps/demo/model/ledger.ts 同一份文件、同一计法）
 * 只记元数据：不记密钥，也不记完整响应正文。
 * ------------------------------------------------------------------ */

async function ledgerPath() {
  const repoRoot = await findRepoRoot();
  return join(repoRoot, '.runtime', 'mobile-word-demo', RUN_ID, 'model-ledger.jsonl');
}

async function appendLedgerLine(entry) {
  const path = await ledgerPath();
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(entry) + '\n', 'utf8');
  return path;
}

/** 数账本里已登记过多少次请求（含其它模块写的行）。读不到就按 0 计。 */
async function countLedgerReserved() {
  try {
    const path = await ledgerPath();
    const text = await readFile(path, 'utf8');
    let count = 0;
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        if (JSON.parse(trimmed).kind === 'budget_reserved') count += 1;
      } catch {
        // 坏行忽略
      }
    }
    return count;
  } catch {
    return 0;
  }
}

function candidateBases(base) {
  const list = [base];
  if (!/\/v1$/.test(base)) list.push(`${base}/v1`);
  return [...new Set(list)];
}

const PROBE_BODY = '{}';
const probeHeaders = { ...authHeaders() };

async function runProbes() {
  const results = [];
  const bases = candidateBases(rawBase);

  for (const base of bases) {
    results.push(await probe(`POST ${base}/messages (empty body)`, {
      method: 'POST', url: `${base}/messages`, headers: probeHeaders, body: PROBE_BODY,
    }));
    results.push(await probe(`POST ${base}/chat/completions (empty body)`, {
      method: 'POST', url: `${base}/chat/completions`, headers: probeHeaders, body: PROBE_BODY,
    }));
    results.push(await probe(`GET ${base}/models`, { method: 'GET', url: `${base}/models`, headers: probeHeaders }));
  }
  return results;
}

/**
 * 从探测结果推断「哪种形状被真实接受」。
 * 判定依据：该端点对非法请求体返回的是**可辨识的 JSON 错误**（而不是 404 / HTML / 连接错误）。
 */
function detectShape(probes, base) {
  const bases = candidateBases(base);
  const ordered = [];
  for (const b of bases) ordered.push({ base: b, shape: 'anthropic', url: `${b}/messages` });
  for (const b of bases) ordered.push({ base: b, shape: 'openai', url: `${b}/chat/completions` });

  const findings = ordered.map((cand) => {
    const p = probes.find((r) => r.url === cand.url && r.method === 'POST');
    const status = p?.status ?? null;
    const shape = p?.jsonErrorShape ?? null;
    const alive = status !== null && status !== 404 && status < 500;
    const recognisable = alive && (shape === 'anthropic_error' || shape === 'openai_error' || shape === 'bare_message' || status === 400 || status === 401 || status === 403 || status === 422);
    return { ...cand, status, errorShape: shape, alive, recognisable };
  });

  const winners = findings.filter((f) => f.recognisable);
  return { findings, winners };
}

/* ------------------------------------------------------------------ *
 * 真实生成（1 次额度）
 * ------------------------------------------------------------------ */

const LIVE_INSTRUCTION =
  '为新生读书会写一封温暖的邀请函，不编造时间、地点和报名联系方式。';

const LIVE_SYSTEM =
  '你是写作助手。只输出一个 JSON 对象，不要输出任何解释、注释或 Markdown 代码块围栏。\n' +
  'JSON 形状必须是：{"title":"字符串","paragraphs":[{"id":"p1","text":"字符串"},{"id":"p2","text":"字符串"}]}\n' +
  '要求：title 非空；paragraphs 恰好 2 段；每段非空；正文总字数不超过 2000。\n' +
  '不得编造具体人数、金额、日期或出处；用户请求里若出现未经确认的具体数字，' +
  '正文中必须写「需要补充资料」而不得自行编造。';

function buildLiveBody(shape, base) {
  const userText = `${LIVE_INSTRUCTION}\n\n请按系统要求只输出 JSON。`;
  if (shape === 'anthropic') {
    return {
      url: `${base}/messages`,
      body: JSON.stringify({
        model,
        max_tokens: LIVE_MAX_TOKENS,
        temperature: 0.15,
        system: LIVE_SYSTEM,
        messages: [{ role: 'user', content: userText }],
        ...(LIVE_THINKING_DISABLED ? { thinking: { type: 'disabled' } } : {}),
      }),
    };
  }
  return {
    url: `${base}/chat/completions`,
    body: JSON.stringify({
      model,
      max_tokens: LIVE_MAX_TOKENS,
      temperature: 0.15,
      messages: [
        { role: 'system', content: LIVE_SYSTEM },
        { role: 'user', content: userText },
      ],
    }),
  };
}

function extractText(shape, parsed) {
  if (shape === 'anthropic') {
    if (Array.isArray(parsed?.content)) {
      const parts = parsed.content
        .filter((b) => b && (b.type === 'text' || typeof b.text === 'string'))
        .map((b) => String(b.text ?? ''));
      if (parts.length) return parts.join('');
    }
    if (typeof parsed?.content === 'string') return parsed.content;
    return null;
  }
  const choice = Array.isArray(parsed?.choices) ? parsed.choices[0] : null;
  const content = choice?.message?.content ?? choice?.text;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => String(c?.text ?? '')).join('');
  return null;
}

function stripFences(text) {
  const t = text.trim();
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(t);
  return m && typeof m[1] === 'string' ? m[1].trim() : t;
}

const live = {
  enabled: DO_LIVE,
  httpPosts: 0,
  generations: 0,
  attempts: [],
  verdict: 'not_attempted',
  draft: null,
};

async function runLive(shape, base) {
  const { url, body } = buildLiveBody(shape, base);
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const requestId = `preflight-${startedAt}`;
  const attempt = {
    shape,
    url,
    requestId,
    startedAt,
    durationMs: 0,
    status: null,
    ok: false,
    note: '',
    thinkingDisabled: false,
  };

  // 预算：先登记，再发请求。超预算不继续打。
  const used = await countLedgerReserved();
  if (used >= MAX_REQUESTS) {
    attempt.note = `预算耗尽（已登记 ${used} / 上限 ${MAX_REQUESTS}），未发出请求`;
    live.attempts.push(attempt);
    live.budgetBlocked = true;
    return false;
  }
  const attemptIndex = used + 1;
  attempt.attemptIndex = attemptIndex;
  await appendLedgerLine({
    kind: 'budget_reserved',
    requestId,
    taskId: PREFLIGHT_TASK_ID,
    provider: shape === 'anthropic' ? 'anthropic_messages' : 'openai_chat_completions',
    model,
    attemptIndex,
    startedAt,
    thinkingDisabled: false,
  });

  live.httpPosts += 1;
  let errorCode = null;
  let outputChars = 0;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: authHeaders(),
      body,
      signal: AbortSignal.timeout(LIVE_TIMEOUT_MS),
    });
    attempt.status = res.status;
    const raw = await res.text();
    attempt.durationMs = Date.now() - started;
    attempt.bodyHead = sanitize(raw).slice(0, 600);

    if (!res.ok) {
      attempt.note = `HTTP ${res.status}`;
      errorCode = `preflight_http_${res.status}`;
    } else {
      live.generations += 1;
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      if (parsed === null) {
        attempt.note = 'response is not JSON';
        errorCode = 'model_response_not_json';
      } else {
        const text = extractText(shape, parsed);
        if (!text || !text.trim()) {
          attempt.note = 'no text content in response';
          errorCode = 'model_empty_response';
        } else {
          outputChars = text.length;
          attempt.responseChars = text.length;
          attempt.responseHead = sanitize(text).slice(0, 300);
          const verdict = validateDraft(text);
          attempt.note = verdict.ok ? 'draft validated' : `draft invalid: ${verdict.reason}`;
          attempt.draftValid = verdict.ok;
          if (verdict.ok) {
            live.draft = verdict.draft;
          } else {
            errorCode = 'model_response_invalid';
            // 失败分支也要留档：脱敏后的正文片段。
            attempt.responseExcerpt = sanitize(text).slice(0, 160);
          }
        }
      }
    }
  } catch (err) {
    attempt.durationMs = Date.now() - started;
    attempt.note = sanitize(`${err?.name || 'Error'}: ${err?.message || err}`);
    errorCode = 'model_transport_error';
  }

  attempt.ok = attempt.draftValid === true;
  live.attempts.push(attempt);

  await appendLedgerLine({
    kind: 'call_result',
    requestId,
    taskId: PREFLIGHT_TASK_ID,
    provider: shape === 'anthropic' ? 'anthropic_messages' : 'openai_chat_completions',
    model,
    attemptIndex,
    startedAt,
    thinkingDisabled: false,
    durationMs: attempt.durationMs,
    ok: attempt.ok,
    promptChars: LIVE_SYSTEM.length + LIVE_INSTRUCTION.length + 64,
    outputChars,
    ...(errorCode ? { errorCode } : {}),
  });

  return attempt.ok;
}

/** 与 apps/demo/model/validate.ts 同口径的轻量校验（此处内联以免依赖 TS 构建产物）。 */
function validateDraft(rawText) {
  let parsed;
  try {
    parsed = JSON.parse(stripFences(rawText));
  } catch {
    return { ok: false, reason: 'not valid JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'root is not a JSON object' };
  }
  const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
  if (!title) return { ok: false, reason: 'title empty' };
  if (!Array.isArray(parsed.paragraphs)) return { ok: false, reason: 'paragraphs not an array' };
  if (parsed.paragraphs.length < 2 || parsed.paragraphs.length > 4) {
    return { ok: false, reason: `paragraph count ${parsed.paragraphs.length} out of range 2..4` };
  }
  const paragraphs = [];
  let total = 0;
  for (let i = 0; i < parsed.paragraphs.length; i += 1) {
    const p = parsed.paragraphs[i];
    const text = typeof p === 'string' ? p : p && typeof p.text === 'string' ? p.text : null;
    if (text === null) return { ok: false, reason: `paragraph ${i + 1} has no text` };
    if (!text.trim()) return { ok: false, reason: `paragraph ${i + 1} is blank` };
    total += text.trim().length;
    paragraphs.push({ id: `p${i + 1}`, text: text.trim() });
  }
  if (total > 2000) return { ok: false, reason: `total draft chars ${total} exceed 2000` };
  return { ok: true, reason: 'ok', draft: { title, paragraphs, provenance: 'model_generated', totalChars: total } };
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function main() {
  const startedAt = new Date().toISOString();
  const report = {
    script: 'scripts/demo/model-preflight.mjs',
    runId: RUN_ID,
    startedAt,
    checkedAt: startedAt,
    node: process.version,
    config,
    stage1_configPresent: config.configPresent,
    stage2_endpointReachable: false,
    stage3_generationVerified: false,
    probes: [],
    shapeDetection: null,
    live,
    notes: [],
  };

  if (!rawBase) {
    report.notes.push('ANTHROPIC_BASE_URL 未设置，无法探测。');
    emit(report, 2);
    return;
  }

  report.probes = await runProbes();

  const detection = detectShape(report.probes, rawBase);
  report.shapeDetection = {
    findings: detection.findings,
    acceptedShapes: detection.winners.map((w) => ({ shape: w.shape, url: w.url, status: w.status, errorShape: w.errorShape })),
  };
  report.stage2_endpointReachable = detection.winners.length > 0;

  if (!report.stage2_endpointReachable) {
    report.notes.push('没有任何候选端点对非法请求体返回可辨识的 JSON 错误 —— 端点形状未知。');
    emit(report, 3);
    return;
  }

  if (!DO_LIVE) {
    report.notes.push('--no-live：跳过真实生成，未消耗额度。');
    emit(report, 0);
    return;
  }

  if (!config.configPresent) {
    report.notes.push('配置不完整（缺 base url / 认证 / model），跳过真实生成。');
    emit(report, 2);
    return;
  }

  // 先试首选形状；仅在端点根本不存在（无 2xx/4xx 且 404/405）时换另一形状。
  const ordered = [...detection.winners].sort((a, b) => (a.shape === 'anthropic' ? -1 : 1) - (b.shape === 'anthropic' ? -1 : 1));
  for (const winner of ordered) {
    const ok = await runLive(winner.shape, winner.base);
    if (ok) break;
    const last = live.attempts[live.attempts.length - 1];
    const switchable = last && (last.status === 404 || last.status === 405 || last.status === null);
    if (!switchable) break;
  }

  report.stage3_generationVerified = live.draft !== null;
  report.live.verdict = report.stage3_generationVerified ? 'generation_verified' : 'generation_failed';
  if (!report.stage3_generationVerified) {
    report.notes.push('端点可达，但未取得合法草稿 —— 真实生成未通过，不得据此宣称模型可用。');
  }
  emit(report, report.stage3_generationVerified ? 0 : 4);
}

async function emit(report, code) {
  report.finishedAt = new Date().toISOString();
  report.exitCode = code;
  const json = sanitize(JSON.stringify(report, null, 2));

  const repoRoot = await findRepoRoot();
  const runtimeDir = join(repoRoot, '.runtime', 'mobile-word-demo', RUN_ID);
  try {
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(join(runtimeDir, 'model-preflight.json'), json + '\n', 'utf8');
    report.writtenTo = join(runtimeDir, 'model-preflight.json');
  } catch (err) {
    report.writtenTo = `write failed: ${sanitize(String(err?.message || err))}`;
  }

  process.stdout.write(sanitize(JSON.stringify(report, null, 2)) + '\n');
  process.exitCode = code;
}

main().catch((err) => {
  process.stderr.write(sanitize(`preflight crashed: ${err?.stack || err}`) + '\n');
  process.exitCode = 5;
});
