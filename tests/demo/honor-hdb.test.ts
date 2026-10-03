import net from 'node:net';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// Dynamic path avoids making a JS declaration file part of this read-only CLI change.
const scriptPath = resolve('scripts/demo/honor-hdb.mjs');
const modulePath = pathToFileURL(scriptPath).href;
const { diagnoseHonorHdb, smartSocketRequest, formatSummary, probeDiscoveredHonorServices } = await import(modulePath);
const execute = promisify(execFile);
const cleanup: Array<() => Promise<void>> = [];
const tick = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const packet = (body: string) => `OKAY${Buffer.byteLength(body).toString(16).padStart(4, '0')}${body}`;
type Handler = (service: string, socket: net.Socket) => void | Promise<void>;
const discoveryFor = (...ports: number[]) => ({ status: 'inspected',
  processes: [{ pid: 100001, resolvedProcessPath: null, pathStatus: 'unknown' }],
  listeners: ports.map((port) => ({ pid: 100001, address: '127.0.0.1', host: '127.0.0.1', port })),
});

async function fragmented(socket: net.Socket, data: string, width = 1, delay = 1) {
  const bytes = Buffer.from(data);
  for (let index = 0; index < bytes.length && !socket.destroyed; index += width) {
    socket.write(bytes.subarray(index, index + width));
    await tick(delay);
  }
}

async function fakeService(handler: Handler) {
  const requests: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let data = Buffer.alloc(0);
    let queued = Promise.resolve();
    socket.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
      while (data.length >= 4) {
        const size = Number.parseInt(data.subarray(0, 4).toString(), 16);
        if (!Number.isInteger(size) || data.length < size + 4) return;
        const service = data.subarray(4, size + 4).toString();
        data = data.subarray(size + 4);
        requests.push(service);
        queued = queued.then(() => handler(service, socket)).catch(() => { socket.destroy(); });
      }
    });
  });
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => server.close(() => done()));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected local TCP fixture');
  return { port: address.port, requests };
}

async function deviceService(options: { devices?: string; shell?: Handler; transport?: Handler; split?: boolean } = {}) {
  return fakeService(async (service, socket) => {
    const send = async (text: string) => options.split ? fragmented(socket, text) : void socket.write(text);
    if (service === 'host:version') await send(packet('0026'));
    else if (service === 'host:devices-l') await send(packet(options.devices ?? 'HONOR-TEST\tdevice product:test model:Magic7 transport_id:1\n'));
    else if (service.startsWith('host:transport:')) {
      if (options.transport) await options.transport(service, socket);
      else await send('OKAY');
    } else if (service === 'shell:getprop ro.product.model') {
      if (options.shell) await options.shell(service, socket);
      else { await send('OKAYMagic7\n'); socket.end(); }
    } else socket.end('FAIL0007unknown');
  });
}

afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

