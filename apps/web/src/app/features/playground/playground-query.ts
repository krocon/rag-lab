import type { PlaygroundSearchRequest } from '@raglab/shared';

/** Upper bound of `topK` (API: 1..100). */
export const MAX_TOP_K = 100;

/** The query parameters of `/playground` (all optional strings, as the router provides them). */
export interface PlaygroundParams {
  collection?: string | undefined;
  q?: string | undefined;
  topK?: string | undefined;
  minScore?: string | undefined;
  prompt?: string | undefined;
}

/** Values of the search form. Numbers stay strings so the fields keep what the user typed. */
export interface PlaygroundFormValue {
  collectionId: string;
  query: string;
  topK: string;
  minScore: string;
  includePrompt: boolean;
}

export type PlaygroundFormErrors = Partial<
  Record<'collectionId' | 'query' | 'topK' | 'minScore', string>
>;

export function formFromParams(params: PlaygroundParams): PlaygroundFormValue {
  return {
    collectionId: params.collection ?? '',
    query: params.q ?? '',
    topK: params.topK ?? '',
    minScore: params.minScore ?? '',
    includePrompt: params.prompt === '1' || params.prompt === 'true',
  };
}

/**
 * Validates the form like the API does. `maxQueryChars` is `MAX_QUERY_CHARS` from
 * `/api/system/info` (unknown while it loads – the API checks again).
 */
export function validateForm(
  value: PlaygroundFormValue,
  maxQueryChars?: number,
): PlaygroundFormErrors {
  const errors: PlaygroundFormErrors = {};
  if (value.collectionId === '') {
    errors.collectionId = 'Choose a knowledge base.';
  }
  const query = value.query.trim();
  if (query.length === 0) {
    errors.query = 'Enter a query.';
  } else if (maxQueryChars !== undefined && query.length > maxQueryChars) {
    errors.query = `The query must not be longer than ${maxQueryChars} characters (it has ${query.length}).`;
  }
  const topK = value.topK.trim();
  if (topK !== '' && (!/^\d+$/.test(topK) || Number(topK) < 1 || Number(topK) > MAX_TOP_K)) {
    errors.topK = `Top-K must be a whole number from 1 to ${MAX_TOP_K}.`;
  }
  const minScore = value.minScore.trim();
  if (minScore !== '') {
    const number = Number(minScore);
    if (!Number.isFinite(number) || number < -1 || number > 1) {
      errors.minScore = 'minScore must be a number from −1 to 1, or empty.';
    }
  }
  return errors;
}

/** Query parameters for a valid form (empty optional values are left out). */
export function paramsFromForm(value: PlaygroundFormValue): Record<string, string | null> {
  const topK = value.topK.trim();
  const minScore = value.minScore.trim();
  return {
    collection: value.collectionId,
    q: value.query.trim(),
    topK: topK === '' ? null : String(Number(topK)),
    minScore: minScore === '' ? null : String(Number(minScore)),
    prompt: value.includePrompt ? '1' : null,
  };
}

/**
 * The request a URL describes, or `undefined` when it describes no (valid) search – then the page
 * shows the form only. Invalid values in a shared link are reported by {@link validateForm}.
 */
export function requestFromParams(params: PlaygroundParams): PlaygroundSearchRequest | undefined {
  const form = formFromParams(params);
  if (Object.keys(validateForm(form)).length > 0) {
    return undefined;
  }
  const topK = form.topK.trim();
  const minScore = form.minScore.trim();
  return {
    collectionId: form.collectionId,
    query: form.query.trim(),
    ...(topK !== '' ? { topK: Number(topK) } : {}),
    ...(minScore !== '' ? { minScore: Number(minScore) } : {}),
    ...(form.includePrompt ? { includePrompt: true } : {}),
  };
}
