import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const scriptPath = resolve('scripts/demo/honor-connect.mjs');
const modulePath = pathToFileURL(scriptPath).href;
const { invokeHonorNative, runHonorConnect, formatConnectSummary, writeConnectEvidence, PROJECT_ROOT,
  PHONE_HEALTH_SERVICE, STOP_SERVICE, PID_SERVICE, START_SERVICE, parsePhoneHealth, parseReverseForward, parseReverseList,
  parseAppLogs, inspectLocalApk } = await import(modulePath);
const execute = promisify(execFile);
const temporaryDirectories: Array<{ root: string; path: string }> = [];
const goodStages = 'stage=vendor_auth_connect_ok\nstage=doctor_command_exit_verified\nstage=service_response_complete\nstage=push_complete\nstage=complete\n';
const enumerated = () => ({ verdict: 'enumerated_only', debugReady: false, exitCode: 0,
  transport: { status: 'reachable', host: '127.0.0.1', port: 12345, versionDecimal: 38 },
  devices: [{ serial: 'TEST-HONOR', state: 'device' }], selection: { serial: 'TEST-HONOR', state: 'device' },
  probe: { status: 'skipped' },
});
const health = { ready: true, bootId: 'boot-fixture-1', buildId: 'build-fixture-1', modelConfigured: true, modelVerified: false };
const framed = (body: string) => `${Buffer.byteLength(body).toString(16).padStart(4, '0')}${body}`;
const phoneHttp = (body = health) => `HTTP/1.1 200 OK\r\r\nContent-Type: application/json\r\r\nTransfer-Encoding: chunked\r\r\n\r\r\n${Buffer.byteLength(JSON.stringify(body)).toString(16)}\r\r\n${JSON.stringify(body)}\r\r\n0\r\r\n\r\r\n`;
function appFixture(overrides: Record<string, string> = {}) {
  const requests: string[] = [];
  const responses: Record<string, string> = {
    'shell:pm path com.potbot.demo': 'package:/data/app/~~fixture/com.potbot.demo-id/base.apk\r\r\n',
    'reverse:forward:tcp:8765;tcp:8765': 'OKAY00048765',
    'reverse:list-forward': framed('UsbFfs_hdb tcp:8765 tcp:8765\n'),
    [PHONE_HEALTH_SERVICE]: phoneHttp(),
    [STOP_SERVICE]: '\nPOTBOT_STOP_EXIT:0\r\r\n',
    [START_SERVICE]: 'Starting: Intent { cmp=com.potbot.demo/.MainActivity }\r\r\nStatus: ok\r\r\nActivity: com.potbot.demo/.MainActivity\r\r\nLaunchState: COLD\r\r\nComplete\r\r\nPOTBOT_START_EXIT:0\r\r\n',
    [PID_SERVICE]: '23456\r\r\nPOTBOT_PID_EXIT:0\r\r\n',
    ...overrides,
  };
  return { requests, dependencies: {
    fetchHostHealth: async () => health,
    diagnoseHonorHdb: async () => enumerated(),
    invokeHonorNative: async (options: { operation: string; service?: string }) => {
      const previous = requests.at(-1);
      requests.push(options.operation === 'doctor' ? '--doctor' : options.service!);
      let stdout = options.operation === 'doctor' ? 'Magic7\r\n' : responses[options.service!];
      if (options.service === PID_SERVICE && previous === STOP_SERVICE && !Object.hasOwn(overrides, 'stopped_pid')) stdout = '\nPOTBOT_PID_EXIT:1\n';
      if (options.service === PID_SERVICE && previous === STOP_SERVICE && Object.hasOwn(overrides, 'stopped_pid')) stdout = overrides.stopped_pid;
      if (options.service?.startsWith('shell:logcat ')) stdout = overrides.logs ?? 'I/PotbotDemo(23456): Fixture application log\nPOTBOT_LOGCAT_EXIT:0\n';
      if (stdout === undefined) throw new Error('Unexpected native service');
      return { stdout, stages: ['vendor_auth_connect_ok', 'service_response_complete', 'complete'], stdoutBytes: Buffer.byteLength(stdout), stderrBytes: goodStages.length, exitCode: 0 };
    },
  } };
}

