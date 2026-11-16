import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join, delimiter } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { resolveClaudeBin } from '../../utils/claude-bin.js';

describe('resolveClaudeBin()', () => {
  let root: string;

  beforeEach(async () => {
    root = join(tmpdir(), `ace-claude-bin-test-${randomUUID()}`);
    await fs.mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  const touch = async (path: string) => {
    await fs.mkdir(join(path, '..'), { recursive: true });
    await fs.writeFile(path, '');
  };

  it('CLAUDE_BIN が指定されていればそれを返す', async () => {
    const bin = await resolveClaudeBin({ CLAUDE_BIN: 'C:\\custom\\claude.exe', PATH: '' }, 'win32');
    expect(bin).toBe('C:\\custom\\claude.exe');
  });

  it('PATH 上の claude.exe を見つける', async () => {
    const dir = join(root, 'bin');
    await touch(join(dir, 'claude.exe'));

    const bin = await resolveClaudeBin({ PATH: ['C:\\nowhere', dir].join(delimiter) }, 'win32');
    expect(bin).toBe(join(dir, 'claude.exe'));
  });

  it('npm の claude.cmd から node_modules 配下の claude.exe を導出する', async () => {
    const npmDir = join(root, 'npm');
    await touch(join(npmDir, 'claude.cmd'));
    const exe = join(npmDir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    await touch(exe);

    const bin = await resolveClaudeBin({ PATH: npmDir }, 'win32');
    expect(bin).toBe(exe);
  });

  it('実体が見つからなければ null（呼び出し側が従来の shell 経由にフォールバック）', async () => {
    const dir = join(root, 'empty');
    await fs.mkdir(dir, { recursive: true });

    expect(await resolveClaudeBin({ PATH: dir }, 'win32')).toBeNull();
  });

  it('Windows 以外では null（従来どおり）', async () => {
    const dir = join(root, 'bin');
    await touch(join(dir, 'claude.exe'));

    expect(await resolveClaudeBin({ PATH: dir }, 'linux')).toBeNull();
  });
});
