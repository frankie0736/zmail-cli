# Search guide

## Query modes

| Flag | Meaning | Example |
|---|---|---|
| `--query` / positional | Terms combined with AND, safely escaped | `zmail search "silicone quotation"` |
| `--phrase` | Exact phrase | `--phrase "purchase order"` |
| `--any` | Any of these terms | `--any refund credit chargeback` |
| `--exclude` | Exclude these terms | `--exclude newsletter` |
| `--raw-fts` | Raw FTS5 expression, no normalization | debugging only |

## Filters

```
--from <address>          exact sender
--from-domain <domain>    sender's domain (indexed, fast)
--to <address>            appears in To/Cc/Bcc
--folder <name>           Inbox, Sent, Archive…
--after / --before <date> ISO 8601
--unread
--has-attachment
--limit <n>               default 20
--sort relevance|newest|oldest
```

## Chinese

Pass terms as the user wrote them. The CLI splits CJK internally and applies
the identical transformation to the index and the query.

```bash
zmail search "询价" --json          # ✅
zmail search "硅胶管报价" --json     # ✅
zmail search "询 价" --json         # ❌ do not pre-split
zmail search --raw-fts "询价"       # ❌ bypasses normalization, returns nothing
```

Two-character business terms — 询价, 报价, 样品, 交期, 客户 — all work. This is
deliberate: FTS5's default tokenizer treats a run of Han characters as one
token, so a naive implementation silently returns nothing for exactly these
words.

## Widening a search that returned too little

In order of what to relax first:

1. Remove date bounds
2. `--any` instead of AND
3. `--from-domain` instead of `--from`
4. Fewer, more general keywords
5. Add `--include-remote-deleted` if the message may have been deleted in
   WebMail

Do not jump straight to listing everything. A search returning nothing is
information; a search returning 5000 results is not.

## Reading the results

```json
{
  "ok": true,
  "data": {
    "total": 42,
    "returned": 20,
    "hits": [
      {
        "messageId": "1785426182570141900",
        "threadId": "…",
        "folder": "Inbox",
        "subject": "…",
        "fromAddress": "buyer@example.com",
        "receivedAt": "2026-07-30T12:00:00.000Z",
        "hasAttachments": true,
        "snippet": "…matched context…",
        "score": -1.23
      }
    ]
  }
}
```

`total` is the full match count; `returned` is how many came back. `score` is
bm25 — **lower is better**. `snippet` is generated from the plain-text body,
so it is safe to show the user directly.

IDs are always strings. Never convert them to numbers: they exceed 2^53 and
will be silently corrupted.
