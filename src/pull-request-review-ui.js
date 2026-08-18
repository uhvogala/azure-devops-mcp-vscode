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
	const branchName = element('span', 'branch-name');
	branchName.textContent = `${review.sourceRef.replace('refs/heads/', '')} -> ${review.targetRef.replace('refs/heads/', '')}`;
	const branchActions = element('div', 'branch-actions');
	const branchError = element('span', 'branch-error');
	for (const [label, branch] of [['Checkout source', review.sourceRef], ['Checkout target', review.targetRef]]) {
		const button = element('button', 'checkout-branch');
		button.type = 'button';
		button.textContent = label;
		button.addEventListener('click', async () => {
			button.disabled = true;
			button.textContent = 'Checking out...';
			branchError.textContent = '';
			const result = await run('checkout_pull_request_branch', { organization: review.organization, project: review.project, repository: review.repository, branch }, branchError);
			button.textContent = result?.structuredContent?.currentBranch === branch.replace('refs/heads/', '') ? 'Current branch' : label;
			button.disabled = false;
		});
		branchActions.append(button);
	}
	branches.append(branchName, branchActions, branchError);

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
	const filesHeader = element('div', 'files-header');
	const filesTitle = element('h2');
	filesTitle.textContent = 'Changed files';
	const filesCount = element('span');
	filesCount.textContent = review.changesTruncated ? `${review.changes.length}+ files` : `${review.changes.length} files`;
	filesHeader.append(filesTitle, filesCount);
	files.append(filesHeader);
	for (const change of review.changes) {
		const row = element('div', 'file');
		const control = element('label', 'review-control');
		const checkbox = element('input');
		checkbox.type = 'checkbox';
		checkbox.checked = change.reviewed === true;
		checkbox.setAttribute('aria-label', `Mark ${change.path} as reviewed`);
		control.append(checkbox, 'Reviewed');
		const details = element('div', 'file-details');
		const path = element('code');
		path.textContent = change.path;
		const kind = element('span');
		kind.textContent = changeLabel(change.changeType);
		const comments = element('button', 'comment-count');
		comments.type = 'button';
		comments.textContent = change.commentCount ? `${change.commentCount} comment${change.commentCount === 1 ? '' : 's'}` : '';
		const error = element('span', 'action-error');
		details.append(path, kind, comments, error);
		checkbox.addEventListener('change', async () => {
			checkbox.disabled = true;
			const result = await run('set_pull_request_file_reviewed', { organization: review.organization, project: review.project, repository: review.repository, pullRequestId: review.id, path: change.path, reviewed: checkbox.checked }, error);
			if (!result) {checkbox.checked = !checkbox.checked;}
			else {change.reviewed = checkbox.checked;}
			checkbox.disabled = false;
		});
		comments.addEventListener('click', () => run('open_pull_request_file_diff', change, error));
		const actions = element('div', 'file-actions');
		for (const [label, name, arguments_] of [['Open diff', 'open_pull_request_file_diff', change], ['Open file', 'open_pull_request_file', { organization: change.organization, project: change.project, repository: change.repository, path: change.path }]]) {
			const button = element('button', name === 'open_pull_request_file' ? 'open-file' : '');
			button.type = 'button';
			button.textContent = label;
			button.addEventListener('click', () => run(name, arguments_, error));
			actions.append(button);
		}
		row.append(control, details, actions);
		files.append(row);
	}
	root.append(header, branches, approvals, summary, files);
}