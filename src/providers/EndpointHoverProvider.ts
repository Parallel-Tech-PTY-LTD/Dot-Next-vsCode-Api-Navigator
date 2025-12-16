import * as vscode from 'vscode';
import { getEndpointIndex } from '../EndpointIndex';
import { detectEndpointAtPosition } from '../scanner/frontendScanner';
import * as path from 'path';

/**
 * Provides hover information for API endpoints.
 * Shows backend file location and parameter info when hovering over fetch() calls.
 */
export class EndpointHoverProvider implements vscode.HoverProvider {
    
    provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.Hover> {
        
        // Detect if cursor is on an API endpoint string
        const detected = detectEndpointAtPosition(document, position);
        
        if (!detected) {
            return null;
        }

        // Look up the endpoint in the index using endpoint and HTTP method
        const index = getEndpointIndex();
        const entry = index.getEntry(detected.endpoint, detected.httpMethod);

        // Build hover content
        const content = new vscode.MarkdownString();
        content.isTrusted = true;
        content.supportHtml = true;

        // Endpoint header with icon and HTTP method
        content.appendMarkdown(`### 🔗 API Endpoint\n\n`);
        content.appendMarkdown(`\`${detected.endpoint}\` **[${detected.httpMethod}]**\n\n`);

        if (entry) {
            // Status indicator
            const statusIcon = this.getStatusIcon(entry.status);
            content.appendMarkdown(`**Status:** ${statusIcon} ${entry.status}\n\n`);

            if (entry.backend) {
                // Backend info
                const backendPath = path.relative(
                    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
                    entry.backend.uri.fsPath
                );
                const line = entry.backend.range.start.line + 1;

                content.appendMarkdown(`**Backend Definition:**\n`);
                content.appendMarkdown(`- File: \`${backendPath}\`\n`);
                content.appendMarkdown(`- Line: ${line}\n`);
                if (entry.httpMethod) {
                    content.appendMarkdown(`- Method: \`HTTP ${entry.httpMethod}\`\n`);
                }
                content.appendMarkdown(`\n`);

                // Parameters
                if (entry.backendParams.length > 0) {
                    content.appendMarkdown(`**Route Parameters:** `);
                    content.appendMarkdown(entry.backendParams.map(p => `\`{${p}}\``).join(', '));
                    content.appendMarkdown(`\n\n`);
                }

                // Parameter mismatches
                if (entry.paramMismatches.length > 0) {
                    content.appendMarkdown(`**⚠️ Parameter Mismatches:**\n`);
                    for (const mismatch of entry.paramMismatches) {
                        content.appendMarkdown(
                            `- Position ${mismatch.position}: frontend \`\${${mismatch.frontendParam}}\` ≠ backend \`{${mismatch.backendParam}}\`\n`
                        );
                    }
                    content.appendMarkdown(`\n`);
                }

                // Click instruction
                content.appendMarkdown(`---\n`);
                content.appendMarkdown(`*Ctrl+Click to navigate to backend definition*`);
            } else {
                // No backend found
                content.appendMarkdown(`**⚠️ No backend definition found**\n\n`);
                content.appendMarkdown(`This endpoint is called from the frontend but has no corresponding controller action.`);
            }

            // Frontend calls count
            if (entry.frontends.length > 0) {
                content.appendMarkdown(`\n\n---\n`);
                content.appendMarkdown(`📍 **${entry.frontends.length}** frontend call site(s)`);
            }
        } else {
            content.appendMarkdown(`**⚠️ Endpoint not indexed**\n\n`);
            content.appendMarkdown(`Run "Refresh API Endpoints" to rebuild the index.`);
        }

        return new vscode.Hover(content, detected.range);
    }

    private getStatusIcon(status: string): string {
        switch (status) {
            case 'valid':
                return '✅';
            case 'invalid':
                return '❌';
            case 'unresolved':
                return '⚠️';
            case 'param-mismatch':
                return '⚡';
            default:
                return '❓';
        }
    }
}
