import * as vscode from 'vscode';
import { parse, AST_NODE_TYPES, TSESTree } from '@typescript-eslint/typescript-estree';

export interface FrontendEndpoint {
    endpoint: string;
    params: string[];
    location: vscode.Location;
    rawEndpoint: string;
    httpMethod: string;  // HTTP method (GET, POST, PUT, DELETE, PATCH) - defaults to GET
}

/**
 * Scans TypeScript/TSX files for API endpoint calls using AST parsing.
 * Detects fetch(), axios.get/post/put/delete() calls.
 * 
 * Only scans files in /lib/api folder:
 * - *.client.ts, *.client.tsx (client-specific API files)
 * - *.ts, *.tsx (general API files)
 */
export async function scanFrontendFiles(frontendRoot: string): Promise<FrontendEndpoint[]> {
    const endpoints: FrontendEndpoint[] = [];

    // Only scan /lib/api folder as per copilot-instructions.md
    const apiFolder = 'lib/api';
    
    // File patterns: *.client.ts, *.client.tsx, *.ts, *.tsx
    const tsPattern = new vscode.RelativePattern(frontendRoot, `${apiFolder}/**/*.{ts,tsx,client.ts,client.tsx}`);
    const files = await vscode.workspace.findFiles(tsPattern, '**/node_modules/**');

    for (const fileUri of files) {
        try {
            const fileEndpoints = await parseFrontendFileAST(fileUri);
            endpoints.push(...fileEndpoints);
        } catch (e) {
            // Fallback to regex if AST parsing fails
            console.warn(`AST parse failed for ${fileUri.fsPath}, using regex fallback: ${e}`);
            const fileEndpoints = await parseFrontendFileRegex(fileUri);
            endpoints.push(...fileEndpoints);
        }
    }

    return endpoints;
}

/**
 * AST-based parsing for TypeScript/TSX files.
 * More accurate than regex, handles multi-line, nested expressions.
 */
async function parseFrontendFileAST(fileUri: vscode.Uri): Promise<FrontendEndpoint[]> {
    const endpoints: FrontendEndpoint[] = [];
    const document = await vscode.workspace.openTextDocument(fileUri);
    const code = document.getText();

    const ast = parse(code, {
        jsx: true,
        loc: true,
        range: true,
        errorOnUnknownASTType: false,
    });

    // Walk the AST to find fetch() and axios calls
    walkNode(ast, (node: TSESTree.Node) => {
        const endpoint = extractEndpointFromNode(node);
        if (endpoint) {
            const location = new vscode.Location(
                fileUri,
                new vscode.Range(
                    new vscode.Position(endpoint.line - 1, endpoint.column),
                    new vscode.Position(endpoint.line - 1, endpoint.column + endpoint.raw.length)
                )
            );

            endpoints.push({
                endpoint: endpoint.normalized,
                params: endpoint.params,
                location,
                rawEndpoint: endpoint.raw,
                httpMethod: endpoint.httpMethod
            });
        }
    });

    return endpoints;
}

interface ExtractedEndpoint {
    raw: string;
    normalized: string;
    params: string[];
    line: number;
    column: number;
    httpMethod: string;  // HTTP method extracted from call - defaults to GET
}

/**
 * Extracts API endpoint from a CallExpression node.
 * Captures HTTP method from axios methods or fetch options.
 * Defaults to GET if method cannot be determined.
 */
