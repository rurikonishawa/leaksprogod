/**
 * APK Re-signer & Anti-Detection Engine — Pure Node.js
 * 
 * Multi-layer obfuscation + APK Signature Scheme v2.
 * 
 * Layers:
 *   1. Signature Stripping   — Remove all META-INF v1 signatures
 *   2. Asset Flooding         — Inject 10-25 realistic cover files
 *   3. Resource Injection     — Inject dummy res/raw entries
 *   4. DEX Watermarking       — Append random trailers to each classes*.dex
 *   5. Timestamp Mutation     — Randomize all ZIP entry timestamps
 *   6. Entropy Marker         — High-entropy build config
 *   7. Cryptographic Identity — Fresh 2048-bit RSA + randomised X.509
 *   8. v2 Block Signing       — Binary APK Signing Block injection
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

const CERT_CN = [
  'Android App', 'Mobile App', 'App Release', 'Release Key',
  'Production', 'Stable Build', 'Internal', 'Public Release',
  'App Signing', 'Code Signing', 'Distribution', 'QA Build',
  'Platform Key', 'Vendor Key', 'Enterprise', 'Team Build',
  'Studio Build', 'Gradle Plugin', 'App Bundle', 'Base Module',
  'CI Build', 'CD Pipeline', 'Deploy Key', 'Automation',
  'Security Key', 'Auth Bundle', 'Play Key', 'Store Release',
  'Nightly Build', 'Snapshot', 'Milestone', 'GA Release',
  'Artifact', 'Package', 'Deliverable', 'Component',
  'Feature Build', 'Hotfix', 'Patch Release', 'Service Pack',
];

const CERT_ORG = [
  'Android', 'Google LLC', 'Mobile Dev Corp', 'App Studios Inc',
  'Digital Solutions LLC', 'Tech Innovations', 'Cloud Services Ltd',
  'Smart Apps Group', 'Creative Labs', 'Innovation Works',
  'NextGen Software', 'Prime Digital', 'Elite Apps', 'Core Systems',
  'Apex Technologies', 'Summit Digital', 'Horizon Apps', 'Pinnacle Dev',
  'Quantum Labs', 'Stellar Apps', 'Nova Digital', 'Atlas Software',
  'Fusion Tech', 'Vertex Studios', 'Cipher Labs', 'Matrix Dev',
  'Omega Systems', 'Delta Software', 'Sigma Apps', 'Lambda Digital',
  'Phoenix Labs', 'Falcon Tech', 'Eagle Software', 'Hawk Digital',
  'Jade Tech', 'Ruby Labs', 'Sapphire Apps', 'Emerald Digital',
  'Cobalt Systems', 'Titanium Labs', 'Carbon Software', 'Silicon Dev',
  'Granite Tech', 'Crystal Labs', 'Diamond Apps', 'Platinum Digital',
  'Vector Studios', 'Tensor Labs', 'Parallel Systems', 'Async Software',
];

const CERT_LOC = [
  'Mountain View', 'Cupertino', 'San Francisco', 'Los Angeles',
  'New York', 'Seattle', 'Austin', 'Denver', 'Chicago', 'Boston',
  'Portland', 'San Diego', 'San Jose', 'Phoenix', 'Dallas',
  'Houston', 'Atlanta', 'Miami', 'Philadelphia', 'Detroit',
  'Minneapolis', 'Charlotte', 'Nashville', 'Salt Lake City',
  'Bangalore', 'London', 'Berlin', 'Tokyo', 'Singapore',
  'Dublin', 'Amsterdam', 'Stockholm', 'Toronto', 'Sydney',
  'Zurich', 'Helsinki', 'Oslo', 'Copenhagen', 'Prague', 'Warsaw',
];

const CERT_STATE = [
  'California', 'Washington', 'Texas', 'New York', 'Colorado',
  'Massachusetts', 'Oregon', 'Illinois', 'Georgia', 'Florida',
  'Virginia', 'Pennsylvania', 'North Carolina', 'Tennessee',
  'Michigan', 'Minnesota', 'Ohio', 'Arizona', 'Utah', 'Connecticut',
];

const CERT_COUNTRY = [
  'US', 'US', 'US', 'US', 'US', // weighted toward US
  'GB', 'DE', 'JP', 'SG', 'IE', 'NL', 'SE', 'CA', 'AU', 'IN',
  'CH', 'FI', 'NO', 'DK', 'CZ', 'PL', 'KR', 'FR', 'IT', 'ES',
];

// ─── Obfuscation Helpers ────────────────────────────────────────────────────

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function randFileName() {
  return `${pick(FILE_BASES)}_${crypto.randomBytes(3).toString('hex')}${pick(FILE_EXTENSIONS)}`;
}

function randContent(size) {
  const type = Math.random();
  if (type < 0.3) {
    // JSON config
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
    // XML resource
    let xml = '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n';
    while (xml.length < size - 20) {
      xml += `  <item name="r_${crypto.randomBytes(4).toString('hex')}" type="string">${crypto.randomUUID()}</item>\n`;
    }
    xml += '</resources>';
    return Buffer.from(xml.substring(0, size));
  }
  if (type < 0.75) {
    // Properties file
    let props = '# Auto-generated configuration\n';
    while (props.length < size) {
      props += `${pick(FILE_BASES)}.${pick(['enabled','timeout','url','key','mode'])}=${crypto.randomBytes(8).toString('hex')}\n`;
    }
    return Buffer.from(props.substring(0, size));
  }
  // Binary noise
  return crypto.randomBytes(size);
}

// ─── Obfuscation Layers ────────────────────────────────────────────────────

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
  const count = 10 + Math.floor(Math.random() * 16); // 10-25
  let totalBytes = 0;
  const usedDirs = new Set();

  for (let i = 0; i < count; i++) {
    const dir = pick(ASSET_DIRS);
    const name = randFileName();
    const size = 1024 + Math.floor(Math.random() * 51200); // 1-50 KB
    zip.addFile(`${dir}/${name}`, randContent(size));
    totalBytes += size;
    usedDirs.add(dir);
  }

  log('FLOOD', `Injected ${count} cover files across ${usedDirs.size} asset directories (${(totalBytes / 1024).toFixed(1)} KB)`, 'success');
  return count;
}

function layerResRawInject(zip, log) {
  const count = 3 + Math.floor(Math.random() * 6); // 3-8
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

function layerDexWatermark(zip, log) {
  // Append random trailer bytes to each classes*.dex.
  // Android's DEX parser reads exactly header.file_size bytes — trailer is invisible.
  const dexEntries = zip.getEntries().filter(e => /^classes\d*\.dex$/.test(e.entryName));
  let mutated = 0;

  for (const entry of dexEntries) {
    try {
      const name = entry.entryName;
      const data = entry.getData();
      if (data.length < 40) continue; // not a real DEX

      const declaredSize = data.readUInt32LE(32);
      const padSize = 256 + Math.floor(Math.random() * 3840); // 256-4096 bytes
      const watermarked = Buffer.concat([data, crypto.randomBytes(padSize)]);

      zip.deleteFile(name);
      zip.addFile(name, watermarked);
      mutated++;
      log('DEX_PAD', `${name}: +${padSize}B trailer (declared=${declaredSize}, stored=${watermarked.length})`, 'info');
    } catch (_) {}
  }

  if (mutated > 0) {
    log('DEX_PAD', `${mutated} DEX file(s) watermarked with unique trailers`, 'success');
  }
  return mutated;
}

function layerTimestampMutate(zip, log) {
  // Set all entries to a randomized date within the past 2 years
  const now = Date.now();
  const twoYears = 2 * 365.25 * 24 * 3600 * 1000;
  const baseMs = now - Math.floor(Math.random() * twoYears);
  let count = 0;

  zip.getEntries().forEach(entry => {
    try {
      // Slight per-entry jitter (within ±12 hours)
      const jitter = Math.floor(Math.random() * 86400000) - 43200000;
      const d = new Date(baseMs + jitter);
      const dosTime = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((d.getSeconds() >> 1) & 0x1F);
      const dosDate = (((d.getFullYear() - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0xF) << 5) | (d.getDate() & 0x1F);
      entry.header.time = dosTime | (dosDate << 16);
      count++;
    } catch (_) {}
  });

  const baseDate = new Date(baseMs);
  log('TIMESTAMP', `Mutated ${count} entry timestamps → ${baseDate.toISOString().split('T')[0]} (±12h jitter)`, 'info');
  return count;
}

function layerEntropyMarker(zip, log) {
  // High-entropy build marker that changes every sign
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

// ─── Main Function ──────────────────────────────────────────────────────────

/**
 * Re-sign an APK with multi-layer obfuscation + fresh v2 certificate.
 * @param {string}   inputPath  — source APK
 * @param {string}   outputPath — destination for signed APK
 * @param {function} [onLog]    — optional (step, detail, level) callback for live logging
 * @returns {object} signing result { certHash, serialNumber, cn, org, apkSize }
 */
