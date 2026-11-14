const { randomBytes } = require("node:crypto");

function createEmailQueue(db, { env = process.env, fetchImpl = fetch } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS email_notifications (
    id TEXT PRIMARY KEY, event_key TEXT NOT NULL UNIQUE,
    reference TEXT NOT NULL, recipient TEXT NOT NULL,
    subject TEXT NOT NULL, body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '',
    provider_id TEXT, created INTEGER NOT NULL
  )`);
  const configured = Boolean(env.RESEND_API_KEY && env.EMAIL_FROM);
  let running = false;

  // Call inside the same transaction as the order update.
  function enqueue({ eventKey, reference, recipient, subject, body }) {
    db.prepare(`INSERT OR IGNORE INTO email_notifications
      (id, event_key, reference, recipient, subject, body, created)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      randomBytes(18).toString("hex"), eventKey, reference, recipient, subject, body, Date.now()
    );
  }

  function latest(reference) {
    return db.prepare(`SELECT status, attempts, last_error FROM email_notifications
      WHERE reference = ? ORDER BY rowid DESC LIMIT 1`).get(reference) || null;
  }

  async function flush() {
    if (!configured || running) return;
    running = true;
    try {
      const jobs = db.prepare(`SELECT * FROM email_notifications
        WHERE status = 'pending' AND next_attempt <= ? ORDER BY rowid LIMIT 5`).all(Date.now());
      for (const job of jobs) {
        // Keep updates for one order in sequence, including while retrying.
        const earlier = db.prepare(`SELECT 1 FROM email_notifications
          WHERE reference = ? AND rowid < (SELECT rowid FROM email_notifications WHERE id = ?)
          AND status = 'pending'`).get(job.reference, job.id);
        if (earlier) continue;
        const attempts = job.attempts + 1;
        try {
          const response = await fetchImpl("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              Authorization: "Bearer " + env.RESEND_API_KEY,
              "Content-Type": "application/json",
              "Idempotency-Key": "bakery-notification/" + job.id
            },
            body: JSON.stringify({
              from: env.EMAIL_FROM, to: [job.recipient],
              subject: job.subject, text: job.body,
              ...(env.EMAIL_REPLY_TO ? { reply_to: env.EMAIL_REPLY_TO } : {})
            }),
            signal: AbortSignal.timeout(15000)
          });
          if (!response.ok) throw Error("Email provider returned HTTP " + response.status);
          const result = await response.json();
          if (!result.id) throw Error("Email provider did not return a message ID");
          db.prepare(`UPDATE email_notifications SET status = 'submitted',
            attempts = ?, last_error = '', provider_id = ? WHERE id = ?`)
            .run(attempts, result.id, job.id);
        } catch (error) {
          db.prepare(`UPDATE email_notifications SET status = ?, attempts = ?,
            next_attempt = ?, last_error = ? WHERE id = ?`).run(
            attempts >= 5 ? "failed" : "pending", attempts,
            Date.now() + Math.min(3600000, 30000 * 2 ** (attempts - 1)),
            String(error.message).slice(0, 300), job.id
          );
        }
      }
    } catch {
      console.error("Email queue processing failed; pending notifications remain saved.");
    } finally { running = false; }
  }

  return { enqueue, latest, flush, configured };
}

module.exports = { createEmailQueue };
