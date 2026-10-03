#!/usr/bin/env node
/**
 * **满足判据的假服务**（S6 自检夹具的**阳性对照臂**，不是产品代码）。
 *
 * 用途：证明 `scripts/demo/verify-demo.mjs` **不是恒失败的空仪器**——当判据真的满足时，
 * 它必须给出全绿。行为：
 *
 *   - 按 requestId 去重（同 id 同输入 ⇒ 同 taskId；同 id 不同输入 ⇒ 409）；
 *   - 生成与 draft **逐段相同**的 DOCX，下载返回真实字节、真实 sha256、真实长度；
 *   - 未知 artifactId ⇒ 404；超 4000 字请求 ⇒ 400 + 稳定 code；
 *   - health 形状符合合同 v1。
 *
 * 运行：node tests/demo/fixtures/fake-good-service.mjs <port>
 *
 * **注意**：它不调用任何真实模型，只用于校验仪器本身；不得用来代替 live 验收。
 */

import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = Number(process.argv[2] ?? 8798);

const PY_CANDIDATE = 'C:/Users/<user>/AppData/Local/Programs/Python/Python313/python.exe';
const python = process.env.DEMO_PYTHON ?? (existsSync(PY_CANDIDATE) ? PY_CANDIDATE : 'python');

const PY_BUILD = String.raw`
import json, sys, zipfile
spec = json.load(open(sys.argv[1], encoding='utf-8'))
paras = [spec['title']] + list(spec['paragraphs']) + list(spec.get('extras', []))
def esc(t):
    return t.replace('&','&amp;').replace('<','&lt;').replace('>','&gt;')
body = ''.join('<w:p><w:r><w:t xml:space="preserve">%s</w:t></w:r></w:p>' % esc(p) for p in paras)
CT = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
RELS = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
DOC = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
       '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
       + body +
       '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>')
with zipfile.ZipFile(sys.argv[2], 'w', zipfile.ZIP_STORED) as zf:
    zf.writestr('[Content_Types].xml', CT)
    zf.writestr('_rels/.rels', RELS)
    zf.writestr('word/document.xml', DOC)
`;

const workDir = mkdtempSync(join(tmpdir(), 's6-good-'));

function buildDocx(title, paragraphs, extras) {
  const specPath = join(workDir, `spec-${Math.random().toString(36).slice(2)}.json`);
  const docxPath = `${specPath}.docx`;
  writeFileSync(specPath, JSON.stringify({ title, paragraphs, extras }), 'utf8');
  execFileSync(python, ['-c', PY_BUILD, specPath, docxPath], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  return readFileSync(docxPath);
}

/** 交付正文不追加后台来源；阳性对照保留实际草稿文本。 */
function sourceSections(instruction) {
  return [];
}

const byRequestId = new Map();
let seq = 0;

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const path = url.pathname;

  const json = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (path === '/health') {
    return json(200, { ready: true, modelConfigured: true, modelVerified: false, buildId: 'fake-good', bootId: 'boot-1' });
  }

  if (path === '/api/documents' && req.method === 'POST') {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        return json(400, { code: 'bad_json', message: '请求不是合法 JSON', retryable: false });
      }
      const instruction = String(body.instruction ?? '');
      if (instruction.length > 4000) {
        return json(400, { code: 'instruction_too_long', message: '请求超过 4000 字上限', retryable: false });
      }
      const existing = byRequestId.get(body.requestId);
      if (existing) {
        if (existing.instruction !== instruction) {
          return json(409, { code: 'request_id_conflict', message: '同一请求 ID 对应了不同输入', retryable: false });
        }
        return json(202, { requestId: body.requestId, taskId: existing.task.taskId, status: existing.task.status });
      }

      const taskId = `good-task-${++seq}`;
      const title = '读书会邀请函';
      const paragraphs = [`主题：${instruction.slice(0, 40)}`, '期待与你相聚。'];
      const bytes = buildDocx(title, paragraphs, sourceSections(instruction));
      const sha = createHash('sha256').update(bytes).digest('hex');
      const artifactId = `good-artifact-${taskId}`;
      const task = {
        requestId: body.requestId,
        taskId,
        status: 'ready',
        stage: 'ready',
        draft: {
          title,
          paragraphs: paragraphs.map((text, index) => ({ id: `p${index + 1}`, text })),
          provenance: 'model_generated',
        },
        artifact: {
          artifactId,
          filename: 'invitation.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          byteLength: bytes.byteLength,
          sha256: sha,
          downloadPath: `/api/artifacts/${artifactId}/download`,
          taskRevision: 1,
          artifactVersion: 1,
        },
      };
      byRequestId.set(body.requestId, { instruction, task, bytes });
      json(202, { requestId: body.requestId, taskId, status: 'accepted' });
    });
    return undefined;
  }

  if (path.startsWith('/api/tasks/')) {
    const taskId = decodeURIComponent(path.slice('/api/tasks/'.length));
    for (const entry of byRequestId.values()) {
      if (entry.task.taskId === taskId) return json(200, entry.task);
    }
    return json(200, { requestId: '', taskId, status: 'unknown', stage: 'failed' });
  }

  if (path.startsWith('/api/artifacts/') && path.endsWith('/download')) {
    const artifactId = decodeURIComponent(path.slice('/api/artifacts/'.length, -'/download'.length));
    for (const entry of byRequestId.values()) {
      if (entry.task.artifact.artifactId === artifactId) {
        res.writeHead(200, {
          'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'content-disposition': 'attachment; filename="invitation.docx"',
        });
        return res.end(entry.bytes);
      }
    }
    return json(404, { code: 'artifact_not_found', message: '没有这个产物', retryable: false });
  }

  return json(404, { code: 'not_found', message: '没有这个路径', retryable: false });
});

server.listen(port, '127.0.0.1', () => {
  // 打印**实际**绑定端口（port=0 时由系统分配），避免自检时端口冲突。
  console.log(`fake-good-service listening on ${server.address().port}`);
});
