# CLI reference

Generated from the CLI itself. If this drifts from the implementation, the
implementation wins — regenerate with `node scripts/gen-cli-reference.mjs`.

**Every command accepts `--json`.** Agents should always pass it.

## Global options

```
--profile <name>     use a specific profile
--data-dir <path>    override the data directory (beats ZMAIL_HOME)
--json               emit the stable JSON envelope
-q, --quiet          suppress progress on stderr
--verbose            more diagnostics
--no-color           disable coloured output
```

## `zmail`

```
Usage: zmail [options] [command]

Local-first Zoho Mail mirror, search and safe-write CLI for AI agents

Options:
  -V, --version                print the version
  --profile <name>             use a specific profile
  --data-dir <path>            override the data directory (takes precedence
                               over ZMAIL_HOME)
  --json                       emit the stable JSON envelope for agents
                               (default: false)
  -q, --quiet                  suppress progress output on stderr (default:
                               false)
  --verbose                    emit more diagnostic detail (default: false)
  --no-color                   disable coloured output
  -h, --help                   display help for command

Commands:
  init                         create ~/.zmail/ and initialise the database
  status                       show current status
  doctor                       diagnose Node, directories, permissions,
                               credential backend and database
  version                      print package, schema and index-normalizer
                               versions
  config                       inspect configuration
  sync [options]               sync mail from Zoho into the local mirror
  search [options] [terms...]  full-text search the local mirror (English and
                               Chinese)
  message                      read a single message
  thread                       read a thread
  folder                       folders
  attachment                   attachments (metadata syncs; content downloads on
                               demand)
  data                         local data maintenance
  export [options]             export mail to standard formats — your data is
                               not locked in
  auth                         manage Zoho authorization
```

## `zmail auth`

```
Usage: zmail auth [options] [command]

manage Zoho authorization

Options:
  -h, --help       display help for command

Commands:
  setup [options]  store Zoho OAuth client credentials
  login            authorize in a browser and store the refresh token
  status           show authorization status
  refresh          refresh the access token to verify credentials work
  revoke           revoke remotely at Zoho and delete the local refresh token
  remove           delete local credentials only; the remote grant stays active
```

## `zmail sync`

```
Usage: zmail sync [options]

sync mail from Zoho into the local mirror

Options:
  --full           full sync with reconciliation (default is quick) (default:
                   false)
  --quick          scan only the most recent messages (default) (default: false)
  --folder <name>  sync only the named folder
  -h, --help       display help for command
```

## `zmail search`

```
Usage: zmail search [options] [terms...]

full-text search the local mirror (English and Chinese)

Options:
  --query <text>          terms, escaped and combined with AND
  --phrase <text>         exact phrase
  --any <text...>         match any of these terms
  --exclude <text...>     exclude these terms
  --raw-fts <expr>        raw FTS5 expression; Chinese will usually match
                          nothing
  --from <address>        sender address
  --from-domain <domain>  sender domain
  --to <address>          recipient address
  --folder <name>         restrict to a folder
  --after <date>          on or after this ISO 8601 date
  --before <date>         on or before this ISO 8601 date
  --unread                unread only (default: false)
  --has-attachment        with attachments only (default: false)
  --limit <n>             number of results (default: "20")
  --sort <mode>           relevance | newest | oldest (default: "relevance")
  -h, --help              display help for command
```

## `zmail message`

```
Usage: zmail message [options] [command]

read a single message

Options:
  -h, --help       display help for command

Commands:
  get <messageId>  read a message by ID
```

## `zmail thread`

```
Usage: zmail thread [options] [command]

read a thread

Options:
  -h, --help      display help for command

Commands:
  get <threadId>  read an entire thread by ID
```

## `zmail folder`

```
Usage: zmail folder [options] [command]

folders

Options:
  -h, --help  display help for command

Commands:
  list        list folders and whether they are synced
```

## `zmail attachment`

```
Usage: zmail attachment [options] [command]

attachments (metadata syncs; content downloads on demand)

Options:
  -h, --help                         display help for command

Commands:
  list <messageId>                   list a message's attachments
  download [options] <attachmentId>  download attachment content into
                                     content-addressed storage
  path <attachmentId>                print the local absolute path of an
                                     attachment
  prune [options]                    evict attachment content by LRU to stay
                                     within quota (metadata kept)
```

## `zmail export`

```
Usage: zmail export [options]

export mail to standard formats — your data is not locked in

Options:
  --format <fmt>   eml | mbox | jsonl (default: "jsonl")
  --out <path>     directory for eml; file path for mbox and jsonl
  --folder <name>  restrict to a folder
  --after <date>   该时间之后
  --before <date>  该时间之前
  --limit <n>      maximum number of messages to export
  -h, --help       display help for command
```

## `zmail data`

```
Usage: zmail data [options] [command]

local data maintenance

Options:
  -h, --help        display help for command

Commands:
  rebuild-index     rebuild the full-text index from messages
  stats             report disk usage broken down by component
  verify            integrity check: database, FTS index consistency, attachment
                    files
  backup [options]  back up database and config (excludes attachments and
                    credentials)
  prune [options]   prune regenerable data to reclaim space
  reset [options]   clear the local database and attachments; the Zoho mailbox
                    is untouched
  purge [options]   delete the entire data directory
```

## `zmail config`

```
Usage: zmail config [options] [command]

inspect configuration

Options:
  -h, --help  display help for command

Commands:
  path        print the path to config.json
  show        print the current configuration
```

## `zmail doctor`

```
Usage: zmail doctor [options]

diagnose Node, directories, permissions, credential backend and database

Options:
  -h, --help  display help for command
```
