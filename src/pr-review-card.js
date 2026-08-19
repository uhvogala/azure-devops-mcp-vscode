import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import { setSharedState, subscribeToSharedState } from './mcp-app-shared-state';
import { renderPullRequestDraft } from './pull-request-draft-ui';
import { subscribeToPullRequestRefresh } from './pull-request-refresh';
import { applyReviewedPaths, renderPullRequestReview } from './pull-request-review-ui';

const app = new App({ name: 'Azure DevOps pull request review', version: '0.0.67' }, {});
const root = document.createElement('main');
root.className = 'review-card';
document.body.append(root);
let loadingOperations = 0;
let unsubscribeSharedState = () => undefined;
let unsubscribeReviewRefresh = () => undefined;
let unsubscribeRepositoryRefresh = () => undefined;

function element(name, className) {
	const node = document.createElement(name);
	if (className) {
		node.className = className;
	}
	return node;
}

function renderMessage(message) {
	const state = element('div', 'terminal-state');
	state.setAttribute('role', 'status');
	state.textContent = message;
	root.replaceChildren(state);
}

function updateLoadingState() {
	const isLoading = loadingOperations > 0;
	root.classList.toggle('is-loading', isLoading);
	root.setAttribute('aria-busy', String(isLoading));
	const spinner = root.querySelector('.loading-spinner');
	if (isLoading && !spinner) {
		const loadingSpinner = element('div', 'loading-spinner');
		loadingSpinner.setAttribute('role', 'status');
		loadingSpinner.setAttribute('aria-label', 'Loading pull request');
		root.append(loadingSpinner);
	}
	if (!isLoading) {
		spinner?.remove();
	}
}

function startLoading() {
	loadingOperations += 1;
	updateLoadingState();
}

function finishLoading() {
	loadingOperations = Math.max(0, loadingOperations - 1);
	updateLoadingState();
}

function applyHostContext(context) {
	if (context.theme) {
		applyDocumentTheme(context.theme);
	}
	if (context.styles?.variables) {
		applyHostStyleVariables(context.styles.variables);
	}
}

function resultError(result) {
	return result.content
		.map(item => item.type === 'text' ? item.text : '')
		.filter(Boolean)
		.join(' ')
		|| 'VS Code could not open this diff.';
}

function renderDraft(draft) {
	unsubscribeRepositoryRefresh();
	unsubscribeReviewRefresh();
	unsubscribeSharedState();
	unsubscribeSharedState = renderPullRequestDraft(root, draft, {
		callAction: request => app.callServerTool(request),
		subscribeSharedState: (sharedState, defaultValue, onChange) => subscribeToSharedState(app, sharedState, defaultValue, onChange),
		setSharedState: (sharedState, value) => setSharedState(app, sharedState, value),
		onSubmitted: review => {
			if (review?.id && Array.isArray(review.changes)) {
				renderReview(review);
			} else {
				unsubscribeSharedState();
				renderMessage('Pull request submitted.');
			}
		},
		onDeleted: () => {
			unsubscribeSharedState();
			renderMessage('Draft deleted.');
		},
	});
}

function renderReview(review) {
	unsubscribeRepositoryRefresh();
	unsubscribeReviewRefresh();
	unsubscribeSharedState();
	renderPullRequestReview(root, review, request => app.callServerTool({
		name: request.name,
		arguments: request.arguments,
	}));
	unsubscribeSharedState = subscribeToSharedState(app, review.sharedState, [], value => {
		applyReviewedPaths(review, value);
		renderReview(review);
	});
	const loadReview = async () => (await app.callServerTool({
			name: 'get_pull_request',
			arguments: {
				organization: review.organization,
				project: review.project,
				repository: review.repository,
				pullRequestId: review.id,
				includeChanges: true,
			},
		})).structuredContent;
	const refreshReview = async () => {
		const nextReview = await loadReview();
		if (nextReview?.id && Array.isArray(nextReview.changes)) {
			nextReview.currentBranch = review.currentBranch;
			renderReview(nextReview);
		}
	};
	unsubscribeReviewRefresh = subscribeToPullRequestRefresh(
		review,
		loadReview,
		renderReview,
	);
	unsubscribeRepositoryRefresh = subscribeToSharedState(app, review.repositoryState, {}, value => {
		if (value && typeof value === 'object' && typeof value.currentBranch === 'string') {
			review.currentBranch = value.currentBranch;
		}
		void refreshReview();
	});
}

app.ontoolresult = result => {
	const content = result.structuredContent;
	if (content?.mode === 'create') {
		finishLoading();
		renderDraft(content);
	} else if (content?.id && Array.isArray(content.changes)) {
		finishLoading();
		renderReview(content);
	}
};

app.onhostcontextchanged = applyHostContext;

startLoading();
void app.connect().then(() => applyHostContext(app.getHostContext()));