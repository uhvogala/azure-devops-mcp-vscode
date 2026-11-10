import * as assert from 'assert';
import { InMemoryTransport, LATEST_PROTOCOL_VERSION, McpServer } from '@modelcontextprotocol/server';
import { BuildApi, IBuildApi } from 'azure-devops-node-api/BuildApi';
import { IGitApi } from 'azure-devops-node-api/GitApi';
import { IPipelinesApi } from 'azure-devops-node-api/PipelinesApi';
import { BuildDefinition, BuildStatus, DefinitionQueueStatus } from 'azure-devops-node-api/interfaces/BuildInterfaces';
import { GitVersionType, ItemContentType, VersionControlChangeType } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { pipelineCardUri, registerPipelineTools } from '../pipeline-tools';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

const identity = { organization: 'example-org', project: 'example-project' };
const commitId = 'a'.repeat(40);
const branch = 'refs/heads/feature/ci';

function yamlDefinition(): BuildDefinition {
	return {
		id: 42, name: 'CI', revision: 3, queueStatus: DefinitionQueueStatus.Enabled,
		process: { type: 2, yamlFilename: '/azure-pipelines.yml' },
		repository: { id: 'repository-id', name: 'repo', type: 'TfsGit', defaultBranch: 'refs/heads/main' },
		variables: { token: { isSecret: true, value: 'server-secret' }, config: { value: 'Debug', allowOverride: true } },
		triggers: [{ triggerType: 2 }],
	} as BuildDefinition;
}

interface ToolResult {
	isError?: boolean;
	structuredContent?: Record<string, unknown>;
	content: { type: string; text?: string }[];
}

interface TestApis {
	build?: Partial<IBuildApi>;
	git?: Partial<IGitApi>;
	pipelines?: Partial<IPipelinesApi>;
}

async function withTools(apis: TestApis, testTools: (tools: {
	call: (name: string, arguments_?: Record<string, unknown>) => Promise<ToolResult>;
	list: () => Promise<{ tools: { name: string; annotations?: { readOnlyHint?: boolean }; _meta?: { ui?: { resourceUri?: string } } }[] }>;
}) => Promise<void>): Promise<void> {
	const server = new McpServer({ name: 'pipeline-tests', version: '1.0.0' });
	registerPipelineTools(server, {
		getBuildApi: async () => { assert.ok(apis.build, 'Unexpected Build API request'); return apis.build as IBuildApi; },
		getGitApi: async () => { assert.ok(apis.git, 'Unexpected Git API request'); return apis.git as IGitApi; },
		getPipelinesApi: async () => { assert.ok(apis.pipelines, 'Unexpected Pipelines API request'); return apis.pipelines as IPipelinesApi; },
	});
	const [client, transport] = InMemoryTransport.createLinkedPair();
	let nextId = 0;
	const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	client.onmessage = message => {
		if (!('id' in message) || typeof message.id !== 'number') { return; }
		const request = pending.get(message.id);
		if (!request) { return; }
		pending.delete(message.id);
		if ('error' in message) { request.reject(new Error(message.error.message)); }
		else if ('result' in message) { request.resolve(message.result); }
	};
	async function request<Result>(method: string, params: Record<string, unknown> = {}): Promise<Result> {
		const id = ++nextId;
		const response = new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }));
		await client.send({ jsonrpc: '2.0', id, method, params });
		return await response as Result;
	}
	try {
		await server.connect(transport);
		await client.start();
		await request('initialize', { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'tests', version: '1.0.0' } });
		await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
		await testTools({
			call: (name, arguments_ = {}) => request('tools/call', { name, arguments: { ...identity, ...arguments_ } }),
			list: () => request('tools/list'),
		});
	} finally {
		await server.close();
		await client.close();
	}
}

function data(result: ToolResult): Record<string, unknown> {
	assert.ok(!result.isError, JSON.stringify(result.content));
	assert.ok(result.structuredContent);
	return result.structuredContent;
}

function expectError(result: ToolResult, message: RegExp): void {
	assert.strictEqual(result.isError, true);
	assert.match(JSON.stringify(result.content), message);
}

