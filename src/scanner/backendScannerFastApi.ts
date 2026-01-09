import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { BackendEndpoint } from './backendScanner';
import { 
  FastApiEntrypoint, 
  parseFastapiEntrypoint 
} from './config';

/** Maximum recursion depth for import traversal */
const MAX_IMPORT_DEPTH = 10;

/** Cache of workspace package/folder names for import filtering */
let workspacePackages: Set<string> | null = null;

/**
 * Information about a router/app instance found in a Python file.
 */
interface RouterInfo {
  varName: string;
  prefix: string;
}

/**
 * Scans FastAPI Python files for API endpoint definitions.
 * 
 * Starts from the entrypoint file (e.g., main.py:app), parses decorator-based
 * routes (@app.get, @router.post, etc.), and follows include_router() calls
 * to discover nested routers.
 * 
 * Only follows imports that match workspace folder/package names to avoid
 * traversing into site-packages or external libraries.
 */
export async function scanFastApiEndpoints(
    backendRoot: string,
    entrypointStr: string
): Promise<BackendEndpoint[]> {
    const entrypoint = parseFastapiEntrypoint(entrypointStr);
    if (!entrypoint) {
        console.error(`Invalid FastAPI entrypoint: ${entrypointStr}`);
        return [];
    }
    
    // Build workspace package cache
    workspacePackages = await getWorkspacePackages(backendRoot);

    const entrypointPath = path.join(backendRoot, entrypoint.filePath);
    
    if (!fs.existsSync(entrypointPath)) {
        console.error(`FastAPI entrypoint file not found: ${entrypointPath}`);
        return [];
    }

    const endpoints: BackendEndpoint[] = [];
    const visitedFiles = new Set<string>();

    // Start scanning from entrypoint
    await scanPythonFile(
        entrypointPath,
        backendRoot,
        entrypoint.appVar,
        '',  // No prefix for root app
        endpoints,
        visitedFiles,
        0
    );

    return endpoints;
}

/**
 * Gets all folder/package names in the workspace to filter imports.
 */
async function getWorkspacePackages(backendRoot: string): Promise<Set<string>> {
    const packages = new Set<string>();
    
    try {
        const entries = fs.readdirSync(backendRoot, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== '__pycache__') {
                packages.add(entry.name);
            }
            // Also add Python files as potential module names
            if (entry.isFile() && entry.name.endsWith('.py')) {
                packages.add(entry.name.replace('.py', ''));
            }
        }
    } catch (e) {
        console.error(`Failed to read backend root: ${e}`);
    }
    
    return packages;
}

/**
 * Scans a single Python file for FastAPI endpoints and include_router calls.
 */
