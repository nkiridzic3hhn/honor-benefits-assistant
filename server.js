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
    // Railway's internal connection doesn't need SSL. Set PGSSL=true if you
    // connect over the public URL instead.
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

async function logQuestion({ question, answer, needsHr, sessionId }) {
  if (!pool || !dbReady) return;
  try {
    await pool.query(
      `INSERT INTO questions (question, answer, needs_hr, session_id)
       VALUES ($1, $2, $3, $4)`,
      [
        scrubPII(question)?.slice(0, 4000) || "",
        scrubPII(answer)?.slice(0, 8000) || "",
        !!needsHr,
        sessionId ? String(sessionId).slice(0, 100) : null,
      ]
    );
  } catch (e) {
    console.error("Could not log question:", e.message);
  }
}

// --- Simple in-memory rate limit (protects your API bill) ------------------
// Not a real auth system. Replace with proper access control before going wide.
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

// The hidden marker the model appends when it had to send someone to HR.
const NEEDS_HR_MARKER = "[[NEEDS_HR]]";

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

    // Sanitize: only valid roles, cap history length and message size.
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
        system: SYSTEM_PROMPT,
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

    // Detect and strip the internal review marker before showing the reply.
    const needsHr = reply.includes(NEEDS_HR_MARKER);
    if (needsHr) reply = reply.split(NEEDS_HR_MARKER).join("").trim();

    const finalReply = reply || "Sorry, I didn't catch that. Could you rephrase?";

    // Log the question for HR's review page (fire and forget).
    const lastUser = [...safeMessages].reverse().find((m) => m.role === "user");
    logQuestion({ question: lastUser?.content || "", answer: finalReply, needsHr, sessionId });

    res.json({ reply: finalReply });
  } catch (err) {
    console.error("Chat handler error:", err);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// --- Admin (HR review page) ------------------------------------------------
// Gated with HTTP Basic auth against ADMIN_PASSWORD. Username is ignored.
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
    if (filter === "needs_hr") where = "WHERE needs_hr = true";
    else if (filter === "unreviewed") where = "WHERE reviewed = false";
    const { rows } = await pool.query(
      `SELECT id, created_at, question, answer, needs_hr, reviewed, session_id
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
app.use(express.static(path.join(__dirname, "public")));

app.get("/healthz", (_req, res) => res.send("ok"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HHN Benefits Assistant running on port ${PORT} (model: ${MODEL})`));
