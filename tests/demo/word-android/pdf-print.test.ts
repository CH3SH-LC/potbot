/**
 * WCF-D62 / design-05-P8（WF-089 PDF 导出、WF-090 打印交接）的**手机侧**结构化判据。
 *
 * 起因：WCF-D53 只在**电脑侧**（Word COM）做到了 PDF 导出与打印交接；`docs/STATE.md`
 * 明记手机端 `MainActivity` 没有 `PrintManager`、`setDownloadListener` 明确拒绝浏览器
 * 下载路径 ⇒ **手机端 PDF/打印是真正的空白**，而目标平台是**安卓**。
 *
 * 本文件把这一批的合同变成可机判断言：
 *  1. PDF 导出**必须用真排版引擎**（`android.graphics.pdf.PdfDocument`），**不得改扩展名伪造**；
 *  2. 导出链顺序固定：排版 → 刷新 → **显式关闭** → **关闭后独立读回**
 *     （`%PDF-` 魔数 + 系统解析器页数 + 首页墨迹 + 摘要）→ 才允许 `pdf_exported_verified`；
 *  3. 失败分类**互不冒充**：无引擎 / 超时 / 空间不足 / 权限不足 / 空 / 非 PDF /
 *     页数不符 / 空白页 / 读回失败 / 摘要不符，各自独立状态；
 *  4. 打印交接**只到"已交接"**：`printed` 在源码里可证伪地恒为 `false`，
 *     状态类型**不可表达**"已打印/已提交"，且没有字符串字面量在非否定语境里宣称"已打印"。
 *
 * **未验证声明（必须明读）**：本文件**只断言源码结构**。真机运行期行为
 * （PdfDocument 实际出图、`PdfRenderer` 实际解析、`PrintManager` 实际被调起、
 * 打印机是否出纸）在本波**没有设备**，一律标「未验证」。
 * **不得**把这里的源码扫描当作真机证据。
 */

import { describe, expect, it } from 'vitest';

import { REPO_ROOT, readText } from '../support.js';
import {
  ANDROID_JAVA_SOURCES,
  ANDROID_MAIN_ACTIVITY,
  PRINT_ALLOWED_STATES,
  PRINT_FAILURE_STATUSES,
  PDF_ENGINE_FAILURE_STATUSES,
  PDF_READBACK_FAILURE_STATUSES,
  PDF_REQUIRED_STATUSES,
  RULE_PDF,
  RULE_PRINT,
  SUCCESS_STATUSES,
  enumMembers,
  extractMethodBody,
  javaStringLiterals,
  parseStatusConstants,
  reportsStatus,
  scanPdfExport,
  scanPrintHandoff,
} from './android-source.js';

// ---------------------------------------------------------------------------
// 合成镜像：引擎 / 读回器的"存在性 token"（结构与真实实现同形）
// ---------------------------------------------------------------------------

/** 真排版引擎 + 真读回器的存在性片段（干净臂）。 */
const ENGINE_TOKENS_FULL = `
import android.graphics.pdf.PdfDocument;
import android.graphics.pdf.PdfRenderer;
final class MirrorEngine {
    PdfDocument doc = new PdfDocument();
    int pages = renderer.getPageCount();
    boolean magicOk = "%PDF-".equals(magic);
    boolean shapeOk = isPdfMagic(bytes);
    String expectedSha256;
}
`;

/** 坏臂：读回器"只看长度"，没有魔数、没有系统解析器、没有摘要核对。 */
const ENGINE_TOKENS_LENGTH_ONLY = `
import android.graphics.pdf.PdfDocument;
final class MirrorEngine {
    PdfDocument doc = new PdfDocument();
    int pages = declaredPages;
}
`;

