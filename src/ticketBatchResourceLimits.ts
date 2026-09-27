export const ANSWER_PACKAGE_MAX_BYTES = 5 * 1024 * 1024;
export const HOSTED_TELEGRAM_DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const TICKET_BATCH_EXPORT_MAX_BYTES = 50 * 1024 * 1024;

export interface TicketBatchResourceLimits {
  answerPackageMaxBytes: number;
  attachmentMaxBytes: number;
  exportMaxBytes: number;
  zipMaxBytes: number;
}

export const DEFAULT_TICKET_BATCH_RESOURCE_LIMITS: Readonly<TicketBatchResourceLimits> = {
  answerPackageMaxBytes: ANSWER_PACKAGE_MAX_BYTES,
  attachmentMaxBytes: HOSTED_TELEGRAM_DOWNLOAD_MAX_BYTES,
  exportMaxBytes: TICKET_BATCH_EXPORT_MAX_BYTES,
  zipMaxBytes: TICKET_BATCH_EXPORT_MAX_BYTES,
};
