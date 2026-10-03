package com.potbot.demo;

import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.graphics.pdf.PdfDocument;
import android.os.Build;
import android.text.Layout;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.StaticLayout;
import android.text.TextPaint;
import android.text.style.LeadingMarginSpan;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * design-05 **WF-089（手机侧）** 的**真实排版引擎**。
 *
 * ## 为什么必须是一个真排版引擎
 *
 * WF-089 要求 PDF 导出走**真实排版引擎**，**不得改扩展名伪造**。手机端没有 Word COM，
 * 也没有 Word/LibreOffice 这类外部转换器可依赖；本类因此直接用
 * {@link android.graphics.pdf.PdfDocument} 把**结构化文档模型**排到 A4 页面上：
 *
 *  - 页面几何：A4 = 595 × 842 pt（PDF 用户单位，1 pt = 1/72 inch），四周页边距 72 pt；
 *  - 段落排版：字号（pt）、粗体、五种对齐、行距倍数、段后间距、首行缩进（按"字"计）；
 *  - 真实分页：按行逐行摆放，装不下就换页；**超长段落跨页续排**，不截断、不丢字；
 *  - 页脚页码：每页底部居中的真实页码。
 *
 * 这些都是用户点名的常用排版能力（WF-001–034 的手机端子集）——不是把 DOCX 字节换个
 * 名字写成 .pdf。产物是否真的是 PDF，由 {@link PotbotPdfReadback} **独立读回**判定，
 * 本类自报的 `pageCount` **不作为**通过依据（只作交叉核对对象）。
 *
 * ## 失败语义（引擎段）
 *
 *  - 无引擎：{@link NoEngineException} —— 设备上没有可用的 PdfDocument 排版引擎；
 *  - 超时：{@link TimeoutException} —— 排版超过调用方给的 deadline；
 *  - 参数被拒：{@link RejectedException} —— JSON 非法/超限（"参数问题"，不是引擎故障）；
 *  - 其它排版错误：{@link LayoutException}。
 *  四者互不冒充；写盘/读回的失败由调用方各自报告。
 *
 * **未验证声明**：本类只在 Android 运行期执行；本波**没有设备**，故其真机行为一律标「未验证」。
 */
final class PotbotPdfLayout {

    private PotbotPdfLayout() {
    }

    /** A4 宽（pt）。 */
    static final int A4_WIDTH_PT = 595;
    /** A4 高（pt）。 */
    static final int A4_HEIGHT_PT = 842;
    /** 页边距（pt）——对应 Word 默认的 2.54 cm 左右边距。 */
    static final int MARGIN_PT = 72;

    static final int MAX_PARAGRAPHS = 2000;
    static final int MAX_PARAGRAPH_CHARS = 20000;
    static final long MAX_TOTAL_CHARS = 500_000L;

    /** 引擎自报名字（写进结果与日志，便于事后追溯是哪条路线）。 */
    static final String ENGINE_NAME = "android.graphics.pdf.PdfDocument/StaticLayout";

    // ------------------------------------------------------------- 异常

    /** 设备上没有可用的排版引擎（与"排版出错""超时"互相区分）。 */
    static final class NoEngineException extends Exception {
        private static final long serialVersionUID = 1L;

        NoEngineException(String message, Throwable cause) {
            super(message, cause);
        }

        NoEngineException(String message) {
            super(message);
        }
    }

    /** 排版超过 deadline。 */
    static final class TimeoutException extends Exception {
        private static final long serialVersionUID = 1L;

        TimeoutException(String message) {
            super(message);
        }
    }

    /** 其它排版错误（版面计算失败等）。 */
    static final class LayoutException extends Exception {
        private static final long serialVersionUID = 1L;

        LayoutException(String message) {
            super(message);
        }
    }

    /** 请求被拒（JSON 非法 / 超限）——属于"参数问题"，不是引擎故障。 */
    static final class RejectedException extends Exception {
        private static final long serialVersionUID = 1L;

        RejectedException(String message) {
            super(message);
        }
    }

