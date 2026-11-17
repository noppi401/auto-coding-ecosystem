import { describe, it, expect } from 'vitest';
import { modifiedFilesInDiff } from '../../utils/modified-files.js';

const diff = [
  'diff --git a/server.js b/server.js',
  'index 111..222 100644',
  '--- a/server.js',
  '+++ b/server.js',
  '@@ -100,3 +100,6 @@',
  '+  const x = MAX_BODY_SIZE;',
  'diff --git a/test/api.test.js b/test/api.test.js',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/test/api.test.js',
  '@@ -0,0 +1,3 @@',
  '+it("a", () => {});',
  'diff --git a/old.js b/old.js',
  'deleted file mode 100644',
  '--- a/old.js',
  '+++ /dev/null',
].join('\n');

describe('modifiedFilesInDiff', () => {
  it('既存ファイルの変更だけを返す（新規・削除は除く。新規は差分に全文がある）', () => {
    expect(modifiedFilesInDiff(diff)).toEqual(['server.js']);
  });

  it('差分が無ければ空', () => {
    expect(modifiedFilesInDiff('')).toEqual([]);
  });
});
