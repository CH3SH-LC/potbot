#!/usr/bin/env node
/** Read-only HONOR HDB diagnosis. Never launches a server or performs authentication. */
import net from 'node:net';
import { execFile } from 'node:child_process';
import { access, mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const EXPECTED_BINARY = 'C:\\Program Files (x86)\\HonorSuite\\hwtools\\hdbtransport.exe';
export const EXIT_CODES = Object.freeze({ ready: 0, enumerated_only: 0, no_device: 2,
  device_found_but_not_debuggable: 3, error: 4, ambiguous_device: 5 });

class ProtocolError extends Error {
  constructor(code, details = {}) { super(code); this.code = code; this.details = details; }
}
const fail = (code, details) => new ProtocolError(code, details);
const safeError = (error) => ({ code: error instanceof ProtocolError ? error.code : 'local_error',
  ...(error instanceof ProtocolError ? error.details : {}) });

function validateOptions(options) {
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)) {
    throw fail('invalid_port');
  }
  if (options.host !== undefined && !['127.0.0.1', '::1'].includes(options.host)) throw fail('non_loopback_host');
  if (options.serial !== undefined && (typeof options.serial !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(options.serial))) {
    throw fail('invalid_serial');
  }
  for (const key of ['connectTimeoutMs', 'dataTimeoutMs', 'totalTimeoutMs', 'maxBytes']) {
    if (options[key] !== undefined && (!Number.isInteger(options[key]) || options[key] < 1)) throw fail('invalid_limit');
  }
}

/** Only inspect existing hdbtransport processes and their TCP listeners. */
export async function discoverHonorService() {
  let binaryPresent = false;
  try { await access(EXPECTED_BINARY); binaryPresent = true; } catch { /* unknown/missing is evidence */ }
  const result = { status: 'unknown', expectedBinary: EXPECTED_BINARY, binaryPresent, processes: [], listeners: [] };
  if (process.platform !== 'win32') return { ...result, reason: 'windows_discovery_unavailable' };
  const script = String.raw`[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); $ErrorActionPreference = 'Stop'; $items = @(Get-Process -Name hdbtransport -ErrorAction SilentlyContinue | ForEach-Object { $p = $null; try { $p = $_.Path } catch {}; [PSCustomObject]@{ pid = $_.Id; resolvedProcessPath = $p } }); ConvertTo-Json -InputObject $items -Compress`;
  try {
    const reads = await Promise.allSettled([
      runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 }),
      runFile('netstat.exe', ['-ano', '-p', 'TCP'], { windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }),
    ]);
    if (reads.some((item) => item.status !== 'fulfilled')) return { ...result, reason: 'process_or_listener_read_failed' };
    const rows = JSON.parse(reads[0].value.stdout.trim().replace(/^\uFEFF/, '') || '[]');
    if (!Array.isArray(rows)) return { ...result, reason: 'unexpected_process_list' };
    result.processes = rows.filter((row) => Number.isInteger(row.pid)).map((row) => ({
      pid: row.pid, resolvedProcessPath: typeof row.resolvedProcessPath === 'string' && row.resolvedProcessPath ? row.resolvedProcessPath : null,
      pathStatus: row.resolvedProcessPath ? 'resolved' : 'unknown',
    }));
    const pids = new Set(result.processes.map((row) => row.pid));
    for (const line of reads[1].value.stdout.split(/\r?\n/)) {
      const fields = line.trim().split(/\s+/);
      if (fields[0] !== 'TCP' || fields[3] !== 'LISTENING' || !pids.has(Number(fields[4]))) continue;
      const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(fields[1]);
      if (!match) continue;
      const address = match[1] || match[2];
      if (!['127.0.0.1', '0.0.0.0', '::1', '::'].includes(address)) continue;
      result.listeners.push({ pid: Number(fields[4]), address, port: Number(match[3]), host: address.includes(':') ? '::1' : '127.0.0.1' });
    }
    return { ...result, status: 'inspected' };
  } catch { return { ...result, reason: 'discovery_failed' }; }
}

