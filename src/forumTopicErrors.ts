import { GrammyError } from "grammy";

function badRequestDescription(error: unknown): string | null {
  if (!(error instanceof GrammyError) || error.error_code !== 400) return null;
  return error.description.toLowerCase();
}

/** Matches only Bot API responses that identify the forum topic itself as unavailable. */
export function isForumTopicUnavailable(error: unknown): boolean {
  const description = badRequestDescription(error);
  return (
    description !== null &&
    (description.includes("message thread not found") ||
      description.includes("message topic not found") ||
      description.includes("topic not found"))
  );
}

/**
 * Ticket routing sends only to a ticket's forum thread, never to an arbitrary reply target.
 * Telegram's reply-target wording is therefore safe to treat as that thread no longer existing here.
 */
export function isTicketRoutingTopicUnavailable(error: unknown): boolean {
  const description = badRequestDescription(error);
  return (
    isForumTopicUnavailable(error) ||
    (description !== null &&
      (description.includes("message to be replied not found") ||
        description.includes("reply message not found") ||
        description.includes("replied message not found")))
  );
}

/** Keeps a closed topic distinct from a missing topic so callers can reopen it safely. */
export function isForumTopicClosed(error: unknown): boolean {
  const description = badRequestDescription(error);
  return description !== null && (description.includes("topic_closed") || description.includes("topic is closed"));
}
