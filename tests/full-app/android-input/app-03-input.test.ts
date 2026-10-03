/**
 * APP-03（输入入口与类型识别）—— **源码级结构断言**。
 *
 * 能力口径：文本 / 粘贴 / 系统分享（{@code ACTION_SEND}）/ 文件选择
 * （{@code ACTION_OPEN_DOCUMENT} / {@code ACTION_GET_CONTENT}）入口；
 * DOCX/XLSX/PPTX 与约定的 PDF/文本/图片**正确识别**（按 MIME + 扩展名双重判定，
 * 冲突时具名报错）；**不支持的输入明确反馈，不当成已解析**。
 *
 * 判据（都可机判，且每条都用**合成的坏源码**自证会变红）：
 *   ① 判定表是**双重**的：MIME 与扩展名都参与，冲突在"两者都表态且不同"时才具名报；
 *   ② 不支持 / 冲突的输入一律 {@code accepted=false}；
 *   ③ 文本超长**不截断**，明确拒绝；
 *   ④ 两个选择器入口的授权语义**不同**：OPEN_DOCUMENT 才带可持久化标志；
 *   ⑤ 多文件（{@code EXTRA_ALLOW_MULTIPLE} + {@code ClipData}）有入口；
 *   ⑥ 系统分享意图确实被解析（ACTION_SEND / SEND_MULTIPLE）；
 *   ⑦ 宿主 MainActivity 把结论接上（解析 + 只读回报）。
 *
 * ⚠️ **未验证（需真机）**：真机上系统分享来源、选择器返回的 MIME 习惯、中文输入法
 * 行为都**未验证**（本包不跑 Gradle、不装 APK、不连设备）。本文件只核对源码结构。
 */

import { describe, expect, it } from 'vitest';

import {
  INPUT_GATEWAY,
  MAIN_ACTIVITY,
  NEW_CLASSES,
  STRINGS_XML,
  androidAppSourceFiles,
  extractMethodBody,
  readText,
  scanForSecrets,
  stripJavaComments,
} from './android-input-source.js';

const gateway = readText(INPUT_GATEWAY);
const gatewayCode = stripJavaComments(gateway);
const activity = readText(MAIN_ACTIVITY);

// ---------------------------------------------------------------------------
// 判别力自证用的**合成坏实现**（每一条都必须被对应判据抓出来）
// ---------------------------------------------------------------------------

/** 只看 MIME、完全不看扩展名的天真实现。 */
const NAIVE_MIME_ONLY = `
public static Kind kindOf(String mime, String displayName) {
    Kind byMime = kindForMime(mime);
    return byMime == null ? Kind.UNSUPPORTED : byMime;
}
public static Item classifyFile(String mime, String displayName, String uri) {
    return new Item(Kind.DOCX.name(), mime, displayName, uri, null, true, ST_ACCEPTED_FILE);
}`;

/** 超长就截断、还当成成功的天真实现。 */
const NAIVE_TRUNCATING = `
private static Incoming textItem(String text, String source) {
    String cut = text.substring(0, MAX_TEXT_CHARS);
    return new Incoming(source, true, ST_ACCEPTED_TEXT, items);
}`;

// ---------------------------------------------------------------------------
// 判据（纯函数，便于用合成源码自证）
// ---------------------------------------------------------------------------

