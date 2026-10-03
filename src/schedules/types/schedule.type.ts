import { z } from 'zod';
import { scheduleSchema } from '../dto/schedule.dto.js';

export type Schedule = z.infer<typeof scheduleSchema> & { id: string };
