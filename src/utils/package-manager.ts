import { t } from './i18n.js';

export interface InstallCommandChoice {
  command: string;
  args: string[];
  manager: 'npm' | 'pnpm' | 'yarn' | 'bun';
  reason: string;
}

export interface PackageManifestLike {
  packageManager?: string;
}

export interface LockfilePresence {
  packageLock?: boolean;
  npmShrinkwrap?: boolean;
  pnpmLock?: boolean;
  yarnLock?: boolean;
  bunLock?: boolean;
}

function managerFromPackageManager(value: string | undefined): InstallCommandChoice['manager'] | null {
  const name = value?.split('@')[0]?.trim().toLowerCase();
  if (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun') {
    return name;
  }
  return null;
}

function isYarnClassic(value: string | undefined): boolean {
  const version = value?.match(/^yarn@(\d+)/i)?.[1];
  return version === '1';
}

export function selectInstallCommand(
  pkg: PackageManifestLike | null | undefined,
  lockfiles: LockfilePresence
): InstallCommandChoice {
  const manager = managerFromPackageManager(pkg?.packageManager);

  if (manager === 'npm') {
    if (lockfiles.packageLock || lockfiles.npmShrinkwrap) {
      return { command: 'npm', args: ['ci'], manager, reason: t('packageManager=npm と npm lockfile を検出', 'detected packageManager=npm and an npm lockfile') };
    }
    return { command: 'npm', args: ['install'], manager, reason: t('packageManager=npm を検出（lockfileなし）', 'detected packageManager=npm (no lockfile)') };
  }

  if (manager === 'pnpm') {
    return {
      command: 'pnpm',
      args: lockfiles.pnpmLock ? ['install', '--frozen-lockfile'] : ['install'],
      manager,
      reason: lockfiles.pnpmLock ? t('packageManager=pnpm と pnpm-lock.yaml を検出', 'detected packageManager=pnpm and pnpm-lock.yaml') : t('packageManager=pnpm を検出（lockfileなし）', 'detected packageManager=pnpm (no lockfile)'),
    };
  }

  if (manager === 'yarn') {
    const frozenArg = isYarnClassic(pkg?.packageManager) ? '--frozen-lockfile' : '--immutable';
    return {
      command: 'yarn',
      args: lockfiles.yarnLock ? ['install', frozenArg] : ['install'],
      manager,
      reason: lockfiles.yarnLock ? t('packageManager=yarn と yarn.lock を検出', 'detected packageManager=yarn and yarn.lock') : t('packageManager=yarn を検出（lockfileなし）', 'detected packageManager=yarn (no lockfile)'),
    };
  }

  if (manager === 'bun') {
    return {
      command: 'bun',
      args: lockfiles.bunLock ? ['install', '--frozen-lockfile'] : ['install'],
      manager,
      reason: lockfiles.bunLock ? t('packageManager=bun と bun lockfile を検出', 'detected packageManager=bun and a bun lockfile') : t('packageManager=bun を検出（lockfileなし）', 'detected packageManager=bun (no lockfile)'),
    };
  }

  if (lockfiles.packageLock || lockfiles.npmShrinkwrap) {
    return { command: 'npm', args: ['ci'], manager: 'npm', reason: t('npm lockfile を検出', 'detected an npm lockfile') };
  }
  if (lockfiles.pnpmLock) {
    return { command: 'pnpm', args: ['install', '--frozen-lockfile'], manager: 'pnpm', reason: t('pnpm-lock.yaml を検出', 'detected pnpm-lock.yaml') };
  }
  if (lockfiles.yarnLock) {
    return { command: 'yarn', args: ['install', '--frozen-lockfile'], manager: 'yarn', reason: t('yarn.lock を検出', 'detected yarn.lock') };
  }
  if (lockfiles.bunLock) {
    return { command: 'bun', args: ['install', '--frozen-lockfile'], manager: 'bun', reason: t('bun lockfile を検出', 'detected a bun lockfile') };
  }

  return { command: 'npm', args: ['install'], manager: 'npm', reason: t('packageManager / lockfile 未検出のため npm install を使用', 'no packageManager or lockfile found; using npm install') };
}
