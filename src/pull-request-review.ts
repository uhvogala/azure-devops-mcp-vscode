import { IGitApi } from 'azure-devops-node-api/GitApi';
import { GitPullRequest, GitVersionType, IdentityRefWithVote } from 'azure-devops-node-api/interfaces/GitInterfaces';

export interface PullRequestIdentity {
	organization: string;
	project: string;
	repository: string;
}

export interface PullRequestReviewState extends PullRequestIdentity {
	pullRequestId: number;
}

export interface PullRequestReviewDependencies {
	getGitApi: (organization: string) => Promise<IGitApi>;
	getCurrentUserId?: (organization: string) => Promise<string>;
	getReviewedPaths?: (review: PullRequestReviewState) => Promise<readonly string[]>;
}

export interface PullRequestReview {
	id: number;
	organization: string;
	project: string;
	repository: string;
	title: string;
	description?: string;
	status?: number;
	sourceRef: string;
	targetRef: string;
	sourceCommit: string;
	targetCommit: string;
	currentBranch?: string;
	currentUserId?: string;
	reviewers: ReturnType<typeof reviewerSummary>[];
	changes: Array<PullRequestReviewChange>;
	changesTruncated: boolean;
}

export interface PullRequestReviewChange extends PullRequestReviewState {
	path: string;
	originalPath?: string;
	changeType: number;
	reviewed: boolean;
	commentCount: number;
	sourceCommit: string;
	targetCommit: string;
}

export function reviewerSummary(reviewer: IdentityRefWithVote): Record<string, unknown> {
	return {
		id: reviewer.id,
		displayName: reviewer.displayName,
		vote: reviewer.vote ?? 0,
		isRequired: reviewer.isRequired ?? false,
		hasDeclined: reviewer.hasDeclined ?? false,
	};
}

export async function loadPullRequestReview(
	pullRequest: GitPullRequest,
	identity: PullRequestIdentity,
	dependencies: PullRequestReviewDependencies,
): Promise<PullRequestReview> {
	const pullRequestId = pullRequest.pullRequestId;
	const sourceCommit = pullRequest.lastMergeSourceCommit?.commitId;
	const targetCommit = pullRequest.lastMergeTargetCommit?.commitId;
	if (!pullRequestId || !sourceCommit || !targetCommit || !pullRequest.sourceRefName || !pullRequest.targetRefName) {
		throw new Error('Azure DevOps did not return enough pull request information for review.');
	}
	const gitApi = await dependencies.getGitApi(identity.organization);
	const mergeBase = (await gitApi.getMergeBases(identity.repository, sourceCommit, targetCommit, identity.project))[0]?.commitId;
	if (!mergeBase) {
		throw new Error('Azure DevOps could not determine the pull request merge base.');
	}
	const [changes, threads, reviewedPaths, currentUserId] = await Promise.all([
		gitApi.getCommitDiffs(
			identity.repository,
			identity.project,
			false,
			1000,
			undefined,
			{ version: mergeBase, versionType: GitVersionType.Commit },
			{ version: sourceCommit, versionType: GitVersionType.Commit },
		),
		gitApi.getThreads(identity.repository, pullRequestId, identity.project),
		dependencies.getReviewedPaths?.({ ...identity, pullRequestId }) ?? Promise.resolve([]),
		dependencies.getCurrentUserId?.(identity.organization),
	]);
	const commentCounts = new Map<string, number>();
	for (const thread of threads) {
		const path = thread.threadContext?.filePath;
		if (path && !thread.isDeleted && (thread.comments ?? []).some(comment => !comment.isDeleted)) {
			commentCounts.set(path, (commentCounts.get(path) ?? 0) + 1);
		}
	}
	const reviewed = new Set(reviewedPaths);
	return {
		id: pullRequestId,
		...identity,
		title: pullRequest.title ?? 'Untitled pull request',
		description: pullRequest.description,
		status: pullRequest.status,
		sourceRef: pullRequest.sourceRefName,
		targetRef: pullRequest.targetRefName,
		sourceCommit,
		targetCommit,
		currentUserId,
		reviewers: (pullRequest.reviewers ?? []).map(reviewerSummary),
		changes: (changes.changes ?? []).flatMap(change => {
			const path = change.item?.path;
			if (!path || change.item?.isFolder || change.changeType === undefined) {
				return [];
			}
			return [{
				...identity,
				pullRequestId,
				path,
				originalPath: change.originalPath,
				changeType: change.changeType,
				reviewed: reviewed.has(path),
				commentCount: commentCounts.get(path) ?? 0,
				sourceCommit,
				targetCommit,
			}];
		}),
		changesTruncated: !changes.allChangesIncluded,
	};
}