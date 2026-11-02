/**
 * pgvector's text input format `[1,2,3]`. Vectors are passed as one bind parameter and cast
 * with `::vector` – never concatenated into SQL.
 */
export function toVectorLiteral(embedding: readonly number[]): string {
  return `[${embedding.join(',')}]`;
}
