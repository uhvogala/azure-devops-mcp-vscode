import { applyReviewedPaths, renderPullRequestReview } from './pull-request-review-ui';

const vscode = acquireVsCodeApi();
const root = document.createElement('main');
root.className = 'review-host';
document.body.append(root);
const pendingActions = new Map();
let review;

function callHostAction(request) {
	const id = crypto.randomUUID();
	vscode.postMessage({ type: 'action', id, request });
	return new Promise(resolve => pendingActions.set(id, resolve));
}

window.addEventListener('message', event => {
	if (event.data.type === 'actionResult') {
		pendingActions.get(event.data.id)?.(event.data.result);
		pendingActions.delete(event.data.id);
		return;
	}
	if (event.data.type === 'sharedStateChanged') {
		const change = event.data.change;
		if (review?.sharedState?.key !== change?.key || !Array.isArray(change.value)) {
			return;
		}
		review.sharedState.version = change.version;
		applyReviewedPaths(review, change.value);
		renderPullRequestReview(root, review, callHostAction);
		return;
	}
	if (event.data.review) {
		review = event.data.review;
		renderPullRequestReview(root, review, callHostAction);
		return;
	}
	root.textContent = event.data.error || 'Select a pull request to review.';
});

vscode.postMessage({ type: 'ready' });