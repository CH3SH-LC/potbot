package com.potbot.kernel.lifecycle;

/**
 * K-I21 —— 通知句柄（对应 {@code types.ts} 的 {@code NotificationHandle}）。
 *
 * <p>投递成功后才由 {@link NotificationPort#post} 返回；{@code postedAt} 由调用方传入的
 * {@code at} 决定（**不读墙钟**，与仓库注入时钟纪律一致）。
 */
public final class NotificationHandle {

    public final String notificationId;
    public final long postedAt;

    public NotificationHandle(String notificationId, long postedAt) {
        if (notificationId == null || notificationId.trim().isEmpty()) {
            throw new IllegalArgumentException("notificationId 必须是非空字符串");
        }
        this.notificationId = notificationId;
        this.postedAt = postedAt;
    }
}