/** 判定表是否**双重**：MIME 与扩展名都参与，且冲突只在"都表态且不同"时具名报。 */
function hasDualJudgment(java: string): boolean {
  const code = stripJavaComments(java);
  const hasMime = /Kind\s+kindForMime\s*\(/.test(code);
  const hasExt = /Kind\s+kindForExtension\s*\(/.test(code);
  const hasConflictFn = /boolean\s+isMimeExtensionConflict\s*\(/.test(code);
  const body = extractMethodBody(code, 'public static boolean isMimeExtensionConflict(') ?? '';
  const comparesBoth = /byMime\s*!=\s*byExt/.test(body);
  return hasMime && hasExt && hasConflictFn && comparesBoth && code.includes('ST_MIME_EXTENSION_CONFLICT');
}

/** 不支持的输入必须 accepted=false（绝不当成已解析）。 */
function rejectsUnsupported(java: string): boolean {
  const body = extractMethodBody(stripJavaComments(java), 'public static Item classifyFile(') ?? '';
  const flat = body.replace(/\s+/g, ' ');
  return /Kind\.UNSUPPORTED/.test(flat) && flat.includes('ST_UNSUPPORTED')
      && flat.includes(', false,');
}

/** 文本超长必须**不截断**地拒绝。 */
function rejectsTooLongWithoutTruncating(java: string): boolean {
  const body = extractMethodBody(stripJavaComments(java), 'private static Incoming textItem(') ?? '';
  return body.includes('ST_TEXT_TOO_LONG') && !body.includes('substring');
}

describe('判别力自证（合成坏源码必须被抓）', () => {
  it('只看 MIME 的天真实现 → 双重判定判据为假', () => {
    expect(hasDualJudgment(NAIVE_MIME_ONLY)).toBe(false);
  });

  it('超长截断仍然成功的天真实现 → 不截断判据为假', () => {
    expect(rejectsTooLongWithoutTruncating(NAIVE_TRUNCATING)).toBe(false);
  });

  it('无条件 accepted=true 的天真实现 → 不支持判据为假', () => {
    const naiveAccept = 'public static Item classifyFile(String mime, String d, String u) {'
        + ' return new Item("DOCX", mime, d, u, null, true, ST_ACCEPTED_FILE); }';
    expect(rejectsUnsupported(naiveAccept)).toBe(false);
  });
});

describe('判定表：MIME + 扩展名双重判定（APP-03）', () => {
  it('双重判定成立（两条腿 + 具名冲突 + 冲突条件正确）', () => {
    expect(hasDualJudgment(gateway)).toBe(true);
  });

  it('MIME 与扩展名的映射覆盖约定的六类：DOCX/XLSX/PPTX/PDF/文本/图片', () => {
    const mimeBody = extractMethodBody(gatewayCode, 'public static Kind kindForMime(') ?? '';
    for (const token of ['MIME_DOCX', 'MIME_XLSX', 'MIME_PPTX', 'MIME_PDF', 'MIME_TEXT_PLAIN', 'MIME_IMAGE_PREFIX']) {
      expect(mimeBody, `kindForMime 少了 ${token}`).toContain(token);
    }
    const extBody = extractMethodBody(gatewayCode, 'public static Kind kindForExtension(') ?? '';
    for (const ext of ['docx', 'xlsx', 'pptx', 'pdf', 'txt', 'png', 'jpg']) {
      expect(extBody, `kindForExtension 少了扩展名 ${ext}`).toContain(`"${ext}"`);
    }
  });

  it('通配与兜底类型**不表态**（不把 */* 或 octet-stream 当成判据）', () => {
    const body = extractMethodBody(gatewayCode, 'public static boolean isDefinitiveMime(') ?? '';
    expect(body).toContain('MIME_WILDCARD');
    expect(body).toContain('MIME_OCTET_STREAM');
    expect(body.replace(/\s+/g, ' ')).toMatch(/return false/);
  });

  it('MIME 明确不支持时直接判不支持，**不拿扩展名去圆**', () => {
    const body = extractMethodBody(gatewayCode, 'public static Kind kindOf(') ?? '';
    expect(body.replace(/\s+/g, ' ')).toMatch(/byMime == Kind\.UNSUPPORTED/);
    expect(body).toContain('return Kind.UNSUPPORTED');
  });

  it('不支持的输入如实反馈、不当成已解析', () => {
    expect(rejectsUnsupported(gateway)).toBe(true);
  });

  it('冲突是**具名**状态（不是笼统的失败）', () => {
    const constants = readText(INPUT_GATEWAY);
    expect(constants).toContain('ST_MIME_EXTENSION_CONFLICT = "input_mime_extension_conflict"');
    expect(constants).toContain('ST_UNSUPPORTED = "input_unsupported"');
    expect(constants).toContain('ST_MULTIPLE_PARTIAL = "input_multiple_partial"');
  });
});

describe('文本入口：长文本不截断（APP-03 / APP-08）', () => {
  it('超长明确拒绝且不截断', () => {
    expect(rejectsTooLongWithoutTruncating(gateway)).toBe(true);
  });

  it('空文本单独报（不把空当"有输入"）', () => {
    const body = extractMethodBody(gatewayCode, 'private static Incoming textItem(') ?? '';
    expect(body).toContain('ST_TEXT_EMPTY');
  });

  it('粘贴与直接输入是两个具名入口', () => {
    expect(gatewayCode).toMatch(/public static Incoming fromPaste\(String text\)/);
    expect(gatewayCode).toMatch(/public static Incoming fromText\(String text, String source\)/);
  });

  it('有明确的长文本上限常量', () => {
    expect(gatewayCode).toMatch(/int\s+MAX_TEXT_CHARS\s*=\s*\d/);
  });
});

describe('文件选择入口：两个选择器的授权语义不同', () => {
  const openDoc = extractMethodBody(gatewayCode, 'public static Intent buildOpenDocumentIntent(') ?? '';
  const getContent = extractMethodBody(gatewayCode, 'public static Intent buildGetContentIntent(') ?? '';

  it('ACTION_OPEN_DOCUMENT：可持久授权 + 多选开关 + 类型过滤', () => {
    expect(openDoc).toContain('ACTION_OPEN_DOCUMENT');
    expect(openDoc).toContain('CATEGORY_OPENABLE');
    expect(openDoc).toContain('FLAG_GRANT_PERSISTABLE_URI_PERMISSION');
    expect(openDoc).toContain('FLAG_GRANT_READ_URI_PERMISSION');
    expect(openDoc).toContain('EXTRA_ALLOW_MULTIPLE');
    expect(openDoc).toContain('EXTRA_MIME_TYPES');
  });

  it('★ACTION_GET_CONTENT：**刻意不**带可持久化标志（拿了会让人以为之后还能读）', () => {
    expect(getContent).toContain('ACTION_GET_CONTENT');
    expect(getContent).toContain('FLAG_GRANT_READ_URI_PERMISSION');
    expect(getContent).not.toContain('FLAG_GRANT_PERSISTABLE_URI_PERMISSION');
  });

  it('类型过滤是"我们支持的六类"，不是空过滤', () => {
    const body = extractMethodBody(gatewayCode, 'public static String[] supportedMimeTypes()') ?? '';
    for (const token of ['MIME_DOCX', 'MIME_XLSX', 'MIME_PPTX', 'MIME_PDF', 'MIME_TEXT_PLAIN', '"image/png"']) {
      expect(body, `supportedMimeTypes 少了 ${token}`).toContain(token);
    }
  });
});

describe('系统分享入口（APP-03 / APP-08 多文件）', () => {
  const parse = extractMethodBody(gatewayCode, 'public static Incoming parseIncoming(') ?? '';

  it('解析 ACTION_SEND / SEND_MULTIPLE / VIEW', () => {
    expect(parse).toContain('ACTION_SEND');
    expect(parse).toContain('ACTION_SEND_MULTIPLE');
    expect(parse).toContain('ACTION_VIEW');
  });

  it('多文件走 ClipData（EXTRA_STREAM 只作回落），逐个判定、全通过才算通过', () => {
    const multi = extractMethodBody(gatewayCode, 'private static List<Uri> multipleUris(') ?? '';
    expect(multi).toContain('getClipData');
    expect(multi).toContain('getItemCount');
    const fileIncoming = extractMethodBody(gatewayCode, 'public static Incoming fileIncoming(') ?? '';
    expect(fileIncoming).toContain('anyRejected');
    expect(fileIncoming).toContain('ST_MULTIPLE_PARTIAL');
  });

  it('只接受 content://，file:// 等直传路径明确拒绝', () => {
    const body = extractMethodBody(gatewayCode, 'public static Incoming fileIncoming(') ?? '';
    expect(body).toContain('"content"');
    expect(body).toContain('ST_SCHEME_NOT_CONTENT');
  });

  it('拿不到文件名时不编造（displayNameOf 失败回 null）', () => {
    const body = extractMethodBody(gatewayCode, 'public static String displayNameOf(') ?? '';
    expect(body).toContain('OpenableColumns.DISPLAY_NAME');
    expect(body.replace(/\s+/g, ' ')).toMatch(/Throwable e\)\s*\{\s*return null/);
  });
});

describe('宿主接线（MainActivity 只做最小追加）', () => {
  it('冷启动与新意图都只解析**结论**', () => {
    expect(activity).toContain('PotbotInputGateway.parseIncoming(this, getIntent())');
    expect(activity).toContain('PotbotInputGateway.parseIncoming(this, intent)');
  });

  it('桥上有只读的 incomingInput()，页面据此显示"不支持"，不自己猜类型', () => {
    expect(activity).toMatch(/public\s+String\s+incomingInput\(\)/);
    expect(activity).toContain('PotbotInputGateway.describeJson(lastIncomingInput)');
    expect(gatewayCode).toMatch(/public static String describeJson\(Incoming incoming\)/);
  });

  it('信号里不带长文本全文（只带长度与预览）', () => {
    const body = extractMethodBody(gatewayCode, 'public static String describeJson(') ?? '';
    expect(body).toContain('textLength');
    expect(body).toContain('textPreview');
    expect(body).toContain('substring(0, 200)');
  });
});

describe('密钥形态：新增源码与资源不得带进密钥（APP-03 侧的附带判据）', () => {
  it('扫描器自证：合成的带密钥源码必须被抓、干净样本必须放行', () => {
    expect(scanForSecrets([{
      path: 'Fake.java',
      text: 'String k = "' + 'sk' + '-' + 'abcdefghijklmnop0123' + '";',
    }]).join()).toContain('厂商密钥前缀');
    expect(scanForSecrets([{ path: 'Clean.java', text: 'status = "input_accepted_file";' }])).toEqual([]);
  });

  it('本包新增的四个类 + strings.xml 无密钥形态', () => {
    const files = [...NEW_CLASSES.map((p) => ({ path: p, text: readText(p) })),
      { path: STRINGS_XML, text: readText(STRINGS_XML) }];
    expect(scanForSecrets(files)).toEqual([]);
  });

  it('整个进 APK 的 Android 源码树仍然干净（不因本包新增而破口）', () => {
    expect(scanForSecrets(androidAppSourceFiles())).toEqual([]);
  });
});
