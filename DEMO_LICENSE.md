# Internal Demo License

> **⚠️ Internal use only — do not share this file or its contents publicly.**
> This key is for developers, QA, and support staff testing SootheVoice
> locally or offline. It is not, and must never become, user-facing.

## Purpose

SootheVoice's subscription system (`src/main/license-config.ts` /
`src/main/subscription-monitor.ts`) recognizes one special license key that
activates a local, offline 30-day license token without contacting the
verification server. This is useful for:

- Automated tests and CI runs that need a licensed state without a live
  payment/verification backend.
- Manual QA of licensed features on a machine with no network access.
- Support staff reproducing a customer's licensed experience.

It is **not** a substitute for a real license and is **not** shown anywhere
in the app UI (Ticket 47 removed the old on-screen hint and its guessable
key, `SOOTHEVOICE-DEMO-2026`).

## The key

```
SOOTHEVOICE-DEMO-8f3aQ9c#2b7e1D4f6a9B2c3d4e5F6a7b8C9d0e1f
```

57 characters, mixed-case letters, digits, and a special character — long
and random enough not to be guessable, unlike the old key.

## How to use it

1. Make it available to the app via the `DEMO_LICENSE_KEY` environment
   variable (preferred — see `src/main/license-config.ts`, which reads
   `process.env['DEMO_LICENSE_KEY']` and only falls back to the value above
   if that variable is unset):

   ```bash
   DEMO_LICENSE_KEY='SOOTHEVOICE-DEMO-8f3aQ9c#2b7e1D4f6a9B2c3d4e5F6a7b8C9d0e1f' npm run dev
   ```

2. Open **Settings → Subscription** in a running dev build.
3. Under "Or enter an existing license key", paste the key above and click
   **Activate**. Matching is case-insensitive, so it still works even
   though the key-entry field upper-cases whatever you type.
4. The app creates a local 30-day `monthly`-plan token with all features
   unlocked, without calling the serverless verification endpoint.

This is for **development only**. Never enter this key, or reference it, in
a production/customer-facing environment or support ticket that a customer
can see.

## Security notes

- This file is intentionally excluded from packaged builds — `files:` in
  `electron-builder.js` only bundles `out/**/*`, `node_modules/**/*`, and
  `package.json`, so root-level Markdown files (including this one) never
  ship in the `.dmg`/`.exe`/`AppImage`/`.deb` output.
- The key is not referenced anywhere in `src/renderer` (the UI bundle) —
  it is only compared in the main process (`subscription-monitor.ts`).
- If this key is ever suspected of leaking beyond the team, rotate it:
  generate a new long, random value, update the fallback in
  `src/main/license-config.ts` (or set `DEMO_LICENSE_KEY` in your
  deployment/CI secrets instead), and update this file to match.
