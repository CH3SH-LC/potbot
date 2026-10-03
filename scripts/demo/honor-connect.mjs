#!/usr/bin/env node
/** User entry point for the installed HONOR vendor's normal HDB authentication. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { diagnoseHonorHdb } from './honor-hdb.mjs';

const runFile = promisify(execFile);
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const NATIVE_HELPER = resolve(PROJECT_ROOT, '.runtime/honor-hdb/honor-hdb-native.exe');
export const BUILD_COMMAND = 'scripts\\demo\\build-honor-hdb.cmd';
const DEFAULT_TIMEOUT_MS = 65_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const EXIT_CODES = { ready: 0, no_device: 2, device_found_but_not_debuggable: 3, error: 4, ambiguous_device: 5 };
export const APP_PACKAGE = 'com.potbot.demo';
export const APP_COMPONENT = `${APP_PACKAGE}/.MainActivity`;
export const DEFAULT_APK = resolve(PROJECT_ROOT, 'apps/android/app/build/outputs/apk/debug/app-debug.apk');
export const PHONE_HEALTH_SERVICE = String.raw`shell:(printf 'GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'; sleep 2) | toybox nc -w 3 -W 3 127.0.0.1 8765`;
export const STOP_SERVICE = String.raw`shell:am force-stop com.potbot.demo; rc=$?; printf '\nPOTBOT_STOP_EXIT:%s\n' "$rc"`;
export const PID_SERVICE = String.raw`shell:pidof com.potbot.demo; rc=$?; printf '\nPOTBOT_PID_EXIT:%s\n' "$rc"`;
export const START_SERVICE = String.raw`shell:am start -W -n com.potbot.demo/.MainActivity; rc=$?; printf '\nPOTBOT_START_EXIT:%s\n' "$rc"`;

function error(code, details = {}) { return Object.assign(new Error(code), { code, details }); }
function safeError(cause) {
  const code = typeof cause?.code === 'string' && /^[a-z][a-z0-9_]+$/.test(cause.code) ? cause.code : 'local_error';
  return { code, ...(cause?.details || {}) };
}
function validateTarget({ serial, port }) {
  if (typeof serial !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(serial)) throw error('invalid_serial');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw error('invalid_port');
}
function nonEmptyArgument(value, code, limit = 4096) {
  if (typeof value !== 'string' || !value || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) throw error(code);
  return value;
}

function nativeArguments(options) {
  validateTarget(options);
  const args = [`--${options.operation}`, options.serial, String(options.port)];
  if (options.operation === 'doctor') return args;
  if (options.operation === 'service') return [...args, nonEmptyArgument(options.service, 'invalid_service')];
  if (options.operation === 'push') return [...args, resolve(nonEmptyArgument(options.localFile, 'invalid_local_file')), nonEmptyArgument(options.remoteFile, 'invalid_remote_file')];
  throw error('unsupported_native_operation');
}

function nativeMetadata(stdout, stderr) {
  const stages = String(stderr || '').split(/\r?\n/).flatMap((line) => {
    const match = /^stage=([a-z0-9_]{1,80})$/.exec(line);
    return match ? [match[1]] : [];
  });
  return { stages, stdoutBytes: Buffer.byteLength(stdout || ''), stderrBytes: Buffer.byteLength(stderr || '') };
}

function normalizeShell(text) { return String(text).replace(/\r+\n/g, '\n').replace(/\r/g, '\n'); }
function checkedHealth(value) {
  if (!value || typeof value !== 'object' || value.ready !== true ||
      ![value.bootId, value.buildId].every((id) => typeof id === 'string' && /^[a-zA-Z0-9._:-]{1,160}$/.test(id))) throw error('invalid_health_response');
  return { ready: true, bootId: value.bootId, buildId: value.buildId,
    ...(typeof value.modelConfigured === 'boolean' ? { modelConfigured: value.modelConfigured } : {}),
    ...(typeof value.modelVerified === 'boolean' ? { modelVerified: value.modelVerified } : {}) };
}

export async function fetchHostHealth() {
  let response;
  try { response = await fetch('http://127.0.0.1:8765/health', { redirect: 'error', signal: AbortSignal.timeout(4000) }); }
  catch { throw error('host_health_unreachable'); }
  if (response.status !== 200) { await response.body?.cancel(); throw error('host_health_http_error', { status: response.status }); }
  const reader = response.body?.getReader();
  if (!reader) throw error('host_health_empty');
  let size = 0; const chunks = [];
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.length;
      if (size > 65536) { await reader.cancel(); throw error('host_health_too_large'); }
      chunks.push(Buffer.from(chunk.value));
    }
    return checkedHealth(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch (cause) { if (cause.details) throw cause; throw error('host_health_invalid_body'); }
}

function lengthPayload(raw) {
  const bytes = Buffer.from(raw, 'utf8');
  const prefix = bytes.subarray(0, 4).toString('ascii');
  if (!/^[0-9a-fA-F]{4}$/.test(prefix)) throw error('invalid_service_length');
  const length = Number.parseInt(prefix, 16);
  if (bytes.length !== 4 + length) throw error('service_length_mismatch', { expectedBytes: length, receivedBytes: Math.max(0, bytes.length - 4) });
  return bytes.subarray(4).toString('utf8');
}

/** `FAIL` + 4 hex length + message -- adbd's reason for refusing a service request. */
function failureReason(raw) {
  const bytes = Buffer.from(raw.slice(4), 'utf8');
  const prefix = bytes.subarray(0, 4).toString('ascii');
  if (!/^[0-9a-fA-F]{4}$/.test(prefix)) return {};
  const message = bytes.subarray(4, 4 + Number.parseInt(prefix, 16)).toString('utf8');
  const printable = message.replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  return printable ? { reason: printable } : {};
}

