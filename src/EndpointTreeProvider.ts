import * as vscode from "vscode";

export interface EndpointItem {
  endpoint: string;
  frontend: vscode.Location;
  backend?: vscode.Location;
}

export class EndpointTreeProvider
  implements vscode.TreeDataProvider<EndpointItem> {

  private _onDidChangeTreeData =
    new vscode.EventEmitter<void>();

  readonly onDidChangeTreeData =
    this._onDidChangeTreeData.event;

  private endpoints: EndpointItem[] = [];

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  setEndpoints(endpoints: EndpointItem[]) {
    this.endpoints = endpoints;
    this.refresh();
  }

  getTreeItem(item: EndpointItem): vscode.TreeItem {
    const treeItem = new vscode.TreeItem(
      item.endpoint,
      vscode.TreeItemCollapsibleState.Collapsed
    );

    treeItem.description = "API Endpoint";
    treeItem.tooltip = item.endpoint;
    
    return treeItem;
  }

  getChildren(item?: EndpointItem): Thenable<any[]> {
    if (!item) {
      return Promise.resolve(this.endpoints);
    }

    const children = [];

    children.push(
      this.locationItem("Frontend", item.frontend)
    );

    if (item.backend) {
      children.push(
        this.locationItem("Backend", item.backend)
      );
    }

    return Promise.resolve(children);
  }

  private locationItem(
    label: string,
    location: vscode.Location
  ): vscode.TreeItem {
    const line = location.range.start.line + 1;

    const item = new vscode.TreeItem(
      `${label}: ${location.uri.fsPath}:${line}`
    );

    item.command = {
      command: "vscode.open",
      title: "Open",
      arguments: [
        location.uri,
        {
          selection: location.range,
        },
      ],
    };

    item.iconPath =
      label === "Frontend"
        ? new vscode.ThemeIcon("file-code")
        : new vscode.ThemeIcon("symbol-method");

    return item;
  }
}
