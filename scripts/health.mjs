// Health probe for the local service. Exit codes:
//   0 = our service is up
//   1 = nothing is listening / service is down
//   3 = the port is taken by something else
// ASCII-only output on purpose: Windows console code pages vary.
const port = Number(process.env.PORT || 8900);
const verbose = process.argv.includes("-v");
const base = `http://127.0.0.1:${port}`;

async function main() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 2500);
  try {
    const res = await fetch(`${base}/api/status`, { signal: ctl.signal });
    const body = await res.json().catch(() => null);
    if (!body || body.app !== "yuyue3") {
      console.log(`[FOREIGN] port ${port} answers, but it is not YuQing (app=${body?.app ?? "unknown"})`);
      return 3;
    }
    if (!verbose) return 0;
    const up = body.uptimeMs ? `${Math.round(body.uptimeMs / 1000)}s` : "?";
    console.log(`[UP] port ${port}  v${body.version ?? "?"}  up ${up}`);
    const room = (body.rooms || []).find((r) => r.active) || (body.rooms || [])[0];
    if (room) console.log(`     room ${room.roomId}  ${room.title ?? ""}  ${room.state ?? room.liveState ?? ""}`);
    if (body.account?.uname) console.log(`     account ${body.account.uname}`);
    if (body.config) console.log(`     dry run ${body.config.dryRun ? "on" : "off"}`);
    return 0;
  } catch {
    console.log(`[DOWN] nothing is answering on port ${port}`);
    return 1;
  } finally {
    clearTimeout(timer);
  }
}

process.exitCode = await main();
