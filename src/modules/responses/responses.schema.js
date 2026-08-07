import { z } from 'zod';

const answerSchema = z.object({
  questionId: z.string().uuid(),
  optionIds: z.array(z.string().uuid()).max(50).optional(),
  valueText: z.string().max(5000).optional(),
  valueNum: z.number().finite().optional(),
});

export const submitResponseSchema = z.object({
  answers: z.array(answerSchema).min(1).max(50),
  respondentName: z.string().trim().min(1).max(80).optional(),
  inviteCode: z.string().trim().min(4).max(32).optional(),
  turnstileToken: z.string().max(4000).optional(),
  // Client-computed device signal. Weak on its own — it is one layer of the
  // stack, not the whole defence.
  fingerprint: z.string().max(200).optional(),
});

export const slugParam = z.object({ slug: z.string().min(4).max(32) });
