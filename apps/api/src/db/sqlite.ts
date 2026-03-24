import Database from 'better-sqlite3'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(moduleDir, '..', '..')
const defaultDbPath = path.join(projectRoot, 'data', 'audit.db')
const dbPath = process.env.DB_PATH
  ? path.resolve(projectRoot, process.env.DB_PATH)
  : defaultDbPath

// Ensure the data directory exists
const dbDir = path.dirname(dbPath)
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true })
}

const db: InstanceType<typeof Database> = new Database(dbPath)

// Enable WAL mode for concurrent reads during writes
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

// Create tables idempotently
db.exec(`
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    email TEXT NOT NULL,
    filename TEXT,
    score INTEGER,
    grade TEXT,
    ip_address TEXT,
    user_agent TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_audit_email ON audit_log(email);
  CREATE INDEX IF NOT EXISTS idx_audit_event ON audit_log(event_type);

  CREATE TABLE IF NOT EXISTS otp_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    otp_hash TEXT NOT NULL,
    attempts INTEGER DEFAULT 0,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_otp_email ON otp_codes(email);

  CREATE TABLE IF NOT EXISTS shared_reports (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    filename TEXT NOT NULL,
    report_json TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_shared_reports_expires ON shared_reports(expires_at);

  CREATE TABLE IF NOT EXISTS browser_clients (
    client_id TEXT PRIMARY KEY,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS browser_sessions (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (client_id) REFERENCES browser_clients(client_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_browser_sessions_client ON browser_sessions(client_id);
  CREATE INDEX IF NOT EXISTS idx_browser_sessions_expires ON browser_sessions(expires_at);

  CREATE TABLE IF NOT EXISTS queue_items (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    md5 TEXT NOT NULL,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    mime_type TEXT,
    state TEXT NOT NULL,
    storage_path TEXT,
    upload_progress INTEGER NOT NULL DEFAULT 0,
    processing_progress INTEGER NOT NULL DEFAULT 0,
    processing_stage TEXT,
    hidden INTEGER NOT NULL DEFAULT 0,
    result_json TEXT,
    error_json TEXT,
    page_count INTEGER,
    overall_score INTEGER,
    grade TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    upload_started_at DATETIME,
    upload_completed_at DATETIME,
    processing_started_at DATETIME,
    completed_at DATETIME,
    expires_at DATETIME NOT NULL,
    FOREIGN KEY (client_id) REFERENCES browser_clients(client_id) ON DELETE CASCADE,
    UNIQUE(client_id, md5)
  );

  CREATE INDEX IF NOT EXISTS idx_queue_items_client ON queue_items(client_id);
  CREATE INDEX IF NOT EXISTS idx_queue_items_client_state ON queue_items(client_id, state);
  CREATE INDEX IF NOT EXISTS idx_queue_items_expires ON queue_items(expires_at);

  CREATE TABLE IF NOT EXISTS tool_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tool_name TEXT NOT NULL,
    pdf_class TEXT NOT NULL,
    outcome TEXT NOT NULL,
    round_number INTEGER NOT NULL,
    stage_number INTEGER NOT NULL,
    overall_score_before INTEGER,
    overall_score_after INTEGER,
    category_deltas_json TEXT,
    reliability_success INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_tool_outcomes_tool ON tool_outcomes(tool_name);
  CREATE INDEX IF NOT EXISTS idx_tool_outcomes_tool_pdf_class ON tool_outcomes(tool_name, pdf_class);

  CREATE TABLE IF NOT EXISTS family_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    family_id TEXT NOT NULL,
    pdf_class TEXT NOT NULL,
    step_tool TEXT NOT NULL,
    postcondition_status TEXT NOT NULL,
    round_number INTEGER NOT NULL,
    stage_number INTEGER NOT NULL,
    overall_score_before INTEGER,
    overall_score_after INTEGER,
    blocking_keys_before_json TEXT,
    blocking_keys_after_json TEXT,
    playbook_id TEXT,
    playbook_run_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_family_outcomes_family ON family_outcomes(family_id);
  CREATE INDEX IF NOT EXISTS idx_family_outcomes_family_pdf_class ON family_outcomes(family_id, pdf_class);

  CREATE TABLE IF NOT EXISTS playbook_entries (
    id TEXT PRIMARY KEY,
    failure_signature_hash TEXT NOT NULL,
    failure_mode_keys TEXT NOT NULL,
    pdf_class TEXT NOT NULL,
    tool_sequence TEXT NOT NULL,
    has_images INTEGER NOT NULL DEFAULT 0,
    has_forms INTEGER NOT NULL DEFAULT 0,
    has_tables INTEGER NOT NULL DEFAULT 0,
    page_count_range TEXT NOT NULL DEFAULT 'medium',
    initial_score INTEGER NOT NULL,
    final_score INTEGER NOT NULL,
    success_count INTEGER NOT NULL DEFAULT 1,
    failure_count INTEGER NOT NULL DEFAULT 0,
    total_attempts INTEGER NOT NULL DEFAULT 1,
    avg_rounds REAL NOT NULL DEFAULT 1.0,
    status TEXT NOT NULL DEFAULT 'candidate',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_used_at DATETIME
  );

  CREATE INDEX IF NOT EXISTS idx_playbook_sig ON playbook_entries(failure_signature_hash);
  CREATE INDEX IF NOT EXISTS idx_playbook_status ON playbook_entries(status);

  CREATE TABLE IF NOT EXISTS playbook_runs (
    id TEXT PRIMARY KEY,
    playbook_id TEXT NOT NULL,
    failure_signature_hash TEXT NOT NULL,
    pdf_class TEXT NOT NULL,
    matched_exact INTEGER NOT NULL DEFAULT 1,
    outcome TEXT NOT NULL DEFAULT 'pending',
    initial_score INTEGER NOT NULL,
    final_score INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    FOREIGN KEY (playbook_id) REFERENCES playbook_entries(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_playbook_runs_playbook ON playbook_runs(playbook_id);
`)

