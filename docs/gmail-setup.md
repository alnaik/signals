# Connecting Gmail (optional)

Job Signal reads Gmail to notice replies and to pick up job emails you label. It is
read-only and limited in code to one label plus mail from contacts already in a thread.
Each person uses their own Google Cloud project; nothing is shared.

1. Go to https://console.cloud.google.com/ and create a project, e.g. "Job Signal".
2. APIs & Services → Library → enable **Gmail API**.
3. APIs & Services → OAuth consent screen:
   - User type **External**, app name "Job Signal", your email as support and developer contact.
   - Scopes: add only `https://www.googleapis.com/auth/gmail.readonly`.
   - Test users: add your own address.
   - **Publishing status: click "Publish app" → In production.** In "Testing", Google expires
     refresh tokens after 7 days and reply detection would stop every week. The app stays
     unverified; that's fine for your own use. You'll click through a warning once.
4. APIs & Services → Credentials → Create credentials → OAuth client ID → **Desktop app**.
5. Store the client in the Keychain (copy each value, then run):
   ```sh
   pbpaste | jobsignal key set gmail_client_id
   pbpaste | jobsignal key set gmail_client_secret
   ```
6. In Gmail, create a label called **Job Signal** (or set `[source.gmail] label` in
   `config.toml`). Add filters that apply it to LinkedIn job alerts and Grok results.
7. `jobsignal gmail connect` and approve in the browser.

The refresh token is stored in the Keychain, never in the data folder.
