import { z } from 'zod';
import {
  POLL_TYPES,
  VISIBILITY,
  IDENTITY_MODES,
  DEDUP_MODES,
  RESULTS_MODES,
  QUESTION_TYPES,
  CHOICE_TYPES,
} from '../../config/constants.js';

const optionSchema = z
  .object({
    label: z.string().trim().min(1).max(200).optional(),
    imagePublicId: z.string().max(300).optional(),
  })
  .refine((o) => o.label || o.imagePublicId, {
    message: 'An option needs a label, an image, or both',
  });

const questionSchema = z
  .object({
    type: z.enum(QUESTION_TYPES),
    prompt: z.string().trim().min(1).max(500),
    required: z.boolean().default(true),
    config: z.record(z.unknown()).default({}),
    options: z.array(optionSchema).max(50).default([]),
  })
  .superRefine((q, ctx) => {
    // Structural validation belongs here rather than in the service: a choice
    // question with no options is not a business-rule violation, it is a
    // malformed request.
    if (CHOICE_TYPES.includes(q.type) && q.options.length < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${q.type} questions need at least 2 options`,
        path: ['options'],
      });
    }
    if (!CHOICE_TYPES.includes(q.type) && q.options.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${q.type} questions cannot have options`,
        path: ['options'],
      });
    }
  });

export const createPollSchema = z
  .object({
    type: z.enum(POLL_TYPES),
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).optional(),
    visibility: z.enum(VISIBILITY).default('unlisted'),
    identityMode: z.enum(IDENTITY_MODES).default('anonymous'),
    dedupMode: z.enum(DEDUP_MODES).default('cookie_device'),
    resultsMode: z.enum(RESULTS_MODES).default('after_vote'),
    coverPublicId: z.string().max(300).optional(),
    opensAt: z.coerce.date().optional(),
    closesAt: z.coerce.date().optional(),
    questions: z.array(questionSchema).min(1).max(50),
  })
  .superRefine((p, ctx) => {
    if (p.type === 'vote' && p.questions.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A Quick Vote has exactly one question — use type "survey" for more',
        path: ['questions'],
      });
    }
    if (p.opensAt && p.closesAt && p.closesAt <= p.opensAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'closesAt must be after opensAt',
        path: ['closesAt'],
      });
    }
    // account_required without account dedup is a footgun: the poll demands a
    // login and then still lets one account vote repeatedly.
    if (p.identityMode === 'account_required' && p.dedupMode === 'none') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A poll requiring an account should dedupe by account',
        path: ['dedupMode'],
      });
    }
  });

/** Settings-only patch. Question edits go through their own endpoint. */
export const updatePollSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  visibility: z.enum(VISIBILITY).optional(),
  identityMode: z.enum(IDENTITY_MODES).optional(),
  dedupMode: z.enum(DEDUP_MODES).optional(),
  resultsMode: z.enum(RESULTS_MODES).optional(),
  coverPublicId: z.string().max(300).nullable().optional(),
  opensAt: z.coerce.date().nullable().optional(),
  closesAt: z.coerce.date().nullable().optional(),
});

export const listPollsSchema = z.object({
  status: z.enum(['draft', 'published', 'closed', 'archived']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const pollIdParam = z.object({ id: z.string().uuid() });
export const slugParam = z.object({ slug: z.string().min(4).max(32) });
