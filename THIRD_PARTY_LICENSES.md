# Third-party components

Every component that is not this repository's own work, with its licence and
how that licence was established. A component is not added before its row is.

---

## Runtime dependencies

| Component | Source | Licence | Verification |
| --- | --- | --- | --- |
| `@modelcontextprotocol/server` | npm | MIT | ✅ 2026-09-06 — `license` field read from `registry.npmjs.org` |
| `agents` | npm | MIT | ✅ 2026-09-06 — same route |
| `zod` | npm | MIT | ✅ 2026-09-06 — same route |

## Development dependencies

| Component | Source | Licence | Verification |
| --- | --- | --- | --- |
| `wrangler` | npm | MIT OR Apache-2.0 | ✅ 2026-09-06 — same route |
| `typescript` | npm | Apache-2.0 | ✅ 2026-09-06 — same route |
| `esbuild` | npm | MIT | ✅ 2026-09-06 — same route |
| `@cloudflare/workers-types` | npm | MIT OR Apache-2.0 | ✅ 2026-09-06 — same route |

**How these were checked.** Each package's `license` field was read from the npm
registry directly (`registry.npmjs.org/<name>/latest`) on 2026-09-06, not from
a summary, a badge or a search result. The lock file agrees with every row.

**What MIT requires**, checked against the text rather than assumed: the
copyright notice and the permission notice must accompany copies or substantial
portions. Nothing here redistributes these packages — they are dependencies a
deploy installs, not files this repository ships.

**What `MIT OR Apache-2.0` means:** the recipient chooses. Either satisfies.

All of them permit commercial use.

---

## The models

Three, one per assistant. **None of them is in this repository.** This is an
interface that sends requests to an inference provider — there are no Caracat
weights, and no model files here.

| Assistant | Model | Licence | Verification |
| --- | --- | --- | --- |
| Caracat AI | `openai/gpt-oss-20b` by OpenAI | Apache-2.0 | ✅ read from the model page 2026-08-23, from the repository 2026-09-03 |
| Caracat Code | `Qwen/Qwen3-Coder-Next` by Qwen | Apache-2.0 | ✅ read from the model page 2026-08-23, from the repository 2026-09-03 |
| Caracat Pro | `deepseek-ai/DeepSeek-V3.1` by DeepSeek | MIT | ✅ read from the repository 2026-09-05 |

The full record — including how each was verified, `gpt-oss-20b`'s
`USAGE_POLICY`, and the `license_link` in `Qwen3-Coder-Next` that points at a
file the repository does not contain — is kept in the model repository:

<https://github.com/Pheonix-Studio-cat/training-and-devoloping-caracat-code/blob/main/THIRD_PARTY_LICENSES.md>

**MIT is not Apache-2.0**, and this file does not summarise them as one. MIT
carries a single condition: the notice accompanies copies. Apache-2.0
additionally requires stating changes and preserving NOTICE content, and grants
patent rights expressly.

**Nobody's weights are redistributed here**, so those conditions bite on the
inference provider's copy, not on anything in this repository.

---

## Services this repository talks to

Not components, and carrying no licence obligation here. Listed so nobody has
to guess whether something was missed.

| Service | Role |
| --- | --- |
| Cloudflare Workers | runs this server |
| Hugging Face Inference Providers | serves the three models |
| `raw.githubusercontent.com` | the three personalities are fetched from the model repository at build time |

---

## Not yet included

No framework beyond the four packages above. If that changes, a row goes here
**first**, with the licence read from the primary source.
