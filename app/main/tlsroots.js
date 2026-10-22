'use strict';

/* ===========================================================================
   AI-OS // roots the main process stops trusting
   ---------------------------------------------------------------------------
   In October 2026 the private keys of eight eMudhra intermediate certificates
   were reported compromised, and Mozilla took three of eMudhra's emSign roots
   out of its store. Node.js 24.22.1 ships that store. The Node inside this
   Electron is older and still trusts all three, so every TLS connection the
   main process makes itself -- IMAP, SMTP, the model providers -- would accept
   a certificate issued under them.

   Electron 43.8.1 already refuses chains through the eight compromised keys.
   This takes out the roots as well, which is what upstream did. Once Electron's
   Node carries the newer store, these fingerprints are no longer found and the
   call changes nothing; this file can then go.

   The built-in browser and web.request use Chromium's certificate verifier,
   not this store, so nothing here touches them.
   =========================================================================== */

const tls = require('node:tls');
const { X509Certificate } = require('node:crypto');

/* SHA-256 fingerprints, as X509Certificate.fingerprint256 prints them. These
   are exactly the roots that differ between Node 24.21.0 and 24.22.1. */
const DISTRUSTED = new Map([
  ['86:A1:EC:BA:08:9C:4A:8D:3B:BE:27:34:C6:12:BA:34:1D:81:3E:04:3C:F9:E8:A8:62:CD:5C:57:A3:6B:BE:6B',
    'emSign ECC Root CA - G3'],
  ['12:56:09:AA:30:1D:A0:A2:49:B9:7A:82:39:CB:6A:34:21:6F:44:DC:AC:9F:39:54:B1:42:92:F2:E8:C8:60:8F',
    'emSign Root CA - C1'],
  ['BC:4D:80:9B:15:18:9D:78:DB:3E:1D:8C:F4:F9:72:6A:79:5D:A1:64:3C:A5:F1:35:8E:1D:DB:0E:DC:0D:7E:B3',
    'emSign ECC Root CA - C3']
]);

/**
 * Drop the distrusted roots from the default CA set. Must run before the first
 * TLS connection: a secure context made earlier keeps the store it was made
 * with. Returns how many were removed.
 */
function dropDistrustedRoots() {
  const all = tls.getCACertificates('default');
  const keep = all.filter((pem) => !DISTRUSTED.has(new X509Certificate(pem).fingerprint256));
  if (keep.length !== all.length) tls.setDefaultCACertificates(keep);
  return all.length - keep.length;
}

module.exports = { dropDistrustedRoots, DISTRUSTED };