/**
 * adbd acknowledges `reverse:forward:tcp:8765;tcp:8765` in two different shapes,
 * and **both mean the mapping is in place**:
 *   1. `OKAY` + 4 hex length + `8765` -- this request created it (12 bytes);
 *   2. a **bare `OKAY`** -- no length prefix and no payload (4 bytes) -- the mapping
 *      already existed, so the request is an idempotent no-op.
 * Shape 2 is a success. Reading it as one is what aborted `start` at `reverse_setup`
 * with `invalid_service_length` (exit 4) on a device that already had `tcp:8765`
 * mapped -- the cold start that follows never ran at all. `reverse:list-forward`
 * re-reads the mapping immediately afterwards anyway, so accepting the bare
 * acknowledgement gives up no verification.
 * This stays narrow on purpose: `FAIL<length><reason>` still fails (now carrying
 * adbd's reason), and `OKAY<length><port>` still has to carry exactly `8765`.
 */
export function parseReverseForward(raw) {
  if (raw.startsWith('FAIL')) throw error('reverse_forward_not_acknowledged', failureReason(raw));
  if (!raw.startsWith('OKAY')) throw error('reverse_forward_not_acknowledged');
  const payload = raw.slice(4);
  // A bare acknowledgement carries no length prefix at all -- nothing to decode.
  if (payload.trim() === '') return { acknowledged: true, devicePort: 8765, hostPort: 8765 };
  const value = lengthPayload(payload);
  if (value !== '8765') throw error('reverse_forward_unexpected_port');
  return { acknowledged: true, devicePort: 8765, hostPort: 8765 };
}

export function parseReverseList(raw) {
  const lines = lengthPayload(raw).split(/\r?\n/).filter(Boolean);
  const mappings = lines.map((line) => {
    const match = /^([a-zA-Z0-9._:-]{1,160}) (\S{1,160}) (\S{1,160})$/.exec(line);
    if (!match) throw error('invalid_reverse_list');
    return { transport: match[1], device: match[2], host: match[3] };
  });
  const relevant = mappings.filter((mapping) => mapping.device === 'tcp:8765');
  if (relevant.length !== 1 || relevant[0].host !== 'tcp:8765') throw error('required_reverse_mapping_missing_or_conflicting');
  return { ...relevant[0], verified: true };
}

