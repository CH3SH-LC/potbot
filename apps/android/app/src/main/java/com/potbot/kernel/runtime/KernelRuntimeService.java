package com.potbot.kernel.runtime;

import android.app.Service;
import android.content.Intent;
import android.content.res.AssetManager;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * K01 —— 手机内核业务运行时宿主（Android 侧接线点）。
 *
 * ⚠️ 未编译、未安装、未在真机验证（本机无 Android SDK / NDK / gradle wrapper / adb）。
 * 这是 K01 的**宿主接线点**，不是已验证实现；`apps/mobile-kernel/bootstrap/` 的 TS 引导层
 * 才是本增量里真实测试过的部分（见该目录 README 的 spike 计划）。
 *
 * 职责（与 TS 引导层的对应关系）：
 *   - 启动一个独立的 HandlerThread 跑内核（UI 线程不承载业务执行）；
 *   - 承载**打包后的 JS 运行时**：从 APK assets 读取 K-I14 产出的单文件 ESM
 *     （{@link #BUNDLE_ASSET_PATH}），交给 {@link JsEngine} 选型实现求值，得到内核句柄；
 *   - 把 {@link KernelLocalUiBridge} 注册到 WebView，暴露 submit / subscribe / cancel；
 *   - 前台化与进程回收恢复由 K10 lifecycle 包接管（本文件只留接入点，不承诺无限常驻）。
 *
 * fail-closed：JS 运行时未绑定 / 引导层加载失败 ⇒ **不**注入 dispatcher，桥的 submit
 * 一律返回 {@code EXECUTOR_UNAVAILABLE}，绝不上报成功（与 TS 引导层不变量 3 一致）。
 *
 * 写入边界：本文件只做宿主接线，业务语义归注册进 JS 引导层的模块（K02–K10）。
 * Service 声明与 `WebView.addJavascriptInterface` 的调用由 Android 集成人单写（不在本目录）。
 */
public final class KernelRuntimeService extends Service {

    public static final String TAG = "PotbotKernelRuntime";
    public static final String ACTION_START = "com.potbot.kernel.runtime.START";
    public static final String ACTION_STOP = "com.potbot.kernel.runtime.STOP";

    /**
     * APK 内打包后引导层的 assets 路径。产物由 `apps/mobile-kernel/bootstrap/build.mjs`
     * （K-I14）生成：`apps/mobile-kernel/bootstrap/dist/bootstrap.mjs` ⇒ 装入
     * `assets/kernel/bootstrap.mjs`。集成人负责把产物拷入 `app/src/main/assets/`。
     */
    public static final String BUNDLE_ASSET_PATH = "kernel/bootstrap.mjs";

    /** 允许提交命令的本地 origin 白名单（唯一来源：{@link KernelLocalUiBridge#DEFAULT_ALLOWED_ORIGINS}）。 */
    static final String[] ALLOWED_ORIGINS = KernelLocalUiBridge.DEFAULT_ALLOWED_ORIGINS;

    /**
     * 可嵌入 JS 运行时接缝：把单文件 ESM 引导层加载成内核句柄。
     * 选型（QuickJS / V8 / Hermes）由 arm64 spike 决定，故本文件只留接缝，
     * 由集成人在选型完成后 {@link #setJsEngine(JsEngine)} 注入。
     */
    public interface JsEngine {
        /** @param moduleSource `bootstrap.mjs` 全文；@return 内核句柄。 */
        KernelHandle loadBundle(String moduleSource);
    }

    /** 内核句柄：JS 引导层暴露给宿主的两个操作（对应 TS 桥的 submit / cancel）。 */
    public interface KernelHandle {
        /** @param commandJson mobile-v1 command；@return mobile-v1 event JSON。 */
        String dispatch(String commandJson);

        boolean cancel(String commandId);
    }

    /**
     * 当前活动的服务实例（同进程唯一）。{@link #onCreate} 置入、{@link #onDestroy} 清空。
     *
     * <p><b>为什么需要它</b>：{@link #onBind} 返回 {@code null}（本增量不提供 binder，
     * 见类注释），本地 UI 桥又要由宿主注册进 WebView 才能被页面调用；没有静态持有者时
     * {@link #getBridge()} 无法从 Activity 取到实例（旧实现即此缺口）。
     *
     * <p><b>生命周期正确性（无泄漏、无串台）</b>：
     * <ul>
     *   <li>只在服务存活期间非空；{@link #onDestroy} 里**仅当仍指向自己**时清空，
     *       不会因进程内服务重建而把新实例误清（防止 cross-instance 串台）。</li>
     *   <li>{@link KernelLocalUiBridge} 自身**不持有 Context**（只持 {@code Handler} 与
     *       {@code String[]}），且内核线程在 {@code onDestroy} 中 {@code quitSafely}——
     *       故该静态引用不会把 Activity / Context 拖住。</li>
     *   <li>进程被杀时，"静态"随进程一起消失，不留下跨进程的残留引用。</li>
     * </ul>
     */
    private static volatile KernelRuntimeService instance;

    private HandlerThread kernelThread;
    private Handler kernelHandler;
    private KernelLocalUiBridge bridge;
    private volatile JsEngine jsEngine;
    private volatile boolean bundleLoaded = false;

    @Override
    public void onCreate() {
        super.onCreate();
        kernelThread = new HandlerThread("potbot-kernel");
        kernelThread.start();
        kernelHandler = new Handler(kernelThread.getLooper());
        bridge = new KernelLocalUiBridge(kernelHandler, ALLOWED_ORIGINS);
        // 交付口：服务一创建就把自己登记为可交付实例，供 {@link #getBridge()} 取桥。
        instance = this;
        Log.i(TAG, "kernel runtime service created");
    }

    /** 注入 JS 运行时实现（集成人按 arm64 spike 选型提供）。 */
    public void setJsEngine(JsEngine engine) {
        this.jsEngine = engine;
    }

    /**
     * 加载 assets 里的引导层并注入 dispatcher（在 kernel 线程上执行）。
     * 任一步失败都**不**注入 dispatcher —— 桥保持 fail-closed。
     */
    void loadBundle() {
        final JsEngine engine = jsEngine;
        if (engine == null) {
            Log.w(TAG, "no JsEngine bound; kernel stays fail-closed (EXECUTOR_UNAVAILABLE)");
            return;
        }
        try {
            final String moduleSource = readAsset(BUNDLE_ASSET_PATH);
            final KernelHandle handle = engine.loadBundle(moduleSource);
            if (handle == null) {
                Log.w(TAG, "JsEngine returned null handle; kernel stays fail-closed");
                return;
            }
            bridge.setDispatcher(new BootstrapDispatcher(handle));
            bundleLoaded = true;
            Log.i(TAG, "bootstrap bundle loaded: " + BUNDLE_ASSET_PATH);
        } catch (Exception error) {
            Log.w(TAG, "bootstrap bundle load failed: " + error.getClass().getSimpleName());
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        final String action = intent == null ? null : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            kernelHandler.post(new Runnable() {
                @Override
                public void run() {
                    bridge.stopRuntime();
                }
            });
            return START_NOT_STICKY;
        }
        // 默认 START：在独立线程上加载引导层并启动（start() 幂等校验在 TS 侧）。
        kernelHandler.post(new Runnable() {
            @Override
            public void run() {
                if (!bundleLoaded) {
                    loadBundle();
                }
                bridge.startRuntime();
            }
        });
        return START_NOT_STICKY;
    }

    /**
     * 交付口：Activity 取回**当前存活**的本地 UI 桥，供 WebView 把它注册为页面 JS 接口。
     * 服务未创建（{@link #onCreate} 尚未跑完/已 {@link #onDestroy}）时返回 {@code null}——
     * 调用方此时**不得**注册（fail-closed：不把半成品桥暴露给页面）。
     *
     * <p><b>宿主接线约定（归 MainActivity / WebView；本类不调用 WebView 任何方法）</b>：
     * <ol>
     *   <li>MainActivity 先用显式 Intent（{@link #ACTION_START}）启动本服务
     *       （{@code startService} / 同进程显式 Intent）。服务是 {@code START_NOT_STICKY}，
     *       创建时机在**主线程**，故推荐在启动后于主线程再取桥（例如 {@code onResume}
     *       或一次 {@code Handler.post} 之后），不要在 {@code startService()} 同一行立刻取。</li>
     *   <li>调用本方法取桥；返回 {@code null} 就表示服务还没起来——此时不要注册。</li>
     *   <li>把返回的桥交给 WebView 的平台级 JS 接口注册入口（即 WebView 那套
     *       addJavascriptInterface 风格 API，第二个参数是页面全局对象名，由 Activity 约定，
     *       例如 "PotbotKernel"）。注意：该注册入口是本类**之外**的调用，本类不代劳
     *       （K-I23 契约要求桥与 Service 源码均不得出现该调用）。</li>
     *   <li>再调用 {@link KernelLocalUiBridge#setEventSink} 把事件下行接到
     *       {@code WebView.evaluateJavascript}，页面才能收到订阅事件。</li>
     * </ol>
     *
     * <p><b>仍是 fail-closed 的</b>：只有当 {@link #setJsEngine(JsEngine)} 注入运行时且
     * bundle 加载成功后，桥才可真正执行业务；否则 {@code submit} 一律返回
     * {@code EXECUTOR_UNAVAILABLE}（不谎报成功）。
     */
    public static KernelLocalUiBridge getBridge() {
        final KernelRuntimeService self = instance;
        return self == null ? null : self.bridge;
    }

    public Handler kernelHandler() {
        return kernelHandler;
    }

    @Override
    public IBinder onBind(Intent intent) {
        // 本增量不提供 binder 服务；仅以 startCommand + WebView JS 接口接线。
        return null;
    }

    @Override
    public void onDestroy() {
        // 先撤交付口（仅当仍指向自己）：此后 getBridge() 返回 null，不再把已停的桥交给宿主。
        if (instance == this) {
            instance = null;
        }
        if (bridge != null) {
            bridge.stopRuntime();
        }
        if (kernelThread != null) {
            kernelThread.quitSafely();
        }
        super.onDestroy();
    }

    /** 从 APK assets 读取 UTF-8 文本。 */
    private String readAsset(String path) throws IOException {
        final AssetManager assets = getAssets();
        InputStream in = null;
        try {
            in = assets.open(path);
            final ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            final byte[] chunk = new byte[8192];
            int read;
            while ((read = in.read(chunk)) != -1) {
                buffer.write(chunk, 0, read);
            }
            return new String(buffer.toByteArray(), StandardCharsets.UTF_8);
        } finally {
            if (in != null) {
                try {
                    in.close();
                } catch (IOException ignored) {
                    // 读取结束，关闭失败不改变结果。
                }
            }
        }
    }

    /** 把 {@link KernelHandle} 适配成桥的 {@link KernelLocalUiBridge.CommandDispatcher}。 */
    private static final class BootstrapDispatcher implements KernelLocalUiBridge.CommandDispatcher {
        private final KernelHandle handle;

        BootstrapDispatcher(KernelHandle handle) {
            this.handle = handle;
        }

        @Override
        public String dispatch(String commandJson) {
            return handle.dispatch(commandJson);
        }

        @Override
        public boolean cancel(String commandId) {
            return handle.cancel(commandId);
        }
    }

    /** 供日志/测试断言：当前内核线程是否活着且非调用线程。 */
    boolean isKernelThreadAlive() {
        return kernelThread != null && kernelThread.isAlive() && Looper.myLooper() != kernelThread.getLooper();
    }
}
