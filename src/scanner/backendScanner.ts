import * as vscode from 'vscode';
import { BACKEND_FILE_GLOBS } from './config';

export interface BackendEndpoint {
    endpoint: string;           // Normalized endpoint (constraints stripped)
    params: string[];           // Ordered parameter names
    location: vscode.Location;
    httpMethod: string;
    rawEndpoint: string;        // Original endpoint with constraints
}


async function scanContollerPattern(controllerPattern: vscode.RelativePattern): Promise<BackendEndpoint[]> {
  const endpoints: BackendEndpoint[] = [];
    const files = await vscode.workspace.findFiles(controllerPattern);

    for (const fileUri of files) {
        try {
            const fileEndpoints = await parseControllerFile(fileUri);
            endpoints.push(...fileEndpoints);
        } catch (e) {
            console.error(`Failed to parse ${fileUri.fsPath}: ${e}`);
        }
    }

    return endpoints;
}
/**
 * Scans ASP.NET Controller files for API endpoint definitions.
 * Uses improved regex patterns with multi-pass parsing for robustness.
 * 
 * Only scans /<*>Controllers folders as per copilot-instructions.md:
 * - Pattern: {backendRoot}/<*>/Controllers/*Controller.cs
 * 
 * Supports:
 * - [Route("api/[controller]")] class-level routes
 * - [HttpGet("{id:guid}")] with type constraints
 * - [HttpPost("flags/{flagId:guid}/documents/{documentId:guid}")] complex routes
 * - [action] placeholder substitution
 */
export async function scanBackendControllers(backendRoot: string): Promise<BackendEndpoint[]> {
        const endpoints: BackendEndpoint[] = [];

        // Scan using the configured globs from config.ts. Create a RelativePattern
        // for each glob and aggregate discovered endpoints.
        for (const glob of BACKEND_FILE_GLOBS) {
                console.log(`Using backend glob pattern: ${glob}`);
                const controllerPattern = new vscode.RelativePattern(backendRoot, glob);
                const scanned = await scanContollerPattern(controllerPattern);
                endpoints.push(...scanned);
        }

        return endpoints;
}

interface ControllerContext {
    name: string;               // Controller name without "Controller" suffix
    classRoute: string;         // Class-level [Route] value
    isApiController: boolean;
    classStartLine: number;
    classEndLine: number;
}

/**
 * Parses a single controller file to extract all API endpoints.
 */
async function parseControllerFile(fileUri: vscode.Uri): Promise<BackendEndpoint[]> {
    const endpoints: BackendEndpoint[] = [];
    const document = await vscode.workspace.openTextDocument(fileUri);
    const text = document.getText();
    const lines = text.split('\n');

    // First pass: Find controller class and its attributes
    const controller = findControllerContext(text, lines);
    if (!controller) {
        return endpoints;
    }

    // Second pass: Find all HTTP method endpoints within the controller
    const methodEndpoints = findMethodEndpoints(text, lines, controller, fileUri);
    endpoints.push(...methodEndpoints);

    return endpoints;
}

/**
 * Finds the controller class and extracts its context (route, name, etc.)
 */
