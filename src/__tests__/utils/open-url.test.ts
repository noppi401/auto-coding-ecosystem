import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { getOpenExternalUrlCommand, openExternalUrl } from '../../utils/open-url.js';

describe('open-url', () => {
  it('Windows は PowerShell Start-Process に URL を引数として渡す', () => {
    const url = 'https://github.com/owner/repo/pull/1?x=1&y=2';
    const command = getOpenExternalUrlCommand(url, 'win32');

    expect(command.command).toBe('powershell.exe');
    expect(command.args).toEqual([
      '-NoProfile',
      '-Command',
      'Start-Process -FilePath $args[0]',
      url,
    ]);
    expect(command.args[2]).not.toContain(url);
  });

  it('macOS は open を使う', () => {
    expect(getOpenExternalUrlCommand('https://example.com', 'darwin')).toEqual({
      command: 'open',
      args: ['https://example.com'],
    });
  });

  it('Linux は xdg-open を使う', () => {
    expect(getOpenExternalUrlCommand('https://example.com', 'linux')).toEqual({
      command: 'xdg-open',
      args: ['https://example.com'],
    });
  });

  it('http/https 以外のURLは拒否する', () => {
    expect(() => getOpenExternalUrlCommand('javascript:alert(1)', 'linux')).toThrow(
      'Unsupported URL protocol'
    );
  });

  it('openコマンドの起動に失敗したらrejectする', async () => {
    const child = new EventEmitter() as any;
    const spawnUrl = vi.fn(() => child);
    const promise = openExternalUrl('https://github.com/owner/repo/pull/1', spawnUrl as any);

    child.emit('error', new Error('xdg-open missing'));

    await expect(promise).rejects.toThrow('xdg-open missing');
    expect(spawnUrl).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['https://github.com/owner/repo/pull/1']),
      expect.objectContaining({ stdio: 'ignore', windowsHide: true })
    );
  });
});
