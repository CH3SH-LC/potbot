/**
 * 手机美团插件 · 协议脱敏管道与 PII 扫描器（零依赖、纯函数）。
 *
 * > 生产出处：本模块由 M-R01 备用包 `tests/mobile-meituan/M-R01/redaction.ts`
 * > **原样提升**到生产源码树（M-R01 集成请求 #1），使其它 M 包无需伸手进测试树即可
 * > 复用脱敏 / 门禁能力。**测试树中的 M-R01 副本不得改动**（只读对照）。
 *
 * ## 这个包要关掉的洞
 *
 * 美团协议 fixture 一旦被"真实响应"命名，就极容易把**真实手机号、身份证、地址、
 * 联系人、token** 原样带进仓库、日志或证据。本模块的职责不是"采集真实响应"
 * （那要先过 M01 能力核实），而是**建立一条可机读的脱敏管道**：
 * 真实响应到手后必须经 {@link redactProtocolPayload} 处理，并由 {@link assertRedacted}
 * 在入库/入证据前拦住任何残留 PII。
 *
 * ## 两层判据
 *
 * 1. **字段名驱动**：值位于敏感字段名（`phone` / `idCard` / `token` / `address` …）之下时，
 *    必须已是**占位符或引用**（`«redacted:phone#1»` / `keyref:…` / `acct:…` / `poi-…`），
 *    否则视为违规。
 * 2. **模式驱动**：任意字符串（即使在非敏感字段，如 `remark`）出现**手机号 / 身份证 /
 *    邮箱**形状即违规。这一层防止 PII 躲在自由文本里。
 *
 * 扫描器**刻意不把长十六进制串当 secret**：`sha256:` 摘要是"可公开的指纹"，不是凭据；
 * 把摘要误判成 secret 会让真正的 secret 规则被噪声淹没。secret 只按字段名捕获。
 *
 * ## 正则状态（易错点）
 *
 * 模式正则均带 `g` 标志。带 `g` 的 `RegExp` 在 `.test()` 之间会保留 `lastIndex`，
 * 若先 `.test()` 再 `.test()`，第二次会从上次位置继续，**静默漏判**。本模块统一经
 * {@link matches} 重置 `lastIndex`；替换路径直接调用 `String.prototype.replace`
 * （全局替换自带收敛），**绝不**先 `.test()` 预判。
 *
 * ## 如实声明
 *
 * 本模块是**纯函数**，不读网络、不读时钟、不读环境变量。它**不证明**真实响应已被采集，
 * 只证明"经它处理的载荷不含可识别 PII"。真实响应尚未采集（M01 未核验 endpoint）。
 */

/** 可识别的个人/凭据信息类别（新增必须在此登记）。 */
export const PII_KINDS = [
  'phone',
  'id_card',
  'email',
  'bank_card',
  'token',
  'secret',
  'address',
  'contact_name',
  'geo',
] as const;

export type PiiKind = (typeof PII_KINDS)[number];

