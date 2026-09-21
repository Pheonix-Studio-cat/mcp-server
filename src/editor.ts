/**
 * The video editor, over MCP.
 *
 * The editor itself lives in the `cut-video-connector` repo and runs entirely
 * in a browser. What it cannot do is be told, in words, what to cut. That is
 * what these tools are for: a model describes an edit, gets back a **cut plan**
 * and a link, and the person taps the link, picks their file and the edit is
 * already there.
 *
 * ## Why a link and not a file
 *
 * The owner of this project works from an iPad and has no terminal. Anything
 * that would need one has to become something you tap. A plan is small enough
 * to fit in a URL fragment, so it does.
 *
 * It also means **no video is ever uploaded anywhere**. This worker never sees
 * a frame. It builds a description of an edit, and the editing happens on the
 * person's own device. There is nothing here to leak and nothing to pay for.
 *
 * ## No key needed
 *
 * Unlike the Caracat tools next door, nothing here calls a paid model or any
 * outside service at all. These tools are arithmetic on a JSON object, so they
 * work without an `Authorization` header.
 *
 * ## One thing to know about the format
 *
 * `edl.js` in the editor repo is the **authority** on the cut plan: it is what
 * actually validates a plan before anything is exported. The checks here are a
 * second copy, and a second copy can drift. Two things keep that harmless:
 * `FORMAT`/`VERSION` are written into every plan, so a mismatch is caught
 * rather than misread; and every plan that arrives at the editor is validated
 * again there before a single frame is touched. A plan this worker got wrong
 * fails loudly in the editor, not quietly in the export.
 *
 * (The same duplication, for the same reason, as `DEEP_INSTRUCTION` in
 * `caracat.ts`: there is no module that both a Cloudflare Worker and a static
 * page on GitHub Pages can load.)
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";

/**
 * Where the editor lives. A constant, not a parameter.
 *
 * Same rule as the Hugging Face host in `caracat.ts`, for the same reason: a
 * tool that takes an address and hands it back inside a link the person is
 * invited to tap is a tool for sending people to an address of the caller's
 * choosing. The address belongs in the code.
 */
const EDITOR = "https://pheonix-studio-cat.github.io/cut-video-connector/";

const FORMAT = "cut-plan";
const VERSION = 1;

/** Past this a link starts getting truncated by chat apps and address bars. */
const SAFE_LINK_LENGTH = 2000;

const METHODS = ["temporal-median", "inpaint", "blur", "pixelate"] as const;
type Method = (typeof METHODS)[number];

const METHOD_HELP: Record<Method, string> = {
  "temporal-median":
    "Takes the background from other frames. The one that actually removes things. " +
    "Needs the object or the camera to move at some point during the range.",
  inpaint:
    "Invents the background from elsewhere in the same frame. For something that never moves. " +
    "Good on texture, poor on straight lines and faces.",
  blur:
    "Smears it. The thing is still there and the information is only attenuated. " +
    "For something that must not be readable, prefer pixelate, or remove it outright.",
  pixelate:
    "Averages it into blocks. Obvious, deliberate, and harder to undo than a blur.",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Clip { id: string; start: number; end: number; speed?: number; muted?: boolean }
interface Shape {
  type: "rect" | "ellipse" | "polygon" | "brush";
  x?: number; y?: number; w?: number; h?: number;
  points?: Array<[number, number]>;
  stamps?: Array<{ x: number; y: number; r: number }>;
}
interface Key { t: number; shape: Shape }
interface Erasure {
  id: string; method: Method; from: number; to: number;
  feather?: number; strength?: number; track?: boolean; keys: Key[];
}
interface Plan {
  format: string; version: number;
  source: { name: string; duration: number; width?: number | null; height?: number | null; fps?: number | null } | null;
  clips: Clip[];
  erasures: Erasure[];
  output: { width?: number | null; height?: number | null; fps?: number | null; bitrate?: number | null };
}
interface Finding { severity: "error" | "warning"; path: string; message: string }

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const round3 = (n: number) => Math.round(n * 1e3) / 1e3;

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

/**
 * Turn a list of ranges to drop into the ranges to keep.
 *
 * The caller thinks in "take this bit out", the plan is a list of what stays.
 * Doing the inversion here rather than asking for the complement is the whole
 * point -- working out the complement of four overlapping ranges by hand is
 * exactly the arithmetic a model gets wrong, and the mistake is invisible in
 * the output until someone watches the result.
 *
 * Overlapping and out-of-order ranges are handled; that is the normal case
 * when they were described one at a time.
 */
export function keepRanges(duration: number, remove: Array<[number, number]>): Array<[number, number]> {
  const cuts = remove
    .map(([a, b]) => [Math.max(0, Math.min(a, b)), Math.min(duration, Math.max(a, b))] as [number, number])
    .filter(([a, b]) => b > a)
    .sort((p, q) => p[0] - q[0]);

  const merged: Array<[number, number]> = [];
  for (const [a, b] of cuts) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1] + 1e-6) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }

  const keep: Array<[number, number]> = [];
  let at = 0;
  for (const [a, b] of merged) {
    if (a - at > 1e-6) keep.push([round6(at), round6(a)]);
    at = b;
  }
  if (duration - at > 1e-6) keep.push([round6(at), round6(duration)]);
  return keep;
}

