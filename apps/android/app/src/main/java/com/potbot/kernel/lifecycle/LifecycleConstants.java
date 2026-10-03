package com.potbot.kernel.lifecycle;

import android.app.NotificationManager;
import android.content.pm.ServiceInfo;

/**
 * K-I21 —— 生命周期词表常量（与 {@code apps/mobile-kernel/lifecycle/types.ts} 逐项对齐）。
 *
 * <p>本包是 {@code com/potbot/kernel/lifecycle}，即 K10 集成请求 #1 指名的原生接线层：
 * 把 {@code NotificationPort} / {@code Clock} / 连通性三类端口的原生实现落在 Android 侧，
 * 供前台服务、通知通道与 JobScheduler 复用。
 *
 * <p><b>诚实边界</b>：本包**未在本环境编译、未安装、未在真机验证**（无 Android SDK /
 * gradle wrapper / 设备）。它是按 Android 标准 API 写就的接线点，不是已验证实现。
 * 静态契约（实现了哪些方法、权限闸门在通知投递之前）由
 * {@code tests/mobile-kernel/K-I21/} 的 Node 契约测试机判。
 *
 * <p><b>清单归集成人</b>：前台服务类型（{@code android:foregroundServiceType}）、
 * {@code <service>} 声明与 {@code POST_NOTIFICATIONS} / {@code FOREGROUND_SERVICE_DATA_SYNC}
 * 的 uses-permission 均在 {@code AndroidManifest.xml}，本单元**不得编辑**；本文件只固定
 * 运行期要用到的常量，供集成人比对清单。
 */
public final class LifecycleConstants {

    private LifecycleConstants() {
        // 纯常量类
    }

    // ------------------------------------------------------------------
    // 通知（与 types.ts 的 NotificationPort 配套）
    // ------------------------------------------------------------------

    /** 唯一通知通道 id（稳定字符串，改它等于换通道——集成人须与清单/资源保持一致）。 */
    public static final String NOTIFICATION_CHANNEL_ID = "potbot.kernel.tasks";

    /** 通道展示名（用户可见）。 */
    public static final CharSequence NOTIFICATION_CHANNEL_NAME = "Potbot 任务";

    /** 通道重要度：长任务进度用 LOW，不打断用户但保持可见。 */
    public static final int NOTIFICATION_CHANNEL_IMPORTANCE = NotificationManager.IMPORTANCE_LOW;

    /**
     * runtime 通知权限名（API 33+）。与
     * {@code android.content.pm.Manifest.permission.POST_NOTIFICATIONS} 同值；
     * 用字面量而非 {@code Manifest.permission} 常量，避免在低编译目标上解析不到。
     */
    public static final String PERMISSION_POST_NOTIFICATIONS = "android.permission.POST_NOTIFICATIONS";

    /** 前台服务通知的稳定 id（同一时刻只服务一个前台任务）。 */
    public static final int FOREGROUND_NOTIFICATION_ID = 0x706F10;

    // ------------------------------------------------------------------
    // 前台服务类型（真机需 AndroidManifest.xml 声明，清单归集成人）
    // ------------------------------------------------------------------

    /**
     * 前台服务类型：长任务属"数据同步"语义（读进度、提交外部单、回读结果）。
     * 与清单里 {@code android:foregroundServiceType="dataSync"} 必须一致。
     */
    public static final int FOREGROUND_SERVICE_TYPE = ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC;

    // ------------------------------------------------------------------
    // 有界常驻（types.ts 的 residencyBudgetMs 语义）
    // ------------------------------------------------------------------

    /**
     * 常驻预算：到点主动 {@code stopForeground} 并停服务，**不承诺无限常驻**。
     * 与 K10 `ForegroundTaskCoordinator` 的 bounded 模型同义。
     */
    public static final long DEFAULT_RESIDENCY_BUDGET_MS = 10L * 60L * 1000L;

    // ------------------------------------------------------------------
    // JobScheduler（后台延迟工作）
    // ------------------------------------------------------------------

    /** 续跑作业 id（稳定；同一 App 内唯一）。 */
    public static final int RESUME_JOB_ID = 0x706F21;

    /** 续跑作业的最小延迟（毫秒）：避免被系统立刻密集拉起。 */
    public static final long RESUME_JOB_MIN_LATENCY_MS = 30L * 1000L;

    // ------------------------------------------------------------------
    // 网络状态词表（与 types.ts 的 NETWORK_STATES 逐字对齐）
    // ------------------------------------------------------------------

    /** 对应 TS `NetworkState = 'online'`。 */
    public static final String NETWORK_ONLINE = "online";

    /** 对应 TS `NetworkState = 'offline'`。 */
    public static final String NETWORK_OFFLINE = "offline";
}
