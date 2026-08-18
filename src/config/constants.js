export const POLL_TYPES = ['vote', 'survey'];
export const POLL_STATUSES = ['draft', 'published', 'closed', 'archived'];

export const VISIBILITY = ['public', 'unlisted', 'private'];
export const IDENTITY_MODES = ['anonymous', 'name_required', 'account_required'];
export const DEDUP_MODES = ['none', 'cookie_device', 'ip', 'account', 'invite_code'];
export const RESULTS_MODES = ['live', 'after_vote', 'after_close', 'creator_only'];

export const QUESTION_TYPES = [
  'single_choice',
  'multi_choice',
  'rating',
  'yes_no',
  'short_text',
  'long_text',
  'ranking',
];

/** Question types whose answers reference an option row. */
export const CHOICE_TYPES = ['single_choice', 'multi_choice', 'yes_no', 'ranking'];

export const ROLES = ['creator', 'admin'];

/** How often a repeating poll opens a fresh round. Null means it does not. */
export const REPEAT_INTERVALS = ['daily', 'weekly', 'monthly'];

export const NOTIFICATION_EVENTS = [
  'poll_closing',
  'response_milestone',
  'results_ready',
];

/**
 * Response counts that earn the owner a notification.
 *
 * Sparse and widening on purpose: the interesting news is "this is taking
 * off", and a poll that reaches 1000 should not have sent 1000 notifications
 * on the way. Matched by equality, which is safe because the counter advances
 * one response at a time — a skipped value would simply not notify rather
 * than notify twice.
 */
export const RESPONSE_MILESTONES = [10, 50, 100, 250, 500, 1000, 5000];

/** How far ahead of closes_at the "closing soon" warning is sent. */
export const CLOSING_WARNING_WINDOW = '1 hour';

export const DEDUP_COOKIE = 'ph_did';
export const DEDUP_COOKIE_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 365;

export const ACCESS_TOKEN_TTL = '15m';
export const REFRESH_TOKEN_TTL_DAYS = 30;
