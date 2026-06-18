/**
 * Subsequence matcher for the ⌘K palette (SPEC §10 "支持模糊搜索").
 *
 * Case-insensitive and script-agnostic: a Chinese substring is also a
 * subsequence, so 「整理」 matches 「一键整理画布」 without a pinyin table.
 * Higher score = better match; `null` means no match.
 */
const SEPARATORS = new Set([" ", "/", "-", "_", ".", "·", ":", "、"]);

export function fuzzyScore(text: string, query: string): number | null {
  if (query.length === 0) return 0;
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();

  let score = 0;
  let cursor = 0;
  let previousIndex = -1;

  for (const character of needle) {
    if (character === " ") continue;
    const index = haystack.indexOf(character, cursor);
    if (index === -1) return null;
    if (index === previousIndex + 1)
      score += 4; // contiguous run
    else score += 1;
    if (index === 0)
      score += 3; // matches the very first character
    else if (SEPARATORS.has(haystack[index - 1] ?? "")) score += 2; // word start
    score -= Math.min(index - cursor, 4) * 0.2; // penalise long skips
    previousIndex = index;
    cursor = index + 1;
  }

  // Prefer short labels when everything else is equal.
  return score - haystack.length * 0.01;
}

export interface FuzzyFields {
  /** Primary label; carries full weight. */
  label: string;
  /** Secondary text (path, subtitle, group); weighted at 60 %. */
  hint?: string;
}

/** Best of the label / hint scores, or `null` when neither matches. */
export function matchScore(
  { label, hint }: FuzzyFields,
  query: string,
): number | null {
  const primary = fuzzyScore(label, query);
  const secondary = hint ? fuzzyScore(hint, query) : null;
  if (primary === null && secondary === null) return null;
  return Math.max(primary ?? -Infinity, (secondary ?? -Infinity) * 0.6);
}
