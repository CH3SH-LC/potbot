/**
 * WCF-D09 / design-05-P8（WF-082 导入既有 DOCX、WF-084 另存副本导回）：
 * Android 侧**文件边界**的结构化判据。
 *
 * 合同要点：
 *  - 导入走 SAF `ACTION_OPEN_DOCUMENT`，只处理 `content://`；**打开回执 ≠ 保存成功，
 *    也不等于读到了正确字节**——必须实际读入、与系统声明 SIZE 及第二次独立读入交叉核对
 *    后才回报 `import_ok`。
 *  - 另存副本走 `ACTION_CREATE_DOCUMENT`，导回只允许本应用真正取得过授权的 content:// 文档。
 *  - 不因此新增危险权限，也不放宽 FileProvider 暴露面。
 *  - **权限不变量（FA-APP-NOTIFY-PERM 起）**：由"等于固定两元集合"改为**具名白名单**。
 *    它原本要保的是「**不申请与功能无关的敏感权限**」（相机 / 定位 / 通讯录 / 后台定位 /
 *    外部存储……），而不是"永远只有两个权限"。`POST_NOTIFICATIONS` 属于**功能必需 +
 *    用户可见可撤销**的一类，因此被收进白名单；白名单**外**的权限仍然一律报红
 *    （见本文件的反向对照臂：塞 CAMERA / ACCESS_FINE_LOCATION 必须被抓）。
 *
 * **未验证声明**：本文件只断言源码/清单结构；真机（SAF 选择器、授权持久化、导回）
 * 在本波**没有设备**，一律标「未验证」。
 */

import { describe, expect, it } from 'vitest';

import { REPO_ROOT, readText } from '../support.js';
import {
  ALLOWED_PERMISSIONS,
  PERMISSION_RULE,
  allowlistedPermissionNames,
  scanPermissionViolations,
} from '../../full-app/android/android-app-source.js';
import {
  ANDROID_FILE_PATHS,
  ANDROID_MAIN_ACTIVITY,
  ANDROID_MANIFEST,
  RULE,
  extractMethodBody,
  parseStatusConstants,
  reportsStatus,
  scanImport,
} from './android-source.js';

/** FA-APP-NOTIFY-PERM 新增的权限助手与后台作业服务（仓库相对路径）。 */
const ANDROID_NOTIFY_PERMISSION =
  'apps/android/app/src/main/java/com/potbot/demo/PotbotNotificationPermission.java';
const ANDROID_JOB_SERVICE =
  'apps/android/app/src/main/java/com/potbot/demo/PotbotProgressJobService.java';

/** 从清单文本里取出 uses-permission 名单（本文件的局部小工具，保持自足）。 */
function declaredPermissionNames(manifest: string): readonly string[] {
  const out: string[] = [];
  for (const m of manifest.matchAll(/<uses-permission\s+android:name="([^"]+)"/g)) {
    if (m[1] !== undefined) out.push(m[1]);
  }
  return out;
}

