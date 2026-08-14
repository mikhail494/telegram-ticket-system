import pino from "pino";
import { config } from "./config.js";
import { sanitizeLogValue } from "./logSanitizer.js";

export function createLogger(destination?: pino.DestinationStream): pino.Logger {
  return pino({
    level: config.logLevel,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: { err: (error) => sanitizeLogValue(error) },
    formatters: { log: (object) => sanitizeLogValue(object) as Record<string, unknown> },
    hooks: {
      logMethod(args, method) {
        method.apply(this, args.map((arg) => sanitizeLogValue(arg)) as never);
      }
    }
  }, destination);
}

export const logger = createLogger();
