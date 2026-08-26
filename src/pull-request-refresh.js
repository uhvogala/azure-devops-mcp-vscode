function reviewChanged(review, nextReview) {
	if (nextReview.sourceCommit !== review.sourceCommit || nextReview.targetCommit !== review.targetCommit) {
		return true;
	}
	if (nextReview.changes.length !== review.changes.length) {
		return true;
	}
	const previousChanges = new Map(review.changes.map(change => [change.path, change]));
	return nextReview.changes.some(change => {
		const previous = previousChanges.get(change.path);
		return !previous || previous.commentCount !== change.commentCount;
	});
}

export function subscribeToPullRequestRefresh(review, loadReview, onRefresh, intervalMs = 15_000) {
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
