// GENERATED FILE — do not edit by hand.
// Bundled by scripts/mobile/bundle-kernel.mjs from apps/mobile-kernel/bootstrap/index.ts
// Modules: 8; named exports: 19; external runtime deps: none.
// Single-file ESM for in-APK loading (K01). Each source module keeps its own scope.
const __kernelModules = new Map();
const __kernelCache = new Map();
function __kernelNormalize(fromDir, spec) {
  const parts = (fromDir + '/' + spec).split('/');
  const out = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') { out.pop(); continue; }
    out.push(part);
  }
  return out.join('/');
}
function __kernelRequire(id) {
  const cached = __kernelCache.get(id);
  if (cached !== undefined) return cached.exports;
  const record = __kernelModules.get(id);
  if (record === undefined) throw new Error('[kernel-bundle] missing module: ' + id);
  const module = { exports: {} };
  __kernelCache.set(id, module);
  const localRequire = (spec) => __kernelRequire(__kernelNormalize(record.dir, spec));
  record.factory(module, module.exports, localRequire);
  return module.exports;
}
function __kernelDefine(id, dir, factory) { __kernelModules.set(id, { dir, factory }); }

__kernelDefine("apps/mobile-kernel/bootstrap/errors.js", "apps/mobile-kernel/bootstrap", function (module, exports, require) {
"use strict";
/**
 * K01 —— 手机内核引导层错误。
 *
 * 分层口径（本包最重要的约定，测试据此断言）：
 *
 * - **边界错误（throw）**：调用方 / 本地 origin 不合法、命令形状不合法、载荷夹带
 *   密钥/绝对路径/代码执行字段、运行时未启动。这些发生在**信任边界之外**，命令本身
 *   可能不完整（连 commandId 都没有），无法安全地包装成契约 `event`（event 要求
 *   `eventId/seq/commandId/revision/status` 齐备）。所以**抛出**结构化错误，由宿主
 *   （Android Service / WebView）决定如何拒绝。
 * - **执行结果（返回 event）**：命令合法但执行层给不出结果（缺执行器、处理器抛错、
 *   revision 冲突、被取消）。这些**一定**返回契约 `event`，状态取自词表
 *   `pending/running/succeeded/failed/conflict/cancelled`，绝不伪造成 succeeded。
 *
 * 零依赖纯 TS，不 import node 内建；可被 QuickJS / V8 / Node 任一旁加载。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BootstrapError = exports.BOOTSTRAP_ERROR_CODES = void 0;
exports.isBootstrapError = isBootstrapError;
exports.bootstrapError = bootstrapError;
exports.BOOTSTRAP_ERROR_CODES = [
    'ORIGIN_REJECTED',
    'CALLER_INVALID',
    'COMMAND_INVALID',
    'PAYLOAD_FORBIDDEN',
    'RUNTIME_NOT_RUNNING',
    'RUNTIME_ALREADY_RUNNING',
    'MODULE_CONFLICT',
];
class BootstrapError extends Error {
    code;
    issues;
    constructor(code, message, issues = []) {
        super(message);
        this.name = 'BootstrapError';
        this.code = code;
        this.issues = issues;
    }
}
exports.BootstrapError = BootstrapError;
function isBootstrapError(value) {
    return value instanceof BootstrapError;
}
function bootstrapError(code, message, issues = []) {
    return new BootstrapError(code, message, issues);
}
});

__kernelDefine("apps/mobile-kernel/bootstrap/origin.js", "apps/mobile-kernel/bootstrap", function (module, exports, require) {
"use strict";
/**
 * K01 —— 调用方 / 本地 origin 校验。
 *
 * 桥的信任边界：APK 内页面随包本地加载（README §3 "UI WebView 可以保留，但页面必须随
 * APK 本地加载，不能以加载远程页面代替内核迁移"）。因此**只有本地 origin** 允许提交命令。
 *
 * 默认白名单是**本地**三态：
 *   - `app://local`             —— 自定义 scheme（assets 域名隔离）；
 *   - `file:///android_asset`   —— `file://` 指向 APK 资源；
 *   - `https://localhost`       —— 本地 WebView 回环（系统 localhost 映射）。
 *
 * 远程 origin（`https://evil.example`、`http://10.0.2.2` 等）一律拒绝。这是**唯一**的
 * 远程/本地判定点；其余层不得各自再造一套。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_ALLOWED_ORIGINS = void 0;
exports.normalizeOrigin = normalizeOrigin;
exports.isAllowedOrigin = isAllowedOrigin;
exports.assertCaller = assertCaller;
const errors_js_1 = require("./errors.js");
exports.DEFAULT_ALLOWED_ORIGINS = [
    'app://local',
    'file:///android_asset',
    'https://localhost',
];
const VALID_KINDS = ['ui-webview', 'native', 'test'];
/** 归一化 origin：去空白；scheme/host 小写（path 保持原样）。 */
function normalizeOrigin(origin) {
    const trimmed = origin.trim();
    // 只小写 scheme + authority 段，避免把大小写敏感的 path 改坏。
    const match = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]*)(.*)$/.exec(trimmed);
    if (match === null)
        return trimmed.toLowerCase();
    return `${(match[1] ?? '').toLowerCase()}${match[2] ?? ''}`;
}
function isAllowedOrigin(origin, allowed = exports.DEFAULT_ALLOWED_ORIGINS) {
    const normalized = normalizeOrigin(origin);
    return allowed.some((candidate) => normalizeOrigin(candidate) === normalized);
}
/**
 * 校验调用方身份。合法返回归一化后的身份；不合法**抛** `ORIGIN_REJECTED` / `CALLER_INVALID`。
 */
