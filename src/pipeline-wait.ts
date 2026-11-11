import { parseArgs } from 'node:util';
import { waitForPipelineWatchResult } from './pipeline-watch';

async function main(): Promise<number> {
	const { values } = parseArgs({ options: { url: { type: 'string' }, 'timeout-seconds': { type: 'string' } }, strict: true });
	const snapshot = await waitForPipelineWatchResult(values.url ?? '', Number(values['timeout-seconds']));
	console.log(JSON.stringify(snapshot));
	if (snapshot.state === 'timed_out') { return 2; }
	if (snapshot.state === 'stopped') { return 3; }
	if (snapshot.state === 'error') { return 4; }
	return snapshot.result === 'Succeeded' ? 0 : 1;
}

void main().then(code => { process.exitCode = code; }).catch(() => {
	console.error(JSON.stringify({ state: 'error', message: 'Pipeline watch unavailable or invalid. The extension host may have stopped; inspect the run explicitly. No pipeline operation was performed.' }));
	process.exitCode = 4;
});