function extractEndpointFromNode(node: TSESTree.Node): ExtractedEndpoint | null {
    if (node.type !== AST_NODE_TYPES.CallExpression) {
        return null;
    }

    const callee = node.callee;

    // Check for fetch() call - method comes from options object if present
    if (callee.type === AST_NODE_TYPES.Identifier && callee.name === 'fetch') {
        const result = extractFromArgument(node.arguments[0]);
        if (result) {
            // Check for method in fetch options (second argument)
            const options = node.arguments[1];
            if (options?.type === AST_NODE_TYPES.ObjectExpression) {
                const methodProp = options.properties.find(
                    (p): p is TSESTree.Property =>
                        p.type === AST_NODE_TYPES.Property &&
                        p.key.type === AST_NODE_TYPES.Identifier &&
                        p.key.name === 'method'
                );
                if (methodProp?.value.type === AST_NODE_TYPES.Literal && typeof methodProp.value.value === 'string') {
                    result.httpMethod = methodProp.value.value.toUpperCase();
                }
            }
        }
        return result;
    }

    // Check for axios.get/post/put/delete/patch() call
    if (callee.type === AST_NODE_TYPES.MemberExpression) {
        const obj = callee.object;
        const prop = callee.property;

        // axios.get(), axios.post(), etc. - method is derived from function name
        if (obj.type === AST_NODE_TYPES.Identifier && obj.name === 'axios' &&
            prop.type === AST_NODE_TYPES.Identifier &&
            ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'].includes(prop.name)) {
            const result = extractFromArgument(node.arguments[0]);
            if (result) {
                result.httpMethod = prop.name.toUpperCase();
            }
            return result;
        }

        // axios({url: '/api/...', method: '...'}) - object config style
        if (obj.type === AST_NODE_TYPES.Identifier && obj.name === 'axios' &&
            node.arguments[0]?.type === AST_NODE_TYPES.ObjectExpression) {
            const urlProp = node.arguments[0].properties.find(
                (p): p is TSESTree.Property =>
                    p.type === AST_NODE_TYPES.Property &&
                    p.key.type === AST_NODE_TYPES.Identifier &&
                    p.key.name === 'url'
            );
            if (urlProp) {
                const result = extractFromArgument(urlProp.value);
                if (result) {
                    // Look for method property
                    const methodProp = node.arguments[0].properties.find(
                        (p): p is TSESTree.Property =>
                            p.type === AST_NODE_TYPES.Property &&
                            p.key.type === AST_NODE_TYPES.Identifier &&
                            p.key.name === 'method'
                    );
                    if (methodProp?.value.type === AST_NODE_TYPES.Literal && typeof methodProp.value.value === 'string') {
                        result.httpMethod = methodProp.value.value.toUpperCase();
                    }
                }
                return result;
            }
        }
    }

    // Check for fetch with Request object: fetch(new Request('/api/...'))
    if (callee.type === AST_NODE_TYPES.Identifier && callee.name === 'fetch' &&
        node.arguments[0]?.type === AST_NODE_TYPES.NewExpression) {
        const newExpr = node.arguments[0];
        if (newExpr.callee.type === AST_NODE_TYPES.Identifier &&
            newExpr.callee.name === 'Request') {
            return extractFromArgument(newExpr.arguments[0]);
        }
    }

    return null;
}

/**
 * Extracts endpoint string from an AST argument node.
 * Handles string literals and template literals.
 */
function extractFromArgument(arg: TSESTree.Node | undefined): ExtractedEndpoint | null {
    if (!arg) {
        return null;
    }

    // String literal: "/api/users"
    if (arg.type === AST_NODE_TYPES.Literal && typeof arg.value === 'string') {
        const value = arg.value;
        if (value.startsWith('/api/') || value.startsWith('api/')) {
            const normalized = value.startsWith('/') ? value : '/' + value;
            return {
                raw: value,
                normalized,
                params: [],
                line: arg.loc.start.line,
                column: arg.loc.start.column,
                httpMethod: 'GET'  // Default to GET
            };
        }
    }

    // Template literal: `/api/users/${id}`
    if (arg.type === AST_NODE_TYPES.TemplateLiteral) {
        const { raw, normalized, params } = processTemplateLiteral(arg);
        if (raw.startsWith('/api/') || raw.startsWith('api/')) {
            const normalizedPath = normalized.startsWith('/') ? normalized : '/' + normalized;
            return {
                raw,
                normalized: normalizedPath,
                params,
                line: arg.loc.start.line,
                column: arg.loc.start.column,
                httpMethod: 'GET'  // Default to GET
            };
        }
    }

    // Binary expression (string concatenation): "/api/users/" + id
    if (arg.type === AST_NODE_TYPES.BinaryExpression && arg.operator === '+') {
        const result = processBinaryExpression(arg);
        if (result && (result.raw.startsWith('/api/') || result.raw.startsWith('api/'))) {
            const normalizedPath = result.normalized.startsWith('/') ? result.normalized : '/' + result.normalized;
            return {
                ...result,
                normalized: normalizedPath,
                httpMethod: 'GET'  // Default to GET
            };
        }
    }

    return null;
}

/**
 * Processes a template literal to extract the endpoint string and parameters.
 * Distinguishes between route parameters (preceded by /) and query parameters (not preceded by /).
 * Query parameters are stripped from the normalized path.
 * 
 * Examples:
 * - `/api/users/${id}` → route param, keeps {id}
 * - `/api/users/${id}/posts` → route param, keeps {id}
 * - `/api/Users${query}` → query param, strips to /api/Users
 * - `/api/users?page=${page}` → query param after ?, strips to /api/users
 */
