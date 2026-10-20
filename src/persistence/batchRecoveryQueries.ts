// These predicates are shared by the recovery selectors and operational counts.
// Aliases: i = answer item, p = answer package, t = ticket.
export const BATCH_FAILURE_EVENT_PENDING = `p.staff_chat_id = @staffChatId
  AND i.delivery_failure_event_state IN ('PENDING', 'FAILED') AND t.status != 'CLOSED'
  AND i.action IN ('reply_keep_open', 'reply_and_close')
  AND i.delivery_error_category IS NOT NULL AND i.delivery_message_id IS NULL
  AND (i.delivery_failure_event_next_retry_at IS NULL OR i.delivery_failure_event_next_retry_at <= @at)`;

export const BATCH_FINAL_SUMMARY_PENDING = `p.staff_chat_id = @staffChatId
  AND p.final_summary_state IN ('PENDING', 'FAILED')
  AND (p.final_summary_next_retry_at IS NULL OR p.final_summary_next_retry_at <= @at)`;

export const BATCH_TOPIC_ECHO_PENDING = `p.staff_chat_id = @staffChatId
  AND (i.topic_echo_state IN ('PENDING', 'FAILED')
    OR (i.action = 'reply_keep_open' AND i.state = 'REPLY_SENT' AND i.topic_echo_state = 'SENT'))
  AND t.status != 'CLOSED'
  AND (i.topic_echo_next_retry_at IS NULL OR i.topic_echo_next_retry_at <= @at)
  AND ((i.action = 'no_action' AND (i.follow_up_state != 'NONE' OR i.internal_note IS NOT NULL OR i.escalation_target != 'NONE'))
    OR (i.action IN ('reply_keep_open', 'reply_and_close') AND i.delivery_message_id IS NOT NULL
      AND i.delivery_error_category IS NULL AND i.delivery_error_permanence IS NULL
      AND i.delivery_failure_event_state != 'SENT' AND i.state IN ('REPLY_SENT', 'STAFF_SYNC_PENDING', 'COMPLETED')))`;

export const BATCH_CLOSED_REPLY_PENDING = `p.staff_chat_id = @staffChatId AND p.status IN ('APPLYING', 'PARTIAL')
  AND t.status = 'CLOSED' AND t.staff_chat_id = p.staff_chat_id
  AND i.action IN ('reply_and_close', 'reply_keep_open') AND i.state IN ('REPLY_SENT', 'STAFF_SYNC_PENDING')
  AND i.delivery_message_id IS NOT NULL AND i.delivery_error_category IS NULL AND i.delivery_error_permanence IS NULL
  AND i.delivery_failure_event_state != 'SENT'
  AND (i.topic_echo_state IN ('PENDING', 'FAILED') OR i.action = 'reply_keep_open')`;

export const BATCH_REPLY_AND_CLOSE_PENDING = `p.staff_chat_id = @staffChatId AND p.status IN ('APPLYING', 'PARTIAL')
  AND i.action = 'reply_and_close' AND i.state IN ('REPLY_SENT', 'STAFF_SYNC_PENDING')
  AND i.delivery_message_id IS NOT NULL AND i.delivery_error_category IS NULL AND i.delivery_error_permanence IS NULL
  AND i.delivery_failure_event_state != 'SENT'
  AND (i.topic_echo_state = 'SENT' OR (i.topic_echo_state = 'NOT_REQUIRED' AND t.status = 'CLOSED'))
  AND (i.topic_echo_next_retry_at IS NULL OR i.topic_echo_next_retry_at <= @at)`;

export const BATCH_SILENT_CLOSE_PENDING = `p.staff_chat_id = @staffChatId AND p.status IN ('APPLYING', 'PARTIAL')
  AND i.action = 'silent_close' AND i.state = 'APPLYING'
  AND (i.topic_echo_next_retry_at IS NULL OR i.topic_echo_next_retry_at <= @at)`;

export const BATCH_INVALID_SUCCESS_ECHO = `p.staff_chat_id = @staffChatId
  AND i.topic_echo_state IN ('PENDING', 'FAILED') AND i.action IN ('reply_keep_open', 'reply_and_close')
  AND (i.delivery_message_id IS NULL OR i.delivery_error_category IS NOT NULL
    OR i.delivery_error_permanence IS NOT NULL OR i.delivery_failure_event_state = 'SENT')`;
