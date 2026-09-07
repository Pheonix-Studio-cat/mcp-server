# Security

## Reporting

Open an issue, or contact the repository owner privately if the finding should
not be public before it is fixed.

## This server holds no key

**Every `ask_caracat_*` call is billed to the Hugging Face token the caller
sends**, as an `Authorization: Bearer` header. The server stores no token, has
no secret binding, and reads none from its environment.

That is not convenience, it is the only arrangement that survives the address
becoming known. A public MCP endpoint calling paid models on the operator's own
credit is an open wallet: anyone who learns the URL spends someone else's
money, and there is no way to notice until the balance is gone.

What follows from having no key:

- there is no secret to leak, in a log, an error or a bundle;
- there is no shared budget, and therefore no request counter — the counter on
  the project's website is documented there as racy under concurrent requests,
  and not reproducing it is a feature;
- the address may be public.

**The token is never written anywhere but the outgoing request header.** Not
into the request body, not into an error message, not into a tool result. Two
checks in `checks/check-caracat.mjs` assert exactly that, and the counter-proof
confirms they fail when the token is deliberately put into the body.

## What the Caracat tools will not do

- **No tool takes an address.** The Hugging Face endpoint is a constant in
  `src/caracat.ts`. A parameter that accepted a host would turn a narrow tool
  into an open proxy — the same rule the model repository applies to its GitHub
  module, for the same reason.
- **No tool names a model.** The caller picks an *assistant*; which model that
  is stays written in the source. A request that could name a model could name
  any model.
- **Questions are length-capped** at 24,000 characters. The caller pays, but a
  tool without a limit invites tipping half a repository into it by accident.

## `fetch_url` was removed

The scaffold this server grew from had a fourth example tool, `fetch_url`, which
fetched any URL it was given with no authentication.

While nothing was deployed, that was an exercise. On **2026-09-07** the Worker
went live at a public `workers.dev` address, and the same code became an open
proxy: anyone who learned the address could have this account fetch arbitrary
pages — private network addresses and cloud metadata endpoints included — with
the operator's egress IP and on the operator's bill.

It was removed rather than restricted. An allowlist would work, but it is a list
somebody has to maintain, and no tool is the smaller attack surface.

**A check holds it:** `checks/check-caracat.mjs` asserts `fetch_url` is not in
`tools/list`, and the counter-proof puts a URL-fetching tool back to confirm the
assertion actually fails when it returns.

If something like it is ever wanted again: **the hosts belong in the source as
constants, never in a parameter.** That is the rule the model repository applies
to its GitHub module, for exactly this reason.

## The personalities are fetched, not stored

`scripts/fetch-personas.mjs` pulls the three system prompts from the model
repository at build time and **aborts the deploy if any of them cannot be
fetched or does not name itself**.

A server that deployed without them would still answer — as a bare model call,
introducing itself as gpt-oss or DeepSeek. That has happened three times on the
project's website, twice through a cached 404 and once through a merge race,
and each time the build went green. Here it fails instead: this server's only
job is to be Caracat.

## What is not defended against

- **A caller with a valid token can spend their own credit.** That is the
  point, not a flaw.
- **Prompt injection through the `question` parameter.** Whatever a caller
  sends reaches the model. The assistants' personalities tell them to be honest
  about uncertainty, but a system prompt is guidance, not a boundary.
- **Rate limiting.** There is none. Cloudflare's own limits apply, and the
  caller's Hugging Face account is the real ceiling.
