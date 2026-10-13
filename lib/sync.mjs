import { AuthError } from './backloggd.mjs';
import { platformFor } from './platforms.mjs';

// Netlify stops scheduled functions at 30 s; leave room to save state.
const DEFAULT_BUDGET_MS = 20_000;
const KEEP_SYNCED_DAYS = 14;
// Longest gap between two polls still credited as play; anything longer was downtime.
const MAX_LIVE_CREDIT_MS = 10 * 60_000;

export function emptyState() {
    return { snapshot: null, days: {}, mappings: {}, unmapped: {}, lastRun: null, lastPoll: null, lastError: null, log: [] };
}

/** `YYYY-MM-DD` for `now` in the given IANA time zone. */
export function localDate(now, timeZone) {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

const normaliseTitle = (t) =>
    String(t ?? '')
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[™®©]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();

const LOG_SIZE = 30;

/**
 * Keeps a short newest-first journal of the runs that did something. Quiet runs
 * (nothing played, nothing pushed, no error) only move `lastRun`.
 */
export function appendLog(state, { at, gained = [], pushed = [], error = null }) {
    if (!gained.length && !pushed.length && !error) return;
    const entry = { at };
    if (gained.length) entry.played = gained.map((g) => `${g.name} +${Math.round(g.minutes)} min`);
    if (pushed.length) entry.pushed = pushed.map((p) => `${p.game} ${p.date} → ${p.minutes} min`);
    if (error) entry.error = error;
    state.log = [entry, ...(state.log ?? [])].slice(0, LOG_SIZE);
}

function addMinutes(state, key, name, date, minutes) {
    const dayKey = `${key}|${date}`;
    const day = state.days[dayKey] ?? { appid: key, name, date, minutes: 0 };
    day.minutes += minutes;
    day.synced = false;
    state.days[dayKey] = day;
}

/** Steam ROM Manager titles often carry region or revision tags: "Chrono Trigger (USA)". */
export function cleanShortcutName(name) {
    return String(name).replace(/\s*[([][^)\]]*[)\]]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Merges a day total reported by the Steam Deck watcher. The watcher sends its running
 * total for the day, so re-sending is harmless; a lower total (watcher state lost)
 * never shrinks what was already counted. Returns the minutes added.
 */
export function recordReportedPlay(state, { name, date, minutes, system }) {
    const clean = cleanShortcutName(name);
    const key = `ns:${clean}|${date}`;
    // The system folder is kept even when the total did not grow, so it reaches Backloggd.
    if (system && state.days[key] && state.days[key].system !== system) {
        state.days[key].system = system;
        state.days[key].synced = false;
    }
    const current = state.days[key]?.minutes ?? 0;
    if (minutes <= current) return 0;
    addMinutes(state, `ns:${clean}`, clean, date, minutes - current);
    if (system) state.days[key].system = system;
    return minutes - current;
}

/**
 * Credits time to a non-Steam game seen as "In-Game" on the profile. Steam keeps no
 * playtime for shortcuts, so each poll that finds one running counts the time since
 * the previous poll. Owned Steam games are skipped: their playtime comes from
 * `recordPlaytime`, which is exact. Pure: returns the new state.
 */
export function recordLiveGame(state, current, { now, timeZone }) {
    const next = structuredClone(state);
    const since = next.lastPoll ? now.getTime() - Date.parse(next.lastPoll) : 0;
    next.lastPoll = now.toISOString();

    const owned = current?.gameId && next.snapshot && String(current.gameId) in next.snapshot;
    // Shortcut ids sit above 2^32; those games are reported by the Deck watcher instead.
    const shortcut = current?.gameId && BigInt(current.gameId) > 0xffffffffn;
    if (!current || owned || shortcut || since <= 0) return { state: next, gained: [] };

    const minutes = Math.min(since, MAX_LIVE_CREDIT_MS) / 60_000;
    const name = cleanShortcutName(current.name);
    addMinutes(next, `ns:${name}`, name, localDate(now, timeZone), minutes);
    return { state: next, gained: [{ appid: `ns:${name}`, name, minutes }] };
}

/**
 * Restarts tracking when STEAM_ID changes. Comparing against another account's
 * snapshot would turn the difference between two libraries into "playtime".
 */
export function forAccount(state, steamId) {
    if (state.steamId === steamId) return state;
    const next = structuredClone(state);
    // Older state has no steamId: its snapshot may come from any account, so drop it too.
    next.steamId = steamId;
    next.snapshot = null;
    next.lastPoll = null;
    for (const [key, day] of Object.entries(next.days)) {
        if (!day.synced) delete next.days[key];
    }
    next.unmapped = {};
    return next;
}

/**
 * Adds the playtime gained since the last snapshot to today's per-game totals.
 * Pure: returns the new state without touching the network.
 */
export function recordPlaytime(state, games, { now, timeZone }) {
    const next = structuredClone(state);
    const current = Object.fromEntries(games.map((g) => [g.appid, g.playtime]));

    // First run: nothing to compare against, so only remember where we start.
    if (!next.snapshot) {
        next.snapshot = current;
        return { state: next, gained: [] };
    }

    const date = localDate(now, timeZone);
    const gained = [];
    for (const g of games) {
        const before = next.snapshot[g.appid];
        // A game that just appeared in the library only counts if it was played recently,
        // otherwise its whole history would land on today.
        const delta = before === undefined
            ? (g.lastPlayed * 1000 > now.getTime() - 24 * 3600_000 ? g.playtime : 0)
            : g.playtime - before;
        if (delta <= 0) continue;

        addMinutes(next, g.appid, g.name, date, delta);
        gained.push({ appid: g.appid, name: g.name, minutes: delta });
    }
    next.snapshot = current;

    const cutoff = localDate(new Date(now.getTime() - KEEP_SYNCED_DAYS * 86_400_000), timeZone);
    for (const [key, day] of Object.entries(next.days)) {
        if (day.synced && day.date < cutoff) delete next.days[key];
    }
    return { state: next, gained };
}

/** Finds the Backloggd game for a Steam title, refusing to guess between several. */
export async function resolveGame(backloggd, name) {
    const hits = await backloggd.autocomplete(name);
    const exact = hits.filter((h) => normaliseTitle(h.title) === normaliseTitle(name));
    if (exact.length === 1) return { match: exact[0] };
    return { candidates: (exact.length ? exact : hits).slice(0, 5) };
}

/**
 * Pushes unsynced daily totals to Backloggd. Mutates `state` as each day lands so a
 * timeout mid-way loses nothing: the rest is picked up on the next run.
 */
export async function pushToBackloggd(state, backloggd, { budgetMs = DEFAULT_BUDGET_MS, clock = Date.now } = {}) {
    const deadline = clock() + budgetMs;
    const pending = Object.values(state.days).filter((d) => !d.synced).sort((a, b) => a.date.localeCompare(b.date));
    const pushed = [];

    for (const day of pending) {
        if (clock() > deadline) break;

        let game = state.mappings[day.appid];
        if (game === undefined) {
            const { match, candidates } = await resolveGame(backloggd, day.name);
            if (!match) {
                state.unmapped[day.appid] = { name: day.name, candidates };
                continue;
            }
            game = state.mappings[day.appid] = match;
            delete state.unmapped[day.appid];
        }
        // `null` means "known, never sync this app" (tools, soundtracks, ...).
        if (game === null) {
            day.synced = true;
            continue;
        }

        // Live-tracked games accumulate fractions of minutes; Backloggd takes whole ones.
        const minutes = Math.round(day.minutes);
        if (minutes < 1) continue;

        try {
            const platform = platformFor(day.system);
            await backloggd.upsertDailySession({ gameId: game.id, date: day.date, minutes, ...(platform && { platform }) });
        } catch (err) {
            if (err instanceof AuthError) throw err;
            day.error = String(err.message ?? err);
            continue;
        }
        day.synced = true;
        delete day.error;
        pushed.push({ game: game.title ?? game.slug, date: day.date, minutes });
    }
    return pushed;
}
