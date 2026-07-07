import type { Message, User } from "grammy/types";

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
  if ("text" in message && typeof message.text === "string") {
    return message.text;
  }

  if ("caption" in message && typeof message.caption === "string") {
    return message.caption;
  }

  return null;
}

function getMediaInfo(message: Message): { type: string; fileId: string } | null {
  if ("photo" in message) {
    const photos = message.photo ?? [];
    const largestPhoto = photos.at(-1);
    return largestPhoto ? { type: "photo", fileId: largestPhoto.file_id } : null;
  }

  if ("document" in message) {
    const document = message.document ?? null;
    return document ? { type: "document", fileId: document.file_id } : null;
  }

  if ("video" in message) {
    const video = message.video ?? null;
    return video ? { type: "video", fileId: video.file_id } : null;
  }

  if ("animation" in message) {
    const animation = message.animation ?? null;
    return animation ? { type: "animation", fileId: animation.file_id } : null;
  }

  if ("audio" in message) {
    const audio = message.audio ?? null;
    return audio ? { type: "audio", fileId: audio.file_id } : null;
  }

  if ("voice" in message) {
    const voice = message.voice ?? null;
    return voice ? { type: "voice", fileId: voice.file_id } : null;
  }

  if ("video_note" in message) {
    const videoNote = message.video_note ?? null;
    return videoNote ? { type: "video_note", fileId: videoNote.file_id } : null;
  }

  return null;
}
