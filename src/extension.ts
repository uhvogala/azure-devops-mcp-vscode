import * as vscode from 'vscode';
import * as azureDevOps from 'azure-devops-node-api';
import {
	CommentType,
	CommentThreadStatus,
	GitPullRequestCommentThread,
	GitVersionType,
	VersionControlChangeType,
} from 'azure-devops-node-api/interfaces/GitInterfaces';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AzureDevOpsAuthentication } from './authentication';

const providerId = 'azure-devops-mcp.pull-requests';
const pullRequestContentScheme = 'azure-devops-pr';
const openPullRequestFileDiffCommand = 'azure-devops-mcp.openPullRequestFileDiff';
const replyToPullRequestCommentCommand = 'azure-devops-mcp.replyToPullRequestComment';
const addPullRequestCommentCommand = 'azure-devops-mcp.addPullRequestComment';
const openLocalPullRequestFileCommand = 'azure-devops-mcp.openLocalPullRequestFile';
const execFileAsync = promisify(execFile);

interface OpenPullRequestFileDiffArguments {
	organization: string;
	project: string;
	repository: string;
	pullRequestId: number;
	path: string;
	originalPath?: string;
	sourceCommit: string;
	targetCommit: string;
	changeType: number;
}

interface OpenPullRequestFileArguments {
	organization: string;
	project: string;
	repository: string;
	path: string;
}

interface PullRequestCommentThreadReference {
	organization: string;
	project: string;
	repository: string;
	pullRequestId: number;
	threadId: number;
}

interface PullRequestCommentDocumentReference {
	organization: string;
	project: string;
	repository: string;
	pullRequestId: number;
	path: string;
}

export interface CheckoutPullRequestBranchArguments {
	organization: string;
	project: string;
	repository: string;
	branch: string;
}

export interface PullRequestReviewStateArguments {
	organization: string;
	project: string;
	repository: string;
	pullRequestId: number;
	path?: string;
	reviewed?: boolean;
}

interface ReviewStateStorage {
	get<T>(section: string, defaultValue?: T): T;
	update(section: string, value: unknown): Thenable<void>;
}

export class PullRequestReviewStateStore {
	private readonly updates = new Map<string, Promise<void>>();

	public constructor(private readonly storage: ReviewStateStorage) {
	}

	public getReviewedPaths(arguments_: PullRequestReviewStateArguments): readonly string[] {
		return this.storage.get<readonly string[]>(this.key(arguments_), []);
	}

	public async setFileReviewed({ path, reviewed, ...review }: Required<PullRequestReviewStateArguments>): Promise<void> {
		const key = this.key(review);
		const previousUpdate = this.updates.get(key) ?? Promise.resolve();
		const update = previousUpdate.catch(() => undefined).then(async () => {
			const reviewedPaths = new Set(this.getReviewedPaths(review));
			if (reviewed) {
				reviewedPaths.add(path);
			} else {
				reviewedPaths.delete(path);
			}
			await this.storage.update(key, [...reviewedPaths].sort());
		});
		this.updates.set(key, update);
		try {
			await update;
		} finally {
			if (this.updates.get(key) === update) {
				this.updates.delete(key);
			}
		}
	}

	private key({ organization, project, repository, pullRequestId }: PullRequestReviewStateArguments): string {
		return `azure-devops-mcp.reviewed.${organization}.${project}.${repository}.${pullRequestId}`;
	}
}

function isOpenPullRequestFileDiffArguments(value: unknown): value is OpenPullRequestFileDiffArguments {
	if (!value || typeof value !== 'object') {
		return false;
	}

	const arguments_ = value as Record<string, unknown>;
	return [
		'organization',
		'project',
		'repository',
		'path',
		'sourceCommit',
		'targetCommit',
	].every(key => typeof arguments_[key] === 'string' && arguments_[key].length > 0)
		&& typeof arguments_.pullRequestId === 'number'
		&& typeof arguments_.changeType === 'number'
		&& (arguments_.originalPath === undefined || typeof arguments_.originalPath === 'string');
}

