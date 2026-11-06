import { fileURLToPath } from 'node:url';
import { spawn } from 'bun';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

export async function compose(...args: string[]): Promise<{ code: number; output: string }> {
  const child = spawn({
    cmd: ['docker', 'compose', ...args],
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, output: `${stdout}${stderr}` };
}

export async function composeOrThrow(...args: string[]): Promise<void> {
  const result = await compose(...args);
  if (result.code !== 0) {
    throw new Error(`docker compose ${args.join(' ')} failed:\n${result.output}`);
  }
}

export async function eventually(
  probe: () => Promise<boolean>,
  { timeoutMs = 60_000, intervalMs = 500, description = 'condition' } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await probe()) return;
    } catch {}
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
    await Bun.sleep(intervalMs);
  }
}
