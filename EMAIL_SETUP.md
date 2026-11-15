# Customer order emails

The server automatically loads the project `.env` file. Fill in
`RESEND_API_KEY`, `EMAIL_FROM` (a verified sender), `PUBLIC_SITE_URL` (the HTTPS
website address), and `ADMIN_EMAIL` (the recovery address). The `.env` file is
excluded from Git. Restart the server after saving changes. For an existing
administrator with a saved recovery email, update that address in Account
details; `ADMIN_EMAIL` only fills a blank recovery address.

The shop uses Resend for transactional emails. Set up a verified sending domain in
Resend and create a sending API key. See https://resend.com/docs/send-with-nodejs.
Do not put the API key in browser code or commit it to source control.

In PowerShell, set these values before starting the server:

```powershell
$env:RESEND_API_KEY = 'your-resend-api-key'
$env:EMAIL_FROM = 'pastries by subanesse <orders@your-verified-domain.com>'
$env:EMAIL_REPLY_TO = 'your-bakery-contact@your-domain.com'
$env:PUBLIC_SITE_URL = 'https://your-public-shop-domain.com'
node server.cjs
```

Replace the example values with your real configuration. EMAIL_REPLY_TO and
PUBLIC_SITE_URL are optional. Set PUBLIC_SITE_URL to the publicly accessible shop
address to include private order tracking links. Never use localhost in emails
to customers. Restart the server after changing configuration.

Notifications are created for:

- A newly confirmed order.
- Preparing, ready for pickup, out for delivery, completed, and cancelled statuses.
- New custom cake requests and changes to their request status.

Adding an item or changing inventory does not email unrelated customers.

The SQLite email queue is saved in the same transaction as the order change.
Pending notifications survive restarts. When configured, the worker processes
notifications immediately and every 30 seconds, retrying failed requests up to
five times with increasing delays. Notifications for an order are processed in
sequence. Provider idempotency keys reduce duplicate sends on retries.

Admin shows the latest notification status for each order. “Submitted to email
service” means Resend accepted the message; it does not confirm inbox delivery.
Check Resend's dashboard for delivery and bounce information. After five failed
attempts, investigate the provider configuration and saved queue entry before
retrying it; no automatic retry occurs for that failed entry.

Existing orders are not emailed retroactively. Without sending credentials,
new notifications remain queued. No emails were sent while implementing this
feature; verification uses an in-memory database and a mocked email service.
