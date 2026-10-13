import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendLog, cleanShortcutName, emptyState, forAccount, recordReportedPlay, localDate, pushToBackloggd, recordLiveGame, recordPlaytime, resolveGame } from '../lib/sync.mjs';
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
    const mine = { id: 12, range_start_date: '2026-10-13', range_end_date: '2026-10-14', hours: 0, minutes: 20, note: SESSION_NOTE };

    // Same minutes, no platform yet: the platform alone is worth a write.
    let site = fakeSite([{ id: 500, play_dates: [mine] }]);
    assert.deepEqual(await site.client.upsertDailySession({ gameId: 99, date: '2026-10-13', minutes: 20, platform: 21 }), { changed: true, platform: 21 });
    assert.equal(site.posts[0]['playthroughs[0][played_platform]'], '21');

    // A platform chosen by hand is kept.
    site = fakeSite([{ id: 500, played_platform: 8, play_dates: [mine] }]);
    assert.deepEqual(await site.client.upsertDailySession({ gameId: 99, date: '2026-10-13', minutes: 20, platform: 21 }), { changed: false });
    site.client.lastWrite = -Infinity;
    await site.client.upsertDailySession({ gameId: 99, date: '2026-10-13', minutes: 30, platform: 21 });
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
