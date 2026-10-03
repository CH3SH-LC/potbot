package com.potbot.demo;

import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.pdf.PdfRenderer;
import android.os.ParcelFileDescriptor;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;

/**
 * design-05 **WF-089（手机侧）** 的**独立 PDF 读回器**。
 *
 * ## 纪律（与电脑侧的 `apps/demo/rendering/pdf-readback.ts` 同一条）
 *
 * **没有读回证据就不许说导出成功。** 写盘方自报"我写了一页 PDF"只是**必要条件**；
 * 本读回器从**盘上的字节**重新回答四件事：
 *
 *  1. `file_non_empty` —— 长度 > 0；
 *  2. `pdf_magic` —— 文件头是 `%PDF-`（**改扩展名伪造**的产物在这里被抓）；
 *  3. `pdf_parses` —— 交给 **系统自带的 PDF 解析器**（{@link PdfRenderer}）能打开、
 *     报得出页数，且**首页渲染出来有实际墨迹**（不是空白页）；
 *  4. `page_count` / `sha256` —— 与写入方自报的页数交叉核对、与写盘前的字节摘要一致。
 *
 * 判据 3 用的是系统解析器，**不是**我们自己的写入类——所以"写坏了但自报成功"不可能蒙混过关。
 *
 * ## 失败分类（互不冒充）
 *
 * | kind | 含义 |
 * |---|---|
 * | `read_failed` | 盘上文件读不回来（IO / 不存在） |
 * | `parser_failed` | 系统 PDF 解析器打不开（不是合法 PDF / 加密 / 解析异常） |
 * | `empty` | 读回来了但 0 字节 |
 * | `magic_mismatch` | 非空但不是 `%PDF-` 开头（改扩展名伪造） |
 * | `page_count_mismatch` | 解析出的页数与写入方自报页数不符 |
 * | `blank` | 首页渲染出来是纯空白（有页但没内容） |
 * | `digest_failed` | 读回字节的 sha256 与写盘前不一致 |
 *
 * **未验证声明**：本类只在 Android 运行期执行；本波**没有设备**，真机行为一律「未验证」。
 */
final class PotbotPdfReadback {

    private PotbotPdfReadback() {
    }

    /** 读回字节上限（与主宿主的 IO 上限一致，避免无限读入）。 */
    static final long MAX_READBACK_BYTES = 64L * 1024L * 1024L;
    /** 首页渲染的像素上限，避免畸形 PDF 撑爆内存。 */
    private static final int MAX_RENDER_DIMENSION = 4096;

    static final String PARSER_NAME = "android.graphics.pdf.PdfRenderer";

    /** 读回成功（四件事全过）。 */
    static final class Success {
        final long byteLength;
        final String sha256;
        /** 文件头前 5 字节（ASCII），用于报告里逐字粘贴。 */
        final String magic;
        /** 系统解析器读出的页数。 */
        final int parsedPageCount;
        /** 写入方自报页数（仅作交叉核对对象）。 */
        final int declaredPageCount;
        /** 首页渲染出的非白像素数（>0 表示真有内容）。 */
        final long inkPixels;
        final long elapsedMs;
        final String parser;

        Success(long byteLength, String sha256, String magic, int parsedPageCount,
                int declaredPageCount, long inkPixels, long elapsedMs, String parser) {
            this.byteLength = byteLength;
            this.sha256 = sha256;
            this.magic = magic;
            this.parsedPageCount = parsedPageCount;
            this.declaredPageCount = declaredPageCount;
            this.inkPixels = inkPixels;
            this.elapsedMs = elapsedMs;
            this.parser = parser;
        }
    }

    /** 读回失败（结构化）。 */
    static final class Failure {
        final String kind;
        final String message;
        final String detail;

        Failure(String kind, String message, String detail) {
            this.kind = kind;
            this.message = message;
            this.detail = detail;
        }
    }

    /** 读回结果（成功或失败，**不抛异常**——失败也是结果）。 */
    static final class Outcome {
        final Success result;
        final Failure failure;

        private Outcome(Success result, Failure failure) {
            this.result = result;
            this.failure = failure;
        }

        static Outcome ok(Success s) {
            return new Outcome(s, null);
        }

        static Outcome fail(String kind, String message, String detail) {
            return new Outcome(null, new Failure(kind, message, detail));
        }

        boolean isOk() {
            return result != null;
        }
    }

