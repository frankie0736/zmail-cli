# Setting up a Zoho OAuth application

`zmail` talks to Zoho with **your own** OAuth application. This takes about
three minutes, once.

You may reasonably wonder why you have to do this rather than just clicking
"allow" on something we registered. Two reasons, and one of them is in your
favour:

- Zoho does not document an OAuth scope that lets a third party act on your
  mailbox without a client of its own.
- **API quota is counted per client.** With your own application, your quota is
  yours alone — you are not sharing a rate limit with every other user of this
  tool.

---

## 1. Create the application

Open <https://api-console.zoho.com/> and sign in with the Zoho account whose
mailbox you want to mirror.

Choose **ADD CLIENT** → **Server-based Applications**.

| Field | Value |
|---|---|
| Client Name | `zmail-cli` (anything you like) |
| Homepage URL | `https://github.com/frankie0736/zmail-cli` |
| **Authorized Redirect URIs** | `http://127.0.0.1:53682/oauth/callback` |

The redirect URI must match **exactly**, character for character. Zoho compares
it as a string. A trailing slash, `localhost` instead of `127.0.0.1`, or a
different port will produce `redirect_uri_mismatch`.

Nothing listens on that address except during the few seconds you are
authorizing, and it is bound to `127.0.0.1` — not reachable from your network.

## 2. Copy the credentials

After creating the client, Zoho shows a **Client ID** and **Client Secret**.
Keep the page open; you need both in the next step.

## 3. Hand them to zmail

```bash
zmail auth setup
```

It prompts for the client ID, client secret, your Zoho email address, and your
data centre. Everything except the email address goes straight into your OS
keychain — never into a file in `~/.zmail/`.

Non-interactively (for scripts):

```bash
zmail auth setup \
  --client-id 1000.XXXXXXXX \
  --client-secret xxxxxxxx \
  --email you@yourdomain.com \
  --location com
```

### Which data centre?

Look at the URL you use for Zoho Mail:

| You use | `--location` |
|---|---|
| mail.zoho.com | `com` |
| mail.zoho.eu | `eu` |
| mail.zoho.in | `in` |
| mail.zoho.com.cn | `com.cn` |
| mail.zoho.com.au | `com.au` |
| mail.zoho.jp | `jp` |

Getting this wrong produces `invalid_client`, because you are talking to a data
centre that has never heard of your application.

## 4. Authorize

```bash
zmail auth login
```

A browser opens to Zoho's consent screen. It asks for three read-only
permissions:

```
ZohoMail.accounts.READ    see which account and addresses exist
ZohoMail.folders.READ     list folders
ZohoMail.messages.READ    read message lists and bodies
```

That is the complete list. There is no write, send, or delete permission,
because this version cannot do any of those things.

After you approve, the browser returns to `127.0.0.1`, `zmail` exchanges the
code for a refresh token, stores it in your keychain, and verifies it by
fetching your account details.

## 5. Sync

```bash
zmail sync --full
zmail search "quotation" --json
```

---

## Troubleshooting

**`redirect_uri_mismatch`**
The redirect URI in the console is not exactly
`http://127.0.0.1:53682/oauth/callback`. Check for a trailing slash, `https`
instead of `http`, or `localhost`.

**`invalid_client`**
Client ID or secret is wrong, or `--location` points at the wrong data centre.

**No refresh token returned**
Zoho stops returning one for repeat authorizations of the same client. Revoke
it at <https://accounts.zoho.com/home#sessions/userconnectedapps> and run
`zmail auth login` again.

**Port 53682 already in use**
Another `zmail auth login` is still running. `lsof -i :53682` will show it.

**Anything else**

```bash
zmail doctor --json
```

Its output is designed to be safe to paste into a public issue — email
addresses are masked and no credential material is included.

## Revoking access

```bash
zmail auth revoke    # revoke at Zoho and delete the local token
zmail auth remove    # delete local credentials only; the grant stays active
```

Or remove it from Zoho's UI at
<https://accounts.zoho.com/home#sessions/userconnectedapps>.
