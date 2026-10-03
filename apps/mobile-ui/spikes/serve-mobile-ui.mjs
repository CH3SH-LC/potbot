#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * ============================================================================
 * SPIKE —— potbot mobile-ui 组合根的**静态/渲染服务**（宿主侧投递垫片）
 * ============================================================================
 *
 * 这是 **spike（一次性投递垫片）**，不是产品服务：
 *
 *   - 它**不修改** `apps/demo/**`、`apps/android/**`、`src/**` 任何产品源码；
 *   - 它**不连内核**、不发命令、不读密钥、不写用户文档；
 *   - 它只做三件事：把编译后的组合根渲染成 HTML 投给浏览器/手机；投两张静态资源；
 *     收一份「页面自己看到的渲染报告」，作为**渲染证据**（本仓没有截图能力）。
 *
 * ## 为什么另起端口，而不是复用 8765 的 Demo 服务
 *
 * 产品服务在 `127.0.0.1:8765`（`apps/demo/server/main.ts`），静态目录可用
 * `POTBOT_WEB_DIR` 覆盖。要让手机看到本页有两条路：
 *   1. 复用产品服务：`POTBOT_WEB_DIR=<本页目录>` 起 Demo —— 会**替换**掉当前 demo 页面，
 *      且要拉起整个内核/模型端口；
 *   2. **本文件**：独立小服务 + 独立的 `adb reverse`（见下方「手机打开方式」）——
 *      产品服务一个字节都不动，两者可以同时在跑、互不干扰。
 * 本任务选 2，并在交付说明里写明。
 *
 * ## 手机打开方式（HONOR HDB，非标准 adb）
 *
 * ```bash
 * # 1) 起服务（本机）
 * node apps/mobile-ui/spikes/serve-mobile-ui.mjs            # 默认 127.0.0.1:8788
 *
 * # 2) 建反向隧道（把手机的 127.0.0.1:8788 指回本机 8788）
 * .runtime/honor-hdb/honor-hdb-native.exe --service <serial> <hdb-port> "reverse:forward:tcp:8788;tcp:8788"
 *
 * # 3) 在手机上打开浏览器
 * .runtime/honor-hdb/honor-hdb-native.exe --service <serial> <hdb-port> \
 *   "shell:am start -a android.intent.action.VIEW -d http://127.0.0.1:8788/"
 *
 * # 4) 读回证据（页面加载时自己 POST 上来的渲染报告）
 * curl -s http://127.0.0.1:8788/__evidence
 * ```
 *
 * 退出码：0 = 正常启动后收到 SIGINT/SIGTERM；1 = 编译产物缺失（先跑 tsc）。
 */

import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const BUILD_ENTRY = join(REPO_ROOT, '.runtime', 'mobile-ui-app', 'build', 'app', 'index.js');
const SHELL_ENTRY = join(REPO_ROOT, '.runtime', 'mobile-ui-app', 'build', 'shell', 'index.js');
const EVIDENCE_DIR = join(REPO_ROOT, '.runtime', 'mobile-ui-app');
const EVIDENCE_FILE = join(EVIDENCE_DIR, 'device-render-evidence.json');
const FOUNDATION_CSS = join(REPO_ROOT, 'apps', 'mobile-ui', 'foundation.css');
const BRAND_PNG = join(REPO_ROOT, 'docs', 'design', 'release-ui', 'brand-user.png');

const PORT = Number(process.env.POTBOT_UI_PORT ?? 8788);
const BIND = process.env.POTBOT_UI_BIND ?? '127.0.0.1';
const MAX_REPORT_BYTES = 64 * 1024;

if (!existsSync(BUILD_ENTRY)) {
  console.error(`[mobile-ui] 编译产物缺失：${BUILD_ENTRY}`);
  console.error('[mobile-ui] 先跑：node_modules/.bin/tsc -p apps/mobile-ui/tsconfig.build.json');
  process.exit(1);
}

