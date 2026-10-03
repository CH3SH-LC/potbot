/**
 * 手机 Android 宿主「保存链 / 导入边界」的**静态判别器**（S6 风格，不是被测实现）。
 *
 * 为什么静态：真机层在本波**没有设备**（协调者统一安排设备窗口），Android 的
 * `onActivityResult` / `ContentResolver` 无法在 Node 里真跑。能被结构化断言的部分
 * 是**源码结构**：哪些状态存在、谁在谁之前、成功只能从哪条路出去。本模块把这些
 * 断言做成可复用、**带判别力自证**的扫描器——合成的坏实现必须被抓，干净实现必须放行。
 *
 * 它**不**声称任何运行期行为已通过；真机一律标「未验证」。
 */

/** 被测源码的仓库相对路径。 */
export const ANDROID_MAIN_ACTIVITY =
  'apps/android/app/src/main/java/com/potbot/demo/MainActivity.java';
export const ANDROID_MANIFEST = 'apps/android/app/src/main/AndroidManifest.xml';
export const ANDROID_FILE_PATHS = 'apps/android/app/src/main/res/xml/file_paths.xml';

/**
 * Android 宿主侧的全部 Java 源（WCF-D62 起含 PDF 导出 / 打印交接三个新类）。
 *
 * 打印"有没有宣称已打印"这类判断必须**看全部源文件**——只看 MainActivity 会被
 * "在另一个类里写 printed=true"绕过去。
 */
export const ANDROID_JAVA_SOURCES: readonly string[] = [
  'apps/android/app/src/main/java/com/potbot/demo/MainActivity.java',
  'apps/android/app/src/main/java/com/potbot/demo/PotbotPdfLayout.java',
  'apps/android/app/src/main/java/com/potbot/demo/PotbotPdfReadback.java',
  'apps/android/app/src/main/java/com/potbot/demo/PotbotPrintHandoff.java',
];

export interface Violation {
  readonly rule: string;
  readonly detail: string;
}

/** 规则名（测试按名字断言，避免"抓到了但抓错地方"）。 */
export const RULE = {
  save_method_missing: 'savecopy_method_missing',
  no_explicit_close: 'savecopy_no_explicit_close',
  close_failure_not_distinguished: 'savecopy_close_failure_not_distinguished',
  verified_before_close: 'savecopy_verified_reported_before_close',
  no_target_readback: 'savecopy_no_target_readback',
  verified_before_readback: 'savecopy_verified_reported_before_readback',
  no_digest_compare: 'savecopy_readback_without_digest_compare',
  readback_states_collapsed: 'savecopy_readback_failure_states_collapsed',
  silent_return_missing_bytes: 'savecopy_silent_return_when_bytes_missing',
  state_loss_not_reported: 'savecopy_state_loss_not_reported',
  unverified_claimed_success: 'unverified_status_claimed_as_success',

  import_method_missing: 'import_method_missing',
  import_no_second_read: 'import_without_second_read',
  import_digest_missing: 'import_digest_not_computed',
  import_no_cross_digest: 'import_no_cross_read_digest_compare',
  import_no_zip_magic: 'import_no_zip_magic_check',
  import_states_collapsed: 'import_failure_states_collapsed',
  import_ok_before_verification: 'import_reported_ok_before_verification',
  import_not_content_uri: 'import_does_not_handle_content_uri',
  import_no_picker: 'import_no_saf_open_document',
} as const;

/**
 * 抽出 Java 方法/构造器的**方法体**（按花括号配对，跳过字符串、字符与注释）。
 *
 * 必须跳过字符串字面量：本项目里有 `"javascript:(function(){try{...})()"` 这种
 * 带花括号的字符串，朴素计数会算错。找不到返回 `null`（调用方按"方法缺失"报告）。
 */
