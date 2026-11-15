const {randomBytes, randomInt, createHash, scryptSync, timingSafeEqual} = require('node:crypto');
const digest = value => createHash('sha256').update(value).digest('hex');
function createAdminAuth(db, {env = process.env, fetchImpl = fetch, now = Date.now} = {}) {
  const columns = db.prepare('PRAGMA table_info(admin)').all();
  for (const name of ['username', 'email']) if (!columns.some(c => c.name === name)) db.exec(`ALTER TABLE admin ADD COLUMN ${name} TEXT NOT NULL DEFAULT ''`);
  db.exec(`CREATE TABLE IF NOT EXISTS admin_password_resets (token TEXT PRIMARY KEY, code TEXT NOT NULL, expires INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0)`);
  if (!db.prepare('PRAGMA table_info(admin_password_resets)').all().some(c => c.name === 'grant')) db.exec("ALTER TABLE admin_password_resets ADD COLUMN grant TEXT NOT NULL DEFAULT ''");
  db.prepare("UPDATE admin SET username = ? WHERE username = ''").run(env.ADMIN_USERNAME || 'admin');
  if (env.ADMIN_EMAIL) db.prepare("UPDATE admin SET email = ? WHERE email = ''").run(env.ADMIN_EMAIL.trim().toLowerCase());
  const limits = new Map();
  function limit(key, maximum) {
    const time = now();
    for (const [key, entry] of limits) if (entry.until <= time) limits.delete(key);
    const entry = limits.get(key) || {count: 0, until: time + 900000};
    limits.set(key, entry);
    if (++entry.count > maximum) throw Object.assign(Error('Too many attempts. Try again in 15 minutes.'), {status:429});
  }
  function profile(body) {
    const username = String(body.username || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    if (!/^[a-zA-Z0-9_.-]{3,64}$/.test(username)) throw Error('Use 3–64 letters, numbers, dots, underscores or hyphens for the username.');
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Error('Enter a valid recovery email.');
    return {username, email};
  }
  async function requestReset(address, ip) {
    limit('request:'+ip, 5);
    const base = new URL(env.PUBLIC_SITE_URL || 'http://localhost:3000');
    if (!env.RESEND_API_KEY || !env.EMAIL_FROM || !env.PUBLIC_SITE_URL || base.protocol !== 'https:') throw Object.assign(Error('Email recovery is not configured. Contact the site owner.'), {status:503});
    const admin = db.prepare('SELECT * FROM admin LIMIT 1').get();
    const token = randomBytes(32).toString('hex');
    if (!admin.email || String(address || '').trim().toLowerCase() !== admin.email) return token;
    const code = String(randomInt(100000,1000000));
    db.exec('DELETE FROM admin_password_resets');
    db.prepare('INSERT INTO admin_password_resets (token,code,expires) VALUES (?,?,?)').run(digest(token),digest(code),now()+900000);
    base.hash = '/admin?reset=' + token;
    try {
      const result = await fetchImpl('https://api.resend.com/emails', {
        method:'POST', headers:{Authorization:'Bearer '+env.RESEND_API_KEY,'Content-Type':'application/json'},
        body:JSON.stringify({from:env.EMAIL_FROM,to:[admin.email],subject:'Reset your Subanese administrator password',text:'Open this link: '+base.href+'\n\nEnter this code: '+code+'\n\nThis link and code expire in 15 minutes and can be used once. If you did not request this, ignore this email.'}), signal:AbortSignal.timeout(15000)
      });
      if (!result.ok) throw Error('Email delivery failed.');
    } catch {
      db.prepare('DELETE FROM admin_password_resets WHERE token = ?').run(digest(token));
      // Keep the public response identical for registered and unknown addresses.
      console.error('Administrator recovery email failed; check email service configuration.');
    }
    return token;
  }
  function verifyCode(body, ip) {
    limit('verify:'+ip, 10);
    const token = digest(String(body.token || ''));
    const record = db.prepare('SELECT * FROM admin_password_resets WHERE token = ?').get(token);
    if (!record || record.expires <= now() || record.attempts >= 5 || record.grant) throw Error('The link or code is invalid or expired. Request a new email.');
    db.prepare('UPDATE admin_password_resets SET attempts = attempts + 1 WHERE token = ?').run(token);
    if (!timingSafeEqual(Buffer.from(record.code,'hex'),Buffer.from(digest(String(body.code || '')),'hex'))) throw Error('The link or code is invalid or expired. Request a new email.');
    const grant = randomBytes(32).toString('hex');
    db.prepare('UPDATE admin_password_resets SET grant = ? WHERE token = ?').run(digest(grant),token);
    return grant;
  }
  function reset(body, ip) {
    limit('verify:'+ip, 10);
    const password = String(body.password || '');
    if (password.length < 12 || password.length > 128) throw Error('Use a password between 12 and 128 characters.');
    const token = digest(String(body.token || ''));
    const record = body.grant
      ? db.prepare('SELECT * FROM admin_password_resets WHERE grant = ?').get(digest(String(body.grant)))
      : db.prepare('SELECT * FROM admin_password_resets WHERE token = ?').get(token);
    if (!record || record.expires <= now() || (!body.grant && record.attempts >= 5)) throw Error('The link or code is invalid or expired. Request a new email.');
    if (!body.grant) {
      db.prepare('UPDATE admin_password_resets SET attempts = attempts + 1 WHERE token = ?').run(token);
      if (record.grant || !timingSafeEqual(Buffer.from(record.code,'hex'),Buffer.from(digest(String(body.code || '')),'hex'))) throw Error('The link or code is invalid or expired. Request a new email.');
    }
    const salt = randomBytes(18).toString('hex');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE admin SET salt = ?, password = ?').run(salt,scryptSync(password,salt,64).toString('hex'));
      db.exec('DELETE FROM sessions; DELETE FROM admin_password_resets; COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  return {profile, requestReset, verifyCode, reset, limit};
}
module.exports = {createAdminAuth};
