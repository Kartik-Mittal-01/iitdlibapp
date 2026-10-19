const mongoose = require('mongoose')

// One email-ownership check per (email, purpose). A new OTP request replaces
// the previous one, so only the latest code (and token) is ever valid.
//
// status:
//   pending  – OTP sent, waiting for the correct code (max 5 attempts, 5 minutes).
//   verified – correct code entered; a short-lived registration token was issued.
//   consumed – the token was used to create the account; nothing here is valid any more.
//
// Neither the OTP nor the registration token is stored: only keyed hashes.
const emailVerificationSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    purpose: { type: String, enum: ['student_registration'], required: true },
    status: { type: String, enum: ['pending', 'verified', 'consumed'], required: true },
    otpHash: { type: String, default: null },
    otpExpiresAt: { type: Date, default: null },
    attempts: { type: Number, default: 0 },
    lastSentAt: { type: Date, required: true },
    // Rolling one-hour send budget per email address.
    sendWindowStartedAt: { type: Date, required: true },
    sendsInWindow: { type: Number, default: 0 },
    tokenHash: { type: String, default: null },
    tokenExpiresAt: { type: Date, default: null },
    verifiedAt: { type: Date, default: null },
    consumedAt: { type: Date, default: null },
    // Removed by MongoDB after this time (TTL index).
    purgeAt: { type: Date, required: true }
  },
  { timestamps: true }
)

emailVerificationSchema.index({ email: 1, purpose: 1 }, { unique: true })
emailVerificationSchema.index(
  { tokenHash: 1 },
  { unique: true, partialFilterExpression: { tokenHash: { $type: 'string' } } }
)
emailVerificationSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 })

module.exports =
  mongoose.models.EmailVerification || mongoose.model('EmailVerification', emailVerificationSchema)
