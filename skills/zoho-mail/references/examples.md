# Worked examples

## "Did that supplier ever reply about the tubing quote?"

```bash
# Time-sensitive question → refresh first
zmail sync --quick --json

zmail search --query "tubing quote" --from-domain supplier.example.com --json
# → hits[0].threadId

zmail thread get <threadId> --json
```

Read the whole thread before answering. The reply may be three messages down
and may contradict the first one.

## "What did we quote them in March?"

Historical — no sync needed, the answer is already local.

```bash
zmail search --query "quotation" \
  --to customer@example.com \
  --after 2026-03-01 --before 2026-04-01 --json
```

## "找一下客户询价硅胶管的邮件"

Pass the Chinese exactly as given.

```bash
zmail search "询价 硅胶管" --json
```

If nothing comes back, widen rather than give up:

```bash
zmail search --any 询价 报价 硅胶管 --json
```

## "Get me the PDF they sent"

```bash
zmail search --query "quotation" --has-attachment --limit 5 --json
zmail attachment list <messageId> --json

# Only if downloadStatus is not "downloaded"
zmail attachment download <attachmentId> --json

# Now safe to hand to another tool
zmail attachment path <attachmentId> --json
```

## "Summarize this month's customer correspondence"

```bash
zmail search --folder Inbox --after 2026-07-01 --limit 50 --json
```

Read the hits' subjects and snippets first. Fetch full bodies only for the
ones that matter to the question — pulling 50 full messages into context is
almost never the right move.

## "Reply to them saying we can ship next week"

You cannot. Say so, then be useful:

```bash
zmail thread get <threadId> --json
```

Read the thread, draft the reply as text in your response, and tell the user
to send it from Zoho WebMail. Do not imply anything was sent.

## Handling a stale mirror

If the user insists a message exists and search cannot find it:

```bash
zmail status --json      # when was the last sync?
zmail sync --quick --json
zmail search … --json    # retry

# Still missing? It may predate the sync window, or be in an unsynced folder
zmail folder list --json
```

`folder list` shows which folders are actually being synced. Spam and Trash
are excluded by default.
