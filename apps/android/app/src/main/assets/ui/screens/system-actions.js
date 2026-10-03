/* =============================================================================
 * Potbot v6 手机界面 —— 系统动作（system-actions）
 *
 * 屏幕：系统动作 = 日历事件 / 提醒与计时 / 资料来源 三类「专属详情表单」，
 *       每张表单完成后都回到**同一个统一对话**（对应 F-R06 的 I-G）。
 *
 * 技术约束（Android WebView，file:///android_asset/ui/index.html）：
 *   - 经典脚本，无 import/export、无 type=module、无 fetch/XHR、无外部 CDN。
 *   - 只注册 window.PB.screens['system-actions']，只写本文件。
 *
 * 诚实边界（不编造）：
 *   - 起始为空：没有真实回执时一律如实说明，绝不冒充成功。
 *   - 提交后无确定回执 / 收到无法解析报文 / 内核报 progressUnknown ⇒ 一律「结果未知」，
 *     绝不升级为「已完成 / 成功」。取消 ⇒ 「已取消」，不声称已撤销外部动作。
 *   - 日历写入、系统提醒通道、真实检索端口均未接入本界面：相关能力按「未授权 / 未连接 /
 *     未生效」如实标注（镜像 apps/mobile-ui/src/system-actions 的 fail-closed 不变量）。
 *
 * 设计来源（只读）：
 *   docs/design/release-ui/potbot-release.html（原型，确认日历安排 / 来源与依据 文案）；
 *   docs/design/design-07-正式发布版App界面与交互.md 行 48/54/55/133/185–189/193/199–204/210–211；
 *   apps/mobile-ui/src/system-actions/{calendar,reminder,research,screen-adapter}.ts。
 * ========================================================================== */