    // ------------------------------------------------------------- 文档模型

    /** 一个段落（字符格式 + 段落排版的手机端子集）。 */
    static final class Paragraph {
        final String text;
        final String align;          // left | center | right | justify | distribute
        final float sizePt;
        final boolean bold;
        /** 首行缩进，单位"字"（2 字 = 两个当前字号宽）。 */
        final float firstLineChars;
        /** 行距倍数（1.0 = 单倍）。 */
        final float lineSpacing;
        /** 段后间距（pt）。 */
        final float spaceAfterPt;
        final boolean heading;
        final int level;

        Paragraph(String text, String align, float sizePt, boolean bold, float firstLineChars,
                  float lineSpacing, float spaceAfterPt, boolean heading, int level) {
            this.text = text;
            this.align = align;
            this.sizePt = sizePt;
            this.bold = bold;
            this.firstLineChars = firstLineChars;
            this.lineSpacing = lineSpacing;
            this.spaceAfterPt = spaceAfterPt;
            this.heading = heading;
            this.level = level;
        }
    }

    /** 一次排版请求。 */
    static final class Request {
        /** 页面建议的文件名（仍由宿主消毒，本层不做文件名安全判定）。 */
        final String filename;
        final String title;
        final List<Paragraph> paragraphs;
        final int pageWidthPt;
        final int pageHeightPt;
        final int marginPt;
        final long timeoutMs;

        Request(String filename, String title, List<Paragraph> paragraphs, int pageWidthPt,
                int pageHeightPt, int marginPt, long timeoutMs) {
            this.filename = filename;
            this.title = title;
            this.paragraphs = paragraphs;
            this.pageWidthPt = pageWidthPt;
            this.pageHeightPt = pageHeightPt;
            this.marginPt = marginPt;
            this.timeoutMs = timeoutMs;
        }
    }

    /** 排版结果（**自报**，仅作交叉核对对象，不作通过依据）。 */
    static final class Result {
        final int pageCount;
        final int paragraphCount;
        final long layoutMs;
        final String engine;

        Result(int pageCount, int paragraphCount, long layoutMs, String engine) {
            this.pageCount = pageCount;
            this.paragraphCount = paragraphCount;
            this.layoutMs = layoutMs;
            this.engine = engine;
        }
    }

    // ------------------------------------------------------------- 请求解析

