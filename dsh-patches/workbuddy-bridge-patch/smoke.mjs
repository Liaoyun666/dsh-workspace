import fs from 'node:fs';
const code = fs.readFileSync(process.argv[2], 'utf8');
let factory;
globalThis.window = { __ModuleLoader__: { load: (def) => { factory = def.factory; } } };
const noop = () => {};
class Component { constructor(props) { this.props = props; } setState() {} render() { return null; } }
const hookish = (name) => (...args) => ({ hook: name, args });
const react = new Proxy({}, { get: (t, k) => {
  if (k === '__esModule') return true;
  if (k === 'Component' || k === 'PureComponent') return Component;
  if (k === 'createElement') return (type, props, ...kids) => ({ type, props, kids });
  if (k === 'default') return {};
  return hookish(String(k));
}});
const jsxRuntime = new Proxy({}, { get: (t, k) => k === '__esModule' ? true : (type, props, key) => ({ type, props, key }) });
const primitives = new Proxy({}, { get: (t, k) => {
  if (k === '__esModule') return true;
  return new Proxy(function () {}, { get: () => noop, apply: () => null, construct: () => ({}) });
}});
const req = (id) => {
  if (id === 'react') return react;
  if (id === 'react/jsx-runtime' || id === 'react/jsx-dev-runtime') return jsxRuntime;
  if (id === 'react-dom') return { createPortal: noop };
  return primitives;
};
new Function('window', 'globalThis', code)(globalThis.window, globalThis);
if (typeof factory !== 'function') throw new Error('factory not captured');
const mod = factory(req);
console.log('EVAL_OK exports=', Object.keys(mod || {}).join(','));
