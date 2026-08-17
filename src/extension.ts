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

function overviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'pr-overview.js'));
	const nonce = randomBytes(16).toString('hex');
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
:root { color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
html, body { height: 100%; } body { margin: 0; } main { display: grid; height: 100vh; overflow: hidden; grid-template-rows: auto minmax(0, 1fr); }
.toolbar { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; padding: 10px; border-bottom: 1px solid var(--vscode-panel-border); }
select, button { min-height: 28px; box-sizing: border-box; font: inherit; } select { width: 100%; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); }
button { border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor: pointer; } button:hover { background: var(--vscode-button-hoverBackground); }
.content { min-width: 0; overflow: hidden; } .empty, .error { padding: 14px; color: var(--vscode-descriptionForeground); } .error { color: var(--vscode-errorForeground); }
.pr-list { margin: 0; padding: 0; list-style: none; } .pr { width: 100%; padding: 10px; border: 0; border-bottom: 1px solid var(--vscode-panel-border); background: transparent; color: inherit; text-align: left; } .pr[aria-selected="true"] { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.pr-title { display: block; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .pr-meta { display: block; margin-top: 3px; color: var(--vscode-descriptionForeground); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.review { padding: 12px; } .review-header { display: flex; justify-content: space-between; gap: 8px; } h2 { margin: 0; font-size: 15px; line-height: 1.35; } .number, .meta, .files span { color: var(--vscode-descriptionForeground); font-size: 11px; } .branches { margin: 10px 0; padding: 8px; border-left: 3px solid var(--vscode-focusBorder); background: var(--vscode-editorWidget-background); overflow-wrap: anywhere; }
.description { line-height: 1.45; white-space: pre-wrap; } .files { margin-top: 14px; border: 1px solid var(--vscode-panel-border); } .files h3 { margin: 0; padding: 8px; font-size: 12px; } .file { display: flex; justify-content: space-between; gap: 8px; width: 100%; padding: 7px 8px; border: 0; border-top: 1px solid var(--vscode-panel-border); background: transparent; color: inherit; text-align: left; } .file code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.loading { padding: 22px; color: var(--vscode-descriptionForeground); text-align: center; }
.content { display: grid; grid-template-rows: minmax(92px, 34%) minmax(0, 1fr); } .pr-picker { min-height: 0; overflow: auto; border-bottom: 1px solid var(--vscode-panel-border); } .pr-picker > h2 { position: sticky; top: 0; z-index: 1; padding: 8px 10px; background: var(--vscode-editorWidget-background); color: var(--vscode-descriptionForeground); font-size: 11px; text-transform: uppercase; } .pr-picker .empty { padding: 10px; } .review-host { min-height: 0; overflow: auto; }
.review-host { padding: 12px; } .review-host.is-loading { opacity: .65; pointer-events: none; } .header, .files-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; } h1, h2, h3 { margin: 0; } h1 { font-size: 15px; line-height: 1.35; } h2, h3 { font-size: 12px; } .number, .files-header span, .file-details span, .approvals-count, .reviewer-vote { color: var(--vscode-descriptionForeground); font-size: 11px; } .status { padding: 3px 6px; background: var(--vscode-testing-iconPassed); color: var(--vscode-editor-background); font-size: 10px; font-weight: 700; text-transform: uppercase; } .branches { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; margin-top: 10px; padding: 8px; border-left: 3px solid var(--vscode-focusBorder); background: var(--vscode-editorWidget-background); overflow-wrap: anywhere; } .branch-actions, .file-actions { display: flex; gap: 6px; flex-wrap: wrap; } .approval-actions { display: flex; gap: 6px; margin-top: 8px; } .review-host button { border: 1px solid var(--vscode-button-border, transparent); padding: 5px 8px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); font: inherit; font-size: 12px; font-weight: 600; white-space: nowrap; } .review-host button:hover { background: var(--vscode-button-hoverBackground); } .checkout-branch, .open-file { background: var(--vscode-button-secondaryBackground) !important; color: var(--vscode-button-secondaryForeground) !important; } .branch-error, .approval-error, .action-error { color: var(--vscode-errorForeground); font-size: 11px; overflow-wrap: anywhere; } .approvals, .summary, .files { margin-top: 14px; } .approvals-header, .reviewer { display: flex; justify-content: space-between; gap: 8px; } .approval-list { display: grid; gap: 4px; margin-top: 7px; } .reviewer { padding: 6px 8px; border-left: 3px solid var(--vscode-panel-border); background: var(--vscode-editorWidget-background); font-size: 12px; } .reviewer-name { overflow-wrap: anywhere; } .summary .section-title { margin-bottom: 7px; color: var(--vscode-descriptionForeground); font-size: 11px; text-transform: uppercase; } .markdown { line-height: 1.45; } .markdown p { margin: 0 0 8px; } .markdown code, code { font-family: var(--vscode-editor-font-family); } .files { border: 1px solid var(--vscode-panel-border); } .files-header { padding: 8px; background: var(--vscode-editorWidget-background); } .file { display: grid; grid-template-columns: 82px minmax(0, 1fr) auto; align-items: start; gap: 8px; padding: 8px; border-top: 1px solid var(--vscode-panel-border); } .file-details { min-width: 0; display: grid; gap: 3px; } .file code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .review-control { display: inline-flex; align-items: center; gap: 4px; color: var(--vscode-descriptionForeground); font-size: 11px; } .comment-count { min-height: auto !important; justify-self: start; padding: 0 !important; border: 0 !important; background: transparent !important; color: var(--vscode-textLink-foreground) !important; font-size: 11px !important; text-decoration: underline; } @media (max-width: 420px) { .file { grid-template-columns: 82px minmax(0, 1fr); } .file-actions { grid-column: 2; } .branches { grid-template-columns: 1fr; } .branch-actions { justify-content: flex-start; } }
.review-host button { border-radius: var(--vscode-button-border-radius, 4px); }
.review-host .branches { grid-template-columns: minmax(0, 1fr); margin-bottom: 16px; }
.review-host .branch-actions { grid-column: 1; justify-content: flex-start; }
.review-host .branch-error { grid-column: 1; }
.review-host .approvals { margin-top: 0; }
.review-host .approval-actions { margin-top: 12px; }
.review-host .file { grid-template-columns: 72px minmax(110px, 1fr) auto; }
.review-host .file-actions { grid-column: auto; flex-wrap: nowrap; }
@media (max-width: 500px) { .review-host .file { grid-template-columns: 72px minmax(0, 1fr); } .review-host .file-actions { grid-column: 2; flex-wrap: wrap; } }
/* The review view is narrower than the chat card; reset legacy card rules here. */
.review-host, .review-host *, .review-host *::before, .review-host *::after { box-sizing: border-box; }
.review-host { width: 100%; max-width: none; padding: 12px; overflow-x: hidden; }
.review-host .header { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; }
.review-host .branches { display: grid; grid-template-columns: minmax(0, 1fr); width: 100%; margin: 10px 0 0; }
.review-host .branch-actions { display: flex; width: 100%; margin-top: 8px; }
.review-host .approvals { display: block; clear: both; width: 100%; margin-top: 16px; }
.review-host .approval-actions { display: flex; width: 100%; }
.review-host .files { width: 100%; overflow: hidden; }
.review-host .file { display: grid; grid-template-columns: 72px minmax(0, 1fr) auto; width: 100%; margin: 0; border: 0; border-top: 1px solid var(--vscode-panel-border); }
.review-host .file-actions { display: flex; align-items: start; justify-content: flex-end; min-width: 0; }
.review-host .file-actions button { flex: 0 1 auto; min-width: 0; }
@media (max-width: 560px) { .review-host .file { grid-template-columns: 72px minmax(0, 1fr); } .review-host .file-actions { grid-column: 2; justify-content: flex-start; margin-top: 4px; } }
</style></head><body><script nonce="${nonce}" src="${scriptUri}"></script></body></html>`;
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
.approvals, .summary, .files { width: 100%; margin-top: 16px; } .approvals-header, .reviewer, .files-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; } .approval-list { display: grid; gap: 4px; margin-top: 8px; } .reviewer { padding: 6px 8px; border-left: 3px solid var(--vscode-panel-border); background: var(--vscode-editorWidget-background); font-size: 12px; } .reviewer-name { min-width: 0; overflow-wrap: anywhere; } .approval-actions { display: flex; margin-top: 12px; }
.section-title { margin-bottom: 7px; color: var(--vscode-descriptionForeground); font-size: 11px; text-transform: uppercase; } .markdown { line-height: 1.45; } .markdown p { margin: 0 0 8px; } .markdown code, code { font-family: var(--vscode-editor-font-family); }
.files { border: 1px solid var(--vscode-panel-border); overflow: hidden; } .files-header { padding: 8px; background: var(--vscode-editorWidget-background); } .file { display: grid; grid-template-columns: 72px minmax(0, 1fr) auto; gap: 8px; width: 100%; margin: 0; padding: 8px; border: 0; border-top: 1px solid var(--vscode-panel-border); } .file-details { min-width: 0; display: grid; gap: 3px; } .file code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .file-actions { display: flex; align-items: start; gap: 6px; } .review-control { display: inline-flex; align-items: center; gap: 4px; color: var(--vscode-descriptionForeground); font-size: 11px; }
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
	let reviewWebview: vscode.WebviewView | undefined;
	let selectedOverviewRepositoryKey = context.workspaceState.get<string>('azure-devops-mcp.overview.repository');
	let selectedOverviewPullRequestId: number | undefined;
	let treeRepository: WorkspaceRepository | undefined;
	let treePullRequests: readonly OverviewPullRequest[] = [];
	let treeError: string | undefined;
	const treeChanged = new vscode.EventEmitter<void>();
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
			let review: Awaited<ReturnType<typeof loadPullRequestReview>> | undefined;
			if (selectedPullRequest) {
				selectedOverviewPullRequestId = selectedPullRequest.id;
				await context.workspaceState.update(selectedPullRequestKey, selectedPullRequest.id);
				const pullRequest = await gitApi.getPullRequest(selectedRepository.repository, selectedPullRequest.id, selectedRepository.project);
				review = await loadPullRequestReview(pullRequest, selectedRepository, {
					getGitApi,
					getCurrentUserId: getAuthenticatedUserId,
					getReviewedPaths: reviewState => Promise.resolve(reviewStateStore.getReviewedPaths(reviewState)),
				});
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
			if (!treeRepository) {
				return treeError ? [new vscode.TreeItem(treeError, vscode.TreeItemCollapsibleState.None)] : [];
			}
			if (!element) {
				const repositoryItem = new vscode.TreeItem(treeRepository.repository, vscode.TreeItemCollapsibleState.Expanded);
				repositoryItem.description = `${treeRepository.organization}/${treeRepository.project}`;
				repositoryItem.iconPath = new vscode.ThemeIcon('repo');
				repositoryItem.command = { command: selectOverviewRepositoryCommand, title: 'Select Pull Request Repository' };
				repositoryItem.contextValue = 'azure-devops-mcp.repository';
				return [repositoryItem];
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
	pullRequestsTree.onDidChangeVisibility(() => {
		if (pullRequestsTree.visible) {
			void refreshOverview();
		}
	});
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
