import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { BaseAgent, StartupStallError } from '../../agents/base-agent.js';

describe('BaseAgent._execCommand: 出力の文字コード', () => {
  let dir: string;

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('マルチバイト文字がチャンク境界で分断されても文字化けしない', async () => {
    dir = join(tmpdir(), `ace-exec-test-${randomUUID()}`);
    await fs.mkdir(dir, { recursive: true });
    const script = join(dir, 'emit.js');
    // 「エ」(E3 82 A8) を 2 チャンクに分けて出力する（子プロセスが分割して書いた状況の再現）
    await fs.writeFile(
      script,
      `process.stdout.write(Buffer.from([0xE3, 0x82]));
       setTimeout(() => process.stdout.write(Buffer.from([0xA8, 0x0A])), 150);`
    );

    const agent = new BaseAgent('', 'TestAgent');
    const stdout = await (agent as any)._execCommand('node', [script]);

    expect(stdout.trim()).toBe('エ');
    expect(stdout).not.toContain('�');
  });
});

describe('BaseAgent._execCommand: 起動後の無反応（ハング）検知', () => {
  let dir: string;

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  const makeScript = async (body: string) => {
    dir = join(tmpdir(), `ace-exec-test-${randomUUID()}`);
    await fs.mkdir(dir, { recursive: true });
    const script = join(dir, 'child.js');
    await fs.writeFile(script, body);
    return script;
  };

  it('期限内に最初の出力が無ければ StartupStallError で早期に打ち切る', async () => {
    const script = await makeScript('setTimeout(() => {}, 60000);'); // 何も出さずに居座る
    const agent = new BaseAgent('', 'TestAgent');
    const started = Date.now();

    await expect(
      (agent as any)._execCommand('node', [script], undefined, { firstOutputTimeoutMs: 300 })
    ).rejects.toBeInstanceOf(StartupStallError);

    expect(Date.now() - started).toBeLessThan(5000); // 全体タイムアウト(900s)を待たない
  });

  it('期限内に最初の出力があれば、その後に時間がかかっても打ち切らない', async () => {
    const script = await makeScript(
      `console.log('init'); setTimeout(() => console.log('done'), 2500);`
    );
    const agent = new BaseAgent('', 'TestAgent');

    // 期限は node の起動（負荷時は遅い）より十分長く、かつ 2 回目の出力までの間隔より短くする
    const stdout = await (agent as any)._execCommand('node', [script], undefined, { firstOutputTimeoutMs: 2000 });

    expect(stdout).toContain('init');
    expect(stdout).toContain('done');
  });

  // 孫プロセスが stdout を握ったままだと 'close' が来ず、完了済みでもタイムアウトまで待ち続けていた
  const holdPipeScript = (emitResult: boolean, parentExits: boolean) => `
    const { spawn } = require('child_process');
    spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: ['ignore', 'inherit', 'inherit'] }).unref();
    ${emitResult ? `console.log(JSON.stringify({ type: 'result', is_error: false, result: 'done', session_id: 's' }));` : `console.log('plain output');`}
    ${parentExits ? '' : 'setTimeout(() => {}, 60000);'}
  `;

  it('result イベント後に子プロセスが終了せず pipe を握り続けても、猶予後に完了として返す', async () => {
    const script = await makeScript(holdPipeScript(true, false)); // 親も生き続ける
    const agent = new BaseAgent('', 'TestAgent');
    const started = Date.now();

    const stdout = await (agent as any)._execCommand('node', [script], undefined, {
      finishOnResultEvent: true,
      exitGraceMs: 300,
    });

    expect(stdout).toContain('"type":"result"');
    expect(Date.now() - started).toBeLessThan(10000);
  });

  it('親プロセスが終了しても孫が pipe を握って close が来ない場合、猶予後に完了として返す', async () => {
    const script = await makeScript(holdPipeScript(false, true));
    const agent = new BaseAgent('', 'TestAgent');
    const started = Date.now();

    const stdout = await (agent as any)._execCommand('node', [script], undefined, { exitGraceMs: 300 });

    expect(stdout).toContain('plain output');
    expect(Date.now() - started).toBeLessThan(10000);
  });

  it('親が異常終了で pipe が残った場合は、完了扱いにせず失敗として返す', async () => {
    const script = await makeScript(
      holdPipeScript(false, true).replace(`console.log('plain output');`, `console.error('boom'); process.exitCode = 3;`)
    );
    const agent = new BaseAgent('', 'TestAgent');

    await expect(
      (agent as any)._execCommand('node', [script], undefined, { exitGraceMs: 300 })
    ).rejects.toThrow(/code 3.*boom/s);
  });

  it('全体タイムアウト時のエラーに、それまでの出力が診断情報として含まれる', async () => {
    const script = await makeScript(`console.log('partial-output'); setTimeout(() => {}, 60000);`);
    const agent = new BaseAgent('', 'TestAgent');
    const prev = process.env.AGENT_COMMAND_TIMEOUT_MS;
    process.env.AGENT_COMMAND_TIMEOUT_MS = '500';
    try {
      await expect((agent as any)._execCommand('node', [script])).rejects.toThrow(/Command timeout.*partial-output/s);
    } finally {
      if (prev === undefined) delete process.env.AGENT_COMMAND_TIMEOUT_MS;
      else process.env.AGENT_COMMAND_TIMEOUT_MS = prev;
    }
  });
});
