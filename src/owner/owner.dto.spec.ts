import {
  ownerPassword,
  ownerSetupSchema,
  acceptInvitationSchema,
} from './owner.dto.js';
it('accepts eight-character owner/setup passwords and rejects shorter passwords', () => {
  expect(ownerPassword.safeParse('Owner123').success).toBe(true);
  expect(ownerPassword.safeParse('short12').success).toBe(false);
  expect(ownerPassword.safeParse('a'.repeat(129)).success).toBe(false);
  expect(
    ownerSetupSchema.safeParse({
      token: 'a'.repeat(43),
      name: 'Owner',
      password: 'Owner123',
      code: '123456',
    }).success,
  ).toBe(true);
});
it('uses the same eight-character minimum for first-company administrator invitations', () => {
  expect(
    acceptInvitationSchema.safeParse({
      token: 'a'.repeat(43),
      name: 'Admin',
      password: 'Admin123',
      branchName: 'Main',
      policy: {
        address: 'Office',
        latitude: 30,
        longitude: 31,
        radiusMeters: 50,
        trackingRadiusMeters: 150,
        trackingGraceMinutes: 5,
      },
    }).success,
  ).toBe(true);
});