const fixtureHash = 'a'.repeat(64);
const fixtureRemote = `/data/local/tmp/potbot-${fixtureHash.slice(0, 12)}.apk`;
const fixtureInstalled = '/data/app/~~fixture/com.potbot.demo-id/base.apk';
function installFixture(overrides: Record<string, string> = {}) {
  const requests: string[] = [];
  const responses: Record<string, string> = {
    [`shell:sha256sum ${fixtureRemote}`]: `${fixtureHash}  ${fixtureRemote}\n`,
    [`shell:pm install -r ${fixtureRemote}`]: 'Success\r\r\n',
    'shell:pm path com.potbot.demo': `package:${fixtureInstalled}\n`,
    [`shell:sha256sum ${fixtureInstalled}`]: `${fixtureHash}  ${fixtureInstalled}\n`,
    ...overrides,
  };
  return { requests, dependencies: {
    fetchHostHealth: async () => { throw new Error('Install must not require host health'); },
    diagnoseHonorHdb: async () => enumerated(),
    inspectLocalApk: async () => ({ path: 'C:\\fixture\\app-debug.apk', bytes: 1234, sha256: fixtureHash, package: 'com.potbot.demo', versionCode: '1', versionName: '1.0-demo' }),
    invokeHonorNative: async (options: { operation: string; service?: string; localFile?: string; remoteFile?: string }) => {
      requests.push(options.operation === 'service' ? options.service! : `--${options.operation}`);
      if (options.operation === 'push') expect(options).toMatchObject({ localFile: 'C:\\fixture\\app-debug.apk', remoteFile: fixtureRemote });
      const stdout = options.operation === 'doctor' ? 'Magic7\n' : options.operation === 'push' ? '' : responses[options.service!];
      if (stdout === undefined) throw new Error('Unexpected install command');
      return { stdout, stages: ['vendor_auth_connect_ok', 'doctor_command_exit_verified', 'service_response_complete', 'push_complete', 'complete'], stdoutBytes: Buffer.byteLength(stdout), stderrBytes: goodStages.length, exitCode: 0 };
    },
  } };
}

async function directory(root = tmpdir()) {
  const path = await mkdtemp(join(root, 'honor-connect-test-'));
  temporaryDirectories.push({ root, path });
  return path;
}

async function fakeNative(scenario = 'good') {
  const dir = await directory();
  const path = join(dir, 'fake-native.mjs');
  await writeFile(path, `
const [scenario, operation, serial, port, ...args] = process.argv.slice(2);
const stages = ${JSON.stringify(goodStages)};
if (scenario === 'good') {
  process.stderr.write(stages);
  process.stdout.write(operation === '--doctor' ? 'Magic7\\r\\n' : JSON.stringify({operation, serial, port, args}));
} else if (scenario === 'failure') {
  process.stderr.write('stage=vendor_auth_connect_start\\nSECRET_STDERR_AUTH_PAYLOAD\\n');
  process.stdout.write('SECRET_STDOUT_AUTH_PAYLOAD');
  process.exitCode = 7;
} else if (scenario === 'timeout') {
  setTimeout(() => {}, 60000);
} else if (scenario === 'no_complete') {
  process.stderr.write('stage=vendor_auth_connect_ok\\n'); process.stdout.write('Magic7');
} else if (scenario === 'no_auth') {
  process.stderr.write('stage=complete\\n'); process.stdout.write('Magic7');
} else if (scenario === 'old_doctor') {
  process.stderr.write('stage=vendor_auth_connect_ok\\nstage=complete\\n'); process.stdout.write('Magic7');
} else if (scenario === 'doctor_failed') {
  process.stderr.write('stage=vendor_auth_connect_ok\\nstage=doctor_command_failed\\n'); process.stdout.write('Permission denied'); process.exitCode = 43;
} else if (scenario === 'oversize') {
  process.stderr.write(stages); process.stdout.write('S'.repeat(2 * 1024 * 1024));
} else if (scenario === 'invalid_model') {
  process.stderr.write(stages); process.stdout.write('HDB AUTHENTICEXRES SECRET_AUTH_PAYLOAD');
}
`, 'utf8');
  return { helperPath: process.execPath, prefixArgs: [path, scenario] };
}