function isOpenPullRequestFileArguments(value: unknown): value is OpenPullRequestFileArguments {
	if (!value || typeof value !== 'object') {
		return false;
	}

	const arguments_ = value as Record<string, unknown>;
	return ['organization', 'project', 'repository', 'path']
		.every(key => typeof arguments_[key] === 'string' && arguments_[key].length > 0);
}

function isCheckoutPullRequestBranchArguments(value: unknown): value is CheckoutPullRequestBranchArguments {
	if (!value || typeof value !== 'object') {
		return false;
	}

	const arguments_ = value as Record<string, unknown>;
	return ['organization', 'project', 'repository', 'branch']
		.every(key => typeof arguments_[key] === 'string' && arguments_[key].length > 0);
}

function isPullRequestReviewStateArguments(value: unknown): value is PullRequestReviewStateArguments {
	if (!value || typeof value !== 'object') {
		return false;
	}

	const arguments_ = value as Record<string, unknown>;
	return ['organization', 'project', 'repository'].every(key => typeof arguments_[key] === 'string' && arguments_[key].length > 0)
		&& typeof arguments_.pullRequestId === 'number'
		&& (arguments_.path === undefined || typeof arguments_.path === 'string')
		&& (arguments_.reviewed === undefined || typeof arguments_.reviewed === 'boolean');
}

function contentUri(arguments_: OpenPullRequestFileDiffArguments, path: string, commit: string): vscode.Uri {
	return vscode.Uri.from({
		scheme: pullRequestContentScheme,
		path,
		query: new URLSearchParams({
			organization: arguments_.organization,
			project: arguments_.project,
			repository: arguments_.repository,
			pullRequestId: String(arguments_.pullRequestId),
			commit,
		}).toString(),
	});
}

function commentDocumentReference(uri: vscode.Uri): PullRequestCommentDocumentReference | undefined {
	if (uri.scheme !== pullRequestContentScheme) {
		return undefined;
	}
	const query = new URLSearchParams(uri.query);
	const organization = query.get('organization');
	const project = query.get('project');
	const repository = query.get('repository');
	const pullRequestId = Number(query.get('pullRequestId'));
	if (!organization || !project || !repository || !Number.isInteger(pullRequestId) || pullRequestId <= 0) {
		return undefined;
	}
	return { organization, project, repository, pullRequestId, path: uri.path };
}

function threadRange(thread: GitPullRequestCommentThread): vscode.Range | undefined {
	const context = thread.threadContext;
	const start = context?.rightFileStart?.line;
	const end = context?.rightFileEnd?.line ?? start;
	if (!start || !end) {
		return undefined;
	}
	return new vscode.Range(start - 1, 0, end - 1, Number.MAX_SAFE_INTEGER);
}

function threadComments(thread: GitPullRequestCommentThread): vscode.Comment[] {
	return (thread.comments ?? [])
		.filter(comment => !comment.isDeleted && comment.content)
		.map(comment => ({
			body: new vscode.MarkdownString(comment.content),
			mode: vscode.CommentMode.Preview,
			author: { name: comment.author?.displayName ?? 'Azure DevOps user' },
			timestamp: comment.publishedDate,
		}));
}

async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of stream) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString('utf8');
}

export class PullRequestCommandBridge implements vscode.Disposable {
	private readonly token = randomBytes(32).toString('hex');
	private server: Server | undefined;
	private startPromise: Promise<number> | undefined;

	public constructor(
		private readonly openDiff: (arguments_: OpenPullRequestFileDiffArguments) => Promise<void>,
		private readonly openFile: (arguments_: OpenPullRequestFileArguments) => Promise<void>,
		private readonly checkoutBranch: (arguments_: CheckoutPullRequestBranchArguments) => Promise<string>,
		private readonly getReviewedPaths: (arguments_: PullRequestReviewStateArguments) => readonly string[],
		private readonly setFileReviewed: (arguments_: Required<PullRequestReviewStateArguments>) => Promise<void>,
	) {
	}

