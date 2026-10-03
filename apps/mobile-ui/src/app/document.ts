/**
 * F-APP 组合根 —— **整页 HTML 文档生成器**（composition root → 可交付页面）。
 *
 * `renderHtml()` 只序列化**一棵 ViewNode 树**；真机上人看到的是**一个完整 HTML 文档**。
 * 本模块补上那一层：`<head>`（viewport / 标题 / 样式）+ `<body>`（渲染出来的视图树，
 * 外加一个用于真机读回的极小脚本）。
 *
 * ## 分层（谁写什么）
 *
 * | 层 | 生产者 | 产出 |
 * | --- | --- | --- |
 * | 视图树 | `pages.ts`（消费 shell/render/foundation） | `ViewNode` |
 * | 视图树 → HTML | `render/render-html.ts` | 转义且 byte-stable 的 HTML 片段 |
 * | HTML → 整页 | **本文件** | `<!doctype html>` 文档 |
 * | 整页 → 手机 | `apps/mobile-ui/spikes/serve-mobile-ui.mjs`（spike 静态服务） | HTTP |
 *
 * ## 样式从哪来
 *
 * - **令牌**：`apps/mobile-ui/foundation.css`（颜色等 `--pb-color-*` CSS 变量），由测试与
 *   `foundation/tokens.ts` 逐变量比对，是设计令牌的落盘投影；本文件**不重写**它。
 * - **结构**：本文件的 `STRUCTURAL_CSS`，只做几何（flex / 定点 / 触区 / 省略号）。
 *   颜色一律 `var(--pb-color-*)`；本文件**不写死十六进制色值**。
 * - **内联令牌**：颜色 / 字号 / 字重 / 间距 / 圆角由 `pages.ts` 以令牌名给出，
 *   经 `render-html.ts` 序列化成 `style="color: var(--pb-color-…); font-size: 16px"`。
 *
 * ## 未做（如实标注）
 *
 * - 不读系统 inset / 软键盘：`--pb-composer-offset` 由宿主人为注入（查询参数），
 *   真机 IME 数值未接（见 `safe-area.ts` 的宿主桥，本组合根不发命令）。
 * - 无事件状态机：导航是整页 `<a href>` 跳转，不是单页路由；没有 View 复用 / 局部刷新。
 * - 无真机截图能力：渲染证据靠页面自身的 `fetch('/__render-report')` 读回（见 `serve-mobile-ui.mjs`）。
 */

import { renderHtml } from '../render/index.js';
import { renderText } from '../render/index.js';
import { screenDefOf, type ScreenId } from '../shell/index.js';
import { FIXTURE_PROVENANCE } from './fixtures.js';
import { buildScreenPage, composerOffsetDp, isWiredScreen, type PageOptions } from './pages.js';

/**
 * 结构样式（几何 only）。
 *
 * 说明两处**设计未写死**的数值，此处按「可运行、可替换」处理，不冒充设计定稿：
 *  - 选中下划线 2px：design-07 §2 行 36 只写「细橙色下划线」，未给 dp；
 *  - 字体族：design-07 §3 行 101 只写「Android 系统中文无衬线字体」，未给 font-family 串，
 *    故用系统字体栈（真机即系统字体）。
 */
