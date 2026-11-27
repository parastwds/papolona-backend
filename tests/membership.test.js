const env = require('../src/config/env');
const db = require('../src/db');
const { setupDB, resetData, teardownDB, api, registerUser, bearer, givePennies } = require('./helpers');

beforeAll(() => setupDB('membership'));
beforeEach(resetData);
afterAll(teardownDB);

const realRequired = env.PROBATION_READINGS;
beforeEach(() => {
  env.PROBATION_READINGS = 3;
});
afterAll(() => {
  env.PROBATION_READINGS = realRequired;
});

// Signed up long enough ago that the apprenticeship's days are done: only the readings decide.
async function signedIn({ passed = 0 } = {}) {
  const { tokens, user } = await registerUser();
  await db.testing.backdateUser(user.id, env.PROBATION_DAYS);
  if (passed) await db.testing.addPassedReadings(user.id, passed);
  return { token: tokens.accessToken, userId: user.id };
}

const status = (token) => api().get('/api/v1/membership').set(bearer(token));
const join = (token, body) => api().post('/api/v1/membership/join').set(bearer(token)).send(body ?? {});
const choose = (token, type) => api().put('/api/v1/membership/type').set(bearer(token)).send({ type });

describe('membership', () => {
  test('requires a signed-in user', async () => {
    expect((await api().get('/api/v1/membership')).status).toBe(401);
    expect((await api().post('/api/v1/membership/join')).status).toBe(401);
  });

  test('during probation: free, but cannot join yet', async () => {
    const { token } = await signedIn({ passed: 1 });
    const res = await status(token);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      status: 'probation',
      isMember: false,
      memberSince: null,
      probation: { readingsDone: 1, readingsRequired: 3, complete: false },
      free: true,
      price: null,
      canJoin: false,
    });

    const joined = await join(token, { type: 'explorer' });
    expect(joined.status).toBe(403);
    expect(joined.body.error.code).toBe('PROBATION_INCOMPLETE');
  });

  test('after probation: joining as a Collector is free and makes the user a member', async () => {
    const { token, userId } = await signedIn({ passed: 3 });
    expect((await status(token)).body.data.canJoin).toBe(true);
    // A membership is compulsory.
    const without = await join(token);
    expect(without.status).toBe(400);
    expect((await status(token)).body.data.isMember).toBe(false);

    const joined = await join(token, { type: 'collector' });
    expect(joined.status).toBe(201);
    expect(joined.body.data.membership).toMatchObject({ status: 'member', isMember: true, canJoin: false });
    expect(joined.body.data.membership.memberSince).toEqual(expect.any(String));

    const me = await api().get('/api/v1/users/me').set(bearer(token));
    expect(me.body.data.user).toMatchObject({ status: 'member', memberSince: expect.any(String) });
    // Nothing is charged.
    expect(await db.payments.list(userId)).toHaveLength(0);
  });

  test('joining twice: the second is refused', async () => {
    const { token } = await signedIn({ passed: 3 });
    const [first, second] = await Promise.all([join(token, { type: 'collector' }), join(token, { type: 'collector' })]);
    expect([first.status, second.status].sort()).toEqual([201, 409]);
    const again = await join(token, { type: 'collector' });
    expect(again.body.error.code).toBe('ALREADY_MEMBER');
  });

  test('the three memberships, and the one the cohort suggests', async () => {
    const { token, userId } = await signedIn({ passed: 3 });
    const data = (await status(token)).body.data;
    expect(data.membershipType).toBeNull();
    // Priced in Papolona pennies.
    expect(data.membershipTypes.map((t) => [t.id, t.priceCents, t.currency])).toEqual([
      ['explorer', env.MEMBERSHIP_EXPLORER_CENTS, 'PNY'],
      ['creator', env.MEMBERSHIP_CREATOR_CENTS, 'PNY'],
      ['collector', env.MEMBERSHIP_COLLECTOR_CENTS, 'PNY'],
    ]);
    // The test questionnaire answers make an artist: the creator cohort suggests Creator.
    expect((await db.users.findById(userId)).cohort).toBe('creator');
    expect(data.suggestedType).toBe('creator');
  });

  test('a new Creator starts provisional: free, Single, Twin and Level 1 only; Collector is free', async () => {
    const creator = await signedIn({ passed: 3 });
    expect((await join(creator.token, { type: 'castle' })).status).toBe(400);
    const joined = await join(creator.token, { type: 'creator' });
    expect(joined.status).toBe(201);
    expect(joined.body.data).toMatchObject({
      payment: null,
      membership: {
        membershipType: 'creator',
        creatorStage: 'provisional',
        allowedSeriesLengths: [1, 2, 3],
        canProfit: true,
        // A provisional Creator has no two-month terms yet.
        standing: { required: false },
        wallet: { balanceCents: 1000, currency: 'PNY' },
      },
    });
    const me = await api().get('/api/v1/users/me').set(bearer(creator.token));
    expect(me.body.data.user.membershipType).toBe('creator');

    const collector = await signedIn({ passed: 3 });
    const free = await join(collector.token, { type: 'collector' });
    expect(free.body.data).toMatchObject({ payment: null, membership: { membershipType: 'collector' } });
    expect(await db.payments.list(collector.userId)).toHaveLength(0);
  });

  test('members choose or change their membership later', async () => {
    const { token, userId } = await signedIn({ passed: 3 });
    expect((await choose(token, 'explorer')).body.error.code).toBe('MEMBERSHIP_REQUIRED');
    await join(token, { type: 'collector' });
    // Collectors are invited to create.
    expect((await status(token)).body.data.creatorInvite).toBe(true);
    // Switching to Creator starts provisional, and free.
    const chosen = await choose(token, 'creator');
    expect(chosen.status).toBe(200);
    expect(chosen.body.data.membership).toMatchObject({ membershipType: 'creator', creatorStage: 'provisional' });
    expect(chosen.body.data.payment).toBeNull();
    expect((await choose(token, 'creator')).body.error.code).toBe('SAME_MEMBERSHIP');
    // A full Creator (their first Level 1 conversion, see market tests) who leaves and comes back is full at
    // once, and pays the first month in pennies.
    await db.testing.confirmCreator(userId);
    await givePennies(userId, 5000);
    // Explorer is free after graduation, and limited: singles, twins and Level 1, no profit.
    const explorer = await choose(token, 'explorer');
    expect(explorer.body.data).toMatchObject({
      payment: null,
      membership: { membershipType: 'explorer', allowedSeriesLengths: [1, 2, 3], canProfit: false },
    });
    // Switching back to Creator, once a full Creator: charged in pennies, every level at once.
    const back = await choose(token, 'creator');
    expect(back.body.data.payment).toMatchObject({ amountCents: env.MEMBERSHIP_CREATOR_CENTS, currency: 'PNY' });
    expect(back.body.data.membership).toMatchObject({
      creatorStage: 'full',
      allowedSeriesLengths: [1, 2, 3, 6, 12, 24],
      canProfit: true,
      wallet: { balanceCents: 1000 - env.MEMBERSHIP_CREATOR_CENTS + 5000 },
    });
    expect(await db.payments.list(userId)).toHaveLength(1);
  });

  test('the old checkout route joins too, with a membership', async () => {
    const { token, userId } = await signedIn({ passed: 3 });
    const res = await api().post('/api/v1/membership/checkout').set(bearer(token)).send({ type: 'collector' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ payment: null, membership: { status: 'member' } });
    expect(await db.payments.list(userId)).toHaveLength(0);
  });
});

