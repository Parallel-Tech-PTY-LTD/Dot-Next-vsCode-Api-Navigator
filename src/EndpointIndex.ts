import * as vscode from 'vscode';
import { BackendEndpoint, scanBackendControllers } from './scanner/backendScanner';
import { scanFastApiEndpoints } from './scanner/backendScannerFastApi';
import { FrontendEndpoint, scanFrontendFiles } from './scanner/frontendScanner';
import { BackendKind } from './scanner/config';

export type EndpointStatus = 'valid' | 'invalid' | 'unresolved' | 'param-mismatch';

export interface ParamMismatch {
    position: number;
    frontendParam: string;
    backendParam: string;
}

export interface EndpointEntry {
    /** Normalized endpoint path (e.g., /api/users/{id}) */
    endpoint: string;
    /** Original endpoint with type constraints (e.g., /api/users/{id:guid}) */
    rawEndpoint?: string;
    /** Backend definition location (should be exactly one, first one if multiple) */
    backend?: vscode.Location;
    /** All backend definitions (for detecting duplicates) */
    backendDefinitions: Array<{
        location: vscode.Location;
        httpMethod: string;
        rawEndpoint: string;
    }>;
    /** Backend HTTP method (GET, POST, etc.) */
    httpMethod?: string;
    /** Backend route parameters in order */
    backendParams: string[];
    /** Frontend call site locations (zero or more) */
    frontends: Array<{
        location: vscode.Location;
        params: string[];
        rawEndpoint: string;
        httpMethod: string;
    }>;
    /** Validation status */
    status: EndpointStatus;
    /** Details about parameter mismatches if status is 'param-mismatch' */
    paramMismatches: ParamMismatch[];
    /** Error message for invalid endpoints (multiple backends) */
    errorMessage?: string;
}

/**
 * Central index of all API endpoints in the workspace.
 * Maintains the single source of truth for endpoint mappings.
 */
export class EndpointIndex {
    private endpoints: Map<string, EndpointEntry> = new Map();
    private _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;

    /**
     * Rebuilds the entire endpoint index by scanning frontend and backend files.
     * @param frontendRoot Absolute path to the frontend root folder
     * @param backendRoot Absolute path to the backend root folder
     * @param backendKind Backend framework type ('dotnet' or 'fastapi')
     * @param fastapiEntrypoint FastAPI entrypoint string (required when backendKind is 'fastapi')
     */
    async rebuild(
        frontendRoot: string, 
        backendRoot: string, 
        backendKind: BackendKind,
        fastapiEntrypoint?: string
    ): Promise<void> {
        this.endpoints.clear();

        // Scan backend based on backend kind
        let backendEndpoints: BackendEndpoint[];
        if (backendKind === 'fastapi') {
            if (!fastapiEntrypoint) {
                console.error('FastAPI entrypoint required but not provided');
                backendEndpoints = [];
            } else {
                backendEndpoints = await scanFastApiEndpoints(backendRoot, fastapiEntrypoint);
            }
        } else {
            // Default to ASP.NET controller scanning
            backendEndpoints = await scanBackendControllers(backendRoot);
        }
        
        // Scan frontend files
        const frontendEndpoints = await scanFrontendFiles(frontendRoot);

        // Index backend endpoints - key includes HTTP method
        for (const backend of backendEndpoints) {
            const normalizedEndpoint = this.normalizeEndpoint(backend.endpoint, backend.httpMethod);
            
            const existing = this.endpoints.get(normalizedEndpoint);
            if (existing) {
                // Multiple backend definitions for same path+method - mark as invalid
                existing.status = 'invalid';
                existing.backendDefinitions.push({
                    location: backend.location,
                    httpMethod: backend.httpMethod,
                    rawEndpoint: backend.rawEndpoint
                });
                existing.errorMessage = `Multiple backend definitions found (${existing.backendDefinitions.length} definitions)`;
            } else {
                this.endpoints.set(normalizedEndpoint, {
                    endpoint: backend.endpoint,
                    rawEndpoint: backend.rawEndpoint,
                    backend: backend.location,
                    backendDefinitions: [{
                        location: backend.location,
                        httpMethod: backend.httpMethod,
                        rawEndpoint: backend.rawEndpoint
                    }],
                    httpMethod: backend.httpMethod,
                    backendParams: backend.params,
                    frontends: [],
                    status: 'valid',
                    paramMismatches: []
                });
            }
        }

        // Index frontend endpoints - key includes HTTP method
        for (const frontend of frontendEndpoints) {
            const normalizedEndpoint = this.normalizeEndpoint(frontend.endpoint, frontend.httpMethod);
            
            let entry = this.endpoints.get(normalizedEndpoint);
            
            if (!entry) {
                // No backend definition found - create unresolved entry
                entry = {
                    endpoint: frontend.endpoint,
                    backend: undefined,
                    backendDefinitions: [],
                    httpMethod: frontend.httpMethod,
                    backendParams: [],
                    frontends: [],
                    status: 'unresolved',
                    paramMismatches: [],
                    errorMessage: 'No backend definition found'
                };
                this.endpoints.set(normalizedEndpoint, entry);
            }

            // Add frontend call site
            entry.frontends.push({
                location: frontend.location,
                params: frontend.params,
                rawEndpoint: frontend.rawEndpoint,
                httpMethod: frontend.httpMethod
            });

            // Validate parameter names match in order
            if (entry.backend && entry.status !== 'invalid') {
                const mismatches = this.validateParams(frontend.params, entry.backendParams);
                if (mismatches.length > 0) {
                    entry.status = 'param-mismatch';
                    entry.paramMismatches = mismatches;
                }
            }
        }

        this._onDidChange.fire();
    }

