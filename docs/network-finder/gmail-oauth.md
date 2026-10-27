# Gmail drafts — Google Cloud OAuth setup

Network Finder saves a **draft** (never sends) in each member's own Gmail. Each member authorises their own
account through Google's consent screen at `/gmail`. No Gmail passwords or app passwords are used anywhere.

JobSync asks for exactly three scopes:

| Scope | Why |
|---|---|
| `openid`, `email` | know which Gmail address was connected |
| `https://www.googleapis.com/auth/gmail.compose` | create drafts (this scope also *technically* allows sending, but JobSync only ever calls `drafts.create`; no send endpoint exists in the code) |

It cannot read mail (no `gmail.readonly` / `gmail.modify`).

**Optional — "sent" tracking (`GMAIL_TRACK_SENT=true`).** To move a Connection to *Messaged* when a member
sends their Network Finder draft, JobSync must tell "sent" from "deleted", which the drafts permission cannot
do. With this setting the consent screen also asks for `https://www.googleapis.com/auth/gmail.metadata`
(read-only labels and headers, **never message bodies**; restricted scope, like `gmail.compose`). JobSync uses
it for one thing only: looking at the labels of the thread of a draft it created itself (`threads.get`,
`format=minimal`). Add this scope under *Data access* too if you turn the setting on; members who connected
before must click **Reconnect Gmail** once. Without it, drafts that disappear are reported as "unknown" and
no status is changed.

## 1. Google Cloud Console (one-time, by Anni)

Use the same Google Cloud project as the Sheets service account (or a new one) at https://console.cloud.google.com.

1. **Enable the Gmail API**: *APIs & Services → Library → "Gmail API" → Enable*.
2. **OAuth consent screen** (*Google Auth Platform*):
   - *Branding*: App name `JobSync`, user-support email = Anni's address, developer contact = Anni's address.
   - *Audience*: User type **External**; publishing status **Testing**; **Test users** → add the three Gmail
     addresses (Anni, Lukky, Rishii). Only these accounts can connect.
   - *Data access*: add the scopes `openid`, `.../auth/userinfo.email`, `.../auth/gmail.compose`.
3. **Credentials** → *Create credentials → OAuth client ID*:
   - Application type: **Web application**, name `JobSync Gmail drafts`.
   - **Authorised redirect URIs** (add both, exactly):
     - `http://localhost:3000/api/gmail/callback`
     - `https://jobsbyarillabs.vercel.app/api/gmail/callback`
   - (Authorised JavaScript origins are not needed.)
   - Create → copy the **Client ID** and **Client secret**.

## 2. Where each value goes

Local: `.env.local` (git-ignored). Production later: Vercel → Project → Settings → Environment Variables
(mark the secrets *Sensitive*).

| Variable | Value | Local | Production |
|---|---|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | the Client ID (`…apps.googleusercontent.com`) | same | same |
| `GOOGLE_OAUTH_CLIENT_SECRET` | the Client secret | same | same (Sensitive) |
| `GOOGLE_OAUTH_REDIRECT_URI` | callback URL | `http://localhost:3000/api/gmail/callback` | `https://jobsbyarillabs.vercel.app/api/gmail/callback` |
| `GMAIL_TOKEN_ENCRYPTION_KEY` | 32 random bytes, base64 (`openssl rand -base64 32`) | already generated in `.env.local` | a **different** new key (Sensitive) |

Tokens connected locally do not work in production and vice versa (different keys and storage), so each
member connects once per environment.

## 3. Where the authorisation is stored

Tab `NF_GmailAccounts` in the JobSync spreadsheet: member, Gmail address, the refresh token **encrypted with
AES-256-GCM** (bound to that member, so a token copied into another member's row is useless), scope, status.
Never in Connections, never in logs, never sent to the browser. Disconnect at `/gmail` revokes it at Google
and deletes it.

## 4. Important limitation of "Testing" mode

Google expires refresh tokens of **Testing**-mode apps after **7 days**. After that, a member's status
becomes *Needs reconnecting*; drafts for that member are skipped (the others continue) until they click
**Reconnect Gmail** at `/gmail`. Removing this limit requires publishing the app, and because `gmail.compose`
is a *restricted* scope, Google then requires app verification and a third-party security assessment.
Recommended: stay in Testing and reconnect weekly.

During consent each member will see "Google hasn't verified this app" → *Advanced* → *Go to JobSync* (expected
for Testing apps with test users).

## 5. First real test — safely, without production data

`.env.local`'s `GOOGLE_SHEETS_SPREADSHEET_ID` is the **production** spreadsheet, so do NOT test Gmail with the
normal `npm run dev`. Use the in-memory backend (tokens live in memory and vanish on restart):

```bash
SHEETS_TEST_BACKEND=memory npm run dev       # PowerShell: $env:SHEETS_TEST_BACKEND="memory"; npm run dev
```

Then sign in, open http://localhost:3000/gmail → **Connect Gmail** → pick your account → allow. Creating a
test draft from there is a later step (it needs the Nemotron draft writer wired in).
