# Deployment Notes

This app is ready to deploy as a Render Blueprint using `render.yaml`.

## Render Blueprint

1. Push this repository to GitHub.
2. In Render, create a new Blueprint from the repository.
3. Render will create:
   - a Node web service named `hockey-pool`
   - a Postgres database named `hockey-pool-db`
4. When Render prompts for secret values, enter the Stripe values below.

The web service uses:

```text
Build Command: npm ci && npm run build
Start Command: npm start
Health Check Path: /api/health
```

## Render Postgres

The Blueprint wires the database connection automatically:

```text
DATABASE_URL=<Render internal database URL>
```

The server creates these tables automatically on startup:

- `users`
- `sessions`
- `tickets`

Local development still uses `data/pool.json` unless `DATABASE_URL` is set.

## Stripe

For Stripe test payments, add these Render environment variables when prompted:

```text
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
TICKET_PRICE_CENTS=300
```

Without `STRIPE_SECRET_KEY`, tickets are marked paid automatically for local/dev testing.

After deployment, add a Stripe webhook endpoint pointing at:

```text
https://<your-render-domain>/api/stripe/webhook
```
