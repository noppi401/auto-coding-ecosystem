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

const defaultRulesPath = join(process.cwd(), 'prompts', 'project-rules.md');

describe('loadCodexProjectInstructions: Claude と Codex に渡すルール', () => {
  const originalNew = process.env.PROJECT_RULES_FILE;
  const originalOld = process.env.CODEX_PROJECT_RULES_FILE;
  let dir = '';

  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  afterEach(async () => {
    restore('PROJECT_RULES_FILE', originalNew);
    restore('CODEX_PROJECT_RULES_FILE', originalOld);
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    dir = '';
  });

  async function writeRules(content: string): Promise<string> {
    dir = join(tmpdir(), `ace-rules-${randomUUID()}`);
    await fs.mkdir(dir, { recursive: true });
    const file = join(dir, 'rules.md');
    await fs.writeFile(file, content);
    return file;
  }

  it('既定では prompts/project-rules.md を渡し、ACE 自身の CLAUDE.md は渡さない', async () => {
    delete process.env.PROJECT_RULES_FILE;
    delete process.env.CODEX_PROJECT_RULES_FILE;
    const rules = await load();

    expect(rules).toBe((await fs.readFile(defaultRulesPath, 'utf-8')).trim());
    // ACE の開発用ルール（日本語で書く、.ecosystem の運用など）が生成するプロジェクトに入らない
    expect(rules).not.toMatch(/[぀-ヿ一-鿿]/);
    expect(rules).not.toContain('.ecosystem');
  });

  it('既定のルールには、Codex の失敗出力にエコーされても利用上限と誤判定される語が含まれない', async () => {
    delete process.env.PROJECT_RULES_FILE;
    delete process.env.CODEX_PROJECT_RULES_FILE;
    expect(isCodexUsageLimitMessage(await load())).toBe(false);
  });

  it('PROJECT_RULES_FILE に絶対パスを指定すると、そのファイルを渡す（実行ディレクトリと別のドライブでもよい）', async () => {
    process.env.PROJECT_RULES_FILE = await writeRules('custom rule\n');
    delete process.env.CODEX_PROJECT_RULES_FILE;

    expect(await load()).toBe('custom rule');
  });

  it('PROJECT_RULES_FILE に相対パスを指定すると、実行ディレクトリから解決する', async () => {
    process.env.PROJECT_RULES_FILE = join('prompts', 'project-rules.md');
    delete process.env.CODEX_PROJECT_RULES_FILE;

    expect(await load()).toBe((await fs.readFile(defaultRulesPath, 'utf-8')).trim());
  });

  it('以前の名前の CODEX_PROJECT_RULES_FILE も使える（PROJECT_RULES_FILE が優先）', async () => {
    const file = await writeRules('old name rule\n');
    delete process.env.PROJECT_RULES_FILE;
    process.env.CODEX_PROJECT_RULES_FILE = file;
    expect(await load()).toBe('old name rule');

    process.env.PROJECT_RULES_FILE = join('prompts', 'project-rules.md');
    expect(await load()).toBe((await fs.readFile(defaultRulesPath, 'utf-8')).trim());
  });
});
