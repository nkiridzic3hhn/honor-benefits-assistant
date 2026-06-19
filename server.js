import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import { buildSystemPrompt } from "./prompt.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: "1mb" }));

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// Token prices (USD per 1,000,000 tokens). Defaults are Claude Sonnet 4.6
// ($3.00 input / $15.00 output). Override with env vars if the model or the
// rates ever change. These drive the cost estimate on the /admin dashboard.
const PRICE_IN_PER_MTOK = parseFloat(process.env.PRICE_IN_PER_MTOK || "3.00");
const PRICE_OUT_PER_MTOK = parseFloat(process.env.PRICE_OUT_PER_MTOK || "15.00");

// --- Load the knowledge base once at startup -------------------------------
// To update answers, edit knowledge-base.md and redeploy (push to GitHub;
// Railway redeploys automatically).
let KNOWLEDGE_BASE = "";
try {
  KNOWLEDGE_BASE = fs.readFileSync(path.join(__dirname, "knowledge-base.md"), "utf8");
  console.log(`Loaded knowledge base (${KNOWLEDGE_BASE.length} chars).`);
} catch (e) {
  console.warn("No knowledge-base.md found yet:", e.message);
}
const SYSTEM_PROMPT = buildSystemPrompt(KNOWLEDGE_BASE);

// --- Question log (Postgres) -----------------------------------------------
// Optional: if DATABASE_URL isn't set, the assistant still runs normally and
// logging plus the /admin page are simply turned off. On Railway, add the
// Postgres plugin and it injects DATABASE_URL automatically.
const { Pool } = pg;
let pool = null;
let dbReady = false;

if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : false,
  });
  initDb();
} else {
  console.warn("DATABASE_URL not set — question logging and /admin are disabled.");
}

async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS questions (
        id SERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        question TEXT NOT NULL,
        answer TEXT,
        needs_hr BOOLEAN NOT NULL DEFAULT false,
        reviewed BOOLEAN NOT NULL DEFAULT false,
        session_id TEXT
      );
    `);
    // Add the newer columns if an older table already exists (safe to re-run).
    await pool.query(`ALTER TABLE questions ADD COLUMN IF NOT EXISTS input_tokens INTEGER DEFAULT 0;`);
    await pool.query(`ALTER TABLE questions ADD COLUMN IF NOT EXISTS output_tokens INTEGER DEFAULT 0;`);
    await pool.query(`ALTER TABLE questions ADD COLUMN IF NOT EXISTS cache_read_tokens INTEGER DEFAULT 0;`);
    await pool.query(`ALTER TABLE questions ADD COLUMN IF NOT EXISTS cache_write_tokens INTEGER DEFAULT 0;`);
    await pool.query(`ALTER TABLE questions ADD COLUMN IF NOT EXISTS topic TEXT;`);
    await pool.query(`ALTER TABLE questions ADD COLUMN IF NOT EXISTS agency TEXT;`);
    await pool.query(`CREATE INDEX IF NOT EXISTS questions_created_at_idx ON questions (created_at);`);
    dbReady = true;
    console.log("Question log is ready.");
  } catch (e) {
    console.error("Could not initialize the question log table:", e.message);
  }
}

// Strip things people shouldn't have typed before anything is stored.
function scrubPII(text) {
  if (!text) return text;
  return text
    .replace(/\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g, "[redacted]") // SSN-like
    .replace(/\b\d{9,}\b/g, "[redacted]"); // long digit runs (account numbers, etc.)
}

function normalizeAgency(slug) {
  if (!slug) return "none";
  const s = String(slug).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return s || "none";
}

async function logQuestion(row) {
  if (!pool || !dbReady) return;
  try {
    await pool.query(
      `INSERT INTO questions
         (question, answer, needs_hr, session_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, topic, agency)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        scrubPII(row.question)?.slice(0, 4000) || "",
        scrubPII(row.answer)?.slice(0, 8000) || "",
        !!row.needsHr,
        row.sessionId ? String(row.sessionId).slice(0, 100) : null,
        row.inputTokens || 0,
        row.outputTokens || 0,
        row.cacheReadTokens || 0,
        row.cacheWriteTokens || 0,
        row.topic || "other",
        row.agency || "none",
      ]
    );
  } catch (e) {
    console.error("Could not log question:", e.message);
  }
}

