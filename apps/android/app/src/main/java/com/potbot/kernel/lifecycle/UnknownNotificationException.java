package com.potbot.kernel.lifecycle;

/**
 * K-I21 —— 更新/引用一个不存在（或已撤销）的通知时的拒因。
 *
 * <p>对应 TS 侧 {@code LifecycleError('unknown_task', ...)} 的同款纪律：不把"句柄已失效"
 * 静默当作成功，而是如实抛出。
 */
public final class UnknownNotificationException extends IllegalStateException {

    public UnknownNotificationException(String message) {
        super(message);
    }
}