export function parsePhoneHealth(raw, hostHealth) {
  const text = normalizeShell(raw);
  const status = /(?:^|\n)HTTP\/1\.[01] (\d{3})(?: [^\n]*)?\n/.exec(text);
  if (!status || status[1] !== '200') throw error('phone_health_http_error', { status: status ? Number(status[1]) : null });
  const bodyStart = text.indexOf('\n\n', status.index);
  if (bodyStart < 0) throw error('phone_health_missing_body');
  // The local Node server emits one-line JSON; chunk framing and PTY CRs may surround it.
  const jsonLines = text.slice(bodyStart + 2).split('\n').filter((line) => /^\{.*\}$/.test(line.trim()));
  if (!jsonLines.length) throw error('phone_health_missing_json');
  let health;
  try { health = checkedHealth(JSON.parse(jsonLines.at(-1).trim())); }
  catch { throw error('phone_health_invalid_json'); }
  if (health.bootId !== hostHealth.bootId || health.buildId !== hostHealth.buildId) throw error('phone_host_identity_mismatch');
  return { ...health, httpStatus: 200, sameHostInstance: true };
}

function parsePackage(raw) {
  const lines = normalizeShell(raw).trim().split('\n');
  if (!lines.length || lines.some((line) => !/^package:\/data\/(?:app|app-private)\/[a-zA-Z0-9/_=+~.-]+\.apk$/.test(line))) throw error('potbot_package_not_verified');
  const apkPaths = lines.map((line) => line.slice('package:'.length));
  const bases = apkPaths.filter((path) => path.endsWith('/base.apk'));
  if (bases.length !== 1) throw error('potbot_base_apk_not_verified');
  return { name: APP_PACKAGE, installed: true, apkCount: lines.length, apkPaths, baseApkPath: bases[0] };
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function inspectLocalApk(path = DEFAULT_APK, dependencies = {}) {
  const expected = await realpath(dependencies.expectedApkPath || DEFAULT_APK).catch(() => { throw error('project_apk_missing', { expectedPath: DEFAULT_APK }); });
  const actual = await realpath(resolve(path)).catch(() => { throw error('requested_apk_missing'); });
  if (relative(expected, actual) !== '') throw error('apk_path_not_allowed', { expectedPath: DEFAULT_APK });
  const info = await stat(actual);
  if (!info.isFile() || info.size < 1 || info.size > 100 * 1024 * 1024) throw error('invalid_apk_size');
  const aaptPath = dependencies.aaptPath || resolve(process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME || 'D:\\android-sdk', 'build-tools/34.0.0/aapt.exe');
  if (!(await stat(aaptPath).catch(() => null))?.isFile()) throw error('apk_inspector_missing', { expectedPath: aaptPath });
  const beforeHash = await sha256File(actual);
  let output;
  try { output = await (dependencies.execute || runFile)(aaptPath, ['dump', 'badging', actual], { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024, encoding: 'utf8', shell: false }); }
  catch { throw error('apk_identity_read_failed'); }
  const identity = /^package: name='([^']+)' versionCode='(\d+)' versionName='([^']*)'/m.exec(output.stdout);
  const launch = /^launchable-activity: name='([^']+)'/m.exec(output.stdout);
  if (identity?.[1] !== APP_PACKAGE || launch?.[1] !== `${APP_PACKAGE}.MainActivity`) throw error('apk_identity_mismatch');
  if (!/^[a-zA-Z0-9._+-]{1,80}$/.test(identity[3])) throw error('invalid_apk_version');
  const hash = await sha256File(actual);
  if (hash !== beforeHash || (await stat(actual)).size !== info.size) throw error('apk_changed_during_inspection');
  return { path: actual, bytes: info.size, sha256: hash, package: APP_PACKAGE, versionCode: identity[2], versionName: identity[3], launchableActivity: launch[1] };
}

