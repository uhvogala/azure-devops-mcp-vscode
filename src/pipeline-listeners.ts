import * as z from 'zod/v4';

export const nativePipelineListenerToolName = 'azure_devops_pipeline_listener';

export const pipelineListenerHandoffSchema = z.object({
	resultUrl: z.string().refine(value => {
		try {
			const url = new URL(value);
			return url.protocol === 'http:' && url.hostname === '127.0.0.1' && !!url.port
				&& !url.username && !url.password && !url.search && !url.hash
				&& /^\/pipeline-watch-result\/[a-f0-9]{64}$/.test(url.pathname);
		} catch { return false; }
	}, 'Use the result-only loopback URL from the watch handoff.'),
	timeoutSeconds: z.number().int().min(1).max(7205),
	terminalToolName: z.string().min(1).optional(),
}).strict();

export interface PipelineTerminalTool {
	name: string;
	inputSchema?: object;
}

export function pipelineTerminalTools(tools: readonly PipelineTerminalTool[]): PipelineTerminalTool[] {
	return tools.filter(tool => /(?:^|_)(?:run_in_terminal|runInTerminal|bash|powershell|local_shell)$/.test(tool.name));
}

export function selectPipelineTerminalTool(tools: readonly PipelineTerminalTool[], name?: string): PipelineTerminalTool {
	const candidates = pipelineTerminalTools(tools);
	const selected = name ? candidates.find(tool => tool.name === name)
		: candidates.find(tool => /(?:run_in_terminal|runInTerminal)$/.test(tool.name)) ?? candidates[0];
	if (!selected) { throw new Error('No matching terminal tool is available in this host tool catalog. Inspect the listener prototypes; do not start an untracked process instead.'); }
	return selected;
}

export function pipelineListenerCommand(helperPath: string, input: unknown): string {
	const { resultUrl, timeoutSeconds } = pipelineListenerHandoffSchema.parse(input);
	const quote = (value: string) => `'${value.replace(/'/g, process.platform === 'win32' ? "''" : "'\\''")}'`;
	return `${process.platform === 'win32' ? '& ' : ''}${['node', helperPath, '--url', resultUrl, '--timeout-seconds', String(timeoutSeconds)].map(quote).join(' ')}`;
}

export function pipelineTerminalInput(tool: PipelineTerminalTool, command: string, timeoutSeconds: number): Record<string, unknown> {
	const schema = z.object({
		properties: z.record(z.string(), z.unknown()), required: z.array(z.string()).optional(),
	}).parse(tool.inputSchema);
	if (!('command' in schema.properties)) { throw new Error('The terminal tool has no supported command input.'); }
	const input: Record<string, unknown> = { command };
	const optional: Record<string, unknown> = {
		explanation: 'Attach the bounded pipeline listener to this conversation.',
		goal: 'Receive pipeline completion', description: 'Bounded pipeline listener',
		mode: 'async', isBackground: true, timeout: 1000, yield_time_ms: 1000,
		timeout_ms: timeoutSeconds * 1000,
	};
	for (const [name, value] of Object.entries(optional)) {
		if (!(name in schema.properties)) { continue; }
		const field = schema.properties[name];
		if (field && typeof field === 'object' && 'enum' in field && Array.isArray(field.enum) && !field.enum.includes(value)) {
			throw new Error(`The terminal tool does not support the prototype's ${name} value. Inspect its schema.`);
		}
		input[name] = value;
	}
	if (schema.required?.some(name => !(name in input))) { throw new Error('The terminal tool requires unsupported inputs. Inspect its schema before trying another route.'); }
	return input;
}