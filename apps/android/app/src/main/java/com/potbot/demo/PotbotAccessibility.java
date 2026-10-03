package com.potbot.demo;

import android.content.Context;
import android.os.Bundle;
import android.view.View;

/**
 * APP-08（中文输入法 / 长文本 / 多文件 / 屏幕旋转恢复 / 大字与基本可访问性）
 * —— 宿主侧的**可访问性与恢复**支撑。
 *
 * <p>本类只放"宿主能控制、且能静态核对"的那一半；页面里的排版细节不归它管：
 * <ul>
 *   <li>{@link #contentDescRes}：把界面上的几个**有名字的区域**映射到
 *       {@code strings.xml} 里的 {@code contentDescription} 文案——屏幕阅读器据此朗读，
 *       空白/缺失都会被 tests 抓住；</li>
 *   <li>{@link #textZoomPercent}：跟随系统"字体大小/大字模式"（{@code fontScale}），
 *       并**夹在 {@link #TEXT_ZOOM_MIN_PERCENT}–{@link #TEXT_ZOOM_MAX_PERCENT}** 之间
 *       ——不跟随是把大字用户排除在外，无限放大则会把版面撑坏；</li>
 *   <li>{@link #isLargeFont}：判断当前是否处于大字模式（>= {@link #LARGE_FONT_SCALE_THRESHOLD}）；</li>
 *   <li>{@link #putDraft} / {@link #getDraft}：**长文本草稿**跨进程重建的落点
 *       （旋转由清单的 {@code configChanges} 就地处理，不重建；进程被杀才靠这里恢复）；</li>
 *   <li>{@link #MIN_TOUCH_TARGET_DP}：可点区域的最小边长（48dp，平台建议值），
 *       给页面侧核对用。</li>
 * </ul>
 *
 * <p>多文件入口在 {@link PotbotInputGateway}（{@code EXTRA_ALLOW_MULTIPLE} + {@link android.content.ClipData}）。
 * 中文输入法不需要任何额外权限：清单用 {@code android:windowSoftInputMode="adjustResize"}
 * 保证输入框不被键盘盖住，输入本身由系统输入法完成。
 *
 * <p><b>未验证（需真机）</b>：真实中文输入法的候选词行为、TalkBack 的朗读顺序、
 * 各家 ROM 的大字档位，本批**没有设备**，未验证。
 */
public final class PotbotAccessibility {

    /** 可点区域最小边长（dp）。 */
    public static final int MIN_TOUCH_TARGET_DP = 48;
    /** 大字模式判定阈值（系统 fontScale）。 */
    public static final float LARGE_FONT_SCALE_THRESHOLD = 1.3f;
    /** 文本缩放的下限（不缩小）。 */
    public static final int TEXT_ZOOM_MIN_PERCENT = 100;
    /** 文本缩放的上限（放到 2 倍为止，再大版面会碎）。 */
    public static final int TEXT_ZOOM_MAX_PERCENT = 200;
    /** 长文本草稿的长度上限（与 {@link PotbotInputGateway#MAX_TEXT_CHARS} 一致，不截断）。 */
    public static final int MAX_DRAFT_CHARS = PotbotInputGateway.MAX_TEXT_CHARS;
    /** 草稿在 Bundle 里的键。 */
    public static final String STATE_COMPOSER_DRAFT = "potbot.composerDraft";

    // ---- 需要 contentDescription 的区域名（测试按这些名字核对资源齐备） ----

    /** 主内容区（对话与任务内容）。 */
    public static final String TARGET_MAIN_CONTENT = "main_content";
    /** 输入框。 */
    public static final String TARGET_INPUT_FIELD = "input_field";
    /** 发送按钮。 */
    public static final String TARGET_SEND_BUTTON = "send_button";
    /** 添加文件按钮。 */
    public static final String TARGET_ATTACH_BUTTON = "attach_button";

    private PotbotAccessibility() {
    }

    /** 全部需要朗读文案的区域名。 */
    public static String[] contentDescTargets() {
        return new String[] {
                TARGET_MAIN_CONTENT, TARGET_INPUT_FIELD, TARGET_SEND_BUTTON, TARGET_ATTACH_BUTTON,
        };
    }

    /** 区域名 → contentDescription 文案资源号；不认识的名字回 0（调用方跳过）。 */
    public static int contentDescRes(String target) {
        if (TARGET_MAIN_CONTENT.equals(target)) return R.string.potbot_a11y_content_desc;
        if (TARGET_INPUT_FIELD.equals(target)) return R.string.potbot_a11y_input_field;
        if (TARGET_SEND_BUTTON.equals(target)) return R.string.potbot_a11y_send_button;
        if (TARGET_ATTACH_BUTTON.equals(target)) return R.string.potbot_a11y_attach_button;
        return 0;
    }

    /** 给视图设置朗读文案；视图或资源缺失时**静默跳过**（不崩、不设空串冒充）。 */
    public static void applyContentDescription(View view, int resId) {
        if (view == null || resId == 0) {
            return;
        }
        try {
            view.setContentDescription(view.getContext().getString(resId));
        } catch (Throwable e) {
            // 拿不到文案就不设——空串比不设更糟（会读成"空白"）。
        }
    }

    /** 系统字体缩放比例（判不出来按 1.0，即标准字号）。 */
    public static float fontScale(Context context) {
        if (context == null) {
            return 1.0f;
        }
        try {
            float scale = context.getResources().getConfiguration().fontScale;
            if (scale <= 0f) {
                return 1.0f;
            }
            return scale;
        } catch (Throwable e) {
            return 1.0f;
        }
    }

    /** 当前是否处于大字模式。 */
    public static boolean isLargeFont(Context context) {
        return fontScale(context) >= LARGE_FONT_SCALE_THRESHOLD;
    }

    /** WebView 文本缩放百分比（跟随系统字号，夹在上下限之间）。 */
    public static int textZoomPercent(Context context) {
        int percent = Math.round(fontScale(context) * 100f);
        if (percent < TEXT_ZOOM_MIN_PERCENT) {
            return TEXT_ZOOM_MIN_PERCENT;
        }
        if (percent > TEXT_ZOOM_MAX_PERCENT) {
            return TEXT_ZOOM_MAX_PERCENT;
        }
        return percent;
    }

    // ---------------------------------------------------------------- 长文本草稿

    /** 把长文本草稿写进 Bundle；超长**不截断**（截断会让人以为存住的是全文）。 */
    public static void putDraft(Bundle outState, String draft) {
        if (outState == null) {
            return;
        }
        if (draft != null && draft.length() > MAX_DRAFT_CHARS) {
            // 超长就整体不存：宁可让用户重来，也不给他一段被砍掉的内容。
            outState.remove(STATE_COMPOSER_DRAFT);
            return;
        }
        outState.putString(STATE_COMPOSER_DRAFT, draft);
    }

    /** 读回长文本草稿（没有返回 null，不用空串冒充"有草稿"）。 */
    public static String getDraft(Bundle state) {
        if (state == null) {
            return null;
        }
        return state.getString(STATE_COMPOSER_DRAFT);
    }
}