function parsePhoneSha256(raw, expectedPath, expectedHash) {
  const match = /^([a-fA-F0-9]{64})[ \t]+(\/[a-zA-Z0-9/_=+~.-]+)$/.exec(normalizeShell(raw).trim());
  if (!match || match[2] !== expectedPath) throw error('phone_apk_hash_not_verified');
  if (match[1].toLowerCase() !== expectedHash) throw error('phone_apk_hash_mismatch');
  return { path: expectedPath, sha256: expectedHash, matchesLocal: true };
}

function parseInstall(raw) {
  const response = normalizeShell(raw).trim();
  if (response === 'Success') return { acknowledged: true, package: APP_PACKAGE };
  const code = /^Failure \[([A-Z0-9_]+)(?:[^\]]*)\]$/.exec(response)?.[1];
  throw error(code ? 'apk_install_rejected' : 'apk_install_result_unknown', code ? { installCode: code } : {});
}

function parseStart(raw) {
  const output = parseExitMarker(raw, 'POTBOT_START_EXIT');
  const text = output.body;
  if (output.exitCode !== 0 || /^Error:/m.test(text) || /Activity not started|currently running|intent has been delivered/i.test(text) ||
      (text.match(/^Status: ok\s*$/gm) || []).length !== 1) throw error('potbot_start_not_verified');
  const launchState = /^LaunchState: (\S+)\s*$/m.exec(text)?.[1];
  if (launchState && launchState !== 'COLD') throw error('potbot_launch_not_cold');
  const activity = /^Activity: ([^\n]+)$/m.exec(text)?.[1]?.trim();
  if (activity && ![APP_COMPONENT, `${APP_PACKAGE}/${APP_PACKAGE}.MainActivity`].includes(activity)) throw error('potbot_started_activity_mismatch');
  return { status: 'ok', commandExitCode: 0, component: APP_COMPONENT, ...(activity ? { activity } : {}), ...(launchState ? { launchState } : {}) };
}

function parsePids(raw) {
  const output = parseExitMarker(raw, 'POTBOT_PID_EXIT');
  const text = output.body.trim();
  if (output.exitCode !== 0) throw error('potbot_pid_not_verified');
  if (!/^[1-9]\d*(?:\s+[1-9]\d*){0,15}$/.test(text)) throw error('potbot_pid_not_verified');
  const pids = text.split(/\s+/).map(Number);
  if (pids.some((pid) => !Number.isSafeInteger(pid))) throw error('potbot_pid_not_verified');
  return { package: APP_PACKAGE, pids: [...new Set(pids)], running: true };
}

export function parseExitMarker(raw, marker) {
  if (!/^POTBOT_[A-Z_]+$/.test(marker)) throw error('invalid_exit_marker');
  const text = normalizeShell(raw).trimEnd();
  const match = new RegExp(`(?:^|\\n)${marker}:([0-9]{1,3})$`).exec(text);
  if (!match) throw error('shell_exit_not_verified');
  return { exitCode: Number(match[1]), body: text.slice(0, match.index) };
}

function parseStopped(raw) {
  const result = parseExitMarker(raw, 'POTBOT_STOP_EXIT');
  if (result.exitCode !== 0 || result.body.trim()) throw error('potbot_force_stop_not_verified');
  return { commandExitCode: 0 };
}

function parseAbsentPid(raw) {
  const result = parseExitMarker(raw, 'POTBOT_PID_EXIT');
  if (result.exitCode !== 1 || result.body.trim()) throw error('potbot_process_still_present_or_unverified');
  return { package: APP_PACKAGE, running: false, pidofExitCode: 1 };
}