/** 脱敏占位符形状：`«redacted:phone»` 或 `«redacted:phone#2»`。 */
export const REDACTED_PLACEHOLDER_RE = /^«redacted:[a-z_]+(?:#\d+)?»$/;

/** 生成占位符。带 ordinal 时保证同一载荷内同类值互不相同（避免合并成同一条）。 */
export function redactedPlaceholder(kind: PiiKind, ordinal?: number): string {
  return ordinal === undefined ? `«redacted:${kind}»` : `«redacted:${kind}#${ordinal}»`;
}

// ---------------------------------------------------------------------------
// 遮罩函数（供视图层复用；本包 fixture 用**完整占位符**，不用遮罩——见 fixture.ts）
// ---------------------------------------------------------------------------

/** 手机号：保留前 3 后 4，中间 `****`；短号只留末 2；空串原样返回空串。 */
export function maskPhone(phone: string): string {
  if (phone.length === 0) return '';
  if (phone.length <= 4) return '*'.repeat(phone.length);
  if (phone.length < 8) return `${'*'.repeat(phone.length - 2)}${phone.slice(-2)}`;
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

/** 联系人名：保留首字符，其余 `*`。 */
export function maskContactName(name: string): string {
  if (name.length === 0) return '';
  if (name.length === 1) return '*';
  return `${name.slice(0, 1)}${'*'.repeat(name.length - 1)}`;
}

/** 邮箱：保留首字符与域名，local 其余部分 `*`。 */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return email.length === 0 ? '' : '*'.repeat(email.length);
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const head = local.slice(0, 1);
  return `${head}${'*'.repeat(Math.max(local.length - 1, 0))}${domain}`;
}

/** 身份证：保留前 3 后 1，中间 `*`。 */
export function maskIdCard(id: string): string {
  if (id.length <= 4) return '*'.repeat(id.length);
  return `${id.slice(0, 3)}${'*'.repeat(id.length - 4)}${id.slice(-1)}`;
}

/** 地址：保留前 2 字符，其余 `*`。 */
export function maskAddress(address: string): string {
  if (address.length <= 2) return '*'.repeat(address.length);
  return `${address.slice(0, 2)}${'*'.repeat(address.length - 2)}`;
}

// ---------------------------------------------------------------------------
// 字段名 → PII 类别
// ---------------------------------------------------------------------------

/** 敏感字段名登记（键用小写比较；新增须在此登记）。 */
export const SENSITIVE_FIELD_KINDS: Readonly<Record<string, PiiKind>> = Object.freeze({
  phone: 'phone',
  mobile: 'phone',
  tel: 'phone',
  telephone: 'phone',
  contactphone: 'phone',
  receiverphone: 'phone',
  idcard: 'id_card',
  identity: 'id_card',
  idnumber: 'id_card',
  email: 'email',
  mail: 'email',
  bankcard: 'bank_card',
  cardno: 'bank_card',
  cardnumber: 'bank_card',
  token: 'token',
  accesstoken: 'token',
  sessiontoken: 'token',
  refreshtoken: 'token',
  secret: 'secret',
  appsecret: 'secret',
  apikey: 'secret',
  appkey: 'secret',
  sign: 'secret',
  signature: 'secret',
  address: 'address',
  addr: 'address',
  addrdetail: 'address',
  detailaddress: 'address',
  receiveraddress: 'address',
  contactname: 'contact_name',
  receivername: 'contact_name',
  username: 'contact_name',
  realname: 'contact_name',
  latitude: 'geo',
  longitude: 'geo',
  lat: 'geo',
  lng: 'geo',
});

// 模式驱动的 PII 形状（顺序重要：身份证先于手机号，避免 18 位被截成手机号）。
const ID_CARD_RE = /(?<![\dXx])\d{17}[\dXx](?![\dXx])/g;
const PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** 已是脱敏占位符、引用或合成 ID 的值（不再视为残留 PII）。 */
export function isSafeSensitiveValue(value: string): boolean {
  if (value.length === 0) return true;
  if (REDACTED_PLACEHOLDER_RE.test(value)) return true;
  if (/^(keyref|acct|ref):[A-Za-z0-9._:\-]+$/.test(value)) return true;
  // 合成引用 ID（不得含 6 位以上连续数字，否则可能是真实手机号/卡号残片）。
  if (/^[A-Za-z]+[A-Za-z0-9*._-]*$/.test(value) && !/\d{6,}/.test(value)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// 脱敏
// ---------------------------------------------------------------------------

export interface RedactionApplication {
  /** JSON 路径，如 `data.poiList[0].phone`。 */
  readonly path: string;
  readonly kind: PiiKind;
}

export interface RedactionResult {
  readonly value: unknown;
  readonly applied: readonly RedactionApplication[];
}

export interface RedactOptions {
  /** 关闭字段名驱动的递归（只做字符串内模式替换）。 */
  readonly patternOnly?: boolean;
}

function isPlainObject(node: unknown): node is Record<string, unknown> {
  return typeof node === 'object' && node !== null && !Array.isArray(node);
}

/**
 * 深度脱敏：按字段名 + 字符串模式两段处理。**确定性**（同输入同输出、占位符编号按遍历顺序）。
 * 记录 `applied` 只含 path 与 kind，**不含原值**——避免把明文写进结果或证据。
 */
export function redactProtocolPayload(input: unknown, options: RedactOptions = {}): RedactionResult {
  const applied: RedactionApplication[] = [];
  const counters = new Map<PiiKind, number>();

  const nextPlaceholder = (kind: PiiKind, path: string): string => {
    const ordinal = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, ordinal);
    applied.push(Object.freeze({ path, kind }));
    return redactedPlaceholder(kind, ordinal);
  };

  const replaceInline = (raw: string, path: string): string => {
    let out = raw;
    // 直接调用 replace（全局正则非命中时为恒等）；**不要**先用 `.test()`
    // 预判——带 `g` 的 regex 状态在 `.test()` 之间会残留，导致漏替换。
    out = out.replace(ID_CARD_RE, () => nextPlaceholder('id_card', path));
    out = out.replace(PHONE_RE, () => nextPlaceholder('phone', path));
    out = out.replace(EMAIL_RE, () => nextPlaceholder('email', path));
    return out;
  };

  const walk = (node: unknown, path: string): unknown => {
    if (Array.isArray(node)) {
      return node.map((item, index) => walk(item, `${path}[${index}]`));
    }
    if (isPlainObject(node)) {
      const out: Record<string, unknown> = {};
      for (const [key, raw] of Object.entries(node)) {
        const childPath = path === '' ? key : `${path}.${key}`;
        const kind = options.patternOnly === true ? undefined : SENSITIVE_FIELD_KINDS[key.toLowerCase()];
        if (kind !== undefined && (typeof raw === 'string' || typeof raw === 'number')) {
          const asText = String(raw);
          if (asText.length > 0 && !isSafeSensitiveValue(asText)) {
            out[key] = nextPlaceholder(kind, childPath);
            continue;
          }
        }
        out[key] = walk(raw, childPath);
      }
      return out;
    }
    if (typeof node === 'string') {
      return replaceInline(node, path);
    }
    return node;
  };

  return Object.freeze({ value: walk(input, ''), applied: Object.freeze(applied) });
}

// ---------------------------------------------------------------------------
// PII 扫描
// ---------------------------------------------------------------------------

export interface PiiViolation {
  readonly path: string;
  readonly kind: PiiKind;
  readonly reason: string;
}

/**
 * 带 `g` 的 regex 用 `.test()` 会保留 lastIndex —— 必须先重置，否则漏判。
 * 每次调用前把 `lastIndex` 归零，保证扫描**无跨调用状态**。
 */
function matches(re: RegExp, text: string): boolean {
  re.lastIndex = 0;
  return re.test(text);
}

function findPatternKind(text: string): PiiKind | null {
  if (REDACTED_PLACEHOLDER_RE.test(text)) return null;
  if (matches(ID_CARD_RE, text)) return 'id_card';
  if (matches(PHONE_RE, text)) return 'phone';
  if (matches(EMAIL_RE, text)) return 'email';
  return null;
}

/**
 * 扫描任意 JSON 值，返回**残留 PII** 列表。空数组 = 未发现可识别 PII。
 * 这是 fixture 入库前的门禁：`assertRedacted` 抛错，测试据此断言。
 *
 * **无跨调用状态**：内部模式正则虽带 `g`，但每次判定都先重置 `lastIndex`，
 * 故对同一输入重复调用结果完全一致（见 M-I11 回归测试）。
 */
export function scanForPii(input: unknown): PiiViolation[] {
  const violations: PiiViolation[] = [];

  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (isPlainObject(node)) {
      for (const [key, raw] of Object.entries(node)) {
        const childPath = path === '' ? key : `${path}.${key}`;
        const kind = SENSITIVE_FIELD_KINDS[key.toLowerCase()];
        if (kind !== undefined && typeof raw === 'string' && raw.length > 0 && !isSafeSensitiveValue(raw)) {
          violations.push(Object.freeze({ path: childPath, kind, reason: `敏感字段 "${key}" 的值不是占位符/引用` }));
        }
        if (kind === 'geo' && typeof raw === 'number') {
          violations.push(Object.freeze({ path: childPath, kind, reason: `地理坐标 "${key}" 不得为裸数值` }));
        }
        walk(raw, childPath);
      }
      return;
    }
    if (typeof node === 'string') {
      const kind = findPatternKind(node);
      if (kind !== null) {
        violations.push(Object.freeze({ path: path === '' ? '$' : path, kind, reason: '字符串匹配到 PII 形状' }));
      }
    }
  };

  walk(input, '');
  return violations;
}

/** 扫描并抛错（fixture 入库门禁）。错误信息**只含路径与类别**，不回显明文。 */
export function assertRedacted(input: unknown, label = 'payload'): void {
  const violations = scanForPii(input);
  if (violations.length > 0) {
    const summary = violations.map((v) => `${v.path}(${v.kind})`).join(', ');
    throw new Error(`[MR01_PII_LEAK] ${label} 含未脱敏 PII：${summary}`);
  }
}