function assertCaller(caller, allowedOrigins = exports.DEFAULT_ALLOWED_ORIGINS, allowedKinds) {
    if (typeof caller !== 'object' || caller === null || Array.isArray(caller)) {
        throw (0, errors_js_1.bootstrapError)('CALLER_INVALID', '调用方身份必须是对象');
    }
    const record = caller;
    const origin = record.origin;
    if (typeof origin !== 'string' || origin.trim().length === 0) {
        throw (0, errors_js_1.bootstrapError)('CALLER_INVALID', '调用方缺少 origin');
    }
    const kind = record.kind;
    if (kind !== undefined && (typeof kind !== 'string' || !VALID_KINDS.includes(kind))) {
        const issues = [{ path: 'kind', code: 'UNKNOWN_KIND', message: `kind 必须是 ${VALID_KINDS.join(' | ')}` }];
        throw (0, errors_js_1.bootstrapError)('CALLER_INVALID', '调用方 kind 非法', issues);
    }
    const normalized = normalizeOrigin(origin);
    if (!isAllowedOrigin(normalized, allowedOrigins)) {
        const issues = [{ path: 'origin', code: 'ORIGIN_NOT_ALLOWED', message: `origin ${origin} 不在本地白名单内` }];
        throw (0, errors_js_1.bootstrapError)('ORIGIN_REJECTED', `拒绝非本地 origin：${origin}`, issues);
    }
    if (allowedKinds !== undefined && kind !== undefined && !allowedKinds.includes(kind)) {
        const issues = [{ path: 'kind', code: 'KIND_NOT_ALLOWED', message: `kind ${kind} 不在允许集合内` }];
        throw (0, errors_js_1.bootstrapError)('ORIGIN_REJECTED', `拒绝调用方种类：${kind}`, issues);
    }
    const packageName = record.packageName;
    return {
        origin: normalized,
        ...(kind === undefined ? {} : { kind: kind }),
        ...(typeof packageName === 'string' ? { packageName } : {}),
    };
}
});

