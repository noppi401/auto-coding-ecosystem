import { promises as fs } from 'fs';
import { extname } from 'path';

/**
 * 依頼文ファイルを読み込む。
 * - .html / .htm: script/style を除去し、タグを外したテキストにする
 * - .pdf: 未対応（バイナリを依頼文として扱わないよう明示的にエラー）
 * - それ以外（.md / .txt など）: UTF-8 テキストとしてそのまま読む
 */
export async function readInstructionFile(path: string): Promise<string> {
  const ext = extname(path).toLowerCase();
  if (ext === '.pdf') {
    throw new Error(`PDF files are not supported as instruction input: ${path} (use .md, .txt or .html)`);
  }

  const raw = await fs.readFile(path, 'utf-8');
  const text = (ext === '.html' || ext === '.htm' ? htmlToText(raw) : raw).trim();
  if (!text) {
    throw new Error(`Instruction file is empty: ${path}`);
  }
  return text;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|pre|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}
