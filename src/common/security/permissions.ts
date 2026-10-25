import { companyContext } from '../../database/database.service.js';
import { ForbiddenException } from '@nestjs/common';
import type { Actor } from '../types/actor.type.js';

export function requireHr(actor: Actor) {
  if (actor.role !== 'hr' && actor.role !== 'admin')
    throw new ForbiddenException('HR access required');
  const context = companyContext.getStore();
  if (actor.role === 'hr' && context?.actor && context.grants === '')
    throw new ForbiddenException('No HR branches have been assigned');
}

export function requireAdmin(actor: Actor) {
  if (actor.role !== 'admin')
    throw new ForbiddenException('Administrator access required');
}
