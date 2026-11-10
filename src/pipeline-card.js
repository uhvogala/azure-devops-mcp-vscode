import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import { renderPipelineCard } from './pipeline-card-ui';

const app = new App({ name: 'Azure DevOps pipelines and logs', version: __AZURE_DEVOPS_MCP_VERSION__ }, {});
const root = document.createElement('main');
root.className = 'review-card pipeline-card';
document.body.append(root);

function showMessage(message, isError = false) {
	const state = document.createElement('div');
	state.className = 'terminal-state';
	state.setAttribute('role', isError ? 'alert' : 'status');
	state.textContent = message;
	root.replaceChildren(state);
}

function applyHostContext(context) {
	if (context.theme) { applyDocumentTheme(context.theme); }
	if (context.styles?.variables) { applyHostStyleVariables(context.styles.variables); }
}

app.ontoolresult = result => {
	if (result.isError) {
		showMessage(result.content?.filter(item => item.type === 'text').map(item => item.text).join(' ') || 'Unable to load pipeline data.', true);
		return;
	}
	const content = result.structuredContent;
	if (content?.view === 'run' || content?.view === 'log') {
		renderPipelineCard(root, content, {
			callTool: request => app.callServerTool(request),
			openLink: url => app.openLink({ url }),
			copyText: text => navigator.clipboard.writeText(text),
		});
	} else { showMessage('No pipeline data available.'); }
};
app.onhostcontextchanged = applyHostContext;
showMessage('Loading pipeline data...');
void app.connect().then(() => applyHostContext(app.getHostContext())).catch(error => showMessage(error.message || 'Unable to connect to the chat host.', true));