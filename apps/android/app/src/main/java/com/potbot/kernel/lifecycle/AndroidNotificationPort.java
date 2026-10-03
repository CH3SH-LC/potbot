package com.potbot.kernel.lifecycle;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;

import java.util.HashMap;
import java.util.Map;

/**
 * K-I21 —— {@link NotificationPort} 的 Android 实现（NotificationManager + 通知通道）。
 *
 * <p><b>职责</b>
 * <ul>
 *   <li><b>通知通道</b>：构造时创建稳定 id 的 {@link NotificationChannel}
 *       （{@link LifecycleConstants#NOTIFICATION_CHANNEL_ID}），API 26+ 必需；重复创建是幂等的。</li>
 *   <li><b>权限闸门（fail-closed）</b>：{@link #permission()} 在 API &lt; 33 视为 GRANTED；
 *       API 33+ 只有 {@code checkSelfPermission(POST_NOTIFICATIONS) == GRANTED} 才 GRANTED，
 *       其余一律 DENIED（不区分 not-determined——保守）。{@link #post} 在**调用系统
 *       {@code notify()} 之前**先过此闸门，未授予即抛
 *       {@link NotificationPermissionDeniedException}，因此拒绝路径落地的通知数恒为零。</li>
 *   <li><b>句柄账</b>：只有 notify 成功后才把句柄记入 {@code active}，故 {@link #activeCount()}
 *       在拒绝路径恒为 0（对应 K10 判据"无通知权限 ⇒ 零通知"）。</li>
 * </ul>
 *
 * <p><b>未验证</b>：本文件未编译、未上真机（本环境无 Android SDK / 设备）。真机上须复核
 * 通道创建、权限弹窗结果与通知可见性；本文件不得当作"已完成"。
 *
 * <p><b>不读墙钟</b>：投递/更新时间由调用方以 {@code at} 传入。
 */
public final class AndroidNotificationPort implements NotificationPort {

    private final Context context;
    private final NotificationManager manager;
    private final Map<String, NotificationHandle> active = new HashMap<>();

    public AndroidNotificationPort(Context context) {
        if (context == null) {
            throw new IllegalArgumentException("context 不能为空");
        }
        this.context = context.getApplicationContext();
        this.manager = (NotificationManager) this.context.getSystemService(Context.NOTIFICATION_SERVICE);
        createChannel();
    }

    /** 创建通知通道（API 26+）；重复调用幂等。 */
    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || manager == null) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
                LifecycleConstants.NOTIFICATION_CHANNEL_ID,
                LifecycleConstants.NOTIFICATION_CHANNEL_NAME,
                LifecycleConstants.NOTIFICATION_CHANNEL_IMPORTANCE);
        channel.setDescription("Potbot 长任务的前台服务通知");
        manager.createNotificationChannel(channel);
    }

    /**
     * 版本闸门地构造 {@link Notification.Builder}。
     *
     * <p>两参构造 {@code Notification.Builder(Context, String)} 是 **API 26（O）** 才引入的；
     * 在 API 24/25（本工程 {@code minSdk = 24}）上直接调用会在**运行期**抛
     * {@link NoSuchMethodError}（编译期不报错，因 compileSdk = 34 能解析到该重载）。
     * 故 API 26+ 走两参构造（绑定 {@link LifecycleConstants#NOTIFICATION_CHANNEL_ID} 通道），
     * API &lt; 26 退回一参构造（低版本没有通知通道概念）。
     *
     * <p>与同仓库 {@code com.potbot.demo.PotbotProgressJobService#notifyProgress} 的写法一致
     * （那是本仓库既有的正确版本闸门模式）。
     */
    private Notification.Builder newNotificationBuilder() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            return new Notification.Builder(context, LifecycleConstants.NOTIFICATION_CHANNEL_ID);
        }
        // API < 26：无通道 API，只能用一参构造（该构造在 API 26+ 已废弃，但低版本必须用它）。
        return new Notification.Builder(context);
    }

    @Override
    public NotificationPermission permission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            // API < 33 无该运行时权限，通知默认可发。
            return NotificationPermission.GRANTED;
        }
        if (context.checkSelfPermission(LifecycleConstants.PERMISSION_POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED) {
            return NotificationPermission.GRANTED;
        }
        // 非 GRANTED 一律 DENIED：宁可当作发不出，也不假装能常驻（fail-closed）。
        return NotificationPermission.DENIED;
    }

    @Override
    public NotificationHandle post(NotificationRequest request, long at) {
        if (request == null) {
            throw new IllegalArgumentException("notification request 不能为空");
        }
        // fail-closed 闸门：必须在调用 manager.notify() 之前完成判定。
        if (permission() != NotificationPermission.GRANTED) {
            throw new NotificationPermissionDeniedException(
                    "POST_NOTIFICATIONS 未授予：拒绝投递且不常驻（落地通知数为零）");
        }
        if (manager == null) {
            throw new NotificationPermissionDeniedException("通知服务不可用：拒绝投递（落地通知数为零）");
        }
        Notification notification = newNotificationBuilder()
                .setContentTitle(request.title)
                .setContentText(request.text)
                .setOngoing(request.ongoing)
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .build();
        manager.notify(stableId(request.notificationId), notification);
        NotificationHandle handle = new NotificationHandle(request.notificationId, at);
        // 只有投递成功后才登记句柄 —— 拒绝路径不会走到这里。
        active.put(request.notificationId, handle);
        return handle;
    }

    @Override
    public void update(NotificationHandle handle, String text, long at) {
        if (handle == null) {
            throw new IllegalArgumentException("handle 不能为空");
        }
        NotificationHandle current = active.get(handle.notificationId);
        if (current == null) {
            throw new UnknownNotificationException(
                    "通知 " + handle.notificationId + " 不存在或已撤销，无法更新");
        }
        if (manager == null) {
            throw new UnknownNotificationException("通知服务不可用，无法更新");
        }
        Notification notification = newNotificationBuilder()
                .setContentTitle("Potbot 任务")
                .setContentText(text == null ? "" : text)
                .setOngoing(true)
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .build();
        manager.notify(stableId(handle.notificationId), notification);
    }

    @Override
    public void stop(String notificationId) {
        if (notificationId != null && manager != null) {
            manager.cancel(stableId(notificationId));
        }
        if (notificationId != null) {
            active.remove(notificationId);
        }
    }

    @Override
    public int activeCount() {
        return active.size();
    }

    /** 把任意非空 id 映射成稳定的系统通知 id（同 id 复投即更新同一条）。 */
    private static int stableId(String notificationId) {
        return notificationId.hashCode() & 0x7FFFFFFF;
    }
}
