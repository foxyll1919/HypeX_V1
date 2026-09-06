# Supabase Cloud Migration - Implementation Checklist

## ✅ Completed Tasks

### Phase 1: Schema & Infrastructure
- [x] Created PostgreSQL schema with pgvector (`supabase/migrations/001_initial_schema.sql`)
  - All 10 tables converted from MySQL to PostgreSQL syntax
  - pgvector extension enabled for 384-dimensional embeddings
  - HNSW index created for fast similarity search
  - Vector matching functions: `match_materials()`, `batch_match_materials()`
  - Row-Level Security (RLS) policies enabled
  - Seed users imported (admin, manager, reviewer, approver, viewer)

- [x] Updated backend configuration (`backend/src/config/db.js`)
  - Replaced `mysql2` with `@supabase/supabase-js` client
  - Added connection verification on startup

- [x] Updated environment variables (`backend/.env`)
  - Added `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`
  - Commented out old MySQL credentials (kept for rollback)

- [x] Installed dependencies
  - `@supabase/supabase-js` added to `backend/package.json`

- [x] Created data migration script (`backend/scripts/migrate-to-supabase.js`)
  - Migrates all data from MySQL to Supabase
  - Handles JSON → pgvector conversion for embeddings
  - Batches inserts for performance (100-500 per batch)

### Phase 2: Documentation
- [x] Created setup guide (`supabase/SETUP.md`)
- [x] Created this checklist

---

## 🔴 CRITICAL: Next Steps You Must Complete

### Step 1: Configure Supabase Credentials (REQUIRED)

1. Go to **Supabase Dashboard**: https://supabase.com/dashboard
2. Select your project: `uniscttzakwookdxiknt`
3. Navigate to **Project Settings → API**
4. Copy your credentials:
   - **Project URL**: (should be `https://uniscttzakwookdxiknt.supabase.co`)
   - **Service Role Key**: (secret key, starts with `eyJhbGc...`)

5. Update `backend/.env`:
   ```env
   SUPABASE_URL=https://uniscttzakwookdxiknt.supabase.co
   SUPABASE_SERVICE_KEY=your-actual-service-role-key-here
   ```

⚠️ **SECURITY WARNING**: Keep the service role key secret. Never commit it to git.

---

### Step 2: Run Schema Migration in Supabase

**Method A: Using Supabase Dashboard (Recommended)**

1. Go to your Supabase project dashboard
2. Click **SQL Editor** in the left sidebar
3. Click **New Query**
4. Copy the entire contents of `supabase/migrations/001_initial_schema.sql`
5. Paste into the SQL editor
6. Click **Run** or press `Ctrl+Enter`
7. Wait for completion (should see "Success")

**Method B: Using SQL File Upload**

1. In Supabase SQL Editor, click **Upload SQL File**
2. Select `supabase/migrations/001_initial_schema.sql`
3. Click **Run**

**Verify Success**:
```sql
-- Run these queries to verify
SELECT extname FROM pg_extension WHERE extname = 'vector';
SELECT COUNT(*) FROM users;
SELECT COUNT(*) FROM materials;
```

Expected output:
- pgvector extension exists
- 5 seed users created
- 0 materials (or your existing data count)

---

### Step 3: Migrate Existing Data (If You Have Any)

If you have existing materials, embeddings, matches, etc. in MySQL:

```bash
cd backend
node scripts/migrate-to-supabase.js
```

This will:
1. Export all data from MySQL
2. Convert JSON embeddings to pgvector format
3. Import into Supabase
4. Show progress for each table

**Note**: This script uses both MySQL and Supabase clients. Make sure:
- MySQL is running locally
- `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` in `.env` are correct
- `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` are set

---

### Step 4: Update Backend Routes to Use Supabase

The new `db.js` exports a Supabase client. However, **all route handlers need to be updated** from the old `mysql2` API to the Supabase API.

**Current state**: Routes still use `db.run()`, `db.all()`, `db.get()` which are MySQL methods.

**Conversion pattern**:

```javascript
// OLD (MySQL)
const result = await db.run('INSERT INTO materials (...) VALUES (...)', [values]);

// NEW (Supabase)
const { data, error } = await db
  .from('materials')
  .insert([{ cpse_name, original_code, description, ... }])
  .select('id');
if (error) throw error;
const result = { id: data[0].id };
```

