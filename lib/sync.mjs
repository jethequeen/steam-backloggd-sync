import { AuthError } from './backloggd.mjs';

// Netlify stops scheduled functions at 30 s; leave room to save state.
const DEFAULT_BUDGET_MS = 20_000;
const KEEP_SYNCED_DAYS = 14;

export function emptyState() {
    return { snapshot: null, days: {}, mappings: {}, unmapped: {}, lastRun: null, lastError: null };
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

        const key = `${g.appid}|${date}`;
        const day = next.days[key] ?? { appid: g.appid, name: g.name, date, minutes: 0 };
        day.minutes += delta;
        day.synced = false;
        next.days[key] = day;
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

        try {
            await backloggd.upsertDailySession({ gameId: game.id, date: day.date, minutes: day.minutes });
        } catch (err) {
            if (err instanceof AuthError) throw err;
            day.error = String(err.message ?? err);
            continue;
        }
        day.synced = true;
        delete day.error;
        pushed.push({ game: game.title ?? game.slug, date: day.date, minutes: day.minutes });
    }
    return pushed;
}