__kernelDefine("apps/mobile-kernel/bootstrap/bridge.js", "apps/mobile-kernel/bootstrap", function (module, exports, require) {
"use strict";
/**
 * K01 —— 受限的本地 UI 桥（信任边界）。
 *
 * 桥是 WebView 页面与手机内核之间**唯一**的入口。它只做三件事，且**每个**入口先过
 * 调用方 / 本地 origin 校验（K01 写权：`apps/mobile-kernel/bootstrap/`）：
 *
 *   1. `submit(caller, command)`  —— 提交一条 `mobile-v1` 命令；
 *   2. `subscribe(caller, listener)` —— 订阅事件流，返回可 `unsubscribe` 的订阅；
 *   3. `cancel(caller, commandId)` —— 中止在飞命令。
 *
 * 桥**不**暴露：任意文件读写、密钥原文、代码执行。载荷里的密钥/绝对路径/代码字段由
 * 运行时 `scanPayload` 拒绝（见 guard.ts）；桥只负责 origin/调用方这一道门。
 *
 * 组合关系：`bridge` 是薄封装，业务状态与事件归 `runtime` 所有；桥不复制运行时状态。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createLocalUiBridge = createLocalUiBridge;
const origin_js_1 = require("./origin.js");
function createLocalUiBridge(runtime, options = {}) {
    const allowedOrigins = options.allowedOrigins ?? origin_js_1.DEFAULT_ALLOWED_ORIGINS;
    const allowedKinds = options.allowedKinds;
    const guard = (caller) => (0, origin_js_1.assertCaller)(caller, allowedOrigins, allowedKinds);
    return {
        // async：让 origin 校验失败也走 rejected promise（WebView 桥一律 promise 语义）。
        async submit(caller, command) {
            guard(caller);
            return runtime.dispatch(command);
        },
        subscribe(caller, listener) {
            guard(caller);
            return runtime.subscribe(listener);
        },
        cancel(caller, commandId) {
            guard(caller);
            if (typeof commandId !== 'string' || commandId.length === 0) {
                throw new TypeError('cancel 需要非空 commandId');
            }
            return runtime.cancelInFlight(commandId);
        },
    };
}
});

__kernelDefine("apps/mobile-kernel/bootstrap/guard.js", "apps/mobile-kernel/bootstrap", function (module, exports, require) {
"use strict";
/**
 * K01 —— 载荷安全扫描：桥**不**暴露任意文件 / 密钥 / 代码执行。
 *
 * K01 的桥是 UI 与手机内核之间的封闭边界。UI 只能提交**业务命令**，不能借 payload
 * 把密钥塞进内核（会进日志/事件/账本）、不能递进电脑绝对路径（正式路径禁止回退到电脑，
 * 见 README §3）、不能递进"一段代码"让内核执行。
 *
 * 这是**纵深防御**的一层，不是唯一防线（真正的密钥由 K03 Keystore 持有，明文永不下行）。
 * 命中即抛 `PAYLOAD_FORBIDDEN`（边界错误，非执行结果）。
 *
 * 已知局限：这是**启发式**（键名 + 值模式），不做语义分析；合法业务字段名若恰好撞上
 * 保留字（如某个 patch 里真有 `token` 键）会被拒——需要时由业务改成引用（`*Ref`）。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.FORBIDDEN_CODE_KEYS = exports.FORBIDDEN_KEYS = void 0;
exports.scanPayload = scanPayload;
/** 保留键名（小写比较）：任何层级出现即拒。 */
exports.FORBIDDEN_KEYS = [
    'apikey',
    'api_key',
    'secret',
    'clientsecret',
    'client_secret',
    'password',
    'passwd',
    'token',
    'accesstoken',
    'access_token',
    'refreshtoken',
    'refresh_token',
    'privatekey',
    'private_key',
    'credential',
    'credentials',
];
/** 保留的代码执行键名：桥不承载"把代码传进来跑"。 */
exports.FORBIDDEN_CODE_KEYS = ['eval', 'exec', 'executescript', 'sourcecode', 'source_code', 'javascript', 'shellcommand', 'shell_command'];
/** 值模式：电脑绝对路径 / 私钥块 / 常见密钥字面量。 */
const FORBIDDEN_VALUE_PATTERNS = [
    { code: 'ABSOLUTE_WINDOWS_PATH', re: /^[A-Za-z]:[\\/]/, why: '禁止电脑盘符路径' },
    { code: 'ABSOLUTE_POSIX_PATH', re: /^\//, why: '禁止 POSIX 绝对路径' },
    { code: 'PRIVATE_KEY_BLOCK', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, why: '禁止私钥块' },
    { code: 'SECRET_LITERAL', re: /\bsk-[A-Za-z0-9_-]{12,}/, why: '禁止密钥字面量' },
];
const MAX_DEPTH = 12;
/** 扫描一个 payload（或任意子结构），返回发现的问题。 */
function scanPayload(payload) {
    const findings = [];
    walk(payload, 'payload', 0, findings);
    return findings;
}
function walk(value, path, depth, out) {
    if (depth > MAX_DEPTH) {
        out.push({ path, code: 'TOO_DEEP', message: `嵌套超过 ${MAX_DEPTH} 层` });
        return;
    }
    if (typeof value === 'string') {
        for (const { code, re, why } of FORBIDDEN_VALUE_PATTERNS) {
            if (re.test(value))
                out.push({ path, code, message: why });
        }
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1, out));
        return;
    }
    if (typeof value === 'object' && value !== null) {
        for (const [key, child] of Object.entries(value)) {
            const lower = key.toLowerCase();
            const childPath = `${path}.${key}`;
            if (exports.FORBIDDEN_KEYS.includes(lower)) {
                out.push({ path: childPath, code: 'FORBIDDEN_KEY', message: `禁止密钥类字段 ${key}` });
            }
            if (exports.FORBIDDEN_CODE_KEYS.includes(lower)) {
                out.push({ path: childPath, code: 'FORBIDDEN_CODE_KEY', message: `桥不承载代码执行字段 ${key}` });
            }
            walk(child, childPath, depth + 1, out);
        }
    }
}
});

