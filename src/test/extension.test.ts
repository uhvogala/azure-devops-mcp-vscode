import * as assert from 'assert';
import * as vscode from 'vscode';
import {
	CheckoutPullRequestBranchArguments,
	PullRequestCommandBridge,
	PullRequestReviewStateArguments,
	PullRequestReviewStateStore,
	SharedWorkspaceStateStore,
} from '../extension';


suite('Azure DevOps PRs (MCP) extension', () => {
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
	});

	test('forwards checkout and reviewed-file actions with their full card parameters', async () => {
		let diffArguments: object | undefined;
		let checkoutArguments: CheckoutPullRequestBranchArguments | undefined;
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
			sharedState,
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
