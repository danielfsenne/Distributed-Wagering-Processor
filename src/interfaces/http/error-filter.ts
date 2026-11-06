import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import type { Response } from 'express';
import { ApplicationError, ValidationError } from '../../application/errors';
import type { Logger } from '../../application/ports';
import { DomainError } from '../../domain/shared/domain-error';

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    issues?: Array<{ field: string; message: string }>;
    transactionId?: string;
  };
}

const STATUS_BY_CATEGORY = {
  validation: 400,
  'not-found': 404,
  conflict: 409,
  transient: 503,
} as const;

export function describeError(error: unknown): { status: number; body: ErrorBody } {
  if (error instanceof ApplicationError) {
    const status = STATUS_BY_CATEGORY[error.category];
    const transactionId = (error as { transactionId?: unknown }).transactionId;
    return {
      status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          retryable: error.category === 'transient',
          ...(error instanceof ValidationError && error.issues.length > 0 ? { issues: error.issues } : {}),
          ...(typeof transactionId === 'string' ? { transactionId } : {}),
        },
      },
    };
  }
  if (error instanceof DomainError) {
    return {
      status: 400,
      body: { error: { code: error.code, message: error.message, retryable: false } },
    };
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    const code =
      status === 400 ? 'INVALID_PAYLOAD' : status === 404 ? 'ROUTE_NOT_FOUND' : `HTTP_${status}`;
    return {
      status,
      body: { error: { code, message: error.message, retryable: status >= 500 } },
    };
  }
  return {
    status: 500,
    body: { error: { code: 'INTERNAL_ERROR', message: 'Unexpected error', retryable: true } },
  };
}

@Catch()
export class ErrorFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { status, body } = describeError(exception);
    if (status >= 500) {
      this.logger.error('request failed', {
        status,
        code: body.error.code,
        error: exception instanceof Error ? exception.message : String(exception),
        cause:
          exception instanceof Error && exception.cause instanceof Error ? exception.cause.message : undefined,
      });
    } else {
      this.logger.info('request rejected', { status, code: body.error.code });
    }
    if (status === 503) {
      response.setHeader('Retry-After', '1');
    }
    response.status(status).json(body);
  }
}
