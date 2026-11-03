/**
 * The hive's SFTP server, for devices (spec: "Device link", item 2).
 *
 * A device mounts this laptop's hive with `sshfs -o directport=<base>`, which
 * speaks raw SFTP to a TCP port; the link's `-R <base>:127.0.0.1:<port>`
 * forward carries that port here. Measured on the real machines: through such
 * a forward the mount survives a link cut (reads and writes fail at once with
 * EIO, nothing is written locally) and works again by itself when the link is
 * back.
 *
 * One loopback listener serves every device. Each connection gets its own
 * `sftp-server` child (this laptop's OpenSSH binary, run as this user) with
 * the socket piped through it, so there is no socat dependency.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';

export const SFTP_SERVER_PATHS = [
  '/usr/lib/ssh/sftp-server',
  '/usr/lib/openssh/sftp-server',
  '/usr/libexec/openssh/sftp-server',
  '/usr/libexec/sftp-server'
];

export function findSftpServer(candidates: string[] = SFTP_SERVER_PATHS): string | null {
  return candidates.find((p) => existsSync(p)) ?? null;
}

export interface SftpServer {
  port: number;
  close(): void;
}

export function startSftpServer(candidates: string[] = SFTP_SERVER_PATHS): Promise<SftpServer> {
  const bin = findSftpServer(candidates);
  if (!bin) {
    return Promise.reject(new Error(
      `No sftp-server on this laptop (looked in ${candidates.join(', ')}). Install OpenSSH to run agents on devices.`
    ));
  }
  const server = createServer((sock) => {
    const child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    sock.pipe(child.stdin);
    child.stdout.pipe(sock);
    const end = (): void => {
      try { child.kill(); } catch { /* already gone */ }
      sock.destroy();
    };
    sock.on('error', end);
    sock.on('close', end);
    child.on('error', end);
    child.on('exit', () => sock.end());
    // A socket that closes mid-write must not crash the main process.
    child.stdin.on('error', () => {});
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // Loopback only: the device reaches it through the ssh forward, nothing else can.
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ port, close: () => server.close() });
    });
  });
}
