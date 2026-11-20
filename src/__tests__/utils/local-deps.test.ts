import { describe, it, expect } from 'vitest';
import { localDependencies } from '../../utils/local-deps.js';

const tracked = [
  'src/index.js',
  'src/server.js',
  'src/storage/todos.js',
  'src/api/handler.js',
  'src/ui/html.js',
  'src/lib/index.js',
  'src/esm.mjs',
  'package.json',
];

describe('localDependencies', () => {
  it('require の相対パスを、拡張子を補ってリポジトリ内のファイルに解決する（run 32 のタスク8）', () => {
    const files = [{
      path: 'src/index.js',
      content: [
        "const { createServer } = require('./server');",
        "const { createTodoStorage } = require('./storage/todos');",
        "const { ApiHandler } = require(\"./api/handler.js\");",
        "const { UiRenderer } = require('./ui/html');",
        "const http = require('node:http');",
      ].join('\n'),
    }];
    expect(localDependencies(files, tracked)).toEqual([
      'src/server.js', 'src/storage/todos.js', 'src/api/handler.js', 'src/ui/html.js',
    ]);
  });

  it('import / export from / 動的 import と、ディレクトリの index.js、親ディレクトリへの参照を解決する', () => {
    const files = [{
      path: 'src/api/handler.js',
      content: [
        "import { x } from '../lib';",
        "export { y } from '../esm.mjs';",
        "const m = await import('../ui/html.js');",
      ].join('\n'),
    }];
    expect(localDependencies(files, tracked)).toEqual(['src/lib/index.js', 'src/esm.mjs', 'src/ui/html.js']);
  });

  it('入力に含まれるファイル自身・パッケージ・存在しないファイル・非 JS は除外し、重複させない', () => {
    const files = [
      { path: 'src/index.js', content: "require('./server'); require('./server'); require('express'); require('./missing');" },
      { path: 'src/server.js', content: "require('./index');" },
      { path: 'README.md', content: "require('./src/ui/html')" },
    ];
    expect(localDependencies(files, tracked)).toEqual([]);
  });
});