function findControllerContext(text: string, lines: string[]): ControllerContext | null {
    // Match controller class declaration
    // Supports various patterns:
    // - public class UsersController : ControllerBase
    // - public class UsersController : Controller
    // - public abstract class BaseController : ControllerBase
    // - public class UsersController<T> : ControllerBase
    const classPattern = /public\s+(?:abstract\s+|sealed\s+)?class\s+(\w+)Controller\s*(?:<[^>]+>)?\s*:\s*(?:Controller|ControllerBase|ApiController|Microsoft\.AspNetCore\.Mvc\.Controller)/;
    
    let controllerName = '';
    let classStartLine = -1;
    let classEndLine = -1;

    // Find the class declaration
    for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(classPattern);
        if (match) {
            controllerName = match[1];
            classStartLine = i;
            break;
        }
    }

    if (!controllerName || classStartLine === -1) {
        return null;
    }

    // Find class end by tracking braces
    let braceCount = 0;
    let foundFirstBrace = false;
    for (let i = classStartLine; i < lines.length; i++) {
        const line = lines[i];
        for (const char of line) {
            if (char === '{') {
                braceCount++;
                foundFirstBrace = true;
            } else if (char === '}') {
                braceCount--;
            }
        }
        if (foundFirstBrace && braceCount === 0) {
            classEndLine = i;
            break;
        }
    }

    if (classEndLine === -1) {
        classEndLine = lines.length - 1;
    }

    // Look for class-level attributes (Route, ApiController) before the class declaration
    let classRoute = '';
    let isApiController = false;

    // Search backwards from class declaration for attributes
    for (let i = classStartLine - 1; i >= Math.max(0, classStartLine - 20); i--) {
        const line = lines[i].trim();
        
        // Stop if we hit another class or namespace
        if (/^\s*(public|private|internal|protected|class|namespace|interface)\s/.test(line) && !line.includes('[')) {
            break;
        }

        // Check for [ApiController]
        if (/\[ApiController\]/.test(line)) {
            isApiController = true;
        }

        // Check for [Route("...")] - extract the route value
        const routeMatch = line.match(/\[Route\s*\(\s*["']([^"']+)["']\s*\)\]/);
        if (routeMatch) {
            classRoute = routeMatch[1];
        }
    }

    return {
        name: controllerName,
        classRoute,
        isApiController,
        classStartLine,
        classEndLine
    };
}

/**
 * Finds all HTTP method endpoints within the controller.
 */
