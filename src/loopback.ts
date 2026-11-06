import { createServer } from 'node:net';

interface LoopbackServer {
  once(event: 'error', listener: (error: Error) => void): unknown;
  listen(options: { host: string; port: number; exclusive: boolean }, callback: () => void): unknown;
  close(callback: (error?: Error) => void): unknown;
}

/** Probe localhost binding without opening a persistent listener. */
export function probeLoopback(serverFactory: () => LoopbackServer = createServer): Promise<boolean> {
  return new Promise(resolve => {
    const server = serverFactory();
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      server.close(error => resolve(error === undefined));
    });
  });
}
