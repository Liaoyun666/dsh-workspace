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

    const CSS = "/* dsh-font-lab —— 排版与几何照抄 Font Lab（ignoredone.com/fontlab）的样本页：\n   胶囊控件、18px 卡片圆角、48px 网格间距、36px 预览正文、.08em 大写小标题、\n   cubic-bezier(.22,1,.36,1) 的 0.72s 入场。颜色改成吃 DSH 的深色底。\n   Font Lab 原站是白底黑字，硬搬白底会在深色壳里像一张外来的纸，所以只借它的\n   留白与形状，色板换成 var(--dsw-alias-label-primary) 那条调的灰阶，外加它唯一的\n   强调色 #d8e4e1（浅灰青）。 */\n\n.fl-root {\n  /* 明暗两套值都挂在这里：默认是深色壳，.fl-root[data-fl-scheme=\"light\"] 覆盖成浅色。\n     判定由客户端量真实像素决定（见 client.template.js 的 detectScheme），\n     不看 html[data-ds-theme-source]——那是主题「偏好来源」，不一定等于皮肤实际渲染的明暗。 */\n  --fl-ink: #f1eff6;\n  --fl-ink-soft: rgba(241, 239, 246, 0.9);\n  --fl-muted: #9b9b98;\n  --fl-dim: rgba(241, 239, 246, 0.42);\n  --fl-line: rgba(255, 255, 255, 0.07);\n  --fl-surface: rgba(255, 255, 255, 0.035);\n  --fl-field: rgba(255, 255, 255, 0.06);\n  --fl-field-line: rgba(255, 255, 255, 0.09);\n  --fl-placeholder: rgba(241, 239, 246, 0.35);\n  --fl-focus-ring: rgba(122, 190, 255, 0.45);\n  --fl-tag-bg: rgba(255, 255, 255, 0.07);\n  --fl-hot-bg: rgba(216, 228, 225, 0.16);\n  --fl-hot-ink: #d8e4e1;\n  --fl-weight-bg: rgba(255, 255, 255, 0.05);\n  --fl-press-ring: transparent;\n  --fl-copy-bg: rgba(255, 255, 255, 0.07);\n  --fl-copy-hover-bg: #d8e4e1;\n  --fl-copy-hover-ink: #16181a;\n  --fl-btn-bg: #f1eff6;\n  --fl-btn-ink: #16181a;\n  --fl-btn-hover-bg: #d8e4e1;\n  --fl-btn-hover-ink: #16181a;\n  --fl-btn-off-bg: rgba(255, 255, 255, 0.08);\n  --fl-btn-off-ink: #9b9b98;\n  --fl-skeleton-a: rgba(255, 255, 255, 0.04);\n  --fl-skeleton-b: rgba(255, 255, 255, 0.09);\n  --fl-error-bg: rgba(255, 120, 120, 0.12);\n  --fl-error-ink: #ffb4b4;\n  --fl-accent: #d8e4e1;\n  --fl-accent-ink: #16181a;\n  --fl-ease: cubic-bezier(0.4, 0, 0.2, 1);\n  --fl-rise: cubic-bezier(0.22, 1, 0.36, 1);\n  --fl-veil: 19, 17, 22;\n\n  position: relative;\n  box-sizing: border-box;\n  width: 100%;\n  min-height: 100%;\n  /* 不自己开滚动：滚动交给宿主那层 scrollBody。面板自己当滚动容器的话，\n     筛选条的 sticky 会被困在一个永远不滚的 scrollport 里，滚下去就跟着跑没了。 */\n  padding: 28px 5vw 120px;\n  color: var(--fl-ink);\n  font-family: -apple-system, BlinkMacSystemFont, \"Segoe UI\", \"Microsoft YaHei\", sans-serif;\n  -webkit-font-smoothing: antialiased;\n}\n\n.fl-root *,\n.fl-root *::before,\n.fl-root *::after {\n  box-sizing: border-box;\n}\n\n/* 面板自带滚动，宿主那条横向拖宽的手柄会压住表格边缘 —— 学 memory-evolve 的做法隐藏它。 */\n[data-phase]:has(.fl-root) [data-width-handle] {\n  display: none;\n}\n\n/* ── 抬头 ─────────────────────────────────────────────── */\n\n.fl-head {\n  display: grid;\n  grid-template-columns: minmax(0, 1fr) 300px;\n  gap: 80px;\n  align-items: end;\n  margin: 8px 0 44px;\n}\n\n.fl-eyebrow {\n  margin: 0 0 16px;\n  font-size: 12px;\n  font-weight: 500;\n  letter-spacing: 0.08em;\n  text-transform: uppercase;\n  color: var(--fl-muted);\n}\n\n.fl-title {\n  margin: 0;\n  font-size: clamp(32px, 4vw, 54px);\n  font-weight: 400;\n  line-height: 1.1;\n  letter-spacing: 0.5px;\n  opacity: 0.94;\n}\n\n.fl-lede {\n  margin: 16px 0 0;\n  max-width: 44ch;\n  font-size: 14px;\n  line-height: 1.9;\n  color: var(--fl-dim);\n}\n\n.fl-stats {\n  display: grid;\n  grid-template-columns: repeat(3, minmax(0, 1fr));\n  gap: 12px;\n}\n\n.fl-stat {\n  padding: 14px 0 0;\n  border-top: 1px solid var(--fl-line);\n}\n\n.fl-stat b {\n  display: block;\n  font-size: 26px;\n  font-weight: 400;\n  line-height: 1.1;\n  letter-spacing: 0.5px;\n}\n\n.fl-stat span {\n  display: block;\n  margin-top: 6px;\n  font-size: 11px;\n  letter-spacing: 0.08em;\n  text-transform: uppercase;\n  color: var(--fl-dim);\n}\n\n/* ── 筛选条 ───────────────────────────────────────────── */\n\n.fl-bar {\n  position: sticky;\n  top: 0;\n  z-index: 20;\n  display: flex;\n  flex-wrap: wrap;\n  align-items: center;\n  gap: 12px;\n  margin: 0 0 36px;\n  padding: 12px 0;\n  /* 整条要挡得住下面的卡片：底色做实，只在下面留一小截渐隐，别让卡片的字从中间透出来 */\n  background: rgb(var(--fl-veil));\n  backdrop-filter: blur(16px) saturate(180%);\n  -webkit-backdrop-filter: blur(16px) saturate(180%);\n}\n\n.fl-bar::after {\n  content: \"\";\n  position: absolute;\n  left: 0;\n  right: 0;\n  top: 100%;\n  height: 16px;\n  background: linear-gradient(to bottom, rgb(var(--fl-veil)), rgba(var(--fl-veil), 0));\n  pointer-events: none;\n}\n\n.fl-field {\n  height: 40px;\n  padding: 0 16px;\n  border-radius: 999px;\n  border: 1px solid var(--fl-field-line);\n  background: var(--fl-field);\n  color: var(--fl-ink);\n  font-family: inherit;\n  font-size: 14px;\n  letter-spacing: 0.02em;\n  outline: none;\n  transition: border-color 0.2s var(--fl-ease), box-shadow 0.2s var(--fl-ease);\n}\n\n.fl-field::placeholder {\n  color: var(--fl-placeholder);\n}\n\n.fl-field:focus-visible {\n  border-color: transparent;\n  box-shadow: 0 0 0 2px var(--fl-focus-ring);\n}\n\n.fl-search {\n  flex: 1 1 200px;\n  min-width: 0;\n}\n\nselect.fl-field {\n  appearance: none;\n  -webkit-appearance: none;\n  padding-right: 36px;\n  background-image: linear-gradient(45deg, transparent 50%, var(--fl-muted) 50%),\n    linear-gradient(135deg, var(--fl-muted) 50%, transparent 50%);\n  background-position: calc(100% - 17px) 50%, calc(100% - 11px) 50%;\n  background-size: 6px 6px, 6px 6px;\n  background-repeat: no-repeat;\n}\n\n.fl-toggle {\n  height: 40px;\n  padding: 0 18px;\n  border-radius: 999px;\n  border: 1px solid var(--fl-field-line);\n  background: transparent;\n  color: var(--fl-muted);\n  font-family: inherit;\n  font-size: 14px;\n  letter-spacing: 0.02em;\n  cursor: pointer;\n  transition: background 0.2s var(--fl-ease), color 0.2s var(--fl-ease),\n    border-color 0.2s var(--fl-ease), transform 0.2s var(--fl-ease);\n}\n\n.fl-toggle:hover {\n  color: var(--fl-ink);\n  transform: translateY(-1px);\n}\n\n.fl-toggle[aria-pressed=\"true\"] {\n  background: var(--fl-accent);\n  border-color: transparent;\n  color: var(--fl-accent-ink);\n  font-weight: 500;\n}\n\n.fl-btn {\n  display: inline-flex;\n  align-items: center;\n  gap: 8px;\n  height: 40px;\n  padding: 0 22px;\n  border: 0;\n  border-radius: 999px;\n  background: var(--fl-btn-bg);\n  color: var(--fl-btn-ink);\n  font-family: inherit;\n  font-size: 14px;\n  font-weight: 500;\n  letter-spacing: 0.02em;\n  cursor: pointer;\n  transition: background 0.2s var(--fl-ease), transform 0.2s var(--fl-ease),\n    color 0.2s var(--fl-ease);\n}\n\n.fl-btn:hover:not(:disabled) {\n  background: var(--fl-btn-hover-bg);\n  color: var(--fl-btn-hover-ink);\n  transform: translateY(-1px);\n}\n\n.fl-btn:active:not(:disabled) {\n  transform: translateY(0);\n}\n\n.fl-btn:disabled {\n  background: var(--fl-btn-off-bg);\n  color: var(--fl-btn-off-ink);\n  cursor: progress;\n  transform: none;\n}\n\n/* ── 分组与网格 ───────────────────────────────────────── */\n\n.fl-group {\n  margin: 0 0 56px;\n}\n\n.fl-group:last-child {\n  margin-bottom: 0;\n}\n\n.fl-group-head {\n  display: flex;\n  align-items: baseline;\n  gap: 10px;\n  margin: 0 0 6px;\n}\n\n.fl-group-title {\n  margin: 0;\n  font-size: 16px;\n  font-weight: 600;\n  letter-spacing: -0.02em;\n  text-transform: uppercase;\n  color: var(--fl-muted);\n}\n\n.fl-group-count {\n  font-size: 11px;\n  letter-spacing: 0.08em;\n  color: var(--fl-dim);\n}\n\n.fl-grid {\n  display: grid;\n  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));\n  align-items: start;\n  gap: 24px;\n  margin: 0;\n  padding: 0;\n  list-style: none;\n}\n\n/* ── 字体卡 ───────────────────────────────────────────── */\n\n.fl-card {\n  position: relative;\n  display: flex;\n  flex-direction: column;\n  padding: 20px 18px 16px;\n  border-radius: 18px;\n  background: var(--fl-surface);\n  animation: fl-rise 0.72s var(--fl-rise) both;\n  animation-delay: calc(var(--i, 0) * 14ms);\n}\n\n.fl-card::after {\n  content: \"\";\n  position: absolute;\n  left: 5px;\n  right: 5px;\n  bottom: 0;\n  height: 1px;\n  background: var(--fl-line);\n}\n\n.fl-card-head {\n  display: flex;\n  align-items: baseline;\n  justify-content: space-between;\n  gap: 16px;\n  margin: 0 0 12px;\n}\n\n.fl-name {\n  display: -webkit-box;\n  -webkit-line-clamp: 2;\n  -webkit-box-orient: vertical;\n  overflow: hidden;\n  margin: 0;\n  min-width: 0;\n  font-size: 22px;\n  font-weight: 500;\n  line-height: 1.25;\n  letter-spacing: 0.2px;\n  opacity: 0.92;\n  word-break: break-word;\n}\n\n/* 右上角的分类字样不许被长家族名挤成省略号 */\n.fl-card-head .fl-meta {\n  flex: none;\n  align-self: flex-start;\n  padding-top: 5px;\n  white-space: nowrap;\n}\n\n.fl-tags {\n  display: flex;\n  flex-wrap: wrap;\n  gap: 6px;\n  margin: 0 0 16px;\n}\n\n.fl-tag {\n  display: inline-flex;\n  align-items: center;\n  height: 22px;\n  padding: 0 10px;\n  border-radius: 999px;\n  background: var(--fl-tag-bg);\n  color: var(--fl-muted);\n  font-size: 11px;\n  letter-spacing: 0.02em;\n  white-space: nowrap;\n}\n\n.fl-tag.is-hot {\n  background: var(--fl-hot-bg);\n  color: var(--fl-hot-ink);\n}\n\n.fl-preview {\n  display: -webkit-box;\n  -webkit-line-clamp: 2;\n  -webkit-box-orient: vertical;\n  overflow: hidden;\n  margin: 0 0 16px;\n  min-height: 0;\n  max-height: 2.8em;\n  font-size: 34px;\n  line-height: 1.4;\n  word-break: break-word;\n  overflow-wrap: anywhere;\n}\n\n.fl-weights {\n  display: flex;\n  flex-wrap: wrap;\n  gap: 6px;\n  margin: 0 0 18px;\n}\n\n.fl-weight {\n  height: 26px;\n  padding: 0 10px;\n  border-radius: 999px;\n  border: 1px solid transparent;\n  background: var(--fl-weight-bg);\n  color: var(--fl-dim);\n  font-family: inherit;\n  font-size: 11px;\n  letter-spacing: 0.02em;\n  cursor: pointer;\n  transition: background 0.2s var(--fl-ease), color 0.2s var(--fl-ease),\n    transform 0.2s var(--fl-ease);\n}\n\n.fl-weight:hover {\n  color: var(--fl-ink);\n  transform: translateY(-1px);\n}\n\n.fl-weight[aria-pressed=\"true\"] {\n  background: var(--fl-accent);\n  color: var(--fl-accent-ink);\n  font-weight: 600;\n  box-shadow: inset 0 0 0 1px var(--fl-press-ring);\n}\n\n.fl-weights-note {\n  display: inline-flex;\n  align-items: center;\n  height: 26px;\n  font-size: 11px;\n  letter-spacing: 0.02em;\n  color: var(--fl-dim);\n}\n\n.fl-card-foot {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 12px;\n  margin-top: auto;\n  padding-top: 4px;\n}\n\n.fl-meta {\n  min-width: 0;\n  font-size: 11px;\n  letter-spacing: 0.02em;\n  color: var(--fl-dim);\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n\n.fl-copy {\n  flex: none;\n  display: inline-flex;\n  align-items: center;\n  height: 34px;\n  padding: 0 20px;\n  border: 0;\n  border-radius: 999px;\n  background: var(--fl-copy-bg);\n  color: var(--fl-ink);\n  font-family: inherit;\n  font-size: 13px;\n  font-weight: 500;\n  letter-spacing: 0.02em;\n  cursor: pointer;\n  transition: background 0.2s var(--fl-ease), transform 0.2s var(--fl-ease),\n    color 0.2s var(--fl-ease);\n}\n\n.fl-copy:hover {\n  background: var(--fl-copy-hover-bg);\n  color: var(--fl-copy-hover-ink);\n  transform: translateY(-1px);\n}\n\n.fl-copy:active {\n  transform: translateY(0);\n}\n\n.fl-copy[data-done=\"1\"] {\n  background: var(--fl-copy-hover-bg);\n  color: var(--fl-copy-hover-ink);\n}\n\n/* ── 空白 / 骨架 / 错误 ───────────────────────────────── */\n\n.fl-empty,\n.fl-error {\n  padding: 80px 0;\n  text-align: center;\n  color: var(--fl-dim);\n}\n\n.fl-empty b,\n.fl-error b {\n  display: block;\n  margin-bottom: 10px;\n  font-size: 18px;\n  font-weight: 400;\n  color: var(--fl-ink);\n}\n\n.fl-error code {\n  display: inline-block;\n  margin-top: 12px;\n  padding: 8px 14px;\n  border-radius: 999px;\n  background: var(--fl-error-bg);\n  color: var(--fl-error-ink);\n  font-size: 12px;\n}\n\n.fl-skeleton {\n  display: grid;\n  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));\n  gap: 24px;\n}\n\n.fl-skeleton i {\n  display: block;\n  height: 168px;\n  border-radius: 18px;\n  background: linear-gradient(\n    100deg,\n    var(--fl-skeleton-a) 30%,\n    var(--fl-skeleton-b) 50%,\n    var(--fl-skeleton-a) 70%\n  );\n  background-size: 220% 100%;\n  animation: fl-shimmer 1.4s var(--fl-ease) infinite;\n}\n\n@keyframes fl-rise {\n  from {\n    opacity: 0;\n    transform: translateY(28px);\n  }\n  to {\n    opacity: 1;\n    transform: translateY(0);\n  }\n}\n\n@keyframes fl-shimmer {\n  from {\n    background-position: 120% 0;\n  }\n  to {\n    background-position: -20% 0;\n  }\n}\n\n/* ── 窄屏 ─────────────────────────────────────────────── */\n\n@media (max-width: 980px) {\n  .fl-head {\n    grid-template-columns: minmax(0, 1fr);\n    gap: 28px;\n    align-items: start;\n  }\n\n  .fl-stats {\n    max-width: 420px;\n  }\n\n  .fl-grid,\n  .fl-skeleton {\n    gap: 28px;\n  }\n}\n\n@media (max-width: 640px) {\n  .fl-root {\n    padding: 18px 18px 96px;\n  }\n\n  .fl-grid,\n  .fl-skeleton {\n    gap: 16px;\n  }\n\n  .fl-preview {\n    font-size: 30px;\n  }\n\n  .fl-bar {\n    gap: 8px;\n    margin-bottom: 24px;\n    padding: 10px 0;\n  }\n\n  .fl-search {\n    flex: 1 1 100%;\n  }\n\n  .fl-field,\n  .fl-toggle,\n  .fl-btn {\n    height: 38px;\n    font-size: 13px;\n  }\n\n  .fl-toggle,\n  .fl-btn {\n    padding: 0 14px;\n  }\n}\n\n@media (prefers-reduced-motion: reduce) {\n  .fl-card,\n  .fl-skeleton i {\n    animation: none !important;\n  }\n\n  .fl-toggle,\n  .fl-btn,\n  .fl-copy,\n  .fl-weight {\n    transition: none !important;\n  }\n}\n\n/* ── 浅色壳 ──────────────────────────────────────────────\n   整块只换变量：形状、间距、缓动都不动，只把纸从深色换成白色。\n\n   开关是 .fl-root 自己的 data-fl-scheme，由客户端量出来的（client.template.js 的\n   detectScheme）：先看宿主真发给我们的 --dsw-alias-bg-base / --dsw-alias-label-primary\n   到底亮不亮，再退到 color-scheme、dream-skin 的 scheme 属性、主题来源属性。\n   不能只看 html[data-ds-theme-source]：那是「主题偏好来源」，深色皮肤配浅色偏好时\n   它照样写 light，于是深底上套浅色字——正是之前那次显示错乱的成因。 */\n\n.fl-root[data-fl-scheme=\"light\"] {\n  --fl-ink: #16181a;\n  --fl-ink-soft: rgba(22, 24, 26, 0.9);\n  --fl-muted: #6b6b68;\n  --fl-dim: rgba(22, 24, 26, 0.46);\n  --fl-line: rgba(0, 0, 0, 0.08);\n  --fl-surface: rgba(0, 0, 0, 0.025);\n  --fl-field: rgba(0, 0, 0, 0.04);\n  --fl-field-line: rgba(0, 0, 0, 0.1);\n  --fl-placeholder: rgba(22, 24, 26, 0.36);\n  --fl-focus-ring: rgba(29, 108, 193, 0.34);\n  --fl-tag-bg: rgba(0, 0, 0, 0.055);\n  --fl-hot-bg: rgba(0, 0, 0, 0.07);\n  --fl-hot-ink: #2f3a37;\n  --fl-weight-bg: rgba(0, 0, 0, 0.045);\n  --fl-press-ring: rgba(0, 0, 0, 0.08);\n  --fl-copy-bg: rgba(0, 0, 0, 0.045);\n  --fl-copy-hover-bg: #16181a;\n  --fl-copy-hover-ink: #f7f7f5;\n  --fl-btn-bg: #16181a;\n  --fl-btn-ink: #f7f7f5;\n  --fl-btn-hover-bg: #d8e4e1;\n  --fl-btn-hover-ink: #16181a;\n  --fl-btn-off-bg: rgba(0, 0, 0, 0.08);\n  --fl-btn-off-ink: #6b6b68;\n  --fl-skeleton-a: rgba(0, 0, 0, 0.04);\n  --fl-skeleton-b: rgba(0, 0, 0, 0.08);\n  --fl-error-bg: rgba(182, 50, 45, 0.1);\n  --fl-error-ink: #b6322d;\n  --fl-accent: #d8e4e1;\n  --fl-accent-ink: #16181a;\n  --fl-veil: 250, 250, 248;\n}\n\n/* 浅色下字重胶囊选中态的描边要变成黑线，否则浅底上的浅青胶囊没有边界 */\n.fl-root[data-fl-scheme=\"light\"] .fl-weight[aria-pressed=\"true\"] {\n  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.08);\n}\n"

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