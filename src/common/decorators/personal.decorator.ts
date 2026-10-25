import { SetMetadata } from '@nestjs/common';
export const PERSONAL_ROUTE = 'personal-route';
export const Personal = (changesSession = false) =>
  SetMetadata(PERSONAL_ROUTE, changesSession ? 'session-change' : true);
