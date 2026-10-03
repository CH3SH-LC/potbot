/*
 * potbot 完整 App —— 「模板管理」面板：接上真实模板平台路由，并**真的能启停**
 *
 * 入口：`GET /api/plugins`（`plugin-routes.ts` 的 `PLUGINS_ROOT`，**已挂载且真服务实测 200**）。
 * 它返回的是**真实清单**（版本 / 能力 / 适配器依赖 / 权限 / 数据范围 / 经验策略），
 * 其中 `kind === 'business_template'` 的就是历史业务模板。
 *
 * 面板真的发一次请求，渲染模板名 / 版本 / 产出格式 / **五态**（已安装 / 启用 / 授权 /
 * 依赖就绪 / 实测支持）。电脑端没接上持久存储时是结构化 503 `plugin_store_unwired`——
 * 面板把它翻成一句人话 + 你能做什么，**不把错误码当正文**。
 *
 * 第二批（FA-WEB-PANEL-DEPTH）：**每个业务模板两件事**——
 *   ① **启用 / 停用**：真发 `POST /api/plugins/:id/enable|disable`，写完重新读取目录核对；
 *   ② **解锁动作**：未就绪的行给一个按钮，真发 `GET /api/plugins/:id` 把电脑端给的
 *      `unlock_actions`（哪一态为假 → 推进它的那一步）原样翻成「你可以：…」。
 *
 * ⚠️ 五态是**五个独立问题**：`ready` 为假时 `false_states` 列出没满足的那几项；
 *    桩实现（`is_stub`）如实标注，不当成"可用"。**本页不代签实测结论**（R233/R240）。
 * ⚠️ 浏览器 / 真机渲染**未验证**。
 *
 * 能力目录 APP-06（模板平台）；合同 R228 / R258。
 */
