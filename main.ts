// Boot file for the forge. The harness contract, in short:
//   * MAKEFUN_ENV_URL points at the env; without it there is nobody to serve.
//   * Listen on port 0 (the kernel chooses), never on 8080 (the env's port).
//   * Tell the env the chosen port via POST /register, then keep asking
//     GET /done until it answers {"done": true}; only then exit, with 0.
// Registering and polling are retried with a capped backoff, because the env
// may still be starting when this process comes up.

import { createApp as buildForgeServer } from './app.ts';

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin.length === 0) {
  process.stderr.write('[forge] MAKEFUN_ENV_URL is unset, exiting\n');
  process.exit(1);
}

const CALL_TIMEOUT_MS = 30000;
const FIRST_RETRY_MS = 250;
const LONGEST_RETRY_MS = 2000;

function pause(ms: number): Promise<void> {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}

function backoffFor(failures: number): number {
  const grown = FIRST_RETRY_MS * 2 ** Math.min(failures, 8);
  return Math.min(LONGEST_RETRY_MS, grown);
}

/** POST the port until the env takes it: 200 recorded, 409 beaten to it. */
async function announcePort(port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const res = await fetch(envOrigin + '/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port: port }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error('register refused with HTTP ' + res.status + ': ' + (await res.text()));
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register refused')) throw err;
    }
    await pause(backoffFor(failures));
    failures += 1;
  }
}

/** Ask the env whether the trial is over, forever if need be. */
async function holdUntilDone(): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const res = await fetch(envOrigin + '/done', {
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // A silent env is a running trial, not a finished one: keep asking.
    }
    await pause(backoffFor(failures));
    failures += 1;
  }
}

async function run(): Promise<void> {
  const server = buildForgeServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      resolve();
    });
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('no ephemeral TCP port was bound');
  }
  process.stdout.write('[forge] serving on port ' + bound.port + '\n');
  await announcePort(bound.port);
  process.stdout.write('[forge] registered, holding until done\n');
  await holdUntilDone();
  server.close();
  process.stdout.write('[forge] trial over, exiting\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  const text = err instanceof Error ? err.message : String(err);
  process.stderr.write('[forge] ' + text + '\n');
  process.exit(1);
}
