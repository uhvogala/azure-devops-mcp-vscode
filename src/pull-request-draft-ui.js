import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { changeLabel } from './pull-request-review-ui';

function element(name, className) {
	const node = document.createElement(name);
	if (className) {node.className = className;}
	return node;
}

function actionError(result, fallback) {
	if (result?.isError) {
		return result.content?.filter(item => item.type === 'text').map(item => item.text).join(' ') || fallback;
	}
	return undefined;
}

export function renderPullRequestDraft(root, draft, { callAction, subscribeSharedState, setSharedState, onSubmitted, onDeleted }) {
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
	const branchName = element('span', 'branch-name');
	branchName.textContent = `${draft.sourceRefName.replace('refs/heads/', '')} -> ${draft.targetRefName.replace('refs/heads/', '')}`;
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
	const stateError = element('span', 'submit-error');
	const renderPreview = () => {
		descriptionPreview.innerHTML = DOMPurify.sanitize(marked.parse(descriptionInput.value || 'No description provided.'));
	};
	let submitting = false;
	let descriptionTimer;
	let descriptionUpdate = Promise.resolve();
	const publishDescription = () => {
		const description = descriptionInput.value;
		draft.description = description;
		descriptionUpdate = descriptionUpdate
			.catch(() => undefined)
			.then(() => setSharedState(draft.sharedState, { description }));
		return descriptionUpdate;
	};
	previewToggle.addEventListener('change', () => {
		const previewing = previewToggle.checked;
		descriptionInput.hidden = previewing;
		descriptionPreview.hidden = !previewing;
		if (previewing) {renderPreview();}
	});
	descriptionInput.addEventListener('input', () => {
		clearTimeout(descriptionTimer);
		descriptionTimer = setTimeout(() => {
			void publishDescription().catch(() => {
				stateError.textContent = 'VS Code could not sync this draft.';
			});
		}, 150);
	});
	const unsubscribe = subscribeSharedState(draft.sharedState, { description: draft.description }, value => {
		if (value && typeof value === 'object' && value.deleted === true) {
			if (!submitting) {onDeleted?.();}
			return;
		}
		if (!value || typeof value !== 'object' || typeof value.description !== 'string') {return;}
		draft.description = value.description;
		if (descriptionInput.value !== value.description) {
			descriptionInput.value = value.description;
			if (previewToggle.checked) {renderPreview();}
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

	const details = element('div', 'draft-details');
	const reviewerSummary = element('span');
	const reviewerCount = draft.reviewerIds?.length ?? 0;
	reviewerSummary.textContent = reviewerCount === 0 ? 'No reviewers suggested' : `${reviewerCount} reviewer${reviewerCount === 1 ? '' : 's'} suggested`;
	const submitButton = element('button', 'submit-pull-request');
	submitButton.type = 'button';
	submitButton.textContent = 'Submit PR';
	const submitError = element('span', 'submit-error');
	const deleteButton = element('button', 'delete-pull-request-draft');
	deleteButton.type = 'button';
	deleteButton.textContent = 'Delete Draft';
	const deleteError = element('span', 'submit-error');
	deleteButton.addEventListener('click', async () => {
		deleteButton.disabled = true;
		deleteButton.textContent = 'Deleting...';
		deleteError.textContent = '';
		try {
			const result = await callAction({ name: 'delete_pull_request_draft', arguments: { key: draft.key } });
			const error = actionError(result, 'VS Code could not delete this draft.');
			if (error) {throw new Error(error);}
			onDeleted?.();
		} catch (error) {
			deleteButton.textContent = 'Retry delete';
			deleteButton.disabled = false;
			deleteError.textContent = error instanceof Error ? error.message : 'VS Code could not delete this draft.';
		}
	});
	submitButton.addEventListener('click', async () => {
		submitting = true;
		submitButton.disabled = true;
		submitButton.textContent = 'Submitting...';
	submitError.textContent = '';
	stateError.textContent = '';
		try {
			clearTimeout(descriptionTimer);
			await publishDescription();
			const result = await callAction({
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
			const error = actionError(result, 'VS Code could not create this pull request.');
			if (error) {throw new Error(error);}
			onSubmitted?.(result.structuredContent);
		} catch (error) {
			submitting = false;
			submitButton.textContent = 'Retry submit';
			submitButton.disabled = false;
			submitError.textContent = error instanceof Error ? error.message : 'VS Code could not create this pull request.';
		}
	});
	details.append(reviewerSummary, submitButton, deleteButton, submitError, deleteError, stateError);
	root.append(header, branches, description, files, details);

	return () => {
		clearTimeout(descriptionTimer);
		unsubscribe();
	};
}
