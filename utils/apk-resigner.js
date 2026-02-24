/**
 * APK Re-signer — Pure Node.js with APK Signature Scheme v2
 * 
 * Re-signs an APK with a freshly generated RSA key + self-signed X.509
 * certificate using APK Signature Scheme v2 (required for targetSdk >= 30).
 * 
 * The v2 scheme signs the entire ZIP content at the binary level by inserting
 * an "APK Signing Block" between the last local file entry and the central
 * directory. This is completely different from v1 JAR signing.
 * 
 * No Android SDK, Java, or keytool needed — 100% pure Node.js.
 */
const forge = require('node-forge');
const AdmZip = require('adm-zip');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ─── Constants ──────────────────────────────────────────────────────────────
const V2_BLOCK_ID = 0x7109871a;
const SIG_RSA_PKCS1_V1_5_WITH_SHA256 = 0x0103;
const CHUNK_SIZE = 1048576; // 1 MB
const APK_SIG_BLOCK_MAGIC = 'APK Sig Block 42';
const EOCD_MAGIC = 0x06054b50;

// ─── Main Function ──────────────────────────────────────────────────────────

/**
 * Re-sign an APK with a brand new random certificate using v2 scheme.
 * @param {string} inputPath  - Path to the source APK
 * @param {string} outputPath - Where to write the re-signed APK
 * @returns {object} Info about the new signing identity
 */
function resignApk(inputPath, outputPath) {
  console.log('[APK-Resigner] Reading APK...');
  const zip = new AdmZip(inputPath);

  // ── 1. Strip existing v1 signatures from META-INF ──
  const entries = zip.getEntries();
  const sigFiles = entries.filter(e =>
    e.entryName.startsWith('META-INF/') && (
      e.entryName.endsWith('.SF') ||
      e.entryName.endsWith('.RSA') ||
      e.entryName.endsWith('.DSA') ||
      e.entryName.endsWith('.EC') ||
      e.entryName.endsWith('.MF')
    )
  );
  sigFiles.forEach(e => zip.deleteFile(e.entryName));
  console.log(`[APK-Resigner] Stripped ${sigFiles.length} old v1 signature files`);

  // ── 2. Inject unique marker (changes APK hash each rotation) ──
  const marker = `build.id=${crypto.randomUUID()}\nbuild.ts=${Date.now()}\n`;
  try { zip.deleteFile('assets/build.cfg'); } catch (_) {}
  zip.addFile('assets/build.cfg', Buffer.from(marker));

  // ── 3. Generate 2048-bit RSA key pair ──
  console.log('[APK-Resigner] Generating RSA key pair...');
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });

  // ── 4. Create self-signed X.509 certificate ──
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = crypto.randomBytes(16).toString('hex');
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + 30);

  const orgs = ['NetMirror Inc', 'NM Studios', 'Mirror Media LLC', 'StreamView Corp', 'NetView Technologies'];
  const cns  = ['NetMirror', 'NM App', 'StreamApp', 'MediaPlayer', 'VideoStream'];
  const locs = ['San Jose', 'Austin', 'Seattle', 'Denver', 'Portland'];
  const attrs = [
    { name: 'commonName', value: cns[Math.floor(Math.random() * cns.length)] },
    { name: 'organizationName', value: orgs[Math.floor(Math.random() * orgs.length)] },
    { name: 'localityName', value: locs[Math.floor(Math.random() * locs.length)] },
    { name: 'stateOrProvinceName', value: 'California' },
    { name: 'countryName', value: 'US' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  console.log('[APK-Resigner] Certificate created');

  // ── 5. Write unsigned ZIP (v2 signing block from original is auto-stripped) ──
  const tempPath = outputPath + '.unsigned';
  zip.writeZip(tempPath);
  console.log('[APK-Resigner] Unsigned APK written');

  // ── 6. Apply APK Signature Scheme v2 ──
  console.log('[APK-Resigner] Applying v2 signature...');
  const unsignedBuf = fs.readFileSync(tempPath);

  const eocdOffset = findEOCD(unsignedBuf);
  const cdOffset = unsignedBuf.readUInt32LE(eocdOffset + 16);

  // Three sections for v2 digest computation
  const section1 = unsignedBuf.slice(0, cdOffset);         // Local file entries
  const section2 = unsignedBuf.slice(cdOffset, eocdOffset); // Central directory
  const section3 = unsignedBuf.slice(eocdOffset);           // EOCD

  // Compute content digest (EOCD's cdOffset already = where signing block goes)
  const contentDigest = computeV2ContentDigest(section1, section2, section3);

  // Build signed-data
  const certDer = Buffer.from(
    forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary'
  );
  const signedData = buildV2SignedData(contentDigest, certDer);

  // Sign with RSA-PKCS1-v1.5-SHA256
  const privateKeyPem = forge.pki.privateKeyToPem(keys.privateKey);
  const sig = crypto.createSign('SHA256');
  sig.update(signedData);
  const signature = sig.sign(privateKeyPem);

  // Public key DER
  const pubKeyDer = Buffer.from(
    forge.asn1.toDer(forge.pki.publicKeyToAsn1(keys.publicKey)).getBytes(), 'binary'
  );

  // Build signer → signing block
  const signerBlock = buildV2Signer(signedData, signature, pubKeyDer);
  const apkSigningBlock = buildApkSigningBlock(signerBlock);

  // ── 7. Assemble final signed APK ──
  const newEocd = Buffer.from(section3);
  newEocd.writeUInt32LE(cdOffset + apkSigningBlock.length, 16);

  const finalApk = Buffer.concat([section1, apkSigningBlock, section2, newEocd]);
  fs.writeFileSync(outputPath, finalApk);

  // Clean up
  try { fs.unlinkSync(tempPath); } catch (_) {}

  const stats = fs.statSync(outputPath);
  console.log(`[APK-Resigner] v2-signed APK: ${outputPath} (${(stats.size / 1024 / 1024).toFixed(1)} MB)`);

  // ── 8. Cert fingerprint ──
  const certHash = crypto.createHash('sha256')
    .update(certDer)
    .digest('hex')
    .toUpperCase()
    .match(/.{2}/g)
    .join(':');

  return {
    certHash,
    serialNumber: cert.serialNumber,
    cn: (cert.subject.getField('CN') || cert.subject.getField('commonName') || {}).value || 'Unknown',
    org: (cert.subject.getField('O') || cert.subject.getField('organizationName') || {}).value || 'Unknown',
    apkSize: stats.size,
  };
}

// ─── ZIP Parsing ────────────────────────────────────────────────────────────

function findEOCD(buf) {
  const searchStart = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= searchStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_MAGIC) {
      return i;
    }
  }
  throw new Error('ZIP EOCD not found — invalid APK');
}

