import { McpServer } from '@modelcontextprotocol/server';
import { IBuildApi } from 'azure-devops-node-api/BuildApi';
import { IGitApi } from 'azure-devops-node-api/GitApi';
import { IPipelinesApi } from 'azure-devops-node-api/PipelinesApi';
import {
	Build,
	BuildDefinition,
	BuildDefinitionReference,
	BuildQueryOrder,
	BuildReason,
	BuildResult,
	BuildStatus,
	DefinitionQueueStatus,
	Timeline,
	TypeInfo,
	YamlProcess,
} from 'azure-devops-node-api/interfaces/BuildInterfaces';
import { GitVersionType, ItemContentType, VersionControlChangeType } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { RunPipelineParameters } from 'azure-devops-node-api/interfaces/PipelinesInterfaces';
import { IncomingHttpHeaders } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod/v4';

export const pipelineCardUri = 'ui://azure-devops/pipeline-card.html';

const projectSchema = {
	organization: z.string().min(1).describe('Azure DevOps organization name.'),
	project: z.string().min(1).describe('Azure DevOps project name or ID.'),
};

const runSchema = {
	...projectSchema,
	runId: z.number().int().positive().describe('Azure DevOps build/run ID, not the pipeline definition ID.'),
};

const pipelineSchema = {
	...projectSchema,
	pipelineId: z.number().int().positive().describe('Pipeline definition ID from list_pipelines or get_pipeline; not a run ID.'),
};

const branchSchema = z.string().startsWith('refs/heads/').min(12).describe('Full branch ref, e.g. refs/heads/feature/ci.');
const commitSchema = z.string().regex(/^[0-9a-f]{40}$/i).describe('Full Git commit ID.');
const confirmationSchema = z.literal(true).describe('Set only after the user explicitly confirms this exact remote operation.');
const queueStatuses = {
	enabled: DefinitionQueueStatus.Enabled,
	paused: DefinitionQueueStatus.Paused,
	disabled: DefinitionQueueStatus.Disabled,
};

const statuses = {
	notStarted: BuildStatus.NotStarted,
	inProgress: BuildStatus.InProgress,
	completed: BuildStatus.Completed,
	cancelling: BuildStatus.Cancelling,
	postponed: BuildStatus.Postponed,
};

function jsonResult(value: Record<string, unknown>) {
	return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], structuredContent: value };
}

function pipelineSummary(definition: BuildDefinitionReference) {
	return {
		id: definition.id,
		name: definition.name,
		folder: definition.path,
		revision: definition.revision,
		queueStatus: definition.queueStatus === undefined ? undefined : DefinitionQueueStatus[definition.queueStatus],
		url: definition._links?.web?.href,
	};
}

function runSummary(build: Build) {
	return {
		id: build.id,
		buildNumber: build.buildNumber,
		pipeline: build.definition && pipelineSummary(build.definition),
		status: build.status === undefined ? undefined : BuildStatus[build.status],
		result: build.result === undefined ? undefined : BuildResult[build.result],
		sourceBranch: build.sourceBranch,
		sourceVersion: build.sourceVersion,
		reason: build.reason === undefined ? undefined : BuildReason[build.reason],
		requestedBy: build.requestedBy?.displayName,
		queueTime: build.queueTime,
		startTime: build.startTime,
		finishTime: build.finishTime,
		url: build._links?.web?.href,
	};
}

function definitionSummary(definition: BuildDefinition) {
	return {
		...pipelineSummary(definition),
		description: definition.description,
		repository: definition.repository && {
			id: definition.repository.id,
			name: definition.repository.name,
			type: definition.repository.type,
			defaultBranch: definition.repository.defaultBranch,
		},
		process: { type: definition.process?.type, yamlFilename: (definition.process as YamlProcess | undefined)?.yamlFilename },
		variables: Object.fromEntries(Object.entries(definition.variables ?? {}).map(([name, variable]) => [
			name, variable.isSecret ? { isSecret: true } : { value: variable.value, allowOverride: variable.allowOverride },
		])),
	};
}