const STRUCTURAL_CSS = `
:root { color-scheme: light only; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--pb-color-canvas); }
body {
  color: var(--pb-color-text-primary);
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", "Noto Sans SC", sans-serif;
  font-size: 16px;
  line-height: 1.5;
  -webkit-text-size-adjust: 100%;
}
.pb-app {
  max-width: 480px;
  margin: 0 auto;
  min-height: 100vh;
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  background: var(--pb-color-canvas);
}
.pb-app a { color: inherit; text-decoration: none; }
.pb-app h1, .pb-app h2, .pb-app p { margin: 0; }
.pb-app :focus-visible { outline: 2px solid var(--pb-color-focus-ring); outline-offset: 2px; }

/* ---- 页头 ---- */
.pb-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 20px 8px;
  padding-top: calc(12px + env(safe-area-inset-top, 0px));
}
.pb-header--detail { justify-content: flex-start; }
.pb-brand-mark {
  width: 24px; height: 24px; flex: 0 0 auto;
  background-image: url("/assets/brand.png");
  background-repeat: no-repeat;
  background-position: center;
  background-size: contain;
}
.pb-brand-title { letter-spacing: 0.02em; }
.pb-fixture-badge {
  margin-left: auto;
  padding: 2px 8px;
  border-radius: 12px;
  background: var(--pb-color-accent-surface);
}
.pb-new-entry, .pb-back {
  min-height: 48px; min-width: 48px;
  display: inline-flex; align-items: center;
  padding: 0 6px;
  background: none; border: 0; font: inherit;
}
.pb-header--detail .pb-detail-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---- 主体 ---- */
.pb-main {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  padding: 8px 20px 112px;
  overflow-y: auto;
}
.pb-section { display: flex; flex-direction: column; }
.pb-section-title { margin: 0; }
.pb-card, .pb-list { border: 1px solid var(--pb-color-outline); border-radius: 20px; display: flex; flex-direction: column; }
.pb-card { padding: 16px; }
.pb-list { padding: 8px; }
.pb-empty, .pb-note { margin: 0; }

/* ---- 行 ---- */
.pb-row, .pb-result-row {
  display: flex; align-items: center; gap: 12px;
  min-height: 48px;
  padding: 8px 4px;
  border-bottom: 1px solid var(--pb-color-outline);
}
.pb-row:last-child, .pb-result-row:last-child { border-bottom: 0; }
.pb-row-main, .pb-result-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.pb-row-title, .pb-row-snippet, .pb-result-title, .pb-result-meta,
.pb-row-time, .pb-result-open {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.pb-row-time, .pb-result-open { flex: 0 0 auto; }

/* ---- 状态胶囊 ---- */
.pb-chip { flex: 0 0 auto; padding: 2px 10px; border-radius: 12px; white-space: nowrap; }
.pb-chip--pending { background: var(--pb-color-accent-surface); color: var(--pb-color-accent-text); }
.pb-chip--running { background: var(--pb-color-accent-surface); color: var(--pb-color-success); }
.pb-chip--ended { background: var(--pb-color-surface); color: var(--pb-color-text-secondary); border: 1px solid var(--pb-color-outline); }

/* ---- 底部四入口导航（细橙色选中下划线） ---- */
.pb-tabbar {
  position: fixed;
  left: 0; right: 0; bottom: 0;
  max-width: 480px; margin: 0 auto;
  display: flex;
  min-height: 56px;
  background: var(--pb-color-canvas);
  border-top: 1px solid var(--pb-color-outline);
  padding-bottom: env(safe-area-inset-bottom, 0px);
  z-index: 20;
}
.pb-tab {
  flex: 1 1 0;
  display: flex; align-items: center; justify-content: center;
  min-height: 48px;
  position: relative;
  color: var(--pb-color-text-secondary);
}
.pb-tab--on { color: var(--pb-color-text-primary); }
.pb-tab--on::after {
  content: "";
  position: absolute;
  bottom: 6px; left: 50%;
  width: 24px; height: 2px;
  margin-left: -12px;
  border-radius: 1px;
  background: var(--pb-color-brand);
}

/* ---- 底部输入区（键盘上方 / 安全区感知；偏移由宿主注入） ---- */
.pb-composer {
  position: fixed;
  left: 0; right: 0;
  bottom: calc(56px + var(--pb-composer-offset, 0px) + env(safe-area-inset-bottom, 0px));
  max-width: 480px; margin: 0 auto;
  display: flex; align-items: flex-end; gap: 8px;
  padding: 8px 20px;
  background: var(--pb-color-canvas);
  border-top: 1px solid var(--pb-color-outline);
  z-index: 21;
}
.pb-attach {
  min-width: 48px; min-height: 48px;
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--pb-color-text-primary);
}
.pb-composer-field { position: relative; flex: 1 1 auto; display: flex; }
.pb-composer-input {
  width: 100%;
  min-height: 48px; max-height: 96px;
  resize: none;
  padding: 12px 16px;
  border: 1px solid var(--pb-color-outline);
  border-radius: 12px;
  background: var(--pb-color-input);
  color: var(--pb-color-text-primary);
  font: inherit;
}
.pb-composer-hint {
  position: absolute; left: 16px; top: 12px;
  pointer-events: none;
}
.pb-send {
  min-height: 48px; min-width: 72px;
  padding: 0 16px;
  border: 0; border-radius: 12px;
  background: var(--pb-color-action-primary);
  font: inherit;
}
.pb-send--stop { background: var(--pb-color-accent-surface); }
`;