function findMethodEndpoints(
    text: string,
    lines: string[],
    controller: ControllerContext,
    fileUri: vscode.Uri
): BackendEndpoint[] {
    const endpoints: BackendEndpoint[] = [];

    // HTTP method attribute pattern - handles complex routes
    // Matches: [HttpGet], [HttpGet("route")], [HttpGet("{id:guid}")], [HttpPost("complex/{param:type}/path")]
    const httpMethodPattern = /\[Http(Get|Post|Put|Delete|Patch|Head|Options)\s*(?:\(\s*["']([^"']*?)["']\s*\))?\]/g;

    // Method declaration pattern - more comprehensive
    const methodDeclPattern = /(?:public|private|protected|internal)\s+(?:virtual\s+|override\s+|async\s+|static\s+)*(?:Task<)?(?:IActionResult|ActionResult(?:<[^>]+>)?|IHttpActionResult|JsonResult|ContentResult|OkObjectResult|[A-Za-z<>\[\],\s]+)>?\s+(\w+)\s*\(/;

    // Scan only within the controller class bounds
    for (let i = controller.classStartLine; i <= controller.classEndLine; i++) {
        const line = lines[i];
        
        // Reset regex for each line
        httpMethodPattern.lastIndex = 0;
        let match;

        while ((match = httpMethodPattern.exec(line)) !== null) {
            const httpMethod = match[1];
            const methodRoute = match[2] || '';

            // Find the action name by looking at subsequent lines
            let actionName = '';
            for (let j = i; j < Math.min(i + 15, controller.classEndLine); j++) {
                const methodMatch = lines[j].match(methodDeclPattern);
                if (methodMatch) {
                    actionName = methodMatch[1];
                    break;
                }
            }

            // Build the full endpoint
            const fullEndpoint = buildFullEndpoint(
                controller.classRoute,
                methodRoute,
                controller.name,
                actionName
            );

            // Extract parameters and normalize
            const params = extractRouteParams(fullEndpoint);
            const normalizedEndpoint = normalizeEndpoint(fullEndpoint);

            // Create location
            const position = new vscode.Position(i, 0);
            const range = new vscode.Range(position, position);
            const location = new vscode.Location(fileUri, range);

            endpoints.push({
                endpoint: normalizedEndpoint,
                params,
                location,
                httpMethod,
                rawEndpoint: fullEndpoint
            });
        }
    }

    return endpoints;
}

/**
 * Builds the full endpoint path from class route and method route.
 * 
 * Handles:
 * - [controller] → controller name (lowercase)
 * - [Controller] → controller name (lowercase, case-insensitive match)
 * - [action] → action/method name (lowercase)
 * - Combines class-level and method-level routes
 */
function buildFullEndpoint(
    classRoute: string,
    methodRoute: string,
    controllerName: string,
    actionName?: string
): string {
    let route = classRoute;

    // Replace [controller] placeholder (case-insensitive)
    route = route.replace(/\[controller\]/gi, controllerName.toLowerCase());

    // Replace [action] placeholder (case-insensitive)
    if (actionName) {
        route = route.replace(/\[action\]/gi, actionName.toLowerCase());
    }

    // Ensure route starts with /
    if (route && !route.startsWith('/')) {
        route = '/' + route;
    }

    // Process method route
    let processedMethodRoute = methodRoute;
    if (processedMethodRoute) {
        // Replace placeholders in method route too
        processedMethodRoute = processedMethodRoute.replace(/\[controller\]/gi, controllerName.toLowerCase());
        if (actionName) {
            processedMethodRoute = processedMethodRoute.replace(/\[action\]/gi, actionName.toLowerCase());
        }

        // Combine routes
        if (route && !route.endsWith('/') && processedMethodRoute && !processedMethodRoute.startsWith('/')) {
            route += '/';
        }
        route += processedMethodRoute;
    }

    // Ensure the route starts with /api if it doesn't already
    // (but don't add /api if route already has it or starts with api)
    if (route) {
        if (!route.toLowerCase().startsWith('/api') && !route.toLowerCase().startsWith('api')) {
            // Check if classRoute was "api/..." without leading slash
            if (classRoute.toLowerCase().startsWith('api')) {
                route = '/' + route.substring(1); // Just ensure leading slash
            } else {
                route = '/api' + route;
            }
        }
    } else {
        route = '/api';
    }

    // Clean up double slashes
    route = route.replace(/\/+/g, '/');

    // Remove trailing slash (unless it's just "/api")
    if (route.length > 1 && route.endsWith('/')) {
        route = route.slice(0, -1);
    }

    return route;
}

/**
 * Extracts route parameter names from an endpoint string.
 * 
 * Handles ASP.NET route parameter formats:
 * - {id} → "id"
 * - {id:int} → "id" 
 * - {id:guid} → "id"
 * - {flagId:guid} → "flagId"
 * - {id:int:min(1)} → "id" (multiple constraints)
 * - {*catchAll} → "catchAll" (catch-all)
 * - {**slug} → "slug" (catch-all with path segments)
 * - {id?} → "id" (optional)
 * - {id:int?} → "id" (optional with constraint)
 * 
 * Returns parameters in order of appearance.
 */
function extractRouteParams(endpoint: string): string[] {
    // Match {paramName}, {paramName:constraint}, {*paramName}, {**paramName}, optional {paramName?}
    // The constraint can be complex: {id:int:min(1):max(100)}
    const paramPattern = /\{(\*{0,2})([a-zA-Z_][a-zA-Z0-9_]*)(?::[^}]+)?(\?)?\}/g;
    const params: string[] = [];
    let match;

    while ((match = paramPattern.exec(endpoint)) !== null) {
        // match[1] = * or ** prefix (catch-all indicator)
        // match[2] = parameter name
        // match[3] = ? suffix (optional indicator)
        const paramName = match[2];
        if (paramName && !params.includes(paramName)) {
            params.push(paramName);
        }
    }

    return params;
}

/**
 * Normalizes an endpoint by stripping type constraints from parameters.
 * This is used for display and matching purposes.
 * 
 * Examples:
 * - /api/flags/{flagId:guid}/documents/{documentId:guid}
 *   → /api/flags/{flagId}/documents/{documentId}
 * - /api/users/{id:int:min(1)}
 *   → /api/users/{id}
 */
function normalizeEndpoint(endpoint: string): string {
    // Replace {*param:constraint} or {param:constraint} with {*param} or {param}
    // Preserves * or ** prefix and ? suffix, removes everything between : and } or ?
    return endpoint.replace(
        /\{(\*{0,2})([a-zA-Z_][a-zA-Z0-9_]*)(?::[^}?]+)?(\?)?\}/g,
        '{$1$2$3}'
    );
}
