/*
 * decisions.js —— Potbot v6 手机界面：决策（确认 / 回执 / 状态语义）+ 美团（外卖）能力状态屏。
 *
 * ⚠️ Android WebView 在 file:// 下禁止 ES module 与本地 fetch：本文件是**经典脚本**，
 *    不使用 import/export、type="module"、XMLHttpRequest、CDN 或任何网络调用。
 *    后端访问**只经** window.PB.host（host-api.js 封装的宿主原生 JSON 通道）。
 *
 * 注册两个屏（同一文件）：
 *   window.PB.screens.decisions —— 决策：真实待确认动作 / 回执 / 状态词表（全部读实时后端）
 *   window.PB.screens.food      —— 美团：能力状态读数（**不**显示任何编造的门店 / 订单）
 *
 * ── 这一版为什么这样写（都是实测后钉住的边界）──────────────────────────────
 * 1) 「对话事件流不含决策气泡」：实测
 *    GET /api/conversations/<cid>/events 的每条事件只有
 *    {seq,eventId,at,kind,messageId,state,phase,text,detail}，**没有** bubble/decision 字段。
 *    因此 **不**从对话事件里"找"待确认气泡——那只能是编造。
 * 2) 待确认动作的**真实来源**是动作台账（Store.actions）：
 *    GET  /api/adapters/actions                        → {ok, actions:[ActionRecord]}
 *    POST /api/adapters/actions/<id>/executable        → {ok, executable, expired, terminal,
 *                                                          authorizationRevoked, currentTaskRevision}
 *    POST /api/conversation-loop/bubbles/click         → {verdict, clicked_bubble_id, root}
 *        （CHAT-07 点击判定：重复/过期/改参数/已交接，全部如实返回）
 *    POST /api/adapters/actions/<id>/transition        → {ok, action}
 *    POST /api/adapters/actions/<id>/execute           → 受控执行器（唯一可信回执来源）
 *    GET  /api/adapters/actions/vocabulary             → {ok, kernelVocabulary, adapterVocabulary}
 *    台账为空时**如实显示为空**，绝不补示例卡。
 * 3) 美团外卖：产品路径**未注入任何已授权端口**，实测
 *    POST /api/adapters/extra/meituan/query  → 503 {ok:false, code:'meituan_candidate_query_not_ready',
 *        stub:true, realExecutor:false, candidates:[], model_fabricated:false, unblockedBy:...}
 *    GET  /api/adapters/readiness            → 逐子项 verdict/reason/unblockedBy（真实）
 *    → 本屏只显示"能力未接通"与后端原话，**不**显示任何门店 / 菜单 / 购物车 / 地址 / 订单。
 *
 * ── 诚实边界（写死在本文件）───────────────────────────────────────────────
 * - 不信任何前端自造的"成功"。确认走真实 bubbles/click 判定；执行走真实 execute。
 * - 只有 state==='confirmed_complete' 且 receipt.trusted===true 才可称完成；
 *   handed_off / submitted / result_unknown / user_reported_complete **都不等于完成**。
 * - 后端不可达时显示真实错误；加载 / 空 / 错误 / 未知 都是必渲染态，不是可选项。
 */

