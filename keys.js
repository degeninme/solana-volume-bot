// Solana Wallet Private Keys Configuration
// Reads from Railway environment variables

const keys = [];

// Load from environment variables (Railway deployment)
if (process.env.WALLET_1_PRIVATE_KEY) {
    keys.push(process.env.WALLET_1_PRIVATE_KEY);
    console.log("✅ Loaded Wallet 1");
}

if (process.env.WALLET_2_PRIVATE_KEY) {
    keys.push(process.env.WALLET_2_PRIVATE_KEY);
    console.log("✅ Loaded Wallet 2");
}

// Validate we have keys
if (keys.length === 0) {
    console.error("❌ ERROR: No wallet keys found!");
    console.error("Make sure you set these environment variables in Railway:");
    console.error("  - WALLET_1_PRIVATE_KEY");
    console.error("  - WALLET_2_PRIVATE_KEY");
    process.exit(1);
}

console.log(`✅ Successfully loaded ${keys.length} wallet(s) for trading`);

module.exports = {
    keys: keys
};
