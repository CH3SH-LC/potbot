/*
 * potbot 完整 App —— 「记忆管理」面板：接上真实记忆路由，并**真的能忘记一条**
 *
 * 入口：`GET /api/memory/entries?owner_id=…&limit=…&offset=…`（`memory-routes.ts` 的
 * `MEMORY_ROOT`，**已挂载且真服务实测 200**）。此前「记忆管理」视图只有一句
 * 「本页已预留入口」，用户够不到任何真实条目。
 *
 * 面板真的发一次请求，把**真实记忆条目**渲染成行（条数 / 命中总数 / 上限 / 每条的类型、
 * 状态与文本）。取不到时按四态如实分流：端口没接上是 `memory_not_ready`
 * （正文是一句人话 + 你能做什么，码只进「查看原因」），不是空白数据。
 *
 * 第二批（FA-WEB-PANEL-DEPTH）：**每条记忆一行「忘记」**——
 *   ① 先弹**二次确认层**（危险操作）；**点「取消」什么都不发**；
 *   ② 点「确认」才真发 `POST /api/memory/entries/:id`（`{ owner_id, action: 'forget' }`）；
 *   ③ 写完**再读回核对**：「写成功」不等于「真的不在了」——重新拉一次清单，
 *      还在就如实说「结果未确认」，不在才说「已确认忘记」。
 *
 * ⚠️ 一次读取受实例上限约束（R237）：面板固定用小页（默认 20 条），
 *    越界时电脑端会结构化拒绝（`injection_limit_violation`），面板照实显示。
 * ⚠️ 浏览器 / 真机渲染**未验证**。
 *
 * 能力目录 APP-05（记忆）；合同 R258。
 */