(function () {
  "use strict";

  window.PB = window.PB || {};
  window.PB.screens = window.PB.screens || {};

  var KEY = "system-actions";

  /* ------------------------------------------------------------------ *
   * 0. 常量（镜像 F-R06：时区 / 账号引用 / 重复 / 提醒 / 来源状态词表）
   * ------------------------------------------------------------------ */

  var TZ_OPTS = [
    ["Asia/Shanghai", "亚洲 / 上海"],
    ["Asia/Tokyo", "亚洲 / 东京"],
    ["Europe/London", "欧洲 / 伦敦"],
    ["America/New_York", "美洲 / 纽约"],
    ["UTC", "协调世界时 UTC"]
  ];
  // 目标日历账号只能是 cal:/acct: 引用（I-C）；granted 表示已授权可写。
  var CAL_OPTS = [
    ["cal:personal", "个人日历", true],
    ["cal:work", "工作日历", false]
  ];
  var REC_OPTS = [
    ["", "不重复"],
    ["FREQ=DAILY", "每天"],
    ["FREQ=WEEKLY", "每周"],
    ["FREQ=MONTHLY", "每月"]
  ];
  var REC_LABEL = { "": "不重复", "FREQ=DAILY": "每天", "FREQ=WEEKLY": "每周", "FREQ=MONTHLY": "每月" };
  var SCOPE_OPTS = [
    ["this", "仅本次"],
    ["this-and-future", "本次及以后"],
    ["whole-series", "整个系列"]
  ];
  var SCOPE_LABEL = { this: "仅本次", "this-and-future": "本次及以后", "whole-series": "整个系列" };
  var REMIND_AHEAD = [
    ["", "不提醒"],
    ["5", "提前 5 分钟"],
    ["30", "提前 30 分钟"],
    ["60", "提前 1 小时"]
  ];

  var REM_KINDS = [
    ["reminder", "提醒"],
    ["alarm", "闹钟"],
    ["timer", "计时器"],
    ["stopwatch", "秒表"],
    ["world-clock", "世界时钟"]
  ];
  var REM_KIND_LABEL = { reminder: "提醒", alarm: "闹钟", timer: "计时器", stopwatch: "秒表", "world-clock": "世界时钟" };
  var OWNERS = [["self", "自管（本机）"], ["system", "系统（系统时钟应用）"]];
  var PERMS = [["granted", "已授权"], ["denied", "已拒绝"], ["unknown", "未知"]];
  var DUR_UNITS = [["60000", "分钟"], ["1000", "秒"], ["3600000", "小时"]];

  var SRC_STATES = [
    ["read", "已读取"],
    ["partial", "部分读取"],
    ["unread", "未读取"],
    ["expired", "过期"],
    ["conflict", "冲突"],
    ["inaccessible", "不可访问"]
  ];
  var HONESTY = {
    read: "可核验",
    partial: "部分",
    unread: "未知",
    expired: "已过期",
    conflict: "有冲突",
    inaccessible: "不可访问"
  };
  var QUERY_SCOPES = [
    ["conversation", "本次会话资料"],
    ["private", "我的私有资料"],
    ["public", "公开来源"]
  ];

  // 来源地址不得是电脑绝对路径（I-F）。
  var URI_SCHEME = /^(?:https?|content|blob|app|ref):/i;
  var WIN_DRIVE = /^[A-Za-z]:[\\/]/;

  var UNKNOWN_MSG = "提交后未收到确定回执，结果未知——未重复创建，可稍后核对同一动作。";

  /* ------------------------------------------------------------------ *
   * 1. 表单默认值（全部留空；不预填示例内容）
   * ------------------------------------------------------------------ */

  /* 表单默认值：全部留空，用户自己填（不预填示例内容）。 */
  var DEMO = {
    calendar: {
      op: "create", eventId: "", title: "", date: "", start: "", end: "",
      tz: "Asia/Shanghai", cal: "", rec: "", scope: "", remind: "", people: "", revision: 1
    },
    reminder: {
      kind: "reminder", reminderId: "", label: "", owner: "self", time: "",
      duration: "", unit: "60000", tz: "Asia/Shanghai", channel: "", permission: "granted", revision: 1
    },
    research: {
      sourceId: "", title: "", uri: "", state: "unknown", fetchedAt: "",
      evidence: "", conflicts: "", isPrivate: true, queryScope: "private",
      permission: "granted", revision: 1
    }
  };

  /* ------------------------------------------------------------------ *
   * 2. 小工具
   * ------------------------------------------------------------------ */

  // 全部样式内联、作用域限定在 .sa- 前缀，避免与其他屏幕样式冲突。
  var STYLE_ID = "pb-screen-system-actions";
  var CSS = "" +
    ":root{--pb-accent:#E9A66D;--pb-accent-soft:#FFF0E2;--pb-bg:#fff;--pb-ink:#28231F;--pb-muted:#77716B;}" +
    ".sa-wrap{--sa-accent:var(--pb-accent,#E9A66D);--sa-soft:var(--pb-accent-soft,#FFF0E2);--sa-ink:var(--pb-ink,#28231F);--sa-muted:var(--pb-muted,#77716B);" +
    "--sa-outline:#E8E4DF;--sa-input:#FAFAF9;--sa-danger:#A73729;--sa-success:#306A4B;--sa-warn:#8A5A22;" +
    "color:var(--sa-ink);padding-bottom:calc(24px + env(safe-area-inset-bottom))}" +
    ".sa-title{font-size:24px;line-height:32px;font-weight:600;margin:12px 0 4px}" +
    ".sa-sub{font-size:14px;line-height:20px;color:var(--sa-muted);margin:0 0 14px}" +
    ".sa-status{display:flex;gap:8px;align-items:center;margin:8px 0;padding:8px 12px;border-radius:10px;font-size:12px;line-height:18px;" +
    "background:var(--sa-soft);color:#825034;border:1px solid #F3DFCB}" +
    ".sa-status.ok{background:#EDF6F0;color:var(--sa-success);border-color:#D3E7DB}" +
    ".sa-dot{width:8px;height:8px;border-radius:50%;background:currentColor;flex:none}" +
    ".sa-tabs{display:flex;gap:8px;margin:12px 0}" +
    ".sa-tab{flex:1;min-height:48px;border:1px solid var(--sa-outline);background:#fff;color:var(--sa-muted);border-radius:12px;font:inherit;font-size:15px;font-weight:500}" +
    ".sa-tab[aria-selected=\"true\"]{background:var(--sa-soft);color:#825034;border-color:#F3DFCB}" +
    ".sa-card{background:#fff;border:1px solid var(--sa-outline);border-radius:16px;padding:14px 16px;margin:8px 0}" +
    ".sa-field{display:block;margin:12px 0}" +
    ".sa-label{display:block;font-size:13px;color:var(--sa-muted);margin-bottom:4px}" +
    ".sa-input{width:100%;min-height:48px;font:inherit;font-size:16px;color:var(--sa-ink);background:var(--sa-input);border:1px solid var(--sa-outline);border-radius:12px;padding:10px 12px}" +
    ".sa-area{min-height:72px;resize:vertical;line-height:24px}" +
    ".sa-select{-webkit-appearance:none;appearance:none;padding-right:34px;" +
    "background-image:linear-gradient(45deg,transparent 50%,#77716B 50%),linear-gradient(135deg,#77716B 50%,transparent 50%);" +
    "background-position:calc(100% - 18px) 21px,calc(100% - 13px) 21px;background-size:5px 5px,5px 5px;background-repeat:no-repeat}" +
    ".sa-hint{display:block;font-size:12px;line-height:18px;color:var(--sa-muted);margin-top:4px}" +
    ".sa-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}" +
    ".sa-check{display:flex;gap:10px;align-items:center;min-height:48px;margin:8px 0;font-size:15px}" +
    ".sa-check input{width:22px;height:22px;flex:none}" +
    ".sa-h3{font-size:15px;font-weight:600;margin:16px 0 8px}" +
    ".sa-kvbox{border-top:1px solid var(--sa-outline)}" +
    ".sa-kv{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid var(--sa-outline);font-size:15px}" +
    ".sa-k{color:var(--sa-muted);flex:none}" +
    ".sa-v{text-align:right;word-break:break-word}" +
    ".sa-warns{margin:8px 0}" +
    ".sa-warn{margin:6px 0;padding:8px 10px;border-radius:10px;font-size:13px;line-height:19px;background:var(--sa-soft);color:#825034}" +
    ".sa-warn.warn{background:#FBF3E6;color:var(--sa-warn)}" +
    ".sa-warn.error{background:#FBEDEA;color:var(--sa-danger)}" +
    ".sa-effects{border-top:1px solid var(--sa-outline);margin-top:8px}" +
    ".sa-effect{display:flex;gap:10px;padding:7px 0;font-size:13px;line-height:19px;border-bottom:1px solid var(--sa-outline)}" +
    ".sa-effect-name{flex:none;width:72px;font-weight:600}" +
    ".sa-effect-desc{color:var(--sa-muted)}" +
    ".sa-actions{display:flex;gap:10px;margin-top:18px}" +
    ".sa-btn{flex:1;min-height:48px;border-radius:12px;border:0;font:inherit;font-size:16px;font-weight:500;padding:0 12px}" +
    ".sa-btn.primary{background:var(--sa-accent);color:#241A14}" +
    ".sa-btn.secondary{background:#fff;color:var(--sa-ink);border:1px solid var(--sa-outline)}" +
    ".sa-btn.destructive{background:var(--sa-danger);color:#fff;width:100%;flex:none;margin-top:10px}" +
    ".sa-btn:disabled{opacity:.45}" +
    ".sa-statusbox{font-size:13px;color:var(--sa-muted);margin-top:10px}" +
    ".sa-statusbox.error{color:var(--sa-danger)}" +
    ".sa-result{margin:10px 0;padding:12px 14px;border:1px solid var(--sa-outline);border-radius:14px;background:#fff}" +
    ".sa-result-unknown{border-color:#EAD6B4;background:#FBF6EC}" +
    ".sa-result-error{border-color:#EFCFC7;background:#FCF0ED}" +
    ".sa-result-cancelled{background:var(--sa-input)}" +
    ".sa-result-top{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}" +
    ".sa-result-text{font-size:14px;line-height:21px;margin:4px 0 10px;white-space:pre-wrap;word-break:break-word}" +
    ".sa-badge{font-size:12px;font-weight:600;padding:2px 8px;border-radius:8px;background:var(--sa-soft);color:#825034;flex:none}" +
    ".sa-badge.ok{background:#EDF6F0;color:var(--sa-success)}" +
    ".sa-badge.unknown{background:#FBF3E6;color:var(--sa-warn)}" +
    ".sa-badge.cancelled{background:var(--sa-input);color:var(--sa-muted)}" +
    ".sa-badge.error{background:#FBEDEA;color:var(--sa-danger)}" +
    ".sa-mini{font-size:12px;line-height:18px;color:var(--sa-muted)}" +
    ".sa-delete{margin:14px 0 4px;padding-top:12px;border-top:1px solid var(--sa-outline)}" +
    ".sa-link{background:none;border:0;color:#825034;font:inherit;font-size:15px;min-height:48px;padding:0;text-align:left}" +
    ".sa-scopecard{margin-top:8px;padding:10px 12px;border:1px solid var(--sa-outline);border-radius:12px;background:var(--sa-input)}" +
    ".sa-footnote{font-size:12px;line-height:19px;color:var(--sa-muted);margin:14px 0 0}" +
    ".sa-preview{margin-top:8px}" +
    ".sa-wrap :focus-visible{outline:2px solid #825034;outline-offset:2px}" +
    "@media (max-width:340px){.sa-grid{grid-template-columns:1fr}}";

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement("style");
    st.id = STYLE_ID;
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }

  function frag() { return document.createDocumentFragment(); }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function bridgeLive(ctx) {
    return !!(ctx && ctx.bridge && ctx.bridge.available);
  }

  function parse(s) {
    if (s && typeof s === "object") return s;
    if (typeof s !== "string") return null;
    try { return JSON.parse(s); } catch (e) { return null; }
  }

  function newId() {
    return "sa-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  /* ---- 表单控件 ---- */

  function textField(label, value, onInput, opts) {
    opts = opts || {};
    var wrap = el("label", "sa-field");
    wrap.appendChild(el("span", "sa-label", label));
    var input = el("input", "sa-input");
    input.type = opts.type || "text";
    if (opts.placeholder) input.setAttribute("placeholder", opts.placeholder);
    if (opts.min != null) input.setAttribute("min", opts.min);
    input.value = value == null ? "" : value;
    input.addEventListener("input", function () { onInput(input.value); });
    wrap.appendChild(input);
    if (opts.hint) wrap.appendChild(el("span", "sa-hint", opts.hint));
    return wrap;
  }

  function areaField(label, value, onInput, opts) {
    opts = opts || {};
    var wrap = el("label", "sa-field");
    wrap.appendChild(el("span", "sa-label", label));
    var ta = el("textarea", "sa-input sa-area");
    ta.rows = opts.rows || 3;
    if (opts.placeholder) ta.setAttribute("placeholder", opts.placeholder);
    ta.value = value == null ? "" : value;
    ta.addEventListener("input", function () { onInput(ta.value); });
    wrap.appendChild(ta);
    if (opts.hint) wrap.appendChild(el("span", "sa-hint", opts.hint));
    return wrap;
  }

  function selectField(label, options, value, onChange, hint) {
    var wrap = el("label", "sa-field");
    wrap.appendChild(el("span", "sa-label", label));
    var sel = el("select", "sa-input sa-select");
    options.forEach(function (o) {
      var opt = el("option", null, o[1]);
      opt.value = o[0];
      if (String(o[0]) === String(value)) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener("change", function () { onChange(sel.value); });
    wrap.appendChild(sel);
    if (hint) wrap.appendChild(el("span", "sa-hint", hint));
    return wrap;
  }

  function checkField(label, checked, onChange) {
    var wrap = el("label", "sa-check");
    var cb = el("input");
    cb.type = "checkbox";
    cb.checked = !!checked;
    cb.addEventListener("change", function () { onChange(cb.checked); });
    wrap.appendChild(cb);
    wrap.appendChild(el("span", null, label));
    return wrap;
  }

  function row2(a, b) {
    var g = el("div", "sa-grid");
    g.appendChild(a);
    g.appendChild(b);
    return g;
  }

  /* ------------------------------------------------------------------ *
   * 3. 会话内状态（导航子页 + 各表单草稿）
   * ------------------------------------------------------------------ */

  function getSA(ctx) {
    try {
      ctx.state = ctx.state || {};
      var st = ctx.state.systemActions;
      if (!st || typeof st !== "object") {
        st = { kind: "calendar", models: {}, result: null, deleting: false };
        ctx.state.systemActions = st;
      }
      if (!st.models) st.models = {};
      if (!st.models.calendar) st.models.calendar = clone(DEMO.calendar);
      if (!st.models.reminder) st.models.reminder = clone(DEMO.reminder);
      if (!st.models.research) st.models.research = clone(DEMO.research);
      if (!st.kind) st.kind = "calendar";
      st.result = st.result || null;
      return st;
    } catch (e) {
      // 状态不可写时降级为一次性草稿（不崩溃）。
      return { kind: "calendar", models: { calendar: clone(DEMO.calendar), reminder: clone(DEMO.reminder), research: clone(DEMO.research) }, result: null, deleting: false };
    }
  }

  function calByRef(ref) {
    for (var i = 0; i < CAL_OPTS.length; i++) if (CAL_OPTS[i][0] === ref) return CAL_OPTS[i];
    return null;
  }

  /* ------------------------------------------------------------------ *
   * 4. 校验（镜像 F-R06 不变量；返回可见的错误 / 告警 / 执行摘要）
   * ------------------------------------------------------------------ */

  function evalCalendar(m) {
    var errors = [], warnings = [], blocked = [], summary = [];
    var title = (m.title || "").trim();
    if (!title) errors.push("标题不能为空。");
    if (!m.date) errors.push("日期不能为空。");
    if (!m.start) errors.push("开始时间不能为空。");
    if (m.end && m.start && m.end < m.start) errors.push("结束时间不能早于开始时间。");

    var recLabel = REC_LABEL[m.rec] || "不重复";
    var editing = m.op === "edit";
    if (editing && m.rec && !m.scope) {
      errors.push("修改重复日程必须显式选择作用范围（仅本次 / 本次及以后 / 整个系列）。");
    }

    var cal = calByRef(m.cal);
    if (!cal) {
      blocked.push("目标日历账号未选择。");
    } else if (!cal[2]) {
      blocked.push("日历「" + cal[1] + "」未授权，无法写入；请先在我的 › 连接与权限中授权。");
    }

    var tzLabel = tzText(m.tz);
    var timeText = m.date + " " + (m.start || "—") + (m.end ? "–" + m.end : "");
    summary.push(["操作", editing ? "更新已有日程" : "创建日程"]);
    summary.push(["标题", title || "（未填写）"]);
    summary.push(["执行摘要（绝对时间）", timeText + " · " + tzLabel]);
    summary.push(["目标日历", cal ? cal[1] + "（" + cal[0] + "）" : "未选择"]);
    summary.push(["重复", recLabel]);
    if (editing && m.rec) summary.push(["作用范围", SCOPE_LABEL[m.scope] || "未指定"]);
    summary.push(["提醒", aheadLabel(m.remind)]);
    summary.push(["参与者", (m.people || "").trim() || "不发送邀请"]);

    if (!m.end) warnings.push(["info", "未给出结束时间，将按单点事件处理。"]);
    if (editing && m.rec) warnings.push(["info", "本次修改仅作用于：" + (SCOPE_LABEL[m.scope] || "未指定") + "；失败原记录将保留。"]);
    if (blocked.length) warnings.push(["error", blocked[0]]);

    var ok = errors.length === 0;
    return {
      ok: ok,
      errors: errors,
      warnings: warnings,
      blocked: blocked,
      summary: summary,
      actionLabel: editing ? "保存修改" : "确认并提交",
      command: function () {
        return {
          schemaVersion: "mobile-v1",
          commandId: newId(),
          idempotencyKey: idOf("calendar-event", title + m.date + m.start),
          operation: m.eventId ? "mutate" : "create",
          payload: {
            kind: "calendar-event",
            eventId: m.eventId || null,
            title: title,
            date: m.date,
            start: m.start,
            end: m.end || null,
            timezone: m.tz,
            accountRef: m.cal,
            recurrence: m.rec || null,
            occurrenceScope: m.scope || null,
            reminderMinutesBefore: m.remind ? Number(m.remind) : null,
            expectedRevision: Number(m.revision) || 0
          }
        };
      }
    };
  }

  function evalReminder(m) {
    var errors = [], warnings = [], summary = [];
    var label = (m.label || "").trim();
    if (!label) errors.push("名称不能为空。");

    var kind = m.kind;
    if (kind === "alarm" || kind === "reminder") {
      if (!m.time) errors.push("闹钟 / 提醒必须给出触发时间。");
    }
    if (kind === "timer") {
      var d = Number(m.duration);
      if (!(d > 0) || Math.floor(d) !== d) errors.push("计时器时长必须是正整数。");
    }
    if (kind === "world-clock" && !m.tz) errors.push("世界时钟必须给出时区。");
    if (m.owner === "system" && !(m.channel || "").trim()) {
      errors.push("系统归属必须给出系统提醒通道 / 应用引用。");
    }

    var armed = m.permission === "granted";
    var blockedReason = m.permission === "denied" ? "permission-denied" : m.permission === "unknown" ? "permission-unknown" : null;
    if (blockedReason === "permission-denied") {
      warnings.push(["error", "精确提醒权限被拒绝，本提醒不会触发；未标记为已设置。"]);
    } else if (blockedReason === "permission-unknown") {
      warnings.push(["warn", "提醒权限状态未知，需确认后才能触发。"]);
    }
    if (m.owner === "system") warnings.push(["info", "本提醒交由系统调度，属系统归属，与自管分别验收。"]);
    if (m.kind === "timer" && m.owner === "system") warnings.push(["warn", "计时器一般由本机自管；系统归属可能不受支持。"]);

    summary.push(["类型", REM_KIND_LABEL[kind] || kind]);
    summary.push(["名称", label || "（未填写）"]);
    summary.push(["归属", m.owner === "self" ? "自管" : "系统"]);
    if (kind === "alarm" || kind === "reminder") summary.push(["执行摘要（绝对时间）", (m.time || "—") + " · " + tzText(m.tz)]);
    if (kind === "timer") summary.push(["时长", durationText(m)]);
    if (kind === "world-clock") summary.push(["时区", tzText(m.tz)]);
    if (m.owner === "system") summary.push(["系统通道", (m.channel || "").trim() || "未提供"]);
    summary.push(["权限", permLabel(m.permission)]);
    summary.push(["状态", armed ? "已设置，届时触发" : "未生效（" + (blockedReason === "permission-denied" ? "权限被拒绝" : "权限未知") + "）"]);

    return {
      ok: errors.length === 0,
      errors: errors,
      warnings: warnings,
      blocked: armed ? [] : [blockedReason],
      summary: summary,
      actionLabel: m.reminderId ? "保存修改" : "设置提醒",
      command: function () {
        return {
          schemaVersion: "mobile-v1",
          commandId: newId(),
          idempotencyKey: idOf("reminder", label + kind + (m.time || m.duration)),
          operation: m.reminderId ? "mutate" : "create",
          payload: {
            kind: "reminder",
            reminderId: m.reminderId || null,
            reminderKind: kind,
            label: label,
            owner: m.owner,
            time: (kind === "alarm" || kind === "reminder") ? m.time : null,
            durationMs: kind === "timer" ? Math.round(Number(m.duration) * Number(m.unit)) : null,
            timezone: m.tz,
            systemChannel: m.owner === "system" ? (m.channel || "").trim() : null,
            permission: m.permission,
            expectedRevision: Number(m.revision) || 0
          }
        };
      }
    };
  }

  function evalResearch(m) {
    var errors = [], warnings = [], summary = [];
    var title = (m.title || "").trim();
    if (!title) errors.push("来源标题不能为空。");

    var uri = (m.uri || "").trim();
    if (!uri) {
      errors.push("原址不能为空。");
    } else if (WIN_DRIVE.test(uri) || uri.slice(0, 2) === "\\\\" || uri.charAt(0) === "/") {
      errors.push("原址不得是电脑绝对路径；请使用 http(s) / content / blob / app / ref 引用。");
    } else if (!URI_SCHEME.test(uri)) {
      errors.push("原址必须是 http(s):// / content:// / blob:// / app:// / ref:// 引用。");
    }

    var state = m.state;
    var hasEvidence = !!(m.evidence || "").trim();
    var hasFetched = !!(m.fetchedAt || "").trim();
    if (state === "read" || state === "partial") {
      if (!hasFetched) errors.push("已读取 / 部分读取的来源必须给出读取时间。");
      if (!hasEvidence) errors.push("已读取 / 部分读取的来源必须给出证据片段。");
    } else if (state === "unread") {
      if (hasEvidence) errors.push("未读取的来源不得携带证据片段——未读取不得伪装为已读取。");
      if (hasFetched) errors.push("未读取的来源不得携带读取时间。");
    }
    if (state === "conflict" && !(m.conflicts || "").trim()) {
      errors.push("冲突来源必须列出与之冲突的来源。");
    }

    if (state === "unread") warnings.push(["warn", "来源尚未读取，结论可指向的证据为空。"]);
    if (state === "partial") warnings.push(["warn", "仅部分读取，结论证据不完整。"]);
    if (state === "expired") warnings.push(["warn", "来源已过期，需重新读取。"]);
    if (state === "conflict") warnings.push(["warn", "与其他来源冲突，需并列展示。"]);
    if (state === "inaccessible") warnings.push(["error", "来源不可访问，不能以空白掩盖。"]);
    if (m.isPrivate) warnings.push(["info", "私有资料：删除将联动其引用与派生事实。"]);
    if (m.permission === "denied") warnings.push(["error", "该来源的读取权限被拒绝，当前不能重新读取。"]);

    summary.push(["查询范围", scopeLabel(m.queryScope)]);
    summary.push(["来源状态", stateLabel(state)]);
    summary.push(["可信度", HONESTY[state] || state]);
    summary.push(["原址", uri || "（未填写）"]);
    if (hasFetched) summary.push(["读取时间", m.fetchedAt]);
    if (hasEvidence) summary.push(["证据", m.evidence]);
    if (state === "conflict") summary.push(["冲突来源", (m.conflicts || "").trim() || "未列出"]);
    summary.push(["私有资料", m.isPrivate ? "是" : "否"]);

    return {
      ok: errors.length === 0,
      errors: errors,
      warnings: warnings,
      blocked: m.permission === "denied" ? ["permission-denied"] : [],
      summary: summary,
      actionLabel: "提交来源",
      command: function () {
        return {
          schemaVersion: "mobile-v1",
          commandId: newId(),
          idempotencyKey: idOf("research-source", title + uri),
          operation: "query",
          payload: {
            kind: "research-source",
            sourceId: m.sourceId,
            title: title,
            originUri: uri,
            state: state,
            fetchedAt: (state === "read" || state === "partial") ? m.fetchedAt : (hasFetched ? m.fetchedAt : null),
            evidenceSnippet: (state === "unread") ? null : (hasEvidence ? m.evidence : null),
            conflictWith: state === "conflict" ? splitRefs(m.conflicts) : [],
            isPrivate: !!m.isPrivate,
            queryScope: m.queryScope,
            expectedRevision: Number(m.revision) || 0
          }
        };
      }
    };
  }

  function splitRefs(s) {
    return String(s || "").split(/[\s,，;；]+/).filter(function (x) { return x.length; });
  }
  function tzText(tz) {
    for (var i = 0; i < TZ_OPTS.length; i++) if (TZ_OPTS[i][0] === tz) return TZ_OPTS[i][1];
    return tz || "未指定";
  }
  function aheadLabel(v) {
    for (var i = 0; i < REMIND_AHEAD.length; i++) if (REMIND_AHEAD[i][0] === String(v)) return REMIND_AHEAD[i][1];
    return "不提醒";
  }
  function permLabel(v) {
    for (var i = 0; i < PERMS.length; i++) if (PERMS[i][0] === v) return PERMS[i][1];
    return v || "未知";
  }
  function stateLabel(v) {
    for (var i = 0; i < SRC_STATES.length; i++) if (SRC_STATES[i][0] === v) return SRC_STATES[i][1];
    return v || "未读取";
  }
  function scopeLabel(v) {
    for (var i = 0; i < QUERY_SCOPES.length; i++) if (QUERY_SCOPES[i][0] === v) return QUERY_SCOPES[i][1];
    return v || "本次会话资料";
  }
  function durationText(m) {
    var unitLabel = m.unit === "1000" ? "秒" : m.unit === "3600000" ? "小时" : "分钟";
    return (m.duration || "0") + " " + unitLabel + "（" + (Number(m.duration) || 0) * (Number(m.unit) || 60000) + " 毫秒）";
  }
  function idOf(kind, seed) {
    // 确定性幂等键：同一逻辑提交重发得同一键（FNV-1a 64bit 简化版）。
    var s = kind + "|" + seed, h1 = 0x811c9dc5, h2 = 0x01000193;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      h1 = (h1 ^ c) >>> 0; h1 = (h1 * 0x01000193) >>> 0;
      h2 = (h2 + c * (i + 1)) >>> 0;
    }
    return (h1.toString(16) + h2.toString(16)).slice(0, 16);
  }

  /* ------------------------------------------------------------------ *
   * 5. 表单构造
   * ------------------------------------------------------------------ */

  function buildCalendar(m, onChange) {
    var node = el("div");
    function upd(k, v) { m[k] = v; onChange(); }

    node.appendChild(textField("标题", m.title, function (v) { upd("title", v); }, { placeholder: "例如：8 人周末活动" }));
    node.appendChild(selectField("操作", [["create", "创建日程"], ["edit", "修改已有日程"]], m.op, function (v) { upd("op", v); }));

    node.appendChild(row2(
      textField("日期", m.date, function (v) { upd("date", v); }, { type: "date" }),
      selectField("时区", TZ_OPTS, m.tz, function (v) { upd("tz", v); })
    ));
    node.appendChild(row2(
      textField("开始", m.start, function (v) { upd("start", v); }, { type: "time" }),
      textField("结束", m.end, function (v) { upd("end", v); }, { type: "time", hint: "可留空" })
    ));

    node.appendChild(selectField("目标日历账号", CAL_OPTS.map(function (o) { return [o[0], o[1] + (o[2] ? "" : " · 未授权")]; }), m.cal, function (v) { upd("cal", v); }));
    node.appendChild(selectField("重复", REC_OPTS, m.rec, function (v) { upd("rec", v); }));
    if (m.rec) {
      node.appendChild(selectField("重复范围", SCOPE_OPTS, m.scope, function (v) { upd("scope", v); }, "仅修改重复日程时必填（分开确认）"));
    }
    node.appendChild(row2(
      selectField("提醒", REMIND_AHEAD, m.remind, function (v) { upd("remind", v); }),
      textField("参与者", m.people, function (v) { upd("people", v); }, { hint: "留空=不发送邀请" })
    ));
    return node;
  }

  function buildReminder(m, onChange) {
    var node = el("div");
    function upd(k, v) { m[k] = v; onChange(); }

    node.appendChild(selectField("类型", REM_KINDS, m.kind, function (v) { upd("kind", v); }));
    node.appendChild(textField("名称", m.label, function (v) { upd("label", v); }, { placeholder: "例如：提交活动方案" }));
    node.appendChild(selectField("归属", OWNERS, m.owner, function (v) { upd("owner", v); }));

    if (m.kind === "alarm" || m.kind === "reminder") {
      node.appendChild(row2(
        textField("触发时间", m.time, function (v) { upd("time", v); }, { type: "datetime-local" }),
        selectField("时区", TZ_OPTS, m.tz, function (v) { upd("tz", v); })
      ));
    }
    if (m.kind === "timer") {
      node.appendChild(row2(
        textField("时长", m.duration, function (v) { upd("duration", v); }, { type: "number", min: "1" }),
        selectField("单位", DUR_UNITS, m.unit, function (v) { upd("unit", v); })
      ));
    }
    if (m.kind === "world-clock") {
      node.appendChild(selectField("时区", TZ_OPTS, m.tz, function (v) { upd("tz", v); }));
    }
    if (m.owner === "system") {
      node.appendChild(textField("系统通道引用", m.channel, function (v) { upd("channel", v); }, { placeholder: "例如：alarmapp:com.android.deskclock" }));
    }
    node.appendChild(selectField("提醒权限", PERMS, m.permission, function (v) { upd("permission", v); }, "权限非「已授权」时不会触发，也不会标为已设置"));
    return node;
  }

  function buildResearch(m, onChange) {
    var node = el("div");
    function upd(k, v) { m[k] = v; onChange(); }

    node.appendChild(textField("来源标题", m.title, function (v) { upd("title", v); }));
    node.appendChild(textField("原址", m.uri, function (v) { upd("uri", v); }, { placeholder: "https:// / content:// / app:// / ref://", hint: "不接受电脑绝对路径" }));
    node.appendChild(selectField("查询范围", QUERY_SCOPES, m.queryScope, function (v) { upd("queryScope", v); }));
    node.appendChild(selectField("来源状态", SRC_STATES, m.state, function (v) { upd("state", v); }));

    if (m.state === "read" || m.state === "partial" || m.state === "expired" || m.state === "conflict" || m.state === "inaccessible") {
      node.appendChild(textField("读取时间", m.fetchedAt, function (v) { upd("fetchedAt", v); }, { hint: "可留空（未读取项不得填写）" }));
      node.appendChild(areaField("证据片段", m.evidence, function (v) { upd("evidence", v); }, { hint: "结论需能指向具体片段" }));
    }
    if (m.state === "conflict") {
      node.appendChild(areaField("冲突来源", m.conflicts, function (v) { upd("conflicts", v); }, { hint: "多个用空格 / 逗号分隔" }));
    }
    node.appendChild(checkField("这是用户的私有资料", m.isPrivate, function (v) { upd("isPrivate", v); }));
    return node;
  }

  /* ------------------------------------------------------------------ *
   * 6. 提交（桥存在走内核；否则本地演练；断流/超时 ⇒ 结果未知）
   * ------------------------------------------------------------------ */

  function dispatch(ctx, op, onStatus) {
    var bridge = ctx.bridge || {};
    var commandId = op.commandId;
    var settled = false;
    var timer = null;

    function done(state, text) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      onStatus(state, text);
    }

    onStatus("loading", "已提交内核，等待回执…");

    // 订阅下行事件：终局用于收敛；中间态不冒充完成。
    if (typeof bridge.subscribe === "function") {
      try {
        bridge.subscribe(function (ev) {
          var e = parse(ev);
          if (!e) return;
          if (e.commandId && commandId && e.commandId !== commandId) return;
          if (e.error) { done("error", (e.error.code || "error") + "：" + (e.error.message || "内核拒绝")); return; }
          var st = e.status;
          if (st === "cancelled") { done("cancelled", "动作已取消，未产生写入。"); return; }
          if (st === "unknown" || st === "progressUnknown") { done("unknown", UNKNOWN_MSG); return; }
          if (e.text || (e.payload && e.payload.text)) { done("ok", e.text || e.payload.text); return; }
          if (st && st !== "completed" && st !== "succeeded") { onStatus("loading", "内核状态：" + st + "…"); }
        });
      } catch (e) { /* 订阅失败不阻塞提交；由超时兜底为未知 */ }
    }

    var res;
    try {
      res = bridge.submit(op);
    } catch (e) {
      done("error", "桥调用异常：" + (e && e.message ? e.message : String(e)));
      return;
    }

    function handle(r) {
      var p = parse(r);
      if (!p) { done("unknown", "收到无法解析的回执，结果未知。"); return; }
      if (p.error) { done("error", (p.error.code || "error") + "：" + (p.error.message || "内核拒绝")); return; }
      var st = p.status;
      if (st === "cancelled") { done("cancelled", "动作已取消，未产生写入。"); return; }
      if (st === "unknown" || st === "progressUnknown" || st === "pending") { done("unknown", UNKNOWN_MSG); return; }
      if (p.text) { done("ok", p.text); return; }
      if (p.payload && p.payload.text) { done("ok", p.payload.text); return; }
      if (st === "succeeded" || st === "completed") { done("ok", "内核已受理" + (p.commandId ? "（" + p.commandId + "）" : "") + "。"); return; }
      done("ok", "内核已受理" + (p.commandId ? "（" + p.commandId + "）" : "") + "；结果以稍后回执为准。");
    }

    if (res && typeof res.then === "function") {
      res.then(handle, function (e) { done("error", "桥承诺被拒绝：" + (e && e.message ? e.message : String(e))); });
    } else {
      handle(res);
    }

    // 超时 ⇒ 结果未知（不静默重试、不伪造成功）。
    timer = setTimeout(function () { done("unknown", UNKNOWN_MSG); }, 8000);
  }

  /* ------------------------------------------------------------------ *
   * 7. 渲染
   * ------------------------------------------------------------------ */

  function bridgeBanner(ctx) {
    var live = bridgeLive(ctx);
    var bar = el("div", "sa-status" + (live ? " ok" : " off"));
    bar.setAttribute("role", "status");
    var dot = el("span", "sa-dot"); bar.appendChild(dot);
    bar.appendChild(el("span", null, live
      ? "已连接处理服务：提交会送达服务"
      : "当前没有连接到处理服务"));
    return bar;
  }

  function tabBar(st, ctx, root) {
    var bar = el("div", "sa-tabs");
    bar.setAttribute("role", "tablist");
    [["calendar", "日历"], ["reminder", "提醒"], ["research", "来源"]].forEach(function (t) {
      var b = el("button", "sa-tab", t[1]);
      b.type = "button";
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", st.kind === t[0] ? "true" : "false");
      b.addEventListener("click", function () {
        if (st.kind === t[0]) return;
        st.kind = t[0];
        st.result = null;
        st.deleting = false;
        render(root, ctx);
      });
      bar.appendChild(b);
    });
    return bar;
  }

  function kvList(rows) {
    var list = el("div", "sa-kvbox");
    rows.forEach(function (r) {
      var row = el("div", "sa-kv");
      row.appendChild(el("span", "sa-k", r[0]));
      row.appendChild(el("span", "sa-v", r[1]));
      list.appendChild(row);
    });
    return list;
  }

  function warnList(evaluation) {
    var box = el("div", "sa-warns");
    evaluation.errors.forEach(function (msg) {
      var w = el("p", "sa-warn error");
      w.setAttribute("role", "alert");
      w.textContent = "错误 · " + msg;
      box.appendChild(w);
    });
    evaluation.warnings.forEach(function (w) {
      var p = el("p", "sa-warn " + w[0]);
      p.setAttribute("role", "status");
      p.textContent = w[1];
      box.appendChild(p);
    });
    return box;
  }

  function resultCard(st, ctx, root) {
    var r = st.result;
    if (!r) return null;
    var card = el("div", "sa-result sa-result-" + r.state);
    card.setAttribute("role", "status");
    var badge = el("span", "sa-badge " + r.state);
    badge.textContent = r.state === "ok" ? "已受理" : r.state === "unknown" ? "结果未知" : r.state === "cancelled" ? "已取消" : r.state === "loading" ? "提交中" : "失败";
    var top = el("div", "sa-result-top");
    top.appendChild(badge);
    if (!bridgeLive(ctx)) top.appendChild(el("span", "sa-mini", "本地演练 · 非真实内核"));
    card.appendChild(top);
    card.appendChild(el("p", "sa-result-text", r.text || ""));
    if (r.state === "unknown") {
      card.appendChild(el("p", "sa-mini", "可稍后在同一对话内核对；不会自动重复创建。"));
    }
    var back = el("button", "sa-btn secondary", "返回对话");
    back.type = "button";
    back.addEventListener("click", function () { returnToChat(ctx); });
    card.appendChild(back);
    return card;
  }

  function returnToChat(ctx) {
    try {
      if (typeof ctx.navigate === "function") ctx.navigate("chat");
    } catch (e) { /* 无导航能力时静默 */ }
  }

  function render(root, ctx) {
    ctx = ctx || {};
    ctx.state = ctx.state || {};
    ensureStyle();
    root.innerHTML = "";

    var st = getSA(ctx);
    var kind = st.kind;
    var model = st.models[kind];

    var wrap = el("section", "sa-wrap");
    wrap.setAttribute("aria-label", "系统动作");

    wrap.appendChild(bridgeBanner(ctx));
    wrap.appendChild(el("h2", "sa-title", "系统动作"));
    wrap.appendChild(el("p", "sa-sub", "日历、提醒与资料的专属详情。完成后可返回对话。"));
    wrap.appendChild(tabBar(st, ctx, root));

    var card = el("div", "sa-card");
    var statusBox = el("div", "sa-statusbox");
    var warnBox = el("div", "sa-warns");
    var previewBox = el("div", "sa-preview");
    var actionsBar = el("div", "sa-actions");
    var submitBtn = el("button", "sa-btn primary");
    submitBtn.type = "button";
    var backBtn = el("button", "sa-btn secondary", "返回对话");
    backBtn.type = "button";
    backBtn.addEventListener("click", function () { returnToChat(ctx); });

    function currentEval() {
      if (kind === "calendar") return evalCalendar(model);
      if (kind === "reminder") return evalReminder(model);
      return evalResearch(model);
    }

    function paint() {
      var ev = currentEval();
      previewBox.innerHTML = "";
      previewBox.appendChild(el("h3", "sa-h3", "确认内容"));
      previewBox.appendChild(kvList(ev.summary));

      warnBox.innerHTML = "";
      var wl = warnList(ev);
      if (wl.childNodes.length) warnBox.appendChild(wl);

      submitBtn.textContent = ev.actionLabel;
      submitBtn.disabled = !ev.ok;
      submitBtn.setAttribute("aria-disabled", ev.ok ? "false" : "true");
    }

    function onChange() { paint(); }

    var formNode = kind === "calendar" ? buildCalendar(model, onChange)
      : kind === "reminder" ? buildReminder(model, onChange)
        : buildResearch(model, onChange);
    card.appendChild(formNode);

    // 提醒：动作效果表（dismiss ≠ delete，I-E / design-07 行 187）
    if (kind === "reminder") {
      var eff = el("div", "sa-effects");
      eff.appendChild(el("h3", "sa-h3", "动作效果（不把 dismiss 都标为删除）"));
      [["忽略本次", "跳过这一次触发，记录保留"],
       ["稍后提醒", "推迟本次触发，记录保留"],
       ["停用", "停止后续触发，记录保留、可再启用"],
       ["删除", "停止后续触发，并删除记录"]].forEach(function (p) {
        var li = el("div", "sa-effect");
        li.appendChild(el("span", "sa-effect-name", p[0]));
        li.appendChild(el("span", "sa-effect-desc", p[1]));
        eff.appendChild(li);
      });
      card.appendChild(eff);
    }

    card.appendChild(warnBox);
    card.appendChild(previewBox);

    // 来源：删除联动（RES-07–10；私有资料与来源删除联动）
    if (kind === "research") {
      var delWrap = el("div", "sa-delete");
      var delToggle = el("button", "sa-link", st.deleting ? "收起删除范围" : "删除来源…");
      delToggle.type = "button";
      delToggle.addEventListener("click", function () { st.deleting = !st.deleting; render(root, ctx); });
      delWrap.appendChild(delToggle);
      if (st.deleting) {
        var scopeCard = el("div", "sa-scopecard");
        scopeCard.appendChild(el("p", "sa-mini", "删除来源前必须逐类声明关联对象的处理方式（级联删除 / 保留）。"));
        var scopeModel = st.delScope || (st.delScope = { index: "retain", snippet: "retain", citations: "retain", derivedFacts: "retain", confirmed: false });
        [["index", "索引"], ["snippet", "证据片段"], ["citations", "引用与结论"], ["derivedFacts", "派生事实"]].forEach(function (f) {
          scopeCard.appendChild(selectField(f[1], [["cascade", "级联删除"], ["retain", "保留"]], scopeModel[f[0]], function (v) { scopeModel[f[0]] = v; }));
        });
        scopeCard.appendChild(checkField("我确认以上删除范围", scopeModel.confirmed, function (v) { scopeModel.confirmed = v; }));
        var delBtn = el("button", "sa-btn destructive", "确认删除来源");
        delBtn.type = "button";
        delBtn.disabled = !scopeModel.confirmed;
        delBtn.addEventListener("click", function () {
          runSubmit(ctx, model, { ok: true, actionLabel: "删除来源", errors: [], warnings: [], summary: [], command: function () {
            return { schemaVersion: "mobile-v1", commandId: newId(), idempotencyKey: idOf("source-delete", model.sourceId), operation: "delete", payload: { kind: "research-source-delete", sourceId: model.sourceId, scope: { index: scopeModel.index, snippet: scopeModel.snippet, citations: scopeModel.citations, derivedFacts: scopeModel.derivedFacts } } };
          } }, st, kind, setResult);
        });
        scopeCard.appendChild(delBtn);
        if (model.isPrivate) scopeCard.appendChild(el("p", "sa-mini", "该来源为私有资料，删除会联动其引用与派生事实。"));
        delWrap.appendChild(scopeCard);
      }
      card.appendChild(delWrap);
    }

    card.appendChild(statusBox);
    actionsBar.appendChild(submitBtn);
    actionsBar.appendChild(backBtn);
    card.appendChild(actionsBar);

    function setResult(state, text) {
      st.result = { state: state, text: text };
      var rc = resultCard(st, ctx, root);
      // 就地替换：移除旧结果卡，插入新结果卡（不整屏重渲染，保留草稿焦点）。
      var old = wrap.querySelector(".sa-result");
      if (old) old.parentNode.removeChild(old);
      if (rc) card.insertBefore(rc, statusBox);
      submitBtn.disabled = state === "loading";
    }

    submitBtn.addEventListener("click", function () {
      var ev = currentEval();
      if (!ev.ok) { paint(); statusBox.textContent = "请先修正表单中的错误。"; statusBox.className = "sa-statusbox error"; return; }
      runSubmit(ctx, model, ev, st, kind, setResult);
    });

    wrap.appendChild(card);

    // 能力边界（诚实标注）
    var foot = el("p", "sa-footnote", footNote(kind));
    wrap.appendChild(foot);

    root.appendChild(wrap);
    paint();

    // 重放既有结果（切换 tab 前保留）
    if (st.result) {
      var rc0 = resultCard(st, ctx, root);
      if (rc0) card.insertBefore(rc0, statusBox);
    }
  }

  function runSubmit(ctx, model, ev, st, kind, setResult) {
    var live = bridgeLive(ctx);
    if (!live) {
      setResult("warn", "未连接处理服务：这次提交没有发出，也没有写入任何内容。");
      return;
    }
    var op = ev.command();
    dispatch(ctx, op, function (state, text) { setResult(state, text); });
  }

  function footNote(kind) {
    if (kind === "calendar") {
      return "边界：本界面未接入真实日历账号写入；未授权账号会如实标为「未授权，无法写入」。相对时间（如「明天上午」）不得作为最终执行摘要，须先解析为绝对日期 / 时间 / 时区。";
    }
    if (kind === "reminder") {
      return "边界：系统提醒通道由目标时钟应用的系统接口决定，可能不受支持；权限非「已授权」时提醒未生效，不标为已设置。自管与系统归属分别验收。";
    }
    return "边界：本界面未接入真实检索端口；未读取的来源不得携带证据，冲突来源必须并列展示，私有资料删除会联动其引用与派生事实。";
  }

  window.PB.screens[KEY] = { title: "系统动作", render: render };
})();
