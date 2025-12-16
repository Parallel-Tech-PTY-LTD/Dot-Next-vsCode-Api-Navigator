import * as vscode from "vscode";
import { EndpointTreeProvider } from "./EndpointTreeProvider";

export function activate(context: vscode.ExtensionContext) {
  const provider = new EndpointTreeProvider();

  vscode.window.registerTreeDataProvider(
    "dot-next-apiNavigator.endpoints",
    provider
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "apiNavigator.refresh",
      () => provider.refresh()
    )
  );

  // TEMP: Add a fake endpoint so you can see it working
  provider.setEndpoints([
    {
      endpoint: "/api/hello",
      frontend: new vscode.Location(
        vscode.Uri.file("/path/to/frontend/page.tsx"),
        new vscode.Range(10, 0, 10, 10)
      ),
      backend: new vscode.Location(
        vscode.Uri.file("/path/to/backend/HelloController.cs"),
        new vscode.Range(5, 0, 5, 10)
      ),
    },
  ]);
}
