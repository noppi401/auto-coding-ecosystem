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
      `console.log('init'); setTimeout(() => console.log('done'), 800);`
    );
    const agent = new BaseAgent('', 'TestAgent');

    const stdout = await (agent as any)._execCommand('node', [script], undefined, { firstOutputTimeoutMs: 400 });

    expect(stdout).toContain('init');
    expect(stdout).toContain('done');
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