    /**
     * 解析并校验页面送来的文档 JSON。非法输入一律 {@link RejectedException}（参数问题），
     * 与引擎故障分开。
     */
    static Request parseRequest(String json) throws RejectedException {
        if (json == null || json.trim().isEmpty()) {
            throw new RejectedException("文档 JSON 为空。");
        }
        JSONObject o;
        try {
            o = new JSONObject(json);
        } catch (Throwable e) {
            throw new RejectedException("文档 JSON 无法解析：" + e.getClass().getSimpleName());
        }
        String title = o.optString("title", "");
        if (title.length() > MAX_PARAGRAPH_CHARS) {
            throw new RejectedException("标题超过 " + MAX_PARAGRAPH_CHARS + " 字符。");
        }
        JSONArray arr = o.optJSONArray("paragraphs");
        if (arr == null) {
            throw new RejectedException("缺少 paragraphs 数组。");
        }
        if (arr.length() > MAX_PARAGRAPHS) {
            throw new RejectedException("段落数 " + arr.length() + " 超过上限 " + MAX_PARAGRAPHS + "。");
        }
        long total = 0;
        List<Paragraph> paragraphs = new ArrayList<Paragraph>(arr.length());
        for (int i = 0; i < arr.length(); i++) {
            JSONObject p = arr.optJSONObject(i);
            if (p == null) {
                throw new RejectedException("第 " + i + " 段不是对象。");
            }
            String text = p.optString("text", "");
            if (text.length() > MAX_PARAGRAPH_CHARS) {
                throw new RejectedException("第 " + i + " 段超过 " + MAX_PARAGRAPH_CHARS + " 字符。");
            }
            total += text.length();
            if (total > MAX_TOTAL_CHARS) {
                throw new RejectedException("正文总字符数超过上限 " + MAX_TOTAL_CHARS + "。");
            }
            float sizePt = (float) p.optDouble("sizePt", 12.0d);
            if (!(sizePt >= 4.0f) || !(sizePt <= 200.0f)) {
                throw new RejectedException("第 " + i + " 段字号越界：" + sizePt);
            }
            float firstLineChars = (float) p.optDouble("firstLineChars", 0.0d);
            if (!(firstLineChars >= 0.0f) || !(firstLineChars <= 20.0f)) {
                throw new RejectedException("第 " + i + " 段首行缩进越界：" + firstLineChars);
            }
            float lineSpacing = (float) p.optDouble("lineSpacing", 1.0d);
            if (!(lineSpacing >= 0.5f) || !(lineSpacing <= 5.0f)) {
                throw new RejectedException("第 " + i + " 段行距越界：" + lineSpacing);
            }
            float spaceAfterPt = (float) p.optDouble("spaceAfterPt", 0.0d);
            if (!(spaceAfterPt >= 0.0f) || !(spaceAfterPt <= 400.0f)) {
                throw new RejectedException("第 " + i + " 段段后间距越界：" + spaceAfterPt);
            }
            paragraphs.add(new Paragraph(
                    text,
                    normalizeAlign(p.optString("align", "left")),
                    sizePt,
                    p.optBoolean("bold", false),
                    firstLineChars,
                    lineSpacing,
                    spaceAfterPt,
                    p.optBoolean("heading", false),
                    p.optInt("level", 0)));
        }
        int w = o.optInt("pageWidthPt", A4_WIDTH_PT);
        int h = o.optInt("pageHeightPt", A4_HEIGHT_PT);
        int margin = o.optInt("marginPt", MARGIN_PT);
        if (w < 200 || w > 5000 || h < 200 || h > 5000) {
            throw new RejectedException("页面尺寸越界：" + w + "x" + h);
        }
        if (margin < 0 || margin * 2 >= Math.min(w, h)) {
            throw new RejectedException("页边距越界：" + margin);
        }
        long timeoutMs = o.optLong("timeoutMs", 15000L);
        if (timeoutMs < 100L || timeoutMs > 120000L) {
            timeoutMs = 15000L;
        }
        return new Request(o.optString("filename", "potbot.pdf"), title, paragraphs, w, h, margin,
                timeoutMs);
    }

    private static String normalizeAlign(String raw) {
        if (raw == null) {
            return "left";
        }
        String a = raw.trim().toLowerCase(Locale.ROOT);
        if ("center".equals(a) || "right".equals(a) || "justify".equals(a)
                || "distribute".equals(a)) {
            return a;
        }
        return "left";
    }

    /** 段落对齐 → {@link Layout.Alignment}（纯函数，便于静态检查引用）。 */
    static Layout.Alignment alignmentOf(String align) {
        if ("center".equals(align)) {
            return Layout.Alignment.ALIGN_CENTER;
        }
        if ("right".equals(align)) {
            return Layout.Alignment.ALIGN_OPPOSITE;
        }
        return Layout.Alignment.ALIGN_NORMAL;
    }

    /** 是否要求两端对齐（API 26+ 才有 justification mode）。 */
    static boolean wantsJustify(String align) {
        return "justify".equals(align) || "distribute".equals(align);
    }

    // ------------------------------------------------------------- 排版

