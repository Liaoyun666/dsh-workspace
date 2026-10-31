/**
 * dsh-relay-think 的纯逻辑半：思考档位预设、声明的校验/识别、以及「把声明写进
 * llm-pi-ai 配置」所需的路径规划。
 *
 * 这一层不碰 ctx、不碰 fs，只做数据变换，因此可以单独跑单测（test/plan.test.mjs）。
 * 宿主半（lib/index.js）负责把这里的 ops 交给 settings.mutate 落盘。
 */

/** pi-ai 认可的全部思考档位，按升序排列（与 dsh-llm-pi-ai 的 THINKING_LEVELS 一致）。 */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** 需要在界面上展示名称的档位（off 单独表达“不发送思考参数”，不算一档强度）。 */
export const DISPLAY_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * 内置预设。levels 的键是选择器里的档位 id，值是真正发给中转站的线缆拼写；
 * off: null 表示「不发送思考参数」，也就是交给中转站自己的默认行为。
 * 与 dsh-llm-pi-ai 的 reasoningEfforts 完全同构，可直接写进配置。
 */
export const PRESETS = [
  {
    id: 'standard',
    levels: { off: null, low: 'low', medium: 'medium', high: 'high' },
    zh: '常用三档（低/中/高）',
    en: 'Standard (low/medium/high)',
  },
  {
    id: 'dual',
    levels: { off: null, low: 'low', high: 'high' },
    zh: '两档（低/高）',
    en: 'Dual (low/high)',
  },
  {
    id: 'wide',
    levels: { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high' },
    zh: '四档（极简/低/中/高）',
    en: 'Wide (minimal/low/medium/high)',
  },
  {
    id: 'full',
    levels: { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
    zh: '全档（极简…最高）',
    en: 'Full (minimal…max)',
  },
];

/** 预设 id → 预设。 */
export const PRESET_BY_ID = new Map(PRESETS.map((preset) => [preset.id, preset]));

/** 是否是普通对象。 */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 解析客户端传来的预设/自定义等级；非法输入抛出带人话的 TypeError。 */
export function resolveRequestedLevels(input) {
  if (!isRecord(input)) throw new TypeError('levels 必须是一个对象');
  const presetId = typeof input.preset === 'string' ? input.preset : undefined;
  if (presetId === 'none') return { mode: 'none', levels: null, preset: 'none' };
  if (presetId === 'disabled') return { mode: 'set', levels: false, preset: 'disabled' };
  if (presetId !== undefined && presetId !== 'custom') {
    const preset = PRESET_BY_ID.get(presetId);
    if (preset === undefined) throw new TypeError(`未知的思考档位预设 "${presetId}"`);
    return { mode: 'set', levels: validateLevels(preset.levels), preset: preset.id };
  }
  if (presetId === 'custom' || isRecord(input.levels)) {
    const levels = validateLevels(input.levels);
    return { mode: 'set', levels, preset: classifyLevels(levels) };
  }
  throw new TypeError('缺少 preset 或 levels');
}

/**
 * 校验一份 reasoningEfforts 声明，返回去掉多余键后的副本。
 * 规则对齐 dsh-llm-pi-ai：只有 off 允许空值；至少要有一个 off 之外的档位；
 * 线缆拼写必须是非空字符串。
 */
export function validateLevels(levels) {
  if (!isRecord(levels)) throw new TypeError('reasoningEfforts 必须是一个对象');
  const keys = Object.keys(levels);
  if (keys.length === 0) throw new TypeError('reasoningEfforts 不能为空');
  let thinking = 0;
  const out = {};
  for (const level of THINKING_LEVELS) {
    if (!Object.hasOwn(levels, level)) continue;
    const wire = levels[level];
    if (wire === null) {
      if (level !== 'off') throw new TypeError(`档位 "${level}" 需要一个线缆拼写（只有 off 可以留空）`);
      out[level] = null;
      continue;
    }
    if (typeof wire !== 'string') throw new TypeError(`档位 "${level}" 的线缆拼写必须是字符串`);
    if (wire.trim() === '') throw new TypeError(`档位 "${level}" 的线缆拼写不能是空字符串`);
    if (wire.length > 64) throw new TypeError(`档位 "${level}" 的线缆拼写过长（>64）`);
    if (level !== 'off') thinking += 1;
    out[level] = wire;
  }
  for (const key of keys) {
    if (!THINKING_LEVELS.includes(key)) throw new TypeError(`未知的思考档位 "${key}"`);
  }
  if (thinking === 0) throw new TypeError('至少要声明一个 off 之外的思考档位（只声明 off 没有意义，请用“关闭声明”）');
  return out;
}

/** 判断一份声明与哪个预设等价；不匹配返回 'custom'。 */
export function classifyLevels(levels) {
  if (!isRecord(levels)) return 'custom';
  const normalized = Object.entries(levels)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  for (const preset of PRESETS) {
    const candidate = Object.entries(preset.levels).sort(([left], [right]) => left.localeCompare(right));
    if (normalized.length !== candidate.length) continue;
    if (normalized.every(([key, value], index) => key === candidate[index][0] && value === candidate[index][1])) {
      return preset.id;
    }
  }
  return 'custom';
}

/** 把声明折叠成界面可读的档位 id 列表（不含 off）。 */
export function declaredLevelIds(declared) {
  if (!isRecord(declared)) return [];
  return DISPLAY_LEVELS.filter((level) => typeof declared[level] === 'string' && declared[level] !== '');
}

/**
 * 从 route 的配置片段里读出某个模型当前的 reasoningEfforts 声明。
 * @returns {undefined | false | Record<string, string | null>} 未声明 / 明确声明为 false / 声明对象
 */
export function declaredOf(profile, modelId) {
  if (!isRecord(profile)) return undefined;
  if (Array.isArray(profile.models)) {
    const entry = profile.models.find((model) => isRecord(model) && model.id === modelId);
    if (isRecord(entry) && entry.reasoningEfforts !== undefined) return entry.reasoningEfforts;
  }
  if (isRecord(profile.modelOverrides)) {
    const override = profile.modelOverrides[modelId];
    if (isRecord(override) && override.reasoningEfforts !== undefined) return override.reasoningEfforts;
  }
  return undefined;
}

/** 模型在用户配置里的落点（models 数组或 modelOverrides）。 */
export function findModelSlot(userProviders, resolvedProviders, routeId, modelId) {
  const user = isRecord(userProviders) && isRecord(userProviders[routeId]) ? userProviders[routeId] : undefined;
  if (user === undefined) {
    throw new TypeError(`提供商 "${routeId}" 不在本 profile 的用户配置里，无法安全编辑（请先在 Models 页配置它）`);
  }
  const resolved = isRecord(resolvedProviders) && isRecord(resolvedProviders[routeId]) ? resolvedProviders[routeId] : undefined;
  const userModels = Array.isArray(user.models) ? user.models : undefined;
  const knownModels = userModels ?? (isRecord(resolved) && Array.isArray(resolved.models) ? resolved.models : undefined);
  if (knownModels !== undefined) {
    const index = knownModels.findIndex((model) => isRecord(model) && model.id === modelId);
    if (index === -1) {
      throw new TypeError(`模型 "${modelId}" 不在该提供商的 models 列表里；请先在 Models 页把它加进列表`);
    }
    return {
      kind: 'models',
      routeId,
      modelId,
      index,
      models: knownModels,
      userModels,
      path: ['providers', routeId, 'models', index, 'reasoningEfforts'],
    };
  }
  const overrides = isRecord(user.modelOverrides) ? user.modelOverrides : undefined;
  const existing = isRecord(overrides) && isRecord(overrides[modelId]) ? overrides[modelId] : undefined;
  return {
    kind: 'overrides',
    routeId,
    modelId,
    path: ['providers', routeId, 'modelOverrides', modelId, 'reasoningEfforts'],
    overridePath: ['providers', routeId, 'modelOverrides', modelId],
    existing,
  };
}

/** 声明 / 取消声明一个模型的思考档位，返回 settings.mutate 的 ops。 */
export function planModelLevels(userProviders, resolvedProviders, routeId, modelId, levels) {
  const slot = findModelSlot(userProviders, resolvedProviders, routeId, modelId);
  if (levels === null) {
    // 取消声明
    if (slot.kind === 'models') {
      if (slot.userModels !== undefined) return [{ op: 'unset', path: slot.path }];
      const next = slot.models.map((model) => {
        if (!isRecord(model) || model.id !== modelId) return model;
        const copy = { ...model };
        delete copy.reasoningEfforts;
        return copy;
      });
      return [{ op: 'set', path: ['providers', routeId, 'models'], value: next }];
    }
    if (slot.existing !== undefined && Object.keys(slot.existing).every((key) => key === 'reasoningEfforts')) {
      return [{ op: 'unset', path: slot.overridePath }];
    }
    return [{ op: 'unset', path: slot.path }];
  }
  const checked = levels === false ? false : validateLevels(levels);
  if (slot.kind === 'models') {
    if (slot.userModels !== undefined) return [{ op: 'set', path: slot.path, value: checked }];
    const next = slot.models.map((model) => {
      if (!isRecord(model) || model.id !== modelId) return model;
      return { ...model, reasoningEfforts: checked };
    });
    return [{ op: 'set', path: ['providers', routeId, 'models'], value: next }];
  }
  return [{ op: 'set', path: slot.path, value: checked }];
}

/** 设置 / 清除提供商的默认思考档位（选择器打开时预选的那一档）。 */
export function planDefaultEffort(routeId, effort) {
  const path = ['providers', routeId, 'reasoning'];
  if (effort === null || effort === undefined || effort === '') return [{ op: 'unset', path }];
  if (typeof effort !== 'string' || !THINKING_LEVELS.includes(effort)) {
    throw new TypeError(`未知的思考档位 "${String(effort)}"`);
  }
  return [{ op: 'set', path, value: effort }];
}

/** 从 baseURL 里剥掉可能存在的 userinfo / query，只留 origin + pathname 供界面展示。 */
export function safeBaseUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.href.replace(/\/$/, '');
  } catch {
    return null;
  }
}