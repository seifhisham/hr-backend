import { ForbiddenException } from '@nestjs/common';
import type { Actor } from '../types/actor.type.js';

export function requireHr(actor: Actor) {
  if (actor.role === 'employee')
    throw new ForbiddenException('HR access required');
}

export function requireAdmin(actor: Actor) {
  if (actor.role !== 'admin')
    throw new ForbiddenException('Administrator access required');
}
