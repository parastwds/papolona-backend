const env = require('../src/config/env');
const db = require('../src/db');
const { qrng } = require('../src/modules/clue/clue.service');
const judgeAi = require('../src/modules/clue/judge.ai');
const { setupDB, resetData, teardownDB, api, registerUser, bearer } = require('./helpers');

beforeAll(() => setupDB('market'));
beforeEach(resetData);
afterAll(teardownDB);

const SAMPLE = ['48656c6c6f2021', '576f726c64'];
const realFetch = qrng.fetchHexStrings;
const realChat = judgeAi.llm.chat;
const saved = {
  qrng: env.QRNG_API_KEY,
  ai: env.ANTHROPIC_API_KEY,
  demo: env.DEMO_PAYMENTS,
};
const reply = JSON.stringify({
  verdict: 'pass',
  parts: [{ part: 'HELL', meaning: 'A hard place.' }],
  feedback: 'Feedback.',
  eeriness: 5,
  satisfaction: 5,
});

beforeEach(() => {
  env.QRNG_API_KEY = 'test-key';
  env.ANTHROPIC_API_KEY = 'test-key';
  env.DEMO_PAYMENTS = true;
  qrng.fetchHexStrings = async () => SAMPLE;
  judgeAi.llm.chat = async () => reply;
});
afterEach(() => {
  qrng.fetchHexStrings = realFetch;
  judgeAi.llm.chat = realChat;
  env.QRNG_API_KEY = saved.qrng;
  env.ANTHROPIC_API_KEY = saved.ai;
  env.DEMO_PAYMENTS = saved.demo;
});

const ADDRESS = {
  recipientName: 'Asha Verma',
  addressLine1: '1 Banyan Road',
  city: 'Pune',
  postcode: '411001',
  country: 'India',
};

async function member(name = 'Asha Verma') {
  const { tokens, user } = await registerUser({ name });
  await db.users.promoteToMember(user.id);
  return { token: tokens.accessToken, userId: user.id };
}

async function reading(token) {
  const draw = (await api().post('/api/v1/clue-string').set(bearer(token)).send({ question: 'Today?' })).body.data;
  return (
    await api()
      .post(`/api/v1/clue-string/${draw.id}/interpretation`)
      .set(bearer(token))
      .send({ text: 'HELL-OW: a hard place, then pain. The way through is hard.', source: 'text' })
  ).body.data;
}

async function complete(token, length) {
  expect((await api().post('/api/v1/series').set(bearer(token)).send({ length })).status).toBe(201);
  let judged;
  for (let i = 0; i < length; i += 1) judged = await reading(token);
  return judged.series;
}

const convert = (token, id, body = {}) => api().post(`/api/v1/series/${id}/convert`).set(bearer(token)).send(body);
const orderStone = (token, body = ADDRESS) => api().post('/api/v1/membership/stone').set(bearer(token)).send(body);
const membership = async (token) => (await api().get('/api/v1/membership').set(bearer(token))).body.data;
const list = (token, seriesId, priceCents) =>
  api().post('/api/v1/market/listings').set(bearer(token)).send({ seriesId, priceCents });
const buy = (token, id) => api().post(`/api/v1/market/listings/${id}/buy`).set(bearer(token));

/** A member who has ordered the stone and converted a triple: active, with an NFT to sell. */
async function activeSeller(name = 'Asha Verma') {
  const m = await member(name);
  const triple = await complete(m.token, 3);
  expect((await orderStone(m.token)).status).toBe(201);
  expect((await convert(m.token, triple.id)).status).toBe(201);
  return { ...m, nft: triple };
}

