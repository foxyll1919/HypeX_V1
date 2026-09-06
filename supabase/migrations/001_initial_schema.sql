-- =====================================================
-- Supabase PostgreSQL Schema for HypeX (National Material Master)
-- Migration from MySQL to PostgreSQL with pgvector
-- =====================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =====================================================
-- 1. Materials Table
-- =====================================================
CREATE TABLE IF NOT EXISTS materials (
  id SERIAL PRIMARY KEY,
  cpse_name VARCHAR(255) NOT NULL,
  original_code VARCHAR(255) NOT NULL,
  sap_code VARCHAR(255),
  description TEXT NOT NULL,
  material_known_as TEXT,
  unit VARCHAR(50),
  specifications TEXT,
  technical_parameters TEXT,
  material_type VARCHAR(255),
  material_grade VARCHAR(255),
  dimension VARCHAR(255),
  dimension_unit VARCHAR(50),
  length VARCHAR(255),
  length_unit VARCHAR(50),
  pressure VARCHAR(255),
  pressure_unit VARCHAR(50),
  standard_reference VARCHAR(255),
  unit_of_measurement VARCHAR(50),
  classification VARCHAR(255),
  normalized_description TEXT,
  match_status VARCHAR(50) DEFAULT 'PENDING' CHECK (match_status IN ('PENDING', 'APPROVED', 'REJECTED', 'REVIEW', 'INSUFFICIENT')),
  national_code VARCHAR(255),
  thread_size VARCHAR(50),
  thread_length VARCHAR(50),
  thread_length_unit VARCHAR(20),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Composite unique constraint (same as MySQL)
CREATE UNIQUE INDEX IF NOT EXISTS materials_cpse_original_idx ON materials(cpse_name, original_code);

-- =====================================================
-- 2. Material Embeddings Table (with pgvector)
-- =====================================================
CREATE TABLE IF NOT EXISTS material_embeddings (
  material_id INTEGER PRIMARY KEY REFERENCES materials(id) ON DELETE CASCADE,
  embedding vector(384) NOT NULL
);

-- HNSW index for fast approximate nearest neighbor search
-- cosine distance: <=> operator returns distance (lower = more similar)
CREATE INDEX IF NOT EXISTS material_embeddings_hnsw_idx
ON material_embeddings USING hnsw (embedding vector_cosine_ops);

-- IVFFlat index as alternative (good for larger datasets, slower build but smaller)
-- CREATE INDEX IF NOT EXISTS material_embeddings_ivfflat_idx
-- ON material_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- =====================================================
-- 3. Matches Table
-- =====================================================
CREATE TABLE IF NOT EXISTS matches (
  id SERIAL PRIMARY KEY,
  material_a_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  material_b_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  semantic_score REAL,
  technical_score REAL,
  final_score REAL,
  result VARCHAR(100) CHECK (result IN ('EXACT DUPLICATE', 'EQUIVALENT', 'NEAR DUPLICATE', 'POSSIBLE MATCH', 'DIFFERENT', 'INSUFFICIENT INFORMATION')),
  reason TEXT,
  comparison JSONB,
  status VARCHAR(50) DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  reviewer_comment TEXT,
  reviewed_by VARCHAR(255),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT matches_no_self_match CHECK (material_a_id != material_b_id)
);

-- Index for querying pending matches
CREATE INDEX IF NOT EXISTS matches_status_idx ON matches(status);
CREATE INDEX IF NOT EXISTS matches_material_pair_idx ON matches(material_a_id, material_b_id);

-- =====================================================
-- 4. Clusters Table
-- =====================================================
CREATE TABLE IF NOT EXISTS clusters (
  id VARCHAR(255) PRIMARY KEY, -- CL-00001 etc
  national_code VARCHAR(255) UNIQUE,
  standardized_description TEXT,
  category VARCHAR(255),
  confidence REAL,
  status VARCHAR(50) DEFAULT 'APPROVED' CHECK (status IN ('APPROVED', 'PENDING', 'REJECTED')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS clusters_national_code_idx ON clusters(national_code);

-- =====================================================
-- 5. Cluster Members Table
-- =====================================================
CREATE TABLE IF NOT EXISTS cluster_members (
  cluster_id VARCHAR(255) NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
  material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  PRIMARY KEY (cluster_id, material_id)
);

CREATE INDEX IF NOT EXISTS cluster_members_material_idx ON cluster_members(material_id);

-- =====================================================
-- 6. National Material Codes Table
-- =====================================================
CREATE TABLE IF NOT EXISTS national_codes (
  code VARCHAR(255) PRIMARY KEY, -- NMC-00001 etc
  standard_description TEXT NOT NULL,
  category VARCHAR(255),
  specifications TEXT,
  status VARCHAR(50) DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'DEPRECATED')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS national_codes_category_idx ON national_codes(category);

-- =====================================================
-- 7. Mappings Table
-- =====================================================
CREATE TABLE IF NOT EXISTS mappings (
  id SERIAL PRIMARY KEY,
  national_code VARCHAR(255) NOT NULL REFERENCES national_codes(code) ON DELETE CASCADE,
  cpse_name VARCHAR(255) NOT NULL,
  original_code VARCHAR(255) NOT NULL,
  material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  status VARCHAR(50) DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS mappings_national_code_idx ON mappings(national_code);
CREATE INDEX IF NOT EXISTS mappings_material_idx ON mappings(material_id);
CREATE INDEX IF NOT EXISTS mappings_cpse_code_idx ON mappings(cpse_name, original_code);

-- =====================================================
-- 8. Users Table
-- =====================================================
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(255) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL CHECK (role IN ('ADMIN', 'MANAGER', 'REVIEWER', 'APPROVER', 'VIEWER')),
  full_name VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS users_username_idx ON users(username);

-- =====================================================
-- 9. Audit Logs Table
-- =====================================================
CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  username VARCHAR(255),
  action VARCHAR(255) NOT NULL, -- Upload, Normalize, Match, Approve, Reject, Mapping Modified, NMC Created
  material_id INTEGER REFERENCES materials(id) ON DELETE SET NULL,
  decision VARCHAR(100),
  comment TEXT
);

CREATE INDEX IF NOT EXISTS audit_logs_timestamp_idx ON audit_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS audit_logs_action_idx ON audit_logs(action);
CREATE INDEX IF NOT EXISTS audit_logs_username_idx ON audit_logs(username);

-- =====================================================
-- 10. Reviews Table
-- =====================================================
CREATE TABLE IF NOT EXISTS reviews (
  id SERIAL PRIMARY KEY,
  match_id INTEGER REFERENCES matches(id) ON DELETE CASCADE,
  reviewer VARCHAR(255),
  decision VARCHAR(100),
  comment TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS reviews_match_idx ON reviews(match_id);

-- =====================================================
-- 11. Seed Default Users (same as MySQL version)
-- =====================================================
INSERT INTO users (username, password, role, full_name) VALUES
  ('admin', 'admin123', 'ADMIN', 'System Administrator'),
  ('manager', 'manager123', 'MANAGER', 'Data Manager'),
  ('reviewer', 'reviewer123', 'REVIEWER', 'Match Reviewer'),
  ('approver', 'approver123', 'APPROVER', 'Senior Approver'),
  ('viewer', 'viewer123', 'VIEWER', 'Guest Viewer')
ON CONFLICT (username) DO NOTHING;

-- =====================================================
-- 12. Vector Similarity Matching Functions
-- =====================================================

-- Function: Find similar materials by embedding
CREATE OR REPLACE FUNCTION match_materials(
  query_embedding vector(384),
  match_threshold float DEFAULT 0.70,
  match_count int DEFAULT 10
)
RETURNS TABLE (
  material_id int,
  similarity float
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    me.material_id,
    1 - (me.embedding <=> query_embedding) AS similarity
  FROM material_embeddings me
  WHERE 1 - (me.embedding <=> query_embedding) >= match_threshold
  ORDER BY similarity DESC
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql STABLE;

-- Function: Match a specific material to all others
CREATE OR REPLACE FUNCTION match_material_to_all(
  material_id_input int,
  match_threshold float DEFAULT 0.70,
  match_count int DEFAULT 10
)
RETURNS TABLE (
  matched_material_id int,
  similarity float
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    me.material_id,
    1 - (me.embedding <=> ref_emb.embedding) AS similarity
  FROM material_embeddings me
  CROSS JOIN material_embeddings ref_emb
  WHERE ref_emb.material_id = material_id_input
    AND me.material_id != material_id_input
    AND 1 - (me.embedding <=> ref_emb.embedding) >= match_threshold
  ORDER BY similarity DESC
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql STABLE;

-- Function: Batch match multiple materials
CREATE OR REPLACE FUNCTION batch_match_materials(
  material_ids int[],
  match_threshold float DEFAULT 0.70,
  match_count_per_material int DEFAULT 10
)
RETURNS TABLE (
  source_material_id int,
  matched_material_id int,
  similarity float
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    ref_emb.material_id AS source_material_id,
    me.material_id AS matched_material_id,
    1 - (me.embedding <=> ref_emb.embedding) AS similarity
  FROM material_embeddings me
  CROSS JOIN unnest(material_ids) AS ref_id
  CROSS JOIN material_embeddings ref_emb
  WHERE ref_emb.material_id = ref_id
    AND me.material_id != ref_emb.material_id
    AND 1 - (me.embedding <=> ref_emb.embedding) >= match_threshold
  ORDER BY ref_emb.material_id, similarity DESC;
END;
$$ LANGUAGE plpgsql STABLE;

-- =====================================================
-- 13. Auto-update updated_at timestamp
-- =====================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER materials_updated_at
  BEFORE UPDATE ON materials
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- 14. Row-Level Security (RLS) Policies
-- =====================================================

-- Enable RLS on tables
ALTER TABLE materials ENABLE ROW LEVEL SECURITY;
ALTER TABLE material_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE clusters ENABLE ROW LEVEL SECURITY;
ALTER TABLE cluster_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE national_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;

-- For now, allow authenticated users full access (you can tighten these later)
-- These are permissive policies - adjust based on your auth strategy

CREATE POLICY "Enable read access for authenticated users" ON materials
  FOR SELECT USING (true);

CREATE POLICY "Enable insert for authenticated users" ON materials
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Enable update for authenticated users" ON materials
  FOR UPDATE USING (true);

CREATE POLICY "Enable delete for authenticated users" ON materials
  FOR DELETE USING (true);

-- Embeddings follow materials access
CREATE POLICY "Embeddings follow materials access" ON material_embeddings
  FOR ALL USING (true);

CREATE POLICY "Matches readable by authenticated users" ON matches
  FOR SELECT USING (true);

CREATE POLICY "Matches modifiable by authenticated users" ON matches
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Matches updatable by authenticated users" ON matches
  FOR UPDATE USING (true);

-- Other tables - permissive access
CREATE POLICY "Clusters access" ON clusters FOR ALL USING (true);
CREATE POLICY "Cluster members access" ON cluster_members FOR ALL USING (true);
CREATE POLICY "National codes access" ON national_codes FOR ALL USING (true);
CREATE POLICY "Mappings access" ON mappings FOR ALL USING (true);
CREATE POLICY "Users readable" ON users FOR SELECT USING (true);
CREATE POLICY "Audit logs readable" ON audit_logs FOR SELECT USING (true);
CREATE POLICY "Reviews access" ON reviews FOR ALL USING (true);

-- =====================================================
-- 15. Comments for documentation
-- =====================================================
COMMENT ON TABLE materials IS 'Core materials table storing industrial material records';
COMMENT ON TABLE material_embeddings IS 'Vector embeddings for semantic similarity search using pgvector';
COMMENT ON COLUMN material_embeddings.embedding IS '384-dimensional vector (all-MiniLM-L6-v2 or Qwen3-Embedding-4B)';
COMMENT ON FUNCTION match_materials IS 'Find similar materials using cosine similarity on embeddings';
COMMENT ON EXTENSION vector IS 'PostgreSQL extension for vector similarity search';
