import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as azureDevOps from 'azure-devops-node-api';
import {
	CommentThreadStatus,
	CommentType,
	GitPullRequest,
	GitPullRequestCommentThread,
	GitVersionType,
	PullRequestStatus,
} from 'azure-devops-node-api/interfaces/GitInterfaces';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod/v4';
import { loadPullRequestReview, reviewerSummary } from './pull-request-review';

const repositorySchema = {
	organization: z.string().min(1).describe('Azure DevOps organization name.'),
	project: z.string().min(1).describe('Azure DevOps project name or ID.'),
	repository: z.string().min(1).describe('Git repository name or ID.'),
};

const openPullRequestFileDiffCommand = 'azure-devops-mcp.openPullRequestFileDiff';
const pullRequestReviewCardUri = 'ui://azure-devops/pull-request-review.html';

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

interface CheckoutPullRequestBranchArguments {
	organization: string;
	project: string;
	repository: string;
	branch: string;
}

interface PullRequestReviewStateArguments {
	organization: string;
	project: string;
	repository: string;
	pullRequestId: number;
	path?: string;
	reviewed?: boolean;
}

function requiredEnvironment(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Missing ${name}. Start this server from the Azure DevOps MCP VS Code extension.`);
	}
	return value;
}

function createTokenProvider(): () => Promise<string> {
	const accessToken = requiredEnvironment('AZURE_DEVOPS_ACCESS_TOKEN');
	return async () => accessToken;
}

function pullRequestSummary(pullRequest: GitPullRequest): Record<string, unknown> {
	return {
		id: pullRequest.pullRequestId,
		title: pullRequest.title,
		description: pullRequest.description,
		status: pullRequest.status,
		url: pullRequest.url,
		createdAt: pullRequest.creationDate,
		sourceRef: pullRequest.sourceRefName,
		targetRef: pullRequest.targetRefName,
	};
}

function pullRequestResult(pullRequest: GitPullRequest): string {
	return JSON.stringify(pullRequestSummary(pullRequest), null, 2);
}

function pullRequestCommentSummary(thread: GitPullRequestCommentThread): Record<string, unknown> {
	return {
		id: thread.id,
		status: thread.status,
		filePath: thread.threadContext?.filePath,
		startLine: thread.threadContext?.rightFileStart?.line,
		endLine: thread.threadContext?.rightFileEnd?.line,
		comments: (thread.comments ?? [])
			.filter(comment => !comment.isDeleted)
			.map(comment => ({
				id: comment.id,
				author: comment.author?.displayName,
				content: comment.content,
				publishedAt: comment.publishedDate,
			})),
	};
}

function openPullRequestFileDiffLink(arguments_: OpenPullRequestFileDiffArguments): string {
	const commandArguments = encodeURIComponent(JSON.stringify([arguments_]));
	return `[Open diff](command:${openPullRequestFileDiffCommand}?${commandArguments})`;
}

async function openPullRequestFileDiff(arguments_: OpenPullRequestFileDiffArguments): Promise<void> {
	await invokeExtensionCommand('AZURE_DEVOPS_DIFF_COMMAND_URL', arguments_);
}

async function openPullRequestFile(arguments_: OpenPullRequestFileArguments): Promise<void> {
	await invokeExtensionCommand('AZURE_DEVOPS_OPEN_FILE_URL', arguments_);
}

async function checkoutPullRequestBranch(arguments_: CheckoutPullRequestBranchArguments): Promise<string> {
	const response = await fetch(requiredEnvironment('AZURE_DEVOPS_CHECKOUT_BRANCH_URL'), {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${requiredEnvironment('AZURE_DEVOPS_DIFF_COMMAND_TOKEN')}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(arguments_),
	});
	if (!response.ok) {
		throw new Error((await response.text()) || `Unable to check out branch (${response.status}).`);
	}
	const body: unknown = await response.json();
	if (!body || typeof body !== 'object' || typeof (body as { currentBranch?: unknown }).currentBranch !== 'string') {
		throw new Error('Invalid branch checkout response.');
	}
	return (body as { currentBranch: string }).currentBranch;
}

async function getPullRequestReviewState(arguments_: PullRequestReviewStateArguments): Promise<readonly string[]> {
	const response = await fetch(requiredEnvironment('AZURE_DEVOPS_REVIEW_STATE_URL'), {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${requiredEnvironment('AZURE_DEVOPS_DIFF_COMMAND_TOKEN')}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(arguments_),
	});
	if (!response.ok) {
		throw new Error((await response.text()) || `Unable to load review state (${response.status}).`);
	}
	const body: unknown = await response.json();
	if (!body || typeof body !== 'object' || !Array.isArray((body as { reviewedPaths?: unknown }).reviewedPaths)) {
		throw new Error('Invalid pull request review state response.');
	}
	return (body as { reviewedPaths: unknown[] }).reviewedPaths.filter((path): path is string => typeof path === 'string');
}

async function setPullRequestFileReviewed(arguments_: Required<PullRequestReviewStateArguments>): Promise<void> {
	await getPullRequestReviewState(arguments_);
}

async function invokeExtensionCommand(urlEnvironment: string, arguments_: object): Promise<void> {
	const response = await fetch(requiredEnvironment(urlEnvironment), {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${requiredEnvironment('AZURE_DEVOPS_DIFF_COMMAND_TOKEN')}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(arguments_),
	});
	if (!response.ok) {
		const detail = await response.text();
		throw new Error(detail || `Unable to open the native diff view (${response.status}).`);
	}
}

async function main(): Promise<void> {
	const getAccessToken = createTokenProvider();
	const server = new McpServer({ name: 'azure-devops-pull-requests', version: '0.0.1' });

	server.registerResource(
		'Azure DevOps pull request review card',
		pullRequestReviewCardUri,
		{
			description: 'Interactive Azure DevOps pull request review card.',
			mimeType: 'text/html;profile=mcp-app',
			_meta: { ui: { prefersBorder: true } },
		},
		async uri => ({
			contents: [{
				uri: uri.href,
				mimeType: 'text/html;profile=mcp-app',
				text: await readFile(join(__dirname, 'pr-review-card.html'), 'utf8'),
			}],
		}),
	);

	const getGitApi = async (organization: string) => {
		const accessToken = await getAccessToken();
		const connection = new azureDevOps.WebApi(
			`https://dev.azure.com/${encodeURIComponent(organization)}`,
			azureDevOps.getBearerHandler(accessToken),
		);
		return connection.getGitApi();
	};

	const getAuthenticatedUserId = async (organization: string): Promise<string> => {
		const accessToken = await getAccessToken();
		const connection = new azureDevOps.WebApi(
			`https://dev.azure.com/${encodeURIComponent(organization)}`,
			azureDevOps.getBearerHandler(accessToken),
		);
		const connectionData = await connection.connect();
		const userId = connectionData.authenticatedUser?.id;
		if (!userId) {
			throw new Error('Azure DevOps did not return the signed-in user identity.');
		}
		return userId;
	};

	const pullRequestReviewResult = async (
		pullRequest: GitPullRequest,
		organization: string,
		project: string,
		repository: string,
	) => {
		const review = await loadPullRequestReview(pullRequest, { organization, project, repository }, {
			getGitApi,
			getCurrentUserId: getAuthenticatedUserId,
			getReviewedPaths: getPullRequestReviewState,
		});
		return {
			content: [{
				type: 'text' as const,
				text: JSON.stringify({ ...pullRequestSummary(pullRequest), reviewers: review.reviewers, changes: review.changes, changesTruncated: review.changesTruncated }, null, 2),
			}],
			structuredContent: review,
		};
	};

	const pullRequestDraftChanges = async (
		organization: string,
		project: string,
		repository: string,
		sourceRef: string,
		targetRef: string,
	) => {
		try {
			const gitApi = await getGitApi(organization);
			const refs = await gitApi.getRefs(repository, project);
			const sourceCommit = refs.find(ref => ref.name === sourceRef)?.objectId;
			const targetCommit = refs.find(ref => ref.name === targetRef)?.objectId;
			if (!sourceCommit || !targetCommit) {
				throw new Error('Azure DevOps could not resolve the source or target branch head.');
			}
			const changes = await gitApi.getCommitDiffs(
				repository,
				project,
				false,
				20,
				undefined,
				{ version: targetCommit, versionType: GitVersionType.Commit },
				{ version: sourceCommit, versionType: GitVersionType.Commit },
			);
			const changeEntries = (changes.changes ?? []).flatMap(change => change.item?.path ? [{
				path: change.item.path,
				changeType: change.changeType,
			}] : []);
			return {
				changes: changeEntries.filter(change => !changeEntries.some(other => other.path.startsWith(`${change.path}/`))),
				changesTruncated: !changes.allChangesIncluded,
			};
		} catch (error) {
			return {
				changes: [],
				changesTruncated: false,
				changesError: error instanceof Error ? error.message : 'Azure DevOps could not load changed files.',
			};
		}
	};

	server.registerTool(
		'list_pull_requests',
		{
			description: 'List pull requests in an Azure DevOps Git repository.',
			inputSchema: z.object({
				...repositorySchema,
				status: z.enum(['active', 'abandoned', 'completed', 'all']).default('active'),
				top: z.number().int().min(1).max(100).default(25),
			}),
		},
		async ({ organization, project, repository, status, top }) => {
			const statuses = {
				active: PullRequestStatus.Active,
				abandoned: PullRequestStatus.Abandoned,
				completed: PullRequestStatus.Completed,
				all: PullRequestStatus.All,
			};
			const pullRequests = await (await getGitApi(organization)).getPullRequests(
				repository,
				{ status: statuses[status] },
				project,
				undefined,
				undefined,
				top,
			);
			return { content: [{ type: 'text', text: JSON.stringify(pullRequests.map(pullRequestSummary), null, 2) }] };
		},
	);

	server.registerTool(
		'open_pull_request_file',
		{
			description: 'Open a changed pull request file from the matching local VS Code workspace folder.',
			inputSchema: z.object({
				...repositorySchema,
				path: z.string().min(1).describe('Changed repository file path.'),
			}),
			_meta: {
				ui: { visibility: ['model', 'app'] },
				'ui/visibility': ['model', 'app'],
			},
		},
		async ({ organization, project, repository, path }) => {
			await openPullRequestFile({ organization, project, repository, path });
			return { content: [{ type: 'text', text: `Opened local file ${path}.` }] };
		},
	);

	server.registerTool(
		'list_pull_request_comments',
		{
			description: 'List Azure DevOps discussion threads on a pull request, including file and line locations.',
			inputSchema: z.object({
				...repositorySchema,
				pullRequestId: z.number().int().positive(),
			}),
		},
		async ({ organization, project, repository, pullRequestId }) => {
			const threads = await (await getGitApi(organization)).getThreads(repository, pullRequestId, project);
			return {
				content: [{ type: 'text', text: JSON.stringify(threads.map(pullRequestCommentSummary), null, 2) }],
			};
		},
	);

	server.registerTool(
		'add_pull_request_comment',
		{
			description: 'Create an Azure DevOps pull request comment. Include path and line for a comment that appears in the native diff editor.',
			inputSchema: z.object({
				...repositorySchema,
				pullRequestId: z.number().int().positive(),
				content: z.string().min(1).describe('Comment text.'),
				path: z.string().min(1).optional().describe('Changed repository file path for a line comment.'),
				line: z.number().int().positive().optional().describe('1-based line in the pull request source file.'),
			}),
		},
		async ({ organization, project, repository, pullRequestId, content, path, line }) => {
			if ((path === undefined) !== (line === undefined)) {
				throw new Error('Specify both path and line for a file comment, or neither for a general comment.');
			}
			const commentThread: GitPullRequestCommentThread = {
				comments: [{ content, commentType: CommentType.Text }],
				status: CommentThreadStatus.Active,
				threadContext: path && line ? {
					filePath: path,
					rightFileStart: { line, offset: 1 },
					rightFileEnd: { line, offset: 1 },
				} : undefined,
			};
			const thread = await (await getGitApi(organization)).createThread(commentThread, repository, pullRequestId, project);
			return { content: [{ type: 'text', text: JSON.stringify(pullRequestCommentSummary(thread), null, 2) }] };
		},
	);

	server.registerTool(
		'reply_to_pull_request_comment',
		{
			description: 'Reply to an existing Azure DevOps pull request comment thread.',
			inputSchema: z.object({
				...repositorySchema,
				pullRequestId: z.number().int().positive(),
				threadId: z.number().int().positive(),
				content: z.string().min(1).describe('Reply text.'),
			}),
		},
		async ({ organization, project, repository, pullRequestId, threadId, content }) => {
			const comment = await (await getGitApi(organization)).createComment({
				content,
				commentType: CommentType.Text,
			}, repository, pullRequestId, threadId, project);
			return {
				content: [{
					type: 'text',
					text: JSON.stringify({
						id: comment.id,
						author: comment.author?.displayName,
						content: comment.content,
						publishedAt: comment.publishedDate,
					}, null, 2),
				}],
			};
		},
	);

	server.registerTool(
		'checkout_pull_request_branch',
		{
			description: 'Check out a pull request source or target branch in the matching local VS Code workspace folder.',
			inputSchema: z.object({
				...repositorySchema,
				branch: z.string().startsWith('refs/heads/').describe('Pull request sourceRef or targetRef.'),
			}),
			_meta: {
				ui: { visibility: ['model', 'app'] },
				'ui/visibility': ['model', 'app'],
			},
		},
		async ({ organization, project, repository, branch }) => {
			const currentBranch = await checkoutPullRequestBranch({ organization, project, repository, branch });
			return {
				content: [{ type: 'text', text: `Checked out ${currentBranch}.` }],
				structuredContent: { currentBranch },
			};
		},
	);

	server.registerTool(
		'set_pull_request_file_reviewed',
		{
			description: 'Mark a pull request file as reviewed or not reviewed. Review state is stored in the current VS Code workspace.',
			inputSchema: z.object({
				...repositorySchema,
				pullRequestId: z.number().int().positive(),
				path: z.string().min(1).describe('Changed repository file path.'),
				reviewed: z.boolean().describe('Whether the file has been reviewed.'),
			}),
			_meta: {
				ui: { visibility: ['model', 'app'] },
				'ui/visibility': ['model', 'app'],
			},
		},
		async ({ organization, project, repository, pullRequestId, path, reviewed }) => {
			await setPullRequestFileReviewed({ organization, project, repository, pullRequestId, path, reviewed });
			return { content: [{ type: 'text', text: `${reviewed ? 'Marked' : 'Marked not'} reviewed: ${path}.` }] };
		},
	);

	server.registerTool(
		'get_pull_request',
		{
			description: 'Get an Azure DevOps pull request by ID.',
			inputSchema: z.object({
				...repositorySchema,
				pullRequestId: z.number().int().positive(),
				includeChanges: z.boolean().default(false).describe('Include changed files with links to VS Code native diffs.'),
			}),
			_meta: {
				ui: { resourceUri: pullRequestReviewCardUri },
				'ui/resourceUri': pullRequestReviewCardUri,
			},
		},
		async ({ organization, project, repository, pullRequestId, includeChanges }) => {
			const gitApi = await getGitApi(organization);
			const pullRequest = await gitApi.getPullRequest(repository, pullRequestId, project);
			if (!includeChanges) {
				return { content: [{ type: 'text', text: pullRequestResult(pullRequest) }] };
			}
			return pullRequestReviewResult(pullRequest, organization, project, repository);
		},
	);

	server.registerTool(
		'approve_pull_request',
		{
			description: 'Approve an Azure DevOps pull request as the signed-in user.',
			inputSchema: z.object({
				...repositorySchema,
				pullRequestId: z.number().int().positive(),
			}),
			_meta: {
				ui: { visibility: ['model', 'app'] },
				'ui/visibility': ['model', 'app'],
			},
		},
		async ({ organization, project, repository, pullRequestId }) => {
			const gitApi = await getGitApi(organization);
			const userId = await getAuthenticatedUserId(organization);
			const reviewer = await gitApi.createPullRequestReviewer(
				{ id: userId, vote: 10 },
				repository,
				pullRequestId,
				userId,
				project,
			);
			const reviewers = await gitApi.getPullRequestReviewers(repository, pullRequestId, project);
			return {
				content: [{ type: 'text', text: JSON.stringify({ reviewer: reviewerSummary(reviewer), reviewers: reviewers.map(reviewerSummary) }, null, 2) }],
				structuredContent: { reviewer: reviewerSummary(reviewer), reviewers: reviewers.map(reviewerSummary) },
			};
		},
	);

	server.registerTool(
		'open_pull_request_file_diff',
		{
			description: 'Open a pull request file comparison in VS Code\'s native diff editor.',
			inputSchema: z.object({
				...repositorySchema,
				pullRequestId: z.number().int().positive().describe('Azure DevOps pull request ID.'),
				path: z.string().min(1).describe('Changed repository file path.'),
				originalPath: z.string().min(1).optional().describe('Previous file path for renamed files.'),
				sourceCommit: z.string().min(1).describe('Pull request source commit ID.'),
				targetCommit: z.string().min(1).describe('Pull request target commit ID.'),
				changeType: z.number().int().nonnegative().describe('Azure DevOps change type from get_pull_request.'),
			}),
			_meta: {
				ui: { visibility: ['model', 'app'] },
				'ui/visibility': ['model', 'app'],
			},
		},
		async ({ organization, project, repository, pullRequestId, path, originalPath, sourceCommit, targetCommit, changeType }) => {
			await openPullRequestFileDiff({
				organization,
				project,
				repository,
				pullRequestId,
				path,
				originalPath,
				sourceCommit,
				targetCommit,
				changeType,
			});
			return { content: [{ type: 'text', text: `Opened native diff for ${path}.` }] };
		},
	);

	server.registerTool(
		'create_pull_request',
		{
			description: 'Prepare an Azure DevOps pull request draft for review. This does not create a remote pull request.',
			inputSchema: z.object({
				...repositorySchema,
				sourceRef: z.string().startsWith('refs/heads/'),
				targetRef: z.string().startsWith('refs/heads/'),
				title: z.string().min(1).max(255),
				description: z.string().optional(),
				reviewerIds: z.array(z.string().min(1)).optional(),
			}),
			_meta: {
				ui: { resourceUri: pullRequestReviewCardUri },
				'ui/resourceUri': pullRequestReviewCardUri,
			},
		},
		async ({ organization, project, repository, sourceRef, targetRef, title, description, reviewerIds }) => {
			const changedFiles = await pullRequestDraftChanges(organization, project, repository, sourceRef, targetRef);
			const draft = {
				mode: 'create',
				sourceRefName: sourceRef,
				targetRefName: targetRef,
				title,
				description: description ?? '',
				reviewerIds: reviewerIds ?? [],
				organization,
				project,
				repository,
				...changedFiles,
			};
			return {
				content: [{ type: 'text', text: JSON.stringify(draft, null, 2) }],
				structuredContent: draft,
			};
		},
	);

	server.registerTool(
		'submit_pull_request',
		{
			description: 'Create a reviewed Azure DevOps pull request. This changes remote state and requires confirm: true.',
			inputSchema: z.object({
				...repositorySchema,
				sourceRef: z.string().startsWith('refs/heads/'),
				targetRef: z.string().startsWith('refs/heads/'),
				title: z.string().min(1).max(255),
				description: z.string(),
				reviewerIds: z.array(z.string().min(1)).default([]),
				confirm: z.literal(true).describe('Must be true to create the pull request.'),
			}),
			_meta: {
				ui: { visibility: ['model', 'app'], resourceUri: pullRequestReviewCardUri },
				'ui/visibility': ['model', 'app'],
				'ui/resourceUri': pullRequestReviewCardUri,
			},
		},
		async ({ organization, project, repository, sourceRef, targetRef, title, description, reviewerIds }) => {
			const pullRequest = await (await getGitApi(organization)).createPullRequest({
				sourceRefName: sourceRef,
				targetRefName: targetRef,
				title,
				description,
				reviewers: reviewerIds.map(id => ({ id })),
			}, repository, project);
			return pullRequestReviewResult(pullRequest, organization, project, repository);
		},
	);

	await server.connect(new StdioServerTransport());
}

void main();