import { randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { pipelineListenerCommand, pipelineListenerHandoffSchema, pipelineTerminalInput, pipelineTerminalTools, selectPipelineTerminalTool } from './pipeline-listeners';
import { waitForPipelineWatchResult } from './pipeline-watch';
import { pipelineWatchProbeSchema, pipelineWatchRequestSchema } from './pipeline-watch';

const runtimeListenerInputSchema = z.object({
	resultUrl: pipelineListenerHandoffSchema.shape.resultUrl.optional(),
	timeoutSeconds: z.number().int().min(1).max(7205).optional(),
	terminalToolName: z.string().min(1).optional(),
	organization: z.string().min(1).optional(), project: z.string().min(1).optional(), runId: z.number().int().positive().optional(),
	probe: z.boolean().default(false), delaySeconds: z.number().int().min(1).max(120).optional(), result: z.enum(['Succeeded', 'Failed']).optional(),
}).strict();

interface RuntimeTool {
	name: string;
	description: string;
	parameters: object;
	handler: (input: unknown) => Promise<{ textResultForLlm: string; resultType: 'success' | 'failure' }>;
}

export interface PipelineRuntimeSession {
	rpc: {
		tools: { getBuiltinDescriptors: (input: object) => Promise<unknown>; getCurrentMetadata: () => Promise<unknown>;
			execute: (input: { name: string; arguments: Record<string, unknown>; toolCallId: string }) => Promise<unknown> };
		tasks: { register: (input: object) => Promise<{ task: { id: string; sequence: number } }>; update: (input: object) => Promise<unknown> };
	};
}

export function createPipelineRuntimeTools(getSession: () => PipelineRuntimeSession, helperPath: string): RuntimeTool[] {
	const tasks = new Map<string, { controller: AbortController; state: string; updateError?: string }>();
	const result = (value: Record<string, unknown>, failed = false) => ({ textResultForLlm: JSON.stringify(value), resultType: failed ? 'failure' as const : 'success' as const });
	const descriptors = async () => {
		const offered = pipelineTerminalTools((await metadata()).map(tool => ({ name: tool.name, inputSchema: tool.input_schema })));
		if (offered.length) { return offered; }
		const response = await getSession().rpc.tools.getBuiltinDescriptors({});
		return z.object({ tools: z.array(z.object({ name: z.string(), inputSchema: z.object({}).passthrough().nullable().optional() })) }).parse(response).tools
			.map(tool => ({ name: tool.name, inputSchema: tool.inputSchema ?? undefined }));
	};
	const metadata = async () => z.object({ tools: z.array(z.object({ name: z.string(), mcpToolName: z.string().optional(),
		input_schema: z.object({}).passthrough().optional() })).nullable() }).parse(await getSession().rpc.tools.getCurrentMetadata()).tools ?? [];
	const resolveHandoff = async (input: unknown) => {
		const target = runtimeListenerInputSchema.parse(input);
		if (target.resultUrl) { return pipelineListenerHandoffSchema.parse({ resultUrl: target.resultUrl, timeoutSeconds: target.timeoutSeconds, terminalToolName: target.terminalToolName }); }
		const suffix = target.probe ? 'start_pipeline_watch_probe' : 'watch_pipeline_run';
		const matches = (await metadata()).filter(tool => tool.mcpToolName === suffix || tool.name === suffix || tool.name.endsWith(`_${suffix}`));
		if (matches.length !== 1) { throw new Error('Exactly one pipeline watch/probe tool must be offered by the runtime. Inspect its catalog, or provide an existing resultUrl and timeoutSeconds handoff.'); }
		const response = await getSession().rpc.tools.execute({ name: matches[0]!.name, arguments: target.probe
			? pipelineWatchProbeSchema.parse(target) : pipelineWatchRequestSchema.parse(target), toolCallId: randomUUID() });
		let payload: unknown = response;
		if (typeof payload === 'string') { payload = JSON.parse(payload); }
		if (payload && typeof payload === 'object') {
			if ('structuredContent' in payload) { payload = payload.structuredContent; }
			else if ('textResultForLlm' in payload && typeof payload.textResultForLlm === 'string') { payload = JSON.parse(payload.textResultForLlm); }
			else if ('content' in payload && Array.isArray(payload.content)) {
				const text = payload.content.find((part: unknown) => !!part && typeof part === 'object' && 'type' in part && part.type === 'text');
				if (text && typeof text.text === 'string') { payload = JSON.parse(text.text); }
			}
		}
		const handoff = z.object({ wait: z.object({ args: z.tuple([z.string(), z.literal('--url'), z.string(), z.literal('--timeout-seconds'), z.string()]) }) }).parse(payload);
		return pipelineListenerHandoffSchema.parse({ resultUrl: handoff.wait.args[2], timeoutSeconds: Number(handoff.wait.args[4]), terminalToolName: target.terminalToolName });
	};
	const handoffParameters = z.toJSONSchema(runtimeListenerInputSchema);
	return [{
		name: 'azure_pipeline_runtime_inspect',
		description: 'Prototype: inspect this legitimately joined runtime companion and its terminal descriptors. Does not read Azure or launch work.',
		parameters: { type: 'object', properties: {}, additionalProperties: false },
		handler: async () => result({ approach: 'runtime-inspect', joinedForegroundSession: true, terminalTools: await descriptors(), offeredTools: await metadata(),
			tasks: [...tasks].map(([id, task]) => ({ id, state: task.state, updateError: task.updateError })),
			clientTaskDelivery: 'Unverified in this host. Registration is not proof of an automatic agent turn.' }),
	}, {
		name: 'azure_pipeline_runtime_terminal',
		description: 'Prototype: start a watch and invoke the native terminal via session.rpc.tools.execute in ONE call. Provide organization/project/runId/timeoutSeconds, or probe:true for a LOCAL simulation (delaySeconds/result/timeoutSeconds). Alternatively attach with resultUrl=wait.args[2] and timeoutSeconds=Number(wait.args[4]). No arbitrary commands, Azure credentials, or session IDs. Background delivery must be observed.',
		parameters: handoffParameters,
		handler: async input => {
			const terminal = selectPipelineTerminalTool(await descriptors(), runtimeListenerInputSchema.parse(input).terminalToolName);
			pipelineTerminalInput(terminal, '', 1);
			const handoff = await resolveHandoff(input);
			const nativeResult = await getSession().rpc.tools.execute({ name: terminal.name,
				arguments: pipelineTerminalInput(terminal, pipelineListenerCommand(helperPath, handoff), handoff.timeoutSeconds), toolCallId: randomUUID() });
			const failed = !!nativeResult && typeof nativeResult === 'object' && 'resultType' in nativeResult && nativeResult.resultType !== 'success';
			return result({ approach: 'runtime-terminal', terminalToolName: terminal.name, nativeResult, backgroundDelivery: 'Verify in this conversation.' }, failed);
		},
	}, {
		name: 'azure_pipeline_runtime_task',
		description: 'Prototype: start a watch and register a client-owned background task in ONE call, then return immediately. Provide organization/project/runId/timeoutSeconds, or probe:true for a LOCAL simulation. Alternatively attach with resultUrl/timeoutSeconds from an existing handoff. The terminal result goes through session.rpc.tasks; no CLI. Client-task UI and agent continuation are unverified. Local cancellation never cancels Azure.',
		parameters: handoffParameters,
		handler: async input => {
			const handoff = await resolveHandoff(input);
			for (const [id, task] of tasks) { if (tasks.size < 20) { break; } if (task.state !== 'running') { tasks.delete(id); } }
			if (tasks.size >= 20) { throw new Error('At most 20 runtime listener tasks can be retained.'); }
			const watchId = new URL(handoff.resultUrl).pathname.split('/').pop()!;
			const { task } = await getSession().rpc.tasks.register({ type: 'client', clientTaskId: `azure-pipeline-${watchId}`,
				description: 'Bounded Azure DevOps pipeline watch', displayName: 'Pipeline watch prototype', cancellable: false });
			if (tasks.has(task.id)) { return result({ approach: 'runtime-client-task', taskId: task.id, alreadyAttached: true }); }
			const entry = { controller: new AbortController(), state: 'running', updateError: undefined as string | undefined };
			tasks.set(task.id, entry);
			void (async () => {
				const update = await waitForPipelineWatchResult(handoff.resultUrl, handoff.timeoutSeconds, entry.controller.signal).then(watch => {
					if (watch.state === 'stopped') { return { kind: 'cancelled', reason: 'Local watch stopped. Azure was not cancelled.' }; }
					if (watch.state !== 'completed' || watch.result !== 'Succeeded') { return { kind: 'failed', error: `Watch ${watch.state}; pipeline result ${watch.result ?? 'unavailable'}.`, code: `pipeline_${watch.state}` }; }
					return { kind: 'completed', result: watch };
				}, () => entry.controller.signal.aborted
					? { kind: 'cancelled', reason: 'Local waiter cancelled. Bounded monitoring continues; Azure was not cancelled.' }
					: { kind: 'failed', error: 'Pipeline watch result unavailable. Inspect the watch explicitly.', code: 'listener_unavailable' });
				entry.state = update.kind;
				await getSession().rpc.tasks.update({ id: task.id, sequence: task.sequence + 1, update });
			})().catch(() => { entry.updateError = 'Unable to publish the final runtime task update. Inspect local watches explicitly.'; });
			return result({ approach: 'runtime-client-task', taskId: task.id, returnsImmediately: true, cancellableThroughRuntimeUI: false,
				cancelTool: 'azure_pipeline_runtime_cancel', backgroundDelivery: 'Experimental; task registration does not prove conversation continuation.' });
		},
	}, {
		name: 'azure_pipeline_runtime_cancel', description: 'Cancel only a runtime companion task waiter created by this companion. Does not stop the bounded extension watch or cancel Azure.',
		parameters: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'], additionalProperties: false },
		handler: async input => {
			const { taskId } = z.object({ taskId: z.string().min(1) }).strict().parse(input);
			const task = tasks.get(taskId);
			if (!task) { throw new Error('Unknown runtime companion task.'); }
			if (task.state === 'running') { task.controller.abort(); }
			return result({ taskId, waiterCancellationRequested: true, azureRunCancelled: false, boundedWatchStopped: false });
		},
	}];
}

export async function startRuntimePipelineExtension(helperPath: string): Promise<void> {
	const sdkModule = '@github/copilot-sdk/extension';
	const sdk = await import(sdkModule) as { joinSession: (config: { tools: RuntimeTool[] }) => Promise<PipelineRuntimeSession> };
	let session: PipelineRuntimeSession | undefined;
	const tools = createPipelineRuntimeTools(() => {
		if (!session) { throw new Error('Runtime companion has not joined the foreground session yet.'); }
		return session;
	}, helperPath);
	session = await sdk.joinSession({ tools });
}