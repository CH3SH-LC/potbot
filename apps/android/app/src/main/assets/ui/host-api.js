/*
 * host-api.js —— 手机壳原生 JSON 通道（window.PotbotHost）的页面侧封装。
 *
 * 为什么需要它：页面由 file:///android_asset/ui/index.html 加载，其源是 "null"，
 * 电脑侧后端不发 CORS 头，因此页面**不能**用 fetch/XHR 访问 http://127.0.0.1:8765。
 * 宿主（MainActivity）注入 window.PotbotHost，由**原生**发起 HTTP，绕开同源限制：
 *
 *   PotbotHost.getJson(path)             -> JSON 字符串
 *   PotbotHost.postJson(path, bodyJson)  -> JSON 字符串
 *
 * path 形如 "/api/xxx"；端点在原生侧配置（默认 http://127.0.0.1:8765）。
 * 失败时原生返回形如 {"ok":false,"error":"..."} 的 JSON 对象。
 *
 * 本文件只做三件事，不多做：
 *   1. 能力探测：`typeof window.PotbotHost?.postJson === 'function'`（经典脚本写法；
 *      WebView file:// 下禁止 ES module，也禁止可选链之外的现代语法时仍要能跑）。
 *   2. 把原生返回的字符串/对象/thenable 统一成**不抛异常**的结果对象：
 *        { ok:boolean, data:any, error:{code,message,retryable}|null }
 *   3. 原样转发，不缓存、不改写路径、不重试、不伪造成功。
 *
 * 对外面：window.PB.host = { available, detect(), get(path), post(path, body), describe() }
 * 宿主不存在时 available === false，调用方必须据此如实降级（不得假装成功）。
 */
(function () {
  "use strict";

  var PB = (window.PB = window.PB || {});

  /* 宿主可能给本对象起的全局名（正式名 PotbotHost） */
  var API_NAMES = ["PotbotHost"];

  var host = null;

  function resolveHost() {
    for (var i = 0; i < API_NAMES.length; i++) {
      var candidate = null;
      try { candidate = window[API_NAMES[i]]; } catch (e) { candidate = null; }
      if (!candidate) continue;
      if (typeof candidate.postJson !== "function") continue;
      if (typeof candidate.getJson !== "function") continue;
      return candidate;
    }
    return null;
  }

  function detect() {
    host = resolveHost();
    return !!host;
  }

  function fail(code, message, retryable) {
    return {
      ok: false,
      data: null,
      error: { code: code, message: message, retryable: retryable !== false }
    };
  }

  /** 从各种错误载荷里取一句给人看的话；取不到就给中性文案，不编造原因。 */
  function messageOf(payload, fallback) {
    if (typeof payload === "string" && payload.trim()) return payload.trim();
    if (payload && typeof payload === "object") {
      if (typeof payload.error === "string" && payload.error.trim()) return payload.error.trim();
      if (payload.error && typeof payload.error === "object") {
        if (typeof payload.error.message === "string" && payload.error.message) return payload.error.message;
        if (typeof payload.error.code === "string" && payload.error.code) return payload.error.code;
      }
      if (typeof payload.message === "string" && payload.message) return payload.message;
      if (typeof payload.detail === "string" && payload.detail) return payload.detail;
    }
    return fallback || "本地服务没有接受这次请求。";
  }

  function codeOf(payload, fallback) {
    if (payload && typeof payload === "object") {
      if (payload.error && typeof payload.error === "object" && typeof payload.error.code === "string") {
        return payload.error.code;
      }
      if (typeof payload.code === "string" && payload.code) return payload.code;
    }
    return fallback || "host_error";
  }

  /**
   * 判断一份解析后的响应体是不是**通道层**的失败载荷。
   *
   * 只认两种形状：
   *   1. `{"ok":false, ...}`            —— 契约明写的失败形状；
   *   2. `{"error":"<字符串>", ...}`    —— 原生通道没有 `ok` 时用字符串错误表示失败。
   *
   * **不算**失败的是后端自己的业务响应：它会用对象形式的 `error`
   * （如任务失败时的 `{status:"failed", error:{code,message,retryable}}`），
   * 那是业务结论，由调用方按 status 判断，不能在这里被当成"没拿到响应"。
   */
  function looksFailed(data) {
    if (data === null || typeof data !== "object") return false;
    if (data.ok === false) return true;
    if (data.ok === undefined && typeof data.error === "string") return true;
    return false;
  }

  function interpret(raw) {
    if (raw === undefined || raw === null) {
      return fail("empty_response", "本地服务没有返回内容。");
    }
    var data = raw;
    if (typeof raw === "string") {
      var text = raw.trim();
      if (!text) return fail("empty_response", "本地服务没有返回内容。");
      try {
        data = JSON.parse(text);
      } catch (e) {
        return fail("bad_json", "本地服务返回的不是合法 JSON。");
      }
    }
    if (looksFailed(data)) {
      return {
        ok: false,
        data: data,
        error: {
          code: codeOf(data, "host_error"),
          message: messageOf(data, "本地服务拒绝了这次请求。"),
          retryable: !(data.error && typeof data.error === "object" && data.error.retryable === false)
        }
      };
    }
    /* 通道返回了 JSON，但内容是后端的错误体（HTTP 非 2xx）：照样按失败处理，
       并把服务端原话带出来，不把 {code,message} 当成一份"正常数据"。 */
    if (typeof data === "object" && data !== null && data.ok !== true &&
        data.error && typeof data.error === "object" && typeof data.error.message === "string" &&
        typeof data.taskId !== "string" && typeof data.status !== "string") {
      return {
        ok: false,
        data: data,
        error: {
          code: codeOf(data, "server_error"),
          message: messageOf(data, "本地服务拒绝了这次请求。"),
          retryable: data.error.retryable !== false
        }
      };
    }
    return { ok: true, data: data, error: null };
  }

  /** 原生方法可能同步返回，也可能是 thenable：两种都归一化，绝不抛。 */
  function settle(raw) {
    if (raw && typeof raw.then === "function") {
      return Promise.resolve(raw).then(
        function (value) { return interpret(value); },
        function (err) { return fail("host_threw", "本地服务调用失败：" + String((err && err.message) || err)); }
      );
    }
    return Promise.resolve(interpret(raw));
  }

  function callGet(path) {
    if (!host && !detect()) {
      return Promise.resolve(fail("host_absent", "当前环境没有可用的本地服务通道。", false));
    }
    var raw;
    try {
      raw = host.getJson(String(path));
    } catch (e) {
      return Promise.resolve(fail("host_threw", "本地服务调用失败：" + String((e && e.message) || e)));
    }
    return settle(raw);
  }

  function callPost(path, body) {
    if (!host && !detect()) {
      return Promise.resolve(fail("host_absent", "当前环境没有可用的本地服务通道。", false));
    }
    var bodyJson;
    try {
      bodyJson = (body === undefined || body === null) ? "{}" : JSON.stringify(body);
    } catch (e) {
      return Promise.resolve(fail("bad_body", "请求体无法序列化为 JSON。", false));
    }
    var raw;
    try {
      raw = host.postJson(String(path), bodyJson);
    } catch (e) {
      return Promise.resolve(fail("host_threw", "本地服务调用失败：" + String((e && e.message) || e)));
    }
    return settle(raw);
  }

  detect();

  var api = {
    get: callGet,
    post: callPost,
    detect: function () { detect(); return !!host; },
    describe: function () {
      return host ? "本地服务通道已就绪" : "本地服务通道不可用";
    }
  };

  Object.defineProperty(api, "available", {
    enumerable: true,
    get: function () { return !!host; }
  });

  PB.host = api;
})();
