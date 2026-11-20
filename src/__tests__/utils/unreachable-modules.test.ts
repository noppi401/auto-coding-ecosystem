import { describe, it, expect } from 'vitest';
import { findUnreachableModules } from '../../utils/unreachable-modules.js';

describe('findUnreachableModules', () => {
  it('起動ファイルから require をたどって到達できないソースファイルを返す（run 34: html-template.js が未接続）', () => {
    const files = {
      'src/server.js': "const { route } = require('./router'); const { TodoStore } = require('./store');",
      'src/router.js': "const handlers = require('./handlers');",
      'src/handlers.js': "const { validate } = require('./utils');",
      'src/utils.js': 'module.exports = {};',
      'src/store.js': 'module.exports = {};',
      'src/html-template.js': 'function getHtmlTemplate() {} module.exports = { getHtmlTemplate };',
      'test/helpers/test-server.js': "require('../../src/server');",
      'test/router.test.js': "require('../src/router');",
    };
    expect(findUnreachableModules('src/server.js', files)).toEqual(['src/html-template.js']);
  });

  it('すべてつながっていれば空', () => {
    const files = {
      'src/index.js': "import './a.js';",
      'src/a.js': "export * from './b.js';",
      'src/b.js': 'export const b = 1;',
    };
    expect(findUnreachableModules('src/index.js', files)).toEqual([]);
  });

  it('テスト・テスト用ヘルパー・設定ファイルは対象外', () => {
    const files = {
      'src/index.js': '',
      'tests/x.test.js': '',
      '__tests__/y.js': '',
      'test/helpers/h.js': '',
      'eslint.config.js': '',
      'vitest.config.mjs': '',
    };
    expect(findUnreachableModules('src/index.js', files)).toEqual([]);
  });

  it('起動ファイルが無ければ判定しない（空を返す）', () => {
    expect(findUnreachableModules('src/missing.js', { 'src/a.js': '' })).toEqual([]);
  });
});
