/*
 * potbot 手机 Word Demo —— 文档预览读取与选区翻译（doc-read.js）
 *
 * 由来（design-05-P8「选区、剪贴板与预览」WF-088，用户可达入口）：
 *   内核侧已经能「导入 DOCX → 按范围改格式 → 导出」，但手机页面上没有任何办法把
 *   **屏幕上的选中文字**翻译成内核认得的范围表达式。本文件补的正是这一段：
 *     ① 把服务端返回的 DOCX 字节解出「段落 / 表格」结构，渲染成可选中的预览；
 *     ② 把用户的选中区翻译成 `src/documents/selection/expression.ts` 的**固定语法**
 *        范围表达式（`全文` / `第N段` / `第N至M段` / `第N个表格` /
 *        `第N个表格第R行第C列` / `指定文本:…`），绝不自造同义词；
 *     ③ 从同一份字节里读出选区的**直接格式**状态（统一 / 混合 / 未指定），
 *        供工具栏做「格式检查」。
 *     ④ （WCF-D72）从同一份字节里按内核同序枚举**节**（`w:sectPr`），
 *        让页面能说清"改的是哪一节"——多节文档下不许含糊（R108）。
 *
 * ## 只读消费，不改服务端
 *   本文件不发任何请求；字节由 app.js 从 `GET /api/sessions/:id/versions/:rev/download`
 *   取回（或用户导入时的本地文件字节）。**服务端没有任何"读回文档内容"的接口**，
 *   页面能读到的唯一权威内容就是它返回的那份 DOCX 字节，因此这里读的就是返回的字节。
 *
 * ## 三条不变量（各有测试）
 *   1. 生成的范围表达式**必须**能被内核 `parseRangeExpression` 解析——测试用真实的
 *      那个函数断言，而不是"看起来像"。翻译不出来时**返回 null**，由上层禁用操作，
 *      不猜、不兜底成语义不同的表达式。
 *   2. 段落序号与内核 `collectParagraphs` 的口径一致：**按文档顺序、含表格单元格内的
 *      段落**（表格按 行 → 列 → 单元格内块 递归展开）。序号错一位就会改错地方。
 *   3. 解压只走标准的 raw DEFLATE（`DecompressionStream('deflate-raw')`），STORE 直接取；
 *      不支持的压缩方法**如实报错**，不返回半份内容。
 *
 * 载入方式：`<script src="./doc-read.js">`（在 app.js 之前）⇒ 挂到全局 `PotbotDocRead`。
 * 测试用 `node:vm` 直接加载本文件（测的就是线上这一份，不复制实现）。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (root && typeof root === 'object') root.PotbotDocRead = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
  'use strict';

  /* ===================== 上限（有界，不静默截断） ===================== */

  /** `word/document.xml` 解压后的字节上限；超出如实报错，不解析半份。 */
  var MAX_DOCUMENT_XML_BYTES = 8 * 1024 * 1024;
  /** ZIP 中央目录里最多扫描多少条目；超出如实报错。 */
  var MAX_ZIP_ENTRIES = 4096;

  /** 固定范围语法（镜像 `src/documents/selection/expression.ts`，**只读镜像**）。 */
  var RANGE_GRAMMAR = Object.freeze({
    whole: '全文',
    body: '正文',
    headings: '标题',
    currentSelection: '当前选区',
    textPrefix: '指定文本:'
  });

  /* ===================== 通用小工具 ===================== */

  function isU8(value) {
    return value instanceof Uint8Array;
  }

  function toU8(value) {
    if (isU8(value)) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    return null;
  }

  function decodeUtf8(bytes) {
    if (typeof TextDecoder === 'function') {
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    }
    /* 没有 TextDecoder 的环境：明确失败，不用手写解码器冒充正确性。 */
    throw new Error('当前环境没有 TextDecoder，无法读取 DOCX 内容。');
  }

  function bytesToBase64(bytes) {
    var view = toU8(bytes);
    if (view === null) return '';
    var chunk = 0x8000;
    var parts = [];
    for (var i = 0; i < view.length; i += chunk) {
      var slice = view.subarray(i, Math.min(i + chunk, view.length));
      var binary = '';
      for (var j = 0; j < slice.length; j++) binary += String.fromCharCode(slice[j]);
      parts.push(btoa(binary));
    }
    return parts.join('');
  }

  /* ===================== ZIP 读取（只取需要的条目） ===================== */

  function readU16(view, offset) {
    return view[offset] | (view[offset + 1] << 8);
  }

  function readU32(view, offset) {
    return (view[offset] | (view[offset + 1] << 8) | (view[offset + 2] << 16) | (view[offset + 3] << 24)) >>> 0;
  }

  /** 找 EOCD（PK\x05\x06），返回中央目录的起点与条目数。 */
  function findCentralDirectory(view) {
    var maxBack = Math.min(view.length, 65557); /* 65535 注释 + 22 固定长 */
    for (var i = view.length - 22; i >= view.length - maxBack && i >= 0; i--) {
      if (view[i] === 0x50 && view[i + 1] === 0x4b && view[i + 2] === 0x05 && view[i + 3] === 0x06) {
        return { offset: readU32(view, i + 16), count: readU16(view, i + 10) };
      }
    }
    return null;
  }

  /** 表项：{name, method, compressedSize, uncompressedSize, localOffset}。 */
  function listEntries(view) {
    var eocd = findCentralDirectory(view);
    if (eocd === null) return null;
    if (eocd.count > MAX_ZIP_ENTRIES) return null;
    var entries = [];
    var cursor = eocd.offset;
    for (var i = 0; i < eocd.count; i++) {
      if (readU32(view, cursor) !== 0x02014b50) return null;
      var method = readU16(view, cursor + 10);
      var compressedSize = readU32(view, cursor + 20);
      var uncompressedSize = readU32(view, cursor + 24);
      var nameLen = readU16(view, cursor + 28);
      var extraLen = readU16(view, cursor + 30);
      var commentLen = readU16(view, cursor + 32);
      var localOffset = readU32(view, cursor + 42);
      var nameBytes = view.subarray(cursor + 46, cursor + 46 + nameLen);
      entries.push({
        name: decodeUtf8(nameBytes),
        method: method,
        compressedSize: compressedSize,
        uncompressedSize: uncompressedSize,
        localOffset: localOffset
      });
      cursor += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  function entryData(view, entry) {
    var at = entry.localOffset;
    if (readU32(view, at) !== 0x04034b50) return null;
    var nameLen = readU16(view, at + 26);
    var extraLen = readU16(view, at + 28);
    var start = at + 30 + nameLen + extraLen;
    var end = start + entry.compressedSize;
    if (end > view.length) return null;
    return view.subarray(start, end);
  }

  /** raw DEFLATE → 字节。用标准的 `DecompressionStream('deflate-raw')`，不引第三方库。 */
  function inflateRaw(bytes) {
    return new Promise(function (resolve, reject) {
      if (typeof DecompressionStream !== 'function') {
        reject(new Error('当前环境不支持 DecompressionStream：无法解压这个 DOCX（STORE 存储的文件仍可读）。'));
        return;
      }
      var stream;
      try {
        stream = new DecompressionStream('deflate-raw');
      } catch (e) {
        reject(new Error('当前环境不支持 deflate-raw 解压：无法读取这个 DOCX。'));
        return;
      }
      var writer = stream.writable.getWriter();
      var reader = stream.readable.getReader();
      var chunks = [];
      var total = 0;

      function pump() {
        return reader.read().then(function (result) {
          if (result.done === true) {
            var out = new Uint8Array(total);
            var offset = 0;
            for (var i = 0; i < chunks.length; i++) {
              out.set(chunks[i], offset);
              offset += chunks[i].byteLength;
            }
            return out;
          }
          var value = result.value;
          var chunk = isU8(value) ? value : new Uint8Array(value);
          chunks.push(chunk);
          total += chunk.byteLength;
          if (total > MAX_DOCUMENT_XML_BYTES) throw new Error('解压后的文档部件超过上限，已放弃读取。');
          return pump();
        });
      }

      pump().then(resolve, reject);
      writer.write(toU8(bytes) || new Uint8Array(0)).then(function () {
        return writer.close();
      })['catch'](function () {
        /* 写出失败由读侧的错误统一报告，这里不吞掉真正的 read 错误。 */
      });
    });
  }

  function readEntry(view, entry) {
    var data = entryData(view, entry);
    if (data === null) return Promise.reject(new Error('DOCX 的 ZIP 结构不完整，无法定位部件。'));
    if (entry.method === 0) return Promise.resolve(data);
    if (entry.method === 8) return inflateRaw(data);
    return Promise.reject(new Error('DOCX 里有不支持的压缩方式（method=' + String(entry.method) + '），已放弃读取。'));
  }

  /* ===================== 轻量 XML 解析（只读，不做命名空间解析） ===================== */

  var ENTITY_MAP = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

  function decodeEntities(text) {
    if (text.indexOf('&') === -1) return text;
    return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, function (whole, body) {
      if (body.charAt(0) === '#') {
        var code = body.charAt(1) === 'x' || body.charAt(1) === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
        if (!isFinite(code) || code < 0 || code > 0x10ffff) return whole;
        try {
          return String.fromCodePoint(code);
        } catch (e) {
          return whole;
        }
      }
      var mapped = ENTITY_MAP[body];
      return mapped === undefined ? whole : mapped;
    });
  }

  function localNameOf(name) {
    var colon = name.indexOf(':');
    return colon === -1 ? name : name.slice(colon + 1);
  }

  function parseAttributes(raw) {
    var attrs = {};
    var re = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    var match;
    while ((match = re.exec(raw)) !== null) {
      var name = match[1];
      var value = match[3] !== undefined ? match[3] : match[4];
      attrs[name] = decodeEntities(value === undefined ? '' : value);
    }
    return attrs;
  }

  /**
   * 解析 XML 成轻量节点树。
   * 节点形如 `{name, local, attrs, children}`，文本形如 `{text}`。
   * 不认识的结构（注释 / 处理指令 / CDATA）**原样跳过或当文本**，不抛错。
   */
  function parseXml(text) {
    var rootNode = { name: '#document', local: '#document', attrs: {}, children: [] };
    var stack = [rootNode];
    var i = 0;
    var length = text.length;

    function pushText(value) {
      if (value.length === 0) return;
      var top = stack[stack.length - 1];
      var last = top.children[top.children.length - 1];
      if (last && last.text !== undefined) last.text += value;
      else top.children.push({ text: value });
    }

    while (i < length) {
      var lt = text.indexOf('<', i);
      if (lt === -1) {
        pushText(decodeEntities(text.slice(i)));
        break;
      }
      if (lt > i) pushText(decodeEntities(text.slice(i, lt)));

      if (text.startsWith('<!--', lt)) {
        var commentEnd = text.indexOf('-->', lt);
        i = commentEnd === -1 ? length : commentEnd + 3;
        continue;
      }
      if (text.startsWith('<?', lt)) {
        var piEnd = text.indexOf('?>', lt);
        i = piEnd === -1 ? length : piEnd + 2;
        continue;
      }
      if (text.startsWith('<![CDATA[', lt)) {
        var cdataEnd = text.indexOf(']]>', lt);
        var cdata = cdataEnd === -1 ? text.slice(lt + 9) : text.slice(lt + 9, cdataEnd);
        pushText(cdata);
        i = cdataEnd === -1 ? length : cdataEnd + 3;
        continue;
      }
      if (text.startsWith('<!', lt)) {
        var declEnd = text.indexOf('>', lt);
        i = declEnd === -1 ? length : declEnd + 1;
        continue;
      }

      var gt = findTagEnd(text, lt + 1);
      if (gt === -1) {
        pushText(decodeEntities(text.slice(lt)));
        break;
      }
      var body = text.slice(lt + 1, gt);
      i = gt + 1;

      if (body.charAt(0) === '/') {
        var closeName = body.slice(1).trim();
        for (var s = stack.length - 1; s >= 1; s--) {
          if (stack[s].name === closeName) {
            stack.length = s;
            break;
          }
        }
        continue;
      }

      var selfClosing = body.charAt(body.length - 1) === '/';
      var inner = selfClosing ? body.slice(0, -1) : body;
      var spaceAt = inner.search(/[\s]/);
      var name = spaceAt === -1 ? inner : inner.slice(0, spaceAt);
      var attrText = spaceAt === -1 ? '' : inner.slice(spaceAt);
      if (name === '') continue;

      var node = {
        name: name,
        local: localNameOf(name),
        attrs: parseAttributes(attrText),
        children: []
      };
      stack[stack.length - 1].children.push(node);
      if (!selfClosing) stack.push(node);
    }
    return rootNode;
  }

  /** 找标签结束的 `>`，跳过引号里的 `>`。 */
  function findTagEnd(text, from) {
    var quote = '';
    for (var i = from; i < text.length; i++) {
      var ch = text.charAt(i);
      if (quote !== '') {
        if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === '>') return i;
    }
    return -1;
  }

  function childElements(node) {
    var out = [];
    for (var i = 0; i < node.children.length; i++) {
      if (node.children[i].name !== undefined) out.push(node.children[i]);
    }
    return out;
  }

  function findChild(node, local) {
    var kids = childElements(node);
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].local === local) return kids[i];
    }
    return null;
  }

  function textOf(node) {
    var out = '';
    for (var i = 0; i < node.children.length; i++) {
      var child = node.children[i];
      if (child.text !== undefined) out += child.text;
      else out += textOf(child);
    }
    return out;
  }

  /* ===================== 直接格式读取 ===================== */

  var TOGGLE_TAGS = {
    bold: 'b',
    italic: 'i',
    strike: 'strike',
    doubleStrike: 'dstrike',
    caps: 'caps',
    smallCaps: 'smallCaps'
  };

  /** `w:b` / `w:b w:val="0"` / 无 ⇒ 'on' / 'off' / 'unset'（R206：三种含义不合并）。 */
  function toggleState(rPr, tag) {
    if (rPr === null) return 'unset';
    var element = findChild(rPr, tag);
    if (element === null) return 'unset';
    var raw = element.attrs['w:val'];
    if (raw === undefined) raw = element.attrs['val'];
    if (raw === undefined) return 'on';
    var value = String(raw).toLowerCase();
    if (value === '0' || value === 'false' || value === 'off') return 'off';
    return 'on';
  }

  /** 从 `w:pPr` 读段落级直接格式（**只读**直接格式，不展开样式继承）。 */
  function readParagraphDirect(pPr) {
    var out = {
      alignment: null,
      lineSpacing: null,
      spacingBefore: null,
      spacingAfter: null,
      firstLineIndent: null,
      hangingIndent: null,
      leftIndent: null,
      rightIndent: null
    };
    if (pPr === null) return out;
    var jc = findChild(pPr, 'jc');
    if (jc !== null) out.alignment = jc.attrs['w:val'] || jc.attrs['val'] || null;
    var spacing = findChild(pPr, 'spacing');
    if (spacing !== null) {
      out.lineSpacing = spacing.attrs['w:line'] !== undefined
        ? { line: spacing.attrs['w:line'], rule: spacing.attrs['w:lineRule'] || null }
        : null;
      out.spacingBefore = spacing.attrs['w:before'] !== undefined ? spacing.attrs['w:before'] : null;
      out.spacingAfter = spacing.attrs['w:after'] !== undefined ? spacing.attrs['w:after'] : null;
    }
    var ind = findChild(pPr, 'ind');
    if (ind !== null) {
      out.firstLineIndent = ind.attrs['w:firstLine'] !== undefined
        ? { kind: 'length', twips: ind.attrs['w:firstLine'] }
        : (ind.attrs['w:firstLineChars'] !== undefined ? { kind: 'chars', value: ind.attrs['w:firstLineChars'] } : null);
      out.hangingIndent = ind.attrs['w:hanging'] !== undefined ? { twips: ind.attrs['w:hanging'] } : null;
      out.leftIndent = ind.attrs['w:left'] !== undefined ? { twips: ind.attrs['w:left'] } : null;
      out.rightIndent = ind.attrs['w:right'] !== undefined ? { twips: ind.attrs['w:right'] } : null;
    }
    return out;
  }

  /* ===================== 结构提取 ===================== */

  function readRun(runElement) {
    var rPr = findChild(runElement, 'rPr');
    var text = '';
    var kids = childElements(runElement);
    for (var i = 0; i < kids.length; i++) {
      var child = kids[i];
      if (child.local === 't') text += textOf(child);
      else if (child.local === 'tab') text += '\t';
      else if (child.local === 'br') text += '\n';
    }
    var flags = {};
    for (var key in TOGGLE_TAGS) {
      if (Object.prototype.hasOwnProperty.call(TOGGLE_TAGS, key)) {
        flags[key] = toggleState(rPr, TOGGLE_TAGS[key]);
      }
    }
    return { text: text, flags: flags };
  }

  /** 收集一段里的 run（跳过 `w:pPr`，它不会含 `w:r`）。 */
  function collectRuns(node, out) {
    var kids = childElements(node);
    for (var i = 0; i < kids.length; i++) {
      var child = kids[i];
      if (child.local === 'pPr') continue;
      if (child.local === 'r') out.push(child);
      else collectRuns(child, out);
    }
    return out;
  }

  function buildParagraph(pElement, cellRef) {
    var pPr = findChild(pElement, 'pPr');
    var runElements = collectRuns(pElement, []);
    var runs = [];
    var text = '';
    for (var i = 0; i < runElements.length; i++) {
      var run = readRun(runElements[i]);
      runs.push(run);
      text += run.text;
    }
    var state = {};
    for (var key in TOGGLE_TAGS) {
      if (Object.prototype.hasOwnProperty.call(TOGGLE_TAGS, key)) {
        var values = {};
        for (var r = 0; r < runs.length; r++) values[runs[r].flags[key]] = true;
        if (runs.length === 0) state[key] = 'unset';
        else if (Object.keys(values).length === 1) state[key] = Object.keys(values)[0];
        else state[key] = 'mixed';
      }
    }
    return {
      text: text,
      runs: runs,
      direct: readParagraphDirect(pPr),
      toggle: state,
      styleRef: pPr !== null && findChild(pPr, 'pStyle') !== null
        ? (findChild(pPr, 'pStyle').attrs['w:val'] || null)
        : null,
      cell: cellRef || null
    };
  }

  /**
   * 按文档顺序走一遍 body 的直接子块。
   * 段落序号与内核 `collectParagraphs` 完全一致：**表格按 行 → 列 → 单元格内块 递归**。
   */
  function walkBlocks(children, context) {
    var blocks = [];
    for (var i = 0; i < children.length; i++) {
      var child = children[i];
      if (child.local === 'p') {
        context.paragraphIndex += 1;
        var paragraph = buildParagraph(child, context.cellRef);
        paragraph.index = context.paragraphIndex;
        context.paragraphs.push(paragraph);
        blocks.push({ kind: 'paragraph', paragraphIndex: paragraph.index });
        /* 段级节属性（`w:pPr/w:sectPr`）：这一段的**末尾**结束了一节（R108）。 */
        collectParagraphSection(child, context);
      } else if (child.local === 'tbl') {
        context.tableIndex += 1;
        var table = walkTable(child, context, context.tableIndex);
        context.tables.push(table);
        blocks.push({ kind: 'table', index: table.index });
      } else if (child.local === 'sectPr') {
        /* body 级节属性：文档**最后一节**的属性，排在所有段级节属性之后。 */
        context.sections.push(readSection(child, context.sections.length));
      }
      /* 其它（w:bookmarkStart / …）：不建模，跳过。 */
    }
    return blocks;
  }

  function walkTable(tblElement, context, tableIndex) {
    var rows = [];
    var rowElements = [];
    var kids = childElements(tblElement);
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].local === 'tr') rowElements.push(kids[i]);
    }
    for (var r = 0; r < rowElements.length; r++) {
      var cells = [];
      var cellElements = [];
      var rowKids = childElements(rowElements[r]);
      for (var c = 0; c < rowKids.length; c++) {
        if (rowKids[c].local === 'tc') cellElements.push(rowKids[c]);
      }
      for (var k = 0; k < cellElements.length; k++) {
        var cellRef = { table: tableIndex, row: r + 1, column: k + 1 };
        var outer = context.cellRef;
        context.cellRef = cellRef;
        var cellBlocks = walkBlocks(childElements(cellElements[k]), context);
        context.cellRef = outer;
        var paragraphIndexes = [];
        for (var b = 0; b < cellBlocks.length; b++) {
          if (cellBlocks[b].kind === 'paragraph') paragraphIndexes.push(cellBlocks[b].paragraphIndex);
        }
        var texts = [];
        for (var t = 0; t < paragraphIndexes.length; t++) {
          texts.push(context.paragraphs[paragraphIndexes[t] - 1].text);
        }
        cells.push({
          table: tableIndex,
          row: r + 1,
          column: k + 1,
          paragraphIndexes: paragraphIndexes,
          text: texts.join('\n')
        });
      }
      rows.push({ row: r + 1, cells: cells });
    }
    return { index: tableIndex, rows: rows };
  }

  /* ===================== 节（w:sectPr）读取 ===================== */

  /**
   * 节的**枚举规则**（必须与内核 `src/documents/docx/import.ts` 完全同序，
   * 否则页面上选的「第 N 节」会指到服务端模型的另一节）：
   *
   *   - 按文档顺序遇到 `w:p > w:pPr > w:sectPr` ⇒ 追加一节（import.ts 第 740–746 行）；
   *   - 表格单元格里的段落走**同一条**规则（import.ts 第 931 行 `parseCell` → `parseParagraph`）；
   *   - `w:body > w:sectPr`（body 级）在所有段级之后再追加一节（import.ts 第 662–665 行）。
   *
   * 因此索引是 0 起的连续整数，与内核 `model.sections` 的下标**一一对应**。
   */
  function collectParagraphSection(pElement, context) {
    var pPr = findChild(pElement, 'pPr');
    if (pPr === null) return;
    var sectPr = findChild(pPr, 'sectPr');
    if (sectPr === null) return;
    context.sections.push(readSection(sectPr, context.sections.length));
  }

  /** 读一个属性：先试带前缀的 `w:x`，再试裸名 `x`（与其它读取函数同一条口径）。 */
  function attrOf(node, local) {
    if (node === null) return null;
    var prefixed = node.attrs['w:' + local];
    if (prefixed !== undefined) return prefixed;
    var bare = node.attrs[local];
    return bare === undefined ? null : bare;
  }

  /** 读一个属性并转成整数（读不出来返回 `null`，**不猜 0**）。 */
  function intAttrOf(node, local) {
    var raw = attrOf(node, local);
    if (raw === null || raw === undefined || String(raw).trim() === '') return null;
    if (!/^-?[0-9]+$/.test(String(raw).trim())) return null;
    var value = Number(String(raw).trim());
    return isFinite(value) ? value : null;
  }

  /**
   * `w:sectPr` → 页面侧的节视图。
   *
   * 只读**已声明**的东西：没写 `w:pgSz` 就是 `null`（"未指定"就是未指定，R118），
   * 不替文档补一个 A4。方向优先取 `w:orient` 属性；没有该属性时**由宽高推断**，
   * 并在 `orientationSource` 里如实标 `'inferred'`（不让推断结果冒充文档声明）。
   */
  function readSection(sectPr, index) {
    var pgSz = findChild(sectPr, 'pgSz');
    var pageSize = null;
    if (pgSz !== null) {
      var widthTwips = intAttrOf(pgSz, 'w');
      var heightTwips = intAttrOf(pgSz, 'h');
      var declared = attrOf(pgSz, 'orient');
      var orientation = null;
      var orientationSource = null;
      if (declared === 'portrait' || declared === 'landscape') {
        orientation = declared;
        orientationSource = 'attr';
      } else if (widthTwips !== null && heightTwips !== null) {
        orientation = widthTwips > heightTwips ? 'landscape' : 'portrait';
        orientationSource = 'inferred';
      }
      pageSize = {
        widthTwips: widthTwips,
        heightTwips: heightTwips,
        orientation: orientation,
        orientationSource: orientationSource
      };
    }

    var pgMar = findChild(sectPr, 'pgMar');
    var margins = null;
    if (pgMar !== null) {
      margins = {
        top: intAttrOf(pgMar, 'top'),
        right: intAttrOf(pgMar, 'right'),
        bottom: intAttrOf(pgMar, 'bottom'),
        left: intAttrOf(pgMar, 'left'),
        gutter: intAttrOf(pgMar, 'gutter')
      };
    }

    var pgNumType = findChild(sectPr, 'pgNumType');
    var pageNumbering = null;
    if (pgNumType !== null) {
      var fmt = attrOf(pgNumType, 'fmt');
      pageNumbering = {
        format: fmt === null ? null : String(fmt),
        start: intAttrOf(pgNumType, 'start')
      };
    }

    return {
      index: index,
      number: index + 1,
      pageSize: pageSize,
      margins: margins,
      pageNumbering: pageNumbering
    };
  }

  /** 一节的**只读摘要**（给页面上「第 N 节：…」那一行用；显示层，不参与判据）。 */
  function describeSection(section) {
    var parts = [];
    if (section.pageSize !== null) {
      var orientation = section.pageSize.orientation;
      parts.push(orientation === 'landscape' ? '横向' : (orientation === 'portrait' ? '纵向' : '方向未指定'));
      if (section.pageSize.widthTwips !== null && section.pageSize.heightTwips !== null) {
        parts.push(section.pageSize.widthTwips + '×' + section.pageSize.heightTwips + ' 缇');
      } else {
        parts.push('纸张尺寸未指定');
      }
    } else {
      parts.push('页面设置未指定');
    }
    parts.push(section.margins === null ? '页边距未指定' : '页边距已设置');
    if (section.pageNumbering === null) {
      parts.push('页码设置未指定');
    } else {
      parts.push('页码格式 ' + (section.pageNumbering.format === null ? '（沿用默认）' : section.pageNumbering.format) +
        (section.pageNumbering.start === null ? '（接上一节）' : '（从 ' + section.pageNumbering.start + ' 起）'));
    }
    return parts.join(' · ');
  }

  /* ===================== 对外：读结构 ===================== */

  /**
   * 把 DOCX 字节解成预览结构。
   * 返回 `{ok:true, preview}` 或 `{ok:false, code, message}`——**失败一定带原因**，
   * 不返回半份结构（R164：不静默截断）。
   */
  function readDocxStructure(bytes) {
    var view = toU8(bytes);
    if (view === null || view.length === 0) {
      return Promise.resolve({ ok: false, code: 'empty_bytes', message: '没有拿到文件字节，无法预览。' });
    }
    var entries;
    try {
      entries = listEntries(view);
    } catch (e) {
      entries = null;
    }
    if (entries === null) {
      return Promise.resolve({ ok: false, code: 'not_a_zip', message: '这份文件不是可读的 DOCX（ZIP 结构不完整）。' });
    }
    var documentEntry = null;
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].name === 'word/document.xml') documentEntry = entries[i];
    }
    if (documentEntry === null) {
      return Promise.resolve({ ok: false, code: 'no_document_part', message: 'DOCX 里没有 word/document.xml，无法预览。' });
    }
    if (documentEntry.uncompressedSize > MAX_DOCUMENT_XML_BYTES) {
      return Promise.resolve({
        ok: false,
        code: 'too_large',
        message: '文档部件超过预览上限（' + MAX_DOCUMENT_XML_BYTES + ' 字节），已放弃预览。'
      });
    }

    return readEntry(view, documentEntry).then(function (xmlBytes) {
      var xml;
      try {
        xml = decodeUtf8(xmlBytes);
      } catch (e) {
        return { ok: false, code: 'decode_failed', message: e && e.message ? e.message : '文档部件解码失败。' };
      }
      var document = parseXml(xml);
      var body = null;
      var stack = [document];
      while (stack.length > 0 && body === null) {
        var node = stack.pop();
        var kids = childElements(node);
        for (var k = 0; k < kids.length; k++) {
          if (kids[k].local === 'body') { body = kids[k]; break; }
          stack.push(kids[k]);
        }
      }
      if (body === null) {
        return { ok: false, code: 'no_body', message: 'DOCX 的正文部件里没有 w:body，无法预览。' };
      }

      var context = {
        paragraphIndex: 0, tableIndex: 0, paragraphs: [], tables: [], cellRef: null,
        /* 节的枚举顺序与内核 `import.ts` 一致（见 `collectParagraphSection` 的说明）。 */
        sections: []
      };
      var blocks = walkBlocks(childElements(body), context);
      return {
        ok: true,
        preview: {
          paragraphCount: context.paragraphs.length,
          paragraphs: context.paragraphs,
          tables: context.tables,
          blocks: blocks,
          sections: context.sections,
          sectionCount: context.sections.length
        }
      };
    }, function (error) {
      return {
        ok: false,
        code: 'inflate_failed',
        message: error && error.message ? error.message : 'DOCX 解压失败。'
      };
    });
  }

  /* ===================== 对外：选区 → 范围表达式 ===================== */

  /**
   * 把选中区翻译成内核对得上的范围表达式。
   *
   * `selection` 形状（由 app.js 从真实 DOM Selection 读出）：
   *   { text, startPara, startOffset, endPara, endOffset }
   *   - `startPara` / `endPara`：1 起的文档段落序号（与 `collectParagraphs` 同口径）；
   *   - offset：在该段文本里的码位偏移；范围不落在段落边界上时为 `null` 段落。
   *
   * 返回 `{ expression, kind, note }` 或 `null`（翻不出来时**返回 null**，
   * 由上层禁用操作；绝不生成一个语义不同的近似表达式）。
   */
  function selectionToRangeExpression(preview, selection) {
    if (preview === null || selection === null || selection === undefined) return null;
    var text = typeof selection.text === 'string' ? selection.text : '';
    if (text.replace(/\s+/g, '').length === 0) return null;

    var startPara = normalizeIndex(selection.startPara, preview.paragraphCount);
    var endPara = normalizeIndex(selection.endPara, preview.paragraphCount);
    if (startPara === null || endPara === null || startPara > endPara) return null;

    var startOffset = typeof selection.startOffset === 'number' ? selection.startOffset : null;
    var endOffset = typeof selection.endOffset === 'number' ? selection.endOffset : null;

    var startText = preview.paragraphs[startPara - 1].text;
    var endText = preview.paragraphs[endPara - 1].text;
    var startsAtParaStart = startOffset === 0;
    var endsAtParaEnd = endOffset === codePointLength(endText);

    /* ① 整篇：从第一段开头到最后一段末尾。 */
    if (startPara === 1 && endPara === preview.paragraphCount &&
        startsAtParaStart && endsAtParaEnd && preview.paragraphCount > 1) {
      return { expression: RANGE_GRAMMAR.whole, kind: 'whole_document', note: '覆盖全部 ' + preview.paragraphCount + ' 段。' };
    }

    /* ② 整张表格 / 整个单元格（按表格序号与行列定位，比段落序号更贴近用户想说的东西）。 */
    var cellExpression = tableExpressionFor(preview, startPara, endPara, startsAtParaStart, endsAtParaEnd);
    if (cellExpression !== null) return cellExpression;

    /* ③ 单段：整段 ⇒ 第N段；段内子串 ⇒ 指定文本:…（同一段内不会跨段匹配）。 */
    if (startPara === endPara) {
      if (startsAtParaStart && endsAtParaEnd) {
        return { expression: '第' + startPara + '段', kind: 'paragraph', note: '整段覆盖。' };
      }
      if (text.indexOf('\n') !== -1 || text.indexOf('\t') !== -1) {
        return null; /* 跨行子串无法用固定语法表达（内核按段落拼接文本匹配）。 */
      }
      return {
        expression: RANGE_GRAMMAR.textPrefix + text,
        kind: 'text',
        note: '段内子串；若文档里出现多处，内核会回 ambiguous，需要改用整段范围。'
      };
    }

    /* ④ 多段且两端都对齐到段落边界 ⇒ 第N至M段。 */
    if (startsAtParaStart && endsAtParaEnd) {
      return { expression: '第' + startPara + '至' + endPara + '段', kind: 'paragraph_range', note: '整段区间。' };
    }

    return null;
  }

  function normalizeIndex(value, paragraphCount) {
    if (typeof value !== 'number' || !isFinite(value)) return null;
    var index = Math.floor(value);
    if (index < 1 || index > paragraphCount) return null;
    return index;
  }

  function codePointLength(text) {
    return Array.from(String(text)).length;
  }

  /** 整格 / 整表选中 ⇒ 表格类表达式；否则 null。 */
  function tableExpressionFor(preview, startPara, endPara, startsAtParaStart, endsAtParaEnd) {
    if (!startsAtParaStart || !endsAtParaEnd) return null;
    var first = preview.paragraphs[startPara - 1];
    var last = preview.paragraphs[endPara - 1];
    if (first.cell === null || last.cell === null) return null;
    if (first.cell.table !== last.cell.table) return null;

    var table = null;
    for (var i = 0; i < preview.tables.length; i++) {
      if (preview.tables[i].index === first.cell.table) table = preview.tables[i];
    }
    if (table === null) return null;

    /* 整表：覆盖了这个表格的全部段落。 */
    var all = [];
    for (var r = 0; r < table.rows.length; r++) {
      for (var c = 0; c < table.rows[r].cells.length; c++) {
        for (var p = 0; p < table.rows[r].cells[c].paragraphIndexes.length; p++) {
          all.push(table.rows[r].cells[c].paragraphIndexes[p]);
        }
      }
    }
    if (all.length > 0 && startPara === all[0] && endPara === all[all.length - 1]) {
      return { expression: '第' + table.index + '个表格', kind: 'table', note: '整表覆盖。' };
    }

    if (first.cell.row === last.cell.row && first.cell.column === last.cell.column) {
      var cellIndexes = null;
      for (var rr = 0; rr < table.rows.length; rr++) {
        for (var cc = 0; cc < table.rows[rr].cells.length; cc++) {
          var cell = table.rows[rr].cells[cc];
          if (cell.row === first.cell.row && cell.column === first.cell.column) cellIndexes = cell.paragraphIndexes;
        }
      }
      if (cellIndexes !== null && cellIndexes.length > 0 &&
          startPara === cellIndexes[0] && endPara === cellIndexes[cellIndexes.length - 1]) {
        return {
          expression: '第' + first.cell.table + '个表格第' + first.cell.row + '行第' + first.cell.column + '列',
          kind: 'table_cell',
          note: '整个单元格覆盖。'
        };
      }
    }
    return null;
  }

  /* ===================== 对外：格式检查（选区的直接格式） ===================== */

  var TOGGLE_LABELS = {
    bold: '加粗',
    italic: '斜体',
    strike: '删除线',
    doubleStrike: '双删除线',
    caps: '全部大写',
    smallCaps: '小型大写'
  };

  /**
   * 统计选区的直接格式状态：每个开关属性给出
   * `'on' | 'off' | 'unset' | 'mixed'`（R206：四态不合并成一种含义）。
   */
  function formatStateOf(preview, selection) {
    var result = { toggles: {}, paragraph: {}, paragraphCount: 0, source: 'docx-bytes' };
    if (preview === null || selection === null || selection === undefined) return result;
    var startPara = normalizeIndex(selection.startPara, preview.paragraphCount);
    var endPara = normalizeIndex(selection.endPara, preview.paragraphCount);
    if (startPara === null || endPara === null) return result;
    result.paragraphCount = endPara - startPara + 1;

    var keys = Object.keys(TOGGLE_LABELS);
    for (var k = 0; k < keys.length; k++) {
      var seen = {};
      for (var p = startPara; p <= endPara; p++) seen[preview.paragraphs[p - 1].toggle[keys[k]]] = true;
      /* 段落级已折叠成单值或 'mixed'；跨段再合并一次。 */
      var values = Object.keys(seen);
      result.toggles[keys[k]] = values.length === 1 ? values[0] : 'mixed';
    }

    var fields = ['alignment', 'lineSpacing', 'spacingBefore', 'spacingAfter', 'firstLineIndent', 'hangingIndent', 'leftIndent', 'rightIndent'];
    for (var f = 0; f < fields.length; f++) {
      var field = fields[f];
      var first = JSON.stringify(preview.paragraphs[startPara - 1].direct[field]);
      var same = true;
      for (var q = startPara; q <= endPara; q++) {
        if (JSON.stringify(preview.paragraphs[q - 1].direct[field]) !== first) { same = false; break; }
      }
      result.paragraph[field] = same
        ? { state: preview.paragraphs[startPara - 1].direct[field] === null ? 'unset' : 'on',
            value: preview.paragraphs[startPara - 1].direct[field] }
        : { state: 'mixed', value: null };
    }
    return result;
  }

  return {
    MAX_DOCUMENT_XML_BYTES: MAX_DOCUMENT_XML_BYTES,
    RANGE_GRAMMAR: RANGE_GRAMMAR,
    TOGGLE_LABELS: TOGGLE_LABELS,
    readDocxStructure: readDocxStructure,
    selectionToRangeExpression: selectionToRangeExpression,
    formatStateOf: formatStateOf,
    /* 节的显示层（只读；节索引的语义由 readDocxStructure 的 sections 决定）。 */
    describeSection: describeSection,
    bytesToBase64: bytesToBase64,
    codePointLength: codePointLength,
    /* 只读内部件，供测试与调试接缝使用（不改变行为）。 */
    _parseXml: parseXml
  };
});