/** 干净镜像：PDF 导出链的真顺序（对照臂，防止扫描器恒报红）。 */
const CLEAN_PDF_MIRROR = `
public class Mirror {
    private void doExportPdf(String docJson) {
        try {
            layout = PotbotPdfLayout.render(request, os);
        } catch (Throwable e) {
            closeQuietly(os);
            reportStatus(false, ST_PDF_WRITE_FAILED, "写入失败");
            return;
        }
        try {
            os.close();
        } catch (Throwable e) {
            reportStatus(false, ST_PDF_CLOSE_FAILED, "关闭失败，内容可能不完整");
            return;
        }
        PotbotPdfReadback.Outcome readback = PotbotPdfReadback.inspect(out, layout.pageCount, null);
        if (!readback.isOk()) {
            reportStatus(false, pdfReadbackStatus(readback.failure.kind), "导出未验证");
            return;
        }
        reportStatus(true, ST_PDF_EXPORTED_VERIFIED, "已导出并独立读回核对通过");
    }

    private static String pdfReadbackStatus(String kind) {
        if ("empty".equals(kind)) { return ST_PDF_EMPTY; }
        if ("magic_mismatch".equals(kind)) { return ST_PDF_NOT_PDF; }
        if ("page_count_mismatch".equals(kind)) { return ST_PDF_PAGE_MISMATCH; }
        if ("blank".equals(kind)) { return ST_PDF_BLANK; }
        if ("digest_failed".equals(kind)) { return ST_PDF_COPY_READBACK_DIGEST_MISMATCH; }
        return ST_PDF_READBACK_FAILED;
    }

    private void engineFailures() {
        reportStatus(false, ST_PDF_NO_ENGINE, "无引擎");
        reportStatus(false, ST_PDF_TIMEOUT, "超时");
        reportStatus(false, ST_PDF_NO_SPACE, "空间不足");
        reportStatus(false, ST_PDF_PERMISSION_DENIED, "权限被拒");
    }
}
`;

/** 坏臂 A：排版完就宣称 verified，既不关闭也不读回。 */
const BAD_PDF_NO_READBACK = `
public class Bad {
    private void doExportPdf(String docJson) {
        layout = PotbotPdfLayout.render(request, os);
        reportStatus(true, ST_PDF_EXPORTED_VERIFIED, "排版完了就算导出成功");
    }
    private static String pdfReadbackStatus(String kind) {
        if ("empty".equals(kind)) { return ST_PDF_EMPTY; }
        if ("magic_mismatch".equals(kind)) { return ST_PDF_NOT_PDF; }
        if ("page_count_mismatch".equals(kind)) { return ST_PDF_PAGE_MISMATCH; }
        if ("blank".equals(kind)) { return ST_PDF_BLANK; }
        if ("digest_failed".equals(kind)) { return ST_PDF_COPY_READBACK_DIGEST_MISMATCH; }
        return ST_PDF_READBACK_FAILED;
    }
    private void engineFailures() {
        reportStatus(false, ST_PDF_NO_ENGINE, "无引擎");
        reportStatus(false, ST_PDF_TIMEOUT, "超时");
        reportStatus(false, ST_PDF_NO_SPACE, "空间不足");
        reportStatus(false, ST_PDF_PERMISSION_DENIED, "权限被拒");
    }
}
`;

/** 坏臂 B：先读回、后关闭（没有做到"关闭之后读回"）。 */
const BAD_PDF_READBACK_BEFORE_CLOSE = `
public class Bad {
    private void doExportPdf(String docJson) {
        layout = PotbotPdfLayout.render(request, os);
        PotbotPdfReadback.Outcome readback = PotbotPdfReadback.inspect(out, layout.pageCount, null);
        try { os.close(); } catch (Throwable e) { reportStatus(false, ST_PDF_CLOSE_FAILED, "关闭失败"); return; }
        reportStatus(true, ST_PDF_EXPORTED_VERIFIED, "读回过了");
    }
    private static String pdfReadbackStatus(String kind) {
        if ("empty".equals(kind)) { return ST_PDF_EMPTY; }
        if ("magic_mismatch".equals(kind)) { return ST_PDF_NOT_PDF; }
        if ("page_count_mismatch".equals(kind)) { return ST_PDF_PAGE_MISMATCH; }
        if ("blank".equals(kind)) { return ST_PDF_BLANK; }
        if ("digest_failed".equals(kind)) { return ST_PDF_COPY_READBACK_DIGEST_MISMATCH; }
        return ST_PDF_READBACK_FAILED;
    }
    private void engineFailures() {
        reportStatus(false, ST_PDF_NO_ENGINE, "无引擎");
        reportStatus(false, ST_PDF_TIMEOUT, "超时");
        reportStatus(false, ST_PDF_NO_SPACE, "空间不足");
        reportStatus(false, ST_PDF_PERMISSION_DENIED, "权限被拒");
    }
}
`;

/** 坏臂 C：失败状态被合并成一种笼统的 ST_PDF_READBACK_FAILED。 */
const BAD_PDF_STATES_COLLAPSED = `
public class Bad {
    private void doExportPdf(String docJson) {
        layout = PotbotPdfLayout.render(request, os);
        try { os.close(); } catch (Throwable e) { reportStatus(false, ST_PDF_READBACK_FAILED, "关闭也算读回失败"); return; }
        PotbotPdfReadback.Outcome readback = PotbotPdfReadback.inspect(out, layout.pageCount, null);
        if (!readback.isOk()) { reportStatus(false, ST_PDF_READBACK_FAILED, "读回失败"); return; }
        reportStatus(true, ST_PDF_EXPORTED_VERIFIED, "导出成功");
    }
    private static String pdfReadbackStatus(String kind) {
        return ST_PDF_READBACK_FAILED;
    }
}
`;

