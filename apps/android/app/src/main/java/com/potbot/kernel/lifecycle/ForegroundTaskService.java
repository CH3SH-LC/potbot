package com.potbot.kernel.lifecycle;

import android.app.Notification;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

/**
 * K-I21 —— 长任务的前台服务宿主（可见常驻 + 有界预算）。
 *
 * <p>对应 K10 的可见长任务语义：*可见的长任务*用前台服务 + 常驻通知；**不承诺无限常驻**——
 * {@link LifecycleConstants#DEFAULT_RESIDENCY_BUDGET_MS} 到点主动停服务并撤通知
 * （对应 TS 的 {@code resident_budget_exhausted}）。
 *
 * <p><b>前台服务类型</b>：运行期用 {@code startForeground(id, notification, type)} 传入
 * {@link LifecycleConstants#FOREGROUND_SERVICE_TYPE}（dataSync）。清单里的
 * {@code android:foregroundServiceType="dataSync"} 与相应 uses-permission 归集成人，
 * 本包**不编辑 AndroidManifest.xml**。
 *
 * <p><b>fail-closed</b>：{@link NotificationPort#permission()} 非 GRANTED 时，
 * {@code onStartCommand} 在**任何 startForeground 之前**直接 {@code stopSelf}——
 * 绝不以"无通知常驻"绕过权限（零通知）。
 *
 * <p><b>未验证</b>：未编译、未安装、未上真机。
 */
public final class ForegroundTaskService extends Service {

    public static final String TAG = "PotbotKernelFgs";

    public static final String ACTION_START = "com.potbot.kernel.lifecycle.START";
    public static final String ACTION_STOP = "com.potbot.kernel.lifecycle.STOP";

    public static final String EXTRA_TASK_ID = "com.potbot.kernel.lifecycle.TASK_ID";
    public static final String EXTRA_TITLE = "com.potbot.kernel.lifecycle.TITLE";
    public static final String EXTRA_TEXT = "com.potbot.kernel.lifecycle.TEXT";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private NotificationPort notifications;

    /** 有界常驻：到点主动降级，不假装还在跑。 */
    private final Runnable budgetStop = new Runnable() {
        @Override
        public void run() {
            stopResident("resident_budget_exhausted");
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        notifications = new AndroidNotificationPort(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            stopResident("stopped");
            return START_NOT_STICKY;
        }
        String title = intent == null ? "Potbot 任务" : orDefault(intent.getStringExtra(EXTRA_TITLE), "Potbot 任务");
        String text = intent == null ? "任务进行中" : orDefault(intent.getStringExtra(EXTRA_TEXT), "任务进行中");

        // fail-closed：无通知权限 ⇒ 在 startForeground 之前就停，绝不以"无通知常驻"绕过。
        if (notifications.permission() != NotificationPermission.GRANTED) {
            Log.w(TAG, "POST_NOTIFICATIONS 未授予：拒绝前台常驻（零通知）");
            stopSelf(startId);
            return START_NOT_STICKY;
        }

        Notification notification = buildNotification(title, text);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(LifecycleConstants.FOREGROUND_NOTIFICATION_ID, notification,
                    LifecycleConstants.FOREGROUND_SERVICE_TYPE);
        } else {
            startForeground(LifecycleConstants.FOREGROUND_NOTIFICATION_ID, notification);
        }

        handler.removeCallbacks(budgetStop);
        handler.postDelayed(budgetStop, LifecycleConstants.DEFAULT_RESIDENCY_BUDGET_MS);
        return START_NOT_STICKY;
    }

    /**
     * 构建常驻通知（通道 id 与 {@link AndroidNotificationPort} 一致）。
     *
     * <p>版本闸门：两参构造 {@code Notification.Builder(Context, String)} 是 **API 26（O）**
     * 才引入的，本工程 {@code minSdk = 24}；API 24/25 上直接用它会在运行期抛
     * {@link NoSuchMethodError}。故 API 26+ 用两参（绑通道），API &lt; 26 用一参。
     * 与同仓库 {@code com.potbot.demo.PotbotProgressJobService} 的既有写法一致。
     */
    private Notification buildNotification(String title, String text) {
        Notification.Builder builder = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                ? new Notification.Builder(this, LifecycleConstants.NOTIFICATION_CHANNEL_ID)
                : new Notification.Builder(this);
        return builder
                .setContentTitle(title)
                .setContentText(text)
                .setOngoing(true)
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .build();
    }

    /** 停前台 + 撤通知 + 停服务（幂等）。 */
    private void stopResident(String reason) {
        handler.removeCallbacks(budgetStop);
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
        Log.i(TAG, "前台常驻结束：" + reason);
    }

    private static String orDefault(String value, String fallback) {
        return value == null || value.trim().isEmpty() ? fallback : value;
    }

    @Override
    public IBinder onBind(Intent intent) {
        // 本增量不提供 binder；通过 startCommand + 内核桥接线。
        return null;
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(budgetStop);
        super.onDestroy();
    }
}
