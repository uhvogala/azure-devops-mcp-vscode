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
			if (active && nextReview
				&& (nextReview.sourceCommit !== review.sourceCommit || nextReview.targetCommit !== review.targetCommit)) {
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
