import type { Category, CategoryAnswer } from "./category";

// Turns free-typed input into a lookup key: lowercase, no accents, no punctuation,
// no leading article, single spaces.
export function normalize(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^(the|a|an) /, "")
    .replace(/\s+/g, " ");
}

// Cheap English singular forms, tried as extra keys. Over-stripping is harmless:
// a key only matters if it lands on an indexed answer.
export function singularForms(key: string): string[] {
  const forms: string[] = [];
  if (key.endsWith("ies") && key.length > 4) forms.push(key.slice(0, -3) + "y");
  if (key.endsWith("es") && key.length > 3) forms.push(key.slice(0, -2));
  if (key.endsWith("s") && !key.endsWith("ss") && key.length > 2) forms.push(key.slice(0, -1));
  return forms;
}

export function levenshtein(a: string, b: string, max = Infinity): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

export interface MatchedAnswer {
  id: string; // normalized canonical, stable per category
  answer: CategoryAnswer;
}

interface CategoryIndex {
  exact: Map<string, MatchedAnswer>;
  keys: string[];
}

const indexCache = new WeakMap<Category, CategoryIndex>();

export function answerId(answer: CategoryAnswer): string {
  return normalize(answer.canonical);
}

function buildIndex(category: Category): CategoryIndex {
  const exact = new Map<string, MatchedAnswer>();
  for (const answer of category.answers) {
    const matched = { id: answerId(answer), answer };
    for (const raw of [answer.canonical, ...(answer.aliases ?? [])]) {
      const key = normalize(raw);
      if (key && !exact.has(key)) exact.set(key, matched);
    }
  }
  return { exact, keys: [...exact.keys()] };
}

function getIndex(category: Category): CategoryIndex {
  let index = indexCache.get(category);
  if (!index) {
    index = buildIndex(category);
    indexCache.set(category, index);
  }
  return index;
}

const FUZZY_MIN_LENGTH = 5;

// Exact key, then singular forms, then a single typo (edit distance 1) for longer
// words when exactly one answer is that close.
export function matchAnswer(category: Category, input: string): MatchedAnswer | null {
  const key = normalize(input);
  if (!key) return null;
  const index = getIndex(category);

  const direct = index.exact.get(key);
  if (direct) return direct;
  for (const form of singularForms(key)) {
    const hit = index.exact.get(form);
    if (hit) return hit;
  }

  // Typo check on the input and its singular forms ("narwals" -> "narwal" ~ "narwhal").
  const probes = [key, ...singularForms(key)].filter((p) => p.length >= FUZZY_MIN_LENGTH);
  let found: MatchedAnswer | null = null;
  for (const candidate of index.keys) {
    if (candidate.length < FUZZY_MIN_LENGTH) continue;
    if (probes.some((p) => levenshtein(p, candidate, 1) <= 1)) {
      const hit = index.exact.get(candidate)!;
      if (found && found.id !== hit.id) return null; // ambiguous typo
      found = hit;
    }
  }
  return found;
}
