/**
 * WCF-D34 文档编辑区测试夹具（**不是**被测实现的一部分）。
 *
 * 复用 WCF-D08 夹具的零件（`createClock` / `webSource` / `FakeElement`），在 `node:vm`
 * 里**原样执行线上那一份** `doc-read.js` / `edit-intent.js` / `app.js`，并提供：
 *   - 一个能按 id 找到**动态创建**元素的最小 DOM 桩（工具栏按钮是渲染出来的）；
 *   - 可驱动的 `window.getSelection()`（真实 app.js 走的就是这一条读数路径）；
 *   - 会话接口的 fetch 桩（`POST /api/sessions`、`GET /api/sessions/:id`、
 *     `POST /api/sessions/:id/edits`、`GET /api/sessions/:id/versions/:n/download`），
 *     并把每次请求记进 `fetches` 供断言（例如"一次复合只发一次 /edits"）。
 *
 * 纪律：本夹具只做「加载真实文件 + 提供宿主替身」，**不重写被测逻辑**。
 */

import { createHash } from 'node:crypto';
import { createContext, runInContext } from 'node:vm';

import { sectionScopeLabel } from '../../../src/documents/session/section-ops.js';

import { FakeElement, createClock, webSource } from './harness.js';
import type { Clock } from './harness.js';

/** 回执里用得到的范围形状（夹具只读 `kind`/`index`/`indices`）。 */
interface SectionScopeShape {
  readonly kind: 'all' | 'current' | 'indices';
  readonly index?: number;
  readonly indices?: readonly number[];
}

/** 文本节点桩：`nodeType === 3`，没有 `data-para`（让 app.js 走到父元素上取段落号）。 */
export class FakeTextNode extends FakeElement {
  readonly nodeType = 3;
  constructor(text: string) {
    super('#text');
    this.textContent = text;
  }
  override getAttribute(): null {
    return null;
  }
}

export interface FakeSelectionRange {
  readonly startContainer: FakeElement;
  readonly startOffset: number;
  readonly endContainer: FakeElement;
  readonly endOffset: number;
}

export interface RecordedFetch {
  readonly url: string;
  readonly method: string;
  readonly body: Record<string, unknown> | null;
}

export interface EditScriptEntry {
  readonly status: number;
  readonly body: unknown;
}

export interface EditorHarnessOptions {
  /** 导入时选中的文件字节（默认由调用方通过 importDocx 提供）。 */
  readonly docx?: Uint8Array;
  /** 各编辑版本对应的字节（缺省时统一返回当前字节）。 */
  readonly versionBytes?: Record<number, Uint8Array>;
  /** 依次消费的编辑回执；用完后重复最后一条（默认：一次成功）。 */
  readonly editScript?: readonly EditScriptEntry[];
  /** 校验能力（下载新版本时用）。 */
  readonly digestMode?: 'unavailable' | 'match' | 'mismatch';
}

