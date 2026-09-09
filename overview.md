# HypeX Project Overview

Audit date: 2026-09-10

## Executive Status

The frontend and MySQL-backed Node.js backend are currently runnable. The frontend production build succeeds, and the backend starts, connects to MySQL on `localhost:3306`, initializes the schema, and serves material and analytics data.

The ML service is now runnable after installing the declared Python dependencies. Its maintained test suite passes, and the backend-compatible FastAPI process responds on `127.0.0.1:8000`. Qwen is available through the local llama.cpp server and is used as the primary embedding provider. Its 2,560-dimensional output is folded deterministically into the existing 384-dimensional database contract; sentence-transformers and feature hashing remain fallbacks.

Status meanings:

- **Working**: verified by source inspection and/or a live executable check.
- **Conditionally working**: implemented, but depends on another service, data state, or a runtime prerequisite.
- **Blocked**: could not run because a required dependency or service is unavailable.
- **Limited / not production-ready**: the UI or fallback exists, but the implementation is demo-only or incomplete for production use.

## Validation Performed

| Area | Check | Result |
|---|---|---|
| Frontend | `npm run build` in `frontend` | **Passed**; Vite transformed 2,366 modules and produced a production bundle. |
| Backend syntax | `node --check` on server, MySQL routes, Supabase routes, and ML client | **Passed**. |
| Backend startup | Started `backend/src/server.js` | **Passed**; Express listened on port 5000, MySQL connected, and schema initialization completed. |
| Backend API | `GET /api/analytics` and `GET /api/materials` | **Passed**; both returned successful responses with database data. |
| ML source | `python -m compileall` | **Passed**. |
| ML imports | Imported core ML modules | **Passed** after dependency installation. |
| ML tests | `pytest -q` | **Passed**; 80 tests passed, with one Pydantic deprecation warning. |
| ML service startup | `uvicorn main:app --host 127.0.0.1 --port 8000` | **Passed**. |
| Render deployment configuration | [render.yaml](render.yaml) | **Prepared, not remotely deployed**; no Render CLI/session is configured in this workspace. |
| ML health/API | `GET /health` plus backend `mlClient.healthCheck()` | **Passed**; HTTP 200 and `true`. |
| Browser workflow | Full Playwright or manual browser walkthrough | **Not run**. |

## Feature-by-Feature Status

### Frontend application

| Feature | Location | Condition |
|---|---|---|
| Client-side login with five demo roles | [frontend/src/pages/Login.jsx](frontend/src/pages/Login.jsx) | **Working, limited**. The five hard-coded accounts accept passwords in the form `<role>123` and store the user in `localStorage`. There is no backend authentication or session validation. |
| Dashboard summary and charts | [frontend/src/pages/Dashboard.jsx](frontend/src/pages/Dashboard.jsx) | **Conditionally working**. The page calls analytics and demo-seed APIs and should work with the active backend and database. |
| Material list, search, filters, and inline editing | [frontend/src/pages/Materials.jsx](frontend/src/pages/Materials.jsx) | **Conditionally working**. Backend read/update routes are implemented and the live material read passed. Full edit behavior was not browser-tested. |
| CSV/JSON material upload | [frontend/src/pages/Upload.jsx](frontend/src/pages/Upload.jsx) | **Conditionally working**. Client validation, duplicate warnings, parsing, batch upload, and progress polling are implemented. Requires the MySQL backend. |
| Manual material entry | [frontend/src/pages/Upload.jsx](frontend/src/pages/Upload.jsx) | **At risk**. The endpoint exists, but the MySQL manual-insert SQL/value mapping should be corrected and tested before relying on it; pressure values are included in the values list while the SQL column list is inconsistent. |
| Demo dataset loading | [frontend/src/pages/Upload.jsx](frontend/src/pages/Upload.jsx) | **Conditionally working**. The backend has a destructive reset-and-seed endpoint. It requires an available database and should be used only in a demo environment. |
| AI matching progress and result summary | [frontend/src/pages/AIMatching.jsx](frontend/src/pages/AIMatching.jsx) | **Conditionally working**. The ML service is now available; full UI workflow still needs browser-level verification. |
| Match review and approve/reject decisions | [frontend/src/pages/MatchReview.jsx](frontend/src/pages/MatchReview.jsx) | **Conditionally working**. Candidate retrieval and decision routes exist. Approval/rejection also triggers clustering and national-code recomputation, so the full workflow depends on database state and ML/fallback behavior. |
| Cluster list and details | [frontend/src/pages/Clusters.jsx](frontend/src/pages/Clusters.jsx) | **Conditionally working**. Read endpoints and detail views exist; data is produced after approved matches. |
| National Material Code list, generation, details, and CSV export | [frontend/src/pages/NationalCodes.jsx](frontend/src/pages/NationalCodes.jsx) | **Conditionally working**. Routes and UI are implemented. Generation depends on approved clusters and ML NMC generation, with a backend fallback. |
| Traceability mappings | [frontend/src/pages/Mapping.jsx](frontend/src/pages/Mapping.jsx) | **Conditionally working**. The backend query and UI exist and require generated mappings. |
| Analytics charts and approval metrics | [frontend/src/pages/Analytics.jsx](frontend/src/pages/Analytics.jsx) | **Working for current backend data**. The live analytics endpoint responded successfully; chart rendering was not browser-tested. |
| Global material search navigation | [frontend/src/layouts/Layout.jsx](frontend/src/layouts/Layout.jsx) | **Working by implementation**. Entering a search term navigates to the Materials page with a query parameter. |
| Logout | [frontend/src/layouts/Layout.jsx](frontend/src/layouts/Layout.jsx) | **Working, limited**. It removes local demo identity and navigates to login; it is not server-side session logout. |