// --- Simple in-memory rate limit (protects your API bill) ------------------
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 30;
const hits = new Map(); // ip -> { count, resetAt }

function rateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now > rec.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  rec.count += 1;
  return rec.count > MAX_PER_WINDOW;
}

// --- Parse and strip the model's hidden review tag -------------------------
// Tag looks like: [[META | topic: premiums_cost | agency: family_care | answered: no]]
// We also still honor the older [[NEEDS_HR]] marker for safety.
const META_RE = /\[\[META\b[^\]]*\]\]/gi;
const LEGACY_NEEDS_HR = /\[\[NEEDS_HR\]\]/gi;

function parseAndStripTag(text) {
  let needsHr = false;
  let topic = "other";
  let agency = "none";

  const metaMatch = text.match(/\[\[META\b[^\]]*\]\]/i);
  if (metaMatch) {
    const raw = metaMatch[0];
    const grab = (key) => {
      const m = raw.match(new RegExp(key + "\\s*:\\s*([A-Za-z0-9_\\-]+)", "i"));
      return m ? m[1].toLowerCase() : null;
    };
    topic = grab("topic") || "other";
    agency = normalizeAgency(grab("agency"));
    needsHr = grab("answered") === "no";
  }
  if (LEGACY_NEEDS_HR.test(text)) needsHr = true;

  const clean = text.replace(META_RE, "").replace(LEGACY_NEEDS_HR, "").trim();
  return { clean, needsHr, topic, agency };
}

// --- Chat endpoint ---------------------------------------------------------
app.post("/api/chat", async (req, res) => {
  try {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;
    if (rateLimited(ip)) {
      return res.status(429).json({ error: "You're sending messages too quickly. Please wait a moment." });
    }

    if (!API_KEY) {
      console.error("ANTHROPIC_API_KEY is not set.");
      return res.status(500).json({ error: "The assistant isn't configured yet. Please contact HR." });
    }

    const { messages, sessionId } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "No question received." });
    }

    const safeMessages = messages
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-20)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));

    if (safeMessages.length === 0) {
      return res.status(400).json({ error: "No question received." });
    }

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        // Cache the system prompt (persona + knowledge base). It's identical on
        // every request, so after the first call Claude reads it from cache at
        // ~1/10 the input price instead of re-charging the full ~8k tokens.
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        messages: safeMessages,
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      console.error("Anthropic API error:", anthropicRes.status, errText);
      return res.status(502).json({ error: "The assistant is temporarily unavailable. Please try again." });
    }

    const data = await anthropicRes.json();
    let reply = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    const { clean, needsHr, topic, agency } = parseAndStripTag(reply);
    const finalReply = clean || "Sorry, I didn't catch that. Could you rephrase?";

    const usage = data.usage || {};
    const lastUser = [...safeMessages].reverse().find((m) => m.role === "user");

    logQuestion({
      question: lastUser?.content || "",
      answer: finalReply,
      needsHr,
      topic,
      agency,
      sessionId,
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
      cacheReadTokens: usage.cache_read_input_tokens || 0,
      cacheWriteTokens: usage.cache_creation_input_tokens || 0,
    });

    res.json({ reply: finalReply });
  } catch (err) {
    console.error("Chat handler error:", err);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// --- Admin (HR review page) ------------------------------------------------
function adminAuth(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(503).send("The review page isn't configured yet. Set ADMIN_PASSWORD to enable it.");
  }
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    const decoded = Buffer.from(encoded, "base64").toString();
    const pass = decoded.slice(decoded.indexOf(":") + 1);
    if (pass && pass === ADMIN_PASSWORD) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="HHN Benefits Review"');
  return res.status(401).send("Authentication required.");
}