(function () {
  "use strict";

  var PB = (window.PB = window.PB || {});
  PB.screens = PB.screens || {};

  // ------------------------------------------------------------------
  // 词汇（与 kernels 词表一致；最终以实时 vocabulary 接口为准）
  // ------------------------------------------------------------------
  // src/workledger/action-ledger.ts ACTION_STATE_LABELS（七态，严格区分，不合并）
  var STATE_LABEL = {
    prepared: "已准备",
    handed_off: "已交接",
    submitted: "已提交",
    confirmed_complete: "已确认完成",
    result_unknown: "结果未知",
    user_reported_complete: "用户报告完成",
    invalidated_or_failed: "已失效或失败"
  };
  var TERMINAL_STATE = { confirmed_complete: true, invalidated_or_failed: true };
  // 只有可信回执确认的这一个算"成功"（R242）
  var SUCCESS_STATE = "confirmed_complete";

  function stateKind(state) {
    if (state === "confirmed_complete") return "confirmed";
    if (state === "invalidated_or_failed") return "rejected";
    if (state === "result_unknown") return "unknown";
    if (state === "prepared") return "pending";
    return "muted";
  }

  // ------------------------------------------------------------------
  // 小工具
  // ------------------------------------------------------------------
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function fmtClock(ms) {
    var d = new Date(ms);
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
  }
  function shortDigest(d, n) {
    if (typeof d !== "string" || !d) return "—";
    var k = n || 16;
    return d.length > k ? d.slice(0, k) + "…" : d;
  }
  function asInt(v) { return typeof v === "number" && isFinite(v) ? v : null; }

  function chip(text, kind) {
    return "<span class=\"pbx-chip pbx-chip--" + esc(kind || "muted") + "\">" + esc(text) + "</span>";
  }
  function kv(label, valueHtml, cls) {
    return "<div class=\"pbx-kv " + (cls || "") + "\"><span class=\"pbx-kv-k\">" + esc(label) +
      "</span><span class=\"pbx-kv-v\">" + valueHtml + "</span></div>";
  }
  function btn(label, act, arg, cls, aria) {
    return "<button type=\"button\" class=\"pbx-btn " + (cls || "") + "\" data-act=\"" + esc(act) + "\"" +
      (arg != null ? " data-arg=\"" + esc(arg) + "\"" : "") +
      (aria ? " aria-label=\"" + esc(aria) + "\"" : "") + ">" + label + "</button>";
  }
  function mono(text) { return "<span class=\"pbx-mono\">" + esc(text) + "</span>"; }
  function toast(msg) { if (typeof PB.toast === "function") PB.toast(msg); }

  // ------------------------------------------------------------------
  // 样式（一次注入；全部选择器以 .pbx 前缀限定）
  // ------------------------------------------------------------------
  var STYLE_ID = "pbx-decisions-style";
  var CSS = [
    ".pbx{color:var(--pb-color-text-primary,#28231F);font-size:15px;line-height:22px;padding-bottom:8px}",
    ".pbx h2{font-size:17px;margin:0}", ".pbx h3{font-size:15px;margin:0}",
    ".pbx-seg{display:flex;gap:2px;overflow-x:auto;-webkit-overflow-scrolling:touch;border-bottom:1px solid var(--pb-color-outline,#E8E4DF);margin:2px 0 14px}",
    ".pbx-seg::-webkit-scrollbar{display:none}",
    ".pbx-seg-btn{flex:none;min-height:48px;padding:0 13px;background:none;border:0;font:inherit;font-size:14px;color:var(--pb-color-text-secondary,#77716B);position:relative;white-space:nowrap}",
    ".pbx-seg-btn[aria-selected=\"true\"]{color:var(--pb-color-accent-text,#825034);font-weight:600}",
    ".pbx-seg-btn[aria-selected=\"true\"]::after{content:\"\";position:absolute;left:8px;right:8px;bottom:0;height:2px;border-radius:1px;background:var(--pb-color-brand,#E9A66D)}",
    ".pbx-card{border:1px solid var(--pb-color-outline,#E8E4DF);border-radius:16px;padding:14px;margin-bottom:14px;background:var(--pb-color-surface,#fff)}",
    ".pbx-card.is-pending{border-color:#F0D9C2;box-shadow:inset 3px 0 0 var(--pb-color-brand,#E9A66D)}",
    ".pbx-card.is-invalid{background:var(--pb-color-input,#FAFAF9);border-style:dashed}",
    ".pbx-cardhead{display:flex;align-items:flex-start;gap:8px;margin-bottom:6px}",
    ".pbx-grow{flex:1;min-width:0}",
    ".pbx-kicker{font-size:12px;color:var(--pb-color-text-secondary,#77716B);margin-bottom:2px}",
    ".pbx-title{font-size:16px;font-weight:600;word-break:break-word}",
    ".pbx-chip{display:inline-block;font-size:12px;line-height:18px;padding:1px 9px;border-radius:999px;white-space:nowrap}",
    ".pbx-chip--pending{background:var(--pb-color-accent-surface,#FFF0E2);color:var(--pb-color-accent-text,#825034)}",
    ".pbx-chip--confirmed{background:#EDF6F0;color:var(--pb-color-success,#306A4B)}",
    ".pbx-chip--rejected{background:#FBEDEB;color:var(--pb-color-danger,#A73729)}",
    ".pbx-chip--unknown{background:#FBF3E4;color:#8A6413}",
    ".pbx-chip--invalid{background:#F1EFEC;color:var(--pb-color-text-secondary,#77716B)}",
    ".pbx-chip--muted{background:#F1EFEC;color:var(--pb-color-text-secondary,#77716B)}",
    ".pbx-kv{display:flex;gap:10px;padding:7px 0;border-top:1px solid #F1EFEC;font-size:14px}",
    ".pbx-kv:first-child{border-top:0}",
    ".pbx-kv-k{flex:0 0 78px;color:var(--pb-color-text-secondary,#77716B)}",
    ".pbx-kv-v{flex:1;min-width:0;word-break:break-word}",
    ".pbx-kv--field .pbx-kv-v{font-weight:500}",
    ".pbx-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;word-break:break-all;color:var(--pb-color-text-primary,#28231F)}",
    ".pbx-missing{color:var(--pb-color-danger,#A73729);font-weight:500}",
    ".pbx-note{font-size:12px;line-height:18px;color:var(--pb-color-text-secondary,#77716B);margin:8px 0 0}",
    ".pbx-warn{font-size:13px;line-height:19px;background:#FBF3E4;color:#8A6413;border-radius:10px;padding:8px 10px;margin:9px 0 0}",
    ".pbx-dangerbox{font-size:13px;line-height:19px;background:#FBEDEB;color:var(--pb-color-danger,#A73729);border-radius:10px;padding:8px 10px;margin:9px 0 0}",
    ".pbx-okbox{font-size:13px;line-height:19px;background:#EDF6F0;color:var(--pb-color-success,#306A4B);border-radius:10px;padding:8px 10px;margin:9px 0 0}",
    ".pbx-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}",
    ".pbx-btn{min-height:48px;padding:0 15px;border-radius:12px;border:1px solid transparent;font:inherit;font-size:15px;font-weight:500;background:none;color:var(--pb-color-text-primary,#28231F);flex:1 1 auto}",
    ".pbx-btn.primary{background:var(--pb-color-action-primary,#E9A66D);color:var(--pb-color-action-foreground,#241A14);font-weight:600}",
    ".pbx-btn.secondary{background:var(--pb-color-surface,#fff);border-color:var(--pb-color-outline,#E8E4DF)}",
    ".pbx-btn.danger{background:var(--pb-color-surface,#fff);border-color:#E7C6C0;color:var(--pb-color-danger,#A73729)}",
    ".pbx-btn.ghost{background:none;border:0;color:var(--pb-color-accent-text,#825034);flex:0 0 auto;padding:0 8px;text-decoration:underline;min-height:48px}",
    ".pbx-btn.block{flex-basis:100%}",
    ".pbx-btn[disabled]{opacity:.45}",
    ".pbx-mod{background:var(--pb-color-input,#FAFAF9);border:1px dashed var(--pb-color-outline,#E8E4DF);border-radius:12px;padding:10px;margin-top:10px}",
    ".pbx-mod-title{font-size:13px;font-weight:600;margin-bottom:6px}",
    ".pbx-steps{list-style:none;margin:10px 0 0;padding:0}",
    ".pbx-step{display:flex;gap:10px;padding:6px 0}",
    ".pbx-step-dot{width:12px;height:12px;border-radius:50%;flex:none;margin-top:5px;background:#E1DDD8}",
    ".pbx-step.done .pbx-step-dot{background:var(--pb-color-brand,#E9A66D)}",
    ".pbx-step.current .pbx-step-dot{background:var(--pb-color-accent-text,#825034);box-shadow:0 0 0 4px var(--pb-color-accent-surface,#FFF0E2)}",
    ".pbx-step.unknown .pbx-step-dot{background:#C6A24A}",
    ".pbx-step.failed .pbx-step-dot{background:var(--pb-color-danger,#A73729)}",
    ".pbx-step-label{font-size:14px;font-weight:500}",
    ".pbx-step-note{font-size:12px;color:var(--pb-color-text-secondary,#77716B)}",
    ".pbx-empty{border:1px dashed var(--pb-color-outline,#E8E4DF);border-radius:14px;padding:20px 14px;text-align:center;color:var(--pb-color-text-secondary,#77716B);font-size:14px;margin-bottom:12px}",
    ".pbx-strong{font-weight:600}",
    ".pbx-tabintro{font-size:13px;color:var(--pb-color-text-secondary,#77716B);margin:0 0 12px}",
    ".pbx-reflist{list-style:none;margin:0;padding:0}",
    ".pbx-refrow{display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-top:1px solid #F1EFEC;font-size:13px}",
    ".pbx-refrow:first-child{border-top:0}",
    ".pbx-refname{flex:0 0 108px}",
    ".pbx-sep{height:1px;background:#F1EFEC;margin:10px 0}",
    ".pbx-badge{display:inline-block;font-size:11px;padding:1px 7px;border-radius:999px;background:var(--pb-color-accent-surface,#FFF0E2);color:var(--pb-color-accent-text,#825034);margin-left:6px;vertical-align:1px}"
  ].join("\n");

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  // ------------------------------------------------------------------
  // 宿主通道包装：**只**经 PB.host；缺失 / 失败如实返回，不伪造成功。
  //   返回 { ok, data, error:{code,message} }
  // host-api 的坑：后端把 {code,message} 直接放顶层时它可能把整包当 ok:true，
  // 所以调用方必须**同时**校验 data 的形状（下面每个消费点都做了）。
  // ------------------------------------------------------------------
  function hostReady(ctx) {
    return !!(ctx && ctx.host && ctx.host.available && typeof ctx.host.get === "function");
  }
  function hostAbsent() {
    return { ok: false, data: null, error: { code: "host_absent", message: "当前环境没有可用的本地服务通道（PB.host 不可用）。" } };
  }
  // res.data 里带 {code,message} 且没有本端点应有的成功字段 ⇒ 判为业务错误，不当作正常数据。
  function bizError(data, successKeys) {
    if (!data || typeof data !== "object") return null;
    if (typeof data.code !== "string" || data.ok === true) return null;
    for (var i = 0; i < successKeys.length; i++) {
      if (data[successKeys[i]] !== undefined) return null;
    }
    return { code: data.code, message: typeof data.message === "string" ? data.message : data.code };
  }
  function hostGet(ctx, path, successKeys) {
    if (!hostReady(ctx)) return Promise.resolve(hostAbsent());
    return Promise.resolve(ctx.host.get(path)).then(function (r) {
      var out = { ok: !!(r && r.ok), data: r ? r.data : null, error: r ? r.error : null };
      var be = bizError(out.data, successKeys || []);
      if (be) { out.ok = false; out.error = be; }
      return out;
    }, function (e) {
      return { ok: false, data: null, error: { code: "host_threw", message: String((e && e.message) || e) } };
    });
  }
  function hostPost(ctx, path, body, successKeys) {
    if (!hostReady(ctx)) return Promise.resolve(hostAbsent());
    return Promise.resolve(ctx.host.post(path, body)).then(function (r) {
      var out = { ok: !!(r && r.ok), data: r ? r.data : null, error: r ? r.error : null };
      var be = bizError(out.data, successKeys || []);
      if (be) { out.ok = false; out.error = be; }
      return out;
    }, function (e) {
      return { ok: false, data: null, error: { code: "host_threw", message: String((e && e.message) || e) } };
    });
  }
  function errText(r) {
    if (r && r.error && r.error.message) return r.error.message;
    if (r && r.data && typeof r.data.message === "string") return r.data.message;
    if (r && r.error && r.error.code) return r.error.code;
    return "本地服务没有接受这次请求。";
  }
  function errCode(r) {
    if (r && r.error && r.error.code) return r.error.code;
    if (r && r.data && typeof r.data.code === "string") return r.data.code;
    return "unknown_error";
  }

  // 延迟执行，让浏览器先绘制（原生调用最多阻塞 ~10s，绝不连环紧调用）。
  function later(fn) { setTimeout(fn, 0); }

  // ==================================================================
  // 决策屏
  // ==================================================================
  var DEC = {
    tab: "pending",
    loading: false,
    actions: { mode: "idle", list: [], error: null },   // GET /api/adapters/actions
    vocab: { mode: "idle", list: [], mapping: [], note: "", error: null },
    eventsProbe: { mode: "idle", conversationId: null, count: 0, hasBubble: false, error: null },
    exec: {},              // actionId -> { mode, data, error }（executable 端点）
    execQueue: [],
    busy: null,            // 正在处理的 actionId
    verdict: null,         // { actionId, res } bubbles/click 真实判定
    actResult: null,       // { kind:'transition'|'execute', actionId, ok, text, data }
    modifyOpen: null
  };

  function decSegs() {
    return [
      ["pending", "待确认"],
      ["receipt", "回执 / 台账"],
      ["states", "状态语义"]
    ];
  }

  function decPendingList() {
    return DEC.actions.list.filter(function (a) { return a && a.state === "prepared"; });
  }
  function decAwaitList() {
    return DEC.actions.list.filter(function (a) {
      return a && (a.state === "handed_off" || a.state === "submitted" ||
        a.state === "result_unknown" || a.state === "user_reported_complete");
    });
  }
  function decDoneList() {
    return DEC.actions.list.filter(function (a) { return a && (a.state === "confirmed_complete" || a.state === "invalidated_or_failed"); });
  }

  function actionTitle(a) {
    return a.action_kind || (a.action_id ? String(a.action_id) : "动作");
  }

  function ledgerStateBox() {
    if (DEC.actions.mode === "loading" || DEC.actions.mode === "idle") {
      return "<div class=\"pbx-empty\">正在从本地服务读取动作台账（/api/adapters/actions）…</div>";
    }
    if (DEC.actions.mode === "error") {
      return "<div class=\"pbx-card is-invalid\"><div class=\"pbx-kicker\">读取失败 · " + esc(errCode(DEC.actions)) + "</div>" +
        "<div class=\"pbx-dangerbox\">" + esc(DEC.actions.error || "未知错误") + "</div>" +
        "<div class=\"pbx-actions\">" + btn("重试读取", "dec-reload", null, "secondary") + "</div></div>";
    }
    // ready：给出刷新入口，便于看到刚创建的真实动作（不自动轮询，避免紧调用）
    return "<div class=\"pbx-actions\" style=\"margin:0 0 12px\">" +
      btn("刷新台账", "dec-reload", null, "ghost") + "</div>";
  }

  function execBox(a) {
    var e = DEC.exec[a.action_id];
    if (!e || e.mode === "loading") return "<div class=\"pbx-note\">正在读取可执行状态（/executable）…</div>";
    if (e.mode === "error") return "<div class=\"pbx-warn\">可执行状态读取失败：" + esc(e.error) + "</div>";
    var d = e.data || {};
    var rows = "";
    rows += kv("当前任务版本", "r" + esc(String(asInt(d.currentTaskRevision) == null ? "未知" : d.currentTaskRevision)) +
      " / 动作绑定 r" + esc(String(asInt(d.actionTaskRevision) == null ? "?" : d.actionTaskRevision)));
    rows += kv("是否可执行", d.executable === true ? "<span class=\"pbx-strong\">可执行</span>" :
      "<span class=\"pbx-missing\">不可执行</span>");
    rows += kv("是否已过期", d.expired === true ? "<span class=\"pbx-missing\">已过期（R213）</span>" : "否");
    rows += kv("是否终态", d.terminal === true ? "是（不得再改）" : "否");
    rows += kv("授权是否撤销", d.authorizationRevoked === true ? "<span class=\"pbx-missing\">已撤销（R244）</span>" : "否");
    return rows;
  }

  function actionCardHtml(a) {
    var isPending = a.state === "prepared";
    var ch = chip(STATE_LABEL[a.state] || a.state, stateKind(a.state));
    var out = "<section class=\"pbx-card " + (isPending ? "is-pending" : "") + "\" aria-label=\"动作：" + esc(actionTitle(a)) + "\">";
    out += "<div class=\"pbx-cardhead\"><div class=\"pbx-grow\">" +
      "<div class=\"pbx-kicker\">动作确认 · 记录 r" + esc(String(a.revision)) + " · 任务版本 r" + esc(String(a.task_revision)) + "</div>" +
      "<div class=\"pbx-title\">" + esc(actionTitle(a)) + "</div></div>" + ch + "</div>";

    out += kv("动作 ID", mono(String(a.action_id)), "pbx-kv--field");
    out += kv("任务", mono(String(a.task_id)));
    out += kv("参数摘要", mono(String(a.param_digest)), "pbx-kv--field");
    out += kv("幂等键", mono(shortDigest(a.idempotency_key, 24)));
    var az = a.authorization || {};
    out += kv("授权来源", esc(String(az.source == null ? "—" : az.source)));
    out += kv("用户显式批准", az.user_approved === true ? "是" : "<span class=\"pbx-missing\">否</span>");
    out += kv("授权主体", az.subject_instance_id == null ? "无（不限主体）" : mono(String(az.subject_instance_id)));

    if (isPending) out += execBox(a);

    if (Array.isArray(a.side_effects) && a.side_effects.length) {
      out += "<div class=\"pbx-note\" style=\"margin-top:8px\">已发生副作用 " + a.side_effects.length +
        " 项（reverted 恒为 false，不得假称撤销）：</div>";
      for (var i = 0; i < a.side_effects.length; i++) {
        out += kv("副作用", esc(a.side_effects[i].description || a.side_effects[i].effect_id));
      }
    }

    if (a.invalidated_reason) out += "<div class=\"pbx-warn\">失效原因：" + esc(a.invalidated_reason) + "</div>";
    if (a.superseded_by_action_id) out += "<div class=\"pbx-note\">已被新动作取代：" + mono(String(a.superseded_by_action_id)) + "</div>";
    if (a.receipt) {
      out += "<div class=\"" + (a.receipt.trusted === true ? "pbx-okbox" : "pbx-warn") + "\">" +
        "回执：trusted=" + (a.receipt.trusted === true ? "true" : "false") +
        " · 来源 " + esc(String(a.receipt.source)) + (a.receipt.detail ? " · " + esc(a.receipt.detail) : "") + "</div>";
    }

    if (isPending) {
      out += "<div class=\"pbx-actions\">" +
        btn("确认并提交", "dec-confirm", a.action_id, "primary", "确认并提交：" + actionTitle(a)) +
        btn("拒绝", "dec-reject", a.action_id, "danger", "拒绝：" + actionTitle(a)) +
        btn("修改", "dec-modify", a.action_id, "secondary", "修改：" + actionTitle(a)) +
        "</div>";
      if (DEC.modifyOpen === a.action_id) {
        out += "<div class=\"pbx-mod\"><div class=\"pbx-mod-title\">修改 = 用新参数创建新动作（不原地改）</div>" +
          "<div class=\"pbx-note\" style=\"margin-top:0\">参数一变，param_digest 就变 ⇒ 这是**另一个动作**（新的幂等键）。" +
          "正确做法是 <b>POST /api/adapters/actions</b> 以新 params 建新动作；旧动作若任务版本已推进则自动过期（R213）。" +
          "本屏**不**提供「原地改价 / 换门店」的假按钮——那需要真实的目录与报价来源，当前未接通。</div>" +
          btn("收起", "dec-modify", a.action_id, "ghost") + "</div>";
      }
    }
    out += "</section>";
    return out;
  }

  function verdictBox() {
    if (!DEC.verdict) return "";
    var v = DEC.verdict;
    var r = v.res || {};
    var d = r.data || {};
    var verdict = d.verdict || null;
    var s = "<section class=\"pbx-card is-pending\"><div class=\"pbx-cardhead\"><div class=\"pbx-grow\">" +
      "<div class=\"pbx-kicker\">点击判定结果 · bubbles/click（CHAT-07）</div>" +
      "<div class=\"pbx-title\">动作 " + esc(shortDigest(v.actionId, 20)) + "</div></div>";
    if (!r.ok || !verdict) {
      s += chip("判定失败", "rejected") + "</div>";
      s += "<div class=\"pbx-dangerbox\">" + esc(errText(r)) + "</div></div>";
      return s + "</section>";
    }
    s += chip(verdict.ok ? "可执行" : "不可执行", verdict.ok ? "confirmed" : "rejected") + "</div>";
    s += kv("结论", esc(verdict.message || ""));
    if (verdict.reason) s += kv("拒因", mono(String(verdict.reason)));
    s += kv("是否重复点击", verdict.duplicate === true ? "是（不得再执行，R243）" : "否");
    s += kv("展示状态", esc(verdict.displayed_label || verdict.displayed_state || "—"));
    s += kv("可称完成", verdict.completed === true ? "是" : "否");
    s += kv("等待回执", verdict.awaiting_receipt === true ? "是（已交接 / 已提交 ≠ 完成）" : "否");
    if (verdict.ok === true) {
      s += "<div class=\"pbx-note\">判定通过只表示「这次点击可执行」，**尚未发生外部动作**。执行要走受控执行器。</div>";
      s += "<div class=\"pbx-actions\">" + btn("执行（受控执行器）", "dec-execute", v.actionId, "primary") + "</div>";
    } else {
      s += "<div class=\"pbx-warn\">判定未通过：不执行、不新建动作；按上面拒因处理（过期须重建气泡，重复不得再点）。</div>";
    }
    s += "</section>";
    return s;
  }

  function actResultBox() {
    if (!DEC.actResult) return "";
    var a = DEC.actResult;
    var t = a.kind === "execute" ? "受控执行（/execute）" : "状态推进（/transition）";
    var box = a.ok ? "pbx-okbox" : "pbx-dangerbox";
    var s = "<section class=\"pbx-card\"><div class=\"pbx-kicker\">" + esc(t) + "</div>";
    s += "<div class=\"" + box + "\">" + esc(a.text) + "</div>";
    if (a.ok && a.data && a.data.action) {
      var rec = a.data.action;
      s += kv("新状态", chip(STATE_LABEL[rec.state] || rec.state, stateKind(rec.state)));
      s += kv("记录版本", "r" + esc(String(rec.revision)));
    }
    s += "</section>";
    return s;
  }

  function decPendingBody() {
    var s = "<p class=\"pbx-tabintro\">待确认动作<b>只</b>来自本机动作台账（Store.actions）的真实记录。" +
      "实测对话事件流（/api/conversations/&lt;id&gt;/events）<b>不含</b>决策气泡字段，故本屏不从对话里「找」气泡。</p>";
    s += ledgerStateBox();
    if (DEC.actions.mode === "ready") {
      var pend = decPendingList();
      if (!pend.length) {
        s += "<div class=\"pbx-empty\">当前没有待确认的真实动作（台账里 prepared 数量为 0）。" +
          "确认 / 拒绝只在有真实动作记录时才出现——本屏不补示例卡。</div>";
      } else {
        for (var i = 0; i < pend.length; i++) s += actionCardHtml(pend[i]);
      }
      s += verdictBox();
      s += actResultBox();
    }
    return s;
  }

  function decReceiptBody() {
    var s = "<p class=\"pbx-tabintro\">" + "台账里的非终态 / 终态动作。" +
      "「已交接」「已提交」「结果未知」「用户报告完成」<b>都不等于完成</b>；" +
      "只有 state=confirmed_complete 且 receipt.trusted=true 才可称完成。</p>";
    s += ledgerStateBox();
    if (DEC.actions.mode === "ready") {
      var await_ = decAwaitList();
      var done = decDoneList();
      if (!await_.length && !done.length) {
        s += "<div class=\"pbx-empty\">台账里暂无已提交 / 已终态的动作。</div>";
      }
      if (await_.length) {
        s += "<div class=\"pbx-kicker\" style=\"margin:4px 0 8px\">进行中 / 待回执（不得标完成）</div>";
        for (var i = 0; i < await_.length; i++) s += actionCardHtml(await_[i]);
      }
      if (done.length) {
        s += "<div class=\"pbx-kicker\" style=\"margin:4px 0 8px\">终态（历史保留，不得改写）</div>";
        for (var j = 0; j < done.length; j++) s += actionCardHtml(done[j]);
      }
    }
    return s;
  }

  function decStatesBody() {
    var s = "<p class=\"pbx-tabintro\">七态词表与允许的下一步，实时取自 <code>GET /api/adapters/actions/vocabulary</code>；" +
      "最终以接口返回为准。</p>";
    if (DEC.vocab.mode === "idle" || DEC.vocab.mode === "loading") {
      s += "<div class=\"pbx-empty\">正在读取状态词表…</div>";
      return s;
    }
    if (DEC.vocab.mode === "error") {
      s += "<div class=\"pbx-card is-invalid\"><div class=\"pbx-dangerbox\">词表读取失败：" + esc(DEC.vocab.error) + "</div>" +
        "<div class=\"pbx-actions\">" + btn("重试", "dec-reload", null, "secondary") + "</div></div>";
      return s;
    }
    s += "<section class=\"pbx-card\"><div class=\"pbx-kicker\" style=\"margin-bottom:6px\">内核七态（真实接口返回）</div>" +
      "<ul class=\"pbx-reflist\">";
    for (var i = 0; i < DEC.vocab.list.length; i++) {
      var row = DEC.vocab.list[i] || {};
      var nextLabels = [];
      for (var j = 0; j < (row.allowedNext || []).length; j++) {
        nextLabels.push(STATE_LABEL[row.allowedNext[j]] || row.allowedNext[j]);
      }
      s += "<li class=\"pbx-refrow\"><span class=\"pbx-refname\">" + chip(row.label || row.id, stateKind(row.id)) + "</span>" +
        "<span class=\"pbx-grow\">" + (row.terminal ? "终态（不再前进）" : "可转：" + esc(nextLabels.join(" / ") || "（无）")) +
        (row.id === SUCCESS_STATE ? "<br><span class=\"pbx-note\" style=\"margin:0\">唯一算「成功」的状态</span>" : "") +
        "</span></li>";
    }
    s += "</ul>";
    if (DEC.vocab.mapping && DEC.vocab.mapping.length) {
      s += "<div class=\"pbx-note\">适配器侧拼写（同一套语义的另一种写法）：" + esc(DEC.vocab.mapping.join("、")) + "</div>";
    }
    if (DEC.vocab.note) s += "<div class=\"pbx-note\">" + esc(DEC.vocab.note) + "</div>";
    s += "</section>";

    s += "<section class=\"pbx-card\"><div class=\"pbx-kicker\" style=\"margin-bottom:6px\">对话事件流实测（本屏真实探测）</div>";
    if (DEC.eventsProbe.mode === "ready") {
      s += kv("会话", esc(String(DEC.eventsProbe.conversationId || "（无）")));
      s += kv("事件条数", esc(String(DEC.eventsProbe.count)));
      s += kv("是否含决策气泡字段", DEC.eventsProbe.hasBubble
        ? "<span class=\"pbx-strong\">有（应在此屏渲染）</span>"
        : "<span class=\"pbx-missing\">无（故不从对话里取气泡）</span>");
    } else if (DEC.eventsProbe.mode === "error") {
      s += "<div class=\"pbx-warn\">事件流探测失败：" + esc(DEC.eventsProbe.error) + "</div>";
    } else {
      s += "<div class=\"pbx-note\" style=\"margin-top:0\">正在探测最近会话的事件流…</div>";
    }
    s += "</section>";
    return s;
  }

  function buildDecisionsHtml() {
    var tab = DEC.tab;
    var s = "<div class=\"pbx-seg\" role=\"tablist\" aria-label=\"决策分区\">";
    var segs = decSegs();
    for (var i = 0; i < segs.length; i++) {
      s += "<button type=\"button\" role=\"tab\" class=\"pbx-seg-btn\" data-act=\"dec-tab\" data-arg=\"" + segs[i][0] +
        "\" aria-selected=\"" + (tab === segs[i][0] ? "true" : "false") +
        "\" aria-current=\"" + (tab === segs[i][0] ? "page" : "false") + "\">" + segs[i][1] + "</button>";
    }
    s += "</div>";
    if (tab === "pending") s += decPendingBody();
    else if (tab === "receipt") s += decReceiptBody();
    else s += decStatesBody();
    return s;
  }

  var decCur = { root: null, ctx: null };

  function rerenderDec() {
    if (decCur.root && (PB.state && PB.state.key === "decisions")) renderDecisions(decCur.root, decCur.ctx);
  }

  function renderDecisions(root, ctx) {
    injectStyle();
    decCur.root = root; decCur.ctx = ctx;
    var wrap = document.createElement("div");
    wrap.className = "pbx pbx-dec";
    wrap.setAttribute("role", "region");
    wrap.setAttribute("aria-label", "决策");
    wrap.innerHTML = buildDecisionsHtml();
    root.innerHTML = "";
    root.appendChild(wrap);
    bindDelegated(wrap, "dec");
    if (DEC.actions.mode === "idle") later(function () { decLoad(ctx); });
  }

  function setActions(mode, list, error) {
    DEC.actions = { mode: mode, list: list || [], error: error || null };
  }

  function decLoad(ctx) {
    if (DEC.loading) return;
    DEC.loading = true;
    setActions("loading", [], null);
    rerenderDec();

    hostGet(ctx, "/api/adapters/actions", ["actions"]).then(function (r) {
      if (r.ok && r.data && Array.isArray(r.data.actions)) {
        setActions("ready", r.data.actions, null);
        DEC.loading = false;
        rerenderDec();
        decEnqueueExec(ctx, decPendingList());
      } else {
        setActions("error", [], errText(r));
        DEC.loading = false;
        rerenderDec();
      }
      return hostGet(ctx, "/api/adapters/actions/vocabulary", ["kernelVocabulary"]);
    }).then(function (r) {
      if (r && r.ok && r.data && Array.isArray(r.data.kernelVocabulary)) {
        DEC.vocab = {
          mode: "ready", list: r.data.kernelVocabulary,
          mapping: Array.isArray(r.data.adapterVocabulary) ? r.data.adapterVocabulary : [],
          note: typeof r.data.note === "string" ? r.data.note : "", error: null
        };
      } else if (r) {
        DEC.vocab = { mode: "error", list: [], mapping: [], note: "", error: errText(r) };
      }
      rerenderDec();
      return hostGet(ctx, "/api/conversations", ["conversations"]);
    }).then(function (r) {
      var list = (r && r.ok && r.data && Array.isArray(r.data.conversations)) ? r.data.conversations : null;
      if (!list || !list.length) {
        DEC.eventsProbe = { mode: "ready", conversationId: null, count: 0, hasBubble: false, error: null };
        rerenderDec();
        return null;
      }
      var cid = list[0].conversationId;
      return hostGet(ctx, "/api/conversations/" + encodeURIComponent(cid) + "/events", ["events"]).then(function (e) {
        if (e && e.ok && e.data && Array.isArray(e.data.events)) {
          var has = false;
          for (var i = 0; i < e.data.events.length; i++) {
            var ev = e.data.events[i] || {};
            if (ev.bubble !== undefined || ev.bubbles !== undefined || ev.decision !== undefined || ev.decisionBubble !== undefined) { has = true; break; }
          }
          DEC.eventsProbe = { mode: "ready", conversationId: cid, count: e.data.events.length, hasBubble: has, error: null };
        } else {
          DEC.eventsProbe = { mode: "error", conversationId: cid, count: 0, hasBubble: false, error: errText(e) };
        }
        rerenderDec();
      });
    });
  }

  // executable 逐个取（最多 5 个），每个之间让浏览器绘制一次，绝不连环紧调用。
  function decEnqueueExec(ctx, list) {
    DEC.execQueue = (list || []).slice(0, 5).map(function (a) { return a.action_id; });
    decDrainExec(ctx);
  }
  function decDrainExec(ctx) {
    var id = DEC.execQueue.shift();
    if (!id) return;
    DEC.exec[id] = { mode: "loading", data: null, error: null };
    rerenderDec();
    later(function () {
      hostPost(ctx, "/api/adapters/actions/" + encodeURIComponent(id) + "/executable", {}, ["executable"]).then(function (r) {
        if (r.ok && r.data && typeof r.data.executable === "boolean") {
          DEC.exec[id] = { mode: "ready", data: r.data, error: null };
        } else {
          DEC.exec[id] = { mode: "error", data: r.data, error: errText(r) };
        }
        rerenderDec();
        decDrainExec(ctx);
      });
    });
  }

  function findAction(id) {
    for (var i = 0; i < DEC.actions.list.length; i++) if (String(DEC.actions.list[i].action_id) === String(id)) return DEC.actions.list[i];
    return null;
  }

  // 「确认并提交」：先确保拿到 currentTaskRevision，再调真实 bubbles/click 判定。
  function decConfirm(ctx, id) {
    var a = findAction(id);
    if (!a) { toast("未找到该动作记录。"); return; }
    if (DEC.busy) return;
    DEC.busy = id;
    DEC.verdict = null; DEC.actResult = null;
    rerenderDec();

    var exec = DEC.exec[id];
    var needExec = !(exec && exec.mode === "ready" && asInt(exec.data && exec.data.currentTaskRevision) != null);
    var getRev = needExec
      ? hostPost(ctx, "/api/adapters/actions/" + encodeURIComponent(id) + "/executable", {}, ["executable"])
      : Promise.resolve({ ok: true, data: exec.data, error: null });

    getRev.then(function (er) {
      var rev = (er.ok && er.data) ? asInt(er.data.currentTaskRevision) : null;
      if (rev == null) {
        DEC.busy = null;
        DEC.verdict = { actionId: id, res: { ok: false, data: null, error: { code: errCode(er), message: "取不到当前任务版本，无法判定：" + errText(er) } } };
        rerenderDec();
        return null;
      }
      DEC.exec[id] = { mode: "ready", data: er.data, error: null };
      return hostPost(ctx, "/api/conversation-loop/bubbles/click",
        { action: a, current_task_revision: rev }, ["verdict"]).then(function (cr) {
          DEC.busy = null;
          DEC.verdict = { actionId: id, res: cr };
          rerenderDec();
        });
    });
  }

  function decReject(ctx, id) {
    var a = findAction(id);
    if (!a) { toast("未找到该动作记录。"); return; }
    if (DEC.busy) return;
    DEC.busy = id;
    DEC.actResult = null;
    rerenderDec();
    hostPost(ctx, "/api/adapters/actions/" + encodeURIComponent(id) + "/transition",
      { to: "invalidated_or_failed", invalidatedReason: "用户拒绝（决策屏）" }, ["action"]).then(function (r) {
        DEC.busy = null;
        if (r.ok && r.data && r.data.action) {
          DEC.actResult = { kind: "transition", actionId: id, ok: true, text: "已置为「已失效或失败」（用户拒绝）。", data: r.data };
          toast("已拒绝：动作已置为失效。");
        } else {
          DEC.actResult = { kind: "transition", actionId: id, ok: false, text: "拒绝被本地服务拒绝：" + errText(r) + "（" + errCode(r) + "）", data: r.data };
        }
        rerenderDec();
        decLoad(ctx);
      });
  }

  function decExecute(ctx, id) {
    if (DEC.busy) return;
    DEC.busy = id;
    DEC.actResult = null;
    rerenderDec();
    hostPost(ctx, "/api/adapters/actions/" + encodeURIComponent(id) + "/execute", {}, ["result", "action", "token", "receiptToken", "status"]).then(function (r) {
      DEC.busy = null;
      if (r.ok && r.data) {
        var d = r.data;
        var note = typeof d.note === "string" ? d.note : "";
        DEC.actResult = {
          kind: "execute", actionId: id, ok: true,
          text: "受控执行器已响应" + (d.status ? "（status=" + d.status + "）" : "") + "。" +
            (note ? note : "真实外部执行未验证（执行器为受控/本机存根），故不据此声称外部已完成。"),
          data: d
        };
      } else {
        DEC.actResult = { kind: "execute", actionId: id, ok: false, text: "执行被拒绝：" + errText(r) + "（" + errCode(r) + "）", data: r.data };
      }
      rerenderDec();
      decLoad(ctx);
    });
  }

  function handleDec(act, arg) {
    var ctx = decCur.ctx;
    switch (act) {
      case "dec-tab": DEC.tab = arg; DEC.modifyOpen = null; rerenderDec(); return;
      case "dec-reload":
        if (DEC.loading) return;      // 正在读取，忽略重复点击（不制造并发紧调用）
        DEC.exec = {}; DEC.execQueue = [];
        decLoad(ctx); return;
      case "dec-modify": DEC.modifyOpen = DEC.modifyOpen === arg ? null : arg; rerenderDec(); return;
      case "dec-confirm": decConfirm(ctx, arg); return;
      case "dec-reject": decReject(ctx, arg); return;
      case "dec-execute": decExecute(ctx, arg); return;
      default: return;
    }
  }

  // ==================================================================
  // 美团（外卖）屏：只报能力状态，不显示任何编造的门店 / 订单
  // ==================================================================
  var FOOD = {
    tab: "cap",
    ready: { mode: "idle", data: null, error: null },   // GET /api/adapters/readiness
    probe: { mode: "idle", res: null, error: null },    // POST /api/adapters/extra/meituan/query
    loadingReady: false
  };
  var VERDICT_LABEL = { implemented: "已实现", not_ready: "未就绪", blocked: "阻塞" };
  var VERDICT_KIND = { implemented: "confirmed", not_ready: "unknown", blocked: "rejected" };

  function foodSegs() {
    return [["cap", "能力状态"], ["probe", "实测查询"], ["about", "边界说明"]];
  }

  function foodCapBody(ctx) {
    var s = "<p class=\"pbx-tabintro\">这里显示美团外卖能力的<b>真实就绪度</b>（取自 <code>GET /api/adapters/readiness</code> 的 meituan 包）。" +
      "未接通就等于<b>没有</b>门店 / 菜单 / 报价 / 订单可显示——本屏不编造任何一个。</p>";
    if (FOOD.ready.mode === "idle" || FOOD.ready.mode === "loading") {
      s += "<div class=\"pbx-empty\">正在读取能力就绪度…</div>";
      return s;
    }
    if (FOOD.ready.mode === "error") {
      s += "<div class=\"pbx-card is-invalid\"><div class=\"pbx-kicker\">读取失败 · " + esc(errCode(FOOD.ready)) + "</div>" +
        "<div class=\"pbx-dangerbox\">" + esc(FOOD.ready.error) + "</div>" +
        "<div class=\"pbx-actions\">" + btn("重试", "fd-reload", null, "secondary") + "</div></div>";
      return s;
    }
    var pkg = FOOD.ready.data;
    if (!pkg) {
      s += "<div class=\"pbx-empty\">就绪度响应里没有 meituan 包。</div>";
      return s;
    }
    var counts = pkg.counts || {};
    s += "<section class=\"pbx-card\"><div class=\"pbx-cardhead\"><div class=\"pbx-grow\">" +
      "<div class=\"pbx-kicker\">外卖能力未接通</div><div class=\"pbx-title\">美团 · 就绪度</div></div>" +
      chip("未就绪", "unknown") + "</div>";
    s += kv("已实现", esc(String(counts.implemented == null ? 0 : counts.implemented)));
    s += kv("未就绪", esc(String(counts.not_ready == null ? 0 : counts.not_ready)));
    s += kv("阻塞", esc(String(counts.blocked == null ? 0 : counts.blocked)));
    s += "<div class=\"pbx-warn\">后端明确的未解锁条件：真实查询 / 详情 / 交接需要<b>已授权账号与 Token</b>（MT-01）。" +
      "「入口可见」不等于「可用」，故不接通。</div>";
    s += "<div class=\"pbx-actions\">" + btn("刷新就绪度", "fd-reload", null, "ghost") + "</div>";
    s += "</section>";

    var items = Array.isArray(pkg.subitems) ? pkg.subitems : [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i] || {};
      s += "<section class=\"pbx-card\"><div class=\"pbx-cardhead\"><div class=\"pbx-grow\">" +
        "<div class=\"pbx-kicker\">" + esc(String(it.id || "")) + " · " + esc(String(it.verdict || "")) + "</div>" +
        "<div class=\"pbx-title\">" + esc(String(it.requirement || "")) + "</div></div>" +
        chip(VERDICT_LABEL[it.verdict] || it.verdict, VERDICT_KIND[it.verdict] || "muted") + "</div>";
      if (it.implementedScope) s += kv("已实现范围", esc(String(it.implementedScope)));
      if (it.reason) s += kv("未就绪原因", esc(String(it.reason)));
      if (it.unblockedBy) s += kv("解锁条件", esc(String(it.unblockedBy)));
      var flags = [];
      if (it.stub === true) flags.push("stub");
      if (it.realExecutor === true) flags.push("realExecutor");
      s += kv("标识", flags.length ? esc(flags.join(" · ")) : "—");
      if (Array.isArray(it.evidence) && it.evidence.length) s += kv("证据", mono(it.evidence.join(" · ")));
      s += "</section>";
    }
    return s;
  }

  function probeResultHtml() {
    if (FOOD.probe.mode === "idle") return "";
    if (FOOD.probe.mode === "loading") return "<div class=\"pbx-empty\">正在向本地服务发起一次真实查询…</div>";
    var r = FOOD.probe.res, d = (r && r.data) || {};
    // meituan not_ready 是真实业务结论：ok:false 但在 data 里有结构化字段。
    var isNotReady = typeof d.code === "string" && /not_ready|unavailable|rejected|empty/.test(d.code);
    var s = "<section class=\"pbx-card\">";
    s += "<div class=\"pbx-kicker\">POST /api/adapters/extra/meituan/query 返回</div>";
    if (isNotReady || (d && (d.reason || d.unblockedBy || d.capability))) {
      s += "<div class=\"pbx-warn\">" + esc(String(d.message || errText(r))) + "</div>";
      s += kv("code", mono(String(d.code || errCode(r))));
      s += kv("verdict / status", esc(String(d.status || d.verdict || "—")));
      s += kv("capability", esc(String(d.capability || "—")));
      s += kv("stub", d.stub === true ? "true" : "false");
      s += kv("realExecutor", d.realExecutor === true ? "true" : "false");
      s += kv("model_fabricated", d.model_fabricated === true ? "<span class=\"pbx-missing\">true</span>" : "false");
      if (Array.isArray(d.candidates)) s += kv("返回候选", esc(String(d.candidates.length)) + " 条（未就绪时恒为空）");
      if (d.unblockedBy) s += kv("解锁条件", esc(String(d.unblockedBy)));
      if (d.visibility && d.visibility.note) s += kv("范围可见性", esc(String(d.visibility.note)));
      s += "<div class=\"pbx-note\">以上是本地服务的<b>原话</b>：未就绪时不产出任何候选，绝不用模型知识补位。</div>";
    } else if (r && r.ok && d && Array.isArray(d.candidates)) {
      s += "<div class=\"pbx-okbox\">就绪：返回 " + d.candidates.length + " 条候选。</div>";
      for (var i = 0; i < d.candidates.length; i++) {
        var c = d.candidates[i] || {};
        s += kv(String(c.label || c.id || "候选"), esc(String((c.provenance && c.provenance.sourceRef) || "")));
      }
    } else {
      s += "<div class=\"pbx-dangerbox\">" + esc(errText(r)) + "</div>";
    }
    s += "</section>";
    return s;
  }

  function foodProbeBody(ctx) {
    var s = "<p class=\"pbx-tabintro\">点一下按钮，向本地服务发<b>一次</b>真实查询，原样显示它的回答。" +
      "这能证明「未接通」不是本屏的托词，而是后端的真实结论。</p>";
    s += "<section class=\"pbx-card\">" +
      "<div class=\"pbx-actions\">" + btn("发起一次真实查询", "fd-probe", null, "primary") + "</div>" +
      "<div class=\"pbx-note\">查询体：{ category:\"咖啡\", location:\"张江\" }（示例条件；不预设任何门店）。</div>" +
      "</section>";
    s += probeResultHtml();
    return s;
  }

  function foodAboutBody() {
    return "<p class=\"pbx-tabintro\">本屏的诚实边界：</p>" +
      "<section class=\"pbx-card\">" +
      "<div class=\"pbx-kv\"><span class=\"pbx-kv-k\">显示什么</span><span class=\"pbx-kv-v\">只显示后端返回的能力就绪度与真实查询结果。</span></div>" +
      "<div class=\"pbx-kv\"><span class=\"pbx-kv-k\">不显示什么</span><span class=\"pbx-kv-v\">不显示任何门店 / 菜单 / 规格 / 购物车 / 地址 / 报价 / 订单——这些此前是示例数据，现已全部移除。</span></div>" +
      "<div class=\"pbx-kv\"><span class=\"pbx-kv-k\">为什么</span><span class=\"pbx-kv-v\">真实下单需已授权账号与 Token（MT-01 未就绪）；无凭据时编造门店或订单等于假回执。</span></div>" +
      "<div class=\"pbx-kv\"><span class=\"pbx-kv-k\">下单去哪</span><span class=\"pbx-kv-v\">真实外部动作只经动作台账与受控执行器（见「决策」屏），且未接通前不声称完成。</span></div>" +
      "</section>";
  }

  function buildFoodHtml(ctx) {
    var s = "<div class=\"pbx-seg\" role=\"tablist\" aria-label=\"美团分区\">";
    var segs = foodSegs();
    for (var i = 0; i < segs.length; i++) {
      s += "<button type=\"button\" role=\"tab\" class=\"pbx-seg-btn\" data-act=\"fd-tab\" data-arg=\"" + segs[i][0] +
        "\" aria-selected=\"" + (FOOD.tab === segs[i][0] ? "true" : "false") +
        "\" aria-current=\"" + (FOOD.tab === segs[i][0] ? "page" : "false") + "\">" + segs[i][1] + "</button>";
    }
    s += "</div>";
    if (FOOD.tab === "cap") s += foodCapBody(ctx);
    else if (FOOD.tab === "probe") s += foodProbeBody(ctx);
    else s += foodAboutBody();
    return s;
  }

  var foodCur = { root: null, ctx: null };

  function rerenderFood() {
    if (foodCur.root && (PB.state && PB.state.key === "food")) renderFood(foodCur.root, foodCur.ctx);
  }

  function renderFood(root, ctx) {
    injectStyle();
    foodCur.root = root; foodCur.ctx = ctx;
    var wrap = document.createElement("div");
    wrap.className = "pbx pbx-fd";
    wrap.setAttribute("role", "region");
    wrap.setAttribute("aria-label", "美团外卖");
    wrap.innerHTML = buildFoodHtml(ctx);
    root.innerHTML = "";
    root.appendChild(wrap);
    bindDelegated(wrap, "fd");
    if (FOOD.ready.mode === "idle") later(function () { foodLoadReady(ctx); });
  }

  function foodLoadReady(ctx) {
    if (FOOD.loadingReady) return;
    FOOD.loadingReady = true;
    FOOD.ready = { mode: "loading", data: null, error: null };
    rerenderFood();
    hostGet(ctx, "/api/adapters/readiness", ["packages"]).then(function (r) {
      FOOD.loadingReady = false;
      if (r.ok && r.data && r.data.packages) {
        FOOD.ready = { mode: "ready", data: r.data.packages.meituan || null, error: null };
      } else {
        FOOD.ready = { mode: "error", data: null, error: errText(r) };
      }
      rerenderFood();
    });
  }

  function foodProbe(ctx) {
    if (FOOD.probe.mode === "loading") return;
    FOOD.probe = { mode: "loading", res: null, error: null };
    FOOD.tab = "probe";
    rerenderFood();
    hostPost(ctx, "/api/adapters/extra/meituan/query",
      { query: { category: "咖啡", location: "张江" } },
      ["candidates", "rejected", "scope"]).then(function (r) {
        FOOD.probe = { mode: "ready", res: r, error: null };
        rerenderFood();
      });
  }

  function handleFood(act, arg) {
    var ctx = foodCur.ctx;
    switch (act) {
      case "fd-tab": FOOD.tab = arg; rerenderFood(); return;
      case "fd-reload": if (FOOD.loadingReady) return; foodLoadReady(ctx); return;
      case "fd-probe": foodProbe(ctx); return;
      default: return;
    }
  }

  // ==================================================================
  // 事件委派
  // ==================================================================
  function bindDelegated(wrap, mode) {
    wrap.addEventListener("click", function (e) {
      var t = e.target;
      var el = (t && t.closest) ? t.closest("[data-act]") : null;
      if (!el) return;
      if (el.disabled) return;
      var act = el.getAttribute("data-act");
      var arg = el.getAttribute("data-arg");
      if (mode === "fd") handleFood(act, arg);
      else handleDec(act, arg);
    });
  }

  // ==================================================================
  // 注册
  // ==================================================================
  PB.screens.decisions = {
    title: "决策",
    render: function (root, ctx) { renderDecisions(root, ctx); }
  };
  PB.screens.food = {
    title: "美团",
    render: function (root, ctx) { renderFood(root, ctx); }
  };
})();
