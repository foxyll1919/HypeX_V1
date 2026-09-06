# Supabase Cloud Setup Guide for HypeX

## Your Project
- **URL**: https://uniscttzakwookdxiknt.supabase.co
- **Project Ref**: `uniscttzakwookdxiknt`

---

## Step 1: Run the Schema Migration

### Option A: Supabase Dashboard SQL Editor (Recommended)

1. Go to [Supabase Dashboard](https://supabase.com/dashboard)
2. Select your project: `uniscttzakwookdxiknt`
3. Click **SQL Editor** in the left sidebar
4. Click **New Query**
5. Copy the contents of `supabase/migrations/001_initial_schema.sql`
6. Paste into the SQL Editor
7. Click **Run** (or press `Ctrl+Enter`)

### Option B: Connect via psql

```bash
# Install PostgreSQL client if not installed
# Then connect using your connection string from:
# Supabase Dashboard → Project Settings → Database → Connection String

psql "postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres"
```

---

## Step 2: Get Your Supabase Credentials

1. Go to **Project Settings → API**
2. Copy these values:
   - **Project URL**: `https://uniscttzakwookdxiknt.supabase.co`
   - **anon/public key**: For frontend use
   - **service_role key**: For backend use (keep secret!)

---

## Step 3: Update Backend Environment Variables

Edit `backend/.env`:

```env
# Supabase Configuration
SUPABASE_URL=https://uniscttzakwookdxiknt.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key-here

# Keep these for potential rollback
# DB_HOST=localhost
# DB_PORT=3306
# DB_USER=root
# DB_PASSWORD=
# DB_NAME=nmm_db

# ML Service (unchanged)
ML_SERVICE_URL=http://localhost:8000

# Port
PORT=5000
```

---

## Step 4: Install Supabase Client

```bash
cd backend
npm install @supabase/supabase-js
```

---

## Step 5: Update Backend Code

The migration SQL creates:
- ✅ All 10 tables (converted from MySQL)
- ✅ pgvector extension with `vector(384)` type
- ✅ HNSW index for fast similarity search
- ✅ Seed users (admin, manager, reviewer, approver, viewer)
- ✅ Vector matching functions (`match_materials`, `batch_match_materials`)
- ✅ Row-Level Security policies

### Manual Steps Needed:

1. **Export data from MySQL** (if you have existing data)
2. **Import data to Supabase** (using the migration script)
3. **Update backend** `db.js` to use Supabase client

---

## Verifying the Setup

Run this query in Supabase SQL Editor to verify:

```sql
-- Check if pgvector is enabled
SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';

-- Check tables exist
SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';

-- Check seed users
SELECT username, role FROM users;
```

Expected output:
```
 extname | extversion 
---------+------------
 vector  | 0.5.1
```

---

## Connection String Format

Supabase Direct Connection:
```
postgresql://postgres.[PROJECT_REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres
```

Example:
```
postgresql://postgres.uniscttzakwookdxiknt:mypassword@aws-0-us-east-1.pooler.supabase.com:6543/postgres
```

---

## Next Steps

After running the schema:

1. ✅ Schema migration complete
2. ⏳ Update `backend/src/config/db.js` (I'll do this)
3. ⏳ Install `@supabase/supabase-js` dependency
4. ⏳ Test the backend connection
5. ⏳ Migrate existing data (if any)

---

## Troubleshooting

### "permission denied for schema public"
Make sure you're using the service role key, not the anon key, for migrations.

### "extension vector not found"
pgvector might not be enabled on your project. Go to:
**Database → Extensions** and enable `vector`.

### "relation does not exist"
Wait a few seconds after running the migration - sometimes there's a brief delay.

---

## Cost & Limits

| Resource | Free Tier | Notes |
|----------|-----------|-------|
| Database | 500MB | ~100k materials with embeddings |
| Bandwidth | 1GB/month | Monitor usage |
| Storage | 500MB | For CSV files |
| API Requests | 60/min | Rate limited |

For your scale (100k-1M materials), you may need the **Pro tier** ($25/mo) for more storage.
