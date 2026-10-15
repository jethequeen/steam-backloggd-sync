import { deleteGame, deleteSession, reopenChoice, restoreGame } from '../../lib/sync.mjs';
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
 *                                            same from the Android phone (android/)
 *   POST {"action":"rechoose","appid":632470}  forget a game's entry and offer the choice again
 *   POST {"action":"deleteSession","gameId":1565,"date":"2026-10-13"}  delete one day's session, here and on Backloggd
 *   POST {"action":"deleteGame","gameId":1565}  delete a game logged by mistake and never send it again
 *   POST {"action":"restore","gameId":1565}  take a game off the deleted list
 *   POST {"action":"unskip","appid":N}       forget "never sync" for an app: it is offered for choice again
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
            history: Object.values(state.history ?? {}).map(({ sessionId, ...h }) => h),
            games: state.games ?? {},
            finished: state.finished ?? {},
            blocked: state.blocked ?? {},
            skipped: Object.entries(state.mappings).filter(([, m]) => m === null)
                .map(([appid]) => ({ appid, name: state.skippedNames?.[appid] ?? Object.values(state.days).find((d) => String(d.appid) === appid)?.name ?? null })),
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
                if (state.unmapped[appid]?.name) (state.skippedNames ??= {})[appid] = state.unmapped[appid].name;
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
            if (typeof name !== 'string' || !name.trim() || name.length > 200) return json(400, { error: 'name required' });
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) return json(400, { error: 'date must be YYYY-MM-DD' });
            if (!Number.isFinite(minutes) || minutes < 0 || minutes > 1440) return json(400, { error: 'minutes must be 0-1440' });
            const system = typeof body.system === 'string' && /^[a-z0-9_-]{1,20}$/.test(body.system) ? body.system : undefined;
            const appid = Number.isInteger(body.appid) && body.appid > 0 && body.appid < 2 ** 31 ? body.appid : undefined;
            await saveReport({ name: name.trim(), date, minutes, system: appid ? undefined : system, appid, device: appid ? undefined : device });
            await markDeckSeen(name.trim(), device);
            return json(202, { ok: true });
        }

        case 'deleteSession':
        case 'deleteGame':
        case 'restore': {
            const gameId = Number(body.gameId);
            if (!Number.isInteger(gameId) || gameId <= 0) return json(400, { error: 'gameId required' });
            if (body.action === 'deleteSession' && !/^\d{4}-\d{2}-\d{2}$/.test(body.date ?? '')) return json(400, { error: 'date must be YYYY-MM-DD' });
            const state = await loadState();
            let result;
            if (body.action === 'restore') {
                if (!restoreGame(state, gameId)) return json(404, { error: 'not on the deleted list' });
            } else {
                const backloggd = await makeBackloggd();
                backloggd.deleteVariant = state.deleteVariant;
                try {
                    result = body.action === 'deleteGame'
                        ? await deleteGame(state, backloggd, gameId)
                        : await deleteSession(state, backloggd, gameId, body.date);
                } catch (err) {
                    return json(502, { error: String(err.message ?? err) });
                }
                state.deleteVariant = backloggd.deleteVariant;
                if (result === null) return json(404, { error: 'unknown session' });
            }
            await saveState(state);
            return json(200, { ok: true, ...result });
        }

        case 'unskip': {
            const appid = String(body.appid ?? '').startsWith('ns:') ? body.appid : Number(body.appid);
            const state = await loadState();
            if (state.mappings[appid] !== null) return json(404, { error: 'not skipped' });
            delete state.mappings[appid];
            delete state.skippedNames?.[appid];
            await saveState(state);
            return json(200, { ok: true });
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