export function parseAppLogs(raw, pid) {
  const result = parseExitMarker(raw, 'POTBOT_LOGCAT_EXIT');
  if (result.exitCode !== 0) throw error('potbot_logs_not_verified', { commandExitCode: result.exitCode });
  const lines = result.body.split('\n').filter((line) => {
    const entry = /^\s*([VDIWEFAS])\/(PotbotDemo|chromium|AndroidRuntime)\(\s*(\d+)\):/.exec(line);
    return entry && Number(entry[3]) === pid && (entry[2] === 'PotbotDemo' || ['E', 'F', 'A', 'S'].includes(entry[1]));
  });
  const all = lines.join('\n'), maximumBytes = 128 * 1024;
  const allBytes = Buffer.byteLength(all);
  let text = allBytes > maximumBytes ? Buffer.from(all).subarray(0, maximumBytes).toString('utf8') : all;
  while (Buffer.byteLength(text) > maximumBytes) text = text.slice(0, -1);
  return { package: APP_PACKAGE, pid, commandExitCode: 0, readVerified: true,
    allowedTags: ['PotbotDemo', 'chromium', 'AndroidRuntime'], requestedLineLimit: 200,
    entryCount: lines.length, empty: lines.length === 0, capturedStartupLogs: 'not_verified',
    text, returnedBytes: Buffer.byteLength(text), truncated: allBytes > maximumBytes, maximumBytes };
}

/** Reusable bounded native call. Failed stdout/stderr is discarded, except static stage names. */
export async function invokeHonorNative(options, dependencies = {}) {
  const args = nativeArguments(options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_TIMEOUT_MS) throw error('invalid_timeout');
  const helperPath = dependencies.helperPath || NATIVE_HELPER;
  const info = await stat(helperPath).catch((cause) => {
    if (cause.code === 'ENOENT') throw error('native_helper_missing', { expectedPath: NATIVE_HELPER, action: 'build_native_helper', buildCommand: BUILD_COMMAND });
    throw error('native_helper_unreadable');
  });
  if (!info.isFile()) throw error('native_helper_not_file');
  const execute = dependencies.execute || runFile;
  let output;
  try {
    output = await execute(helperPath, [...(dependencies.prefixArgs || []), ...args], {
      cwd: PROJECT_ROOT, windowsHide: true, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES,
      encoding: 'utf8', shell: false,
    });
  } catch (cause) {
    const metadata = nativeMetadata(cause.stdout, cause.stderr);
    const code = cause.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'native_output_limit' : cause.killed || cause.code === 124 ? 'native_timeout' : 'native_exit_nonzero';
    throw error(code, { ...metadata, exitCode: Number.isInteger(cause.code) ? cause.code : null, signal: typeof cause.signal === 'string' && /^[A-Z0-9]+$/.test(cause.signal) ? cause.signal : null });
  }
  const metadata = nativeMetadata(output.stdout, output.stderr);
  if (!metadata.stages.includes('complete')) throw error('native_completion_not_verified', metadata);
  if (!metadata.stages.includes('vendor_auth_connect_ok')) throw error('native_auth_not_verified', metadata);
  if (options.operation === 'doctor' && !metadata.stages.includes('doctor_command_exit_verified')) throw error('native_doctor_exit_not_verified', metadata);
  if (options.operation === 'push' && !metadata.stages.includes('push_complete')) throw error('native_push_not_verified', metadata);
  return { stdout: output.stdout, ...metadata, exitCode: 0 };
}

