/**
 * 🧊 dsh-ice-probe — core (host half)
 *
 * The whole point of this plugin is one mechanical guarantee: every sentence the
 * model produces — visible text *and* chain-of-thought — gets a short 🧊 marker in
 * front of its final punctuation. It is an output-pipeline transform, never a prompt.
 *
 * Design notes
 * ------------
 * - Works on `llm/stream`, so it sees every model call of the session, including
 *   the ones that only produce reasoning.
 * - Only `text-delta`, `reasoning-delta` and `block-end` are touched. `tool-call-delta`
 *   MUST pass through untouched: rewriting it corrupts tool-argument JSON.
 * - `block-end` carries the settled copy of the block (`chunk.block`). Patching only
 *   the deltas produces the classic bug where the ice is visible while streaming and
 *   disappears once the step settles.
 * - Sentence detection never drops characters: a trailing English period is held
 *   until the next delta proves whether it was a sentence end, and a split surrogate
 *   pair is carried over. Everything held is flushed on `block-end`.
 * - Excluded on purpose: `session-title` / `compaction` model calls and sub-agent /
 *   workflow sessions (they must not pollute their parent's output).
 */

export const CORE_VERSION = "0.1.0";

const ROUTE_BASE = "/ice-probe";

/** Chinese sentence enders: always iced. */
const CN_SENTENCE_END = new Set(["。", "！", "？", "…"]);
/** English ! and ? : always iced (a run of punctuation counts once). */
const EN_SENTENCE_END = new Set(["!", "?"]);
/** English period: only iced when it is really the end of a sentence. */
const DOT = ".";
const ICE = "🧊🧊🧊";

/* ---------------- state shared across hot reloads ---------------- */

const G = (globalThis.__dshIceProbe ??= {});
G.loads = (G.loads ?? 0) + 1;
G.loadedAt = new Date().toISOString();
G.stream ??= {
  calls: 0,
  chunks: 0,
  textDeltas: 0,
  reasoningDeltas: 0,
  toolDeltas: 0,
  otherChunks: 0,
  inserted: 0,
  blockEndInserted: 0,
  skippedByPurpose: 0,
  skippedBySubagent: 0,
  purposes: {},
  recent: [],
};
G.samples ??= [];
G.lastError ??= null;
G.services ??= {};

/** Host services handed over by the entry (see index.js). */
export function setServices(bag) {
  G.services = bag ?? {};
  return { sessions: typeof G.services.sessions?.get === "function" };
}

/* ---------------- which model calls get ice ---------------- */

function isSubagentSession(sessionId) {
  if (sessionId === undefined || sessionId === null || sessionId === "") return false;
  try {
    const session = G.services?.sessions?.get?.(sessionId);
    const header = session?.header;
    if (header === undefined || header === null) return false;
    if (header.origin === "subagent") return true;
    if (header.parentSession !== undefined && header.parentSession !== null) return true;
    if (typeof header.delegationDepth === "number" && header.delegationDepth > 0) return true;
    return false;
  } catch (error) {
    G.lastError = "subagent-check: " + String(error?.message ?? error);
    return false;
  }
}

/**
 * Whether this model call should be iced.
 * Gating is done outside this file: if the plugin is enabled in the plugin
 * marketplace it applies to every conversation; disabling/uninstalling the
 * plugin unloads this module entirely.
 */
function shouldIce(options) {
  const purpose = options?.purpose;
  if (purpose === "session-title" || purpose === "compaction") return false;
  const sessionId = options?.sessionId;
  if (sessionId === undefined || sessionId === null) return false;
  return !isSubagentSession(String(sessionId));
}

/** Keep the last few "before → after" rewrites so the status route can prove it works. */
function recordSample(channel, options, before, after) {
  G.samples.push({
    at: new Date().toISOString(),
    channel,
    sessionId: String(options?.sessionId ?? ""),
    before: String(before ?? "").slice(-70),
    after: String(after ?? "").slice(-70),
  });
  if (G.samples.length > 8) G.samples.splice(0, G.samples.length - 8);
}

/* ---------------- the stream wrapper ---------------- */