### Backend API and business logic

| Feature / endpoint group | Condition |
|---|---|
| Material listing, ID lookup, search, CPSE/status/national-code filters | **Working** with MySQL; live material retrieval passed. |
| Material create and update | **Conditionally working**; update is implemented, while manual create has the SQL/value mapping risk noted above. |
| Synchronous batch upload | **Working conditionally** with MySQL; invalid rows are skipped rather than returned as row-level failures. |
| Asynchronous batch upload and progress status | **Working conditionally** with MySQL; job state is in-memory and is lost on process restart. |
| AI pipeline orchestration | **Blocked currently** by ML runtime dependencies/service. |
| Match candidate retrieval | **Working conditionally** after matching has produced records. |
| Approve/reject match and audit trail | **Working conditionally**; database route exists and recomputes downstream data. |
| Cluster recomputation | **Conditionally working**; calls the ML service and contains a JavaScript union-find fallback. |
| National-code generation | **Conditionally working**; calls ML generation and contains a JavaScript fallback. |
| National-code export | **Working conditionally** when mappings and codes exist. |
| Analytics and audit-log reporting | **Working** against the live MySQL database. |
| ERP/SAP mock status, pull sync, and mapping push | **Working as a mock integration**; not a real SAP connector. |
| Demo seed/reset | **Working conditionally**; destructive and intended for demo data. |
| CORS and JSON API serving | **Working**; Express starts and exposes the `/api` namespace. |

### ML service

The FastAPI source exposes these implemented capabilities:

- `/normalize`: description normalization.
- `/extract`: technical attribute extraction.
- `/embed`: embedding generation.
- `/similarity`: cosine similarity.
- `/match`: pairwise material matching.
- `/pipeline/run`: normalization, extraction, embeddings, pairwise candidate detection, and rule-based verification.
- `/pipeline/cluster`: approved-edge clustering.
- `/national-codes/generate`: national material code assignment.

The ML features are **working at the service/test level** with the installed dependencies. The active legacy-compatible entry point now uses the Qwen server first, then sentence-transformers, then feature hashing. The maintained tests under [ml-service/tests](ml-service/tests) pass: 80 tests passed.

There is also a client-side health-check method for `/health`, but [ml-service/main.py](ml-service/main.py) does not define a `/health` route. That health check will therefore report false even after dependencies are installed unless a health endpoint is added or the client method is removed/changed.

### Database and deployment modes

| Area | Condition |
|---|---|
| MySQL schema bootstrap | **Working**; verified during backend startup. |
| Default backend database mode | **Provider-aware**; Supabase is selected when `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` are configured, otherwise [backend/src/routes/api.js](backend/src/routes/api.js) uses local MySQL. |
| Supabase migration assets | **Core path enabled**. [backend/src/routes/api-supabase.js](backend/src/routes/api-supabase.js) is mounted automatically when Supabase credentials are available; its current route surface is smaller than the MySQL implementation and should be expanded before a full production cutover. |
| In-memory upload jobs | **Limited**; progress data is not durable or shared across backend instances. |
| Authentication and authorization | **Demo-only**; backend routes do not enforce the role stored by the frontend. |

## Main Blockers and Risks

1. For Render, configure `LLAMA_SERVER_URL` to a reachable external Qwen/llama.cpp embedding server; the local `127.0.0.1:8080` address is not reachable from Render.
2. Fix and integration-test the MySQL manual material insert column/value mapping.
3. Add browser-level tests for login, upload, matching review, clustering, NMC export, and analytics rendering.
4. Decide whether MySQL or Supabase is the supported deployment mode, then complete and mount only the chosen route implementation.
5. Replace client-only demo authentication with server-backed authentication and authorization before production use.

## Overall Conclusion

**The project is substantially working at the service level.** The frontend build, backend startup, MySQL schema bootstrap, ML service, ML tests, read APIs, analytics, and most UI/API surfaces are operational under the MySQL configuration. Remaining limitations are the fallback embedding mode, demo-only authentication, the manual insert path risk, and missing end-to-end browser verification. It should still be treated as a functional demo/MVP rather than a fully production-ready system.