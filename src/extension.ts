import * as vscode from 'vscode';
import * as azureDevOps from 'azure-devops-node-api';
import {
	CommentType,
	CommentThreadStatus,
	GitPullRequestCommentThread,
	GitVersionType,
	PullRequestStatus,
	VersionControlChangeType,
} from 'azure-devops-node-api/interfaces/GitInterfaces';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AzureDevOpsAuthentication } from './authentication';
import { loadPullRequestReview } from './pull-request-review';

const providerId = 'azure-devops-mcp.pull-requests';
const pullRequestContentScheme = 'azure-devops-pr';
const openPullRequestFileDiffCommand = 'azure-devops-mcp.openPullRequestFileDiff';
const replyToPullRequestCommentCommand = 'azure-devops-mcp.replyToPullRequestComment';
const addPullRequestCommentCommand = 'azure-devops-mcp.addPullRequestComment';
const openLocalPullRequestFileCommand = 'azure-devops-mcp.openLocalPullRequestFile';
const pullRequestsViewId = 'azure-devops-mcp.pullRequests';
const reviewViewId = 'azure-devops-mcp.review';
const refreshOverviewCommand = 'azure-devops-mcp.refreshOverview';
const selectOverviewRepositoryCommand = 'azure-devops-mcp.selectOverviewRepository';
const pullRequestDraftIndexKey = 'azure-devops-mcp.drafts';
const execFileAsync = promisify(execFile);

interface WorkspaceRepository {
	organization: string;
	project: string;
	repository: string;
}

interface OverviewPullRequest {
	id: number;
	title: string;
	sourceRef: string;
	targetRef: string;
}

interface OverviewPullRequestDraft {
	key: string;
	organization: string;
	project: string;
	repository: string;
	sourceRefName: string;
	targetRefName: string;
	title: string;
	description: string;
	reviewerIds: string[];
	changes: unknown[];
	changesTruncated?: boolean;
	changesError?: string;
}

function repositoryFromRemote(remote: string): WorkspaceRepository | undefined {
	const match = remote.match(/^https:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+?)(?:\.git)?$/)
		?? remote.match(/^https:\/\/([^/.]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/]+?)(?:\.git)?$/)
		?? remote.match(/^git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/)
		?? remote.match(/^ssh:\/\/git@ssh\.dev\.azure\.com\/v3\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/);
	if (!match) {
		return undefined;
	}
	return { organization: match[1], project: match[2], repository: match[3] };
}

function repositoryKey(repository: WorkspaceRepository): string {
	return `${repository.organization}/${repository.project}/${repository.repository}`;
}

function reviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'pr-overview.js'));
	const nonce = randomBytes(16).toString('hex');
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
:root { color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
html, body, main { height: 100%; } body { margin: 0; overflow: hidden; } .review-host, .review-host *, .review-host *::before, .review-host *::after { box-sizing: border-box; }
.review-host { width: 100%; height: 100%; overflow: auto; padding: 12px; } .review-host.is-loading { opacity: .65; pointer-events: none; }
.header { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: start; } h1, h2 { margin: 0; } h1 { font-size: 15px; line-height: 1.35; } h2 { font-size: 12px; } .number, .files-header span, .file-details span, .approvals-count, .reviewer-vote { color: var(--vscode-descriptionForeground); font-size: 11px; }
.status { padding: 3px 6px; background: var(--vscode-testing-iconPassed); color: var(--vscode-editor-background); font-size: 10px; font-weight: 700; text-transform: uppercase; }
.branches { display: grid; gap: 6px; width: 100%; margin-top: 12px; padding: 6px 8px; border-left: 3px solid var(--vscode-focusBorder); background: var(--vscode-editorWidget-background); overflow-wrap: anywhere; } .branch-actions { display: flex; flex-wrap: wrap; gap: 6px; } .branch-error, .approval-error, .action-error { color: var(--vscode-errorForeground); font-size: 11px; overflow-wrap: anywhere; } .branch-error:empty { display: none; } .checkout-branch { padding: 4px 8px; min-height: 24px; font-size: 11px; }
.approvals, .summary, .files { width: 100%; margin-top: 16px; } .approvals-header, .reviewer, .files-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; } .approval-list { display: grid; gap: 4px; margin-top: 8px; } .reviewer { padding: 6px 8px; border-left: 3px solid var(--vscode-panel-border); background: var(--vscode-editorWidget-background); font-size: 12px; } .reviewer-name { min-width: 0; overflow-wrap: anywhere; } .approval-actions { display: flex; margin-top: 12px; } .draft-status { background: var(--vscode-charts-blue); } .draft-description, .draft-files { margin-top: 16px; } .draft-description-header, .draft-details { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 7px; } .preview-control { display: inline-flex; align-items: center; gap: 5px; color: var(--vscode-descriptionForeground); font-size: 11px; cursor: pointer; } .description-input { width: 100%; min-height: 130px; resize: vertical; padding: 8px; border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); font: inherit; } .description-preview { min-height: 130px; padding: 8px; border: 1px solid var(--vscode-panel-border); background: var(--vscode-editorWidget-background); } .draft-files { border: 1px solid var(--vscode-panel-border); } .draft-file, .draft-file-empty { display: flex; justify-content: space-between; gap: 8px; padding: 7px 8px; border-top: 1px solid var(--vscode-panel-border); } .draft-file span, .draft-file-empty { color: var(--vscode-descriptionForeground); font-size: 11px; } .draft-file-empty { display: block; } .draft-details { justify-content: flex-start; margin-top: 10px; flex-wrap: wrap; } .draft-details > span:first-child { color: var(--vscode-descriptionForeground); font-size: 11px; }
.section-title { margin-bottom: 7px; color: var(--vscode-descriptionForeground); font-size: 11px; text-transform: uppercase; } .markdown { line-height: 1.45; } .markdown p { margin: 0 0 8px; } .markdown code, code { font-family: var(--vscode-editor-font-family); }
.files { border: 1px solid var(--vscode-panel-border); overflow: hidden; } .files-header { padding: 8px; background: var(--vscode-editorWidget-background); } .file { display: grid; grid-template-columns: 72px minmax(0, 1fr) auto; align-items: center; gap: 8px; width: 100%; margin: 0; padding: 8px; border: 0; border-top: 1px solid var(--vscode-panel-border); } .file-details { min-width: 0; display: grid; align-content: center; gap: 3px; } .file code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .file-actions { display: flex; align-items: center; gap: 6px; } .review-control { display: inline-flex; align-items: center; gap: 4px; color: var(--vscode-descriptionForeground); font-size: 11px; }
button { min-height: 28px; border: 1px solid var(--vscode-button-border, transparent); border-radius: var(--vscode-button-border-radius, 4px); padding: 5px 8px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); font: inherit; font-size: 12px; font-weight: 600; white-space: nowrap; cursor: pointer; } button:hover { background: var(--vscode-button-hoverBackground); } button:disabled { opacity: .7; cursor: progress; } .checkout-branch, .open-file { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); } .comment-count { min-height: auto; justify-self: start; padding: 0; border: 0; border-radius: 0; background: transparent; color: var(--vscode-textLink-foreground); font-size: 11px; text-decoration: underline; }
@media (max-width: 540px) { .file { grid-template-columns: 72px minmax(0, 1fr); } .file-actions { grid-column: 2; flex-wrap: wrap; } }
</style></head><body><script nonce="${nonce}" src="${scriptUri}"></script></body></html>`;
}

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

interface SubmitPullRequestArguments {
	organization: string;
	project: string;
	repository: string;
	sourceRef: string;
	targetRef: string;
	title: string;
	description: string;
	reviewerIds: string[];
	confirm: true;
}

interface SharedStateRequest {
	key: string;
	afterVersion?: number;
	expectedVersion?: number;
	wait?: boolean;
	defaultValue?: unknown;
	value?: unknown;
	set?: boolean;
}

interface ReviewStateStorage {
	get<T>(section: string, defaultValue?: T): T;
	update(section: string, value: unknown): Thenable<void>;
}

export interface SharedStateSnapshot<T> {
	value: T;
	version: number;
}

export interface SharedStateChange extends SharedStateSnapshot<unknown> {
	key: string;
}

export interface SharedStateWriteResult<T> {
	applied: boolean;
	snapshot: SharedStateSnapshot<T>;
}

export class SharedWorkspaceStateStore implements vscode.Disposable {
	private readonly updates = new Map<string, Promise<void>>();
	private readonly changed = new vscode.EventEmitter<SharedStateChange>();

	public readonly onDidChange = this.changed.event;

	public constructor(private readonly storage: ReviewStateStorage) {
	}

	public get<T>(key: string, defaultValue: T): SharedStateSnapshot<T> {
		return {
			value: this.storage.get<T>(key, defaultValue),
			version: this.storage.get<number>(this.versionKey(key), 0),
		};
	}

	public async set<T>(key: string, value: T): Promise<SharedStateSnapshot<T>> {
		return this.update(key, value, () => value);
	}

	public async update<T>(key: string, defaultValue: T, transform: (currentValue: T) => T): Promise<SharedStateSnapshot<T>> {
		const previousUpdate = this.updates.get(key) ?? Promise.resolve();
		let snapshot: SharedStateSnapshot<T> | undefined;
		const update = previousUpdate.catch(() => undefined).then(async () => {
			const current = this.get(key, defaultValue);
			const value = transform(current.value);
			const version = current.version + 1;
			await this.storage.update(key, value);
			await this.storage.update(this.versionKey(key), version);
			snapshot = { value, version };
			this.changed.fire({ key, ...snapshot });
		});
		this.updates.set(key, update);
		try {
			await update;
			return snapshot!;
		} finally {
			if (this.updates.get(key) === update) {
				this.updates.delete(key);
			}
		}
	}

	public async compareAndSet<T>(key: string, defaultValue: T, expectedVersion: number, value: T): Promise<SharedStateWriteResult<T>> {
		const previousUpdate = this.updates.get(key) ?? Promise.resolve();
		let result: SharedStateWriteResult<T> | undefined;
		const update = previousUpdate.catch(() => undefined).then(async () => {
			const current = this.get(key, defaultValue);
			if (current.version !== expectedVersion) {
				result = { applied: false, snapshot: current };
				return;
			}
			const snapshot = { value, version: current.version + 1 };
			await this.storage.update(key, value);
			await this.storage.update(this.versionKey(key), snapshot.version);
			this.changed.fire({ key, ...snapshot });
			result = { applied: true, snapshot };
		});
		this.updates.set(key, update);
		try {
			await update;
			return result!;
		} finally {
			if (this.updates.get(key) === update) {
				this.updates.delete(key);
			}
		}
	}

	public async waitForChange<T>(key: string, afterVersion: number, defaultValue: T, timeoutMs = 25_000): Promise<SharedStateSnapshot<T>> {
		const current = this.get(key, defaultValue);
		if (current.version > afterVersion) {
			return current;
		}
		return new Promise(resolve => {
			const listener = this.onDidChange(change => {
				if (change.key !== key || change.version <= afterVersion) {
					return;
				}
				clearTimeout(timeout);
				listener.dispose();
				resolve({ value: change.value as T, version: change.version });
			});
			const timeout = setTimeout(() => {
				listener.dispose();
				resolve(this.get(key, defaultValue));
			}, timeoutMs);
		});
	}

	public dispose(): void {
		this.changed.dispose();
	}

	private versionKey(key: string): string {
		return `${key}.version`;
	}
}

export class PullRequestReviewStateStore {
	private readonly state: SharedWorkspaceStateStore;

	public constructor(storage: ReviewStateStorage | SharedWorkspaceStateStore) {
		this.state = storage instanceof SharedWorkspaceStateStore ? storage : new SharedWorkspaceStateStore(storage);
	}

	public getReviewedPaths(arguments_: PullRequestReviewStateArguments): readonly string[] {
		return this.getState(arguments_).value;
	}

	public getState(arguments_: PullRequestReviewStateArguments): SharedStateSnapshot<readonly string[]> {
		return this.state.get(this.key(arguments_), []);
	}

	public async setFileReviewed({ path, reviewed, ...review }: Required<PullRequestReviewStateArguments>): Promise<void> {
		await this.state.update(this.key(review), [] as string[], currentPaths => {
			const reviewedPaths = new Set(currentPaths);
			if (reviewed) {
				reviewedPaths.add(path);
			} else {
				reviewedPaths.delete(path);
			}
			return [...reviewedPaths].sort();
		});
	}

	public key({ organization, project, repository, pullRequestId }: PullRequestReviewStateArguments): string {
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

function isSharedStateRequest(value: unknown): value is SharedStateRequest {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const request = value as Record<string, unknown>;
	return typeof request.key === 'string'
		&& request.key.length > 0
		&& (request.afterVersion === undefined || (typeof request.afterVersion === 'number' && Number.isInteger(request.afterVersion) && request.afterVersion >= 0))
		&& (request.expectedVersion === undefined || (typeof request.expectedVersion === 'number' && Number.isInteger(request.expectedVersion) && request.expectedVersion >= 0))
		&& (request.wait === undefined || typeof request.wait === 'boolean')
		&& (request.set === undefined || typeof request.set === 'boolean');
}

function isSubmitPullRequestArguments(value: unknown): value is SubmitPullRequestArguments {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const arguments_ = value as Record<string, unknown>;
	return ['organization', 'project', 'repository', 'sourceRef', 'targetRef', 'title', 'description'].every(key => typeof arguments_[key] === 'string' && arguments_[key].length > 0)
		&& Array.isArray(arguments_.reviewerIds) && arguments_.reviewerIds.every(id => typeof id === 'string')
		&& arguments_.confirm === true;
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
		private readonly sharedState: SharedWorkspaceStateStore,
	) {
	}

	public async getServerEnvironment(): Promise<Record<string, string>> {
		const port = await this.start();
		return {
			AZURE_DEVOPS_DIFF_COMMAND_URL: `http://127.0.0.1:${port}/open-pull-request-file-diff`,
			AZURE_DEVOPS_OPEN_FILE_URL: `http://127.0.0.1:${port}/open-pull-request-file`,
			AZURE_DEVOPS_CHECKOUT_BRANCH_URL: `http://127.0.0.1:${port}/checkout-pull-request-branch`,
			AZURE_DEVOPS_SHARED_STATE_URL: `http://127.0.0.1:${port}/shared-state`,
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
			if (request.url === '/shared-state' && isSharedStateRequest(arguments_)) {
				const defaultValue = arguments_.defaultValue ?? null;
				const snapshot = arguments_.set
					? arguments_.expectedVersion === undefined
						? { applied: true, snapshot: await this.sharedState.set(arguments_.key, arguments_.value ?? null) }
						: await this.sharedState.compareAndSet(arguments_.key, defaultValue, arguments_.expectedVersion, arguments_.value ?? null)
					: arguments_.wait
					? await this.sharedState.waitForChange(arguments_.key, arguments_.afterVersion ?? 0, defaultValue)
					: this.sharedState.get(arguments_.key, defaultValue);
				response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
					.end(JSON.stringify('snapshot' in snapshot ? { ...snapshot.snapshot, applied: snapshot.applied } : snapshot));
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
	const getGitApi = async (organization: string) => {
		const environment = await authentication.getServerEnvironment();
		const connection = new azureDevOps.WebApi(
			`https://dev.azure.com/${encodeURIComponent(organization)}`,
			azureDevOps.getBearerHandler(environment.AZURE_DEVOPS_ACCESS_TOKEN),
		);
		return connection.getGitApi();
	};
	const getAuthenticatedUserId = async (organization: string): Promise<string> => {
		const environment = await authentication.getServerEnvironment();
		const connection = new azureDevOps.WebApi(
			`https://dev.azure.com/${encodeURIComponent(organization)}`,
			azureDevOps.getBearerHandler(environment.AZURE_DEVOPS_ACCESS_TOKEN),
		);
		const userId = (await connection.connect()).authenticatedUser?.id;
		if (!userId) {
			throw new Error('Azure DevOps did not return the signed-in user identity.');
		}
		return userId;
	};
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
		const comment = await (await getGitApi(reference.organization)).createComment({
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
		const gitApi = await getGitApi(arguments_.organization);
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
		await (await getGitApi(reference.organization)).createThread({
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
	const workspaceFolderForRepository = (repository: string): vscode.WorkspaceFolder | undefined =>
		vscode.workspace.workspaceFolders?.find(folder => folder.name === repository || basename(folder.uri.fsPath) === repository);
	const openPullRequestFile = async ({ repository, path }: OpenPullRequestFileArguments): Promise<void> => {
		const pathSegments = path.split('/').filter(Boolean);
		if (!path.startsWith('/') || pathSegments.some(segment => segment === '.' || segment === '..')) {
			throw new Error('Invalid pull request file path.');
		}

		const workspaceFolder = workspaceFolderForRepository(repository);
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
	const sharedState = new SharedWorkspaceStateStore(context.workspaceState);
	context.subscriptions.push(sharedState);
	const reviewStateStore = new PullRequestReviewStateStore(sharedState);
	let reviewWebview: vscode.WebviewView | undefined;
	let selectedOverviewRepositoryKey = context.workspaceState.get<string>('azure-devops-mcp.overview.repository');
	let selectedOverviewPullRequestId: number | undefined;
	let treeRepository: WorkspaceRepository | undefined;
	let treePullRequests: readonly OverviewPullRequest[] = [];
	let treeError: string | undefined;
	const treeChanged = new vscode.EventEmitter<void>();
	let selectedDraftKey = context.workspaceState.get<string>('azure-devops-mcp.draft.selected');
	let treeDrafts: readonly OverviewPullRequestDraft[] = [];
	const materializeDraft = (draft: OverviewPullRequestDraft) => {
		const state = sharedState.get(draft.key, { description: draft.description });
		const description = state.value && typeof state.value === 'object' && typeof (state.value as { description?: unknown }).description === 'string'
			? (state.value as { description: string }).description
			: draft.description;
		return { ...draft, mode: 'create', description, sharedState: { key: draft.key, version: state.version } };
	};
	const refreshDrafts = async (openSelected = false): Promise<void> => {
		treeDrafts = sharedState.get<readonly OverviewPullRequestDraft[]>(pullRequestDraftIndexKey, [] as OverviewPullRequestDraft[]).value;
		if (!treeDrafts.some(draft => draft.key === selectedDraftKey)) {
			selectedDraftKey = treeDrafts[0]?.key;
		}
		await context.workspaceState.update('azure-devops-mcp.draft.selected', selectedDraftKey);
		treeChanged.fire();
		if (openSelected) {
			const draft = treeDrafts.find(candidate => candidate.key === selectedDraftKey);
			if (draft) {
				await reviewWebview?.webview.postMessage({ draft: materializeDraft(draft) });
			}
		}
	};
	const deleteDraft = async (draftKey: string): Promise<void> => {
		await sharedState.set(draftKey, { deleted: true });
		await sharedState.update<OverviewPullRequestDraft[]>(pullRequestDraftIndexKey, [], drafts => drafts.filter(draft => draft.key !== draftKey));
		if (selectedDraftKey === draftKey) {
			selectedDraftKey = undefined;
			await context.workspaceState.update('azure-devops-mcp.draft.selected', undefined);
			await reviewWebview?.webview.postMessage({ error: 'Draft deleted.' });
		}
	};
	const workspaceRepositories = async (): Promise<WorkspaceRepository[]> => {
		const folders = vscode.workspace.workspaceFolders ?? [];
		const repositories = await Promise.all(folders.map(async folder => {
			try {
				const { stdout } = await execFileAsync('git', ['-C', folder.uri.fsPath, 'remote', 'get-url', 'origin']);
				return repositoryFromRemote(stdout.trim());
			} catch {
				return undefined;
			}
		}));
		return repositories.filter((repository): repository is WorkspaceRepository => repository !== undefined)
			.filter((repository, index, values) => values.findIndex(value => repositoryKey(value) === repositoryKey(repository)) === index);
	};
	const refreshOverview = async (): Promise<void> => {
		const repositories = await workspaceRepositories();
		const selectedRepository = repositories.find(repository => repositoryKey(repository) === selectedOverviewRepositoryKey) ?? repositories[0];
		if (!selectedRepository) {
			treeRepository = undefined;
			treePullRequests = [];
			treeError = 'No Azure DevOps Git remotes were found in the workspace.';
			treeChanged.fire();
			await reviewWebview?.webview.postMessage({ error: treeError });
			return;
		}
		selectedOverviewRepositoryKey = repositoryKey(selectedRepository);
		await context.workspaceState.update('azure-devops-mcp.overview.repository', selectedOverviewRepositoryKey);
		const selectedPullRequestKey = `azure-devops-mcp.overview.pullRequest.${selectedOverviewRepositoryKey}`;
		if (selectedOverviewPullRequestId === undefined) {
			selectedOverviewPullRequestId = context.workspaceState.get<number>(selectedPullRequestKey);
		}
		try {
			const gitApi = await getGitApi(selectedRepository.organization);
			const pullRequests = await gitApi.getPullRequests(
				selectedRepository.repository,
				{ status: PullRequestStatus.Active },
				selectedRepository.project,
				undefined,
				undefined,
				50,
			);
			const summaries: OverviewPullRequest[] = pullRequests.flatMap(pullRequest => {
				if (!pullRequest.pullRequestId || !pullRequest.sourceRefName || !pullRequest.targetRefName) {
					return [];
				}
				return [{
					id: pullRequest.pullRequestId,
					title: pullRequest.title ?? 'Untitled pull request',
					description: pullRequest.description,
					sourceRef: pullRequest.sourceRefName,
					targetRef: pullRequest.targetRefName,
					changes: [],
				}];
			});
			const selectedPullRequest = summaries.find(pullRequest => pullRequest.id === selectedOverviewPullRequestId) ?? summaries[0];
			let review: (Awaited<ReturnType<typeof loadPullRequestReview>> & {
				sharedState: { key: string; version: number };
			}) | undefined;
			if (selectedPullRequest) {
				selectedOverviewPullRequestId = selectedPullRequest.id;
				await context.workspaceState.update(selectedPullRequestKey, selectedPullRequest.id);
				const pullRequest = await gitApi.getPullRequest(selectedRepository.repository, selectedPullRequest.id, selectedRepository.project);
				const loadedReview = await loadPullRequestReview(pullRequest, selectedRepository, {
					getGitApi,
					getCurrentUserId: getAuthenticatedUserId,
					getReviewedPaths: reviewState => Promise.resolve(reviewStateStore.getReviewedPaths(reviewState)),
				});
				const reviewState = reviewStateStore.getState({ ...selectedRepository, pullRequestId: selectedPullRequest.id });
				review = {
					...loadedReview,
					sharedState: { key: reviewStateStore.key({ ...selectedRepository, pullRequestId: selectedPullRequest.id }), version: reviewState.version },
				};
			}
			treeRepository = selectedRepository;
			treePullRequests = summaries;
			treeError = undefined;
			treeChanged.fire();
			await reviewWebview?.webview.postMessage({ review });
		} catch (overviewError) {
			treeRepository = selectedRepository;
			treePullRequests = [];
			treeError = overviewError instanceof Error ? overviewError.message : 'Unable to load pull requests.';
			treeChanged.fire();
			await reviewWebview?.webview.postMessage({ error: treeError });
		}
	};
	const pullRequestsProvider: vscode.TreeDataProvider<vscode.TreeItem> = {
		onDidChangeTreeData: treeChanged.event,
		getTreeItem: item => item,
		getChildren: element => {
			if (!element) {
				const items: vscode.TreeItem[] = [];
				if (treeRepository) {
					const repositoryItem = new vscode.TreeItem(treeRepository.repository, vscode.TreeItemCollapsibleState.Expanded);
					repositoryItem.description = `${treeRepository.organization}/${treeRepository.project}`;
					repositoryItem.iconPath = new vscode.ThemeIcon('repo');
					repositoryItem.command = { command: selectOverviewRepositoryCommand, title: 'Select Pull Request Repository' };
					repositoryItem.contextValue = 'azure-devops-mcp.repository';
					items.push(repositoryItem);
				} else if (treeError) {
					items.push(new vscode.TreeItem(treeError, vscode.TreeItemCollapsibleState.None));
				}
				if (treeDrafts.length > 0) {
					const draftsItem = new vscode.TreeItem('Pull Request Drafts', vscode.TreeItemCollapsibleState.Expanded);
					draftsItem.iconPath = new vscode.ThemeIcon('git-pull-request');
					draftsItem.contextValue = 'azure-devops-mcp.drafts';
					items.push(draftsItem);
				}
				return items;
			}
			if (element.contextValue === 'azure-devops-mcp.drafts') {
				return treeDrafts.map(draft => {
					const item = new vscode.TreeItem(draft.title || 'Untitled draft', vscode.TreeItemCollapsibleState.None);
					(item as vscode.TreeItem & { draftKey: string }).draftKey = draft.key;
					item.description = `${draft.repository}: ${draft.sourceRefName.replace('refs/heads/', '')} -> ${draft.targetRefName.replace('refs/heads/', '')}`;
					item.iconPath = new vscode.ThemeIcon(draft.key === selectedDraftKey ? 'eye' : 'git-pull-request');
					item.contextValue = 'azure-devops-mcp.draft';
					item.command = { command: 'azure-devops-mcp.selectOverviewDraft', title: 'Select Pull Request Draft', arguments: [draft.key] };
					return item;
				});
			}
			return treePullRequests.map(pullRequest => {
				const item = new vscode.TreeItem(`#${pullRequest.id} ${pullRequest.title}`, vscode.TreeItemCollapsibleState.None);
				item.description = `${pullRequest.sourceRef.replace('refs/heads/', '')} -> ${pullRequest.targetRef.replace('refs/heads/', '')}`;
				item.iconPath = new vscode.ThemeIcon(pullRequest.id === selectedOverviewPullRequestId ? 'eye' : 'git-pull-request');
				item.command = { command: 'azure-devops-mcp.selectOverviewPullRequest', title: 'Select Pull Request', arguments: [pullRequest.id] };
				return item;
			});
		},
	};
	const reviewProvider: vscode.WebviewViewProvider = {
		resolveWebviewView: view => {
			reviewWebview = view;
			view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')] };
			view.webview.html = reviewHtml(view.webview, context.extensionUri);
			view.webview.onDidReceiveMessage(async (message: unknown) => {
				if (!message || typeof message !== 'object') {
					return;
				}
				const request = message as { type?: string; id?: string; request?: { name?: string; arguments?: unknown } };
				if (request.type === 'action' && request.id && request.request?.name && request.request.arguments) {
					let result: { isError?: boolean; content?: Array<{ type: string; text: string }>; structuredContent?: object } = {};
					try {
						const arguments_ = request.request.arguments;
						switch (request.request.name) {
							case 'open_pull_request_file_diff':
								if (!isOpenPullRequestFileDiffArguments(arguments_)) {throw new Error('Invalid pull request diff request.');}
								await openPullRequestFileDiff(arguments_);
								break;
							case 'open_pull_request_file':
								if (!isOpenPullRequestFileArguments(arguments_)) {throw new Error('Invalid pull request file request.');}
								await openPullRequestFile(arguments_);
								break;
							case 'checkout_pull_request_branch':
								if (!isCheckoutPullRequestBranchArguments(arguments_)) {throw new Error('Invalid pull request branch request.');}
								result.structuredContent = { currentBranch: await checkoutPullRequestBranch(arguments_) };
								break;
							case 'set_pull_request_file_reviewed':
								if (!isPullRequestReviewStateArguments(arguments_) || arguments_.path === undefined || arguments_.reviewed === undefined) {throw new Error('Invalid review state request.');}
								await reviewStateStore.setFileReviewed({ ...arguments_, path: arguments_.path, reviewed: arguments_.reviewed });
								break;
							case 'set_shared_state': {
								if (!isSharedStateRequest(arguments_)) {throw new Error('Invalid shared state request.');}
								const defaultValue = arguments_.defaultValue ?? null;
								const write = arguments_.expectedVersion === undefined
									? { applied: true, snapshot: await sharedState.set(arguments_.key, arguments_.value ?? null) }
									: await sharedState.compareAndSet(arguments_.key, defaultValue, arguments_.expectedVersion, arguments_.value ?? null);
								result.structuredContent = { ...write.snapshot, applied: write.applied };
								break;
							}
							case 'delete_pull_request_draft': {
								if (!arguments_ || typeof arguments_ !== 'object' || typeof (arguments_ as { key?: unknown }).key !== 'string') {throw new Error('Invalid draft deletion request.');}
								await deleteDraft((arguments_ as { key: string }).key);
								result.structuredContent = { deleted: true };
								break;
							}
							case 'submit_pull_request': {
								if (!isSubmitPullRequestArguments(arguments_)) {throw new Error('Invalid pull request submission request.');}
								const gitApi = await getGitApi(arguments_.organization);
								const pullRequest = await gitApi.createPullRequest({
									sourceRefName: arguments_.sourceRef,
									targetRefName: arguments_.targetRef,
									title: arguments_.title,
									description: arguments_.description,
									reviewers: arguments_.reviewerIds.map(id => ({ id })),
								}, arguments_.repository, arguments_.project);
								const loadedReview = await loadPullRequestReview(pullRequest, arguments_, {
									getGitApi,
									getCurrentUserId: getAuthenticatedUserId,
									getReviewedPaths: reviewState => Promise.resolve(reviewStateStore.getReviewedPaths(reviewState)),
								});
								await sharedState.update<OverviewPullRequestDraft[]>(pullRequestDraftIndexKey, [], drafts =>
									drafts.filter(draft => !(draft.organization === arguments_.organization
										&& draft.project === arguments_.project
										&& draft.repository === arguments_.repository
										&& draft.sourceRefName === arguments_.sourceRef
										&& draft.targetRefName === arguments_.targetRef
										&& draft.title === arguments_.title)),
								);
								result.structuredContent = {
									...loadedReview,
									sharedState: { key: reviewStateStore.key({ ...arguments_, pullRequestId: pullRequest.pullRequestId! }), version: reviewStateStore.getState({ ...arguments_, pullRequestId: pullRequest.pullRequestId! }).version },
								};
								break;
							}
							case 'approve_pull_request': {
								if (!isPullRequestReviewStateArguments(arguments_)) {throw new Error('Invalid approval request.');}
								const userId = await getAuthenticatedUserId(arguments_.organization);
								const gitApi = await getGitApi(arguments_.organization);
								const reviewer = await gitApi.createPullRequestReviewer({ id: userId, vote: 10 }, arguments_.repository, arguments_.pullRequestId, userId, arguments_.project);
								result.structuredContent = { reviewer, reviewers: await gitApi.getPullRequestReviewers(arguments_.repository, arguments_.pullRequestId, arguments_.project) };
								break;
							}
							default:
								throw new Error('Unsupported pull request action.');
						}
					} catch (actionError) {
						result = { isError: true, content: [{ type: 'text', text: actionError instanceof Error ? actionError.message : 'Pull request action failed.' }] };
					}
					await view.webview.postMessage({ type: 'actionResult', id: request.id, result });
					return;
				}
				if (request.type === 'ready') {
					await refreshOverview();
				}
			});
		},
	};
	const pullRequestsTree = vscode.window.createTreeView(pullRequestsViewId, { treeDataProvider: pullRequestsProvider });
	void refreshDrafts();
	pullRequestsTree.onDidChangeVisibility(() => {
		if (pullRequestsTree.visible) {
			void refreshOverview();
		}
	});
	const commandBridge = new PullRequestCommandBridge(
		openPullRequestFileDiff,
		openPullRequestFile,
		checkoutPullRequestBranch,
		sharedState,
	);
	context.subscriptions.push(sharedState.onDidChange(change => {
		void reviewWebview?.webview.postMessage({ type: 'sharedStateChanged', change });
		if (change.key === pullRequestDraftIndexKey) {
			void refreshDrafts();
		}
	}));
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
		pullRequestsTree,
		vscode.window.registerWebviewViewProvider(reviewViewId, reviewProvider),
		vscode.commands.registerCommand(refreshOverviewCommand, () => refreshOverview()),
		vscode.commands.registerCommand(selectOverviewRepositoryCommand, async () => {
			const repositories = await workspaceRepositories();
			const selected = await vscode.window.showQuickPick(repositories.map(repository => ({
				label: repository.repository,
				description: `${repository.organization}/${repository.project}`,
				repository,
			})), { placeHolder: 'Select an Azure DevOps workspace repository' });
			if (selected) {
				selectedOverviewRepositoryKey = repositoryKey(selected.repository);
				selectedOverviewPullRequestId = context.workspaceState.get<number>(`azure-devops-mcp.overview.pullRequest.${selectedOverviewRepositoryKey}`);
				await refreshOverview();
			}
		}),
		vscode.commands.registerCommand('azure-devops-mcp.selectOverviewPullRequest', async (pullRequestId: unknown) => {
			if (typeof pullRequestId !== 'number') {
				return;
			}
			selectedOverviewPullRequestId = pullRequestId;
			await context.workspaceState.update(`azure-devops-mcp.overview.pullRequest.${selectedOverviewRepositoryKey}`, pullRequestId);
			await refreshOverview();
		}),
		vscode.commands.registerCommand('azure-devops-mcp.selectOverviewDraft', async (draftKey: unknown) => {
			if (typeof draftKey !== 'string') {
				return;
			}
			selectedDraftKey = draftKey;
			await refreshDrafts(true);
		}),
		vscode.commands.registerCommand('azure-devops-mcp.deletePullRequestDraft', async (item: unknown) => {
			const draftKey = typeof item === 'string'
				? item
				: item && typeof item === 'object' && typeof (item as { draftKey?: unknown }).draftKey === 'string'
					? (item as { draftKey: string }).draftKey
					: undefined;
			if (draftKey) {
				await deleteDraft(draftKey);
			}
		}),
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
