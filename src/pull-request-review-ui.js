import DOMPurify from 'dompurify';
import { marked } from 'marked';

function element(name, className) {
	const node = document.createElement(name);
	if (className) {node.className = className;}
	return node;
}

export function changeLabel(changeType) {
	if ((changeType & 1) !== 0) {return 'Added';}
	if ((changeType & 16) !== 0) {return 'Deleted';}
	if ((changeType & 8) !== 0) {return 'Renamed';}
	return 'Modified';
}

function changeClass(changeType) {
	if ((changeType & 1) !== 0) {return 'change-added';}
	if ((changeType & 16) !== 0) {return 'change-deleted';}
	if ((changeType & 8) !== 0) {return 'change-renamed';}
	return 'change-modified';
}

function normalizedBranchName(branch) {
	return branch?.trim()
		.replace(/^refs\/heads\//, '')
		.replace(/^refs\/remotes\/origin\//, '')
		.replace(/^origin\//, '');
}

function reviewAsset(name) {
	return globalThis.__azureDevOpsMcpReviewAssets?.[name] ?? '';
}

export function applyReviewedPaths(review, value) {
	if (!Array.isArray(value)) {
		return;
	}
	const reviewedPaths = new Set(value.filter(path => typeof path === 'string'));
	for (const change of review.changes) {
		change.reviewed = reviewedPaths.has(change.path);
	}
}

function voteLabel(reviewer) {
	if (reviewer.hasDeclined) {return 'Declined';}
	if (reviewer.vote === 10) {return 'Approved';}
	if (reviewer.vote === 5) {return 'Approved with suggestions';}
	if (reviewer.vote === -10) {return 'Rejected';}
	if (reviewer.vote === -5) {return 'Waiting for author';}
	return 'No response';
}

function actionError(result, fallback) {
	if (result?.isError) {
		return result.content?.filter(item => item.type === 'text').map(item => item.text).join(' ') || fallback;
	}
	return undefined;
}

export function renderPullRequestReview(root, review, callAction) {
	root.replaceChildren();
	const run = async (name, arguments_, errorTarget) => {
		root.classList.add('is-loading');
		root.setAttribute('aria-busy', 'true');
		try {
			const result = await callAction({ name, arguments: arguments_ });
			const error = actionError(result, `Unable to ${name.replaceAll('_', ' ')}.`);
			if (error) {throw new Error(error);}
			return result;
		} catch (error) {
			if (errorTarget) {errorTarget.textContent = error instanceof Error ? error.message : 'Action failed.';}
			return undefined;
		} finally {
			root.classList.remove('is-loading');
			root.setAttribute('aria-busy', 'false');
		}
	};

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
	const branchFlow = element('div', 'branch-flow');
	const branchError = element('span', 'branch-error');
	const checkoutBranch = async (button, branch, resetText) => {
		button.disabled = true;
		button.classList.add('is-checking-out');
		branchError.textContent = '';
		const result = await run('checkout_pull_request_branch', { organization: review.organization, project: review.project, repository: review.repository, branch }, branchError);
		if (result?.structuredContent?.currentBranch) {
			review.currentBranch = result.structuredContent.currentBranch;
			renderPullRequestReview(root, review, callAction);
			return;
		}
		button.disabled = false;
		button.classList.remove('is-checking-out');
		button.textContent = resetText;
	};
	for (const [branch, label] of [[review.sourceRef, 'source'], [review.targetRef, 'target']]) {
		const branchName = normalizedBranchName(branch);
		const isCurrent = normalizedBranchName(review.currentBranch) === branchName;
		const branchControl = element('span', 'branch-control');
		const branchItem = element(isCurrent ? 'span' : 'button', `branch-link${isCurrent ? ' is-current' : ''}`);
		branchItem.textContent = branchName;
		branchItem.title = isCurrent ? 'Current branch' : `Check out ${branchName}`;
		if (!isCurrent) {
			branchItem.type = 'button';
			branchItem.setAttribute('aria-label', `Check out ${label} branch ${branchName}`);
			branchItem.addEventListener('click', () => checkoutBranch(branchItem, branch, branchName));
		}
		branchControl.append(branchItem);
		if (isCurrent) {
			const currentMark = element('span', 'current-branch-mark');
			currentMark.textContent = '\u2713';
			currentMark.title = 'Current branch';
			branchControl.append(currentMark);
		}
		branchFlow.append(branchControl);
		if (branch === review.sourceRef) {
			const separator = element('span', 'branch-separator');
			separator.textContent = '\u2192';
			branchFlow.append(separator);
		}
	}
	branches.append(branchFlow, branchError);

	const approvals = element('section', 'approvals');
	const approvalsHeader = element('div', 'approvals-header');
	const approvalsTitle = element('h2', 'section-title');
	approvalsTitle.textContent = 'Approvals';
	const reviewers = review.reviewers ?? [];
	const approvalsCount = element('span', 'approvals-count');
	approvalsCount.textContent = `${reviewers.filter(reviewer => reviewer.vote === 10).length} of ${reviewers.length} approved`;
	approvalsHeader.append(approvalsTitle, approvalsCount);
	const approvalList = element('div', 'approval-list');
	for (const reviewer of reviewers) {
		const row = element('div', 'reviewer');
		const name = element('span', 'reviewer-name');
		name.textContent = reviewer.displayName || 'Azure DevOps user';
		const vote = element('span', 'reviewer-vote');
		vote.textContent = voteLabel(reviewer);
		row.append(name, vote);
		approvalList.append(row);
	}
	if (!reviewers.length) {approvalList.textContent = 'No reviewers assigned';}
	const approvalActions = element('div', 'approval-actions');
	const approveButton = element('button', 'approve-pull-request');
	approveButton.type = 'button';
	const approved = reviewers.some(reviewer => reviewer.id === review.currentUserId && reviewer.vote === 10);
	approveButton.textContent = approved ? 'Approved' : 'Approve PR';
	approveButton.disabled = approved || review.status !== 1;
	const approvalError = element('span', 'approval-error');
	approveButton.addEventListener('click', async () => {
		approveButton.disabled = true;
		approveButton.textContent = 'Approving...';
		const result = await run('approve_pull_request', { organization: review.organization, project: review.project, repository: review.repository, pullRequestId: review.id }, approvalError);
		if (result?.structuredContent?.reviewers) {
			review.reviewers = result.structuredContent.reviewers;
			review.currentUserId = result.structuredContent.reviewer?.id ?? review.currentUserId;
			renderPullRequestReview(root, review, callAction);
			return;
		}
		approveButton.disabled = false;
		approveButton.textContent = 'Retry approval';
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
	const filesSectionHeader = element('div', 'section-heading');
	const filesSectionTitle = element('h2', 'section-title');
	filesSectionTitle.textContent = 'Changed files';
	filesSectionHeader.append(filesSectionTitle);
	const fileList = element('div', 'file-list');
	const filesHeader = element('div', 'files-header');
	const filesTitle = element('h2');
	filesTitle.textContent = 'Changed files';
	const filesCount = element('span');
	const reviewedCount = review.changes.filter(change => change.reviewed).length;
	const fileCount = review.changesTruncated ? `${review.changes.length}+` : review.changes.length;
	filesCount.textContent = `${fileCount} files \u00b7 ${reviewedCount} reviewed`;
	filesHeader.append(filesTitle, filesCount);
	fileList.append(filesHeader);
	for (const change of review.changes) {
		const row = element('div', 'file');
		const control = element('label', 'review-control');
		const checkbox = element('input');
		checkbox.type = 'checkbox';
		checkbox.checked = change.reviewed === true;
		checkbox.setAttribute('aria-label', `Mark ${change.path} as reviewed`);
		control.title = `Mark ${change.path} as reviewed`;
		const reviewIcon = element('img', 'review-icon');
		reviewIcon.src = reviewAsset(change.reviewed ? 'reviewed' : 'notReviewed');
		reviewIcon.alt = '';
		control.append(checkbox, reviewIcon);
		const details = element('div', 'file-details');
		const path = element('code');
		path.textContent = change.path;
		path.title = change.path;
		const metadata = element('div', 'file-metadata');
		const kind = element('span', `change-kind ${changeClass(change.changeType)}`);
		kind.textContent = changeLabel(change.changeType);
		metadata.append(kind);
		if (change.commentCount) {
			const comments = element('button', 'comment-count');
			comments.type = 'button';
			comments.textContent = `${change.commentCount} comment${change.commentCount === 1 ? '' : 's'}`;
			comments.addEventListener('click', () => run('open_pull_request_file_diff', change, error));
			metadata.append(comments);
		}
		const error = element('span', 'action-error');
		details.append(path, metadata, error);
		checkbox.addEventListener('change', async () => {
			checkbox.disabled = true;
			const result = await run('set_pull_request_file_reviewed', { organization: review.organization, project: review.project, repository: review.repository, pullRequestId: review.id, path: change.path, reviewed: checkbox.checked }, error);
			if (!result) {checkbox.checked = !checkbox.checked;}
			else {change.reviewed = checkbox.checked;}
			reviewIcon.src = reviewAsset(checkbox.checked ? 'reviewed' : 'notReviewed');
			checkbox.disabled = false;
		});
		const actions = element('div', 'file-actions');
		for (const [label, icon, name, arguments_] of [['Open diff', 'openDiff', 'open_pull_request_file_diff', change], ['Open file', 'openFile', 'open_pull_request_file', { organization: change.organization, project: change.project, repository: change.repository, path: change.path }]]) {
			const button = element('button', `file-action${name === 'open_pull_request_file' ? ' open-file' : ''}`);
			button.type = 'button';
			button.title = label;
			button.setAttribute('aria-label', label);
			const actionIcon = element('img', 'file-action-icon');
			actionIcon.src = reviewAsset(icon);
			actionIcon.alt = '';
			button.append(actionIcon);
			button.addEventListener('click', () => run(name, arguments_, error));
			actions.append(button);
		}
		row.append(control, details, actions);
		fileList.append(row);
	}
	files.append(filesSectionHeader, fileList);
	root.append(header, branches, approvals, summary, files);
}