describe('standing: Creators and Collectors keep their membership by meeting its terms', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const realDemo = env.DEMO_PAYMENTS;
  beforeEach(() => {
    env.DEMO_PAYMENTS = true;
  });
  afterAll(() => {
    env.DEMO_PAYMENTS = realDemo;
  });

  async function memberAs(type) {
    const member = await signedIn({ passed: 3 });
    await join(member.token, { type });
    return member;
  }
  // Moves the start of the member's current period back past its end.
  const periodOver = (userId) =>
    db.users.update(userId, { membershipTypeSince: new Date(Date.now() - (env.STANDING_PERIOD_DAYS + 1) * DAY) });
  const payFee = (token) => api().post('/api/v1/membership/collector-fee').set(bearer(token)).send({});
  const recordPurchase = (userId) =>
    db.payments.record(userId, 'nft_purchase', { amountCents: 9000, currency: 'USD', provider: 'demo' });

  test('explorers have no terms; a new Collector has the whole first period', async () => {
    const explorer = await memberAs('explorer');
    expect((await status(explorer.token)).body.data.standing).toMatchObject({ required: false, met: true });

    const collector = await memberAs('collector');
    const res = (await status(collector.token)).body.data;
    expect(res.standing).toMatchObject({ required: true, type: 'collector', met: true, periodDays: env.STANDING_PERIOD_DAYS });
    expect(new Date(res.standing.dueBy).getTime()).toBeGreaterThan(Date.now() + (env.STANDING_PERIOD_DAYS - 1) * DAY);
  });

  test('a Collector who did nothing in the period returns to Explorer', async () => {
    const { token, userId } = await memberAs('collector');
    await periodOver(userId);
    const res = (await status(token)).body.data;
    expect(res).toMatchObject({ membershipType: 'explorer', demotedFrom: 'collector', canProfit: false });
    // Once: the next look just shows an Explorer.
    expect((await status(token)).body.data.demotedFrom).toBeNull();
  });

  test('the Collector fee keeps a Collector; it is paid in pennies', async () => {
    const { token, userId } = await memberAs('collector');
    await periodOver(userId);
    // 1,000 pennies to start with: not enough for the fee.
    const short = await payFee(token);
    expect(short.status).toBe(402);
    expect(short.body.error).toMatchObject({ code: 'NOT_ENOUGH_PENNIES', details: { needed: env.COLLECTOR_FEE_CENTS, balance: 1000 } });
    await givePennies(userId, env.COLLECTOR_FEE_CENTS);
    const paid = await payFee(token);
    expect(paid.status).toBe(201);
    expect(paid.body.data.payment).toMatchObject({
      purpose: 'collector_fee',
      amountCents: env.COLLECTOR_FEE_CENTS,
      currency: 'PNY',
    });
    expect(paid.body.data.membership.wallet.balanceCents).toBe(1000);
    expect(paid.body.data.membership).toMatchObject({ membershipType: 'collector', standing: { met: true } });
  });

  test('a purchase keeps a Collector only while the wallet holds the minimum', async () => {
    const { token, userId } = await memberAs('collector');
    await recordPurchase(userId);
    await periodOver(userId);
    // Bought, but the wallet is empty: the period has ended.
    let res = (await status(token)).body.data;
    expect(res.membershipType).toBe('explorer');

    // Back to Collector (a new first period), then a purchase with the minimum in the wallet.
    await choose(token, 'collector');
    await givePennies(userId, env.COLLECTOR_MIN_WALLET_CENTS);
    await recordPurchase(userId);
    await periodOver(userId);
    res = (await status(token)).body.data;
    expect(res).toMatchObject({ membershipType: 'collector', standing: { met: true, walletOk: true } });
  });

  test('art worth the yearly amount in 12 months keeps a Collector for those 12 months, wallet or not', async () => {
    const { token, userId } = await memberAs('collector');
    const buy = (amountCents) =>
      db.payments.record(userId, 'nft_purchase', { amountCents, currency: 'USD', provider: 'demo' });
    await buy(env.COLLECTOR_ART_YEAR_CENTS - 4000);
    await buy(4000);
    await periodOver(userId);
    const res = (await status(token)).body.data;
    expect(res).toMatchObject({
      membershipType: 'collector',
      standing: {
        met: true,
        walletOk: false,
        artYearCents: env.COLLECTOR_ART_YEAR_CENTS,
        artYearTargetCents: env.COLLECTOR_ART_YEAR_CENTS,
      },
    });
    // Covered until the oldest purchase it needed is a year old.
    expect(new Date(res.standing.dueBy).getTime()).toBeGreaterThan(Date.now() + 364 * DAY);
  });

  test('a provisional Creator has no terms; a full Creator who converted nothing in the period returns to Explorer', async () => {
    const { token, userId } = await memberAs('creator');
    await periodOver(userId);
    expect((await status(token)).body.data).toMatchObject({
      membershipType: 'creator',
      creatorStage: 'provisional',
      standing: { required: false },
    });
    await db.testing.confirmCreator(userId);
    expect((await status(token)).body.data.standing).toMatchObject({ required: true, met: true });
    await db.users.update(userId, { creatorConfirmedAt: new Date(Date.now() - (env.STANDING_PERIOD_DAYS + 1) * DAY) });
    const res = (await status(token)).body.data;
    expect(res).toMatchObject({ membershipType: 'explorer', demotedFrom: 'creator' });
  });

  test('Collectors are reminded now and then that they can start creating', async () => {
    const { userId } = await memberAs('collector');
    const { dispatchDue } = require('../src/modules/reminders/reminders.service');
    const { outbox } = require('../src/utils/mailer');
    const sent = () => outbox.filter((m) => m.subject === 'You can start creating too').length;
    const before = sent();
    // Not in their first days as a Collector.
    await dispatchDue();
    expect(sent()).toBe(before);
    // A Collector for a while: once, then not again until COLLECTOR_NUDGE_DAYS have passed.
    await db.users.update(userId, { membershipTypeSince: new Date(Date.now() - (env.COLLECTOR_NUDGE_DAYS + 1) * DAY) });
    await dispatchDue();
    await dispatchDue();
    expect(sent()).toBe(before + 1);
  });

  test('the Collector fee is for Collectors', async () => {
    const { token } = await memberAs('explorer');
    expect((await payFee(token)).body.error.code).toBe('COLLECTORS_ONLY');
  });
});

