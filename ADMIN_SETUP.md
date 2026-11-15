# Administrator sign-in and email recovery

The shop has one administrator account. Existing passwords are preserved. Its
initial username is `admin` (or `ADMIN_USERNAME` when migrating). Sign in at
`/#/admin`, then open **Account details → Sign-in and recovery** to save a
username and recovery email, confirming your current password.

For a new database, set `ADMIN_USERNAME`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD`
before starting the server. Passwords require at least 12 characters. For an
existing database these environment values do not overwrite saved credentials.
An owner who has lost the existing password can run
`node server.cjs --reset-admin-password` locally; this prints a new password
and signs out admin sessions while preserving the username and email.

Configure these server environment variables for email recovery:

```powershell
$env:RESEND_API_KEY = 'your-resend-api-key'
$env:EMAIL_FROM = 'Subanese <accounts@your-verified-domain.com>'
$env:PUBLIC_SITE_URL = 'https://your-shop-domain.com'
npm.cmd run dev
```

Use your verified email sender and an HTTPS shop URL accessible to the admin.
Keep credentials out of source control. Restart after changing environment
variables. See EMAIL_SETUP.md for the existing Resend configuration.

**Forgot password?** emails a link and six-digit code to the saved recovery
address. Open the link, enter the code, and enter and confirm a new password.
The link and code must be used together within 15 minutes. Only the latest
request is valid. Five incorrect code attempts invalidate a request, and
requests and verification attempts are also rate limited by client IP.
Successful resets revoke all administrator sessions. Signed-in admins can
request the same email through Account details. The email provider accepting
a request does not guarantee inbox delivery; inspect the provider dashboard
if the email does not arrive.

Recovery returns the same public message for known and unknown addresses.
Reset tokens and codes are stored as hashes and are not added to the order
email queue. No real reset emails are sent by the automated tests.
