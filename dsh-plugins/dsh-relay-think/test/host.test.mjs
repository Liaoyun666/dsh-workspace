import assert from 'node:assert/strict';
import test from 'node:test';
import { applyChange, buildState } from '../lib/index.js';

/**
 * 构造一个宿主 ctx 桩：settings.describe 返回固定的 resolved/user 两层，
 * settings.mutate 记录 ops 并更新一层内存状态（足以验证状态汇总与错误映射）。
 */
function makeCtx(initial = {}) {
  const config = {
    providers: {
      aihubmix: {
        displayName: 'AIHubMix',
        apiKeyEnv: 'AIHUBMIX_API_KEY',
        api: 'openai-responses',
        baseURL: 'https://user:pass@aihubmix.com/v1?token=secret',
        models: [
          { id: 'gpt-x', name: 'GPT-X', contextWindow: 1000000, input: ['text', 'image'] },
          { id: 'gpt-y', name: 'GPT-Y' },
        ],
      },
      catalog: {
        apiKeyEnv: 'CATALOG_KEY',
        modelOverrides: { 'm-1': { contextWindow: 200000 } },
      },
    },
  };
  const state = {
    descriptor: {
      ns: 'llm-pi-ai',
      revision: initial.revision ?? 0,
      value: structuredClone(config),
      user: structuredClone(config),
    },
    mutations: [],
  };
  const ctx = {
    get(name) {
      if (name === 'settings') return settings;
      if (name === 'llm') return llm;
      return undefined;
    },
    logger: { warn() {}, info() {} },
  };
  const settings = {
    describe() {
      return [structuredClone(state.descriptor)];
    },
    async mutate(ns, ops, expectedRevision) {
      if (expectedRevision !== undefined && expectedRevision !== state.descriptor.revision) {
        const error = new Error('stale');
        error.code = 'SETTINGS_CONFLICT';
        throw error;
      }
      state.mutations.push({ ns, ops });
      state.descriptor.revision += 1;
    },
  };
  const llm = {
    async listModels(provider) {
      const profile = config.providers[provider];
      if (profile === undefined) return [];
      if (Array.isArray(profile.models)) return profile.models;
      return Object.keys(profile.modelOverrides ?? {}).map((id) => ({ id, name: id }));
    },
    async resolveModelInfo(provider, model) {
      const profile = config.providers[provider];
      if (profile === undefined) throw new Error('no provider');
      const entry = (profile.models ?? []).find((candidate) => candidate.id === model);
      const overrides = profile.modelOverrides ?? {};
      const declared = entry?.reasoningEfforts ?? overrides[model]?.reasoningEfforts;
      if (declared === undefined || declared === false) return { confidence: 'declared', reasoning: undefined };
      const efforts = Object.keys(declared).map((id) => ({ id, name: id }));
      return { confidence: 'declared', reasoning: { efforts } };
    },
  };
  return { ctx, state };
}

test('buildState summarizes relay routes, models and declared levels', async () => {
  const { ctx } = makeCtx();
  const state = await buildState(ctx, 'llm-pi-ai');
  assert.equal(state.ok, true);
  assert.equal(state.available, true);
  assert.equal(state.namespace, 'llm-pi-ai');
  assert.equal(state.revision, 0);
  assert.equal(state.routes.length, 2);
  const route = state.routes.find((entry) => entry.provider === 'aihubmix');
  assert.equal(route.displayName, 'AIHubMix');
  assert.equal(route.baseUrl, 'https://aihubmix.com/v1');
  assert.equal(route.defaultEffort, null);
  assert.deepEqual(route.models.map((model) => model.id), ['gpt-x', 'gpt-y']);
  assert.equal(route.models[0].preset, 'none');
  assert.equal(route.models[0].editable, true);
  const catalog = state.routes.find((entry) => entry.provider === 'catalog');
  assert.equal(catalog.models[0].slot, 'overrides');
});

test('applyChange rejects an unknown model with a 400 HttpError', async () => {
  const { ctx, state } = makeCtx();
  await assert.rejects(
    applyChange(ctx, 'llm-pi-ai', { operation: 'levels', provider: 'aihubmix', model: 'does-not-exist', preset: 'standard' }),
    (error) => error.status === 400 && /models 列表/.test(error.message),
  );
  assert.equal(state.mutations.length, 0);
});

test('applyChange rejects an unknown preset with a 400 HttpError', async () => {
  const { ctx } = makeCtx();
  await assert.rejects(
    applyChange(ctx, 'llm-pi-ai', { operation: 'levels', provider: 'aihubmix', model: 'gpt-x', preset: 'nope' }),
    (error) => error.status === 400 && /未知/.test(error.message),
  );
});

test('applyChange writes a model declaration through settings.mutate', async () => {
  const { ctx, state } = makeCtx();
  const next = await applyChange(ctx, 'llm-pi-ai', {
    operation: 'levels',
    provider: 'aihubmix',
    model: 'gpt-x',
    preset: 'standard',
    expectedRevision: 0,
  });
  assert.equal(state.mutations.length, 1);
  assert.deepEqual(state.mutations[0].ops, [{
    op: 'set',
    path: ['providers', 'aihubmix', 'models', 0, 'reasoningEfforts'],
    value: { off: null, low: 'low', medium: 'medium', high: 'high' },
  }]);
  assert.equal(next.revision, 1);
});

test('applyChange clears a declaration and sets a provider default', async () => {
  const { ctx, state } = makeCtx();
  await applyChange(ctx, 'llm-pi-ai', { operation: 'levels', provider: 'aihubmix', model: 'gpt-x', preset: 'none', expectedRevision: 0 });
  assert.deepEqual(state.mutations[0].ops, [{
    op: 'unset',
    path: ['providers', 'aihubmix', 'models', 0, 'reasoningEfforts'],
  }]);
  await applyChange(ctx, 'llm-pi-ai', { operation: 'defaultEffort', provider: 'aihubmix', effort: 'high', expectedRevision: 1 });
  assert.deepEqual(state.mutations[1].ops, [{
    op: 'set',
    path: ['providers', 'aihubmix', 'reasoning'],
    value: 'high',
  }]);
});

test('applyChange rejects a stale revision with 409 and fresh state', async () => {
  const { ctx } = makeCtx({ revision: 3 });
  await assert.rejects(
    applyChange(ctx, 'llm-pi-ai', { operation: 'levels', provider: 'aihubmix', model: 'gpt-x', preset: 'dual', expectedRevision: 1 }),
    (error) => error.status === 409 && error.code === 'revision-conflict' && error.state !== undefined,
  );
});

test('applyChange refuses a provider outside the user layer', async () => {
  const { ctx, state } = makeCtx();
  state.descriptor.user = { providers: {} };
  await assert.rejects(
    applyChange(ctx, 'llm-pi-ai', { operation: 'levels', provider: 'aihubmix', model: 'gpt-x', preset: 'dual' }),
    (error) => error.status === 400 && /用户配置/.test(error.message),
  );
});

test('buildState reports a helpful error when the namespace is absent', async () => {
  const { ctx } = makeCtx();
  const state = await buildState(ctx, 'not-mounted');
  assert.equal(state.available, false);
  assert.match(state.reason, /设置命名空间/);
  assert.deepEqual(state.routes, []);
});