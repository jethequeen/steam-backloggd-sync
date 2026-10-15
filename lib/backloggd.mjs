/**
 * Minimal Backloggd client. Backloggd has no public API: these are the same endpoints
 * the site's own front end calls, as documented by github.com/DenisionSoft/backloggd-mcp.
 * Any of them can change without notice.
 */

export const BASE_URL = 'https://backloggd.com';
const USER_AGENT = 'steam-backloggd-sync/0.1 (personal playtime sync; github.com/jethequeen/steam-backloggd-sync)';
const WRITE_GAP_MS = 2500;
// Sessions written before October 2026 carried this note; the ones written since carry none
// and are found again by the id remembered after writing them.
export const LEGACY_SESSION_NOTE = 'Steam';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class AuthError extends Error {}

export class BackloggdClient {
    constructor({ sessionCookie, username, password, fetchImpl = fetch }) {
        this.cookies = new Map([['ne_cookies_consent', 'true']]);
        if (sessionCookie) this.cookies.set('_backloggd_session', sessionCookie.trim().replace(/^_backloggd_session=/, ''));
        this.username = username;
        this.password = password;
        this.fetchImpl = fetchImpl;
        this.csrf = null;
        this.userId = null;
        this.lastWrite = 0;
    }

    /** Current session cookie; Rails rotates it, so callers persist this after a run. */
    get sessionCookie() {
        return this.cookies.get('_backloggd_session') ?? null;
    }

    async request(path, { method = 'GET', form, query, write = false, csrf = method !== 'GET', accept } = {}) {
        if (write) {
            const wait = this.lastWrite + WRITE_GAP_MS - Date.now();
            if (wait > 0) await sleep(wait);
        }
        const url = new URL(path, BASE_URL);
        if (query) url.search = new URLSearchParams(query).toString();

        const headers = {
            'User-Agent': USER_AGENT,
            Accept: accept ?? 'text/html,application/json,*/*;q=0.8',
            'X-Requested-With': 'XMLHttpRequest',
            Referer: `${BASE_URL}/`,
            Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        };
        if (csrf) headers['X-CSRF-Token'] = await this.getCsrf();
        let body;
        if (form) {
            headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
            body = new URLSearchParams(Object.entries(form).map(([k, v]) => [k, String(v ?? '')])).toString();
        }

        const res = await this.fetchImpl(url, { method, headers, body, redirect: 'manual' });
        this.absorbCookies(res);
        if (write) this.lastWrite = Date.now();
        return res;
    }

    absorbCookies(res) {
        const list = res.headers.getSetCookie?.() ?? [];
        for (const line of list) {
            const [pair] = line.split(';');
            const i = pair.indexOf('=');
            if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
        }
    }

