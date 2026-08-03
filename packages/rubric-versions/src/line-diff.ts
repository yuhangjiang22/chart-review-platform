export type DiffTag = "ctx" | "add" | "del";
export interface DiffLine { tag: DiffTag; text: string; }
export interface LineDiff { lines: DiffLine[]; added: number; removed: number; }

/** LCS line diff: emits context/added/removed lines in order, with counts.
 *  Deterministic; no dependencies. Removals for a hunk are emitted before its
 *  additions (git-style). */
export function diffLines(oldText: string, newText: string): LineDiff {
  const a = oldText.length ? oldText.split("\n") : [];
  const b = newText.length ? newText.split("\n") : [];
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const lines: DiffLine[] = [];
  let i = 0, j = 0, added = 0, removed = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { lines.push({ tag: "ctx", text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { lines.push({ tag: "del", text: a[i] }); i++; removed++; }
    else { lines.push({ tag: "add", text: b[j] }); j++; added++; }
  }
  while (i < m) { lines.push({ tag: "del", text: a[i++] }); removed++; }
  while (j < n) { lines.push({ tag: "add", text: b[j++] }); added++; }
  return { lines, added, removed };
}