	public async getServerEnvironment(): Promise<Record<string, string>> {
		const port = await this.start();
		return {
			AZURE_DEVOPS_DIFF_COMMAND_URL: `http://127.0.0.1:${port}/open-pull-request-file-diff`,
			AZURE_DEVOPS_OPEN_FILE_URL: `http://127.0.0.1:${port}/open-pull-request-file`,
			AZURE_DEVOPS_CHECKOUT_BRANCH_URL: `http://127.0.0.1:${port}/checkout-pull-request-branch`,
			AZURE_DEVOPS_REVIEW_STATE_URL: `http://127.0.0.1:${port}/pull-request-review-state`,
			AZURE_DEVOPS_DIFF_COMMAND_TOKEN: this.token,
		};
	}

	public dispose(): void {
		this.server?.close();
	}

	private start(): Promise<number> {
		this.startPromise ??= new Promise((resolve, reject) => {
			this.server = createServer((request, response) => {
				void this.handleRequest(request, response);
			});
			this.server.once('error', reject);
			this.server.listen(0, '127.0.0.1', () => {
				this.server?.off('error', reject);
				const address = this.server?.address();
				if (!address || typeof address === 'string') {
					reject(new Error('Unable to start the Azure DevOps pull request diff bridge.'));
					return;
				}
				resolve(address.port);
			});
		});
		return this.startPromise;
	}

	private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (request.method !== 'POST' || request.headers.authorization !== `Bearer ${this.token}`) {
			response.writeHead(404).end();
			return;
		}

		try {
			const chunks: Buffer[] = [];
			for await (const chunk of request) {
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			}
			const arguments_: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
			if (request.url === '/open-pull-request-file-diff' && isOpenPullRequestFileDiffArguments(arguments_)) {
				await this.openDiff(arguments_);
				response.writeHead(204).end();
				return;
			}
			if (request.url === '/open-pull-request-file' && isOpenPullRequestFileArguments(arguments_)) {
				await this.openFile(arguments_);
				response.writeHead(204).end();
				return;
			}
			if (request.url === '/checkout-pull-request-branch' && isCheckoutPullRequestBranchArguments(arguments_)) {
				const currentBranch = await this.checkoutBranch(arguments_);
				response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
					.end(JSON.stringify({ currentBranch }));
				return;
			}
			if (request.url === '/pull-request-review-state' && isPullRequestReviewStateArguments(arguments_)) {
				if (arguments_.path !== undefined && arguments_.reviewed !== undefined) {
					await this.setFileReviewed({ ...arguments_, path: arguments_.path, reviewed: arguments_.reviewed });
				}
				response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
					.end(JSON.stringify({ reviewedPaths: this.getReviewedPaths(arguments_) }));
				return;
			}

			{
				response.writeHead(400).end();
				return;
			}
		} catch (error) {
			const detail = error instanceof Error ? error.message : 'Unable to open the native diff view.';
			response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end(detail);
		}
	}
}