function openReader(socket, { dataTimeoutMs, maxBytes }) {
  let buffer = Buffer.alloc(0), ended = false, error = null, waiter;
  let receivedBytes = 0;
  const wake = () => { if (waiter) { const pending = waiter; waiter = undefined; pending(); } };
  socket.on('data', (data) => {
    receivedBytes += data.length;
    if (receivedBytes > maxBytes) { error = fail('response_too_large', { receivedBytes, maxBytes }); socket.destroy(); }
    else buffer = Buffer.concat([buffer, data]);
    wake();
  });
  socket.on('end', () => { ended = true; wake(); });
  socket.on('close', () => { ended = true; wake(); });
  socket.on('error', (cause) => { error = fail('socket_error', { systemCode: /^[A-Z0-9_]+$/.test(cause.code || '') ? cause.code : 'UNKNOWN' }); wake(); });
  const wait = async () => {
    await new Promise((resolveWait, reject) => {
      const timer = setTimeout(() => { waiter = undefined; reject(fail('data_timeout')); }, dataTimeoutMs);
      waiter = () => { clearTimeout(timer); resolveWait(); };
    });
  };
  return {
    get receivedBytes() { return receivedBytes; },
    abort(cause) { error = cause; wake(); },
    async take(size) {
      while (buffer.length < size) {
        if (error) throw error;
        if (ended) throw fail('truncated_response', { expectedBytes: size, availableBytes: buffer.length });
        await wait();
      }
      if (error) throw error;
      const data = buffer.subarray(0, size); buffer = buffer.subarray(size); return data;
    },
    async all() {
      while (!ended) { if (error) throw error; await wait(); }
      if (error) throw error;
      const data = buffer; buffer = Buffer.alloc(0); return data;
    },
  };
}

async function readStatus(reader) {
  const status = (await reader.take(4)).toString('ascii');
  if (status === 'OKAY') return;
  if (status === 'FAIL') {
    const length = await readLength(reader);
    const data = await reader.take(length);
    const known = { closed: 'closed', unauthorized: 'unauthorized', 'device offline': 'offline', 'device not found': 'not_found' };
    throw fail('server_fail', { payloadBytes: length, category: known[data.toString('utf8').trim()] || 'unspecified' });
  }
  if (status === 'HDB ') {
    const kinds = ['AUTHENTICEXABORT', 'AUTHENTICEXRES', 'AUTHENTICEX', 'AUTHENTIC'];
    let token = '';
    while (token.length < 32) {
      try { token += (await reader.take(1)).toString('ascii'); } catch { break; }
      if (kinds.includes(token) && !kinds.some((kind) => kind !== token && kind.startsWith(token))) break;
      if (!kinds.some((kind) => kind.startsWith(token))) break;
    }
    const kind = kinds.find((candidate) => token.startsWith(candidate));
    throw fail('hdb_auth_required_or_unsupported', {
      protocolType: kind ? `HDB ${kind}` : 'HDB unknown', receivedBytes: reader.receivedBytes,
    });
  }
  throw fail('unknown_status', { statusBytes: 4, receivedBytes: reader.receivedBytes });
}

async function readLength(reader) {
  const text = (await reader.take(4)).toString('ascii');
  if (!/^[0-9a-fA-F]{4}$/.test(text)) throw fail('invalid_length', { lengthFieldBytes: 4 });
  return Number.parseInt(text, 16);
}

function frame(service) {
  const bytes = Buffer.from(service, 'utf8');
  if (bytes.length > 65535) throw fail('request_too_large');
  return Buffer.concat([Buffer.from(bytes.length.toString(16).padStart(4, '0')), bytes]);
}