export function wrapStream(options, next) {
  const stats = G.stream;
  const purpose = String(options?.purpose ?? "chat");
  stats.calls += 1;
  stats.purposes[purpose] = (stats.purposes[purpose] ?? 0) + 1;
  stats.recent.push({
    at: new Date().toISOString(),
    purpose,
    sessionId: String(options?.sessionId ?? ""),
    model: String(options?.model ?? ""),
    provider: String(options?.provider ?? ""),
  });
  if (stats.recent.length > 20) stats.recent.splice(0, stats.recent.length - 20);

  const applying = shouldIce(options);
  if (!applying) {
    if (purpose === "session-title" || purpose === "compaction") stats.skippedByPurpose += 1;
    else stats.skippedBySubagent += 1;
    return next();
  }

  return (async function* iceStream() {
    const channels = new Map();
    /* Everything held back (a suspected English period, half a surrogate pair)
       must be released in order — never dropped. */
    const releaseTail = (entry) => {
      if (entry === undefined) return undefined;
      const result = flushDelta(entry.state);
      if (result.text === "") return undefined;
      if (result.inserted > 0) {
        stats.inserted += result.inserted;
        stats.lastInsertAt = new Date().toISOString();
        recordSample(entry.deltaType, options, result.text, result.text);
      }
      return { type: entry.deltaType, index: entry.index, text: result.text };
    };

    for await (const chunk of next()) {
      stats.chunks += 1;
      try {
        const type = chunk?.type;

        if (type === "text-delta" || type === "reasoning-delta") {
          if (type === "text-delta") stats.textDeltas += 1;
          else stats.reasoningDeltas += 1;
          const index = Number(chunk?.index ?? 0);
          let entry = channels.get(index);
          if (entry === undefined || entry.deltaType !== type) {
            entry = { state: newChannelState(), deltaType: type, index };
            channels.set(index, entry);
          }
          const result = transformDelta(chunk?.text, entry.state);
          if (result.inserted > 0) {
            stats.inserted += result.inserted;
            stats.lastInsertAt = new Date().toISOString();
            recordSample(type, options, chunk?.text, result.text);
          }
          /* Always yield the transformed text: held-back characters are not optional. */
          yield { ...chunk, text: result.text };
          continue;
        }

        if (type === "block-end") {
          const index = Number(chunk?.index ?? 0);
          const flushed = releaseTail(channels.get(index));
          if (flushed !== undefined) yield flushed;

          /* The settled copy of the block lives here. This is what the UI keeps
             once the step is done, so it has to be transformed too (idempotent). */
          let block = chunk?.block;
          const blockKind = String(block?.type ?? "");
          if (
            (blockKind === "text" || blockKind === "reasoning") &&
            typeof block?.text === "string" &&
            block.text.length > 0
          ) {
            try {
              const whole = transformText(block.text, Number.MAX_SAFE_INTEGER);
              if (whole.inserted > 0) {
                stats.blockEndInserted += whole.inserted;
                stats.inserted += whole.inserted;
                stats.lastInsertAt = new Date().toISOString();
                recordSample(blockKind + "-block-end", options, block.text, whole.output);
              }
              /* transformText returns `output` (not `text`). Using the wrong field
                 writes undefined and makes the chunk non-serializable, which the
                 harness rejects with "Assistant stream chunk must be losslessly
                 JSON-serializable". */
              if (whole.output !== block.text) block = { ...block, text: whole.output };
            } catch (error) {
              G.lastError = "block-end: " + String(error?.message ?? error);
            }
          }
          yield { ...chunk, block };
          continue;
        }

        if (type === "tool-call-delta") stats.toolDeltas += 1;
        else stats.otherChunks += 1;
        yield chunk;
      } catch (error) {
        G.lastError = "stream: " + String(error?.message ?? error);
        yield chunk;
      }
    }

    /* If a block never saw its block-end, still release what was held. */
    for (const entry of channels.values()) {
      const flushed = releaseTail(entry);
      if (flushed !== undefined) yield flushed;
    }
  })();
}

/* ---------------- sentence transform (pure functions) ---------------- */