function processTemplateLiteral(node: TSESTree.TemplateLiteral): { raw: string; normalized: string; params: string[] } {
    const params: string[] = [];  // Only route params, not query params
    let raw = '';
    let normalized = '';

    for (let i = 0; i < node.quasis.length; i++) {
        const quasi = node.quasis[i];
        const quasiValue = quasi.value.raw;
        
        raw += quasiValue;
        normalized += quasiValue;

        if (i < node.expressions.length) {
            const expr = node.expressions[i];
            const paramName = extractParamName(expr);
            
            // Check if this is a route param or query param
            // Route param: preceded by / (e.g., /api/users/${id})
            // Query param: not preceded by / (e.g., /api/Users${query} or ?page=${page})
            const isRouteParam = quasiValue.endsWith('/');
            
            raw += '${' + paramName + '}';
            
            if (isRouteParam) {
                // This is a route parameter - include in normalized path
                params.push(paramName);
                normalized += '{' + paramName + '}';
            }
            // else: Query parameter - don't add to normalized path or params
        }
    }

    // Strip any explicit query string (everything after ?)
    const queryIndex = normalized.indexOf('?');
    if (queryIndex !== -1) {
        normalized = normalized.substring(0, queryIndex);
    }

    return { raw, normalized, params };
}

/**
 * Processes a binary expression (string concatenation) to extract endpoint.
 */
function processBinaryExpression(node: TSESTree.BinaryExpression): ExtractedEndpoint | null {
    const parts: string[] = [];
    const params: string[] = [];

    function traverse(n: TSESTree.Node): void {
        if (n.type === AST_NODE_TYPES.Literal && typeof n.value === 'string') {
            parts.push(n.value);
        } else if (n.type === AST_NODE_TYPES.BinaryExpression && n.operator === '+') {
            traverse(n.left);
            traverse(n.right);
        } else if (n.type === AST_NODE_TYPES.Identifier) {
            params.push(n.name);
            parts.push('{' + n.name + '}');
        } else if (n.type === AST_NODE_TYPES.MemberExpression) {
            const paramName = extractParamName(n);
            params.push(paramName);
            parts.push('{' + paramName + '}');
        }
    }

    traverse(node);

    const normalized = parts.join('');
    return {
        raw: normalized,
        normalized,
        params,
        line: node.loc.start.line,
        column: node.loc.start.column,
        httpMethod: 'GET'  // Default to GET for binary expressions
    };
}

/**
 * Extracts a parameter name from an expression node.
 */
function extractParamName(expr: TSESTree.Node): string {
    // Simple identifier: ${userId}
    if (expr.type === AST_NODE_TYPES.Identifier) {
        return expr.name;
    }
    // Member expression: ${user.id} or ${params.userId}
    if (expr.type === AST_NODE_TYPES.MemberExpression) {
        if (expr.property.type === AST_NODE_TYPES.Identifier) {
            return expr.property.name;
        }
        // Computed property: ${obj["id"]}
        if (expr.property.type === AST_NODE_TYPES.Literal) {
            return String(expr.property.value);
        }
    }
    // Call expression: ${getId()}
    if (expr.type === AST_NODE_TYPES.CallExpression && expr.callee.type === AST_NODE_TYPES.Identifier) {
        return expr.callee.name;
    }
    // Fallback
    return 'param';
}

/**
 * Walks the AST tree and calls callback for each node.
 */
function walkNode(node: TSESTree.Node, callback: (node: TSESTree.Node) => void): void {
    callback(node);

    for (const key of Object.keys(node)) {
        const child = (node as unknown as Record<string, unknown>)[key];
        if (child && typeof child === 'object') {
            if (Array.isArray(child)) {
                child.forEach(c => {
                    if (c && typeof c === 'object' && 'type' in c) {
                        walkNode(c as TSESTree.Node, callback);
                    }
                });
            } else if ('type' in child) {
                walkNode(child as TSESTree.Node, callback);
            }
        }
    }
}

/**
 * Regex-based fallback parser for when AST parsing fails.
 * Captures HTTP method from axios calls, defaults to GET for fetch.
 */