    async getCsrf() {
        if (this.csrf) return this.csrf;
        const res = await this.request('/', { csrf: false });
        const html = await res.text();
        this.csrf = /<meta name="csrf-token" content="([^"]+)"/.exec(html)?.[1] ?? null;
        if (!this.csrf) throw new Error('Could not read the CSRF token from backloggd.com');
        return this.csrf;
    }

    /** Confirms the session works and learns the numeric user id. Logs in again if allowed. */
    async ensureAuthenticated() {
        if (this.userId) return this.userId;
        if (this.sessionCookie) {
            this.userId = await this.probeIdentity();
            if (this.userId) return this.userId;
        }
        if (!this.username || !this.password) {
            throw new AuthError('Backloggd session expired and no username/password is configured.');
        }
        await this.login();
        this.userId = await this.probeIdentity();
        if (!this.userId) throw new AuthError('Backloggd login did not produce a valid session.');
        return this.userId;
    }

    async probeIdentity() {
        const res = await this.request('/settings/', { csrf: false });
        if (res.status !== 200) return null;
        const html = await res.text();
        if (!html.includes('/users/sign_out')) return null;
        return /user_id=["']?(\d+)/.exec(html)?.[1] ?? null;
    }

    async login() {
        this.cookies.delete('_backloggd_session');
        this.csrf = null;
        const page = await this.request('/users/sign_in', { csrf: false });
        const html = await page.text();
        const formHtml = /<form[^>]*action="\/users\/sign_in"[\s\S]*?<\/form>/.exec(html)?.[0] ?? html;
        const token = /name="authenticity_token"[^>]*value="([^"]+)"/.exec(formHtml)?.[1];
        if (!token) throw new AuthError('Could not read the Backloggd login form.');

        const res = await this.request('/users/sign_in', {
            method: 'POST',
            csrf: false,
            write: true,
            form: {
                authenticity_token: token,
                'user[login]': this.username,
                'user[password]': this.password,
                'user[remember_me]': '1',
            },
        });
        // Devise answers a bad login with 422 and a re-rendered form; success is a redirect.
        if (res.status === 422) throw new AuthError('Backloggd rejected the username/password.');
        this.csrf = null;
    }

    /** Autocomplete hits: [{ id, slug, title, year }]. */
    async autocomplete(query) {
        const res = await this.request('/autocomplete.json', { query: { query }, accept: 'application/json' });
        if (!res.ok) throw new Error(`Backloggd autocomplete HTTP ${res.status}`);
        const data = await res.json().catch(() => ({}));
        return (data.suggestions ?? [])
            .map((s) => ({
                id: Number(s.data?.id),
                slug: s.data?.slug,
                title: s.data?.title ?? s.value,
                year: s.data?.year ? Number(s.data.year) : null,
            }))
            .filter((h) => Number.isFinite(h.id) && h.slug);
    }

    /** From a game's page: release platform slugs (["ngc", "ps2", ...]) and cover image URL. */
    async gameDetails(slug) {
        const res = await this.request(`/games/${encodeURIComponent(slug)}/`);
        if (!res.ok) throw new Error(`Backloggd game page HTTP ${res.status}`);
        const html = await res.text();
        const platforms = [...new Set([...html.matchAll(/game-page-platform[^>]*release_platform:([a-z0-9-]+)/g)].map((m) => m[1]))];
        const cover = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/.exec(html)?.[1]
            ?? /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/.exec(html)?.[1]
            ?? null;
        return { platforms, cover };
    }

    /** Other editions of a game (Final Cut, remasters, ...) from the frame its page loads: [{ id, slug, title }]. */
    async editions(gameId) {
        const res = await this.request(`/update_game_detail/${gameId}/editions/`);
        if (!res.ok) return [];
        const html = await res.text();
        return html.split(/class=["']?card game-cover/).slice(1).map((card) => ({
            id: Number(/game_id=["']?(\d+)/.exec(card)?.[1]),
            slug: /href=["']?\/games\/([a-z0-9-]+)/.exec(card)?.[1],
            title: decodeEntities(/alt=["']([^"']*)["']/.exec(card)?.[1] ?? ''),
        })).filter((g) => Number.isFinite(g.id) && g.slug);
    }

    /** The user's full state for one game, including playthroughs and their dated sessions. */
    async getGameLog(gameId) {
        const res = await this.request(`/log/edit/${gameId}`, { accept: 'application/json' });
        if (!res.ok) throw new Error(`Backloggd log/edit HTTP ${res.status}`);
        const data = await res.json();
        const raw = data.playthroughs ?? [];
        const playthroughs = (Array.isArray(raw) ? raw : Object.values(raw)).filter(Boolean);
        return { log: data.game_log ?? null, playthroughs };
    }

    /**
     * Sets this tool's session on `date` to `minutes`, creating the log, the playthrough
     * and the session as needed. Re-running with the same values is a no-op on the site.
     * `sessionId` is the session written for this day before, if any; `pushedBefore` says
     * one was written even when its id is unknown. Returns the session's id when it knows it.
     */
    async upsertDailySession({ gameId, date, minutes, platform = null, sessionId = null, pushedBefore = false }) {
        const userId = await this.ensureAuthenticated();
        let { log, playthroughs } = await this.getGameLog(gameId);
        // A game already shelved as Played or Completed was started long ago, whatever the journal says.
        const alreadyPlayed = Boolean(log?.is_play);

        if (playthroughs.length === 0) {
            await this.postLog(userId, gameId, log, { 'playthroughs[0][id]': -1, 'playthroughs[0][title]': 'Log', 'playthroughs[0][sync_sessions]': 'false' }, { createPlaying: true });
            ({ log, playthroughs } = await this.getGameLog(gameId));
            if (playthroughs.length === 0) throw new Error(`Could not create a playthrough for Backloggd game ${gameId}`);
        }

        const playthrough = playthroughs.at(-1);
        const sessions = normaliseSessions(playthrough.play_dates);
        const sameDay = sessions.filter((s) => s.startDate === date);
        const unnoted = sameDay.filter((s) => !s.note);
        const mine = (sessionId != null && sessions.find((s) => String(s.id) === String(sessionId)))
            || sameDay.find((s) => s.note === LEGACY_SESSION_NOTE)
            // Written before but its id was lost: the day's only session without a note is ours.
            || (pushedBefore && unnoted.length === 1 ? unnoted[0] : null);
        const wanted = { hours: Math.floor(minutes / 60), minutes: minutes % 60 };
        // An old session still marked "Steam" loses the note on its next write.
        const dropNote = mine?.note === LEGACY_SESSION_NOTE;
        // A platform already on the log (set by hand, or by an earlier run) always wins.
        const current = playthrough.played_platform ?? playthrough.platform ?? null;
        const setPlatform = Boolean(platform) && (current === null || current === '');
        if (mine && mine.hours === wanted.hours && mine.minutes === wanted.minutes && !setPlatform && !dropNote) return { changed: false, sessionId: mine.id };

        // The very first session of a playthrough is marked as its start ("Started" in the journal).
        const startMark = sessions.length === 0 && !alreadyPlayed ? date : '';
        const next = mine
            ? sessions.map((s) => (s === mine ? { ...s, ...wanted, ...(dropNote && { note: null }) } : s))
            : [...sessions, { id: -1, startDate: date, endDate: date, note: null, status: null, startMark, finishMark: '', ...wanted }];

        const fields = playthroughFields(playthrough, next);
        const keep = current === null || current === '' ? {} : { 'playthroughs[0][platform]': current, 'playthroughs[0][played_platform]': current };
        let result = { changed: true };
        if (!setPlatform) {
            await this.postLog(userId, gameId, log, { ...fields, ...keep });
        } else {
            try {
                await this.postLog(userId, gameId, log, { ...fields, 'playthroughs[0][platform]': platform, 'playthroughs[0][played_platform]': platform });
                result.platform = platform;
            } catch (err) {
                // An id Backloggd does not take must never hold the play time back.
                if (err instanceof AuthError) throw err;
                await this.postLog(userId, gameId, log, fields);
                result.platformError = String(err.message ?? err);
            }
        }
        result.sessionId = mine ? mine.id : await this.newSessionId(gameId, date, sessions);
        return result;
    }

    /** The id Backloggd gave the session just added on `date`: the one that was not there before. */
    async newSessionId(gameId, date, before) {
        try {
            const known = new Set(before.map((s) => String(s.id)));
            const { playthroughs } = await this.getGameLog(gameId);
            const added = normaliseSessions(playthroughs.at(-1)?.play_dates).filter((s) => s.startDate === date && !known.has(String(s.id)));
            return added.length === 1 ? added[0].id : null;
        } catch {
            return null;
        }
    }

    /**
     * Once the game is set to Played, Completed or Retired on Backloggd, marks its last session
     * as the finish ("Finished" in the journal). Returns the session's date when it marked one,
     * `true` when the game is done but there is nothing to mark, and `false` while it is not done.
     */
    async markFinished(gameId) {
        const { log, playthroughs } = await this.getGameLog(gameId);
        // Saves from this tool send status "played" without `is_play`: only the owner sets both.
        if (!log?.is_play || !FINISHED_STATUSES.has(log.status)) return false;
        const playthrough = playthroughs.at(-1);
        const sessions = normaliseSessions(playthrough?.play_dates);
        if (!sessions.length || sessions.some((s) => s.finishMark)) return true;
        const last = sessions.reduce((a, b) => ((b.endDate ?? b.startDate) > (a.endDate ?? a.startDate) ? b : a));
        const date = last.endDate ?? last.startDate;
        const next = sessions.map((s) => (s === last ? { ...s, finishMark: date } : s));
        const current = playthrough.played_platform ?? playthrough.platform ?? null;
        const keep = current === null || current === '' ? {} : { 'playthroughs[0][platform]': current, 'playthroughs[0][played_platform]': current };
        await this.postLog(await this.ensureAuthenticated(), gameId, log, { ...playthroughFields(playthrough, next), ...keep });
        return date;
    }

    /**
     * Removes sessions this tool wrote from the game's last playthrough: the ids given, any
     * old session noted "Steam", and on the `dates` given the day's only session without a
     * note. With `unlogIfEmpty`, a log left with nothing of the owner's own (no session, no
     * rating, no review, not marked played) is removed from the library too.
     * Returns { removed: [dates], unlogged }.
     */
    async removeSessions(gameId, { ids = [], dates = [], unlogIfEmpty = false } = {}) {
        const userId = await this.ensureAuthenticated();
        let { log, playthroughs } = await this.getGameLog(gameId);
        const playthrough = playthroughs.at(-1);
        const sessions = normaliseSessions(playthrough?.play_dates);
        const wantedIds = new Set(ids.filter((id) => id != null).map(String));
        const mine = sessions.filter((s) => wantedIds.has(String(s.id)) || s.note === LEGACY_SESSION_NOTE
            || (dates.includes(s.startDate) && !s.note && sessions.filter((o) => o.startDate === s.startDate && !o.note).length === 1));
        if (mine.length) {
            const keepSessions = sessions.filter((s) => !mine.includes(s));
            const current = playthrough.played_platform ?? playthrough.platform ?? null;
            const keep = current === null || current === '' ? {} : { 'playthroughs[0][platform]': current, 'playthroughs[0][played_platform]': current };
            await this.postLog(userId, gameId, log, { ...playthroughFields(playthrough, keepSessions), ...keep });
            ({ log, playthroughs } = await this.getGameLog(gameId));
            const left = new Set(normaliseSessions(playthroughs.at(-1)?.play_dates).map((s) => String(s.id)));
            if (mine.some((s) => left.has(String(s.id)))) throw new Error('Backloggd a gardé la session : suppression refusée.');
        }
        const removed = mine.map((s) => s.startDate);
        const ownerData = log?.is_play || log?.rating || playthroughs.length > 1
            || playthroughs.some((p) => normaliseSessions(p.play_dates).length || p.rating || p.review);
        if (!unlogIfEmpty || !log?.id || ownerData) return { removed, unlogged: false };
        const res = await this.request('/unlog/', { method: 'DELETE', write: true, form: { game_id: gameId, log_id: log.id } });
        if (res.status === 401 || res.status === 403) throw new AuthError(`Backloggd refused the write (HTTP ${res.status}).`);
        return { removed, unlogged: res.ok };
    }

    async postLog(userId, gameId, log, playthroughFields, { createPlaying = false } = {}) {
        // Re-send the current shelf state so saving sessions never moves the game.
        const form = {
            game_id: gameId,
            ...playthroughFields,
            'log[game_liked]': String(Boolean(log?.game_liked)),
            'log[is_play]': String(Boolean(log?.is_play)),
            'log[is_playing]': String(createPlaying || Boolean(log?.is_playing)),
            'log[is_backlog]': String(Boolean(log?.is_backlog)),
            'log[is_wishlist]': String(Boolean(log?.is_wishlist)),
            'log[status]': log?.status ?? 'played',
            'log[id]': log?.id ?? '',
            'log[time_source]': '1',
            modal_type: 'full',
        };
        const res = await this.request(`/api/user/${userId}/log/${gameId}`, { method: 'POST', write: true, form });
        if (res.status === 401 || res.status === 403) throw new AuthError(`Backloggd refused the write (HTTP ${res.status}).`);
        if (!res.ok) throw new Error(`Backloggd log save HTTP ${res.status}`);
    }
}

// Shelved and Abandoned are unfinished games: no finish mark.
const FINISHED_STATUSES = new Set(['played', 'completed', 'retired']);

/** The playthrough fields a save needs, re-sent as they are, with this set of sessions. */
function playthroughFields(playthrough, sessions) {
    return {
        'playthroughs[0][id]': playthrough.id,
        'playthroughs[0][title]': playthrough.title ?? 'Log',
        'playthroughs[0][rating]': playthrough.rating ?? 0,
        'playthroughs[0][review]': playthrough.review ?? '',
        'playthroughs[0][review_spoilers]': String(Boolean(playthrough.review_spoilers)),
        'playthroughs[0][is_master]': String(Boolean(playthrough.is_master)),
        'playthroughs[0][is_replay]': String(Boolean(playthrough.is_replay)),
        'playthroughs[0][sync_sessions]': 'true',
        ...buildSessionFields(playthrough.id, sessions),
    };
}

const decodeEntities = (s) => s.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'" }[e]));

function shiftDate(date, days) {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number.parseInt(String(v), 10);
    return Number.isFinite(n) ? n : null;
}

/** Backloggd stores a session as [range_start_date, range_end_date) with an exclusive end. */
export function normaliseSessions(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.filter(Boolean).map((s) => {
        const start = s.range_start_date ?? null;
        const rawEnd = s.range_end_date ?? null;
        return {
            id: s.id,
            startDate: start,
            endDate: rawEnd && start && rawEnd !== start ? shiftDate(rawEnd, -1) : (rawEnd ?? start),
            hours: num(s.hours),
            minutes: num(s.minutes),
            note: s.note?.trim() || null,
            status: s.status ?? null,
            // Kept as Backloggd sent them, so a save never clears a Started/Finished mark.
            startMark: s.start_date ?? '',
            finishMark: s.finish_date ?? '',
        };
    });
}

/** The `dates[playthroughId][i][...]` fields; the save replaces the whole set, so all sessions go. */
export function buildSessionFields(playthroughId, sessions) {
    const form = {};
    sessions.forEach((s, i) => {
        const p = `dates[${playthroughId}][${i}]`;
        form[`${p}[id]`] = s.id;
        form[`${p}[range_start_date]`] = s.startDate;
        form[`${p}[range_end_date]`] = shiftDate(s.endDate ?? s.startDate, 1);
        // The server only persists sessions flagged as edited.
        form[`${p}[edited]`] = 'true';
        form[`${p}[note]`] = s.note ?? '';
        form[`${p}[hours]`] = s.hours ?? '';
        form[`${p}[minutes]`] = s.minutes ?? '';
        form[`${p}[status]`] = s.status ?? '';
        form[`${p}[start_date]`] = s.startMark ?? '';
        form[`${p}[finish_date]`] = s.finishMark ?? '';
    });
    return form;
}
