package com.potbot.kernel.lifecycle;

/**
 * K-I21 —— {@code NotificationPort} 端口的原生声明。
 *
 * <p>对应 {@code apps/mobile-kernel/lifecycle/types.ts} 的：
 * <pre>
 *   export interface NotificationPort {
 *     permission(): NotificationPermission;
 *     post(request: NotificationRequest, at: number): NotificationHandle;
 *     update(handle: NotificationHandle, patch: { text: string }, at: number): void;
 *     stop(notificationId: string): void;
 *     activeCount(): number;
 *   }
 * </pre>
 *
 * <p>方法名与 TS 逐字一致，便于静态契约测试按名核对。生产实现见
 * {@link AndroidNotificationPort}（真机）；测试可另写内存实现。
 *
 * <p><b>fail-closed 契约</b>：任何实现都**不得**在未获通知权限时投递通知或以无通知方式常驻——
 * {@link #post} 必须抛错且不改变 {@link #activeCount()}。
 */
public interface NotificationPort {

    /** 当前通知权限（判不出"已授予"时归 DENIED）。 */
    NotificationPermission permission();

    /**
     * 投递通知。权限未授予时**抛 {@link NotificationPermissionDeniedException}**，
     * 且不投递任何通知（activeCount 不变）。
     */
    NotificationHandle post(NotificationRequest request, long at);

    /** 更新已存活通知的正文；句柄不存在时抛 {@link UnknownNotificationException}。 */
    void update(NotificationHandle handle, String text, long at);

    /** 撤销通知（不存在则无操作）。 */
    void stop(String notificationId);

    /** 当前存活的通知数（用于证明完成/取消后无泄漏的常驻通知）。 */
    int activeCount();
}