/** Failure stops dependent steps; install/start change only the selected app/files/mapping. */
export async function runHonorConnect(options = {}, dependencies = {}) {
  const report = { schemaVersion: 1, checkedAt: new Date().toISOString(), command: options.command || 'doctor',
    route: 'honor_vendor_normal_hdb', readOnly: !['start', 'install'].includes(options.command), enumeration: null,
    native: { status: 'not_attempted', expectedPath: NATIVE_HELPER, buildCommand: BUILD_COMMAND },
    authentication: { method: 'vendor_normal_hdb', status: 'not_verified' },
    probe: { status: 'not_attempted', service: 'shell:getprop ro.product.model' },
    capabilities: { deviceEnumeration: false, normalVendorAuth: false, readOnlyShell: false, install: 'not_verified', forwarding: 'not_verified', phoneToHost: 'not_verified', appLaunch: 'not_verified', appDebug: 'not_verified', appLogRead: 'not_verified' },
    steps: [],
    debugReady: false, verdict: 'error', exitCode: EXIT_CODES.error };
  const finish = (verdict, cause) => ({ ...report, verdict, exitCode: EXIT_CODES[verdict], ...(cause ? { error: safeError(cause) } : {}) });
  if (!['doctor', 'install', 'start', 'status', 'logs'].includes(report.command)) return finish('error', error('unsupported_command', { supportedCommands: ['doctor', 'install', 'start', 'status', 'logs'] }));
  try {
    if (['start', 'status'].includes(report.command)) {
      report.hostHealth = checkedHealth(await (dependencies.fetchHostHealth || fetchHostHealth)());
    }
    const diagnose = dependencies.diagnoseHonorHdb || diagnoseHonorHdb;
    report.enumeration = await diagnose({ port: options.port, serial: options.serial, noProbe: true });
    if (report.enumeration.verdict !== 'enumerated_only') {
      const verdict = ['no_device', 'ambiguous_device'].includes(report.enumeration.verdict) ? report.enumeration.verdict : 'error';
      return finish(verdict, error('enumeration_failed', { causeCode: report.enumeration.error?.code || report.enumeration.verdict }));
    }
    report.capabilities.deviceEnumeration = true;
    const selected = report.enumeration.selection;
    if (!selected || selected.state !== 'device') return finish('device_found_but_not_debuggable', error('device_not_ready', { deviceState: selected?.state || 'unknown' }));
    const port = report.enumeration.transport?.port;
    validateTarget({ serial: selected.serial, port });
    report.native.status = 'running';
    let native;
    try {
      native = await (dependencies.invokeHonorNative || invokeHonorNative)({ operation: 'doctor', serial: selected.serial, port, timeoutMs: options.timeoutMs });
    } catch (cause) {
      const failure = safeError(cause);
      report.native = { ...report.native, status: 'failed', error: failure };
      report.probe.status = 'not_verified';
      return finish('device_found_but_not_debuggable', cause);
    }
    const model = typeof native.stdout === 'string' ? native.stdout.trim() : '';
    if (!/^[a-zA-Z0-9][a-zA-Z0-9 ._+()/-]{0,199}$/.test(model) || /^(?:HDB |FAIL|OKAY)/.test(model)) {
      report.native = { ...report.native, status: 'completed_with_invalid_output', stages: native.stages, stdoutBytes: native.stdoutBytes, stderrBytes: native.stderrBytes };
      report.probe.status = 'failed';
      return finish('device_found_but_not_debuggable', error('invalid_model_response', { stdoutBytes: native.stdoutBytes }));
    }
    report.native = { ...report.native, status: 'succeeded', stages: native.stages, stdoutBytes: native.stdoutBytes, stderrBytes: native.stderrBytes, exitCode: native.exitCode };
    report.authentication.status = 'verified';
    report.probe = { ...report.probe, status: 'succeeded', model };
    report.capabilities.normalVendorAuth = true;
    report.capabilities.readOnlyShell = true;
    report.debugReady = true;
    if (report.command !== 'doctor') {
      report.debugReady = false;
      const call = dependencies.invokeHonorNative || invokeHonorNative;
      const step = async (name, service, parse, mayMutate = false) => {
        const item = { name, status: 'running', mayMutate }; report.steps.push(item);
        try {
          const response = await call({ operation: 'service', serial: selected.serial, port, service, timeoutMs: options.timeoutMs });
          const result = parse(response.stdout);
          Object.assign(item, { status: 'succeeded', stages: response.stages, stdoutBytes: response.stdoutBytes, stderrBytes: response.stderrBytes });
          return result;
        } catch (cause) {
          const uncertain = mayMutate && cause.code !== 'apk_install_rejected';
          Object.assign(item, { status: uncertain ? 'outcome_unknown' : 'failed', ...(uncertain ? { mayHaveChangedDevice: true } : {}), error: safeError(cause) }); throw cause;
        }
      };
      if (report.command === 'install') {
        report.apk = await (dependencies.inspectLocalApk || inspectLocalApk)(options.apk || DEFAULT_APK);
        if (report.apk.package !== APP_PACKAGE || !/^[a-f0-9]{64}$/.test(report.apk.sha256)) throw error('apk_identity_mismatch');
        const remoteFile = `/data/local/tmp/potbot-${report.apk.sha256.slice(0, 12)}.apk`;
        report.temporaryApk = { path: remoteFile, cleanup: 'retained_for_evidence' };
        const pushStep = { name: 'apk_push', status: 'running', mayMutate: true }; report.steps.push(pushStep);
        try {
          const pushed = await call({ operation: 'push', serial: selected.serial, port, localFile: report.apk.path, remoteFile, timeoutMs: options.timeoutMs });
          if (pushed.stdout.trim()) throw error('apk_push_unexpected_output');
          Object.assign(pushStep, { status: 'succeeded', stages: pushed.stages, stdoutBytes: pushed.stdoutBytes, stderrBytes: pushed.stderrBytes });
        } catch (cause) { Object.assign(pushStep, { status: 'outcome_unknown', mayHaveChangedDevice: true, error: safeError(cause) }); throw cause; }
        report.uploadedApk = await step('uploaded_apk_hash', `shell:sha256sum ${remoteFile}`, (raw) => parsePhoneSha256(raw, remoteFile, report.apk.sha256));
        // HONOR validates the exact signed pm command. A trailing marker/compound shell
        // command causes INSTALL_HDB_VERIFY_FAILED on the verified device.
        report.install = await step('apk_install', `shell:pm install -r ${remoteFile}`, parseInstall, true);
        report.package = await step('package_readback', `shell:pm path ${APP_PACKAGE}`, parsePackage);
        report.installedApk = await step('installed_apk_hash', `shell:sha256sum ${report.package.baseApkPath}`, (raw) => parsePhoneSha256(raw, report.package.baseApkPath, report.apk.sha256));
        report.capabilities.install = true;
        report.debugReady = true;
        return finish('ready');
      }
      report.package = await step('package_readback', `shell:pm path ${APP_PACKAGE}`, parsePackage);
      if (report.command === 'logs') {
        report.appProcess = await step('potbot_pid', PID_SERVICE, parsePids);
        if (report.appProcess.pids.length !== 1) throw error('ambiguous_potbot_process');
        const pid = report.appProcess.pids[0];
        const service = `shell:logcat -d --pid=${pid} -t 200 -v brief PotbotDemo:V chromium:E AndroidRuntime:E '*:S'; rc=$?; printf '\\nPOTBOT_LOGCAT_EXIT:%s\\n' "$rc"`;
        report.logs = await step('potbot_logs', service, (raw) => parseAppLogs(raw, pid));
        report.capabilities.appLogRead = true;
        report.debugReady = true;
        return finish('ready');
      }
      if (report.command === 'start') report.reverseSetup = await step('reverse_setup', 'reverse:forward:tcp:8765;tcp:8765', parseReverseForward, true);
      report.mapping = await step('reverse_readback', 'reverse:list-forward', parseReverseList);
      report.capabilities.forwarding = true;
      report.phoneHealth = await step('phone_health', PHONE_HEALTH_SERVICE, (raw) => parsePhoneHealth(raw, report.hostHealth));
      report.capabilities.phoneToHost = true;
      if (report.command === 'start') {
        report.appStop = await step('potbot_force_stop', STOP_SERVICE, parseStopped, true);
        report.stoppedProcess = await step('potbot_stopped_pid', PID_SERVICE, parseAbsentPid);
        report.appStart = await step('potbot_start', START_SERVICE, parseStart, true);
        report.appProcess = await step('potbot_pid', PID_SERVICE, parsePids);
        report.capabilities.appLaunch = true;
      }
      report.debugReady = true;
    }
    return finish('ready');
  } catch (cause) { return finish('error', cause); }
}