/** A bounded smart-socket exchange. Authentication data is never returned or logged. */
export async function smartSocketRequest(options) {
  validateOptions(options);
  const { host = '127.0.0.1', port, request, serial, response = 'length',
    connectTimeoutMs = 2000, dataTimeoutMs = 2000, totalTimeoutMs = 6000, maxBytes = 65536 } = options;
  if (port === undefined || typeof request !== 'string' || !['length', 'stream'].includes(response)) throw fail('invalid_request');
  if (!['host:version', 'host:devices-l', 'shell:getprop ro.product.model'].includes(request)) throw fail('unsupported_read_only_request');
  if (request.startsWith('shell:') ? (serial === undefined || response !== 'stream') : (serial !== undefined || response !== 'length')) throw fail('invalid_request_mode');
  const socket = new net.Socket();
  const reader = openReader(socket, { dataTimeoutMs, maxBytes });
  let rejectConnect;
  const totalTimer = setTimeout(() => { const error = fail('total_timeout'); reader.abort(error); rejectConnect?.(error); socket.destroy(); }, totalTimeoutMs);
  let connectTimer;
  try {
    await new Promise((connected, reject) => {
      rejectConnect = reject;
      connectTimer = setTimeout(() => { reject(fail('connect_timeout')); socket.destroy(); }, connectTimeoutMs);
      socket.once('error', (cause) => reject(fail('connect_error', { systemCode: /^[A-Z0-9_]+$/.test(cause.code || '') ? cause.code : 'UNKNOWN' })));
      socket.connect(port, host, connected);
    });
    rejectConnect = undefined;
    clearTimeout(connectTimer);
    if (serial !== undefined) {
      socket.write(frame(`host:transport:${serial}`));
      await readStatus(reader);
    }
    socket.write(frame(request));
    await readStatus(reader);
    const data = response === 'length' ? await reader.take(await readLength(reader)) : await reader.all();
    // HDB extensions can also appear after OKAY. Never pass their authentication payload onward.
    if (data.subarray(0, 4).toString('ascii') === 'HDB ') {
      const prefix = data.subarray(4, 36).toString('ascii');
      const kind = ['AUTHENTICEXABORT', 'AUTHENTICEXRES', 'AUTHENTICEX', 'AUTHENTIC'].find((value) => prefix.startsWith(value));
      throw fail('hdb_auth_required_or_unsupported', { protocolType: kind ? `HDB ${kind}` : 'HDB unknown', receivedBytes: reader.receivedBytes });
    }
    return { data: data.toString('utf8'), payloadBytes: data.length, receivedBytes: reader.receivedBytes };
  } finally { clearTimeout(connectTimer); clearTimeout(totalTimer); socket.destroy(); }
}

function parseDevices(text) {
  const devices = [];
  for (const line of text.split(/\r?\n/).filter((value) => value.trim())) {
    const match = /^(\S+)\s+(device|offline|unauthorized|recovery|sideload|bootloader|no permissions)(?:\s|$)/.exec(line);
    if (!match || !/^[\x21-\x7e]{1,256}$/.test(match[1])) throw fail('invalid_device_list');
    // Deliberately exclude arbitrary trailing fields from the server.
    devices.push({ serial: match[1], state: match[2] });
  }
  if (new Set(devices.map((device) => device.serial)).size !== devices.length) throw fail('duplicate_device_serial');
  return devices;
}

