import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { PROVIDER_IDENTITY } from './tokens';

export const IS_PUBLIC = 'wagering:isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

export interface Principal {
  subject: string;
  providerIds: readonly string[] | '*';
}

export type AuthenticatedRequest = Request & { principal?: Principal };

export interface ProviderIdentityPort {
  resolve(request: Request): Promise<Principal>;
  assertMayActFor(principal: Principal | undefined, providerId: string): void;
}

export const ANONYMOUS_PRINCIPAL: Principal = { subject: 'anonymous', providerIds: '*' };

export class NoopProviderIdentity implements ProviderIdentityPort {
  async resolve(): Promise<Principal> {
    return ANONYMOUS_PRINCIPAL;
  }

  assertMayActFor(): void {}
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    request.principal = await this.identity.resolve(request);
    return true;
  }
}