function yamlSource(definition: BuildDefinition) {
	const path = (definition.process as YamlProcess | undefined)?.yamlFilename;
	if (definition.process?.type !== 2 || !path || definition.repository?.type !== 'TfsGit' || !definition.repository.id) {
		throw new Error('YAML editing requires a YAML pipeline backed by Azure Repos Git. Classic pipelines support definition settings only.');
	}
	return { path, repositoryId: definition.repository.id };
}

function checkRevision(definition: BuildDefinition, expectedRevision: number): void {
	if (definition.revision !== expectedRevision) {
		throw new Error('The pipeline definition changed. Read it again and confirm the revised edit before retrying.');
	}
}

interface PipelineApis {
	getBuildApi: (organization: string) => Promise<IBuildApi>;
	getGitApi: (organization: string) => Promise<IGitApi>;
	getPipelinesApi: (organization: string) => Promise<IPipelinesApi>;
}

async function getBuildPage<Item>(api: IBuildApi, project: string, resource: 'definitions' | 'builds', query: Record<string, string | number | undefined>) {
	const url = new URL(`${encodeURIComponent(project)}/_apis/build/${resource}`, `${api.baseUrl.replace(/\/$/, '')}/`);
	url.searchParams.set('api-version', '7.1');
	for (const [name, value] of Object.entries(query)) {
		if (value !== undefined) { url.searchParams.set(name, String(value)); }
	}
	const response = await api.rest.get<unknown>(url.href);
	const metadata = resource === 'definitions' ? TypeInfo.BuildDefinitionReference : TypeInfo.Build;
	const items = api.formatResponse(response.result, metadata, true) as Item[];
	const continuationToken = (response.headers as IncomingHttpHeaders)['x-ms-continuationtoken'];
	return { items, continuationToken: Array.isArray(continuationToken) ? continuationToken[0] : continuationToken };
}