function makePlan(source: Plan["source"], keep: Array<[number, number]>, erasures: Erasure[]): Plan {
  return {
    format: FORMAT,
    version: VERSION,
    source,
    clips: keep.map(([start, end], i) => ({ id: `c${i + 1}`, start: round6(start), end: round6(end) })),
    erasures,
    output: {
      width: source?.width ?? null,
      height: source?.height ?? null,
      fps: source?.fps ?? null,
      bitrate: null,
    },
  };
}

// ---------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------

/** The same invariants the editor checks, in the same order. */
export function validatePlan(plan: unknown): Finding[] {
  const findings: Finding[] = [];
  const err = (path: string, message: string) => findings.push({ severity: "error", path, message });
  const warn = (path: string, message: string) => findings.push({ severity: "warning", path, message });

  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return [{ severity: "error", path: "", message: "Plan is not an object." }];
  }
  const p = plan as Partial<Plan>;
  if (p.format !== FORMAT) err("format", `Expected format "${FORMAT}", got ${JSON.stringify(p.format)}.`);
  if (p.version !== VERSION) err("version", `Expected version ${VERSION}, got ${JSON.stringify(p.version)}.`);

  const duration = p.source && isNum(p.source.duration) ? p.source.duration : null;
  if (p.source == null) warn("source", "No source described; the plan can only be applied once a file is opened.");
  else if (duration == null || duration <= 0) err("source.duration", "Source duration must be a positive number of seconds.");

  if (!Array.isArray(p.clips)) {
    err("clips", "clips must be an array.");
  } else {
    if (p.clips.length === 0) warn("clips", "No clips: the export would be empty.");
    const seen = new Set<string>();
    p.clips.forEach((clip, i) => {
      const at = `clips[${i}]`;
      if (!clip || typeof clip !== "object") return err(at, "Clip is not an object.");
      if (typeof clip.id !== "string" || !clip.id) err(`${at}.id`, "Clip needs a non-empty string id.");
      else if (seen.has(clip.id)) err(`${at}.id`, `Duplicate clip id ${JSON.stringify(clip.id)}.`);
      else seen.add(clip.id);
      if (!isNum(clip.start) || clip.start < 0) err(`${at}.start`, "start must be a number >= 0.");
      if (!isNum(clip.end)) err(`${at}.end`, "end must be a number.");
      if (isNum(clip.start) && isNum(clip.end) && clip.end <= clip.start) {
        err(at, `Empty or reversed clip: start ${clip.start} >= end ${clip.end}.`);
      }
      if (duration != null && isNum(clip.end) && clip.end > duration + 1e-6) {
        err(`${at}.end`, `Clip ends at ${clip.end}s, past the source duration ${duration}s.`);
      }
      if (clip.speed != null && (!isNum(clip.speed) || clip.speed <= 0)) {
        err(`${at}.speed`, "speed must be a positive number.");
      }
    });
  }

  if (!Array.isArray(p.erasures)) {
    err("erasures", "erasures must be an array.");
  } else {
    const seen = new Set<string>();
    p.erasures.forEach((e, i) => {
      const at = `erasures[${i}]`;
      if (!e || typeof e !== "object") return err(at, "Erasure is not an object.");
      if (typeof e.id !== "string" || !e.id) err(`${at}.id`, "Erasure needs a non-empty string id.");
      else if (seen.has(e.id)) err(`${at}.id`, `Duplicate erasure id ${JSON.stringify(e.id)}.`);
      else seen.add(e.id);
      if (!METHODS.includes(e.method)) {
        err(`${at}.method`, `Unknown method ${JSON.stringify(e.method)}. Known: ${METHODS.join(", ")}.`);
      }
      if (!isNum(e.from) || e.from < 0) err(`${at}.from`, "from must be a number >= 0.");
      if (!isNum(e.to)) err(`${at}.to`, "to must be a number.");
      if (isNum(e.from) && isNum(e.to) && e.to < e.from) err(at, `Reversed range: from ${e.from} > to ${e.to}.`);
      if (duration != null && isNum(e.to) && e.to > duration + 1e-6) {
        warn(`${at}.to`, `Erasure ends at ${e.to}s, past the source duration ${duration}s.`);
      }
      if (!Array.isArray(e.keys) || e.keys.length === 0) {
        err(`${at}.keys`, "An erasure needs at least one mask keyframe.");
      } else {
        e.keys.forEach((k, j) => validateKey(k, `${at}.keys[${j}]`, err));
        for (let j = 1; j < e.keys.length; j += 1) {
          if (isNum(e.keys[j]?.t) && isNum(e.keys[j - 1]?.t) && e.keys[j].t < e.keys[j - 1].t) {
            err(`${at}.keys`, "Keyframes must be sorted by time.");
            break;
          }
        }
        // The mask holds past the last keyframe rather than carrying on in the
        // direction it was going -- extrapolating would drift off the object
        // and start erasing background. So a range that outlasts its keys
        // leaves the tail of it erasing wherever the object last was.
        const lastKey = e.keys[e.keys.length - 1];
        if (isNum(lastKey?.t) && isNum(e.to) && e.to - lastKey.t > 0.5 && e.keys.length > 1) {
          warn(`${at}.keys`,
            `The last keyframe is at ${round3(lastKey.t)}s but the erasure runs to ${round3(e.to)}s. ` +
            "The mask holds where it was for the rest of it, so a moving object will walk out from under it.");
        }
      }
      if (e.method === "temporal-median" && duration != null && isNum(e.from) && isNum(e.to) &&
          e.from <= 1e-6 && e.to >= duration - 1e-6) {
        warn(at, "temporal-median covers the whole source, so it depends on the object or the camera moving during it.");
      }
    });
  }
  return findings;
}

