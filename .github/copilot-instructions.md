# VS Code Extension – API Endpoint Navigator

This repository contains a VS Code extension that links **Next.js frontend API calls** to a **single authoritative ASP.NET backend definition**.

This file defines **Copilot instructions** and **architectural rules**. Copilot must follow these strictly when generating or modifying code.

---

## 🎯 Core Goal

Build a VS Code extension that:

1. Lets the user **configure**:

   * The root folder of a **Next.js frontend**
   * The root folder of an **ASP.NET (.NET) backend**

2. Scans both projects to build an **API endpoint index**

3. Enforces:

   * **Exactly one backend definition per endpoint**
   * **Zero or more frontend call sites per endpoint**

4. Displays all endpoints in a **left sidebar Tree View**

5. Enables navigation:

   * Click frontend call → jump to file + line
   * Click backend definition → jump to file + line
   * **CTRL + Hover + Click on frontend endpoint → jump directly to backend definition**

---

## 🧭 Navigation Rules (Critical)

* Every API endpoint:

  * **MUST have exactly one backend definition**
  * **MAY have multiple frontend call sites**

* If more than one backend definition is detected:

  * The endpoint must be marked as **INVALID**
  * A warning icon must be shown in the sidebar

* If no backend definition exists:

  * The endpoint must be marked as **UNRESOLVED**

---

## 📁 User Configuration

Copilot must assume a settings-based configuration model:

```json
{
  "apiNavigator.frontendRoot": "./frontend",
  "apiNavigator.backendRoot": "./backend"
}
```

Rules:

* Paths are workspace-relative
* Both folders are mandatory
* Changes trigger a full re-index

---

## 🌳 Sidebar Tree Structure

The left sidebar must follow this exact hierarchy:

```
/api/hello
 ├─ Backend Definition
 │   └─ Backend/Controllers/HelloController.cs:12
 └─ Frontend Calls (3)
     ├─ app/page.tsx:8
     ├─ components/useHello.ts:14
     └─ services/api.ts:22
```

Rules:

* Line numbers are **1-based**
* Clicking any node opens the file at the exact line

---

## 🔍 Frontend Scanning Rules

Copilot must generate code that:

* Scans `.ts` and `.tsx` files only
* Detects endpoints in:

```ts
fetch("/api/... ")
axios.get("/api/... ")
axios.post("/api/... ")
```

* Records:

  * File path
  * Line number
  * Endpoint string

AST-based parsing is preferred, regex is acceptable initially.

---

## 🧱 Backend Scanning Rules

Copilot must assume classic ASP.NET Web API controllers:

```csharp
[Route("api")]
[HttpGet("hello")]
```

or:

```csharp
[Route("api/hello")]
[HttpGet]
```

or:

```csharp
[ApiController]
[Route("api/*")]
public class HelloController : ControllerBase
{
    [HttpGet("Route")]
    public IActionResult GetHello() { ... }
}
```

Rules:

* Exactly **one** backend definition per endpoint
* Controller + method location must be recorded

---

## 🖱 CTRL + Hover + Click Behavior

Required behavior:

* When hovering over a frontend endpoint string while holding **CTRL**:

  * The endpoint is highlighted

* When **CTRL + Click** is performed:

  * VS Code navigates to the **single backend definition**

This must be implemented using:

* `HoverProvider` (for highlight)
* `DefinitionProvider` (for navigation)

---

## ⚙️ Internal Data Model

Copilot must preserve this logical structure:

```ts
EndpointIndex {
  endpoint: string;
  backend: Location;        // exactly one
  frontends: Location[];    // zero or more
}
```

All UI components must consume this index as a single source of truth.

---

## ♻️ Refresh & Watching

* File changes in frontend/backend roots must trigger re-indexing
* Re-indexing must be debounced
* Sidebar must update via TreeDataProvider events

---

## 🚫 Hard Constraints (Do Not Violate)

* Do NOT allow multiple backend definitions
* Do NOT hardcode folder paths
* Do NOT render custom UI (TreeView only)
* Do NOT block the extension host thread

---

## 🧠 Design Philosophy

* Deterministic
* Static-analysis driven
* No runtime HTTP calls
* No framework-specific assumptions beyond Next.js + ASP.NET

This extension should feel like **"Go To Definition" for APIs**.

---

## 📌 Copilot Guidance

When generating code:

* Prefer clarity over cleverness
* Add comments explaining VS Code APIs
* Keep scanning logic separate from UI logic
* Optimize for correctness first, performance second

---

End of Copilot Instructions
