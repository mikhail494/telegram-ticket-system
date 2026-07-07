import type { User } from "grammy/types";
import type { Message } from "grammy/types";

export interface MessageContent {
  text: string | null;
  mediaType: string | null;
  fileId: string | null;
  shouldCopyOriginal: boolean;
}

export function displayTelegramUser(user: {
  username?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  telegram_id?: number;
  id?: number;
}): string {
  if (user.username) {
    return `@${user.username}`;
  }

  const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  if (fullName) {
    return fullName;
  }

  const id = user.telegram_id ?? user.id;
  return id ? `User ${id}` : "Unknown user";
}

export function usernameOf(user: User | undefined): string | null {
  return user?.username ?? null;
}

export function isCommandText(text: string | undefined): boolean {
  return Boolean(text?.trim().startsWith("/"));
}

export function getMessageContent(message: Message): MessageContent {
  const text = getMessageText(message);
  const media = getMediaInfo(message);

  return {
    text,
    mediaType: media?.type ?? null,
    fileId: media?.fileId ?? null,
    shouldCopyOriginal: Boolean(media) || (text?.length ?? 0) > 2500
  };
}

export function getMessageText(message: Message): string | null {
  if ("text" in message) {
    return message.text;
  }

  if ("caption" in message && typeof message.caption === "string") {
    return message.caption;
  }

  return null;
}

function getMediaInfo(message: Message): { type: string; fileId: string } | null {
  if ("photo" in message) {
    const largestPhoto = message.photo.at(-1);
    return largestPhoto ? { type: "photo", fileId: largestPhoto.file_id } : null;
  }

  if ("document" in message) {
    return { type: "document", fileId: message.document.file_id };
  }

  if ("video" in message) {
    return { type: "video", fileId: message.video.file_id };
  }

  if ("animation" in message) {
    return { type: "animation", fileId: message.animation.file_id };
  }

  if ("audio" in message) {
    return { type: "audio", fileId: message.audio.file_id };
  }

  if ("voice" in message) {
    return { type: "voice", fileId: message.voice.file_id };
  }

  if ("video_note" in message) {
    return { type: "video_note", fileId: message.video_note.file_id };
  }

  return null;
}
