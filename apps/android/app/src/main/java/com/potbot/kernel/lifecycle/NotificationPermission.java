package com.potbot.kernel.lifecycle;

/**
 * K-I21 —— 通知权限三态（对应 {@code types.ts} 的
 * {@code NOTIFICATION_PERMISSIONS = ['granted','denied','not-determined']}）。
 *
 * <p>Android 的 {@code checkSelfPermission} 只给 GRANTED / DENIED 两态；本实现**不猜**
 * "未询问"（需要 {@code shouldShowRequestPermissionRationale} 与请求历史，语义模糊）。
 * 判不出"已授予"时一律归 {@link #DENIED}——这是 fail-closed 的保守方向：
 * 宁可当作发不出通知，也不假装能常驻。
 */
public enum NotificationPermission {
    GRANTED,
    DENIED,
    NOT_DETERMINED;

    /** 与 TS 词表逐字一致的线上表示。 */
    public String wire() {
        switch (this) {
            case GRANTED:
                return "granted";
            case DENIED:
                return "denied";
            case NOT_DETERMINED:
            default:
                return "not-determined";
        }
    }
}