export function activate(context: vscode.ExtensionContext): void {
	const authentication = new AzureDevOpsAuthentication();
	let prDocumentContext = false;
	const setPrDocumentContext = async (value: boolean): Promise<void> => {
		prDocumentContext = value;
		await vscode.commands.executeCommand('setContext', 'azureDevOpsMcpPrDocument', value);
	};
	const commentController = vscode.comments.createCommentController('azure-devops-mcp.pull-request-comments', 'Azure DevOps');
	commentController.commentingRangeProvider = {
		provideCommentingRanges: () => [],
	};
	const renderedCommentThreads = new Map<string, vscode.CommentThread[]>();
	const commentThreadReferences = new WeakMap<vscode.CommentThread, PullRequestCommentThreadReference>();
	const azureComment = (content: string, author: string, timestamp?: Date): vscode.Comment => ({
		body: new vscode.MarkdownString(content),
		mode: vscode.CommentMode.Preview,
		author: { name: author },
		timestamp,
	});
	const addAzureDevOpsReply = async (thread: vscode.CommentThread, text: string): Promise<void> => {
		const reference = commentThreadReferences.get(thread);
		if (!reference || !text.trim()) {
			return;
		}
		const environment = await authentication.getServerEnvironment();
		const connection = new azureDevOps.WebApi(
			`https://dev.azure.com/${encodeURIComponent(reference.organization)}`,
			azureDevOps.getBearerHandler(environment.AZURE_DEVOPS_ACCESS_TOKEN),
		);
		const comment = await (await connection.getGitApi()).createComment({
			content: text.trim(),
			commentType: CommentType.Text,
		}, reference.repository, reference.pullRequestId, reference.threadId, reference.project);
		thread.comments = [
			...thread.comments,
			azureComment(comment.content ?? text.trim(), comment.author?.displayName ?? 'Azure DevOps user', comment.publishedDate),
		];
	};
	const renderPullRequestComments = async (arguments_: PullRequestCommentDocumentReference, uri: vscode.Uri): Promise<void> => {
		const key = uri.toString();
		for (const thread of renderedCommentThreads.get(key) ?? []) {
			thread.dispose();
		}
		const environment = await authentication.getServerEnvironment();
		const connection = new azureDevOps.WebApi(
			`https://dev.azure.com/${encodeURIComponent(arguments_.organization)}`,
			azureDevOps.getBearerHandler(environment.AZURE_DEVOPS_ACCESS_TOKEN),
		);
		const gitApi = await connection.getGitApi();
		const threads = await gitApi.getThreads(arguments_.repository, arguments_.pullRequestId, arguments_.project);
		const rendered = threads.flatMap(thread => {
			if (thread.isDeleted || thread.threadContext?.filePath !== arguments_.path) {
				return [];
			}
			const range = threadRange(thread);
			const comments = threadComments(thread);
			if (!range || comments.length === 0) {
				return [];
			}
			const commentThread = commentController.createCommentThread(uri, range, comments);
			commentThread.label = `Azure DevOps thread ${thread.id ?? ''}`.trim();
			commentThread.contextValue = `azure-devops-thread-${thread.id}`;
			commentThread.state = thread.status === CommentThreadStatus.Active
				? vscode.CommentThreadState.Unresolved
				: vscode.CommentThreadState.Resolved;
			commentThread.canReply = false;
			if (thread.id !== undefined) {
				commentThreadReferences.set(commentThread, {
					organization: arguments_.organization,
					project: arguments_.project,
					repository: arguments_.repository,
					pullRequestId: arguments_.pullRequestId,
					threadId: thread.id,
				});
			}
			return [commentThread];
		});
		renderedCommentThreads.set(key, rendered);
	};
	const addAzureDevOpsComment = async (uri: vscode.Uri, line: number): Promise<void> => {
		const reference = commentDocumentReference(uri);
		if (!reference || line <= 0) {
			return;
		}
		const text = await vscode.window.showInputBox({
			prompt: `Add Azure DevOps comment at line ${line}`,
			placeHolder: 'Write a comment',
			ignoreFocusOut: true,
		});
		if (!text?.trim()) {
			return;
		}
		const environment = await authentication.getServerEnvironment();
		const connection = new azureDevOps.WebApi(
			`https://dev.azure.com/${encodeURIComponent(reference.organization)}`,
			azureDevOps.getBearerHandler(environment.AZURE_DEVOPS_ACCESS_TOKEN),
		);
		await (await connection.getGitApi()).createThread({
			comments: [{ content: text.trim(), commentType: CommentType.Text }],
			status: CommentThreadStatus.Active,
			threadContext: {
				filePath: reference.path,
				rightFileStart: { line, offset: 1 },
				rightFileEnd: { line, offset: 1 },
			},
		}, reference.repository, reference.pullRequestId, reference.project);
		await renderPullRequestComments(reference, uri);
	};
	const openPullRequestFileDiff = async (arguments_: OpenPullRequestFileDiffArguments): Promise<void> => {
		const isAdded = (arguments_.changeType & VersionControlChangeType.Add) !== 0;
		const isDeleted = (arguments_.changeType & VersionControlChangeType.Delete) !== 0;
		const originalPath = arguments_.originalPath ?? arguments_.path;
		const left = isAdded
			? vscode.Uri.parse('untitled:Azure DevOps pull request base does not contain this file')
			: contentUri(arguments_, originalPath, arguments_.targetCommit);
		const right = isDeleted
			? vscode.Uri.parse('untitled:Azure DevOps pull request source does not contain this file')
			: contentUri(arguments_, arguments_.path, arguments_.sourceCommit);
		await setPrDocumentContext(true);
		await vscode.commands.executeCommand(
			'vscode.diff',
			left,
			right,
			`PR: ${arguments_.path}`,
		);
		await renderPullRequestComments(arguments_, right);
	};
	const openPullRequestFile = async ({ repository, path }: OpenPullRequestFileArguments): Promise<void> => {
		const pathSegments = path.split('/').filter(Boolean);
		if (!path.startsWith('/') || pathSegments.some(segment => segment === '.' || segment === '..')) {
			throw new Error('Invalid pull request file path.');
		}

		const workspaceFolder = vscode.workspace.workspaceFolders?.find(folder =>
			folder.name === repository || basename(folder.uri.fsPath) === repository,
		);
		if (!workspaceFolder) {
			throw new Error(`Open the ${repository} workspace folder to view this local file.`);
		}

		const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, ...pathSegments);
		try {
			await vscode.workspace.fs.stat(fileUri);
		} catch {
			throw new Error(`${path} is not present in the local ${repository} workspace.`);
		}
		await vscode.window.showTextDocument(fileUri, { preview: true });
	};
	const updatePrDocumentContext = async (editor: vscode.TextEditor | undefined): Promise<void> => {
		const isPrDocument = Boolean(commentDocumentReference(editor?.document.uri ?? vscode.Uri.parse('untitled:')));
		if (isPrDocument !== prDocumentContext) {
			await setPrDocumentContext(isPrDocument);
		}
	};
	const workspaceFolderForRepository = (repository: string): vscode.WorkspaceFolder | undefined =>
		vscode.workspace.workspaceFolders?.find(folder => folder.name === repository || basename(folder.uri.fsPath) === repository);
	const checkoutPullRequestBranch = async ({ repository, branch }: CheckoutPullRequestBranchArguments): Promise<string> => {
		if (!branch.startsWith('refs/heads/')) {
			throw new Error('Only pull request branch refs can be checked out.');
		}
		const branchName = branch.slice('refs/heads/'.length);
		if (!branchName || branchName.includes('..') || branchName.startsWith('/') || branchName.endsWith('/')) {
			throw new Error('Invalid pull request branch name.');
		}
		const workspaceFolder = workspaceFolderForRepository(repository);
		if (!workspaceFolder) {
			throw new Error(`Open the ${repository} workspace folder to check out this branch.`);
		}
		try {
			await execFileAsync('git', ['-C', workspaceFolder.uri.fsPath, 'checkout', branchName]);
		} catch {
			try {
				await execFileAsync('git', [
					'-C',
					workspaceFolder.uri.fsPath,
					'fetch',
					'origin',
					`refs/heads/${branchName}:refs/remotes/origin/${branchName}`,
				]);
				await execFileAsync('git', [
					'-C',
					workspaceFolder.uri.fsPath,
					'checkout',
					'--track',
					`origin/${branchName}`,
				]);
			} catch (error) {
				const detail = error instanceof Error ? error.message : 'Git could not check out the branch.';
				throw new Error(detail);
			}
		}
		const { stdout } = await execFileAsync('git', ['-C', workspaceFolder.uri.fsPath, 'branch', '--show-current']);
		return stdout.trim();
	};
	const reviewStateStore = new PullRequestReviewStateStore(context.workspaceState);
	const commandBridge = new PullRequestCommandBridge(
		openPullRequestFileDiff,
		openPullRequestFile,
		checkoutPullRequestBranch,
		arguments_ => reviewStateStore.getReviewedPaths(arguments_),
		arguments_ => reviewStateStore.setFileReviewed(arguments_),
	);
	const contentProvider: vscode.TextDocumentContentProvider = {
		provideTextDocumentContent: async uri => {
			const query = new URLSearchParams(uri.query);
			const organization = query.get('organization');
			const project = query.get('project');
			const repository = query.get('repository');
			const commit = query.get('commit');
			if (!organization || !project || !repository || !commit) {
				throw new Error('Invalid Azure DevOps pull request file URI.');
			}

			const environment = await authentication.getServerEnvironment();
			const connection = new azureDevOps.WebApi(
				`https://dev.azure.com/${encodeURIComponent(organization)}`,
				azureDevOps.getBearerHandler(environment.AZURE_DEVOPS_ACCESS_TOKEN),
			);
			const gitApi = await connection.getGitApi();
			const content = await gitApi.getItemContent(
				repository,
				uri.path,
				project,
				undefined,
				undefined,
				false,
				false,
				true,
				{ version: commit, versionType: GitVersionType.Commit },
				true,
			);
			return streamToString(content);
		},
	};

	context.subscriptions.push(
		commandBridge,
		commentController,
		vscode.window.onDidChangeActiveTextEditor(editor => { void updatePrDocumentContext(editor); }),
		vscode.commands.registerCommand('azure-devops-mcp.signIn', () => authentication.signIn()),
		vscode.commands.registerCommand(addPullRequestCommentCommand, async (uri?: vscode.Uri, line?: number) => {
			const editor = vscode.window.activeTextEditor;
			const targetUri = uri?.scheme === pullRequestContentScheme ? uri : editor?.document.uri;
			const targetLine = typeof line === 'number' ? line : (editor?.selection.active.line ?? -1) + 1;
			if (targetUri) {
				await addAzureDevOpsComment(targetUri, targetLine);
			}
		}),
		vscode.commands.registerCommand(openLocalPullRequestFileCommand, async (uri?: vscode.Uri) => {
			const editor = vscode.window.activeTextEditor;
			const targetUri = uri?.scheme === pullRequestContentScheme ? uri : editor?.document.uri;
			const reference = targetUri ? commentDocumentReference(targetUri) : undefined;
			if (reference) {
				await openPullRequestFile(reference);
			}
		}),
		vscode.commands.registerCommand(replyToPullRequestCommentCommand, async (thread: vscode.CommentThread) => {
			if (!commentThreadReferences.has(thread)) {
				return;
			}
			const text = await vscode.window.showInputBox({
				prompt: 'Reply to Azure DevOps thread',
				placeHolder: 'Write a reply',
				ignoreFocusOut: true,
			});
			if (text) {
				await addAzureDevOpsReply(thread, text);
			}
		}),
		vscode.workspace.registerTextDocumentContentProvider(pullRequestContentScheme, contentProvider),
		vscode.commands.registerCommand('azure-devops-mcp.openPullRequestFileDiff', async (arguments_: unknown) => {
			if (!isOpenPullRequestFileDiffArguments(arguments_)) {
				throw new Error('Invalid Azure DevOps pull request diff request.');
			}
			await openPullRequestFileDiff(arguments_);
		}),
		vscode.lm.registerMcpServerDefinitionProvider(providerId, {
			provideMcpServerDefinitions: () => [
				new vscode.McpStdioServerDefinition(
					'Azure DevOps pull requests',
					process.execPath,
					[context.asAbsolutePath('dist/mcp-server.js')],
					{},
					context.extension.packageJSON.version,
				),
			],
			resolveMcpServerDefinition: async server => {
				if (!(server instanceof vscode.McpStdioServerDefinition)) {
					return undefined;
				}

				server.env = {
					...await authentication.getServerEnvironment(),
					...await commandBridge.getServerEnvironment(),
				};
				return server;
			},
		}),
	);
	void updatePrDocumentContext(vscode.window.activeTextEditor);
}

export function deactivate(): void {
}
