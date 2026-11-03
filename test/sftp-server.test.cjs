'use strict';
/**
 * Devices, Task 3: the loopback SFTP server a device's sshfs reaches through
 * the link's first forward. One SSH_FXP_INIT must get SSH_FXP_VERSION back.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const loadTs = require('./load-ts.cjs');

const { startSftpServer, findSftpServer } = loadTs('src/main/sftpServer.ts');

test('a connection speaks SFTP: INIT gets VERSION back', { skip: !findSftpServer() && 'no sftp-server on this machine' }, async () => {
  const s = await startSftpServer();
  try {
    const reply = await new Promise((resolve, reject) => {
      const c = net.connect(s.port, '127.0.0.1', () => {
        // uint32 length=5, byte SSH_FXP_INIT=1, uint32 version=3
        const init = Buffer.alloc(9);
        init.writeUInt32BE(5, 0);
        init.writeUInt8(1, 4);
        init.writeUInt32BE(3, 5);
        c.write(init);
      });
      let buf = Buffer.alloc(0);
      c.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        if (buf.length >= 9) { c.destroy(); resolve(buf); }
      });
      c.on('error', reject);
      setTimeout(() => reject(new Error('no reply from sftp-server')), 5000).unref();
    });
    assert.equal(reply.readUInt8(4), 2, 'SSH_FXP_VERSION');
    assert.equal(reply.readUInt32BE(5), 3);
  } finally {
    s.close();
  }
});

test('no sftp-server binary: a clear error, not a crash', async () => {
  await assert.rejects(startSftpServer(['/nope/sftp-server']), /^Error: No sftp-server on this laptop/);
});
