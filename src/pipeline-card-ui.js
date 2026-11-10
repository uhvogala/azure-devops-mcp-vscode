import { createElement, ArrowLeft, ChevronLeft, ChevronRight, Copy, ExternalLink, FileText, RefreshCw } from 'lucide';
import stripAnsi from 'strip-ansi';

function element(tag, className, text) {
	const node = document.createElement(tag);
	if (className) { node.className = className; }
	if (text !== undefined) { node.textContent = text; }
	return node;
}

function iconButton(icon, label, onClick) {
	const button = element('button', 'file-action pipeline-icon-button');
	button.type = 'button';
	button.title = label;
	button.setAttribute('aria-label', label);
	button.append(createElement(icon, { width: 16, height: 16, 'aria-hidden': 'true' }));
	button.addEventListener('click', onClick);
	return button;
}

function stateLabel(value, labels) {
	return typeof value === 'number' ? labels[value] ?? 'Unknown' : value ?? '';
}

function statusClass(value) {
	const normalized = String(value).toLowerCase();
	if (/failed|abandoned/.test(normalized)) { return 'pipeline-failed'; }
	if (/issues|warning/.test(normalized)) { return 'pipeline-warning'; }
	if (/succeeded/.test(normalized)) { return 'pipeline-passed'; }
	if (/progress|running|cancelling/.test(normalized)) { return 'pipeline-running'; }
	return 'pipeline-muted';
}

function readableState(value) {
	return String(value || 'Unknown').replace(/([a-z])([A-Z])/g, '$1 $2');
}

function duration(start, finish) {
	if (!start) { return undefined; }
	const milliseconds = (finish ? new Date(finish).getTime() : Date.now()) - new Date(start).getTime();
	if (!Number.isFinite(milliseconds) || milliseconds < 0) { return undefined; }
	const seconds = Math.floor(milliseconds / 1000);
	return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}

function orderedRecords(records) {
	const selected = records.filter(record => /^(stage|job|task)$/i.test(record.type));
	const ids = new Set(selected.map(record => record.id));
	const children = new Map();
	for (const record of selected) {
		const parent = ids.has(record.parentId) ? record.parentId : undefined;
		if (!children.has(parent)) { children.set(parent, []); }
		children.get(parent).push(record);
	}
	const result = [];
	const visited = new Set();
	function visit(record, depth) {
		if (visited.has(record.id)) { return; }
		visited.add(record.id);
		result.push({ record, depth: Math.min(depth, 3) });
		for (const child of (children.get(record.id) ?? []).sort((left, right) => (left.order ?? 0) - (right.order ?? 0))) { visit(child, depth + 1); }
	}
	for (const record of children.get(undefined) ?? []) { visit(record, 0); }
	for (const record of selected) { visit(record, 0); }
	return result;
}

