import { AuthError } from './backloggd.mjs';
import { platformFor, platformSlugsFor } from './platforms.mjs';

// Netlify stops scheduled functions at 30 s; leave room to save state.
const DEFAULT_BUDGET_MS = 20_000;
const KEEP_SYNCED_DAYS = 14;
// Longest gap between two polls still credited as play; anything longer was downtime.
const MAX_LIVE_CREDIT_MS = 10 * 60_000;
// While the Deck has reported a Steam game this recently, Steam's own playtime for it
// is ignored: that time is already counted, on the right day, by the Deck.
const DECK_OWNS_MS = 24 * 3600_000;

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
export function appendLog(state, { at, gained = [], pushed = [], finished = [], error = null }) {
    if (!gained.length && !pushed.length && !finished.length && !error) return;
    const entry = { at };
    if (gained.length) entry.played = gained.map((g) => `${g.name} +${Math.round(g.minutes)} min`);
    if (pushed.length) entry.pushed = pushed.map((p) => `${p.game} ${p.date} → ${p.minutes} min`);
    if (finished.length) entry.finished = finished.map((f) => `${f.game} (session du ${f.date})`);
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
export function recordReportedPlay(state, { name, date, minutes, system, appid: steamAppid, device }, { now = new Date() } = {}) {
    if (Number.isInteger(steamAppid)) {
        // A Steam game: same key as Steam's own playtime, so mappings are shared.
        (state.deckApps ??= {})[steamAppid] = now.toISOString();
        const key = `${steamAppid}|${date}`;
        // Time Steam already counted that day, before the Deck took over, stays: the Deck's
        // total only covers what it saw itself.
        const base = state.days[key] ? (state.days[key].deckBase ??= state.days[key].minutes) : 0;
        const current = state.days[key]?.minutes ?? 0;
        const added = base + minutes - current;
        if (added <= 0) return 0;
        addMinutes(state, steamAppid, name, date, added);
        state.days[key].deckBase ??= 0;
        return added;
    }
    const clean = cleanShortcutName(name);
    // The same title on two systems can be two Backloggd games, so the system is part of the key.
    const appid = system ? `ns:${system}:${clean}` : `ns:${clean}`;
    // Each device sends its own day total, so the phone and the Deck get separate days;
    // the push adds up every day of the same game and date.
    const key = device ? `${appid}|${date}|${device}` : `${appid}|${date}`;
    const current = state.days[key]?.minutes ?? 0;
    if (minutes <= current) return 0;
    const day = state.days[key] ?? { appid, name: clean, date, minutes: 0 };
    day.minutes = minutes;
    day.synced = false;
    if (system) day.system = system;
    if (device) day.device = device;
    state.days[key] = day;
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
    const deckOwns = (appid) => Date.parse(next.deckApps?.[appid] ?? '') > now.getTime() - DECK_OWNS_MS;
    for (const g of games) {
        const before = next.snapshot[g.appid];
        if (deckOwns(g.appid)) continue;
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
    for (const [appid, at] of Object.entries(next.deckApps ?? {})) {
        if (Date.parse(at) < now.getTime() - KEEP_SYNCED_DAYS * 86_400_000) delete next.deckApps[appid];
    }

    const cutoff = localDate(new Date(now.getTime() - KEEP_SYNCED_DAYS * 86_400_000), timeZone);
    for (const [key, day] of Object.entries(next.days)) {
        if (day.synced && day.date < cutoff) delete next.days[key];
    }
    return { state: next, gained };
}

const MAX_CANDIDATES = 8;

/**
 * Every Backloggd entry a title could mean: the same title, titles that extend it
 * ("Disco Elysium: The Final Cut"), and the editions Backloggd lists for exact matches,
 * each with its release platforms and cover so the page can show them.
 */
export async function findCandidates(backloggd, name) {
    const wanted = normaliseTitle(name);
    const related = (title) => {
        const t = normaliseTitle(title);
        return t === wanted || t.startsWith(`${wanted} `) || wanted.startsWith(`${t} `);
    };
    const hits = (await backloggd.autocomplete(name)).filter((h) => related(h.title));
    const found = new Map(hits.map((h) => [h.id, h]));
    for (const hit of hits.filter((h) => normaliseTitle(h.title) === wanted).slice(0, 2)) {
        const editions = await quietly(() => backloggd.editions?.(hit.id));
        for (const e of editions ?? []) if (!found.has(e.id)) found.set(e.id, e);
    }
    const candidates = [...found.values()].slice(0, MAX_CANDIDATES);
    for (const c of candidates) Object.assign(c, (await quietly(() => backloggd.gameDetails?.(c.slug))) ?? {});
    return candidates;
}

// Extra details are a nicety: a page that fails to load must not stop the run.
const quietly = async (fn) => {
    try { return await fn(); } catch { return null; }
};

/**
 * The candidate to preselect: released on the game's system, then the exact title, then
 * the most specific entry (fewest platforms), so a GameCube-only entry beats the
 * multi-platform one.
 */
export function suggest(candidates, name, system) {
    const slugs = platformSlugsFor(system);
    const wanted = normaliseTitle(name);
    const score = (c) => [
        slugs.length && !(c.platforms ?? []).some((p) => slugs.includes(p)) ? 1 : 0,
        normaliseTitle(c.title) === wanted ? 0 : 1,
        c.platforms?.length || 99,
    ];
    const better = (a, b) => {
        const [x, y] = [score(a), score(b)];
        const i = x.findIndex((v, k) => v !== y[k]);
        return i === -1 ? 0 : x[i] - y[i];
    };
    return [...candidates].sort(better)[0] ?? null;
}

/**
 * Finds the Backloggd game for a title. Only a single possible entry is taken on its own;
 * as soon as there are several (ports, editions, remasters) the person chooses, with the
 * best guess preselected.
 */
export async function resolveGame(backloggd, name, system = null) {
    const candidates = await findCandidates(backloggd, name);
    if (candidates.length === 1) return { match: candidates[0] };
    return { candidates, suggested: suggest(candidates, name, system)?.slug ?? null };
}

/**
 * Puts a game that already has an entry back up for choice, e.g. when it was matched
 * to the original release before editions were offered. Sessions already written stay
 * where they are; the next ones wait for the new choice. Returns false if the game is unknown.
 */
export async function reopenChoice(state, backloggd, appid) {
    const old = state.mappings[appid];
    const days = Object.values(state.days).filter((d) => d.appid === appid);
    const name = days.at(-1)?.name ?? old?.title;
    if (!name) return false;
    const system = days.find((d) => d.system)?.system ?? (typeof appid === 'number' ? 'pc' : null);
    const candidates = await findCandidates(backloggd, name);
    if (old && !candidates.some((c) => c.slug === old.slug)) candidates.push(old);
    state.unmapped[appid] = { name, system, candidates, suggested: suggest(candidates, name, system)?.slug ?? null, held: true };
    delete state.mappings[appid];
    return true;
}

const FINISH_CHECK_MS = 3600_000;

/**
 * Looks, about once an hour, at the games played in the last two weeks: one set to
 * Completed on Backloggd gets its last session marked as the finish. A game is checked
 * until that happens, then left alone. Returns the sessions marked.
 */
export async function markFinishedGames(state, backloggd, { now = new Date(), budgetMs = DEFAULT_BUDGET_MS, clock = Date.now } = {}) {
    if (Date.parse(state.lastFinishCheck ?? '') > now.getTime() - FINISH_CHECK_MS) return [];
    const deadline = clock() + budgetMs;
    const finished = (state.finished ??= {});
    const games = new Map();
    for (const day of Object.values(state.days)) {
        const game = state.mappings[day.appid];
        if (day.synced && game && !finished[game.id]) games.set(game.id, game);
    }
    const marked = [];
    for (const game of games.values()) {
        if (clock() > deadline) return marked;
        let result;
        try {
            result = await backloggd.markFinished(game.id);
        } catch (err) {
            if (err instanceof AuthError) throw err;
            continue;
        }
        if (!result) continue;
        finished[game.id] = now.toISOString();
        if (typeof result === 'string') marked.push({ game: game.title ?? game.slug, date: result });
    }
    state.lastFinishCheck = now.toISOString();
    return marked;
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
        // Already written as part of another source's day for the same game.
        if (day.synced) continue;

        // Steam games (numeric app ids) are PC games; emulated ones carry their ROM system.
        const system = day.system ?? (typeof day.appid === 'number' ? 'pc' : null);
        let game = state.mappings[day.appid];
        if (game === undefined) {
            // A game already waiting for a choice is not looked up again on every run.
            if (state.unmapped[day.appid]?.held) continue;
            const { match, candidates, suggested } = await resolveGame(backloggd, day.name, system);
            if (!match) {
                state.unmapped[day.appid] = { name: day.name, system, candidates, suggested, held: true };
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

        // Several sources can land on one game and date (the Deck and the phone, two keys
        // mapped to one entry); Backloggd gets one session per day, so it holds their sum.
        const same = Object.values(state.days).filter((d) => d.date === day.date && state.mappings[d.appid]?.id === game.id);
        // Live-tracked games accumulate fractions of minutes; Backloggd takes whole ones.
        const minutes = Math.round(same.reduce((sum, d) => sum + d.minutes, 0));
        if (minutes < 1) continue;

        try {
            const platform = platformFor(system);
            await backloggd.upsertDailySession({ gameId: game.id, date: day.date, minutes, ...(platform && { platform }) });
        } catch (err) {
            if (err instanceof AuthError) throw err;
            day.error = String(err.message ?? err);
            continue;
        }
        for (const d of same) {
            d.synced = true;
            delete d.error;
        }
        pushed.push({ game: game.title ?? game.slug, date: day.date, minutes });
    }
    return pushed;
}
