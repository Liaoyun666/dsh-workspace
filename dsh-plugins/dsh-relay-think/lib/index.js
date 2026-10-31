/**
 * dsh-relay-think 宿主半 —— 中转站（llm-pi-ai 路由）模型思考强度的读写接口。
 *
 * 背景：DSH 的 Models 设置页刻意不提供「推理强度」编辑（它是逐模型能力），
 * 而没有声明 reasoningEfforts 的中转站模型，在输入框的模型选择器里不会出现
 * 思考强度子菜单。本插件补上这一块：
 *
 *   GET  /relay-think/state    列出 llm-pi-ai 的每条中转站路由、模型、
 *                              当前声明与目录里实际生效的思考档位
 *   POST /relay-think/apply    为一个模型写入/清除 reasoningEfforts，
 *                              或设置该路由的默认档位（providers.<route>.reasoning）
 *
 * 写入一律走 ctx.settings.mutate（与 Models 页同一条设置 seam）：
 * schema 校验、revision 冲突检测、profile patch 持久化、热重载都由宿主负责。
 * 本插件不直接改 YAML、不碰凭据、不接触任何 provider 请求。
 *
 * config（在 profile 的 cordis.patch.yml 里按行 id 覆写本行）：
 *   settingsNs: 'llm-pi-ai'   要编辑的设置命名空间（默认 llm-pi-ai）
 */
import {
  DISPLAY_LEVELS,
  PRESETS,
  classifyLevels,
  declaredLevelIds,
  declaredOf,
  findModelSlot,
  isRecord,
  planDefaultEffort,
  planModelLevels,
  resolveRequestedLevels,
  safeBaseUrl,
} from './plan.js';

export const name = 'relay-think';

/** 路由挂在 web carrier 上。 */
export const inject = ['webServer'];

/** 默认编辑的设置命名空间：llm-pi-ai 行的 id。 */
const DEFAULT_SETTINGS_NS = 'llm-pi-ai';
/** 两条接口的基路径。 */
const API_BASE = '/relay-think';
/** POST 请求体上限：一条模型声明只有几十字节，64 KiB 足够且不给滥用留空间。 */
const MAX_BODY_BYTES = 64 * 1024;

/** 带 HTTP 状态码的受控失败。 */
class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

/** 读 config（缺省/写错都退回默认值，不阻塞装载）。 */
function readConfig(config) {
  const raw = isRecord(config) ? config : {};
  const settingsNs = typeof raw.settingsNs === 'string' && raw.settingsNs.trim() !== ''
    ? raw.settingsNs.trim()
    : DEFAULT_SETTINGS_NS;
  return { settingsNs };
}

/** 把任意异常折成一句可读文本（不展开 stack）。 */
function messageOf(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** 发送 JSON 响应。 */
function sendJson(res, status, payload) {
  const body = `${JSON.stringify(payload)}\n`;
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-length', Buffer.byteLength(body));
  res.end(body);
}

/** 读取并解析 JSON 请求体；空体按 {} 处理。 */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'body-too-large', `请求体超过 ${MAX_BODY_BYTES} 字节`);
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid-json', '请求体不是合法 JSON');
  }
}

/** 取一个必填字符串字段。 */
function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, 'invalid-request', `缺少必填字段 "${field}"`);
  }
  return value.trim();
}

/** 描述命名空间当前值：resolved（含默认值）与 user（用户层原文）。 */
function readNamespace(settings, settingsNs) {
  let descriptors;
  try {
    descriptors = settings.describe();
  } catch (error) {
    throw new HttpError(503, 'settings-unavailable', `读取设置失败：${messageOf(error)}`);
  }
  const descriptor = descriptors.find((row) => row.ns === settingsNs);
  if (descriptor === undefined) {
    throw new HttpError(
      503,
      'namespace-unavailable',
      `设置命名空间 "${settingsNs}" 不存在；请确认 llm-pi-ai 已挂载（或本插件 config.settingsNs 指对了）`,
    );
  }
  const resolvedProviders = isRecord(descriptor.value?.providers) ? descriptor.value.providers : {};
  const userProviders = isRecord(descriptor.user?.providers) ? descriptor.user.providers : {};
  return { descriptor, resolvedProviders, userProviders };
}

/**
 * 汇总中转站路由与模型状态，供浏览器半渲染。
 * @param ctx - 宿主插件上下文。
 * @param settingsNs - llm-pi-ai 的设置命名空间。
 * @returns 可直接 JSON 化的状态快照。
 */
