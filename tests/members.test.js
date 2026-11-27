const db = require('../src/db');
const { setupDB, resetData, teardownDB, api, registerUser, bearer } = require('./helpers');

beforeAll(() => setupDB('members'));
beforeEach(resetData);
afterAll(teardownDB);

async function person(name) {
  const { tokens, user } = await registerUser({ name });
  return { token: tokens.accessToken, id: user.id };
}

const get = (p, path) => api().get(`/api/v1/members${path}`).set(bearer(p.token));
const post = (p, path) => api().post(`/api/v1/members${path}`).set(bearer(p.token));

describe('member profiles', () => {
  test('anyone sees the profile; readings and NFTs stay locked until the member approves', async () => {
    const ada = await person('Ada Lovelace');
    const grace = await person('Grace Hopper');
    await db.testing.addPassedReadings(ada.id, 2);

    const locked = (await get(grace, `/${ada.id}`)).body.data;
    expect(locked).toMatchObject({
      member: { id: ada.id, name: 'Ada L.', role: 'Apprentice' },
      stats: { readings: 2, emblems: 0, nfts: 0 },
      access: 'none',
      dm: { state: 'none', threadId: null },
    });
    expect(locked.readings).toBeUndefined();
    expect(locked.nfts).toBeUndefined();

    // Her own profile is open to her.
    const own = (await get(ada, `/${ada.id}`)).body.data;
    expect(own.access).toBe('self');
    expect(own.readings).toHaveLength(2);
    expect((await post(ada, `/${ada.id}/access`)).status).toBe(400);

    expect((await post(grace, `/${ada.id}/access`)).body.data).toEqual({ access: 'pending' });
    expect((await get(grace, `/${ada.id}`)).body.data.access).toBe('pending');
    const waiting = (await get(ada, '/access-requests')).body.data.requests;
    expect(waiting).toEqual([{ id: expect.any(String), createdAt: expect.any(String), viewer: { id: grace.id, name: 'Grace H.', avatarUrl: null } }]);

    // Only the owner answers.
    expect((await post(grace, `/access-requests/${waiting[0].id}/approve`)).status).toBe(404);
    expect((await post(ada, `/access-requests/${waiting[0].id}/approve`)).body.data).toEqual({ status: 'approved' });
    const open = (await get(grace, `/${ada.id}`)).body.data;
    expect(open.access).toBe('approved');
    expect(open.readings.map((r) => r.coherent)).toEqual([true, true]);
    expect(open.nfts).toEqual([]);
    expect((await get(ada, '/access-requests')).body.data.requests).toEqual([]);

    // Revoked: locked again.
    await api().delete(`/api/v1/members/viewers/${grace.id}`).set(bearer(ada.token));
    expect((await get(grace, `/${ada.id}`)).body.data).toMatchObject({ access: 'none' });
  });

  test('a denied request can be asked again; a member who blocked you is not found', async () => {
    const ada = await person('Ada Lovelace');
    const grace = await person('Grace Hopper');
    await post(grace, `/${ada.id}/access`);
    const [req] = (await get(ada, '/access-requests')).body.data.requests;
    expect((await post(ada, `/access-requests/${req.id}/deny`)).body.data).toEqual({ status: 'denied' });
    expect((await get(grace, `/${ada.id}`)).body.data.access).toBe('denied');
    expect((await post(grace, `/${ada.id}/access`)).body.data).toEqual({ access: 'pending' });

    await api().post('/api/v1/dms/blocks').set(bearer(ada.token)).send({ userId: grace.id });
    expect((await get(grace, `/${ada.id}`)).status).toBe(404);
    expect((await post(grace, `/${ada.id}/access`)).status).toBe(404);
    expect((await get(ada, `/${grace.id}`)).body.data.blocked).toBe('by_me');
  });
});
