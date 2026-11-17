import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { killProcessTree } from '../../utils/process-tree.js';

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForFile(path: string, timeoutMs = 10000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const content = await fs.readFile(path, 'utf-8').catch(() => '');
    if (content.trim()) return content.trim();
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${path}`);
}

// タイムアウト時に cmd.exe 経由の孫プロセス（claude.exe 相当）が残らないことを検証する。
// shell:true で起動した場合、child.kill() は cmd.exe しか止めず孫が孤児化していた。
describe.skipIf(process.platform !== 'win32')('killProcessTree()（Windows）', () => {
  let dir: string;
  let grandchildPid: number | null = null;

  afterEach(async () => {
    if (grandchildPid && isAlive(grandchildPid)) {
      try { process.kill(grandchildPid, 'SIGKILL'); } catch { /* ignore */ }
    }
    grandchildPid = null;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('shell:true で起動した子の、さらに子（孫）まで終了させる', async () => {
    dir = join(tmpdir(), `ace-process-tree-test-${randomUUID()}`);
    await fs.mkdir(dir, { recursive: true });
    const pidFile = join(dir, 'grandchild.pid');
    const grandchildJs = join(dir, 'grandchild.js');
    const parentJs = join(dir, 'parent.js');

    await fs.writeFile(
      grandchildJs,
      `require('fs').writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);`
    );
    await fs.writeFile(
      parentJs,
      `const { spawn } = require('child_process');
       spawn(process.execPath, [${JSON.stringify(grandchildJs)}, process.argv[2]], { stdio: 'ignore' });
       setInterval(() => {}, 1000);`
    );

    // cmd.exe → node(parent) → node(grandchild) の3段（システムの claude 起動と同じ形）
    const child = spawn('node', [parentJs, pidFile], { shell: true, stdio: 'ignore' });
    grandchildPid = Number(await waitForFile(pidFile));
    expect(isAlive(grandchildPid)).toBe(true);

    killProcessTree(child);
    // taskkill の完了は負荷で前後するため、固定待ちではなく終了するまで最大 10 秒ポーリングする
    const deadline = Date.now() + 10000;
    while (isAlive(grandchildPid) && Date.now() < deadline) await sleep(100);

    expect(isAlive(grandchildPid)).toBe(false);
  });
});
