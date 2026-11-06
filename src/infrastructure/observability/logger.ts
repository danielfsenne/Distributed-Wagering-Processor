import pino, { type Logger as PinoLogger } from 'pino';
import type { LogFields, Logger } from '../../application/ports';
import { currentLogContext } from './log-context';

const REDACTED_PATHS = [
  'money',
  'balance',
  'payload',
  'body',
  'data',
  'authorization',
  'headers.authorization',
  '*.money',
  '*.balance',
  '*.payload',
];

export function createRootLogger(level = process.env.LOG_LEVEL ?? 'info'): PinoLogger {
  return pino({
    level,
    base: { service: 'wagering-processor', pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    messageKey: 'msg',
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    mixin: () => currentLogContext(),
  });
}

export class PinoAppLogger implements Logger {
  constructor(private readonly logger: PinoLogger) {}

  child(bindings: LogFields): PinoAppLogger {
    return new PinoAppLogger(this.logger.child(bindings));
  }

  debug(message: string, fields?: LogFields): void {
    this.logger.debug(fields ?? {}, message);
  }

  info(message: string, fields?: LogFields): void {
    this.logger.info(fields ?? {}, message);
  }

  warn(message: string, fields?: LogFields): void {
    this.logger.warn(fields ?? {}, message);
  }

  error(message: string, fields?: LogFields): void {
    this.logger.error(fields ?? {}, message);
  }
}
