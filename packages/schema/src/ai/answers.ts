import { z } from 'zod';

/*
 * The answers of the AI tasks other than the pack (whose schema is content-pack.ts), each as the Zod
 * schema the answer is validated with and the JSON Schema the model is given: the contract, whatever
 * the provider. Moved here from the engine modules that ask for them, unchanged, so the task
 * definitions (tasks.ts) can name them from the domain.
 */

/** What checking a text against the code answers: the contract, whatever the provider */
export const CheckAnswer = z.object({
  revised: z.string(),
  findings: z
    .array(
      z.object({
        claim: z.string().max(500),
        verdict: z.enum(['backed', 'planned', 'not-found', 'contradicted']),
        evidence: z.string().max(1000),
      }),
    )
    .max(40),
});
export type CheckAnswer = z.infer<typeof CheckAnswer>;

export function checkJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['revised', 'findings'],
    properties: {
      revised: { type: 'string', description: 'The text with every claim the code does not back corrected or removed; otherwise exactly as it was' },
      findings: {
        type: 'array',
        description: 'One entry per factual claim checked',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['claim', 'verdict', 'evidence'],
          properties: {
            claim: { type: 'string', description: 'The claim, in a few words' },
            verdict: { type: 'string', enum: ['backed', 'planned', 'not-found', 'contradicted'] },
            evidence: { type: 'string', description: 'Where in the code (path, symbol), or what was looked for and not found' },
          },
        },
      },
    },
  };
}

/** The answer the AI gives for one comment: the contract, whatever the provider */
export const ReplyAnswer = z.object({
  classification: z.enum(['question', 'feedback', 'praise', 'bug', 'spam', 'abuse', 'other']),
  language: z.string().max(10),
  dismiss: z.boolean(),
  reply: z.string().max(5000),
  reason: z.string().max(1000),
});
export type ReplyAnswer = z.infer<typeof ReplyAnswer>;

export function replyJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['classification', 'language', 'dismiss', 'reply', 'reason'],
    properties: {
      classification: { type: 'string', enum: ['question', 'feedback', 'praise', 'bug', 'spam', 'abuse', 'other'], description: 'What the comment is' },
      language: { type: 'string', description: 'The comment’s language, ISO 639-1 (en, es…)' },
      dismiss: { type: 'boolean', description: 'True for spam, abuse or anything that should get no reply' },
      reply: { type: 'string', description: 'The reply, in the comment’s language; empty when dismissed' },
      reason: { type: 'string', description: 'One line for the owner: why this reply, or why to dismiss' },
    },
  };
}

/** The answer the AI gives: the contract, whatever the provider */
export const ProfileReviewAnswer = z.object({
  summary: z.string().max(1000),
  proposals: z
    .array(
      z.object({
        field: z.enum(['displayName', 'bio', 'links', 'avatar']),
        current: z.string().max(5000),
        proposed: z.string().max(5000),
        why: z.string().max(1000),
      }),
    )
    .max(12),
});
export type ProfileReviewAnswer = z.infer<typeof ProfileReviewAnswer>;

export function profileReviewJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'proposals'],
    properties: {
      summary: { type: 'string', description: 'One line on how the profile reads now' },
      proposals: {
        type: 'array',
        maxItems: 12,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['field', 'current', 'proposed', 'why'],
          properties: {
            field: { type: 'string', enum: ['displayName', 'bio', 'links', 'avatar'], description: 'The field the proposal changes' },
            current: { type: 'string', description: 'The field as it is now; empty when there is none' },
            proposed: { type: 'string', description: 'The whole new value, ready to paste; links one per line as `Label: value`; for the picture, what it should show' },
            why: { type: 'string', description: 'One or two sentences for the owner: why this is better' },
          },
        },
      },
    },
  };
}
