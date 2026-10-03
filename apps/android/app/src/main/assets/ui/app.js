/*
 * app.js —— Potbot 外壳（shell）。
 *
 * 职责（只做外壳，不画屏幕内容）：
 *   1. 建 chrome：顶栏 + #pb-root + 输入区 + 四入口底部导航（细橙下划线）；
 *   2. 路由：把选中屏交给 PB.screens[key].render(rootEl, ctx)（ctx 契约见下）；
 *   3. 防御：某屏模块缺失/抛错 → 该屏渲染诚实错误面板，外壳照常可用，绝不白屏；
 *   4. 键盘避让：visualViewport 驱动容器高度，输入区始终在软键盘之上。
 *
 * ⚠️ 必须用**经典脚本**（无 type="module"）：Android WebView 在 file:// 下
 *    禁止 ES module。本文件与各屏幕模块一律挂在全局 window.PB 上，不使用 import/export。
 *
 * 屏幕契约（由 screens/*.js 提供）：
 *   window.PB.screens.<key> = {
 *     title?: string,
 *     render(root: HTMLElement, ctx: {
 *       bridge,        // PB.bridge —— 内核命令桥（可用性由 PB.bridge.available 判定）
 *       host,          // PB.host   —— 原生 JSON 通道（默认后端访问路径）
 *       wordFlow,      // PB.wordFlow —— 一句话 → 真实 Word 文件
 *       navigate,      // (key) => void
 *       state          // PB.state —— 外壳状态（含 messages）
 *     }) => void
 *   }
 *
 * 后端访问一律走 PB.host（window.PotbotHost），不经 fetch/XHR：本页源为 "null"，
 * 电脑端后端不发 CORS 头。通道缺失时如实报错，不伪造成功。
 */
