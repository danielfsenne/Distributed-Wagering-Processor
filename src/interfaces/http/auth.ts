import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { ProviderPrincipal } from '../../application/provider-access';
import { PROVIDER_IDENTITY } from './tokens';

export const IS_PUBLIC = 'wagering:isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

export type AuthenticatedRequest = Request & { principal?: ProviderPrincipal };

export interface ProviderIdentityPort {
  resolve(request: Request): Promise<ProviderPrincipal>;
}

export const ANONYMOUS_PRINCIPAL: ProviderPrincipal = { subject: 'anonymous', providerIds: '*' };

export class NoopProviderIdentity implements ProviderIdentityPort {
  async resolve(): Promise<ProviderPrincipal> {
    return ANONYMOUS_PRINCIPAL;
  }
}

export function principalOf(request: AuthenticatedRequest): ProviderPrincipal {
  return request.principal ?? ANONYMOUS_PRINCIPAL;
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
