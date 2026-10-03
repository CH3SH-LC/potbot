/**
 * APP-05（退后台/锁屏/网络切换/进程回收后回到任务；前台不常开也能获知后台进度；
 * 取消与重连不重复执行）—— 源码级结构断言。
 *
 * 合同依据：`full-app-contract-v1.md` R255（后台按生命周期/工作类型选机制）、
 * R256（回到任务 + 后台进度）、R257（取消与重连不重复执行）、R208（续取游标）。
 *
 * 判据（都可机判）：
 *   ① 有**独立于 Activity 生命周期**的后台机制（JobScheduler/JobService），且权限只落在
 *      **具名白名单**内（白名单外的权限一律报红，见 `android-app-source.ts`）；
 *   ② 任务/进度落进应用私有 SharedPreferences（系统强杀后 Bundle 不回来，prefs 会）；
 *   ③ 冷启动/深链能回到任务（`PotbotTaskState.restoreActive` + `EXTRA_TASK_ID` + 推送）；
 *   ④ 退后台排作业、回前台取消作业；作业到终态**不再重排**（不空转）；
 *   ⑤ 取消/重连的幂等键**单飞**：同一个 (taskId, action) 在受理前只有一个键；
 *   ⑥ 进度"未知"是 -1，**不写成 0**；后端不认识的状态如实记，不当成功。
 *
 * ⚠️ **未验证（需真机）**：JobScheduler 的真实拉起时机、doze 下的行为、通知是否真的出现、
 * 深链是否真的把用户送回任务、强杀后 prefs 是否真的被读回、**API 33+ 权限弹窗与拒绝后的
 * 降级行为**——本文件**只核对源码结构**。
 *
 * FA-APP-NOTIFY-PERM 起：`POST_NOTIFICATIONS` **已声明**且进**具名白名单**（声明 ≠ 已授权，
 * 回前台时请求一次；拒绝后不再打扰，通知发不出则 `NOTIFY_DENIED` 如实记录，进度仍可从
 * 持久层读回）。白名单外的权限仍然一律报红。
 */

import { describe, expect, it } from 'vitest';

import {
  ANDROID_MANIFEST,
  JAVA_DIR,
  KERNEL_TASK_LIFECYCLE,
  MAIN_ACTIVITY,
  PERMISSION_RULE,
  allowlistedPermissionNames,
  declaredPermissions,
  extractMethodBody,
  parseStringConstants,
  readText,
  scanPermissionViolations,
} from './android-app-source.js';

const TASK_STATE = `${JAVA_DIR}/PotbotTaskState.java`;
const JOB_SERVICE = `${JAVA_DIR}/PotbotProgressJobService.java`;
const TASK_ACTIONS = `${JAVA_DIR}/PotbotTaskActions.java`;
const NOTIFY_PERMISSION = `${JAVA_DIR}/PotbotNotificationPermission.java`;

/** 从 `export const X = [ 'a', 'b' ] as const;` 里取出字符串成员。 */
function tsStringArray(source: string, constName: string): readonly string[] {
  const re = new RegExp(`${constName}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`);
  const m = re.exec(source);
  if (!m || m[1] === undefined) throw new Error(`找不到 ${constName}`);
  const out: string[] = [];
  for (const s of m[1].matchAll(/'([^']+)'/g)) {
    if (s[1] !== undefined) out.push(s[1]);
  }
  return out;
}

/** 幂等键"单飞"判别谓词：受理前必须**先读已有键**，而不是每次生成新 nonce。 */
export function actionKeyIsSingleFlight(source: string): boolean {
  const body = extractMethodBody(source, 'public static ActionKey beginAction(');
  if (body === null) return false;
  const idxReadExisting = body.indexOf('getString(ledgerKey');
  const idxNewNonce = body.indexOf('newNonce()');
  if (idxReadExisting < 0 || idxNewNonce < 0) return false;
  if (idxReadExisting > idxNewNonce) return false; // 先造了 nonce 才读旧键 ⇒ 不单飞
  return /return\s+new\s+ActionKey\([^;]*,\s*true\s*\)/.test(body);
}

