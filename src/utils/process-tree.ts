import { spawn, ChildProcess } from 'child_process';

/**
 * 子プロセスをプロセスツリーごと終了する。
 *
 * Windows で `shell: true` 起動した場合、`child.kill()` は cmd.exe しか終了させず、
 * その子（claude.exe など）が孤児として残る。taskkill /T で配下ごと止める。
 */
export function killProcessTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.on('error', () => child.kill());
    return;
  }
  child.kill();
}
