import { spawn } from 'child_process';
import { createServer } from 'net';
import http from 'http';
import { killProcessTree } from './process-tree.js';

export interface SmokeCheckResult {
  status: 'passed' | 'failed' | 'skipped';
  summary: string;
  details?: string;
}

/** 空いている TCP ポートを OS に割り当ててもらう。 */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function get(host: string, port: number, path: string): Promise<{ status: number; body: string } | null> {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path, timeout: 3000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (body.length < 2000) body += d; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null)); // 未起動（接続拒否）は「まだ」として扱う
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * アプリを実際に起動し（環境変数 PORT に空きポートを渡す）、GET <path> が 2xx/3xx を返すかを確かめる。
 * テストが通っても「画面が出ない」不具合（例: Windows のパス区切りで GET / が 403）を、
 * テストを書いた側の思い込みと独立に検出するためのゲート。
 *
 * - 期限内に 2xx/3xx → passed
 * - 4xx/5xx・起動失敗（異常終了）・期限内に無応答 → failed
 * - ポートを開かずに正常終了（Web アプリでない）→ skipped
 */
export async function runSmokeCheck(opts: {
  cwd: string;
  command: string;
  args: string[];
  path?: string;
  startupTimeoutMs?: number;
}): Promise<SmokeCheckResult> {
  const path = opts.path ?? '/';
  const timeoutMs = opts.startupTimeoutMs ?? 20000;
  const port = await freePort();
  const commandLine = [opts.command, ...opts.args].join(' ');

  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (d) => { output += d; });
  child.stderr?.on('data', (d) => { output += d; });
  let exitCode: number | null | undefined;
  let spawnError: Error | undefined;
  child.on('exit', (code) => { exitCode = code; });
  child.on('error', (err) => { spawnError = err; });

  const tail = () => output.slice(-1500);
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (spawnError) {
        return { status: 'failed', summary: `起動コマンドを実行できない: ${commandLine}`, details: String(spawnError) };
      }
      for (const host of ['127.0.0.1', '::1']) {
        const res = await get(host, port, path);
        if (!res) continue;
        if (res.status >= 200 && res.status < 400) {
          return { status: 'passed', summary: `起動確認通過: GET ${path} -> ${res.status}（PORT=${port}）` };
        }
        return {
          status: 'failed',
          summary: `起動確認失敗: GET ${path} が ${res.status} を返した（PORT=${port}）`,
          details: `response body:\n${res.body.slice(0, 1000)}\n\napp output:\n${tail()}`,
        };
      }
      if (exitCode !== undefined) {
        if (exitCode === 0) {
          return { status: 'skipped', summary: `ポートを開かずに正常終了したため Web アプリではないと判断（${commandLine}）` };
        }
        return {
          status: 'failed',
          summary: `起動確認失敗: ${commandLine} が終了コード ${exitCode} で終了した`,
          details: tail(),
        };
      }
      await sleep(300);
    }
    return {
      status: 'failed',
      summary: `起動確認失敗: ${Math.round(timeoutMs / 1000)} 秒以内に PORT=${port} で応答しなかった（アプリは環境変数 PORT で待ち受ける必要がある）`,
      details: tail(),
    };
  } finally {
    if (exitCode === undefined) killProcessTree(child);
  }
}

/** "node server.js" のような start script から、修正対象として渡すエントリファイルを推定する。 */
export function entryFileFromStartScript(script: string | undefined): string | undefined {
  if (!script) return undefined;
  const m = script.match(/(?:^|\s)node\s+(?:--?\S+\s+)*([^\s-][^\s]*\.[cm]?[jt]s)\b/);
  return m?.[1];
}
