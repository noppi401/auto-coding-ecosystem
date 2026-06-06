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
      return { command: 'npm', args: ['ci'], manager, reason: 'packageManager=npm と npm lockfile を検出' };
    }
    return { command: 'npm', args: ['install'], manager, reason: 'packageManager=npm を検出（lockfileなし）' };
  }

  if (manager === 'pnpm') {
    return {
      command: 'pnpm',
      args: lockfiles.pnpmLock ? ['install', '--frozen-lockfile'] : ['install'],
      manager,
      reason: lockfiles.pnpmLock ? 'packageManager=pnpm と pnpm-lock.yaml を検出' : 'packageManager=pnpm を検出（lockfileなし）',
    };
  }

  if (manager === 'yarn') {
    const frozenArg = isYarnClassic(pkg?.packageManager) ? '--frozen-lockfile' : '--immutable';
    return {
      command: 'yarn',
      args: lockfiles.yarnLock ? ['install', frozenArg] : ['install'],
      manager,
      reason: lockfiles.yarnLock ? 'packageManager=yarn と yarn.lock を検出' : 'packageManager=yarn を検出（lockfileなし）',
    };
  }

  if (manager === 'bun') {
    return {
      command: 'bun',
      args: lockfiles.bunLock ? ['install', '--frozen-lockfile'] : ['install'],
      manager,
      reason: lockfiles.bunLock ? 'packageManager=bun と bun lockfile を検出' : 'packageManager=bun を検出（lockfileなし）',
    };
  }

  if (lockfiles.packageLock || lockfiles.npmShrinkwrap) {
    return { command: 'npm', args: ['ci'], manager: 'npm', reason: 'npm lockfile を検出' };
  }
  if (lockfiles.pnpmLock) {
    return { command: 'pnpm', args: ['install', '--frozen-lockfile'], manager: 'pnpm', reason: 'pnpm-lock.yaml を検出' };
  }
  if (lockfiles.yarnLock) {
    return { command: 'yarn', args: ['install', '--frozen-lockfile'], manager: 'yarn', reason: 'yarn.lock を検出' };
  }
  if (lockfiles.bunLock) {
    return { command: 'bun', args: ['install', '--frozen-lockfile'], manager: 'bun', reason: 'bun lockfile を検出' };
  }

  return { command: 'npm', args: ['install'], manager: 'npm', reason: 'packageManager / lockfile 未検出のため npm install を使用' };
}