async function scanPythonFile(
    filePath: string,
    backendRoot: string,
    targetVar: string,
    routePrefix: string,
    endpoints: BackendEndpoint[],
    visitedFiles: Set<string>,
    depth: number
): Promise<void> {
    // Prevent infinite recursion and revisiting files
    const normalizedPath = path.normalize(filePath).toLowerCase();
    if (visitedFiles.has(normalizedPath) || depth > MAX_IMPORT_DEPTH) {
        return;
    }
    visitedFiles.add(normalizedPath);

    let content: string;
    try {
        content = fs.readFileSync(filePath, 'utf-8');
    } catch (e) {
        console.error(`Failed to read ${filePath}: ${e}`);
        return;
    }

    const lines = content.split('\n');
    const fileUri = vscode.Uri.file(filePath);

    // Track router variables defined in this file
    const routers = new Map<string, RouterInfo>();
    
    // The target variable (app or router) we're looking for
    routers.set(targetVar, { varName: targetVar, prefix: routePrefix });

    // Also detect new router definitions: router = APIRouter()
    const routerDefPattern = /^(\w+)\s*=\s*(?:fastapi\.)?APIRouter\s*\(/;
    for (const line of lines) {
        const match = line.match(routerDefPattern);
        if (match) {
            const varName = match[1];
            if (!routers.has(varName)) {
                routers.set(varName, { varName, prefix: '' });
            }
        }
    }

    // Scan for route decorators and include_router calls
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Check for route decorators: @app.get("/path"), @router.post("/path/{id}")
        const decoratorMatch = line.match(/@(\w+)\.(get|post|put|delete|patch|head|options)\s*\(\s*["']([^"']*?)["']/i);
        if (decoratorMatch) {
            const routerVar = decoratorMatch[1];
            const httpMethod = decoratorMatch[2].toUpperCase();
            const routePath = decoratorMatch[3];

            const router = routers.get(routerVar);
            if (router) {
                const fullPath = buildFullPath(router.prefix, routePath);
                const params = extractRouteParams(fullPath);
                const normalizedEndpoint = normalizeEndpoint(fullPath);

                const position = new vscode.Position(i, 0);
                const range = new vscode.Range(position, position);
                const location = new vscode.Location(fileUri, range);

                endpoints.push({
                    endpoint: normalizedEndpoint,
                    params,
                    location,
                    httpMethod,
                    rawEndpoint: fullPath
                });
            }
        }

        // Check for include_router calls:
        // app.include_router(users_router, prefix="/api/users")
        // app.include_router(router, prefix="/api/items", tags=["items"])
        const includeMatch = line.match(/(\w+)\.include_router\s*\(\s*(\w+)(?:\s*,\s*prefix\s*=\s*["']([^"']*?)["'])?/);
        if (includeMatch) {
            const parentVar = includeMatch[1];
            const childRouter = includeMatch[2];
            const prefix = includeMatch[3] || '';

            const parentRouter = routers.get(parentVar);
            if (parentRouter) {
                const combinedPrefix = buildFullPath(parentRouter.prefix, prefix);
                
                // Look for where childRouter is imported from
                const importInfo = findImportSource(content, childRouter, backendRoot, filePath);
                if (importInfo) {
                    await scanPythonFile(
                        importInfo.filePath,
                        backendRoot,
                        importInfo.varName,
                        combinedPrefix,
                        endpoints,
                        visitedFiles,
                        depth + 1
                    );
                } else {
                    // Router might be defined in this file, scan with the new prefix
                    if (routers.has(childRouter)) {
                        const childInfo = routers.get(childRouter)!;
                        childInfo.prefix = combinedPrefix;
                    }
                }
            }
        }
    }
}

/**
 * Finds the source file and variable name for an imported router.
 * Only follows imports that match workspace package names.
 */
function findImportSource(
    content: string,
    varName: string,
    backendRoot: string,
    currentFile: string
): { filePath: string; varName: string } | null {
    const lines = content.split('\n');
    const currentDir = path.dirname(currentFile);

    for (const line of lines) {
        // from app.routers.users import router
        // from app.routers.users import router as users_router
        const fromImportMatch = line.match(/from\s+([\w.]+)\s+import\s+([^#\n]+)/);
        if (fromImportMatch) {
            const modulePath = fromImportMatch[1];
            const imports = fromImportMatch[2];

            // Check if this import brings in our variable
            const importItems = imports.split(',').map(s => s.trim());
            for (const item of importItems) {
                // Handle "router as users_router" syntax
                const aliasMatch = item.match(/(\w+)\s+as\s+(\w+)/);
                if (aliasMatch) {
                    if (aliasMatch[2] === varName) {
                        const resolved = resolveModulePath(modulePath, backendRoot, currentDir);
                        if (resolved) {
                            return { filePath: resolved, varName: aliasMatch[1] };
                        }
                    }
                } else if (item === varName) {
                    const resolved = resolveModulePath(modulePath, backendRoot, currentDir);
                    if (resolved) {
                        return { filePath: resolved, varName };
                    }
                }
            }
        }

        // import app.routers.users as users_module
        const importAsMatch = line.match(/import\s+([\w.]+)\s+as\s+(\w+)/);
        if (importAsMatch && importAsMatch[2] === varName) {
            const modulePath = importAsMatch[1];
            const resolved = resolveModulePath(modulePath, backendRoot, currentDir);
            if (resolved) {
                return { filePath: resolved, varName: 'router' };  // Assume default router
            }
        }
    }

    return null;
}

/**
 * Resolves a Python module path to an absolute file path.
 * Only resolves if the root package is in our workspace packages list.
 */
function resolveModulePath(
    modulePath: string,
    backendRoot: string,
    currentDir: string
): string | null {
    const parts = modulePath.split('.');
    
    // Check if the root package is in our workspace
    const rootPackage = parts[0];
    if (!workspacePackages?.has(rootPackage)) {
        // Not a workspace package, skip (likely site-packages)
        return null;
    }

    // Try to resolve as a file path
    // app.routers.users -> app/routers/users.py or app/routers/users/__init__.py
    const relativePath = parts.join(path.sep);
    
    // Try as a .py file first
    const pyFilePath = path.join(backendRoot, relativePath + '.py');
    if (fs.existsSync(pyFilePath)) {
        return pyFilePath;
    }

    // Try as a package (__init__.py)
    const initPath = path.join(backendRoot, relativePath, '__init__.py');
    if (fs.existsSync(initPath)) {
        return initPath;
    }

    // Try relative to current directory for relative imports
    if (parts[0] === '') {
        // Relative import like ".routers"
        const relPath = parts.slice(1).join(path.sep);
        const relPyPath = path.join(currentDir, relPath + '.py');
        if (fs.existsSync(relPyPath)) {
            return relPyPath;
        }
    }

    return null;
}

/**
 * Builds a full API path by combining prefix and route path.
 */
function buildFullPath(prefix: string, routePath: string): string {
    let full = prefix;
    
    // Ensure prefix has leading slash
    if (full && !full.startsWith('/')) {
        full = '/' + full;
    }
    
    // Handle route path
    let route = routePath;
    if (route && !route.startsWith('/')) {
        route = '/' + route;
    }
    
    // Combine
    if (full && route) {
        // Avoid double slashes
        if (full.endsWith('/') && route.startsWith('/')) {
            full = full + route.substring(1);
        } else {
            full = full + route;
        }
    } else {
        full = full || route || '/';
    }
    
    // Clean up double slashes
    full = full.replace(/\/+/g, '/');
    
    // Remove trailing slash (unless it's just "/")
    if (full.length > 1 && full.endsWith('/')) {
        full = full.slice(0, -1);
    }
    
    return full;
}

/**
 * Extracts route parameter names from a FastAPI path.
 * 
 * FastAPI uses {param} or {param:type} syntax, similar to ASP.NET.
 * Examples:
 * - /users/{user_id} -> ["user_id"]
 * - /items/{item_id:int} -> ["item_id"]
 * - /files/{file_path:path} -> ["file_path"]
 */
function extractRouteParams(endpoint: string): string[] {
    const paramPattern = /\{([a-zA-Z_][a-zA-Z0-9_]*)(?::[^}]+)?\}/g;
    const params: string[] = [];
    let match;

    while ((match = paramPattern.exec(endpoint)) !== null) {
        const paramName = match[1];
        if (paramName && !params.includes(paramName)) {
            params.push(paramName);
        }
    }

    return params;
}

/**
 * Normalizes an endpoint by stripping type constraints from parameters.
 * 
 * Example: /items/{item_id:int} -> /items/{item_id}
 */
function normalizeEndpoint(endpoint: string): string {
    return endpoint.replace(
        /\{([a-zA-Z_][a-zA-Z0-9_]*)(?::[^}]+)?\}/g,
        '{$1}'
    );
}
