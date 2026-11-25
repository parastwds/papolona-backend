const env = require('../src/config/env');
const db = require('../src/db');
const storage = require('../src/utils/storage');
const { qrng } = require('../src/modules/clue/clue.service');
const { setupDB, resetData, teardownDB, api, registerUser, bearer, PASSWORD } = require('./helpers');

beforeAll(() => setupDB('journal'));
beforeEach(resetData);
afterAll(teardownDB);

const realFetch = qrng.fetchHexStrings;
beforeEach(() => {
  env.QRNG_API_KEY = 'test-key';
  qrng.fetchHexStrings = async () => ['48656c6c6f2021', '576f726c64']; // HELLOW
});
afterEach(() => {
  qrng.fetchHexStrings = realFetch;
  env.QRNG_API_KEY = undefined;
});

let n = 0;
const entry = (overrides = {}) => ({ text: 'A red door again.', source: 'text', clientId: `client-${Date.now()}-${n++}`, ...overrides });
const write = (token, body = entry()) => api().post('/api/v1/journal').set(bearer(token)).send(body);
const list = (token, query = '') => api().get(`/api/v1/journal${query}`).set(bearer(token));
// Marks a draw as judged, so the next clue can be drawn.
const judged = (userId, drawId) =>
  db.clueDraws.saveJudgement(userId, drawId, {
    attempt: 1,
    text: 'HELL-OW interpretation',
    source: 'text',
    verdict: 'pass',
    parts: [],
    feedback: 'F',
    model: 'test',
    judgedAt: new Date(),
  });
const drawClue = (token) => api().post('/api/v1/clue-string').set(bearer(token)).send({ question: 'Where does the red door lead?' });

describe('POST /journal', () => {
  test('requires a signed-in user', async () => {
    expect((await api().post('/api/v1/journal').send(entry())).status).toBe(401);
  });

  test('saves a written or spoken entry as open', async () => {
    const { tokens } = await registerUser();
    const res = await write(tokens.accessToken, entry({ source: 'voice', text: '  spoken words  ' }));
    expect(res.status).toBe(201);
    expect(res.body.data.entry).toMatchObject({ text: 'spoken words', source: 'voice', clue: null, photos: [] });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  test('rejects empty text and unknown sources', async () => {
    const { tokens } = await registerUser();
    expect((await write(tokens.accessToken, entry({ text: '   ' }))).status).toBe(400);
    expect((await write(tokens.accessToken, entry({ source: 'audio' }))).status).toBe(400);
    const noText = await write(tokens.accessToken, entry({ text: undefined }));
    expect(noText.body.error.details).toEqual([{ field: 'text', message: 'Write or say something first.' }]);
  });

  test('accepts long writing up to 50,000 characters', async () => {
    const { tokens } = await registerUser();
    const long = 'ॐ'.repeat(50000); // 3 bytes each in UTF-8: well over the default 100 kB body limit
    const res = await write(tokens.accessToken, entry({ text: long }));
    expect(res.status).toBe(201);
    expect(res.body.data.entry.text).toHaveLength(50000);
    expect((await write(tokens.accessToken, entry({ text: `${long}x` }))).status).toBe(400);
  });

  test('the same clientId twice returns the first entry', async () => {
    const { tokens } = await registerUser();
    const body = entry();
    const first = await write(tokens.accessToken, body);
    const retry = await write(tokens.accessToken, { ...body, text: 'changed' });
    expect(retry.status).toBe(200);
    expect(retry.body.data.entry.id).toBe(first.body.data.entry.id);
    expect(await db.testing.countJournalEntries()).toBe(1);
  });
});

describe('journal and clue', () => {
  test('drawing a clue seals open entries; the journal stays open', async () => {
    const { tokens } = await registerUser();
    await write(tokens.accessToken);
    await write(tokens.accessToken, entry({ source: 'voice' }));
    expect((await drawClue(tokens.accessToken)).status).toBe(201);

    const { entries } = (await list(tokens.accessToken)).body.data;
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.clue?.clue === 'HELLOW')).toBe(true);

    expect((await write(tokens.accessToken)).status).toBe(201);
  });

  test('entries written before a draw are sealed to it', async () => {
    const { tokens } = await registerUser();
    await write(tokens.accessToken);
    expect((await drawClue(tokens.accessToken)).status).toBe(201);

    expect((await list(tokens.accessToken)).body.data.entries[0].clue.clue).toBe('HELLOW');
    // Already sealed, so "clear all" leaves it.
    expect((await api().delete('/api/v1/journal').set(bearer(tokens.accessToken))).body.data.deleted).toBe(0);
  });

  test('entries after a draw seal to the next one', async () => {
    const { tokens, user } = await registerUser();
    await write(tokens.accessToken);
    const first = (await drawClue(tokens.accessToken)).body.data;
    await judged(user.id, first.id);

    expect((await write(tokens.accessToken)).status).toBe(201);
    qrng.fetchHexStrings = async () => ['414243444546']; // ABCDEF
    await drawClue(tokens.accessToken);

    const clues = (await list(tokens.accessToken)).body.data.entries.map((e) => e.clue.clue);
    expect(clues).toEqual(['ABCDEF', 'HELLOW']);
  });

  test('a failed draw leaves entries open and the journal unlocked', async () => {
    qrng.fetchHexStrings = async () => ['0102'];
    const { tokens } = await registerUser();
    await write(tokens.accessToken);
    expect((await drawClue(tokens.accessToken)).status).toBe(502);

    expect((await list(tokens.accessToken)).body.data.entries[0].clue).toBeNull();
    expect((await write(tokens.accessToken)).status).toBe(201);
  });

  test('entries after a draw stay open for the next one', async () => {
    const { tokens } = await registerUser();
    await write(tokens.accessToken);
    await drawClue(tokens.accessToken);
    const res = await write(tokens.accessToken);
    expect(res.status).toBe(201);
    expect(res.body.data.entry.clue).toBeNull();
  });
});

