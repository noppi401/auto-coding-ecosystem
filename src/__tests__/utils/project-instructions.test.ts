import { describe, it, expect, vi, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { isCodexUsageLimitMessage } from '../../utils/llm-errors.js';

vi.mock('../../utils/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), section: vi.fn() },
}));

// 読み込み結果をモジュール内でキャッシュするため、テストごとに読み込み直す
async function load(): Promise<string> {
  vi.resetModules();
  const { loadCodexProjectInstructions } = await import('../../utils/project-instructions.js');
  return loadCodexProjectInstructions();
}

describe('loadCodexProjectInstructions: Codex に渡すルール', () => {
  const original = process.env.CODEX_PROJECT_RULES_FILE;
  let dir = '';

  afterEach(async () => {
    if (original === undefined) delete process.env.CODEX_PROJECT_RULES_FILE;
    else process.env.CODEX_PROJECT_RULES_FILE = original;
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    dir = '';
  });

  it('既定では Codex 用のルール（prompts/codex-project-rules.md）を渡し、ACE 自身の CLAUDE.md は渡さない', async () => {
    delete process.env.CODEX_PROJECT_RULES_FILE;
    const rules = await load();

    const expected = await fs.readFile(join(process.cwd(), 'prompts', 'codex-project-rules.md'), 'utf-8');
    expect(rules).toBe(expected.trim());
    // ACE の開発用ルール（日本語で書く、.ecosystem の運用など）が生成するプロジェクトに入らない
    expect(rules).not.toMatch(/[぀-ヿ一-鿿]/);
    expect(rules).not.toContain('.ecosystem');
  });

  it('既定のルールには、Codex の失敗出力にエコーされても利用上限と誤判定される語が含まれない', async () => {
    delete process.env.CODEX_PROJECT_RULES_FILE;
    expect(isCodexUsageLimitMessage(await load())).toBe(false);
  });

  it('CODEX_PROJECT_RULES_FILE に絶対パスを指定すると、そのファイルを渡す（実行ディレクトリと別のドライブでもよい）', async () => {
    dir = join(tmpdir(), `ace-rules-${randomUUID()}`);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'rules.md'), 'custom rule\n');
    process.env.CODEX_PROJECT_RULES_FILE = join(dir, 'rules.md');

    expect(await load()).toBe('custom rule');
  });

  it('CODEX_PROJECT_RULES_FILE に相対パスを指定すると、実行ディレクトリから解決する', async () => {
    process.env.CODEX_PROJECT_RULES_FILE = join('prompts', 'codex-project-rules.md');
    const expected = await fs.readFile(join(process.cwd(), 'prompts', 'codex-project-rules.md'), 'utf-8');

    expect(await load()).toBe(expected.trim());
  });
});
