import * as assert from 'assert';
import * as vscode from 'vscode';
import {
	CheckoutPullRequestBranchArguments,
	PullRequestCommandBridge,
	PullRequestReviewStateArguments,
	PullRequestReviewStateStore,
} from '../extension';


suite('Azure DevOps MCP extension', () => {
	test('activates and registers its commands', async () => {
		const extension = vscode.extensions.getExtension('local.azure-devops-mcp');
		assert.ok(extension, 'Azure DevOps MCP extension should be available');

		await extension.activate();
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes('azure-devops-mcp.signIn'));
		assert.ok(commands.includes('azure-devops-mcp.openPullRequestFileDiff'));
		assert.ok(commands.includes('azure-devops-mcp.replyToPullRequestComment'));
		assert.ok(commands.includes('azure-devops-mcp.addPullRequestComment'));
		assert.ok(commands.includes('azure-devops-mcp.openLocalPullRequestFile'));
	});

	test('forwards checkout and reviewed-file actions with their full card parameters', async () => {
		let diffArguments: object | undefined;
		let checkoutArguments: CheckoutPullRequestBranchArguments | undefined;
		let reviewArguments: Required<PullRequestReviewStateArguments> | undefined;
		const reviewedPaths = new Set<string>();
		const bridge = new PullRequestCommandBridge(
			async arguments_ => {
				diffArguments = arguments_;
			},
			async () => undefined,
			async arguments_ => {
				checkoutArguments = arguments_;
				return 'feature/example-branch';
			},
			() => [...reviewedPaths],
			async arguments_ => {
				reviewArguments = arguments_;
				if (arguments_.reviewed) {
					reviewedPaths.add(arguments_.path);
				} else {
					reviewedPaths.delete(arguments_.path);
				}
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

			const reviewResponse = await fetch(environment.AZURE_DEVOPS_REVIEW_STATE_URL, {
				method: 'POST',
				headers,
				body: JSON.stringify({
					...identity,
					pullRequestId: 123,
					path: '/src/example.ts',
					reviewed: true,
				}),
			});
			assert.strictEqual(reviewResponse.status, 200);
			assert.deepStrictEqual(reviewArguments, {
				...identity,
				pullRequestId: 123,
				path: '/src/example.ts',
				reviewed: true,
			});
			assert.deepStrictEqual(await reviewResponse.json(), { reviewedPaths: ['/src/example.ts'] });
		} finally {
			bridge.dispose();
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
});
