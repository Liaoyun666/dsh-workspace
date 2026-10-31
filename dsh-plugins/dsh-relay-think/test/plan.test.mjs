import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PRESETS,
  classifyLevels,
  declaredLevelIds,
  declaredOf,
  findModelSlot,
  planDefaultEffort,
  planModelLevels,
  resolveRequestedLevels,
  safeBaseUrl,
  validateLevels,
} from '../lib/plan.js';

test('validateLevels accepts a standard declaration', () => {
  assert.deepEqual(validateLevels({ off: null, low: 'low', medium: 'medium', high: 'high' }), {
    off: null,
    low: 'low',
    medium: 'medium',
    high: 'high',
  });
});

test('validateLevels keeps custom wire spellings', () => {
  assert.deepEqual(validateLevels({ off: null, low: 'LOW', high: 'max' }), {
    off: null,
    low: 'LOW',
    high: 'max',
  });
});

test('validateLevels rejects malformed declarations', () => {
  assert.throws(() => validateLevels(null), /对象/);
  assert.throws(() => validateLevels({}), /不能为空/);
  assert.throws(() => validateLevels({ off: null }), /至少/);
  assert.throws(() => validateLevels({ off: 'none', low: null }), /线缆拼写/);
  assert.throws(() => validateLevels({ low: 'low', ultra: 'ultra' }), /未知/);
  assert.throws(() => validateLevels({ low: '' }), /空字符串/);
  assert.throws(() => validateLevels({ low: 'x'.repeat(65) }), /过长/);
});

test('presets all validate and classify back to their ids', () => {
  for (const preset of PRESETS) {
    const checked = validateLevels(preset.levels);
    assert.equal(classifyLevels(checked), preset.id);
  }
});

test('classifyLevels reports custom declarations', () => {
  assert.equal(classifyLevels({ off: null, low: 'call-me-low', high: 'high' }), 'custom');
  assert.equal(classifyLevels({ minimal: 'minimal', max: 'max' }), 'custom');
});

test('resolveRequestedLevels understands presets, none, disabled and custom', () => {
  assert.equal(resolveRequestedLevels({ preset: 'standard' }).preset, 'standard');
  assert.deepEqual(resolveRequestedLevels({ preset: 'standard' }).levels, PRESETS[0].levels);
  assert.equal(resolveRequestedLevels({ preset: 'none' }).mode, 'none');
  assert.deepEqual(resolveRequestedLevels({ preset: 'disabled' }), { mode: 'set', levels: false, preset: 'disabled' });
  assert.deepEqual(resolveRequestedLevels({ preset: 'custom', levels: { off: null, low: 'L', high: 'H' } }).levels, { off: null, low: 'L', high: 'H' });
  assert.equal(resolveRequestedLevels({ preset: 'custom', levels: { off: null, low: 'low', high: 'high' } }).preset, 'dual');
  assert.throws(() => resolveRequestedLevels({ preset: 'nope' }), /未知/);
  assert.throws(() => resolveRequestedLevels({}), /缺少/);
});

test('declaredLevelIds drops off and keeps escalation order', () => {
  assert.deepEqual(declaredLevelIds({ off: null, high: 'high', low: 'low' }), ['low', 'high']);
  assert.deepEqual(declaredLevelIds(false), []);
  assert.deepEqual(declaredLevelIds(undefined), []);
});

test('declaredOf reads models entries and modelOverrides', () => {
  const models = { models: [{ id: 'a', reasoningEfforts: { off: null, high: 'high' } }, { id: 'b' }] };
  assert.deepEqual(declaredOf(models, 'a'), { off: null, high: 'high' });
  assert.equal(declaredOf(models, 'b'), undefined);
  assert.deepEqual(declaredOf({ modelOverrides: { c: { reasoningEfforts: false } } }, 'c'), false);
});

const userModels = {
  slow: {
    api: 'openai-responses',
    baseURL: 'https://relay.example/v1',
    models: [
      { id: 'gpt-x', name: 'GPT-X' },
      { id: 'gpt-y', name: 'GPT-Y', reasoningEfforts: false },
    ],
  },
};
const resolvedModels = {
  slow: {
    ...userModels.slow,
    reasoning: 'high',
  },
};

