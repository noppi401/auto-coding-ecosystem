import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { runSmokeCheck, entryFileFromStartScript } from '../../utils/smoke-check.js';

// 実プロセスで、起動確認ゲートが「応答する/エラーを返す/Web アプリでない/起動失敗/無応答」を見分けることを確かめる
describe('runSmokeCheck', () => {
  let dir: string;

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  const app = async (body: string) => {
    dir = join(tmpdir(), `ace-smoke-${randomUUID()}`);
    await fs.mkdir(dir, { recursive: true });
    const file = join(dir, 'app.js');
    await fs.writeFile(file, body);
    return file;
  };

  const server = (status: number) => `
    const http = require('http');
    http.createServer((req, res) => {
      res.writeHead(req.url === '/' ? ${status} : 404, { 'Content-Type': 'text/html' });
      res.end('<h1>hello</h1>');
    }).listen(Number(process.env.PORT));
  `;

  it('PORT で起動して GET / が 2xx を返せば passed', async () => {
    const file = await app(server(200));
    const r = await runSmokeCheck({ cwd: dir, command: process.execPath, args: [file], startupTimeoutMs: 10000 });
    expect(r.status).toBe('passed');
    expect(r.summary).toContain('200');
  });

  it('GET / が 4xx/5xx（今回の 403 のような不具合）なら failed で、ステータスと本文を含む', async () => {
    const file = await app(server(403));
    const r = await runSmokeCheck({ cwd: dir, command: process.execPath, args: [file], startupTimeoutMs: 10000 });
    expect(r.status).toBe('failed');
    expect(r.summary).toContain('403');
    expect(r.details).toContain('hello');
  });

  it('ポートを開かずに正常終了するもの（Web アプリでない）は skipped', async () => {
    const file = await app(`console.log('cli done');`);
    const r = await runSmokeCheck({ cwd: dir, command: process.execPath, args: [file], startupTimeoutMs: 10000 });
    expect(r.status).toBe('skipped');
  });

  it('起動に失敗して異常終了したら failed で、出力を含む', async () => {
    const file = await app(`console.error('boom on start'); process.exit(2);`);
    const r = await runSmokeCheck({ cwd: dir, command: process.execPath, args: [file], startupTimeoutMs: 10000 });
    expect(r.status).toBe('failed');
    expect(r.details).toContain('boom on start');
  });

  it('期限内に応答しなければ failed（PORT を無視するアプリ等）。プロセスは残さない', async () => {
    const file = await app(`setInterval(() => {}, 1000);`);
    const started = Date.now();
    const r = await runSmokeCheck({ cwd: dir, command: process.execPath, args: [file], startupTimeoutMs: 1500 });
    expect(r.status).toBe('failed');
    expect(r.summary).toMatch(/PORT/);
    expect(Date.now() - started).toBeLessThan(10000);
  });
});

describe('entryFileFromStartScript', () => {
  it('node <file> 形式の start script からエントリファイルを取り出す', () => {
    expect(entryFileFromStartScript('node server.js')).toBe('server.js');
    expect(entryFileFromStartScript('node --watch src/index.js')).toBe('src/index.js');
  });

  it('解釈できなければ undefined', () => {
    expect(entryFileFromStartScript('next start')).toBeUndefined();
    expect(entryFileFromStartScript(undefined)).toBeUndefined();
  });
});
