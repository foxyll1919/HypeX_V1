# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

HypeX (National Material Master) is a multi-service platform for industrial material data management. It ingests material records from CSV uploads, normalizes descriptions with ML, generates embeddings, finds duplicate/equivalent materials via semantic matching, clusters them, and assigns National Material Codes (NMCs). Four services run independently:

- **Frontend** (`frontend/`) — React 18 + Vite SPA
- **Backend** (`backend/`) — Express API, single route file, MySQL database
- **ML Service** (`ml-service/`) — FastAPI service for NLP pipeline (normalize → extract → embed → match → cluster → NMC generation)
- **Database** (`database/`) — MySQL schema with 10 tables (materials, embeddings, matches, clusters, cluster_members, national_codes, mappings, users, audit_logs, reviews)

## Commands

### Install
```bash
cd backend && npm install
cd frontend && npm install
cd ml-service && python -m venv .venv && .venv\Scripts\Activate.ps1 && pip install -r requirements.txt
```

### Run (each in its own terminal)
```bash
cd backend && npm run dev          # Express on :5000 (nodemon)
cd frontend && npm run dev         # Vite on :5173
cd ml-service && .venv\Scripts\Activate.ps1 && uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

### Embedding server (optional, for Qwen3 embeddings instead of fallback hash vectors)
```bash
cd ml-service && .venv\Scripts\Activate.ps1 && llama-server -m "D:\HypeX\HypeX_Models\Qwen3-Embedding-4B-Q4_K_M.gguf" --embeddings --port 8080
```

### Build frontend
```bash
cd frontend && npm run build
```

### Run ML tests
```bash
cd ml-service && .venv\Scripts\Activate.ps1 && pytest
```

There is no test suite for the backend or frontend. No Docker setup exists.

## Environment Variables

Backend (`backend/.env`):
- `PORT` — Express port (default `5000`)
- `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` — MySQL connection (default `localhost:3306`, db `nmm_db`)
- `ML_SERVICE_URL` — ML service base URL (default `http://localhost:8000`)

Frontend: `VITE_API_URL` — Backend API base (default `http://localhost:5000/api`)

ML Service (`ml-service/.env` or env vars): `LLAMA_SERVER_URL` (default `http://127.0.0.1:8080`), matching thresholds, scoring weights — all configurable via `ml-service/app/config.py` Settings class.

## Architecture

### Request Flow
Frontend → `frontend/src/services/api.js` → Express `:5000/api/*` → `backend/src/routes/api.js` → MySQL (via `backend/src/config/db.js`) and/or ML service `:8000` (via `backend/src/services/mlClient.js`).

### Backend
Single monolithic route file: `backend/src/routes/api.js` (~1800 lines). All REST endpoints live here. Key endpoint groups:
- `/materials` — CRUD
- `/upload` + `/upload/start` + `/upload/status/:jobId` — CSV import with async job processing (in-memory `Map` job store, batch insert with duplicate detection, post-insert DB verification)
- `/match` — triggers ML pipeline, persists matches
- `/matches/:id/approve|reject` — review workflow
- `/clusters` — cluster CRUD
- `/national-codes` + `/national-codes/generate` — NMC lifecycle
- `/mappings`, `/analytics`, `/audit-logs`, `/erp/*`, `/demo/seed`

Database helper (`backend/src/config/db.js`): wraps `mysql2/promise` pool. Exports `query.all()`, `query.get()`, `query.run()`, `query.exec()` and `pool` for transactions. Auto-runs `database/schema.sql` and seeds demo users on startup. Includes a migration function that adds columns if missing.

### ML Service
Two parallel code paths exist:
1. **Root-level modules** (`ml-service/main.py`, `normalization.py`, `extraction.py`, `embeddings.py`, `matching.py`, `clustering.py`, `schemas.py`) — the original FastAPI app. `main.py` is the active entrypoint used by `uvicorn main:app`.
2. **`ml-service/app/`** — restructured version with service classes, config via pydantic-settings, async embedding client with llama.cpp/Qwen3 integration, and route modules. Has its own `app/main.py`.

The root-level `embeddings.py` uses `sentence-transformers` (all-MiniLM-L6-v2) with a hash-based fallback. The `app/services/embedding_service.py` uses llama.cpp server (Qwen3-Embedding-4B on `:8080`) with a hash-based fallback. Which one is active depends on which entrypoint is used.

ML endpoints: `/normalize`, `/extract`, `/embed`, `/similarity`, `/match`, `/pipeline/run` (batch: normalize → extract → embed → pairwise match), `/pipeline/cluster`, `/national-codes/generate`.

Matching threshold: cosine similarity ≥ 0.70 triggers candidate evaluation. Results classified as EXACT DUPLICATE (≥0.96), EQUIVALENT (≥0.85), NEAR DUPLICATE (≥0.75), POSSIBLE MATCH (≥0.65), or DIFFERENT.

### Frontend
React 18 with react-router-dom v6. Pages lazy-loaded from `frontend/src/pages/`. Layout wrapper at `frontend/src/layouts/Layout.jsx`. All API calls centralized in `frontend/src/services/api.js`. No state management library — local component state via `useState`. Icons from `lucide-react`, charts from `recharts`.

Pages: Dashboard, Materials, Upload, AIMatching, MatchReview, Clusters, NationalCodes, Mapping, Analytics, Login.

### Upload/Import Flow (the most complex feature)
1. Frontend parses CSV → calls `POST /upload/start` with materials array + CPSE name
2. Backend creates an in-memory job, returns `jobId`, processes asynchronously via `processUploadJob()`
3. Frontend polls `GET /upload/status/:jobId` every 500ms
4. Backend processes rows in batches: normalize via ML, check for duplicates (matching `cpse_name` + `original_code`), insert new, track inserted/duplicates/failed counts
5. After insert: verification phase counts `beforeCount`/`afterCount`, sets `verified = afterCount >= beforeCount + inserted`
6. Job status values: `pending` → `importing` → `verifying` → `completed` | `partial` | `failed`
7. Frontend renders pipeline stages with state machine: Loader2 (spinning) during active phase, CheckCircle (green) on success, AlertTriangle on failure

## Service Boundaries

- Frontend API calls → `frontend/src/services/api.js`
- Backend routes → `backend/src/routes/api.js`
- Backend services → `backend/src/services/`
- ML logic → `ml-service/` (preserve FastAPI contract in `main.py` and schemas in `schemas.py`)
- Database DDL → `database/schema.sql`, runtime migrations in `backend/src/config/db.js`

When changing route names, status enum values, or response shapes, check all three services for call-site compatibility.
