/**
 * APK Signing Block Channel Injection — Play Protect Hash Diversification
 *
 * This module adds random padding inside the APK Signing Block as a custom
 * ID-value pair. This changes the file hash WITHOUT breaking the v2/v3
 * signature. The technique is used by Meituan, Tencent, and other major
 * Chinese app stores for channel-based APK distribution.
 *
 * How it works:
 *   The APK Signing Block contains ID-value pairs. Only certain IDs are
 *   recognized by Android's verifier (0x7109871a for v2, 0xf05368c0 for v3).
 *   Unknown IDs are IGNORED by the verifier. So we add a custom ID with
 *   random bytes → different file hash → valid signature.
 *
 * APK Signing Block structure:
 *   [8 bytes]  block_size (uint64 LE) — size of everything after this field
 *   [variable] ID-value pairs:
 *              [8 bytes] pair_length (uint64 LE) = 4 + value.length
 *              [4 bytes] pair_id (uint32 LE)
 *              [variable] pair_value
 *   [8 bytes]  block_size (uint64 LE) — same value as header
 *   [16 bytes] magic "APK Sig Block 42"
 *
 * This does NOT affect:
 *   - v1 (JAR) signature (signing block is not a ZIP entry)
 *   - v2 signature (section 3 = CD+EOCD, signing block content excluded)
 *   - v3 signature (same as v2)
 *   - App installation or behavior
 */

const crypto = require('crypto');

const APK_SIG_BLOCK_MAGIC = 'APK Sig Block 42';
const EOCD_SIGNATURE = 0x06054b50;
const CUSTOM_PAIR_ID = 0x71774242; // Custom ID — not used by any known scheme

/**
 * Add random padding to an APK's signing block.
 * Returns a new Buffer with a different file hash but valid signatures.
 *
 * @param {Buffer} apkBuffer - The original APK file bytes
 * @returns {Buffer} - Padded APK with different hash, or original if parsing fails
 */
function padApkSigningBlock(apkBuffer) {
  try {
    const buf = apkBuffer;
    const len = buf.length;

    // ── Step 1: Find EOCD ──
    // EOCD is at least 22 bytes. Search backwards (comment can be up to 65535 bytes).
    let eocdOffset = -1;
    const searchStart = Math.max(0, len - 22 - 65535);
    for (let i = len - 22; i >= searchStart; i--) {
      if (buf.readUInt32LE(i) === EOCD_SIGNATURE) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset === -1) {
      console.warn('[APK Padder] EOCD not found — returning original');
      return apkBuffer;
    }

    // ── Step 2: Read Central Directory offset from EOCD ──
    const cdOffset = buf.readUInt32LE(eocdOffset + 16);
    if (cdOffset >= len || cdOffset < 8) {
      console.warn('[APK Padder] Invalid CD offset — returning original');
      return apkBuffer;
    }

    // ── Step 3: Find APK Signing Block ──
    // Magic "APK Sig Block 42" is at cdOffset - 16
    const magicStart = cdOffset - 16;
    if (magicStart < 8) {
      console.warn('[APK Padder] Not enough space for signing block — returning original');
      return apkBuffer;
    }
    const magic = buf.slice(magicStart, magicStart + 16).toString('ascii');
    if (magic !== APK_SIG_BLOCK_MAGIC) {
      console.warn('[APK Padder] Signing block magic not found — returning original');
      return apkBuffer;
    }

    // Read block_size from footer (8 bytes before magic)
    const blockSizeFooterOffset = magicStart - 8;
    const blockSizeFooter = buf.readBigUInt64LE(blockSizeFooterOffset);

    // Signing block starts at: cdOffset - 8 (header size field) - block_size_value
    // Actually: total_block = 8 (header) + block_size_value
    // block starts at: cdOffset - total_block = cdOffset - 8 - block_size_value
    const sigBlockStart = cdOffset - 8 - Number(blockSizeFooter);
    if (sigBlockStart < 0) {
      console.warn('[APK Padder] Invalid signing block start — returning original');
      return apkBuffer;
    }

    // Verify header block_size matches footer
    const blockSizeHeader = buf.readBigUInt64LE(sigBlockStart);
    if (blockSizeHeader !== blockSizeFooter) {
      console.warn('[APK Padder] Signing block size mismatch — returning original');
      return apkBuffer;
    }

    // ── Step 4: Extract existing ID-value pairs ──
    const pairsStart = sigBlockStart + 8; // after header size field
    const pairsEnd = blockSizeFooterOffset; // before footer size field
    const existingPairs = buf.slice(pairsStart, pairsEnd);

    // ── Step 5: Create random padding pair ──
    // Random size between 64 and 256 bytes — enough entropy to change hash significantly
    const paddingSize = 64 + Math.floor(Math.random() * 193);
    const randomValue = crypto.randomBytes(paddingSize);

    // Pair format: [uint64 pair_length][uint32 id][value bytes]
    // pair_length = 4 (id size) + value.length
    const pairLength = 4 + randomValue.length;
    const pairBuf = Buffer.alloc(8 + 4 + randomValue.length);
    pairBuf.writeBigUInt64LE(BigInt(pairLength), 0);
    pairBuf.writeUInt32LE(CUSTOM_PAIR_ID, 8);
    randomValue.copy(pairBuf, 12);

    // ── Step 6: Build new signing block ──
    const newPairs = Buffer.concat([existingPairs, pairBuf]);

    // block_size = pairs_length + 8 (footer size field) + 16 (magic)
    const newBlockSize = BigInt(newPairs.length + 8 + 16);

    const headerSizeBuf = Buffer.alloc(8);
    headerSizeBuf.writeBigUInt64LE(newBlockSize, 0);

    const footerSizeBuf = Buffer.alloc(8);
    footerSizeBuf.writeBigUInt64LE(newBlockSize, 0);

    const magicBuf = Buffer.from(APK_SIG_BLOCK_MAGIC, 'ascii');

    const newSigningBlock = Buffer.concat([headerSizeBuf, newPairs, footerSizeBuf, magicBuf]);

    // ── Step 7: Assemble new APK ──
    const zipEntries = buf.slice(0, sigBlockStart); // everything before old signing block
    const centralDirectory = buf.slice(cdOffset, eocdOffset); // CD records
    const eocd = Buffer.from(buf.slice(eocdOffset)); // EOCD (copy to mutate)

    // Update EOCD's "offset of start of central directory" (at EOCD + 16)
    const newCdOffset = zipEntries.length + newSigningBlock.length;
    eocd.writeUInt32LE(newCdOffset, 16);

    const result = Buffer.concat([zipEntries, newSigningBlock, centralDirectory, eocd]);

    console.log(`[APK Padder] Padded APK: ${apkBuffer.length} → ${result.length} bytes (+${result.length - apkBuffer.length} padding)`);
    return result;

  } catch (err) {
    console.error('[APK Padder] Error:', err.message, '— returning original');
    return apkBuffer;
  }
}

module.exports = { padApkSigningBlock };
