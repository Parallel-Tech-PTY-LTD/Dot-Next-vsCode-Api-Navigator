import * as vscode from "vscode";
import * as path from "path";
import { EndpointIndex, EndpointEntry, EndpointStatus } from "./EndpointIndex";

type TreeNode = EndpointNode | BackendGroupNode | BackendDefinitionNode | FrontendGroupNode | FrontendCallNode;

interface EndpointNode {
  type: 'endpoint';
  entry: EndpointEntry;
}

interface BackendGroupNode {
  type: 'backend-group';
  entry: EndpointEntry;
}

interface BackendDefinitionNode {
  type: 'backend-definition';
  location: vscode.Location;
  httpMethod?: string;
  rawEndpoint: string;
  isOnlyOne: boolean;  // True if this is the only backend definition (no group needed)
  parentEntry: EndpointEntry;
}

interface FrontendGroupNode {
  type: 'frontend-group';
  entry: EndpointEntry;
}

interface FrontendCallNode {
  type: 'frontend-call';
  location: vscode.Location;
  params: string[];
  rawEndpoint: string;
  parentEntry: EndpointEntry;
}

export class EndpointTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private index: EndpointIndex) {
    // Listen for index changes
    index.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    switch (node.type) {
      case 'endpoint':
        return this.createEndpointTreeItem(node.entry);
      case 'backend-group':
        return this.createBackendGroupTreeItem(node.entry);
      case 'backend-definition':
        return this.createBackendDefinitionTreeItem(node);
      case 'frontend-group':
        return this.createFrontendGroupTreeItem(node.entry);
      case 'frontend-call':
        return this.createFrontendCallTreeItem(node);
      default:
        return new vscode.TreeItem('Unknown');
    }
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (!node) {
      // Root level - return all endpoints
      return this.index.getAllEndpoints().map(entry => ({
        type: 'endpoint' as const,
        entry
      }));
    }

