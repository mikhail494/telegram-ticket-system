import type { Api } from "grammy";

export interface WorkspaceValidationCheck { key: string; label: string; passed: boolean; guidance?: string; }
export interface WorkspaceValidationResult {
  valid: boolean; chatId: number; title: string | null; username: string | null; checks: WorkspaceValidationCheck[];
}

export async function validateStaffWorkspace(api: Api, chatId: number, ownerId: number): Promise<WorkspaceValidationResult> {
  const [chat, owner, bot] = await Promise.all([api.getChat(chatId), api.getChatMember(chatId, ownerId), api.getMe()]);
  const botMember = await api.getChatMember(chatId, bot.id);
  const isSupergroup = chat.type === "supergroup";
  const forum = isSupergroup && chat.is_forum === true;
  const ownerAdmin = owner.status === "creator" || owner.status === "administrator";
  const botAdmin = botMember.status === "administrator" || botMember.status === "creator";
  const rights = botMember.status === "administrator" ? botMember : null;
  const checks: WorkspaceValidationCheck[] = [
    { key: "supergroup", label: "Supergroup", passed: isSupergroup, guidance: "Convert the group to a supergroup." },
    { key: "forum", label: "Forum topics enabled", passed: forum, guidance: "Enable Topics in the group settings." },
    { key: "owner_admin", label: "Owner is an administrator", passed: ownerAdmin, guidance: "Promote the OWNER account to group administrator." },
    { key: "bot_admin", label: "Bot is an administrator", passed: botAdmin, guidance: "Promote the bot to administrator." },
    { key: "manage_topics", label: "Manage topics", passed: Boolean(rights?.can_manage_topics), guidance: "Enable Manage Topics for the bot." },
    { key: "delete_messages", label: "Delete messages", passed: Boolean(rights?.can_delete_messages), guidance: "Enable Delete Messages for the bot." },
    { key: "send_messages", label: "Send messages", passed: botAdmin, guidance: "Allow the bot to send messages." },
    { key: "pin_messages", label: "Pin messages", passed: Boolean(rights?.can_pin_messages), guidance: "Enable Pin Messages for the bot." }
  ];
  return {
    valid: checks.every((check) => check.passed), chatId,
    title: "title" in chat ? chat.title ?? null : null,
    username: "username" in chat ? chat.username ?? null : null,
    checks
  };
}

export function formatWorkspaceChecklist(result: WorkspaceValidationResult): string {
  return result.checks.map((check) => `${check.passed ? "✅" : "❌"} ${check.label}${!check.passed && check.guidance ? ` — ${check.guidance}` : ""}`).join("\n");
}

export function parsePublicSupergroupReference(value: string): string | null {
  const trimmed = value.trim();
  const match = /^(?:@|https?:\/\/t\.me\/|t\.me\/)([A-Za-z][A-Za-z0-9_]{4,31})\/?$/.exec(trimmed);
  return match?.[1] ? `@${match[1]}` : null;
}

export function isPrivateInviteLink(value: string): boolean {
  return /^https?:\/\/t\.me\/(?:\+|joinchat\/)/i.test(value.trim());
}
