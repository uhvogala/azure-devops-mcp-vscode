import { randomBytes } from 'node:crypto';
import { get } from 'node:http';
import { Build, BuildResult, BuildStatus } from 'azure-devops-node-api/interfaces/BuildInterfaces';
import * as z from 'zod/v4';

export const pipelineWatchRequestSchema = z.object({
	organization: z.string().min(1),
	project: z.string().min(1),
	runId: z.number().int().positive(),
	timeoutSeconds: z.number().int().min(1).max(7200),
});

export const pipelineWatchProbeSchema = z.object({
	delaySeconds: z.number().int().min(1).max(120).default(20),
	timeoutSeconds: z.number().int().min(1).max(180).default(60),
	result: z.enum(['Succeeded', 'Failed']).default('Succeeded'),
});

export const pipelineWatchCommandSchema = z.discriminatedUnion('action', [
	z.object({ action: z.literal('start'), request: pipelineWatchRequestSchema }),
	z.object({ action: z.literal('probe'), request: pipelineWatchProbeSchema }),
	z.object({ action: z.literal('get'), watchId: z.string().regex(/^[a-f0-9]{64}$/) }),
	z.object({ action: z.literal('list') }),
	z.object({ action: z.literal('inspect') }),
	z.object({ action: z.literal('stop'), watchId: z.string().regex(/^[a-f0-9]{64}$/) }),
]);

export const pipelineWatchSnapshotSchema = pipelineWatchRequestSchema.extend({
	watchId: z.string().regex(/^[a-f0-9]{64}$/),
	state: z.enum(['watching', 'completed', 'timed_out', 'stopped', 'error']),
	createdAt: z.string(), expiresAt: z.string(),
	status: z.string().optional(), result: z.string().optional(),
	sourceVersion: z.string().optional(), sourceBranch: z.string().optional(),
	url: z.string().optional(), message: z.string().optional(),
});

export interface PipelineWatchRequest {
	organization: string;
	project: string;
	runId: number;
	timeoutSeconds: number;
}

export interface PipelineWatchSnapshot extends PipelineWatchRequest {
	watchId: string;
	state: 'watching' | 'completed' | 'timed_out' | 'stopped' | 'error';
	createdAt: string;
	expiresAt: string;
	status?: string;
	result?: string;
	sourceVersion?: string;
	sourceBranch?: string;
	url?: string;
	message?: string;
}

interface WatchEntry {
	snapshot: PipelineWatchSnapshot;
	readRun: () => Promise<Build>;
	pollIntervalMs: number;
	result: Promise<PipelineWatchSnapshot>;
	resolve: (snapshot: PipelineWatchSnapshot) => void;
	poll?: NodeJS.Timeout;
	deadline?: NodeJS.Timeout;
}

export async function waitForPipelineWatchResult(resultUrl: string, timeoutSeconds: number, signal?: AbortSignal): Promise<PipelineWatchSnapshot> {
	const url = new URL(resultUrl);
	if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password
		|| url.search || url.hash || !/^\/pipeline-watch-result\/[a-f0-9]{64}$/.test(url.pathname)
		|| !Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 7205) {
		throw new Error('Invalid pipeline watch handoff.');
	}
	const deadline = AbortSignal.timeout(timeoutSeconds * 1000);
	const payload = await new Promise<unknown>((resolve, reject) => {
		const request = get(url, { signal: signal ? AbortSignal.any([signal, deadline]) : deadline }, response => {
			if (response.statusCode !== 200) { response.resume(); reject(new Error('The pipeline watch is unavailable.')); return; }
			let body = '';
			response.setEncoding('utf8');
			response.on('data', chunk => {
				body += String(chunk);
				if (body.length > 65_536) { response.destroy(new Error('Invalid pipeline watch result.')); }
			});
			response.on('error', reject);
			response.on('end', () => {
				try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
			});
		});
		request.on('error', reject);
	});
	const snapshot = pipelineWatchSnapshotSchema.parse(payload);
	if (!url.pathname.endsWith(`/${snapshot.watchId}`) || snapshot.state === 'watching') {
		throw new Error('Invalid pipeline watch result.');
	}
	return snapshot;
}

export class PipelineWatchStore {
	private readonly watches = new Map<string, WatchEntry>();

	public constructor(
		private readonly readRun: (request: PipelineWatchRequest) => Promise<Build>,
		private readonly pollIntervalMs = 15_000,
	) {}

	public start(request: PipelineWatchRequest): PipelineWatchSnapshot {
		return this.startWatch(request, () => this.readRun(request), this.pollIntervalMs);
	}

