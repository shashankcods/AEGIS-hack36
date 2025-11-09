// public/encryption.js
// ------------------------------------------------------------
// AES-GCM-256 encryption helper for AEGIS Chrome extension
// ------------------------------------------------------------

import {
  AEGIS_ENCRYPTION_KEY_BASE64,
  base64ToArrayBuffer,
  arrayBufferToBase64,
} from "../src/config.js";

/**
 * Encrypt plaintext using AES-GCM-256.
 *
 * @param {string} plaintext - The text to encrypt
 * @returns {Promise<{iv: string, cipher: string}>} - Base64 IV and ciphertext
 */
export async function encryptTextAESGCM(plaintext) {
  if (!plaintext || !plaintext.trim()) {
    throw new Error("No plaintext provided to encrypt");
  }

  // 1️⃣ Decode the Base64 key into raw bytes
  const keyData = base64ToArrayBuffer(AEGIS_ENCRYPTION_KEY_BASE64);

  // 2️⃣ Import the key into WebCrypto
  const cryptoKey = await crypto.subtle.importKey(
    "raw",              // key format
    keyData,            // raw key bytes
    { name: "AES-GCM" }, // algorithm
    false,              // not extractable
    ["encrypt"]         // allowed usages
  );

  // 3️⃣ Encode the plaintext as UTF-8
  const encoder = new TextEncoder();
  const data = encoder.encode(plaintext);

  // 4️⃣ Generate a random 12-byte IV (nonce)
  const iv = crypto.getRandomValues(new Uint8Array(12));

  // 5️⃣ Perform encryption
  const cipherBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    data
  );

  // 6️⃣ Return Base64-encoded IV and ciphertext
  return {
    iv: arrayBufferToBase64(iv),
    cipher: arrayBufferToBase64(cipherBuffer),
  };
}