    switch (node.type) {
      case 'endpoint':
        return this.getEndpointChildren(node.entry);
      case 'backend-group':
        return this.getBackendDefinitionChildren(node.entry);
      case 'frontend-group':
        return this.getFrontendCallChildren(node.entry);
      default:
        return [];
    }
  }

  private getEndpointChildren(entry: EndpointEntry): TreeNode[] {
    const children: TreeNode[] = [];

    // Backend definitions - show group if multiple, single node if one, or not-found node
    if (entry.backendDefinitions.length > 1) {
      // Multiple backend definitions - show as collapsible group
      children.push({
        type: 'backend-group' as const,
        entry
      });
    } else if (entry.backendDefinitions.length === 1) {
      // Single backend definition - show directly
      const def = entry.backendDefinitions[0];
      children.push({
        type: 'backend-definition' as const,
        location: def.location,
        httpMethod: def.httpMethod,
        rawEndpoint: def.rawEndpoint,
        isOnlyOne: true,
        parentEntry: entry
      });
    } else {
      // No backend definition - show warning node
      children.push({
        type: 'backend-group' as const,  // Use group type with empty definitions
        entry
      });
    }

    // Frontend calls group
    if (entry.frontends.length > 0) {
      children.push({
        type: 'frontend-group' as const,
        entry
      });
    }

    return children;
  }

  private getBackendDefinitionChildren(entry: EndpointEntry): TreeNode[] {
    return entry.backendDefinitions.map(def => ({
      type: 'backend-definition' as const,
      location: def.location,
      httpMethod: def.httpMethod,
      rawEndpoint: def.rawEndpoint,
      isOnlyOne: false,
      parentEntry: entry
    }));
  }

  private getFrontendCallChildren(entry: EndpointEntry): TreeNode[] {
    return entry.frontends.map(frontend => ({
      type: 'frontend-call' as const,
      location: frontend.location,
      params: frontend.params,
      rawEndpoint: frontend.rawEndpoint,
      parentEntry: entry
    }));
  }

  private createEndpointTreeItem(entry: EndpointEntry): vscode.TreeItem {
    // Include HTTP method in the endpoint label: "/api/users/{id} [GET]"
    const label = entry.httpMethod 
      ? `${entry.endpoint} [${entry.httpMethod}]`
      : entry.endpoint;
    
    const item = new vscode.TreeItem(
      label,
      vscode.TreeItemCollapsibleState.Collapsed
    );

    // Status-based icon and description
    const statusInfo = this.getStatusInfo(entry.status);
    item.iconPath = new vscode.ThemeIcon(statusInfo.icon, statusInfo.color);

    // Build tooltip with detailed info
    item.tooltip = this.buildEndpointTooltip(entry);

    return item;
  }

  private createBackendGroupTreeItem(entry: EndpointEntry): vscode.TreeItem {
    if (entry.backendDefinitions.length === 0) {
      // No backend definition found
      const item = new vscode.TreeItem('Backend Definition');
      item.description = '⚠️ Not found';
      item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
      item.tooltip = 'No backend controller found for this endpoint';
      return item;
    }

    // Multiple backend definitions - collapsible group with warning
    const count = entry.backendDefinitions.length;
    const item = new vscode.TreeItem(
      `Backend Definitions (${count})`,
      vscode.TreeItemCollapsibleState.Collapsed
    );
    item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
    item.description = '❌ Duplicate definitions';
    item.tooltip = `${count} conflicting backend definitions found - should be exactly 1`;

    return item;
  }

  private createBackendDefinitionTreeItem(node: BackendDefinitionNode): vscode.TreeItem {
    const relativePath = this.getRelativePath(node.location.uri);
    const line = node.location.range.start.line + 1;

    const item = new vscode.TreeItem(
      node.isOnlyOne ? 'Backend Definition' : `${relativePath}:${line}`
    );
    item.description = node.isOnlyOne ? `${relativePath}:${line}` : (node.httpMethod ? `[${node.httpMethod}]` : undefined);
    
    if (node.parentEntry.status === 'invalid' && !node.isOnlyOne) {
      // Part of duplicate definitions - show warning
      item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.orange'));
    } else {
      item.iconPath = new vscode.ThemeIcon('symbol-method', new vscode.ThemeColor('charts.blue'));
    }
    
    item.tooltip = `${node.location.uri.fsPath}:${line}\nEndpoint: ${node.rawEndpoint}`;

    item.command = {
      command: 'vscode.open',
      title: 'Open Backend Definition',
      arguments: [
        node.location.uri,
        { selection: node.location.range }
      ]
    };

    return item;
  }

  private createFrontendGroupTreeItem(entry: EndpointEntry): vscode.TreeItem {
    const count = entry.frontends.length;
    const item = new vscode.TreeItem(
      `Frontend Calls (${count})`,
      vscode.TreeItemCollapsibleState.Collapsed
    );

    item.iconPath = new vscode.ThemeIcon('references', new vscode.ThemeColor('charts.green'));
    item.tooltip = `${count} frontend call site(s)`;

    return item;
  }

  private createFrontendCallTreeItem(node: FrontendCallNode): vscode.TreeItem {
    const relativePath = this.getRelativePath(node.location.uri);
    const line = node.location.range.start.line + 1;

    const item = new vscode.TreeItem(`${relativePath}:${line}`);
    item.iconPath = new vscode.ThemeIcon('file-code');

    // Check for parameter mismatch
    const hasMismatch = this.checkParamMismatch(node.params, node.parentEntry.backendParams);
    if (hasMismatch) {
      item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.orange'));
      item.tooltip = this.buildParamMismatchTooltip(node.params, node.parentEntry.backendParams);
    } else {
      item.tooltip = node.rawEndpoint;
    }

    item.command = {
      command: 'vscode.open',
      title: 'Open Frontend Call',
      arguments: [
        node.location.uri,
        { selection: node.location.range }
      ]
    };

    return item;
  }

  private getStatusInfo(status: EndpointStatus): { icon: string; color: vscode.ThemeColor } {
    switch (status) {
      case 'valid':
        return { icon: 'check', color: new vscode.ThemeColor('charts.green') };
      case 'invalid':
        return { icon: 'error', color: new vscode.ThemeColor('charts.red') };
      case 'unresolved':
        return { icon: 'warning', color: new vscode.ThemeColor('charts.yellow') };
      case 'param-mismatch':
        return { icon: 'zap', color: new vscode.ThemeColor('charts.orange') };
      default:
        return { icon: 'question', color: new vscode.ThemeColor('foreground') };
    }
  }

  private buildEndpointTooltip(entry: EndpointEntry): vscode.MarkdownString {
    const tooltip = new vscode.MarkdownString();
    tooltip.isTrusted = true;

    tooltip.appendMarkdown(`### ${entry.endpoint}\n\n`);
    
    // Status
    const statusEmoji = this.getStatusEmoji(entry.status);
    tooltip.appendMarkdown(`**Status:** ${statusEmoji} ${entry.status}\n\n`);

    // HTTP Method
    if (entry.httpMethod) {
      tooltip.appendMarkdown(`**HTTP Method:** \`${entry.httpMethod}\`\n\n`);
    }

    // Backend info - show all definitions
    if (entry.backendDefinitions.length === 0) {
      tooltip.appendMarkdown(`**Backend:** ⚠️ Not found\n\n`);
    } else if (entry.backendDefinitions.length === 1) {
      const def = entry.backendDefinitions[0];
      const backendPath = this.getRelativePath(def.location.uri);
      const line = def.location.range.start.line + 1;
      tooltip.appendMarkdown(`**Backend:** \`${backendPath}:${line}\`\n\n`);
    } else {
      tooltip.appendMarkdown(`**Backend Definitions:** ❌ ${entry.backendDefinitions.length} duplicates\n\n`);
      for (const def of entry.backendDefinitions) {
        const backendPath = this.getRelativePath(def.location.uri);
        const line = def.location.range.start.line + 1;
        tooltip.appendMarkdown(`- \`${backendPath}:${line}\`\n`);
      }
      tooltip.appendMarkdown('\n');
    }

    // Frontend calls count
    tooltip.appendMarkdown(`**Frontend Calls:** ${entry.frontends.length}\n\n`);

    // Parameter mismatches
    if (entry.paramMismatches.length > 0) {
      tooltip.appendMarkdown(`---\n\n**⚠️ Parameter Mismatches:**\n\n`);
      for (const mismatch of entry.paramMismatches) {
        tooltip.appendMarkdown(
          `- Position ${mismatch.position}: frontend \`\${${mismatch.frontendParam}}\` ≠ backend \`{${mismatch.backendParam}}\`\n`
        );
      }
    }

    // Error message
    if (entry.errorMessage) {
      tooltip.appendMarkdown(`---\n\n**❌ Error:** ${entry.errorMessage}\n`);
    }

    return tooltip;
  }

  private buildParamMismatchTooltip(frontendParams: string[], backendParams: string[]): string {
    const lines = ['⚠️ Parameter Mismatch:', ''];
    const maxLen = Math.max(frontendParams.length, backendParams.length);

    for (let i = 0; i < maxLen; i++) {
      const frontend = frontendParams[i] || '(missing)';
      const backend = backendParams[i] || '(missing)';
      if (frontend !== backend) {
        lines.push(`Position ${i + 1}: frontend \${${frontend}} ≠ backend {${backend}}`);
      }
    }

    return lines.join('\n');
  }

  private checkParamMismatch(frontendParams: string[], backendParams: string[]): boolean {
    if (frontendParams.length !== backendParams.length) {
      return true;
    }
    for (let i = 0; i < frontendParams.length; i++) {
      if (frontendParams[i] !== backendParams[i]) {
        return true;
      }
    }
    return false;
  }

  private getStatusEmoji(status: EndpointStatus): string {
    switch (status) {
      case 'valid': return '✅';
      case 'invalid': return '❌';
      case 'unresolved': return '⚠️';
      case 'param-mismatch': return '⚡';
      default: return '❓';
    }
  }

  private getRelativePath(uri: vscode.Uri): string {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      return path.relative(workspaceFolder.uri.fsPath, uri.fsPath);
    }
    return path.basename(uri.fsPath);
  }
}

