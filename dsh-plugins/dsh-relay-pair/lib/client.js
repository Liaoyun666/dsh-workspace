// dsh-relay-pair / lib/client.js
//
// DSH Web GUI 的「设置 → 中继配对」页：填配对码就能配对，不用在对话里敲工具。
// 桌面端和手机端（DSHA 里同一个 Web GUI）都会加载这份客户端插件。
//
// 数据来源：本机插件的 HTTP 路由 /relay/api/{state,pair,unpair,tasks}。
// 这些路由带信任围栏，只认 loopback / trustedHosts，跨站请求会被 403。

window.__ModuleLoader__.load({
  id: "dsh-relay-pair",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    let react = require("react");
    const h = react.createElement;
    const useState = react.useState;
    const useEffect = react.useEffect;
    const useCallback = react.useCallback;

    const NS = 'relay-pair';

    const zh = {
      'nav': '中继配对',
      'title': 'DSH 中继台配对',
      'intro': '把本机接到中继台：本机在线时网页能派活过来，本机关了任务就走云端。',
      'status.paired': '已配对',
      'status.unpaired': '未配对',
      'status.online': '心跳正常',
      'status.stale': '心跳中断',
      'status.unreachable': '连不上中继',
      'status.authLost': '令牌已失效',
      'kv.lastBeat': '心跳',
      'kv.renewed': '自动续期',
      'field.relayUrl': '中继地址',
      'field.code': '配对码',
      'field.name': '设备名（可留空）',
      'action.pair': '配对',
      'action.unpair': '断开配对',
      'action.refresh': '刷新状态',
      'pair.hint': '在中继网页点「生成配对码」拿三段码（XXXX-XXXX-XXXX），10 分钟内有效、用一次作废。',
      'pair.busy': '配对中…',
      'pair.ok': '配对成功，心跳已启动。',
      'unpair.ok': '已断开并清除本机凭据。',
      'err.fence': '只能在 DSH 本机页面里配对（本机路由拒绝了这个请求）。',
      'err.unsupported': '插件没加载起来：/relay/api 路由没有响应。',
      'empty.tasks': '还没有跑过中继任务。',
      'section.tasks': '最近任务',
      'section.pairing': '配对',
      'cloud.hint': '想在本机离线时继续跑任务，就去中继网页的「设置」里启用云端执行器并填 key。',
    };

    const en = {
      'nav': 'Relay pairing',
      'title': 'Pair this DSH with the relay',
      'intro': 'Connect this machine to the relay: the web page can dispatch tasks while it is online, and the cloud runner takes over when it is off.',
      'status.paired': 'Paired',
      'status.unpaired': 'Not paired',
      'status.online': 'heartbeat OK',
      'status.stale': 'heartbeat lost',
      'status.unreachable': 'relay unreachable',
      'status.authLost': 'token rejected',
      'kv.lastBeat': 'Heartbeat',
      'kv.renewed': 'Auto-renewed',
      'field.relayUrl': 'Relay URL',
      'field.code': 'Pairing code',
      'field.name': 'Device name (optional)',
      'action.pair': 'Pair',
      'action.unpair': 'Unpair',
      'action.refresh': 'Refresh',
      'pair.hint': 'Generate an 8-character code on the relay page; it expires in 10 minutes and works once.',
      'pair.busy': 'Pairing…',
      'pair.ok': 'Paired. Heartbeat started.',
      'unpair.ok': 'Unpaired and local token cleared.',
      'err.fence': 'Pairing only works from the local DSH page (the local route refused this request).',
      'err.unsupported': 'Plugin not loaded: /relay/api did not respond.',
      'empty.tasks': 'No relay tasks yet.',
      'section.tasks': 'Recent tasks',
      'section.pairing': 'Pairing',
      'cloud.hint': 'To keep running tasks while this machine is offline, enable the cloud runner in the relay page settings.',
    };

    const css = `
.relay-pair { display: grid; gap: 14px; font-size: 13.5px; }
.relay-pair h3 { margin: 0 0 6px; font-size: 13px; color: var(--muted, #8b98a9); font-weight: 500; letter-spacing: .3px; }
.relay-pair .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; }
.relay-pair .fld { display: flex; flex-direction: column; gap: 5px; flex: 1 1 200px; min-width: 160px; }
.relay-pair .fld span { font-size: 12px; color: var(--muted, #8b98a9); }
.relay-pair input { width: 100%; padding: 7px 9px; border-radius: 8px; border: 1px solid rgba(127,127,127,.35); background: rgba(127,127,127,.08); color: inherit; font: inherit; }
.relay-pair button { padding: 7px 13px; border-radius: 8px; border: 1px solid rgba(127,127,127,.35); background: transparent; color: inherit; font: inherit; cursor: pointer; }
.relay-pair button.primary { background: #35d0ba; border-color: #35d0ba; color: #06231f; font-weight: 600; }
.relay-pair button[disabled] { opacity: .5; cursor: not-allowed; }
.relay-pair .badge { display: inline-flex; align-items: center; gap: 6px; padding: 2px 9px; border-radius: 999px; border: 1px solid rgba(127,127,127,.35); font-size: 12px; }
.relay-pair .badge.ok { color: #4cd07d; border-color: rgba(76,208,125,.5); }
.relay-pair .badge.bad { color: #f0616d; border-color: rgba(240,97,109,.5); }
.relay-pair .kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 12.5px; }
.relay-pair .kv b { font-weight: 500; color: var(--muted, #8b98a9); }
.relay-pair .hint { color: var(--muted, #8b98a9); font-size: 12px; margin: 0; }
.relay-pair .err { color: #f0616d; font-size: 12.5px; margin: 0; }
.relay-pair .ok { color: #4cd07d; font-size: 12.5px; margin: 0; }
.relay-pair ul { margin: 0; padding-left: 18px; color: var(--muted, #8b98a9); font-size: 12.5px; }
.relay-pair li { margin: 2px 0; }
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

      const paired = Boolean(state && state.relay && state.relay.paired);
      const online = Boolean(state && state.relay && state.relay.online);
      const tasks = state && Array.isArray(state.tasks) ? state.tasks.slice(0, 5) : [];
      // 断了到底为什么断：令牌失效 / 连不上中继 / 单纯没心跳，三种对主人的处置完全不同
      // （前两种看是不是网络，令牌失效还得知道要不要重新配对），别都塞进「心跳中断」。
      const staleLabel = !paired ? ''
        : online ? t('status.online')
          : state.relay.lastAuthError ? t('status.authLost')
            : /连不上中继|fetch failed|UNREACHABLE/i.test(String(state.relay.lastError || '')) ? t('status.unreachable')
              : t('status.stale');

      return h('div', { className: 'relay-pair' },
        h('p', { className: 'hint' }, t('intro')),

        h('div', { className: 'row' },
          h('span', { className: 'badge ' + (paired ? 'ok' : 'bad') }, paired ? t('status.paired') : t('status.unpaired')),
          paired ? h('span', { className: 'badge ' + (online ? 'ok' : 'bad') }, staleLabel) : null,
          h('button', { type: 'button', onClick: load }, t('action.refresh'))
        ),

        state ? h('div', { className: 'kv' },
          paired ? h('b', null, '中继') : null, paired ? h('span', null, state.relay.url) : null,
          paired ? h('b', null, '设备') : null, paired ? h('span', null, (state.device && state.device.name) + '（' + (state.device && state.device.kind) + '）') : null,
          paired ? h('b', null, t('kv.lastBeat')) : null, paired ? h('span', null, ago(state.relay.lastHeartbeatAt)) : null,
          // 自愈生效过就亮出来：主人能确认「不用重新配对了」这件事真的发生了。
          paired && state.relay.renewCount > 0 ? h('b', null, t('kv.renewed')) : null,
          paired && state.relay.renewCount > 0
            ? h('span', null, String(state.relay.renewCount) + ' 次（最近 ' + ago(state.relay.renewAt) + '）')
            : null,
          paired && state.relay.lastError ? h('b', null, '最后错误') : null,
          paired && state.relay.lastError ? h('span', null, state.relay.lastError) : null
        ) : null,

        error ? h('p', { className: 'err' }, error) : null,
        notice ? h('p', { className: 'ok' }, notice) : null,

        h('div', null,
          h('h3', null, t('section.pairing')),
          h('p', { className: 'hint' }, t('pair.hint')),
          h('div', { className: 'row' },
            h('label', { className: 'fld' }, h('span', null, t('field.relayUrl')),
              h('input', {
                value: relayUrl,
                placeholder: 'https://relay.example.com',
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
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-relay-pair: dictionaries');
      ctx.effect(() => {
        const tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-relay-pair';
        tag.textContent = css;
        document.head.append(tag);
        return () => tag.remove();
      }, 'dsh-relay-pair: styles');

      const t = ctx.locale.bind(NS);
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'relay-pair',
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
