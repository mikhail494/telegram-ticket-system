const messages = {
  MISSING: "Adaptive privacy key is missing; restore the original key or use explicit offline adaptive recovery.",
  MISMATCH: "Adaptive privacy key mismatch; restore the correct installation key.",
  DIRECTORY: "Unsafe adaptive key directory; use a trusted owner-controlled path.",
  PERMISSIONS: "Insecure adaptive key permissions; require an owner-only directory (0700) and key file (0600).",
  FILE: "Unsafe adaptive key file; refusing a symlink, unexpected hard link or substituted file.",
  LENGTH: "Invalid adaptive privacy key; expected exactly 32 bytes.",
} as const;

export class AdaptiveKeyError extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
    this.name = "AdaptiveKeyError";
  }
}
