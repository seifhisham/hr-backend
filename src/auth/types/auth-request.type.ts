import type { Request } from 'express';
import type { Actor } from '../../common/types/actor.type.js';

export type AuthRequest = Request & { actor: Actor; sessionToken: string };
