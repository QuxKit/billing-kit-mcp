# billing-kit-mcp — diagrams

The mermaid sources for this repo. They live here rather than in the
README because npm renders no mermaid: on the package page a fence
like this one ships as raw DSL. GitHub and the QuxKit docs site both
draw them. The README carries an ASCII equivalent of each.

## The server between an MCP host and exact arithmetic

```mermaid
flowchart LR
    host["MCP host<br/>Claude Desktop · Claude Code"]
    subgraph srv["billing-kit-mcp"]
        t["price_usage · format_money<br/>check_ledger_balance<br/>search_api · list_components"]
    end
    bk["billing-kit<br/>Money · Quantity · Rate · price"]
    host <-->|stdio · JSON-RPC| srv
    t -->|exact arithmetic| bk
    classDef a fill:#0d9488,stroke:#0f766e,color:#fff
    class bk a
```

## The database-backed tools: read-only, tenant-scoped, capped

```mermaid
flowchart TB
    call["tool call<br/>{ tenantId, subjectId, ... }"]
    call --> t1{"tenantId present?"}
    t1 -- no --> e1["schema error"]
    t1 -- yes --> t2{"BILLING_KIT_MCP_TENANT<br/>set and different?"}
    t2 -- yes --> e2["isError: outside scope"]
    t2 -- no --> bk["billing-kit read function<br/>queryUsage · aggregateUsage · balance<br/>entries · walletBalance · getSubscription"]
    bk --> pool["pg.Pool<br/>SET default_transaction_read_only = on<br/>on every connection"]
    pool --> pg[("billing.* — INSERT refused")]
    classDef a fill:#0d9488,stroke:#0f766e,color:#fff
    classDef bad fill:#9e2b2b,stroke:#7f2222,color:#fff
    class bk a
    class e1,e2 bad
```

## explain-charge: what the prompt walks

```mermaid
flowchart LR
    p["explain-charge<br/>{ tenantId, subscription }"]
    p --> s["getSubscription<br/>plan id · seats · period · trial"]
    p --> c["billing://plans<br/>base · seats · included · overage"]
    p --> u["aggregateUsage<br/>per metered metric, over the period"]
    s & c & u --> ch["chargeForPeriod<br/>flat / seats / usage / discount → total"]
    p --> l["entries + balance<br/>charge postings · owed now"]
    ch & l --> m["one user message:<br/>the exact figures + 'explain each line'"]
    classDef a fill:#0d9488,stroke:#0f766e,color:#fff
    class ch a
```

## Write tools: the four guards

```mermaid
flowchart TB
    c["record_usage / apply_coupon call"] --> f{"--allow-writes?"}
    f -- no --> r1["isError: writes are disabled"]
    f -- yes --> k{"confirm: true?"}
    k -- no --> r2["isError: needs confirm"]
    k -- yes --> t{"in tenant scope?"}
    t -- no --> r3["isError: outside scope"]
    t -- yes --> bk["billing-kit record / post<br/>idempotent on the key"]
    bk --> o1["recorded / posted"]
    bk --> o2["deduplicated: true (same payload)"]
    bk --> o3["idempotency_conflict (different payload)"]
    r1 & r2 & r3 & o1 & o2 & o3 -.-> a["audit line → stderr"]
    classDef bad fill:#9e2b2b,stroke:#7f2222,color:#fff
    classDef a fill:#0d9488,stroke:#0f766e,color:#fff
    class r1,r2,r3,o3 bad
    class bk a
```

## Two transports: stdio by default, HTTP behind a bearer token

```mermaid
flowchart LR
    l["local host<br/>Claude Desktop · Claude Code"] -->|spawn + stdio| srv
    r["remote host<br/>hosted assistant · team deployment"] -->|"POST /mcp<br/>Authorization: Bearer"| gate
    gate{"token set?<br/>constant-time match?"} -- no --> x["401 + WWW-Authenticate<br/>(no token at all: refuses to listen)"]
    gate -- yes --> srv["McpServer<br/>(one per request, stateless)"]
    srv --> pools["shared pools:<br/>read-only + (with --allow-writes) writable"]
    classDef bad fill:#9e2b2b,stroke:#7f2222,color:#fff
    class x bad
```

## Why the tool exists: an assistant guessing vs. the Money type

```mermaid
flowchart TB
    q["price 1,234,567 tokens<br/>at $0.0000012 / token, USD"]
    q --> guess["assistant on its own<br/>invents qty × rate ÷ 100<br/>drifts on large values,<br/>wrong for a third of ISO 4217"]
    q --> tool["price_usage → billing-kit<br/>$1.48 · exact 148.14804 minor<br/>from the Money type"]
    classDef bad fill:#9e2b2b,stroke:#7f2222,color:#fff
    classDef good fill:#2c6e5b,stroke:#225646,color:#fff
    class guess bad
    class tool good
```