describe('conversion and active membership', () => {
  test('series are named Triple, Hexa, Dozen and Double Dozen, with conversion prices', async () => {
    const { token } = await member();
    const { options } = (await api().get('/api/v1/series/options').set(bearer(token))).body.data;
    expect(options.map((o) => o.label)).toEqual(['Single', 'Twin', 'Triple', 'Hexa', 'Dozen', 'Double Dozen']);
    const triple = await complete(token, 3);
    expect(triple).toMatchObject({ label: 'Triple', convertedAt: null, acquired: false, listing: null });
    expect(triple.conversionPrice).toEqual({ amountCents: 9000, currency: env.PAYMENTS_CURRENCY });
  });

  test('converting charges the conversion price once and makes the emblem an NFT', async () => {
    const { token, userId } = await member();
    const six = await complete(token, 6);
    const [a, b] = await Promise.all([convert(token, six.id, { poc: true }), convert(token, six.id)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const ok = a.status === 201 ? a : b;
    expect(ok.body.data.payment).toMatchObject({ purpose: 'conversion', amountCents: 18000, provider: 'demo' });
    expect(ok.body.data.series.convertedAt).toEqual(expect.any(String));
    expect((await db.payments.list(userId)).filter((p) => p.purpose === 'conversion')).toHaveLength(1);
  });

  test('singles and twins cannot be converted', async () => {
    const { token } = await member();
    const twin = await complete(token, 2);
    const res = await convert(token, twin.id);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_MINT_ELIGIBLE');
  });

  test('active needs the stone and a conversion within the window', async () => {
    const { token, userId } = await member();
    expect((await membership(token)).active).toMatchObject({ isActive: false, stoneOrdered: false, activeUntil: null });

    const triple = await complete(token, 3);
    await convert(token, triple.id);
    let status = await membership(token);
    // Converted, but no stone yet.
    expect(status.active).toMatchObject({ isActive: false, stoneOrdered: false, windowDays: env.ACTIVE_WINDOW_DAYS });
    expect(status.active.activeUntil).toEqual(expect.any(String));

    const ordered = await orderStone(token);
    expect(ordered.status).toBe(201);
    expect(ordered.body.data.payment).toMatchObject({
      purpose: 'stone',
      amountCents: env.PACKAGE_STONE_TRIPTYCH_CENTS + env.STONE_POSTAGE_CENTS,
    });
    // No package named (an app build from before packages): the first one.
    expect(ordered.body.data.order).toMatchObject({ city: 'Pune', addressLine2: '', package: 'stone_triptych' });
    expect(ordered.body.data.membership.active.isActive).toBe(true);
    expect((await orderStone(token)).body.error.code).toBe('STONE_ALREADY_ORDERED');

    // The window closes ACTIVE_WINDOW_DAYS after the last conversion.
    const membershipService = require('../src/modules/membership/membership.service');
    const user = await db.users.findById(userId);
    const later = new Date(Date.now() + (env.ACTIVE_WINDOW_DAYS + 1) * 24 * 60 * 60 * 1000);
    expect((await membershipService.activeStatus(user, later)).isActive).toBe(false);
  });

  test('the Sensitisation Package is the one package on sale, in euros', async () => {
    const { token } = await member();
    const { packages } = await membership(token);
    expect(packages).toHaveLength(1);
    expect(packages[0]).toMatchObject({
      id: 'stone_triptych',
      title: 'Sensitisation Package',
      subtitle: 'Initiation into the Papolona Method',
      totalCents: env.PACKAGE_STONE_TRIPTYCH_CENTS + env.STONE_POSTAGE_CENTS,
      currency: env.PACKAGE_CURRENCY,
    });
    expect(packages[0].includes).toHaveLength(4);
    // The old retreat package is no longer sold: the retreat is by application.
    expect((await orderStone(token, { ...ADDRESS, package: 'retreat' })).status).toBe(400);
    const ordered = await orderStone(token);
    expect(ordered.body.data.payment).toMatchObject({ currency: env.PACKAGE_CURRENCY });
  });

  test('members apply for the retreat once, without paying', async () => {
    const { token, userId } = await member();
    const before = (await membership(token)).retreat;
    expect(before).toMatchObject({
      days: env.RETREAT_DAYS,
      priceFromCents: env.RETREAT_PRICE_FROM_CENTS,
      priceToCents: env.RETREAT_PRICE_TO_CENTS,
      application: null,
    });
    const apply = (body) => api().post('/api/v1/membership/retreat').set(bearer(token)).send(body);
    expect((await apply({ motivation: 'Too short' })).status).toBe(400);
    const motivation = 'I would like a few quiet days to deepen my daily readings.';
    const applied = await apply({ motivation });
    expect(applied.status).toBe(201);
    expect(applied.body.data.application).toMatchObject({ motivation, status: 'pending' });
    expect(applied.body.data.membership.retreat.application.status).toBe('pending');
    // The team is emailed: the SMTP account unless RETREAT_APPLICATIONS_EMAIL is set.
    const { outbox } = require('../src/utils/mailer');
    const mail = outbox.find((m) => /^Retreat application/.test(m.subject));
    expect(mail.text).toContain(motivation);
    expect(mail.text).toContain('Asha Verma');
    expect((await apply({ motivation })).body.error.code).toBe('ALREADY_APPLIED');
    expect(await db.payments.list(userId)).toHaveLength(0);

    const { tokens } = await registerUser({ email: 'apprentice@example.test' });
    const res = await api().post('/api/v1/membership/retreat').set(bearer(tokens.accessToken)).send({ motivation });
    expect(res.body.error.code).toBe('MEMBERSHIP_REQUIRED');
  });

  test('apprentices cannot order the stone', async () => {
    const { tokens } = await registerUser();
    const res = await orderStone(tokens.accessToken);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('MEMBERSHIP_REQUIRED');
  });
});

describe('billing info', () => {
  const BILLING = {
    fullName: 'Asha Verma',
    email: 'billing@example.test',
    addressLine1: '12 MG Road',
    city: 'Pune',
    postcode: '411001',
    country: 'India',
  };
  const getBilling = async (token) => (await api().get('/api/v1/users/me/billing').set(bearer(token))).body.data;
  const putBilling = (token, body) => api().put('/api/v1/users/me/billing').set(bearer(token)).send(body);

  test('is saved once in Settings, suggested from the account until then', async () => {
    const { token } = await member();
    const before = await getBilling(token);
    expect(before.billing).toBeNull();
    expect(before.suggested.fullName).toBe('Asha Verma');

    expect((await putBilling(token, { ...BILLING, email: 'not-an-email' })).status).toBe(400);
    const saved = await putBilling(token, BILLING);
    expect(saved.status).toBe(200);
    expect(saved.body.data.billing).toMatchObject({ ...BILLING, phone: '', addressLine2: '' });
    const updated = await putBilling(token, { ...BILLING, city: 'Mumbai' });
    expect(updated.body.data.billing.city).toBe('Mumbai');
    expect((await getBilling(token)).billing.city).toBe('Mumbai');
  });

  test('each payment keeps the billing info it was paid with', async () => {
    const { token, userId } = await member();
    await putBilling(token, BILLING);
    const triple = await complete(token, 3);
    expect((await convert(token, triple.id)).status).toBe(201);
    await orderStone(token);
    const paid = await db.payments.list(userId);
    expect(paid.map((p) => p.purpose).sort()).toEqual(['conversion', 'stone']);
    for (const p of paid) expect(p.billing).toMatchObject({ fullName: 'Asha Verma', city: 'Pune' });
  });
});

describe('marketplace', () => {
  test('only active members sell, and only NFTs', async () => {
    const { token } = await member();
    const triple = await complete(token, 3);
    expect((await list(token, triple.id, 12000)).body.error.code).toBe('NOT_AN_NFT');
    await convert(token, triple.id);
    // Converted, but not active without the stone.
    expect((await list(token, triple.id, 12000)).body.error.code).toBe('ACTIVE_MEMBERSHIP_REQUIRED');
    await orderStone(token);
    expect((await list(token, triple.id, 50)).body.error.code).toBe('INVALID_PRICE');
    // Negotiable, but never below Papolona's suggested minimum for the level ($90 for a Triple).
    const cheap = await list(token, triple.id, 8999);
    expect(cheap.status).toBe(400);
    expect(cheap.body.error.code).toBe('BELOW_SUGGESTED_PRICE');
    expect(cheap.body.error.details).toMatchObject({ suggestedResalePrice: { amountCents: 9000 } });
    const listed = await list(token, triple.id, 12000);
    expect(listed.status).toBe(201);
    expect(listed.body.data.listing).toMatchObject({
      priceCents: 12000,
      status: 'active',
      mine: true,
      feeCents: 6000,
      sellerProceedsCents: 6000,
      seller: { name: 'Asha V.' },
    });
    expect((await list(token, triple.id, 15000)).body.error.code).toBe('ALREADY_LISTED');
    // The series carries its listing, and selling it put it on the collective artwork.
    const [own] = (await api().get('/api/v1/series').set(bearer(token))).body.data.series;
    expect(own.listing).toMatchObject({ priceCents: 12000 });
    expect(own.publishedAt).toEqual(expect.any(String));
    const wall = (await api().get('/api/v1/artwork/wall').set(bearer(token))).body.data;
    expect(wall.tiles.map((t) => t.id)).toEqual([triple.id]);
  });

  test('a series for sale stays public; once withdrawn it can be made private', async () => {
    const { token, nft } = await activeSeller();
    const listing = (await list(token, nft.id, 12000)).body.data.listing;
    const unpublish = () => api().delete(`/api/v1/series/${nft.id}/publish`).set(bearer(token));

    const refused = await unpublish();
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('LISTED_FOR_SALE');
    expect((await api().get('/api/v1/artwork/wall').set(bearer(token))).body.data.tiles).toHaveLength(1);

    await api().delete(`/api/v1/market/listings/${listing.id}`).set(bearer(token));
    // Withdrawing the sale leaves it public until the owner says otherwise.
    expect((await api().get('/api/v1/artwork/wall').set(bearer(token))).body.data.tiles).toHaveLength(1);
    expect((await unpublish()).body.data.series).toMatchObject({ publishedAt: null, listing: null });
    expect((await api().get('/api/v1/artwork/wall').set(bearer(token))).body.data.tiles).toEqual([]);
  });

  test('after the Collectors’ auction closes without bids, anyone can buy: the NFT moves to the buyer and the seller gets half', async () => {
    const seller = await activeSeller('Ada Lovelace');
    const listing = (await list(seller.token, seller.nft.id, 20000)).body.data.listing;

    // During the Collectors' auction an apprentice neither sees nor buys it.
    const apprentice = await registerUser({ name: 'Grace Hopper' });
    const token = apprentice.tokens.accessToken;
    expect((await api().get('/api/v1/market/listings').set(bearer(token))).body.data.listings).toEqual([]);
    expect((await api().get(`/api/v1/market/listings/${listing.id}`).set(bearer(token))).status).toBe(404);
    expect((await buy(token, listing.id)).body.error.code).toBe('IN_AUCTION');
    await db.testing.endAuction(listing.id);

    // Now open to all: the apprentice sees the listing, without the seller's split, and buys it.
    const market = (await api().get('/api/v1/market/listings').set(bearer(token))).body.data;
    expect(market.listings).toHaveLength(1);
    expect(market.listings[0].mine).toBe(false);
    expect(market.listings[0].sellerProceedsCents).toBeUndefined();
    expect(market.feePercent).toBe(50);

    expect((await buy(seller.token, listing.id)).body.error.code).toBe('OWN_LISTING');
    const bought = await buy(token, listing.id);
    expect(bought.status).toBe(201);
    expect(bought.body.data.payment).toMatchObject({ purpose: 'nft_purchase', amountCents: 20000 });
    expect(bought.body.data.series).toMatchObject({ id: seller.nft.id, acquired: true, listing: null });
    expect(bought.body.data.listing.status).toBe('sold');

    const sale = await db.market.findOffer(listing.id);
    expect(sale).toMatchObject({ buyerId: apprentice.user.id, feeCents: 10000, sellerProceedsCents: 10000 });

    // Now the buyer's, and gone from the seller and the marketplace.
    const buyerSeries = (await api().get('/api/v1/series').set(bearer(token))).body.data.series;
    expect(buyerSeries.map((s) => s.id)).toEqual([seller.nft.id]);
    const sellerSeries = (await api().get('/api/v1/series').set(bearer(seller.token))).body.data.series;
    expect(sellerSeries.map((s) => s.id)).not.toContain(seller.nft.id);

    // It is in the buyer's purchases, with the NFT and who sold it.
    const purchases = (await api().get('/api/v1/users/me/purchases').set(bearer(token))).body.data.purchases;
    expect(purchases).toHaveLength(1);
    expect(purchases[0]).toMatchObject({
      purpose: 'nft_purchase',
      amountCents: 20000,
      seller: 'Ada L.',
      series: { id: seller.nft.id, length: 3 },
    });
    expect(purchases[0].billing).toBeUndefined();
    // The seller's own purchases: the package and the conversion.
    const sellerPurchases = (await api().get('/api/v1/users/me/purchases').set(bearer(seller.token))).body.data
      .purchases;
    expect(sellerPurchases.map((p) => p.purpose).sort()).toEqual(['conversion', 'stone']);
    expect(sellerPurchases.find((p) => p.purpose === 'stone').packageId).toBe('stone_triptych');
    expect((await api().get('/api/v1/market/listings').set(bearer(token))).body.data.listings).toEqual([]);
    const mine = (await api().get('/api/v1/market/mine').set(bearer(seller.token))).body.data.listings;
    expect(mine[0]).toMatchObject({ status: 'sold', sellerProceedsCents: 10000, buyer: { name: 'Grace H.' } });
    // Still on the collective artwork, now under the buyer's name.
    const tile = (await api().get(`/api/v1/artwork/wall/${seller.nft.id}`).set(bearer(token))).body.data.tile;
    expect(tile.owner.id).toBe(apprentice.user.id);
    // Still credited to the member who completed it, and still in their public gallery.
    expect(tile.creator).toEqual({ id: seller.userId, name: 'Ada L.' });
    const made = (await api().get(`/api/v1/artwork/members/${seller.userId}`).set(bearer(token))).body.data;
    expect(made.tiles.map((t) => t.id)).toEqual([seller.nft.id]);
  });

  test('two buyers at once: one gets it, the other pays nothing', async () => {
    const seller = await activeSeller();
    const listing = (await list(seller.token, seller.nft.id, 9000)).body.data.listing;
    await db.testing.endAuction(listing.id);
    const a = await member('Buyer One');
    const b = await member('Buyer Two');
    const [x, y] = await Promise.all([buy(a.token, listing.id), buy(b.token, listing.id)]);
    expect([x.status, y.status].sort()).toEqual([201, 409]);
    const purchases = [
      ...(await db.payments.list(a.userId)),
      ...(await db.payments.list(b.userId)),
    ].filter((p) => p.purpose === 'nft_purchase');
    expect(purchases).toHaveLength(1);
  });

  test('a withdrawn listing cannot be bought', async () => {
    const seller = await activeSeller();
    const listing = (await list(seller.token, seller.nft.id, 9000)).body.data.listing;
    const other = await member('Someone Else');
    expect((await api().delete(`/api/v1/market/listings/${listing.id}`).set(bearer(other.token))).status).toBe(404);
    const withdrawn = await api().delete(`/api/v1/market/listings/${listing.id}`).set(bearer(seller.token));
    expect(withdrawn.body.data.listing.status).toBe('cancelled');
    expect((await buy(other.token, listing.id)).body.error.code).toBe('LISTING_CLOSED');
  });

  test('buying is refused while demo payments are off', async () => {
    const seller = await activeSeller();
    const listing = (await list(seller.token, seller.nft.id, 9000)).body.data.listing;
    await db.testing.endAuction(listing.id);
    env.DEMO_PAYMENTS = false;
    const buyer = await member('Buyer');
    expect((await buy(buyer.token, listing.id)).status).toBe(503);
  });
});

describe('Collectors’ auction', () => {
  const bid = (token, id, amountCents) =>
    api().post(`/api/v1/market/listings/${id}/bids`).set(bearer(token)).send({ amountCents });
  const getListing = async (token, id) =>
    (await api().get(`/api/v1/market/listings/${id}`).set(bearer(token))).body.data.listing;

  async function collector(name) {
    const { tokens, user } = await registerUser({ name });
    await db.users.promoteToMember(user.id, new Date(), 'collector');
    return { token: tokens.accessToken, userId: user.id };
  }

  test('a new listing is a Collectors’ auction for 30 days, seen by Collectors only', async () => {
    const seller = await activeSeller('Ada Lovelace');
    const listing = (await list(seller.token, seller.nft.id, 12000)).body.data.listing;
    const days = (new Date(listing.auction.collectorsUntil) - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);
    expect(listing.auction).toMatchObject({ phase: 'collectors', bidCount: 0, minNextBidCents: 12000, canBid: false });

    const c = await collector('Cora Collector');
    const market = (await api().get('/api/v1/market/listings').set(bearer(c.token))).body.data;
    expect(market.listings.map((l) => l.id)).toEqual([listing.id]);
    expect(market.listings[0].auction).toMatchObject({ phase: 'collectors', canBid: true, canBuy: false });
    expect(market.auctionDays).toBe(30);

    // An Explorer (or any non-Collector member) sees nothing yet and cannot bid.
    const explorer = await member('Ed Explorer');
    expect((await api().get('/api/v1/market/listings').set(bearer(explorer.token))).body.data.listings).toEqual([]);
    expect((await bid(explorer.token, listing.id, 12000)).body.error.code).toBe('COLLECTORS_ONLY');
    // The seller cannot bid on their own NFT, and nobody can buy it outright during the auction.
    expect((await bid(seller.token, listing.id, 12000)).body.error.code).toBe('OWN_LISTING');
    expect((await buy(c.token, listing.id)).body.error.code).toBe('IN_AUCTION');
  });

  test('each bid must beat the highest; the highest bidder wins when the auction closes', async () => {
    const seller = await activeSeller('Ada Lovelace');
    const listing = (await list(seller.token, seller.nft.id, 10000)).body.data.listing;
    const a = await collector('Cora Collector');
    const b = await collector('Bea Bidder');

    // The first bid starts at the starting price.
    const low = await bid(a.token, listing.id, 9999);
    expect(low.status).toBe(400);
    expect(low.body.error).toMatchObject({ code: 'BID_TOO_LOW', details: { minBidCents: 10000 } });
    const first = await bid(a.token, listing.id, 10000);
    expect(first.status).toBe(201);
    expect(first.body.data.listing.auction).toMatchObject({
      bidCount: 1,
      highestBidCents: 10000,
      highestBidMine: true,
      canBid: false,
      // 5% more, so $105.
      minNextBidCents: 10500,
    });
    // The highest bidder cannot outbid themselves; the next bid must be 5% higher.
    expect((await bid(a.token, listing.id, 20000)).body.error.code).toBe('ALREADY_HIGHEST');
    expect((await bid(b.token, listing.id, 10400)).body.error).toMatchObject({ details: { minBidCents: 10500 } });
    expect((await bid(b.token, listing.id, 15000)).status).toBe(201);
    expect((await getListing(a.token, listing.id)).auction).toMatchObject({ highestBidMine: false, canBid: true });
    // The seller sees who leads; with bids it can no longer be withdrawn.
    expect((await getListing(seller.token, listing.id)).auction).toMatchObject({
      bidCount: 2,
      highestBidCents: 15000,
      highestBidder: { name: 'Bea B.' },
    });
    const withdraw = await api().delete(`/api/v1/market/listings/${listing.id}`).set(bearer(seller.token));
    expect(withdraw.body.error.code).toBe('HAS_BIDS');

    // The auction closes: the next read settles it to the highest bidder at their bid.
    await db.testing.endAuction(listing.id);
    expect((await bid(a.token, listing.id, 20000)).body.error.code).toBe('AUCTION_ENDED');
    const settled = await getListing(seller.token, listing.id);
    expect(settled).toMatchObject({
      status: 'sold',
      priceCents: 15000,
      feeCents: 7500,
      sellerProceedsCents: 7500,
      buyer: { id: b.userId, name: 'Bea B.' },
    });
    const purchases = await db.payments.list(b.userId);
    expect(purchases.filter((p) => p.purpose === 'nft_purchase').map((p) => p.amountCents)).toEqual([15000]);
    expect((await db.payments.list(a.userId)).filter((p) => p.purpose === 'nft_purchase')).toEqual([]);
    const won = (await api().get('/api/v1/series').set(bearer(b.token))).body.data.series;
    expect(won.map((s) => s.id)).toEqual([seller.nft.id]);
    // Both sides were told.
    const { outbox } = require('../src/utils/mailer');
    expect(outbox.some((m) => m.subject === 'You won a Papolona auction')).toBe(true);
    expect(outbox.some((m) => m.subject === 'Your NFT has sold at auction')).toBe(true);
  });

  test('the dispatcher settles closed auctions on its own', async () => {
    const seller = await activeSeller();
    const listing = (await list(seller.token, seller.nft.id, 9000)).body.data.listing;
    const c = await collector('Cora Collector');
    await bid(c.token, listing.id, 9000);
    const { dispatchDue } = require('../src/modules/reminders/reminders.service');
    expect((await dispatchDue()).auctions).toBe(0);
    await db.testing.endAuction(listing.id);
    expect((await dispatchDue()).auctions).toBe(1);
    expect((await db.market.findOffer(listing.id)).status).toBe('sold');
  });

  test('without bids it stays for sale and opens to everyone at the starting price', async () => {
    const seller = await activeSeller();
    const listing = (await list(seller.token, seller.nft.id, 9000)).body.data.listing;
    await db.testing.endAuction(listing.id);
    const { dispatchDue } = require('../src/modules/reminders/reminders.service');
    expect((await dispatchDue()).auctions).toBe(0);
    const anyone = await registerUser({ name: 'Grace Hopper' });
    const open = await getListing(anyone.tokens.accessToken, listing.id);
    expect(open).toMatchObject({ status: 'active', priceCents: 9000 });
    expect(open.auction).toMatchObject({ phase: 'open', canBuy: true, canBid: false });
    // Collectors can no longer bid; anyone buys it outright.
    const c = await collector('Cora Collector');
    expect((await bid(c.token, listing.id, 20000)).body.error.code).toBe('AUCTION_ENDED');
    expect((await buy(anyone.tokens.accessToken, listing.id)).status).toBe(201);
  });

  test('two Collectors bidding the same amount at once: only one bid is taken', async () => {
    const seller = await activeSeller();
    const listing = (await list(seller.token, seller.nft.id, 9000)).body.data.listing;
    const a = await collector('Cora Collector');
    const b = await collector('Bea Bidder');
    const [x, y] = await Promise.all([bid(a.token, listing.id, 9000), bid(b.token, listing.id, 9000)]);
    expect([x.status, y.status].sort()).toEqual([201, 400]);
    expect((await getListing(a.token, listing.id)).auction.bidCount).toBe(1);
  });
});

describe('active membership reminder', () => {
  test('emails a member once, a week before their window closes', async () => {
    const seller = await activeSeller();
    const windowMs = env.ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const nearEnd = new Date(Date.now() + windowMs - 3 * 24 * 60 * 60 * 1000);
    const week = 7 * 24 * 60 * 60 * 1000;
    const first = await db.market.activeReminderCandidates(nearEnd, new Date(nearEnd.getTime() + week), windowMs);
    expect(first.map((u) => u.id)).toEqual([seller.userId]);
    await db.market.markActiveReminder(seller.userId, first[0].activeUntil);
    expect(await db.market.activeReminderCandidates(nearEnd, new Date(nearEnd.getTime() + week), windowMs)).toEqual([]);
  });
});
