#!/usr/bin/env node
/**
 * **故意做坏的假服务**（S6 自检夹具，不是产品代码）。
 *
 * 用途：证明 `scripts/demo/verify-demo.mjs` 有判别力——它能识破下列"看起来能用"
 * 的假实现。假服务把每一条"不足以通过的现象"都演一遍：
 *
 *   1. 未知 artifactId 返回 200 + 旧字节（拿旧文件顶包）；
 *   2. 下载的 DOCX 正文与任务里公布的 draft **不一致**；
 *   3. 同 requestId 重复提交返回**另一个** taskId（去重失效 ⇒ 可能二次调用模型）；
 *   4. task.draft 存在但 artifact 声明长度与真实字节不符。
 *
 * 运行：node tests/demo/fixtures/fake-bad-service.mjs <port>
 */

import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const port = Number(process.argv[2] ?? 8799);

const PY_CANDIDATE = 'C:/Users/<user>/AppData/Local/Programs/Python/Python313/python.exe';
const python = process.env.DEMO_PYTHON ?? (existsSync(PY_CANDIDATE) ? PY_CANDIDATE : 'python');

/** 造一份"正文与 draft 不符"的 DOCX（内容写死为摊牌用的错文）。 */
function buildMismatchedDocx() {
  const script = String.raw`
import sys, zipfile
CT = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
RELS = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
DOC = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
       '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
       '<w:p><w:r><w:t>无关标题</w:t></w:r></w:p>'
       '<w:p><w:r><w:t>这段正文与接口公布的 draft 完全不符</w:t></w:r></w:p>'
       '<w:p><w:r><w:t>第二段也是错的</w:t></w:r></w:p>'
       '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>')
with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_STORED) as zf:
    zf.writestr('[Content_Types].xml', CT)
    zf.writestr('_rels/.rels', RELS)
    zf.writestr('word/document.xml', DOC)
`;
  const tmp = `${process.env.TEMP ?? '/tmp'}/s6-fake-bad.docx`;
  execFileSync(python, ['-c', script, tmp], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  return tmp;
}

const docxPath = buildMismatchedDocx();
const tasks = new Map();
let seq = 0;

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const path = url.pathname;

  const json = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (path === '/health') {
    return json(200, { ready: true, modelConfigured: true, modelVerified: true, buildId: 'fake', bootId: 'fake-boot' });
  }

  if (path === '/api/documents' && req.method === 'POST') {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        return json(400, { code: 'bad_json', message: '坏 JSON', retryable: false });
      }
      if (String(body.instruction ?? '').length > 4000) {
        return json(400, { code: 'instruction_too_long', message: '请求过长', retryable: false });
      }
      // 故意不做去重：每次提交都开新 taskId。
      const taskId = `fake-task-${++seq}`;
      tasks.set(taskId, {
        requestId: body.requestId,
        taskId,
        status: 'ready',
        stage: 'ready',
        draft: {
          title: '读书会邀请函',
          paragraphs: [
            { id: 'p1', text: '这是接口公布的草稿第一段。' },
            { id: 'p2', text: '这是接口公布的草稿第二段。' },
          ],
          provenance: 'model_generated',
        },
        artifact: {
          artifactId: `fake-artifact-${taskId}`,
          filename: 'invitation.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          byteLength: 999_999, // 故意与真实字节不符
          sha256: '0'.repeat(64), // 故意与真实摘要不符
          downloadPath: `/api/artifacts/fake-artifact-${taskId}/download`,
          taskRevision: 1,
          artifactVersion: 1,
        },
      });
      json(202, { requestId: body.requestId, taskId, status: 'accepted' });
    });
    return undefined;
  }

  if (path.startsWith('/api/tasks/')) {
    const taskId = decodeURIComponent(path.slice('/api/tasks/'.length));
    const task = tasks.get(taskId);
    if (!task) return json(200, { requestId: '', taskId, status: 'unknown', stage: 'failed' });
    return json(200, task);
  }

  if (path.startsWith('/api/artifacts/') && path.endsWith('/download')) {
    // 故意：未知产物也返回 200 + 同一份错文件（"拿旧文件顶包"）。
    res.writeHead(200, {
      'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'content-disposition': 'attachment; filename="invitation.docx"',
    });
    res.end(readFileSync(docxPath));
    return undefined;
  }

  return json(404, { code: 'not_found', message: '没有这个路径', retryable: false });
});

server.listen(port, '127.0.0.1', () => {
  // 打印**实际**绑定端口（port=0 时由系统分配），避免自检时端口冲突。
  console.log(`fake-bad-service listening on ${server.address().port}`);
});