    /**
     * 把文档排到 PDF 页面上并写入 {@code out}。
     *
     * **不关闭** {@code out}（关闭失败必须由调用方单独判定），但会关闭 {@link PdfDocument}。
     * 自报页数在返回的 {@link Result} 里——调用方**必须**再走 {@link PotbotPdfReadback} 独立读回。
     */
    static Result render(Request request, OutputStream out)
            throws NoEngineException, TimeoutException, LayoutException, IOException {
        if (request == null) {
            throw new LayoutException("请求为空。");
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.KITKAT) {
            // API < 19 没有 android.graphics.pdf.PdfDocument：设备上**没有可用排版引擎**。
            throw new NoEngineException(
                    "本设备 API " + Build.VERSION.SDK_INT + " 低于 19，没有 PdfDocument 排版引擎。");
        }

        final long started = System.nanoTime();
        final long deadline = started + request.timeoutMs * 1_000_000L;

        PdfDocument doc;
        try {
            doc = new PdfDocument();
        } catch (Throwable e) {
            throw new NoEngineException(
                    "无法创建 PdfDocument 排版引擎：" + e.getClass().getSimpleName(), e);
        }

        Renderer renderer = new Renderer(doc, request, deadline);
        try {
            renderer.run();
            doc.writeTo(out);
        } catch (TimeoutException e) {
            throw e;
        } catch (NoEngineException e) {
            throw e;
        } catch (IOException e) {
            throw e;
        } catch (Throwable e) {
            throw new LayoutException("排版过程出错：" + e.getClass().getSimpleName() + " " + safe(e));
        } finally {
            try {
                doc.close();
            } catch (Throwable ignored) {
                // 关闭失败不改写已经发生的分类；写盘/关闭流的失败由调用方判定。
            }
        }

        long layoutMs = (System.nanoTime() - started) / 1_000_000L;
        return new Result(renderer.pageCount, request.paragraphs.size(), layoutMs, ENGINE_NAME);
    }

    /** 逐行摆放、按需换页的渲染器（行级分页，超长段落跨页续排）。 */
    private static final class Renderer {
        private final PdfDocument doc;
        private final Request request;
        private final long deadline;

        private PdfDocument.Page page;
        private Canvas canvas;
        private float y;
        private int pageCount;

        private final float contentLeft;
        private final float contentWidth;
        private final float contentTop;
        private final float contentBottom;

        Renderer(PdfDocument doc, Request request, long deadline) {
            this.doc = doc;
            this.request = request;
            this.deadline = deadline;
            this.contentLeft = request.marginPt;
            this.contentWidth = request.pageWidthPt - request.marginPt * 2.0f;
            this.contentTop = request.marginPt;
            this.contentBottom = request.pageHeightPt - request.marginPt;
        }

        void run() throws TimeoutException, NoEngineException {
            checkDeadline();
            newPage();

            if (request.title != null && !request.title.trim().isEmpty()) {
                TextPaint tp = paint(18.0f, true);
                StaticLayout sl = buildLayout(request.title, tp, Layout.Alignment.ALIGN_CENTER,
                        contentWidth, 1.2f, 0.0f, false);
                y = place(sl, 12.0f);
            }

            for (Paragraph p : request.paragraphs) {
                checkDeadline();
                TextPaint tp = paint(p.sizePt, p.bold || p.heading);
                StaticLayout sl = buildLayout(p.text == null ? "" : p.text, tp,
                        alignmentOf(p.align), contentWidth, p.lineSpacing,
                        p.firstLineChars * p.sizePt, wantsJustify(p.align));
                y = place(sl, p.spaceAfterPt);
            }

            if (page != null) {
                doc.finishPage(page);
                page = null;
                canvas = null;
            }
        }

        /** 摆放一个 layout（必要时跨页），返回该段落底部的 y。 */
        private float place(StaticLayout sl, float spaceAfterPt)
                throws TimeoutException, NoEngineException {
            int lineCount = sl.getLineCount();
            if (lineCount == 0) {
                return y + spaceAfterPt;
            }
            int line = 0;
            while (line < lineCount) {
                checkDeadline();
                float lineHeight = (float) sl.getLineBottom(line) - (float) sl.getLineTop(line);
                // 当前页连这一行都放不下，且本页已经排过内容 -> 换页重排。
                if (y + lineHeight > contentBottom && y > contentTop + 0.5f) {
                    newPage();
                }
                int last = line;
                while (last < lineCount
                        && y + ((float) sl.getLineBottom(last) - (float) sl.getLineTop(line))
                        <= contentBottom) {
                    last++;
                }
                if (last == line) {
                    // 空页仍放不下单行（例如页面高度非法）：不截断，直接放行一行，避免死循环。
                    last = line + 1;
                }
                drawLines(sl, line, last, y - (float) sl.getLineTop(line));
                y += (float) sl.getLineTop(last) - (float) sl.getLineTop(line);
                line = last;
                if (line < lineCount) {
                    newPage();
                }
            }
            return y + spaceAfterPt;
        }

