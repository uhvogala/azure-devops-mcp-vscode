import { renderPullRequestReview } from './pull-request-review-ui';

const vscode = acquireVsCodeApi();
const root = document.createElement('main');
root.className = 'review-host';
document.body.append(root);
const pendingActions = new Map();

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
	if (event.data.review) {
		renderPullRequestReview(root, event.data.review, callHostAction);
		return;
	}
	root.textContent = event.data.error || 'Select a pull request to review.';
});

vscode.postMessage({ type: 'ready' });