async function withBuildHttp(handler: (request: IncomingMessage, response: ServerResponse) => void, testApi: (api: BuildApi) => Promise<void>): Promise<void> {
	const errors: unknown[] = [];
	const server = createServer((request, response) => {
		try { handler(request, response); }
		catch (error) {
			errors.push(error);
			response.statusCode = 500;
			response.end('Unexpected build API request');
		}
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const api = new BuildApi(`http://127.0.0.1:${(server.address() as AddressInfo).port}/organization`, []);
	try {
		await testApi(api);
		assert.strictEqual(errors.length, 0, String(errors[0]));
	} finally {
		api.http.dispose();
		api.rest.client.dispose();
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	}
}

suite('Azure DevOps pipeline tools', () => {
	test('registers discovery, monitoring, execution and editing tools with read-only hints', async () => {
		await withTools({}, async tools => {
			const { tools: registered } = await tools.list();
			assert.deepStrictEqual(registered.map(tool => tool.name).sort(), [
				'cancel_pipeline_run', 'get_pipeline', 'get_pipeline_run', 'get_pipeline_run_log', 'get_pipeline_yaml',
				'list_pipeline_runs', 'list_pipelines', 'run_pipeline', 'show_pipeline_run', 'show_pipeline_run_log', 'update_pipeline', 'update_pipeline_yaml',
			]);
			assert.strictEqual(registered.find(tool => tool.name === 'get_pipeline_run')?.annotations?.readOnlyHint, true);
			assert.strictEqual(registered.find(tool => tool.name === 'run_pipeline')?.annotations?.readOnlyHint, false);
		});
	});

	test('attaches card resources only to explicit show tools', async () => {
		await withTools({}, async tools => {
			const { tools: registered } = await tools.list();
			for (const name of ['show_pipeline_run', 'show_pipeline_run_log']) {
				const tool = registered.find(candidate => candidate.name === name);
				assert.strictEqual(tool?._meta?.ui?.resourceUri, pipelineCardUri);
				assert.strictEqual(tool?.annotations?.readOnlyHint, true);
			}
			for (const name of ['get_pipeline_run', 'get_pipeline_run_log']) {
				assert.strictEqual(registered.find(tool => tool.name === name)?._meta?.ui?.resourceUri, undefined);
			}
		});
	});

	test('shows run cards with identity, timeline, and task order while quiet reads stay unchanged', async () => {
		await withTools({ build: {
			getBuild: async () => ({ id: 100, status: BuildStatus.InProgress, definition: { id: 42, name: 'CI' } }),
			getBuildTimeline: async () => ({ records: [{ id: 'task', name: 'Tests', type: 'Task', order: 2, log: { id: 7 } }] }),
		} }, async tools => {
			const card = data(await tools.call('show_pipeline_run', { runId: 100 }));
			assert.strictEqual(card.view, 'run');
			assert.strictEqual(card.organization, identity.organization);
			assert.strictEqual(card.project, identity.project);
			assert.strictEqual(card.runId, 100);
			assert.strictEqual(card.status, 'InProgress');
			assert.strictEqual((card.records as { order: number }[])[0].order, 2);
			const quiet = data(await tools.call('get_pipeline_run', { runId: 100 }));
			assert.strictEqual(quiet.view, undefined);
			assert.deepStrictEqual(quiet.records, card.records);
		});
	});

	test('shows bounded log cards without interpreting or changing untrusted text', async () => {
		const lines = ['<script>alert("not markup")</script>', '\u001b[31m##[error] failure\u001b[0m'];
		await withTools({ build: { getBuildLogLines: async (...arguments_) => {
			assert.deepStrictEqual(arguments_, [identity.project, 100, 7, 13, 14]);
			return lines;
		} } }, async tools => {
			const card = data(await tools.call('show_pipeline_run_log', { runId: 100, logId: 7, startLine: 12, lineCount: 2 }));
			assert.strictEqual(card.view, 'log');
			assert.strictEqual(card.lineCount, 2);
			assert.strictEqual(card.nextStartLine, 14);
			assert.deepStrictEqual(card.lines, lines);
			assert.strictEqual(card.organization, identity.organization);
			expectError(await tools.call('show_pipeline_run_log', { runId: 100 }), /logId/);
		});
	});

	test('rejects every unconfirmed mutation before requesting authentication or APIs', async () => {
		await withTools({}, async tools => {
			for (const name of ['run_pipeline', 'cancel_pipeline_run', 'update_pipeline', 'update_pipeline_yaml']) {
				for (const confirm of [undefined, false]) {
					expectError(await tools.call(name, {
						pipelineId: 42, runId: 100, branch, expectedRevision: 3, expectedCommitId: commitId,
						content: 'steps: []', commitMessage: 'fix: CI', name: 'New CI', confirm,
					}), /confirm/);
				}
			}
		});
	});

	test('resolves workspace repository names and forwards definition pagination', async () => {
		await withBuildHttp((request, response) => {
			const url = new URL(request.url!, 'http://localhost');
			assert.strictEqual(request.method, 'GET');
			assert.strictEqual(url.pathname, `/organization/${identity.project}/_apis/build/definitions`);
			assert.strictEqual(url.searchParams.get('api-version'), '7.1');
			assert.strictEqual(url.searchParams.get('name'), '*CI*');
			assert.strictEqual(url.searchParams.get('repositoryId'), 'repository-id');
			assert.strictEqual(url.searchParams.get('repositoryType'), 'TfsGit');
			assert.strictEqual(url.searchParams.get('$top'), '5');
			assert.strictEqual(url.searchParams.get('continuationToken'), 'previous');
			assert.strictEqual(url.searchParams.get('queryOrder'), 'lastModifiedDescending');
			response.setHeader('Content-Type', 'application/json');
			response.setHeader('x-ms-continuationtoken', 'next-page');
			response.end(JSON.stringify({ count: 1, value: [{ id: 42, name: 'CI' }] }));
		}, async build => withTools({
			git: { getRepository: async (repository, project) => {
				assert.strictEqual(repository, 'repo'); assert.strictEqual(project, identity.project);
				return { id: 'repository-id' };
			} },
			build,
		}, async tools => {
			const result = data(await tools.call('list_pipelines', { repository: 'repo', name: '*CI*', top: 5, continuationToken: 'previous' }));
			assert.strictEqual(result.continuationToken, 'next-page');
			assert.strictEqual((result.pipelines as { id: number }[])[0].id, 42);
		}));
	});

	test('filters runs by PR merge ref, status and pipeline with pagination', async () => {
		await withBuildHttp((request, response) => {
			const url = new URL(request.url!, 'http://localhost');
			assert.strictEqual(url.pathname, `/organization/${identity.project}/_apis/build/builds`);
			assert.strictEqual(url.searchParams.get('definitions'), '42');
			assert.strictEqual(url.searchParams.get('statusFilter'), String(BuildStatus.InProgress));
			assert.strictEqual(url.searchParams.get('$top'), '5');
			assert.strictEqual(url.searchParams.get('continuationToken'), 'previous');
			assert.strictEqual(url.searchParams.get('branchName'), 'refs/pull/12/merge');
			response.setHeader('Content-Type', 'application/json');
			response.setHeader('x-ms-continuationtoken', 'next');
			response.end(JSON.stringify({ count: 1, value: [{ id: 100, status: 'inProgress' }] }));
		}, async build => withTools({ build }, async tools => {
			const result = data(await tools.call('list_pipeline_runs', { pipelineId: 42, pullRequestId: 12, status: 'inProgress', top: 5, continuationToken: 'previous' }));
			assert.strictEqual(result.continuationToken, 'next');
			assert.strictEqual((result.runs as { status: string }[])[0].status, 'InProgress');
			expectError(await tools.call('list_pipeline_runs', { branch, pullRequestId: 12 }), /branch or pullRequestId/);
		}));
	});

	test('follows opaque HTTP pagination tokens and stops at the last page', async () => {
		let requests = 0;
		await withBuildHttp((request, response) => {
			requests++;
			const url = new URL(request.url!, 'http://localhost');
			assert.strictEqual(url.searchParams.get('$top'), '1');
			assert.strictEqual(url.searchParams.get('queryOrder'), 'lastModifiedDescending');
			assert.strictEqual(url.searchParams.has('repositoryId'), false);
			response.setHeader('Content-Type', 'application/json');
			if (requests === 1) {
				assert.strictEqual(url.searchParams.has('continuationToken'), false);
				response.setHeader('X-MS-ContinuationToken', 'next/+==');
				response.end(JSON.stringify({ count: 1, value: [{ id: 42, name: 'CI' }] }));
			} else {
				assert.strictEqual(url.searchParams.get('continuationToken'), 'next/+==');
				response.end(JSON.stringify({ count: 1, value: [{ id: 43, name: 'Release' }] }));
			}
		}, async build => withTools({ build }, async tools => {
			const first = data(await tools.call('list_pipelines', { top: 1 }));
			assert.strictEqual(first.continuationToken, 'next/+==');
			const second = data(await tools.call('list_pipelines', { top: 1, continuationToken: first.continuationToken }));
			assert.strictEqual(second.continuationToken, undefined);
			assert.deepStrictEqual((second.pipelines as { id: number }[]).map(pipeline => pipeline.id), [43]);
			assert.strictEqual(requests, 2);
		}));
	});

	test('returns run timelines and log IDs without waiting for completion', async () => {
		await withTools({ build: {
			getBuild: async (project, id) => { assert.strictEqual(project, identity.project); return { id, status: BuildStatus.InProgress }; },
			getBuildTimeline: async () => ({ records: [{ id: 'job', name: 'Tests', log: { id: 7 }, issues: [{ message: 'A test failed' }] }] }),
		} }, async tools => {
			const result = data(await tools.call('get_pipeline_run', { runId: 100 }));
			assert.strictEqual(result.status, 'InProgress');
			assert.strictEqual((result.records as { logId: number }[])[0].logId, 7);
		});
	});

	test('allows status-only monitoring without requesting a timeline', async () => {
		await withTools({ build: { getBuild: async () => ({ id: 100, status: BuildStatus.NotStarted }) } }, async tools => {
			assert.strictEqual(data(await tools.call('get_pipeline_run', { runId: 100, includeTimeline: false })).status, 'NotStarted');
		});
	});

	test('monitors queued runs before a timeline exists without hiding permission failures', async () => {
		let statusCode = 404;
		await withTools({ build: {
			getBuild: async () => ({ id: 100, status: BuildStatus.NotStarted }),
			getBuildTimeline: async () => { throw Object.assign(new Error('Timeline unavailable'), { statusCode }); },
		} }, async tools => {
			const result = data(await tools.call('get_pipeline_run', { runId: 100 }));
			assert.strictEqual(result.status, 'NotStarted');
			assert.strictEqual(result.timelineAvailable, false);
			statusCode = 403;
			expectError(await tools.call('get_pipeline_run', { runId: 100 }), /Timeline unavailable/);
		});
	});

	test('translates zero-based log ranges to one-based inclusive service ranges', async () => {
		await withTools({ build: {
			getBuildLogs: async () => [{ id: 7, lineCount: 500 }],
			getBuildLogLines: async (...arguments_) => {
				assert.deepStrictEqual(arguments_, [identity.project, 100, 7, 11, 12]); return ['first', 'second'];
			},
		} }, async tools => {
			assert.deepStrictEqual(data(await tools.call('get_pipeline_run_log', { runId: 100 })).logs, [{ id: 7, lineCount: 500, type: undefined }]);
			const result = data(await tools.call('get_pipeline_run_log', { runId: 100, logId: 7, startLine: 10, lineCount: 2 }));
			assert.deepStrictEqual(result.lines, ['first', 'second']);
			assert.strictEqual(result.nextStartLine, 12);
			expectError(await tools.call('get_pipeline_run_log', { runId: 100, logId: 7, lineCount: 1001 }), /1000/);
		});
	});

	test('reads exactly one log line and continues without gaps or duplicates', async () => {
		const lines = ['first', 'second', 'third'];
		await withTools({ build: {
			getBuildLogLines: async (_project, _runId, _logId, startLine, endLine) => {
				assert.ok(startLine !== undefined && startLine >= 1);
				return lines.slice(startLine - 1, endLine);
			},
		} }, async tools => {
			const first = data(await tools.call('get_pipeline_run_log', { runId: 100, logId: 7, lineCount: 1 }));
			assert.deepStrictEqual(first.lines, ['first']);
			assert.strictEqual(first.nextStartLine, 1);
			const rest = data(await tools.call('get_pipeline_run_log', { runId: 100, logId: 7, startLine: first.nextStartLine, lineCount: 2 }));
			assert.deepStrictEqual(rest.lines, ['second', 'third']);
			assert.strictEqual(rest.nextStartLine, 3);
			const end = data(await tools.call('get_pipeline_run_log', { runId: 100, logId: 7, startLine: rest.nextStartLine, lineCount: 1 }));
			assert.deepStrictEqual(end.lines, []);
			assert.strictEqual(end.nextStartLine, 3);
		});
	});

	test('queues YAML runs with unchanged typed parameters and pinned source versions', async () => {
		const templateParameters = { deploy: false, count: 2, matrix: { os: ['linux', 'windows'] } };
		await withTools({
			build: { getDefinition: async () => yamlDefinition() },
			pipelines: { runPipeline: async (parameters, project, pipelineId) => {
				assert.strictEqual(project, identity.project); assert.strictEqual(pipelineId, 42);
				assert.deepStrictEqual(parameters, {
					resources: { repositories: { self: { refName: branch, version: commitId } } }, templateParameters,
					variables: { config: { value: 'Release', isSecret: false } },
				});
				return { id: 100, state: 1 };
			} },
		}, async tools => {
			assert.strictEqual(data(await tools.call('run_pipeline', { pipelineId: 42, branch, commitId, templateParameters, variables: { config: 'Release' }, confirm: true })).id, 100);
		});
	});

	test('queues classic builds and rejects YAML parameters for classic definitions', async () => {
		await withTools({ build: {
			getDefinition: async () => ({ id: 42, process: { type: 1 } }),
			queueBuild: async (build, project) => {
				assert.strictEqual(project, identity.project);
				assert.deepStrictEqual(build, { definition: { id: 42 }, sourceBranch: branch, sourceVersion: undefined, parameters: '{"config":"Release"}' });
				return { id: 100 };
			},
		} }, async tools => {
			assert.strictEqual(data(await tools.call('run_pipeline', { pipelineId: 42, branch, parameters: { config: 'Release' }, confirm: true })).id, 100);
			expectError(await tools.call('run_pipeline', { pipelineId: 42, branch, templateParameters: {}, confirm: true }), /Classic pipelines/);
		});
	});

	test('requests cancellation only for active runs', async () => {
		let updates = 0;
		await withTools({ build: {
			getBuild: async (_project, id) => ({ id, status: id === 100 ? BuildStatus.InProgress : BuildStatus.Completed }),
			updateBuild: async (build, project, id) => {
				updates++; assert.deepStrictEqual(build, { status: BuildStatus.Cancelling });
				assert.strictEqual(project, identity.project); return { id, ...build };
			},
		} }, async tools => {
			assert.strictEqual(data(await tools.call('cancel_pipeline_run', { runId: 100, confirm: true })).status, 'Cancelling');
			assert.strictEqual(data(await tools.call('cancel_pipeline_run', { runId: 101, confirm: true })).status, 'Completed');
			assert.strictEqual(updates, 1);
		});
	});

	test('redacts secret variables and avoids exposing classic task inputs', async () => {
		const definition = yamlDefinition();
		definition.process = { type: 1, phases: [{ steps: [{ inputs: { password: 'task-secret' } }] }] } as BuildDefinition['process'];
		await withTools({ build: { getDefinition: async () => definition } }, async tools => {
			const result = await tools.call('get_pipeline', { pipelineId: 42 });
			data(result);
			assert.ok(!JSON.stringify(result).includes('server-secret'));
			assert.ok(!JSON.stringify(result).includes('task-secret'));
		});
	});

	test('preserves revision, triggers, and secret variables when editing definitions', async () => {
		const original = yamlDefinition();
		await withTools({ build: {
			getDefinition: async () => structuredClone(original),
			updateDefinition: async (definition, project, id, secretsSourceId, secretsSourceRevision) => {
				assert.strictEqual(project, identity.project); assert.strictEqual(id, 42);
				assert.strictEqual(secretsSourceId, 42); assert.strictEqual(secretsSourceRevision, 3);
				assert.strictEqual(definition.revision, 3); assert.strictEqual(definition.name, 'CI new');
				assert.deepStrictEqual(definition.triggers, original.triggers);
				assert.deepStrictEqual(definition.variables?.token, original.variables?.token);
				assert.deepStrictEqual(definition.variables?.config, { value: 'Release', allowOverride: true, isSecret: false });
				return { ...definition, revision: 4 };
			},
		} }, async tools => {
			const result = await tools.call('update_pipeline', { pipelineId: 42, expectedRevision: 3, name: 'CI new', variables: { config: 'Release' }, confirm: true });
			assert.strictEqual(data(result).revision, 4);
			assert.ok(!JSON.stringify(result).includes('server-secret'));
		});
	});

	test('refuses stale definitions and secret-variable overwrites before saving', async () => {
		await withTools({ build: { getDefinition: async () => yamlDefinition() } }, async tools => {
			expectError(await tools.call('update_pipeline', { pipelineId: 42, expectedRevision: 2, name: 'New CI', confirm: true }), /definition changed/);
			expectError(await tools.call('update_pipeline', { pipelineId: 42, expectedRevision: 3, variables: { token: 'replacement' }, confirm: true }), /Cannot overwrite secret/);
			expectError(await tools.call('update_pipeline', { pipelineId: 42, expectedRevision: 3, confirm: true }), /at least one setting/);
		});
	});

	test('reads YAML at an immutable commit selected from the exact branch ref', async () => {
		await withTools({
			build: { getDefinition: async () => yamlDefinition() },
			git: {
				getRefs: async (_repository, _project, filter) => {
					assert.strictEqual(filter, 'heads/feature/ci');
					return [{ name: `${branch}-other`, objectId: 'b'.repeat(40) }, { name: branch, objectId: commitId }];
				},
				getItem: async (...arguments_) => {
					assert.deepStrictEqual(arguments_, ['repository-id', '/azure-pipelines.yml', identity.project, undefined, undefined, false, false, false,
						{ version: commitId, versionType: GitVersionType.Commit }, true]);
					return { content: 'steps: []' };
				},
			},
		}, async tools => {
			const result = data(await tools.call('get_pipeline_yaml', { pipelineId: 42, branch }));
			assert.strictEqual(result.commitId, commitId); assert.strictEqual(result.revision, 3); assert.strictEqual(result.content, 'steps: []');
		});
	});

	test('commits YAML with an atomic branch-tip guard and propagates branch conflicts without retry', async () => {
		let pushes = 0;
		await withTools({
			build: { getDefinition: async () => yamlDefinition() },
			git: { createPush: async (push, repository, project) => {
				pushes++; assert.strictEqual(repository, 'repository-id'); assert.strictEqual(project, identity.project);
				assert.deepStrictEqual(push, {
					refUpdates: [{ name: branch, oldObjectId: commitId }],
					commits: [{ comment: 'fix: CI', changes: [{ changeType: VersionControlChangeType.Edit, item: { path: '/azure-pipelines.yml' },
						newContent: { content: 'steps: []', contentType: ItemContentType.RawText } }] }],
				});
				throw new Error('Branch changed or branch policy refused the push');
			} },
		}, async tools => {
			expectError(await tools.call('update_pipeline_yaml', {
				pipelineId: 42, branch, expectedRevision: 3, expectedCommitId: commitId, content: 'steps: []', commitMessage: 'fix: CI', confirm: true,
			}), /Branch changed/);
			assert.strictEqual(pushes, 1);
		});
	});

	test('refuses YAML edits for stale definitions or non-Azure-Repos pipelines', async () => {
		await withTools({ build: { getDefinition: async () => ({ ...yamlDefinition(), repository: { type: 'GitHub' } }) } }, async tools => {
			expectError(await tools.call('get_pipeline_yaml', { pipelineId: 42, branch }), /Azure Repos Git/);
			expectError(await tools.call('update_pipeline_yaml', {
				pipelineId: 42, branch, expectedRevision: 2, expectedCommitId: commitId, content: 'steps: []', commitMessage: 'fix: CI', confirm: true,
			}), /definition changed/);
		});
	});

	test('surfaces authentication and permission failures without retrying', async () => {
		let requests = 0;
		await withTools({ build: { getBuild: async () => { requests++; throw new Error('Sign-in cancelled'); } } }, async tools => {
			expectError(await tools.call('get_pipeline_run', { runId: 100 }), /Sign-in cancelled/);
			assert.strictEqual(requests, 1);
		});
	});
});