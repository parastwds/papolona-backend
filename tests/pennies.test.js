const env = require('../src/config/env');
const db = require('../src/db');
const { qrng } = require('../src/modules/clue/clue.service');
const { setupDB, resetData, teardownDB, api, registerUser, bearer } = require('./helpers');

beforeAll(() => setupDB('pennies'));
beforeEach(resetData);
afterAll(teardownDB);

const saved = { demo: env.DEMO_PAYMENTS, qrng: env.QRNG_API_KEY };
const realFetch = qrng.fetchHexStrings;
beforeEach(() => {
  env.DEMO_PAYMENTS = true;
  env.QRNG_API_KEY = 'test-key';
  qrng.fetchHexStrings = async () => ['48656c6c6f2021', '576f726c64'];
});
afterEach(() => {
  env.DEMO_PAYMENTS = saved.demo;
  env.QRNG_API_KEY = saved.qrng;
  qrng.fetchHexStrings = realFetch;
});

async function person(name = 'Asha Verma') {
  const { tokens, user } = await registerUser({ name });
  return { token: tokens.accessToken, id: user.id };
}
const wallet = async (p) => (await api().get('/api/v1/pennies').set(bearer(p.token))).body.data;
const history = async (p) => (await api().get('/api/v1/pennies/history').set(bearer(p.token))).body.data.transactions;
const balance = async (p) => (await db.users.findById(p.id)).walletCents;

describe('Papolona pennies', () => {
  test('requires a signed-in user', async () => {
    expect((await api().get('/api/v1/pennies')).status).toBe(401);
  });

  test('every new user starts with 1,000 pennies, in their history', async () => {
    const p = await person();
    const w = await wallet(p);
    expect(w).toMatchObject({
      balance: 1000,
      prices: { reading: env.PENNY_READING_PRICE, cluePrompt: env.PENNY_PROMPT_PRICE, messageRequest: env.PENNY_MESSAGE_REQUEST_PRICE },
      dailyBonus: { amount: env.PENNY_DAILY_BONUS, available: true },
    });
    expect(w.packs.map((pack) => [pack.id, pack.pennies, pack.priceCents])).toEqual([
      ['pack_1000', 1000, 1000],
      ['pack_5500', 5500, 5000],
      ['pack_12000', 12000, 10000],
    ]);
    expect(await history(p)).toEqual([expect.objectContaining({ amount: 1000, reason: 'welcome', balanceAfter: 1000 })]);
  });

  test('the daily bonus: once a day', async () => {
    const p = await person();
    const claim = () => api().post('/api/v1/pennies/daily-bonus').set(bearer(p.token));
    const first = await claim();
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ claimed: env.PENNY_DAILY_BONUS, wallet: { balance: 1000 + env.PENNY_DAILY_BONUS } });
    expect(first.body.data.wallet.dailyBonus).toMatchObject({ available: false, nextAt: expect.any(String) });
    expect((await claim()).body.error.code).toBe('BONUS_ALREADY_CLAIMED');
    // A day later it can be claimed again.
    await db.users.update(p.id, { dailyBonusAt: new Date(Date.now() - 25 * 60 * 60 * 1000) });
    expect((await claim()).status).toBe(200);
    expect(await balance(p)).toBe(1000 + 2 * env.PENNY_DAILY_BONUS);
  });

  test('penny packs are bought with real money (demo), the only real-money payment', async () => {
    const p = await person();
    const buy = (packId) => api().post('/api/v1/pennies/packs').set(bearer(p.token)).send({ packId });
    expect((await buy('pack_lots')).body.error.code).toBe('UNKNOWN_PACK');
    const bought = await buy('pack_5500');
    expect(bought.status).toBe(201);
    expect(bought.body.data).toMatchObject({
      wallet: { balance: 6500 },
      payment: { amountCents: 5000, currency: env.PENNY_PACK_CURRENCY },
    });
    expect((await history(p))[0]).toMatchObject({ amount: 5500, reason: 'pack', balanceAfter: 6500 });
    env.DEMO_PAYMENTS = false;
    expect((await buy('pack_1000')).status).toBe(503);
    expect(await balance(p)).toBe(6500);
  });

  test('each reading costs pennies; a clue that cannot be drawn costs nothing', async () => {
    const p = await person();
    const draw = () => api().post('/api/v1/clue-string').set(bearer(p.token)).send({ question: 'Today?' });
    expect((await draw()).status).toBe(201);
    expect(await balance(p)).toBe(1000 - env.PENNY_READING_PRICE);
    expect((await history(p))[0]).toMatchObject({ amount: -env.PENNY_READING_PRICE, reason: 'reading' });

    // The quantum source is down: given back.
    const other = await person('Grace Hopper');
    qrng.fetchHexStrings = async () => {
      throw new Error('down');
    };
    const failed = await api().post('/api/v1/clue-string').set(bearer(other.token)).send({ question: 'Today?' });
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(await balance(other)).toBe(1000);

    // Out of pennies: no reading.
    await db.users.update(other.id, { walletCents: 0 });
    qrng.fetchHexStrings = async () => ['48656c6c6f2021', '576f726c64'];
    const broke = await api().post('/api/v1/clue-string').set(bearer(other.token)).send({ question: 'Today?' });
    expect(broke.status).toBe(402);
    expect(broke.body.error.code).toBe('NOT_ENOUGH_PENNIES');
  });

  test('a message request costs pennies; one refused costs nothing', async () => {
    const ada = await person('Ada Lovelace');
    const grace = await person('Grace Hopper');
    const request = (from, to) =>
      api().post('/api/v1/dms/requests').set(bearer(from.token)).send({ userId: to.id, text: 'Hello!' });
    expect((await request(ada, grace)).status).toBe(201);
    expect(await balance(ada)).toBe(1000 - env.PENNY_MESSAGE_REQUEST_PRICE);
    // Already waiting: refused, and free.
    expect((await request(ada, grace)).status).toBe(409);
    expect(await balance(ada)).toBe(1000 - env.PENNY_MESSAGE_REQUEST_PRICE);
  });
});