/** Distinguish the server socket from forward listeners owned by that same process. */
export async function probeDiscoveredHonorServices(discovery, options = {}) {
  validateOptions(options);
  const pids = new Set((discovery.processes || []).map((item) => item.pid).filter((pid) => Number.isInteger(pid) && pid > 0));
  const groups = new Map();
  for (const listener of discovery.listeners || []) {
    if (!pids.has(listener.pid) || !Number.isInteger(listener.port) || listener.port < 1 || listener.port > 65535) continue;
    if (!['127.0.0.1', '0.0.0.0', '::1', '::'].includes(listener.address)) continue;
    const host = listener.address.includes(':') ? '::1' : '127.0.0.1';
    const key = `${listener.pid}:${listener.port}`;
    if (!groups.has(key)) groups.set(key, { pid: listener.pid, port: listener.port, hosts: new Set() });
    groups.get(key).hosts.add(host);
  }
  const candidates = [...groups.values()];
  // A fixed ceiling prevents a large listener set from becoming an open-ended port scan.
  if (candidates.length > 16) return { status: 'failed', probes: [], selected: null, error: { code: 'too_many_service_candidates', candidateCount: candidates.length, maximumCandidates: 16 } };
  if (candidates.length === 0) return { status: 'failed', probes: [], selected: null, error: { code: 'hdb_service_not_discovered' } };
  const settled = await Promise.allSettled(candidates.map(async (candidate) => {
    const probes = [];
    // IPv4/IPv6 listeners owned by the same PID and port represent one candidate;
    // use the other loopback family only if the first does not answer correctly.
    const hosts = [...candidate.hosts].sort((a, b) => a === '127.0.0.1' ? -1 : b === '127.0.0.1' ? 1 : 0);
    for (const host of hosts) {
      const endpoint = { pid: candidate.pid, host, port: candidate.port };
      try {
        const version = await smartSocketRequest({ ...endpoint, request: 'host:version',
          connectTimeoutMs: Math.min(options.connectTimeoutMs ?? 1000, 1000),
          dataTimeoutMs: Math.min(options.dataTimeoutMs ?? 1000, 1000),
          totalTimeoutMs: Math.min(options.totalTimeoutMs ?? 1500, 1500), maxBytes: 1024 });
        if (!/^[0-9a-fA-F]{4}$/.test(version.data)) throw fail('invalid_server_version');
        const selected = { ...endpoint, versionHex: version.data.toLowerCase(), versionDecimal: Number.parseInt(version.data, 16) };
        probes.push({ ...selected, status: 'smart_socket_verified' });
        return { probes, selected };
      } catch (error) { probes.push({ ...endpoint, status: 'rejected', error: safeError(error) }); }
    }
    return { probes, selected: null };
  }));
  const probes = [], valid = [];
  for (const result of settled) {
    if (result.status === 'rejected') return { status: 'failed', probes, selected: null, error: safeError(result.reason) };
    probes.push(...result.value.probes);
    if (result.value.selected) valid.push(result.value.selected);
  }
  if (valid.length !== 1) return { status: 'failed', probes, selected: null,
    error: { code: valid.length ? 'ambiguous_service_port' : 'no_valid_smart_socket', validServiceCount: valid.length } };
  return { status: 'selected', probes, selected: valid[0] };
}

export async function diagnoseHonorHdb(options = {}, dependencies = {}) {
  const report = { schemaVersion: 1, checkedAt: new Date().toISOString(), readOnly: true,
    discovery: null, transport: { status: 'not_checked' }, devices: [], selection: null,
    probe: { status: 'not_attempted', service: 'shell:getprop ro.product.model' },
    debugReady: false, verdict: 'error', exitCode: EXIT_CODES.error };
  const finish = (verdict, error) => ({ ...report, verdict, exitCode: EXIT_CODES[verdict], ...(error ? { error: safeError(error) } : {}) });
  try {
    validateOptions(options);
    let port = options.port, host = options.host || '127.0.0.1';
    // Dependency injection supplies synthetic process/listener evidence in tests only;
    // the CLI always uses the real, read-only operating-system discovery above.
    report.discovery = port === undefined ? await (dependencies.discoverHonorService || discoverHonorService)() : { status: 'skipped', reason: 'explicit_port', expectedBinary: EXPECTED_BINARY };
    let verifiedVersion;
    if (port === undefined) {
      const serviceSelection = await probeDiscoveredHonorServices(report.discovery, options);
      report.discovery = { ...report.discovery, serviceSelection };
      if (!serviceSelection.selected) return finish('error', fail(serviceSelection.error.code, serviceSelection.error));
      ({ port, host } = serviceSelection.selected);
      verifiedVersion = serviceSelection.selected.versionHex;
    }
    report.transport = { status: 'connecting', host, port };
    const requestOptions = { ...options, host, port };
    const version = verifiedVersion || (await smartSocketRequest({ ...requestOptions, serial: undefined, request: 'host:version' })).data;
    if (!/^[0-9a-fA-F]{4}$/.test(version)) throw fail('invalid_server_version');
    report.transport = { ...report.transport, status: 'reachable', versionHex: version.toLowerCase(), versionDecimal: Number.parseInt(version, 16) };
    const list = await smartSocketRequest({ ...requestOptions, serial: undefined, request: 'host:devices-l' });
    report.devices = parseDevices(list.data);
    if (report.devices.length === 0) return finish('no_device');
    if (options.serial) {
      report.selection = report.devices.find((device) => device.serial === options.serial) || null;
      if (!report.selection) return finish('error', fail('requested_device_not_found'));
    } else {
      if (report.devices.length !== 1) return finish('ambiguous_device', fail('explicit_serial_required'));
      report.selection = report.devices[0];
    }
    if (options.noProbe) { report.probe.status = 'skipped'; return finish('enumerated_only'); }
    if (report.selection.state !== 'device') return finish('device_found_but_not_debuggable', fail('device_not_ready', { deviceState: report.selection.state }));
    try {
      const model = await smartSocketRequest({ ...requestOptions, serial: report.selection.serial, request: report.probe.service, response: 'stream', maxBytes: 4096 });
      const value = model.data.trim();
      if (!value || value.length > 200 || /[\x00-\x1f\x7f\ufffd]/.test(value)) throw fail('invalid_model_response', { payloadBytes: model.payloadBytes });
      report.probe = { ...report.probe, status: 'succeeded', model: value, payloadBytes: model.payloadBytes };
      report.debugReady = true;
      return finish('ready');
    } catch (error) {
      report.probe = { ...report.probe, status: 'failed', error: safeError(error) };
      return finish('device_found_but_not_debuggable');
    }
  } catch (error) { return finish('error', error); }
}