async function buildState(ctx, settingsNs) {
  const settings = ctx.get('settings');
  if (settings === undefined) {
    return {
      ok: true,
      available: false,
      reason: 'settings 服务未挂载：当前部署没有 profile 设置面板，无法编辑模型思考强度',
      namespace: settingsNs,
      presets: PRESETS.map(publicPreset),
      levels: DISPLAY_LEVELS,
      routes: [],
    };
  }
  let descriptor;
  let resolvedProviders;
  let userProviders;
  try {
    const namespace = readNamespace(settings, settingsNs);
    descriptor = namespace.descriptor;
    resolvedProviders = namespace.resolvedProviders;
    userProviders = namespace.userProviders;
  } catch (error) {
    if (error instanceof HttpError) {
      return {
        ok: true,
        available: false,
        reason: error.message,
        namespace: settingsNs,
        presets: PRESETS.map(publicPreset),
        levels: DISPLAY_LEVELS,
        routes: [],
      };
    }
    throw error;
  }
  const llm = ctx.get('llm');
  const routes = [];
  for (const [providerId, resolvedProfile] of Object.entries(resolvedProviders)) {
    if (!isRecord(resolvedProfile)) continue;
    const userProfile = isRecord(userProviders[providerId]) ? userProviders[providerId] : undefined;
    const configuredModels = Array.isArray(userProfile?.models) ? userProfile.models : [];
    const resolvedModels = Array.isArray(resolvedProfile.models) ? resolvedProfile.models : [];
    let catalogModels = [];
    let routeError = typeof resolvedProfile.catalogError === 'string' ? resolvedProfile.catalogError : null;
    if (llm !== undefined) {
      try {
        catalogModels = await llm.listModels(providerId);
      } catch (error) {
        routeError ??= messageOf(error);
      }
    }
    const ids = [];
    const seen = new Set();
    for (const model of [...configuredModels, ...resolvedModels, ...(Array.isArray(catalogModels) ? catalogModels : [])]) {
      if (!isRecord(model) || typeof model.id !== 'string' || seen.has(model.id)) continue;
      seen.add(model.id);
      ids.push({ id: model.id, name: typeof model.name === 'string' ? model.name : undefined });
    }
    const models = [];
    for (const entry of ids) {
      const declared = declaredOf(userProfile, entry.id) ?? declaredOf(resolvedProfile, entry.id);
      let info;
      if (llm !== undefined) {
        try {
          info = await llm.resolveModelInfo(providerId, entry.id);
        } catch {
          // 目录不可用的模型仍然展示配置状态，只是没有 catalog 信息。
        }
      }
      const reasoning = isRecord(info?.reasoning)
        ? {
            efforts: Array.isArray(info.reasoning.efforts)
              ? info.reasoning.efforts.map((effort) => (typeof effort?.id === 'string' ? effort.id : String(effort))).filter((id) => id !== '')
              : [],
            defaultEffort: typeof info.reasoning.defaultEffort === 'string' ? info.reasoning.defaultEffort : null,
          }
        : null;
      let slot = null;
      try {
        slot = findModelSlot(userProviders, resolvedProviders, providerId, entry.id).kind;
      } catch {
        slot = null;
      }
      models.push({
        id: entry.id,
        name: entry.name ?? entry.id,
        declared: declared === undefined ? null : declared,
        declaredLevels: declaredLevelIds(declared),
        preset: declared === undefined ? 'none' : declared === false ? 'disabled' : classifyLevels(declared),
        catalogEfforts: reasoning === null ? null : reasoning.efforts,
        catalogDefaultEffort: reasoning === null ? null : reasoning.defaultEffort,
        reasoningSupported: reasoning !== null,
        slot,
        editable: userProfile !== undefined && slot !== null,
      });
    }
    routes.push({
      provider: providerId,
      displayName: typeof resolvedProfile.displayName === 'string' ? resolvedProfile.displayName : providerId,
      api: typeof resolvedProfile.api === 'string' ? resolvedProfile.api : null,
      baseUrl: safeBaseUrl(resolvedProfile.baseURL),
      defaultEffort: typeof resolvedProfile.reasoning === 'string' ? resolvedProfile.reasoning : null,
      editable: userProfile !== undefined,
      error: routeError,
      models,
    });
  }
  routes.sort((left, right) => left.provider.localeCompare(right.provider));
  return {
    ok: true,
    available: true,
    namespace: settingsNs,
    revision: descriptor.revision,
    presets: PRESETS.map(publicPreset),
    levels: DISPLAY_LEVELS,
    routes,
  };
}

/** 预设的公开形状（浏览器半用 id + zh/en 自行取文案）。 */
function publicPreset(preset) {
  return { id: preset.id, levels: preset.levels, zh: preset.zh, en: preset.en };
}

/**
 * 应用一次修改。
 * @param ctx - 宿主插件上下文。
 * @param settingsNs - llm-pi-ai 的设置命名空间。
 * @param body - { operation, provider, model?, preset?, levels?, effort?, expectedRevision? }
 * @returns 写入后的最新状态。
 */
