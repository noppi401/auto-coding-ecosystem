import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * LLM の CLI（claude / codex / gemini）を起動する作業ディレクトリ。
 *
 * CLI は起動ディレクトリの指示ファイル（claude は CLAUDE.md、codex は AGENTS.md、gemini は GEMINI.md）を
 * 自動で読み込む。ACE の実行ディレクトリで起動すると、ACE 自身の開発ルール（「PR は日本語で書く」など）が
 * 生成するプロジェクトに入り込むため、何も置かない専用のディレクトリで起動する。
 * 必要な情報はすべてプロンプトで渡しているため、作業ディレクトリの中身は使わない。
 */
export async function getLlmWorkDir(): Promise<string> {
  const dir = join(tmpdir(), 'ace-llm-workdir');
  await fs.mkdir(dir, { recursive: true });
  return dir;
}