/** 合成一份清单：给一组权限名，拼出最小的 `<manifest>` 文本。 */
function syntheticManifest(permissions: readonly string[]): string {
  const lines = permissions
    .map((p) => `    <uses-permission android:name="${p}" />`)
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>\n<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n${lines}\n</manifest>\n`;
}

/** 干净镜像：读入两次、交叉核对摘要、检查 ZIP 形态，最后才报 ok。 */
const CLEAN_IMPORT_SYNTHETIC = `
public class Mirror {
    private void readAndVerifyImport(Uri uri, String origin) {
        long declaredSize = -1L;
        Cursor cursor = getContentResolver().query(uri, null, null, null, null);
        int sizeIdx = cursor.getColumnIndex(OpenableColumns.SIZE);
        byte[] first;
        try {
            first = readAllContent(uri, MAX_IO_BYTES);
        } catch (SecurityException e) {
            reportStatus(false, ST_IMPORT_PERMISSION_DENIED, "读取权限不足");
            return;
        } catch (UriInvalidException e) {
            reportStatus(false, ST_IMPORT_URI_INVALID, "URI 已失效");
            return;
        } catch (TooLargeException e) {
            reportStatus(false, ST_IMPORT_TOO_LARGE, "超过上限");
            return;
        }
        if (declaredSize >= 0 && declaredSize != first.length) {
            reportStatus(false, ST_IMPORT_DECLARED_SIZE_MISMATCH, "与系统声明 SIZE 不符");
            return;
        }
        byte[] second = readAllContent(uri, MAX_IO_BYTES);
        String firstSha = sha256Hex(first);
        String secondSha = sha256Hex(second);
        if (!firstSha.equalsIgnoreCase(secondSha)) {
            reportStatus(false, ST_IMPORT_READBACK_MISMATCH, "两次读入不一致");
            return;
        }
        if (!isZipMagic(first)) {
            reportStatus(false, ST_IMPORT_NOT_ZIP, "不是 ZIP/OOXML");
            return;
        }
        reportStatus(true, ST_IMPORT_OK, "导入完成并字节核对通过");
    }

    void wire() {
        if (!"content".equalsIgnoreCase(uri.getScheme())) { return; }
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        long sz = cursor.getLong(cursor.getColumnIndex(OpenableColumns.SIZE));
    }
}
`;

/** 坏实现 A：只读一次（没有第二次独立读入做字节核对）。 */
const BAD_SINGLE_READ = `
public class Bad {
    private void readAndVerifyImport(Uri uri, String origin) {
        byte[] first = readAllContent(uri, MAX_IO_BYTES);
        reportStatus(true, ST_IMPORT_OK, "读到了就算导入成功");
    }
}
`;

/** 坏实现 B：读了两次但没比对摘要，也没查 ZIP 形态。 */
const BAD_NO_CROSS_COMPARE = `
public class Bad {
    private void readAndVerifyImport(Uri uri, String origin) {
        byte[] first = readAllContent(uri, MAX_IO_BYTES);
        byte[] second = readAllContent(uri, MAX_IO_BYTES);
        String firstSha = sha256Hex(first);
        String secondSha = sha256Hex(second);
        reportStatus(true, ST_IMPORT_OK, "两次都读到东西就算成功");
    }
}
`;

/** 坏实现 C：先把 ok 报出去，比对与形态检查都在后面（顺序颠倒）。 */
const BAD_OK_BEFORE_COMPARE = `
public class Bad {
    private void readAndVerifyImport(Uri uri, String origin) {
        byte[] first = readAllContent(uri, MAX_IO_BYTES);
        byte[] second = readAllContent(uri, MAX_IO_BYTES);
        String firstSha = sha256Hex(first);
        String secondSha = sha256Hex(second);
        if (!isZipMagic(first)) {
            reportStatus(false, ST_IMPORT_NOT_ZIP, "不是 ZIP");
            return;
        }
        reportStatus(true, ST_IMPORT_OK, "先报成功");
        if (!firstSha.equalsIgnoreCase(secondSha)) {
            reportStatus(false, ST_IMPORT_READBACK_MISMATCH, "两次不一致");
            return;
        }
    }
}
`;

describe('导入链扫描器的判别力（先证明尺子有刻度）', () => {
  const WHOLE_FILE_TOKENS = `
    void wire() {
        if (!"content".equalsIgnoreCase(uri.getScheme())) { return; }
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        int sizeIdx = cursor.getColumnIndex(OpenableColumns.SIZE);
    }
`;

  it('干净镜像：零违规（对照臂，防止扫描器恒报红）', () => {
    expect(scanImport(CLEAN_IMPORT_SYNTHETIC)).toEqual([]);
  });

  it('抓得到「只读一次就报导入成功」', () => {
    const rules = scanImport(BAD_SINGLE_READ + WHOLE_FILE_TOKENS).map((v) => v.rule);
    expect(rules).toContain(RULE.import_no_second_read);
    expect(rules).toContain(RULE.import_no_cross_digest);
    expect(rules).toContain(RULE.import_no_zip_magic);
    expect(rules).toContain(RULE.import_states_collapsed);
  });

  it('抓得到「读了两次但没交叉比对、也没查 ZIP 形态」', () => {
    const rules = scanImport(BAD_NO_CROSS_COMPARE + WHOLE_FILE_TOKENS).map((v) => v.rule);
    expect(rules).toContain(RULE.import_no_cross_digest);
    expect(rules).toContain(RULE.import_no_zip_magic);
    expect(rules).toContain(RULE.import_states_collapsed);
  });

  it('抓得到「先报 import_ok、后做比对」的顺序颠倒', () => {
    const rules = scanImport(BAD_OK_BEFORE_COMPARE + WHOLE_FILE_TOKENS).map((v) => v.rule);
    expect(rules).toContain(RULE.import_ok_before_verification);
  });
});

describe('权限白名单判别器（反向对照：证明白名单不是恒真）', () => {
  const CLEAN = syntheticManifest([
    'android.permission.INTERNET',
    'android.permission.ACCESS_NETWORK_STATE',
    'android.permission.POST_NOTIFICATIONS',
  ]);

  it('干净镜像：只含白名单成员 ⇒ 零违规（对照臂，防止"永远报红"）', () => {
    expect(scanPermissionViolations(CLEAN)).toEqual([]);
  });

  it('塞 CAMERA ⇒ 报 permission_not_allowlisted（白名单不是"任意权限都行"）', () => {
    const violations = scanPermissionViolations(
      syntheticManifest(['android.permission.INTERNET', 'android.permission.CAMERA']),
    );
    expect(violations.map((v) => v.rule)).toContain(PERMISSION_RULE.not_allowlisted);
    expect(violations.map((v) => v.detail).join('\n')).toContain('android.permission.CAMERA');
  });

  it('塞 ACCESS_FINE_LOCATION ⇒ 报 permission_not_allowlisted', () => {
    const violations = scanPermissionViolations(
      syntheticManifest(['android.permission.ACCESS_NETWORK_STATE', 'android.permission.ACCESS_FINE_LOCATION']),
    );
    expect(violations.map((v) => v.rule)).toContain(PERMISSION_RULE.not_allowlisted);
    expect(violations.map((v) => v.detail).join('\n')).toContain('ACCESS_FINE_LOCATION');
  });

  it('塞 READ_EXTERNAL_STORAGE ⇒ 报硬禁（存储直读任何理由都不许）', () => {
    const violations = scanPermissionViolations(
      syntheticManifest(['android.permission.INTERNET', 'android.permission.READ_EXTERNAL_STORAGE']),
    );
    expect(violations.map((v) => v.rule)).toContain(PERMISSION_RULE.storage_hard_ban);
  });

  it('真实清单：零违规（这是唯一被放行的那一份）', () => {
    expect(scanPermissionViolations(readText(`${REPO_ROOT}/${ANDROID_MANIFEST}`))).toEqual([]);
  });
});

describe('真实源码：Android 导入/导回边界', () => {
  const java = readText(`${REPO_ROOT}/${ANDROID_MAIN_ACTIVITY}`);

  it('未发现导入链违规：两次读入 + 交叉核对 + ZIP 形态，才报 import_ok', () => {
    const violations = scanImport(java);
    const rendered = violations.map((v) => `[${v.rule}] ${v.detail}`).join('\n');
    expect(violations, `[未通过] 导入链出现违规：\n${rendered}`).toEqual([]);
  });

  it('导入路径的 ok 只在两次读入比对与 ZIP 检查之后', () => {
    const body = extractMethodBody(java, 'private void readAndVerifyImport(');
    expect(body, '[未满足] 找不到 readAndVerifyImport(...)').not.toBeNull();
    const text = body ?? '';
    const idxFirst = text.indexOf('readAllContent(uri');
    const idxSecond = text.indexOf('readAllContent(uri', idxFirst + 1);
    const idxCross = text.indexOf('firstSha.equalsIgnoreCase(secondSha)');
    const idxZip = text.indexOf('isZipMagic(');
    const idxOk = text.indexOf('ST_IMPORT_OK');
    expect(idxSecond, '[未通过] 没有第二次独立读入').toBeGreaterThan(idxFirst);
    expect(idxCross, '[未通过] 没有两次读入的摘要交叉比对').toBeGreaterThan(idxSecond);
    expect(idxZip, '[未通过] 没有 ZIP 形态检查').toBeGreaterThan(idxCross);
    expect(idxOk, '[未通过] import_ok 出现在核对之前').toBeGreaterThan(idxZip);
    expect(reportsStatus(text, true, 'ST_IMPORT_OK'), '[未通过] 成功回报未锚定 ST_IMPORT_OK').toBe(true);
  });

  it('openDocument 导入与 createDocument 另存都接在真实 SAF 动作上', () => {
    expect(java).toContain('Intent.ACTION_OPEN_DOCUMENT');
    expect(java).toContain('Intent.ACTION_CREATE_DOCUMENT');
    expect(java).toContain('Intent.FLAG_GRANT_READ_URI_PERMISSION');
  });

  it('导回只接受本应用取得过授权的 content:// 文档（拒绝任意内容读取）', () => {
    expect(java).toContain('grantedContentUris');
    expect(java).toContain('ST_IMPORT_URI_NOT_GRANTED');
    const body = extractMethodBody(java, 'private void startReimport(');
    expect(body, '[未满足] 找不到 startReimport(...)').not.toBeNull();
    expect(body ?? '').toContain('isGrantedUri(uri)');
  });

  it('导入失败状态互不相同（权限/URI/超限/两次读入不一致/ZIP 形态）', () => {
    const constants = parseStatusConstants(java);
    const names = [
      'ST_IMPORT_PERMISSION_DENIED',
      'ST_IMPORT_URI_INVALID',
      'ST_IMPORT_TOO_LARGE',
      'ST_IMPORT_READBACK_MISMATCH',
      'ST_IMPORT_NOT_ZIP',
      'ST_IMPORT_OK',
    ];
    const values: string[] = [];
    for (const name of names) {
      const value = constants.get(name);
      expect(value, `[未满足] 缺少状态常量 ${name}`).toBeDefined();
      values.push(value ?? '');
    }
    expect(new Set(values).size, `[未通过] 导入状态常量取重：${values.join(', ')}`).toBe(values.length);
    // 成功状态必须与所有失败状态不同名不同值。
    expect(values.includes('import_ok')).toBe(true);
    expect(values.filter((v) => v === 'import_ok')).toHaveLength(1);
  });
});

describe('Android 清单与 FileProvider 暴露面（不得因导入而放宽）', () => {
  const java = readText(`${REPO_ROOT}/${ANDROID_MAIN_ACTIVITY}`);
  const manifest = readText(`${REPO_ROOT}/${ANDROID_MANIFEST}`);
  const filePaths = readText(`${REPO_ROOT}/${ANDROID_FILE_PATHS}`);

  it('权限只落在**具名白名单**内：白名单外一律报红（不是"任意权限都行"）', () => {
    const violations = scanPermissionViolations(manifest);
    const rendered = violations.map((v) => `[${v.rule}] ${v.detail}`).join('\n');
    expect(violations, `[未通过] 清单出现白名单外/硬禁权限：\n${rendered}`).toEqual([]);
    // 同时钉死"声明集合 == 白名单"：新增任何**未登记**的权限都会在这里报红。
    expect([...declaredPermissionNames(manifest)].sort()).toEqual([...allowlistedPermissionNames()]);
  });

  it('POST_NOTIFICATIONS 已声明且在白名单里（API 33+ 通知可达的前提；功能必需、可见可撤销）', () => {
    expect(manifest).toContain('android.permission.POST_NOTIFICATIONS');
    expect([...allowlistedPermissionNames()]).toContain('android.permission.POST_NOTIFICATIONS');
  });

  it('白名单成员必须都是 android.permission.* 且写明功能理由（不许"裸名"或无名理由混入）', () => {
    expect(ALLOWED_PERMISSIONS.length).toBeGreaterThan(0);
    for (const p of ALLOWED_PERMISSIONS) {
      expect(p.name.startsWith('android.permission.'), `[未满足] 非法权限名：${p.name}`).toBe(true);
      expect(p.why.trim().length, `[未满足] ${p.name} 缺少功能理由`).toBeGreaterThan(0);
    }
  });

  it('SAF 导入不需要存储权限（不得出现 READ/WRITE_EXTERNAL_STORAGE、MANAGE_EXTERNAL_STORAGE）', () => {
    expect(manifest).not.toMatch(/READ_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE|MANAGE_EXTERNAL_STORAGE/);
  });

  it('API 33+ 的运行时请求有只读判断 + 一次性请求，拒绝后降级不崩溃', () => {
    const perms = readText(`${REPO_ROOT}/${ANDROID_NOTIFY_PERMISSION}`);
    // 只读判断：是否已授权 / 是否声明，读不到一律保守返回 false。
    expect(perms).toContain('static boolean isGranted(Context');
    expect(perms).toContain('static boolean isDeclared(Context');
    expect(perms).toContain('checkSelfPermission(PERMISSION)');
    expect(perms).toContain('PERMISSION_GRANTED');
    // 请求：只在"未授权且没问过"时请求一次（拒绝后不再骚扰）。
    expect(perms).toContain('static boolean requestIfNeeded(Activity');
    expect(perms).toContain('requestPermissions(');
    const request = extractMethodBody(perms, 'static boolean requestIfNeeded(Activity') ?? '';
    expect(request).toContain('isGranted(activity)');
    expect(request).toContain('requestPermissions(');
    // 异常一律吞掉（降级而非崩溃）。
    expect(perms).toContain('catch (Throwable');
    // 宿主在回前台时真的调用了它（不是写了没人用）。
    expect(java).toContain('PotbotNotificationPermission.requestIfNeeded(this)');
  });

  it('拒绝授权时通知发不出去只**如实记录**，不假装已送达', () => {
    const job = readText(`${REPO_ROOT}/${ANDROID_JOB_SERVICE}`);
    expect(job).toContain('NOTIFY_DENIED');
    expect(job).toContain('canNotify()');
    expect(job).toContain('notification_permission_not_declared_or_denied');
  });

  it('FileProvider 仍只暴露应用私有 artifacts/，没有外部存储或根路径', () => {
    const pathKinds: string[] = [];
    for (const m of filePaths.matchAll(
      /<\s*(files-path|external-path|external-files-path|external-cache-path|external-media-path|cache-path|root-path)\b/g,
    )) {
      if (m[1] !== undefined) pathKinds.push(m[1]);
    }
    expect(pathKinds).toEqual(['files-path']);
    expect(filePaths).toContain('path="artifacts/"');
  });

  it('WebView 仍不允许 file/content 协议访问（导入不靠放宽 WebView）', () => {
    expect(java).toContain('s.setAllowFileAccess(false)');
    expect(java).toContain('s.setAllowContentAccess(false)');
  });

  it('桥的既有回调签名未被修改：PotbotBridgeResult 仍是 2 参数', () => {
    // 结构化状态走**独立的、可选的** PotbotBridgeStatus 通道；旧页面实现不受影响。
    expect(java).toContain("JS_RESULT_FN = \"PotbotBridgeResult\"");
    expect(java).toContain("JS_STATUS_FN = \"PotbotBridgeStatus\"");
    expect(java).toMatch(/typeof window\.\" \+ JS_STATUS_FN \+ \"==='function'/);
    expect(java).not.toMatch(/PotbotBridgeResult,\s*\"\+\s*JSONObject/);
  });
});
