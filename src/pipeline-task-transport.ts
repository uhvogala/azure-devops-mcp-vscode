import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/server';
import { randomBytes } from 'node:crypto';
import * as z from 'zod/v4';

const taskTool = 'wait_pipeline_run_task';
const taskParams = z.object({ taskId: z.string().regex(/^[a-f0-9]{64}$/) });
const taskOptions = z.object({ ttl: z.number().int().min(1000).max(7_500_000).optional() });
type RequestId = string | number;
type TaskResponse = Extract<JSONRPCMessage, { result: unknown } | { error: unknown }>;

interface TaskEntry {
	requestId: string;
	state: {
		taskId: string;
		status: 'working' | 'completed' | 'failed' | 'cancelled';
		createdAt: string;
		lastUpdatedAt: string;
		ttl: number;
		pollInterval: number;
	};
	response?: TaskResponse;
	waiters: Set<RequestId>;
	expiry: NodeJS.Timeout;
}

export class PipelineTaskTransport implements Transport {
	public onmessage?: Transport['onmessage'];
	public onclose?: Transport['onclose'];
	public onerror?: Transport['onerror'];
	private legacyTasks = false;
	private initializeId?: RequestId;
	private closed = false;
	private readonly tasks = new Map<string, TaskEntry>();
	private readonly requests = new Map<string, TaskEntry>();

	public constructor(private readonly inner: Transport) {}

	public get sessionId() { return this.inner.sessionId; }
	public setProtocolVersion(version: string): void { this.inner.setProtocolVersion?.(version); }
	public setSupportedProtocolVersions(versions: string[]): void { this.inner.setSupportedProtocolVersions?.(versions); }

	public async start(): Promise<void> {
		this.inner.onmessage = (message, extra) => {
			void this.receive(message, extra).catch(() => this.onerror?.(new Error('Pipeline task protocol handling failed.')));
		};
		this.inner.onerror = error => this.onerror?.(error);
		this.inner.onclose = () => { this.dispose(); this.onclose?.(); };
		await this.inner.start();
	}

	public async close(): Promise<void> {
		this.dispose();
		await this.inner.close();
	}

