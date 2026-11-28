export const MODERATION_CLEANUP_UNFINISHED = "j.state IN ('PENDING', 'CLEANING', 'LOG_PENDING')";

// An empty or resolved cycle can finish logging. Terminal deletions block only
// once all pending work in this exact immutable cycle has been drained.
const SAME_CYCLE = `v.chat_id = j.chat_id AND v.user_telegram_id = j.user_telegram_id
  AND v.moderation_cycle_id = j.violation_cycle_id`;
export const MODERATION_CLEANUP_RUNNABLE = `(
  NULLIF(TRIM(j.violation_cycle_id), '') IS NOT NULL AND (
    NOT EXISTS (SELECT 1 FROM language_moderation_violations v WHERE ${SAME_CYCLE} AND v.cleanup_state = 'TERMINAL_FAILED')
    OR EXISTS (SELECT 1 FROM language_moderation_violations v WHERE ${SAME_CYCLE} AND v.cleanup_state = 'PENDING')
  )
)`;