/** 组合根（已编译的 F 线前端库装配）。 */
const app = await import(`file://${BUILD_ENTRY.replace(/\\/g, '/')}`);
/** shell 注册表（屏幕 id 的单一来源；组合根不另列一份清单）。 */
const shell = await import(`file://${SHELL_ENTRY.replace(/\\/g, '/')}`);

/** 屏幕 id 白名单直接取自 shell 注册表（单一来源，不在这里另列一份）。 */
const SCREEN_IDS = shell.listScreens().map((s) => s.id);

/** 已收到的渲染报告（内存 + 落盘）。 */
const reports = [];

function readQuery(url) {
  const q = url.searchParams;
  const num = (key, fallback) => {
    const raw = q.get(key);
    if (raw === null) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  };
  return {
    insets: {
      top: num('safeTop', 0),
      right: num('safeRight', 0),
      bottom: num('safeBottom', 0),
      left: num('safeLeft', 0),
    },
    keyboardHeightDp: num('kb', 0),
    ...(q.get('w') === null ? {} : { widthDp: num('w', 400) }),
  };
}

function send(res, status, contentType, body) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': bytes.byteLength,
    'cache-control': 'no-store',
  });
  res.end(bytes);
}

function sendFile(res, filePath, contentType) {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    send(res, 404, 'text/plain; charset=utf-8', 'not found\n');
    return;
  }
  send(res, 200, contentType, readFileSync(filePath));
}