describe('GET /journal', () => {
  test('pages newest first and only shows your own entries', async () => {
    const { tokens } = await registerUser();
    const other = await registerUser();
    for (let i = 0; i < 5; i += 1) await write(tokens.accessToken, entry({ text: `entry ${i}` }));
    await write(other.tokens.accessToken);

    const first = (await list(tokens.accessToken, '?limit=3')).body.data;
    expect(first.entries.map((e) => e.text)).toEqual(['entry 4', 'entry 3', 'entry 2']);
    const second = (await list(tokens.accessToken, `?limit=3&before=${first.nextCursor}`)).body.data;
    expect(second.entries.map((e) => e.text)).toEqual(['entry 1', 'entry 0']);
    expect(second.nextCursor).toBeNull();
  });
});

describe('deleting', () => {
  test('one entry, open or sealed; never another user\'s', async () => {
    const { tokens } = await registerUser();
    const other = await registerUser();
    const id = (await write(tokens.accessToken)).body.data.entry.id;
    await drawClue(tokens.accessToken);

    const foreign = await api().delete(`/api/v1/journal/${id}`).set(bearer(other.tokens.accessToken));
    expect(foreign.status).toBe(404);
    const own = await api().delete(`/api/v1/journal/${id}`).set(bearer(tokens.accessToken));
    expect(own.status).toBe(200);
    expect(await db.testing.countJournalEntries()).toBe(0);
  });

  test('clear all removes open entries and keeps sealed ones', async () => {
    const { tokens } = await registerUser();
    await write(tokens.accessToken);
    await drawClue(tokens.accessToken);
    await write(tokens.accessToken);

    const res = await api().delete('/api/v1/journal').set(bearer(tokens.accessToken));
    expect(res.body.data.deleted).toBe(1);
    expect((await list(tokens.accessToken)).body.data.entries).toHaveLength(1);
  });

  test('deleting the account deletes the journal', async () => {
    const { tokens } = await registerUser();
    await write(tokens.accessToken);
    await api().delete('/api/v1/users/me').set(bearer(tokens.accessToken)).send({ password: PASSWORD });
    expect(await db.testing.countJournalEntries()).toBe(0);
  });
});