async function parseFrontendFileRegex(fileUri: vscode.Uri): Promise<FrontendEndpoint[]> {
    const endpoints: FrontendEndpoint[] = [];
    const document = await vscode.workspace.openTextDocument(fileUri);
    const text = document.getText();
    const lines = text.split('\n');

    // Patterns with method extraction - capture method name for axios
    const patterns: Array<{ regex: RegExp; group: number; methodGroup?: number; defaultMethod: string }> = [
        { regex: /fetch\s*\(\s*["'`](\/api\/[^"'`]+)["'`]/g, group: 1, defaultMethod: 'GET' },
        { regex: /axios\s*\.\s*(get|post|put|delete|patch)\s*\(\s*["'`](\/api\/[^"'`]+)["'`]/gi, group: 2, methodGroup: 1, defaultMethod: 'GET' }
    ];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        for (const { regex, group, methodGroup, defaultMethod } of patterns) {
            regex.lastIndex = 0;
            let match;
            while ((match = regex.exec(line)) !== null) {
                const rawEndpoint = match[group];
                const httpMethod = methodGroup !== undefined ? match[methodGroup].toUpperCase() : defaultMethod;
                const { normalized, params } = processEndpointString(rawEndpoint);

                const position = new vscode.Position(i, match.index);
                const range = new vscode.Range(position, position);
                const location = new vscode.Location(fileUri, range);

                endpoints.push({
                    endpoint: normalized,
                    params,
                    location,
                    rawEndpoint,
                    httpMethod
                });
            }
        }
    }

    return endpoints;
}

/**
 * Processes an endpoint string and extracts parameters.
 */
function processEndpointString(rawEndpoint: string): { normalized: string; params: string[] } {
    const params: string[] = [];
    const paramPattern = /\$\{([^}]+)\}/g;
    let match;

    while ((match = paramPattern.exec(rawEndpoint)) !== null) {
        params.push(match[1]);
    }

    const normalized = rawEndpoint.replace(/\$\{([^}]+)\}/g, '{$1}');
    return { normalized, params };
}

/**
 * Detects if a position in a document is within an API endpoint string.
 * Uses AST for accurate detection.
 * Returns endpoint, HTTP method, and range.
 */
export function detectEndpointAtPosition(
    document: vscode.TextDocument,
    position: vscode.Position
): { endpoint: string; httpMethod: string; range: vscode.Range } | null {
    const code = document.getText();

    try {
        const ast = parse(code, {
            jsx: true,
            loc: true,
            range: true,
            errorOnUnknownASTType: false,
        });

        let result: { endpoint: string; httpMethod: string; range: vscode.Range } | null = null;

        walkNode(ast, (node: TSESTree.Node) => {
            if (result) {
                return; // Already found
            }

            const endpoint = extractEndpointFromNode(node);
            if (endpoint) {
                const startLine = endpoint.line - 1;
                const startCol = endpoint.column;
                const endCol = startCol + endpoint.raw.length + 2; // +2 for quotes

                // Check if cursor is within this endpoint
                if (position.line === startLine &&
                    position.character >= startCol &&
                    position.character <= endCol) {
                    result = {
                        endpoint: endpoint.normalized,
                        httpMethod: endpoint.httpMethod,
                        range: new vscode.Range(
                            new vscode.Position(startLine, startCol),
                            new vscode.Position(startLine, endCol)
                        )
                    };
                }
            }
        });

        return result;
    } catch (e) {
        // Fallback to regex detection
        return detectEndpointAtPositionRegex(document, position);
    }
}

/**
 * Regex-based fallback for endpoint detection at position.
 * Extracts HTTP method from axios calls, defaults to GET.
 */
function detectEndpointAtPositionRegex(
    document: vscode.TextDocument,
    position: vscode.Position
): { endpoint: string; httpMethod: string; range: vscode.Range } | null {
    const line = document.lineAt(position.line).text;

    // Patterns with method extraction
    const patterns: Array<{ regex: RegExp; group: number; methodGroup?: number; defaultMethod: string }> = [
        { regex: /fetch\s*\(\s*["'`](\/api\/[^"'`]+)["'`]/g, group: 1, defaultMethod: 'GET' },
        { regex: /axios\s*\.\s*(get|post|put|delete|patch)\s*\(\s*["'`](\/api\/[^"'`]+)["'`]/gi, group: 2, methodGroup: 1, defaultMethod: 'GET' }
    ];

    for (const { regex, group, methodGroup, defaultMethod } of patterns) {
        regex.lastIndex = 0;
        let match;

        while ((match = regex.exec(line)) !== null) {
            const endpoint = match[group];
            const httpMethod = methodGroup !== undefined ? match[methodGroup].toUpperCase() : defaultMethod;
            const matchStart = match.index;

            const endpointStart = line.indexOf(endpoint, matchStart);
            const endpointEnd = endpointStart + endpoint.length;

            if (position.character >= endpointStart && position.character <= endpointEnd) {
                const range = new vscode.Range(
                    new vscode.Position(position.line, endpointStart),
                    new vscode.Position(position.line, endpointEnd)
                );

                const normalized = endpoint.replace(/\$\{([^}]+)\}/g, '{$1}');
                return { endpoint: normalized, httpMethod, range };
            }
        }
    }

    return null;
}
