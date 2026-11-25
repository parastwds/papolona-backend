const { sql } = require('drizzle-orm');
const db = require('../src/db');
const { db: rawDb } = require('../src/db/postgres/connection');
const { setupDB, resetData, teardownDB, api, registerUser, bearer, lastChangeCode } = require('./helpers');
const { countryOfPhone } = require('../src/utils/phoneCountry');

beforeAll(() => setupDB('community'));
beforeEach(resetData);
afterAll(teardownDB);

const setPhone = async ({ tokens, user }, phone) => {
  await api().post('/api/v1/users/me/phone').set(bearer(tokens.accessToken)).send({ phone });
  const res = await api()
    .post('/api/v1/users/me/phone/confirm')
    .set(bearer(tokens.accessToken))
    .send({ code: lastChangeCode(user.email) });
  expect(res.status).toBe(200);
};

const getMap = ({ tokens }) => api().get('/api/v1/community/map').set(bearer(tokens.accessToken));

describe('countryOfPhone', () => {
  test('reads the country from the calling code, telling shared codes apart', () => {
    expect(countryOfPhone('+919876543210')).toBe('IN');
    expect(countryOfPhone('+33612345678')).toBe('FR');
    expect(countryOfPhone('+12125550123')).toBe('US');
    expect(countryOfPhone('+14165550123')).toBe('CA');
    expect(countryOfPhone('+77011234567')).toBe('KZ');
    expect(countryOfPhone('+99999999999')).toBeNull();
    expect(countryOfPhone(null)).toBeNull();
  });
});

describe('GET /community/stats', () => {
  test('needs a signed-in user', async () => {
    expect((await api().get('/api/v1/community/stats')).status).toBe(401);
  });

  test('counts readings, completed series, countries and members', async () => {
    const a = await registerUser({ phone: '+919876543210' });
    const b = await registerUser({ phone: '+919876543211' });
    const c = await registerUser({ phone: '+33612345678' });
    await db.users.promoteToMember(b.user.id);
    const now = new Date();
    await db.clueDraws.create({ userId: a.user.id, clue: 'ABC', question: '', generatedAt: now, nextAvailableAt: now });
    await db.clueDraws.create({ userId: b.user.id, clue: 'DEF', question: '', generatedAt: now, nextAvailableAt: now });
    await rawDb().execute(sql`
      insert into nft_series (user_id, length, rows, cols, rarity, status, artwork_key, reveal_order, revealed_tiles, started_at, deadline_at, completed_at)
      values (${b.user.id}, 1, 1, 1, 'common', 'completed', 'none', '{0}', '{0}', now(), now(), now())`);
    // A deleted account's country no longer counts.
    await api().delete('/api/v1/users/me').set(bearer(c.tokens.accessToken)).send({ password: c.password });

    const res = await api().get('/api/v1/community/stats').set(bearer(a.tokens.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ sessions: 2, artworks: 1, countries: 1, members: 1 });
  });
});

describe('GET /community/map', () => {
  test('needs a signed-in user', async () => {
    expect((await api().get('/api/v1/community/map')).status).toBe(401);
  });

  test('counts users per country of their phone number, split by membership', async () => {
    const a = await registerUser({ phone: '+919876543210' });
    const b = await registerUser({ phone: '+919876543211' });
    await registerUser({ phone: '+5511987654321' });
    const d = await registerUser();
    await db.users.promoteToMember(b.user.id);
    // An account from before numbers were compulsory: counted in the totals only.
    await rawDb().execute(sql`update users set phone = null, phone_country = null where id = ${d.user.id}`);
    // The profile country is the user's own claim: it never moves a pin.
    await api().patch('/api/v1/users/me').set(bearer(a.tokens.accessToken)).send({ country: 'FR' });
    await api().patch('/api/v1/users/me').set(bearer(d.tokens.accessToken)).send({ country: 'JP' });

    const res = await getMap(d);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      registered: 3,
      members: 1,
      countries: [
        { code: 'IN', registered: 1, members: 1 },
        { code: 'BR', registered: 1, members: 0 },
      ],
    });
    expect(JSON.stringify(res.body)).not.toMatch(/9876543/);
  });

  test('removing the phone clears its country; deleted accounts drop off', async () => {
    const a = await registerUser();
    const b = await registerUser();
    await setPhone(a, '+33612345678');
    await setPhone(a, null);
    await setPhone(b, '+819012345678');
    await api().delete('/api/v1/users/me').set(bearer(b.tokens.accessToken)).send({ password: b.password });

    const res = await getMap(a);
    expect(res.body.data).toEqual({ registered: 1, members: 0, countries: [] });
  });

  test('backfill fills numbers saved before the column existed', async () => {
    const a = await registerUser();
    await setPhone(a, '+4915112345678');
    await rawDb().execute(sql`update users set phone_country = null`);
    expect(await db.users.backfillPhoneCountries()).toBe(1);
    expect(await db.users.backfillPhoneCountries()).toBe(0);
    const res = await getMap(a);
    expect(res.body.data.countries).toEqual([{ code: 'DE', registered: 1, members: 0 }]);
  });
});
