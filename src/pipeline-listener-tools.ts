import * as vscode from 'vscode';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as z from 'zod/v4';
import { nativePipelineListenerToolName, pipelineListenerCommand, pipelineTerminalInput, pipelineTerminalTools, selectPipelineTerminalTool } from './pipeline-listeners';
import { pipelineWatchProbeSchema, pipelineWatchRequestSchema, pipelineWatchSnapshotSchema } from './pipeline-watch';

export const nativePipelineListenerInputSchema = z.object({
	mode: z.enum(['inspect', 'terminal']).default('terminal'),
	watchId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
	organization: z.string().min(1).optional(), project: z.string().min(1).optional(),
	runId: z.number().int().positive().optional(), timeoutSeconds: z.number().int().min(1).max(7200).optional(),
	probe: z.boolean().default(false), delaySeconds: z.number().int().min(1).max(120).optional(),
	result: z.enum(['Succeeded', 'Failed']).optional(), terminalToolName: z.string().min(1).optional(),
}).strict().superRefine((input, context) => {
	if (input.mode === 'inspect') { return; }
	const runFields = [input.organization, input.project, input.runId];
	if (input.watchId) {
		if (input.probe || [...runFields, input.timeoutSeconds, input.delaySeconds, input.result].some(value => value !== undefined)) {
			context.addIssue({ code: 'custom', message: 'Provide only watchId when attaching to an existing watch.' });
		}
		return;
	}
	if (input.probe) {
		if (runFields.some(value => value !== undefined)) {
			context.addIssue({ code: 'custom', message: 'A local simulation cannot include an Azure run target.' });
		}
		return;
	}
	if (runFields.some(value => value === undefined) || input.timeoutSeconds === undefined) {
		context.addIssue({ code: 'custom', message: 'Provide watchId, probe:true, or organization/project/runId/timeoutSeconds.' });
	}
	if (input.delaySeconds !== undefined || input.result !== undefined) {
		context.addIssue({ code: 'custom', message: 'Simulation options require probe:true.' });
	}
});

const companionOwner = 'export const prototypeOwner = "aitostack.azure-devops-prs-mcp";\n';

export function experimentalPipelineListenersEnabled(): boolean {
	return vscode.workspace.getConfiguration('azure-devops-mcp').get('experimentalPipelineListeners', false);
}

export function pipelineRuntimeCompanionPath(): string {
	return join(process.env.COPILOT_HOME ?? join(homedir(), '.copilot'), 'extensions', 'azure-devops-pipeline-listener', 'extension.mjs');
}

export async function installPipelineRuntimeCompanion(extensionPath: string, target = pipelineRuntimeCompanionPath(), onlyRefresh = false, enabled = true): Promise<boolean> {
	let existing: string | undefined;
	try { existing = await readFile(target, 'utf8'); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
	if (existing !== undefined && !existing.startsWith(companionOwner)) { throw new Error('Refusing to overwrite an unmanaged runtime companion.'); }
	if (existing === undefined && onlyRefresh) { return false; }
	const source = `${companionOwner}export const pipelineRuntimeEnabled = ${enabled};\n${enabled ? `import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nconst { startRuntimePipelineExtension } = require(${JSON.stringify(join(extensionPath, 'dist', 'pipeline-runtime.js'))});\nawait startRuntimePipelineExtension(${JSON.stringify(join(extensionPath, 'dist', 'pipeline-wait.js'))});\n` : ''}`;
	if (existing !== source) {
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, source, { encoding: 'utf8', mode: 0o600, flag: existing === undefined ? 'wx' : 'w' });
	}
	return true;
}

export function inspectPipelineListenerHost(): Record<string, unknown> {
	return {
		nativeToolName: nativePipelineListenerToolName,
		mcpCanSupplyToolInvocationToken: false,
		runtimeCompanionPath: pipelineRuntimeCompanionPath(),
		runtimeCompanionInstalled: existsSync(pipelineRuntimeCompanionPath()),
		runtimeInstallCommand: 'azure-devops-mcp.installPipelineRuntimePrototype',
		tokenRule: 'Only a host-issued native tool invocation supplies the opaque chat token. Do not send or construct one as an MCP argument.',
		terminalTools: pipelineTerminalTools(vscode.lm.tools).map(tool => ({ name: tool.name, inputSchema: tool.inputSchema })),
		terminalOutputLocation: vscode.workspace.getConfiguration('chat.tools.terminal').get('outputLocation', 'chat'),
		experimentalListenersEnabled: experimentalPipelineListenersEnabled(),
		watchLifetime: 'Window-local, at most 7200 seconds; not persisted across reload or shutdown.',
		chatStopBehavior: 'Host-dependent. Monitoring may continue, but post-Stop chat continuation is not guaranteed. Never automatically relaunch.',
		runtimeExtensionsOptInSetting: 'chat.canvases.enabled',
		runtimeExtensionsOptIn: vscode.workspace.getConfiguration('chat.canvases').get('enabled', false),
		runtimeTools: ['azure_pipeline_runtime_inspect', 'azure_pipeline_runtime_terminal', 'azure_pipeline_runtime_task', 'azure_pipeline_runtime_cancel'],
		runtimeRequirement: 'A runtime-launched companion must join the foreground session. Reload/discovery and host feature support must be verified; MCP cannot attach it by session ID.',
		clientTaskHostProjection: 'Experimental: the inspected host projects shell and agent tasks, not client tasks. Completion delivery is unverified.',
	};
}

