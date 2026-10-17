/**
 * 🧊 dsh-ice-probe — host entry
 *
 * Everything that may change lives in `lib/core.js`; this entry stays intentionally
 * thin. The entry re-imports the core whenever the core file's mtime/size changes,
 * which makes iterating on the transform possible without restarting the harness.
 *
 * Services must be declared with a top-level `export const inject = [...]`.
 * Reading a service that is not declared there throws
 * `cannot get property "X" without inject`.
 */

import { statSync } from "node:fs";

export const name = "dsh-ice-probe";
export const inject = ["sessions", "webServer"];

const CORE_URL = new URL("./lib/core.js", import.meta.url);
const ROUTE_BASE = "/ice-probe";

let currentCore = null;
let coreStamp = null;

function info(message) {
  try {
    console.log(`[ice-probe] ${message}`);
  } catch {
    /* no console in this runtime */
  }
  try {
    const g = (globalThis.__dshIceProbe ??= {});
    g.entryLog = (g.entryLog ?? []).concat([`${new Date().toISOString()} ${message}`]).slice(-40);
  } catch {
    /* ignore */
  }
}

async function loadCore() {
  let stamp = "missing";
  try {
    const stat = statSync(CORE_URL);
    stamp = `${stat.mtimeMs}-${stat.size}`;
  } catch (error) {
    stamp = "stat-failed:" + String(error?.message ?? error);
  }
  if (currentCore !== null && stamp === coreStamp) return currentCore;
  const mod = await import(`${CORE_URL.href}?v=${encodeURIComponent(stamp)}`);
  currentCore = mod;
  coreStamp = stamp;
  info(`core loaded: v=${stamp} version=${mod?.CORE_VERSION ?? "?"}`);
  return mod;
}

function services(ctx) {
  return { sessions: ctx?.sessions };
}

try {
  await loadCore();
} catch (error) {
  info("core initial load failed: " + String(error?.message ?? error));
}

export function apply(ctx) {
  info(`apply — ${name}`);

  try {
    currentCore?.setServices?.(services(ctx));
  } catch (error) {
    info("setServices failed: " + String(error?.message ?? error));
  }

  /* Status + self-test route, under the plugin's own prefix. */
  ctx.inject(["webServer"], () => {
    const webServer = ctx.webServer;
    if (webServer === undefined || typeof webServer.register !== "function") {
      info("webServer unavailable — status route not mounted");
      return () => {};
    }
    info("registering route " + ROUTE_BASE + "/*");
    return webServer.register({
      kind: "prefix",
      path: ROUTE_BASE,
      handler: async (req, res) => {
        try {
          const core = await loadCore();
          core.setServices(services(ctx));
          core.handleHttp(req, res);
        } catch (error) {
          try {
            res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
          } catch {
            /* ignore */
          }
        }
        return undefined;
      },
    });
  });

  /* The transform itself. `global: true` so it sees every session, sub-agents included
     (the core decides which ones are skipped). */
  ctx.on(
    "llm/stream",
    (options, next) => {
      void loadCore().catch((error) => info("core reload failed: " + String(error?.message ?? error)));
      const core = currentCore;
      if (core === null || typeof core.wrapStream !== "function") return next();
      try {
        return core.wrapStream(options, next);
      } catch (error) {
        info("wrapStream failed: " + String(error?.message ?? error));
        return next();
      }
    },
    { global: true },
  );
}
