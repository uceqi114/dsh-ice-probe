/**
 * 🧊 dsh-ice-probe — client half
 *
 * The host appends 🧊 markers to the model output. This half counts the markers that
 * reach the browser and plays a short sound for each one, so "how many times ice was
 * added" and "how many sounds were played" line up.
 *
 * How the counting works
 * ----------------------
 * - The host writes ice in front of sentence-ending punctuation. A run of adjacent
 *   🧊 characters counts as one insertion.
 * - Live deltas (`assistant/live-chunk`) are cumulative inside a step, but the UI can
 *   replay recent chunks to a freshly registered definition, so the "how many ice
 *   markers have I already counted" watermark lives in a module-level Map, outside
 *   the definition state.
 * - Reasoning text arrives live, but the settled body of a message arrives as
 *   `assistant/message`. The settled copy is complete, so it is reconciled against
 *   what already played (subtract live-counted ice) — the message sounds exactly once.
 *
 * The sound is synthesized (no audio files needed): queue length picks the tier, and
 * each tier plays `cost` short descending-beep notes while draining that many ice
 * markers from the queue. A tier-4 burst therefore feels denser than a tier-1 blip.
 */

window.__ModuleLoader__.load({
  id: "dsh-ice-probe",
  factory(require) {
    const VERSION = "0.1.0";
    const PROBE_KEY = "ice-probe";
    const ICE_CHAR = "🧊";
    /** Punctuation is only used for diagnostics here; "should this get ice" is decided by the host. */
    const END_PUNCT = /[。！？…!?.]/;

    /** Queue length → sound tier. cost = how many ice markers this sound drains. */
    const LADDER = [
      { cost: 1, offsetHz: 0 },
      { cost: 2, offsetHz: 120 },
      { cost: 3, offsetHz: 240 },
      { cost: 4, offsetHz: 360 },
    ];
    const TONE_BASE_HZ = 1180;
    const NOTE_MS = 70;
    const NOTE_STEP_MS = 90;
    const GAP_MS = 60;

    const log = (...parts) => {
      try {
        console.log("[ice-probe]", VERSION, ...parts);
      } catch {
        /* no console */
      }
    };
    const warn = (...parts) => {
      try {
        console.warn("[ice-probe]", VERSION, ...parts);
      } catch {
        /* ignore */
      }
    };

    log("client loaded at", new Date().toISOString());

    /* ---------------- counters and queue ---------------- */

    const stats = {
      chunks: 0,
      textDeltas: 0,
      reasoningDeltas: 0,
      otherDeltas: 0,
      iceSeen: 0,
      ends: 0,
      plays: 0,
      drains: 0,
      drained: 0,
      replays: 0,
      unlocks: 0,
      definitions: 0,
      audioErrors: 0,
    };
    const queueState = { cubes: 0, playing: false, maxSeen: 0 };
    /** Playback watermark: `turn:step:channel` → ice already counted. Kept outside definition state. */
    const played = new Map();
    /** Punctuation watermark (diagnostics only). */
    const endsMark = new Map();
    const chunkTypes = new Set();
    let audioCtx = null;
    let audioState = "none";
    /** `turn:step` of the step currently streaming, used to reconcile the settled message. */
    let currentTurnStep = "?";

    /* ---------------- audio ---------------- */

    function unlock(reason) {
      try {
        const AudioCtor = window.AudioContext || window.webkitAudioContext;
        if (typeof AudioCtor !== "function") {
          audioState = "no-AudioContext";
          return null;
        }
        if (audioCtx === null) audioCtx = new AudioCtor();
        if (audioCtx.state === "suspended") void audioCtx.resume();
        audioState = audioCtx.state;
        stats.unlocks += 1;
        log("audio unlocked (" + reason + ") →", audioCtx.state);
        return audioCtx;
      } catch (error) {
        audioState = "throw:" + String(error?.message ?? error);
        warn("audio unlock failed:", String(error?.message ?? error));
        return null;
      }
    }

    /** One sound = `count` short notes, one note per drained ice marker. */
    function playSound(tierIndex, onEnded) {
      const step = LADDER[tierIndex];
      const audio = audioCtx ?? unlock("play");
      if (audio === null) {
        stats.audioErrors += 1;
        if (typeof onEnded === "function") onEnded();
        return;
      }
      try {
        const start = audio.currentTime;
        for (let note = 0; note < step.cost; note += 1) {
          const at = start + (note * NOTE_STEP_MS) / 1000;
          const osc = audio.createOscillator();
          const gain = audio.createGain();
          osc.type = "triangle";
          osc.frequency.setValueAtTime(TONE_BASE_HZ + step.offsetHz, at);
          gain.gain.setValueAtTime(0.0001, at);
          gain.gain.exponentialRampToValueAtTime(0.12, at + 0.006);
          gain.gain.exponentialRampToValueAtTime(0.0001, at + NOTE_MS / 1000);
          osc.connect(gain);
          gain.connect(audio.destination);
          if (note === step.cost - 1 && typeof onEnded === "function") {
            osc.onended = () => onEnded();
          }
          osc.start(at);
          osc.stop(at + NOTE_MS / 1000 + 0.01);
        }
        stats.plays += 1;
      } catch (error) {
        warn("play failed:", String(error?.message ?? error));
        if (typeof onEnded === "function") onEnded();
      }
    }

    /* ---------------- queue → sound ---------------- */

    function enqueueCubes(count) {
      queueState.cubes += count;
      if (queueState.cubes > queueState.maxSeen) queueState.maxSeen = queueState.cubes;
      drain();
    }

    function drain() {
      if (queueState.playing) return;
      if (queueState.cubes <= 0) return;
      const tier = Math.min(queueState.cubes, LADDER.length);
      const step = LADDER[tier - 1];
      queueState.cubes = Math.max(0, queueState.cubes - step.cost);
      queueState.playing = true;
      stats.drains += 1;
      stats.drained += step.cost;
      playSound(tier - 1, () => {
        queueState.playing = false;
        window.setTimeout(() => drain(), GAP_MS);
      });
    }

    /* Browsers only allow audio after a user gesture. One global gesture is enough. */
    if (typeof document !== "undefined") {
      const gestureEvents = ["pointerdown", "keydown", "touchstart"];
      const onGesture = (event) => {
        const audio = unlock(String(event?.type ?? "gesture"));
        if (audio !== null && audio.state === "running") {
          for (const name of gestureEvents) document.removeEventListener(name, onGesture, true);
        }
      };
      for (const name of gestureEvents) document.addEventListener(name, onGesture, true);
    }

    /* ---------------- ice counting ---------------- */

    /** Count insertions: a run of adjacent 🧊 characters is one insertion. */
    function countIce(text) {
      let total = 0;
      let inRun = false;
      for (const char of text) {
        if (char === ICE_CHAR) {
          if (!inRun) {
            total += 1;
            inRun = true;
          }
        } else {
          inRun = false;
        }
      }
      return total;
    }

    /** Punctuation count, diagnostics only. */
    function countEnds(text) {
      let total = 0;
      for (const char of text) if (END_PUNCT.test(char)) total += 1;
      return total;
    }

    const probeDefinition = {
      kind: PROBE_KEY,
      match(event) {
        if (event?.type === "step/start") {
          return { id: `${event.data?.turn}:${event.data?.step}`, role: "start" };
        }
        if (event?.type === "assistant/live-chunk") {
          return { id: `${event.data?.turn}:${event.data?.step}`, role: "update" };
        }
        /* The visible body is not delivered as live text deltas in this UI; it arrives as
           the settled `assistant/message`. Counting it here is what makes body ice audible. */
        if (event?.type === "assistant/message") {
          return { id: `msg:${event.data?.message?.id ?? event.seq}`, role: "update" };
        }
        return null;
      },
      start(_context, match) {
        return {
          turn: match?.event?.data?.turn,
          step: match?.event?.data?.step,
          channels: {},
        };
      },
      update(context, match) {
        const state = context?.state ?? { channels: {} };

        if (match?.event?.type === "assistant/message") {
          /* Settled message: the complete body + reasoning. Subtract what already played
             from the live deltas so the same sentence does not sound twice, then mark it
             as handled (the UI may replay it). */
          const durableKey = `${state.turn ?? currentTurnStep}:msg:${match.event.data?.message?.id ?? match.event.seq}`;
          if (played.has(durableKey)) return state;
          const content = match.event.data?.message?.content ?? [];
          let settled = 0;
          for (const block of content) {
            if (typeof block?.text === "string" && (block.type === "text" || block.type === "reasoning")) {
              settled += countIce(block.text);
            }
          }
          const prefix = `${currentTurnStep}:`;
          let liveCounted = 0;
          for (const [key, value] of played) {
            if (key.startsWith(prefix) && key.includes(":msg:") === false) liveCounted += value;
          }
          const fresh = settled - liveCounted;
          if (fresh > 0) {
            played.set(durableKey, settled);
            stats.iceSeen += fresh;
            log("settled message: +" + fresh + " ice (total in message: " + settled + ")");
            enqueueCubes(fresh);
          }
          return state;
        }

        const chunk = match?.event?.data?.chunk;
        if (chunk === undefined) return state;
        if (!chunkTypes.has(chunk.type)) {
          chunkTypes.add(chunk.type);
          log("first chunk type seen:", chunk.type);
        }

        stats.chunks += 1;
        if (chunk.type === "text-delta") stats.textDeltas += 1;
        else if (chunk.type === "reasoning-delta") stats.reasoningDeltas += 1;
        else stats.otherDeltas += 1;

        if (chunk.type !== "text-delta" && chunk.type !== "reasoning-delta") return state;

        const channel = `${chunk.type}:${chunk.index}`;
        /* Deltas are incremental, so accumulate. */
        const accumulated = (state.channels?.[channel] ?? "") + String(chunk.text ?? "");
        const waterKey = `${state.turn}:${state.step}:${channel}`;
        currentTurnStep = `${state.turn}:${state.step}`;

        const ices = countIce(accumulated);
        const done = played.get(waterKey) ?? 0;
        if (ices > done) {
          played.set(waterKey, ices);
          const fresh = ices - done;
          stats.iceSeen += fresh;
          if (fresh > 1) stats.replays += 1;
          enqueueCubes(fresh);
        }

        const ends = countEnds(accumulated);
        const endsDone = endsMark.get(waterKey) ?? 0;
        if (ends > endsDone) {
          endsMark.set(waterKey, ends);
          stats.ends += ends - endsDone;
        }

        return { ...state, channels: { ...state.channels, [channel]: accumulated } };
      },
      publication: (match) => (match?.role === "start" ? "immediate" : "animation-frame"),
    };

    /* ---------------- registration ---------------- */

    function readService(ctx, name) {
      try {
        return ctx?.[name];
      } catch (error) {
        warn(`service "${name}" unavailable:`, String(error?.message ?? error));
        return undefined;
      }
    }

    return {
      inject: ["uiConversation"],
      apply(ctx) {
        log("apply() at", new Date().toISOString());

        const uiConversation = readService(ctx, "uiConversation");
        const registerEvents = uiConversation?.events?.register?.bind(uiConversation.events);
        if (typeof registerEvents === "function") {
          try {
            ctx.effect(() => {
              const registered = registerEvents(probeDefinition);
              stats.definitions += 1;
              log("conversation node definition registered, kind =", PROBE_KEY);
              return typeof registered === "function" ? registered : undefined;
            }, "ice-probe conversation node definition");
          } catch (error) {
            warn("definition registration failed:", String(error?.message ?? error));
          }
        } else {
          warn("uiConversation.events.register is unavailable");
        }

        try {
          window.__iceProbe = {
            version: VERSION,
            stats,
            queueState,
            played,
            chunkTypes,
            probeDefinition,
            audioState: () => audioState,
            unlock,
            playSound,
            drain,
            enqueueCubes,
          };
          log("window.__iceProbe is available");
        } catch {
          /* ignore */
        }
      },
    };
  },
});
