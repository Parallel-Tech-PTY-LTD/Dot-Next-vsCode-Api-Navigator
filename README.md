# Frontend to Backend API Navigator

Navigate between Next.js frontend `fetch()` calls and backend controller endpoints with **Ctrl+Click** navigation.

## Features

- **Go-to-Definition** � Ctrl+Click on a frontend API URL string to jump directly to the matching backend endpoint.
- **Hover Info** � Hover over an API URL in your frontend code to see the resolved backend endpoint details.
- **Endpoint Tree View** � Browse all discovered API endpoints in the Explorer sidebar panel.
- **Auto Refresh** � Automatically re-scans endpoints when files change.
- **Multi-backend support** � Works with ASP.NET Controllers (C#) and Python FastAPI.

## Extension Settings

| Setting | Default | Description |
|---|---|---|
| `apiNavigator.frontendRoot` | `./frontend` | Path to the Next.js frontend root folder (relative to workspace) |
| `apiNavigator.backendRoot` | `./backend` | Path to the backend root folder (relative to workspace) |
| `apiNavigator.backendKind` | � | Backend framework: `dotnet` or `fastapi` |
| `apiNavigator.fastapiEntrypoint` | `""` | FastAPI entrypoint, e.g. `app/main.py:app` (required for `fastapi`) |
| `apiNavigator.autoRefresh` | `true` | Automatically refresh endpoint index when files change |

## Getting Started

1. Open a workspace containing both frontend and backend projects.
2. Set `apiNavigator.frontendRoot` and `apiNavigator.backendRoot` to point at your project folders.
3. Select your `apiNavigator.backendKind` (`dotnet` or `fastapi`).
4. Use **Ctrl+Click** on any API URL string in your frontend code to navigate to the backend handler.

## Installing from Source

```bash
npm install
npx @vscode/vsce package
code --install-extension wired-0.0.1.vsix
```

Use `npx @vscode/vsce package` so packaging resolves the local build and validation dependencies from this workspace.

## Development

Open the project in VS Code and press **F5** to launch the Extension Development Host.