describe('photos', () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
  const upload = (token, field = 'photo', file = PNG) =>
    api().post('/api/v1/journal/photos').set(bearer(token)).attach(field, file, 'photo.png');
  const attachable = ({ publicId, width, height }) => ({ publicId, width, height });

  test("upload goes to the user's own folder", async () => {
    const { tokens, user } = await registerUser();
    expect((await api().post('/api/v1/journal/photos').attach('photo', PNG, 'p.png')).status).toBe(401);

    const res = await upload(tokens.accessToken);
    expect(res.status).toBe(201);
    const { photo } = res.body.data;
    expect(photo.publicId.startsWith(`papolona/journal/${user.id}/`)).toBe(true);
    expect(photo).toEqual({ publicId: photo.publicId, url: expect.stringMatching(/^https:\/\//), width: 1200, height: 900 });
    expect(storage.uploads.has(photo.publicId)).toBe(true);
  });

  test('rejects non-images, the wrong field and big files', async () => {
    const { tokens } = await registerUser();
    const text = await upload(tokens.accessToken, 'photo', Buffer.from('not an image'));
    expect(text.body.error.code).toBe('UNSUPPORTED_FILE_TYPE');
    expect((await upload(tokens.accessToken, 'avatar')).body.error.code).toBe('INVALID_UPLOAD');
    const big = await upload(tokens.accessToken, 'photo', Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]));
    expect(big.status).toBe(413);
  });

  test('an entry can be photos alone; the server builds the URLs', async () => {
    const { tokens } = await registerUser();
    const photo = (await upload(tokens.accessToken)).body.data.photo;
    const sent = { ...attachable(photo), url: 'https://evil.example/x.png' };
    const res = await write(tokens.accessToken, entry({ text: '  ', photos: [sent] }));
    expect(res.status).toBe(201);
    expect(res.body.data.entry).toMatchObject({ text: '', photos: [photo] });
    expect((await list(tokens.accessToken)).body.data.entries[0].photos).toEqual([photo]);
  });

  test("refuses another user's photo, odd ids and more than six", async () => {
    const { tokens } = await registerUser();
    const other = await registerUser();
    const foreign = (await upload(other.tokens.accessToken)).body.data.photo;
    const own = (await upload(tokens.accessToken)).body.data.photo;

    const stolen = await write(tokens.accessToken, entry({ photos: [attachable(foreign)] }));
    expect(stolen.status).toBe(400);
    expect(stolen.body.error.code).toBe('INVALID_PHOTO');
    const nested = { ...attachable(own), publicId: `${own.publicId}/../x` };
    expect((await write(tokens.accessToken, entry({ photos: [nested] }))).body.error.code).toBe('INVALID_PHOTO');
    const seven = await write(tokens.accessToken, entry({ photos: Array(7).fill(attachable(own)) }));
    expect(seven.body.error.code).toBe('VALIDATION_ERROR');
    expect(await db.testing.countJournalEntries()).toBe(0);
  });

  test('deleting an entry, clearing all or deleting the account removes its photos', async () => {
    const { tokens } = await registerUser();
    const add = async () => {
      const photo = (await upload(tokens.accessToken)).body.data.photo;
      const id = (await write(tokens.accessToken, entry({ photos: [attachable(photo)] }))).body.data.entry.id;
      return { id, publicId: photo.publicId };
    };

    const one = await add();
    await api().delete(`/api/v1/journal/${one.id}`).set(bearer(tokens.accessToken));
    expect(storage.uploads.has(one.publicId)).toBe(false);

    const open = await add();
    expect((await api().delete('/api/v1/journal').set(bearer(tokens.accessToken))).body.data.deleted).toBe(1);
    expect(storage.uploads.has(open.publicId)).toBe(false);

    const kept = await add();
    expect(storage.uploads.has(kept.publicId)).toBe(true);
    await api().delete('/api/v1/users/me').set(bearer(tokens.accessToken)).send({ password: PASSWORD });
    expect(storage.uploads.has(kept.publicId)).toBe(false);
  });
});

describe('GET /journal/calendar', () => {
  const calendar = (token, from, to) => api().get('/api/v1/journal/calendar').query({ from, to }).set(bearer(token));
  const hoursAgo = (h) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();

  test('validates the range', async () => {
    const { tokens } = await registerUser();
    const from = '2026-11-01T00:00:00+05:30';
    expect((await calendar(tokens.accessToken, from, from)).status).toBe(400);
    expect((await calendar(tokens.accessToken, from, '2026-10-01T00:00:00+05:30')).status).toBe(400);
    expect((await calendar(tokens.accessToken, from, '2026-12-16T00:00:01+05:30')).status).toBe(400); // just over 45 days
    expect((await calendar(tokens.accessToken, 'yesterday', '2026-11-02T00:00:00Z')).status).toBe(400);
    expect((await calendar(tokens.accessToken, from, '2026-12-16T00:00:00+05:30')).status).toBe(200); // 45 days
  });

  test('lists when you wrote and drew clues in [from, to), only your own', async () => {
    const { tokens } = await registerUser();
    const other = await registerUser();
    await write(tokens.accessToken);
    await write(tokens.accessToken);
    await drawClue(tokens.accessToken);
    await write(other.tokens.accessToken);
    await drawClue(other.tokens.accessToken);

    const res = await calendar(tokens.accessToken, hoursAgo(1), hoursAgo(-1));
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data.entries).toHaveLength(2);
    expect(res.body.data.readings).toHaveLength(1);
    expect(new Date(res.body.data.readings[0]).toISOString()).toBe(res.body.data.readings[0]);

    expect((await calendar(tokens.accessToken, hoursAgo(2), hoursAgo(1))).body.data).toEqual({ entries: [], readings: [] });
  });
});