function ensureColumn(table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (columns.some(existing => existing.name === column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}

ensureColumn('queue_items', 'original_storage_path', 'TEXT')
ensureColumn('queue_items', 'remediated_storage_path', 'TEXT')
ensureColumn('queue_items', 'rebuilt_storage_path', 'TEXT')
ensureColumn('queue_items', 'document_model_path', 'TEXT')
ensureColumn('queue_items', 'review_assets_dir', 'TEXT')
ensureColumn('queue_items', 'original_result_json', 'TEXT')
ensureColumn('queue_items', 'remediated_result_json', 'TEXT')
ensureColumn('queue_items', 'rebuilt_result_json', 'TEXT')
ensureColumn('queue_items', 'remediation_status', "TEXT NOT NULL DEFAULT 'pending'")
ensureColumn('queue_items', 'document_model_status', "TEXT NOT NULL DEFAULT 'pending'")
ensureColumn('queue_items', 'remediation_error_json', 'TEXT')
ensureColumn('queue_items', 'reconstruction_error_json', 'TEXT')
ensureColumn('queue_items', 'original_page_count', 'INTEGER')
ensureColumn('queue_items', 'original_overall_score', 'INTEGER')
ensureColumn('queue_items', 'original_grade', 'TEXT')
ensureColumn('queue_items', 'remediated_page_count', 'INTEGER')
ensureColumn('queue_items', 'remediated_overall_score', 'INTEGER')
ensureColumn('queue_items', 'remediated_grade', 'TEXT')
ensureColumn('queue_items', 'rebuilt_page_count', 'INTEGER')
ensureColumn('queue_items', 'rebuilt_overall_score', 'INTEGER')
ensureColumn('queue_items', 'rebuilt_grade', 'TEXT')
ensureColumn('queue_items', 'applied_fixes_json', 'TEXT')
ensureColumn('queue_items', 'skipped_fixes_json', 'TEXT')
ensureColumn('queue_items', 'manual_review_flags_json', 'TEXT')
ensureColumn('queue_items', 'ai_applied_changes_json', 'TEXT')
ensureColumn('queue_items', 'ai_suggested_changes_json', 'TEXT')
ensureColumn('queue_items', 'confidence_summary_json', 'TEXT')
ensureColumn('queue_items', 'processing_path', "TEXT NOT NULL DEFAULT 'rebuild'")
ensureColumn('queue_items', 'path_fallbacks_json', 'TEXT')
ensureColumn('queue_items', 'adobe_summary_json', 'TEXT')
ensureColumn('queue_items', 'original_adobe_summary_json', 'TEXT')
ensureColumn('queue_items', 'rebuilt_adobe_summary_json', 'TEXT')
ensureColumn('queue_items', 'owner_kind', 'TEXT')
ensureColumn('queue_items', 'owner_id', 'TEXT')
ensureColumn('queue_items', 'job_group', 'TEXT')
ensureColumn('queue_items', 'supersedes_item_id', 'TEXT')
ensureColumn('queue_items', 'runtime_generation', 'TEXT')
ensureColumn('queue_items', 'code_version', 'TEXT')
ensureColumn('queue_items', 'result_freshness', "TEXT NOT NULL DEFAULT 'fresh'")
ensureColumn('queue_items', 'promotion_status', "TEXT NOT NULL DEFAULT 'unvalidated'")
ensureColumn('queue_items', 'promotion_rejection_reason', 'TEXT')
ensureColumn('queue_items', 'blocker_report_json', 'TEXT')
ensureColumn('tool_outcomes', 'playbook_id', 'TEXT')
ensureColumn('tool_outcomes', 'playbook_run_id', 'TEXT')

export default db
