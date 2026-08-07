// Student AI — backend
// AI inference happens entirely in the browser (WebLLM, no API key).
// This server only handles: signup/login, storing conversations/messages,
// and an admin dashboard gated by a single passcode (see seed-admin.js).
import express from 'express';
import cors from 'cors';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const { Pool } = pg;
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const PORT = process.env.PORT || 5000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now(),
      last_login_at TIMESTAMPTZ,
      blocked BOOLEAN DEFAULT false
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      title TEXT DEFAULT 'New chat',
      subject TEXT DEFAULT 'general',
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS admin_auth (
      id INTEGER PRIMARY KEY DEFAULT 1,
      passcode_hash TEXT NOT NULL
    );
  `);
}

function sign(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
}
function auth(requiredType) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Sign in required.' });
    try {
      const data = jwt.verify(token, JWT_SECRET);
      if (requiredType && data.type !== requiredType) throw new Error('wrong type');
      req.auth = data;
      next();
    } catch (e) {
      res.status(401).json({ error: 'Session expired. Please sign in again.' });
    }
  };
}

/* ---------------- Customer auth ---------------- */
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    if (!name || !email || !password || password.length < 6) {
      return res.status(400).json({ error: 'Name, email, and a password (6+ chars) are required.' });
    }
    const existing = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
    if (existing.rows.length) return res.status(400).json({ error: 'An account with this email already exists.' });
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (name, email, password_hash, last_login_at) VALUES ($1,$2,$3, now()) RETURNING id, name, email',
      [name, email, hash]
    );
    const user = result.rows[0];
    res.json({ token: sign({ type: 'user', id: user.id }), user: { name: user.name, email: user.email } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Something went wrong. Try again.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const result = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
    const user = result.rows[0];
    if (!user) return res.status(400).json({ error: 'No account with that email.' });
    if (user.blocked) return res.status(403).json({ error: 'This account has been blocked.' });
    const ok = await bcrypt.compare(password || '', user.password_hash);
    if (!ok) return res.status(400).json({ error: 'Wrong password.' });
    await pool.query('UPDATE users SET last_login_at = now() WHERE id=$1', [user.id]);
    res.json({ token: sign({ type: 'user', id: user.id }), user: { name: user.name, email: user.email } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Something went wrong. Try again.' });
  }
});

/* ---------------- Conversations & messages (AI reply generated client-side) ---------------- */
app.get('/api/chat/conversations', auth('user'), async (req, res) => {
  const r = await pool.query('SELECT id, title, subject, updated_at AS "updatedAt" FROM conversations WHERE user_id=$1 ORDER BY updated_at DESC', [req.auth.id]);
  res.json({ conversations: r.rows });
});

app.post('/api/chat/conversations', auth('user'), async (req, res) => {
  const subject = (req.body && req.body.subject) || 'general';
  const r = await pool.query(
    'INSERT INTO conversations (user_id, subject) VALUES ($1,$2) RETURNING id, title, subject, updated_at AS "updatedAt"',
    [req.auth.id, subject]
  );
  res.json(r.rows[0]);
});

app.delete('/api/chat/conversations/:id', auth('user'), async (req, res) => {
  await pool.query('DELETE FROM conversations WHERE id=$1 AND user_id=$2', [req.params.id, req.auth.id]);
  res.json({ ok: true });
});

app.get('/api/chat/conversations/:id/messages', auth('user'), async (req, res) => {
  const conv = await pool.query('SELECT id FROM conversations WHERE id=$1 AND user_id=$2', [req.params.id, req.auth.id]);
  if (!conv.rows.length) return res.status(404).json({ error: 'Conversation not found.' });
  const r = await pool.query('SELECT id, role, content FROM messages WHERE conversation_id=$1 ORDER BY id ASC', [req.params.id]);
  res.json({ messages: r.rows });
});

// Client already generated the AI reply locally (WebLLM). This just persists both turns.
app.post('/api/chat/conversations/:id/message', auth('user'), async (req, res) => {
  try {
    const { content, reply } = req.body || {};
    if (!content || !reply) return res.status(400).json({ error: 'Missing message content or reply.' });
    const conv = await pool.query('SELECT * FROM conversations WHERE id=$1 AND user_id=$2', [req.params.id, req.auth.id]);
    if (!conv.rows.length) return res.status(404).json({ error: 'Conversation not found.' });

    const userMsg = await pool.query(
      "INSERT INTO messages (conversation_id, role, content) VALUES ($1,'user',$2) RETURNING id",
      [req.params.id, content]
    );
    const botMsg = await pool.query(
      "INSERT INTO messages (conversation_id, role, content) VALUES ($1,'assistant',$2) RETURNING id",
      [req.params.id, reply]
    );

    let title = conv.rows[0].title;
    if (!title || title === 'New chat') {
      title = content.slice(0, 48) + (content.length > 48 ? '…' : '');
      await pool.query('UPDATE conversations SET title=$1, updated_at=now() WHERE id=$2', [title, req.params.id]);
    } else {
      await pool.query('UPDATE conversations SET updated_at=now() WHERE id=$1', [req.params.id]);
    }

    res.json({ userMessageId: userMsg.rows[0].id, assistantMessageId: botMsg.rows[0].id, title });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not save this message.' });
  }
});

/* ---------------- Admin (single shared passcode, set via seed-admin.js) ---------------- */
app.post('/api/admin/login', async (req, res) => {
  try {
    const { passcode } = req.body || {};
    const r = await pool.query('SELECT passcode_hash FROM admin_auth WHERE id=1');
    if (!r.rows.length) return res.status(400).json({ error: 'Admin passcode not set up yet. Run seed-admin.js first.' });
    const ok = await bcrypt.compare(passcode || '', r.rows[0].passcode_hash);
    if (!ok) return res.status(400).json({ error: 'Wrong passcode.' });
    res.json({ token: sign({ type: 'admin' }) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.get('/api/admin/customers', auth('admin'), async (req, res) => {
  const r = await pool.query(`
    SELECT u.name, u.email, u.created_at AS "createdAt", u.last_login_at AS "lastLoginAt", u.blocked,
           COUNT(c.id) AS "conversationCount"
    FROM users u LEFT JOIN conversations c ON c.user_id = u.id
    GROUP BY u.id ORDER BY u.created_at DESC
  `);
  res.json({ customers: r.rows });
});

app.post('/api/admin/customers/:email/block', auth('admin'), async (req, res) => {
  await pool.query('UPDATE users SET blocked = NOT blocked WHERE email=$1', [req.params.email]);
  res.json({ ok: true });
});

app.get('/api/admin/customers/:email/conversations', auth('admin'), async (req, res) => {
  const u = await pool.query('SELECT id FROM users WHERE email=$1', [req.params.email]);
  if (!u.rows.length) return res.status(404).json({ error: 'Customer not found.' });
  const r = await pool.query(
    'SELECT id, title, subject, updated_at AS "updatedAt" FROM conversations WHERE user_id=$1 ORDER BY updated_at DESC',
    [u.rows[0].id]
  );
  res.json({ conversations: r.rows });
});

app.get('/api/admin/conversations/:id/messages', auth('admin'), async (req, res) => {
  const r = await pool.query('SELECT id, role, content FROM messages WHERE conversation_id=$1 ORDER BY id ASC', [req.params.id]);
  res.json({ messages: r.rows });
});

app.use(express.static('public'));

initDb()
  .then(() => app.listen(PORT, () => console.log(`Student AI server running on port ${PORT}`)))
  .catch((e) => { console.error('DB init failed:', e); process.exit(1); });
