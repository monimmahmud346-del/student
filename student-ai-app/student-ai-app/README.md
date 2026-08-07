# জিজ্ঞাসা — Student AI

Login/signup + saved chat history + admin dashboard, styled dark (KROVOS-style).
**AI runs entirely in the student's browser (WebLLM, WebGPU) — no AI API key anywhere.**
The backend (Express + Postgres) only handles accounts and stores chat history.

## Setup

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL (a free Postgres, e.g. Replit's built-in DB, works)
node seed-admin.js "your-admin-passcode"   # sets the shared admin passcode (min 6 chars)
npm start
```

Open `http://localhost:5000`.

## How it works

- Student signs up / logs in (email + password, stored hashed).
- Picks a subject (General / Science / Arts / Commerce) — this sets the tutor's system prompt.
- Clicks **Load AI** once — downloads a small model to the browser (0.7–2.3GB depending on choice), cached after that.
- Every reply is generated **locally in the browser**, then just saved to the database so chat history persists across devices/logins.
- Admin (`Admin access →` on the login screen) signs in with the shared passcode from `seed-admin.js`, and can view/block any customer and read their chat transcripts.

## Deploying (e.g. Replit)

1. Add a Postgres database (Replit has a free built-in Postgres — copy its connection string into `DATABASE_URL`).
2. Run `node seed-admin.js "..."` once from the shell to set the admin passcode.
3. Run `npm start`. Requires Chrome/Edge on the student's device (desktop, WebGPU) for the AI to load — WebGPU isn't available on all phones/older browsers yet.

## Notes / limits

- Small models (1B–3B params) are not as capable as ChatGPT, but are solid for student-level explanations.
- No AI cost, ever — inference happens on the student's own device.
- If a student's device doesn't support WebGPU, they'll see a clear message asking them to use an updated Chrome/Edge on desktop.
