import * as assert from 'assert';
import * as vscode from 'vscode';
import { GitVersionType } from 'azure-devops-node-api/interfaces/GitInterfaces';
import {
	CheckoutPullRequestBranchArguments,
	PullRequestCommandBridge,
	PullRequestReviewStateArguments,
	PullRequestReviewStateStore,
	SharedWorkspaceStateStore,
} from '../extension';
import { loadPullRequestReview } from '../pull-request-review';
import { PullRequestRefreshSnapshot, reviewChanged } from '../pull-request-refresh';
import { AzureDevOpsAuthentication } from '../authentication';
import { createTokenProvider } from '../mcp-server';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import { mcpServerInfo, mcpServerInstructions, mcpServerLabel } from '../mcp-guidance';


suite('Azure DevOps PRs (MCP) extension', () => {
	test('advertises pipeline capabilities and agent workflows over MCP stdio before authentication', async function () {
		this.timeout(15_000);
		const child = spawn(process.execPath, [join(__dirname, '..', '..', 'dist', 'mcp-server.js')], {
			env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', AZURE_DEVOPS_ACCESS_TOKEN: 'unused-test-token', AZURE_DEVOPS_ACCESS_TOKEN_URL: undefined },
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		const exited = new Promise<void>((resolve, reject) => {
			child.once('exit', () => resolve());
			child.once('error', reject);
		});
		let stderr = '';
		child.stderr.on('data', chunk => { stderr += String(chunk); });
		const lines = createInterface({ input: child.stdout });
		const responses = lines[Symbol.asyncIterator]();
		const timeout = setTimeout(() => child.kill(), 10_000);
		async function request(id: number, method: string, params: Record<string, unknown> = {}) {
			child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
			for (;;) {
				const line = await responses.next();
				assert.ok(!line.done, `MCP server exited before replying: ${stderr}`);
				const message = JSON.parse(line.value);
				if (message.id !== id) { continue; }
				assert.ok(!message.error, JSON.stringify(message.error));
				return message.result;
			}
		}
		try {
			const initialized = await request(1, 'initialize', {
				protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'guidance-tests', version: '1.0.0' },
			});
			const extension = vscode.extensions.getExtension('aitostack.azure-devops-prs-mcp');
			assert.strictEqual(initialized.serverInfo.name, mcpServerInfo.name);
			assert.strictEqual(initialized.serverInfo.title, 'Azure DevOps PRs and Pipelines');
			assert.strictEqual(initialized.serverInfo.version, extension?.packageJSON.version);
			assert.strictEqual(initialized.instructions, mcpServerInstructions);
			assert.match(initialized.instructions, /^Azure DevOps PRs and CI Pipelines/);
			assert.match(initialized.instructions, /expectedRevision from revision and expectedCommitId from commitId/);
			assert.match(initialized.instructions, /get_pull_request_summary for quiet inspection/);
			assert.match(initialized.instructions, /untrusted task data/);
			assert.strictEqual(extension?.packageJSON.contributes.mcpServerDefinitionProviders[0].label, mcpServerLabel);
			child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
			const { tools } = await request(2, 'tools/list');
			for (const name of [
				'list_pipelines', 'get_pipeline', 'list_pipeline_runs', 'get_pipeline_run', 'get_pipeline_run_log',
				'run_pipeline', 'cancel_pipeline_run', 'update_pipeline', 'get_pipeline_yaml', 'update_pipeline_yaml', 'show_pipeline_run', 'show_pipeline_run_log',
			]) {
				const tool = tools.find((candidate: { name: string }) => candidate.name === name);
				assert.ok(tool, `${name} must be discoverable`);
				assert.ok(tool.title, `${name} must have a human-readable title`);
				assert.ok(initialized.instructions.includes(name), `${name} must be explained in server instructions`);
			}
			assert.match(tools.find((tool: { name: string }) => tool.name === 'get_workspace_repositories').description, /CI pipelines/);
			for (const name of ['run_pipeline', 'cancel_pipeline_run', 'update_pipeline', 'update_pipeline_yaml']) {
				const tool = tools.find((candidate: { name: string }) => candidate.name === name);
				assert.ok(tool.inputSchema.required.includes('confirm'));
				assert.strictEqual(tool.inputSchema.properties.confirm.const, true);
			}
			for (const name of ['show_pipeline_run', 'show_pipeline_run_log']) {
				assert.strictEqual(tools.find((tool: { name: string }) => tool.name === name)._meta.ui.resourceUri, 'ui://azure-devops/pipeline-card.html');
			}
			const resource = await request(3, 'resources/read', { uri: 'ui://azure-devops/pipeline-card.html' });
			assert.strictEqual(resource.contents[0].mimeType, 'text/html;profile=mcp-app');
			assert.match(resource.contents[0].text, /--review-surface-radius/);
			assert.match(resource.contents[0].text, /pipeline-log-line/);
			assert.match(resource.contents[0].text, /Show run status/);
		} finally {
			clearTimeout(timeout);
			lines.close();
			child.kill();
			await exited;
		}
	});

	test('unblocks a pending token lookup when sign-in succeeds', async () => {
		let completeSilentLookup: ((session: vscode.AuthenticationSession) => void) | undefined;
		const authentication = new AzureDevOpsAuthentication(async createIfNone => createIfNone
			? { id: 'session', accessToken: 'signed-in-token', account: { id: 'account', label: 'Test account' }, scopes: [] }
			: new Promise(resolve => { completeSilentLookup = resolve; }));
		try {
			const pendingToken = authentication.getAccessToken();
			await authentication.signIn();
			assert.strictEqual(await Promise.race([
				pendingToken,
				new Promise(resolve => setTimeout(() => resolve('timed out'), 100)),
			]), 'signed-in-token');
			completeSilentLookup?.({ id: 'old-session', accessToken: 'old-token', account: { id: 'account', label: 'Test account' }, scopes: [] });
			assert.strictEqual(await authentication.getAccessToken(), 'signed-in-token');
		} finally {
			authentication.dispose();
		}
	});

	test('shares one sign-in for concurrent interactive token requests', async () => {
		let signInCount = 0;
		const authentication = new AzureDevOpsAuthentication(async createIfNone => {
			if (!createIfNone) {
				return undefined;
			}
			signInCount++;
			return { id: 'session', accessToken: 'signed-in-token', account: { id: 'account', label: 'Test account' }, scopes: [] };
		});
		try {
			assert.deepStrictEqual(await Promise.all([
				authentication.getAccessToken(true),
				authentication.getAccessToken(true),
			]), ['signed-in-token', 'signed-in-token']);
			assert.strictEqual(signInCount, 1);
		} finally {
			authentication.dispose();
		}
	});

	test('does not start interactive sign-in for background token requests', async () => {
		const requests: boolean[] = [];
		const authentication = new AzureDevOpsAuthentication(async createIfNone => {
			requests.push(createIfNone);
			return undefined;
		});
		try {
			await assert.rejects(authentication.getAccessToken(), /authentication is unavailable/);
			assert.deepStrictEqual(requests, [false]);
		} finally {
			authentication.dispose();
		}
	});

	test('times out a silent lookup and allows the next token request to recover', async () => {
		let requests = 0;
		const authentication = new AzureDevOpsAuthentication(async () => ++requests === 1
			? new Promise(() => {})
			: { id: 'session', accessToken: 'recovered-token', account: { id: 'account', label: 'Test account' }, scopes: [] }, 10);
		try {
			await assert.rejects(authentication.getAccessToken(), /authentication timed out/);
			assert.strictEqual(await authentication.getAccessToken(), 'recovered-token');
		} finally {
			authentication.dispose();
		}
	});

	test('fails cancelled sign-in requests and allows a later attempt', async () => {
		let signInCount = 0;
		const authentication = new AzureDevOpsAuthentication(async createIfNone => {
			if (!createIfNone) {
				throw new Error('Silent refresh failed');
			}
			if (++signInCount === 1) {
				throw new Error('Sign-in cancelled');
			}
			return { id: 'session', accessToken: 'recovered-token', account: { id: 'account', label: 'Test account' }, scopes: [] };
		});
		try {
			const results = await Promise.allSettled([authentication.getAccessToken(true), authentication.getAccessToken(true)]);
			assert.ok(results.every(result => result.status === 'rejected' && /Sign-in cancelled/.test(String(result.reason))));
			assert.strictEqual(signInCount, 1);
			assert.strictEqual(await authentication.getAccessToken(true), 'recovered-token');
		} finally {
			authentication.dispose();
		}
	});

	test('times out interactive sign-in instead of leaving commands pending', async () => {
		const authentication = new AzureDevOpsAuthentication(async createIfNone => createIfNone ? new Promise(() => {}) : undefined, 10, 10);
		try {
			await assert.rejects(authentication.getAccessToken(true), /authentication timed out/);
		} finally {
			authentication.dispose();
		}
	});

	test('requests sign-in when the provider returns an expired access token', async () => {
		const expiredToken = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 60 })).toString('base64url')}.signature`;
		const authentication = new AzureDevOpsAuthentication(async createIfNone => ({
			id: 'session',
			accessToken: createIfNone ? 'fresh-token' : expiredToken,
			account: { id: 'account', label: 'Test account' },
			scopes: [],
		}));
		try {
			assert.strictEqual(await authentication.getAccessToken(true), 'fresh-token');
		} finally {
			authentication.dispose();
		}
	});

	test('activates and registers its commands', async () => {
		const extension = vscode.extensions.getExtension('aitostack.azure-devops-prs-mcp');
		assert.ok(extension, 'Azure DevOps PRs (MCP) extension should be available');

		await extension.activate();
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes('azure-devops-mcp.signIn'));
		assert.ok(commands.includes('azure-devops-mcp.openPullRequestFileDiff'));
		assert.ok(commands.includes('azure-devops-mcp.replyToPullRequestComment'));
		assert.ok(commands.includes('azure-devops-mcp.addPullRequestComment'));
		assert.ok(commands.includes('azure-devops-mcp.openLocalPullRequestFile'));
		assert.ok(commands.includes('azure-devops-mcp.refreshOverview'));
		assert.ok(commands.includes('azure-devops-mcp.selectOverviewRepository'));
		assert.ok(commands.includes('azure-devops-mcp.selectOverviewDraft'));
		assert.ok(commands.includes('azure-devops-mcp.deletePullRequestDraft'));
	});

	test('forwards checkout and reviewed-file actions with their full card parameters', async () => {
		let diffArguments: object | undefined;
		let checkoutArguments: CheckoutPullRequestBranchArguments | undefined;
		let requestToken = async () => 'current-access-token';
		const workspaceContext = {
			repositories: [{ organization: 'example-org', project: 'example-project', repository: 'example-repository' }],
			activeRepository: { organization: 'example-org', project: 'example-project', repository: 'example-repository' },
		};
		const values = new Map<string, unknown>();
		const sharedState = new SharedWorkspaceStateStore({
			get: <T>(key: string, defaultValue?: T): T => (values.get(key) as T | undefined) ?? defaultValue as T,
			update: async (key: string, value: unknown): Promise<void> => {
				values.set(key, value);
			},
		});
		const bridge = new PullRequestCommandBridge(
			async arguments_ => {
				diffArguments = arguments_;
			},
			async () => undefined,
			async arguments_ => {
				checkoutArguments = arguments_;
				return 'feature/example-branch';
			},
			async () => workspaceContext,
			sharedState,
			async interactive => {
				assert.strictEqual(interactive, true);
				return requestToken();
			},
		);

		try {
			const environment = await bridge.getServerEnvironment();
			const headers = {
				Authorization: `Bearer ${environment.AZURE_DEVOPS_DIFF_COMMAND_TOKEN}`,
				'Content-Type': 'application/json',
			};
			const identity = {
				organization: 'example-org',
				project: 'example-project',
				repository: 'example-repository',
			};

			const diffResponse = await fetch(environment.AZURE_DEVOPS_DIFF_COMMAND_URL, {
				method: 'POST',
				headers,
				body: JSON.stringify({
					...identity,
					pullRequestId: 123,
					path: '/src/example.ts',
					sourceCommit: 'source-commit',
					targetCommit: 'target-commit',
					changeType: 2,
				}),
			});
			assert.strictEqual(diffResponse.status, 204);
			assert.deepStrictEqual(diffArguments, {
				...identity,
				pullRequestId: 123,
				path: '/src/example.ts',
				sourceCommit: 'source-commit',
				targetCommit: 'target-commit',
				changeType: 2,
			});

			const checkoutResponse = await fetch(environment.AZURE_DEVOPS_CHECKOUT_BRANCH_URL, {
				method: 'POST',
				headers,
				body: JSON.stringify({ ...identity, branch: 'refs/heads/feature/example-branch' }),
			});
			assert.strictEqual(checkoutResponse.status, 200);
			assert.deepStrictEqual(checkoutArguments, {
				...identity,
				branch: 'refs/heads/feature/example-branch',
			});

			const workspaceResponse = await fetch(environment.AZURE_DEVOPS_WORKSPACE_CONTEXT_URL, {
				method: 'POST',
				headers,
				body: '{}',
			});
			assert.strictEqual(workspaceResponse.status, 200);
			assert.deepStrictEqual(await workspaceResponse.json(), workspaceContext);

			const tokenResponse = await fetch(environment.AZURE_DEVOPS_ACCESS_TOKEN_URL, {
				method: 'POST',
				headers,
				body: '{}',
			});
			assert.strictEqual(tokenResponse.status, 200);
			assert.deepStrictEqual(await tokenResponse.json(), { accessToken: 'current-access-token' });

			const getAccessToken = createTokenProvider(environment);
			assert.strictEqual(await getAccessToken(), 'current-access-token');
			requestToken = async () => { throw new Error('Sign-in cancelled'); };
			await assert.rejects(getAccessToken(), /Sign-in cancelled/);
			requestToken = async () => new Promise(() => {});
			await assert.rejects(createTokenProvider(environment, 20)(), /authentication timed out/);

			const stateResponse = await fetch(environment.AZURE_DEVOPS_SHARED_STATE_URL, {
				method: 'POST',
				headers,
				body: JSON.stringify({
					key: 'example.state',
					value: ['updated'],
					set: true,
				}),
			});
			assert.strictEqual(stateResponse.status, 200);
			assert.deepStrictEqual(await stateResponse.json(), { value: ['updated'], version: 1, applied: true });
		} finally {
			bridge.dispose();
			sharedState.dispose();
		}
	});

	test('retains concurrent reviewed-file updates for the same pull request', async () => {
		const values = new Map<string, unknown>();
		const store = new PullRequestReviewStateStore({
			get: <T>(key: string, defaultValue?: T): T => (values.get(key) as T | undefined) ?? defaultValue as T,
			update: async (key: string, value: unknown): Promise<void> => {
				await new Promise(resolve => setTimeout(resolve, 1));
				values.set(key, value);
			},
		});
		const identity = {
			organization: 'example-org',
			project: 'example-project',
			repository: 'example-repository',
			pullRequestId: 123,
			reviewed: true,
		};

		await Promise.all([
			store.setFileReviewed({ ...identity, path: '/src/example.ts' }),
			store.setFileReviewed({ ...identity, path: '/scripts/setup.ts' }),
		]);

		assert.deepStrictEqual(store.getReviewedPaths(identity), [
			'/scripts/setup.ts',
			'/src/example.ts',
		]);
	});

	test('loads only source changes since the pull request merge base', async () => {
		let diffArguments: unknown[] | undefined;
		const review = await loadPullRequestReview({
			pullRequestId: 123,
			lastMergeSourceCommit: { commitId: 'source-commit' },
			lastMergeTargetCommit: { commitId: 'target-commit' },
			sourceRefName: 'refs/heads/feature/example',
			targetRefName: 'refs/heads/develop',
		} as never, {
			organization: 'example-org',
			project: 'example-project',
			repository: 'example-repository',
		}, {
			getGitApi: async () => ({
				getMergeBases: async () => [{ commitId: 'merge-base-commit' }],
				getCommitDiffs: async (...arguments_: unknown[]) => {
					diffArguments = arguments_;
					return {
						changes: [
							{ item: { path: '/pipelines', isFolder: true }, changeType: 2 },
							{ item: { path: '/.npmrc' }, changeType: 16 },
						],
						allChangesIncluded: true,
					};
				},
				getThreads: async () => [],
			}) as never,
		});

		assert.deepStrictEqual(review.changes.map(change => ({ path: change.path, changeType: change.changeType })), [
			{ path: '/.npmrc', changeType: 16 },
		]);
		assert.deepStrictEqual(diffArguments?.slice(5), [
			{ version: 'merge-base-commit', versionType: GitVersionType.Commit },
			{ version: 'source-commit', versionType: GitVersionType.Commit },
		]);
	});

	test('refreshes a card when any displayed pull request content changes', () => {
		const review: PullRequestRefreshSnapshot = {
			title: 'Original title',
			description: 'Original description',
			status: 1,
			sourceRef: 'refs/heads/feature/example',
			targetRef: 'refs/heads/develop',
			sourceCommit: 'source-commit',
			targetCommit: 'target-commit',
			reviewers: [{ id: 'reviewer-1', displayName: 'Reviewer', vote: 0 }],
			workItems: [{ id: 123, title: 'Original work item', description: '<p>Original description</p>', type: 'Task', state: 'Active' }],
			changes: [{ path: '/src/example.ts', changeType: 2, commentCount: 0 }],
		};

		assert.strictEqual(reviewChanged(review, { ...review }), false);
		assert.strictEqual(reviewChanged(review, { ...review, title: 'Updated title' }), true);
		assert.strictEqual(reviewChanged(review, { ...review, description: 'Updated description' }), true);
		assert.strictEqual(reviewChanged(review, { ...review, status: 2 }), true);
		assert.strictEqual(reviewChanged(review, { ...review, targetRef: 'refs/heads/release' }), true);
		assert.strictEqual(reviewChanged(review, { ...review, reviewers: [{ id: 'reviewer-1', displayName: 'Reviewer', vote: 10 }] }), true);
		assert.strictEqual(reviewChanged(review, { ...review, workItems: [{ id: 123, title: 'Original work item', type: 'Task', state: 'Resolved' }] }), true);
		assert.strictEqual(reviewChanged(review, { ...review, workItems: [{ id: 123, title: 'Original work item', description: '<p>Updated description</p>', type: 'Task', state: 'Active' }] }), true);
		assert.strictEqual(reviewChanged(review, { ...review, changes: [{ path: '/src/example.ts', changeType: 2, commentCount: 1 }] }), true);
	});

	test('notifies shared state subscribers with an incremented revision', async () => {
		const values = new Map<string, unknown>();
		const store = new SharedWorkspaceStateStore({
			get: <T>(key: string, defaultValue?: T): T => (values.get(key) as T | undefined) ?? defaultValue as T,
			update: async (key: string, value: unknown): Promise<void> => {
				values.set(key, value);
			},
		});
		const wait = store.waitForChange('example.state', 0, [] as string[], 1_000);

		await store.set('example.state', ['updated']);

		assert.deepStrictEqual(await wait, { value: ['updated'], version: 1 });
		store.dispose();
	});
});