describe('幂等键单飞判别器（判别力自证）', () => {
  it('干净镜像放行', () => {
    const good = `
      public static ActionKey beginAction(Context context, String taskId, String action) {
        String ledgerKey = ledgerKey(taskId, action);
        String existing = prefs.getString(ledgerKey, null);
        if (existing != null && !existing.isEmpty()) {
          return new ActionKey(idempotencyKey(taskId, action, existing), action, true);
        }
        String nonce = newNonce();
        prefs.edit().putString(ledgerKey, nonce).commit();
        return new ActionKey(idempotencyKey(taskId, action, nonce), action, false);
      }
    `;
    expect(actionKeyIsSingleFlight(good)).toBe(true);
  });

  it('抓得到「每次调用都生成新 nonce」的假幂等', () => {
    const bad = `
      public static ActionKey beginAction(Context context, String taskId, String action) {
        String nonce = newNonce();
        prefs.edit().putString(ledgerKey(taskId, action), nonce).commit();
        return new ActionKey(idempotencyKey(taskId, action, nonce), action, false);
      }
    `;
    expect(actionKeyIsSingleFlight(bad)).toBe(false);
  });
});

describe('后台机制不绑 Activity 生命周期，且不新增权限', () => {
  it('清单里有独立的 JobService（BIND_JOB_SERVICE，exported=false）', () => {
    const manifest = readText(ANDROID_MANIFEST);
    expect(manifest).toMatch(/<service[\s\S]*android:name="\.PotbotProgressJobService"/);
    expect(manifest).toContain('android:permission="android.permission.BIND_JOB_SERVICE"');
    expect(manifest).toMatch(/android:name="\.PotbotProgressJobService"[\s\S]*android:exported="false"|android:exported="false"[\s\S]*android:name="\.PotbotProgressJobService"/);
  });

  it('★权限只落在**具名白名单**内（白名单外一律报红）；POST_NOTIFICATIONS 已收编', () => {
    const manifest = readText(ANDROID_MANIFEST);
    const violations = scanPermissionViolations(manifest);
    const rendered = violations.map((v) => `[${v.rule}] ${v.detail}`).join('\n');
    expect(violations, `[未通过] 清单出现白名单外/硬禁权限：\n${rendered}`).toEqual([]);
    // 声明集合必须与白名单**逐项相等**——新增任何未登记的权限都会报红。
    expect(declaredPermissions(manifest).slice().sort()).toEqual([
      ...allowlistedPermissionNames(),
    ]);
    // 白名单判别力反向对照：塞一个白名单外的权限必须被抓（证明白名单不是恒真）。
    const tainted = manifest.replace(
      '</manifest>',
      '<uses-permission android:name="android.permission.CAMERA" /></manifest>',
    );
    expect(tainted).not.toEqual(manifest);
    expect(scanPermissionViolations(tainted).map((v) => v.rule)).toContain(
      PERMISSION_RULE.not_allowlisted,
    );
  });

  it('API 33+ 通知权限：只读判断 + 回前台请求一次，拒绝即降级（不崩溃、不假装已送达）', () => {
    const perms = readText(NOTIFY_PERMISSION);
    expect(perms).toContain('static boolean isGranted(Context');
    expect(perms).toContain('static boolean requestIfNeeded(Activity');
    expect(perms).toContain('requestPermissions(new String[] { PERMISSION }, REQUEST_CODE)');
    expect(perms).toContain('catch (Throwable');
    // 宿主回前台时真的接线了（不是写了没人调）。
    expect(readText(MAIN_ACTIVITY)).toContain('PotbotNotificationPermission.requestIfNeeded(this)');
    // 发不出时如实记录，不假装成功。
    expect(readText(JOB_SERVICE)).toContain('NOTIFY_DENIED');
  });

  it('用平台自带 JobScheduler 排/取作业（不是前台服务、不是第三方库）', () => {
    const java = readText(JOB_SERVICE);
    expect(java).toContain('extends JobService');
    expect(java).toContain('JOB_SCHEDULER_SERVICE');
    expect(java).toContain('JobInfo.Builder');
    expect(java).toContain('onStartJob');
    expect(java).toContain('jobFinished');
  });

  it('退后台排作业、回前台取消作业；真正关闭时不排', () => {
    const activity = readText(MAIN_ACTIVITY);
    const onStop = extractMethodBody(activity, 'protected void onStop()') ?? '';
    const onResume = extractMethodBody(activity, 'protected void onResume()') ?? '';
    expect(onStop).toContain('PotbotProgressJobService.schedule(this)');
    expect(onStop).toContain('isFinishing()');
    expect(onResume).toContain('PotbotProgressJobService.cancel(this)');
  });

  it('作业到终态 / 没有活动任务时不再重排（不空转）', () => {
    const java = readText(JOB_SERVICE);
    const onStart = extractMethodBody(java, 'public boolean onStartJob(') ?? '';
    expect(onStart).toContain('restoreActive(this)');
    expect(onStart).toMatch(/isTerminal\(\)/);
    expect(onStart, '没有活动任务时必须直接结束').toMatch(/return\s+false/);
    // 终态分支必须早于"继续轮询"的排程。
    const idxTerminal = onStart.indexOf('isTerminal()');
    const idxReschedule = onStart.indexOf('schedule(PotbotProgressJobService.this');
    expect(idxTerminal).toBeGreaterThan(-1);
    expect(idxReschedule).toBeGreaterThan(idxTerminal);
  });
});

