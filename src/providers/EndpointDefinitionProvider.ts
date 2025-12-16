import * as vscode from 'vscode';
import { getEndpointIndex } from '../EndpointIndex';
import { detectEndpointAtPosition } from '../scanner/frontendScanner';

/**
 * Provides "Go to Definition" support for API endpoints.
 * When user CTRL+clicks on a fetch("/api/...") call, navigates to the backend controller.
 */
export class EndpointDefinitionProvider implements vscode.DefinitionProvider {
    
    provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.Definition | vscode.LocationLink[]> {
        
        // Detect if cursor is on an API endpoint string
        const detected = detectEndpointAtPosition(document, position);
        
        if (!detected) {
            return null;
        }

        // Look up the backend location in the index using endpoint and HTTP method
        const index = getEndpointIndex();
        const backendLocation = index.findBackendForEndpoint(detected.endpoint, detected.httpMethod);

        if (!backendLocation) {
            // No backend definition found - show message
            vscode.window.showWarningMessage(
                `No backend definition found for endpoint: ${detected.endpoint} [${detected.httpMethod}]`
            );
            return null;
        }

        // Return as LocationLink for better UX (shows origin range)
        const locationLink: vscode.LocationLink = {
            originSelectionRange: detected.range,
            targetUri: backendLocation.uri,
            targetRange: backendLocation.range,
            targetSelectionRange: backendLocation.range
        };

        return [locationLink];
    }
}
