/**
 * dsh-relay-think 浏览器半。
 *
 * 两块界面，都基于宿主半的只读/只写 JSON 接口（/relay-think/state、/relay-think/apply）：
 *
 *  1. settings.models.provider-card（key = llm-pi-ai）：
 *     Models 页每张中转站提供商卡片里多一块「思考强度」面板，逐模型选择
 *     「不声明 / 两档 / 三档 / 四档 / 全档 / 非推理」，以及该路由的默认档位。
 *     选择后写进 llm-pi-ai 的 reasoningEfforts，输入框模型菜单随即出现思考强度子菜单。
 *
 *  2. conversation.input.right：
 *     输入框右侧的「思考 · 高」小胶囊，只对当前有思考档位的模型显示；
 *     点开即可切换当前会话的思考强度（走宿主的 session.selectModel）。
 *
 * 依赖只有平台种子模块 react / react-dom。
 */

window.__ModuleLoader__.load({
  id: 'dsh-relay-think',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    var React = require('react');
    var ReactDOM = require('react-dom');
    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useMemo = React.useMemo;
    var useRef = React.useRef;
    var useCallback = React.useCallback;
    var useSyncExternalStore = React.useSyncExternalStore;

    /** 本插件的字典命名空间。 */
    var NS = 'relay-think';

    /** 宿主注入的启动数据：设置命名空间与接口基路径。 */
    var BOOT = (typeof globalThis.__DSH_RELAY_THINK__ === 'object' && globalThis.__DSH_RELAY_THINK__ !== null)
      ? globalThis.__DSH_RELAY_THINK__
      : {};
    var SETTINGS_NS = typeof BOOT.settingsNs === 'string' && BOOT.settingsNs !== '' ? BOOT.settingsNs : 'llm-pi-ai';
    var API_BASE = typeof BOOT.apiBase === 'string' && BOOT.apiBase !== '' ? BOOT.apiBase : '/relay-think';

    /** 界面里可选的预设（宿主 plan.js 的同一组 id）。 */
    var PRESETS = ['standard', 'dual', 'wide', 'full'];
    /** 默认档位下拉的候选（不含 off：off 通过“不设置”表达）。 */
    var DEFAULT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

    // ── 文案 ──────────────────────────────────────────────────────────────

    var zh = {
      'card.title': '思考强度',
      'card.summary': '已声明 {declared}/{total} 个模型',
      'card.description': '为中转站模型声明可切换的思考档位。声明后，输入框的模型菜单里会出现「思考强度」子菜单；这些档位会作为 reasoningEfforts 写进 llm-pi-ai 配置。',
      'card.readonly': '该提供商来自非 profile 配置层，无法在本页编辑。',
      'card.error': '读取失败：{message}',
      'card.empty': '这个提供商还没有模型。',
      'card.routeError': '路由诊断：{message}',
      'card.defaultEffort': '默认档位',
      'card.defaultEffortHint': '模型选择器打开时预选的那一档（写入 providers.<route>.reasoning）',
      'card.noneDefault': '不设置（由中转站决定）',
      'card.refresh': '刷新',
      'card.uncatalogued': '目录未提供该模型信息',
      'preset.none': '不声明（无思考档）',
      'preset.standard': '常用三档（低/中/高）',
      'preset.dual': '两档（低/高）',
      'preset.wide': '四档（极简/低/中/高）',
      'preset.full': '全档（极简…最高）',
      'preset.custom': '自定义（保持现状）',
      'preset.disabled': '声明为非推理模型',
      'status.none': '未声明',
      'status.disabled': '非推理',
      'status.levels': '档位：{levels}',
      'status.catalog': '目录：{levels}',
      'status.pending': '已写入，等待目录刷新',
      'status.supported': '目录已生效',
      'applied': '已保存，模型选择器会立即生效',
      'applyFailed': '保存失败：{message}',
      'saving': '保存中…',
      'level.off': '关闭',
      'level.minimal': '极简',
      'level.low': '低',
      'level.medium': '中',
      'level.high': '高',
      'level.xhigh': '极高',
      'level.max': '最高',
      'effort.default': '默认',
      'chip.label': '思考 {level}',
      'chip.aria': '调整思考强度，当前 {level}',
      'chip.menu': '思考强度',
      'chip.error': '切换失败：{message}',
      'chip.noLevels': '当前模型没有思考档位',
    };

    var en = {
      'card.title': 'Thinking effort',
      'card.summary': '{declared}/{total} models declared',
      'card.description': 'Declare switchable thinking levels for relay models. Once declared, the composer model menu shows an Effort section; the levels are written into the llm-pi-ai reasoningEfforts config.',
      'card.readonly': 'This provider comes from a non-profile config layer, so it cannot be edited here.',
      'card.error': 'Failed to load: {message}',
      'card.empty': 'This provider has no models yet.',
      'card.routeError': 'Route diagnostic: {message}',
      'card.defaultEffort': 'Default effort',
      'card.defaultEffortHint': 'Preselected when the model picker opens (written to providers.<route>.reasoning)',
      'card.noneDefault': 'Not set (provider decides)',
      'card.refresh': 'Refresh',
      'card.uncatalogued': 'The catalog provides no info for this model',
      'preset.none': 'Not declared (no effort)',
      'preset.standard': 'Standard (low/medium/high)',
      'preset.dual': 'Dual (low/high)',
      'preset.wide': 'Wide (minimal/low/medium/high)',
      'preset.full': 'Full (minimal…max)',
      'preset.custom': 'Custom (keep as is)',
      'preset.disabled': 'Declare as non-reasoning',
      'status.none': 'Not declared',
      'status.disabled': 'Non-reasoning',
      'status.levels': 'Levels: {levels}',
      'status.catalog': 'Catalog: {levels}',
      'status.pending': 'Written, waiting for catalog refresh',
      'status.supported': 'Catalog active',
      'applied': 'Saved; the model picker takes effect immediately',
      'applyFailed': 'Save failed: {message}',
      'saving': 'Saving…',
      'level.off': 'Off',
      'level.minimal': 'Minimal',
      'level.low': 'Low',
      'level.medium': 'Medium',
      'level.high': 'High',
      'level.xhigh': 'Extra high',
      'level.max': 'Max',
      'effort.default': 'Default',
      'chip.label': 'Think {level}',
      'chip.aria': 'Adjust thinking effort, currently {level}',
      'chip.menu': 'Thinking effort',
      'chip.error': 'Switch failed: {message}',
      'chip.noLevels': 'This model has no effort levels',
    };

    // ── 主题样式 ──────────────────────────────────────────────────────────

    var STYLE_ID = 'dsh-relay-think-style';
    var STYLE_TEXT = [
      '.drt-card{margin-top:10px;padding-top:10px;border-top:.5px solid var(--dsw-alias-border-l2);font-family:var(--dsw-font-family);}',
      '.drt-card>summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--dsw-alias-label-primary);}',
      '.drt-card>summary::-webkit-details-marker{display:none;}',
      '.drt-card>summary::before{content:"▸";font-size:10px;color:var(--dsw-alias-label-dimmed);transition:transform .15s;}',
      '.drt-card[open]>summary::before{transform:rotate(90deg);}',
      '.drt-summary-meta{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary);}',
      '.drt-body{padding-top:8px;display:flex;flex-direction:column;gap:8px;}',
      '.drt-desc{margin:0;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary);}',
      '.drt-notice{margin:0;font-size:11.5px;color:var(--dsw-alias-state-warn-primary);}',
      '.drt-route-error{margin:0;font-size:11px;color:var(--dsw-alias-state-warn-primary);white-space:pre-wrap;}',
      '.drt-default-row{display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--dsw-alias-label-secondary);}',
      '.drt-default-row select{font-size:11.5px;padding:2px 6px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}',
      '.drt-models{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;}',
      '.drt-model{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);}',
      '.drt-model-main{min-width:0;flex:1;display:flex;flex-direction:column;gap:2px;}',
      '.drt-model-id{font-size:11.5px;color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.drt-model-name{font-size:10.5px;color:var(--dsw-alias-label-dimmed);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.drt-model-status{font-size:10.5px;color:var(--dsw-alias-label-secondary);}',
      '.drt-model-status.is-warn{color:var(--dsw-alias-state-warn-primary);}',
      '.drt-model-status.is-ok{color:var(--dsw-alias-state-success-primary);}',
      '.drt-model select{flex:none;max-width:210px;font-size:11.5px;padding:3px 6px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}',
      '.drt-model select:disabled{opacity:.6;cursor:progress;}',
      '.drt-footer{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--dsw-alias-label-dimmed);min-height:16px;}',
      '.drt-refresh{border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:11px;padding:0;}',
      '.drt-refresh:hover{color:var(--dsw-alias-label-primary);}',
      '.drt-chip-wrap{position:relative;display:inline-flex;align-items:center;}',
      '.drt-chip{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px;border-radius:12px;border:.5px solid var(--dsw-alias-border-l4);background:transparent;color:var(--dsw-alias-label-secondary);font-size:11.5px;font-family:var(--dsw-font-family);cursor:pointer;white-space:nowrap;}',
      '.drt-chip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}',
      '.drt-chip:disabled{opacity:.6;cursor:progress;}',
      '.drt-chip-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary);flex:none;}',
      '.drt-menu{position:fixed;z-index:60;min-width:148px;padding:4px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l4);box-shadow:var(--dsw-elevation-prominent);display:flex;flex-direction:column;gap:1px;}',
      '.drt-menu-title{padding:4px 8px 2px;font-size:10.5px;color:var(--dsw-alias-label-dimmed);}',
      '.drt-menu-item{display:flex;align-items:center;gap:8px;border:0;background:transparent;text-align:left;padding:5px 8px;border-radius:6px;font-size:12px;color:var(--dsw-alias-label-primary);cursor:pointer;font-family:var(--dsw-font-family);}',
      '.drt-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover);}',
      '.drt-menu-item[aria-checked="true"]{color:var(--dsw-alias-state-success-primary);}',
      '.drt-menu-check{margin-left:auto;font-size:10px;}',
      '.drt-menu-error{padding:4px 8px;font-size:10.5px;color:var(--dsw-alias-state-warn-primary);max-width:260px;}',
    ].join('');

    function installStyles() {
      if (typeof document === 'undefined') return;
      if (document.getElementById(STYLE_ID) !== null) return;
      var style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = STYLE_TEXT;
      document.head.appendChild(style);
    }

    // ── 接口 ──────────────────────────────────────────────────────────────

    function requestJson(suffix, options) {
      var init = options === undefined ? {} : options;
      var headers = { 'content-type': 'application/json' };
      return fetch(API_BASE + suffix, {
        method: init.method === undefined ? 'GET' : init.method,
        credentials: 'same-origin',
        headers: headers,
        body: init.body === undefined ? undefined : init.body,
      }).then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (payload) {
          if (response.ok === true && payload !== null && typeof payload === 'object') return payload;
          var message = payload !== null && typeof payload === 'object' && payload.error !== undefined && typeof payload.error.message === 'string'
            ? payload.error.message
            : 'HTTP ' + String(response.status);
          var error = new Error(message);
          error.payload = payload;
          error.status = response.status;
          throw error;
        });
      });
    }

    function messageOf(error) {
      return error instanceof Error ? error.message : String(error);
    }

    // ── 小工具 ────────────────────────────────────────────────────────────

    function levelName(level, t) {
      return t('level.' + level);
    }

    function levelNames(levels, t) {
      if (!Array.isArray(levels) || levels.length === 0) return '';
      return levels.map(function (level) { return levelName(level, t); }).join(' / ');
    }

    function format(t, key, values) {
      return t(key, values);
    }

    // ── Models 页：提供商卡片里的思考强度面板 ─────────────────────────────

    function ProviderThinkingCard(props) {
      var t = props.t;
      var provider = props.provider;
      var providerId = provider !== null && typeof provider === 'object' && typeof provider.provider === 'string' ? provider.provider : null;

      var stateBox = useState({ status: 'loading', data: null, error: null });
      var state = stateBox[0];
      var setState = stateBox[1];
      var busyBox = useState(null);
      var busy = busyBox[0];
      var setBusy = busyBox[1];
      var noteBox = useState(null);
      var note = noteBox[0];
      var setNote = noteBox[1];
      var openBox = useState(false);
      var open = openBox[0];
      var setOpen = openBox[1];

      var load = useCallback(function () {
        if (providerId === null) {
          setState({ status: 'ready', data: null, error: null });
          return;
        }
        setState(function (previous) {
          return previous.status === 'ready' ? previous : { status: 'loading', data: null, error: null };
        });
        requestJson('/state', { method: 'GET' }).then(function (payload) {
          setState({ status: 'ready', data: payload, error: null });
        }).catch(function (error) {
          setState({ status: 'error', data: null, error: messageOf(error) });
        });
      }, [providerId]);

      useEffect(function () {
        load();
        var off;
        if (typeof props.subscribeChanges === 'function') {
          off = props.subscribeChanges(function () { load(); });
        }
        return function () {
          if (typeof off === 'function') off();
        };
      }, [load, props.subscribeChanges]);

      var submit = useCallback(function (body) {
        setBusy(typeof body.model === 'string' ? body.model : 'default');
        setNote(null);
        var payload = { operation: body.operation, provider: providerId };
        if (typeof body.model === 'string') payload.model = body.model;
        if (typeof body.preset === 'string') payload.preset = body.preset;
        if (body.levels !== undefined) payload.levels = body.levels;
        if (body.effort !== undefined) payload.effort = body.effort;
        if (state.data !== null && typeof state.data.revision === 'number') payload.expectedRevision = state.data.revision;
        return requestJson('/apply', { method: 'POST', body: JSON.stringify(payload) }).then(function (next) {
          setState({ status: 'ready', data: next, error: null });
          setNote({ kind: 'ok', text: t('applied') });
          return next;
        }).catch(function (error) {
          setNote({ kind: 'error', text: t('applyFailed', { message: messageOf(error) }) });
          load();
          return null;
        }).finally(function () {
          setBusy(null);
        });
      }, [providerId, state.data, t, load]);

      var route = useMemo(function () {
        if (state.data === null || !Array.isArray(state.data.routes)) return null;
        return state.data.routes.find(function (entry) { return entry.provider === providerId; }) || null;
      }, [state, providerId]);

      if (state.status === 'loading') {
        return h('div', { className: 'drt-card' }, h('div', { className: 'drt-desc' }, t('card.title') + '…'));
      }
      if (state.status === 'error') {
        return h('div', { className: 'drt-card' }, h('p', { className: 'drt-notice' }, format(t, 'card.error', { message: state.error })));
      }
      if (route === null || route.models.length === 0) return null;

      var declaredCount = route.models.filter(function (model) { return model.preset !== 'none'; }).length;
      var disabled = route.editable !== true;

      var rows = route.models.map(function (model) {
        var statusText;
        var statusClass = 'drt-model-status';
        if (model.preset === 'none') {
          statusText = t('status.none');
        } else if (model.preset === 'disabled') {
          statusText = t('status.disabled');
          statusClass += ' is-ok';
        } else {
          statusText = format(t, 'status.levels', { levels: levelNames(model.declaredLevels, t) });
          statusClass += ' is-ok';
        }
        var catalogText = null;
        if (Array.isArray(model.catalogEfforts)) {
          var catalogThinking = model.catalogEfforts.filter(function (level) { return level !== 'off'; });
          if (catalogThinking.length > 0) {
            catalogText = format(t, 'status.catalog', { levels: levelNames(catalogThinking, t) });
          }
        }
        var pending = model.declaredLevels.length > 0 && !model.reasoningSupported;
        if (pending) {
          statusText = statusText + ' · ' + t('status.pending');
          statusClass += ' is-warn';
        }
        var value = model.preset;
        return h('li', { className: 'drt-model', key: model.id },
          h('div', { className: 'drt-model-main' },
            h('span', { className: 'drt-model-id', title: model.id }, model.id),
            model.name !== model.id ? h('span', { className: 'drt-model-name' }, model.name) : null,
            h('span', { className: statusClass }, statusText),
            catalogText !== null ? h('span', { className: 'drt-model-name' }, catalogText) : null,
          ),
          h('select', {
            value: value,
            disabled: disabled || busy === model.id,
            'aria-label': model.id,
            onChange: function (event) {
              var next = event.target.value;
              if (next === 'custom' || next === 'disabled' && model.preset === 'disabled') return;
              submit({ operation: 'levels', model: model.id, preset: next });
            },
          },
            h('option', { value: 'none', key: 'none' }, t('preset.none')),
            PRESETS.map(function (id) { return h('option', { value: id, key: id }, t('preset.' + id)); }),
            h('option', { value: 'disabled', key: 'disabled' }, t('preset.disabled')),
            model.preset === 'custom' ? h('option', { value: 'custom', key: 'custom', disabled: true }, t('preset.custom')) : null,
          ),
        );
      });

      var defaultOptions = [h('option', { value: '', key: 'none' }, t('card.noneDefault'))].concat(
        DEFAULT_LEVELS.map(function (level) { return h('option', { value: level, key: level }, levelName(level, t)); }),
      );

      return h('details', {
        className: 'drt-card',
        open: open,
        onToggle: function (event) { setOpen(event.currentTarget.open === true); },
      },
        h('summary', null,
          h('span', null, t('card.title')),
          h('span', { className: 'drt-summary-meta' }, format(t, 'card.summary', { declared: declaredCount, total: route.models.length })),
        ),
        h('div', { className: 'drt-body' },
          h('p', { className: 'drt-desc' }, t('card.description')),
          disabled ? h('p', { className: 'drt-notice' }, t('card.readonly')) : null,
          route.error !== null && route.error !== undefined ? h('p', { className: 'drt-route-error' }, format(t, 'card.routeError', { message: route.error })) : null,
          h('div', { className: 'drt-default-row' },
            h('span', { title: t('card.defaultEffortHint') }, t('card.defaultEffort')),
            h('select', {
              value: route.defaultEffort === null || route.defaultEffort === undefined ? '' : route.defaultEffort,
              disabled: disabled || busy === 'default',
              onChange: function (event) {
                var value = event.target.value;
                submit({ operation: 'defaultEffort', effort: value === '' ? null : value });
              },
            }, defaultOptions),
          ),
          h('ul', { className: 'drt-models' }, rows),
          h('div', { className: 'drt-footer' },
            h('button', { type: 'button', className: 'drt-refresh', onClick: function () { load(); } }, t('card.refresh')),
            note === null ? null : h('span', { className: note.kind === 'error' ? 'drt-route-error' : 'drt-model-status is-ok' }, note.text),
            busy !== null ? h('span', null, t('saving')) : null,
          ),
        ),
      );
    }

    // ── 输入框：思考强度小胶囊 ────────────────────────────────────────────

    function EffortChip(props) {
      var t = props.t;
      var available = props.available === true;
      var directory = props.directory;
      var select = props.select;
      var load = props.load;

      var subscribe = useCallback(function (listener) { return directory.subscribe(listener); }, [directory]);
      var getSnapshot = useCallback(function () { return directory.getSnapshot(); }, [directory]);
      var state = useSyncExternalStore(subscribe, getSnapshot);

      var openBox = useState(false);
      var open = openBox[0];
      var setOpen = openBox[1];
      var posBox = useState(null);
      var pos = posBox[0];
      var setPos = posBox[1];
      var busyBox = useState(false);
      var busy = busyBox[0];
      var setBusy = busyBox[1];
      var errorBox = useState(null);
      var error = errorBox[0];
      var setError = errorBox[1];
      var wrapRef = useRef(null);
      var menuRef = useRef(null);

      useEffect(function () {
        if (available && typeof load === 'function') load();
      }, [available, load]);

      useEffect(function () {
        if (!open) return undefined;
        var onDown = function (event) {
          if (wrapRef.current !== null && wrapRef.current.contains(event.target) === true) return;
          if (menuRef.current !== null && menuRef.current.contains(event.target) === true) return;
          setOpen(false);
        };
        var onKey = function (event) {
          if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return function () {
          document.removeEventListener('mousedown', onDown);
          document.removeEventListener('keydown', onKey);
        };
      }, [open]);

      if (!available || state === null || state.current === null) return null;
      var group = null;
      for (var i = 0; i < state.groups.length; i += 1) {
        if (state.groups[i].id === state.current.provider) { group = state.groups[i]; break; }
      }
      if (group === null) return null;
      var model = null;
      for (var j = 0; j < group.models.length; j += 1) {
        if (group.models[j].id === state.current.model) { model = group.models[j]; break; }
      }
      if (model === null || model.reasoning === undefined) return null;

      var reasoning = model.reasoning;
      var effective = state.current.reasoningEffort === undefined ? reasoning.defaultEffort : state.current.reasoningEffort;
      var effectiveLabel = effective === undefined || effective === null
        ? t('effort.default')
        : (function () {
            for (var k = 0; k < reasoning.efforts.length; k += 1) {
              if (reasoning.efforts[k].id === effective) return reasoning.efforts[k].name || effective;
            }
            return effective;
          })();
      var selecting = state.status === 'selecting';

      var choices = [];
      if (reasoning.defaultEffort === undefined) choices.push({ key: 'default', effort: undefined, label: t('effort.default') });
      for (var m = 0; m < reasoning.efforts.length; m += 1) {
        choices.push({ key: reasoning.efforts[m].id, effort: reasoning.efforts[m].id, label: reasoning.efforts[m].name || reasoning.efforts[m].id });
      }

      var toggle = function () {
        if (open) { setOpen(false); return; }
        var rect = wrapRef.current === null ? null : wrapRef.current.getBoundingClientRect();
        if (rect === null) return;
        setPos({
          right: Math.max(8, window.innerWidth - rect.right),
          bottom: Math.max(8, window.innerHeight - rect.top + 6),
        });
        setError(null);
        setOpen(true);
      };

      var choose = function (effort) {
        setOpen(false);
        if (busy || selecting) return;
        if ((effective === undefined ? undefined : effective) === effort) return;
        var selection = { provider: state.current.provider, model: state.current.model };
        if (effort !== undefined) selection.reasoningEffort = effort;
        setBusy(true);
        setError(null);
        Promise.resolve(select(selection)).then(function (result) {
          if (result !== null && typeof result === 'object' && result.ok === false) {
            setError(format(t, 'chip.error', { message: result.error !== undefined && typeof result.error.message === 'string' ? result.error.message : '' }));
          }
        }).catch(function (failure) {
          setError(format(t, 'chip.error', { message: messageOf(failure) }));
        }).finally(function () {
          setBusy(false);
        });
      };

      var menu = null;
      if (open && pos !== null) {
        menu = ReactDOM.createPortal(
          h('div', {
            className: 'drt-menu',
            role: 'menu',
            ref: menuRef,
            style: { right: String(pos.right) + 'px', bottom: String(pos.bottom) + 'px' },
          },
            h('div', { className: 'drt-menu-title' }, t('chip.menu')),
            choices.map(function (choice) {
              var checked = (effective === undefined ? undefined : effective) === choice.effort;
              return h('button', {
                type: 'button',
                key: choice.key,
                role: 'menuitemradio',
                className: 'drt-menu-item',
                'aria-checked': checked ? 'true' : 'false',
                onClick: function () { choose(choice.effort); },
              },
                h('span', null, choice.label),
                checked ? h('span', { className: 'drt-menu-check' }, '✓') : null,
              );
            }),
            error === null ? null : h('div', { className: 'drt-menu-error' }, error),
          ),
          document.body,
        );
      }

      return h('span', { className: 'drt-chip-wrap', ref: wrapRef },
        h('button', {
          type: 'button',
          className: 'drt-chip',
          title: t('chip.aria', { level: effectiveLabel }),
          'aria-haspopup': 'menu',
          'aria-expanded': open ? 'true' : 'false',
          disabled: busy || selecting,
          onClick: toggle,
        },
          h('span', { className: 'drt-chip-dot' }),
          h('span', null, format(t, 'chip.label', { level: effectiveLabel })),
        ),
        menu,
      );
    }

    // ── 插件体 ────────────────────────────────────────────────────────────

    var inject = ['slots', 'locale', 'sessions', 'remote', 'remote.session'];

    function apply(ctx) {
      installStyles();
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en });
      }, 'relay-think: dictionaries');

      // 可选：宿主设置镜像变化时刷新面板（没有 configForms 也不影响）
      var subscribeChanges;
      ctx.inject(['configForms'], function (scope) {
        try {
          var form = scope.configForms.get(SETTINGS_NS);
          subscribeChanges = function (listener) { return form.subscribe(listener); };
          scope.effect(function () {
            return function () { subscribeChanges = undefined; };
          }, 'relay-think: settings mirror');
        } catch (error) {
          ctx.logger?.warn?.('relay-think: 订阅设置镜像失败：' + String(error));
        }
      });

      ctx.slots.inject('settings.models.provider-card', function () {
        return ctx.slots.register({
          name: 'settings.models.provider-card',
          key: SETTINGS_NS,
          locale: NS,
          inject: function () {
            return { apiBase: API_BASE, subscribeChanges: subscribeChanges };
          },
        }, ProviderThinkingCard);
      });

      ctx.inject(['modelDirectories', 'sessions'], function (scope) {
        scope.slots.inject('conversation.input.right', function () {
          return scope.slots.register({
            name: 'conversation.input.right',
            id: 'relay-think',
            order: 20,
            locale: NS,
            inject: function (sessionId) {
              try {
                var directory = scope.modelDirectories.directoryFor(sessionId);
                var available = scope.sessions.subagentAddress(sessionId) === undefined;
                return {
                  available: available,
                  directory: directory.store,
                  load: function () {
                    if (available) directory.load().catch(function () {});
                  },
                  select: function (selection) {
                    return available ? directory.select(selection) : Promise.resolve({ ok: false });
                  },
                };
              } catch (error) {
                scope.logger?.warn?.('relay-think: 无法取得会话模型目录：' + String(error));
                return { available: false };
              }
            },
          }, EffortChip);
        });
      });
    }

    exports.SETTINGS_NS = SETTINGS_NS;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});