(function (root, factory) {
  'use strict';
  var api = factory(root && root.PotbotPanels ? root.PotbotPanels : null);
  if (root && typeof root === 'object') root.PotbotPanelTemplates = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function (core) {
  'use strict';

  var ENDPOINT = '/api/plugins';

  /** 五态的五个独立问题（与 `src/plugins/capability-discovery.ts` 的 `DISCOVERY_STATE_KEYS` 同序）。 */
  var STATE_LABELS = [
    ['installed', '已安装', '未安装'],
    ['enabled', '已启用', '未启用'],
    ['authorized', '已授权', '未授权'],
    ['dependencies_ready', '依赖就绪', '依赖未就绪'],
    ['actually_supported', '已实测支持', '未实测支持']
  ];

  /** 某一态的真值。优先读 `states`；只有 `false_states` 时按「不列为假即为真」推。 */
  function stateFlag(five, key) {
    if (!isObject(five)) return null;
    if (isObject(five.states) && typeof five.states[key] === 'boolean') return five.states[key];
    if (Array.isArray(five.false_states)) return five.false_states.indexOf(key) < 0;
    return null;
  }

  /** 未就绪时**默认**能给出的解锁动作（够不着服务端详情时的兜底，不是编的：逐态对应）。 */
  var DERIVED_UNLOCK = {
    installed: '先在电脑端安装这一项（安装 ≠ 启用，装完还要显式启用与授权）',
    enabled: '点这一行右侧的「启用」',
    authorized: '在电脑端完成授权（POST /api/plugins/<模板>/authorize）',
    dependencies_ready: '在电脑端装配缺失的必需适配器，并注入就绪探针',
    actually_supported: '由真实执行器完成一次实测并登记证据（本页不代签实测结论）'
  };

  function isObject(value) {
    return value !== null && typeof value === 'object';
  }

  function textOf(value) {
    return typeof value === 'string' ? value : '';
  }

  function fmt(res) {
    return res && textOf(res.message) !== '' ? res.message : '电脑端这次没有给出原因。';
  }

  function fiveStateText(five) {
    if (!isObject(five)) return '未上报';
    if (!isObject(five.states)) {
      /* 老形状（只有汇总）：仍如实呈现，但不假装知道每一个布尔。 */
      var ready = five.ready === true;
      var falseStates = Array.isArray(five.false_states) ? five.false_states : [];
      var fallback = [ready ? '五态齐备' : '未就绪'];
      if (!ready && falseStates.length > 0) fallback.push('缺：' + falseStates.join(' / '));
      if (five.stub === true) fallback.push('桩实现（未接真实执行器）');
      return fallback.join('；');
    }
    var flags = [];
    for (var i = 0; i < STATE_LABELS.length; i++) {
      var key = STATE_LABELS[i][0];
      var flag = stateFlag(five, key);
      if (flag === null) flags.push('未上报');
      else flags.push(flag ? STATE_LABELS[i][1] : STATE_LABELS[i][2]);
    }
    var text = flags.join(' / ');
    if (five.ready !== true) text += '；未就绪';
    if (five.stub === true) text += '；桩实现（未接真实执行器）';
    return text;
  }

  /** 逐态给出「推进它的那一步」——供行内提示用（服务端详情里还有更权威的一份）。 */
  function derivedUnlock(five) {
    var missing = [];
    if (isObject(five) && Array.isArray(five.false_states)) missing = five.false_states;
    var steps = [];
    for (var i = 0; i < missing.length; i++) {
      var step = DERIVED_UNLOCK[textOf(missing[i])];
      if (step !== undefined) steps.push(step);
    }
    return steps;
  }

  function summarize(body) {
    if (!isObject(body)) return { rows: [], note: '' };
    var plugins = Array.isArray(body.plugins) ? body.plugins : [];
    /* 空态：目录里一个条目都没有——不拿「计数 0」这类元信息冒充内容。 */
    if (plugins.length === 0) return { rows: [], note: '' };

    var rows = [];
    var counts = isObject(body.counts) ? body.counts : null;

    if (counts) {
      rows.push({
        label: '业务模板 / 基础角色',
        value: String(counts.business_templates) + ' 个模板 · ' + String(counts.base_roles) +
          ' 个基础角色（合计 ' + String(counts.total) + '）'
      });
    }

    var templates = 0;
    for (var i = 0; i < plugins.length; i++) {
      var item = isObject(plugins[i]) ? plugins[i] : {};
      if (textOf(item.kind) !== 'business_template') continue;
      templates += 1;
      var formats = Array.isArray(item.produces_file_formats) ? item.produces_file_formats : [];
      var detail = [];
      if (textOf(item.version) !== '') detail.push('版本 ' + textOf(item.version));
      if (formats.length > 0) detail.push('产出 ' + formats.join('/'));
      detail.push(fiveStateText(item.five_state));
      var five = isObject(item.five_state) ? item.five_state : null;
      var unlockSteps = derivedUnlock(five);
      if (unlockSteps.length > 0) detail.push('你是可以推进它的：' + unlockSteps.join('；'));
      rows.push({
        label: textOf(item.display_name) || textOf(item.plugin_id),
        value: (detail.join('；') || '未上报'),
        /* 供「启用 / 停用」「解锁动作」定位这一项；不渲染，只给动作层用。 */
        entryId: textOf(item.plugin_id),
        enabled: stateFlag(five, 'enabled') === true,
        ready: isObject(five) && five.ready === true
      });
    }

    if (rows.length === 0) return { rows: [], note: '' };
    return {
      rows: rows,
      note: templates === 0
        ? '电脑端这次没有返回业务模板（只有基础角色）。'
        : ('共 ' + String(templates) + ' 个业务模板；清单来自电脑端注册目录，不是名字也不是 prompt。' +
          '「启用 / 停用」会真的改电脑端的安装状态。')
    };
  }

  /* ===================== 写侧：启用 / 停用（写完读回核对） ===================== */

  function findRow(out, pluginId) {
    var rows = out && Array.isArray(out.rows) ? out.rows : [];
    for (var i = 0; i < rows.length; i++) {
      if (textOf(rows[i].entryId) === pluginId) return rows[i];
    }
    return null;
  }

  function toggleTemplate(ctx, row) {
    var pluginId = textOf(row && row.entryId);
    var label = textOf(row && row.label);
    if (pluginId === '') {
      core.setActionStatus(ctx, '这一项没有可用的模板编号，电脑端认不出要改哪一项，本次没有发出请求。');
      return Promise.resolve({ outcome: 'no-id' });
    }
    var enabling = !(row && row.enabled === true);
    var verb = enabling ? '启用' : '停用';
    core.setActionStatus(ctx, '正在请求电脑端' + verb + '「' + label + '」…');
    return core.runWrite(ctx, {
      method: 'POST',
      endpoint: ENDPOINT + '/' + encodeURIComponent(pluginId) + (enabling ? '/enable' : '/disable'),
      body: null
    }).then(function (res) {
      if (!res || res.outcome !== 'sent') {
        core.setActionStatus(ctx,
          res && res.outcome === 'no-channel'
            ? res.message
            : ('没能' + verb + '「' + label + '」：' + fmt(res)));
        return res;
      }
      core.setActionStatus(ctx, '电脑端已接受' + verb + '请求；正在重新读取模板目录核对…');
      return core.runRefresh(SPEC, ctx).then(function (out) {
        var now = findRow(out, pluginId);
        if (out.kind !== 'ready' && out.kind !== 'empty') {
          core.setActionStatus(ctx,
            '电脑端已接受' + verb + '请求，但**重新读取目录没成功**（' + textOf(out.kind) + '），' +
            '本次结果**未确认**。可以点「重新读取模板目录」再核对。');
          return { outcome: 'unverified' };
        }
        if (now === null) {
          core.setActionStatus(ctx,
            '电脑端已接受' + verb + '请求；但重新读取的目录里已经没有「' + label + '」，' +
            '本次结果**未确认**。可以点「重新读取模板目录」再核对。');
          return { outcome: 'unverified' };
        }
        if ((now.enabled === true) === enabling) {
          core.setActionStatus(ctx,
            '已' + verb + '「' + label + '」；重新读取目录，**确认状态已经变了**。' +
            (enabling ? '（停用会阻止新建实例，已有实例的既有绑定不受影响。）' : ''));
          return { outcome: 'verified' };
        }
        core.setActionStatus(ctx,
          '电脑端回了成功，但重新读取时「' + label + '」仍是' + (enabling ? '未启用' : '已启用') +
          '——本次结果**未确认**。请稍后点「重新读取模板目录」再核对。');
        return { outcome: 'stale' };
      });
    });
  }

  /** 未就绪时：向电脑端要**权威的**解锁动作（`GET /api/plugins/:id` 的 `unlock_actions`）。 */
  function showUnlock(ctx, row) {
    var pluginId = textOf(row && row.entryId);
    var label = textOf(row && row.label);
    if (pluginId === '') {
      core.setActionStatus(ctx, '这一项没有可用的模板编号，取不到解锁动作。');
      return Promise.resolve({ outcome: 'no-id' });
    }
    if (!core || typeof ctx.request !== 'function') {
      core.setActionStatus(ctx, '页面没有可用的请求通道，本次没有取解锁动作。');
      return Promise.resolve({ outcome: 'no-channel' });
    }
    core.setActionStatus(ctx, '正在向电脑端查询「' + label + '」的未就绪原因与解锁动作…');
    return Promise.resolve(ctx.request('GET', ENDPOINT + '/' + encodeURIComponent(pluginId))).then(
      function (res) {
        if (!res || res.ok !== true) {
          core.setActionStatus(ctx, '没能取到「' + label + '」的解锁动作：' + fmt({ message: core.humanizeBackend(res && res.data ? res.data.code : '', res && res.data ? res.data.unlock : []) }));
          return { outcome: 'failed' };
        }
        var data = isObject(res.data) ? res.data : {};
        var five = isObject(data.five_state) ? data.five_state : null;
        var actions = five && Array.isArray(five.unlock_actions) ? five.unlock_actions : [];
        if (actions.length === 0) {
          core.setActionStatus(ctx,
            '「' + label + '」：电脑端没有给出解锁动作' +
            (five && five.ready === true
              ? '（这一项其实是就绪的，可以直接点「启用」。）'
              : '，可以点「重新读取模板目录」看看最新状态。'));
          return { outcome: 'none' };
        }
        var steps = [];
        for (var i = 0; i < actions.length; i++) {
          var action = isObject(actions[i]) ? actions[i] : {};
          var what = textOf(action.action);
          var why = textOf(action.reason);
          if (what === '') continue;
          steps.push(what + (why === '' ? '' : '（' + why + '）'));
        }
        core.setActionStatus(ctx,
          '「' + label + '」的解锁动作（来自电脑端）：' + (steps.length > 0 ? steps.join('；') : '电脑端没有给出可执行的步骤。'));
        return { outcome: steps.length > 0 ? 'listed' : 'none' };
      },
      function (err) {
        var offline = typeof ctx.offline === 'function' && ctx.offline() === true;
        core.setActionStatus(ctx, '没能取到「' + label + '」的解锁动作：' + core.classifyFailure(err, offline).message);
        return { outcome: 'failed' };
      }
    );
  }

  function rowActions(row, ctx) {
    if (!isObject(row) || textOf(row.entryId) === '') return [];
    var out = [{
      id: row.enabled === true ? 'disable' : 'enable',
      label: row.enabled === true ? '停用' : '启用',
      entryId: textOf(row.entryId),
      onClick: function () { return toggleTemplate(ctx, row); }
    }];
    if (row.ready !== true) {
      out.push({
        id: 'unlock',
        label: '解锁动作',
        entryId: textOf(row.entryId),
        onClick: function () { return showUnlock(ctx, row); }
      });
    }
    return out;
  }

  var SPEC = {
    view: 'templates',
    label: '模板管理',
    endpoint: ENDPOINT,
    pending: '模板目录清单',
    emptyMessage: '电脑端没有返回任何模板或基础角色，暂时没有可显示的内容。',
    summarize: summarize,
    rowActions: rowActions
  };

  var panel = core ? core.createPanel(SPEC) : null;

  if (core && panel) core.register(panel);

  return {
    VIEW: 'templates',
    ENDPOINT: ENDPOINT,
    STATE_LABELS: STATE_LABELS,
    summarize: summarize,
    rowActions: rowActions,
    toggleTemplate: toggleTemplate,
    showUnlock: showUnlock
  };
});