afterEach(async () => {
  while (temporaryDirectories.length) {
    const entry = temporaryDirectories.pop()!;
    const rel = relative(entry.root, entry.path);
    if (!rel.startsWith('honor-connect-test-') || rel.includes(sep)) throw new Error('Refusing unsafe fixture cleanup');
    await rm(entry.path, { recursive: true, force: true });
  }
});

describe('HONOR normal vendor connection wrapper with synthetic enumeration and native fixtures', () => {
  it('verifies upload and installed APK hashes around a pure pm install command without app restart', async () => {
    const fixture = installFixture();
    const report = await runHonorConnect({ command: 'install' }, fixture.dependencies);
    expect(report).toMatchObject({ verdict: 'ready', readOnly: false, capabilities: { install: true, appLaunch: 'not_verified' },
      uploadedApk: { matchesLocal: true }, install: { acknowledged: true }, installedApk: { sha256: fixtureHash, matchesLocal: true },
      temporaryApk: { path: fixtureRemote, cleanup: 'retained_for_evidence' } });
    expect(fixture.requests).toEqual(['--doctor', '--push', `shell:sha256sum ${fixtureRemote}`, `shell:pm install -r ${fixtureRemote}`,
      'shell:pm path com.potbot.demo', `shell:sha256sum ${fixtureInstalled}`]);
    const installCommand = fixture.requests.find((command) => command.startsWith('shell:pm install'))!;
    expect(installCommand).not.toMatch(/[;&|]|POTBOT_.*EXIT/);
  });

  it('fails before installation if uploaded bytes differ from the inspected APK', async () => {
    const fixture = installFixture({ [`shell:sha256sum ${fixtureRemote}`]: `${'b'.repeat(64)}  ${fixtureRemote}\n` });
    expect(await runHonorConnect({ command: 'install' }, fixture.dependencies)).toMatchObject({ verdict: 'error', error: { code: 'phone_apk_hash_mismatch' } });
    expect(fixture.requests).not.toContain(`shell:pm install -r ${fixtureRemote}`);
  });

  it('distinguishes explicit install rejection from unverified acknowledgement and never accepts Success plus extra text', async () => {
    for (const [response, code, status] of [
      ['Failure [INSTALL_HDB_VERIFY_FAILED]', 'apk_install_rejected', 'failed'],
      ['Success\nUnexpected extra response', 'apk_install_result_unknown', 'outcome_unknown'],
    ] as const) {
      const fixture = installFixture({ [`shell:pm install -r ${fixtureRemote}`]: response });
      const report = await runHonorConnect({ command: 'install' }, fixture.dependencies);
      expect(report).toMatchObject({ verdict: 'error', error: { code } });
      expect(report.steps.at(-1)).toMatchObject({ name: 'apk_install', status });
      expect(fixture.requests.at(-1)).toBe(`shell:pm install -r ${fixtureRemote}`);
    }
  });

  it('does not claim verified installation if installed base.apk differs after a Success response', async () => {
    const fixture = installFixture({ [`shell:sha256sum ${fixtureInstalled}`]: `${'b'.repeat(64)}  ${fixtureInstalled}\n` });
    const report = await runHonorConnect({ command: 'install' }, fixture.dependencies);
    expect(report).toMatchObject({ verdict: 'error', install: { acknowledged: true }, capabilities: { install: 'not_verified' }, error: { code: 'phone_apk_hash_mismatch' } });
  });

  it('accepts only the designated project APK and validates its embedded package and launch identity', async () => {
    const dir = await directory();
    const apk = join(dir, 'app-debug.apk'), other = join(dir, 'other.apk');
    await writeFile(apk, 'fixture APK bytes'); await writeFile(other, 'other APK bytes');
    const deps = { expectedApkPath: apk, aaptPath: process.execPath, execute: async () => ({ stdout: "package: name='com.potbot.demo' versionCode='1' versionName='1.0-demo'\nlaunchable-activity: name='com.potbot.demo.MainActivity' label='potbot'\n", stderr: '' }) };
    expect(await inspectLocalApk(apk, deps)).toMatchObject({ path: apk, bytes: 17, package: 'com.potbot.demo', sha256: createHash('sha256').update('fixture APK bytes').digest('hex') });
    await expect(inspectLocalApk(other, deps)).rejects.toMatchObject({ code: 'apk_path_not_allowed' });
    await expect(inspectLocalApk(apk, { ...deps, execute: async () => ({ stdout: "package: name='another.app' versionCode='1' versionName='1'\nlaunchable-activity: name='another.app.MainActivity'\n" }) })).rejects.toMatchObject({ code: 'apk_identity_mismatch' });
  });

  it('detects a project APK rebuilt while its identity is being inspected', async () => {
    const apk = join(await directory(), 'app-debug.apk'); await writeFile(apk, 'before');
    await expect(inspectLocalApk(apk, { expectedApkPath: apk, aaptPath: process.execPath, execute: async () => {
      await writeFile(apk, 'after');
      return { stdout: "package: name='com.potbot.demo' versionCode='1' versionName='1.0-demo'\nlaunchable-activity: name='com.potbot.demo.MainActivity'\n" };
    } })).rejects.toMatchObject({ code: 'apk_changed_during_inspection' });
  });

  it('requires a force-stop exit marker and an independently absent PID before launch', async () => {
    for (const overrides of [{ [STOP_SERVICE]: '' }, { stopped_pid: '23456\nPOTBOT_PID_EXIT:0\n' }] as Array<Record<string, string>>) {
      const fixture = appFixture(overrides);
      const report = await runHonorConnect({ command: 'start' }, fixture.dependencies);
      expect(report.verdict).toBe('error');
      expect(fixture.requests).not.toContain(START_SERVICE);
    }
  });

  it('rejects a hot launch warning even when am start reports Status ok and exit zero', async () => {
    const fixture = appFixture({ [START_SERVICE]: 'Warning: Activity not started, intent has been delivered to currently running top-most instance.\nStatus: ok\nPOTBOT_START_EXIT:0\n' });
    const report = await runHonorConnect({ command: 'start' }, fixture.dependencies);
    expect(report).toMatchObject({ verdict: 'error', error: { code: 'potbot_start_not_verified' } });
    expect(report.steps.at(-1)).toMatchObject({ status: 'outcome_unknown', mayHaveChangedDevice: true });
  });

  it('preserves unknown device outcome for timed-out reverse mutations and stops dependent work', async () => {
    const fixture = appFixture();
    const original = fixture.dependencies.invokeHonorNative;
    fixture.dependencies.invokeHonorNative = async (options) => {
      if (options.service === 'reverse:forward:tcp:8765;tcp:8765') throw Object.assign(new Error('timeout'), { code: 'native_timeout', details: {} });
      return original(options);
    };
    const report = await runHonorConnect({ command: 'start' }, fixture.dependencies);
    expect(report).toMatchObject({ verdict: 'error', error: { code: 'native_timeout' } });
    expect(report.steps.at(-1)).toMatchObject({ name: 'reverse_setup', status: 'outcome_unknown', mayHaveChangedDevice: true });
    expect(fixture.requests).not.toContain('reverse:list-forward');
  });

  it('reads scoped logs even when host health is unavailable and records the exact PID filter', async () => {
    const fixture = appFixture();
    const report = await runHonorConnect({ command: 'logs' }, { ...fixture.dependencies, fetchHostHealth: async () => { throw new Error('Must not fetch host for logs'); } });
    expect(report).toMatchObject({ verdict: 'ready', readOnly: true, logs: { pid: 23456, readVerified: true, entryCount: 1, capturedStartupLogs: 'not_verified' }, capabilities: { appLogRead: true } });
    expect(fixture.requests.at(-1)).toBe("shell:logcat -d --pid=23456 -t 200 -v brief PotbotDemo:V chromium:E AndroidRuntime:E '*:S'; rc=$?; printf '\\nPOTBOT_LOGCAT_EXIT:%s\\n' \"$rc\"");
    expect(fixture.requests).not.toContain(PHONE_HEALTH_SERVICE);
  });

  it('does not equate empty scoped log output with captured startup logs', async () => {
    const fixture = appFixture({ logs: '\nPOTBOT_LOGCAT_EXIT:0\n' });
    const report = await runHonorConnect({ command: 'logs' }, fixture.dependencies);
    expect(report).toMatchObject({ verdict: 'ready', logs: { empty: true, entryCount: 0, text: '', readVerified: true, capturedStartupLogs: 'not_verified' } });
    expect(formatConnectSummary(report)).toContain('尚未证明捕获启动日志');
  });

  it('keeps only the selected PID and allowed tags and caps log evidence at 128 KiB', () => {
    const raw = `I/PotbotDemo(23456): ${'测'.repeat(50000)}\nE/chromium(99999): OTHER_PROCESS_SECRET\nI/Unrelated(23456): OTHER_TAG_SECRET\nI/chromium(23456): LOW_PRIORITY_SECRET\nPOTBOT_LOGCAT_EXIT:0\n`;
    const logs = parseAppLogs(raw, 23456);
    expect(logs).toMatchObject({ truncated: true, entryCount: 1, readVerified: true });
    expect(logs.returnedBytes).toBeLessThanOrEqual(128 * 1024);
    expect(logs.text).not.toContain('SECRET');
    expect(() => parseAppLogs('POTBOT_LOGCAT_EXIT:1\n', 23456)).toThrow('potbot_logs_not_verified');
  });

  it('starts only the fixed app after reverse acknowledgement, mapping and same-instance phone health', async () => {
    const fixture = appFixture();
    const report = await runHonorConnect({ command: 'start' }, fixture.dependencies);
    expect(report).toMatchObject({ verdict: 'ready', readOnly: false, debugReady: true,
      package: { name: 'com.potbot.demo', installed: true },
      reverseSetup: { acknowledged: true, devicePort: 8765, hostPort: 8765 },
      phoneHealth: { sameHostInstance: true, bootId: health.bootId, buildId: health.buildId },
      appStart: { status: 'ok', component: 'com.potbot.demo/.MainActivity' },
      appProcess: { package: 'com.potbot.demo', pids: [23456] },
      capabilities: { forwarding: true, phoneToHost: true, appLaunch: true, appDebug: 'not_verified' } });
    expect(fixture.requests).toEqual(['--doctor', 'shell:pm path com.potbot.demo', 'reverse:forward:tcp:8765;tcp:8765',
      'reverse:list-forward', PHONE_HEALTH_SERVICE, STOP_SERVICE, PID_SERVICE, START_SERVICE, PID_SERVICE]);
    expect(PHONE_HEALTH_SERVICE).toContain('; sleep 2)');
    expect(JSON.stringify(report)).not.toContain('Starting: Intent');
  });

  it('status performs read-only app, mapping and phone health checks without changing the app or mapping', async () => {
    const fixture = appFixture();
    const report = await runHonorConnect({ command: 'status' }, fixture.dependencies);
    expect(report).toMatchObject({ verdict: 'ready', readOnly: true, capabilities: { phoneToHost: true, appLaunch: 'not_verified' } });
    expect(fixture.requests).toEqual(['--doctor', 'shell:pm path com.potbot.demo', 'reverse:list-forward', PHONE_HEALTH_SERVICE]);
  });

  it('refuses to contact the phone when host readiness is false', async () => {
    const fixture = appFixture();
    const report = await runHonorConnect({ command: 'start' }, { ...fixture.dependencies, fetchHostHealth: async () => ({ ...health, ready: false }) });
    expect(report).toMatchObject({ verdict: 'error', enumeration: null, error: { code: 'invalid_health_response' } });
    expect(fixture.requests).toEqual([]);
  });

  it('rejects missing reverse acknowledgements, malformed lengths and conflicting mappings', () => {
    expect(parseReverseForward('OKAY00048765')).toEqual({ acknowledged: true, devicePort: 8765, hostPort: 8765 });
    for (const raw of ['00048765', 'OKAY00048766', 'OKAY00058765', 'OKAY00048765extra']) expect(() => parseReverseForward(raw)).toThrow();
    expect(parseReverseList(framed('UsbFfs_hdb tcp:8765 tcp:8765\n'))).toMatchObject({ verified: true });
    for (const body of ['', 'UsbFfs_hdb tcp:8765 tcp:9876\n', 'UsbFfs_hdb tcp:8765 tcp:8765\nUsbFfs_hdb tcp:8765 tcp:8765\n']) {
      expect(() => parseReverseList(framed(body))).toThrow();
    }
  });

  it('normalizes PTY line endings, discards extra health fields and rejects host identity mismatch', () => {
    const raw = phoneHttp({ ...health, secret: 'DO_NOT_STORE' } as typeof health);
    expect(parsePhoneHealth(raw, health)).toEqual({ ...health, httpStatus: 200, sameHostInstance: true });
    expect(JSON.stringify(parsePhoneHealth(raw, health))).not.toContain('DO_NOT_STORE');
    expect(() => parsePhoneHealth(phoneHttp({ ...health, bootId: 'other-boot' }), health)).toThrow('phone_host_identity_mismatch');
    expect(() => parsePhoneHealth(phoneHttp().replace('200 OK', '503 Failed'), health)).toThrow('phone_health_http_error');
  });

  it('stops before app mutation when package, mapping or phone health evidence is invalid', async () => {
    for (const [service, reply, code] of [
      ['shell:pm path com.potbot.demo', '', 'potbot_package_not_verified'],
      ['reverse:forward:tcp:8765;tcp:8765', 'FAIL0006closed', 'reverse_forward_not_acknowledged'],
      ['reverse:list-forward', framed('UsbFfs_hdb tcp:8765 tcp:9876\n'), 'required_reverse_mapping_missing_or_conflicting'],
      [PHONE_HEALTH_SERVICE, phoneHttp({ ...health, buildId: 'old-build' }), 'phone_host_identity_mismatch'],
    ] as const) {
      const fixture = appFixture({ [service]: reply });
      const report = await runHonorConnect({ command: 'start' }, fixture.dependencies);
      expect(report).toMatchObject({ verdict: 'error', debugReady: false, error: { code } });
      expect(fixture.requests.at(-1)).toBe(service);
      expect(fixture.requests).not.toContain(STOP_SERVICE);
    }
  });

  it('does not treat native exit zero as successful application launch or process readback', async () => {
    const failedStart = appFixture({ [START_SERVICE]: 'Error: Activity class does not exist\nPOTBOT_START_EXIT:1\n' });
    const report = await runHonorConnect({ command: 'start' }, failedStart.dependencies);
    expect(report).toMatchObject({ verdict: 'error', error: { code: 'potbot_start_not_verified' } });
    expect(failedStart.requests.at(-1)).toBe(START_SERVICE);
    const noProcess = appFixture({ [PID_SERVICE]: '\nPOTBOT_PID_EXIT:1\n' });
    expect(await runHonorConnect({ command: 'start' }, noProcess.dependencies)).toMatchObject({ verdict: 'error', error: { code: 'potbot_pid_not_verified' } });
  });

  it('enumerates without a raw shell probe then verifies normal vendor auth and model', async () => {
    const calls: unknown[] = [];
    const native = await fakeNative();
    const report = await runHonorConnect({ command: 'doctor', port: 12345, serial: 'TEST-HONOR' }, {
      diagnoseHonorHdb: async (options: unknown) => { calls.push(options); return enumerated(); },
      invokeHonorNative: (options: unknown) => invokeHonorNative(options, native),
    });
    expect(calls).toEqual([{ port: 12345, serial: 'TEST-HONOR', noProbe: true }]);
    expect(report).toMatchObject({ verdict: 'ready', debugReady: true, exitCode: 0,
      route: 'honor_vendor_normal_hdb', enumeration: { debugReady: false },
      authentication: { method: 'vendor_normal_hdb', status: 'verified' }, probe: { status: 'succeeded', model: 'Magic7' },
      capabilities: { deviceEnumeration: true, normalVendorAuth: true, readOnlyShell: true, install: 'not_verified', forwarding: 'not_verified', appDebug: 'not_verified' } });
    expect(formatConnectSummary(report)).toContain('安装、端口转发和应用调试仍需分别验证');
  });

  it('does not invoke native when discovery fails, finds no devices, or is ambiguous', async () => {
    for (const verdict of ['error', 'no_device', 'ambiguous_device']) {
      let nativeCalls = 0;
      const report = await runHonorConnect({}, {
        diagnoseHonorHdb: async () => ({ verdict, error: { code: 'fixture_preflight_failure' } }),
        invokeHonorNative: async () => { nativeCalls++; throw new Error('Must not run'); },
      });
      expect(report).toMatchObject({ verdict, debugReady: false, native: { status: 'not_attempted' } });
      expect(nativeCalls).toBe(0);
    }
  });

  it('does not invoke native for a selected offline or unauthorized device', async () => {
    for (const state of ['offline', 'unauthorized']) {
      let nativeCalls = 0;
      const report = await runHonorConnect({}, {
        diagnoseHonorHdb: async () => ({ ...enumerated(), selection: { serial: 'TEST-HONOR', state } }),
        invokeHonorNative: async () => { nativeCalls++; throw new Error('Must not run'); },
      });
      expect(report).toMatchObject({ verdict: 'device_found_but_not_debuggable', exitCode: 3, error: { code: 'device_not_ready' } });
      expect(nativeCalls).toBe(0);
    }
  });

  it('preserves phone discovery when the native helper is missing and provides the actual build command', async () => {
    const missingPath = join(await directory(), 'missing.exe');
    const report = await runHonorConnect({}, {
      diagnoseHonorHdb: async () => enumerated(),
      invokeHonorNative: (options: unknown) => invokeHonorNative(options, { helperPath: missingPath }),
    });
    expect(report).toMatchObject({ verdict: 'device_found_but_not_debuggable', debugReady: false,
      capabilities: { deviceEnumeration: true }, error: { code: 'native_helper_missing', action: 'build_native_helper', buildCommand: 'scripts\\demo\\build-honor-hdb.cmd' } });
    expect(formatConnectSummary(report)).toContain('已发现手机');
    expect(formatConnectSummary(report)).toContain('build-honor-hdb.cmd');
  });

  it('drops failed native stdout and all non-stage stderr text', async () => {
    const native = await fakeNative('failure');
    const report = await runHonorConnect({}, {
      diagnoseHonorHdb: async () => enumerated(), invokeHonorNative: (options: unknown) => invokeHonorNative(options, native),
    });
    expect(report).toMatchObject({ verdict: 'device_found_but_not_debuggable', debugReady: false,
      native: { status: 'failed' }, error: { code: 'native_exit_nonzero', exitCode: 7, stages: ['vendor_auth_connect_start'] } });
    expect(JSON.stringify(report)).not.toContain('SECRET_STDOUT_AUTH_PAYLOAD');
    expect(JSON.stringify(report)).not.toContain('SECRET_STDERR_AUTH_PAYLOAD');
  });

  it('requires both a terminal complete stage and a successful normal authentication stage', async () => {
    for (const [scenario, code] of [['no_complete', 'native_completion_not_verified'], ['no_auth', 'native_auth_not_verified'], ['old_doctor', 'native_doctor_exit_not_verified'], ['doctor_failed', 'native_exit_nonzero']] as const) {
      const native = await fakeNative(scenario);
      await expect(invokeHonorNative({ operation: 'doctor', serial: 'TEST-HONOR', port: 12345 }, native)).rejects.toMatchObject({ code });
    }
  });

  it('enforces child-process timeout and output limits', async () => {
    const stalled = await fakeNative('timeout');
    await expect(invokeHonorNative({ operation: 'doctor', serial: 'TEST-HONOR', port: 12345, timeoutMs: 50 }, stalled)).rejects.toMatchObject({ code: 'native_timeout' });
    const oversized = await fakeNative('oversize');
    await expect(invokeHonorNative({ operation: 'doctor', serial: 'TEST-HONOR', port: 12345 }, oversized)).rejects.toMatchObject({ code: 'native_output_limit' });
  });

  it('rejects raw authentication protocol text as a model and never records it', async () => {
    const native = await fakeNative('invalid_model');
    const report = await runHonorConnect({}, {
      diagnoseHonorHdb: async () => enumerated(), invokeHonorNative: (options: unknown) => invokeHonorNative(options, native),
    });
    expect(report).toMatchObject({ verdict: 'device_found_but_not_debuggable', error: { code: 'invalid_model_response' }, debugReady: false });
    expect(JSON.stringify(report)).not.toContain('SECRET_AUTH_PAYLOAD');
  });

  it('passes service and push arguments without invoking a shell', async () => {
    const native = await fakeNative();
    const service = await invokeHonorNative({ operation: 'service', serial: 'TEST-HONOR', port: 12345, service: 'reverse:list-forward' }, native);
    expect(JSON.parse(service.stdout)).toEqual({ operation: '--service', serial: 'TEST-HONOR', port: '12345', args: ['reverse:list-forward'] });
    const localFile = join(await directory(), 'file with spaces.apk');
    const pushed = await invokeHonorNative({ operation: 'push', serial: 'TEST-HONOR', port: 12345, localFile, remoteFile: '/data/local/tmp/potbot.apk' }, native);
    expect(JSON.parse(pushed.stdout)).toEqual({ operation: '--push', serial: 'TEST-HONOR', port: '12345', args: [localFile, '/data/local/tmp/potbot.apk'] });
  });

  it('rejects malformed targets, unknown native operations and oversized deadlines before invocation', async () => {
    await expect(invokeHonorNative({ operation: 'doctor', serial: 'bad\nserial', port: 12345 })).rejects.toMatchObject({ code: 'invalid_serial' });
    await expect(invokeHonorNative({ operation: 'doctor', serial: 'TEST-HONOR', port: 0 })).rejects.toMatchObject({ code: 'invalid_port' });
    await expect(invokeHonorNative({ operation: 'kill', serial: 'TEST-HONOR', port: 12345 })).rejects.toMatchObject({ code: 'unsupported_native_operation' });
    await expect(invokeHonorNative({ operation: 'doctor', serial: 'TEST-HONOR', port: 12345, timeoutMs: 999999 })).rejects.toMatchObject({ code: 'invalid_timeout' });
  });

  it('does not dispatch unimplemented user commands', async () => {
    for (const command of ['unsupported', 'wipe']) {
      let calls = 0;
      const report = await runHonorConnect({ command }, {
        diagnoseHonorHdb: async () => { calls++; return enumerated(); }, invokeHonorNative: async () => { calls++; },
      });
      expect(report).toMatchObject({ verdict: 'error', error: { code: 'unsupported_command', supportedCommands: ['doctor', 'install', 'start', 'status', 'logs'] } });
      expect(calls).toBe(0);
    }
  });

  it('writes a JSON readback identical to the report and rejects directories outside the project', async () => {
    const dir = await directory(join(PROJECT_ROOT, '.runtime'));
    const report = await runHonorConnect({ command: 'unsupported' });
    const saved = await writeConnectEvidence(report, dir);
    expect(JSON.parse(await readFile(saved.evidence.path, 'utf8'))).toEqual(saved);
    await expect(writeConnectEvidence(report, '..')).rejects.toMatchObject({ code: 'evidence_outside_project' });
  });

  it('CLI produces machine-readable failure evidence without touching discovery for unsupported commands', async () => {
    const dir = await directory(join(PROJECT_ROOT, '.runtime'));
    const result = await execute(process.execPath, [scriptPath, 'unsupported', '--json', '--serial', 'TEST-HONOR', '--port12345', '--apk', 'unused.apk', '--evidence', dir], { windowsHide: true }).then(
      (value) => ({ ...value, code: 0 }), (cause: { code: number; stdout: string; stderr: string }) => cause,
    );
    expect(result.code).toBe(4);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ verdict: 'error', enumeration: null, native: { status: 'not_attempted' }, evidence: { status: 'written' } });
    expect(JSON.parse(await readFile(report.evidence.path, 'utf8'))).toEqual(report);
  });
});
