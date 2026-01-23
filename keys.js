// Solana Wallet Private Keys Configuration
// This file supports both local development and Railway deployment

// FOR RAILWAY DEPLOYMENT:
// Set these environment variables in Railway:
// - WALLET_1_PRIVATE_KEY
// - WALLET_2_PRIVATE_KEY

// FOR LOCAL TESTING (if needed):
// Uncomment the lines below and add your keys directly
// WARNING: Never commit real keys to GitHub!

const keys = [];

// Try to load from environment variables first (Railway)
if (process.env.WALLET_1_PRIVATE_KEY) {
    keys.push(process.env.WALLET_1_PRIVATE_KEY);
}
if (process.env.WALLET_2_PRIVATE_KEY) {
    keys.push(process.env.WALLET_2_PRIVATE_KEY);
}

// If no environment variables, use hardcoded keys (for local testing only)
if (keys.length === 0) {
    keys.push(
        "YOUR_WALLET_1_PRIVATE_KEY_FROM_PHANTOM",
        "YOUR_WALLET_2_PRIVATE_KEY_FROM_PHANTOM"
    );
}

// Validate that we have at least one key
if (keys.length === 0 || keys[0] === "YOUR_WALLET_1_PRIVATE_KEY_FROM_PHANTOM") {
    console.error("❌ ERROR: No valid wallet keys found!");
    console.error("Please set WALLET_1_PRIVATE_KEY and WALLET_2_PRIVATE_KEY environment variables in Railway");
    console.error("Or update this file with your actual private keys for local testing");
    process.exit(1);
}

console.log(`✅ Loaded ${keys.length} wallet(s) for trading`);

module.exports = {
    keys: keys
};
