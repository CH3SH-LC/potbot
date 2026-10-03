package com.potbot.kernel.runtime;

import android.os.Handler;
import android.util.Log;
import android.webkit.JavascriptInterface;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;

/**
 * K01 —— 受限本地 UI 桥（Android 侧 JS 接口）。
 *
 * ⚠️ 未编译、未安装、未在真机验证（本机无 Android SDK / NDK / gradle wrapper / adb）。
 * 本类与 `apps/mobile-kernel/bootstrap/bridge.ts` 是同一契约的两个面：
 *   TS 侧是权威实现（被 51 条测试覆盖），本侧是把它接到 WebView 的接线点。
 *
 * 三条纪律（与 TS 桥一致）：
 *   1. 每个 JS 入口先做**调用方 / 本地 origin 校验**，非白名单 origin 一律拒绝；
 *   2. 只暴露 {@code submit / subscribe / unsubscribe / cancel}；**不**暴露任意文件、
 *      密钥、代码执行（载荷扫描在 TS 引导层 `guard.ts`，本层只转交）；
 *   3. 命令与事件走 `mobile-v1` 契约（命令转交 JS 运行时，事件回 UI）。
 *
 * JS 面 = 恰好 4 个 {@link JavascriptInterface} 方法：
 *   - {@link #submit(String, String)}     —— 提交一条 mobile-v1 命令，返回事件/拒绝 JSON；
 *   - {@link #subscribe(String)}          —— 登记一条事件订阅，返回订阅 id JSON；
 *   - {@link #unsubscribe(String, String)}—— 注销订阅（对应 TS {@code Subscription.unsubscribe}）；
 *   - {@link #cancel(String, String)}     —— 中止在飞命令，返回是否命中。
 * 其余方法（setDispatcher / setEventSink / startRuntime / emitEvent ...）都是**宿主接线口**，
 * **不**带 {@code @JavascriptInterface}，页面无法调用。
 *
 * 静态契约对照见 `tests/mobile-kernel/K-I23/`：断言本类的 JS 面与 K01
 * `createLocalUiBridge`（submit/subscribe/cancel）一致，且不含任何文件/密钥/代码执行钩子。
 */
public final class KernelLocalUiBridge {

    private static final String TAG = "PotbotKernelBridge";

    /**
     * 允许提交命令的本地 origin 白名单（**唯一**判定点，与 TS `origin.ts`
     * 的 `DEFAULT_ALLOWED_ORIGINS` 逐项对齐）。远程 origin 一律拒绝。
     */
    public static final String[] DEFAULT_ALLOWED_ORIGINS = {
            "app://local",
            "file:///android_asset",
            "https://localhost",
    };

    /** 把命令 JSON 交给 JS 引导层；返回事件 JSON。实现由集成人按运行时选型提供。 */
    public interface CommandDispatcher {
        /** @param commandJson mobile-v1 command；@return mobile-v1 event（成功或失败均返回事件 JSON）。 */
        String dispatch(String commandJson);

        boolean cancel(String commandId);
    }

    /**
     * 事件下行口：宿主（Activity）注入，把事件 JSON 经 `WebView.evaluateJavascript` 投给页面。
     * **不**经 {@code @JavascriptInterface} 暴露——页面无法借它注入伪造事件。
     */
    public interface EventSink {
        void onEvent(String subscriptionId, String eventJson);
    }

    private final Handler kernelHandler;
    private final String[] allowedOrigins;
    private final Set<String> subscriptions = new LinkedHashSet<String>();
    private final AtomicLong subscriptionSeq = new AtomicLong(0);

    private volatile boolean running = false;
    /** 由 Android 集成人在选型完成后注入（把一条命令 JSON 交给 JS 引导层）。 */
    private volatile CommandDispatcher dispatcher;
    /** 由宿主 Activity 注入（把事件 JSON 回推页面）。 */
    private volatile EventSink eventSink;

    public KernelLocalUiBridge(Handler kernelHandler) {
        this(kernelHandler, DEFAULT_ALLOWED_ORIGINS);
    }

    public KernelLocalUiBridge(Handler kernelHandler, String[] allowedOrigins) {
        this.kernelHandler = kernelHandler;
        this.allowedOrigins = allowedOrigins == null ? new String[0] : allowedOrigins.clone();
    }

    // ------------------------------------------------------------------
    // 宿主接线口（非 JS 面）
    // ------------------------------------------------------------------

    public void setDispatcher(CommandDispatcher dispatcher) {
        this.dispatcher = dispatcher;
    }

    public void setEventSink(EventSink eventSink) {
        this.eventSink = eventSink;
    }

    public Handler kernelHandler() {
        return kernelHandler;
    }

    public void startRuntime() {
        running = true;
        Log.i(TAG, "runtime started on kernel thread");
    }

    public void stopRuntime() {
        running = false;
        Log.i(TAG, "runtime stopped");
    }

    public boolean isRunning() {
        return running;
    }

    /** 当前登记的订阅数（宿主诊断用，非 JS 面）。 */
    public int subscriptionCount() {
        synchronized (subscriptions) {
            return subscriptions.size();
        }
    }

