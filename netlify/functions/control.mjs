import { reopenChoice } from '../../lib/sync.mjs';
import { loadDeckSeen, loadState, makeBackloggd, markDeckSeen, runSync, saveCookie, saveReport, saveState } from '../../lib/run.mjs';

const json = (status, body) => Response.json(body, { status });

/**
 * Owner-only control endpoint, behind `Authorization: Bearer $SYNC_TOKEN`.
 *
 *   GET                                      status: last run, errors, pending days, unmapped games
 *   POST {"action":"run"}                    run a sync now
 *   POST {"action":"map","appid":N,"slug":"hades"}   pin a Steam app to a Backloggd game
 *   POST {"action":"map","appid":N,"skip":true}      never sync this app
 *   Non-Steam games use their key from `unmapped` instead of a number: "appid":"ns:Chrono Trigger"
 *   POST {"action":"cookie","value":"..."}  replace the Backloggd session cookie without a redeploy
 *   POST {"action":"play","name":"SoulCalibur II (USA)","date":"2026-10-13","minutes":45,"system":"gc"}
 *                                            day total from the Steam Deck watcher (deck/)
 *   POST {"action":"play","appid":632470,"name":"Disco Elysium","date":"...","minutes":30}
 *                                            same for a Steam game the Deck saw running
 *   POST {"action":"play","name":"The Great Ace Attorney Chronicles","date":"...","minutes":30,"system":"switch","device":"phone"}
 *                                            same from the Android phone (android/); "backfill":true lifts the
 *                                            one-day cap for the history Eden already held at install
 *   POST {"action":"rechoose","appid":632470}  forget a game's entry and offer the choice again
 *   POST {"action":"inspect","gameId":1565}  raw Backloggd log for one game (debugging)
 *   POST {"action":"ping"}                   connection test from the watcher's --test
 */
export default async (req) => {
    const token = process.env.SYNC_TOKEN;
    if (!token || req.headers.get('authorization') !== `Bearer ${token}`) {
        return json(401, { error: 'unauthorized' });
    }

    if (req.method === 'GET') {
        const state = await loadState();
        return json(200, {
            lastRun: state.lastRun,
            lastError: state.lastError,
            log: state.log,
            pending: Object.values(state.days).filter((d) => !d.synced),
            unmapped: state.unmapped,
            mappings: state.mappings,
            deck: await loadDeckSeen(),
            phone: await loadDeckSeen('phone'),
        });
    }

    if (req.method !== 'POST') return json(405, { error: 'method not allowed' });
    const body = await req.json().catch(() => ({}));

    switch (body.action) {
        case 'run':
            return json(200, await runSync());

        case 'map': {
            const appid = String(body.appid ?? '').startsWith('ns:') ? body.appid : Number(body.appid);
            if (typeof appid === 'number' && !Number.isFinite(appid)) return json(400, { error: 'appid required' });
            const state = await loadState();
            if (body.skip) {
                state.mappings[appid] = null;
            } else {
                if (!body.slug) return json(400, { error: 'slug or skip required' });
                // A candidate the page offered (the dropdown) needs no new lookup.
                let hit = state.unmapped[appid]?.candidates?.find((c) => c.slug === body.slug);
                if (!hit) {
                    const backloggd = await makeBackloggd();
                    const hits = await backloggd.autocomplete(body.slug.replace(/-/g, ' '));
                    hit = hits.find((h) => h.slug === body.slug);
                    if (!hit) return json(404, { error: `no Backloggd game with slug ${body.slug}`, candidates: hits.slice(0, 5) });
                }
                state.mappings[appid] = hit;
            }
            delete state.unmapped[appid];
            await saveState(state);
            return json(200, { appid, mapping: state.mappings[appid] });
        }

        case 'rechoose': {
            const appid = String(body.appid ?? '').startsWith('ns:') ? body.appid : Number(body.appid);
            if (typeof appid === 'number' && !Number.isFinite(appid)) return json(400, { error: 'appid required' });
            const state = await loadState();
            if (!(await reopenChoice(state, await makeBackloggd(), appid))) return json(404, { error: 'unknown game' });
            await saveState(state);
            return json(200, { appid, choice: state.unmapped[appid] });
        }

        case 'play': {
            const { name, date } = body;
            const minutes = Number(body.minutes);
            const device = typeof body.device === 'string' && /^[a-z0-9_-]{1,20}$/.test(body.device) ? body.device : undefined;
            // The phone's first report can carry Eden's whole history, dated the install day.
            const maxMinutes = body.backfill === true && device ? 100_000 : 1440;
            if (typeof name !== 'string' || !name.trim() || name.length > 200) return json(400, { error: 'name required' });
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) return json(400, { error: 'date must be YYYY-MM-DD' });
            if (!Number.isFinite(minutes) || minutes < 0 || minutes > maxMinutes) return json(400, { error: `minutes must be 0-${maxMinutes}` });
            const system = typeof body.system === 'string' && /^[a-z0-9_-]{1,20}$/.test(body.system) ? body.system : undefined;
            const appid = Number.isInteger(body.appid) && body.appid > 0 && body.appid < 2 ** 31 ? body.appid : undefined;
            await saveReport({ name: name.trim(), date, minutes, system: appid ? undefined : system, appid, device: appid ? undefined : device });
            await markDeckSeen(name.trim(), device);
            return json(202, { ok: true });
        }

        case 'inspect': {
            // Raw Backloggd log for one game, to check what the site stores (platform format, sessions).
            const gameId = Number(body.gameId);
            if (!Number.isInteger(gameId) || gameId <= 0) return json(400, { error: 'gameId required' });
            const backloggd = await makeBackloggd();
            return json(200, await backloggd.getGameLog(gameId));
        }

        case 'ping':
            await markDeckSeen(null, typeof body.device === 'string' && /^[a-z0-9_-]{1,20}$/.test(body.device) ? body.device : null);
            return json(200, { ok: true });

        case 'cookie':
            if (!body.value) return json(400, { error: 'value required' });
            await saveCookie(body.value);
            return json(200, { ok: true });

        default:
            return json(400, { error: 'unknown action' });
    }
};
