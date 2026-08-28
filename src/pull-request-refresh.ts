interface ReviewChange {
	path: string;
	originalPath?: string;
	changeType: number;
	commentCount: number;
}

export interface PullRequestRefreshSnapshot {
	title?: string;
	description?: string;
	status?: number;
	sourceRef?: string;
	targetRef?: string;
	sourceCommit?: string;
	targetCommit?: string;
	reviewers?: unknown[];
	workItems?: unknown[];
	changes?: ReviewChange[];
	changesTruncated?: boolean;
}

function displayedReviewContent(review: PullRequestRefreshSnapshot) {
	return {
		title: review.title,
		description: review.description,
		status: review.status,
		sourceRef: review.sourceRef,
		targetRef: review.targetRef,
		sourceCommit: review.sourceCommit,
		targetCommit: review.targetCommit,
		reviewers: review.reviewers ?? [],
		workItems: review.workItems ?? [],
		changesTruncated: review.changesTruncated ?? false,
		changes: (review.changes ?? []).map(({ path, originalPath, changeType, commentCount }) => ({ path, originalPath, changeType, commentCount })),
	};
}

export function reviewChanged(review: PullRequestRefreshSnapshot, nextReview: PullRequestRefreshSnapshot): boolean {
	return JSON.stringify(displayedReviewContent(review)) !== JSON.stringify(displayedReviewContent(nextReview));
}

export function subscribeToPullRequestRefresh(
	review: PullRequestRefreshSnapshot,
	loadReview: () => Promise<PullRequestRefreshSnapshot | undefined>,
	onRefresh: (review: PullRequestRefreshSnapshot) => void,
	intervalMs = 15_000,
): () => void {
	let active = true;
	let loading = false;
	const refresh = async () => {
		if (!active || loading) {
			return;
		}
		loading = true;
		try {
			const nextReview = await loadReview();
			if (active && nextReview && reviewChanged(review, nextReview)) {
				onRefresh(nextReview);
			}
		} catch {
			// Keep the existing card usable if a background refresh fails.
		} finally {
			loading = false;
		}
	};
	const interval = setInterval(() => {
		void refresh();
	}, intervalMs);
	return () => {
		active = false;
		clearInterval(interval);
	};
}