async function applyChange(ctx, settingsNs, body) {
  const settings = ctx.get('settings');
  if (settings === undefined) {
    throw new HttpError(503, 'settings-unavailable', 'settings 服务未挂载，无法持久化思考强度设置');
  }
  const operation = body?.operation === 'defaultEffort' ? 'defaultEffort' : 'levels';
  const { descriptor, resolvedProviders, userProviders } = readNamespace(settings, settingsNs);
  const expectedRevision = body?.expectedRevision;
  if (expectedRevision !== undefined && expectedRevision !== descriptor.revision) {
    const error = new HttpError(409, 'revision-conflict', `设置已被其他改动更新（期望 revision ${String(expectedRevision)}，当前 ${String(descriptor.revision)}），请刷新后重试`);
    error.state = await buildState(ctx, settingsNs);
    throw error;
  }
  const provider = requireString(body?.provider, 'provider');
  if (!isRecord(userProviders[provider])) {
    throw new HttpError(400, 'not-editable', `提供商 "${provider}" 不在本 profile 的用户配置里，无法安全编辑`);
  }
  let ops;
  try {
    if (operation === 'levels') {
      const model = requireString(body?.model, 'model');
      const requested = resolveRequestedLevels(body);
      const levels = requested.mode === 'none' ? null : requested.levels;
      ops = planModelLevels(userProviders, resolvedProviders, provider, model, levels);
    } else {
      const effort = body?.effort === null || body?.effort === undefined || body?.effort === '' ? null : requireString(body.effort, 'effort');
      ops = planDefaultEffort(provider, effort);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'invalid-request', messageOf(error));
  }
  try {
    await settings.mutate(settingsNs, ops, descriptor.revision);
  } catch (error) {
    if (isRecord(error) && error.code === 'SETTINGS_CONFLICT') {
      throw new HttpError(409, 'revision-conflict', messageOf(error));
    }
    throw new HttpError(400, 'write-rejected', `写入被宿主拒绝：${messageOf(error)}`);
  }
  return buildState(ctx, settingsNs);
}

/**
 * 宿主插件体：挂两条 JSON 路由，并把 settingsNs 注入到页面启动数据，
 * 让浏览器半知道该往哪个命名空间/接口地址发请求。
 * @param ctx - 宿主根上下文。
 * @param config - 本行配置（见文件头）。
 */
export function apply(ctx, config) {
  const { settingsNs } = readConfig(config);

  ctx.on('webserver/index-inject', (table) => {
    table.push({
      kind: 'global',
      name: '__DSH_RELAY_THINK__',
      value: { settingsNs, apiBase: API_BASE },
    });
  });

  /** 复刻官方插件的信任围栏：Host/Origin + 浏览器登录 cookie。 */
  const rejected = (req, res) => {
    const connection = ctx.get('connection');
    if (connection === undefined || typeof connection.requestRejection !== 'function') return false;
    const rejection = connection.requestRejection(req);
    if (rejection === undefined) return false;
    res.statusCode = rejection;
    res.end();
    return true;
  };

  /** 包一层统一的错误处理。 */
  const handler = (fn) => async (req, res) => {
    try {
      if (rejected(req, res)) return;
      await fn(req, res);
    } catch (error) {
      if (res.writableEnded) return;
      const status = error instanceof HttpError ? error.status : 500;
      const code = error instanceof HttpError ? error.code : 'internal';
      ctx.logger?.warn?.(`relay-think: ${messageOf(error)}`);
      sendJson(res, status, {
        ok: false,
        error: { code, message: messageOf(error) },
        ...(error instanceof HttpError && error.state !== undefined ? { state: error.state } : {}),
      });
    }
  };

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${API_BASE}/state`,
    handler: handler(async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405;
        res.setHeader('allow', 'GET, HEAD');
        res.end();
        return;
      }
      const state = await buildState(ctx, settingsNs);
      if (req.method === 'HEAD') {
        sendJsonHead(res, 200);
        return;
      }
      sendJson(res, 200, state);
    }),
  }), `relay-think: GET ${API_BASE}/state`);

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${API_BASE}/apply`,
    handler: handler(async (req, res) => {
      if (req.method !== 'POST') {
        res.statusCode = 405;
        res.setHeader('allow', 'POST');
        res.end();
        return;
      }
      const body = await readJsonBody(req);
      const state = await applyChange(ctx, settingsNs, body);
      sendJson(res, 200, state);
    }),
  }), `relay-think: POST ${API_BASE}/apply`);

  ctx.logger?.info?.(`relay-think: 已挂载（namespace=${settingsNs}，接口 ${API_BASE}/state）`);
}

/** HEAD 响应只写头。 */
function sendJsonHead(res, status) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end();
}

/** 测试用：导出纯宿主逻辑，便于在没有运行中 dsh 的情况下验证。 */
export { applyChange, buildState };