__kernelDefine("apps/mobile-kernel/bootstrap/validate.js", "apps/mobile-kernel/bootstrap", function (module, exports, require) {
"use strict";
/**
 * K01 —— `command` 形状校验（`contracts/mobile-v1/schemas/command.schema.json` 的
 * 零依赖子集实现）。
 *
 * 为什么不直接跑 `contracts/mobile-v1/validate.mjs`：那是 CLI，读文件系统，手机内运行时
 * 不方便；且桥的入口接收的是**未信任的 JS 对象**，需要在**进程内**快速拒绝。这里实现的是
 * 同一形状的可判定子集，并**只覆盖 command**（event 由本层生成，天然满足）。
 *
 * 覆盖的分支规则（与 schema 逐条对应）：
 *   - 公共必需：`schemaVersion=const "mobile-v1"` / `commandId` / `operation` / `idempotencyKey` / `payload`；
 *   - `create|import`：目标 id/revision 可缺省，**不要求** expectedRevision；
 *   - `mutate|apply|export|undo|redo`：**必须**有 `expectedRevision`，且 **必须**有
 *     `conversationId` 或 `taskId`；
 *   - `preview|inspect|query|cancel`：**必须**有 `conversationId` 或 `taskId`；
 *   - payload 的 `additionalProperties:false`：按分支给出允许键集合，出现未知键即报错。
 *
 * 已知局限（如实声明）：不校验 `metadata` 的深层语义；数字判断把 `1.0` 视作整数
 * （与契约校验器的子集口径一致）。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.QUERY_OPERATIONS = exports.MUTATION_OPERATIONS = exports.CREATE_OPERATIONS = exports.COMMAND_OPERATIONS = void 0;
exports.validateCommand = validateCommand;
exports.COMMAND_OPERATIONS = [
    'create',
    'import',
    'mutate',
    'apply',
    'export',
    'undo',
    'redo',
    'preview',
    'inspect',
    'query',
    'cancel',
];
exports.CREATE_OPERATIONS = ['create', 'import'];
exports.MUTATION_OPERATIONS = ['mutate', 'apply', 'export', 'undo', 'redo'];
exports.QUERY_OPERATIONS = ['preview', 'inspect', 'query', 'cancel'];
const COMMON_KEYS = ['schemaVersion', 'commandId', 'operation', 'idempotencyKey', 'payload', 'metadata'];
const CREATE_PAYLOAD_KEYS = [
    'conversationId',
    'taskId',
    'targetId',
    'id',
    'revision',
    'expectedRevision',
    'goal',
    'templateId',
    'roleHint',
    'content',
    'patch',
    'args',
    'filters',
];
const MUTATION_PAYLOAD_KEYS = [
    'conversationId',
    'taskId',
    'targetId',
    'id',
    'revision',
    'expectedRevision',
    'patch',
    'args',
    'content',
];
const QUERY_PAYLOAD_KEYS = [
    'conversationId',
    'taskId',
    'targetId',
    'id',
    'revision',
    'expectedRevision',
    'filters',
];
const ID_MAX = 128;
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isId(value) {
    return typeof value === 'string' && value.length >= 1 && value.length <= ID_MAX;
}
function isRevision(value) {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
function branchOf(operation) {
    if (exports.CREATE_OPERATIONS.includes(operation))
        return 'create';
    if (exports.MUTATION_OPERATIONS.includes(operation))
        return 'mutation';
    return 'query';
}
function allowedPayloadKeys(branch) {
    if (branch === 'create')
        return CREATE_PAYLOAD_KEYS;
    if (branch === 'mutation')
        return MUTATION_PAYLOAD_KEYS;
    return QUERY_PAYLOAD_KEYS;
}
/** 校验一条命令。返回问题清单；`ok === issues.length === 0`。 */
function validateCommand(input) {
    const issues = [];
    const push = (path, code, message) => {
        issues.push({ path, code, message });
    };
    if (!isRecord(input)) {
        push('$', 'NOT_AN_OBJECT', '命令必须是对象');
        return { ok: false, issues };
    }
    for (const key of Object.keys(input)) {
        if (!COMMON_KEYS.includes(key))
            push(key, 'UNKNOWN_KEY', `command 不接受额外字段 ${key}`);
    }
    if (input.schemaVersion !== 'mobile-v1') {
        push('schemaVersion', 'NOT_MOBILE_V1', 'schemaVersion 必须为 "mobile-v1"');
    }
    if (!isId(input.commandId))
        push('commandId', 'INVALID_ID', 'commandId 必须是 1..128 的字符串');
    if (!isId(input.idempotencyKey))
        push('idempotencyKey', 'INVALID_ID', 'idempotencyKey 必须是 1..128 的字符串');
    if (input.metadata !== undefined && !isRecord(input.metadata))
        push('metadata', 'NOT_AN_OBJECT', 'metadata 必须是对象');
    if (typeof input.operation !== 'string' || !exports.COMMAND_OPERATIONS.includes(input.operation)) {
        push('operation', 'UNKNOWN_OPERATION', `operation 必须是 ${exports.COMMAND_OPERATIONS.join(' | ')} 之一`);
    }
    if (!isRecord(input.payload)) {
        push('payload', 'NOT_AN_OBJECT', 'payload 必须是对象');
        return { ok: issues.length === 0, issues };
    }
    const payload = input.payload;
    const operation = input.operation;
    if (operation === undefined || !exports.COMMAND_OPERATIONS.includes(operation)) {
        return { ok: false, issues };
    }
    const branch = branchOf(operation);
    for (const key of Object.keys(payload)) {
        if (!allowedPayloadKeys(branch).includes(key)) {
            push(`payload.${key}`, 'UNKNOWN_KEY', `payload 在 ${operation} 分支不接受字段 ${key}`);
        }
    }
    // 类型：有则必须合法。
    for (const key of ['conversationId', 'taskId', 'targetId', 'id']) {
        if (payload[key] !== undefined && !isId(payload[key])) {
            push(`payload.${key}`, 'INVALID_ID', `${key} 必须是 1..128 的字符串`);
        }
    }
    for (const key of ['revision', 'expectedRevision']) {
        if (payload[key] !== undefined && !isRevision(payload[key])) {
            push(`payload.${key}`, 'NOT_AN_INTEGER', `${key} 必须是 >=0 的整数`);
        }
    }
    if (branch === 'mutation') {
        if (payload.expectedRevision === undefined) {
            push('payload.expectedRevision', 'MISSING', `${operation} 必须携带 expectedRevision`);
        }
        if (payload.conversationId === undefined && payload.taskId === undefined) {
            push('payload', 'MISSING_TARGET', `${operation} 必须携带 conversationId 或 taskId`);
        }
        if (payload.patch !== undefined && !isRecord(payload.patch))
            push('payload.patch', 'NOT_AN_OBJECT', 'patch 必须是对象');
        if (payload.args !== undefined && !isRecord(payload.args))
            push('payload.args', 'NOT_AN_OBJECT', 'args 必须是对象');
    }
    if (branch === 'query') {
        if (payload.conversationId === undefined && payload.taskId === undefined) {
            push('payload', 'MISSING_TARGET', `${operation} 必须携带 conversationId 或 taskId`);
        }
        if (payload.filters !== undefined && !isRecord(payload.filters))
            push('payload.filters', 'NOT_AN_OBJECT', 'filters 必须是对象');
    }
    if (branch === 'create') {
        if (payload.goal !== undefined && !(typeof payload.goal === 'string' && payload.goal.length >= 1)) {
            push('payload.goal', 'INVALID_STRING', 'goal 必须是非空字符串');
        }
        if (payload.patch !== undefined && !isRecord(payload.patch))
            push('payload.patch', 'NOT_AN_OBJECT', 'patch 必须是对象');
        if (payload.args !== undefined && !isRecord(payload.args))
            push('payload.args', 'NOT_AN_OBJECT', 'args 必须是对象');
        if (payload.filters !== undefined && !isRecord(payload.filters))
            push('payload.filters', 'NOT_AN_OBJECT', 'filters 必须是对象');
    }
    return { ok: issues.length === 0, issues };
}
});

