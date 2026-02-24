/**
 * APK Re-signer — Pure Node.js
 * 
 * Re-signs an APK with a freshly generated RSA key + self-signed X.509
 * certificate. This gives the APK a new signing identity without needing
 * the Android SDK or Java keytool.
 * 
 * Uses JAR signing (APK Signature Scheme v1) which is supported on all
 * Android versions. The v2/v3 signing block (if present) is stripped
 * automatically when the ZIP is rebuilt.
 */
const forge = require('node-forge');
const AdmZip = require('adm-zip');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * Re-sign an APK with a brand new random certificate.
 * @param {string} inputPath  - Path to the source APK
 * @param {string} outputPath - Where to write the re-signed APK
 * @returns {object} Info about the new signing identity
 */
function resignApk(inputPath, outputPath) {
  console.log('[APK-Resigner] Reading APK...');
  const zip = new AdmZip(inputPath);

  // ── 1. Strip existing signatures ──
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
  console.log(`[APK-Resigner] Stripped ${sigFiles.length} old signature files`);

  // ── 2. Inject unique marker (changes APK hash each rotation) ──
  const marker = `build.id=${crypto.randomUUID()}\nbuild.ts=${Date.now()}\n`;
  // Remove old marker if present
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

  // Randomize distinguished name for each rotation
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

  // ── 5. Build MANIFEST.MF ──
  const allEntries = zip.getEntries().filter(e => !e.isDirectory);
  let manifest = 'Manifest-Version: 1.0\r\nCreated-By: 1.0 (Android)\r\n\r\n';
  for (const entry of allEntries) {
    const data = entry.getData();
    const hash = crypto.createHash('sha256').update(data).digest('base64');
    manifest += `Name: ${entry.entryName}\r\nSHA-256-Digest: ${hash}\r\n\r\n`;
  }

  // ── 6. Build CERT.SF ──
  const manifestHash = crypto.createHash('sha256')
    .update(Buffer.from(manifest, 'binary'))
    .digest('base64');

  let sf = `Signature-Version: 1.0\r\nCreated-By: 1.0 (Android)\r\nSHA-256-Digest-Manifest: ${manifestHash}\r\n\r\n`;

  // Per-entry section digests
  const sections = manifest.split('\r\n\r\n');
  // sections[0] = main attributes, sections[1..n-1] = entry sections, sections[n] = ''
  for (let i = 1; i < sections.length; i++) {
    const section = sections[i];
    if (!section.trim()) continue;
    const sectionBytes = section + '\r\n\r\n';
    const nameMatch = section.match(/^Name: (.+)/);
    if (nameMatch) {
      const sectionHash = crypto.createHash('sha256')
        .update(Buffer.from(sectionBytes, 'binary'))
        .digest('base64');
      sf += `Name: ${nameMatch[1]}\r\nSHA-256-Digest: ${sectionHash}\r\n\r\n`;
    }
  }

  // ── 7. Create PKCS#7 detached signature of CERT.SF ──
  console.log('[APK-Resigner] Creating PKCS#7 signature...');
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(sf, 'binary');
  p7.addCertificate(cert);
  p7.addSigner({
    key: keys.privateKey,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
    ],
  });
  p7.sign({ detached: true });
  const rsaDer = forge.asn1.toDer(p7.toAsn1()).getBytes();
  const rsaBuffer = Buffer.from(rsaDer, 'binary');

  // ── 8. Add new signature files to APK ──
  zip.addFile('META-INF/MANIFEST.MF', Buffer.from(manifest, 'binary'));
  zip.addFile('META-INF/CERT.SF', Buffer.from(sf, 'binary'));
  zip.addFile('META-INF/CERT.RSA', rsaBuffer);

  // ── 9. Write re-signed APK ──
  zip.writeZip(outputPath);
  const stats = fs.statSync(outputPath);
  console.log(`[APK-Resigner] Re-signed APK written: ${outputPath} (${(stats.size / 1024 / 1024).toFixed(1)} MB)`);

  // ── 10. Compute cert fingerprint ──
  const certDer = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  const certHash = crypto.createHash('sha256')
    .update(Buffer.from(certDer, 'binary'))
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

module.exports = { resignApk };