(function () {
  "use strict";

  var PB = (window.PB = window.PB || {});
  PB.screens = PB.screens || {};
  PB.version = PB.version || "v6-shell-2";

  /* ============================================================
   * 屏幕登记表：key → 中文名。前四个是底部导航入口。
   * ============================================================ */
  var SCREENS = [
    { key: "chat", title: "对话", tab: true },
    { key: "groups", title: "群组", tab: true },
    { key: "files", title: "文件", tab: true },
    { key: "me", title: "我的", tab: true },
    { key: "conversations", title: "全部对话", tab: false },
    { key: "decisions", title: "决策", tab: false },
    { key: "memory", title: "记忆", tab: false },
    { key: "templates", title: "模版", tab: false },
    { key: "food", title: "美团", tab: false },
    { key: "system-actions", title: "系统操作", tab: false }
  ];
  var KEYS = SCREENS.map(function (s) { return s.key; });
  var TABS = SCREENS.filter(function (s) { return s.tab; });
  function titleOf(key) {
    for (var i = 0; i < SCREENS.length; i++) if (SCREENS[i].key === key) return SCREENS[i].title;
    return key;
  }
  function isTab(key) {
    for (var i = 0; i < TABS.length; i++) if (TABS[i].key === key) return true;
    return false;
  }

  /* ============================================================
   * 状态（外壳唯一真源；屏幕模块经 ctx.state 读写）
   * ============================================================ */
  var state = {
    key: "chat",
    previousKey: null,
    messages: [],        // { id, role: 'user'|'bot'|'sys', text, at }
    submitting: false,
    lastError: null,
    booted: true,
    loadedScreens: [],   // 启动时 snapshot，供错误面板展示
    missingScreens: []
  };
  PB.state = state;
  PB.SCREENS = SCREENS.slice();

  /* ============================================================
   * 桥的兜底：bridge.js 未加载时也给外壳一个诚实的降级实现。
   * ============================================================ */
  function bridge() {
    if (PB.bridge && typeof PB.bridge.submit === "function") return PB.bridge;
    PB.bridge = {
      available: false,
      source: "shell-fallback",
      submit: function () {
        return { ok: false, error: { code: "KERNEL_CHANNEL_ABSENT", message: "本地处理通道不可用。" } };
      },
      subscribe: function () { return { unsubscribe: function () {} }; },
      cancel: function () { return false; }
    };
    return PB.bridge;
  }

  /** 后端访问通道（宿主原生 JSON 接口），由 host-api.js 提供。 */
  function hostApi() {
    return (PB.host && PB.host.available) ? PB.host : null;
  }

  /* ============================================================
   * DOM 骨架
   * ============================================================ */
  var app = document.getElementById("pb-app");
  var topbar = document.getElementById("pb-topbar");
  var titleEl = document.getElementById("pb-title");
  var rootEl = document.getElementById("pb-root");
  var composer = document.getElementById("pb-composer");
  var inputEl = document.getElementById("pb-input");
  var sendEl = document.getElementById("pb-send");
  var hintEl = document.getElementById("pb-composer-hint");
  var tabbar = document.getElementById("pb-tabbar");
  var toastEl = document.getElementById("pb-toast");

  var HOTPOT = [
    '<svg class="pb-brandmark" viewBox="0 0 48 48" role="img" aria-label="Potbot">',
    '<circle cx="24" cy="24" r="22" fill="#fff" stroke="#28231F" stroke-width="2.5"/>',
    '<path d="M12 21h24v7a9 9 0 0 1-9 9h-6a9 9 0 0 1-9-9z" fill="#28231F"/>',
    '<path d="M14 18h20" stroke="#28231F" stroke-width="3" stroke-linecap="round"/>',
    '<path d="M19 13c0-2 2-2 2-4M25 13c0-2 2-2 2-4" stroke="#28231F" stroke-width="2" ',
    'stroke-linecap="round" fill="none"/>',
    '<circle cx="18" cy="39" r="3" fill="none" stroke="#28231F" stroke-width="2"/>',
    '<circle cx="30" cy="39" r="3" fill="none" stroke="#28231F" stroke-width="2"/></svg>'
  ].join("");

  function el(tag, cls, attrs) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (attrs) for (var k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add("pb-show");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { toastEl.classList.remove("pb-show"); }, 2400);
  }
  PB.toast = toast;

  /* ============================================================
   * 顶栏 + 导航
   * ============================================================ */
  function renderTopbar() {
    topbar.innerHTML = "";
    if (isTab(state.key)) {
      topbar.insertAdjacentHTML("beforeend", HOTPOT);
      var wm = el("span", "pb-wordmark");
      wm.textContent = "potbot";
      topbar.appendChild(wm);
      var plus = el("button", "pb-iconbtn", { type: "button", "aria-label": "新建对话" });
      plus.textContent = "＋";
      plus.addEventListener("click", function () { navigate("chat"); });
      topbar.appendChild(plus);
    } else {
      var back = el("button", "pb-iconbtn", { type: "button", "aria-label": "返回" });
      back.textContent = "‹";
      back.addEventListener("click", function () {
        navigate(state.previousKey && state.previousKey !== state.key ? state.previousKey : "chat");
      });
      topbar.appendChild(back);
      titleEl.textContent = (PB.screens[state.key] && PB.screens[state.key].title) || titleOf(state.key);
      topbar.appendChild(titleEl);
    }
  }

  function renderTabbar() {
    tabbar.innerHTML = "";
    TABS.forEach(function (t) {
      var b = el("button", "pb-tab", { type: "button", "data-key": t.key });
      b.textContent = t.title;
      if (state.key === t.key) b.setAttribute("aria-current", "page");
      b.addEventListener("click", function () { navigate(t.key); });
      tabbar.appendChild(b);
    });
  }

  /* ============================================================
   * 降级面板：模块缺失 / 渲染抛错时**这一屏**的诚实说明
   * ============================================================ */
  function fallbackPanel(key, reason, err) {
    var box = el("div", "pb-fallback");
    var mod = PB.screens[key];
    var h = el("h2");
    h.textContent = mod ? "该页面渲染失败" : "该页面模块尚未加载";
    box.appendChild(h);

    var p1 = el("p");
    p1.innerHTML = "目标屏：<code>" + esc(key) + "</code>（" + esc(titleOf(key)) + "）";
    box.appendChild(p1);

    var p2 = el("p");
    p2.textContent = mod
      ? "模块已注册但 render 抛错，错误已隔离，外壳其余部分照常可用。" + (err ? " " + (err.message || err) : "")
      : "期望模块文件：screens/" + key + ".js —— 它要么尚未由对应 lane 写入，要么加载失败。";
    box.appendChild(p2);

    var p3 = el("p");
    p3.textContent = "已加载的屏：" + (state.loadedScreens.length ? state.loadedScreens.join("、") : "（无）");
    box.appendChild(p3);

    if (state.missingScreens.length) {
      var wrap = el("div", "pb-misslist");
      state.missingScreens.forEach(function (k) {
        var s = el("span");
        s.textContent = k;
        wrap.appendChild(s);
      });
      box.appendChild(wrap);
    }
    return box;
  }

  /* ============================================================
   * 路由
   * ============================================================ */
  function navigate(key) {
    if (typeof key !== "string" || !key) return;
    if (KEYS.indexOf(key) === -1) { toast("未知页面：" + key); return; }
    if (key === state.key) { render(); return; }
    state.previousKey = state.key;
    state.key = key;
    render();
  }
  PB.navigate = navigate;

  /* ctx：屏幕模块的唯一接口面 */
  function makeCtx() {
    return {
      bridge: bridge(),
      host: PB.host || null,
      wordFlow: PB.wordFlow || null,
      navigate: navigate,
      state: state
    };
  }
  PB.ctx = makeCtx;

  function render() {
    renderTopbar();
    renderTabbar();

    rootEl.innerHTML = "";
    var mod = PB.screens[state.key];
    /* 每次渲染前重置“屏幕自持输入区”标记 */
    state.screenOwnsComposer = false;

    if (mod && typeof mod.render === "function") {
      try {
        mod.render(rootEl, makeCtx());
      } catch (err) {
        /* 单屏失败被隔离：外壳、导航、状态行继续工作 */
        state.lastError = String((err && err.message) || err);
        rootEl.innerHTML = "";
        rootEl.appendChild(fallbackPanel(state.key, "throw", err));
        if (window.console && console.error) console.error("[PB] screen render failed:", state.key, err);
      }
    } else {
      rootEl.appendChild(fallbackPanel(state.key, "missing"));
    }

    renderComposer();
    rootEl.scrollTop = 0;
  }
  PB.render = render;

  /* ============================================================
   * 输入区：只在 chat 屏出现；若该屏自带了输入控件则让位，避免重复输入框
   * ============================================================ */
  var SEL_OWN_INPUT = "[data-pb-composer], textarea, input[type='text'], input[type='search']";
  function renderComposer() {
    var show = state.key === "chat";
    if (show && rootEl.querySelector(SEL_OWN_INPUT)) show = false;   // 屏幕自带输入区
    composer.hidden = !show;
    if (!show) return;
    hintEl.textContent = hostApi()
      ? "说出你的目标，我来把它做成文件"
      : "当前没有连接到电脑端服务，暂时无法生成文件";
  }

  /* ============================================================
   * 提交：一句话 → 真实 Word 文件（走 PB.wordFlow，即宿主原生 JSON 通道）
   *
   * 说明：对话屏（screens/chat.js）自带输入区，正常情况下由它接管提交；
   * 这里的路径是**单屏渲染失败时的兜底**，行为与对话屏一致：只用真实结果说话，
   * 通道缺失时如实报错，绝不伪造成功。
   * ============================================================ */
  function newId() {
    return "ui-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }
  function pushMessage(role, text) {
    var m = { id: newId(), role: role, text: String(text), at: Date.now() };
    state.messages.push(m);
    return m;
  }
  PB.pushMessage = pushMessage;
  PB.messages = state.messages;

  function submit(text) {
    if (state.submitting) return;
    if (!PB.wordFlow || typeof PB.wordFlow.start !== "function") {
      toast("当前环境无法提交任务。");
      return;
    }
    state.submitting = true;
    sendEl.disabled = true;
    pushMessage("user", text);

    PB.wordFlow.start(text, {
      onProgress: function (step) {
        if (step && step.status === "ready") return;
        toast((step && step.text) || "正在处理");
      },
      onDone: function (artifact) {
        state.submitting = false;
        sendEl.disabled = false;
        pushMessage("bot", "已生成 " + artifact.filename +
          (artifact.sizeText ? "（" + artifact.sizeText + "）" : "") + "，可在对话页打开。");
        toast("已生成：" + artifact.filename);
        render();
      },
      onError: function (err) {
        state.submitting = false;
        sendEl.disabled = false;
        pushMessage("sys", "未能生成文件 · " + ((err && err.message) || "未知原因"));
        toast((err && err.message) || "生成失败");
        render();
      }
    });
  }
  PB.submit = submit;

  /* ============================================================
   * 键盘避让：visualViewport 变化 → 容器高度跟随 → 输入区始终在键盘之上
   * ============================================================ */
  function applyViewport() {
    var vv = window.visualViewport;
    if (!vv) return;
    var shrunk = (window.innerHeight - vv.height) > 120;
    app.style.height = vv.height + "px";
    app.classList.toggle("pb-keyboard", shrunk);
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", applyViewport);
    window.visualViewport.addEventListener("scroll", applyViewport);
    applyViewport();
  }

  /* ============================================================
   * 启动
   * ============================================================ */
  function boot() {
    /* 记录哪些屏模块真的加载成功（供错误面板如实展示，不猜不编） */
    state.loadedScreens = KEYS.filter(function (k) {
      return PB.screens[k] && typeof PB.screens[k].render === "function";
    });
    state.missingScreens = KEYS.filter(function (k) {
      return state.loadedScreens.indexOf(k) === -1;
    });

    bridge();            // 确保 PB.bridge 存在（缺则装诚实降级实现）

    /* 输入区事件 */
    if (inputEl) {
      inputEl.addEventListener("input", function () {
        inputEl.style.height = "auto";
        inputEl.style.height = Math.min(inputEl.scrollHeight, 72) + "px";
        sendEl.disabled = !inputEl.value.trim() || state.submitting;
      });
    }
    if (composer) {
      composer.addEventListener("submit", function (e) {
        e.preventDefault();
        var v = inputEl.value.trim();
        if (!v || state.submitting) return;
        inputEl.value = "";
        inputEl.style.height = "auto";
        sendEl.disabled = true;
        submit(v);
      });
    }

    /* 宿主可能晚于本脚本注入：稍后再探测一次原生通道，刷新提示文案 */
    setTimeout(function () {
      if (PB.host && typeof PB.host.detect === "function") {
        try { PB.host.detect(); } catch (e) {}
      }
      renderComposer();
    }, 600);

    render();
    if (window.console && console.info) {
      console.info("[PB] shell booted. loaded=" + state.loadedScreens.join(",") +
        " missing=" + (state.missingScreens.join(",") || "none"));
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
