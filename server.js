const express = require("express");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const INVITE_TOKEN = process.env.INVITE_TOKEN;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "invites.db");

if (!INVITE_TOKEN || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error("Missing env vars: INVITE_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID");
  process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS invite_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    used INTEGER NOT NULL DEFAULT 0,
    used_at TEXT
  );
  INSERT OR IGNORE INTO invite_state (id, used) VALUES (1, 0);
`);

app.use(express.json({ limit: "2kb" }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

function tokenMatches(value) {
  if (typeof value !== "string") return false;
  const a = Buffer.from(value);
  const b = Buffer.from(INVITE_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.get("/api/status", (req, res) => {
  if (!tokenMatches(req.query.token)) return res.status(404).json({ ok: false });
  const row = db.prepare("SELECT used FROM invite_state WHERE id = 1").get();
  res.json({ available: row.used === 0 });
});

app.post("/api/answer", async (req, res) => {
  if (!tokenMatches(req.body && req.body.token)) {
    return res.status(404).json({ ok: false, message: "Приглашение не найдено." });
  }

  // Consume the invitation atomically before sending the notification.
  const consume = db.prepare(`
    UPDATE invite_state SET used = 1, used_at = ?
    WHERE id = 1 AND used = 0
  `).run(new Date().toISOString());

  if (consume.changes !== 1) {
    return res.status(410).json({ ok: false, message: "Это приглашение уже использовано." });
  }

  const message = "💗 Она приняла приглашение на свидание! Кажется, пора готовить что-то особенное 🌷";
  try {
    const tg = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message })
    });
    const data = await tg.json();
    if (!tg.ok || !data.ok) {
      console.error("Telegram notification failed:", data.description || tg.status);
      // Invitation stays consumed to prevent duplicate responses.
      return res.status(200).json({ ok: true, notificationSent: false });
    }
    return res.json({ ok: true, notificationSent: true });
  } catch (err) {
    console.error("Telegram request failed:", err.message);
    return res.status(200).json({ ok: true, notificationSent: false });
  }
});

app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => console.log(`Invitation app listening on ${PORT}`));
