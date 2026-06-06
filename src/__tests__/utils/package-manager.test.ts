import { describe, it, expect } from 'vitest';
import { selectInstallCommand } from '../../utils/package-manager.js';

describe('selectInstallCommand', () => {
  it('npm lockfile がある場合は npm ci を選ぶ', () => {
    const result = selectInstallCommand({}, { packageLock: true });
    expect(result.command).toBe('npm');
    expect(result.args).toEqual(['ci']);
    expect(result.reason).toContain('npm lockfile');
  });

  it('packageManager=pnpm と pnpm-lock.yaml では frozen install を選ぶ', () => {
    const result = selectInstallCommand(
      { packageManager: 'pnpm@9.0.0' },
      { pnpmLock: true }
    );
    expect(result.command).toBe('pnpm');
    expect(result.args).toEqual(['install', '--frozen-lockfile']);
  });

  it('Yarn classic は --frozen-lockfile を使う', () => {
    const result = selectInstallCommand(
      { packageManager: 'yarn@1.22.22' },
      { yarnLock: true }
    );
    expect(result.command).toBe('yarn');
    expect(result.args).toEqual(['install', '--frozen-lockfile']);
  });

  it('Yarn modern は --immutable を使う', () => {
    const result = selectInstallCommand(
      { packageManager: 'yarn@4.1.0' },
      { yarnLock: true }
    );
    expect(result.command).toBe('yarn');
    expect(result.args).toEqual(['install', '--immutable']);
  });

  it('packageManager / lockfile がない場合は npm install にフォールバックする', () => {
    const result = selectInstallCommand({}, {});
    expect(result.command).toBe('npm');
    expect(result.args).toEqual(['install']);
  });
});