        /** 只画 [from, to) 行——clip + translate 的标准做法，不做任何截断式改写。 */
        private void drawLines(StaticLayout sl, int from, int to, float topY) {
            canvas.save();
            canvas.clipRect(contentLeft, topY + (float) sl.getLineTop(from),
                    contentLeft + contentWidth, topY + (float) sl.getLineBottom(to - 1) + 2.0f);
            canvas.translate(contentLeft, topY);
            sl.draw(canvas);
            canvas.restore();
        }

        private TextPaint paint(float sizePt, boolean bold) {
            TextPaint tp = new TextPaint(Paint.ANTI_ALIAS_FLAG);
            tp.setColor(Color.BLACK);
            tp.setTextSize(sizePt);
            tp.setTypeface(Typeface.create(Typeface.DEFAULT,
                    bold ? Typeface.BOLD : Typeface.NORMAL));
            return tp;
        }

        private StaticLayout buildLayout(String text, TextPaint paint, Layout.Alignment alignment,
                                         float width, float lineSpacing, float firstLineIndentPt,
                                         boolean justify) {
            CharSequence body = text;
            if (firstLineIndentPt > 0.01f) {
                SpannableStringBuilder sb = new SpannableStringBuilder(text);
                if (sb.length() > 0) {
                    sb.setSpan(new LeadingMarginSpan.Standard((int) firstLineIndentPt, 0), 0,
                            sb.length(), Spanned.SPAN_INCLUSIVE_EXCLUSIVE);
                }
                body = sb;
            }
            int safeWidth = Math.max(1, (int) Math.floor(width));
            StaticLayout.Builder b = StaticLayout.Builder
                    .obtain(body, 0, body.length(), paint, safeWidth)
                    .setAlignment(alignment)
                    .setLineSpacing(0.0f, lineSpacing)
                    .setIncludePad(false);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                b.setBreakStrategy(Layout.BREAK_STRATEGY_HIGH_QUALITY);
            }
            if (justify && alignment == Layout.Alignment.ALIGN_NORMAL
                    && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                b.setJustificationMode(Layout.JUSTIFICATION_MODE_INTER_WORD);
            }
            return b.build();
        }

        private void newPage() throws TimeoutException, NoEngineException {
            checkDeadline();
            if (page != null) {
                doc.finishPage(page);
                page = null;
                canvas = null;
            }
            pageCount++;
            PdfDocument.PageInfo info = new PdfDocument.PageInfo.Builder(
                    request.pageWidthPt, request.pageHeightPt, pageCount).create();
            try {
                page = doc.startPage(info);
            } catch (Throwable e) {
                throw new NoEngineException("无法开始第 " + pageCount + " 页（排版引擎不可用）："
                        + e.getClass().getSimpleName() + " " + safe(e), e);
            }
            canvas = page.getCanvas();
            y = contentTop;
            drawFooter(pageCount);
        }

        private void drawFooter(int number) {
            TextPaint tp = paint(9.0f, false);
            tp.setColor(Color.DKGRAY);
            String label = String.valueOf(number);
            float w = tp.measureText(label);
            canvas.drawText(label, (request.pageWidthPt - w) / 2.0f,
                    request.pageHeightPt - contentTop / 2.0f, tp);
        }

        private void checkDeadline() throws TimeoutException {
            if (System.nanoTime() > deadline) {
                throw new TimeoutException("排版超过 deadline（" + request.timeoutMs + " ms）。");
            }
        }
    }

    private static String safe(Throwable e) {
        String m = e == null ? null : e.getMessage();
        if (m == null) {
            return "";
        }
        return m.length() > 200 ? m.substring(0, 200) : m;
    }
}
