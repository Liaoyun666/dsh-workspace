// dsha-relay-pair / lib/client.js
//
// DSHA（手机端）Web GUI 的「设置 → 中继配对」页。
// 和桌面端那份的差别：多了手机专属的两块 ——
//   · 发件箱（跑完却还没回传的报告条数）与通知开关的现状
//   · 「派活给这台手机」输入框（走本机 /relay/api/submit，不经过中继）
//
// 数据来源仍是本机插件的 HTTP 路由 /relay/api/*，带信任围栏（只认 loopback/trustedHosts）。

window.__ModuleLoader__.load({
  id: "dsha-relay-pair",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    let react = require("react");
    const h = react.createElement;
    const useState = react.useState;
    const useEffect = react.useEffect;
    const useCallback = react.useCallback;

    const NS = 'dsha-relay-pair';

    const zh = {
      'nav': '中继配对',
      'title': 'DSHA 手机端 · 中继配对',
      'intro': '把这台手机接进中继台：手机在线时任务直接投到手机上跑，手机锁屏/离线时由桌面端或云端接手。',
      'status.paired': '已配对',
      'status.unpaired': '未配对',
      'status.online': '心跳正常',
      'status.stale': '心跳中断',
      'field.relayUrl': '中继地址',
      'field.code': '配对码',
      'field.name': '设备名（可留空）',
      'action.pair': '配对',
      'action.unpair': '断开配对',
      'action.refresh': '刷新状态',
      'action.submit': '派给这台手机',
      'pair.hint': '在中继网页点「生成配对码」拿三段码（XXXX-XXXX-XXXX），10 分钟内有效、用一次作废。',
      'pair.busy': '配对中…',
      'pair.ok': '配对成功，心跳与长轮询已启动。',
      'unpair.ok': '已断开并清除本机凭据。',
      'err.fence': '只能在本机页面里配对（本机路由拒绝了这个请求）。',
      'err.unsupported': '插件没加载起来：/relay/api 路由没有响应。',
      'empty.tasks': '还没有跑过中继任务。',
      'section.tasks': '最近任务',
      'section.pairing': '配对',
      'section.mobile': '手机端行为',
      'section.submit': '派活给本机',
      'label.notify': '任务到达时弹通知',
      'label.vibrate': '任务到达时震动',
      'label.outbox': '未回传报告',
      'label.delivered': '已投递任务',
      'label.idle': '空闲退避',
      'value.on': '开',
      'value.off': '关',
      'submit.hint': '直接投进本机当前会话（不经过中继，不占中继任务号）。',
      'submit.placeholder': '要这台手机做什么…',
      'submit.ok': '已投进本机会话。',
      'cloud.hint': '手机被系统杀掉/断网时，中继那边的任务会转给桌面端或云端：去中继网页设置里开云端执行器。',
      'outbox.warn': '有报告没送达：网络恢复后会自动重放，别手动删 $DSH_HOME/relay-outbox.jsonl。',
    };

    const en = {
      'nav': 'Relay pairing',
      'title': 'DSHA phone · relay pairing',
      'intro': 'Connect this phone to the relay: tasks are delivered to the phone while it is online; when it sleeps or goes offline the desktop or the cloud runner takes over.',
      'status.paired': 'Paired',
      'status.unpaired': 'Not paired',
      'status.online': 'heartbeat OK',
      'status.stale': 'heartbeat lost',
      'field.relayUrl': 'Relay URL',
      'field.code': 'Pairing code',
      'field.name': 'Device name (optional)',
      'action.pair': 'Pair',
      'action.unpair': 'Unpair',
      'action.refresh': 'Refresh',
      'action.submit': 'Run on this phone',
      'pair.hint': 'Generate an 8-character code on the relay page; it expires in 10 minutes and works once.',
      'pair.busy': 'Pairing…',
      'pair.ok': 'Paired. Heartbeat and polling started.',
      'unpair.ok': 'Unpaired and local token cleared.',
      'err.fence': 'Pairing only works from the local page (the local route refused this request).',
      'err.unsupported': 'Plugin not loaded: /relay/api did not respond.',
      'empty.tasks': 'No relay tasks yet.',
      'section.tasks': 'Recent tasks',
      'section.pairing': 'Pairing',
      'section.mobile': 'Phone behaviour',
      'section.submit': 'Dispatch to this phone',
      'label.notify': 'Notify on new task',
      'label.vibrate': 'Vibrate on new task',
      'label.outbox': 'Reports not sent',
      'label.delivered': 'Tasks delivered',
      'label.idle': 'Idle backoff',
      'value.on': 'on',
      'value.off': 'off',
      'submit.hint': 'Delivers straight into the current local session (bypasses the relay, takes no task id).',
      'submit.placeholder': 'What should this phone do…',
      'submit.ok': 'Delivered to the local session.',
      'cloud.hint': 'If the phone is killed or offline, the relay hands the task to the desktop or cloud runner: enable it in the relay web settings.',
      'outbox.warn': 'Some reports are unsent: they are replayed when the network is back. Do not delete $DSH_HOME/relay-outbox.jsonl.',
    };

    const css = `
.dsha-relay-pair { display: grid; gap: 14px; font-size: 13.5px; }
.dsha-relay-pair h3 { margin: 0 0 6px; font-size: 13px; color: var(--muted, #8b98a9); font-weight: 500; letter-spacing: .3px; }
.dsha-relay-pair .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; }
.dsha-relay-pair .fld { display: flex; flex-direction: column; gap: 5px; flex: 1 1 200px; min-width: 150px; }
.dsha-relay-pair .fld span { font-size: 12px; color: var(--muted, #8b98a9); }
.dsha-relay-pair input, .dsha-relay-pair textarea { width: 100%; padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(127,127,127,.35); background: rgba(127,127,127,.08); color: inherit; font: inherit; }
.dsha-relay-pair textarea { min-height: 68px; resize: vertical; }
.dsha-relay-pair button { padding: 8px 14px; border-radius: 8px; border: 1px solid rgba(127,127,127,.35); background: transparent; color: inherit; font: inherit; cursor: pointer; }
.dsha-relay-pair button.primary { background: #35d0ba; border-color: #35d0ba; color: #06231f; font-weight: 600; }
.dsha-relay-pair button[disabled] { opacity: .5; cursor: not-allowed; }
.dsha-relay-pair .badge { display: inline-flex; align-items: center; gap: 6px; padding: 2px 9px; border-radius: 999px; border: 1px solid rgba(127,127,127,.35); font-size: 12px; }
.dsha-relay-pair .badge.ok { color: #4cd07d; border-color: rgba(76,208,125,.5); }
.dsha-relay-pair .badge.bad { color: #f0616d; border-color: rgba(240,97,109,.5); }
.dsha-relay-pair .badge.warn { color: #e8b23b; border-color: rgba(232,178,59,.5); }
.dsha-relay-pair .kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 12.5px; }
.dsha-relay-pair .kv b { font-weight: 500; color: var(--muted, #8b98a9); }
.dsha-relay-pair .hint { color: var(--muted, #8b98a9); font-size: 12px; margin: 0; }
.dsha-relay-pair .err { color: #f0616d; font-size: 12.5px; margin: 0; }
.dsha-relay-pair .ok { color: #4cd07d; font-size: 12.5px; margin: 0; }
.dsha-relay-pair ul { margin: 0; padding-left: 18px; color: var(--muted, #8b98a9); font-size: 12.5px; }
.dsha-relay-pair li { margin: 2px 0; }
`;

    async function relayCall(path, body) {
      const init = { method: body === undefined ? 'GET' : 'POST', headers: { Accept: 'application/json' } };
      if (body !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      const response = await fetch('/relay/api' + path, init);
      let data = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      if (response.status === 403) throw new Error('FENCE');
      if (response.status === 404) throw new Error('UNSUPPORTED');
      if (!response.ok) {
        const message = data && data.error && data.error.message ? data.error.message : ('HTTP ' + response.status);
        throw new Error(message);
      }
      return data;
    }

    function ago(iso) {
      if (!iso) return '—';
      const ms = Date.now() - new Date(iso).getTime();
      if (!Number.isFinite(ms) || ms < 0) return '—';
      const sec = Math.round(ms / 1000);
      if (sec < 60) return sec + ' 秒前';
      const min = Math.round(sec / 60);
      if (min < 60) return min + ' 分钟前';
      return Math.round(min / 60) + ' 小时前';
    }

    function RelayPairSection(props) {
      const t = props.t;
      const [state, setState] = useState(null);
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');
      const [busy, setBusy] = useState(false);
      const [relayUrl, setRelayUrl] = useState('');
      const [code, setCode] = useState('');
      const [name, setName] = useState('');
      const [prompt, setPrompt] = useState('');

      const load = useCallback(async () => {
        try {
          const data = await relayCall('/state');
          setState(data);
          setError('');
          if (!relayUrl && data && data.relay && data.relay.url) setRelayUrl(data.relay.url);
        } catch (err) {
          const message = err && err.message === 'FENCE' ? t('err.fence')
            : err && err.message === 'UNSUPPORTED' ? t('err.unsupported')
              : '读取状态失败：' + (err && err.message ? err.message : String(err));
          setError(message);
          setState(null);
        }
      }, [relayUrl, t]);

      useEffect(() => {
        load();
        const timer = setInterval(load, 15000);
        return () => clearInterval(timer);
      }, [load]);

      const doPair = async () => {
        setBusy(true);
        setNotice('');
        setError('');
        try {
          await relayCall('/pair', { code, relayUrl, name });
          setCode('');
          setNotice(t('pair.ok'));
          await load();
        } catch (err) {
          setError(t('pair.busy').replace('…', '') + '失败：' + (err && err.message ? err.message : String(err)));
        } finally {
          setBusy(false);
        }
      };

      const doUnpair = async () => {
        setBusy(true);
        setNotice('');
        setError('');
        try {
          await relayCall('/unpair', {});
          setNotice(t('unpair.ok'));
          await load();
        } catch (err) {
          setError('断开失败：' + (err && err.message ? err.message : String(err)));
        } finally {
          setBusy(false);
        }
      };

      const doSubmit = async () => {
        if (!prompt.trim()) return;
        setBusy(true);
        setNotice('');
        setError('');
        try {
          await relayCall('/submit', { prompt });
          setPrompt('');
          setNotice(t('submit.ok'));
          await load();
        } catch (err) {
          setError('派发失败：' + (err && err.message ? err.message : String(err)));
        } finally {
          setBusy(false);
        }
      };

      const paired = Boolean(state && state.relay && state.relay.paired);
      const online = Boolean(state && state.relay && state.relay.online);
      const outbox = state && state.relay && typeof state.relay.outboxPending === 'number' ? state.relay.outboxPending : 0;
      const tasks = state && Array.isArray(state.tasks) ? state.tasks.slice(0, 5) : [];

      return h('div', { className: 'dsha-relay-pair' },
        h('p', { className: 'hint' }, t('intro')),

        h('div', { className: 'row' },
          h('span', { className: 'badge ' + (paired ? 'ok' : 'bad') }, paired ? t('status.paired') : t('status.unpaired')),
          paired ? h('span', { className: 'badge ' + (online ? 'ok' : 'bad') }, online ? t('status.online') : t('status.stale')) : null,
          outbox > 0 ? h('span', { className: 'badge warn' }, t('label.outbox') + ' ' + outbox) : null,
          h('button', { type: 'button', onClick: load }, t('action.refresh'))
        ),

        state ? h('div', { className: 'kv' },
          paired ? h('b', null, '中继') : null, paired ? h('span', null, state.relay.url) : null,
          paired ? h('b', null, '设备') : null, paired ? h('span', null, (state.device && state.device.name) + '（' + (state.device && state.device.kind) + '）') : null,
          paired ? h('b', null, '心跳') : null, paired ? h('span', null, ago(state.relay.lastHeartbeatAt)) : null,
          paired ? h('b', null, t('label.delivered')) : null, paired ? h('span', null, String(state.relay.delivered || 0)) : null,
          paired && state.relay.lastError ? h('b', null, '最后错误') : null,
          paired && state.relay.lastError ? h('span', null, state.relay.lastError) : null
        ) : null,

        error ? h('p', { className: 'err' }, error) : null,
        notice ? h('p', { className: 'ok' }, notice) : null,
        outbox > 0 ? h('p', { className: 'hint' }, t('outbox.warn')) : null,

        h('div', null,
          h('h3', null, t('section.pairing')),
          h('p', { className: 'hint' }, t('pair.hint')),
          h('div', { className: 'row' },
            h('label', { className: 'fld' }, h('span', null, t('field.relayUrl')),
              h('input', {
                value: relayUrl,
                placeholder: 'http://1.2.3.4',
                onChange: (e) => setRelayUrl(e.target.value),
              })),
            h('label', { className: 'fld' }, h('span', null, t('field.code')),
              h('input', {
                value: code,
                placeholder: 'WFQT-GRKK-L3LK',
                onChange: (e) => setCode(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter' && code.trim()) doPair(); },
              })),
            h('label', { className: 'fld' }, h('span', null, t('field.name')),
              h('input', { value: name, placeholder: '', onChange: (e) => setName(e.target.value) }))
          ),
          h('div', { className: 'row', style: { marginTop: 10 } },
            h('button', {
              type: 'button',
              className: 'primary',
              disabled: busy || !code.trim() || !relayUrl.trim(),
              onClick: doPair,
            }, busy ? t('pair.busy') : t('action.pair')),
            paired ? h('button', { type: 'button', disabled: busy, onClick: doUnpair }, t('action.unpair')) : null
          )
        ),

        h('div', null,
          h('h3', null, t('section.submit')),
          h('p', { className: 'hint' }, t('submit.hint')),
          h('textarea', {
            value: prompt,
            placeholder: t('submit.placeholder'),
            onChange: (e) => setPrompt(e.target.value),
          }),
          h('div', { className: 'row', style: { marginTop: 8 } },
            h('button', {
              type: 'button',
              className: 'primary',
              disabled: busy || !prompt.trim(),
              onClick: doSubmit,
            }, t('action.submit'))
          )
        ),

        h('div', null,
          h('h3', null, t('section.tasks')),
          tasks.length === 0 ? h('p', { className: 'hint' }, t('empty.tasks'))
            : h('ul', null, tasks.map((task, index) => h('li', { key: (task.id || '') + index },
              '[' + (task.status || '?') + '] ' + (task.title || task.id || ''))))
        ),

        h('p', { className: 'hint' }, t('cloud.hint'))
      );
    }

    const inject = ['slots', 'locale'];

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsha-relay-pair: dictionaries');
      ctx.effect(() => {
        const tag = document.createElement('style');
        tag.dataset.plugin = 'dsha-relay-pair';
        tag.textContent = css;
        document.head.append(tag);
        return () => tag.remove();
      }, 'dsha-relay-pair: styles');

      const t = ctx.locale.bind(NS);
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsha-relay-pair',
        order: 60,
        label: () => t('nav'),
        inject: () => ({ t }),
      }, RelayPairSection));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
