import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanShortcutName, emptyState, localDate, pushToBackloggd, recordLiveGame, recordPlaytime } from '../lib/sync.mjs';
import { AuthError, BackloggdClient, SESSION_NOTE } from '../lib/backloggd.mjs';

const tz = 'America/Toronto';
const at = (iso) => new Date(iso);

test('first run only takes a snapshot', () => {
    const { state, gained } = recordPlaytime(emptyState(), [{ appid: 1, name: 'Hades', playtime: 600, lastPlayed: 0 }], { now: at('2026-10-13T16:00:00Z'), timeZone: tz });
    assert.deepEqual(gained, []);
    assert.deepEqual(state.snapshot, { 1: 600 });
});

test('playtime deltas accumulate per game per local day', () => {
    let s = emptyState();
    s.snapshot = { 1: 600, 2: 50 };
    const now = at('2026-10-13T16:00:00Z');
    s = recordPlaytime(s, [{ appid: 1, name: 'Hades', playtime: 630 }, { appid: 2, name: 'Celeste', playtime: 50 }], { now, timeZone: tz }).state;
    s = recordPlaytime(s, [{ appid: 1, name: 'Hades', playtime: 645 }, { appid: 2, name: 'Celeste', playtime: 50 }], { now, timeZone: tz }).state;
    assert.deepEqual(Object.keys(s.days), ['1|2026-10-13']);
    assert.equal(s.days['1|2026-10-13'].minutes, 45);
});

test('local date follows the configured time zone, not UTC', () => {
    // 02:00 UTC is still the previous evening in Montréal.
    assert.equal(localDate(at('2026-10-14T02:00:00Z'), tz), '2026-10-13');
});

test('a newly owned game only counts if played in the last day', () => {
    const s = emptyState();
    s.snapshot = {};
    const now = at('2026-10-13T16:00:00Z');
    const games = [
        { appid: 3, name: 'Old', playtime: 900, lastPlayed: now.getTime() / 1000 - 30 * 86400 },
        { appid: 4, name: 'New', playtime: 20, lastPlayed: now.getTime() / 1000 - 600 },
    ];
    const { gained } = recordPlaytime(s, games, { now, timeZone: tz });
    assert.deepEqual(gained.map((g) => g.appid), [4]);
});

test('ambiguous titles are left unmapped instead of guessed', async () => {
    const s = emptyState();
    s.days['5|2026-10-13'] = { appid: 5, name: 'Doom', date: '2026-10-13', minutes: 30, synced: false };
    const fake = {
        autocomplete: async () => [{ id: 1, slug: 'doom', title: 'Doom' }, { id: 2, slug: 'doom--1', title: 'Doom' }],
        upsertDailySession: async () => assert.fail('should not write'),
    };
    await pushToBackloggd(s, fake);
    assert.equal(s.days['5|2026-10-13'].synced, false);
    assert.equal(s.unmapped[5].candidates.length, 2);
});

test('auth errors stop the run and keep days pending', async () => {
    const s = emptyState();
    s.mappings[1] = { id: 9, slug: 'hades' };
    s.days['1|2026-10-13'] = { appid: 1, name: 'Hades', date: '2026-10-13', minutes: 30, synced: false };
    const fake = { upsertDailySession: async () => { throw new AuthError('expired'); } };
    await assert.rejects(pushToBackloggd(s, fake), AuthError);
    assert.equal(s.days['1|2026-10-13'].synced, false);
});

/** A stand-in for backloggd.com that records what the client posts. */
function fakeSite(playthroughs) {
    const posts = [];
    const fetchImpl = async (url, init) => {
        const u = new URL(url);
        const html = (body) => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
        if (u.pathname === '/') return html('<meta name="csrf-token" content="tok">');
        if (u.pathname === '/settings/') return html('<a href="/users/sign_out"></a><script>user_id="42"</script>');
        if (u.pathname.startsWith('/log/edit/')) {
            return Response.json({ game_log: { id: 7, is_playing: true, status: 'played' }, playthroughs });
        }
        if (u.pathname === '/api/user/42/log/99') {
            assert.equal(init.headers['X-CSRF-Token'], 'tok');
            posts.push(Object.fromEntries(new URLSearchParams(init.body)));
            return new Response('{}', { status: 200 });
        }
        return new Response('not found', { status: 404 });
    };
    return { posts, client: new BackloggdClient({ sessionCookie: 'abc', fetchImpl }) };
}