(function (root, factory) {
  'use strict';
  var api = factory(root && root.PotbotPanels ? root.PotbotPanels : null);
  if (root && typeof root === 'object') root.PotbotPanelMemory = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function (core) {
  'use strict';

  var OWNER_ID = 'local-owner';
  var PAGE_LIMIT = 20;

  function isObject(value) {
    return value !== null && typeof value === 'object';
  }

  function textOf(value) {
    return typeof value === 'string' ? value : '';
  }

  function numOf(value) {
    return typeof value === 'number' && isFinite(value) ? value : null;
  }

  function endpoint() {
    return '/api/memory/entries?owner_id=' + encodeURIComponent(OWNER_ID) +
      '&limit=' + String(PAGE_LIMIT) + '&offset=0';
  }

  function entryEndpoint(memoryId) {
    return '/api/memory/entries/' + encodeURIComponent(textOf(memoryId));
  }

  function clip(text, max) {
    var value = textOf(text);
    if (value.length <= max) return value;
    return value.slice(0, max) + '…';
  }

  /** 从响应体里取条目数组（不是数组就是 `null`——**不把别的东西当条目**）。 */
  function entriesOf(body) {
    if (!isObject(body) || !Array.isArray(body.entries)) return null;
    return body.entries;
  }

  function summarize(body) {
    if (!isObject(body)) return { rows: [], note: '' };
    var entries = Array.isArray(body.entries) ? body.entries : [];
    var matchInfo = isObject(body.paging) ? body.paging : null;
    var matched = matchInfo && numOf(matchInfo.total_matched) !== null ? matchInfo.total_matched : null;
    /* 空态：这一页没有条目，且电脑端也说没有匹配到——不拿「归属」这类元信息冒充内容。 */
    if (entries.length === 0 && (matched === null || matched === 0)) return { rows: [], note: '' };

    var rows = [];

    if (textOf(body.owner_id) !== '') rows.push({ label: '归属', value: textOf(body.owner_id) });

    var paging = matchInfo;
    var total = paging && numOf(paging.total_matched) !== null ? String(paging.total_matched) : '未知';
    rows.push({
      label: '本次读取',
      value: String(entries.length) + ' 条（电脑端匹配到 ' + total + ' 条）'
    });

    if (paging && typeof paging.has_more === 'boolean') {
      rows.push({ label: '还有更多', value: paging.has_more ? '是（可继续取下一页）' : '否' });
    }

    var limits = isObject(body.limits) ? body.limits : null;
    if (limits) {
      rows.push({
        label: '本次注入上限',
        value: '最多 ' + String(numOf(limits.max_items) === null ? '?' : limits.max_items) + ' 条 / ' +
          String(numOf(limits.max_chars) === null ? '?' : limits.max_chars) + ' 字符'
      });
    }

    for (var i = 0; i < entries.length; i++) {
      var entry = isObject(entries[i]) ? entries[i] : {};
      var kind = textOf(entry.kind) || '条目';
      var status = textOf(entry.status);
      var label = '#' + String(i + 1) + ' ' + kind + (status === '' ? '' : '（' + status + '）');
      var row = {
        label: label,
        value: clip(entry.text, 80) || '（无文本）',
        /* 供「忘记」动作定位这一条；**不渲染**，只给动作层用。 */
        entryId: textOf(entry.memory_id)
      };
      rows.push(row);
    }

    if (rows.length === 0) return { rows: [], note: '' };
    return { rows: rows, note: '条目来自电脑端的真实记忆存储；点某条右侧的「忘记」可以真的删掉它（会先让你确认）。' };
  }

  /* ===================== 写侧：忘记一条（二次确认 + 写完读回核对） ===================== */

  function fmt(res) {
    return res && textOf(res.message) !== '' ? res.message : '电脑端这次没有给出原因。';
  }

  /**
   * 写成功**不等于**它真的不在了：重新拉一次清单，逐条比 `memory_id`。
   * 三种结论分开说——**不把「没核对上」说成「已成功」**。
   */
  function verifyForgotten(ctx, memoryId, rowLabel) {
    if (!core || typeof core.runRefresh !== 'function') return null;
    return core.runRefresh(SPEC, ctx).then(function (out) {
      var entries = entriesOf(out ? out.data : null);
      if (out.kind !== 'ready' && out.kind !== 'empty') {
        core.setActionStatus(ctx,
          '电脑端已接受「忘记」请求，但**重新读取清单没成功**（' + textOf(out.kind) + '），' +
          '本次结果**未确认**。可以点「重新读取记忆条目」再核对一次。');
        return { outcome: 'unverified', kind: out.kind };
      }
      if (entries === null) {
        core.setActionStatus(ctx,
          '电脑端已接受「忘记」请求；但重新读取的响应里没有条目清单，' +
          '本次结果**未确认**。可以点「重新读取记忆条目」再核对一次。');
        return { outcome: 'unverified', kind: out.kind };
      }
      for (var i = 0; i < entries.length; i++) {
        var entry = isObject(entries[i]) ? entries[i] : {};
        if (textOf(entry.memory_id) === memoryId) {
          core.setActionStatus(ctx,
            '电脑端回了成功，但重新读取时「' + textOf(rowLabel) + '」**仍在清单里**——' +
            '本次结果**未确认**（可能只是还没落定）。请稍后点「重新读取记忆条目」再核对。');
          return { outcome: 'stale' };
        }
      }
      core.setActionStatus(ctx,
        '已忘记「' + textOf(rowLabel) + '」；重新读取清单后，**确认它已经不在了**。');
      return { outcome: 'verified' };
    });
  }

  function forgetEntry(ctx, row) {
    var memoryId = textOf(row && row.entryId);
    var label = textOf(row && row.label);
    if (memoryId === '') {
      core.setActionStatus(ctx, '这一条没有可用的记忆编号，电脑端认不出要忘记哪一条，本次没有发出请求。');
      return Promise.resolve({ outcome: 'no-id' });
    }
    return core.askConfirm(ctx, {
      title: '忘记这条记忆？',
      message: '将请求电脑端忘记「' + label + '」。忘记后它不再被注入，且**不可撤销**。' +
        '这一步只是确认——点「取消」不会发出任何请求。',
      confirmLabel: '忘记它',
      cancelLabel: '取消'
    }).then(function (confirmed) {
      if (confirmed !== true) {
        core.setActionStatus(ctx, '已取消：**没有发送任何请求**，这条记忆还在。');
        return { outcome: 'cancelled' };
      }
      core.setActionStatus(ctx, '正在请求电脑端忘记「' + label + '」…');
      return core.runWrite(ctx, {
        method: 'POST',
        endpoint: entryEndpoint(memoryId),
        body: { owner_id: OWNER_ID, action: 'forget' }
      }).then(function (res) {
        if (res && res.outcome === 'sent') {
          var verified = verifyForgotten(ctx, memoryId, label);
          return verified === null ? res : verified;
        }
        core.setActionStatus(ctx,
          res && res.outcome === 'no-channel'
            ? res.message
            : ('没能忘记「' + label + '」：' + fmt(res)));
        return res;
      });
    });
  }

  function rowActions(row, ctx) {
    if (!isObject(row) || textOf(row.entryId) === '') return [];
    return [{
      id: 'forget',
      label: '忘记',
      entryId: textOf(row.entryId),
      onClick: function () { return forgetEntry(ctx, row); }
    }];
  }

  var SPEC = {
    view: 'memory',
    label: '记忆管理',
    endpoint: endpoint(),
    pending: '记忆条目清单',
    emptyMessage: '电脑端还没有任何记忆条目，或这一页没有内容。',
    summarize: summarize,
    rowActions: rowActions
  };

  var panel = core ? core.createPanel(SPEC) : null;

  if (core && panel) core.register(panel);

  return {
    VIEW: 'memory',
    OWNER_ID: OWNER_ID,
    PAGE_LIMIT: PAGE_LIMIT,
    endpoint: endpoint,
    entryEndpoint: entryEndpoint,
    summarize: summarize,
    rowActions: rowActions,
    forgetEntry: forgetEntry
  };
});
