import * as vscode from "vscode";
import * as path from "path";
import { EndpointTreeProvider } from "./EndpointTreeProvider";
import { EndpointDefinitionProvider } from "./providers/EndpointDefinitionProvider";
import { EndpointHoverProvider } from "./providers/EndpointHoverProvider";
import { getEndpointIndex } from "./EndpointIndex";
import { debounce } from "./utils/debounce";
import { BACKEND_FILE_GLOBS_DOTNET, BACKEND_FILE_GLOBS_FASTAPI, BackendKind, validateBackendConfig } from "./scanner/config";

export function activate(context: vscode.ExtensionContext) {
  console.log('API Navigator extension is now active');

  const index = getEndpointIndex();
  const treeProvider = new EndpointTreeProvider(index);

  // Register TreeView
  const treeView = vscode.window.createTreeView("dot-next-apiNavigator.endpoints", {
    treeDataProvider: treeProvider,
    showCollapseAll: true
  });
  context.subscriptions.push(treeView);

  // Register Definition Provider (CTRL+Click navigation)
  const definitionProvider = new EndpointDefinitionProvider();
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(
      [{ language: 'typescript' }, { language: 'typescriptreact' }],
      definitionProvider
    )
  );

  // Register Hover Provider (CTRL+Hover info)
  const hoverProvider = new EndpointHoverProvider();
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      [{ language: 'typescript' }, { language: 'typescriptreact' }],
      hoverProvider
    )
  );

  // Refresh command
  context.subscriptions.push(
    vscode.commands.registerCommand("apiNavigator.refresh", async () => {
      await refreshIndex(index, treeProvider);
    })
  );

  // Open settings command
  context.subscriptions.push(
    vscode.commands.registerCommand("apiNavigator.openSettings", () => {
      vscode.commands.executeCommand(
        'workbench.action.openSettings',
        'apiNavigator'
      );
    })
  );

  // File watchers for auto-refresh
  const config = vscode.workspace.getConfiguration('apiNavigator');
  const autoRefresh = config.get<boolean>('autoRefresh', true);

  if (autoRefresh) {
    setupFileWatchers(context, index, treeProvider);
  }

  // Configuration change listener
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('apiNavigator')) {
        refreshIndex(index, treeProvider);
      }
    })
  );

  // Initial scan
  refreshIndex(index, treeProvider);
}

async function refreshIndex(
  index: ReturnType<typeof getEndpointIndex>,
  treeProvider: EndpointTreeProvider
): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showWarningMessage('No workspace folder open');
    return;
  }

  const config = vscode.workspace.getConfiguration('apiNavigator');
  const frontendRoot = config.get<string>('frontendRoot', './frontend');
  const backendRoot = config.get<string>('backendRoot', './backend');
  const backendKind = config.get<BackendKind>('backendKind');
  const fastapiEntrypoint = config.get<string>('fastapiEntrypoint', '');

  // Validate backend configuration
  const validationError = validateBackendConfig(backendKind, fastapiEntrypoint);
  if (validationError) {
    vscode.window.showWarningMessage(`API Navigator: ${validationError}`);
    treeProvider.refresh();
    return;
  }

  const absoluteFrontendRoot = path.join(workspaceFolder.uri.fsPath, frontendRoot);
  const absoluteBackendRoot = path.join(workspaceFolder.uri.fsPath, backendRoot);

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Scanning API endpoints...",
        cancellable: false
      },
      async () => {
        await index.rebuild(absoluteFrontendRoot, absoluteBackendRoot, backendKind!, fastapiEntrypoint);
        treeProvider.refresh();
      }
    );

    const endpoints = index.getAllEndpoints();
    const valid = endpoints.filter(e => e.status === 'valid').length;
    const issues = endpoints.filter(e => e.status !== 'valid').length;
    
    const kindLabel = backendKind === 'fastapi' ? 'FastAPI' : 'ASP.NET';
    vscode.window.setStatusBarMessage(
      `API Navigator (${kindLabel}): ${endpoints.length} endpoints (${valid} valid, ${issues} with issues)`,
      5000
    );
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to scan endpoints: ${error}`);
  }
}

function setupFileWatchers(
  context: vscode.ExtensionContext,
  index: ReturnType<typeof getEndpointIndex>,
  treeProvider: EndpointTreeProvider
): void {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return;
  }

  const config = vscode.workspace.getConfiguration('apiNavigator');
  const frontendRoot = config.get<string>('frontendRoot', './frontend');
  const backendRoot = config.get<string>('backendRoot', './backend');
  const backendKind = config.get<BackendKind>('backendKind');

  // Debounced refresh function
  const debouncedRefresh = debounce(() => {
    refreshIndex(index, treeProvider);
  }, 300);

  // Watch for backend file changes based on backend kind
  const backendGlobs = backendKind === 'fastapi' 
    ? BACKEND_FILE_GLOBS_FASTAPI 
    : BACKEND_FILE_GLOBS_DOTNET;

  backendGlobs.forEach(glob => {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        path.join(workspaceFolder.uri.fsPath, backendRoot),
        glob
      )
    );

    watcher.onDidChange(debouncedRefresh);
    watcher.onDidCreate(debouncedRefresh);
    watcher.onDidDelete(debouncedRefresh);
    context.subscriptions.push(watcher);
  });

  // Watch for TypeScript/TSX file changes in /lib/api folder only
  const frontendWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(
      path.join(workspaceFolder.uri.fsPath, frontendRoot),
      'lib/api/**/*.{ts,tsx}'
    )
  );

  frontendWatcher.onDidChange(debouncedRefresh);
  frontendWatcher.onDidCreate(debouncedRefresh);
  frontendWatcher.onDidDelete(debouncedRefresh);
  context.subscriptions.push(frontendWatcher);
}

export function deactivate() {
  const index = getEndpointIndex();
  index.clear();
}
