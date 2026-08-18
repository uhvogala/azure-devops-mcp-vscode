import DOMPurify from 'dompurify';
import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import { marked } from 'marked';
import { setSharedState, subscribeToSharedState } from './mcp-app-shared-state';
import { applyReviewedPaths, changeLabel, renderPullRequestReview } from './pull-request-review-ui';

const app = new App({ name: 'Azure DevOps pull request review', version: '0.0.49' }, {});
const root = document.createElement('main');
root.className = 'review-card';
document.body.append(root);
let loadingOperations = 0;
let unsubscribeSharedState = () => undefined;
let draftDescriptionTimer;
let draftDescriptionUpdate = Promise.resolve();

function element(name, className) {
	const node = document.createElement(name);
	if (className) {
		node.className = className;
	}
	return node;
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

function renderPullRequestDraft(draft) {
	unsubscribeSharedState();
	clearTimeout(draftDescriptionTimer);
	root.replaceChildren();

	const header = element('header', 'header');
	const identity = element('div');
	const number = element('div', 'number');
	number.textContent = 'New pull request';
	const title = element('h1');
	title.textContent = draft.title;
	identity.append(number, title);
	const status = element('span', 'status draft-status');
	status.textContent = 'Draft';
	header.append(identity, status);

	const branches = element('div', 'branches');
	const sourceBranch = draft.sourceRefName.replace('refs/heads/', '');
	const targetBranch = draft.targetRefName.replace('refs/heads/', '');
	const branchName = element('span', 'branch-name');
	branchName.textContent = `${sourceBranch} -> ${targetBranch}`;
	branches.append(branchName);

	const description = element('section', 'draft-description');
	const descriptionHeader = element('div', 'draft-description-header');
	const descriptionTitle = element('h2', 'section-title');
	descriptionTitle.textContent = 'Description';
	const previewControl = element('label', 'preview-control');
	const previewToggle = element('input');
	previewToggle.type = 'checkbox';
	previewToggle.setAttribute('role', 'switch');
	previewToggle.setAttribute('aria-label', 'Show Markdown preview');
	const previewLabel = element('span');
	previewLabel.textContent = 'Markdown preview';
	previewControl.append(previewToggle, previewLabel);
	descriptionHeader.append(descriptionTitle, previewControl);
	const descriptionInput = element('textarea', 'description-input');
	descriptionInput.value = draft.description;
	descriptionInput.rows = 10;
	descriptionInput.setAttribute('aria-label', 'Pull request description');
	const descriptionPreview = element('div', 'markdown description-preview');
	descriptionPreview.hidden = true;
	const renderPreview = () => {
		descriptionPreview.innerHTML = DOMPurify.sanitize(marked.parse(descriptionInput.value || 'No description provided.'));
	};
	const publishDescription = () => {
		const description = descriptionInput.value;
		draft.description = description;
		draftDescriptionUpdate = draftDescriptionUpdate
			.catch(() => undefined)
			.then(() => setSharedState(app, draft.sharedState, { description }));
		return draftDescriptionUpdate;
	};
	previewToggle.addEventListener('change', () => {
		const previewing = previewToggle.checked;
		descriptionInput.hidden = previewing;
		descriptionPreview.hidden = !previewing;
		if (previewing) {
			renderPreview();
		}
	});
	descriptionInput.addEventListener('input', () => {
		clearTimeout(draftDescriptionTimer);
		draftDescriptionTimer = setTimeout(() => {
			void publishDescription().catch(() => {
				draftStateError.textContent = 'VS Code could not sync this draft.';
			});
		}, 150);
	});
	unsubscribeSharedState = subscribeToSharedState(app, draft.sharedState, { description: draft.description }, value => {
		if (!value || typeof value !== 'object' || typeof value.description !== 'string') {
			return;
		}
		draft.description = value.description;
		if (descriptionInput.value !== value.description) {
			descriptionInput.value = value.description;
			if (previewToggle.checked) {
				renderPreview();
			}
		}
	});
	description.append(descriptionHeader, descriptionInput, descriptionPreview);

	const files = element('section', 'draft-files');
	const filesHeader = element('div', 'files-header');
	const filesTitle = element('h2');
	filesTitle.textContent = 'Changed files';
	const filesCount = element('span');
	const changes = draft.changes ?? [];
	filesCount.textContent = draft.changesTruncated ? `${changes.length}+ files` : `${changes.length} files`;
	filesHeader.append(filesTitle, filesCount);
	files.append(filesHeader);
	if (changes.length === 0) {
		const noChanges = element('div', 'draft-file-empty');
		noChanges.textContent = draft.changesError || 'No changed files between these branches.';
		files.append(noChanges);
	} else {
		for (const change of changes) {
			const file = element('div', 'draft-file');
			const path = element('code');
			path.textContent = change.path;
			const kind = element('span');
			kind.textContent = changeLabel(change.changeType);
			file.append(path, kind);
			files.append(file);
		}
	}

	const draftDetails = element('div', 'draft-details');
	const reviewerSummary = element('span');
	const reviewerCount = draft.reviewerIds?.length ?? 0;
	reviewerSummary.textContent = reviewerCount === 0
		? 'No reviewers suggested'
		: `${reviewerCount} reviewer${reviewerCount === 1 ? '' : 's'} suggested`;
	const submitButton = element('button', 'submit-pull-request');
	submitButton.type = 'button';
	submitButton.textContent = 'Submit PR';
	const submitError = element('span', 'submit-error');
	const draftStateError = element('span', 'submit-error');
	submitButton.addEventListener('click', async () => {
		submitButton.disabled = true;
		submitButton.textContent = 'Submitting...';
		submitError.textContent = '';
		draftStateError.textContent = '';
		startLoading();
		try {
			clearTimeout(draftDescriptionTimer);
			await publishDescription();
			const result = await app.callServerTool({
				name: 'submit_pull_request',
				arguments: {
					organization: draft.organization,
					project: draft.project,
					repository: draft.repository,
					sourceRef: draft.sourceRefName,
					targetRef: draft.targetRefName,
					title: draft.title,
					description: descriptionInput.value,
					reviewerIds: draft.reviewerIds ?? [],
					confirm: true,
				},
			});
			if (result.isError) {
				throw new Error(resultError(result));
			}
			const review = result.structuredContent;
			if (review?.id && Array.isArray(review.changes)) {
				renderReview(review);
			}
		} catch (error) {
			submitButton.textContent = 'Retry submit';
			submitButton.disabled = false;
			submitError.textContent = error instanceof Error ? error.message : 'VS Code could not create this pull request.';
		} finally {
			finishLoading();
		}
	});
	draftDetails.append(reviewerSummary, submitButton, submitError, draftStateError);

	root.append(header, branches, description, files, draftDetails);
}

function renderReview(review) {
	unsubscribeSharedState();
	clearTimeout(draftDescriptionTimer);
	renderPullRequestReview(root, review, request => app.callServerTool({
		name: request.name,
		arguments: request.arguments,
	}));
	unsubscribeSharedState = subscribeToSharedState(app, review.sharedState, [], value => {
		applyReviewedPaths(review, value);
		renderReview(review);
	});
}

app.ontoolresult = result => {
	const content = result.structuredContent;
	if (content?.mode === 'create') {
		finishLoading();
		renderPullRequestDraft(content);
	} else if (content?.id && Array.isArray(content.changes)) {
		finishLoading();
		renderReview(content);
	}
};

app.onhostcontextchanged = applyHostContext;

startLoading();
void app.connect().then(() => applyHostContext(app.getHostContext()));