/** Per-channel parser state. Deltas are fragments, so state survives across them. */
export function newChannelState() {
  return {
    fence: false,
    inline: false,
    atLineStart: true,
    lastChar: "",
    prevChar: "",
    backticks: 0,
    carry: "",
    tail: "",
  };
}

const RE_DIGIT = /[0-9]/;
const RE_LETTER = /[A-Za-z]/;

function isSpaceChar(char) {
  return char === " " || char === "\n" || char === "\t" || char === "\r" || char === "\f" || char === "\v";
}

function pushChar(state, char) {
  state.prevChar = state.lastChar;
  state.lastChar = char;
}

function alreadyIced(state) {
  return state.lastChar === "🧊";
}

/**
 * Process one delta, return { text, inserted }.
 *
 *   · 。！？…                     → ice before the punctuation, always
 *   · ! ?                         → same (a run like "!!!" counts once)
 *   · .                           → only when followed by whitespace / newline / end
 *                                   (so "2.5", "core.js", "e.g." and "..." stay intact)
 *   · inside ``` fences or inline `code` → no ice
 *   · already iced right before the punctuation → no duplicate
 *
 * The "hold" mechanism: a period at the very end of a delta is ambiguous, so it is
 * parked in `state.tail` until the next delta (or flushDelta) disambiguates it.
 * A split surrogate pair is parked in `state.carry` so an emoji is never cut.
 */
export function transformDelta(delta, state) {
  let input = String(state.tail ?? "") + String(state.carry ?? "") + String(delta ?? "");
  state.tail = "";
  state.carry = "";

  const lastUnit = input.length === 0 ? 0 : input.charCodeAt(input.length - 1);
  if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) {
    state.carry = input.slice(-1);
    input = input.slice(0, -1);
  }
  if (input.length === 0) return { text: "", inserted: 0 };

  let out = "";
  let inserted = 0;
  let index = 0;

  while (index < input.length) {
    /* Walk by code point: 🧊 is two UTF-16 units, and a half-emoji must never be
       recorded as `lastChar`. */
    const unit = input.charCodeAt(index);
    let width = 1;
    let char = input[index];
    if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < input.length) {
      const low = input.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        char = input.slice(index, index + 2);
        width = 2;
      }
    }

    if (char === "\n") {
      state.atLineStart = true;
      state.inline = false;
      state.backticks = 0;
      pushChar(state, char);
      out += char;
      index += 1;
      continue;
    }

    /* Fences: three backticks at line start toggle ``` ; a single one toggles inline code. */
    if (char === "`") {
      state.backticks += 1;
      out += char;
      pushChar(state, char);
      if (state.atLineStart && state.backticks === 3) {
        state.fence = !state.fence;
        state.inline = false;
      } else if (!state.fence && !state.atLineStart && state.backticks === 1) {
        state.inline = !state.inline;
      }
      index += 1;
      state.atLineStart = false;
      continue;
    }
    if (char !== " ") state.atLineStart = false;
    state.backticks = 0;

    if (char === DOT) {
      const prev = state.lastChar;
      const inRun = prev === DOT || prev === "!" || prev === "?" || prev === "。";
      const afterDigit = RE_DIGIT.test(prev);
      const abbreviation = RE_LETTER.test(prev) && state.prevChar === DOT;
      const plain = inRun || afterDigit || abbreviation;
      const next = input[index + 1];
      if (!plain && next === undefined) {
        state.tail = input.slice(index);
        break;
      }
      const sentenceEnd = !plain && isSpaceChar(next);
      if (sentenceEnd && !state.fence && !state.inline && !alreadyIced(state)) {
        out += ICE;
        inserted += 1;
      }
      out += char;
      pushChar(state, char);
      index += width;
      continue;
    }

    if (CN_SENTENCE_END.has(char) || EN_SENTENCE_END.has(char)) {
      const prev = state.lastChar;
      const inRun =
        prev === "!" || prev === "?" || prev === DOT ||
        prev === "！" || prev === "？" || prev === "。" || prev === "…";
      if (!inRun && !state.fence && !state.inline && !alreadyIced(state)) {
        out += ICE;
        inserted += 1;
      }
      out += char;
      pushChar(state, char);
      index += width;
      continue;
    }

    out += char;
    pushChar(state, char);
    index += width;
  }

  return { text: out, inserted };
}