test('findModelSlot locates a models entry and its path', () => {
  const slot = findModelSlot(userModels, resolvedModels, 'slow', 'gpt-x');
  assert.equal(slot.kind, 'models');
  assert.equal(slot.index, 0);
  assert.deepEqual(slot.path, ['providers', 'slow', 'models', 0, 'reasoningEfforts']);
  assert.throws(() => findModelSlot(userModels, resolvedModels, 'slow', 'gpt-z'), /不在该提供商的 models 列表/);
  assert.throws(() => findModelSlot(userModels, resolvedModels, 'missing', 'gpt-x'), /不在本 profile/);
});

test('findModelSlot falls back to modelOverrides on catalog routes', () => {
  const user = { catalog: { apiKeyEnv: 'X', modelOverrides: { 'm-1': { contextWindow: 200000 } } } };
  const resolved = { catalog: { ...user.catalog, modelOverrides: { 'm-1': { contextWindow: 200000 } } } };
  const slot = findModelSlot(user, resolved, 'catalog', 'm-2');
  assert.equal(slot.kind, 'overrides');
  assert.deepEqual(slot.path, ['providers', 'catalog', 'modelOverrides', 'm-2', 'reasoningEfforts']);
  assert.deepEqual(slot.overridePath, ['providers', 'catalog', 'modelOverrides', 'm-2']);
});

test('planModelLevels sets and unsets a models entry', () => {
  const levels = { off: null, low: 'low', high: 'high' };
  assert.deepEqual(planModelLevels(userModels, resolvedModels, 'slow', 'gpt-x', levels), [
    { op: 'set', path: ['providers', 'slow', 'models', 0, 'reasoningEfforts'], value: levels },
  ]);
  assert.deepEqual(planModelLevels(userModels, resolvedModels, 'slow', 'gpt-y', false), [
    { op: 'set', path: ['providers', 'slow', 'models', 1, 'reasoningEfforts'], value: false },
  ]);
  assert.deepEqual(planModelLevels(userModels, resolvedModels, 'slow', 'gpt-x', null), [
    { op: 'unset', path: ['providers', 'slow', 'models', 0, 'reasoningEfforts'] },
  ]);
});

test('planModelLevels materializes a models array only when the user layer lacks one', () => {
  const user = { catalog: { apiKeyEnv: 'X' } };
  const resolved = { catalog: { apiKeyEnv: 'X', models: [{ id: 'm-1' }, { id: 'm-2' }] } };
  const levels = { off: null, high: 'high' };
  assert.deepEqual(planModelLevels(user, resolved, 'catalog', 'm-1', levels), [
    { op: 'set', path: ['providers', 'catalog', 'models'], value: [{ id: 'm-1', reasoningEfforts: levels }, { id: 'm-2' }] },
  ]);
  assert.deepEqual(planModelLevels(user, resolved, 'catalog', 'm-1', null), [
    { op: 'set', path: ['providers', 'catalog', 'models'], value: [{ id: 'm-1' }, { id: 'm-2' }] },
  ]);
});

test('planModelLevels keeps other override fields when resetting', () => {
  const user = {
    catalog: {
      apiKeyEnv: 'X',
      modelOverrides: {
        'm-1': { contextWindow: 200000, reasoningEfforts: { off: null, high: 'high' } },
        'm-2': { reasoningEfforts: { off: null, high: 'high' } },
      },
    },
  };
  const resolved = user;
  assert.deepEqual(planModelLevels(user, resolved, 'catalog', 'm-1', null), [
    { op: 'unset', path: ['providers', 'catalog', 'modelOverrides', 'm-1', 'reasoningEfforts'] },
  ]);
  assert.deepEqual(planModelLevels(user, resolved, 'catalog', 'm-2', null), [
    { op: 'unset', path: ['providers', 'catalog', 'modelOverrides', 'm-2'] },
  ]);
});

test('planDefaultEffort sets and clears the provider default', () => {
  assert.deepEqual(planDefaultEffort('slow', 'high'), [{ op: 'set', path: ['providers', 'slow', 'reasoning'], value: 'high' }]);
  assert.deepEqual(planDefaultEffort('slow', null), [{ op: 'unset', path: ['providers', 'slow', 'reasoning'] }]);
  assert.throws(() => planDefaultEffort('slow', 'ultra'), /未知/);
});

test('safeBaseUrl strips credentials and query', () => {
  assert.equal(safeBaseUrl('https://user:pass@relay.example/v1?key=secret#x'), 'https://relay.example/v1');
  assert.equal(safeBaseUrl('not a url'), null);
  assert.equal(safeBaseUrl(''), null);
});
