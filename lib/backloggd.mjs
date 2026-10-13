/**
 * Minimal Backloggd client. Backloggd has no public API: these are the same endpoints
 * the site's own front end calls, as documented by github.com/DenisionSoft/backloggd-mcp.
 * Any of them can change without notice.
 */

export const BASE_URL = 'https://backloggd.com';
const USER_AGENT = 'steam-backloggd-sync/0.1 (personal playtime sync; github.com/jethequeen/steam-backloggd-sync)';
const WRITE_GAP_MS = 2500;
// Marks the sessions this tool owns, so it only ever rewrites its own entries.
export const SESSION_NOTE = 'Steam';

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
     */
    async upsertDailySession({ gameId, date, minutes }) {
        const userId = await this.ensureAuthenticated();
        let { log, playthroughs } = await this.getGameLog(gameId);

        if (playthroughs.length === 0) {
            await this.postLog(userId, gameId, log, { 'playthroughs[0][id]': -1, 'playthroughs[0][title]': 'Log', 'playthroughs[0][sync_sessions]': 'false' }, { createPlaying: true });
            ({ log, playthroughs } = await this.getGameLog(gameId));
            if (playthroughs.length === 0) throw new Error(`Could not create a playthrough for Backloggd game ${gameId}`);
        }

        const playthrough = playthroughs.at(-1);
        const sessions = normaliseSessions(playthrough.play_dates);
        const mine = sessions.find((s) => s.startDate === date && s.note === SESSION_NOTE);
        const wanted = { hours: Math.floor(minutes / 60), minutes: minutes % 60 };
        if (mine && mine.hours === wanted.hours && mine.minutes === wanted.minutes) return { changed: false };

        const next = mine
            ? sessions.map((s) => (s === mine ? { ...s, ...wanted } : s))
            : [...sessions, { id: -1, startDate: date, endDate: date, note: SESSION_NOTE, status: null, ...wanted }];

        await this.postLog(userId, gameId, log, {
            'playthroughs[0][id]': playthrough.id,
            'playthroughs[0][title]': playthrough.title ?? 'Log',
            'playthroughs[0][rating]': playthrough.rating ?? 0,
            'playthroughs[0][review]': playthrough.review ?? '',
            'playthroughs[0][review_spoilers]': String(Boolean(playthrough.review_spoilers)),
            'playthroughs[0][is_master]': String(Boolean(playthrough.is_master)),
            'playthroughs[0][is_replay]': String(Boolean(playthrough.is_replay)),
            'playthroughs[0][sync_sessions]': 'true',
            ...buildSessionFields(playthrough.id, next),
        });
        return { changed: true };
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
        form[`${p}[start_date]`] = '';
        form[`${p}[finish_date]`] = '';
    });
    return form;
}
