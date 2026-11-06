import type { Server } from 'bun';
import type { Container } from '../../container';

async function probe(check: () => Promise<void>, timeoutMs = 2_000): Promise<'up' | 'down'> {
  try {
    await Promise.race([
      check(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs).unref()),
    ]);
    return 'up';
  } catch {
    return 'down';
  }
}

export function startOpsServer(container: Container, port: number): Server<undefined> {
  return Bun.serve({
    port,
    fetch: async (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === '/health/live') {
        return Response.json({ status: 'ok' });
      }
      if (pathname === '/health/ready') {
        const [postgres, sqs] = await Promise.all([
          probe(() => container.unitOfWork.ping()),
          probe(() => container.queues.ping(container.config.queues.transactions)),
        ]);
        const ready = postgres === 'up' && sqs === 'up';
        return Response.json(
          { status: ready ? 'ok' : 'unavailable', checks: { postgres, sqs } },
          { status: ready ? 200 : 503 },
        );
      }
      if (pathname === '/metrics') {
        const { contentType, body } = await container.metrics.render();
        return new Response(body, { headers: { 'content-type': contentType } });
      }
      return new Response('Not Found', { status: 404 });
    },
  });
}
