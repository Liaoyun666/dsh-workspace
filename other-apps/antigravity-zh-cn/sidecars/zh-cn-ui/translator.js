(function () {
  if (window.__AGY_ZH_CN_ACTIVE__) { return 'already-active'; }
  window.__AGY_ZH_CN_ACTIVE__ = true;
  var DICT = window.__AGY_ZH_CN_DICT__ || {};
  var has = Object.prototype.hasOwnProperty;
  var PATTERNS = [
    [/^(\d+)\s*active conversations?$/i, function (m) { return m[1] + ' 个进行中的对话'; }],
    [/^(\d+)\s*archived conversations?$/i, function (m) { return m[1] + ' 个已归档对话'; }],
    [/^(\d+)\s*conversations?$/i, function (m) { return m[1] + ' 个对话'; }],
    [/^(\d+)\s*comments?$/i, function (m) { return m[1] + ' 条评论'; }],
    [/^(\d+)\s*results?$/i, function (m) { return m[1] + ' 个结果'; }],
    [/^(\d+)\s*files? changed$/i, function (m) { return m[1] + ' 个文件已更改'; }],
    [/^(\d+)\s*files?$/i, function (m) { return m[1] + ' 个文件'; }],
    [/^(\d+)\s*tool calls?$/i, function (m) { return m[1] + ' 次工具调用'; }],
    [/^(\d+)\s*tokens?$/i, function (m) { return m[1] + ' 个 Token'; }],
    [/^(\d+)\s*of\s*(\d+)$/, function (m) { return m[1] + ' / ' + m[2]; }],
    [/^(\d+)\s*(s|m|h|d|w)$/, function (m) {
      var u = { s: '秒前', m: '分钟前', h: '小时前', d: '天前', w: '周前' }[m[2]];
      return m[1] + ' ' + u;
    }],
    [/^(\d+)\s*(seconds?|minutes?|hours?|days?|weeks?|months?|years?) ago$/i, function (m) {
      var u = m[2].toLowerCase();
      var zh = u.indexOf('second') === 0 ? '秒' : u.indexOf('minute') === 0 ? '分钟' : u.indexOf('hour') === 0 ? '小时' : u.indexOf('day') === 0 ? '天' : u.indexOf('week') === 0 ? '周' : u.indexOf('month') === 0 ? '个月' : '年';
      return m[1] + ' ' + zh + '前';
    }],
    [/^just now$/i, function () { return '刚刚'; }],
    [/^Send feedback as (.+)$/, function (m) { return '以 ' + m[1] + ' 身份发送反馈'; }],
    [/^Show (\d+) breakdown$/, function (m) { return '显示 ' + m[1] + ' 项明细'; }],
    [/^Select model, current: (.+)$/, function (m) { return '选择模型，当前：' + m[1]; }],
    [/^Agent permissions preset selector, current: (.+)$/, function (m) { return '智能体权限预设选择器，当前：' + m[1]; }],
    [/^Select project, current: (.+)$/, function (m) { return '选择项目，当前：' + m[1]; }]
  ];
  var ATTRS = ['placeholder', 'aria-label', 'title', 'alt'];
  var SKIP = { SCRIPT: 1, STYLE: 1, CODE: 1, PRE: 1, TEXTAREA: 1 };
  function lookup(s) {
    if (has.call(DICT, s)) { return DICT[s]; }
    for (var i = 0; i < PATTERNS.length; i++) {
      var m = s.match(PATTERNS[i][0]);
      if (m) { return PATTERNS[i][1](m); }
    }
    return null;
  }
  function isSkipped(el) {
    if (!el || el.nodeType !== 1) { return false; }
    if (SKIP[el.tagName]) { return true; }
    if (el.isContentEditable) { return true; }
    if (el.getAttribute && el.getAttribute('role') === 'textbox') { return true; }
    return false;
  }
  function translateText(node) {
    var raw = node.nodeValue;
    if (!raw) { return; }
    var t = raw.trim();
    if (!t) { return; }
    var parent = node.parentElement;
    if (parent && parent.closest && parent.closest('code, pre, .font-mono')) { return; }
    var v = lookup(t);
    if (v != null && v !== t) { node.nodeValue = raw.replace(t, v); }
  }
  function translateAttrs(el) {
    if (!el.getAttribute) { return; }
    for (var i = 0; i < ATTRS.length; i++) {
      var a = ATTRS[i];
      var val = el.getAttribute(a);
      if (!val) { continue; }
      var t = val.trim();
      var v = lookup(t);
      if (v != null && v !== t) { el.setAttribute(a, v); }
    }
  }
  function walk(node) {
    if (node.nodeType === 3) { translateText(node); return; }
    if (node.nodeType !== 1) { return; }
    if (isSkipped(node)) { return; }
    translateAttrs(node);
    var children = node.childNodes;
    for (var i = 0; i < children.length; i++) { walk(children[i]); }
  }
  var queued = false;
  var pending = [];
  function flush() {
    queued = false;
    var muts = pending; pending = [];
    for (var i = 0; i < muts.length; i++) {
      var m = muts[i];
      if (m.type === 'characterData') { translateText(m.target); }
      else if (m.type === 'attributes') { translateAttrs(m.target); }
      else {
        for (var j = 0; j < m.addedNodes.length; j++) { walk(m.addedNodes[j]); }
      }
    }
  }
  var observer = new MutationObserver(function (muts) {
    for (var i = 0; i < muts.length; i++) { pending.push(muts[i]); }
    if (!queued) { queued = true; requestAnimationFrame(flush); }
  });
  function start() {
    if (!document.body) { return; }
    walk(document.body);
    document.documentElement.lang = 'zh-CN';
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }
  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', start, { once: true }); } else { start(); }
  return 'zh-cn-active';
})();