export function formatConnectSummary(report) {
  if (report.verdict === 'ready' && report.command === 'install') return 'potbot 安装已回执成功，手机已安装 APK 与本地项目 APK 的 SHA256 一致。';
  if (report.verdict === 'ready' && report.command === 'logs') return report.logs.empty
    ? '已验证目标进程的日志读取能力；本次没有匹配的应用日志，尚未证明捕获启动日志。'
    : `已读取目标进程的 ${report.logs.entryCount} 条匹配日志${report.logs.truncated ? '（内容已截断）' : ''}；启动日志是否完整仍未验证。`;
  if (report.verdict === 'ready' && report.command === 'start') return '荣耀正常授权连接及手机到电脑服务已验证；potbot 已冷启动并读回进程。应用业务与文件验收仍需分别完成。';
  if (report.verdict === 'ready' && report.command === 'status') return '已只读核实 potbot 安装、8765 映射及手机到当前电脑服务的连接。';
  if (report.verdict === 'ready') return `荣耀正常授权连接已验证，设备型号：${report.probe.model}。安装、端口转发和应用调试仍需分别验证。`;
  if (report.error?.code === 'native_helper_missing') return `已发现手机；本项目尚未构建荣耀连接程序。请运行 ${BUILD_COMMAND} 后重试。`;
  if (report.verdict === 'no_device') return '荣耀服务未列出手机，连接程序未调用。';
  if (report.verdict === 'ambiguous_device') return '发现多个设备，请用 --serial 指定手机；连接程序未调用。';
  return `荣耀连接未完成验证，后续步骤已停止。原因：${report.error?.code || report.evidence?.error?.code || report.verdict}。`;
}

