/**
 * CLI kill switch: `bun run stop` sends POST /api/shutdown to the running server.
 *
 * No server imports, no shared modules — this is a standalone script that talks HTTP.
 * Respects WC_PORT the same way the server does.
 *
 * In dev mode Vite runs on a separate port (5173). This script also kills that process
 * so the user isn't left with a half-working frontend that can't reach the API.
 */

const VITE_PORT = 5173;
const port = Number(process.env.WC_PORT ?? 8787);
const url = `http://localhost:${port}/api/shutdown`;

let serverWasRunning = false;

try {
  const response = await fetch(url, { method: 'POST' });
  if (response.ok) {
    serverWasRunning = true;
  } else {
    const text = await response.text().catch(() => '');
    console.error(`  Server returned ${response.status}: ${text}`);
    process.exit(1);
  }
} catch (error) {
  // Connection refused means the server is already down — goal met.
  const code =
    (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code;
  if (code !== 'ECONNREFUSED') {
    console.error(`  Could not reach WackChatter on port ${port}:`, (error as Error).message);
    process.exit(1);
  }
}

// Best-effort: kill the Vite dev server if it's running. In production there is no
// separate client process, so this is a no-op that silently succeeds.
let viteKilled = false;
try {
  const lsof = Bun.spawn(['lsof', '-ti', `:${VITE_PORT}`], {
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const pids = (await new Response(lsof.stdout).text()).trim();
  await lsof.exited;
  if (pids) {
    for (const pid of pids.split('\n')) {
      try {
        process.kill(Number(pid), 'SIGTERM');
        viteKilled = true;
      } catch {
        // Already gone.
      }
    }
  }
} catch {
  // lsof not available or errored — not critical.
}

if (serverWasRunning && viteKilled) {
  console.log(`  WackChatter stopped (server on ${port}, dev client on ${VITE_PORT}).`);
} else if (serverWasRunning) {
  console.log(`  WackChatter stopped (port ${port}).`);
} else if (viteKilled) {
  console.log(`  Server was not running on port ${port}. Stopped dev client on ${VITE_PORT}.`);
} else {
  console.log(`  WackChatter is not running on port ${port}.`);
}
