// Solana Wallet Private Keys Configuration
// This file supports both local development and Railway deployment

// FOR RAILWAY DEPLOYMENT:
// Set these environment variables in Railway:
// - WALLET_1_PRIVATE_KEY
// - WALLET_2_PRIVATE_KEY

// FOR LOCAL TESTING (if needed):
// Uncomment the lines below and add your keys directly
// WARNING: Never commit real keys to GitHub!

// Read private keys from environment variables (secure!)
module.exports = {
    keys: [
        process.env.WALLET_1_PRIVATE_KEY,
        process.env.WALLET_2_PRIVATE_KEY,
    ].filter(key => key) // Remove any undefined keys
}
