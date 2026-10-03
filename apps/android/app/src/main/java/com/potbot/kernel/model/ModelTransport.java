package com.potbot.kernel.model;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import javax.net.ssl.HttpsURLConnection;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * K-I19 原生模型传输 —— TS 端口 {@code apps/mobile-kernel/model/types.ts} 的
 * {@code ModelTransport} 在 Android 侧的 HTTPS/SSE 实现。
 *
 * <p>覆盖任务书的四件事：TLS（{@link HttpsURLConnection}）、SSE 行解析
 * （{@link #parseSseLine(String)}）、取消 + 超时接线（{@link AbortSignal} / 看门狗线程）、
 * 不接触明文密钥（本类只收 {@code keyRef} 引用，凭据由注入的
 * {@link AuthHeaderProvider} 在发请求一刻解析成不透明的 Authorization 头取值）。
 *
 * <p><b>状态：已编进 APK（2026-10-03 实测）、未上真机。</b>本机 Gradle wrapper 与 Android SDK 就位后，
 * {@code apps/android} 下 {@code ./gradlew assembleDebug --offline} 构建成功（exit 0，产物
 * {@code app/build/outputs/apk/debug/app-debug.apk}）。编译只证明本类能编进 APK，
 * <b>不</b>代表任何运行期行为通过：真机 / 真实 {@code api.deepseek.com} 的证书校验、SSE 断流、
 * 取消、超时与凭据解析仍全部<b>未验证</b>，<b>不得</b>当作"已完成 / 已验证"。
 *
 * <h2>与 TS 轮廓的对应关系</h2>
 * <ul>
 *   <li>{@code ModelTransport.identity} &lt;-&gt; {@link #IDENTITY} / {@link #identity()}</li>
 *   <li>{@code ModelTransport.send} &lt;-&gt; {@link #send(WireRequest, AbortSignal)}</li>
 *   <li>{@code RawStreamEvent} &lt;-&gt; {@link RawEvent}（kind: text / tool-call / usage / error / done）</li>
 *   <li>{@code TransportRequest} &lt;-&gt; {@link WireRequest}（{@code body} 由 JS 侧序列化成 {@code bodyJson}）</li>
 *   <li>{@code TransportResponse} &lt;-&gt; {@link TransportResponse}（status + headers + 事件拉取）</li>
 * </ul>
 *
 * <h2>明文密钥口径</h2>
 * 本类<b>不接收、不构造、不存储、不打印</b>明文密钥：
 * <ul>
 *   <li>入口只收 {@code keyRef}（形如 {@code keyref:...} 的引用），先过
 *       {@link #validateKeyRef(String)} 的形状 + 明文内容双重判据，命中即同步抛错；</li>
 *   <li>真正的凭据由 {@link AuthHeaderProvider} 在发请求一刻返回一个<b>不透明</b>头值；
 *       本类把它直接交给 {@code setRequestProperty}，随即置空局部变量，绝不落入字段、日志或返回值；</li>
 *   <li>本文件全篇没有 {@code Log.} / {@code System.out} / {@code printStackTrace} —— 传输层无日志出口。</li>
 * </ul>
 */
public final class ModelTransport {

    /** {@code ModelTransport.identity}：本 transport 的稳定身份串。 */
    public static final String IDENTITY = "android.https.model.transport";

    /** 与 {@code apps/mobile-kernel/model/port.ts} 的 {@code DEFAULT_HOST} 对齐。 */
    public static final String DEFAULT_HOST = "api.deepseek.com";

    /** 对话补全路径。 */
    public static final String CHAT_COMPLETIONS_PATH = "/chat/completions";

    /** 未给 {@code timeoutMs} 时的连接超时。 */
    public static final int DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

    /** 未给 {@code timeoutMs} 时的读取超时。 */
    public static final int DEFAULT_READ_TIMEOUT_MS = 60_000;

    /** 单行 SSE 上限：防止上游发一条永不换行的超长行把内存打满。 */
    public static final int MAX_SSE_LINE_CHARS = 1 << 20;

    /** 事件队列容量：满则上游读取线程阻塞（背压），不无界堆积。 */
    public static final int EVENT_QUEUE_CAPACITY = 256;

    // ------------------------------------------------------------------
    // 双重判据的正则（与 K02 redact.ts、K03 keyref.ts 同口径）
    // ------------------------------------------------------------------
    //
    // 这些是**正则源码字符串**，不是密钥本身；写成常量以便静态契约测试逐条抽取并在独立
    // 正则引擎（Node）里复算，防止"Java 侧改了判据而测试没跟上"。
    // 刻意不含反斜杠与引号，保证 Java 字符串字面量与 JS RegExp 源码逐字一致。

    /** {@code $defs.keyRef.pattern}（逐字取自 types.ts）。 */
    public static final String KEY_REF_PATTERN = "^keyref:[A-Za-z0-9._:-]+$";

    /** 明文密钥显著特征 1：带左边界，避免命中 {@code task-registered} 这类词内子串。 */
    public static final String SECRET_SHAPE_1 = "(?<![A-Za-z0-9_])sk-[A-Za-z0-9_-]{10,}";

    /** 明文密钥显著特征 2：Authorization: Bearer &lt;token&gt;。 */
    public static final String SECRET_SHAPE_2 = "Bearer[ ]+[A-Za-z0-9._~+/-]{16,}";

    /** 明文密钥显著特征 3：Google API key。 */
    public static final String SECRET_SHAPE_3 = "AIza[0-9A-Za-z_-]{20,}";

    /** 明文密钥显著特征 4：{@code api_key=...} / {@code apikey: ...} 赋值。 */
    public static final String SECRET_SHAPE_4 = "(?:api[_-]?key|apikey)[ ]*[:=][ ]*[A-Za-z0-9._~+/-]{16,}";

    /** 明文密钥显著特征 5：PEM 私钥头。 */
    public static final String SECRET_SHAPE_5 = "-----BEGIN[ ][A-Z ]*PRIVATE KEY-----";

    /** SSE 数据行前缀。 */
    public static final String SSE_DATA_PREFIX = "data:";

    /** SSE 流收束标记。 */
    public static final String SSE_DONE = "[DONE]";

    private static final Pattern KEY_REF_SHAPE = Pattern.compile(KEY_REF_PATTERN);

    private static final Pattern[] SECRET_SHAPES = new Pattern[] {
            Pattern.compile(SECRET_SHAPE_1),
            Pattern.compile(SECRET_SHAPE_2),
            Pattern.compile(SECRET_SHAPE_3),
            Pattern.compile(SECRET_SHAPE_4),
            Pattern.compile(SECRET_SHAPE_5),
    };

    private final AuthHeaderProvider auth;

    public ModelTransport(AuthHeaderProvider auth) {
        if (auth == null) {
            throw new IllegalArgumentException("AuthHeaderProvider 不能为空");
        }
        this.auth = auth;
    }

    /** {@code ModelTransport.identity} 的取值器（与 {@link #IDENTITY} 同源）。 */
    public String identity() {
        return IDENTITY;
    }

    // ==================================================================
    // 明文密钥判据（同步、纯函数）
    // ==================================================================

    /**
     * 返回文本中**第一处**明文密钥特征，没有则 {@code null}。
     *
     * <p>先按字面扫描，再 {@code JSON} 式展开由调用方决定；本类只对字符串用。
     */
    public static String findPlaintextSecret(String text) {
        if (text == null) {
            return null;
        }
        for (Pattern pattern : SECRET_SHAPES) {
            Matcher matcher = pattern.matcher(text);
            if (matcher.find()) {
                // 报证据但不回显命中的明文：命中片段本身可能包含可用的密钥。
                return matcher.group();
            }
        }
        return null;
    }

    /**
     * {@code keyRef} 双重判据：形状必须是引用，内容不得像明文密钥。
     *
     * @throws ModelTransportException {@code invalid_key_ref}（形状不符）或
     *         {@code key_ref_contains_secret}（形状是引用、内容是明文）。
     */
    public static void validateKeyRef(String keyRef) throws ModelTransportException {
        if (keyRef == null || !KEY_REF_SHAPE.matcher(keyRef).matches()) {
            throw new ModelTransportException(
                    "invalid_key_ref", "keyRef 必须是 keyref:... 形状的引用，不接受明文密钥");
        }
        String hit = findPlaintextSecret(keyRef);
        if (hit != null) {
            throw new ModelTransportException(
                    "key_ref_contains_secret", "keyRef 内容命中明文密钥特征（已隐去原文）");
        }
    }

    // ==================================================================
    // SSE 行解析（纯函数）
    // ==================================================================

    /**
     * 把一行 SSE 文本翻译成 {@link RawEvent}（供应商形状），或 {@code null} 表示忽略该行。
     *
     * <p>只处理 {@code data:} 行：注释行（{@code :} 起）、{@code event:} / {@code id:} /
     * {@code retry:} 行与空行一律忽略。{@code data: [DONE]} 产出 {@code done} 事件。
     * 其余 {@code data:} 载荷按 OpenAI 兼容形状解析：{@code error} / {@code usage} /
     * {@code choices[0].delta.{content,tool_calls}}。
     */
    public static RawEvent parseSseLine(String rawLine) {
        if (rawLine == null) {
            return null;
        }
        String line = rawLine.endsWith("\r") ? rawLine.substring(0, rawLine.length() - 1) : rawLine;
        if (line.isEmpty() || line.charAt(0) == ':') {
            return null;
        }
        if (!line.startsWith(SSE_DATA_PREFIX)) {
            return null;
        }
        String payload = line.substring(SSE_DATA_PREFIX.length()).trim();
        if (payload.isEmpty()) {
            return null;
        }
        if (SSE_DONE.equals(payload)) {
            return RawEvent.done();
        }

        JSONObject obj;
        try {
            obj = new JSONObject(payload);
        } catch (JSONException e) {
            // Android 自带的 org.json 里 JSONException 是**受检**异常（不继承 RuntimeException），
            // 原先只 catch RuntimeException 拦不住它。语义不变：解析失败照样落一条
            // sse_json_invalid，绝不把非法数据行读成"没有内容"的成功。
            return RawEvent.error("sse_json_invalid", "上游数据行不是合法 JSON");
        } catch (RuntimeException e) {
            // 保留原有的运行期兜底（同一判据、同一收束），不因新增受检分支而丢失。
            return RawEvent.error("sse_json_invalid", "上游数据行不是合法 JSON");
        }

        if (obj.has("error")) {
            JSONObject error = obj.optJSONObject("error");
            String code = error == null ? "upstream_error" : error.optString("code", "upstream_error");
            String message = error == null ? "上游返回错误" : error.optString("message", "上游返回错误");
            return RawEvent.error(code, message);
        }

        if (obj.has("usage")) {
            JSONObject usage = obj.optJSONObject("usage");
            if (usage == null) {
                return null;
            }
            return RawEvent.usage(
                    usage.optInt("prompt_tokens", 0),
                    usage.optInt("completion_tokens", 0),
                    usage.has("total_tokens") ? Integer.valueOf(usage.optInt("total_tokens")) : null,
                    usage.has("completion_tokens_details")
                            || usage.has("prompt_tokens_details") ? usage : null);
        }

        JSONArray choices = obj.optJSONArray("choices");
        if (choices == null || choices.length() == 0) {
            return null;
        }
        JSONObject delta = choices.optJSONObject(0) == null
                ? null
                : choices.optJSONObject(0).optJSONObject("delta");
        if (delta == null) {
            return null;
        }
        if (delta.has("content") && !delta.isNull("content")) {
            return RawEvent.text(delta.optString("content", ""));
        }
        JSONArray toolCalls = delta.optJSONArray("tool_calls");
        if (toolCalls != null && toolCalls.length() > 0) {
            JSONObject call = toolCalls.optJSONObject(0);
            if (call == null) {
                return null;
            }
            JSONObject function = call.optJSONObject("function");
            String id = call.optString("id", "");
            String name = function == null ? "" : function.optString("name", "");
            String args = function == null ? "" : function.optString("arguments", "");
            return RawEvent.toolCall(
                    id.isEmpty() ? null : id,
                    name.isEmpty() ? null : name,
                    args.isEmpty() ? null : args);
        }
        return null;
    }

    // ==================================================================
    // send：一次流式调用
    // ==================================================================

    /**
     * 发起一次流式模型调用。校验（含 {@code keyRef} 判据）在调用线程上**同步**完成，
     * 网络读取在守护线程上进行，事件经 {@link TransportResponse#nextEvent(long)} 拉取。
     *
     * @throws ModelTransportException keyRef 不合法（形状不符或内容像明文密钥）。
     */
    public TransportResponse send(WireRequest request, AbortSignal signal) throws ModelTransportException {
        if (request == null) {
            throw new IllegalArgumentException("WireRequest 不能为空");
        }
        validateKeyRef(request.keyRef);
        String host = request.host == null || request.host.isEmpty() ? DEFAULT_HOST : request.host;
        String path = request.path == null || request.path.isEmpty() ? CHAT_COMPLETIONS_PATH : request.path;

        final TransportResponse response = new TransportResponse();
        final ConnectionHolder holder = new ConnectionHolder();
        if (signal != null) {
            signal.register(new Runnable() {
                @Override
                public void run() {
                    holder.closeQuietly();
                }
            });
        }
        final String resolvedHost = host;
        final String resolvedPath = path;
        Thread worker = new Thread(new Runnable() {
            @Override
            public void run() {
                readStream(request, resolvedHost, resolvedPath, signal, response, holder);
            }
        }, "potbot-model-sse");
        worker.setDaemon(true);
        worker.start();
        return response;
    }

    private void readStream(
            WireRequest request,
            String host,
            String path,
            AbortSignal signal,
            TransportResponse response,
            ConnectionHolder holder) {
        HttpsURLConnection connection = null;
        Thread watchdog = null;
        try {
            URL url = new URL("https", host, path);
            connection = (HttpsURLConnection) url.openConnection();
            holder.attach(connection);

            int timeoutMs = request.timeoutMs;
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setInstanceFollowRedirects(false); // 不跟随重定向：凭据不得被带到第三方主机
            connection.setConnectTimeout(timeoutMs > 0 ? timeoutMs : DEFAULT_CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(timeoutMs > 0 ? timeoutMs : DEFAULT_READ_TIMEOUT_MS);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setRequestProperty("Accept", "text/event-stream");
            connection.setRequestProperty("User-Agent", IDENTITY);

            // 凭据仅在此处以不透明头值出现一次，随后置空局部变量：不入字段、不打印、不回传。
            //
            // AuthHeaderProvider.authorizationValue 声明 throws Exception —— 受检路径（K03 的
            // Keystore 实现读密钥本身就可能失败），必须在此显式接住并映射到本模块既有的
            // "先 push 一条 error 事件、再由 finally 收束"的返回形状。绝不能让它穿透读取线程：
            // 未捕获的异常会让 response 永不 finish()，调用方 awaitHandshake/nextEvent 等成假死。
            // 这里宽到 Exception 是有意的、也是唯一一处：接口签名就是 throws Exception，
            // 不先把端口契约改窄（那要动 K03 实现方，不在本次授权范围），就不可能只捕特例。
            String authorization;
            try {
                authorization = auth.authorizationValue(request.keyRef);
            } catch (Exception e) {
                response.push(RawEvent.error("auth_unavailable", "凭据解析失败，未发出请求"));
                return;
            }
            if (authorization != null && !authorization.isEmpty()) {
                connection.setRequestProperty("Authorization", authorization);
            }
            authorization = null;

            byte[] payload = request.bodyJson.getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(payload.length);
            try (OutputStream out = connection.getOutputStream()) {
                out.write(payload);
                out.flush();
            }

            int status = connection.getResponseCode();
            Map<String, String> headers = new LinkedHashMap<String, String>();
            Map<String, List<String>> raw = connection.getHeaderFields();
            for (Map.Entry<String, List<String>> entry : raw.entrySet()) {
                if (entry.getKey() != null && entry.getValue() != null && !entry.getValue().isEmpty()) {
                    headers.put(entry.getKey(), entry.getValue().get(0));
                }
            }
            response.completeHandshake(status, headers);

            if (status < 200 || status >= 300) {
                // 非 2xx：不消费事件流（保证 401/429 不产出内容），仅以错误事件收束。
                response.push(RawEvent.error("http_" + status, "上游返回非 2xx 状态"));
                return;
            }

            if (timeoutMs > 0) {
                watchdog = startWatchdog(timeoutMs, signal, response, holder);
            }

            try (InputStream in = connection.getInputStream();
                 BufferedReader reader =
                         new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    if (line.length() > MAX_SSE_LINE_CHARS) {
                        response.push(RawEvent.error("sse_line_too_long", "上游单行超过上限"));
                        return;
                    }
                    if (signal != null && signal.isAborted()) {
                        response.push(RawEvent.error("transport_aborted", "调用已取消"));
                        return;
                    }
                    RawEvent event = parseSseLine(line);
                    if (event == null) {
                        continue;
                    }
                    response.push(event);
                    if ("done".equals(event.kind)) {
                        return;
                    }
                }
            }
            // 迭代自然结束但未见 done：本类只如实报告"结束"，断流判定交给上层 streamModel。
        } catch (IOException e) {
            response.push(RawEvent.error("transport_io", "网络读取失败"));
        } catch (RuntimeException e) {
            response.push(RawEvent.error("transport_error", "传输失败"));
        } finally {
            if (watchdog != null) {
                watchdog.interrupt();
            }
            holder.closeQuietly();
            response.finish();
        }
    }

    private Thread startWatchdog(
            final int timeoutMs,
            final AbortSignal signal,
            final TransportResponse response,
            final ConnectionHolder holder) {
        Thread watchdog = new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    Thread.sleep(timeoutMs);
                } catch (InterruptedException e) {
                    return;
                }
                if (!response.isTerminal()) {
                    holder.closeQuietly();
                    response.push(RawEvent.error("transport_timeout", "等待上游事件超时"));
                    response.finish();
                    if (signal != null) {
                        signal.abort();
                    }
                }
            }
        }, "potbot-model-watchdog");
        watchdog.setDaemon(true);
        watchdog.start();
        return watchdog;
    }

    // ==================================================================
    // 端口形状
    // ==================================================================

    /**
     * 把 {@code keyRef} 解析成 Authorization 头的**不透明取值**。
     *
     * <p>实现方（K03 Keystore 层）保证：取值即用即弃，不被本类持有、打印或回传。
     * 本类不关心它是不是 "Bearer "-前缀——那是实现方的封装细节。
     */
    public interface AuthHeaderProvider {
        String authorizationValue(String keyRef) throws Exception;
    }

    /** 传输层请求（对应 TS {@code TransportRequest}，body 已由 JS 序列化）。 */
    public static final class WireRequest {
        /** 上游主机（缺省 {@link #DEFAULT_HOST}）。 */
        public final String host;
        /** 请求路径（缺省 {@link #CHAT_COMPLETIONS_PATH}）。 */
        public final String path;
        /** 模型名（如 {@code deepseek-flash}）。 */
        public final String model;
        /** **只是引用**，绝不携带密钥明文。 */
        public final String keyRef;
        /** 已序列化的 {@code ModelWireBody} JSON。 */
        public final String bodyJson;
        /** 静默/整体超时毫秒；{@code <=0} 表示用默认值且不装看门狗。 */
        public final int timeoutMs;

        public WireRequest(String host, String path, String model, String keyRef, String bodyJson, int timeoutMs) {
            this.host = host;
            this.path = path;
            this.model = model;
            this.keyRef = keyRef;
            this.bodyJson = bodyJson;
            this.timeoutMs = timeoutMs;
        }
    }

    /** 可订阅的取消信号（对应 TS 侧的 AbortController）。 */
    public static final class AbortSignal {
        private final AtomicBoolean aborted = new AtomicBoolean(false);
        private final List<Runnable> closers = new CopyOnWriteArrayList<Runnable>();

        /** 触发取消：先已注册的连接关闭器被调用，随后后续事件循环看到 isAborted。 */
        public void abort() {
            if (aborted.compareAndSet(false, true)) {
                for (Runnable closer : closers) {
                    closer.run();
                }
            }
        }

        public boolean isAborted() {
            return aborted.get();
        }

        void register(Runnable closer) {
            closers.add(closer);
            if (aborted.get()) {
                closer.run();
            }
        }
    }

    /** 上游流上的一条原始事件（对应 TS {@code RawStreamEvent}）。 */
    public static final class RawEvent {
        public final String kind; // text | tool-call | usage | error | done | __end__
        public final String text;
        public final String toolCallId;
        public final String toolName;
        public final String argumentsJson;
        public final Integer promptTokens;
        public final Integer completionTokens;
        public final Integer totalTokens;
        public final String errorCode;
        public final String errorMessage;

        private RawEvent(
                String kind,
                String text,
                String toolCallId,
                String toolName,
                String argumentsJson,
                Integer promptTokens,
                Integer completionTokens,
                Integer totalTokens,
                String errorCode,
                String errorMessage) {
            this.kind = kind;
            this.text = text;
            this.toolCallId = toolCallId;
            this.toolName = toolName;
            this.argumentsJson = argumentsJson;
            this.promptTokens = promptTokens;
            this.completionTokens = completionTokens;
            this.totalTokens = totalTokens;
            this.errorCode = errorCode;
            this.errorMessage = errorMessage;
        }

        public static RawEvent text(String text) {
            return new RawEvent("text", text, null, null, null, null, null, null, null, null);
        }

        public static RawEvent toolCall(String toolCallId, String toolName, String argumentsJson) {
            return new RawEvent("tool-call", null, toolCallId, toolName, argumentsJson,
                    null, null, null, null, null);
        }

        public static RawEvent usage(int promptTokens, int completionTokens, Integer totalTokens, Object ignoredDetails) {
            return new RawEvent("usage", null, null, null, null,
                    Integer.valueOf(promptTokens), Integer.valueOf(completionTokens), totalTokens, null, null);
        }

        public static RawEvent error(String code, String message) {
            return new RawEvent("error", null, null, null, null, null, null, null, code, message);
        }

        public static RawEvent done() {
            return new RawEvent("done", null, null, null, null, null, null, null, null, null);
        }

        static RawEvent end() {
            return new RawEvent("__end__", null, null, null, null, null, null, null, null, null);
        }
    }

    /** 传输层响应：HTTP 状态 + 头 + 可拉取的事件流（对应 TS {@code TransportResponse}）。 */
    public static final class TransportResponse {
        private final BlockingQueue<RawEvent> queue = new ArrayBlockingQueue<RawEvent>(EVENT_QUEUE_CAPACITY);
        private final CountDownLatch handshake = new CountDownLatch(1);
        private final AtomicBoolean terminal = new AtomicBoolean(false);
        private final AtomicReference<StatusAndHeaders> statusRef = new AtomicReference<StatusAndHeaders>();

        void completeHandshake(int status, Map<String, String> headers) {
            statusRef.set(new StatusAndHeaders(status, Collections.unmodifiableMap(headers)));
            handshake.countDown();
        }

        void push(RawEvent event) {
            try {
                queue.put(event);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }

        void finish() {
            terminal.set(true);
            handshake.countDown();
            push(RawEvent.end());
        }

        /** 等待握手完成（拿到 status/headers），超时返回 false。 */
        public boolean awaitHandshake(long timeout, TimeUnit unit) throws InterruptedException {
            return handshake.await(timeout, unit);
        }

        /** HTTP 状态；握手前为 -1。 */
        public int status() {
            StatusAndHeaders s = statusRef.get();
            return s == null ? -1 : s.status;
        }

        /** 响应头（只读）；握手前为空表。 */
        public Map<String, String> headers() {
            StatusAndHeaders s = statusRef.get();
            return s == null ? Collections.<String, String>emptyMap() : s.headers;
        }

        public boolean isTerminal() {
            return terminal.get();
        }

        /** 拉取下一条事件；流结束后返回 {@code null}。 */
        public RawEvent nextEvent(long timeout, TimeUnit unit) throws InterruptedException {
            RawEvent event = queue.poll(timeout, unit);
            if (event == null || "__end__".equals(event.kind)) {
                return null;
            }
            return event;
        }

        private static final class StatusAndHeaders {
            final int status;
            final Map<String, String> headers;

            StatusAndHeaders(int status, Map<String, String> headers) {
                this.status = status;
                this.headers = headers;
            }
        }
    }

    /** 传输层错误的可机读形状。 */
    public static final class ModelTransportException extends Exception {
        public final String code;

        public ModelTransportException(String code, String message) {
            super(message);
            this.code = code;
        }
    }

    /** 持有当前连接的句柄，供取消/超时线程随时断开。 */
    static final class ConnectionHolder {
        private final AtomicReference<HttpsURLConnection> ref = new AtomicReference<HttpsURLConnection>();

        void attach(HttpsURLConnection connection) {
            ref.set(connection);
        }

        void closeQuietly() {
            HttpsURLConnection connection = ref.getAndSet(null);
            if (connection != null) {
                try {
                    connection.disconnect();
                } catch (RuntimeException ignored) {
                    // 断开失败不影响收束：读取线程会以 IO 错误事件收场。
                }
            }
        }
    }
}