function persistEvidence() {
  try {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    writeFileSync(
      EVIDENCE_FILE,
      `${JSON.stringify({ schemaVersion: 1, server: `http://${BIND}:${PORT}`, reports }, null, 2)}\n`,
      'utf8',
    );
  } catch (cause) {
    console.error('[mobile-ui] 证据落盘失败（不影响页面）：', String(cause));
  }
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.byteLength;
    if (total > MAX_REPORT_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * `--static-export <dir>`：把 28 个屏幕导出成**静态站点**。
 *
 * 用途：不想另起端口时，可把导出的目录交给产品服务的静态目录
 * （`POTBOT_WEB_DIR=<dir>` 起 `apps/demo/server`），于是**现有 APK 的 WebView**
 * （它固定加载 `http://127.0.0.1:8765/`）直接显示这一版界面。本模式**不改产品源码**，
 * 只是往一个环境变量指向的目录里写文件。
 *
 * 导出内容：`index.html`（C01）、`s/<屏幕id>.html`（28 屏）、`foundation.css`、`assets/brand.png`。
 */
function staticExport(outDir) {
  const write = (rel, body) => {
    const target = join(outDir, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  };
  const defaults = { insets: { top: 0, right: 0, bottom: 0, left: 0 }, keyboardHeightDp: 0 };
  write('index.html', app.renderScreenDocument('C01', defaults));
  for (const id of SCREEN_IDS) {
    write(join('s', `${id}.html`), app.renderScreenDocument(id, defaults));
  }
  write('foundation.css', readFileSync(FOUNDATION_CSS));
  write('assets/brand.png', readFileSync(BRAND_PNG));
  console.log(`[mobile-ui] 静态导出完成：${outDir}`);
  console.log(`[mobile-ui] 交给产品服务：POTBOT_WEB_DIR=${outDir}  （随后重启 apps/demo/server）`);
}

if (process.argv[2] === '--static-export') {
  const outDir = resolve(process.argv[3] ?? join(REPO_ROOT, '.runtime', 'mobile-ui-app', 'www'));
  staticExport(outDir);
  process.exit(0);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${BIND}:${PORT}`);
  const pathname = url.pathname;

  if (req.method !== 'GET' && req.method !== 'HEAD' && pathname !== '/__render-report') {
    send(res, 405, 'text/plain; charset=utf-8', 'method not allowed\n');
    return;
  }

  if (pathname === '/health') {
    send(res, 200, 'application/json; charset=utf-8', `${JSON.stringify({
      ok: true,
      service: 'potbot-mobile-ui-spike',
      screens: SCREEN_IDS.length,
      reports: reports.length,
      fixtureKernelConnected: false,
    })}\n`);
    return;
  }

  if (pathname === '/__evidence') {
    send(res, 200, 'application/json; charset=utf-8', `${JSON.stringify({ reports }, null, 2)}\n`);
    return;
  }

  if (pathname === '/__render-report' && req.method === 'POST') {
    const raw = await readBody(req);
    if (raw === null) {
      send(res, 413, 'application/json; charset=utf-8', '{"error":"report_too_large"}\n');
      return;
    }
    let payload = null;
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = { parseError: true, rawBytes: raw.length };
    }
    reports.push({
      receivedAt: new Date().toISOString(),
      remote: req.socket.remoteAddress ?? 'unknown',
      payload,
    });
    persistEvidence();
    console.log(`[mobile-ui] 渲染报告 #${reports.length} screen=${payload?.screen ?? '?'} title=${payload?.title ?? '?'}`);
    send(res, 200, 'application/json; charset=utf-8', '{"ok":true}\n');
    return;
  }

  if (pathname === '/foundation.css') {
    sendFile(res, FOUNDATION_CSS, 'text/css; charset=utf-8');
    return;
  }

  if (pathname === '/assets/brand.png') {
    sendFile(res, BRAND_PNG, 'image/png');
    return;
  }

  // `/` → C01（对话入口）；`/s/<id>` → 该屏；`/s/<id>.txt` → 可访问性文本读回。
  const textMode = pathname.startsWith('/s/') && pathname.endsWith('.txt');
  const screenId =
    pathname === '/' || pathname === '/index.html'
      ? 'C01'
      : pathname.startsWith('/s/')
        ? pathname.slice(3).replace(/\.txt$/, '').replace(/\.html$/, '')
        : null;

  if (screenId === null) {
    send(res, 404, 'text/html; charset=utf-8', '<!doctype html><meta charset="utf-8"><h1>404</h1><p>没有这个路径。</p>\n');
    return;
  }

  if (!SCREEN_IDS.includes(screenId)) {
    send(
      res,
      404,
      'text/html; charset=utf-8',
      `<!doctype html><meta charset="utf-8"><h1>404</h1><p>未登记的屏幕 id：${screenId.replace(/[<>&]/g, '')}</p>\n`,
    );
    return;
  }

  const options = readQuery(url);
  try {
    if (textMode) {
      send(res, 200, 'text/plain; charset=utf-8', app.renderScreenText(screenId, options));
      return;
    }
    const html = app.renderScreenDocument(screenId, options);
    if (req.method === 'HEAD') {
      send(res, 200, 'text/html; charset=utf-8', '');
      return;
    }
    send(res, 200, 'text/html; charset=utf-8', html);
  } catch (cause) {
    // fail-closed：渲染失败如实报 500，不吐半成品页面。
    console.error(`[mobile-ui] 渲染失败 screen=${screenId}:`, String(cause));
    send(res, 500, 'text/plain; charset=utf-8', `render failed: ${String(cause)}\n`);
  }
});

// HDB `toybox nc` 经 PTY 送来的字节可能带控制字符；Node 的 HTTP 解析器会直接 400。
// 这里把原始包记成 hex，便于诊断「手机到宿主」这一段到底发了什么（spike 诊断用）。
server.on('clientError', (error, socket) => {
  const raw = error.rawPacket ? Buffer.from(error.rawPacket).toString('hex').slice(0, 400) : '';
  console.error(`[mobile-ui] clientError ${error.code} rawHex=${raw}`);
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});

server.listen(PORT, BIND, () => {
  console.log(`[mobile-ui] spike 静态服务 http://${BIND}:${PORT}/  (屏幕 ${SCREEN_IDS.length} 个)`);
  console.log('[mobile-ui] 首页 /  ·  屏幕 /s/<id>  ·  可访问性文本 /s/<id>.txt  ·  证据 /__evidence');
  console.log(`[mobile-ui] 夹具渲染；未接内核（kernelConnected=false）。证据落盘：${EVIDENCE_FILE}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n[mobile-ui] 收到 ${signal}，关闭。`);
    server.close(() => process.exit(0));
  });
}