__kernelDefine("apps/mobile-kernel/bootstrap/runtime.js", "apps/mobile-kernel/bootstrap", function (module, exports, require) {
"use strict";
/**
 * K01 —— 可嵌入的业务运行时（引导层核心）。
 *
 * 这是手机内核在 Android Service 内**承载业务模块**的最小宿主：只管
 * 启动/关闭、命令路由、事件扇出、idempotency、revision 守卫、取消。
 * 业务语义（对话、派发、模板、Word/XLS/PPT、美团）由**注册进来的模块**实现；
 * 引导层不 import 任何业务代码（同一份 TS 可在 QuickJS / V8 / Node 里加载）。
 *
 * 硬口径（逐条由 tests/mobile-kernel/K01 机器化断言）：
 *   I1 fail-closed：`succeeded` 必须携带 `resultRef`；缺执行器只能 `failed` +
 *      `EXECUTOR_UNAVAILABLE`，绝不上报 succeeded（契约不变量 3）。
 *   I2 幂等：同一 `idempotencyKey` 重复提交返回**原事件**（同 eventId/seq/status），
 *      带 `idempotentReplay:true`，且**不**再调用处理器、**不**再扇出给订阅者。
 *   I3 revision 守卫：mutation 的 `expectedRevision` 与当前不符 ⇒ `conflict`，
 *      **不**调用处理器（契约不变量：旧修订明确冲突，不是 succeeded）。
 *   I4 取消：`cancelInFlight` 置 AbortSignal；处理器 settle 后状态以 signal 为准，
 *      强制为 `cancelled`（迟到的 succeeded 不得覆盖取消）。
 *   I5 seq 单调：事件流 `seq` 从 1 起严格递增，无空洞。
 *   I6 订阅隔离：单个订阅者抛错不影响其他订阅者与本次 dispatch。
 *   I7 未启动/边界非法：`RUNTIME_NOT_RUNNING` / `COMMAND_INVALID` / `PAYLOAD_FORBIDDEN`
 *      一律**抛**（见 errors.ts 分层口径）。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createBootstrapRuntime = createBootstrapRuntime;
const errors_js_1 = require("./errors.js");
const guard_js_1 = require("./guard.js");
const validate_js_1 = require("./validate.js");
const CANCELLED_ERROR = { code: 'CANCELLED_BY_USER', message: '用户取消了该命令' };
const EXECUTOR_UNAVAILABLE = {
    code: 'EXECUTOR_UNAVAILABLE',
    message: '缺少可用执行器，未执行任何外部动作',
    retryable: true,
};
const MUTATION_OPERATIONS = new Set(['mutate', 'apply', 'export', 'undo', 'redo']);
const WRITE_OPERATIONS = new Set(['create', 'import', 'mutate', 'apply', 'export', 'undo', 'redo']);
function createBootstrapRuntime(options) {
    const clock = options.clock;
    const verificationMode = options.verificationMode ?? 'fixture';
    let state = 'stopped';
    let seq = 0;
    let subscriptionSeq = 0;
    const modulesByOperation = new Map();
    const subscribers = new Map();
    const revisions = new Map();
    const idempotency = new Map();
    const inFlight = new Map();
    function nextSeq() {
        seq += 1;
        return seq;
    }
    function targetKey(command) {
        const payload = command.payload;
        const explicit = payload.targetId ?? payload.id ?? payload.taskId ?? payload.conversationId;
        if (typeof explicit === 'string' && explicit.length > 0)
            return explicit;
        // create 未给目标：以 commandId 作为新对象身份（内核生成）。
        return `gen:${command.commandId}`;
    }
    function currentRevision(key) {
        return revisions.get(key) ?? 0;
    }
    function publish(event) {
        for (const listener of [...subscribers.values()]) {
            try {
                listener(event);
            }
            catch {
                // I6：单个订阅者抛错不影响其他订阅者与调用方。
            }
        }
    }
    function buildEvent(command, fields) {
        const next = seq + 1;
        seq = next;
        return {
            eventId: `evt-${next}`,
            seq: next,
            commandId: command.commandId,
            revision: fields.revision,
            status: fields.status,
            verificationMode,
            idempotentReplay: false,
            metadata: { emittedAt: clock.now() },
            ...(fields.resultRef === undefined ? {} : { resultRef: fields.resultRef }),
            ...(fields.error === undefined ? {} : { error: fields.error }),
        };
    }
    function commit(command, event) {
        idempotency.set(command.idempotencyKey, event);
        publish(event);
        return event;
    }
    async function runHandler(command, entry, key) {
        const controller = new AbortController();
        inFlight.set(command.commandId, { controller });
        const ctx = {
            command,
            signal: controller.signal,
            now: clock.now(),
            emit: (emit) => {
                const event = buildEvent(command, {
                    status: emit.status,
                    revision: emit.revision ?? currentRevision(key),
                    ...(emit.error === undefined ? {} : { error: emit.error }),
                });
                publish(event);
            },
        };
        try {
            const outcome = await entry.handler(command, ctx);
            return { outcome, aborted: controller.signal.aborted };
        }
        catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                return { outcome: { status: 'cancelled', error: CANCELLED_ERROR }, aborted: true };
            }
            throw error;
        }
        finally {
            inFlight.delete(command.commandId);
        }
    }
    async function dispatch(command) {
        if (state !== 'running') {
            throw (0, errors_js_1.bootstrapError)('RUNTIME_NOT_RUNNING', `运行时未启动（当前 ${state}）`);
        }
        const validation = (0, validate_js_1.validateCommand)(command);
        if (!validation.ok) {
            throw (0, errors_js_1.bootstrapError)('COMMAND_INVALID', `命令形状非法（${validation.issues.length} 处）`, validation.issues);
        }
        const cmd = command;
        const forbidden = (0, guard_js_1.scanPayload)(cmd.payload);
        if (forbidden.length > 0) {
            throw (0, errors_js_1.bootstrapError)('PAYLOAD_FORBIDDEN', `载荷夹带禁止内容（${forbidden.length} 处）`, forbidden);
        }
        // I2：幂等命中——返回原事件，不重跑、不重扇出。
        const prior = idempotency.get(cmd.idempotencyKey);
        if (prior !== undefined) {
            return { ...prior, idempotentReplay: true };
        }
        const key = targetKey(cmd);
        // 取消命令由引导层内建处理（不路由给业务模块）。
        if (cmd.operation === 'cancel') {
            const event = buildEvent(cmd, { status: 'cancelled', revision: currentRevision(key), error: CANCELLED_ERROR });
            return commit(cmd, event);
        }
        const entry = modulesByOperation.get(cmd.operation);
        if (entry === undefined) {
            // I1：缺执行器 ⇒ fail-closed，绝不 succeeded。
            const event = buildEvent(cmd, { status: 'failed', revision: currentRevision(key), error: EXECUTOR_UNAVAILABLE });
            return commit(cmd, event);
        }
        // I3：mutation 的 revision 守卫（在调用处理器之前判定）。
        if (MUTATION_OPERATIONS.has(cmd.operation)) {
            const payload = cmd.payload;
            const expected = payload.expectedRevision;
            const current = currentRevision(key);
            if (typeof expected === 'number' && expected !== current) {
                const conflictError = {
                    code: 'REVISION_CONFLICT',
                    message: `expectedRevision=${expected} 与当前 ${current} 不符`,
                    details: { expectedRevision: expected, currentRevision: current },
                };
                const event = buildEvent(cmd, { status: 'conflict', revision: current, error: conflictError });
                return commit(cmd, event);
            }
        }
        let outcome;
        let aborted;
        try {
            const ran = await runHandler(cmd, entry, key);
            outcome = ran.outcome;
            aborted = ran.aborted;
        }
        catch (error) {
            const failedEvent = buildEvent(cmd, {
                status: 'failed',
                revision: currentRevision(key),
                error: {
                    code: 'HANDLER_ERROR',
                    message: error instanceof Error ? error.message : String(error),
                    retryable: true,
                },
            });
            return commit(cmd, failedEvent);
        }
        // I4：settle 时以 signal 为准——取消优先于处理器声称的终局。
        let status = aborted ? 'cancelled' : outcome.status;
        let error = aborted ? CANCELLED_ERROR : outcome.error;
        if (status === 'succeeded' && (outcome.resultRef === undefined || outcome.resultRef.length === 0)) {
            // I1 fail-closed：没有结果引用不得 succeeded。
            status = 'failed';
            error = { code: 'RESULT_REF_REQUIRED', message: 'succeeded 必须携带 resultRef（fail-closed）' };
        }
        let revision = currentRevision(key);
        if (outcome.revision !== undefined) {
            revision = outcome.revision;
            if (status === 'succeeded')
                revisions.set(key, revision);
        }
        else if (status === 'succeeded' && WRITE_OPERATIONS.has(cmd.operation)) {
            revision = currentRevision(key) + 1;
            revisions.set(key, revision);
        }
        const event = buildEvent(cmd, {
            status,
            revision,
            ...(status === 'succeeded' && outcome.resultRef !== undefined ? { resultRef: outcome.resultRef } : {}),
            ...(error === undefined ? {} : { error }),
        });
        return commit(cmd, event);
    }
    function start() {
        if (state === 'running')
            throw (0, errors_js_1.bootstrapError)('RUNTIME_ALREADY_RUNNING', '运行时已在运行');
        if (state === 'starting')
            throw (0, errors_js_1.bootstrapError)('RUNTIME_ALREADY_RUNNING', '运行时正在启动');
        state = 'starting';
        state = 'running';
    }
    function stop() {
        if (state === 'stopped')
            return;
        state = 'stopping';
        for (const { controller } of inFlight.values())
            controller.abort();
        inFlight.clear();
        state = 'stopped';
    }
    function registerModule(module) {
        for (const operation of module.operations) {
            const existing = modulesByOperation.get(operation);
            if (existing !== undefined) {
                const issues = [
                    { path: operation, code: 'MODULE_CONFLICT', message: `operation ${operation} 已被模块 ${existing.moduleId} 认领` },
                ];
                throw (0, errors_js_1.bootstrapError)('MODULE_CONFLICT', `operation ${operation} 重复认领`, issues);
            }
        }
        for (const operation of module.operations) {
            modulesByOperation.set(operation, { moduleId: module.id, handler: module.handle });
        }
    }
    function subscribe(listener) {
        subscriptionSeq += 1;
        const id = `sub-${subscriptionSeq}`;
        subscribers.set(id, listener);
        return {
            id,
            unsubscribe: () => {
                subscribers.delete(id);
            },
        };
    }
    function cancelInFlight(commandId) {
        const entry = inFlight.get(commandId);
        if (entry === undefined)
            return false;
        entry.controller.abort();
        return true;
    }
    return {
        get state() {
            return state;
        },
        start,
        stop,
        registerModule,
        dispatch,
        subscribe,
        cancelInFlight,
        inFlight: () => [...inFlight.keys()],
    };
}
});

__kernelDefine("apps/mobile-kernel/bootstrap/types.js", "apps/mobile-kernel/bootstrap", function (module, exports, require) {
"use strict";
/**
 * K01 —— 引导层类型。
 *
 * **只读消费** `contracts/mobile-v1/types.ts`（v1 契约类型），不复制其字段定义：
 * 命令/事件的权威形状在 `contracts/mobile-v1/schemas/*.json`，本文件只补引导层
 * 自己的注入口（时钟、模块、桥、调用方身份）。
 *
 * 时间一律经**注入时钟**（契约《金额与时间编码》第 4 条），禁止实现里直接读系统时间，
 * 好让"过期/顺序"可被确定性测试。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createManualClock = createManualClock;
/** 确定性手动时钟：从给定起点按 `stepMs` 递增。测试用，不读墙钟。 */
function createManualClock(startIso = '2026-10-03T00:00:00.000Z', stepMs = 1) {
    let current = Date.parse(startIso);
    if (Number.isNaN(current))
        throw new Error(`invalid startIso: ${startIso}`);
    return {
        now() {
            const iso = new Date(current).toISOString();
            current += stepMs;
            return iso;
        },
        advance(ms = stepMs) {
            current += ms;
            return new Date(current).toISOString();
        },
    };
}
});

