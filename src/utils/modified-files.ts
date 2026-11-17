/**
 * PR 差分から「既存ファイルの変更」だけを抜き出す。
 * 新規ファイルは差分に全文があり、削除ファイルは中身が不要なので除く。
 * レビューが差分外の定義（未変更の行）を見落として誤検知しないよう、これらの全文を渡すために使う。
 */
export function modifiedFilesInDiff(diff: string): string[] {
  const paths: string[] = [];
  for (const block of diff.split(/^(?=diff --git )/m)) {
    const header = block.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    if (!header) continue;
    if (/^(new|deleted) file mode /m.test(block)) continue;
    paths.push(header[2]);
  }
  return paths;
}