export class NativePipelineListenerTool implements vscode.LanguageModelTool<unknown> {
	public constructor(private readonly controlWatch: (input: unknown) => Promise<Record<string, unknown>>, private readonly helperPath: string) {}

	public async invoke(options: vscode.LanguageModelToolInvocationOptions<unknown>, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
		const input = nativePipelineListenerInputSchema.parse(options.input);
		if (input.mode === 'inspect') {
			return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({
				...inspectPipelineListenerHost(), receivedHostInvocationToken: options.toolInvocationToken !== undefined,
			}, null, 2))]);
		}
		if (!options.toolInvocationToken) { throw new Error('This route requires a host-issued native toolInvocationToken. MCP arguments cannot supply it. Invoke azure_devops_pipeline_listener directly as a native tool.'); }
		if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
		const terminal = selectPipelineTerminalTool(vscode.lm.tools, input.terminalToolName);
		pipelineTerminalInput(terminal, '', 1);
		const target = input.watchId ? { action: 'get', watchId: input.watchId }
			: input.probe ? { action: 'probe', request: pipelineWatchProbeSchema.parse(input) }
				: { action: 'start', request: pipelineWatchRequestSchema.parse(input) };
		const handoff = z.object({ watch: pipelineWatchSnapshotSchema,
			wait: z.object({ args: z.tuple([z.string(), z.literal('--url'), z.string(), z.literal('--timeout-seconds'), z.string()]) }),
		}).parse(await this.controlWatch(target));
		if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
		const result = await vscode.lm.invokeTool(terminal.name, {
			input: pipelineTerminalInput(terminal, pipelineListenerCommand(this.helperPath, {
				resultUrl: handoff.wait.args[2], timeoutSeconds: Number(handoff.wait.args[4]),
			}), Number(handoff.wait.args[4])),
			toolInvocationToken: options.toolInvocationToken,
		}, token);
		return new vscode.LanguageModelToolResult([
			new vscode.LanguageModelTextPart(JSON.stringify({
				approach: 'native-terminal', watch: handoff.watch, terminalToolName: terminal.name, ...(input.probe ? { simulation: true } : {}),
				receivedHostInvocationToken: true, terminalInvocationReturned: true, backgroundDelivery: 'The host tracks terminal completion for this conversation. Delivery after chat Stop or disconnect is not guaranteed. Never automatically restart a listener.',
			})), ...result.content,
		]);
	}

	public prepareInvocation(): vscode.PreparedToolInvocation {
		return { invocationMessage: 'Attach a bounded pipeline completion listener' };
	}
}

export function registerPipelineListenerTool(context: vscode.ExtensionContext, controlWatch: (input: unknown) => Promise<Record<string, unknown>>): void {
	context.subscriptions.push(vscode.lm.registerTool(nativePipelineListenerToolName,
		new NativePipelineListenerTool(controlWatch, join(context.extensionPath, 'dist', 'pipeline-wait.js'))));
	context.subscriptions.push(vscode.commands.registerCommand('azure-devops-mcp.installPipelineRuntimePrototype', async () => {
		if (!experimentalPipelineListenersEnabled()) { throw new Error('Enable azure-devops-mcp.experimentalPipelineListeners and reload before installing the experimental runtime companion.'); }
		await installPipelineRuntimeCompanion(context.extensionPath);
		void vscode.window.showInformationMessage('Pipeline runtime companion installed. Reload the window and inspect prototype tool discovery; runtime support may require the host extension opt-in.');
	}));
	void installPipelineRuntimeCompanion(context.extensionPath, pipelineRuntimeCompanionPath(), true, experimentalPipelineListenersEnabled()).catch(() => {
		console.warn('Azure DevOps runtime companion was not refreshed. Use the prototype install command to inspect installation errors.');
	});
}