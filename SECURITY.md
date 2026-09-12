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

## The 3D tools rent a machine, and the caller owns it

`generate_3d` does not call a model endpoint — no inference provider serves
`text-to-3d`. It starts a **Hugging Face Job**: a GPU rented by the second,
running a script, then shut down.

That raises the stakes of the same decision. A public address that spends
someone else's inference credit is an open wallet; one that rents someone
else's *hardware* by the minute empties faster. So:

- **The namespace comes from `whoami-v2`, never from a parameter.** The job is
  created in the caller's own namespace and billed to the caller's own balance.
  There is no way to ask for a different one.
- **The script is a constant** in `src/threed.ts`, pointing at one file in one
  repository. A parameter that took a script URL would be "run arbitrary code
  on someone else's account" — the most expensive open proxy there is.
- **The image is a constant**, and the machine is a fixed list (`cpu-basic`
  through `a10g-small`). The eight-H200 flavors are not offered. The caller pays
  either way; this is a brake on the typo, not on the caller.
- **Every job carries a timeout** (20 minutes). A forgotten job stops costing
  money on its own.
- **Prompts cannot begin with `-`,** and `output_repo` must match `owner/name`.
  The command is an array with no shell between it and the container, but the
  script's own argument parser sees only strings.

### Where the token goes here, and why it differs

The Caracat rule is that the caller's token appears **only** in the outgoing
header. The 3D tools keep that, and add exactly one place: `secrets.HF_TOKEN`
in the job spec. The container has no other way to upload its result, and job
secrets are the mechanism Hugging Face provides for it.

That is a deliberate, narrow exception, and the check is written to match it
rather than to wave it through: the token may appear in the header and in
`secrets`, and **nowhere else** — not in `environment`, not in `command`, not in
`labels`, not in the reply to the caller. The counter-proof moves it into each
of those in turn and confirms the check fails every time.

The token goes to `huggingface.co`, the same host that already sees it in the
header. It goes nowhere else: a check asserts every outgoing request from these
tools starts with that origin.

### What is not defended against here

- **A caller can spend their own money faster than they meant to.** A GPU
  rented by the second is a different shape of cost from a token count.
  `cancel_3d_job` exists for that, and every job has a timeout, but neither is
  a budget.
- **The job script is fetched at run time from `main`.** Whoever can push to
  `Pheonix-Studio-cat/3d-ai-plugin` decides what runs on the caller's rented
  machine. That is the same trust as installing the plugin, but it is worth
  naming: it is not pinned to a commit.

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
