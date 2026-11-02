export interface CitationAnalysis {
  /** Cited numbers that belong to a delivered source (ascending, unique). */
  citedSources: number[];
  /** Cited numbers without a delivered source (ascending, unique). */
  unknownCitations: number[];
}

/** `[1]`, `[1, 3]`, `[2,4, 5]` – square brackets with one or more comma-separated integers. */
const CITATION_PATTERN = /\[\s*(\d{1,6}(?:\s*,\s*\d{1,6})*)\s*\]/g;

/**
 * Extracts citations `[n]` / `[n, m]` from an answer and maps them to the delivered sources
 * `1..sourceCount`. Model output is untrusted: numbers outside that range (including 0) are
 * reported as unknown and must not be linked.
 */
export function analyzeCitations(answer: string, sourceCount: number): CitationAnalysis {
  const cited = new Set<number>();
  const unknown = new Set<number>();
  for (const match of answer.matchAll(CITATION_PATTERN)) {
    for (const part of (match[1] ?? '').split(',')) {
      const n = Number.parseInt(part.trim(), 10);
      if (n >= 1 && n <= sourceCount) {
        cited.add(n);
      } else {
        unknown.add(n);
      }
    }
  }
  const ascending = (values: Set<number>) => [...values].sort((a, b) => a - b);
  return { citedSources: ascending(cited), unknownCitations: ascending(unknown) };
}
