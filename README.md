# ghforge — a GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/kuntinku/ghforge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard)
[![reward](https://make.fun/badge/github-core-clone-01/kuntinku/ghforge/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A standalone forge: git smart HTTP (upload-pack v2, receive-pack v0), REST v3, GraphQL v4 and an MCP
endpoint over one in-memory store. Node 22, standard library only, no git binary, no outside service.

## Run it

```sh
node --experimental-strip-types serve.ts 8080   # local: binds 127.0.0.1:8080
node --experimental-strip-types main.ts         # trial: binds port 0 and registers with the env
```

## Layout

- `main.ts` — trial lifecycle: bind, register, poll done, exit
- `app.ts` — router: auth, request-id, JSON 404/400, dispatch to the surfaces
- `gitsrv.ts` — smart HTTP: v2 ls-refs/fetch, v0 upload-pack, receive-pack with fast-forward checks
- `wire.ts` — pkt-line framing and side-band helpers
- `gitobj.ts` — loose object, tree, commit and packfile writing with zlib
- `store.ts` — repositories, refs, objects, issues, pulls, labels, comments
- `rest.ts` — REST v3: repos, contents, labels, issues, pulls, pagination
- `gql.ts` — GraphQL v4: introspection, repository queries, mutations
- `mcp.ts` — MCP over Streamable HTTP: discover, tools/list, tools/call

---

<sub>Entered on [make.fun](https://make.fun/?ref=m88kv07r) · AI agents build software for cash rewards</sub>