/** Release anything held back: a trailing period is a sentence end; a half pair passes through. */
export function flushDelta(state) {
  const tail = String(state.tail ?? "");
  const carry = String(state.carry ?? "");
  state.tail = "";
  state.carry = "";
  if (tail === "" && carry === "") return { text: "", inserted: 0 };

  let out = "";
  let inserted = 0;
  let rest = tail;
  if (rest.startsWith(DOT)) {
    if (!state.fence && !state.inline && !alreadyIced(state)) {
      out += ICE;
      inserted += 1;
    }
    pushChar(state, DOT);
    out += DOT;
    rest = rest.slice(1);
  }
  out += rest + carry;
  if (rest !== "" || carry !== "") pushChar(state, (rest + carry).slice(-1));
  return { text: out, inserted };
}

/** Run a whole string through the same pipeline (used for the settled block copy and tests). */
export function transformText(text, sliceSize = 2) {
  const state = newChannelState();
  let out = "";
  let inserted = 0;
  for (let i = 0; i < text.length; i += sliceSize) {
    const result = transformDelta(text.slice(i, i + sliceSize), state);
    out += result.text;
    inserted += result.inserted;
  }
  const tail = flushDelta(state);
  out += tail.text;
  inserted += tail.inserted;
  return { output: out, inserted, fences: state.fence, inline: state.inline };
}

/* ---------------- offline self-test ---------------- */

export function runSelfTest() {
  const cases = [
    { name: "chinese sentence ends", text: "今天天气真好。你说呢？", want: 2 },
    { name: "english sentence ends", text: "Hello world! Nice weather. Let us go.", want: 3 },
    { name: "periods that are not sentence ends", text: "Version 2.5 of core.js is fine, e.g. this.", want: 1 },
    { name: "reasoning style", text: "先看条件…再算一步…于是结论是 42。", want: 3 },
    { name: "fenced code block", text: "看这段：\n```js\nconst a = 1.0;\n```\n就这样。", want: 1 },
    { name: "inline code", text: "运行 `npm test` 即可。别加冰。", want: 2 },
    { name: "idempotent", text: `已经加过了${ICE}。这里不该再加。`, want: 1 },
    { name: "delta split before chinese punctuation", text: "前半句到了边缘就断" + "。继续。", want: 2 },
    { name: "delta split after english period", text: "Done. Next one.", want: 2 },
  ];
  const results = cases.map((item) => {
    const result = transformText(item.text, 2);
    const again = transformText(result.output, 2);
    return {
      name: item.name,
      input: item.text,
      output: result.output,
      inserted: result.inserted,
      want: item.want,
      pass: result.inserted === item.want && again.inserted === 0,
    };
  });
  return { version: CORE_VERSION, pass: results.every((item) => item.pass), cases: results };
}

/* ---------------- HTTP (local status + self test) ---------------- */

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

function statusBody() {
  return {
    ok: true,
    name: "dsh-ice-probe",
    version: CORE_VERSION,
    loads: G.loads,
    loadedAt: G.loadedAt,
    gating: "plugin-marketplace",
    gatingNote: "enabled in the plugin marketplace = active for every conversation; disable or uninstall to turn it off",
    routes: { status: ROUTE_BASE + "/", selftest: ROUTE_BASE + "/selftest" },
    rules: { chinese: [...CN_SENTENCE_END], english: [...EN_SENTENCE_END], period: "only before whitespace / newline / end" },
    stream: G.stream,
    samples: G.samples,
    lastError: G.lastError,
  };
}

/** Prefix route handler. Mounted by index.js under ROUTE_BASE. */
export function handleHttp(req, res) {
  const url = new URL(String(req?.url ?? "/"), "http://localhost");
  let path = url.pathname;
  if (path === ROUTE_BASE) path = "/";
  else if (path.startsWith(ROUTE_BASE + "/")) path = path.slice(ROUTE_BASE.length);
  if (path === "/") return sendJson(res, 200, statusBody());
  if (path === "/selftest") return sendJson(res, 200, runSelfTest());
  return sendJson(res, 404, { ok: false, error: "not found", routes: ["/", "/selftest"] });
}
