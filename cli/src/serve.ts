import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

/**
 * Serves the generated report on localhost until interrupted.
 *
 * Deliberately minimal: it binds to 127.0.0.1 only, serves exactly one file,
 * and re-reads it on each request so a rerun in another terminal shows up on
 * refresh. It is not a dashboard and does not poll GitHub - it is the same
 * self-contained HTML file, on a port, for people who would rather look at it
 * in a browser tab than open a file.
 */
export function serveReport(
  reportPath: string,
  port: number,
  note: (s: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' }).end();
        return;
      }
      try {
        const html = await readFile(reportPath, 'utf8');
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          // The report is self-contained, so nothing needs to be fetched.
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:"
        });
        res.end(req.method === 'HEAD' ? undefined : html);
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('Report not found. Rerun the tool.');
      }
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(`Port ${port} is already in use. Pass a different one: --serve 8080`)
          : err
      );
    });

    // 127.0.0.1, not 0.0.0.0: this should not appear on the office network.
    server.listen(port, '127.0.0.1', () => {
      note('');
      note(`  Serving ${basename(reportPath)} at http://localhost:${port}`);
      note('  Nothing is being fetched. Ctrl-C to stop.');
    });

    const stop = () => {
      server.close(() => resolve());
      note('\n  Stopped.');
      // Give close a moment, then exit regardless of keep-alive sockets.
      setTimeout(() => process.exit(0), 200).unref();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}