export function formatSummary(report) {
  const messages = { ready: '已验证指定设备的只读 shell；安装、转发和应用调试仍需分别验证。',
    enumerated_only: '仅完成设备枚举，未验证调试能力。', no_device: '荣耀服务可访问，但未列出设备。',
    device_found_but_not_debuggable: '已发现设备，但只读调试探测未通过。',
    ambiguous_device: '发现多个设备，请通过 --serial 明确目标。', error: '连接诊断失败，未确认调试能力。' };
  const error = report.probe?.error || report.error;
  return `${messages[report.verdict]}${error ? ` 原因：${error.code}${error.protocolType ? ` (${error.protocolType})` : ''}。` : ''}`;
}

function parseArgs(args) {
  const options = {}; let command = 'doctor';
  if (args[0] && !args[0].startsWith('--')) command = args.shift();
  if (!['status', 'doctor'].includes(command)) throw fail('unsupported_command');
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === '--json') options.json = true;
    else if (key === '--no-probe') options.noProbe = true;
    else if (['--port', '--serial', '--evidence'].includes(key)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw fail('missing_argument');
      options[key.slice(2)] = key === '--port' ? (/^\d+$/.test(value) ? Number(value) : NaN) : value;
    } else throw fail('unknown_argument');
  }
  validateOptions(options); return options;
}

function within(root, target) {
  const rel = relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel);
}

async function saveEvidence(directory, report) {
  const root = await realpath(PROJECT_ROOT), target = resolve(PROJECT_ROOT, directory);
  if (!within(PROJECT_ROOT, target)) throw fail('evidence_outside_project');
  // Check existing ancestors before mkdir, then the created directory to reject symlink escape.
  let ancestor = target;
  while (true) {
    try { const actual = await realpath(ancestor); if (actual !== root && !within(root, actual)) throw fail('evidence_outside_project'); break; }
    catch (error) { if (error instanceof ProtocolError || error.code !== 'ENOENT') throw error; ancestor = dirname(ancestor); }
  }
  await mkdir(target, { recursive: true });
  if (!within(root, await realpath(target))) throw fail('evidence_outside_project');
  const path = resolve(target, `honor-hdb-${Date.now()}-${process.pid}.json`);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  return path;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    const report = await diagnoseHonorHdb(options);
    if (options.evidence) report.evidencePath = await saveEvidence(options.evidence, report);
    if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else process.stdout.write(`${formatSummary(report)}\n${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.exitCode;
  } catch (error) {
    const report = { verdict: 'error', debugReady: false, exitCode: EXIT_CODES.error, error: safeError(error) };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); process.exitCode = EXIT_CODES.error;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
