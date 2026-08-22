import type { GlossaryEntry } from "../entity/types.js";

export type GlossaryMatchResult = {
  readonly entries: readonly GlossaryEntry[];
  readonly matchedTerms: readonly string[];
  readonly unmatchedTerms: readonly string[];
};

function normaliseTerm(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .replace(/[._\s-]+/gu, "-");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function wholeWordPattern(term: string): RegExp {
  const normalised = normaliseTerm(term);
  const words = normalised.split("-").filter((word) => word !== "");
  if (words.length === 0) {
    return /(?!)/u;
  }
  const phrase = words.map((word) => escapeRegExp(word)).join("[._\\s-]+");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${phrase}(?=$|[^\\p{L}\\p{N}_])`, "u");
}

export function appearsIn(content: string, terms: readonly string[]): boolean {
  const bodyText = content.normalize("NFKC").toLowerCase();
  return terms.some((term) => wholeWordPattern(term).test(bodyText));
}

function termsFor(entry: GlossaryEntry): readonly string[] {
  return [entry.attributes.term, ...(entry.attributes.aliases ?? [])];
}

export function matchGlossaryTerms(
  entries: readonly GlossaryEntry[],
  content: readonly string[],
): GlossaryMatchResult {
  const matched: GlossaryEntry[] = [];
  const matchedTerms: string[] = [];
  const unmatchedTerms: string[] = [];
  for (const entry of entries) {
    const terms = termsFor(entry);
    const matchedTerm = terms.find((term) => content.some((value) => appearsIn(value, [term])));
    if (matchedTerm === undefined) {
      unmatchedTerms.push(entry.attributes.term);
      continue;
    }
    matched.push(entry);
    matchedTerms.push(matchedTerm);
  }
  return {
    entries: matched,
    matchedTerms,
    unmatchedTerms,
  };
}

export function glossaryContent(entry: GlossaryEntry): string {
  return [
    entry.attributes.term,
    ...(entry.attributes.aliases ?? []),
    entry.attributes.definition,
    entry.body,
  ].join(" ");
}