function validateKey(key: Key, at: string, err: (p: string, m: string) => void) {
  if (!key || typeof key !== "object") return err(at, "Keyframe is not an object.");
  if (!isNum(key.t) || key.t < 0) err(`${at}.t`, "Keyframe time must be a number >= 0.");
  const s = key.shape;
  if (!s || typeof s !== "object") return err(`${at}.shape`, "Keyframe needs a shape.");
  const unit = (name: string, v: unknown) => {
    if (!isNum(v)) err(`${at}.shape.${name}`, `${name} must be a number.`);
    else if (v < -1 || v > 2) {
      err(`${at}.shape.${name}`,
        `${name} = ${v} is far outside the frame. Mask coordinates are fractions of the ` +
        "frame's width and height (0..1), not pixels -- this is the commonest mistake.");
    }
  };
  if (s.type === "rect" || s.type === "ellipse") {
    unit("x", s.x); unit("y", s.y); unit("w", s.w); unit("h", s.h);
    if (isNum(s.w) && s.w <= 0) err(`${at}.shape.w`, "w must be > 0.");
    if (isNum(s.h) && s.h <= 0) err(`${at}.shape.h`, "h must be > 0.");
  } else if (s.type === "polygon") {
    if (!Array.isArray(s.points) || s.points.length < 3) err(`${at}.shape.points`, "A polygon needs at least three points.");
    else s.points.forEach((pt, i) => {
      if (!Array.isArray(pt) || pt.length !== 2) err(`${at}.shape.points[${i}]`, "Each point is an [x, y] pair.");
      else { unit(`points[${i}][0]`, pt[0]); unit(`points[${i}][1]`, pt[1]); }
    });
  } else if (s.type === "brush") {
    if (!Array.isArray(s.stamps) || s.stamps.length === 0) err(`${at}.shape.stamps`, "A brush shape needs at least one stamp.");
    else s.stamps.forEach((st, i) => {
      if (!st || typeof st !== "object") return err(`${at}.shape.stamps[${i}]`, "Each stamp is { x, y, r }.");
      unit(`stamps[${i}].x`, st.x); unit(`stamps[${i}].y`, st.y);
      if (!isNum(st.r) || st.r <= 0) err(`${at}.shape.stamps[${i}].r`, "Stamp radius must be > 0.");
    });
  } else {
    err(`${at}.shape.type`, `Unknown shape ${JSON.stringify(s.type)}. Known: rect, ellipse, polygon, brush.`);
  }
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function hasErrors(findings: Finding[]) {
  return findings.some((f) => f.severity === "error");
}

export function summarise(plan: Plan) {
  const kept = plan.clips.reduce((s, c) => s + Math.max(0, c.end - c.start), 0);
  const output = plan.clips.reduce((s, c) => s + Math.max(0, c.end - c.start) / (c.speed || 1), 0);
  const sourceDuration = plan.source?.duration ?? kept;
  return {
    clips: plan.clips.length,
    erasures: plan.erasures.length,
    source_duration: round3(sourceDuration),
    kept_duration: round3(kept),
    removed_duration: round3(Math.max(0, sourceDuration - kept)),
    output_duration: round3(output),
  };
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/**
 * A plan in a link.
 *
 * Plain base64url of the JSON, with no compression, and that is a decision
 * rather than laziness: the editor has to decode this with four lines of
 * browser code, and a format one end can write but the other cannot read is
 * not a format. The cost is length, which `linkFor` reports.
 */
export function encodePlan(plan: Plan): string {
  const json = JSON.stringify(compact(plan));
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Drop defaults, round times to milliseconds and coordinates to four places. */
function compact(plan: Plan): Record<string, unknown> {
  const r4 = (n: number) => Math.round(n * 10000) / 10000;
  const shape = (s: Shape): Shape => {
    if (s.type === "rect" || s.type === "ellipse") {
      return { type: s.type, x: r4(s.x!), y: r4(s.y!), w: r4(s.w!), h: r4(s.h!) };
    }
    if (s.type === "polygon") return { type: "polygon", points: s.points!.map(([x, y]) => [r4(x), r4(y)]) };
    if (s.type === "brush") return { type: "brush", stamps: s.stamps!.map((st) => ({ x: r4(st.x), y: r4(st.y), r: r4(st.r) })) };
    return s;
  };
  const out: Record<string, unknown> = { format: FORMAT, version: VERSION };
  if (plan.source) {
    const source: Record<string, unknown> = { name: plan.source.name, duration: round3(plan.source.duration) };
    for (const k of ["width", "height", "fps"] as const) {
      if (plan.source[k] != null) source[k] = plan.source[k];
    }
    out.source = source;
  } else {
    out.source = null;
  }
  out.clips = plan.clips.map((c) => {
    const clip: Record<string, unknown> = { id: c.id, start: round3(c.start), end: round3(c.end) };
    if (c.speed != null && c.speed !== 1) clip.speed = c.speed;
    if (c.muted) clip.muted = true;
    return clip;
  });
  out.erasures = plan.erasures.map((e) => {
    const era: Record<string, unknown> = { id: e.id, method: e.method, from: round3(e.from), to: round3(e.to) };
    if (e.feather != null && e.feather !== 6) era.feather = e.feather;
    if (e.strength != null && e.strength !== 1) era.strength = e.strength;
    if (e.track) era.track = true;
    era.keys = e.keys.map((k) => ({ t: round3(k.t), shape: shape(k.shape) }));
    return era;
  });
  const output: Record<string, unknown> = {};
  for (const k of ["width", "height", "fps", "bitrate"] as const) {
    if (plan.output?.[k] != null) output[k] = plan.output[k];
  }
  out.output = output;
  return out;
}

export function linkFor(plan: Plan) {
  const url = `${EDITOR}#plan=${encodePlan(plan)}`;
  return { url, length: url.length, too_long: url.length > SAFE_LINK_LENGTH };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const shapeSchema = z.object({
  type: z.enum(["rect", "ellipse", "polygon", "brush"]).describe("rect and ellipse are the usual choice"),
  x: z.number().optional().describe("Left edge as a fraction of the frame width, 0..1"),
  y: z.number().optional().describe("Top edge as a fraction of the frame height, 0..1"),
  w: z.number().optional().describe("Width as a fraction of the frame width, 0..1"),
  h: z.number().optional().describe("Height as a fraction of the frame height, 0..1"),
  points: z.array(z.tuple([z.number(), z.number()])).optional().describe("polygon only: [x, y] pairs, each 0..1"),
  stamps: z.array(z.object({ x: z.number(), y: z.number(), r: z.number() })).optional()
    .describe("brush only: circles, all three values fractions of the frame"),
});

const erasureSchema = z.object({
  method: z.enum(METHODS).default("temporal-median")
    .describe(
      "temporal-median: take the background from other frames -- the one that really removes things, " +
      "and it needs the object or the camera to move. " +
      "inpaint: invent the background from the same frame, for something that never moves. " +
      "blur / pixelate: obscure rather than remove.",
    ),
  from: z.number().describe("Start of the erasure, in seconds of the ORIGINAL file"),
  to: z.number().describe("End of the erasure, in seconds of the ORIGINAL file"),
  feather: z.number().optional().describe("Soft edge in pixels at output resolution. Default 6"),
  strength: z.number().optional().describe("0..1, how far to blend the fill in. Default 1"),
  keys: z.array(z.object({
    t: z.number().describe("Time in seconds of the ORIGINAL file"),
    shape: shapeSchema,
  })).min(1).describe(
    "Where the mask is, over time. Two keyframes -- one at each end of the range -- are enough " +
    "for something moving in a straight line; the shape is interpolated between them and HELD " +
    "before the first and after the last, never extrapolated. Give a keyframe at the end of the " +
    "range, or the mask stops following before the erasure does.",
  ),
});

const sourceSchema = z.object({
  name: z.string().optional().describe("The file's name, only used to name the export"),
  duration: z.number().describe("Length of the original file in seconds. The one field that must be right"),
  width: z.number().optional(),
  height: z.number().optional(),
  fps: z.number().optional(),
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export function registerEditorTools(server: McpServer) {
  server.registerTool(
    "video_editor",
    {
      description:
        "Where the video editor is, and how to drive it from here. Call this first when someone " +
        "wants to cut a video or erase something out of one. Needs no key and touches no video: " +
        "the editing happens in the person's own browser, and nothing is ever uploaded.",
      inputSchema: {},
    },
    async () => {
      const text = [
        `Editor: ${EDITOR}`,
        "",
        "It cuts video and erases objects out of it, entirely in the browser. No upload, no account,",
        "no install. It is built to be usable from a tablet with no terminal.",
        "",
        "How to use it from here:",
        "",
        "  1. Ask how long the video is, and roughly where the interesting bits are. Everything is",
        "     described in seconds of the ORIGINAL file.",
        "  2. Call build_cut_plan with what should be cut out and what should be erased.",
        "  3. Give the person the link it returns. They open it, pick the same file, and the edit is",
        "     already there for them to check, adjust and export.",
        "",
        "What it can do:",
        "",
        "  Cutting   split, delete a part, cut a marked range, reorder, trim, change speed, mute.",
        "  Erasing   paint over something and take it out of the picture. Four methods:",
        ...METHODS.map((m) => `              ${m.padEnd(16)} ${METHOD_HELP[m]}`),
        "",
        "What it cannot do, so nobody promises it:",
        "",
        "  - Track a flat, untextured object against a background that does not move. There is no",
        "    cue for it; the editor says so rather than guessing.",
        "  - Continue a straight line across a filled hole, or reconstruct a face.",
        "  - Remove something that never moves AND is in front of something never otherwise shown.",
        "    Nothing can: those pixels were never recorded. It will be invented, and it will look it.",
        "",
        "A blur is not a removal. The information is attenuated, not destroyed.",
      ].join("\n");
      return {
        structuredContent: { editor: EDITOR, format: FORMAT, version: VERSION, methods: METHOD_HELP },
        content: [{ type: "text" as const, text }],
      };
    },
  );

  server.registerTool(
    "build_cut_plan",
    {
      description:
        "Build a cut plan and a link that opens the editor with it. Give the length of the video " +
        "and the ranges to remove and/or the things to erase; everything is in seconds of the " +
        "ORIGINAL file, and mask coordinates are fractions of the frame (0..1), never pixels.",
      inputSchema: {
        source: sourceSchema.describe("The video this plan is for"),
        remove: z.array(z.tuple([z.number(), z.number()])).optional()
          .describe(
            "Ranges to cut out, as [from, to] in seconds of the original. Overlapping and " +
            "out-of-order ranges are fine. Leave out to keep the whole thing.",
          ),
        keep: z.array(z.tuple([z.number(), z.number()])).optional()
          .describe(
            "The other way round: only these ranges survive, in the order given. Use this to " +
            "reorder as well as trim. Ignored when `remove` is given.",
          ),
        erase: z.array(erasureSchema).optional().describe("Things to take out of the picture"),
        output: z.object({
          width: z.number().optional(),
          height: z.number().optional(),
          fps: z.number().optional(),
        }).optional().describe("Export size and frame rate. Defaults to the source's"),
      },
    },
    async ({ source, remove, keep, erase, output }) => {
      if (!(source.duration > 0)) {
        return fail("The source duration must be a positive number of seconds. It is the one field that has to be right.");
      }

      const ranges = remove?.length
        ? keepRanges(source.duration, remove)
        : keep?.length
          ? keep.map(([a, b]) => [Math.max(0, Math.min(a, b)), Math.min(source.duration, Math.max(a, b))] as [number, number])
              .filter(([a, b]) => b - a > 1e-6)
          : [[0, round6(source.duration)] as [number, number]];

      if (ranges.length === 0) {
        return fail("That removes the whole video -- nothing would be left to export.");
      }

      const erasures: Erasure[] = (erase ?? []).map((e, i) => ({
        id: `e${i + 1}`,
        method: e.method ?? "temporal-median",
        from: round6(e.from),
        to: round6(e.to),
        ...(e.feather != null ? { feather: e.feather } : {}),
        ...(e.strength != null ? { strength: e.strength } : {}),
        keys: e.keys.map((k) => ({ t: round6(k.t), shape: k.shape as Shape })),
      }));

      const plan = makePlan(
        {
          name: source.name ?? "video",
          duration: round6(source.duration),
          width: source.width ?? null,
          height: source.height ?? null,
          fps: source.fps ?? null,
        },
        ranges,
        erasures,
      );
      if (output) {
        plan.output = {
          width: output.width ?? plan.output.width,
          height: output.height ?? plan.output.height,
          fps: output.fps ?? plan.output.fps,
          bitrate: null,
        };
      }

      const findings = validatePlan(plan);
      if (hasErrors(findings)) {
        return fail(
          "The plan that came out of that is not valid:\n" +
          findings.filter((f) => f.severity === "error").map((f) => `  ${f.path || "(root)"}: ${f.message}`).join("\n"),
        );
      }

      return planResult(plan, findings, "Built.");
    },
  );

  server.registerTool(
    "check_cut_plan",
    {
      description:
        "Check a cut plan and say what it does: how much is kept, how much is cut, how long the " +
        "export will be, and anything wrong or suspicious about it. Also returns a fresh link. " +
        "Use it on a plan that came from somewhere else, or after editing one by hand.",
      inputSchema: {
        plan: z.union([z.string(), z.record(z.string(), z.unknown())])
          .describe("The plan, as JSON text or as an object"),
      },
    },
    async ({ plan }) => {
      let parsed: unknown;
      if (typeof plan === "string") {
        try {
          parsed = JSON.parse(plan);
        } catch (e) {
          return fail(`That is not valid JSON: ${(e as Error).message}`);
        }
      } else {
        parsed = plan;
      }

      const findings = validatePlan(parsed);
      if (hasErrors(findings)) {
        return {
          isError: true,
          structuredContent: { valid: false, findings },
          content: [{
            type: "text" as const,
            text: "This plan cannot be exported:\n" +
              findings.map((f) => `  ${f.severity}: ${f.path || "(root)"} -- ${f.message}`).join("\n"),
          }],
        };
      }
      return planResult(parsed as Plan, findings, "Valid.");
    },
  );

  server.registerTool(
    "cut_plan_format",
    {
      description:
        "The cut plan format, spelled out with an example. Read this before writing a plan by " +
        "hand; build_cut_plan is easier and gets the arithmetic right on its own.",
      inputSchema: {},
    },
    async () => ({
      structuredContent: { format: FORMAT, version: VERSION, methods: METHOD_HELP, editor: EDITOR },
      content: [{ type: "text" as const, text: FORMAT_HELP }],
    }),
  );
}

function planResult(plan: Plan, findings: Finding[], headline: string) {
  const summary = summarise(plan);
  const link = linkFor(plan);
  const lines = [
    headline,
    "",
    `  source      ${summary.source_duration}s`,
    `  kept        ${summary.kept_duration}s in ${summary.clips} part${summary.clips === 1 ? "" : "s"}`,
    `  cut out     ${summary.removed_duration}s`,
    `  export      ${summary.output_duration}s`,
    `  erasures    ${summary.erasures}`,
    "",
    link.url,
    "",
    "Open that, pick the same video file, and the edit is there.",
  ];
  if (link.too_long) {
    lines.push(
      "",
      `Careful: that link is ${link.length} characters. Some chat apps and address bars cut off ` +
      "around two thousand. If it arrives broken, paste the plan JSON into the editor's " +
      "\"Plan as JSON\" box instead.",
    );
  }
  if (findings.length) {
    lines.push("", "Worth knowing:");
    for (const f of findings) lines.push(`  ${f.path || "(plan)"} -- ${f.message}`);
  }
  return {
    structuredContent: { valid: true, plan, summary, link: link.url, link_length: link.length, findings },
    content: [{ type: "text" as const, text: lines.join("\n") }],
  };
}

function fail(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

const FORMAT_HELP = `The cut plan is one JSON object. The editor reads and writes it, a link carries it,
and build_cut_plan produces it.

{
  "format": "${FORMAT}",
  "version": ${VERSION},
  "source":   { "name": "clip.mp4", "duration": 42.5, "width": 1920, "height": 1080, "fps": 30 },
  "clips":    [ { "id": "c1", "start": 0, "end": 12.0 },
                { "id": "c2", "start": 18.5, "end": 42.5 } ],
  "erasures": [ { "id": "e1", "method": "temporal-median", "from": 3.0, "to": 8.0, "feather": 6,
                  "keys": [
                    { "t": 3.0, "shape": { "type": "rect", "x": 0.42, "y": 0.31, "w": 0.12, "h": 0.28 } },
                    { "t": 8.0, "shape": { "type": "rect", "x": 0.61, "y": 0.29, "w": 0.12, "h": 0.28 } } ] } ],
  "output":   { "width": 1920, "height": 1080, "fps": 30 }
}

Two rules are not arbitrary, and getting either wrong is the usual way a plan
comes out wrong:

  TIMES ARE SECONDS OF THE ORIGINAL FILE, never frame numbers. A frame number
  means nothing without a frame rate, and footage off a phone often has no
  single frame rate at all. "clips" lists what SURVIVES, not what is removed,
  and it plays in the order given -- so reordering is just reordering the list.

  MASK COORDINATES ARE FRACTIONS OF THE FRAME (0..1), never pixels. x: 0.42
  means 42% across. A plan built against a small preview has to mean the same
  thing applied to the 4K original, and a plan built from a description was
  written without ever seeing the file.

Shapes: rect and ellipse take x, y, w, h. polygon takes "points", a list of
[x, y] pairs. brush takes "stamps", a list of { x, y, r } circles.

Keyframes: the mask is interpolated between them, and HELD before the first and
after the last -- never extrapolated, because an extrapolated mask drifts off
the object and starts erasing background. Two keyframes, one at each end of the
range, are enough for something moving in a straight line. Put one at the END
of the range, or the mask stops following before the erasure does.

Methods:

${METHODS.map((m) => `  ${m}\n    ${METHOD_HELP[m]}`).join("\n")}

Everything is optional except source.duration, clips and, inside an erasure,
method, from, to and at least one keyframe.`;