export interface EditorHarness {
  readonly debug: {
    selectionText(): string;
    selectionExpression(): string;
    stagedSteps(): Array<{ range: string; operation: Record<string, unknown> }>;
    stagedSize(): number;
    undoneSize(): number;
    editStatusText(): string;
    editorErrorText(): string;
    versionDownloadStatusText(): string;
    session(): { sessionId: string; editRevision: number; contentDigest: string } | null;
    lastVerdict(): { kind: string; showsSuccess: boolean } | null;
    previewParagraphCount(): number;
    previewTableCount(): number;
    previewTexts(): string[];
    formatState(): Record<string, unknown> | null;
    /* --- 节 / 列表（WCF-D72） --- */
    sections(): Array<{
      index: number;
      number: number;
      pageSize: { widthTwips: number | null; heightTwips: number | null; orientation: string | null; orientationSource: string | null } | null;
      margins: Record<string, number | null> | null;
      pageNumbering: { format: string | null; start: number | null } | null;
    }>;
    sectionCount(): number;
    sectionScopeValue(): string;
    sectionScopeLabel(): string;
    stagedDomains(): string[];
    sectionStatusText(): string;
    listStatusText(): string;
    lastListAttempt(): { controlId: string; ok: boolean; code: string | null; showsSuccess: boolean; stagedSize: number; message: string } | null;
  };
  readonly clock: Clock;
  readonly fetches: RecordedFetch[];
  readonly observations: Array<{ artifactId: string; body: Record<string, unknown> }>;
  readonly nativeCalls: Array<{ method: string; args: unknown[] }>;
  readonly anchorClicks: string[];
  element(id: string): FakeElement;
  click(id: string): void;
  setValue(id: string, value: string): void;
  /** 把选区设成「第 paraIndex 段里 [start, end) 码位」并派发 selectionchange。 */
  selectParagraph(paraIndex: number, start?: number, end?: number, text?: string): void;
  /** 跨段选区（整段对齐时用来验证 `第N至M段`）。 */
  selectAcross(
    startPara: number,
    startOffset: number,
    endPara: number,
    endOffset: number,
    text: string,
  ): void;
  clearSelection(): void;
  importDocx(bytes: Uint8Array, filename?: string): Promise<void>;
  flush(times?: number): Promise<void>;
  paragraphText(paraIndex: number): string;
}

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function codePointLength(text: string): number {
  return Array.from(text).length;
}

