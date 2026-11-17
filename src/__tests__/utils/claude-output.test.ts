import { describe, it, expect } from 'vitest';
import { parseClaudeStdout } from '../../utils/claude-output.js';

const result = { type: 'result', is_error: false, result: 'done', session_id: 's1', total_cost_usd: 0.0123 };

describe('parseClaudeStdout', () => {
  it('stream-json（NDJSON）から最後の result イベントを取り出し、コストも読める', () => {
    const stdout = [
      JSON.stringify({ type: 'rate_limit_event' }),
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
      JSON.stringify({ type: 'assistant', message: { content: [] } }),
      JSON.stringify(result),
    ].join('\n');

    const out = parseClaudeStdout(stdout);

    expect(out.result).toBe('done');
    expect(out.total_cost_usd).toBe(0.0123);
  });

  it('従来の json 形式（結果オブジェクト 1 つ）も受け付ける', () => {
    expect(parseClaudeStdout(JSON.stringify(result)).session_id).toBe('s1');
  });

  it('result イベントが無い（途中で切れた）出力は例外にする', () => {
    const stdout = JSON.stringify({ type: 'system', subtype: 'init' }) + '\n';
    expect(() => parseClaudeStdout(stdout)).toThrow('no result event');
  });

  it('イベントでない行が混ざっても result を取り出せる', () => {
    expect(parseClaudeStdout(`warning: something\n${JSON.stringify(result)}\n`).result).toBe('done');
  });
});
