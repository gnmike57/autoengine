import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = path.join(process.cwd(), 'data', 'credentials.sqlite');
const WEIGHTS_PATH = path.join(process.cwd(), 'hermes', 'stealth-weights.json');

/**
 * Hermes RL Stealth Profiler
 * 
 * Runs offline analysis on the SQLite database to correlate fingerprint seeds
 * with successful login outcomes.
 * 
 * It calculates the success rate of each seed and saves the top performing
 * seeds to a weights file, which the engine can use to favor winning profiles.
 */
function analyzeFingerprints() {
  console.log("🧠 Hermes RL: Analyzing fingerprint success rates...");

  if (!fs.existsSync(DB_PATH)) {
    console.error("❌ Database not found at", DB_PATH);
    return;
  }

  const db = new Database(DB_PATH, { readonly: true });

  // Query: Join fingerprints with test_runs to calculate success rate per seed
  const query = `
    SELECT 
      json_extract(sf.fingerprint_data, '$.seed') as seed,
      COUNT(tr.id) as total_runs,
      SUM(CASE WHEN tr.outcome = 'success' OR tr.outcome = '2FA' THEN 1 ELSE 0 END) as successful_runs
    FROM session_fingerprints sf
    JOIN test_runs tr ON sf.session_id = tr.session_id
    WHERE sf.fingerprint_data IS NOT NULL
    GROUP BY seed
    HAVING total_runs > 1
    ORDER BY successful_runs DESC, total_runs ASC
    LIMIT 100
  `;

  try {
    const rows = db.prepare(query).all() as { seed: number; total_runs: number; successful_runs: number }[];
    
    if (rows.length === 0) {
      console.log("⚠️ No sufficient data to build RL weights yet. Using default random distribution.");
      return;
    }

    const weights = rows.map(r => ({
      seed: Number(r.seed),
      successRate: r.total_runs > 0 ? (r.successful_runs / r.total_runs) : 0,
      totalRuns: r.total_runs
    })).filter(w => w.successRate > 0);

    fs.writeFileSync(WEIGHTS_PATH, JSON.stringify(weights, null, 2));
    console.log(`✅ Hermes RL: Saved ${weights.length} optimized fingerprint profiles to stealth-weights.json`);
    
  } catch (error) {
    console.error("❌ RL Profiler Error:", error);
  } finally {
    db.close();
  }
}

analyzeFingerprints();
