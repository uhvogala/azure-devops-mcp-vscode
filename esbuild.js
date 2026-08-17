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
	const script = reviewCard.outputFiles[0].text;
	await fs.writeFile('dist/pr-review-card.html', `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root { color: var(--color-text-primary, #172b4d); font-family: var(--font-sans, sans-serif); color-scheme: light; }
:root[data-theme="dark"] { color-scheme: dark; }
body { margin: 0; background: transparent; }
.review-card { position: relative; box-sizing: border-box; max-width: 720px; padding: 18px; border: 1px solid var(--color-border-primary, #cbd5e1); border-radius: var(--border-radius-md, 8px); background: var(--color-background-primary, #fff); }
.loading-spinner { position: absolute; z-index: 1; inset: 0; display: grid; place-items: center; border-radius: inherit; background: rgba(15, 23, 42, 0.08); cursor: progress; } .loading-spinner::after { width: 22px; height: 22px; border: 3px solid var(--color-border-primary, #cbd5e1); border-top-color: #1686c3; border-radius: 50%; content: ''; animation: review-card-spin 0.8s linear infinite; } @keyframes review-card-spin { to { transform: rotate(360deg); } }
.header, .files-header, .file { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.number, .file-details span, .files-header span { color: var(--color-text-secondary, #64748b); font-size: 12px; }
h1, h2, p { margin: 0; } h1 { max-width: 540px; font-size: 18px; line-height: 1.35; } h2 { font-size: 13px; }
.status { padding: 4px 8px; border-radius: var(--border-radius-sm, 6px); background: var(--color-background-success, #dcfce7); color: var(--color-text-success, #166534); font-size: 11px; font-weight: 700; text-transform: uppercase; }
.branches { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 10px; margin-top: 14px; padding: 9px 10px; border-left: 3px solid var(--color-border-info, #1d4ed8); border-radius: 0 var(--border-radius-sm, 6px) var(--border-radius-sm, 6px) 0; background: var(--color-background-secondary, #f1f5f9); color: var(--color-text-secondary, #475569); font-size: 12px; } .branch-name { overflow-wrap: anywhere; } .branch-actions { display: flex; gap: 6px; } .branch-error { grid-column: 1 / -1; color: var(--color-text-danger, #b91c1c); font-size: 11px; overflow-wrap: anywhere; } button.checkout-branch { border-color: var(--color-border-primary, #64748b); background: transparent; color: var(--color-text-primary, #172b4d); }
.approvals { margin-top: 18px; } .approvals-header, .approval-actions, .reviewer { display: flex; align-items: center; justify-content: space-between; gap: 10px; } .approvals-header { margin-bottom: 8px; } .approvals-count, .no-reviewers { color: var(--color-text-secondary, #64748b); font-size: 12px; } .approval-list { display: grid; gap: 4px; } .reviewer { padding: 7px 9px; border-left: 3px solid var(--color-border-primary, #cbd5e1); background: var(--color-background-secondary, #f8fafc); font-size: 12px; } .reviewer-name { overflow-wrap: anywhere; } .reviewer-vote { color: var(--color-text-secondary, #64748b); white-space: nowrap; } .approval-actions { justify-content: flex-start; margin-top: 10px; } .approval-error { color: var(--color-text-danger, #b91c1c); font-size: 11px; overflow-wrap: anywhere; }
.draft-status { background: var(--color-background-info, #dbeafe); color: var(--color-text-info, #1d4ed8); } .draft-description, .draft-files { margin-top: 18px; } .draft-description-header, .draft-details { display: flex; align-items: center; justify-content: space-between; gap: 10px; } .draft-description-header { margin-bottom: 8px; } .preview-control { display: inline-flex; align-items: center; gap: 6px; color: var(--color-text-secondary, #64748b); font-size: 12px; cursor: pointer; } .preview-control input { width: 32px; height: 18px; margin: 0; accent-color: #1686c3; cursor: pointer; } .description-input { box-sizing: border-box; width: 100%; resize: vertical; border: 1px solid var(--color-border-primary, #cbd5e1); border-radius: var(--border-radius-sm, 6px); padding: 9px 10px; background: var(--color-background-primary, #fff); color: var(--color-text-primary, #172b4d); font: inherit; font-size: 13px; line-height: 1.5; } .description-preview { min-height: 120px; padding: 9px 10px; border: 1px solid var(--color-border-primary, #cbd5e1); border-radius: var(--border-radius-sm, 6px); background: var(--color-background-secondary, #f8fafc); } .draft-files { border: 1px solid var(--color-border-primary, #e2e8f0); border-radius: var(--border-radius-sm, 6px); overflow: hidden; } .draft-file, .draft-file-empty { display: flex; justify-content: space-between; gap: 10px; padding: 7px 10px; border-top: 1px solid var(--color-border-primary, #e2e8f0); } .draft-file span, .draft-file-empty { color: var(--color-text-secondary, #64748b); font-size: 11px; } .draft-file-empty { display: block; } .draft-details { justify-content: flex-start; margin-top: 10px; } .draft-details > span:first-child { color: var(--color-text-secondary, #64748b); font-size: 12px; } .submit-error { color: var(--color-text-danger, #b91c1c); font-size: 11px; overflow-wrap: anywhere; }
.summary { margin-top: 18px; padding: 0; color: var(--color-text-primary, #172b4d); } .section-title { margin-bottom: 8px; color: var(--color-text-secondary, #475569); text-transform: uppercase; font-size: 11px; letter-spacing: .04em; } .markdown { font-size: 13px; line-height: 1.5; } .markdown > :first-child { margin-top: 0; } .markdown > :last-child { margin-bottom: 0; } .markdown h1, .markdown h2, .markdown h3 { margin: 14px 0 6px; font-size: 13px; line-height: 1.35; } .markdown p, .markdown ul, .markdown ol, .markdown pre { margin: 0 0 8px; } .markdown ul, .markdown ol { padding-left: 20px; } .markdown li + li { margin-top: 3px; } .markdown code { padding: 1px 4px; border-radius: 3px; background: var(--color-background-tertiary, #eef2f6); font-family: var(--font-mono, monospace); font-size: 12px; } .markdown pre { overflow-x: auto; padding: 8px; border-radius: 4px; background: var(--color-background-tertiary, #eef2f6); } .markdown pre code { padding: 0; background: transparent; } .markdown a { color: var(--color-text-info, #1d4ed8); }
.files { margin-top: 18px; border: 1px solid var(--color-border-primary, #e2e8f0); border-radius: var(--border-radius-sm, 6px); overflow: hidden; }
.files-header { padding: 10px 12px; background: var(--color-background-secondary, #f8fafc); }
.file { padding: 10px 12px; border-top: 1px solid var(--color-border-primary, #e2e8f0); gap: 10px; } .file.reviewed { background: var(--color-background-secondary, #f8fafc); } .file-details { flex: 1 1 auto; min-width: 0; display: grid; gap: 3px; } code { overflow-wrap: anywhere; font-family: var(--font-mono, monospace); font-size: 13px; } button.comment-count { justify-self: start; padding: 0; border: 0; background: transparent; color: var(--color-text-info, #1686c3); font-size: 11px; font-weight: 600; text-decoration: underline; } button.comment-count:hover { background: transparent; color: var(--color-text-info, #1686c3); } .action-error { color: var(--color-text-danger, #b91c1c); font-size: 11px; line-height: 1.35; overflow-wrap: anywhere; } .file-actions { display: flex; flex: 0 0 auto; gap: 6px; } .review-control { display: inline-flex; flex: 0 0 92px; align-items: center; gap: 5px; color: var(--color-text-secondary, #64748b); font-size: 11px; cursor: pointer; } .review-control input { width: 14px; height: 14px; accent-color: #1686c3; cursor: pointer; } .review-control input:disabled { cursor: progress; }
button { border: 1px solid #1686c3; border-radius: var(--border-radius-sm, 6px); padding: 6px 10px; background: #1686c3; color: #ffffff; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; } button:hover { background: #219ad8; border-color: #219ad8; } button:disabled { cursor: progress; opacity: 0.7; } button.open-file { border-color: var(--color-border-primary, #64748b); background: transparent; color: var(--color-text-primary, #172b4d); } button.open-file:hover { background: var(--color-background-secondary, #eef2f6); }
:root[data-theme="dark"] .review-card { background: var(--color-background-primary, #1e1e1e); border-color: var(--color-border-primary, #454545); } :root[data-theme="dark"] .loading-spinner { background: rgba(0, 0, 0, 0.22); } :root[data-theme="dark"] .branches, :root[data-theme="dark"] .reviewer, :root[data-theme="dark"] .description-preview, :root[data-theme="dark"] .files-header, :root[data-theme="dark"] .file.reviewed { background: var(--color-background-secondary, #252526); } :root[data-theme="dark"] .description-input { border-color: var(--color-border-primary, #454545); background: var(--color-background-primary, #1e1e1e); color: var(--color-text-primary, #cccccc); } :root[data-theme="dark"] .summary { color: var(--color-text-primary, #cccccc); } :root[data-theme="dark"] .markdown code, :root[data-theme="dark"] .markdown pre { background: var(--color-background-tertiary, #333333); } :root[data-theme="dark"] .files, :root[data-theme="dark"] .draft-files, :root[data-theme="dark"] .file, :root[data-theme="dark"] .draft-file, :root[data-theme="dark"] .draft-file-empty { border-color: var(--color-border-primary, #454545); } :root[data-theme="dark"] button.open-file, :root[data-theme="dark"] button.checkout-branch { border-color: #707070; color: #d4d4d4; } :root[data-theme="dark"] button.open-file:hover, :root[data-theme="dark"] button.checkout-branch:hover { background: #333333; }
</style>
</head>
<body><script>${script}</script></body>
</html>`);
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
