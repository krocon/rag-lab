/** JSON schemas shared by several modules' routes. */

export interface IdParams {
  id: string;
}

/** `:id` path parameter; a malformed id is rejected with `400 VALIDATION_ERROR`, not `500`. */
export const idParamsSchema = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;