export function renderPipelineCard(root, content, actions) {
	root.className = 'review-card pipeline-card';
	root.replaceChildren();
	const isLog = content.view === 'log';
	const runId = content.runId ?? content.id;
	const identity = { organization: content.organization, project: content.project, runId };
	const error = element('div', 'action-error pipeline-error');
	error.setAttribute('role', 'alert');
	const runUrl = `https://dev.azure.com/${encodeURIComponent(content.organization)}/${encodeURIComponent(content.project)}/_build/results?buildId=${encodeURIComponent(runId)}`;
	let pending = false;

	async function request(name, arguments_, view, extra = {}) {
		if (pending) { return; }
		pending = true;
		error.textContent = '';
		root.setAttribute('aria-busy', 'true');
		const buttons = [...root.querySelectorAll('button')].map(button => ({ button, disabled: button.disabled }));
		for (const { button } of buttons) { button.disabled = true; }
		try {
			const result = await actions.callTool({ name, arguments: arguments_ });
			if (result.isError || !result.structuredContent) {
				throw new Error(result.content?.filter(item => item.type === 'text').map(item => item.text).join(' ') || 'Unable to load pipeline data.');
			}
			renderPipelineCard(root, { ...result.structuredContent, ...identity, view, ...extra }, actions);
		} catch (failure) {
			error.textContent = failure instanceof Error ? failure.message : 'Unable to load pipeline data.';
		} finally {
			pending = false;
			root.setAttribute('aria-busy', 'false');
			for (const { button, disabled } of buttons) { button.disabled = disabled; }
		}
	}

	const header = element('header', 'header pipeline-header');
	const heading = element('div', 'pipeline-heading');
	heading.append(element('div', 'number', `${isLog ? 'Log' : 'Run'} ${isLog ? content.logId : runId}${isLog ? ` / Run ${runId}` : content.buildNumber ? ` / ${content.buildNumber}` : ''}`));
	heading.append(element('h1', '', isLog ? content.taskName || 'Task log' : content.pipeline?.name || 'Pipeline run'));
	const controls = element('div', 'pipeline-actions');
	if (isLog) {
		controls.append(iconButton(ArrowLeft, 'Show run status', () => void request('get_pipeline_run', identity, 'run')));
	} else {
		const state = content.result && content.result !== 'None' ? content.result : content.status;
		controls.append(element('span', `status ${statusClass(state)}`, readableState(state)));
	}
	controls.append(iconButton(RefreshCw, 'Refresh', () => void request(isLog ? 'get_pipeline_run_log' : 'get_pipeline_run', isLog
		? { ...identity, logId: content.logId, startLine: content.startLine, lineCount: content.lineCount ?? 200 }
		: identity, content.view, isLog ? { lineCount: content.lineCount ?? 200, taskName: content.taskName } : {})));
	controls.append(iconButton(ExternalLink, 'Open in Azure DevOps', async () => {
		try { await actions.openLink(runUrl); }
		catch (failure) { error.textContent = failure instanceof Error ? failure.message : 'Unable to open Azure DevOps.'; }
	}));
	header.append(heading, controls);
	root.append(header, error);

	if (isLog) {
		const lines = Array.isArray(content.lines) ? content.lines : [];
		const startLine = content.startLine ?? 0;
		const lineCount = content.lineCount ?? 200;
		const toolbar = element('div', 'pipeline-log-toolbar');
		toolbar.append(element('span', 'number', lines.length ? `Lines ${startLine + 1}-${startLine + lines.length}` : 'No log lines in this range'));
		const logActions = element('div', 'pipeline-actions');
		logActions.append(iconButton(Copy, 'Copy displayed log', async () => {
			try {
				await actions.copyText(lines.map(line => stripAnsi(line)).join('\n'));
				feedback.textContent = 'Copied';
			} catch (failure) { error.textContent = failure instanceof Error ? failure.message : 'Unable to copy the log.'; }
		}));
		const previous = iconButton(ChevronLeft, 'Previous log lines', () => void request('get_pipeline_run_log', {
			...identity, logId: content.logId, startLine: Math.max(0, startLine - lineCount), lineCount,
		}, 'log', { lineCount, taskName: content.taskName }));
		previous.disabled = startLine === 0;
		const next = iconButton(ChevronRight, 'Next log lines', () => void request('get_pipeline_run_log', {
			...identity, logId: content.logId, startLine: content.nextStartLine, lineCount,
		}, 'log', { lineCount, taskName: content.taskName }));
		next.disabled = lines.length < lineCount;
		logActions.append(previous, next);
		toolbar.append(logActions);
		const output = element('div', 'pipeline-log');
		output.tabIndex = 0;
		output.setAttribute('role', 'region');
		output.setAttribute('aria-label', 'Task log lines');
		for (const [index, rawLine] of lines.entries()) {
			const line = stripAnsi(String(rawLine));
			const timestamp = line.match(/^(\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2})(?:\.\d+)?Z)\s?(.*)$/);
			const message = timestamp ? timestamp[3] : line;
			const level = /##\[error\]|^\s*(ERROR|FATAL|FAIL)\b/i.test(message) ? 'pipeline-failed'
				: /##\[warning\]|^\s*WARN(ING)?\b/i.test(message) ? 'pipeline-warning'
					: /##\[section\]/i.test(message) ? 'pipeline-section' : '';
			const row = element('div', `pipeline-log-line ${level}`);
			row.append(element('span', 'pipeline-line-number', String(startLine + index + 1)));
			const time = element('time', 'pipeline-log-time', timestamp ? timestamp[2] : '');
			if (timestamp) { time.dateTime = timestamp[1]; time.title = timestamp[1]; }
			row.append(time, element('code', 'pipeline-log-message', message));
			output.append(row);
		}
		if (!lines.length) { output.append(element('div', 'pipeline-empty', 'No log lines in this range.')); }
		const feedback = element('span', 'number');
		feedback.setAttribute('role', 'status');
		root.append(toolbar, output, feedback);
		return;
	}

	const metadata = element('dl', 'pipeline-metadata');
	const fields = [
		['Branch', content.sourceBranch?.replace(/^refs\/heads\//, '')],
		['Commit', content.sourceVersion?.slice(0, 8), content.sourceVersion],
		['Duration', duration(content.startTime, content.finishTime)],
		['Started', content.startTime ? new Date(content.startTime).toLocaleString() : content.queueTime ? `Queued ${new Date(content.queueTime).toLocaleString()}` : undefined],
		['Trigger', content.reason],
		['Requested by', content.requestedBy],
	];
	for (const [label, value, title] of fields) {
		if (!value) { continue; }
		const field = element('div');
		const detail = element('dd', '', value);
		if (title) { detail.title = title; }
		field.append(element('dt', '', label), detail);
		metadata.append(field);
	}
	root.append(metadata);
	const timeline = element('section', 'pipeline-timeline');
	timeline.append(element('h2', 'section-title', 'Run timeline'));
	const records = orderedRecords(content.records ?? []);
	if (!records.length) {
		timeline.append(element('div', 'pipeline-empty', content.timelineAvailable === false ? 'Timeline not available yet.' : 'No task results available.'));
	}
	for (const { record, depth } of records) {
		const row = element('div', 'pipeline-record');
		row.style.setProperty('--pipeline-depth', String(depth));
		const name = element('div', 'pipeline-record-name');
		name.append(element('span', 'number', record.type), element('span', '', record.name || 'Unnamed task'));
		const state = stateLabel(record.result, ['Succeeded', 'SucceededWithIssues', 'Failed', 'Canceled', 'Skipped', 'Abandoned'])
			|| stateLabel(record.state, ['Pending', 'InProgress', 'Completed']);
		const status = element('span', `pipeline-record-status ${statusClass(state)}`, readableState(state));
		const elapsed = element('span', 'number', duration(record.startTime, record.finishTime) ?? '');
		row.append(name, status, elapsed);
		if (record.logId) {
			row.append(iconButton(FileText, `Show log for ${record.name || record.type}`, () => void request('get_pipeline_run_log', {
				...identity, logId: record.logId, startLine: 0, lineCount: 200,
			}, 'log', { lineCount: 200, taskName: record.name })));
		} else { row.append(element('span')); }
		timeline.append(row);
		for (const issue of record.issues ?? []) {
			const text = element('div', `pipeline-issue ${issue.type === 1 || String(issue.type).toLowerCase() === 'error' ? 'pipeline-failed' : 'pipeline-warning'}`, issue.message);
			timeline.append(text);
		}
	}
	root.append(timeline);
}