/** 真机读回脚本：把**页面自己看到的内容**回报给宿主端点（渲染证据，不依赖截图）。 */
const RENDER_REPORT_SCRIPT = `
(function () {
  var SCREEN = __SCREEN__;
  var WIRED = __WIRED__;
  function label(selector) {
    return Array.prototype.map.call(document.querySelectorAll(selector), function (n) {
      return (n.textContent || '').trim();
    });
  }
  function report() {
    var composer = document.querySelector('.pb-composer');
    var composerBox = composer ? composer.getBoundingClientRect() : null;
    var offsetVar = getComputedStyle(document.body).getPropertyValue('--pb-composer-offset').trim();
    var payload = {
      composerOffsetVar: offsetVar,
      composerBottomPx: composerBox ? Math.round(window.innerHeight - composerBox.bottom) : null,
      composerHeightPx: composerBox ? Math.round(composerBox.height) : null,
      screen: SCREEN,
      wired: WIRED,
      title: document.title,
      tabs: label('.pb-tab-label'),
      selectedTabs: label('.pb-tab--on .pb-tab-label'),
      sections: label('.pb-section-title'),
      rows: label('.pb-row-title').concat(label('.pb-result-title')),
      hasComposer: document.querySelector('.pb-composer') !== null,
      underline: document.querySelectorAll('.pb-tab--on').length,
      bodyText: (document.body.innerText || document.body.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 4000),
      viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 },
      // 背景标签页的 innerWidth 会被浏览器置 0；screen.* 与标签页可见性无关。
      screenCss: { w: window.screen ? window.screen.width : 0, h: window.screen ? window.screen.height : 0 },
      ua: navigator.userAgent,
      at: new Date().toISOString()
    };
    try {
      fetch('/__render-report', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (e) { /* 读回是尽力而为，失败不影响页面 */ }
  }
  if (document.readyState === 'complete') report();
  else window.addEventListener('load', report);

  var input = document.getElementById('pb-composer-input');
  if (input) {
    var hint = document.querySelector('.pb-composer-hint');
    var sync = function () { if (hint) hint.style.display = input.value.length ? 'none' : ''; };
    input.addEventListener('input', sync);
    sync();
  }
})();
`;

/** 结构样式（导出供验收脚本/测试断言使用，不重复字符串）。 */
export const structuralCss = (): string => STRUCTURAL_CSS;

export interface DocumentOptions extends PageOptions {
  /** 额外注入的 `<meta>`（例如验收标记）；键值都会做属性转义。 */
  readonly extraMeta?: Readonly<Record<string, string>>;
}

/** 属性值转义（复用 render 层的严格转义规则）。 */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 生成一个屏幕的**完整 HTML 文档**。
 *
 * `--pb-composer-offset` = `max(底部安全区, 键盘高)`（由 `shell` 的 composer 模型算出），
 * 因此「输入区在键盘上方且避开手势区」这条约束在 HTML 里是**算出来的**，不是写死的。
 */
export function renderScreenDocument(screen: ScreenId, options: DocumentOptions): string {
  const def = screenDefOf(screen);
  const root = buildScreenPage(screen, options);
  const body = renderHtml(root);
  const offset = composerOffsetDp(options);
  const wired = isWiredScreen(screen);

  const meta: string[] = [
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />',
    `<meta name="pb-screen" content="${escapeAttr(screen)}" />`,
    `<meta name="pb-module" content="${escapeAttr(def.entry)}" />`,
    `<meta name="pb-data-source" content="${escapeAttr(FIXTURE_PROVENANCE.kind)}" />`,
    `<meta name="pb-kernel-connected" content="${FIXTURE_PROVENANCE.kernelConnected ? 'true' : 'false'}" />`,
  ];
  for (const [name, value] of Object.entries(options.extraMeta ?? {})) {
    meta.push(`<meta name="${escapeAttr(name)}" content="${escapeAttr(value)}" />`);
  }

  const script = RENDER_REPORT_SCRIPT.replace('__SCREEN__', JSON.stringify(screen)).replace(
    '__WIRED__',
    wired ? 'true' : 'false',
  );

  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    ...meta.map((line) => `  ${line}`),
    `  <title>potbot · ${def.title}</title>`,
    '  <link rel="stylesheet" href="/foundation.css" />',
    '  <style>',
    STRUCTURAL_CSS.replace(/\n$/, ''),
    '  </style>',
    '</head>',
    '<body class="pb-body" style="--pb-composer-offset: ' + `${String(offset)}px` + '">',
    body,
    '<script>',
    script.trim(),
    '</script>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** 同一棵视图树的**可访问性文本**序列化（`renderText`），供读屏/验收读回。 */
export function renderScreenText(screen: ScreenId, options: DocumentOptions): string {
  const def = screenDefOf(screen);
  const root = buildScreenPage(screen, options);
  return [
    `# potbot ${def.title}`,
    `screen=${screen} entry=${def.entry} data=${FIXTURE_PROVENANCE.kind} kernel=${FIXTURE_PROVENANCE.kernelConnected}`,
    '',
    renderText(root),
    '',
  ].join('\n');
}
