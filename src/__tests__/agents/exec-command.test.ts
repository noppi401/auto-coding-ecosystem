import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { BaseAgent } from '../../agents/base-agent.js';

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