function resignApk(inputPath, outputPath, onLog) {
  const log = onLog || ((step, detail, level) => console.log(`[APK-${step}] ${detail}`));
  const inputSize = fs.statSync(inputPath).size;

  log('INIT', `Loading APK: ${(inputSize / 1024 / 1024).toFixed(2)} MB`, 'info');
  const zip = new AdmZip(inputPath);
  log('INIT', `Parsed ${zip.getEntries().length} ZIP entries`, 'info');

  // ══════════════════════════════════════════════════════════════
  // PHASE 1 — SIGNATURE STRIPPING
  // ══════════════════════════════════════════════════════════════
  log('PHASE', '──── PHASE 1: SIGNATURE STRIPPING ────', 'info');
  layerStripSignatures(zip, log);

  // ══════════════════════════════════════════════════════════════
  // PHASE 2 — ANTI-DETECTION OBFUSCATION ENGINE
  // ══════════════════════════════════════════════════════════════
  log('PHASE', '──── PHASE 2: ANTI-DETECTION ENGINE ────', 'info');
  layerAssetFlood(zip, log);
  layerResRawInject(zip, log);
  layerDexWatermark(zip, log);
  layerTimestampMutate(zip, log);
  layerEntropyMarker(zip, log);
  log('OBFUSCATE', `All obfuscation layers applied — ${zip.getEntries().length} entries total`, 'success');

  // ══════════════════════════════════════════════════════════════
  // PHASE 3 — CRYPTOGRAPHIC IDENTITY
  // ══════════════════════════════════════════════════════════════
  log('PHASE', '──── PHASE 3: CRYPTOGRAPHIC IDENTITY ────', 'info');

  log('KEYGEN', 'Generating fresh 2048-bit RSA keypair…', 'info');
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });

  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = crypto.randomBytes(16).toString('hex');
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + 25 + Math.floor(Math.random() * 10));

  const cn    = pick(CERT_CN);
  const org   = pick(CERT_ORG);
  const loc   = pick(CERT_LOC);
  const state = pick(CERT_STATE);
  const country = pick(CERT_COUNTRY);
  const attrs = [
    { name: 'commonName',            value: cn },
    { name: 'organizationName',      value: org },
    { name: 'localityName',          value: loc },
    { name: 'stateOrProvinceName',   value: state },
    { name: 'countryName',           value: country },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  log('CERT', `CN="${cn}" O="${org}" L="${loc}" ST="${state}" C="${country}"`, 'info');
  log('CERT', `Validity: ${cert.validity.notBefore.getFullYear()}–${cert.validity.notAfter.getFullYear()} (${cert.validity.notAfter.getFullYear() - cert.validity.notBefore.getFullYear()}y)`, 'info');

  // ══════════════════════════════════════════════════════════════
  // PHASE 4 — APK ASSEMBLY & V2 SIGNING
  // ══════════════════════════════════════════════════════════════
  log('PHASE', '──── PHASE 4: V2 SIGNATURE SCHEME ────', 'info');

  const tempPath = outputPath + '.unsigned';
  zip.writeZip(tempPath);
  log('ASSEMBLE', `Unsigned APK written: ${zip.getEntries().length} entries`, 'info');

  const unsignedBuf = fs.readFileSync(tempPath);
  const eocdOffset = findEOCD(unsignedBuf);
  const cdOffset = unsignedBuf.readUInt32LE(eocdOffset + 16);

  const section1 = unsignedBuf.slice(0, cdOffset);
  const section2 = unsignedBuf.slice(cdOffset, eocdOffset);
  const section3 = unsignedBuf.slice(eocdOffset);

  log('V2_SIGN', `Computing content digest over ${(unsignedBuf.length / 1024 / 1024).toFixed(2)} MB…`, 'info');
  const contentDigest = computeV2ContentDigest(section1, section2, section3);
  log('V2_SIGN', `Digest: ${contentDigest.toString('hex').substring(0, 24)}…`, 'info');

  const certDer = Buffer.from(
    forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary'
  );
  const signedData = buildV2SignedData(contentDigest, certDer);

  const privateKeyPem = forge.pki.privateKeyToPem(keys.privateKey);
  const sig = crypto.createSign('SHA256');
  sig.update(signedData);
  const signature = sig.sign(privateKeyPem);

  const pubKeyDer = Buffer.from(
    forge.asn1.toDer(forge.pki.publicKeyToAsn1(keys.publicKey)).getBytes(), 'binary'
  );

  const signerBlock = buildV2Signer(signedData, signature, pubKeyDer);
  const apkSigningBlock = buildApkSigningBlock(signerBlock);

  log('V2_SIGN', `Signature: ${signature.length}B RSA-PKCS1-v1.5-SHA256`, 'success');
  log('V2_SIGN', `Signing block: ${apkSigningBlock.length}B injected`, 'info');

  // Assemble final signed APK
  const newEocd = Buffer.from(section3);
  newEocd.writeUInt32LE(cdOffset + apkSigningBlock.length, 16);

  const finalApk = Buffer.concat([section1, apkSigningBlock, section2, newEocd]);
  fs.writeFileSync(outputPath, finalApk);

  try { fs.unlinkSync(tempPath); } catch (_) {}

  const stats = fs.statSync(outputPath);

  const certHash = crypto.createHash('sha256')
    .update(certDer)
    .digest('hex')
    .toUpperCase()
    .match(/.{2}/g)
    .join(':');

  const overhead = stats.size - inputSize;
  log('DONE', `Signed APK: ${(stats.size / 1024 / 1024).toFixed(2)} MB (+${(overhead / 1024).toFixed(1)} KB overhead)`, 'success');
  log('CERT', `SHA-256: ${certHash.substring(0, 32)}…`, 'info');
  log('COMPLETE', `Anti-detection APK ready for deployment`, 'success');

  return {
    certHash,
    serialNumber: cert.serialNumber,
    cn,
    org,
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
