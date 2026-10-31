/**
 * dsh-font-lab — 客户端。
 *
 * 往 conversation.view 注册一个「字体」标签页，数据来自同源的 /font-lab/api/fonts。
 * 视觉照 Font Lab 那套：胶囊控件、18px 卡片、36px 预览、分组小标题、错峰入场。
 *
 * 注意：不用 JSX（宿主那份 runtime 没有编译步骤），全部 React.createElement。
 */
window.__ModuleLoader__.load({
  id: 'dsh-font-lab',
  factory: (require) => {
    const React = require('react')
    const e = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useMemo = React.useMemo

    const CSS = __CSS__

    const CATEGORY_ORDER = ['无衬线', '衬线', '等宽', '手写', '装饰', '符号', '其他']

    // 字重档位名，和 scan.js 的 weightName 对齐（客户端自己带一份，免得为一个字符串走一趟网络）。
    function weightLabel(w) {
      if (w < 150) return 'Thin'
      if (w < 250) return 'ExtraLight'
      if (w < 350) return 'Light'
      if (w < 450) return 'Regular'
      if (w < 550) return 'Medium'
      if (w < 650) return 'SemiBold'
      if (w < 750) return 'Bold'
      if (w < 850) return 'ExtraBold'
      return 'Black'
    }

    function familyStack(name) {
      // 家族名里可能带引号，先转义再拼 CSS 字体栈。
      return '"' + String(name).replace(/"/g, '') + '", system-ui, sans-serif'
    }

    // ── 明暗判定 ──────────────────────────────────────
    //
    // 不能信 html[data-ds-theme-source]：那是主题「偏好来源」，偏好写了 light 但皮肤
    // 实际渲染深色时（dream-skin 换了深色皮肤、或用户偏好 light 而皮肤 id 固定深色），
    // 它照样发布 light —— 于是深底套深字，整个面板糊成一片。
    // 这里量宿主真发给我们的颜色：--dsw-alias-label-primary 是正文色，它是亮的说明底是
    // 深色；它读不到就退到祖先的实际底色，再退到 color-scheme 与皮肤属性。

    function parseCssColor(value) {
      if (!value) return null
      const text = String(value).trim()
      if (!text || text === 'transparent' || text === 'none') return null
      let hit = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/i.exec(text)
      if (hit) {
        let alpha = 1
        if (hit[4] !== undefined) {
          alpha = hit[4].indexOf('%') >= 0 ? parseFloat(hit[4]) / 100 : parseFloat(hit[4])
        }
        return { r: Number(hit[1]), g: Number(hit[2]), b: Number(hit[3]), a: alpha }
      }
      hit = /^#([0-9a-f]{3,8})$/i.exec(text)
      if (hit) {
        let hex = hit[1]
        if (hex.length === 3 || hex.length === 4) {
          hex = hex
            .split('')
            .map((ch) => ch + ch)
            .join('')
        }
        const r = parseInt(hex.slice(0, 2), 16)
        const g = parseInt(hex.slice(2, 4), 16)
        const b = parseInt(hex.slice(4, 6), 16)
        const a = hex.length >= 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1
        if ([r, g, b].some((n) => Number.isNaN(n))) return null
        return { r, g, b, a }
      }
      return null
    }

    function luminance(color) {
      const channel = (value) => {
        const s = value / 255
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
      }
      return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
    }

    function readToken(name) {
      if (typeof getComputedStyle !== 'function' || !document.body) return null
      return parseCssColor(getComputedStyle(document.body).getPropertyValue(name))
    }

    // 面板背后实际的底色：一路往上收，遇到第一层不透明的就当下界，然后从下往上
    // 把半透明层叠回去 —— 宿主的玻璃层常是 alpha 0.4，只看单层会判错明暗。
    function blendOver(top, bottom) {
      const a = top.a + bottom.a * (1 - top.a)
      if (a <= 0) return { r: 0, g: 0, b: 0, a: 0 }
      const mix = (t, b) => (t * top.a + b * bottom.a * (1 - top.a)) / a
      return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a }
    }

    function ancestorBackground() {
      if (typeof getComputedStyle !== 'function' || !document.body) return null
      const layers = []
      let node = document.body
      let guard = 0
      let base = null
      while (node && guard < 24) {
        const color = parseCssColor(getComputedStyle(node).backgroundColor)
        if (color && color.a > 0) {
          layers.push(color)
          if (color.a >= 0.5) {
            base = color
            break
          }
        }
        node = node.parentElement
        guard += 1
      }
      // 一路全是半透明（玻璃壳），底下到底垫了什么看不见 —— 老实说不知道，交给上层判据。
      if (!base) return null
      let merged = base
      for (let i = layers.length - 1; i >= 0; i -= 1) {
        if (layers[i] === base) continue
        merged = blendOver(layers[i], merged)
      }
      return merged
    }

    function detectScheme() {
      // 先量「面板背后那层纸」：它才是眼睛看到的底。正文色偶尔是给别处用的（弹层、
      // 反色区块），拿它当唯一依据会在浅色壳里判成深色。
      const background = ancestorBackground()
      if (background) return luminance(background) > 0.42 ? 'light' : 'dark'
      const label = readToken('--dsw-alias-label-primary')
      if (label) return luminance(label) > 0.5 ? 'dark' : 'light'
      if (typeof getComputedStyle === 'function') {
        const declared = (getComputedStyle(document.documentElement).colorScheme || '').toLowerCase()
        if (declared.indexOf('dark') >= 0) return 'dark'
        if (declared.indexOf('light') >= 0) return 'light'
      }
      const root = document.documentElement
      const skin = root.getAttribute('data-dsh-dream-skin-scheme')
      if (skin === 'light' || skin === 'dark') return skin
      const source = root.getAttribute('data-ds-theme-source')
      if (source === 'light' || source === 'dark') return source
      return 'dark'
    }

    // 宿主换主题（偏好切换、皮肤切换、系统明暗）时不重挂面板，只重算一次。
    function useScheme() {
      const [scheme, setScheme] = useState(detectScheme)

      useEffect(() => {
        const sync = () => setScheme(detectScheme())
        sync()
        const observer = new MutationObserver(sync)
        observer.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['data-ds-theme-source', 'data-dsh-dream-skin-scheme', 'class', 'style'],
        })
        if (document.body) {
          observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] })
        }
        const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null
        if (media && media.addEventListener) media.addEventListener('change', sync)
        return () => {
          observer.disconnect()
          if (media && media.removeEventListener) media.removeEventListener('change', sync)
        }
      }, []);

      return scheme
    }

    async function copyText(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch (error) {
        // 落到下面的兜底。
      }
      try {
        const box = document.createElement('textarea')
        box.value = text
        box.style.position = 'fixed'
        box.style.opacity = '0'
        document.body.append(box)
        box.select()
        const ok = document.execCommand('copy')
        box.remove()
        return ok
      } catch (error) {
        return false
      }
    }

    // ── 数据 ──────────────────────────────────────────

    function useFonts() {
      const [state, setState] = useState({ phase: 'loading', data: null, error: '' })

      async function load(refresh) {
        setState((prev) => ({ phase: 'loading', data: refresh ? prev.data : null, error: '' }))
        try {
          const res = await fetch('/font-lab/api/fonts' + (refresh ? '?refresh=1' : ''), {
            headers: { accept: 'application/json' },
          })
          const body = await res.json().catch(() => null)
          if (!res.ok || !body || body.ok !== true) {
            const code = body && body.error ? (body.error.message || body.error.code) : 'HTTP ' + res.status
            throw new Error(String(code))
          }
          setState({ phase: 'ready', data: body, error: '' })
        } catch (error) {
          setState({ phase: 'error', data: null, error: String(error && error.message ? error.message : error) })
        }
      }

      useEffect(() => {
        let alive = true
        load(false)
        return () => {
          alive = false
        }
      }, [])

      return { state, load }
    }

    // ── 零件 ──────────────────────────────────────────

    function Stat(props) {
      return e('div', { className: 'fl-stat' }, e('b', null, props.value), e('span', null, props.label))
    }

    function Tag(props) {
      return e('span', { className: 'fl-tag' + (props.hot ? ' is-hot' : '') }, props.children)
    }

    // 预览文案：默认给家族名（看到的就是它本来的样子），切到样张时给一句中英样字。
    const SAMPLE_CJK = '永和九年 岁在癸丑'
    const SAMPLE_LATIN = 'The quick brown fox'

    function sampleText(font, asSample) {
      if (!asSample) return font.family
      return font.cjk ? SAMPLE_CJK : SAMPLE_LATIN
    }

    function Card(props) {
      const font = props.font
      const [weight, setWeight] = useState(0)
      const [copied, setCopied] = useState(false)
      const active = weight || (font.weights.length ? font.weights[0] : 400)

      useEffect(() => {
        if (!copied) return undefined
        const timer = setTimeout(() => setCopied(false), 1400)
        return () => clearTimeout(timer)
      }, [copied])

      const tags = []
      if (font.cjk) tags.push(e(Tag, { key: 'cjk', hot: true }, '中文'));
      if (font.latin) tags.push(e(Tag, { key: 'latin' }, '拉丁'));
      if (font.mono) tags.push(e(Tag, { key: 'mono' }, '等宽'));
      if (font.weights.length > 1) tags.push(e(Tag, { key: 'multi' }, font.weights.length + ' 个字重'));

      const chips = font.weights.map((w) =>
        e(
          'button',
          {
            key: w,
            type: 'button',
            className: 'fl-weight',
            'aria-pressed': w === active ? 'true' : 'false',
            title: weightLabel(w) + ' / ' + w,
            onClick: () => setWeight(w),
          },
          weightLabel(w),
        ),
      );

      const meta = font.fileNames.length + ' 个文件' + (font.subs.length ? ' · ' + font.subs.slice(0, 2).join(' / ') : '')

      return e(
        'li',
        { className: 'fl-card', style: { '--i': props.index % 12 } },
        e(
          'div',
          { className: 'fl-card-head' },
          e('h3', { className: 'fl-name' }, font.family),
          font.cjk ? null : e('span', { className: 'fl-meta' }, font.category),
        ),
        tags.length ? e('div', { className: 'fl-tags' }, tags) : null,
        e(
          'p',
          {
            className: 'fl-preview',
            style: { fontFamily: familyStack(font.family), fontWeight: active },
            title: sampleText(font, props.sample) + ' · ' + font.family,
          },
          sampleText(font, props.sample),
        ),
        e(
          'div',
          { className: 'fl-weights' },
          chips.length ? chips : e('span', { className: 'fl-weights-note' }, '单字重 · ' + weightLabel(active)),
        ),
        e(
          'div',
          { className: 'fl-card-foot' },
          e('span', { className: 'fl-meta', title: meta }, meta),
          e(
            'button',
            {
              type: 'button',
              className: 'fl-copy',
              'data-done': copied ? '1' : '0',
              onClick: async () => {
                const ok = await copyText(font.family);
                setCopied(ok);
              },
            },
            copied ? '已复制' : '复制名称',
          ),
        ),
      );
    }

    // ── 面板 ──────────────────────────────────────────

    function Panel() {
      const { state, load } = useFonts()
      const scheme = useScheme()
      const [query, setQuery] = useState('')
      const [category, setCategory] = useState('all')
      const [weightBand, setWeightBand] = useState('all')
      const [cjkOnly, setCjkOnly] = useState(false)
      const [asSample, setAsSample] = useState(false)

      const data = state.data
      const families = data && data.families ? data.families : []

      const categories = useMemo(() => {
        const seen = new Map()
        for (const font of families) seen.set(font.category, (seen.get(font.category) || 0) + 1)
        const known = CATEGORY_ORDER.filter((name) => seen.has(name))
        const extra = [...seen.keys()].filter((name) => CATEGORY_ORDER.indexOf(name) === -1).sort()
        return known.concat(extra).map((name) => ({ name, count: seen.get(name) }))
      }, [families]);

      const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase()
        return families.filter((font) => {
          if (category !== 'all' && font.category !== category) return false
          if (cjkOnly && !font.cjk) return false
          if (weightBand !== 'all') {
            const [lo, hi] = weightBand.split('-').map(Number)
            if (!font.weights.some((w) => w >= lo && w < hi)) return false
          }
          if (needle && font.family.toLowerCase().indexOf(needle) === -1) return false
          return true
        })
      }, [families, query, category, cjkOnly, weightBand]);

      const groups = useMemo(() => {
        const buckets = new Map()
        for (const font of filtered) {
          if (!buckets.has(font.category)) buckets.set(font.category, [])
          buckets.get(font.category).push(font)
        }
        const names = CATEGORY_ORDER.filter((name) => buckets.has(name)).concat(
          [...buckets.keys()].filter((name) => CATEGORY_ORDER.indexOf(name) === -1).sort(),
        );
        return names.map((name) => ({ name, items: buckets.get(name) }));
      }, [filtered]);

      const stats = [
        { label: '家族', value: data ? families.length : '—' },
        { label: '文件', value: data ? data.parsed : '—' },
        { label: '中文可选', value: data ? families.filter((f) => f.cjk).length : '—' },
      ];

      const head = e(
        'header',
        { className: 'fl-head' },
        e(
          'div',
          null,
          e('p', { className: 'fl-eyebrow' }, '字体实验室 / Font Lab'),
          e('h1', { className: 'fl-title' }, '本机装了什么字体'),
          e(
            'p',
            { className: 'fl-lede' },
            data
              ? '扫描了 ' + (data.dirs || []).length + ' 个字体目录，' + data.files + ' 个 sfnt 文件里读出 ' + data.parsed + ' 张字体。预览用的是这台机器上真装了的字体，看到的就是它本来的样子。'
              : '正在把本机字体读一遍……',
          ),
        ),
        e('div', { className: 'fl-stats' }, stats.map((item) => e(Stat, { key: item.label, value: item.value, label: item.label }))),
      );

      const bar = e(
        'div',
        { className: 'fl-bar' },
        e('input', {
          className: 'fl-field fl-search',
          type: 'search',
          value: query,
          placeholder: '搜字体名…',
          'aria-label': '搜字体名',
          onChange: (event) => setQuery(event.target.value),
        }),
        e(
          'select',
          {
            className: 'fl-field',
            value: category,
            'aria-label': '分类',
            onChange: (event) => setCategory(event.target.value),
          },
          e('option', { value: 'all' }, '全部分类'),
          categories.map((item) => e('option', { key: item.name, value: item.name }, item.name + ' · ' + item.count)),
        ),
        e(
          'select',
          {
            className: 'fl-field',
            value: weightBand,
            'aria-label': '字重',
            onChange: (event) => setWeightBand(event.target.value),
          },
          e('option', { value: 'all' }, '全部字重'),
          e('option', { value: '0-400' }, '轻于 400'),
          e('option', { value: '400-500' }, '正常 400'),
          e('option', { value: '500-700' }, '中等 500-600'),
          e('option', { value: '700-1000' }, '粗体 700+'),
        ),
        e(
          'button',
          {
            type: 'button',
            className: 'fl-toggle',
            'aria-pressed': cjkOnly ? 'true' : 'false',
            onClick: () => setCjkOnly(!cjkOnly),
          },
          '只看中文',
        ),
        e(
          'button',
          {
            type: 'button',
            className: 'fl-toggle',
            'aria-pressed': asSample ? 'true' : 'false',
            title: '预览从字体名换成一句样字',
            onClick: () => setAsSample(!asSample),
          },
          '字形样张',
        ),
        e(
          'button',
          {
            type: 'button',
            className: 'fl-btn',
            disabled: state.phase === 'loading',
            onClick: () => load(true),
          },
          state.phase === 'loading' ? '扫描中…' : '重新扫描',
        ),
      );

      let body
      if (state.phase === 'loading' && !data) {
        body = e(
          'div',
          { className: 'fl-skeleton' },
          Array.from({ length: 6 }, (_, index) => e('i', { key: index })),
        );
      } else if (state.phase === 'error') {
        body = e(
          'div',
          { className: 'fl-error' },
          e('b', null, '没能读到字体列表'),
          e('div', null, '服务端 /font-lab/api/fonts 没回答。如果刚装上这个插件，先重启一次 DSH。'),
          e('code', null, state.error || 'unknown'),
        );
      } else if (groups.length === 0) {
        body = e(
          'div',
          { className: 'fl-empty' },
          e('b', null, '没有匹配的字体'),
          e('div', null, query || category !== 'all' || cjkOnly || weightBand !== 'all' ? '换个条件试试。' : '这台机器上一个 sfnt 字体也没读到。'),
        );
      } else {
        let index = 0
        body = e(
          React.Fragment,
          null,
          groups.map((group) =>
            e(
              'section',
              { key: group.name, className: 'fl-group' },
              e(
                'div',
                { className: 'fl-group-head' },
                e('h2', { className: 'fl-group-title' }, group.name),
                e('span', { className: 'fl-group-count' }, group.items.length + ' 个家族'),
              ),
              e(
                'ul',
                { className: 'fl-grid' },
                group.items.map((font) => {
                  const card = e(Card, { key: font.family, font, index, sample: asSample });
                  index += 1;
                  return card;
                }),
              ),
            ),
          ),
        );
      }

      return e('div', { className: 'fl-root', 'data-fl-scheme': scheme }, head, bar, body);
    }

    // ── 注册 ──────────────────────────────────────────

    function apply(ctx) {
      ctx.effect(() => {
        for (const stale of document.querySelectorAll('style[data-plugin="dsh-font-lab"]')) stale.remove()
        const style = document.createElement('style')
        style.dataset.plugin = 'dsh-font-lab'
        style.textContent = CSS
        document.head.append(style)
        return () => style.remove()
      }, 'dsh-font-lab: panel styles')

      ctx.slots.inject('conversation.view', () =>
        ctx.slots.register(
          { name: 'conversation.view', id: 'font-lab', order: 60, label: () => '字体' },
          Panel,
        ),
      )
    }

    return { inject: ['slots'], apply }
  },
});