    /**
     * 事件下行：JS 运行时在 kernel 线程上把事件 JSON 交进来，扇出给**所有**订阅者。
     * 单个订阅者抛错被隔离，不影响其他订阅者（与 TS 引导层 I6 同源纪律）。
     * 非 JS 面——页面无法调用，故不能伪造事件。
     */
    public void emitEvent(String eventJson) {
        final EventSink sink = eventSink;
        if (sink == null) {
            return;
        }
        final List<String> snapshot;
        synchronized (subscriptions) {
            snapshot = new ArrayList<String>(subscriptions);
        }
        for (String subscriptionId : snapshot) {
            try {
                sink.onEvent(subscriptionId, eventJson);
            } catch (RuntimeException error) {
                Log.w(TAG, "event sink threw for " + subscriptionId);
            }
        }
    }

    // ------------------------------------------------------------------
    // JS 面（恰好 4 个 @JavascriptInterface 方法）
    // ------------------------------------------------------------------

    /**
     * 提交一条命令。origin 不在白名单 ⇒ 返回拒绝 JSON，**不**调用 dispatcher。
     * 校验口径与 TS `assertCaller` 一致（本地三态）。
     */
    @JavascriptInterface
    public String submit(String origin, String commandJson) {
        if (!isAllowedOrigin(origin)) {
            return reject("ORIGIN_REJECTED", "拒绝非本地 origin：" + origin);
        }
        if (commandJson == null || commandJson.isEmpty()) {
            return reject("INVALID_ARGUMENT", "command 不能为空");
        }
        if (!running) {
            return reject("RUNTIME_NOT_RUNNING", "内核运行时未启动");
        }
        final CommandDispatcher target = dispatcher;
        if (target == null) {
            return reject("EXECUTOR_UNAVAILABLE", "缺少可用执行器，未执行任何外部动作");
        }
        // 命令形状/载荷扫描由 TS 引导层完成；本层只转发（fail-closed：异常不外泄）。
        try {
            final String eventJson = target.dispatch(commandJson);
            if (eventJson == null) {
                return reject("BRIDGE_FORWARD_FAILED", "执行器未返回事件");
            }
            return eventJson;
        } catch (RuntimeException error) {
            return reject("BRIDGE_FORWARD_FAILED", "转发失败：" + error.getClass().getSimpleName());
        }
    }

    /**
     * 登记一条事件订阅。同 {@code submit} 一样先过 origin 门；返回订阅 JSON
     * （含订阅 id）。事件经 {@link #emitEvent} 扇出，宿主用 id 定位到页面回调。
     */
    @JavascriptInterface
    public String subscribe(String origin) {
        if (!isAllowedOrigin(origin)) {
            return reject("ORIGIN_REJECTED", "拒绝非本地 origin：" + origin);
        }
        final String subscriptionId = "sub-" + subscriptionSeq.incrementAndGet();
        synchronized (subscriptions) {
            subscriptions.add(subscriptionId);
        }
        return "{\"status\":\"subscribed\",\"subscriptionId\":" + jsonString(subscriptionId) + "}";
    }

    /** 注销订阅；origin 不合法或 id 未登记均返回 false。 */
    @JavascriptInterface
    public boolean unsubscribe(String origin, String subscriptionId) {
        if (!isAllowedOrigin(origin) || subscriptionId == null) {
            return false;
        }
        synchronized (subscriptions) {
            return subscriptions.remove(subscriptionId);
        }
    }

    /** 取消在飞命令；返回是否命中。origin 同样先校验。 */
    @JavascriptInterface
    public boolean cancel(String origin, String commandId) {
        if (!isAllowedOrigin(origin)) {
            Log.w(TAG, "cancel rejected: origin not allowed");
            return false;
        }
        final CommandDispatcher target = dispatcher;
        if (target == null || commandId == null || commandId.isEmpty()) {
            return false;
        }
        return target.cancel(commandId);
    }

    // ------------------------------------------------------------------
    // 内部
    // ------------------------------------------------------------------

    private boolean isAllowedOrigin(String origin) {
        if (origin == null) {
            return false;
        }
        final String normalized = origin.trim().toLowerCase(Locale.ROOT);
        for (String allowed : allowedOrigins) {
            if (allowed != null && allowed.trim().toLowerCase(Locale.ROOT).equals(normalized)) {
                return true;
            }
        }
        return false;
    }

    private static String reject(String code, String message) {
        // 最小 JSON；code/message 一律转义，避免调用方值注入 JSON 结构。
        return "{\"status\":\"failed\",\"error\":{\"code\":" + jsonString(code)
                + ",\"message\":" + jsonString(message) + "}}";
    }

    /** 最小 JSON 字符串转义（不引入解析依赖）。 */
    private static String jsonString(String value) {
        final StringBuilder out = new StringBuilder(value.length() + 2);
        out.append('"');
        for (int i = 0; i < value.length(); i++) {
            final char c = value.charAt(i);
            switch (c) {
                case '"':
                    out.append("\\\"");
                    break;
                case '\\':
                    out.append("\\\\");
                    break;
                case '\n':
                    out.append("\\n");
                    break;
                case '\r':
                    out.append("\\r");
                    break;
                case '\t':
                    out.append("\\t");
                    break;
                default:
                    if (c < 0x20) {
                        out.append(String.format(Locale.ROOT, "\\u%04x", (int) c));
                    } else {
                        out.append(c);
                    }
            }
        }
        out.append('"');
        return out.toString();
    }
}