// ---------------------------------------------------------------------------
// 打印：合成镜像
// ---------------------------------------------------------------------------

/** 干净镜像：只到"已交接"，printed 恒假，状态类型只有两态。 */
const CLEAN_PRINT_MIRROR = `
import android.print.PrintManager;
import android.print.PrintDocumentAdapter;
final class MirrorPrint {
    static final boolean PRINTED = false;

    enum State {
        PREPARED,
        HANDED_OFF
    }

    static final String FAILURE_TARGET_MISSING = "target_missing";
    static final String FAILURE_TARGET_DIGEST_MISMATCH = "target_digest_mismatch";
    static final String FAILURE_HANDOFF_UNAVAILABLE = "handoff_unavailable";
    static final String FAILURE_PERMISSION_DENIED = "permission_denied";
    static final String FAILURE_OPEN_FAILED = "open_failed";

    static final class Outcome {
        private Outcome(State state, boolean printed) { }
        static Outcome prepared(String failureKind, String detail, String jobName, int pageCount) {
            return new Outcome(State.PREPARED, PRINTED);
        }
        static Outcome handedOff(String detail, String jobName, int pageCount, String path) {
            return new Outcome(State.HANDED_OFF, PRINTED);
        }
    }

    static Outcome handOff(Context context, String jobName, File verifiedPdf,
                           String expectedSha256, int pageCount) {
        if (!actual.equalsIgnoreCase(expectedSha256)) {
            return Outcome.prepared(FAILURE_TARGET_DIGEST_MISMATCH, "摘要不一致", jobName, pageCount);
        }
        return Outcome.handedOff("已交给系统打印服务", jobName, pageCount, HANDOFF_PATH);
    }

    private static String sha256Of(File file) { return ""; }

    private void doPrintHandoff() {
        final String src = verifiedPdfPath;
        final String sha = verifiedPdfSha256;
        if (src == null || sha == null) {
            reportStatus(false, ST_PRINT_NOT_VERIFIED, "本会话还没有通过读回核对的 PDF。");
            return;
        }
        PotbotPrintHandoff.Outcome outcome = PotbotPrintHandoff.handOff(this, name, new File(src), sha, pages);
        if (outcome.isHandedOff()) {
            reportStatus(true, ST_PRINT_HANDED_OFF, "已交接；这不代表已打印。");
            return;
        }
        reportStatus(false, printFailureStatus(outcome.failureKind), "未交接");
    }

    private static String printFailureStatus(String kind) {
        if ("target_missing".equals(kind)) { return ST_PRINT_TARGET_MISSING; }
        if ("target_digest_mismatch".equals(kind)) { return ST_PRINT_DIGEST_MISMATCH; }
        if ("permission_denied".equals(kind)) { return ST_PRINT_PERMISSION_DENIED; }
        if ("open_failed".equals(kind)) { return ST_PRINT_OPEN_FAILED; }
        return ST_PRINT_UNAVAILABLE;
    }
}
`;

/** 坏臂 A：`printed` 被置真。 */
const BAD_PRINT_PRINTED_TRUE = CLEAN_PRINT_MIRROR
  .replace('static final boolean PRINTED = false;', 'static final boolean PRINTED = true;');

/** 坏臂 B：状态类型里出现"已打印"这一态。 */
const BAD_PRINT_STATE_PRINTED = CLEAN_PRINT_MIRROR
  .replace('        HANDED_OFF\n', '        HANDED_OFF,\n        PRINTED\n');

/** 坏臂 C：在非否定语境里宣称"已打印"。 */
const BAD_PRINT_CLAIMS = CLEAN_PRINT_MIRROR
  .replace('"已交接；这不代表已打印。"', '"已交接；纸张已打印。"');

/** 坏臂 D：交接前不检查是否已有"通过读回核对"的 PDF。 */
const BAD_PRINT_NO_GATE = CLEAN_PRINT_MIRROR
  .replace(
    `        final String src = verifiedPdfPath;
        final String sha = verifiedPdfSha256;
        if (src == null || sha == null) {
            reportStatus(false, ST_PRINT_NOT_VERIFIED, "本会话还没有通过读回核对的 PDF。");
            return;
        }`,
    `        final String src = anyPathFromPage;
        final String sha = anyShaFromPage;`,
  );

const PDF_ALL = (mirror: string, engineTokens = ENGINE_TOKENS_FULL): string =>
  `${mirror}\n${engineTokens}`;