	public startProbe(request: z.infer<typeof pipelineWatchProbeSchema>): PipelineWatchSnapshot {
		const completesAt = Date.now() + request.delaySeconds * 1000;
		return this.startWatch({
			organization: 'local-prototype', project: 'no-azure-operation',
			runId: randomBytes(6).readUIntBE(0, 6) + 1, timeoutSeconds: request.timeoutSeconds,
		}, async () => ({
			status: Date.now() >= completesAt ? BuildStatus.Completed : BuildStatus.InProgress,
			result: Date.now() >= completesAt ? BuildResult[request.result] : undefined,
			sourceVersion: 'local-simulation', sourceBranch: 'refs/heads/local-prototype',
		}), 100);
	}

	public get(watchId: string): PipelineWatchSnapshot {
		return { ...this.find(watchId).snapshot };
	}

	private startWatch(request: PipelineWatchRequest, readRun: WatchEntry['readRun'], pollIntervalMs: number): PipelineWatchSnapshot {
		if (!Number.isFinite(request.timeoutSeconds) || request.timeoutSeconds <= 0 || request.timeoutSeconds > 7200) {
			throw new Error('Pipeline watches require a positive timeout of at most two hours.');
		}
		const existing = [...this.watches.values()].find(({ snapshot }) => snapshot.state === 'watching'
			&& snapshot.organization === request.organization && snapshot.project === request.project && snapshot.runId === request.runId
			&& snapshot.timeoutSeconds === request.timeoutSeconds);
		if (existing) { return { ...existing.snapshot }; }
		for (const [watchId, entry] of this.watches) {
			if (this.watches.size < 20) { break; }
			if (entry.snapshot.state !== 'watching') { this.watches.delete(watchId); }
		}
		if (this.watches.size >= 20) { throw new Error('At most 20 pipeline watches can run in this window.'); }
		const watchId = randomBytes(32).toString('hex');
		let resolveResult!: WatchEntry['resolve'];
		const result = new Promise<PipelineWatchSnapshot>(resolve => { resolveResult = resolve; });
		const entry: WatchEntry = {
			snapshot: {
				...request, watchId, state: 'watching', createdAt: new Date().toISOString(),
				expiresAt: new Date(Date.now() + request.timeoutSeconds * 1000).toISOString(),
			},
			result, resolve: resolveResult, readRun, pollIntervalMs,
		};
		this.watches.set(watchId, entry);
		entry.deadline = setTimeout(() => this.finish(entry, 'timed_out', 'The watch deadline elapsed; the pipeline was not cancelled.'), request.timeoutSeconds * 1000);
		entry.deadline.unref();
		void this.poll(entry);
		return { ...entry.snapshot };
	}

	public list(): PipelineWatchSnapshot[] {
		return [...this.watches.values()].map(({ snapshot }) => ({ ...snapshot }));
	}

	public wait(watchId: string): Promise<PipelineWatchSnapshot> {
		return this.find(watchId).result.then(snapshot => ({ ...snapshot }));
	}

	public stop(watchId: string): PipelineWatchSnapshot {
		const entry = this.find(watchId);
		this.finish(entry, 'stopped', 'Watching stopped; the pipeline was not cancelled.');
		return { ...entry.snapshot };
	}

	public dispose(): void {
		for (const entry of this.watches.values()) {
			this.finish(entry, 'stopped', 'The extension host stopped; the pipeline was not cancelled.');
		}
	}

	private find(watchId: string): WatchEntry {
		const entry = this.watches.get(watchId);
		if (!entry) { throw new Error('Unknown or expired pipeline watch.'); }
		return entry;
	}

	private finish(entry: WatchEntry, state: PipelineWatchSnapshot['state'], message?: string): void {
		if (entry.snapshot.state !== 'watching') { return; }
		clearTimeout(entry.poll);
		clearTimeout(entry.deadline);
		entry.snapshot = { ...entry.snapshot, state, message };
		entry.resolve({ ...entry.snapshot });
	}

	private async poll(entry: WatchEntry): Promise<void> {
		try {
			const build = await entry.readRun();
			if (entry.snapshot.state !== 'watching') { return; }
			entry.snapshot = {
				...entry.snapshot,
				status: build.status === undefined ? undefined : BuildStatus[build.status],
				result: build.result === undefined ? undefined : BuildResult[build.result],
				sourceVersion: build.sourceVersion, sourceBranch: build.sourceBranch,
				url: build._links?.web?.href,
			};
			if (build.status === BuildStatus.Completed) {
				this.finish(entry, 'completed');
				return;
			}
			entry.poll = setTimeout(() => void this.poll(entry), entry.pollIntervalMs);
			entry.poll.unref();
		} catch {
			this.finish(entry, 'error', 'Monitoring failed. Read the run explicitly to check authentication and permissions; no pipeline operation was retried.');
		}
	}
}