app.get("/admin", adminAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, "admin-page.html"));
});

app.get("/api/admin/questions", adminAuth, async (req, res) => {
  if (!pool || !dbReady) return res.json({ dbReady: false, rows: [] });
  try {
    const filter = req.query.filter;
    let where = "";
    if (filter === "needs_hr") where = "WHERE needs_hr = true AND reviewed = false";
    else if (filter === "unreviewed") where = "WHERE reviewed = false";
    const { rows } = await pool.query(
      `SELECT id, created_at, question, answer, needs_hr, reviewed, session_id, topic, agency
       FROM questions ${where}
       ORDER BY created_at DESC
       LIMIT 500`
    );
    res.json({ dbReady: true, rows });
  } catch (e) {
    console.error("Could not load questions:", e.message);
    res.status(500).json({ error: "Could not load questions." });
  }
});

app.get("/api/admin/stats", adminAuth, async (_req, res) => {
  if (!pool || !dbReady) return res.json({ dbReady: false });
  try {
    const [totals, tokens, daily, topics, agencies] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(DISTINCT session_id) FILTER (WHERE created_at >= date_trunc('day', now()))   AS sessions_today,
          COUNT(DISTINCT session_id) FILTER (WHERE created_at >= date_trunc('week', now()))  AS sessions_week,
          COUNT(DISTINCT session_id) FILTER (WHERE created_at >= date_trunc('month', now())) AS sessions_month,
          COUNT(DISTINCT session_id) AS sessions_total,
          COUNT(*) AS messages_total,
          COUNT(*) FILTER (WHERE needs_hr) AS needs_hr_total,
          COUNT(*) FILTER (WHERE needs_hr AND NOT reviewed) AS needs_hr_open
        FROM questions
      `),
      pool.query(`
        SELECT
          COALESCE(SUM(input_tokens),0)  AS in_tok,
          COALESCE(SUM(output_tokens),0) AS out_tok,
          COALESCE(SUM(cache_read_tokens),0)  AS cache_read_tok,
          COALESCE(SUM(cache_write_tokens),0) AS cache_write_tok,
          COALESCE(SUM(input_tokens)  FILTER (WHERE created_at >= date_trunc('month', now())),0) AS in_tok_month,
          COALESCE(SUM(output_tokens) FILTER (WHERE created_at >= date_trunc('month', now())),0) AS out_tok_month,
          COALESCE(SUM(cache_read_tokens)  FILTER (WHERE created_at >= date_trunc('month', now())),0) AS cache_read_month,
          COALESCE(SUM(cache_write_tokens) FILTER (WHERE created_at >= date_trunc('month', now())),0) AS cache_write_month
        FROM questions
      `),
      pool.query(`
        SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
               COUNT(DISTINCT session_id) AS sessions,
               COUNT(*) AS messages
        FROM questions
        WHERE created_at >= now() - interval '13 days'
        GROUP BY 1 ORDER BY 1
      `),
      pool.query(`
        SELECT COALESCE(NULLIF(topic,''),'other') AS topic, COUNT(*) AS n
        FROM questions GROUP BY 1 ORDER BY n DESC LIMIT 20
      `),
      pool.query(`
        SELECT COALESCE(NULLIF(agency,''),'unknown') AS agency, COUNT(*) AS n
        FROM questions
        WHERE agency IS NOT NULL AND agency NOT IN ('none','')
        GROUP BY 1 ORDER BY n DESC LIMIT 20
      `),
    ]);

    const t = totals.rows[0];
    const k = tokens.rows[0];
    const num = (x) => Number(x) || 0;
    // Cache reads are billed at ~10% of input; 5-minute cache writes at ~125%.
    const CACHE_READ_PER_MTOK = PRICE_IN_PER_MTOK * 0.1;
    const CACHE_WRITE_PER_MTOK = PRICE_IN_PER_MTOK * 1.25;
    const cost = (inTok, outTok, cacheRead, cacheWrite) =>
      (num(inTok) / 1e6) * PRICE_IN_PER_MTOK +
      (num(outTok) / 1e6) * PRICE_OUT_PER_MTOK +
      (num(cacheRead) / 1e6) * CACHE_READ_PER_MTOK +
      (num(cacheWrite) / 1e6) * CACHE_WRITE_PER_MTOK;

    res.json({
      dbReady: true,
      conversations: {
        today: num(t.sessions_today),
        week: num(t.sessions_week),
        month: num(t.sessions_month),
        total: num(t.sessions_total),
      },
      messagesTotal: num(t.messages_total),
      needsHr: { total: num(t.needs_hr_total), open: num(t.needs_hr_open) },
      cost: {
        inputTokens: num(k.in_tok) + num(k.cache_read_tok) + num(k.cache_write_tok),
        outputTokens: num(k.out_tok),
        cachedReadTokens: num(k.cache_read_tok),
        total: cost(k.in_tok, k.out_tok, k.cache_read_tok, k.cache_write_tok),
        month: cost(k.in_tok_month, k.out_tok_month, k.cache_read_month, k.cache_write_month),
        rates: { input: PRICE_IN_PER_MTOK, output: PRICE_OUT_PER_MTOK },
      },
      daily: daily.rows.map((r) => ({ day: r.day, sessions: num(r.sessions), messages: num(r.messages) })),
      topics: topics.rows.map((r) => ({ topic: r.topic, n: num(r.n) })),
      agencies: agencies.rows.map((r) => ({ agency: r.agency, n: num(r.n) })),
    });
  } catch (e) {
    console.error("Could not load stats:", e.message);
    res.status(500).json({ error: "Could not load stats." });
  }
});

app.post("/api/admin/questions/:id/review", adminAuth, async (req, res) => {
  if (!pool || !dbReady) return res.status(503).json({ error: "Review log isn't available." });
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Bad id." });
  const reviewed = req.body?.reviewed !== false;
  try {
    await pool.query("UPDATE questions SET reviewed = $1 WHERE id = $2", [reviewed, id]);
    res.json({ ok: true });
  } catch (e) {
    console.error("Could not update question:", e.message);
    res.status(500).json({ error: "Could not update." });
  }
});

// --- Static site (the employee-facing assistant) ---------------------------
// Everything lives in one flat folder, so we serve ONLY an explicit allow-list.
// This keeps internal files (server.js, prompt.js, knowledge-base.md,
// admin-page.html, Dockerfile, configs) private even though they sit alongside
// the public assets.
const STATIC_FILES = {
  "/": "index.html",
  "/index.html": "index.html",
  "/styles.css": "styles.css",
  "/app.js": "app.js",
  "/honor-health-logo.jpg": "honor-health-logo.jpg",
};
const PUBLIC_PDFS = new Set([
  "2026-engage-benefits-summary.pdf",
  "401k-enrollment-booklet.pdf",
  "accessing-your-account.pdf",
  "hardship-withdrawal-request.pdf",
  "incoming-rollover-request.pdf",
]);

app.get(Object.keys(STATIC_FILES), (req, res) => {
  res.sendFile(path.join(__dirname, STATIC_FILES[req.path]));
});

// The knowledge base links PDFs as /forms/<name>.pdf, but they live at the root.
app.get("/forms/:name", (req, res) => {
  if (PUBLIC_PDFS.has(req.params.name)) {
    return res.sendFile(path.join(__dirname, req.params.name));
  }
  res.status(404).send("Not found.");
});

app.get("/healthz", (_req, res) => res.send("ok"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HHN Benefits Assistant running on port ${PORT} (model: ${MODEL})`));
