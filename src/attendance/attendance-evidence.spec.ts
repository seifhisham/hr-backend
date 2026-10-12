import { computeDestinationPoint } from 'geolib';
import {
  officePolicy,
  validateLocation,
} from './attendance-evidence.service.js';

describe('Office boundary', () => {
  it('accepts just inside the radius and rejects just outside in every direction', () => {
    // Match getDistance's radius; the destination helper defaults to a different one.
    for (const bearing of [0, 90, 180, 270]) {
      const input = {
        accuracyMeters: 10,
        capturedAt: new Date().toISOString(),
      };
      expect(
        validateLocation({
          ...computeDestinationPoint(officePolicy, 49.9, bearing, 6378137),
          ...input,
        }).distanceMeters,
      ).toBeLessThanOrEqual(50);
      expect(() =>
        validateLocation({
          ...computeDestinationPoint(officePolicy, 50.1, bearing, 6378137),
          ...input,
        }),
      ).toThrow('within 50 metres');
    }
  });
});