test('adds a new Steam session while re-sending existing ones', async () => {
    const existing = { id: 11, range_start_date: '2026-10-01', range_end_date: '2026-10-02', hours: 1, minutes: 0, note: 'manual' };
    const { posts, client } = fakeSite([{ id: 500, title: 'Log', play_dates: [existing] }]);
    client.lastWrite = -Infinity;
    await client.upsertDailySession({ gameId: 99, date: '2026-10-13', minutes: 95 });

    assert.equal(posts.length, 1);
    const f = posts[0];
    assert.equal(f['playthroughs[0][id]'], '500');
    assert.equal(f['dates[500][0][id]'], '11');
    assert.equal(f['dates[500][0][note]'], 'manual');
    assert.equal(f['dates[500][1][id]'], '-1');
    assert.equal(f['dates[500][1][range_start_date]'], '2026-10-13');
    assert.equal(f['dates[500][1][range_end_date]'], '2026-10-14');
    assert.equal(f['dates[500][1][hours]'], '1');
    assert.equal(f['dates[500][1][minutes]'], '35');
    assert.equal(f['dates[500][1][note]'], SESSION_NOTE);
    assert.equal(f['log[is_playing]'], 'true');
});

test('rewrites its own session for the day and skips when unchanged', async () => {
    const mine = { id: 12, range_start_date: '2026-10-13', range_end_date: '2026-10-14', hours: 1, minutes: 35, note: SESSION_NOTE };
    const { posts, client } = fakeSite([{ id: 500, play_dates: [mine] }]);

    assert.deepEqual(await client.upsertDailySession({ gameId: 99, date: '2026-10-13', minutes: 95 }), { changed: false });
    assert.equal(posts.length, 0);

    client.lastWrite = -Infinity;
    await client.upsertDailySession({ gameId: 99, date: '2026-10-13', minutes: 120 });
    assert.equal(posts[0]['dates[500][0][id]'], '12');
    assert.equal(posts[0]['dates[500][0][hours]'], '2');
    assert.equal(posts[0]['dates[500][0][minutes]'], '0');
    assert.equal(posts[0]['dates[500][1][id]'], undefined);
});

test('a running non-Steam shortcut is credited the time since the last poll', () => {
    let s = emptyState();
    s.snapshot = { 1: 600 };
    s.lastPoll = '2026-10-13T16:00:00Z';
    const now = at('2026-10-13T16:05:00Z');
    s = recordLiveGame(s, { gameId: '15374772738578399232', name: 'Chrono Trigger (USA)' }, { now, timeZone: tz }).state;
    assert.equal(s.days['ns:Chrono Trigger|2026-10-13'].minutes, 5);
    assert.equal(s.days['ns:Chrono Trigger|2026-10-13'].name, 'Chrono Trigger');
    assert.equal(s.lastPoll, now.toISOString());
});

test('owned Steam games are left to the exact playtime counter', () => {
    const s = emptyState();
    s.snapshot = { 1145360: 600 };
    s.lastPoll = '2026-10-13T16:00:00Z';
    const { gained } = recordLiveGame(s, { gameId: '1145360', name: 'Hades' }, { now: at('2026-10-13T16:05:00Z'), timeZone: tz });
    assert.deepEqual(gained, []);
});

test('a long gap between polls is capped instead of counted as play', () => {
    const s = emptyState();
    s.snapshot = {};
    s.lastPoll = '2026-10-13T10:00:00Z';
    const { gained } = recordLiveGame(s, { gameId: '1', name: 'Zelda' }, { now: at('2026-10-13T16:00:00Z'), timeZone: tz });
    assert.equal(gained[0].minutes, 10);
});

test('fractional minutes are rounded and tiny totals wait for more play', async () => {
    const s = emptyState();
    s.mappings['ns:Zelda'] = { id: 9, slug: 'zelda' };
    s.days['ns:Zelda|2026-10-13'] = { appid: 'ns:Zelda', name: 'Zelda', date: '2026-10-13', minutes: 0.4, synced: false };
    s.days['ns:Zelda|2026-10-12'] = { appid: 'ns:Zelda', name: 'Zelda', date: '2026-10-12', minutes: 12.6, synced: false };
    const calls = [];
    await pushToBackloggd(s, { upsertDailySession: async (a) => calls.push(a) });
    assert.deepEqual(calls, [{ gameId: 9, date: '2026-10-12', minutes: 13 }]);
    assert.equal(s.days['ns:Zelda|2026-10-13'].synced, false);
});

test('shortcut names lose region and revision tags', () => {
    assert.equal(cleanShortcutName('Pokemon - Emerald Version (USA, Europe) [!]'), 'Pokemon - Emerald Version');
});
