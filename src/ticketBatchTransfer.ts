import {
  streamResponseToFileBounded,
  getResponseContentLength,
  ResponseBodyLimitExceededError,
  ResponseBodyStorageLimitExceededError,
} from "./boundedTelegramResponse.js";
import { TicketBatchExportSizeLimitError } from "./ticketBatch.js";
import type { TicketBatchAttachmentDownloadResult } from "./ticketBatch.js";

export async function streamTicketBatchAttachment(
  response: Response,
  destinationPath: string,
  reportedFileSize: number | undefined,
  limits: { maxAttachmentBytes: number; remainingExportBytes: number }
): Promise<TicketBatchAttachmentDownloadResult> {
  const { maxAttachmentBytes, remainingExportBytes } = limits;
  if (reportedFileSize !== undefined && reportedFileSize > maxAttachmentBytes) {
    await cancelResponse(response);
    return tooLargeAttachment();
  }

  const contentLength = getResponseContentLength(response);
  if (contentLength !== undefined && contentLength > maxAttachmentBytes) {
    await cancelResponse(response);
    return tooLargeAttachment();
  }
  try {
    return await streamResponseToFileBounded(
      response,
      destinationPath,
      maxAttachmentBytes,
      Math.min(maxAttachmentBytes, remainingExportBytes)
    );
  } catch (error) {
    if (error instanceof ResponseBodyLimitExceededError) return tooLargeAttachment();
    if (error instanceof ResponseBodyStorageLimitExceededError) throw new TicketBatchExportSizeLimitError();
    throw error;
  }
}

function tooLargeAttachment(): TicketBatchAttachmentDownloadResult {
  return {
    unavailable: true,
    failureCategory: "TELEGRAM_FILE_TOO_LARGE",
    failureReason: "Attachment exceeds the hosted Telegram Bot API download limit.",
  };
}

async function cancelResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}
