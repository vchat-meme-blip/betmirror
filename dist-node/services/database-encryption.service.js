import crypto from 'crypto';
/**
 * Database-level encryption service for sensitive fields
 * Provides field-level encryption for data at rest
 */
export class DatabaseEncryptionService {
    static ENCRYPTION_ALGORITHM = 'aes-256-gcm';
    static KEY_DERIVATION_ITERATIONS = 100000;
    static ENCRYPTION_KEY = process.env.DB_ENCRYPTION_KEY || 'default-key-change-in-production';
    /**
     * Encrypts sensitive data for database storage
     * Format: iv:authTag:encryptedData
     */
    static encrypt(plaintext) {
        try {
            // Generate random IV
            const iv = crypto.randomBytes(16);
            // Derive key using PBKDF2
            const key = crypto.pbkdf2Sync(this.ENCRYPTION_KEY, 'database-salt', this.KEY_DERIVATION_ITERATIONS, 32, 'sha256');
            // Create cipher
            const cipher = crypto.createCipheriv(this.ENCRYPTION_ALGORITHM, key, iv);
            // Encrypt data
            let encrypted = cipher.update(plaintext, 'utf8', 'hex');
            encrypted += cipher.final('hex');
            // Get auth tag
            const authTag = cipher.getAuthTag();
            // Return combined format: iv:authTag:encryptedData
            return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
        }
        catch (error) {
            console.error('Encryption failed:', error);
            throw new Error('Failed to encrypt sensitive data');
        }
    }
    /**
     * Decrypts sensitive data from database storage
     */
    static decrypt(encryptedData) {
        try {
            // Parse combined format
            const parts = encryptedData.split(':');
            if (parts.length !== 3) {
                throw new Error('Invalid encrypted data format');
            }
            const iv = Buffer.from(parts[0], 'hex');
            const authTag = Buffer.from(parts[1], 'hex');
            const encrypted = parts[2];
            // Derive key using same parameters
            const key = crypto.pbkdf2Sync(this.ENCRYPTION_KEY, 'database-salt', this.KEY_DERIVATION_ITERATIONS, 32, 'sha256');
            // Create decipher
            const decipher = crypto.createDecipheriv(this.ENCRYPTION_ALGORITHM, key, iv);
            decipher.setAuthTag(authTag);
            // Decrypt data
            let decrypted = decipher.update(encrypted, 'hex', 'utf8');
            decrypted += decipher.final('utf8');
            return decrypted;
        }
        catch (error) {
            console.error('Decryption failed:', error);
            throw new Error('Failed to decrypt sensitive data');
        }
    }
    /**
     * Mongoose schema middleware for automatic encryption/decryption
     */
    static createEncryptionMiddleware(schema, fieldName) {
        // Encrypt before saving
        schema.pre('save', function (next) {
            if (this.isModified(fieldName) && this[fieldName]) {
                try {
                    // Only encrypt if not already encrypted (check format)
                    if (!this[fieldName].includes(':') || this[fieldName].split(':').length !== 3) {
                        this[fieldName] = DatabaseEncryptionService.encrypt(this[fieldName]);
                    }
                }
                catch (error) {
                    console.error(`Failed to encrypt field ${fieldName}:`, error);
                    return next(error);
                }
            }
            next();
        });
        // Decrypt after finding
        schema.post(['find', 'findOne'], function (result) {
            if (result) {
                const decryptField = (doc) => {
                    if (doc && doc[fieldName]) {
                        try {
                            // Only decrypt if in encrypted format
                            if (doc[fieldName].includes(':') && doc[fieldName].split(':').length === 3) {
                                doc[fieldName] = DatabaseEncryptionService.decrypt(doc[fieldName]);
                            }
                        }
                        catch (error) {
                            console.error(`Failed to decrypt field ${fieldName}:`, error);
                            // Keep original value if decryption fails
                        }
                    }
                };
                if (Array.isArray(result)) {
                    result.forEach(decryptField);
                }
                else {
                    decryptField(result);
                }
            }
            return result;
        });
    }
    /**
     * Validate encryption key strength
     */
    static validateEncryptionKey() {
        const key = this.ENCRYPTION_KEY;
        return key.length >= 32 && key !== 'default-key-change-in-production';
    }
    /**
     * Generate secure encryption key
     */
    static generateEncryptionKey() {
        return crypto.randomBytes(32).toString('hex');
    }
}
