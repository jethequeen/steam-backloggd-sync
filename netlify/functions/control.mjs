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
 *   POST {"action":"play","name":"SoulCalibur II (USA)","date":"2026-10-13","minutes":45}
 *                                            day total from the Steam Deck watcher (deck/)
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
                const backloggd = await makeBackloggd();
                const hits = await backloggd.autocomplete(body.slug.replace(/-/g, ' '));
                const hit = hits.find((h) => h.slug === body.slug);
                if (!hit) return json(404, { error: `no Backloggd game with slug ${body.slug}`, candidates: hits.slice(0, 5) });
                state.mappings[appid] = hit;
            }
            delete state.unmapped[appid];
            await saveState(state);
            return json(200, { appid, mapping: state.mappings[appid] });
        }

        case 'play': {
            const { name, date } = body;
            const minutes = Number(body.minutes);
            if (typeof name !== 'string' || !name.trim() || name.length > 200) return json(400, { error: 'name required' });
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) return json(400, { error: 'date must be YYYY-MM-DD' });
            if (!Number.isFinite(minutes) || minutes < 0 || minutes > 1440) return json(400, { error: 'minutes must be 0-1440' });
            await saveReport({ name: name.trim(), date, minutes });
            await markDeckSeen(name.trim());
            return json(202, { ok: true });
        }

        case 'ping':
            await markDeckSeen();
            return json(200, { ok: true });

        case 'cookie':
            if (!body.value) return json(400, { error: 'value required' });
            await saveCookie(body.value);
            return json(200, { ok: true });

        default:
            return json(400, { error: 'unknown action' });
    }
};
