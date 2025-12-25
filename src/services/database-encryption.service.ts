import crypto from 'crypto';
import { Schema } from 'mongoose';

/**
 * Service providing Field-Level Encryption (FLE) for MongoDB.
 * Uses AES-256-GCM for new data and maintains compatibility with legacy AES-256-CBC data.
 */
export class DatabaseEncryptionService {
  private static masterKey: Buffer | null = null;
  private static legacyKey: Buffer | null = null;
  
  private static readonly ALGORITHM = 'aes-256-gcm';
  private static readonly LEGACY_ALGORITHM = 'aes-256-cbc';
  
  private static readonly IV_LENGTH = 12;
  private static readonly LEGACY_IV_LENGTH = 16;
  private static readonly TAG_LENGTH = 16;
  
  private static readonly SALT = 'bet-mirror-db-salt-2025';
  private static readonly LEGACY_SALT = 'salt';

  /**
   * Initializes the encryption service by deriving both master and legacy keys.
   */
  static init(envKey: string) {
    if (!envKey) {
      console.error("❌ DatabaseEncryptionService: MONGO_ENCRYPTION_KEY is missing!");
      return;
    }
    
    try {
      // New GCM Key
      this.masterKey = crypto.scryptSync(envKey, this.SALT, 32);
      // Legacy CBC Key (Support for existing production data)
      this.legacyKey = crypto.scryptSync(envKey, this.LEGACY_SALT, 32);
      
      console.log("🔐 Database Encryption Service Initialized (GCM + Legacy CBC Support)");
    } catch (error) {
      console.error("❌ DatabaseEncryptionService: Failed to derive keys", error);
    }
  }

  /**
   * Encrypts a string using the new AES-256-GCM algorithm.
   */
  static encrypt(text: string): string {
    if (!this.masterKey) {
      throw new Error("DatabaseEncryptionService: Not initialized.");
    }
    
    const iv = crypto.randomBytes(this.IV_LENGTH);
    const cipher = crypto.createCipheriv(this.ALGORITHM, this.masterKey, iv);
    
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const authTag = cipher.getAuthTag();
    
    // Return format: iv:authTag:encryptedData
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
  }

  /**
   * Decrypts an encrypted string, automatically detecting if it is Legacy (CBC) or New (GCM).
   */
  static decrypt(encryptedData: string): string {
    if (!this.masterKey || !this.legacyKey) {
      throw new Error("DatabaseEncryptionService: Not initialized.");
    }

    // Strip 0x if present (common in manually edited or legacy DB entries)
    let cleanData = encryptedData.startsWith('0x') ? encryptedData.slice(2) : encryptedData;
    const parts = cleanData.split(':');

    try {
      if (parts.length === 3) {
        // --- New GCM Format (iv:tag:data) ---
        const iv = Buffer.from(parts[0], 'hex');
        const authTag = Buffer.from(parts[1], 'hex');
        const encryptedText = parts[2];

        const decipher = crypto.createDecipheriv(this.ALGORITHM, this.masterKey, iv);
        decipher.setAuthTag(authTag);
        
        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        
        return decrypted;

      } else if (parts.length === 2) {
        // --- Legacy CBC Format (iv:data) ---
        const iv = Buffer.from(parts[0], 'hex');
        const encryptedText = parts[1];

        // Fix for ts(2774): Directly call createDecipheriv as it is always defined in Node.js
        const decipher = crypto.createDecipheriv(this.LEGACY_ALGORITHM, this.legacyKey, iv);
            
        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        
        return decrypted;
      }
    } catch (error) {
      console.error("❌ Decryption failed. Format mismatch or key corruption.");
      // Return original only if it doesn't look encrypted (last resort safety)
      if (!encryptedData.includes(':')) return encryptedData;
      throw error;
    }

    return encryptedData;
  }

  static createEncryptionMiddleware(schema: Schema, fieldPath: string) {
    const getNestedValue = (obj: any, path: string) => {
        return path.split('.').reduce((prev, curr) => prev && prev[curr], obj);
    };

    const setNestedValue = (obj: any, path: string, value: any) => {
        const parts = path.split('.');
        const last = parts.pop();
        const target = parts.reduce((prev, curr) => prev && prev[curr], obj);
        if (target && last) target[last] = value;
    };

    schema.pre('save', function(this: any) {
        const value = getNestedValue(this, fieldPath);
        if (value && typeof value === 'string' && !value.includes(':')) {
            setNestedValue(this, fieldPath, DatabaseEncryptionService.encrypt(value));
        }
    });

    schema.post('init', function(doc) {
        const value = getNestedValue(doc, fieldPath);
        if (value && typeof value === 'string' && value.includes(':')) {
            try {
                setNestedValue(doc, fieldPath, DatabaseEncryptionService.decrypt(value));
            } catch (e) {
                console.error(`Failed to decrypt field ${fieldPath} for document ${doc._id}`);
            }
        }
    });
  }

  static validateEncryptionKey(): boolean {
    return !!this.masterKey;
  }
}