---

### Step 5: Test Backend Connection

Once credentials are set and schema is created:

```bash
cd backend
npm run dev
```

You should see:
```
Connected to Supabase successfully.
```

If you see errors, check:
- `SUPABASE_URL` is correct
- `SUPABASE_SERVICE_KEY` is the **service role key**, not the anon key
- Schema migration ran successfully in Supabase

---

### Step 6: Update Frontend (Optional but Recommended)

The frontend still calls the Express backend, so it should work once the backend is updated. However, you can optionally add Supabase auth:

```javascript
// frontend/src/services/api.js
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
)

// Add to .env.local:
// VITE_SUPABASE_URL=https://uniscttzakwookdxiknt.supabase.co
// VITE_SUPABASE_ANON_KEY=your-anon-key
```

---

## 📋 Migration Sequence Summary

```
1. Set Supabase credentials in backend/.env ✅ (You do this)
2. Run schema migration in Supabase ✅ (You do this)
3. Verify schema with test queries ✅ (You do this)
4. (Optional) Run data migration script ⏳ (If you have existing data)
5. Update backend routes to use Supabase client ⏳ (Need to implement)
6. Test backend endpoints ⏳ (Verification)
7. Deploy to production ⏳ (When ready)
```

---

## 🔧 Backend Route Updates Needed

**Files affected**: `backend/src/routes/api.js` (1782 lines, 23 endpoints)

**Conversion helpers**:

```javascript
// Query method mapping:
// db.all(sql, params) → db.from(table).select() / rpc()
// db.get(sql, params) → db.from(table).select().single()
// db.run(sql, params) → db.from(table).insert() / update() / delete()

// Example endpoints to update:
// GET /materials → db.from('materials').select()
// POST /materials → db.from('materials').insert()
// PUT /materials/:id → db.from('materials').update()
// POST /match → call vector RPC: match_materials()
// POST /upload/start → still async, uses db for inserts
// POST /national-codes/generate → still calls ML service
```

---

## ⚠️ Known Issues & Workarounds

### Issue 1: Service Role Key vs Anon Key
**Problem**: Using anon key instead of service role key causes permission errors
**Solution**: Use `SUPABASE_SERVICE_KEY` for backend, `VITE_SUPABASE_ANON_KEY` for frontend

### Issue 2: Connection Pooling
**Problem**: Supabase has connection pooling limits
**Solution**: Use connection pooler endpoint (included in your project URL)

### Issue 3: Batch Insert Size
**Problem**: PostgreSQL has a maximum number of parameters
**Solution**: Migration script batches inserts (100-500 per batch)

### Issue 4: Vector Indexing
**Problem**: HNSW index takes time to build on large datasets
**Solution**: Already configured with `vector_cosine_ops` for cosine similarity

---

## 📊 Cost Implications

| Resource | Current (MySQL) | Supabase Free | Supabase Pro |
|----------|-----------------|---------------|-------------|
| Storage | Self-hosted | 500MB | 8GB |
| Bandwidth | Self-hosted | 1GB/mo | 100GB/mo |
| Database | Free | PostgreSQL + pgvector | PostgreSQL + pgvector |
| Cost | $0 (infra cost) | $0 | $25/mo |

**For your scale (100k-1M materials with 384D vectors ≈ 150-1500MB), you may need Pro tier.**

---

## ✅ Verification Checklist

After completing all steps, verify:

- [ ] Supabase credentials set in `backend/.env`
- [ ] Schema migration ran successfully (check `pg_extension` for pgvector)
- [ ] Seed users exist (SELECT * FROM users;)
- [ ] Backend starts without errors (`npm run dev`)
- [ ] Can query materials via Supabase client
- [ ] Vector similarity functions exist (SELECT * FROM pg_proc WHERE proname = 'match_materials';)
- [ ] Data migrated from MySQL (if applicable)
- [ ] Backend endpoints updated to use Supabase API
- [ ] Tests pass (if applicable)

---

## 🚀 Ready to Proceed?

**Confirm you've completed**:
1. ✅ Set `SUPABASE_SERVICE_KEY` in `backend/.env`
2. ✅ Run schema migration in Supabase Dashboard
3. ✅ Verified schema with test queries

Then I'll help you update the backend routes to use the Supabase client.

**Reply with**: "Ready for Phase 4" or list any blockers.
