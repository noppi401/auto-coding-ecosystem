import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import { pathToFileURL } from 'url';

const srcDir = resolve(__dirname, '..');
const tsxCli = resolve(__dirname, '../../node_modules/tsx/dist/cli.mjs');

describe('.env の読み込み順', () => {
  let dir = '';

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  it('.env の ACE_LANG=en が、読み込み時に決まる表示ラベル（statusMeta）にも反映される', async () => {
    dir = join(tmpdir(), `ace-env-order-${randomUUID()}`);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, '.env'), 'ACE_LANG=en\n');
    const url = (p: string) => pathToFileURL(join(srcDir, p)).href;
    // index.ts と同じく、env.js を最初に静的 import する
    const script = [
      `import '${url('env.ts')}';`,
      `import { locale } from '${url('utils/i18n.ts')}';`,
      `import { statusMeta } from '${url('ui/theme.ts')}';`,
      `console.log(JSON.stringify({ locale, pending: statusMeta.pending.label }));`,
    ].join('\n');
    await fs.writeFile(join(dir, 'check.mts'), script);

    const env = { ...process.env };
    delete env.ACE_LANG;
    delete env.LANG;
    const out = execFileSync(process.execPath, [tsxCli, 'check.mts'], { cwd: dir, env, encoding: 'utf-8' });

    expect(JSON.parse(out.trim().split('\n').pop()!)).toEqual({ locale: 'en', pending: 'Pending' });
  }, 60000);

  it('index.ts は env.js を最初に import する（後ろにすると .env の設定が間に合わない）', async () => {
    const source = await fs.readFile(join(srcDir, 'index.ts'), 'utf-8');
    const firstImport = source.split(/\r?\n/).find((line) => line.startsWith('import '));
    expect(firstImport).toBe("import './env.js';");
  });
});