describe('回到任务：持久化 + 深链 + 推送', () => {
  it('任务/进度落在应用私有 SharedPreferences（Bundle 之外的持久层）', () => {
    const java = readText(TASK_STATE);
    expect(java).toContain('getSharedPreferences');
    expect(java).toContain('MODE_PRIVATE');
    expect(java).toMatch(/public static void saveActive\(/);
    expect(java).toMatch(/public static Active restoreActive\(/);
  });

  it('MainActivity 冷启动与深链都能取回任务', () => {
    const activity = readText(MAIN_ACTIVITY);
    expect(activity).toContain('PotbotTaskState.restoreActive(this)');
    expect(activity).toContain('EXTRA_TASK_ID');
    expect(activity).toContain('taskIdFromIntent(getIntent())');
    const onNewIntent = extractMethodBody(activity, 'protected void onNewIntent(Intent intent)') ?? '';
    expect(onNewIntent).toContain('taskIdFromIntent(intent)');
    expect(onNewIntent).toContain('setIntent(intent)');
    expect(onNewIntent).toContain('pushRestoreToPage()');
  });

  it('页面就绪后才推送恢复指令（页面未实现该回调则不报错）', () => {
    const activity = readText(MAIN_ACTIVITY);
    const push = extractMethodBody(activity, 'private void pushRestoreToPage()') ?? '';
    expect(push).toContain('pageReady');
    expect(push).toContain('PotbotRestoreTask');
    expect(push).toContain("typeof window.PotbotRestoreTask==='function'");
  });

  it('离开前台（含锁屏）先落盘当前任务', () => {
    const activity = readText(MAIN_ACTIVITY);
    expect(extractMethodBody(activity, 'protected void onPause()') ?? '').toContain('persistActiveTaskState()');
    expect(extractMethodBody(activity, 'protected void onStop()') ?? '').toContain('persistActiveTaskState()');
  });

  it('通知带深链回任务的 PendingIntent（点通知回到任务）', () => {
    const java = readText(JOB_SERVICE);
    expect(java).toContain('PendingIntent.getActivity(');
    expect(java).toContain('MainActivity.EXTRA_TASK_ID');
    expect(java).toContain('FLAG_ACTIVITY_SINGLE_TOP');
  });
});

describe('续取游标与"未知不当已知"', () => {
  it('后台读进度带持久游标（R208：只续取，不重放）', () => {
    const java = readText(JOB_SERVICE);
    expect(java).toContain('?cursor=');
    expect(java).toContain('PROGRESS_PATH_PREFIX');
    expect(java).toContain('.cursor');
  });

  it('进度未知用 -1 表示，绝不写成 0', () => {
    const java = readText(TASK_STATE);
    expect(java).toMatch(/PERCENT_UNKNOWN\s*=\s*-1/);
    const save = extractMethodBody(java, 'public static void saveProgress(') ?? '';
    expect(save, 'saveProgress 不得把未知百分比改写成 0').not.toMatch(/percent\s*=\s*0\b/);
    const job = readText(JOB_SERVICE);
    expect(job).toContain('PERCENT_UNKNOWN');
    expect(job).toContain('进度未知');
  });

  it('后端不认识的状态 / 读失败都如实记，不当成功', () => {
    const java = readText(JOB_SERVICE);
    expect(java).toContain('STATE_ENDPOINT_UNSUPPORTED');
    expect(java).toContain('STATE_READ_FAILED');
    expect(java).toContain('isKnownState(state)');
    // 未知状态必须走"如实记 + 继续重试"，而不是报成功。
    const body = extractMethodBody(java, 'private boolean pollOnce(') ?? '';
    const idxUnknown = body.indexOf('isKnownState(state)');
    expect(idxUnknown).toBeGreaterThan(-1);
    expect(body.slice(idxUnknown)).toContain('STATE_ENDPOINT_UNSUPPORTED');
  });

  it('网络切换有独立回调，且只报事实（在线/离线/未知三态）', () => {
    const activity = readText(MAIN_ACTIVITY);
    const connectivity = readText(`${JAVA_DIR}/PotbotConnectivity.java`);
    expect(connectivity).toContain('registerDefaultNetworkCallback');
    expect(activity).toContain('registerNetworkCallbackIfNeeded()');
    expect(activity).toContain('PotbotConnectivity.isOnline(this)');
    expect(activity).toContain('ST_APP_NET_ONLINE');
    expect(activity).toContain('ST_APP_NET_OFFLINE');
    expect(activity).toContain('ST_APP_NET_UNKNOWN');
  });
});

describe('取消与重连不重复执行', () => {
  it('★幂等键单飞（真实源码放行）', () => {
    expect(actionKeyIsSingleFlight(readText(TASK_STATE))).toBe(true);
  });

  it('幂等键是确定性 sha256(taskId|action|nonce)，受理后清除以允许"新意图"', () => {
    const java = readText(TASK_STATE);
    expect(java).toContain('MessageDigest.getInstance("SHA-256")');
    expect(java).toMatch(/taskId \+ "\|" \+ action \+ "\|" \+ nonce/);
    const complete = extractMethodBody(java, 'public static void completeAction(') ?? '';
    expect(complete).toContain('remove(ledgerKey(taskId, action))');
  });

  it('取消/重连都带上幂等键请求头（后端按 R243 去重）', () => {
    const java = readText(TASK_ACTIONS);
    const cancel = extractMethodBody(java, 'public static void cancel(') ?? '';
    const reconnect = extractMethodBody(java, 'public static void reconnect(') ?? '';
    expect(cancel).toContain('HEADER_IDEMPOTENCY');
    expect(reconnect).toContain('HEADER_IDEMPOTENCY');
    expect(cancel).toContain('PotbotTaskState.beginAction(');
    expect(reconnect).toContain('PotbotTaskState.beginAction(');
  });

  it('后端不支持取消时**不宣称已取消**（404/405/501 ⇒ cancel_not_supported）', () => {
    const java = readText(TASK_ACTIONS);
    const cancel = extractMethodBody(java, 'public static void cancel(') ?? '';
    const idxNotSupported = cancel.indexOf('STATUS_CANCEL_NOT_SUPPORTED');
    const idxAccepted = cancel.indexOf('STATUS_CANCEL_ACCEPTED');
    expect(idxNotSupported).toBeGreaterThan(-1);
    expect(idxAccepted).toBeGreaterThan(-1);
    // 只有 2xx 分支才清除幂等键（才能宣称受理）。
    const idx2xx = cancel.indexOf('code >= 200 && code < 300');
    const idxComplete = cancel.indexOf('PotbotTaskState.completeAction(');
    expect(idx2xx).toBeGreaterThan(-1);
    expect(idxComplete).toBeGreaterThan(idx2xx);
  });

  it('重连只续取（带游标），读不到就报离线而不假装恢复', () => {
    const java = readText(TASK_ACTIONS);
    const reconnect = extractMethodBody(java, 'public static void reconnect(') ?? '';
    expect(reconnect).toContain('?cursor=');
    expect(reconnect).toContain('STATUS_RECONNECT_RESUMED');
    expect(reconnect).toContain('STATUS_RECONNECT_OFFLINE');
  });

  it('动作结果状态两两不同（不合并成一种"失败"）', () => {
    const constants = parseStringConstants(readText(TASK_ACTIONS));
    const names = [...constants.keys()].filter((k) => k.startsWith('STATUS_'));
    expect(names.length).toBeGreaterThanOrEqual(7);
    const values = names.map((n) => constants.get(n) ?? '');
    expect(new Set(values).size).toBe(values.length);
  });

  it('桥上暴露 cancelTask / reconnectTask，且都过可信同源校验', () => {
    const activity = readText(MAIN_ACTIVITY);
    for (const method of ['public void cancelTask(String taskId)', 'public void reconnectTask(String taskId)']) {
      const body = extractMethodBody(activity, method) ?? '';
      expect(body, `${method} 缺失`).not.toBe('');
      expect(body).toContain('isTrustedPageOrigin(lastLocalPageUrl)');
      expect(body).toContain('ST_APP_REJECTED');
    }
    expect(activity).toContain('PotbotTaskActions.cancel(');
    expect(activity).toContain('PotbotTaskActions.reconnect(');
  });
});

describe('手机侧状态与内核状态同名同义（不自己发明状态）', () => {
  const kernel = readText(KERNEL_TASK_LIFECYCLE);
  const java = readText(TASK_STATE);

  it('六个运行态与 src/scheduler/task-lifecycle.ts 完全一致', () => {
    const kernelStates = tsStringArray(kernel, 'TASK_RUNTIME_STATUSES').slice().sort();
    const constants = parseStringConstants(java);
    const appStates = ['ST_RUNNING', 'ST_PAUSED', 'ST_CANCELLED', 'ST_TIMED_OUT', 'ST_FAILED', 'ST_COMPLETED']
      .map((n) => constants.get(n) ?? '')
      .sort();
    expect(appStates).toEqual(kernelStates);
  });

  it('终态集合与内核 TASK_TERMINAL_STATUSES 一致（cancelled/completed）', () => {
    const kernelTerminal = tsStringArray(kernel, 'TASK_TERMINAL_STATUSES').slice().sort();
    const arrayMatch = /TERMINAL_STATUSES\s*=\s*\{([^}]*)\}/.exec(java);
    expect(arrayMatch, '找不到 TERMINAL_STATUSES 数组').not.toBeNull();
    const names = [...(arrayMatch?.[1] ?? '').matchAll(/ST_[A-Z_]+/g)].map((m) => m[0]);
    const constants = parseStringConstants(java);
    const appTerminal = names.map((n) => constants.get(n) ?? '').sort();
    expect(appTerminal).toEqual(kernelTerminal);
  });
});
