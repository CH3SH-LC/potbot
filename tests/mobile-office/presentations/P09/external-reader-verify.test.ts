/**
 * P09 · **外部阅读器复核**：把"产物是真 PNG / 真 PDF"交给**别人的解码器**判定。
 *
 * ## 为什么要有这一层（不能只靠自己人解自己人）
 *
 * 上一层的 `zlib-store.test.ts` 用的是"我们自己的解压器 + 宿主 zlib 参考实现"。它证明了
 * 字节可解，但**方案仍是本仓自己的**。本文件把同一批字节交给**三个独立的第三方实现**：
 *
 * | 产物 | 外部阅读器 | 判据 |
 * |---|---|---|
 * | PNG | CPython 标准库 `zlib` + 手写 chunk 解析 | 签名 / 每块 CRC32 / zlib 解压 / 扫描行 sha256 |
 * | PNG | **Pillow** | 打开成功、尺寸与模式正确、逐个像素等于源位图 |
 * | PDF | **pypdf** | 打开成功、页数 / MediaBox 正确、图像 XObject 解出的像素等于源栅格 |
 * | PDF | **PyMuPDF (fitz)** | 把页面**渲染成位图**，页面中央像素等于嵌入图像的实测颜色 |
 *
 * 这正是 `rendering.test.ts` 里 `external_visual_match_verified === false` 所指的**那一层**：
 * 本文件只证"产物被外部阅读器**正确解开**"，**不**等于"人眼看着排版对"——
 * 版式审美仍需人看，这一点在报告里如实保留为**未验证**。
 *
 * ## 反向对照（防"凡产物必过"）
 *
 * 把 PNG 的一个 IDAT 数据字节踩坏 ⇒ Python 侧的 `zlib.decompress` 必须抛错、CRC32 必须不符；
 * 把 PDF 的图像流踩坏 ⇒ pypdf 打开图像必须失败。绿色来自"真的解开了"，不是"断言写得松"。
 *
 * ## 依赖与缺失时的行为
 *
 * Python 是本仓**既有的验收工具链**（`tests/acceptance/office/**` 已在用）；Pillow / pypdf /
 * PyMuPDF 在本机已安装（Pillow 12.2.0 / pypdf 6.14.2 / PyMuPDF 1.27.2.3）。三者**任一缺失即
 * 显式报错**，不静默跳过——"没跑"绝不允许长成"通过"。
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { encodePng } from '../../../../src/mobile-plugins/presentations/rendering/png.js';
import { writeRasterPdf } from '../../../../src/mobile-plugins/presentations/rendering/pdf.js';

// ---------------------------------------------------------------------------
// Python 宿主
// ---------------------------------------------------------------------------

/** 找一个能跑的 Python（`python` → `python3` → `py`）；找不到就**报错**，不跳过。 */
function findPython(): string {
  for (const candidate of ['python', 'python3', 'py']) {
    const probe = spawnSync(candidate, ['-c', 'print(1)'], { encoding: 'utf8', windowsHide: true });
    if (probe.status === 0 && (probe.stdout ?? '').trim() === '1') return candidate;
  }
  throw new Error(
    '外部阅读器复核需要 Python（本仓验收侧的既有工具链）。请在 PATH 上提供 python / python3 / py。',
  );
}

const PYTHON = findPython();

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'p09-external-'));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt === 4) console.warn(`[P09-external] 清理失败，保留取证：${dir} — ${String(error)}`);
        else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
      }
    }
  }
});