export function registerPipelineTools(server: McpServer, { getBuildApi, getGitApi, getPipelinesApi }: PipelineApis): void {
	server.registerResource('Azure DevOps pipeline and log card', pipelineCardUri, {
		description: 'Pipeline run status, task results, and readable log previews using the pull request card theme.',
		mimeType: 'text/html;profile=mcp-app',
		_meta: { ui: { prefersBorder: true } },
	}, async uri => ({ contents: [{
		uri: uri.href,
		mimeType: 'text/html;profile=mcp-app',
		text: await readFile(join(__dirname, 'pipeline-card.html'), 'utf8'),
	}] }));

	const loadRun = async ({ organization, project, runId, includeTimeline }: {
		organization: string; project: string; runId: number; includeTimeline: boolean;
	}) => {
		const api = await getBuildApi(organization);
		const build = await api.getBuild(project, runId);
		let timeline: Timeline | undefined;
		if (includeTimeline) {
			try {
				timeline = await api.getBuildTimeline(project, runId);
			} catch (error) {
				if (!error || typeof error !== 'object' || !('statusCode' in error) || error.statusCode !== 404) {
					throw error;
				}
			}
		}
		return {
			...runSummary(build),
			timelineAvailable: includeTimeline ? timeline !== undefined : undefined,
			records: timeline?.records?.map(record => ({
				id: record.id,
				parentId: record.parentId,
				type: record.type,
				name: record.name,
				order: record.order,
				state: record.state,
				result: record.result,
				percentComplete: record.percentComplete,
				startTime: record.startTime,
				finishTime: record.finishTime,
				issues: record.issues,
				logId: record.log?.id,
			})),
		};
	};

	const loadLog = async ({ organization, project, runId, logId, startLine, lineCount }: {
		organization: string; project: string; runId: number; logId?: number; startLine: number; lineCount: number;
	}) => {
		const api = await getBuildApi(organization);
		if (logId === undefined) {
			const logs = await api.getBuildLogs(project, runId);
			return { runId, logs: logs.map(log => ({ id: log.id, lineCount: log.lineCount, type: log.type })) };
		}
		const lines = await api.getBuildLogLines(project, runId, logId, startLine + 1, startLine + lineCount);
		return { runId, logId, startLine, lines, nextStartLine: startLine + lines.length };
	};

	server.registerTool('list_pipelines', {
		title: 'Find CI Pipelines',
		description: 'Find Azure DevOps CI pipeline definitions (YAML and classic). Pass a repository name or ID from get_workspace_repositories, or filter by pipeline name with wildcards. Returns pipelines[].id for get_pipeline/run_pipeline and a continuationToken for the next page. No local YAML inspection is needed.',
		inputSchema: z.object({
			...projectSchema,
			repository: z.string().min(1).optional().describe('Repository name or ID from workspace discovery. Omit to list project-wide pipelines.'),
			name: z.string().min(1).optional().describe('Pipeline name filter; Azure DevOps supports wildcards.'),
			top: z.number().int().min(1).max(100).default(25),
			continuationToken: z.string().optional(),
		}),
		annotations: { readOnlyHint: true },
	}, async ({ organization, project, repository, name, top, continuationToken }) => {
		const repositoryId = repository === undefined ? undefined : (await (await getGitApi(organization)).getRepository(repository, project)).id;
		if (repository !== undefined && !repositoryId) {
			throw new Error('Azure DevOps returned no repository ID.');
		}
		const page = await getBuildPage<BuildDefinitionReference>(await getBuildApi(organization), project, 'definitions', {
			name, repositoryId, repositoryType: repositoryId ? 'TfsGit' : undefined, '$top': top, continuationToken,
			queryOrder: 'lastModifiedDescending',
		});
		return jsonResult({ pipelines: page.items.map(pipelineSummary), continuationToken: page.continuationToken });
	});

	server.registerTool('get_pipeline', {
		title: 'Read CI Pipeline Settings',
		description: 'Read an Azure DevOps pipeline definition, its revision, repository, default branch, YAML path and non-secret variables. Use before editing a definition or its YAML.',
		inputSchema: z.object(pipelineSchema),
		annotations: { readOnlyHint: true },
	}, async ({ organization, project, pipelineId }) => {
		const definition = await (await getBuildApi(organization)).getDefinition(project, pipelineId);
		return jsonResult(definitionSummary(definition));
	});

	server.registerTool('list_pipeline_runs', {
		title: 'Find CI Runs and PR Builds',
		description: 'List Azure DevOps CI runs, newest first. Filter by pipelineId, full branch ref, status or pullRequestId (not branch and PR together). PR filtering uses refs/pull/<id>/merge; source-branch runs require branch instead. Returns runs[].id as runId for monitoring/logs/cancellation and continuationToken for pagination. Manual source-branch runs are not PR validation.',
		inputSchema: z.object({
			...projectSchema,
			pipelineId: pipelineSchema.pipelineId.optional(),
			branch: z.string().startsWith('refs/').optional(),
			pullRequestId: z.number().int().positive().optional(),
			status: z.enum(['notStarted', 'inProgress', 'completed', 'cancelling', 'postponed']).optional(),
			top: z.number().int().min(1).max(100).default(25),
			continuationToken: z.string().optional(),
		}).refine(value => value.branch === undefined || value.pullRequestId === undefined, { message: 'Specify branch or pullRequestId, not both.' }),
		annotations: { readOnlyHint: true },
	}, async ({ organization, project, pipelineId, branch, pullRequestId, status, top, continuationToken }) => {
		const page = await getBuildPage<Build>(await getBuildApi(organization), project, 'builds', {
			definitions: pipelineId,
			statusFilter: status === undefined ? undefined : statuses[status],
			'$top': top,
			continuationToken,
			queryOrder: BuildQueryOrder.QueueTimeDescending,
			branchName: pullRequestId === undefined ? branch : `refs/pull/${pullRequestId}/merge`,
		});
		return jsonResult({ runs: page.items.map(runSummary), continuationToken: page.continuationToken });
	});

	server.registerTool('get_pipeline_run', {
		title: 'Monitor CI Run and Job Results',
		description: 'Monitor one Azure DevOps CI run: status, result, stages/jobs/tasks, progress, issues and log IDs. Returns a snapshot, not a background watcher. Queued runs may have timelineAvailable: false; includeTimeline: false reads status only. Within the requested monitoring scope, check again as needed. Use records[].logId with get_pipeline_run_log to diagnose a task.',
		inputSchema: z.object({ ...runSchema, includeTimeline: z.boolean().default(true) }),
		annotations: { readOnlyHint: true },
		_meta: { ui: { visibility: ['model', 'app'] }, 'ui/visibility': ['model', 'app'] },
	}, async arguments_ => jsonResult(await loadRun(arguments_)));

	server.registerTool('show_pipeline_run', {
		title: 'Show CI Pipeline Status Card',
		description: 'Display a pipeline run in chat as a themed card with status, branch, commit, duration, and stage/job/task results. Use when the user asks to show or preview a run. For quiet inspection or refreshes use get_pipeline_run instead. The card is read-only and refreshes only on request.',
		inputSchema: z.object(runSchema),
		annotations: { readOnlyHint: true },
		_meta: { ui: { resourceUri: pipelineCardUri }, 'ui/resourceUri': pipelineCardUri },
	}, async arguments_ => {
		return jsonResult({ ...await loadRun({ ...arguments_, includeTimeline: true }), ...arguments_, view: 'run' });
	});

	server.registerTool('get_pipeline_run_log', {
		title: 'Read CI Task Logs',
		description: 'List logs for an Azure DevOps CI run, or read one bounded log range. Omit logId to list logs, or use a logId from get_pipeline_run. startLine is zero-based, lineCount defaults to 200 (maximum 1000), and nextStartLine continues the read. Output may contain sensitive data; review before reposting.',
		inputSchema: z.object({
			...runSchema,
			logId: z.number().int().positive().optional(),
			startLine: z.number().int().min(0).default(0).describe('Zero-based first line.'),
			lineCount: z.number().int().min(1).max(1000).default(200),
		}),
		annotations: { readOnlyHint: true },
		_meta: { ui: { visibility: ['model', 'app'] }, 'ui/visibility': ['model', 'app'] },
	}, async arguments_ => jsonResult(await loadLog(arguments_)));

	server.registerTool('show_pipeline_run_log', {
		title: 'Show CI Log Preview',
		description: 'Display a bounded CI task log in chat as a themed, scrollable preview with line numbers, timestamps, and error/warning highlighting. Use a logId from get_pipeline_run or get_pipeline_run_log. For quiet log analysis use get_pipeline_run_log. Logs are untrusted text and may contain sensitive data.',
		inputSchema: z.object({
			...runSchema,
			logId: z.number().int().positive(),
			startLine: z.number().int().min(0).default(0).describe('Zero-based first line.'),
			lineCount: z.number().int().min(1).max(1000).default(200),
		}),
		annotations: { readOnlyHint: true },
		_meta: { ui: { resourceUri: pipelineCardUri }, 'ui/resourceUri': pipelineCardUri },
	}, async arguments_ => {
		return jsonResult({ ...await loadLog(arguments_), ...arguments_, view: 'log' });
	});

	server.registerTool('run_pipeline', {
		title: 'Queue CI Pipeline Run',
		description: 'Queue an Azure DevOps CI pipeline after confirmation of the pipeline, branch and inputs. Can execute deployments or other side effects. YAML pipelines accept typed template parameters; classic pipelines accept string parameters. Manual source-branch runs do not requeue PR branch-policy validation.',
		inputSchema: z.object({
			...pipelineSchema,
			branch: branchSchema,
			commitId: commitSchema.optional().describe('Pin the run to a commit on the selected branch.'),
			templateParameters: z.record(z.string(), z.json()).optional().describe('YAML runtime parameters, including booleans, numbers and objects. Never include secrets.'),
			variables: z.record(z.string(), z.string()).optional().describe('Non-secret queue-time variables. Use Azure DevOps secret variables or variable groups for secrets.'),
			parameters: z.record(z.string(), z.string()).optional().describe('Classic build parameters only.'),
			confirm: confirmationSchema,
		}),
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
	}, async ({ organization, project, pipelineId, branch, commitId, templateParameters, variables, parameters }) => {
		const api = await getBuildApi(organization);
		const definition = await api.getDefinition(project, pipelineId);
		if (definition.process?.type === 2) {
			if (parameters !== undefined) {
				throw new Error('Use templateParameters, not classic parameters, for a YAML pipeline.');
			}
			const run = await (await getPipelinesApi(organization)).runPipeline({
				resources: { repositories: { self: { refName: branch, version: commitId } } },
				templateParameters: templateParameters as RunPipelineParameters['templateParameters'],
				variables: variables && Object.fromEntries(Object.entries(variables).map(([name, value]) => [name, { value, isSecret: false }])),
			}, project, pipelineId);
			return jsonResult({ id: run.id, name: run.name, state: run.state, result: run.result, url: run._links?.web?.href });
		}
		if (templateParameters !== undefined) {
			throw new Error('Classic pipelines do not support YAML templateParameters. Use parameters instead.');
		}
		if (variables !== undefined) {
			throw new Error('Queue-time variables are supported here for YAML pipelines only. Use classic parameters instead.');
		}
		const build = await api.queueBuild({
			definition: { id: pipelineId }, sourceBranch: branch, sourceVersion: commitId,
			parameters: parameters === undefined ? undefined : JSON.stringify(parameters),
		}, project);
		return jsonResult(runSummary(build));
	});

	server.registerTool('cancel_pipeline_run', {
		title: 'Cancel CI Run',
		description: 'Request cancellation of a CI run after explicit confirmation. Cancellation is asynchronous; use get_pipeline_run to monitor it. Completed or already-cancelling runs are returned unchanged.',
		inputSchema: z.object({ ...runSchema, confirm: confirmationSchema }),
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
	}, async ({ organization, project, runId }) => {
		const api = await getBuildApi(organization);
		const build = await api.getBuild(project, runId);
		if (build.status === BuildStatus.Completed || build.status === BuildStatus.Cancelling) {
			return jsonResult(runSummary(build));
		}
		return jsonResult(runSummary(await api.updateBuild({ status: BuildStatus.Cancelling }, project, runId)));
	});

	server.registerTool('update_pipeline', {
		title: 'Edit CI Pipeline Settings',
		description: 'Edit pipeline definition settings after confirmation of the exact changes. Read get_pipeline first and supply its revision. Preserves other definition fields and secret variables. Does not edit classic tasks/triggers or YAML contents; use update_pipeline_yaml for YAML.',
		inputSchema: z.object({
			...pipelineSchema,
			expectedRevision: z.number().int().positive().describe('Exact revision returned by get_pipeline for the reviewed definition. Reread and reconfirm if stale.'),
			name: z.string().min(1).max(255).optional(),
			description: z.string().max(4000).optional(),
			folder: z.string().startsWith('\\').optional().describe('Pipeline folder, e.g. \\CI.'),
			queueStatus: z.enum(['enabled', 'paused', 'disabled']).optional(),
			defaultBranch: branchSchema.optional(),
			yamlPath: z.string().min(1).optional().describe('Change the configured YAML file path, not its contents. YAML pipelines only.'),
			variables: z.record(z.string(), z.string()).optional().describe('Merge non-secret variables. Existing secret variables cannot be changed through this tool.'),
			confirm: confirmationSchema,
		}).refine(value => [value.name, value.description, value.folder, value.queueStatus, value.defaultBranch, value.yamlPath, value.variables].some(field => field !== undefined), {
			message: 'Provide at least one setting to update.',
		}),
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
	}, async ({ organization, project, pipelineId, expectedRevision, name, description, folder, queueStatus, defaultBranch, yamlPath, variables }) => {
		const api = await getBuildApi(organization);
		const definition = await api.getDefinition(project, pipelineId);
		checkRevision(definition, expectedRevision);
		if (name !== undefined) { definition.name = name; }
		if (description !== undefined) { definition.description = description; }
		if (folder !== undefined) { definition.path = folder; }
		if (queueStatus !== undefined) { definition.queueStatus = queueStatuses[queueStatus]; }
		if (defaultBranch !== undefined) {
			if (!definition.repository) { throw new Error('This pipeline has no repository to update.'); }
			definition.repository.defaultBranch = defaultBranch;
		}
		if (yamlPath !== undefined) {
			if (definition.process?.type !== 2) { throw new Error('Only YAML pipelines have a YAML path.'); }
			definition.process = { ...definition.process, yamlFilename: yamlPath } as YamlProcess;
		}
		for (const [variableName, value] of Object.entries(variables ?? {})) {
			if (definition.variables?.[variableName]?.isSecret) {
				throw new Error(`Cannot overwrite secret variable ${variableName}. Manage secrets in Azure DevOps.`);
			}
			definition.variables ??= {};
			definition.variables[variableName] = { ...definition.variables[variableName], value, isSecret: false };
		}
		return jsonResult(definitionSummary(await api.updateDefinition(definition, project, pipelineId, pipelineId, expectedRevision)));
	});

	server.registerTool('get_pipeline_yaml', {
		title: 'Read CI Pipeline YAML',
		description: 'Read the configured YAML file from an explicit Azure Repos Git branch. Returns its exact commit ID and pipeline revision for conflict-safe edits. Templates must be edited in the repository separately.',
		inputSchema: z.object({ ...pipelineSchema, branch: branchSchema }),
		annotations: { readOnlyHint: true },
	}, async ({ organization, project, pipelineId, branch }) => {
		const definition = await (await getBuildApi(organization)).getDefinition(project, pipelineId);
		const { path, repositoryId } = yamlSource(definition);
		const api = await getGitApi(organization);
		const refs = await api.getRefs(repositoryId, project, branch.replace(/^refs\//, ''));
		const commitId = refs.find(ref => ref.name === branch)?.objectId;
		if (!commitId) { throw new Error(`Branch ${branch} was not found.`); }
		const item = await api.getItem(repositoryId, path, project, undefined, undefined, false, false, false,
			{ version: commitId, versionType: GitVersionType.Commit }, true);
		if (typeof item.content !== 'string') { throw new Error('Azure DevOps did not return YAML file content.'); }
		return jsonResult({ pipelineId, revision: definition.revision, repositoryId, branch, commitId, path, content: item.content });
	});

	server.registerTool('update_pipeline_yaml', {
		title: 'Commit CI Pipeline YAML Edit',
		description: 'Commit replacement pipeline YAML to an existing Azure Repos Git branch after the user confirms the exact content, branch and commit message. Use a PR feature branch. Requires the revision and commit ID from get_pipeline_yaml; rejects concurrent definition changes or branch advances. Does not change the local working tree and does not bypass branch policies.',
		inputSchema: z.object({
			...pipelineSchema,
			branch: branchSchema,
			expectedRevision: z.number().int().positive().describe('revision returned by get_pipeline_yaml for the reviewed file.'),
			expectedCommitId: commitSchema.describe('commitId returned by get_pipeline_yaml. The remote branch must still point to this commit.'),
			content: z.string().min(1).max(1_000_000),
			commitMessage: z.string().min(1).max(4000),
			confirm: confirmationSchema,
		}),
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
	}, async ({ organization, project, pipelineId, branch, expectedRevision, expectedCommitId, content, commitMessage }) => {
		const definition = await (await getBuildApi(organization)).getDefinition(project, pipelineId);
		checkRevision(definition, expectedRevision);
		const { path, repositoryId } = yamlSource(definition);
		const push = await (await getGitApi(organization)).createPush({
			refUpdates: [{ name: branch, oldObjectId: expectedCommitId }],
			commits: [{
				comment: commitMessage,
				changes: [{ changeType: VersionControlChangeType.Edit, item: { path }, newContent: { content, contentType: ItemContentType.RawText } }],
			}],
		}, repositoryId, project);
		return jsonResult({ pipelineId, repositoryId, branch, path, commitId: push.commits?.[0]?.commitId, pushId: push.pushId });
	});
}