function parseArgs(raw) {
  const args = [...raw];
  const options = { command: 'doctor', evidence: '.runtime/honor-hdb' };
  if (args[0] && !args[0].startsWith('--')) options.command = args.shift();
  for (let index = 0; index < args.length; index++) {
    let key = args[index], inline;
    if (/^--port\d+$/.test(key)) { inline = key.slice(6); key = '--port'; }
    else if (key.includes('=')) { const split = key.indexOf('='); inline = key.slice(split + 1); key = key.slice(0, split); }
    if (key === '--json' && inline === undefined) options.json = true;
    else if (['--serial', '--port', '--apk', '--evidence'].includes(key)) {
      const value = inline ?? args[++index];
      if (!value || value.startsWith('--')) throw error('missing_argument');
      options[key.slice(2)] = key === '--port' ? (/^\d+$/.test(value) ? Number(value) : NaN) : value;
    } else throw error('unknown_argument');
  }
  return options;
}

function within(root, target) {
  const path = relative(root, target);
  return path !== '' && path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(path);
}

export async function writeConnectEvidence(report, directory = '.runtime/honor-hdb') {
  const root = await realpath(PROJECT_ROOT), target = resolve(PROJECT_ROOT, directory);
  if (!within(PROJECT_ROOT, target)) throw error('evidence_outside_project');
  let ancestor = target;
  while (true) {
    try { const actual = await realpath(ancestor); if (actual !== root && !within(root, actual)) throw error('evidence_outside_project'); break; }
    catch (cause) { if (cause.code !== 'ENOENT') throw cause; ancestor = dirname(ancestor); }
  }
  await mkdir(target, { recursive: true });
  if (!within(root, await realpath(target))) throw error('evidence_outside_project');
  const path = resolve(target, `honor-connect-${Date.now()}-${process.pid}.json`);
  const withEvidence = { ...report, evidence: { status: 'written', path } };
  await writeFile(path, `${JSON.stringify(withEvidence, null, 2)}\n`, { flag: 'wx' });
  return withEvidence;
}

async function main() {
  let options, report;
  try {
    options = parseArgs(process.argv.slice(2));
    report = await runHonorConnect(options);
    try { report = await writeConnectEvidence(report, options.evidence); }
    catch (cause) { report = { ...report, verdict: 'error', exitCode: 4, evidence: { status: 'failed', error: safeError(cause) } }; }
  } catch (cause) { report = { verdict: 'error', debugReady: false, exitCode: 4, error: safeError(cause) }; }
  if (!options?.json) process.stdout.write(`${formatConnectSummary(report)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.exitCode;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