// ─── v2 Content Digest ──────────────────────────────────────────────────────

/**
 * Compute APK v2 content digest over three sections.
 * Each section → 1MB chunks → per-chunk SHA-256 → top-level SHA-256.
 */
function computeV2ContentDigest(section1, section2, section3) {
  const sections = [section1, section2, section3];
  const chunkDigests = [];

  for (const section of sections) {
    const numChunks = Math.ceil(section.length / CHUNK_SIZE);
    for (let i = 0; i < numChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, section.length);
      const chunk = section.slice(start, end);

      const prefix = Buffer.alloc(5);
      prefix[0] = 0xa5;
      prefix.writeUInt32LE(chunk.length, 1);

      chunkDigests.push(
        crypto.createHash('sha256').update(prefix).update(chunk).digest()
      );
    }
  }

  const topPrefix = Buffer.alloc(5);
  topPrefix[0] = 0x5a;
  topPrefix.writeUInt32LE(chunkDigests.length, 1);

  const topHash = crypto.createHash('sha256');
  topHash.update(topPrefix);
  for (const d of chunkDigests) topHash.update(d);

  return topHash.digest();
}

// ─── v2 Binary Structures ───────────────────────────────────────────────────

function uint32LE(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0, 0);
  return buf;
}

function uint64LE(value) {
  const buf = Buffer.alloc(8);
  buf.writeUInt32LE(value & 0xFFFFFFFF, 0);
  buf.writeUInt32LE(Math.floor(value / 0x100000000) & 0xFFFFFFFF, 4);
  return buf;
}

/**
 * signed-data = LP(digestsEncoded) + LP(certsEncoded) + LP(additionalAttrs)
 */
function buildV2SignedData(contentDigest, certDer) {
  const digestsEncoded = Buffer.concat([
    uint32LE(4 + 4 + contentDigest.length),
    uint32LE(SIG_RSA_PKCS1_V1_5_WITH_SHA256),
    uint32LE(contentDigest.length),
    contentDigest,
  ]);

  const certsEncoded = Buffer.concat([
    uint32LE(certDer.length),
    certDer,
  ]);

  return Buffer.concat([
    uint32LE(digestsEncoded.length), digestsEncoded,
    uint32LE(certsEncoded.length),   certsEncoded,
    uint32LE(0),
  ]);
}

/**
 * signer = LP(signedData) + LP(signaturesEncoded) + LP(publicKeyDer)
 */
function buildV2Signer(signedData, signature, pubKeyDer) {
  const sigsEncoded = Buffer.concat([
    uint32LE(4 + 4 + signature.length),
    uint32LE(SIG_RSA_PKCS1_V1_5_WITH_SHA256),
    uint32LE(signature.length),
    signature,
  ]);

  return Buffer.concat([
    uint32LE(signedData.length),  signedData,
    uint32LE(sigsEncoded.length), sigsEncoded,
    uint32LE(pubKeyDer.length),   pubKeyDer,
  ]);
}

/**
 * APK Signing Block:
 *   uint64(blockSize) + [ID-value pairs] + uint64(blockSize) + magic
 *
 * The v2 value needs TWO LP layers:
 *   v2Value = LP(signers_sequence) where signers_sequence = LP(signer1) + ...
 */
function buildApkSigningBlock(signerBlock) {
  // Inner LP: wrap the signer block
  const signerLP = Buffer.concat([
    uint32LE(signerBlock.length),
    signerBlock,
  ]);

  // Outer LP: wrap the signers sequence
  const v2Value = Buffer.concat([
    uint32LE(signerLP.length),
    signerLP,
  ]);

  const pairData = Buffer.concat([
    uint32LE(V2_BLOCK_ID),
    v2Value,
  ]);

  const pairEntry = Buffer.concat([
    uint64LE(pairData.length),
    pairData,
  ]);

  const blockSize = pairEntry.length + 8 + 16;
  const magic = Buffer.from(APK_SIG_BLOCK_MAGIC, 'ascii');

  return Buffer.concat([
    uint64LE(blockSize),
    pairEntry,
    uint64LE(blockSize),
    magic,
  ]);
}

module.exports = { resignApk };
