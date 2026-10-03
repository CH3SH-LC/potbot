package com.potbot.kernel.lifecycle;

/**
 * K-I21 —— 通知权限未授予时的 fail-closed 拒因。
 *
 * <p>对应 K10 机读错误码 {@code notification_permission_denied}：长任务无通知权限时
 * **不得**以"无通知常驻"绕过——投递必须在调用系统 {@code notify()} 之前就抛出，
 * 保证拒绝路径下落地的通知数恒为零。
 *
 * <p>继承 {@link IllegalStateException}：这是"环境不允许此操作"，不是参数错误。
 * 消息里**不得**包含任何密钥、手机号、地址或桌面路径。
 */
public final class NotificationPermissionDeniedException extends IllegalStateException {

    public NotificationPermissionDeniedException(String message) {
        super(message);
    }
}
