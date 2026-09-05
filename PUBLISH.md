# How to release llm-ledger

After build and tests pass, authenticate with the package registry, dry-run pack the tarball (dist + README + LICENSE), release with public access, then verify via view + npx.

Cursor config once released: use npx --yes llm-ledger with OPENROUTER_MANAGEMENT_KEY and OPENAI_ADMIN_KEY in env.

Bump version before each release; the prepublishOnly script builds automatically.

## Exact commands

1. `npm login`
2. `npm pack --dry-run`
3. `npm publish --access public`
4. `npm view llm-ledger version` then `npx --yes llm-ledger`
