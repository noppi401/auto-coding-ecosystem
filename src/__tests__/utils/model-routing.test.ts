import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  normalizeComplexity,
  modelForComplexity,
  resolveTaskModel,
  isTaskModelRoutingEnabled,
} from '../../utils/model-routing.js';

describe('isTaskModelRoutingEnabled', () => {
  let orig: string | undefined;

  beforeEach(() => {
    orig = process.env.TASK_MODEL_ROUTING;
  });
  afterEach(() => {
    if (orig !== undefined) {
      process.env.TASK_MODEL_ROUTING = orig;
    } else {
      delete process.env.TASK_MODEL_ROUTING;
    }
  });

  it('TASK_MODEL_ROUTING 未設定では false', () => {
    delete process.env.TASK_MODEL_ROUTING;
    expect(isTaskModelRoutingEnabled()).toBe(false);
  });

  it('TASK_MODEL_ROUTING=true では true', () => {
    process.env.TASK_MODEL_ROUTING = 'true';
    expect(isTaskModelRoutingEnabled()).toBe(true);
  });
});

describe('normalizeComplexity', () => {
  it('"low" を返す', () => {
    expect(normalizeComplexity('low')).toBe('low');
  });

  it('"medium" を返す', () => {
    expect(normalizeComplexity('medium')).toBe('medium');
  });

  it('"high" を返す', () => {
    expect(normalizeComplexity('high')).toBe('high');
  });

  it('大文字小文字を無視する', () => {
    expect(normalizeComplexity('HIGH')).toBe('high');
    expect(normalizeComplexity('  Low  ')).toBe('low');
  });

  it('不正な文字列は undefined を返す', () => {
    expect(normalizeComplexity('extreme')).toBeUndefined();
    expect(normalizeComplexity('')).toBeUndefined();
  });

  it('string 以外の型は undefined を返す', () => {
    expect(normalizeComplexity(42)).toBeUndefined();
    expect(normalizeComplexity(null)).toBeUndefined();
    expect(normalizeComplexity(undefined)).toBeUndefined();
  });
});

describe('modelForComplexity', () => {
  afterEach(() => {
    delete process.env.TASK_MODEL_LOW;
    delete process.env.TASK_MODEL_MEDIUM;
    delete process.env.TASK_MODEL_HIGH;
  });

  it('low → haiku モデルを返す', () => {
    const model = modelForComplexity('low');
    expect(model).toContain('haiku');
  });

  it('medium → sonnet モデルを返す', () => {
    const model = modelForComplexity('medium');
    expect(model).toContain('sonnet');
  });

  it('high → opus モデルを返す', () => {
    const model = modelForComplexity('high');
    expect(model).toContain('opus');
  });

  it('環境変数で各 complexity のモデルを上書きできる', () => {
    process.env.TASK_MODEL_LOW = 'custom-low-model';
    process.env.TASK_MODEL_MEDIUM = 'custom-medium-model';
    process.env.TASK_MODEL_HIGH = 'custom-high-model';

    expect(modelForComplexity('low')).toBe('custom-low-model');
    expect(modelForComplexity('medium')).toBe('custom-medium-model');
    expect(modelForComplexity('high')).toBe('custom-high-model');
  });
});

describe('resolveTaskModel', () => {
  let origRouting: string | undefined;

  beforeEach(() => {
    origRouting = process.env.TASK_MODEL_ROUTING;
    process.env.TASK_MODEL_ROUTING = 'true';
  });

  afterEach(() => {
    if (origRouting !== undefined) {
      process.env.TASK_MODEL_ROUTING = origRouting;
    } else {
      delete process.env.TASK_MODEL_ROUTING;
    }
  });

  it('ルーティング無効時は null を返す', () => {
    process.env.TASK_MODEL_ROUTING = 'false';
    expect(resolveTaskModel('high')).toBeNull();
  });

  it('ルーティング有効 + complexity=low → haiku モデルを返す', () => {
    const model = resolveTaskModel('low');
    expect(model).toContain('haiku');
  });

  it('ルーティング有効 + complexity 未設定 → medium 扱い（sonnet）', () => {
    const model = resolveTaskModel(undefined);
    expect(model).toContain('sonnet');
  });

  it('ルーティング結果が上限モデルより高コストの場合は上限に丸める', () => {
    const haikuModel = 'claude-haiku-4-5-20251001';
    const result = resolveTaskModel('high', haikuModel);
    expect(result).toBe(haikuModel);
  });

  it('ルーティング結果が上限以下の場合はそのまま返す', () => {
    const opusModel = 'claude-opus-4-7';
    const result = resolveTaskModel('low', opusModel);
    expect(result).toContain('haiku');
  });
});