    /**
     * 独立读回并核对。
     *
     * @param file             盘上产物
     * @param declaredPageCount 写入方自报页数；<0 表示不核对页数
     * @param expectedSha256   写盘前字节的 sha256；null 表示不核对摘要
     */
    static Outcome inspect(File file, int declaredPageCount, String expectedSha256) {
        if (file == null) {
            return Outcome.fail("read_failed", "读回失败：文件为 null。", "");
        }
        final long started = System.nanoTime();

        byte[] bytes;
        try {
            bytes = readAll(file, MAX_READBACK_BYTES);
        } catch (Throwable e) {
            return Outcome.fail("read_failed",
                    "读回失败：无法读取 " + file.getAbsolutePath() + "（"
                            + e.getClass().getSimpleName() + " " + safe(e) + "）。", "");
        }
        if (bytes == null) {
            return Outcome.fail("read_failed", "读回失败：读取返回空流。", "");
        }
        if (bytes.length == 0) {
            return Outcome.fail("empty", "读回核对未通过：产物是 0 字节。", "");
        }

        String magic = ascii(bytes, 0, 5);
        if (!"%PDF-".equals(magic)) {
            return Outcome.fail("magic_mismatch",
                    "读回核对未通过：产物不是 PDF（文件头 " + quote(magic) + "，要求 %PDF-）。"
                            + "改扩展名伪造的产物在这里会被抓住。",
                    "byteLength=" + bytes.length);
        }

        String sha;
        try {
            sha = sha256Hex(bytes);
        } catch (Throwable e) {
            return Outcome.fail("digest_failed",
                    "读回核对未通过：无法计算读回字节的 SHA256（" + safe(e) + "）。", "");
        }
        if (expectedSha256 != null && !sha.equalsIgnoreCase(expectedSha256)) {
            return Outcome.fail("digest_failed",
                    "读回核对未通过：读回 sha256 " + sha + " 与写入内容 " + expectedSha256 + " 不符。",
                    "byteLength=" + bytes.length);
        }

        // ---- 交给**系统 PDF 解析器**独立解析（不信任我们自己的写入类） ----
        int parsedPages;
        long ink;
        ParcelFileDescriptor fd = null;
        PdfRenderer renderer = null;
        try {
            fd = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
            renderer = new PdfRenderer(fd);
            parsedPages = renderer.getPageCount();
            if (parsedPages <= 0) {
                return Outcome.fail("page_count_mismatch",
                        "读回核对未通过：系统解析器报出 0 页。", "");
            }
            ink = inkPixelsOfFirstPage(renderer);
        } catch (Throwable e) {
            return Outcome.fail("parser_failed",
                    "读回核对未通过：系统 PDF 解析器打不开产物（"
                            + e.getClass().getSimpleName() + " " + safe(e) + "）。", "");
        } finally {
            if (renderer != null) {
                try {
                    renderer.close();
                } catch (Throwable ignored) {
                    // 关闭失败不改写已发生的分类。
                }
            }
            if (fd != null) {
                try {
                    fd.close();
                } catch (Throwable ignored) {
                    // 同上。
                }
            }
        }

        if (declaredPageCount >= 0 && parsedPages != declaredPageCount) {
            return Outcome.fail("page_count_mismatch",
                    "读回核对未通过：写入方自报 " + declaredPageCount + " 页，系统解析器读出 "
                            + parsedPages + " 页。", "");
        }
        if (ink <= 0) {
            return Outcome.fail("blank",
                    "读回核对未通过：首页渲染出来是纯空白（有页但无内容）。", "");
        }

        long elapsedMs = (System.nanoTime() - started) / 1_000_000L;
        return Outcome.ok(new Success(bytes.length, sha, magic, parsedPages, declaredPageCount,
                ink, elapsedMs, PARSER_NAME));
    }

    /** 渲染首页到缩略图并数非白像素——"有页但空白"与"真有内容"由此分开。 */
    private static long inkPixelsOfFirstPage(PdfRenderer renderer) throws IOException {
        PdfRenderer.Page page = null;
        Bitmap bitmap = null;
        try {
            page = renderer.openPage(0);
            int w = page.getWidth();
            int h = page.getHeight();
            if (w <= 0 || h <= 0) {
                return -1L;
            }
            // 超大页面按比例缩到上限内，既省内存又不改变"有没有墨迹"的判断。
            float scale = Math.min(1.0f, (float) MAX_RENDER_DIMENSION / (float) Math.max(w, h));
            int rw = Math.max(1, Math.round(w * scale));
            int rh = Math.max(1, Math.round(h * scale));
            bitmap = Bitmap.createBitmap(rw, rh, Bitmap.Config.ARGB_8888);
            bitmap.eraseColor(Color.WHITE);
            page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);

            long ink = 0;
            // 采样步长：整页逐像素太慢，按不超过 200×200 个采样点统计即可判定"空白/非空白"。
            int stepX = Math.max(1, rw / 200);
            int stepY = Math.max(1, rh / 200);
            for (int py = 0; py < rh; py += stepY) {
                for (int px = 0; px < rw; px += stepX) {
                    int c = bitmap.getPixel(px, py);
                    int lum = (Color.red(c) * 299 + Color.green(c) * 587 + Color.blue(c) * 114) / 1000;
                    if (lum < 250) {
                        ink++;
                    }
                }
            }
            return ink;
        } finally {
            if (bitmap != null) {
                bitmap.recycle();
            }
            if (page != null) {
                try {
                    page.close();
                } catch (Throwable ignored) {
                    // 同上。
                }
            }
        }
    }

    private static byte[] readAll(File file, long max) throws IOException {
        if (file == null || !file.exists()) {
            throw new IOException("文件不存在");
        }
        try (InputStream in = new FileInputStream(file);
             ByteArrayOutputStream bos = new ByteArrayOutputStream()) {
            byte[] buf = new byte[16 * 1024];
            long total = 0;
            int n;
            while ((n = in.read(buf)) != -1) {
                total += n;
                if (total > max) {
                    throw new IOException("内容超过 " + max + " 字节上限");
                }
                bos.write(buf, 0, n);
            }
            return bos.toByteArray();
        }
    }

    private static String ascii(byte[] data, int from, int len) {
        StringBuilder sb = new StringBuilder(len);
        for (int i = from; i < from + len && i < data.length; i++) {
            int c = data[i] & 0xFF;
            sb.append(c >= 32 && c < 127 ? (char) c : '?');
        }
        return sb.toString();
    }

    private static String quote(String s) {
        return "\"" + s + "\"";
    }

    private static String sha256Hex(byte[] data) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        byte[] d = md.digest(data);
        StringBuilder sb = new StringBuilder(d.length * 2);
        for (byte b : d) {
            sb.append(Character.forDigit((b >> 4) & 0xF, 16));
            sb.append(Character.forDigit(b & 0xF, 16));
        }
        return sb.toString();
    }

    private static String safe(Throwable e) {
        String m = e == null ? null : e.getMessage();
        if (m == null) {
            return "";
        }
        return m.length() > 200 ? m.substring(0, 200) : m;
    }
}
