import { applyReviewedPaths, renderPullRequestReview } from './pull-request-review-ui';
import { renderPullRequestDraft } from './pull-request-draft-ui';
import { subscribeToPullRequestRefresh } from './pull-request-refresh';

const vscode = acquireVsCodeApi();
const root = document.createElement('main');
root.className = 'review-host';
document.body.append(root);
const pendingActions = new Map();
let review;
let disposeDraft = () => undefined;
let disposeReviewRefresh = () => undefined;
let disposeRepositoryRefresh = () => undefined;
const sharedStateListeners = new Map();

function renderMessage(message) {
	const state = document.createElement('div');
	state.className = 'terminal-state';
	state.setAttribute('role', 'status');
	state.textContent = message;
	root.replaceChildren(state);
}

function callHostAction(request) {
	const id = crypto.randomUUID();
	vscode.postMessage({ type: 'action', id, request });
	return new Promise(resolve => pendingActions.set(id, resolve));
}

function subscribeSharedState(sharedState, defaultValue, onChange) {
	if (!sharedState?.key) {return () => undefined;}
	const listeners = sharedStateListeners.get(sharedState.key) ?? new Set();
	const listener = change => {
		sharedState.version = change.version;
		onChange(change.value);
	};
	listeners.add(listener);
	sharedStateListeners.set(sharedState.key, listeners);
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) {sharedStateListeners.delete(sharedState.key);}
	};
}

async function setSharedState(sharedState, value) {
	let expectedVersion = sharedState.version ?? 0;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const result = await callHostAction({
			name: 'set_shared_state',
			arguments: { key: sharedState.key, value, expectedVersion },
		});
		if (result.isError) {throw new Error(result.content?.[0]?.text || 'Unable to update shared state.');}
		const state = result.structuredContent;
		if (!state || typeof state.version !== 'number') {throw new Error('Invalid shared state response.');}
		sharedState.version = state.version;
		if (state.applied) {return state;}
		expectedVersion = state.version;
	}
	throw new Error('The draft changed before it could be updated.');
}

function renderDraft(draft) {
	disposeRepositoryRefresh();
	disposeReviewRefresh();
	disposeDraft();
	review = undefined;
	disposeDraft = renderPullRequestDraft(root, draft, {
		callAction: callHostAction,
		subscribeSharedState,
		setSharedState,
		onSubmitted: nextReview => {
			if (nextReview?.id && Array.isArray(nextReview.changes)) {
				renderReview(nextReview);
			} else {
				disposeDraft();
				renderMessage('Pull request submitted.');
			}
		},
		onDeleted: () => {
			disposeDraft();
			renderMessage('Draft deleted.');
		},
	});
}

function renderReview(nextReview) {
	disposeRepositoryRefresh();
	disposeReviewRefresh();
	disposeDraft();
	disposeDraft = () => undefined;
	review = nextReview;
	renderPullRequestReview(root, review, callHostAction);
	const loadReview = async () => (await callHostAction({
			name: 'get_pull_request',
			arguments: {
				organization: review.organization,
				project: review.project,
				repository: review.repository,
				pullRequestId: review.id,
			},
		})).structuredContent;
	const refreshReview = async () => {
		const refreshed = await loadReview();
		if (refreshed?.id && Array.isArray(refreshed.changes)) {
			refreshed.currentBranch = review.currentBranch;
			renderReview(refreshed);
		}
	};
	disposeReviewRefresh = subscribeToPullRequestRefresh(
		review,
		loadReview,
		renderReview,
	);
	disposeRepositoryRefresh = subscribeSharedState(review.repositoryState, {}, value => {
		if (value && typeof value === 'object' && typeof value.currentBranch === 'string') {
			review.currentBranch = value.currentBranch;
		}
		void refreshReview();
	});
}

window.addEventListener('message', event => {
	if (event.data.type === 'actionResult') {
		pendingActions.get(event.data.id)?.(event.data.result);
		pendingActions.delete(event.data.id);
		return;
	}
	if (event.data.type === 'sharedStateChanged') {
		const change = event.data.change;
		for (const listener of sharedStateListeners.get(change?.key) ?? []) {listener(change);}
		if (review?.sharedState?.key === change?.key && Array.isArray(change.value)) {
			review.sharedState.version = change.version;
			applyReviewedPaths(review, change.value);
			renderPullRequestReview(root, review, callHostAction);
		}
		return;
	}
	if (event.data.review) {
		renderReview(event.data.review);
		return;
	}
	if (event.data.draft) {
		renderDraft(event.data.draft);
		return;
	}
	renderMessage(event.data.error || 'Select a pull request to review.');
});

vscode.postMessage({ type: 'ready' });