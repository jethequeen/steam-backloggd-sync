import { runSync } from '../../lib/run.mjs';

export default async () => {
    const result = await runSync();
    console.log(JSON.stringify(result));
};

export const config = { schedule: '*/15 * * * *' };
