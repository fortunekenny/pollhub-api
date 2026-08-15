import { pool } from '../../db/pool.js';

const db = (client) => client ?? pool;

export async function insertResponse(r, client) {
  const { rows } = await db(client).query(
    `INSERT INTO responses (poll_id, respondent_user_id, respondent_name,
                            fingerprint_hash, ip_hash, invite_code_id, meta)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
    [
      r.pollId, r.respondentUserId ?? null, r.respondentName ?? null,
      r.fingerprintHash ?? null, r.ipHash ?? null, r.inviteCodeId ?? null,
      r.meta ?? {},
    ],
  );
  return rows[0];
}

export async function insertAnswers(responseId, answers, client) {
  if (answers.length === 0) return;

  // One multi-row INSERT rather than N round trips — this runs inside the
  // vote transaction, so every extra round trip holds the tally row locks
  // that much longer.
  const values = [];
  const params = [];
  answers.forEach((a, i) => {
    const base = i * 5;
    values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`);
    // rank is set only for ranking answers; every other type stores NULL.
    params.push(responseId, a.questionId, a.optionId ?? null, a.valueText ?? null, a.rank ?? null);
  });

  await db(client).query(
    `INSERT INTO answers (response_id, question_id, option_id, value_text, rank)
     VALUES ${values.join(', ')}`,
    params,
  );
}

export async function bumpResponseCount(pollId, client) {
  const { rows } = await db(client).query(
    'UPDATE polls SET response_count = response_count + 1 WHERE id = $1 RETURNING response_count',
    [pollId],
  );
  return rows[0]?.response_count ?? 0;
}

export async function hasResponded(pollId, { userId, fingerprintHash, ipHash }, client) {
  const { rows } = await db(client).query(
    `SELECT 1 FROM responses
      WHERE poll_id = $1
        AND ( ($2::uuid IS NOT NULL AND respondent_user_id = $2)
           OR ($3::text IS NOT NULL AND fingerprint_hash = $3)
           OR ($4::text IS NOT NULL AND ip_hash = $4) )
      LIMIT 1`,
    [pollId, userId ?? null, fingerprintHash ?? null, ipHash ?? null],
  );
  return rows.length > 0;
}

export async function listForExport(pollId, client) {
  const { rows } = await db(client).query(
    `SELECT r.id, r.submitted_at, r.respondent_name, r.respondent_user_id,
            a.question_id, a.option_id, a.value_text,
            q.prompt, q.position AS question_position,
            o.label AS option_label
       FROM responses r
       LEFT JOIN answers a  ON a.response_id = r.id
       LEFT JOIN questions q ON q.id = a.question_id
       LEFT JOIN options o   ON o.id = a.option_id
      WHERE r.poll_id = $1
      ORDER BY r.submitted_at, q.position`,
    [pollId],
  );
  return rows;
}