    /**
     * Normalizes an endpoint by replacing parameter placeholders with wildcards.
     * Strips query strings and includes HTTP method in the key for unique identification.
     * This allows matching endpoints with different parameter names but same path+method.
     */
    private normalizeEndpoint(endpoint: string, httpMethod: string): string {
        // Strip query string (everything after ?) as it doesn't affect backend routing
        let path = endpoint;
        const queryIndex = path.indexOf('?');
        if (queryIndex !== -1) {
            path = path.substring(0, queryIndex);
        }
        
        // Replace {param}, {param:type}, ${param} with a wildcard *
        const normalizedPath = path
            .replace(/\{[^}]+\}/g, '*')
            .replace(/\$\{[^}]+\}/g, '*')
            .toLowerCase();
        
        // Include HTTP method in key: "/api/users/*:GET"
        return `${normalizedPath}:${httpMethod.toUpperCase()}`;
    }

    /**
     * Validates that frontend and backend parameters match in order.
     * Returns array of mismatches if any.
     */
    private validateParams(frontendParams: string[], backendParams: string[]): ParamMismatch[] {
        const mismatches: ParamMismatch[] = [];
        const maxLength = Math.max(frontendParams.length, backendParams.length);

        for (let i = 0; i < maxLength; i++) {
            const frontendParam = frontendParams[i] || '';
            const backendParam = backendParams[i] || '';

            if (frontendParam !== backendParam) {
                mismatches.push({
                    position: i + 1,
                    frontendParam: frontendParam || '(missing)',
                    backendParam: backendParam || '(missing)'
                });
            }
        }

        return mismatches;
    }

    /**
     * Gets all endpoints as an array.
     */
    getAllEndpoints(): EndpointEntry[] {
        return Array.from(this.endpoints.values());
    }

    /**
     * Finds the backend location for a given endpoint and HTTP method.
     */
    findBackendForEndpoint(endpoint: string, httpMethod: string = 'GET'): vscode.Location | undefined {
        const normalizedEndpoint = this.normalizeEndpoint(endpoint, httpMethod);
        const entry = this.endpoints.get(normalizedEndpoint);
        return entry?.backend;
    }

    /**
     * Gets the full entry for an endpoint with HTTP method.
     */
    getEntry(endpoint: string, httpMethod: string = 'GET'): EndpointEntry | undefined {
        const normalizedEndpoint = this.normalizeEndpoint(endpoint, httpMethod);
        return this.endpoints.get(normalizedEndpoint);
    }

    /**
     * Clears the index.
     */
    clear(): void {
        this.endpoints.clear();
        this._onDidChange.fire();
    }
}

// Global singleton instance
let globalIndex: EndpointIndex | undefined;

export function getEndpointIndex(): EndpointIndex {
    if (!globalIndex) {
        globalIndex = new EndpointIndex();
    }
    return globalIndex;
}