__kernelDefine("apps/mobile-kernel/bootstrap/index.js", "apps/mobile-kernel/bootstrap", function (module, exports, require) {
"use strict";
/**
 * K01 —— 手机内核引导层对外出口。
 *
 * 交付内容（对应 KERNEL.md K01 行）：
 *   - APK 内 JS/业务宿主：`createBootstrapRuntime`（启动/关闭、命令路由、事件扇出、
 *     幂等、revision 守卫、取消）；
 *   - 受限本地 UI 桥：`createLocalUiBridge`（提交/订阅/取消 + 调用方与本地 origin 校验）；
 *   - 载荷安全扫描：`scanPayload`（不暴露密钥/任意文件/代码执行）。
 *
 * 零依赖纯 TS，不 import node 内建，可在 QuickJS / V8 / Node 里加载。
 * 命令/事件形状只读消费 `contracts/mobile-v1`（v1 契约），不复制其字段定义。
 *
 * 用法与验证见同目录 `README.md`（含 arm64 真机 spike 计划与确切命令）。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createManualClock = exports.createLocalUiBridge = exports.createBootstrapRuntime = exports.normalizeOrigin = exports.isAllowedOrigin = exports.assertCaller = exports.DEFAULT_ALLOWED_ORIGINS = exports.scanPayload = exports.FORBIDDEN_KEYS = exports.FORBIDDEN_CODE_KEYS = exports.validateCommand = exports.QUERY_OPERATIONS = exports.MUTATION_OPERATIONS = exports.CREATE_OPERATIONS = exports.COMMAND_OPERATIONS = exports.isBootstrapError = exports.bootstrapError = exports.BootstrapError = exports.BOOTSTRAP_ERROR_CODES = void 0;
var errors_js_1 = require("./errors.js");
Object.defineProperty(exports, "BOOTSTRAP_ERROR_CODES", { enumerable: true, get: function () { return errors_js_1.BOOTSTRAP_ERROR_CODES; } });
Object.defineProperty(exports, "BootstrapError", { enumerable: true, get: function () { return errors_js_1.BootstrapError; } });
Object.defineProperty(exports, "bootstrapError", { enumerable: true, get: function () { return errors_js_1.bootstrapError; } });
Object.defineProperty(exports, "isBootstrapError", { enumerable: true, get: function () { return errors_js_1.isBootstrapError; } });
var validate_js_1 = require("./validate.js");
Object.defineProperty(exports, "COMMAND_OPERATIONS", { enumerable: true, get: function () { return validate_js_1.COMMAND_OPERATIONS; } });
Object.defineProperty(exports, "CREATE_OPERATIONS", { enumerable: true, get: function () { return validate_js_1.CREATE_OPERATIONS; } });
Object.defineProperty(exports, "MUTATION_OPERATIONS", { enumerable: true, get: function () { return validate_js_1.MUTATION_OPERATIONS; } });
Object.defineProperty(exports, "QUERY_OPERATIONS", { enumerable: true, get: function () { return validate_js_1.QUERY_OPERATIONS; } });
Object.defineProperty(exports, "validateCommand", { enumerable: true, get: function () { return validate_js_1.validateCommand; } });
var guard_js_1 = require("./guard.js");
Object.defineProperty(exports, "FORBIDDEN_CODE_KEYS", { enumerable: true, get: function () { return guard_js_1.FORBIDDEN_CODE_KEYS; } });
Object.defineProperty(exports, "FORBIDDEN_KEYS", { enumerable: true, get: function () { return guard_js_1.FORBIDDEN_KEYS; } });
Object.defineProperty(exports, "scanPayload", { enumerable: true, get: function () { return guard_js_1.scanPayload; } });
var origin_js_1 = require("./origin.js");
Object.defineProperty(exports, "DEFAULT_ALLOWED_ORIGINS", { enumerable: true, get: function () { return origin_js_1.DEFAULT_ALLOWED_ORIGINS; } });
Object.defineProperty(exports, "assertCaller", { enumerable: true, get: function () { return origin_js_1.assertCaller; } });
Object.defineProperty(exports, "isAllowedOrigin", { enumerable: true, get: function () { return origin_js_1.isAllowedOrigin; } });
Object.defineProperty(exports, "normalizeOrigin", { enumerable: true, get: function () { return origin_js_1.normalizeOrigin; } });
var runtime_js_1 = require("./runtime.js");
Object.defineProperty(exports, "createBootstrapRuntime", { enumerable: true, get: function () { return runtime_js_1.createBootstrapRuntime; } });
var bridge_js_1 = require("./bridge.js");
Object.defineProperty(exports, "createLocalUiBridge", { enumerable: true, get: function () { return bridge_js_1.createLocalUiBridge; } });
var types_js_1 = require("./types.js");
Object.defineProperty(exports, "createManualClock", { enumerable: true, get: function () { return types_js_1.createManualClock; } });
});

const __kernelEntry = __kernelRequire("apps/mobile-kernel/bootstrap/index.js");
export const BOOTSTRAP_ERROR_CODES = __kernelEntry.BOOTSTRAP_ERROR_CODES;
export const BootstrapError = __kernelEntry.BootstrapError;
export const COMMAND_OPERATIONS = __kernelEntry.COMMAND_OPERATIONS;
export const CREATE_OPERATIONS = __kernelEntry.CREATE_OPERATIONS;
export const DEFAULT_ALLOWED_ORIGINS = __kernelEntry.DEFAULT_ALLOWED_ORIGINS;
export const FORBIDDEN_CODE_KEYS = __kernelEntry.FORBIDDEN_CODE_KEYS;
export const FORBIDDEN_KEYS = __kernelEntry.FORBIDDEN_KEYS;
export const MUTATION_OPERATIONS = __kernelEntry.MUTATION_OPERATIONS;
export const QUERY_OPERATIONS = __kernelEntry.QUERY_OPERATIONS;
export const assertCaller = __kernelEntry.assertCaller;
export const bootstrapError = __kernelEntry.bootstrapError;
export const createBootstrapRuntime = __kernelEntry.createBootstrapRuntime;
export const createLocalUiBridge = __kernelEntry.createLocalUiBridge;
export const createManualClock = __kernelEntry.createManualClock;
export const isAllowedOrigin = __kernelEntry.isAllowedOrigin;
export const isBootstrapError = __kernelEntry.isBootstrapError;
export const normalizeOrigin = __kernelEntry.normalizeOrigin;
export const scanPayload = __kernelEntry.scanPayload;
export const validateCommand = __kernelEntry.validateCommand;