describe('PDF 导出扫描器的判别力（先证明尺子有刻度）', () => {
  it('干净镜像：零违规（对照臂，防止扫描器恒报红）', () => {
    expect(scanPdfExport(CLEAN_PDF_MIRROR, PDF_ALL(CLEAN_PDF_MIRROR))).toEqual([]);
  });

  it('抓得到「排版完就宣称 verified，既不关闭也不读回」', () => {
    const rules = scanPdfExport(BAD_PDF_NO_READBACK, PDF_ALL(BAD_PDF_NO_READBACK)).map((v) => v.rule);
    expect(rules).toContain(RULE_PDF.explicit_close_missing);
    expect(rules).toContain(RULE_PDF.readback_missing);
    expect(rules).toContain(RULE_PDF.verified_before_readback);
  });

  it('抓得到「先读回、后关闭」的顺序颠倒', () => {
    const rules = scanPdfExport(
      BAD_PDF_READBACK_BEFORE_CLOSE, PDF_ALL(BAD_PDF_READBACK_BEFORE_CLOSE),
    ).map((v) => v.rule);
    expect(rules).toContain(RULE_PDF.readback_before_close);
  });

  it('抓得到「读回只看长度」（没有魔数、没有系统解析器、没有摘要核对）', () => {
    const rules = scanPdfExport(CLEAN_PDF_MIRROR, PDF_ALL(CLEAN_PDF_MIRROR, ENGINE_TOKENS_LENGTH_ONLY))
      .map((v) => v.rule);
    expect(rules).toContain(RULE_PDF.magic_missing);
    expect(rules).toContain(RULE_PDF.parser_missing);
    expect(rules).toContain(RULE_PDF.digest_missing);
  });

  it('抓得到「失败状态被合并成一种」', () => {
    const rules = scanPdfExport(
      BAD_PDF_STATES_COLLAPSED, PDF_ALL(BAD_PDF_STATES_COLLAPSED),
    ).map((v) => v.rule);
    expect(rules).toContain(RULE_PDF.states_collapsed);
  });

  it('抓得到「没有真排版引擎（只有改名的假导出）」', () => {
    const fake = CLEAN_PDF_MIRROR.replace('PotbotPdfLayout.render(', 'renameDocxToPdf(');
    const rules = scanPdfExport(fake, `${fake}\nfinal class NoEngine { }`).map((v) => v.rule);
    expect(rules).toContain(RULE_PDF.engine_missing);
    expect(rules).toContain(RULE_PDF.render_not_called);
  });
});

describe('打印交接扫描器的判别力（先证明尺子有刻度）', () => {
  it('干净镜像：零违规（对照臂）', () => {
    expect(scanPrintHandoff(CLEAN_PRINT_MIRROR, CLEAN_PRINT_MIRROR)).toEqual([]);
  });

  it('抓得到「printed 被置真」', () => {
    const rules = scanPrintHandoff(BAD_PRINT_PRINTED_TRUE, BAD_PRINT_PRINTED_TRUE).map((v) => v.rule);
    expect(rules).toContain(RULE_PRINT.printed_not_false);
  });

  it('抓得到「状态类型里能表达"已打印"」', () => {
    const rules = scanPrintHandoff(BAD_PRINT_STATE_PRINTED, BAD_PRINT_STATE_PRINTED).map((v) => v.rule);
    expect(rules).toContain(RULE_PRINT.state_expresses_printed);
  });

  it('抓得到「在非否定语境里宣称纸张已打印」', () => {
    const rules = scanPrintHandoff(BAD_PRINT_CLAIMS, BAD_PRINT_CLAIMS).map((v) => v.rule);
    expect(rules).toContain(RULE_PRINT.claims_printed);
  });

  it('抓得到「交接前不检查是否已有通过读回核对的 PDF」', () => {
    const rules = scanPrintHandoff(BAD_PRINT_NO_GATE, BAD_PRINT_NO_GATE).map((v) => v.rule);
    expect(rules).toContain(RULE_PRINT.verification_gate_missing);
  });

  it('抓得到「根本没接系统打印服务」', () => {
    const bare = CLEAN_PRINT_MIRROR.replace('PrintManager', 'X').replace('PrintDocumentAdapter', 'Y');
    const rules = scanPrintHandoff(bare, bare).map((v) => v.rule);
    expect(rules).toContain(RULE_PRINT.manager_missing);
  });
});

// ---------------------------------------------------------------------------
// 真实源码
// ---------------------------------------------------------------------------

