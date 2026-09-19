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

/** Keeps a closed topic distinct from a missing topic so callers can reopen it safely. */
export function isForumTopicClosed(error: unknown): boolean {
  const description = badRequestDescription(error);
  return description !== null && (description.includes("topic_closed") || description.includes("topic is closed"));
}
