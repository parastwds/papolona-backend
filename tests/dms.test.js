const { setupDB, resetData, teardownDB, api, registerUser, bearer } = require('./helpers');

beforeAll(() => setupDB('dms'));
beforeEach(resetData);
afterAll(teardownDB);

async function person(name) {
  const { tokens, user } = await registerUser({ name });
  return { token: tokens.accessToken, id: user.id };
}

const get = (p, path) => api().get(`/api/v1/dms${path}`).set(bearer(p.token));
const post = (p, path, body = {}) => api().post(`/api/v1/dms${path}`).set(bearer(p.token)).send(body);
const del = (p, path) => api().delete(`/api/v1/dms${path}`).set(bearer(p.token));
const request = (from, to, text = 'Hello, I liked your series.') => post(from, '/requests', { userId: to.id, text });

describe('direct messages', () => {
  test('requires a signed-in user', async () => {
    expect((await api().get('/api/v1/dms')).status).toBe(401);
  });

  test('search finds members by name, not yourself, with where you stand', async () => {
    const ada = await person('Ada Lovelace');
    const grace = await person('Grace Hopper');
    await person('Alan Turing');

    expect((await get(ada, '/search?q=a')).body.data.users).toEqual([]); // too short
    const found = (await get(ada, '/search?q=gra')).body.data.users;
    expect(found).toEqual([{ id: grace.id, name: 'Grace H.', avatarUrl: null, state: 'none', threadId: null }]);
    expect((await get(ada, '/search?q=ada')).body.data.users).toEqual([]);
    // Wildcards are taken literally.
    expect((await get(ada, '/search?q=%25%25')).body.data.users).toEqual([]);

    const sent = (await request(ada, grace)).body.data.thread;
    expect((await get(ada, '/search?q=grace')).body.data.users[0]).toMatchObject({ state: 'requested', threadId: sent.id });
    expect((await get(grace, '/search?q=ada')).body.data.users[0]).toMatchObject({ state: 'incoming', threadId: sent.id });
  });

  test('a request waits for acceptance; then both can talk and unread counts follow', async () => {
    const ada = await person('Ada Lovelace');
    const grace = await person('Grace Hopper');

    const res = await request(ada, grace);
    expect(res.status).toBe(201);
    const thread = res.body.data.thread;
    expect(thread).toMatchObject({ state: 'requested', other: { id: grace.id, name: 'Grace H.' }, canSend: false });

    // The sender waits; asking again or writing more is refused.
    expect((await request(ada, grace)).body.error.code).toBe('REQUEST_PENDING');
    expect((await post(ada, `/${thread.id}/messages`, { text: 'Anyone there?' })).body.error.code).toBe('REQUEST_PENDING');
    expect((await request(grace, ada)).body.error).toMatchObject({ code: 'REQUEST_INCOMING', details: { threadId: thread.id } });

    const inbox = (await get(grace, '')).body.data;
    expect(inbox.requests).toHaveLength(1);
    expect(inbox.requests[0]).toMatchObject({
      state: 'incoming',
      other: { name: 'Ada L.' },
      lastMessage: { text: 'Hello, I liked your series.', mine: false },
    });
    expect(inbox.unreadCount).toBe(1);
    expect((await get(ada, '')).body.data.sent).toHaveLength(1);

    // Only the recipient can accept.
    expect((await post(ada, `/${thread.id}/accept`)).status).toBe(404);
    const accepted = await post(grace, `/${thread.id}/accept`);
    expect(accepted.body.data.thread).toMatchObject({ state: 'connected', canSend: true });

    expect((await post(grace, `/${thread.id}/messages`, { text: 'Thank you!' })).status).toBe(201);
    expect((await post(ada, `/${thread.id}/messages`, { text: '  ' })).status).toBe(400);
    await post(ada, `/${thread.id}/messages`, { text: 'Shall we compare readings?' });

    const graceInbox = (await get(grace, '')).body.data;
    expect(graceInbox.conversations[0]).toMatchObject({ unread: 1, lastMessage: { text: 'Shall we compare readings?' } });
    const opened = (await get(grace, `/${thread.id}`)).body.data;
    expect(opened.messages.map((m) => [m.text, m.mine])).toEqual([
      ['Shall we compare readings?', false],
      ['Thank you!', true],
      ['Hello, I liked your series.', false],
    ]);
    expect((await get(grace, '')).body.data.unreadCount).toBe(0);

    // Strangers cannot read it.
    const eve = await person('Eve Stranger');
    expect((await get(eve, `/${thread.id}`)).status).toBe(404);
    expect((await post(eve, `/${thread.id}/messages`, { text: 'Hi' })).status).toBe(404);
  });

  test('a declined request stays sent for its sender; the decliner can write later', async () => {
    const ada = await person('Ada Lovelace');
    const grace = await person('Grace Hopper');
    const thread = (await request(ada, grace)).body.data.thread;
    expect((await post(grace, `/${thread.id}/decline`)).status).toBe(200);

    expect((await get(grace, '')).body.data.requests).toEqual([]);
    expect((await get(grace, `/${thread.id}`)).status).toBe(404);
    expect((await get(ada, '')).body.data.sent).toHaveLength(1);
    expect((await request(ada, grace)).body.error.code).toBe('REQUEST_PENDING');

    const back = await request(grace, ada, 'Sorry, I was busy. Hello!');
    expect(back.status).toBe(201);
    expect(back.body.data.thread).toMatchObject({ id: thread.id, state: 'requested' });
    expect((await get(ada, '')).body.data.requests).toHaveLength(1);
  });

  test('blocking stops messages both ways, hides from search, and can be undone', async () => {
    const ada = await person('Ada Lovelace');
    const grace = await person('Grace Hopper');
    const thread = (await request(ada, grace)).body.data.thread;
    await post(grace, `/${thread.id}/accept`);

    expect((await post(grace, '/blocks', { userId: grace.id })).status).toBe(400);
    expect((await post(grace, '/blocks', { userId: ada.id })).status).toBe(201);
    expect((await get(grace, '/blocks')).body.data.users).toEqual([
      { id: ada.id, name: 'Ada L.', avatarUrl: null, blockedAt: expect.any(String) },
    ]);
    expect((await post(ada, `/${thread.id}/messages`, { text: 'Hello?' })).body.error.code).toBe('CANNOT_MESSAGE');
    expect((await post(grace, `/${thread.id}/messages`, { text: 'Hi' })).body.error.code).toBe('YOU_BLOCKED');
    expect((await get(grace, '')).body.data.conversations[0]).toMatchObject({ blocked: 'by_me', canSend: false });
    expect((await get(ada, '')).body.data.conversations[0]).toMatchObject({ blocked: 'by_them', canSend: false });
    expect((await get(ada, '/search?q=grace')).body.data.users).toEqual([]);
    expect((await get(grace, '/search?q=ada')).body.data.users).toEqual([]);

    expect((await del(grace, `/blocks/${ada.id}`)).status).toBe(200);
    expect((await post(ada, `/${thread.id}/messages`, { text: 'Hello again' })).status).toBe(201);
  });

  test('blocking someone declines their waiting request and stops new ones', async () => {
    const ada = await person('Ada Lovelace');
    const grace = await person('Grace Hopper');
    await request(ada, grace);
    await post(grace, '/blocks', { userId: ada.id });
    expect((await get(grace, '')).body.data.requests).toEqual([]);

    const eve = await person('Eve Stranger');
    await post(eve, '/blocks', { userId: ada.id });
    expect((await request(ada, eve)).body.error.code).toBe('CANNOT_MESSAGE');
    expect((await request(eve, ada)).body.error.code).toBe('YOU_BLOCKED');
    expect((await request(ada, ada)).body.error.code).toBe('CANNOT_MESSAGE_SELF');
  });
});
