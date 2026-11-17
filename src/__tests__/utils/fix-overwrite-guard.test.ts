import { describe, it, expect } from 'vitest';
import { guardUnshownOverwrites } from '../../utils/fix-overwrite-guard.js';

const files = [
  { path: 'package.json', content: '{}' },
  { path: 'tests/setup.test.js', content: 'new content that wipes the tests' },
  { path: 'src/brand-new.js', content: 'x' },
];

describe('guardUnshownOverwrites', () => {
  it('FixAgent に見せていない既存ファイルへの書き込みを除外する（既存テストを全消しした事故の再発防止）', async () => {
    const existing = new Set(['package.json', 'tests/setup.test.js']);
    const { kept, blocked } = await guardUnshownOverwrites(
      files,
      ['package.json', 'pr.diff'],
      async (p) => existing.has(p)
    );

    expect(kept.map((f) => f.path)).toEqual(['package.json', 'src/brand-new.js']);
    expect(blocked).toEqual(['tests/setup.test.js']);
  });

  it('見せたファイルの更新は、そのまま通す', async () => {
    const { kept, blocked } = await guardUnshownOverwrites(
      [{ path: 'tests/setup.test.js', content: 'edited' }],
      ['tests/setup.test.js'],
      async () => true
    );
    expect(kept).toHaveLength(1);
    expect(blocked).toEqual([]);
  });

  it('リポジトリに存在しない新規ファイルは、見せていなくても通す', async () => {
    const { kept, blocked } = await guardUnshownOverwrites(files.slice(2), [], async () => false);
    expect(kept.map((f) => f.path)).toEqual(['src/brand-new.js']);
    expect(blocked).toEqual([]);
  });

  it('パスの ./ や区切り文字の違いは同一視する', async () => {
    const { blocked } = await guardUnshownOverwrites(
      [{ path: './tests\\setup.test.js', content: 'x' }],
      ['tests/setup.test.js'],
      async () => true
    );
    expect(blocked).toEqual([]);
  });
});