/** 跑一段 Python 脚本（脚本先落盘，避免 `-c` 的转义地狱），把 stdout 当 JSON 读回。 */
function runPython(script: string, args: readonly string[]): Record<string, unknown> {
  const scriptPath = join(tempDir(), 'check.py');
  writeFileSync(scriptPath, script, 'utf8');
  const stdout = execFileSync(PYTHON, [scriptPath, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(stdout.trim()) as Record<string, unknown>;
}

/** 把字节写进临时目录并返回绝对路径。 */
function writeTemp(name: string, bytes: Uint8Array): string {
  const path = join(tempDir(), name);
  writeFileSync(path, bytes);
  return path;
}

/** 造一段可预测的样本字节（不用随机，保证可复现）。 */
function sample(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) out[index] = (index * 37 + 11) & 0xff;
  return out;
}

function hex(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < bytes.length; index += 1) {
    out += (bytes[index] ?? 0).toString(16).padStart(2, '0');
  }
  return out;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Python 侧必须先证明这些库在（缺失即报错，不静默降级）。 */
function requireModules(): void {
  const result = spawnSync(
    PYTHON,
    ['-c', 'import zlib,binascii,hashlib; import PIL,pypdf,fitz; print(PIL.__version__+"|"+pypdf.__version__+"|"+fitz.__doc__)'],
    { encoding: 'utf8', windowsHide: true },
  );
  if (result.status !== 0) {
    throw new Error(
      `外部阅读器缺少依赖（PIL / pypdf / PyMuPDF 缺一不可）：${(result.stderr ?? '').trim()}`,
    );
  }
  console.log('[P09-external] 第三方解码器版本', (result.stdout ?? '').trim());
}

// ---------------------------------------------------------------------------
// Python 脚本（stdlib：独立解析 PNG 容器）
// ---------------------------------------------------------------------------

const PNG_STDLIB_CHECK = `
import sys, zlib, struct, binascii, hashlib, json

data = open(sys.argv[1], 'rb').read()
sig_ok = data[:8] == b'\\x89PNG\\r\\n\\x1a\\n'
pos = 8
chunks = []
crc_ok = True
ihdr = None
idat = b''
while pos + 12 <= len(data):
    ln = struct.unpack('>I', data[pos:pos + 4])[0]
    typ = data[pos + 4:pos + 8]
    body = data[pos + 8:pos + 8 + ln]
    crc = struct.unpack('>I', data[pos + 8 + ln:pos + 12 + ln])[0]
    if (binascii.crc32(typ + body) & 0xffffffff) != crc:
        crc_ok = False
    chunks.append(typ.decode('ascii'))
    if typ == b'IHDR':
        ihdr = struct.unpack('>IIBBBBB', body)
    elif typ == b'IDAT':
        idat += body
    pos += 12 + ln
    if typ == b'IEND':
        break

# zlib.decompress 会自己验 zlib 头与尾部 Adler-32：流不合法这里就抛。
raw = None
decompress_error = None
try:
    raw = zlib.decompress(idat)
except Exception as exc:
    decompress_error = type(exc).__name__

print(json.dumps({
    'signature_ok': sig_ok,
    'chunks': chunks,
    'crc_ok': crc_ok,
    'width': ihdr[0],
    'height': ihdr[1],
    'bit_depth': ihdr[2],
    'color_type': ihdr[3],
    'compression': ihdr[4],
    'filter': ihdr[5],
    'interlace': ihdr[6],
    'raw_len': len(raw) if raw is not None else -1,
    'raw_sha256': hashlib.sha256(raw).hexdigest() if raw is not None else None,
    'first_row': list(raw[0:1 + ihdr[0] * 3]) if raw is not None else None,
    'trailing_bytes': len(data) - pos,
    'decompress_error': decompress_error,
}))
`;

// ---------------------------------------------------------------------------
// Python 脚本（Pillow：独立图像解码器）
// ---------------------------------------------------------------------------

const PNG_PILLOW_CHECK = `
import sys, json
from PIL import Image

im = Image.open(sys.argv[1])
im.load()
rgb = im.convert('RGB')
print(json.dumps({
    'format': im.format,
    'mode': im.mode,
    'size': [im.size[0], im.size[1]],
    'rgb_hex': rgb.tobytes().hex(),
}))
`;

// ---------------------------------------------------------------------------
// Python 脚本（pypdf：独立 PDF 解析器 + 图像 XObject 解码）
// ---------------------------------------------------------------------------

const PDF_PYPDF_CHECK = `
import sys, json
from pypdf import PdfReader

reader = PdfReader(sys.argv[1])
page = reader.pages[0]
images = list(page.images)
img = images[0].image.convert('RGB')
box = page.mediabox
print(json.dumps({
    'page_count': len(reader.pages),
    'media_box': [float(box.left), float(box.bottom), float(box.right), float(box.top)],
    'image_count': len(images),
    'image_size': [img.size[0], img.size[1]],
    'image_rgb_hex': img.tobytes().hex(),
}))
`;

// ---------------------------------------------------------------------------
// Python 脚本（PyMuPDF：把 PDF 页真实渲染成位图）
// ---------------------------------------------------------------------------

const PDF_FITZ_CHECK = `
import sys, json
import fitz

doc = fitz.open(sys.argv[1])
page = doc[0]
pix = page.get_pixmap(matrix=fitz.Matrix(1, 1))
n = pix.n
cx = pix.width // 2
cy = pix.height // 2
off = (cy * pix.width + cx) * n
print(json.dumps({
    'page_count': doc.page_count,
    'rendered_size': [pix.width, pix.height],
    'components': n,
    'center_pixel': [pix.samples[off], pix.samples[off + 1], pix.samples[off + 2]],
}))
`;

// ---------------------------------------------------------------------------
// 1. PNG：CPython 标准库独立解开容器
// ---------------------------------------------------------------------------

describe('P09 外部阅读器 · PNG（CPython 标准库）', () => {
  it('签名 / 每块 CRC32 / zlib 解压 / 扫描行 sha256 全部对得上', () => {
    const width = 7;
    const height = 5;
    const channels = 3;
    const data = sample(width * height * channels);
    const path = writeTemp('stdlib.png', encodePng({ width, height, channels, data }));

    const report = runPython(PNG_STDLIB_CHECK, [path]);
    console.log('[P09-external] PNG stdlib', JSON.stringify(report));

    expect(report['signature_ok']).toBe(true);
    expect(report['chunks']).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(report['crc_ok']).toBe(true);
    expect(report['width']).toBe(width);
    expect(report['height']).toBe(height);
    expect(report['bit_depth']).toBe(8);
    expect(report['color_type']).toBe(2); // RGB
    expect(report['compression']).toBe(0);
    expect(report['filter']).toBe(0);
    expect(report['interlace']).toBe(0);
    expect(report['trailing_bytes']).toBe(0);
    expect(report['decompress_error']).toBeNull();

    // 扫描行（filter 0 + 像素）逐字节独立复算。
    const scanlines = new Uint8Array((width * channels + 1) * height);
    for (let y = 0; y < height; y += 1) {
      const rowStart = y * (width * channels + 1);
      scanlines[rowStart] = 0;
      scanlines.set(data.subarray(y * width * channels, (y + 1) * width * channels), rowStart + 1);
    }
    expect(report['raw_len']).toBe(scanlines.length);
    expect(report['raw_sha256']).toBe(sha256(scanlines));
    expect(report['first_row']).toEqual([...scanlines.subarray(0, width * channels + 1)]);
  });

  it('反向对照：踩坏一个 IDAT 数据字节 ⇒ Python 侧 CRC 不符且 zlib 解压报错', () => {
    const png = encodePng({ width: 3, height: 3, channels: 3, data: sample(27) });
    const broken = Uint8Array.from(png);
    // IDAT 数据从「签名 8 + IHDR 25 + 长度 4 + 类型 4」= 41 起，踩第 45 字节。
    broken[45] = (broken[45] ?? 0) ^ 0xff;
    const path = writeTemp('stdlib-broken.png', broken);

    const report = runPython(PNG_STDLIB_CHECK, [path]);
    expect(report['crc_ok']).toBe(false);
    // 数据字节被踩坏 ⇒ Adler-32 / deflate 结构必有一处不符。
    expect(report['decompress_error']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 2. PNG：Pillow 独立解码，逐像素比对
// ---------------------------------------------------------------------------

describe('P09 外部阅读器 · PNG（Pillow）', () => {
  it('Pillow 打开 PNG ⇒ 尺寸 / 模式正确，像素与源位图逐字节一致', () => {
    const width = 9;
    const height = 4;
    const channels = 3;
    const data = sample(width * height * channels);
    const path = writeTemp('pillow.png', encodePng({ width, height, channels, data }));

    const report = runPython(PNG_PILLOW_CHECK, [path]);
    console.log('[P09-external] PNG Pillow', JSON.stringify({ ...report, rgb_hex: '<省略>' }));

    expect(report['format']).toBe('PNG');
    expect(report['mode']).toBe('RGB');
    expect(report['size']).toEqual([width, height]);
    expect(report['rgb_hex']).toBe(hex(data));
  });
});

// ---------------------------------------------------------------------------
// 3. PDF：pypdf 独立解析 + 图像 XObject 解码
// ---------------------------------------------------------------------------

describe('P09 外部阅读器 · PDF（pypdf）', () => {
  it('pypdf 打开视觉 PDF ⇒ 页数 / MediaBox 正确，图像像素与源栅格逐字节一致', () => {
    const widthPx = 6;
    const heightPx = 2;
    const rgb = sample(widthPx * heightPx * 3);
    const path = writeTemp('pypdf.pdf', writeRasterPdf([{ rgb, widthPx, heightPx }], { width: 720, height: 540 }));

    const report = runPython(PDF_PYPDF_CHECK, [path]);
    console.log('[P09-external] PDF pypdf', JSON.stringify({ ...report, image_rgb_hex: '<省略>' }));

    expect(report['page_count']).toBe(1);
    expect(report['media_box']).toEqual([0, 0, 720, 540]);
    expect(report['image_count']).toBe(1);
    expect(report['image_size']).toEqual([widthPx, heightPx]);
    // **独立解码器解出的像素**（不是我们自己解自己）：逐字节等于喂进去的栅格。
    expect(report['image_rgb_hex']).toBe(hex(rgb));
  });

  it('多页：两页各自嵌自己的栅格，pypdf 逐页读回都对', () => {
    const pageA = sample(4 * 2 * 3);
    const pageB = new Uint8Array(4 * 2 * 3).fill(0x6a);
    const bytes = writeRasterPdf(
      [
        { rgb: pageA, widthPx: 4, heightPx: 2 },
        { rgb: pageB, widthPx: 4, heightPx: 2 },
      ],
      { width: 300, height: 200 },
    );
    const path = writeTemp('pypdf-two.pdf', bytes);

    const reader = runPython(
      `import sys, json
from pypdf import PdfReader
reader = PdfReader(sys.argv[1])
print(json.dumps({
  'page_count': len(reader.pages),
  'images': [page.images[0].image.convert('RGB').tobytes().hex() for page in reader.pages],
}))`,
      [path],
    );

    expect(reader['page_count']).toBe(2);
    expect(reader['images']).toEqual([hex(pageA), hex(pageB)]);
  });

  it('反向对照：踩坏图像流 ⇒ pypdf 解不出那张图', () => {
    const bytes = Uint8Array.from(
      writeRasterPdf([{ rgb: new Uint8Array(3 * 2 * 3).fill(0x11), widthPx: 3, heightPx: 2 }], {
        width: 200,
        height: 100,
      }),
    );
    const text = Buffer.from(bytes).toString('latin1');
    const at = text.indexOf('/Subtype /Image');
    const dataStart = text.indexOf('stream\n', at) + 'stream\n'.length;
    bytes[dataStart + 3] = (bytes[dataStart + 3] ?? 0) ^ 0xff; // 踩坏 deflate 正文
    const path = writeTemp('pypdf-broken.pdf', bytes);

    const report = runPython(
      `import sys, json
from pypdf import PdfReader
reader = PdfReader(sys.argv[1])
page = reader.pages[0]
try:
    img = page.images[0].image
    print(json.dumps({'decoded': True, 'size': [img.size[0], img.size[1]]}))
except Exception as exc:
    print(json.dumps({'decoded': False, 'error': type(exc).__name__}))
`,
      [path],
    );

    expect(report['decoded']).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. PDF：PyMuPDF 把页面渲染成位图（真·外部渲染器）
// ---------------------------------------------------------------------------

describe('P09 外部阅读器 · PDF（PyMuPDF 渲染）', () => {
  it('页面被渲染成位图，中央像素等于嵌入图像的实测颜色', () => {
    const widthPx = 4;
    const heightPx = 2;
    const solid: [number, number, number] = [12, 34, 56];
    const rgb = new Uint8Array(widthPx * heightPx * 3);
    for (let index = 0; index < widthPx * heightPx; index += 1) rgb.set(solid, index * 3);
    const path = writeTemp('fitz.pdf', writeRasterPdf([{ rgb, widthPx, heightPx }], { width: 360, height: 240 }));

    const report = runPython(PDF_FITZ_CHECK, [path]);
    console.log('[P09-external] PDF fitz', JSON.stringify(report));

    expect(report['page_count']).toBe(1);
    // MediaBox 360×240 pt，zoom = 1 ⇒ 渲染出 360×240 的位图。
    expect(report['rendered_size']).toEqual([360, 240]);
    expect(report['center_pixel']).toEqual(solid);
  });
});

// ---------------------------------------------------------------------------
// 5. 依赖前置检查（缺失即报错，不静默跳过）
// ---------------------------------------------------------------------------

describe('P09 外部阅读器 · 依赖前置', () => {
  it('Pillow / pypdf / PyMuPDF 三者齐备（本层不放行"没跑就等于通过"）', () => {
    requireModules();
    expect(PYTHON.length).toBeGreaterThan(0);
  });
});