describe('真实源码：Android 手机侧 PDF 导出（WF-089）', () => {
  const java = readText(`${REPO_ROOT}/${ANDROID_MAIN_ACTIVITY}`);
  const allJava = ANDROID_JAVA_SOURCES
    .map((p) => readText(`${REPO_ROOT}/${p}`))
    .join('\n');

  it('四个 Android 源都存在且非空（否则本组判据无从成立）', () => {
    expect(allJava.length, '[未满足] Android Java 源为空或缺失').toBeGreaterThan(4000);
  });

  it('未发现 PDF 导出链违规：真引擎 → 显式关闭 → 关闭后独立读回 → 才 verified', () => {
    const violations = scanPdfExport(java, allJava);
    const rendered = violations.map((v) => `[${v.rule}] ${v.detail}`).join('\n');
    expect(violations, `[未通过] PDF 导出链出现违规：\n${rendered}`).toEqual([]);
  });

  it('导出路径确有"排版 → 关闭 → 读回 → 魔数/页数/墨迹/摘要 → verified"的固定顺序', () => {
    const body = extractMethodBody(java, 'private void doExportPdf(');
    expect(body, '[未满足] 找不到 doExportPdf(...)').not.toBeNull();
    const text = body ?? '';
    const idxRender = text.indexOf('PotbotPdfLayout.render(');
    const idxClose = text.indexOf('.close();');
    const idxReadback = text.indexOf('PotbotPdfReadback.inspect(');
    const idxVerified = text.indexOf('ST_PDF_EXPORTED_VERIFIED');
    expect(idxRender, '[未通过] 没有调用真排版引擎').toBeGreaterThan(-1);
    expect(idxClose, '[未通过] 没有显式 close()').toBeGreaterThan(idxRender);
    expect(idxReadback, '[未通过] 没有关闭后独立读回').toBeGreaterThan(idxClose);
    expect(idxVerified, '[未通过] verified 出现在读回之前').toBeGreaterThan(idxReadback);
    expect(reportsStatus(text, true, 'ST_PDF_EXPORTED_VERIFIED'),
      '[未通过] 成功回报未锚定 ST_PDF_EXPORTED_VERIFIED').toBe(true);
  });

  it('用的是真排版引擎（android.graphics.pdf.PdfDocument），不是改扩展名', () => {
    expect(allJava).toContain('android.graphics.pdf.PdfDocument');
    // 真的在页面上排版：有页面几何与真实文本绘制，而不是复制 DOCX 字节换个名字。
    expect(allJava).toMatch(/startPage\(/);
    expect(allJava).toMatch(/StaticLayout/);
    expect(allJava).toMatch(/A4_WIDTH_PT|595/);
    // 明确拒绝"改名当导出"。
    expect(allJava).not.toMatch(/renameTo\(/);
  });

  it('读回器用系统解析器独立核对：魔数 / 页数 / 首页墨迹 / 摘要', () => {
    const rb = readText(`${REPO_ROOT}/apps/android/app/src/main/java/com/potbot/demo/PotbotPdfReadback.java`);
    expect(rb).toContain('android.graphics.pdf.PdfRenderer');   // 系统解析器，不是自己的写入类
    expect(rb).toContain('getPageCount()');
    expect(rb).toContain('"%PDF-"');
    expect(rb).toContain('openPage(0)');
    expect(rb).toMatch(/render\(bitmap/);
    expect(rb).toContain('expectedSha256');
    expect(rb).toContain('sha256Hex(bytes)');
  });

  it('失败分类互不冒充：无引擎/超时/空间/权限/空/非PDF/页数/空白/读回/摘要 各自不同值', () => {
    const constants = parseStatusConstants(java);
    const values: string[] = [];
    for (const name of PDF_REQUIRED_STATUSES) {
      const value = constants.get(name);
      expect(value, `[未满足] 缺少状态常量 ${name}`).toBeDefined();
      values.push(value ?? '');
    }
    expect(new Set(values).size, `[未通过] PDF 失败状态取重：${values.join(', ')}`).toBe(values.length);
    // 成功状态必须与所有失败状态不同名不同值。
    expect(constants.get('ST_PDF_EXPORTED_VERIFIED')).toBe('pdf_exported_verified');
    expect(values.includes('pdf_exported_verified')).toBe(false);
  });

  it('读回分类函数把每种读回失败映射到**不同**的状态', () => {
    const body = extractMethodBody(java, 'private static String pdfReadbackStatus(');
    expect(body, '[未满足] 找不到 pdfReadbackStatus(...)').not.toBeNull();
    const text = body ?? '';
    const idxMap = PDF_READBACK_FAILURE_STATUSES.map((t) => text.indexOf(t));
    for (let i = 0; i < idxMap.length; i += 1) {
      expect(idxMap[i], `[未通过] 读回分类缺少 ${PDF_READBACK_FAILURE_STATUSES[i]}`).toBeGreaterThan(-1);
    }
    const constants = parseStatusConstants(java);
    const values = PDF_READBACK_FAILURE_STATUSES.map((t) => constants.get(t) ?? '');
    expect(new Set(values).size, `[未通过] 读回状态取重：${values.join(', ')}`).toBe(values.length);
  });

  it('引擎段与读回段的状态值不重合（两个段不互相冒充）', () => {
    const constants = parseStatusConstants(java);
    const engine = PDF_ENGINE_FAILURE_STATUSES.map((t) => constants.get(t) ?? '');
    const readback = PDF_READBACK_FAILURE_STATUSES.map((t) => constants.get(t) ?? '');
    const overlap = engine.filter((v) => readback.includes(v));
    expect(overlap, `[未通过] 引擎段与读回段状态重合：${overlap.join(', ')}`).toEqual([]);
  });

  it('另存 PDF 副本同样是"关闭后读回核对"（复用 D09 纪律，未放松）', () => {
    const body = extractMethodBody(java, 'private void writeAndVerifyPdfCopy(');
    expect(body, '[未满足] 找不到 writeAndVerifyPdfCopy(...)').not.toBeNull();
    const text = body ?? '';
    const idxClose = text.indexOf('.close();');
    const idxReadback = text.indexOf('readAllContent(target');
    const idxMagic = text.indexOf('isPdfMagic(');
    const idxLength = text.indexOf('readBack.length != bytes.length');
    const idxDigest = text.indexOf('readBackSha.equalsIgnoreCase(writtenSha)');
    const idxVerified = text.indexOf('ST_PDF_COPY_VERIFIED');
    expect(idxClose, '[未通过] 没有显式 close()').toBeGreaterThan(-1);
    expect(idxReadback, '[未通过] 没有关闭后读回目标 URI').toBeGreaterThan(idxClose);
    expect(idxMagic, '[未通过] 没有 %PDF- 魔数检查').toBeGreaterThan(idxReadback);
    expect(idxLength, '[未通过] 没有读回长度比对').toBeGreaterThan(idxMagic);
    expect(idxDigest, '[未通过] 没有读回摘要比对').toBeGreaterThan(idxLength);
    expect(idxVerified, '[未通过] verified 出现在核对完成之前').toBeGreaterThan(idxDigest);
  });
});

describe('真实源码：Android 手机侧打印交接（WF-090）——只标"已交接"', () => {
  const java = readText(`${REPO_ROOT}/${ANDROID_MAIN_ACTIVITY}`);
  const allJava = ANDROID_JAVA_SOURCES
    .map((p) => readText(`${REPO_ROOT}/${p}`))
    .join('\n');

  it('未发现打印链违规：不接"已打印"、不绕过核验闸门', () => {
    const violations = scanPrintHandoff(java, allJava);
    const rendered = violations.map((v) => `[${v.rule}] ${v.detail}`).join('\n');
    expect(violations, `[未通过] 打印交接链出现违规：\n${rendered}`).toEqual([]);
  });

  it('接了系统打印服务：PrintManager + PrintDocumentAdapter', () => {
    expect(allJava).toContain('android.print.PrintManager');
    expect(allJava).toContain('PrintDocumentAdapter');
    expect(allJava).toMatch(/manager\.print\(/);
    expect(allJava).toContain('Context.PRINT_SERVICE');
    expect(allJava).toMatch(/onWrite\(/);
  });

  it('`printed` 在类型上不可为真：static final boolean PRINTED = false', () => {
    const print = readText(`${REPO_ROOT}/apps/android/app/src/main/java/com/potbot/demo/PotbotPrintHandoff.java`);
    expect(print).toMatch(/static\s+final\s+boolean\s+PRINTED\s*=\s*false\s*;/);
    expect(print).not.toMatch(/PRINTED\s*=\s*true/);
    // 两个结果工厂都原样带出 PRINTED，没有任何路径把 true 传进去。
    expect(print).toMatch(/new Outcome\(State\.HANDED_OFF,\s*PRINTED,/);
    expect(print).toMatch(/new Outcome\(State\.PREPARED,\s*PRINTED,/);
    expect(print).not.toMatch(/new Outcome\(State\.[A-Z_]+,\s*true/);
  });

  it('状态类型不可表达"已打印/已提交"：只有 PREPARED 与 HANDED_OFF', () => {
    const print = readText(`${REPO_ROOT}/apps/android/app/src/main/java/com/potbot/demo/PotbotPrintHandoff.java`);
    const members = enumMembers(print, 'State');
    expect(members, '[未满足] 找不到打印状态枚举 State').not.toBeNull();
    expect([...(members ?? [])].sort()).toEqual([...PRINT_ALLOWED_STATES].sort());
    // 七态里"已提交/已完成"在本批**不可表达**（没有可信回执）。
    expect(members ?? []).not.toContain('SUBMITTED');
    expect(members ?? []).not.toContain('CONFIRMED_COMPLETE');
    expect(members ?? []).not.toContain('PRINTED');
  });

  it('没有任何字符串字面量在非否定语境里宣称"已打印"', () => {
    const offenders = javaStringLiterals(allJava)
      .filter((s) => s.includes('已打印') && !/不|没|无|未|非/.test(s));
    expect(offenders, `[未通过] 存在宣称已打印的字面量：${offenders.join(' | ')}`).toEqual([]);
  });

  it('交接前有核验闸门：只交已通过读回核对的产物，且重新核对盘上摘要', () => {
    const body = extractMethodBody(java, 'private void doPrintHandoff(');
    expect(body, '[未满足] 找不到 doPrintHandoff(...)').not.toBeNull();
    const text = body ?? '';
    const idxGate = text.indexOf('verifiedPdfPath');
    const idxHandoff = text.indexOf('PotbotPrintHandoff.handOff(');
    expect(idxGate, '[未通过] 交接前没有检查是否已有通过核对的 PDF').toBeGreaterThan(-1);
    expect(idxHandoff, '[未通过] 没有调用打印交接').toBeGreaterThan(idxGate);
    expect(text, '[未通过] 未核验时没有明确拒绝').toContain('ST_PRINT_NOT_VERIFIED');
    expect(reportsStatus(text, true, 'ST_PRINT_HANDED_OFF'),
      '[未通过] 已交接没有以 ST_PRINT_HANDED_OFF 回报').toBe(true);

    const print = readText(`${REPO_ROOT}/apps/android/app/src/main/java/com/potbot/demo/PotbotPrintHandoff.java`);
    expect(print, '[未通过] 交接前没有重新计算盘上摘要').toContain('sha256Of(');
    expect(print, '[未通过] 摘要不一致时没有拒绝').toContain('target_digest_mismatch');
  });

  it('交接失败原因互不相同（缺件/摘要不符/无打印服务/权限/读取失败）', () => {
    const constants = parseStatusConstants(java);
    const values: string[] = [];
    for (const name of PRINT_FAILURE_STATUSES) {
      const value = constants.get(name);
      expect(value, `[未满足] 缺少状态常量 ${name}`).toBeDefined();
      values.push(value ?? '');
    }
    expect(new Set(values).size, `[未通过] 交接失败状态取重：${values.join(', ')}`).toBe(values.length);
    // "已交接"与所有失败状态不同名不同值。
    expect(constants.get('ST_PRINT_HANDED_OFF')).toBe('print_handed_off');
    expect(values.includes('print_handed_off')).toBe(false);
  });

  it('桥的既有回调签名未被改动（PDF/打印只在旧的 2 参数通道上加状态）', () => {
    expect(java).toContain('JS_RESULT_FN = "PotbotBridgeResult"');
    expect(java).toContain("JS_STATUS_FN = \"PotbotBridgeStatus\"");
    // 新增的桥方法都是 void，不改变既有 saveDocx/saveCopy/importDocx 的行为语义。
    expect(java).toMatch(/public void exportPdf\(String docJson\)/);
    expect(java).toMatch(/public void savePdfCopy\(\)/);
    expect(java).toMatch(/public void printPdf\(\)/);
  });
});

describe('对**真实源码**做变异：扫描器必须变红（不是恒绿仪器）', () => {
  // **换行归一化**（2026-10-03，协调者）：本仓 `.gitattributes`/`core.autocrlf=true` 下，同一份
  // Java 源在有的检出里是 LF、有的是 CRLF（`git merge` 重写过的文件会变 CRLF）。本块的多处变异用
  // `'\n'` 字面量匹配方法体，一旦源文件是 CRLF，`replace` 静默不命中 ⇒ 变异根本没发生 ⇒ 用例红，
  // 而**根因是换行而不是被断言的缺陷**。这里在读入处统一折成 LF，使变异与换行无关。
  const toLf = (text: string): string => text.replaceAll('\r\n', '\n');
  const java = toLf(readText(`${REPO_ROOT}/${ANDROID_MAIN_ACTIVITY}`));
  const print = toLf(readText(`${REPO_ROOT}/apps/android/app/src/main/java/com/potbot/demo/PotbotPrintHandoff.java`));
  const allJava = ANDROID_JAVA_SOURCES
    .map((p) => toLf(readText(`${REPO_ROOT}/${p}`)))
    .join('\n');

  it('把真实现的"关闭后读回"删掉 ⇒ 必须报红', () => {
    const mutatedJava = java.replaceAll('PotbotPdfReadback.inspect(', 'noopReadback(');
    const mutatedAll = allJava.replaceAll('PotbotPdfReadback.inspect(', 'noopReadback(');
    const rules = scanPdfExport(mutatedJava, mutatedAll).map((v) => v.rule);
    expect(rules, '[未通过] 删掉读回后扫描器仍然放行：这就是空断言').toContain(RULE_PDF.readback_missing);
  });

  it('把真实现的"显式关闭"删掉 ⇒ 必须报红', () => {
    const body = extractMethodBody(java, 'private void doExportPdf(') ?? '';
    expect(body.length).toBeGreaterThan(0);
    // 只删导出方法体里的 os.close();（其余源码不动）
    const mutatedBody = body.replace('        try {\n            os.close();', '        try {\n            os.flush();');
    const mutatedJava = java.replace(body, mutatedBody);
    const rules = scanPdfExport(mutatedJava, allJava).map((v) => v.rule);
    expect(rules, '[未通过] 删掉显式关闭后扫描器仍然放行').toContain(RULE_PDF.explicit_close_missing);
  });

  it('把真实现的印刷状态改成 true ⇒ 必须报红', () => {
    const mutated = print.replace(
      'static final boolean PRINTED = false;', 'static final boolean PRINTED = true;',
    );
    const rules = scanPrintHandoff(java, `${allJava}\n${mutated}`).map((v) => v.rule);
    expect(rules, '[未通过] printed 被置真却仍然放行').toContain(RULE_PRINT.printed_not_false);
  });

  it('给真实现的状态类型加一个 PRINTED 成员 ⇒ 必须报红', () => {
    const mutated = print.replace('        HANDED_OFF\n    }', '        HANDED_OFF,\n        PRINTED\n    }');
    expect(mutated, '[未满足] 变异未生效（找不到目标片段）').not.toBe(print);
    const rules = scanPrintHandoff(java, `${allJava}\n${mutated}`).map((v) => v.rule);
    expect(rules, '[未通过] 状态类型能表达"已打印"却仍然放行').toContain(RULE_PRINT.state_expresses_printed);
  });
});

describe('成功状态白名单：扩展而非放松', () => {
  it('仍包含 D09 的三个既有成功状态（一个都没被删掉）', () => {
    for (const s of ['ST_SAVED_VERIFIED', 'ST_SAVED_VERIFIED_HANDOFF_FAILED', 'ST_IMPORT_OK']) {
      expect(SUCCESS_STATUSES, `[未通过] 白名单丢了 ${s}`).toContain(s);
    }
  });

  it('新增的三个都各自是"核对之后才允许 ok=true"的状态，且互不相同', () => {
    expect(SUCCESS_STATUSES).toContain('ST_PDF_EXPORTED_VERIFIED');
    expect(SUCCESS_STATUSES).toContain('ST_PDF_COPY_VERIFIED');
    expect(SUCCESS_STATUSES).toContain('ST_PRINT_HANDED_OFF');
    const constants = parseStatusConstants(
      readText(`${REPO_ROOT}/${ANDROID_MAIN_ACTIVITY}`),
    );
    const values = SUCCESS_STATUSES.map((t) => constants.get(t) ?? '');
    expect(values.some((v) => v === ''), `[未通过] 白名单里有未定义的状态：${values.join(', ')}`).toBe(false);
    expect(new Set(values).size, `[未通过] 白名单状态取重：${values.join(', ')}`).toBe(values.length);
  });
});

describe('未验证声明：源码扫描不得冒充真机证据', () => {
  const allJava = ANDROID_JAVA_SOURCES
    .map((p) => readText(`${REPO_ROOT}/${p}`))
    .join('\n');

  it('新类显式声明"未验证"，且没有任何字面量宣称真机已通过', () => {
    expect(allJava).toContain('未验证');
    const claims = javaStringLiterals(allJava).filter(
      (s) => /真机(已|通过|验证通过)|已装\s*APK|手机端已验证/.test(s),
    );
    expect(claims, `[未通过] 出现真机已通过的宣称：${claims.join(' | ')}`).toEqual([]);
  });

  it('打印边界必须明确"未验证真机打印"（随结论带出）', () => {
    const print = readText(`${REPO_ROOT}/apps/android/app/src/main/java/com/potbot/demo/PotbotPrintHandoff.java`);
    expect(print).toContain('BOUNDARIES');
    expect(print).toContain('真机打印在本波未验证');
  });
});