export function extractMethodBody(text: string, signature: string): string | null {
  const start = text.indexOf(signature);
  if (start < 0) return null;
  const braceStart = text.indexOf('{', start + signature.length);
  if (braceStart < 0) return null;

  let depth = 0;
  let i = braceStart;
  while (i < text.length) {
    const c = text.charAt(i);
    const next = text.charAt(i + 1);
    if (c === '/' && next === '/') {
      while (i < text.length && text.charAt(i) !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text.charAt(i) === '*' && text.charAt(i + 1) === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === '"') {
      i += 1;
      while (i < text.length && text.charAt(i) !== '"') {
        if (text.charAt(i) === '\\') i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (c === "'") {
      i += 1;
      while (i < text.length && text.charAt(i) !== "'") {
        if (text.charAt(i) === '\\') i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(braceStart + 1, i);
    }
    i += 1;
  }
  return null;
}

/**
 * 该方法体里是否存在 `reportStatus(ok, TOKEN, ...)` 形式的**真实调用点**。
 *
 * 有意锚定到调用点而不是"出现过这个名字"：否则把状态名写进注释或常量声明就能骗过扫描器，
 * 规则就退化成空断言。
 */
export function reportsStatus(body: string, ok: boolean, token: string): boolean {
  const re = new RegExp(
    `reportStatus\\(\\s*${ok ? 'true' : 'false'}\\s*,\\s*${token}\\s*,`,
  );
  return re.test(body);
}

/** 解析 `static final String ST_X = "value";` 形式的状态常量。 */
export function parseStatusConstants(java: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  const re = /static\s+final\s+String\s+(ST_[A-Z0-9_]+)\s*=\s*"([^"]*)"/g;
  for (const m of java.matchAll(re)) {
    const name = m[1];
    const value = m[2];
    if (name !== undefined && value !== undefined) out.set(name, value);
  }
  return out;
}

/**
 * 允许携带 `ok=true` 的状态（其余一律不得以成功语义回报）。
 *
 * WCF-D62 扩展了三个（PDF 导出 / PDF 副本 / 打印交接）：它们**同样**是
 * 「只有通过独立读回核对（或对已核对产物的交接）之后才允许发出」的状态。
 * 扩展的是"哪些状态算作已核对"，**不是**放松"未核对不得报 ok=true"这条不变量——
 * `pdf-print.test.ts` 对每个新状态单独断言了它在核对步骤**之后**才出现。
 */
export const SUCCESS_STATUSES: readonly string[] = [
  // —— WCF-D09（原样保留，未删改）——
  'ST_SAVED_VERIFIED',
  'ST_SAVED_VERIFIED_HANDOFF_FAILED',
  'ST_IMPORT_OK',
  // —— WCF-D62 新增 ——
  'ST_PDF_EXPORTED_VERIFIED',
  'ST_PDF_COPY_VERIFIED',
  'ST_PRINT_HANDED_OFF',
];

/**
 * 扫描**另存/本地保存链**。传入整个 MainActivity.java 源码，返回违规清单。
 *
 * 主判据（§2.1 缺口 2 / design-05-P10）：
 *  写入 → 刷新 → **显式关闭** → **关闭后重新读回目标 URI** → 核对长度与 SHA256 → 才 verified。
 */
export function scanSaveChain(java: string): readonly Violation[] {
  const violations: Violation[] = [];
  const push = (rule: string, detail: string): void => {
    violations.push({ rule, detail });
  };

  const body = extractMethodBody(java, 'private void writeAndVerifyCopy(');
  if (body === null) {
    push(RULE.save_method_missing, '找不到另存写盘 + 核对方法 writeAndVerifyCopy(...)：无法判定保存链');
  } else {
    const idxClose = body.indexOf('.close();');
    const idxReadback = body.indexOf('readAllContent(target');
    const idxVerified = body.indexOf('ST_SAVED_VERIFIED');
    const idxCloseFailure = body.indexOf('ST_SAVE_COPY_CLOSE_FAILED');

    if (idxClose < 0) {
      push(RULE.no_explicit_close, '另存路径没有显式 close()：无法区分"关闭失败"与"写入成功"');
    }
    if (!reportsStatus(body, false, 'ST_SAVE_COPY_CLOSE_FAILED')) {
      push(
        RULE.close_failure_not_distinguished,
        '另存路径没有 reportStatus(false, ST_SAVE_COPY_CLOSE_FAILED, ...)：关闭失败未单独报告',
      );
    } else if (idxClose >= 0 && idxCloseFailure < idxClose) {
      push(
        RULE.close_failure_not_distinguished,
        '关闭失败状态出现在 close() 之前：顺序可疑，无法证明关闭失败被单独捕获',
      );
    }
    if (idxReadback < 0) {
      push(RULE.no_target_readback, '另存路径没有关闭后读回目标 URI（readAllContent(target...)）');
    }
    if (idxVerified < 0) {
      push(RULE.save_method_missing, '另存路径没有 ST_SAVED_VERIFIED：成功状态未定义');
    }
    if (idxClose >= 0 && idxVerified >= 0 && idxVerified < idxClose) {
      push(RULE.verified_before_close, 'ST_SAVED_VERIFIED 出现在 close() 之前：关闭前就宣称成功');
    }
    if (idxReadback >= 0 && idxVerified >= 0 && idxVerified < idxReadback) {
      push(RULE.verified_before_readback, 'ST_SAVED_VERIFIED 出现在关闭后读回之前：未读回就宣称成功');
    } else if (idxReadback < 0 && idxVerified >= 0) {
      push(RULE.verified_before_readback, '没有读回调用却有 ST_SAVED_VERIFIED：未读回就宣称成功');
    }

    if (!/sha256Hex\(\s*readBack\s*\)/.test(body)) {
      push(RULE.no_digest_compare, '另存读回后没有对读回字节计算 SHA256（sha256Hex(readBack)）');
    }
    if (!/readBackSha\.equalsIgnoreCase\(writtenSha\)/.test(body)) {
      push(RULE.no_digest_compare, '另存读回没有与写入内容做 SHA256 比对');
    }

    const readbackStates = [
      'ST_SAVE_COPY_READBACK_PERMISSION_DENIED',
      'ST_SAVE_COPY_READBACK_URI_INVALID',
      'ST_SAVE_COPY_READBACK_FAILED',
      'ST_SAVE_COPY_READBACK_MISMATCH',
    ];
    const missingStates = readbackStates.filter((token) => !reportsStatus(body, false, token));
    if (missingStates.length > 0) {
      push(
        RULE.readback_states_collapsed,
        `读回失败状态被合并/缺失：缺少 ${missingStates.join(', ')}（权限不足 / URI 失效 / 读失败 / 摘要不符必须分开）`,
      );
    }
    const idxMismatch = body.indexOf('ST_SAVE_COPY_READBACK_MISMATCH');
    if (idxMismatch >= 0 && idxVerified >= 0 && idxVerified < idxMismatch) {
      push(RULE.verified_before_readback, 'ST_SAVED_VERIFIED 出现在长度/摘要不符判定之前');
    }
  }

  // 消失即静默：Activity 重建 / 进程终止后待保存内容丢失，必须报真实状态而不是无声 return。
  const handler = extractMethodBody(java, 'private void handleCreateDocumentResult(');
  if (handler === null) {
    push(RULE.state_loss_not_reported, '找不到 handleCreateDocumentResult(...)：无法判定状态丢失是否被报告');
  } else {
    // 判据：每个 "bytes == null" 分支在**下一个 return; 之前**必须有一次 reportStatus(...)。
    // 只算"下一个 return"而不是固定窗口，避免窗口长度变成可调参数（调窗口 = 调结论）。
    const needle = 'bytes == null';
    let from = 0;
    for (;;) {
      const at = handler.indexOf(needle, from);
      if (at < 0) break;
      const reportAt = handler.indexOf('reportStatus(', at);
      const returnAt = handler.indexOf('return;', at);
      if (reportAt < 0 || (returnAt >= 0 && returnAt < reportAt)) {
        push(RULE.silent_return_missing_bytes, '待保存内容缺失时没有回报就 return：失败被静默吞掉');
      }
      from = at + needle.length;
    }
    if (!handler.includes('ST_SAVE_COPY_STATE_LOST')) {
      push(RULE.state_loss_not_reported, '缺少 ST_SAVE_COPY_STATE_LOST：Activity 重建/进程终止未单独报告');
    }
  }

  // 只有明确"已核对通过"的状态才能携带 ok=true。
  const successRe = /reportStatus\(\s*true\s*,\s*(ST_[A-Z0-9_]+)/g;
  for (const m of java.matchAll(successRe)) {
    const status = m[1];
    if (status !== undefined && !SUCCESS_STATUSES.includes(status)) {
      push(RULE.unverified_claimed_success, `reportStatus(true, ${status}, ...)：非核对通过状态被当成功回报`);
    }
  }

  return violations;
}

/**
 * 扫描**导入链**（SAF ACTION_OPEN_DOCUMENT + content:// 导回）。
 *
 * 主判据（design-05-P8 / WF-082 / WF-084）：**打开回执 ≠ 保存成功**，也不等于读到了
 * 正确字节；必须实际读入、与声明 SIZE 及第二次独立读入交叉核对后才算通过。
 */
export function scanImport(java: string): readonly Violation[] {
  const violations: Violation[] = [];
  const push = (rule: string, detail: string): void => {
    violations.push({ rule, detail });
  };

  const body = extractMethodBody(java, 'private void readAndVerifyImport(');
  if (body === null) {
    push(RULE.import_method_missing, '找不到导入读入 + 核对方法 readAndVerifyImport(...)');
    return violations;
  }

  const reads = body.match(/readAllContent\(uri/g) ?? [];
  if (reads.length < 2) {
    push(RULE.import_no_second_read, `导入只读入 ${reads.length} 次：没有第二次独立读入做字节核对`);
  }
  if (!/sha256Hex\(\s*first\s*\)/.test(body) || !/sha256Hex\(\s*second\s*\)/.test(body)) {
    push(RULE.import_digest_missing, '导入没有对两次读入分别计算 SHA256');
  }
  if (!/firstSha\.equalsIgnoreCase\(secondSha\)/.test(body)) {
    push(RULE.import_no_cross_digest, '导入没有把两次读入的 SHA256 交叉比对');
  }
  if (!/isZipMagic\(/.test(body)) {
    push(RULE.import_no_zip_magic, '导入没有做 ZIP/OOXML 形态检查（PK 头）');
  }

  const importFailureStates = [
    'ST_IMPORT_PERMISSION_DENIED',
    'ST_IMPORT_URI_INVALID',
    'ST_IMPORT_READBACK_MISMATCH',
    'ST_IMPORT_TOO_LARGE',
  ];
  const missing = importFailureStates.filter((token) => !reportsStatus(body, false, token));
  if (missing.length > 0) {
    push(RULE.import_states_collapsed, `导入失败状态缺失/合并：缺少 ${missing.join(', ')}`);
  }
  if (!reportsStatus(body, true, 'ST_IMPORT_OK')) {
    push(RULE.import_states_collapsed, '导入缺少 reportStatus(true, ST_IMPORT_OK, ...) 成功回报');
  }

  const idxCrossCompare = body.indexOf('firstSha.equalsIgnoreCase(secondSha)');
  const idxZip = body.indexOf('isZipMagic(');
  const idxOk = body.indexOf('ST_IMPORT_OK');
  if (idxOk >= 0) {
    if (idxCrossCompare >= 0 && idxOk < idxCrossCompare) {
      push(RULE.import_ok_before_verification, 'ST_IMPORT_OK 出现在两次读入摘要比对之前');
    }
    if (idxZip >= 0 && idxOk < idxZip) {
      push(RULE.import_ok_before_verification, 'ST_IMPORT_OK 出现在 ZIP 形态检查之前');
    }
  }

  if (!java.includes('"content".equalsIgnoreCase(uri.getScheme())')) {
    push(RULE.import_not_content_uri, '导入路径没有校验 content:// scheme');
  }
  if (!/Intent\.ACTION_OPEN_DOCUMENT/.test(java)) {
    push(RULE.import_no_picker, '导入路径没有使用 SAF ACTION_OPEN_DOCUMENT');
  }
  if (!/OpenableColumns\.SIZE/.test(java)) {
    push(RULE.import_states_collapsed, '导入没有取系统声明的 SIZE 做交叉核对');
  }

  return violations;
}

// ===========================================================================
// WCF-D62 / design-05-P8：PDF 导出（WF-089）与打印交接（WF-090）静态判别器
//
// 同样的判别力自证纪律：合成的坏实现必须被抓，干净镜像必须放行。
// **只断言源码结构**；真机行为（PdfDocument 实际出图、系统打印服务实际被调起）
// 在本波没有设备，一律标「未验证」。
// ===========================================================================

/** PDF 导出链的规则名。 */
export const RULE_PDF = {
  engine_missing: 'pdf_no_real_layout_engine',
  render_not_called: 'pdf_export_does_not_call_layout_engine',
  explicit_close_missing: 'pdf_export_without_explicit_close',
  readback_missing: 'pdf_export_without_independent_readback',
  readback_before_close: 'pdf_readback_before_explicit_close',
  verified_before_readback: 'pdf_verified_reported_before_readback',
  verified_not_anchored: 'pdf_verified_status_not_reported',
  magic_missing: 'pdf_readback_without_pdf_magic_check',
  parser_missing: 'pdf_readback_without_system_parser_page_check',
  digest_missing: 'pdf_readback_without_digest_check',
  states_collapsed: 'pdf_failure_states_collapsed',
} as const;

/** 打印交接链的规则名。 */
export const RULE_PRINT = {
  manager_missing: 'print_no_printmanager_adapter',
  printed_not_false: 'print_printed_flag_not_provably_false',
  factory_not_false: 'print_outcome_factory_does_not_carry_false',
  claims_printed: 'print_claims_paper_printed',
  state_expresses_printed: 'print_state_type_expresses_printed',
  verification_gate_missing: 'print_handoff_without_verification_gate',
  handed_off_status_missing: 'print_handed_off_status_missing',
  states_collapsed: 'print_failure_states_collapsed',
} as const;

/** 引擎段必须**各自独立**报告的失败状态（无引擎 / 超时 / 空间不足 / 权限不足）。 */
export const PDF_ENGINE_FAILURE_STATUSES: readonly string[] = [
  'ST_PDF_NO_ENGINE',
  'ST_PDF_TIMEOUT',
  'ST_PDF_NO_SPACE',
  'ST_PDF_PERMISSION_DENIED',
];

/** 读回段必须**各自独立**映射的失败状态（空 / 非 PDF / 页数 / 空白 / 读回失败 / 摘要）。 */
export const PDF_READBACK_FAILURE_STATUSES: readonly string[] = [
  'ST_PDF_EMPTY',
  'ST_PDF_NOT_PDF',
  'ST_PDF_PAGE_MISMATCH',
  'ST_PDF_BLANK',
  'ST_PDF_READBACK_FAILED',
  'ST_PDF_COPY_READBACK_DIGEST_MISMATCH',
];

/** PDF 侧的完整失败词表（判据：两两不同值，不得合并）。 */
export const PDF_REQUIRED_STATUSES: readonly string[] = [
  ...PDF_ENGINE_FAILURE_STATUSES,
  ...PDF_READBACK_FAILURE_STATUSES,
];

/** 打印交接必须**各自独立**映射的失败原因。 */
export const PRINT_FAILURE_STATUSES: readonly string[] = [
  'ST_PRINT_TARGET_MISSING',
  'ST_PRINT_DIGEST_MISMATCH',
  'ST_PRINT_UNAVAILABLE',
  'ST_PRINT_PERMISSION_DENIED',
  'ST_PRINT_OPEN_FAILED',
];

/** 打印状态类型**只允许**这两个成员——不允许"已打印/已完成"在类型上可表达。 */
export const PRINT_ALLOWED_STATES: readonly string[] = ['PREPARED', 'HANDED_OFF'];

/** 去掉 Java 注释（// 与 /* … *\/），供只看代码不看注释的检查使用。 */
export function stripJavaComments(java: string): string {
  return java.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/**
 * 抽出全部 Java **字符串字面量**的内容（已处理转义）。
 *
 * 必须是**状态机**而不是正则：注释里也会出现引号（例如 `没有"纸张已打印"的证据`），
 * 用正则会把注释里的引号当成字面量边界，配对一乱就会凭空造出"宣称已打印"的字面量。
 * 这里逐字符走：注释直接跳过、字符字面量跳过、只在**代码态**收集字符串。
 */
export function javaStringLiterals(java: string): readonly string[] {
  const out: string[] = [];
  let i = 0;
  const n = java.length;
  while (i < n) {
    const c = java.charAt(i);
    const next = java.charAt(i + 1);
    if (c === '/' && next === '/') {
      while (i < n && java.charAt(i) !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(java.charAt(i) === '*' && java.charAt(i + 1) === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === '"') {
      i += 1;
      let buf = '';
      while (i < n && java.charAt(i) !== '"') {
        if (java.charAt(i) === '\\') {
          const esc = java.charAt(i + 1);
          buf += esc === 'n' ? '\n' : esc;
          i += 2;
          continue;
        }
        buf += java.charAt(i);
        i += 1;
      }
      i += 1;
      out.push(buf);
      continue;
    }
    if (c === "'") {
      i += 1;
      while (i < n && java.charAt(i) !== "'") {
        if (java.charAt(i) === '\\') i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return out;
}

/**
 * 找出 `enum <name>` 体里的成员名（去注释后取全大写标识符）。
 *
 * **合并全部同名 enum 的成员**：只取第一个匹配会让"再声明一个 enum State { …, PRINTED }"
 * 从眼皮底下溜过去——那正好是最容易被用来表达"已打印"的写法。
 * 一个都没有时返回 `null`（调用方按"找不到状态类型"报告）。
 */
export function enumMembers(java: string, enumName: string): readonly string[] | null {
  const text = stripJavaComments(java);
  const re = new RegExp(`enum\\s+${enumName}\\s*\\{([^}]*)\\}`, 'g');
  const out: string[] = [];
  let found = false;
  for (const m of text.matchAll(re)) {
    found = true;
    const body = m[1] ?? '';
    for (const id of body.matchAll(/\b([A-Z][A-Z0-9_]*)\b/g)) {
      if (id[1] !== undefined) out.push(id[1]);
    }
  }
  return found ? out : null;
}

/**
 * 扫描**PDF 导出链**（WF-089，手机侧）。
 *
 * 主判据：排版引擎是真引擎（PdfDocument）→ 显式关闭 → **关闭后独立读回**
 * （`%PDF-` 魔数 + 系统解析器页数 + 首页墨迹 + 摘要）→ 才允许 verified ；
 * 且"无引擎 / 超时 / 空间不足 / 权限不足"与"空 / 非 PDF / 页数不符 / 空白 /
 * 读回失败 / 摘要不符"必须是**互不相同**的状态。
 *
 * @param java    宿主 `MainActivity.java`（判定导出链的顺序）
 * @param allJava 全部 Android Java 源拼接（判定引擎/读回器/词表是否存在）
 */
export function scanPdfExport(java: string, allJava: string): readonly Violation[] {
  const violations: Violation[] = [];
  const push = (rule: string, detail: string): void => {
    violations.push({ rule, detail });
  };

  if (!allJava.includes('android.graphics.pdf.PdfDocument')) {
    push(RULE_PDF.engine_missing,
      '全部 Android 源里没有 android.graphics.pdf.PdfDocument —— 没有真实排版引擎');
  }
  if (allJava.includes('renameTo') || /\.docx["']\s*,\s*["'][^"']*\.pdf/.test(allJava)) {
    push(RULE_PDF.engine_missing, '源码出现"改名当导出"的迹象（renameTo / 把 .docx 写成 .pdf）');
  }

  const body = extractMethodBody(java, 'private void doExportPdf(');
  if (body === null) {
    push(RULE_PDF.readback_missing, '找不到 PDF 导出方法 doExportPdf(...)：无法判定导出链');
    return violations;
  }

  const idxRender = body.indexOf('PotbotPdfLayout.render(');
  const idxClose = body.indexOf('.close();');
  const idxCloseFailed = body.indexOf('ST_PDF_CLOSE_FAILED');
  const idxReadback = body.indexOf('PotbotPdfReadback.inspect(');
  const idxVerified = body.indexOf('ST_PDF_EXPORTED_VERIFIED');

  if (idxRender < 0) {
    push(RULE_PDF.render_not_called,
      '导出方法没有调用本机排版引擎（PotbotPdfLayout.render(...)）');
  }
  if (idxClose < 0) {
    push(RULE_PDF.explicit_close_missing,
      '导出路径没有显式 close()：无法区分"关闭失败"与"导出成功"');
  } else if (idxCloseFailed >= 0 && idxCloseFailed < idxClose) {
    push(RULE_PDF.explicit_close_missing,
      '关闭失败状态出现在 close() 之前：顺序可疑，无法证明关闭失败被单独捕获');
  }
  if (idxReadback < 0) {
    push(RULE_PDF.readback_missing,
      '导出路径没有独立读回（PotbotPdfReadback.inspect(...)）');
  }
  if (idxReadback >= 0 && idxClose >= 0 && idxReadback < idxClose) {
    push(RULE_PDF.readback_before_close, '读回出现在 close() 之前：没有做到"关闭之后读回"');
  }
  if (idxVerified < 0) {
    push(RULE_PDF.verified_not_anchored, '导出路径没有 ST_PDF_EXPORTED_VERIFIED：成功状态未定义');
  } else {
    if (idxReadback < 0) {
      push(RULE_PDF.verified_before_readback, '没有读回调用却有 verified：未读回就宣称导出成功');
    } else if (idxVerified < idxReadback) {
      push(RULE_PDF.verified_before_readback, 'verified 出现在关闭后读回之前：未读回就宣称导出成功');
    }
    if (!reportsStatus(body, true, 'ST_PDF_EXPORTED_VERIFIED')) {
      push(RULE_PDF.verified_not_anchored,
        '导出路径的成功回报没有锚定 ST_PDF_EXPORTED_VERIFIED');
    }
  }

  // 读回器必须能抓"改扩展名伪造"：核对 %PDF- 魔数。
  if (!allJava.includes('"%PDF-"') || !allJava.includes('isPdfMagic(')) {
    push(RULE_PDF.magic_missing,
      '读回器/另存路径没有核对 %PDF- 魔数（改扩展名伪造会溜过去）');
  }
  // 读回器必须用**系统解析器**独立解析并取页数（不信任自己的写入类）。
  if (!allJava.includes('PdfRenderer')) {
    push(RULE_PDF.parser_missing, '读回器没有用系统 PDF 解析器（PdfRenderer）独立解析');
  }
  if (!/getPageCount\(\)/.test(allJava)) {
    push(RULE_PDF.parser_missing, '读回器没有从系统解析器取页数');
  }
  // 读回器必须把读回字节的 sha256 与写入内容核对。
  if (!allJava.includes('expectedSha256')) {
    push(RULE_PDF.digest_missing, '读回器没有把读回字节的 sha256 与写入内容核对');
  }

  // 失败词表：引擎段必须逐个以 ok=false 报出。
  const missingEngine = PDF_ENGINE_FAILURE_STATUSES.filter((t) => !reportsStatus(java, false, t));
  if (missingEngine.length > 0) {
    push(RULE_PDF.states_collapsed,
      `引擎段失败状态缺失/合并：缺少 ${missingEngine.join(', ')}` +
      '（无引擎 / 超时 / 空间不足 / 权限不足必须分开）');
  }
  // 读回段必须由读回分类函数逐个映射出来。
  const rbBody = extractMethodBody(java, 'private static String pdfReadbackStatus(');
  if (rbBody === null) {
    push(RULE_PDF.states_collapsed, '找不到读回失败分类函数 pdfReadbackStatus(...)');
  } else {
    const missingReadback = PDF_READBACK_FAILURE_STATUSES.filter((t) => !rbBody.includes(t));
    if (missingReadback.length > 0) {
      push(RULE_PDF.states_collapsed,
        `读回段失败状态缺失/合并：缺少 ${missingReadback.join(', ')}`);
    }
  }

  return violations;
}

/**
 * 扫描**打印交接链**（WF-090，手机侧）。
 *
 * 主判据：`printed` 在源码里**可证伪地恒为 false**；状态类型**不可表达**"已打印"；
 * 结果工厂只传 false；没有任何字符串字面量在非否定语境里宣称"已打印"；
 * 只对**已通过读回核对**的产物交接（且交接前重新核对盘上字节摘要）；
 * **没有任何"已打印/已提交"的状态**。
 *
 * @param java    宿主 `MainActivity.java`（判定交接闸门与回报状态）
 * @param allJava 全部 Android Java 源拼接（判定类型/字段/词表）
 */
export function scanPrintHandoff(java: string, allJava: string): readonly Violation[] {
  const violations: Violation[] = [];
  const push = (rule: string, detail: string): void => {
    violations.push({ rule, detail });
  };

  if (!allJava.includes('PrintManager')) {
    push(RULE_PRINT.manager_missing, '没有接系统打印服务（PrintManager）');
  }
  if (!allJava.includes('PrintDocumentAdapter')) {
    push(RULE_PRINT.manager_missing, '没有接 PrintDocumentAdapter');
  }

  // ---- printed 必须可证伪地恒为 false ----
  if (!/static\s+final\s+boolean\s+PRINTED\s*=\s*false\s*;/.test(allJava)) {
    push(RULE_PRINT.printed_not_false,
      'PRINTED 不是 `static final boolean PRINTED = false;`：无法在类型上证明它恒为假');
  }
  const forbidden = [
    /PRINTED\s*=\s*true/,
    /\bprinted\s*=\s*true/,
    /printed\s*:\s*true/,
    /new\s+Outcome\(State\.[A-Z_]+,\s*true/,
    /printed\s*,\s*true\s*[,)]/,
  ];
  for (const re of forbidden) {
    if (re.test(allJava)) {
      push(RULE_PRINT.printed_not_false, `源码出现把 printed 置真的写法：${re}`);
    }
  }
  const handedOffFactory = extractMethodBody(allJava, 'static Outcome handedOff(');
  if (handedOffFactory === null
    || !/new Outcome\(State\.HANDED_OFF,\s*PRINTED\s*[,)]/.test(handedOffFactory)) {
    push(RULE_PRINT.factory_not_false,
      '尚未证明 handed_off 结果携带 PRINTED(false)（工厂必须把 PRINTED 原样带出）');
  }
  const preparedFactory = extractMethodBody(allJava, 'static Outcome prepared(');
  if (preparedFactory === null
    || !/new Outcome\(State\.PREPARED,\s*PRINTED\s*[,)]/.test(preparedFactory)) {
    push(RULE_PRINT.factory_not_false,
      '尚未证明 prepared 结果携带 PRINTED(false)');
  }

  // ---- 状态类型不可表达"已打印" ----
  const members = enumMembers(allJava, 'State');
  if (members === null) {
    push(RULE_PRINT.state_expresses_printed, '找不到打印状态枚举 State：无法判定它能否表达"已打印"');
  } else {
    const extra = members.filter((m) => !PRINT_ALLOWED_STATES.includes(m));
    if (extra.length > 0) {
      push(RULE_PRINT.state_expresses_printed,
        `打印状态类型出现了额外成员 ${extra.join(', ')}：状态类型不得能表达"已打印/已提交"`);
    }
  }

  // ---- 字符串字面量里不得有非否定语境的"已打印" ----
  // 只看**字符串字面量**（注释里解释"我们没有宣称已打印"是允许的）；
  // 每个含"已打印"的字面量内部必须出现否定词，否则视为**在宣称**已打印。
  for (const literal of javaStringLiterals(allJava)) {
    if (!literal.includes('已打印')) continue;
    if (!/不|没|无|未|非/.test(literal)) {
      push(RULE_PRINT.claims_printed, `字面量在非否定语境里出现"已打印"：${literal}`);
    }
  }

  // ---- 只对已核对的产物交接，且交接前重新核对摘要 ----
  const doPrint = extractMethodBody(java, 'private void doPrintHandoff(');
  if (doPrint === null) {
    push(RULE_PRINT.verification_gate_missing, '找不到 doPrintHandoff(...)：无法判定交接闸门');
  } else {
    const idxGate = doPrint.indexOf('verifiedPdfPath');
    const idxHandoff = doPrint.indexOf('PotbotPrintHandoff.handOff(');
    if (idxGate < 0) {
      push(RULE_PRINT.verification_gate_missing,
        '交接前没有检查"是否已有通过读回核对的 PDF"');
    } else if (idxHandoff >= 0 && idxGate > idxHandoff) {
      push(RULE_PRINT.verification_gate_missing, '核验闸门出现在交接调用之后：顺序颠倒');
    }
    if (!reportsStatus(doPrint, true, 'ST_PRINT_HANDED_OFF')) {
      push(RULE_PRINT.handed_off_status_missing,
        '已交接没有以 ST_PRINT_HANDED_OFF 回报');
    }
    if (!doPrint.includes('ST_PRINT_NOT_VERIFIED')) {
      push(RULE_PRINT.verification_gate_missing,
        '未核验时没有明确拒绝（缺 ST_PRINT_NOT_VERIFIED）');
    }
  }
  if (!allJava.includes('target_digest_mismatch') || !/sha256Of\(/.test(allJava)) {
    push(RULE_PRINT.verification_gate_missing,
      '交接前没有重新计算盘上字节摘要并与读回时的摘要比对');
  }

  // ---- 交接失败原因必须互不相同 ----
  const mapBody = extractMethodBody(java, 'private static String printFailureStatus(');
  if (mapBody === null) {
    push(RULE_PRINT.states_collapsed, '找不到交接失败分类函数 printFailureStatus(...)');
  } else {
    const missing = PRINT_FAILURE_STATUSES.filter((t) => !mapBody.includes(t));
    if (missing.length > 0) {
      push(RULE_PRINT.states_collapsed,
        `交接失败状态缺失/合并：缺少 ${missing.join(', ')}`);
    }
    if (!mapBody.includes('ST_PRINT_UNAVAILABLE')) {
      push(RULE_PRINT.states_collapsed, '交接失败分类没有兜底状态 ST_PRINT_UNAVAILABLE');
    }
  }

  return violations;
}
