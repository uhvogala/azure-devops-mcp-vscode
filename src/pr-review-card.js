import DOMPurify from 'dompurify';
import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import { marked } from 'marked';
import { renderPullRequestReview } from './pull-request-review-ui';

const app = new App({ name: 'Azure DevOps pull request review', version: '0.0.44' }, {});
const root = document.createElement('main');
root.className = 'review-card';
document.body.append(root);
let loadingOperations = 0;

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

function changeLabel(changeType) {
	if ((changeType & 1) !== 0) {
		return 'Added';
	}
	if ((changeType & 16) !== 0) {
		return 'Deleted';
	}
	if ((changeType & 8) !== 0) {
		return 'Renamed';
	}
	return 'Modified';
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

function reviewerVoteLabel(reviewer) {
	if (reviewer.hasDeclined) {
		return 'Declined';
	}
	if (reviewer.vote === 10) {
		return 'Approved';
	}
	if (reviewer.vote === 5) {
		return 'Approved with suggestions';
	}
	if (reviewer.vote === -10) {
		return 'Rejected';
	}
	if (reviewer.vote === -5) {
		return 'Waiting for author';
	}
	return 'No response';
}

function renderPullRequestDraft(draft) {
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
	previewToggle.addEventListener('change', () => {
		const previewing = previewToggle.checked;
		descriptionInput.hidden = previewing;
		descriptionPreview.hidden = !previewing;
		if (previewing) {
			renderPreview();
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
	submitButton.addEventListener('click', async () => {
		submitButton.disabled = true;
		submitButton.textContent = 'Submitting...';
		submitError.textContent = '';
		startLoading();
		try {
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
	draftDetails.append(reviewerSummary, submitButton, submitError);

	root.append(header, branches, description, files, draftDetails);
}

function renderReviewLegacy(review) {
	root.replaceChildren();

	const header = element('header', 'header');
	const identity = element('div');
	const number = element('div', 'number');
	number.textContent = `PR ${review.id}`;
	const title = element('h1');
	title.textContent = review.title;
	identity.append(number, title);
	const status = element('span', 'status');
	status.textContent = review.status === 1 ? 'Active' : 'Closed';
	header.append(identity, status);

	const branches = element('div', 'branches');
	const sourceBranch = review.sourceRef.replace('refs/heads/', '');
	const targetBranch = review.targetRef.replace('refs/heads/', '');
	const branchName = element('span', 'branch-name');
	branchName.textContent = `${sourceBranch} -> ${targetBranch}`;
	const branchActions = element('div', 'branch-actions');
	const branchError = element('span', 'branch-error');
	const checkoutButtons = new Map();
	for (const [label, branch] of [['Checkout source', review.sourceRef], ['Checkout target', review.targetRef]]) {
		const button = element('button', 'checkout-branch');
		button.type = 'button';
		button.textContent = label;
		button.addEventListener('click', async () => {
			button.disabled = true;
			button.textContent = 'Checking out...';
			branchError.textContent = '';
			startLoading();
			try {
				const result = await app.callServerTool({
					name: 'checkout_pull_request_branch',
					arguments: {
						organization: review.organization,
						project: review.project,
						repository: review.repository,
						branch,
					},
				});
				if (result.isError) {
					throw new Error(resultError(result));
				}
				const currentBranch = result.structuredContent?.currentBranch;
				for (const [branchRef, checkoutButton] of checkoutButtons) {
					checkoutButton.textContent = branchRef.replace('refs/heads/', '') === currentBranch ? 'Current branch' : labelForBranch(branchRef, review);
					checkoutButton.classList.toggle('current-branch', branchRef.replace('refs/heads/', '') === currentBranch);
				}
			} catch (error) {
				button.textContent = 'Retry checkout';
				branchError.textContent = error instanceof Error ? error.message : 'VS Code could not check out this branch.';
			} finally {
				button.disabled = false;
				finishLoading();
			}
		});
		checkoutButtons.set(branch, button);
		branchActions.append(button);
	}
	branches.append(branchName, branchActions, branchError);

	const approvals = element('section', 'approvals');
	const approvalsHeader = element('div', 'approvals-header');
	const approvalsTitle = element('h2', 'section-title');
	approvalsTitle.textContent = 'Approvals';
	const reviewers = review.reviewers ?? [];
	const approvedCount = reviewers.filter(reviewer => reviewer.vote === 10).length;
	const approvalsCount = element('span', 'approvals-count');
	approvalsCount.textContent = `${approvedCount} of ${reviewers.length} approved`;
	approvalsHeader.append(approvalsTitle, approvalsCount);
	const approvalList = element('div', 'approval-list');
	if (reviewers.length === 0) {
		const noReviewers = element('span', 'no-reviewers');
		noReviewers.textContent = 'No reviewers assigned';
		approvalList.append(noReviewers);
	} else {
		for (const reviewer of reviewers) {
			const reviewerRow = element('div', 'reviewer');
			const reviewerName = element('span', 'reviewer-name');
			reviewerName.textContent = reviewer.displayName || 'Azure DevOps user';
			const reviewerVote = element('span', 'reviewer-vote');
			reviewerVote.textContent = reviewerVoteLabel(reviewer);
			reviewerRow.append(reviewerName, reviewerVote);
			approvalList.append(reviewerRow);
		}
	}
	const approvalActions = element('div', 'approval-actions');
	const approveButton = element('button', 'approve-pull-request');
	approveButton.type = 'button';
	const currentReviewer = reviewers.find(reviewer => reviewer.id === review.currentUserId);
	const alreadyApproved = currentReviewer?.vote === 10;
	approveButton.textContent = alreadyApproved ? 'Approved' : 'Approve PR';
	approveButton.disabled = alreadyApproved || review.status !== 1;
	const approvalError = element('span', 'approval-error');
	approveButton.addEventListener('click', async () => {
		approveButton.disabled = true;
		approveButton.textContent = 'Approving...';
		approvalError.textContent = '';
		startLoading();
		try {
			const result = await app.callServerTool({
				name: 'approve_pull_request',
				arguments: {
					organization: review.organization,
					project: review.project,
					repository: review.repository,
					pullRequestId: review.id,
				},
			});
			if (result.isError) {
				throw new Error(resultError(result));
			}
			review.reviewers = result.structuredContent?.reviewers ?? review.reviewers;
			review.currentUserId = result.structuredContent?.reviewer?.id ?? review.currentUserId;
			renderReview(review);
		} catch (error) {
			approveButton.textContent = 'Retry approval';
			approvalError.textContent = error instanceof Error ? error.message : 'VS Code could not approve this pull request.';
			approveButton.disabled = false;
		} finally {
			finishLoading();
		}
	});
	approvalActions.append(approveButton, approvalError);
	approvals.append(approvalsHeader, approvalList, approvalActions);

	const summary = element('section', 'summary');
	const summaryTitle = element('h2', 'section-title');
	summaryTitle.textContent = 'Description';
	const summaryText = element('div', 'markdown');
	summaryText.innerHTML = DOMPurify.sanitize(marked.parse(review.description || 'No description provided.'));
	summary.append(summaryTitle, summaryText);

	const files = element('section', 'files');
	const filesHeader = element('div', 'files-header');
	const filesTitle = element('h2');
	filesTitle.textContent = 'Changed files';
	const filesCount = element('span');
	filesCount.textContent = review.changesTruncated ? `${review.changes.length}+ files` : `${review.changes.length} files`;
	filesHeader.append(filesTitle, filesCount);
	files.append(filesHeader);

	for (const change of review.changes) {
		const row = element('div', 'file');
		row.classList.toggle('reviewed', change.reviewed === true);
		const reviewControl = element('label', 'review-control');
		const checkbox = element('input');
		checkbox.type = 'checkbox';
		checkbox.checked = change.reviewed === true;
		checkbox.setAttribute('aria-label', `Mark ${change.path} as reviewed`);
		const reviewLabel = element('span');
		reviewLabel.textContent = 'Reviewed';
		reviewControl.append(checkbox, reviewLabel);
		const details = element('div', 'file-details');
		const path = element('code');
		path.textContent = change.path;
		const kind = element('span');
		kind.textContent = changeLabel(change.changeType);
		const commentCount = element('button', 'comment-count');
		commentCount.type = 'button';
		if (change.commentCount > 0) {
			commentCount.textContent = `${change.commentCount} comment${change.commentCount === 1 ? '' : 's'}`;
			commentCount.setAttribute('aria-label', `Open ${change.commentCount} comment${change.commentCount === 1 ? '' : 's'} for ${change.path}`);
		}
		const actionError = element('span', 'action-error');
		details.append(path, kind, commentCount, actionError);
		checkbox.addEventListener('change', async () => {
			checkbox.disabled = true;
			actionError.textContent = '';
			startLoading();
			try {
				const result = await app.callServerTool({
					name: 'set_pull_request_file_reviewed',
					arguments: {
						organization: review.organization,
						project: review.project,
						repository: review.repository,
						pullRequestId: review.id,
						path: change.path,
						reviewed: checkbox.checked,
					},
				});
				if (result.isError) {
					throw new Error(resultError(result));
				}
				change.reviewed = checkbox.checked;
				row.classList.toggle('reviewed', checkbox.checked);
			} catch (error) {
				checkbox.checked = !checkbox.checked;
				actionError.textContent = error instanceof Error ? error.message : 'VS Code could not update review status.';
			} finally {
				checkbox.disabled = false;
				finishLoading();
			}
		});
		const button = element('button');
		const actions = element('div', 'file-actions');
		button.type = 'button';
		button.textContent = 'Open diff';
		button.addEventListener('click', async () => {
			button.disabled = true;
			button.textContent = 'Opening...';
			actionError.textContent = '';
			startLoading();
			try {
				const result = await app.callServerTool({
					name: 'open_pull_request_file_diff',
					arguments: { ...change },
				});
				if (result.isError) {
					throw new Error(resultError(result));
				}
				button.textContent = 'Opened';
			} catch (error) {
				button.textContent = 'Retry diff';
				actionError.textContent = error instanceof Error ? error.message : 'VS Code could not open this diff.';
			} finally {
				button.disabled = false;
				finishLoading();
			}
		});
		if (change.commentCount > 0) {
			commentCount.addEventListener('click', async () => {
				commentCount.disabled = true;
				actionError.textContent = '';
				startLoading();
				try {
					const result = await app.callServerTool({
						name: 'open_pull_request_file_diff',
						arguments: { ...change },
					});
					if (result.isError) {
						throw new Error(resultError(result));
					}
				} catch (error) {
					actionError.textContent = error instanceof Error ? error.message : 'VS Code could not open these comments.';
				} finally {
					commentCount.disabled = false;
					finishLoading();
				}
			});
		}
		const openFileButton = element('button', 'open-file');
		openFileButton.type = 'button';
		openFileButton.textContent = 'Open file';
		openFileButton.addEventListener('click', async () => {
			openFileButton.disabled = true;
			openFileButton.textContent = 'Opening...';
			actionError.textContent = '';
			startLoading();
			try {
				const result = await app.callServerTool({
					name: 'open_pull_request_file',
					arguments: {
						organization: change.organization,
						project: change.project,
						repository: change.repository,
						path: change.path,
					},
				});
				if (result.isError) {
					throw new Error(resultError(result));
				}
				openFileButton.textContent = 'Opened';
			} catch (error) {
				openFileButton.textContent = 'Retry file';
				actionError.textContent = error instanceof Error ? error.message : 'VS Code could not open this file.';
			} finally {
				openFileButton.disabled = false;
				finishLoading();
			}
		});
		actions.append(button, openFileButton);
		row.append(reviewControl, details, actions);
		files.append(row);
	}

	root.append(header, branches, approvals, summary, files);
}

function labelForBranch(branch, review) {
	return branch === review.sourceRef ? 'Checkout source' : 'Checkout target';
}

function renderReview(review) {
	renderPullRequestReview(root, review, request => app.callServerTool({
		name: request.name,
		arguments: request.arguments,
	}));
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