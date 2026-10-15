import { computeDestinationPoint } from 'geolib';
import {
  officePolicy,
  validateLocation,
} from './attendance-evidence.service.js';

describe('Office boundary', () => {
  it('uses the configured company coordinates and radius', () => {
    const policy = { latitude: 31, longitude: 30, radiusMeters: 200 };
    const input = { accuracyMeters: 10, capturedAt: new Date().toISOString() };
    expect(
      validateLocation(
        { ...computeDestinationPoint(policy, 199, 90, 6378137), ...input },
        policy,
      ).distanceMeters,
    ).toBeLessThanOrEqual(200);
    expect(() =>
      validateLocation(
        { ...computeDestinationPoint(policy, 201, 90, 6378137), ...input },
        policy,
      ),
    ).toThrow('within 200 metres');
  });
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
