import 'reflect-metadata';
import { type INestApplication, Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import { newId } from '../../domain/shared/id';
import type { Container } from '../../container';
import { runWithLogContext } from '../../infrastructure/observability/log-context';
import { AuthGuard, NoopProviderIdentity, type ProviderIdentityPort } from './auth';
import { HealthController, WageringController, WalletsController } from './controllers';
import { ErrorFilter } from './error-filter';
import { CONTAINER, PROVIDER_IDENTITY } from './tokens';

const CORRELATION_HEADER = 'x-correlation-id';
const CORRELATION_PATTERN = /^[\x21-\x7e]{1,128}$/;

@Module({})
class HttpModule {
  static register(container: Container, identity: ProviderIdentityPort): DynamicModule {
    return {
      module: HttpModule,
      controllers: [WalletsController, WageringController, HealthController],
      providers: [
        { provide: CONTAINER, useValue: container },
        { provide: PROVIDER_IDENTITY, useValue: identity },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    };
  }
}

export async function createHttpApp(
  container: Container,
  identity: ProviderIdentityPort = new NoopProviderIdentity(),
): Promise<INestApplication> {
  const app = await NestFactory.create(HttpModule.register(container, identity), {
    logger: false,
    bodyParser: true,
  });
  app.use((request: Request, response: Response, next: NextFunction) => {
    const incoming = request.header(CORRELATION_HEADER);
    const correlationId = incoming && CORRELATION_PATTERN.test(incoming) ? incoming : newId();
    response.setHeader(CORRELATION_HEADER, correlationId);
    const startedAt = performance.now();
    runWithLogContext({ correlationId }, () => {
      response.on('finish', () => {
        container.logger.info('http request', {
          correlationId,
          method: request.method,
          path: request.route?.path ?? request.path,
          status: response.statusCode,
          durationMs: Math.round(performance.now() - startedAt),
        });
      });
      next();
    });
  });
  app.useGlobalFilters(new ErrorFilter(container.logger));
  return app;
}