	public async send(message: JSONRPCMessage, options?: Parameters<Transport['send']>[1]): Promise<void> {
		if (this.closed) { return; }
		if ('id' in message && typeof message.id === 'string') {
			const entry = this.requests.get(message.id);
			if (entry && ('result' in message || 'error' in message)) {
				if (entry.state.status !== 'working') { this.requests.delete(message.id); return; }
				entry.response = message;
				if ('result' in message && message.result.structuredContent) {
					const structuredContent = { ...message.result.structuredContent as Record<string, unknown>, approach: 'mcp-task' };
					entry.response = { ...message, result: { ...message.result, structuredContent,
						content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }] } };
				}
				await this.finish(entry, 'error' in message || message.result.isError === true ? 'failed' : 'completed');
				return;
			}
		}
		if ('result' in message && message.id === this.initializeId) {
			this.legacyTasks = message.result.protocolVersion === '2025-11-25';
			if (this.legacyTasks) {
				message = { ...message, result: { ...message.result, capabilities: {
					...message.result.capabilities as Record<string, unknown>,
					tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } },
				} } };
			}
		} else if (this.legacyTasks && 'result' in message && Array.isArray(message.result.tools)) {
			message = { ...message, result: { ...message.result, tools: message.result.tools.map(tool =>
				tool.name === taskTool ? { ...tool, execution: { taskSupport: 'optional' } } : tool) } };
		}
		await this.inner.send(message, options);
	}

	private async receive(message: JSONRPCMessage, extra?: Parameters<NonNullable<Transport['onmessage']>>[1]): Promise<void> {
		if ('method' in message && message.method === 'initialize' && 'id' in message) { this.initializeId = message.id; }
		if (!this.legacyTasks || !('method' in message)) { this.onmessage?.(message, extra); return; }
		if (message.method === 'notifications/cancelled') {
			for (const entry of this.tasks.values()) { entry.waiters.delete(message.params?.requestId as RequestId); }
		}
		if (!('id' in message)) { this.onmessage?.(message, extra); return; }
		const id = message.id;
		if (message.method === 'tools/call' && message.params?.task !== undefined && message.params.name !== taskTool) {
			await this.error(id, 'Only wait_pipeline_run_task supports task execution.');
			return;
		}
		if (message.method === 'tools/call' && message.params?.name === taskTool && message.params.task !== undefined) {
			const parsed = taskOptions.safeParse(message.params.task);
			if (!parsed.success) { await this.error(id, 'Task TTL must be 1000-7500000 milliseconds.'); return; }
			for (const [taskId, entry] of this.tasks) {
				if (this.tasks.size < 20) { break; }
				if (entry.state.status !== 'working') {
					clearTimeout(entry.expiry);
					this.tasks.delete(taskId);
					if (entry.state.status !== 'cancelled') { this.requests.delete(entry.requestId); }
				}
			}
			if (this.tasks.size >= 20 || this.requests.size >= 40) { await this.error(id, 'Pipeline task capacity exceeded.'); return; }
			const taskId = randomBytes(32).toString('hex');
			const now = new Date().toISOString();
			const entry: TaskEntry = {
				requestId: `pipeline-task-${randomBytes(32).toString('hex')}`,
				state: { taskId, status: 'working', createdAt: now, lastUpdatedAt: now, ttl: parsed.data.ttl ?? 7_260_000, pollInterval: 1000 },
				waiters: new Set(),
				expiry: setTimeout(() => { void this.expire(taskId).catch(() => {}); }, parsed.data.ttl ?? 7_260_000),
			};
			entry.expiry.unref();
			this.tasks.set(taskId, entry);
			this.requests.set(entry.requestId, entry);
			await this.inner.send({ jsonrpc: '2.0', id, result: { task: { ...entry.state }, _meta: {
				'io.modelcontextprotocol/model-immediate-response': 'A bounded pipeline watch task is running. Host support determines whether the agent can continue other work before its result arrives.',
				'io.modelcontextprotocol/related-task': { taskId },
			} } });
			const params = { ...message.params };
			delete params.task;
			this.onmessage?.({ ...message, id: entry.requestId, params }, extra);
			return;
		}
		if (message.method === 'tasks/list') {
			await this.inner.send({ jsonrpc: '2.0', id, result: { tasks: [...this.tasks.values()].map(entry => ({ ...entry.state })) } });
			return;
		}
		if (!['tasks/get', 'tasks/result', 'tasks/cancel'].includes(message.method)) { this.onmessage?.(message, extra); return; }
		const parsed = taskParams.safeParse(message.params);
		const entry = parsed.success ? this.tasks.get(parsed.data.taskId) : undefined;
		if (!entry) { await this.error(id, 'Unknown or expired pipeline task.'); return; }
		if (message.method === 'tasks/result') {
			if (entry.response) { await this.result(id, entry); }
			else if (entry.waiters.size >= 20) { await this.error(id, 'Too many waiters for this task.'); }
			else { entry.waiters.add(id); }
			return;
		}
		if (message.method === 'tasks/cancel') {
			if (entry.state.status !== 'working') { await this.error(id, 'A terminal pipeline task cannot be cancelled.'); return; }
			entry.response = { jsonrpc: '2.0', id: entry.requestId, error: { code: -32800,
				message: 'Pipeline task wait cancelled; bounded monitoring continues until its deadline or explicit stop_pipeline_watch. No Azure run was cancelled.' } };
			await this.finish(entry, 'cancelled');
			this.cancelWait(entry);
		}
		await this.inner.send({ jsonrpc: '2.0', id, result: { ...entry.state } });
	}

	private async finish(entry: TaskEntry, status: TaskEntry['state']['status']): Promise<void> {
		entry.state = { ...entry.state, status, lastUpdatedAt: new Date().toISOString() };
		await this.inner.send({ jsonrpc: '2.0', method: 'notifications/tasks/status', params: { ...entry.state } });
		for (const id of entry.waiters) { await this.result(id, entry); }
		entry.waiters.clear();
	}

	private async result(id: RequestId, entry: TaskEntry): Promise<void> {
		const response = entry.response;
		if (!response) { return; }
		if ('error' in response) { await this.inner.send({ ...response, id }); return; }
		await this.inner.send({ ...response, id, result: { ...response.result, _meta: {
			...response.result._meta, 'io.modelcontextprotocol/related-task': { taskId: entry.state.taskId },
		} } });
	}

	private cancelWait(entry: TaskEntry): void {
		this.onmessage?.({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: entry.requestId, reason: 'Pipeline task wait ended.' } });
	}

	private async expire(taskId: string): Promise<void> {
		const entry = this.tasks.get(taskId);
		if (!entry) { return; }
		this.tasks.delete(taskId);
		for (const id of entry.waiters) { await this.error(id, 'Pipeline task expired.'); }
		entry.waiters.clear();
		if (entry.state.status === 'completed' || entry.state.status === 'failed') { this.requests.delete(entry.requestId); }
		else { entry.state.status = 'cancelled'; this.cancelWait(entry); }
	}

	private async error(id: RequestId, message: string): Promise<void> {
		await this.inner.send({ jsonrpc: '2.0', id, error: { code: -32602, message } });
	}

	private dispose(): void {
		if (this.closed) { return; }
		this.closed = true;
		for (const entry of this.tasks.values()) { clearTimeout(entry.expiry); this.cancelWait(entry); }
		this.tasks.clear();
		this.requests.clear();
	}
}