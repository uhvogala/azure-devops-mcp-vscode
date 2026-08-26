const esbuild = require("esbuild");
const fs = require('node:fs/promises');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

async function main() {
	const ctx = await esbuild.context({
		entryPoints: [
			'src/extension.ts',
			'src/mcp-server.ts'
		],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outdir: 'dist',
		external: ['vscode'],
		logLevel: 'silent',
		plugins: [
			/* add to the end of plugins array */
			esbuildProblemMatcherPlugin,
		],
	});
	if (watch) {
		await ctx.watch();
	} else {
		await ctx.rebuild();
		await ctx.dispose();
	}

	const reviewCard = await esbuild.build({
		entryPoints: ['src/pr-review-card.js'],
		bundle: true,
		format: 'iife',
		platform: 'browser',
		target: 'es2022',
		write: false,
		logLevel: 'silent',
	});
	const reviewAssetFiles = {
		notReviewed: 'resources/not-reviewed.svg',
		openDiff: 'resources/open-diff.svg',
		openFile: 'resources/open-file.svg',
		reviewed: 'resources/reviewed.svg',
	};
	const reviewAssets = Object.fromEntries(await Promise.all(Object.entries(reviewAssetFiles).map(async ([name, file]) => [name, `data:image/svg+xml;base64,${await fs.readFile(file, 'base64')}`])));
	const script = `globalThis.__azureDevOpsMcpReviewAssets = ${JSON.stringify(reviewAssets)};\n${reviewCard.outputFiles[0].text}`;
	await fs.writeFile('dist/pr-review-card.html', `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root { --review-surface-radius: var(--vscode-cornerRadius-large, 8px); color: #cccccc; font-family: var(--vscode-font-family, sans-serif); color-scheme: dark; }
html, body { height: auto; overflow: visible; }
body { margin: 0; background: transparent; }
.review-card { position: relative; box-sizing: border-box; width: 100%; max-width: 480px; height: auto; min-height: 0; overflow: visible; padding: 16px; border: 1px solid #3c3c3c; border-radius: var(--review-surface-radius); background: #1e1e1e; } .terminal-state { display: grid; min-height: 160px; place-items: center; border-radius: var(--review-surface-radius); color: #9d9d9d; text-align: center; }
.loading-spinner { position: absolute; z-index: 1; inset: 0; display: grid; place-items: center; border-radius: inherit; background: rgba(15, 23, 42, 0.08); cursor: progress; } .loading-spinner::after { width: 22px; height: 22px; border: 3px solid var(--color-border-primary, #cbd5e1); border-top-color: #1686c3; border-radius: 50%; content: ''; animation: review-card-spin 0.8s linear infinite; } @keyframes review-card-spin { to { transform: rotate(360deg); } }
.header, .files-header, .file { display: flex; align-items: center; justify-content: space-between; gap: 12px; } .header { gap: 8px; }
.number, .file-details span, .files-header span, .approvals-count { color: #9d9d9d; font-size: 11px; }
h1, h2, p { margin: 0; } h1 { max-width: 360px; color: #cccccc; font-size: 17px; line-height: 23px; } h2 { font-size: 12px; }
.status { padding: 3px 6px; border: 0; border-radius: 0; background: #2a2d2e; color: #89d185; font-size: 10px; font-weight: 700; text-transform: uppercase; }
.branches { display: flex; align-items: flex-start; gap: 7px; margin-top: 12px; padding: 9px 10px; border: 1px solid #3c3c3c; border-radius: var(--review-surface-radius); background: #2d2d30; font-size: 12px; } .branch-flow, .branch-control { display: inline-flex; align-items: center; min-width: 0; } .branch-flow { gap: 7px; } .branch-control { gap: 4px; } .branch-link { min-width: 0; padding: 0; border: 0; background: transparent; color: #75beff; font: inherit; font-size: 12px; cursor: pointer; } .branch-link:hover { color: #75beff; text-decoration: underline; } .branch-link:focus-visible { outline: 1px solid #007fd4; outline-offset: 2px; } .branch-link.is-current { cursor: default; } .branch-link.is-checking-out { cursor: progress; opacity: .7; } .branch-separator { color: #9d9d9d; } .current-branch-mark { color: #89d185; font-size: 12px; line-height: 16px; } .branch-error { align-self: center; color: #f48771; font-size: 11px; overflow-wrap: anywhere; } .branch-error:empty { display: none; }
.approvals { margin-top: 12px; } .approvals-header, .approval-actions, .reviewer { display: flex; align-items: center; justify-content: space-between; gap: 10px; } .approvals-header { margin-bottom: 12px; } .approvals-header .section-title, .section-heading .section-title { margin: 0; } .approvals-count, .no-reviewers { color: #9d9d9d; font-size: 11px; } .approval-list { display: grid; overflow: hidden; border-radius: var(--review-surface-radius); } .reviewer { padding: 7px 10px; border-bottom: 1px solid #3c3c3c; background: #252526; font-size: 12px; } .reviewer:last-child { border-bottom: 0; } .reviewer-name { overflow-wrap: anywhere; } .reviewer-vote { color: #9d9d9d; font-size: 11px; white-space: nowrap; } .reviewer-vote:first-letter { color: #89d185; } .approval-actions { justify-content: flex-start; margin-top: 12px; } .approval-error { color: #f48771; font-size: 11px; overflow-wrap: anywhere; }
.draft-status { background: var(--color-background-info, #dbeafe); color: var(--color-text-info, #1d4ed8); } .draft-description, .draft-files { margin-top: 18px; } .draft-description-header, .draft-details { display: flex; align-items: center; justify-content: space-between; gap: 10px; } .draft-description-header { margin-bottom: 8px; } .preview-control { display: inline-flex; align-items: center; gap: 6px; color: var(--color-text-secondary, #64748b); font-size: 12px; cursor: pointer; } .preview-control input { width: 32px; height: 18px; margin: 0; accent-color: #1686c3; cursor: pointer; } .description-input { box-sizing: border-box; width: 100%; resize: vertical; border: 1px solid var(--color-border-primary, #cbd5e1); border-radius: var(--border-radius-sm, 6px); padding: 9px 10px; background: var(--color-background-primary, #fff); color: var(--color-text-primary, #172b4d); font: inherit; font-size: 13px; line-height: 1.5; } .description-preview { min-height: 120px; padding: 9px 10px; border: 1px solid var(--color-border-primary, #cbd5e1); border-radius: var(--border-radius-sm, 6px); background: var(--color-background-secondary, #f8fafc); } .draft-files { border: 1px solid var(--color-border-primary, #e2e8f0); border-radius: var(--border-radius-sm, 6px); overflow: hidden; } .draft-file, .draft-file-empty { display: flex; justify-content: space-between; gap: 10px; padding: 7px 10px; border-top: 1px solid var(--color-border-primary, #e2e8f0); } .draft-file span, .draft-file-empty { color: var(--color-text-secondary, #64748b); font-size: 11px; } .draft-file-empty { display: block; } .draft-details { justify-content: flex-start; margin-top: 10px; } .draft-details > span:first-child { color: var(--color-text-secondary, #64748b); font-size: 12px; } .submit-error { color: var(--color-text-danger, #b91c1c); font-size: 11px; overflow-wrap: anywhere; }
:root[data-theme="dark"] .summary { color: #cccccc; } .summary { margin-top: 12px; padding: 0; color: #cccccc; } .section-title { margin-bottom: 12px; color: #9d9d9d; text-transform: none; font-size: 11px; letter-spacing: 0; } .markdown { color: #cccccc; font-size: 12px; line-height: 18px; } .markdown > :first-child { margin-top: 0; } .markdown > :last-child { margin-bottom: 0; } .markdown h1, .markdown h2, .markdown h3 { margin: 14px 0 6px; font-size: 13px; line-height: 1.35; } .markdown p, .markdown ul, .markdown ol, .markdown pre { margin: 0 0 6px; } .markdown ul, .markdown ol { padding-left: 16px; } .markdown li + li { margin-top: 0; } .markdown code { padding: 1px 4px; border-radius: 3px; background: #333333; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; } .markdown pre { overflow-x: auto; padding: 8px; border-radius: 0; background: #333333; } .markdown pre code { padding: 0; background: transparent; } .markdown a { color: #3794ff; }
.files { margin-top: 12px; overflow: visible; } .section-heading { display: flex; align-items: center; min-height: 16px; margin-bottom: 12px; } .file-list { overflow: hidden; border: 1px solid #3c3c3c; border-radius: var(--review-surface-radius); background: #252526; }
.files-header { min-height: 34px; padding: 9px 10px; background: #2d2d30; } .files-header h2 { color: #cccccc; font-size: 12px; }
.file { display: grid; grid-template-columns: 16px minmax(0, 1fr) 58px; min-height: 50px; padding: 8px 8px 8px 10px; gap: 8px; border-top: 1px solid #3c3c3c; background: #252526; } .file:has(input:checked) { background: #2a2d2e; } .file-details { min-width: 0; display: grid; align-content: center; gap: 2px; } .file-details code { overflow: hidden; color: #cccccc; text-overflow: ellipsis; white-space: nowrap; } .file-metadata { display: flex; align-items: center; gap: 6px; min-width: 0; } .change-kind.change-added { color: #89d185; } .change-kind.change-modified, .change-kind.change-renamed { color: #e2c08d; } .change-kind.change-deleted { color: #f48771; } code { overflow-wrap: anywhere; font-family: var(--vscode-font-family, sans-serif); font-size: 12px; } button.comment-count { justify-self: start; padding: 0; border: 0; background: transparent; color: #3794ff; font-size: 11px; font-weight: 400; text-decoration: none; } button.comment-count:hover { background: transparent; color: #3794ff; text-decoration: underline; } .action-error { color: #f48771; font-size: 11px; line-height: 1.35; overflow-wrap: anywhere; } .action-error:empty { display: none; } .file-actions { display: grid; grid-template-columns: repeat(2, 28px); gap: 2px; } button.file-action { display: grid; place-items: center; width: 28px; min-height: 28px; padding: 0; border: 0; border-radius: 3px; background: #2d2d30; } button.file-action:hover { background: #333333; } .file-action-icon, .review-icon { display: block; width: 16px; height: 16px; } .review-control { position: relative; display: grid; place-items: center; width: 16px; height: 16px; cursor: pointer; } .review-control input { position: absolute; opacity: 0; cursor: pointer; } .review-control:has(input:focus-visible) { outline: 1px solid #007fd4; outline-offset: 2px; } .review-control input:disabled, .review-control input:disabled + .review-icon { cursor: progress; }
button { border: 0; border-radius: 3px; padding: 6px 10px; background: #007fd4; color: #ffffff; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; } button:hover { background: #1686c3; } button:disabled { cursor: progress; opacity: 0.7; }
:root[data-theme="dark"] .review-card { background: var(--color-background-primary, #1e1e1e); border-color: var(--color-border-primary, #454545); } :root[data-theme="dark"] .loading-spinner { background: rgba(0, 0, 0, 0.22); } :root[data-theme="dark"] .branches, :root[data-theme="dark"] .reviewer, :root[data-theme="dark"] .description-preview, :root[data-theme="dark"] .files-header, :root[data-theme="dark"] .file.reviewed { background: var(--color-background-secondary, #252526); } :root[data-theme="dark"] .description-input { border-color: var(--color-border-primary, #454545); background: var(--color-background-primary, #1e1e1e); color: var(--color-text-primary, #cccccc); } :root[data-theme="dark"] .summary { color: var(--color-text-primary, #cccccc); } :root[data-theme="dark"] .markdown code, :root[data-theme="dark"] .markdown pre { background: var(--color-background-tertiary, #333333); } :root[data-theme="dark"] .files, :root[data-theme="dark"] .draft-files, :root[data-theme="dark"] .file, :root[data-theme="dark"] .draft-file, :root[data-theme="dark"] .draft-file-empty { border-color: var(--color-border-primary, #454545); } :root[data-theme="dark"] button.open-file, :root[data-theme="dark"] button.checkout-branch { border-color: #707070; color: #d4d4d4; } :root[data-theme="dark"] button.open-file:hover, :root[data-theme="dark"] button.checkout-branch:hover { background: #333333; }
</style>
</head>
<body><script>${script}</script></body>
</html>`);

	await esbuild.build({
		entryPoints: ['src/pr-overview.js'],
		bundle: true,
		format: 'iife',
		platform: 'browser',
		target: 'es2022',
		outfile: 'dist/pr-overview.js',
		logLevel: 'silent',
	});
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
