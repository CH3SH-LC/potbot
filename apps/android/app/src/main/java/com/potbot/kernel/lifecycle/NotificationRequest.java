package com.potbot.kernel.lifecycle;

/**
 * K-I21 —— 通知投递请求（对应 {@code types.ts} 的 {@code NotificationRequest}）。
 *
 * <p>字段与 TS 逐项对应：{@code notificationId} / {@code title} / {@code text} / {@code ongoing}。
 * 三个字符串字段在构造时即拒绝 {@code null}（fail-loud，不给"空标题通知"留口子）。
 */
public final class NotificationRequest {

    public final String notificationId;
    public final String title;
    public final String text;
    /** 长任务通知为 true（用户不能随手划掉，但可在系统设置里强制停止）。 */
    public final boolean ongoing;

    public NotificationRequest(String notificationId, String title, String text, boolean ongoing) {
        this.notificationId = requireText(notificationId, "notificationId");
        this.title = requireText(title, "title");
        this.text = text == null ? "" : text;
        this.ongoing = ongoing;
    }

    private static String requireText(String value, String field) {
        if (value == null || value.trim().isEmpty()) {
            throw new IllegalArgumentException("通知字段 " + field + " 必须是非空字符串");
        }
        return value;
    }
}