describe('donations', () => {
  const realDemo = env.DEMO_PAYMENTS;
  afterAll(() => {
    env.DEMO_PAYMENTS = realDemo;
  });
  const donate = (token, amountCents) =>
    api().post('/api/v1/membership/donation').set(bearer(token)).send({ amountCents });

  test('anyone signed in can give, apprentices too; it shows among their purchases', async () => {
    env.DEMO_PAYMENTS = true;
    expect((await api().post('/api/v1/membership/donation').send({ amountCents: 1000 })).status).toBe(401);
    const { token, userId } = await signedIn();
    expect((await donate(token, 50)).body.error.code).toBe('INVALID_AMOUNT');
    expect((await donate(token, 2000000)).body.error.code).toBe('INVALID_AMOUNT');
    // Given in pennies: more than the 1,000 a new user has is refused.
    expect((await donate(token, 2500)).status).toBe(402);
    const res = await donate(token, 600);
    expect(res.status).toBe(201);
    expect(res.body.data.payment).toMatchObject({ purpose: 'donation', amountCents: 600, currency: 'PNY' });
    expect((await db.users.findById(userId)).walletCents).toBe(400);
    const purchases = await api().get('/api/v1/users/me/purchases').set(bearer(token));
    expect(purchases.body.data.purchases.map((p) => p.purpose)).toContain('donation');
    expect(await db.payments.list(userId)).toHaveLength(1);
  });

  test('without real payments set up, giving pennies still works', async () => {
    env.DEMO_PAYMENTS = false;
    const { token } = await signedIn();
    expect((await donate(token, 100)).status).toBe(201);
  });
});
