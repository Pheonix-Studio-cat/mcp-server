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

## ⚠️ `fetch_url` is a different matter

`fetch_url` predates the Caracat tools and is left as it was found — removing
somebody's tool is not a decision this change makes. But it should be said
plainly:

**`fetch_url` fetches any URL it is given, with no authentication.** Once the
address of this Worker is known, it is an open proxy running on the operator's
Cloudflare account and presenting the operator's egress. It can be pointed at
private network addresses, at metadata endpoints, and at anything else the
runtime can reach.

If that is not wanted, the fix is to delete the tool or to restrict it to an
allowlist of hosts written into the source.

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
