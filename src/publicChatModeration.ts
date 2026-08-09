import type { Api } from "grammy";
import type { ReactionType } from "grammy/types";

export interface PublicChatPermissionCheck {
  key: "supergroup" | "bot_member" | "bot_admin" | "delete_messages" | "restrict_members";
  label: string;
  passed: boolean;
  guidance: string;
}

export interface PublicChatValidationResult {
  valid: boolean;
  chatId: number;
  title: string | null;
  username: string | null;
  isForum: boolean;
  reactionsAvailable: boolean | null;
  checks: readonly PublicChatPermissionCheck[];
}

const MODERATION_REACTIONS = new Set(["\u{1F440}", "\u{1F621}"]);

export async function validatePublicModerationChat(
  api: Api,
  chatId: number,
  botId: number
): Promise<PublicChatValidationResult> {
  const [chat, member] = await Promise.all([
    api.getChat(chatId),
    api.getChatMember(chatId, botId)
  ]);
  const isSupergroup = chat.type === "supergroup";
  const botMember = member.status !== "left" && member.status !== "kicked";
  const botAdmin = member.status === "administrator" || member.status === "creator";
  const admin = member.status === "administrator" ? member : null;
  const checks: PublicChatPermissionCheck[] = [
    { key: "supergroup", label: "Supergroup", passed: isSupergroup, guidance: "Select a Telegram supergroup." },
    { key: "bot_member", label: "Bot is a member", passed: botMember, guidance: "Add the bot to the group." },
    { key: "bot_admin", label: "Bot is an administrator", passed: botAdmin, guidance: "Promote the bot to administrator." },
    { key: "delete_messages", label: "Delete messages", passed: Boolean(admin?.can_delete_messages) || member.status === "creator", guidance: "Enable Delete Messages for the bot." },
    { key: "restrict_members", label: "Restrict and ban members", passed: Boolean(admin?.can_restrict_members) || member.status === "creator", guidance: "Enable Restrict Members for the bot." }
  ];

  return {
    valid: checks.every((check) => check.passed),
    chatId,
    title: "title" in chat ? chat.title ?? null : null,
    username: "username" in chat ? chat.username ?? null : null,
    isForum: isSupergroup && chat.is_forum === true,
    reactionsAvailable: reactionAvailability("available_reactions" in chat ? chat.available_reactions : undefined),
    checks
  };
}

export function formatPublicChatPermissionChecklist(result: PublicChatValidationResult): string {
  const required = result.checks.map((check) =>
    `${check.passed ? "OK" : "MISSING"} - ${check.label}${check.passed ? "" : `: ${check.guidance}`}`
  );
  const reactions = result.reactionsAvailable === false
    ? "Reactions: unavailable (advisory only)"
    : result.reactionsAvailable === true
      ? "Reactions: available"
      : "Reactions: availability unknown (advisory only)";
  return [...required, reactions].join("\n");
}

function reactionAvailability(reactions: readonly ReactionType[] | undefined): boolean | null {
  if (reactions === undefined) return null;
  const availableEmoji = new Set<string>(reactions
    .filter((reaction): reaction is Extract<ReactionType, { type: "emoji" }> => reaction.type === "emoji")
    .map((reaction) => reaction.emoji));
  return [...MODERATION_REACTIONS].every((emoji) => availableEmoji.has(emoji));
}
