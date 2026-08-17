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
