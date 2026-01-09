export type BackendKind = 'dotnet' | 'fastapi';

export interface FastApiEntrypoint {
    filePath: string;
    appVar: string;
}

export const FRONTEND_FILE_GLOBS = [
    '**/lib/api/**/*.client.ts',
    '**/lib/api/**/*.client.tsx',
    '**/lib/api/**/*.ts',
    '**/lib/api/**/*.tsx'
];

export const BACKEND_FILE_GLOBS_DOTNET = [
    '*Controller.cs',
    '*/*Controller.cs',
    '*/*/*Controller.cs',
    '*/*/*/*Controller.cs'
];

export const BACKEND_FILE_GLOBS_FASTAPI = [
    '**/*.py'
];

/**
 * Parses the FastAPI entrypoint string (format: "path/to/file.py:appVar")
 * Returns null if the format is invalid.
 */
export function parseFastapiEntrypoint(entrypoint: string): FastApiEntrypoint | null {
    if (!entrypoint || !entrypoint.includes(':')) {
        return null;
    }
    
    const lastColonIndex = entrypoint.lastIndexOf(':');
    const filePath = entrypoint.substring(0, lastColonIndex).trim();
    const appVar = entrypoint.substring(lastColonIndex + 1).trim();
    
    if (!filePath || !appVar || !filePath.endsWith('.py')) {
        return null;
    }
    
    return { filePath, appVar };
}

/**
 * Validates backend configuration and returns any error messages.
 */
export function validateBackendConfig(
    backendKind: BackendKind | undefined,
    fastapiEntrypoint: string | undefined
): string | null {
    if (!backendKind) {
        return 'Backend kind not configured. Please set apiNavigator.backendKind to "dotnet" or "fastapi".';
    }
    
    if (backendKind !== 'dotnet' && backendKind !== 'fastapi') {
        return `Invalid backend kind: "${backendKind}". Must be "dotnet" or "fastapi".`;
    }
    
    if (backendKind === 'fastapi') {
        if (!fastapiEntrypoint) {
            return 'FastAPI entrypoint not configured. Please set apiNavigator.fastapiEntrypoint (e.g., "app/main.py:app").';
        }
        
        const parsed = parseFastapiEntrypoint(fastapiEntrypoint);
        if (!parsed) {
            return `Invalid FastAPI entrypoint format: "${fastapiEntrypoint}". Expected format: "path/to/file.py:appVar".`;
        }
    }
    
    return null;
}