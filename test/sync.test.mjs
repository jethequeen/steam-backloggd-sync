import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendLog, cleanShortcutName, emptyState, fillCovers, forAccount, seedHistory, deleteGame, deleteSession, restoreGame, markFinishedGames, recordReportedPlay, localDate, pushToBackloggd, recordLiveGame, recordPlaytime, reopenChoice, resolveGame } from '../lib/sync.mjs';
import { AuthError, BackloggdClient, LEGACY_SESSION_NOTE } from '../lib/backloggd.mjs';

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
function fakeSite(playthroughs, log = { id: 7, is_playing: true, status: 'played' }) {
    const posts = [];
    const fetchImpl = async (url, init) => {
        const u = new URL(url);
        const html = (body) => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
        if (u.pathname === '/') return html('<meta name="csrf-token" content="tok">');
        if (u.pathname === '/settings/') return html('<a href="/users/sign_out"></a><script>user_id="42"</script>');
        if (u.pathname.startsWith('/log/edit/')) {
            return Response.json({ game_log: log, playthroughs });
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

test('adds a new session without a note while re-sending existing ones', async () => {
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
    assert.equal(f['dates[500][1][note]'], '');
    assert.equal(f['log[is_playing]'], 'true');
});

test('rewrites its own session for the day and skips when unchanged', async () => {
    const mine = { id: 12, range_start_date: '2026-10-13', range_end_date: '2026-10-14', hours: 1, minutes: 35, note: null };
    const { posts, client } = fakeSite([{ id: 500, play_dates: [mine] }]);

    assert.deepEqual(await client.upsertDailySession({ gameId: 99, date: '2026-10-13', minutes: 95, sessionId: 12 }), { changed: false, sessionId: 12 });
    assert.equal(posts.length, 0);

    client.lastWrite = -Infinity;
    await client.upsertDailySession({ gameId: 99, date: '2026-10-13', minutes: 120, sessionId: 12 });
    assert.equal(posts[0]['dates[500][0][id]'], '12');
    assert.equal(posts[0]['dates[500][0][hours]'], '2');
    assert.equal(posts[0]['dates[500][0][minutes]'], '0');
    assert.equal(posts[0]['dates[500][1][id]'], undefined);
});

test('an old session marked "Steam" is still found, and loses the note', async () => {
    const old = { id: 12, range_start_date: '2026-10-13', range_end_date: '2026-10-14', hours: 1, minutes: 35, note: LEGACY_SESSION_NOTE };
    const { posts, client } = fakeSite([{ id: 500, play_dates: [old] }]);
    assert.deepEqual(await client.upsertDailySession({ gameId: 99, date: '2026-10-13', minutes: 95 }), { changed: true, sessionId: 12 });
    assert.equal(posts[0]['dates[500][0][id]'], '12');
    assert.equal(posts[0]['dates[500][0][note]'], '');
    assert.equal(posts[0]['dates[500][1][id]'], undefined);
});

test('a session written before is found without its id only when it is the day\'s only one without a note', async () => {
    const ours = { id: 12, range_start_date: '2026-10-13', range_end_date: '2026-10-14', hours: 0, minutes: 20 };
    let site = fakeSite([{ id: 500, play_dates: [ours] }]);
    assert.deepEqual(await site.client.upsertDailySession({ gameId: 99, date: '2026-10-13', minutes: 20, pushedBefore: true }), { changed: false, sessionId: 12 });

    // Never written by the sync: a session already there (entered by hand) is left alone.
    site = fakeSite([{ id: 500, play_dates: [ours] }]);
    await site.client.upsertDailySession({ gameId: 99, date: '2026-10-13', minutes: 30 });
    assert.equal(site.posts[0]['dates[500][0][minutes]'], '20');
    assert.equal(site.posts[0]['dates[500][1][id]'], '-1');
});

test('pushes remember the session id and keep a history for the statistics', async () => {
    const s = emptyState();
    s.mappings[632470] = { id: 1, slug: 'disco-elysium', title: 'Disco Elysium', cover: 'https://x/c.jpg' };
    s.days['632470|2026-10-13'] = { appid: 632470, name: 'Disco Elysium', date: '2026-10-13', minutes: 5, synced: false };
    s.days['ns:switch:Disco Elysium|2026-10-13|phone'] = { appid: 'ns:switch:Disco Elysium', name: 'Disco Elysium', date: '2026-10-13', minutes: 3, synced: false, system: 'switch', device: 'phone' };
    s.mappings['ns:switch:Disco Elysium'] = s.mappings[632470];
    const calls = [];
    const backloggd = { upsertDailySession: async (a) => { calls.push(a); return { changed: true, sessionId: 77 }; } };
    await pushToBackloggd(s, backloggd);
    assert.deepEqual(s.history['1|2026-10-13'], { gameId: 1, date: '2026-10-13', minutes: 8, platform: 'win', sources: ['steam', 'phone'], sessionId: 77 });
    assert.deepEqual(s.games[1], { id: 1, slug: 'disco-elysium', title: 'Disco Elysium', year: null, cover: 'https://x/c.jpg' });

    s.days['632470|2026-10-13'].minutes = 10;
    s.days['632470|2026-10-13'].synced = false;
    await pushToBackloggd(s, backloggd);
    assert.equal(calls[1].sessionId, 77);
    assert.equal(calls[1].pushedBefore, true);
    assert.equal(s.history['1|2026-10-13'].minutes, 13);
});

test('the history is seeded once from days already written, and missing covers are fetched', async () => {
    const s = emptyState();
    s.mappings[5] = { id: 9, slug: 'hades', title: 'Hades' };
    s.days['5|2026-10-12'] = { appid: 5, name: 'Hades', date: '2026-10-12', minutes: 40, synced: true };
    s.days['5|2026-10-13'] = { appid: 5, name: 'Hades', date: '2026-10-13', minutes: 10, synced: false };
    seedHistory(s);
    assert.deepEqual(Object.keys(s.history), ['9|2026-10-12']);
    seedHistory(s);
    await fillCovers(s, { gameDetails: async () => ({ cover: 'https://x/h.jpg', platforms: ['win'] }) });
    assert.equal(s.games[9].cover, 'https://x/h.jpg');
});

test('a running game missing from the library (family sharing) is credited the time since the last poll', () => {
    let s = emptyState();
    s.snapshot = { 1: 600 };
    s.lastPoll = '2026-10-13T16:00:00Z';
    const now = at('2026-10-13T16:05:00Z');
    s = recordLiveGame(s, { gameId: '2379780', name: 'Chrono Trigger (USA)' }, { now, timeZone: tz }).state;
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

test('the journal skips quiet runs and keeps the newest 30', () => {
    const s = emptyState();
    appendLog(s, { at: 't0' });
    assert.deepEqual(s.log, []);
    for (let i = 0; i < 35; i++) appendLog(s, { at: `t${i}`, gained: [{ name: 'Hades', minutes: 4.6 }] });
    assert.equal(s.log.length, 30);
    assert.equal(s.log[0].at, 't34');
    assert.deepEqual(s.log[0].played, ['Hades +5 min']);
    appendLog(s, { at: 'x', error: 'Steam GetOwnedGames HTTP 403' });
    assert.deepEqual(s.log[0], { at: 'x', error: 'Steam GetOwnedGames HTTP 403' });
});

test('changing STEAM_ID restarts from a fresh snapshot', () => {
    const s = emptyState();
    s.steamId = '111';
    s.snapshot = { 1: 600 };
    s.lastPoll = '2026-10-13T16:00:00Z';
    s.days['1|2026-10-13'] = { appid: 1, name: 'Hades', date: '2026-10-13', minutes: 30, synced: false };
    s.days['2|2026-10-12'] = { appid: 2, name: 'Celeste', date: '2026-10-12', minutes: 10, synced: true };

    assert.equal(forAccount(s, '111'), s);
    const next = forAccount(s, '222');
    assert.equal(next.steamId, '222');
    assert.equal(next.snapshot, null);
    assert.equal(next.lastPoll, null);
    assert.deepEqual(Object.keys(next.days), ['2|2026-10-12']);

    // Without a snapshot the next run only records a starting point.
    const { gained } = recordPlaytime(next, [{ appid: 1, name: 'Hades', playtime: 9000 }], { now: at('2026-10-13T17:00:00Z'), timeZone: tz });
    assert.deepEqual(gained, []);
});

test('non-Steam shortcut ids are left to the Deck watcher', () => {
    const s = emptyState();
    s.snapshot = {};
    s.lastPoll = '2026-10-13T16:00:00Z';
    const { gained } = recordLiveGame(s, { gameId: '15374772738578399232', name: 'Non-Steam game' }, { now: at('2026-10-13T16:05:00Z'), timeZone: tz });
    assert.deepEqual(gained, []);
});

test('Deck reports set the day total and never shrink it', () => {
    const s = emptyState();
    assert.equal(recordReportedPlay(s, { name: 'SoulCalibur II (USA)', date: '2026-10-13', minutes: 20 }), 20);
    assert.equal(recordReportedPlay(s, { name: 'SoulCalibur II (USA)', date: '2026-10-13', minutes: 20 }), 0);
    assert.equal(recordReportedPlay(s, { name: 'SoulCalibur II (USA)', date: '2026-10-13', minutes: 5 }), 0);
    assert.equal(recordReportedPlay(s, { name: 'SoulCalibur II (USA)', date: '2026-10-13', minutes: 45 }), 25);
    const day = s.days['ns:SoulCalibur II|2026-10-13'];
    assert.equal(day.minutes, 45);
    assert.equal(day.synced, false);
});

test('Deck reports carry the ROM system through to the Backloggd write', async () => {
    const s = emptyState();
    recordReportedPlay(s, { name: 'SoulCalibur II (USA)', date: '2026-10-13', minutes: 20, system: 'gc' });
    s.mappings['ns:gc:SoulCalibur II'] = { id: 1565, slug: 'soulcalibur-ii' };
    const calls = [];
    await pushToBackloggd(s, { upsertDailySession: async (a) => calls.push(a) });
    assert.deepEqual(calls, [{ gameId: 1565, date: '2026-10-13', minutes: 20, platform: 21 }]);

    // The same title on another system is tracked (and mapped) on its own.
    recordReportedPlay(s, { name: 'SoulCalibur II (USA)', date: '2026-10-13', minutes: 5, system: 'ps2' });
    assert.equal(s.days['ns:ps2:SoulCalibur II|2026-10-13'].minutes, 5);
});

test('Phone and Deck days for the same game add up into one Backloggd session', async () => {
    const s = emptyState();
    recordReportedPlay(s, { name: 'Ace Attorney', date: '2026-10-15', minutes: 30, system: 'switch' });
    assert.equal(recordReportedPlay(s, { name: 'Ace Attorney', date: '2026-10-15', minutes: 20, system: 'switch', device: 'phone' }), 20);
    // Each device's total only moves its own day.
    assert.equal(recordReportedPlay(s, { name: 'Ace Attorney', date: '2026-10-15', minutes: 25, system: 'switch', device: 'phone' }), 5);
    assert.equal(s.days['ns:switch:Ace Attorney|2026-10-15'].minutes, 30);
    s.mappings['ns:switch:Ace Attorney'] = { id: 42, slug: 'ace' };
    const calls = [];
    const pushed = await pushToBackloggd(s, { upsertDailySession: async (a) => calls.push(a) });
    assert.deepEqual(calls, [{ gameId: 42, date: '2026-10-15', minutes: 55, platform: 130 }]);
    assert.equal(pushed.length, 1);
    assert.ok(Object.values(s.days).every((d) => d.synced));
});


const soulcalibur = () => ({
    autocomplete: async () => [
        { id: 1565, slug: 'soulcalibur-ii', title: 'SoulCalibur II' },
        { id: 9001, slug: 'soulcalibur-ii--2', title: 'SoulCalibur II' },
        { id: 7, slug: 'soulcalibur-ii-hd-online', title: 'SoulCalibur II HD Online' },
        { id: 8, slug: 'soulcalibur-iii', title: 'SoulCalibur III' },
    ],
    gameDetails: async (slug) => ({
        'soulcalibur-ii': { platforms: ['arcade', 'ps2', 'xbox', 'ngc'] },
        'soulcalibur-ii--2': { platforms: ['ngc'] },
        'soulcalibur-ii-hd-online': { platforms: ['ps3', 'xbox360'] },
    })[slug],
});

test('several possible entries are held for a choice, the ROM system deciding the suggestion', async () => {
    const gc = await resolveGame(soulcalibur(), 'Soulcalibur II', 'gc');
    assert.equal(gc.match, undefined);
    // Same title and its HD release, not the sequel.
    assert.deepEqual(gc.candidates.map((c) => c.slug), ['soulcalibur-ii', 'soulcalibur-ii--2', 'soulcalibur-ii-hd-online']);
    assert.equal(gc.suggested, 'soulcalibur-ii--2');
    assert.equal((await resolveGame(soulcalibur(), 'Soulcalibur II', 'ps2')).suggested, 'soulcalibur-ii');
    assert.equal((await resolveGame(soulcalibur(), 'Soulcalibur II', 'ps3')).suggested, 'soulcalibur-ii-hd-online');
});

test('editions Backloggd lists are offered too, and one possible entry is taken directly', async () => {
    const backloggd = {
        autocomplete: async () => [{ id: 1, slug: 'disco-elysium', title: 'Disco Elysium' }],
        editions: async (id) => (id === 1 ? [{ id: 2, slug: 'disco-elysium-the-final-cut', title: 'Disco Elysium: The Final Cut' }] : []),
    };
    const { candidates, suggested } = await resolveGame(backloggd, 'Disco Elysium', 'pc');
    assert.deepEqual(candidates.map((c) => c.slug), ['disco-elysium', 'disco-elysium-the-final-cut']);
    assert.equal(suggested, 'disco-elysium');

    const single = { autocomplete: async () => [{ id: 3, slug: 'celeste', title: 'Celeste' }] };
    assert.equal((await resolveGame(single, 'Celeste', 'pc')).match.slug, 'celeste');
});

test('reads release platforms, cover and editions from Backloggd pages', async () => {
    const pages = {
        '/games/soulcalibur-ii/': '<meta property="og:image" content="https://images.igdb.com/x.jpg">'
            + '<a class="game-page-platform" href=/games/lib/popular/release_platform:ngc/><i></i> Nintendo GameCube</a>'
            + '<a class="game-page-platform" href=/games/lib/popular/release_platform:ps2/>PlayStation 2</a>',
        '/update_game_detail/1/editions/': '<div class="card game-cover" game_id="2"><a class="cover-link" href="/games/disco-elysium-the-final-cut/">'
            + '<img class="card-img" alt="Disco Elysium: The Final Cut &amp; more"></a></div>',
    };
    const client = new BackloggdClient({ sessionCookie: 'abc', fetchImpl: async (url) => new Response(pages[new URL(url).pathname] ?? '', { status: 200 }) });
    assert.deepEqual(await client.gameDetails('soulcalibur-ii'), { platforms: ['ngc', 'ps2'], cover: 'https://images.igdb.com/x.jpg' });
    assert.deepEqual(await client.editions(1), [{ id: 2, slug: 'disco-elysium-the-final-cut', title: 'Disco Elysium: The Final Cut & more' }]);
});

test('sets the platform only when the log has none', async () => {
    const mine = { id: 12, range_start_date: '2026-10-13', range_end_date: '2026-10-14', hours: 0, minutes: 20, note: null };

    // Same minutes, no platform yet: the platform alone is worth a write.
    let site = fakeSite([{ id: 500, play_dates: [mine] }]);
    assert.deepEqual(await site.client.upsertDailySession({ gameId: 99, date: '2026-10-13', minutes: 20, platform: 21, sessionId: 12 }), { changed: true, platform: 21, sessionId: 12 });
    assert.equal(site.posts[0]['playthroughs[0][played_platform]'], '21');

    // A platform chosen by hand is kept.
    site = fakeSite([{ id: 500, played_platform: 8, play_dates: [mine] }]);
    assert.deepEqual(await site.client.upsertDailySession({ gameId: 99, date: '2026-10-13', minutes: 20, platform: 21, sessionId: 12 }), { changed: false, sessionId: 12 });
    site.client.lastWrite = -Infinity;
    await site.client.upsertDailySession({ gameId: 99, date: '2026-10-13', minutes: 30, platform: 21, sessionId: 12 });
    assert.equal(site.posts[0]['playthroughs[0][played_platform]'], '8');
});

test('a held Steam game waits for a choice, is not looked up again, then lands as a PC game', async () => {
    const s = emptyState();
    s.days['632470|2026-10-13'] = { appid: 632470, name: 'Disco Elysium', date: '2026-10-13', minutes: 5, synced: false };
    let lookups = 0;
    const calls = [];
    const backloggd = {
        autocomplete: async () => { lookups++; return [
            { id: 1, slug: 'disco-elysium', title: 'Disco Elysium' },
            { id: 2, slug: 'disco-elysium--1', title: 'Disco Elysium' },
        ]; },
        gameDetails: async (slug) => ({ 'disco-elysium': { platforms: ['win', 'mac', 'ps4--1'] }, 'disco-elysium--1': { platforms: ['ps5'] } })[slug],
        upsertDailySession: async (a) => calls.push(a),
    };
    await pushToBackloggd(s, backloggd);
    await pushToBackloggd(s, backloggd);
    assert.equal(lookups, 1);
    assert.deepEqual(calls, []);
    assert.equal(s.unmapped[632470].suggested, 'disco-elysium');

    // What the page's "Enregistrer" does.
    s.mappings[632470] = s.unmapped[632470].candidates[0];
    delete s.unmapped[632470];
    await pushToBackloggd(s, backloggd);
    assert.deepEqual(calls, [{ gameId: 1, date: '2026-10-13', minutes: 5, platform: 6 }]);
});

test('the first session of a new log is marked as started, and existing marks are kept', async () => {
    let site = fakeSite([{ id: 500, play_dates: [] }]);
    await site.client.upsertDailySession({ gameId: 99, date: '2026-10-13', minutes: 20 });
    assert.equal(site.posts[0]['dates[500][0][start_date]'], '2026-10-13');

    const finished = { id: 11, range_start_date: '2026-10-01', range_end_date: '2026-10-02', hours: 1, minutes: 0, note: 'manual', start_date: '2026-10-01', finish_date: '2026-10-01' };
    site = fakeSite([{ id: 500, play_dates: [finished] }]);
    await site.client.upsertDailySession({ gameId: 99, date: '2026-10-13', minutes: 20 });
    assert.equal(site.posts[0]['dates[500][0][start_date]'], '2026-10-01');
    assert.equal(site.posts[0]['dates[500][0][finish_date]'], '2026-10-01');
    assert.equal(site.posts[0]['dates[500][1][start_date]'], '');
});

test('a Steam game the Deck reports is counted on the Deck day, not again from Steam playtime', () => {
    const now = at('2026-10-14T13:00:00Z');
    let s = recordPlaytime(emptyState(), [{ appid: 632470, name: 'Disco Elysium', playtime: 100 }], { now, timeZone: tz }).state;
    // Played late on the 13th, Deck slept, Steam only adds the time the next morning.
    assert.equal(recordReportedPlay(s, { appid: 632470, name: 'Disco Elysium', date: '2026-10-13', minutes: 40 }, { now }), 40);
    const { state, gained } = recordPlaytime(s, [{ appid: 632470, name: 'Disco Elysium', playtime: 140 }], { now, timeZone: tz });
    assert.deepEqual(gained, []);
    assert.deepEqual(Object.keys(state.days), ['632470|2026-10-13']);
    assert.equal(state.snapshot[632470], 140);

    // Played elsewhere two days later: Steam's playtime counts again.
    const later = at('2026-10-16T13:00:00Z');
    assert.equal(recordPlaytime(state, [{ appid: 632470, name: 'Disco Elysium', playtime: 170 }], { now: later, timeZone: tz }).gained[0].minutes, 30);
});

test('a game already matched can be put back up for choice, keeping its old entry as an option', async () => {
    const s = emptyState();
    s.mappings[632470] = { id: 1, slug: 'disco-elysium', title: 'Disco Elysium' };
    s.days['632470|2026-10-13'] = { appid: 632470, name: 'Disco Elysium', date: '2026-10-13', minutes: 5, synced: true };
    const backloggd = {
        autocomplete: async () => [{ id: 2, slug: 'disco-elysium-the-final-cut', title: 'Disco Elysium: The Final Cut' }],
        gameDetails: async () => ({ platforms: ['win'] }),
    };
    assert.equal(await reopenChoice(s, backloggd, 632470), true);
    assert.equal(s.mappings[632470], undefined);
    assert.deepEqual(s.unmapped[632470].candidates.map((c) => c.slug), ['disco-elysium-the-final-cut', 'disco-elysium']);
    assert.equal(s.unmapped[632470].held, true);
    assert.equal(await reopenChoice(s, backloggd, 1), false);
});

test('Deck time for a Steam game adds to what Steam counted that day before the Deck took over', () => {
    const now = at('2026-10-13T16:00:00Z');
    const s = emptyState();
    s.days['632470|2026-10-13'] = { appid: 632470, name: 'Disco Elysium', date: '2026-10-13', minutes: 14, synced: true };
    assert.equal(recordReportedPlay(s, { appid: 632470, name: 'Disco Elysium', date: '2026-10-13', minutes: 10 }, { now }), 10);
    assert.equal(s.days['632470|2026-10-13'].minutes, 24);
    assert.equal(s.days['632470|2026-10-13'].synced, false);
    assert.equal(recordReportedPlay(s, { appid: 632470, name: 'Disco Elysium', date: '2026-10-13', minutes: 10 }, { now }), 0);
    assert.equal(recordReportedPlay(s, { appid: 632470, name: 'Disco Elysium', date: '2026-10-13', minutes: 25 }, { now }), 15);
    assert.equal(s.days['632470|2026-10-13'].minutes, 39);
});

test('a game already marked Played gets no Started mark on its first tracked session', async () => {
    const site = fakeSite([{ id: 500, play_dates: [] }], { id: 7, is_play: true, status: 'completed' });
    await site.client.upsertDailySession({ gameId: 99, date: '2026-10-13', minutes: 20 });
    assert.equal(site.posts[0]['dates[500][0][start_date]'], '');
    assert.equal(site.posts[0]['log[status]'], 'completed');
});

test('setting a game to Completed or Played marks its last session as the finish, once', async () => {
    const sessions = [
        { id: 11, range_start_date: '2026-10-10', range_end_date: '2026-10-11', hours: 1, minutes: 0, start_date: '2026-10-10' },
        { id: 12, range_start_date: '2026-10-12', range_end_date: '2026-10-13', hours: 0, minutes: 40 },
    ];
    let site = fakeSite([{ id: 500, play_dates: sessions }], { id: 7, is_play: true, status: 'completed' });
    assert.equal(await site.client.markFinished(99), '2026-10-12');
    assert.equal(site.posts[0]['dates[500][1][finish_date]'], '2026-10-12');
    assert.equal(site.posts[0]['dates[500][0][finish_date]'], '');
    assert.equal(site.posts[0]['dates[500][0][start_date]'], '2026-10-10');

    // Still on the Playing shelf (what this tool's own saves look like): nothing to do.
    site = fakeSite([{ id: 500, play_dates: sessions }]);
    assert.equal(await site.client.markFinished(99), false);
    site = fakeSite([{ id: 500, play_dates: sessions }], { id: 7, is_play: true, status: 'shelved' });
    assert.equal(await site.client.markFinished(99), false);
    assert.equal(site.posts.length, 0);

    // A finish already there is left alone.
    site = fakeSite([{ id: 500, play_dates: [{ ...sessions[1], finish_date: '2026-10-12' }] }], { id: 7, is_play: true, status: 'played' });
    assert.equal(await site.client.markFinished(99), true);
    assert.equal(site.posts.length, 0);
});

test('finished games are checked about hourly and then left alone', async () => {
    const s = emptyState();
    s.mappings[1] = { id: 5, slug: 'hades', title: 'Hades' };
    s.mappings[2] = { id: 6, slug: 'celeste', title: 'Celeste' };
    s.days['1|2026-10-13'] = { appid: 1, date: '2026-10-13', synced: true };
    s.days['2|2026-10-13'] = { appid: 2, date: '2026-10-13', synced: true };
    const asked = [];
    const backloggd = { markFinished: async (id) => { asked.push(id); return id === 5 ? '2026-10-13' : false; } };
    const now = at('2026-10-13T20:00:00Z');
    assert.deepEqual(await markFinishedGames(s, backloggd, { now }), [{ game: 'Hades', date: '2026-10-13' }]);
    assert.deepEqual(await markFinishedGames(s, backloggd, { now: at('2026-10-13T20:30:00Z') }), []);
    await markFinishedGames(s, backloggd, { now: at('2026-10-13T21:01:00Z') });
    assert.deepEqual(asked, [5, 6, 6]);
});

/** fakeSite that also applies saves, so a re-read shows what was written. */
function liveSite(playthroughs, log = { id: 7, is_playing: true, status: 'played' }, { deletedField = 'deleted_dates[]' } = {}) {
    const posts = [];
    const deletes = [];
    const fetchImpl = async (url, init) => {
        const u = new URL(url);
        const html = (body) => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
        if (u.pathname === '/') return html('<meta name="csrf-token" content="tok">');
        if (u.pathname === '/settings/') return html('<a href="/users/sign_out"></a><script>user_id="42"</script>');
        if (u.pathname.startsWith('/log/edit/')) return Response.json({ game_log: log, playthroughs });
        if (u.pathname === '/unlog/') { deletes.push(Object.fromEntries(new URLSearchParams(init.body))); return new Response('{}'); }
        if (u.pathname === '/api/user/42/log/99') {
            const params = new URLSearchParams(init.body);
            const f = Object.fromEntries(params);
            posts.push(f);
            const pt = playthroughs.at(-1);
            // Like the real site: a session left out of the save stays, unless listed as deleted.
            const raw = params.getAll(deletedField);
            const deleted = new Set((deletedField === 'deleted_dates' ? raw.flatMap((v) => { try { return JSON.parse(v); } catch { return []; } }) : raw).map(String));
            const untouched = (pt.play_dates ?? []).filter((d) => !deleted.has(String(d.id)));
            pt.play_dates = [];
            for (let i = 0; f[`dates[${pt.id}][${i}][id]`] !== undefined; i++) {
                const g = (k) => f[`dates[${pt.id}][${i}][${k}]`];
                pt.play_dates.push({ id: Number(g('id')) > 0 ? Number(g('id')) : 1000 + i, range_start_date: g('range_start_date'), range_end_date: g('range_end_date'), hours: g('hours'), minutes: g('minutes'), note: g('note') });
            }
            const sent = new Set(pt.play_dates.map((d) => String(d.id)));
            pt.play_dates.push(...untouched.filter((d) => !sent.has(String(d.id))));
            return new Response('{}');
        }
        return new Response('not found', { status: 404 });
    };
    const client = new BackloggdClient({ sessionCookie: 'abc', fetchImpl });
    client.lastWrite = -Infinity;
    return { posts, deletes, client };
}

const dayAt = (id, date, minutes, note = null) => ({ id, range_start_date: date, range_end_date: date, hours: 0, minutes, note });

test('a new session\'s id is read back after it is created', async () => {
    const site = liveSite([{ id: 500, play_dates: [dayAt(11, '2026-10-01', 30)] }]);
    const res = await site.client.upsertDailySession({ gameId: 99, date: '2026-10-13', minutes: 20 });
    assert.equal(res.sessionId, 1001);
});

test('deleting a session removes only that one on Backloggd, and its time is not sent again', async () => {
    const site = liveSite([{ id: 500, play_dates: [dayAt(11, '2026-10-13', 30), dayAt(12, '2026-10-13', 20)] }]);
    site.client.WRITE_GAP_MS = 0;
    const s = emptyState();
    s.mappings[5] = { id: 99, slug: 'hades', title: 'Hades' };
    s.days['5|2026-10-13'] = { appid: 5, name: 'Hades', date: '2026-10-13', minutes: 20, synced: true };
    s.history = { '99|2026-10-13': { gameId: 99, date: '2026-10-13', minutes: 20, sessionId: 12 } };
    assert.deepEqual(await deleteSession(s, site.client, 99, '2026-10-13'), { removed: ['2026-10-13'], unlogged: false });
    assert.deepEqual(site.posts.at(-1)['dates[500][0][id]'], '11');
    assert.equal(site.posts.at(-1)['dates[500][1][id]'], undefined);
    assert.equal(s.history['99|2026-10-13'], undefined);

    // Same day, more play: only the new 15 minutes become a session.
    const calls = [];
    s.days['5|2026-10-13'].minutes = 35;
    s.days['5|2026-10-13'].synced = false;
    await pushToBackloggd(s, { upsertDailySession: async (a) => { calls.push(a); return { sessionId: 13 }; } });
    assert.deepEqual(calls, [{ gameId: 99, date: '2026-10-13', minutes: 15, platform: 6 }]);
});

test('deleting a game logged by mistake removes it from Backloggd and blocks it until restored', async () => {
    const site = liveSite([{ id: 500, play_dates: [dayAt(12, '2026-10-12', 20), dayAt(13, '2026-10-13', 5, LEGACY_SESSION_NOTE)] }], { id: 7, is_playing: true, status: 'played' });
    const s = emptyState();
    s.mappings['ns:switch:Oops'] = { id: 99, slug: 'oops', title: 'Oops' };
    s.history = { '99|2026-10-12': { gameId: 99, date: '2026-10-12', minutes: 20, sessionId: 12 } };
    const res = await deleteGame(s, site.client, 99);
    assert.deepEqual(res, { removed: ['2026-10-12', '2026-10-13'], unlogged: true });
    assert.deepEqual(site.deletes, [{ game_id: '99', log_id: '7' }]);
    assert.equal(s.blocked[99].title, 'Oops');
    assert.deepEqual(s.history, {});

    // The phone keeps reporting it: nothing is sent.
    s.days['ns:switch:Oops|2026-10-14|phone'] = { appid: 'ns:switch:Oops', name: 'Oops', date: '2026-10-14', minutes: 30, synced: false, system: 'switch' };
    const calls = [];
    await pushToBackloggd(s, { upsertDailySession: async (a) => calls.push(a) });
    assert.deepEqual(calls, []);
    assert.equal(s.days['ns:switch:Oops|2026-10-14|phone'].synced, true);

    assert.equal(restoreGame(s, 99), true);
    s.days['ns:switch:Oops|2026-10-15|phone'] = { appid: 'ns:switch:Oops', name: 'Oops', date: '2026-10-15', minutes: 10, synced: false, system: 'switch' };
    await pushToBackloggd(s, { upsertDailySession: async (a) => calls.push(a) });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].date, '2026-10-15');
});

test('deleting a game the owner also logged by hand keeps their entry', async () => {
    const site = liveSite([{ id: 500, play_dates: [dayAt(11, '2026-09-01', 60, 'manual'), dayAt(12, '2026-10-12', 20)] }]);
    const s = emptyState();
    s.history = { '99|2026-10-12': { gameId: 99, date: '2026-10-12', minutes: 20, sessionId: 12 } };
    assert.deepEqual(await deleteGame(s, site.client, 99), { removed: ['2026-10-12'], unlogged: false });
    assert.deepEqual(site.deletes, []);
    assert.equal(site.posts.at(-1)['dates[500][0][id]'], '11');
});

test('deleted sessions are listed for Backloggd, trying the next form shape when one is ignored', async () => {
    let site = liveSite([{ id: 500, play_dates: [dayAt(11, '2026-10-13', 30), dayAt(12, '2026-10-14', 20)] }]);
    await site.client.removeSessions(99, { ids: [12] });
    assert.equal(site.posts.length, 1);
    assert.equal(site.client.deleteVariant, 'array');

    site = liveSite([{ id: 500, play_dates: [dayAt(11, '2026-10-13', 30), dayAt(12, '2026-10-14', 20)] }], undefined, { deletedField: 'deleted_dates' });
    assert.deepEqual(await site.client.removeSessions(99, { ids: [12] }), { removed: ['2026-10-14'], unlogged: false });
    assert.equal(site.posts.length, 2);
    assert.equal(site.posts[1].deleted_dates, '[12]');
    assert.equal(site.client.deleteVariant, 'json');

    site = liveSite([{ id: 500, play_dates: [dayAt(12, '2026-10-14', 20)] }], undefined, { deletedField: 'nothing' });
    await assert.rejects(site.client.removeSessions(99, { ids: [12] }), /gardé/);
});
