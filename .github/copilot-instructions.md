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
  * Frontend folders are /lib/api
  * Frontend files are *.client.ts, *.client.tsx, *.ts, *.tsx
  * Backend folders are /*/Controllers
  * Backend files are *Controller.cs

Scanning should only happen if changes are detected in relevant files.

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

* Scans `.ts` and `.tsx` files only (excluding `node_modules`)
* Detects endpoints in:

```ts
fetch("/api/users")
fetch('/api/users')
fetch(`/api/users/${userId}`)
fetch(`/api/users/${userId}/posts/${postId}`)
fetch(`/api/Users${query}`, { method: "GET" })  // Query param - stripped
axios.get("/api/users")
axios.post("/api/users")
axios.put(`/api/users/${id}`)
axios.delete(`/api/users/${id}`)
```

* Extracts ordered parameter names from template literals `${paramName}`
* **Route vs Query Parameter Detection:**
  * Route param: `${param}` preceded by `/` (e.g., `/api/users/${id}`)
  * Query param: `${param}` NOT preceded by `/` (e.g., `/api/Users${query}`)
  * Query strings after `?` are stripped from normalized path
* Records:
  * File path
  * Line number (1-based)
  * Endpoint string (normalized, query params stripped)
  * Route parameters array (in order, excludes query params)

Implementation: **AST-based parsing** with regex fallback

---

## 🧱 Backend Scanning Rules

Copilot must scan `*Controller.cs` files and parse ASP.NET Web API attributes:

**Supported patterns:**

```csharp
// Pattern 1: Class route + method route
[Route("api")]
[HttpGet("hello")]
// Result: /api/hello
```

```csharp
// Pattern 2: Full route on class, bare HTTP verb
[Route("api/hello")]
[HttpGet]
// Result: /api/hello
```

```csharp
// Pattern 3: [controller] placeholder (case-insensitive)
[ApiController]
[Route("api/[controller]")]
public class HelloController : ControllerBase
{
    [HttpGet("greet")]
    public IActionResult GetGreet() { ... }
}
// Result: /api/hello/greet
```

```csharp
// Pattern 4: [Controller] placeholder (uppercase)
[ApiController]
[Route("api/[Controller]")]
public class UsersController : ControllerBase
{
    [HttpGet("{id}")]
    public IActionResult GetUser(int id) { ... }
}
// Result: /api/users/{id}
```

```csharp
// Pattern 5: Route parameters with constraints
[HttpGet("{id:int}")]
// Extracts: {id} (constraint stripped)
```

**Extraction rules:**
* Class-level `[Route("...")]` combined with method-level `[Http*(\"...\")]`
* `[controller]` placeholder → controller name (lowercase, without "Controller" suffix)
* `[action]` placeholder → method name (lowercase)
* Route parameters: `{paramName}` or `{paramName:type}` → extract `paramName`
* Records: file path, line number (1-based), HTTP method, parameters array (in order)

Implementation: **Regex-based parsing**

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
interface EndpointEntry {
  endpoint: string;           // Normalized endpoint path (e.g., /api/users/{id})
  backend?: Location;         // Backend definition location (exactly one or undefined)
  httpMethod: string;         // HTTP method (GET, POST, PUT, DELETE, PATCH) - required
  backendParams: string[];    // Backend route parameters in order
  frontends: Array<{
    location: Location;
    params: string[];         // Frontend parameters from ${...} in order
    rawEndpoint: string;      // Original endpoint string
    httpMethod: string;       // HTTP method from frontend call
  }>;
  status: 'valid' | 'invalid' | 'unresolved' | 'param-mismatch';
  paramMismatches: ParamMismatch[];  // Details about parameter name mismatches
  errorMessage?: string;      // Error message for invalid endpoints
}

interface ParamMismatch {
  position: number;           // 1-based position in route
  frontendParam: string;      // Parameter name from frontend (e.g., "userId")
  backendParam: string;       // Parameter name from backend (e.g., "id")
}
```

All UI components must consume this index as a single source of truth.

---

## 🌐 HTTP Method Handling

Endpoints are uniquely identified by **path + HTTP method** combination:

* `/api/users/{id}` with `GET` is a **different** endpoint than `/api/users/{id}` with `DELETE`
* The internal key format is: `normalized_path:METHOD` (e.g., `/api/users/*:GET`)

**Frontend HTTP Method Detection:**
* `axios.get()`, `axios.post()`, etc. → method extracted from function name
* `fetch()` with options object → method extracted from `{ method: 'POST' }`
* `fetch()` without method option → defaults to `GET`
* `axios({ url, method })` config style → method extracted from config
* If method cannot be determined → defaults to `GET`

**TreeView Display:**
* Endpoints are displayed with method badge: `/api/users/{id} [GET]`
* Method badge appears after the path

**Duplicate Definition Rules:**
* Duplicate detection is per path + method combination
* Same path with different methods = **distinct valid endpoints**
* Same path with same method = **invalid (duplicate)**

---

## 🔀 Parameter Validation Rules

Route parameters must be validated between frontend and backend:

* **Parameter names must match in order** (position-by-position comparison)
* Frontend `${userId}` must match backend `{userId}` at the same position
* Mismatches are shown in TreeView tooltips, not as separate nodes
* Example mismatch: "Position 1: frontend `${userId}` ≠ backend `{id}`"

Normalization for matching:
* Frontend: `/api/users/${userId}/posts/${postId}` → `/api/users/*/posts/*`
* Backend: `/api/users/{userId}/posts/{postId}` → `/api/users/*/posts/*`

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