export async function createEditorHarness(options: EditorHarnessOptions = {}): Promise<EditorHarness> {
  const clock = createClock();
  const elements = new Map<string, FakeElement>();
  const created: FakeElement[] = [];
  const fetches: RecordedFetch[] = [];
  const observations: Array<{ artifactId: string; body: Record<string, unknown> }> = [];
  const nativeCalls: Array<{ method: string; args: unknown[] }> = [];
  const anchorClicks: string[] = [];

  let currentBytes: Uint8Array = options.docx ?? new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
  let editRevision = 0;
  let contentDigest = createHash('sha256').update(Buffer.from(currentBytes)).digest('hex');
  let sessionId = '';
  let filename = 'document.docx';
  const versions: Array<Record<string, unknown>> = [];
  const editScript = options.editScript ?? [];
  let editCursor = 0;
  let lastEditBody: Record<string, unknown> | null = null;

  /* ---------------- DOM ---------------- */

  function register(element: FakeElement): FakeElement {
    created.push(element);
    if (element.id !== '') elements.set(element.id, element);
    return element;
  }

  function getElementById(id: string): FakeElement {
    const known = elements.get(id);
    if (known !== undefined) return known;
    for (const candidate of created) {
      if (candidate.id === id) {
        elements.set(id, candidate);
        return candidate;
      }
    }
    const fresh = new FakeElement('div');
    fresh.id = id;
    elements.set(id, fresh);
    created.push(fresh);
    return fresh;
  }

  const documentListeners = new Map<string, Array<() => void>>();

  function makeDocumentStub(): Record<string, unknown> {
    return {
      readyState: 'complete',
      hidden: false,
      body: register(new FakeElement('body')),
      getElementById,
      createElement(tag: string): FakeElement {
        const element = register(new FakeElement(tag));
        if (tag === 'a') {
          const originalClick = element.click.bind(element);
          element.click = (): void => {
            anchorClicks.push(element.download);
            originalClick();
          };
        }
        return element;
      },
      createTextNode(text: string): FakeElement {
        return register(new FakeTextNode(text));
      },
      addEventListener(type: string, fn: () => void): void {
        const list = documentListeners.get(type) ?? [];
        list.push(fn);
        documentListeners.set(type, list);
      },
      removeEventListener(): void {
        /* 夹具不注销监听器 */
      },
      dispatch(type: string): void {
        for (const fn of documentListeners.get(type) ?? []) fn();
      },
    };
  }

  const documentStub = makeDocumentStub();

  /* ---------------- 选区桩 ---------------- */

  let selectionRange: FakeSelectionRange | null = null;
  let selectionText = '';

  function getSelection(): Record<string, unknown> {
    if (selectionRange === null) {
      return { rangeCount: 0, isCollapsed: true, toString: () => '', getRangeAt: () => null };
    }
    const range = selectionRange;
    return {
      rangeCount: 1,
      isCollapsed: range.startContainer === range.endContainer && range.startOffset === range.endOffset,
      toString: () => selectionText,
      getRangeAt: () => range,
    };
  }

  function findParagraphElement(paraIndex: number): FakeElement | null {
    const root = getElementById('doc-preview');
    const stack: FakeElement[] = [root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node.getAttribute('data-para') === String(paraIndex)) return node;
      for (const child of node.children) stack.push(child);
    }
    return null;
  }

  function textNodeOf(paraIndex: number): FakeElement | null {
    const paragraph = findParagraphElement(paraIndex);
    if (paragraph === null) return null;
    for (const child of paragraph.children) {
      if (child instanceof FakeTextNode) return child;
    }
    return null;
  }

  /* ---------------- fetch 桩 ---------------- */

  function jsonResponse(ok: boolean, status: number, body: unknown): Record<string, unknown> {
    return {
      ok,
      status,
      text: async (): Promise<string> => JSON.stringify(body),
      arrayBuffer: async (): Promise<ArrayBuffer> => new ArrayBuffer(0),
    };
  }

  function bytesResponse(bytes: Uint8Array): Record<string, unknown> {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return {
      ok: true,
      status: 200,
      text: async (): Promise<string> => '',
      arrayBuffer: async (): Promise<ArrayBuffer> => copy.buffer,
    };
  }

  function versionEntry(rev: number): Record<string, unknown> {
    return {
      editRevision: rev,
      taskRevision: rev + 1,
      artifactVersion: rev + 1,
      artifactId: `art-v${String(rev)}`,
      contentDigest: createHash('sha256').update(Buffer.from(currentBytes)).digest('hex'),
      byteLength: currentBytes.byteLength,
      publishedAt: new Date(0).toISOString(),
    };
  }

  function bytesForRevision(rev: number): Uint8Array {
    const specific = options.versionBytes?.[rev];
    return specific ?? currentBytes;
  }

  function handleSessionEdit(body: Record<string, unknown>): Record<string, unknown> {
    const entry = editScript.length > 0
      ? (editScript[Math.min(editCursor, editScript.length - 1)] as EditScriptEntry)
      : { status: 200, body: null };
    editCursor += 1;
    lastEditBody = body;

    if (entry.status >= 200 && entry.status < 300) {
      editRevision += 1;
      contentDigest = createHash('sha256').update(Buffer.from(currentBytes)).digest('hex');
      const version = versionEntry(editRevision);
      versions.push(version);
      /* 回执的 `steps` 与服务端同一口径：段落步来自 `intent`，节步来自 `sectionIntent`。
         节步的 `range` 是**派生标签**（`全文`/`第2节`），用内核真实的 `sectionScopeLabel`
         算出来，避免夹具里再造一份会漂移的镜像。 */
      const intentSteps = (body['intent'] as { steps?: unknown } | undefined)?.steps;
      const sectionSteps = (body['sectionIntent'] as { steps?: unknown } | undefined)?.steps;
      const steps = Array.isArray(intentSteps)
        ? (intentSteps as Array<{ range: string }>).map((step) => ({
            range: step.range,
            domain: 'paragraph',
            hitCount: 1,
            changed: true,
          }))
        : Array.isArray(sectionSteps)
          ? (sectionSteps as Array<{ section: SectionScopeShape }>).map((step) => ({
              range: sectionScopeLabel(step.section as never),
              domain: 'section',
              hitCount: 1,
              changed: true,
            }))
          : [];
      const preset = (entry.body ?? {}) as Record<string, unknown>;
      return {
        sessionId,
        replayed: false,
        noOp: false,
        editRevision,
        steps,
        version,
        ...preset,
      };
    }
    const preset = (entry.body ?? {}) as Record<string, unknown>;
    if (Object.keys(preset).length > 0) return preset;
    return { code: 'stale_revision', message: '基线已过期。', currentRevision: editRevision, requestedRevision: body['baseRevision'] };
  }

  function currentVersion(): Record<string, unknown> | null {
    if (versions.length === 0) return null;
    return versions[versions.length - 1] ?? null;
  }

  const fetchStub = (input: unknown, init?: { method?: string; body?: string }): Promise<unknown> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    let parsedBody: Record<string, unknown> | null = null;
    if (typeof init?.body === 'string') {
      try {
        parsedBody = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        parsedBody = null;
      }
    }
    fetches.push({ url, method, body: parsedBody });

    if (url === '/health') {
      return Promise.resolve(jsonResponse(true, 200, {
        ready: true, modelConfigured: true, modelVerified: true, buildId: 'test-build', bootId: 'test-boot',
      }));
    }
    if (url === '/api/sessions' && method === 'POST') {
      sessionId = String(parsedBody?.['sessionId'] ?? 'sess-1');
      filename = String(parsedBody?.['filename'] ?? 'document.docx');
      const base64 = String(parsedBody?.['docxBase64'] ?? '');
      if (base64.length > 0) currentBytes = new Uint8Array(Buffer.from(base64, 'base64'));
      editRevision = 0;
      contentDigest = createHash('sha256').update(Buffer.from(currentBytes)).digest('hex');
      versions.length = 0;
      return Promise.resolve(jsonResponse(true, 201, {
        sessionId, documentId: 'doc-1', filename, kernelTaskId: 'task-1',
        editRevision: 0, contentDigest,
      }));
    }
    const editMatch = /^\/api\/sessions\/([^/]+)\/edits$/.exec(url);
    if (editMatch !== null && method === 'POST') {
      const response = handleSessionEdit(parsedBody ?? {});
      const status = (editScript.length > 0
        ? (editScript[Math.min(Math.max(editCursor - 1, 0), editScript.length - 1)] as EditScriptEntry).status
        : 200);
      return Promise.resolve(jsonResponse(status >= 200 && status < 300, status, response));
    }
    const versionMatch = /^\/api\/sessions\/([^/]+)\/versions\/(\d+)\/download$/.exec(url);
    if (versionMatch !== null) {
      const rev = Number.parseInt(versionMatch[2] ?? '0', 10);
      return Promise.resolve(bytesResponse(bytesForRevision(rev)));
    }
    const sessionMatch = /^\/api\/sessions\/([^/]+)$/.exec(url);
    if (sessionMatch !== null && method === 'GET') {
      return Promise.resolve(jsonResponse(true, 200, {
        sessionId, documentId: 'doc-1', filename, editRevision, contentDigest,
        sourceKind: 'imported', sourceDigest: null,
        versions, currentVersion: currentVersion(), lastFailure: null, log: [],
      }));
    }
    const observationMatch = /^\/api\/artifacts\/([^/]+)\/observations$/.exec(url);
    if (observationMatch !== null && method === 'POST') {
      observations.push({ artifactId: decodeURIComponent(observationMatch[1] ?? ''), body: parsedBody ?? {} });
      return Promise.resolve(jsonResponse(true, 200, { observationId: 'obs-1', recorded: true }));
    }
    if (url.startsWith('/api/artifacts/')) {
      return Promise.resolve(bytesResponse(currentBytes));
    }
    if (/^\/api\/tasks\//.test(url)) {
      return Promise.resolve(jsonResponse(false, 404, { message: '夹具：本用例不涉及生成任务' }));
    }
    return Promise.resolve(jsonResponse(false, 404, { message: '夹具未定义这个路径：' + url }));
  };

  /* ---------------- 沙箱 ---------------- */

  const storage = new Map<string, string>();
  const cryptoStub = options.digestMode === undefined || options.digestMode === 'unavailable'
    ? undefined
    : {
        subtle: {
          digest: async (_algorithm: string, data: ArrayBuffer): Promise<ArrayBuffer> => {
            const hash = createHash('sha256').update(Buffer.from(new Uint8Array(data))).digest();
            if (options.digestMode === 'mismatch') hash.fill(0);
            const copy = new Uint8Array(hash.byteLength);
            copy.set(hash);
            return copy.buffer;
          },
        },
      };

  class AbortControllerStub {
    readonly signal = {};
    abort(): void {
      /* 夹具不主动中止 */
    }
  }

  class BlobStub {
    readonly parts: unknown[];
    constructor(parts: unknown[]) {
      this.parts = parts;
    }
  }

  const sandbox: Record<string, unknown> = {
    console,
    document: documentStub,
    localStorage: {
      getItem: (key: string): string | null => storage.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        storage.set(key, value);
      },
    },
    fetch: fetchStub,
    AbortController: AbortControllerStub,
    Blob: BlobStub,
    URL: { createObjectURL: () => 'blob:stub', revokeObjectURL: () => undefined },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    getSelection,
    DecompressionStream,
    TextDecoder,
    TextEncoder,
    btoa,
    atob,
    PotbotNative: {
      saveDocx: (...args: unknown[]): void => {
        nativeCalls.push({ method: 'saveDocx', args });
      },
      saveCopy: (...args: unknown[]): void => {
        nativeCalls.push({ method: 'saveCopy', args });
      },
    },
  };
  if (cryptoStub !== undefined) sandbox['crypto'] = cryptoStub;
  sandbox['window'] = sandbox;

  const context = createContext(sandbox);
  runInContext(webSource('bridge-ops.js'), context, { filename: 'bridge-ops.js' });
  runInContext(webSource('download-verify.js'), context, { filename: 'download-verify.js' });
  runInContext(webSource('doc-read.js'), context, { filename: 'doc-read.js' });
  runInContext(webSource('edit-intent.js'), context, { filename: 'edit-intent.js' });
  runInContext(webSource('section-intent.js'), context, { filename: 'section-intent.js' });
  runInContext(webSource('list-intent.js'), context, { filename: 'list-intent.js' });
  runInContext(webSource('app.js'), context, { filename: 'app.js' });

  async function flush(times = 60): Promise<void> {
    for (let i = 0; i < times; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  const harness: EditorHarness = {
    debug: sandbox['PotbotWebDebug'] as EditorHarness['debug'],
    clock,
    fetches,
    observations,
    nativeCalls,
    anchorClicks,
    element: getElementById,
    click(id: string): void {
      getElementById(id).click();
    },
    setValue(id: string, value: string): void {
      getElementById(id).value = value;
    },
    selectParagraph(paraIndex: number, start = 0, end?: number, text?: string): void {
      const node = textNodeOf(paraIndex);
      if (node === null) throw new Error('夹具找不到第 ' + String(paraIndex) + ' 段的文本节点');
      const full = node.textContent;
      const length = codePointLength(full);
      const from = start;
      const to = end === undefined ? length : end;
      const selected = text ?? Array.from(full).slice(from, to).join('');
      selectionText = selected;
      selectionRange = {
        startContainer: node, startOffset: from,
        endContainer: node, endOffset: to,
      };
      (documentStub as { dispatch(type: string): void }).dispatch('selectionchange');
    },
    selectAcross(startPara, startOffset, endPara, endOffset, text): void {
      const startNode = textNodeOf(startPara);
      const endNode = textNodeOf(endPara);
      if (startNode === null || endNode === null) throw new Error('夹具找不到跨段选区的文本节点');
      selectionText = text;
      selectionRange = {
        startContainer: startNode, startOffset,
        endContainer: endNode, endOffset,
      };
      (documentStub as { dispatch(type: string): void }).dispatch('selectionchange');
    },
    clearSelection(): void {
      selectionRange = null;
      selectionText = '';
      (documentStub as { dispatch(type: string): void }).dispatch('selectionchange');
    },
    async importDocx(bytes: Uint8Array, name = 'document.docx'): Promise<void> {
      const input = getElementById('docx-file');
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      (input as unknown as { files: unknown[] }).files = [{
        name,
        arrayBuffer: async (): Promise<ArrayBuffer> => copy.buffer,
      }];
      getElementById('import-btn').click();
      await flush();
    },
    flush,
    paragraphText(paraIndex: number): string {
      const node = textNodeOf(paraIndex);
      return node === null ? '' : node.textContent;
    },
  };

  await flush();
  return harness;
}