describe('HONOR HDB read-only diagnosis with local protocol fixtures only', () => {
  it('automatically selects the smart socket while excluding a same-process forward listener', async () => {
    const service = await deviceService();
    const forward = await fakeService((_service, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); });
    const report = await diagnoseHonorHdb({}, { discoverHonorService: async () => discoveryFor(service.port, forward.port) });
    expect(report).toMatchObject({ verdict: 'ready', debugReady: true, transport: { port: service.port, versionDecimal: 38 },
      discovery: { serviceSelection: { status: 'selected', selected: { port: service.port } } } });
    expect(report.discovery.serviceSelection.probes).toEqual(expect.arrayContaining([
      expect.objectContaining({ port: service.port, status: 'smart_socket_verified' }),
      expect.objectContaining({ port: forward.port, status: 'rejected', error: { code: 'unknown_status', statusBytes: 4, receivedBytes: 28 } }),
    ]));
    expect(service.requests).toEqual(['host:version', 'host:devices-l', 'host:transport:HONOR-TEST', 'shell:getprop ro.product.model']);
    expect(forward.requests).toEqual(['host:version']);
  });

  it('waits only for a bounded version probe when a forward port remains silent', async () => {
    const service = await deviceService();
    const forward = await fakeService(() => {});
    const report = await diagnoseHonorHdb({ dataTimeoutMs: 30, totalTimeoutMs: 100 }, {
      discoverHonorService: async () => discoveryFor(service.port, forward.port),
    });
    expect(report).toMatchObject({ verdict: 'ready', transport: { port: service.port } });
    expect(report.discovery.serviceSelection.probes).toEqual(expect.arrayContaining([
      expect.objectContaining({ port: forward.port, status: 'rejected', error: { code: 'data_timeout' } }),
    ]));
    expect(forward.requests).toEqual(['host:version']);
  });

  it('fails closed if multiple owned ports speak the smart-socket protocol', async () => {
    const one = await deviceService();
    const two = await deviceService();
    const report = await diagnoseHonorHdb({}, { discoverHonorService: async () => discoveryFor(one.port, two.port) });
    expect(report).toMatchObject({ verdict: 'error', debugReady: false, error: { code: 'ambiguous_service_port', validServiceCount: 2 }, devices: [] });
    expect(one.requests).toEqual(['host:version']);
    expect(two.requests).toEqual(['host:version']);
  });

  it('fails closed when none of the discovered ports returns a valid version', async () => {
    const wrongVersion = await fakeService((_service, socket) => { socket.end(packet('not-a-version')); });
    const silent = await fakeService(() => {});
    const report = await diagnoseHonorHdb({ dataTimeoutMs: 30 }, {
      discoverHonorService: async () => discoveryFor(wrongVersion.port, silent.port),
    });
    expect(report).toMatchObject({ verdict: 'error', debugReady: false, error: { code: 'no_valid_smart_socket', validServiceCount: 0 }, devices: [] });
    expect(wrongVersion.requests).toEqual(['host:version']);
    expect(silent.requests).toEqual(['host:version']);
    expect(JSON.stringify(report)).not.toContain('not-a-version');
  });

  it('never probes unowned listeners or non-loopback interfaces, and deduplicates address families', async () => {
    const service = await deviceService();
    const unrelated = await fakeService((_service, socket) => { socket.end(packet('0026')); });
    const discovery = discoveryFor(service.port);
    discovery.listeners.push(
      { pid: 100001, address: '0.0.0.0', host: '127.0.0.1', port: service.port },
      { pid: 100001, address: '::', host: '::1', port: service.port },
      { pid: 100002, address: '127.0.0.1', host: '127.0.0.1', port: unrelated.port },
      { pid: 100001, address: '192.0.2.1', host: '127.0.0.1', port: unrelated.port },
    );
    const selection = await probeDiscoveredHonorServices(discovery);
    expect(selection).toMatchObject({ status: 'selected', selected: { host: '127.0.0.1', port: service.port } });
    expect(service.requests).toEqual(['host:version']);
    expect(unrelated.requests).toEqual([]);
    expect(selection.probes).toHaveLength(1);
  });

  it('refuses an oversized candidate set without probing any port', async () => {
    const service = await deviceService();
    const otherPorts = Array.from({ length: 65535 }, (_, index) => index + 1).filter((port) => port !== service.port).slice(0, 16);
    const report = await diagnoseHonorHdb({}, { discoverHonorService: async () => discoveryFor(service.port, ...otherPorts) });
    expect(report).toMatchObject({ verdict: 'error', error: { code: 'too_many_service_candidates', candidateCount: 17, maximumCandidates: 16 } });
    expect(service.requests).toEqual([]);
  });

  it('parses fragmented framing and selects the exact device before read-only getprop', async () => {
    const service = await deviceService({ split: true });
    const report = await diagnoseHonorHdb({ port: service.port });
    expect(report).toMatchObject({ verdict: 'ready', debugReady: true, exitCode: 0,
      discovery: { status: 'skipped', reason: 'explicit_port' },
      transport: { versionHex: '0026', versionDecimal: 38 },
      selection: { serial: 'HONOR-TEST', state: 'device' },
      probe: { status: 'succeeded', model: 'Magic7' } });
    expect(service.requests).toEqual(['host:version', 'host:devices-l', 'host:transport:HONOR-TEST', 'shell:getprop ro.product.model']);
    expect(formatSummary(report)).toContain('仍需分别验证');
  });

  it('labels successful enumeration without claiming debug readiness', async () => {
    const service = await deviceService();
    const report = await diagnoseHonorHdb({ port: service.port, noProbe: true });
    expect(report).toMatchObject({ verdict: 'enumerated_only', debugReady: false, exitCode: 0, probe: { status: 'skipped' } });
    expect(service.requests).toEqual(['host:version', 'host:devices-l']);
  });

  it('returns a separate no-device exit code for a zero-length list', async () => {
    const service = await deviceService({ devices: '' });
    expect(await diagnoseHonorHdb({ port: service.port })).toMatchObject({ verdict: 'no_device', exitCode: 2, debugReady: false, devices: [] });
  });

  it('refuses multiple devices without selecting even a unique online device', async () => {
    const service = await deviceService({ devices: 'ONE\tdevice\nTWO\toffline\n' });
    expect(await diagnoseHonorHdb({ port: service.port })).toMatchObject({ verdict: 'ambiguous_device', exitCode: 5, debugReady: false });
    expect(service.requests).toEqual(['host:version', 'host:devices-l']);
  });

  it('uses only the explicitly selected serial among multiple devices', async () => {
    const service = await deviceService({ devices: 'ONE\tdevice\nTWO\tdevice\n' });
    expect(await diagnoseHonorHdb({ port: service.port, serial: 'TWO' })).toMatchObject({ verdict: 'ready', selection: { serial: 'TWO' } });
    expect(service.requests).toContain('host:transport:TWO');
    expect(service.requests).not.toContain('host:transport:ONE');
  });

  it('does not probe an absent requested serial or an unauthorized device', async () => {
    const service = await deviceService({ devices: 'ONE\tunauthorized\n' });
    expect(await diagnoseHonorHdb({ port: service.port, serial: 'MISSING' })).toMatchObject({ verdict: 'error', error: { code: 'requested_device_not_found' } });
    expect(await diagnoseHonorHdb({ port: service.port, serial: 'ONE' })).toMatchObject({ verdict: 'device_found_but_not_debuggable', exitCode: 3, error: { code: 'device_not_ready' } });
    expect(service.requests.some((value) => value.startsWith('host:transport:'))).toBe(false);
  });

  it('recognizes the fragmented HONOR ABORT then FAIL response without leaking payload', async () => {
    const service = await deviceService({ shell: async (_service, socket) => {
      await fragmented(socket, 'HDB AUTHENTICEXABORT\0FAIL0006closed'); socket.end();
    } });
    const report = await diagnoseHonorHdb({ port: service.port });
    expect(report).toMatchObject({ verdict: 'device_found_but_not_debuggable', exitCode: 3, debugReady: false,
      probe: { status: 'failed', error: { code: 'hdb_auth_required_or_unsupported', protocolType: 'HDB AUTHENTICEXABORT' } } });
    expect(report.probe.error.receivedBytes).toBeGreaterThanOrEqual(19);
    expect(JSON.stringify(report)).not.toContain('FAIL0006closed');
  });

  it('recognizes RES and discards all authentication content', async () => {
    const secret = 'NEVER_PERSIST_AUTH_TOKEN';
    const service = await deviceService({ shell: (_service, socket) => { socket.end(`HDB AUTHENTICEXRES\0${secret}`); } });
    const report = await diagnoseHonorHdb({ port: service.port });
    expect(report.probe.error).toMatchObject({ code: 'hdb_auth_required_or_unsupported', protocolType: 'HDB AUTHENTICEXRES' });
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(formatSummary(report)).not.toContain(secret);
  });

  it('redacts unknown HDB extensions and refuses them', async () => {
    const service = await deviceService({ shell: (_service, socket) => { socket.end('HDB SECRET_TOKEN=abc123'); } });
    const report = await diagnoseHonorHdb({ port: service.port });
    expect(report.probe.error).toMatchObject({ code: 'hdb_auth_required_or_unsupported', protocolType: 'HDB unknown' });
    expect(JSON.stringify(report)).not.toContain('SECRET_TOKEN');
  });

  it('does not expose HDB authentication content after an OKAY prefix either', async () => {
    const service = await deviceService({ shell: (_service, socket) => { socket.end('OKAYHDB AUTHENTICEXRES\0SECRET_TOKEN'); } });
    const report = await diagnoseHonorHdb({ port: service.port });
    expect(report.probe.error).toMatchObject({ code: 'hdb_auth_required_or_unsupported' });
    expect(JSON.stringify(report)).not.toContain('SECRET_TOKEN');
  });

  it('does not issue shell after transport selection fails or leak FAIL text', async () => {
    const secret = 'unknown-private-response';
    const service = await deviceService({ transport: (_service, socket) => { socket.end(`FAIL${secret.length.toString(16).padStart(4, '0')}${secret}`); } });
    const report = await diagnoseHonorHdb({ port: service.port });
    expect(report.probe.error).toMatchObject({ code: 'server_fail', category: 'unspecified', payloadBytes: secret.length });
    expect(service.requests).not.toContain('shell:getprop ro.product.model');
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it('fails closed on an unknown status, invalid length, or truncated frame', async () => {
    for (const [reply, code] of [['TOKEN_WITH_SECRET', 'unknown_status'], ['OKAYZZZZ', 'invalid_length'], ['OKAY0004ab', 'truncated_response']] as const) {
      const service = await fakeService((_service, socket) => { socket.end(reply); });
      const report = await diagnoseHonorHdb({ port: service.port });
      expect(report).toMatchObject({ verdict: 'error', debugReady: false, exitCode: 4, error: { code } });
      expect(JSON.stringify(report)).not.toContain('TOKEN_WITH_SECRET');
    }
  });

  it('rejects malformed or duplicate device entries and invalid versions', async () => {
    for (const devices of ['ONE\tunknown\n', 'ONE\tdevice\nONE\tdevice\n']) {
      const service = await deviceService({ devices });
      expect(await diagnoseHonorHdb({ port: service.port })).toMatchObject({ verdict: 'error', debugReady: false });
    }
    const badVersion = await fakeService((_service, socket) => { socket.end(packet('no-version')); });
    expect(await diagnoseHonorHdb({ port: badVersion.port })).toMatchObject({ error: { code: 'invalid_server_version' } });
  });

  it('treats empty shell output as unverified instead of ready', async () => {
    const service = await deviceService({ shell: (_service, socket) => { socket.end('OKAY'); } });
    expect(await diagnoseHonorHdb({ port: service.port })).toMatchObject({ verdict: 'device_found_but_not_debuggable', debugReady: false, probe: { error: { code: 'invalid_model_response' } } });
  });

  it('bounds response size and idle time without hanging', async () => {
    const large = await deviceService({ shell: (_service, socket) => { socket.end(`OKAY${'X'.repeat(5000)}`); } });
    expect(await diagnoseHonorHdb({ port: large.port })).toMatchObject({ probe: { error: { code: 'response_too_large' } } });
    const silent = await fakeService(() => {});
    expect(await diagnoseHonorHdb({ port: silent.port, dataTimeoutMs: 30 })).toMatchObject({ error: { code: 'data_timeout' } });
  });

  it('uses a total deadline even when response bytes keep arriving', async () => {
    const service = await fakeService(async (_service, socket) => { await fragmented(socket, packet('0026'), 1, 20); });
    await expect(smartSocketRequest({ port: service.port, request: 'host:version', dataTimeoutMs: 100, totalTimeoutMs: 45 })).rejects.toMatchObject({ code: 'total_timeout' });
  });

  it('reports a refused local connection and rejects non-local destinations', async () => {
    const reserved = net.createServer();
    await new Promise<void>((done) => reserved.listen(0, '127.0.0.1', done));
    const address = reserved.address();
    if (!address || typeof address === 'string') throw new Error('Expected port');
    await new Promise<void>((done) => reserved.close(() => done()));
    expect(await diagnoseHonorHdb({ port: address.port })).toMatchObject({ verdict: 'error', error: { code: 'connect_error' } });
    expect(await diagnoseHonorHdb({ host: '192.0.2.1', port: 5037 })).toMatchObject({ error: { code: 'non_loopback_host' } });
    expect(await diagnoseHonorHdb({ port: -1 })).toMatchObject({ error: { code: 'invalid_port' } });
  });

  it('rejects commands outside the fixed read-only capability list before connecting', async () => {
    await expect(smartSocketRequest({ port: 5037, request: 'host:kill' })).rejects.toMatchObject({ code: 'unsupported_read_only_request' });
    await expect(smartSocketRequest({ port: 5037, request: 'shell:getprop ro.product.model' })).rejects.toMatchObject({ code: 'invalid_request_mode' });
  });

  it('CLI emits parseable layered JSON and propagates blocked exit status', async () => {
    const service = await deviceService({ shell: (_service, socket) => { socket.end('HDB AUTHENTICEXABORT\0FAIL0006closed'); } });
    const result = await execute(process.execPath, [scriptPath, 'doctor', '--json', '--port', String(service.port)], { windowsHide: true }).then(
      (value) => ({ ...value, code: 0 }),
      (error: { code: number; stdout: string; stderr: string }) => error,
    );
    expect(result.code).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({ verdict: 'device_found_but_not_debuggable', debugReady: false, transport: { versionDecimal: 38 } });
    expect(result.stderr).toBe('');
  });

  it('CLI status --no-probe never executes a device command', async () => {
    const service = await deviceService();
    const result = await execute(process.execPath, [scriptPath, 'status', '--json', '--no-probe', '--port', String(service.port)], { windowsHide: true });
    expect(JSON.parse(result.stdout)).toMatchObject({ verdict: 'enumerated_only', debugReady: false });
    expect(service.requests).toEqual(['host:version', 'host:devices-l']);
  });

  it('CLI refuses an evidence directory outside the project', async () => {
    const service = await deviceService();
    const result = await execute(process.execPath, [scriptPath, 'status', '--json', '--no-probe', '--port', String(service.port), '--evidence', '..'], { windowsHide: true }).then(
      (value) => ({ ...value, code: 0 }),
      (error: { code: number; stdout: string; stderr: string }) => error,
    );
    expect(result.code).toBe(4);
    expect(JSON.parse(result.stdout)).toMatchObject({ verdict: 'error', error: { code: 'evidence_outside_project' } });
  });
});
