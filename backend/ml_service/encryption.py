# ml_service/encryption.py
import base64
from Crypto.Cipher import AES

# In production, store this key securely (e.g., ENV variable)
AES_MASTER_KEY = b"AEGIS_DEMO_MASTER_KEY_32BYTES_LONG!!"

def decrypt_text_aes_gcm(encrypted_payload: dict) -> str:
    """
    Decrypt AES-GCM payload received from frontend.
    encrypted_payload = { "iv": "base64", "cipher": "base64" }
    """
    if not isinstance(encrypted_payload, dict):
        raise ValueError("Invalid payload format")

    try:
        iv = base64.b64decode(encrypted_payload["iv"])
        cipher_data = base64.b64decode(encrypted_payload["cipher"])
    except Exception as e:
        raise ValueError(f"Invalid base64 fields: {e}")

    cipher = AES.new(AES_MASTER_KEY, AES.MODE_GCM, nonce=iv)
    try:
        decrypted = cipher.decrypt(cipher_data)
        return decrypted.decode("utf-8", errors="ignore")
    except Exception as e:
        raise ValueError(f"Decryption error: {e}")
