import type { EmployeeRequest } from '../requests/types/employee-request.type.js';
import { shiftDate } from './attendance-time.js';

/**
 * Minutes of approved "arriving late" excuse per employee and work date
 * (`employeeId:YYYY-MM-DD`). Arrival within these minutes is not late.
 */
export function arrivalExcuseMinutes(requests: EmployeeRequest[]) {
  const minutes = new Map<string, number>();
  for (const request of requests) {
    if (
      request.status !== 'approved' ||
      request.type !== 'excuse' ||
      request.excuseType !== 'arriving-late'
    )
      continue;
    for (
      let date = request.from;
      date <= request.to;
      date = shiftDate(date, 1)
    ) {
      const key = `${request.employeeId}:${date}`;
      minutes.set(key, (minutes.get(key) ?? 0) + request.durationMinutes);
    }
  }
  return minutes;
}
