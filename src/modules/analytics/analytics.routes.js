import { Router } from 'express';
import { z } from 'zod';
import * as repo from './analytics.repository.js';
import * as responseRepo from '../responses/responses.repository.js';
import { getOwned } from '../polls/polls.service.js';
import { validate } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { readLimiter } from '../../middleware/rate-limit.js';
import { toCsv } from '../../lib/csv.js';

export const analyticsRoutes = Router();

const idParam = z.object({ id: z.string().uuid() });

analyticsRoutes.use(authenticate);

analyticsRoutes.get(
  '/:id/analytics',
  readLimiter,
  validate({ params: idParam }),
  async (req, res) => {
    const poll = await getOwned(req.validatedParams.id, req.user.id);

    const [summary, overTime, completion, breakdown] = await Promise.all([
      repo.summary(poll.id),
      repo.responsesOverTime(poll.id),
      repo.perQuestionCompletion(poll.id),
      repo.optionBreakdown(poll.id),
    ]);

    // Drop-off is relative to the first question, which everyone who started
    // the survey saw.
    const started = completion[0]?.answered ?? 0;
    const questions = completion.map((q) => ({
      id: q.id,
      position: q.position,
      prompt: q.prompt,
      type: q.type,
      answered: q.answered,
      dropOffPct: started > 0 ? Number((((started - q.answered) / started) * 100).toFixed(1)) : 0,
    }));

    const finished = completion.at(-1)?.answered ?? 0;

    res.json({
      summary: {
        ...summary,
        completionRate: started > 0 ? Number(((finished / started) * 100).toFixed(1)) : 0,
      },
      responsesOverTime: overTime,
      questions,
      options: breakdown,
    });
  },
);

analyticsRoutes.get(
  '/:id/export.csv',
  readLimiter,
  validate({ params: idParam }),
  async (req, res) => {
    const poll = await getOwned(req.validatedParams.id, req.user.id);
    const rows = await responseRepo.listForExport(poll.id);

    // Pivot the flat join into one row per response, one column per question.
    const questionCols = [...new Map(rows.map((r) => [r.question_id, r])).values()]
      .filter((r) => r.question_id)
      .sort((a, b) => a.question_position - b.question_position);

    const byResponse = new Map();
    for (const row of rows) {
      if (!byResponse.has(row.id)) {
        byResponse.set(row.id, {
          id: row.id,
          submittedAt: row.submitted_at,
          name: row.respondent_name,
          answers: new Map(),
        });
      }
      if (!row.question_id) continue;

      const answers = byResponse.get(row.id).answers;
      const value = row.option_label ?? row.value_text ?? '';
      // Multi-choice puts several rows on one question; join rather than
      // letting the last one win.
      answers.set(
        row.question_id,
        answers.has(row.question_id) ? `${answers.get(row.question_id)}; ${value}` : value,
      );
    }

    const headers = ['response_id', 'submitted_at', 'respondent_name',
      ...questionCols.map((q) => q.prompt)];

    const body = [...byResponse.values()].map((r) => [
      r.id,
      r.submittedAt?.toISOString?.() ?? r.submittedAt,
      r.name ?? '',
      ...questionCols.map((q) => r.answers.get(q.question_id) ?? ''),
    ]);

    res
      .type('text/csv; charset=utf-8')
      .set('Content-Disposition', `attachment; filename="poll-${poll.slug}.csv"`)
      .send(toCsv(headers, body));
  },
);

analyticsRoutes.get(
  '/:id/questions/:questionId/answers',
  readLimiter,
  validate({ params: idParam.extend({ questionId: z.string().uuid() }) }),
  async (req, res) => {
    const poll = await getOwned(req.validatedParams.id, req.user.id);
    res.json({ answers: await repo.textAnswers(poll.id, req.validatedParams.questionId) });
  },
);
