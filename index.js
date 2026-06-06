require("dotenv").config();
const { Keypair, Connection, VersionedTransaction } = require("@solana/web3.js");
const bs58 = require("bs58");
const { keys } = require("./keys");
const winston = require('winston');
const chalk = require('chalk');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(info => `${info.timestamp} ${info.level}: ${info.message}`)
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'volume-bot.log' })
  ]
});

class VolumeBot {
  constructor() {
    this.config = {
      minAmount: parseFloat(process.env.MIN_AMOUNT || process.env.AMOUNT || 0.001),
      maxAmount: parseFloat(process.env.MAX_AMOUNT || process.env.AMOUNT || 0.001),
      tokenAddress: process.env.TOKEN_ADDRESS,
      delay: parseInt(process.env.DELAY) || 30000,
      slippage: parseInt(process.env.SLIPPAGE) || 30,
      priorityFee: parseFloat(process.env.PRIORITY_FEE) || 0.001,
      rpcUrl: process.env.RPC_URL,
      threads: parseInt(process.env.THREADS) || 1,
      maxRetries: parseInt(process.env.MAX_RETRIES) || 3,
      retryDelay: parseInt(process.env.RETRY_DELAY) || 10000,
      pool: process.env.POOL || 'pump-amm'
    };
    this.keys = keys;
    this.connection = new Connection(this.config.rpcUrl, 'confirmed');
    this.activeWallets = new Set();
    this.failedAttempts = 0;
    this.successfulTrades = 0;

    if (this.config.minAmount !== this.config.maxAmount) {
      logger.info(`💫 Random amounts enabled: ${this.config.minAmount} - ${this.config.maxAmount} SOL`);
    } else {
      logger.info(`Fixed amount: ${this.config.minAmount} SOL`);
    }
  }

  getRandomAmount() {
    const { minAmount, maxAmount } = this.config;
    if (minAmount === maxAmount) return minAmount;
    return parseFloat((minAmount + Math.random() * (maxAmount - minAmount)).toFixed(4));
  }

  getAvailableKeypair() {
    let keypair;
    do {
      const privateKey = this.keys[Math.floor(Math.random() * this.keys.length)];
      keypair = Keypair.fromSecretKey(bs58.decode(privateKey));
    } while (this.activeWallets.has(keypair.publicKey.toBase58()));
    this.activeWallets.add(keypair.publicKey.toBase58());
    return keypair;
  }

  release(publicKey) {
    this.activeWallets.delete(publicKey);
  }

  // Poll for confirmation, resending every 2s to keep tx alive
  async sendAndConfirm(serialized, lastValidBlockHeight) {
    let txid = await this.connection.sendRawTransaction(serialized, { skipPreflight: true });
    logger.info(`📤 Sent tx: ${txid.substring(0, 20)}... polling...`);

    const deadline = Date.now() + 90000;

    while (Date.now() < deadline) {
      const status = await this.connection.getSignatureStatus(txid, {
        searchTransactionHistory: false
      });

      const conf = status?.value?.confirmationStatus;
      if (conf === 'confirmed' || conf === 'finalized') return txid;

      if (status?.value?.err) {
        throw new Error(`On-chain error: ${JSON.stringify(status.value.err)}`);
      }

      const blockHeight = await this.connection.getBlockHeight('confirmed');
      if (blockHeight > lastValidBlockHeight) throw new Error('expired');

      try {
        await this.connection.sendRawTransaction(serialized, { skipPreflight: true });
      } catch (_) {}

      await sleep(2000);
    }

    throw new Error('expired');
  }

  async performBuy(keypair, retryCount = 0) {
    const amount = this.getRandomAmount();
    const walletShort = keypair.publicKey.toBase58().substring(0, 8);
    logger.info(`${chalk.white('[BUYING]')} [${walletShort}...] ${amount} SOL${retryCount > 0 ? ` (Retry ${retryCount}/${this.config.maxRetries})` : ''}`);

    try {
      // Step 1: Get tx from PumpPortal trade-local
      const response = await fetch('https://pumpportal.fun/api/trade-local', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publicKey: keypair.publicKey.toBase58(),
          action: 'buy',
          mint: this.config.tokenAddress,
          denominatedInSol: 'true',
          amount: amount,
          slippage: this.config.slippage,
          priorityFee: this.config.priorityFee,
          pool: this.config.pool
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`PumpPortal API error ${response.status}: ${errText}`);
      }

      // Step 2: Deserialize
      const txBuffer = await response.arrayBuffer();
      const tx = VersionedTransaction.deserialize(new Uint8Array(txBuffer));

      // Step 3: Get fresh blockhash THEN sign — keeps validity window maximum
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('finalized');
      tx.message.recentBlockhash = blockhash;
      tx.sign([keypair]);

      const serialized = tx.serialize();

      // Step 4: Send + poll with resend loop
      const txid = await this.sendAndConfirm(serialized, lastValidBlockHeight);

      logger.info(`${chalk.green('✅ [BOUGHT]')} https://solscan.io/tx/${txid} (${amount} SOL)`);
      this.successfulTrades++;
      this.failedAttempts = 0;
      return txid;

    } catch (error) {
      const errorMsg = error.message || String(error);

      if (errorMsg.includes('429') || errorMsg.includes('Rate limit')) {
        logger.warn(`⚠️ Rate limited! Waiting ${this.config.retryDelay / 1000}s...`);
        await sleep(this.config.retryDelay);
        if (retryCount < this.config.maxRetries) return await this.performBuy(keypair, retryCount + 1);
        this.failedAttempts++;
        return false;
      }

      if (errorMsg === 'expired' || errorMsg.includes('BlockhashNotFound')) {
        logger.warn(`⚠️ Transaction expired. ${retryCount < this.config.maxRetries ? 'Retrying...' : 'Max retries reached.'}`);
        if (retryCount < this.config.maxRetries) {
          await sleep(1000);
          return await this.performBuy(keypair, retryCount + 1);
        }
      }

      logger.error(`❌ Error buying: ${errorMsg}`);
      this.failedAttempts++;

      if (this.failedAttempts > 5) {
        logger.warn(`🛑 Too many failures. Cooling down 30s...`);
        await sleep(30000);
        this.failedAttempts = 0;
      }

      return false;
    }
  }

  async run() {
    while (true) {
      try {
        const keypair = this.getAvailableKeypair();
        logger.info(`🔄 Starting buy (Total: ${this.successfulTrades}, Failed: ${this.failedAttempts})`);
        await this.performBuy(keypair);
        this.release(keypair.publicKey.toBase58());
        logger.info(`⏳ Waiting ${this.config.delay / 1000}s before next buy...`);
        await sleep(this.config.delay);
      } catch (error) {
        logger.error(`❌ Critical error: ${error.message}`);
        await sleep(30000);
      }
    }
  }

  async start() {
    logger.info('🚀 Starting Volume Bot (PumpPortal Buy-Only Mode)');
    logger.info(`📊 Configuration:`);
    logger.info(`   - Token:        ${this.config.tokenAddress}`);
    logger.info(`   - Pool:         ${this.config.pool}`);
    logger.info(`   - Amount:       ${this.config.minAmount}${this.config.minAmount !== this.config.maxAmount ? `-${this.config.maxAmount}` : ''} SOL`);
    logger.info(`   - Delay:        ${this.config.delay / 1000}s`);
    logger.info(`   - Slippage:     ${this.config.slippage}%`);
    logger.info(`   - Priority Fee: ${this.config.priorityFee} SOL`);
    logger.info(`   - Threads:      ${Math.min(this.config.threads, this.keys.length)}`);
    logger.info(`   - RPC:          ${this.config.rpcUrl.substring(0, 50)}...`);

    const availableThreads = Math.min(this.config.threads, this.keys.length);
    const walletPromises = Array.from({ length: availableThreads }, () => this.run());
    await Promise.all(walletPromises);
  }
}

const bot = new VolumeBot();
bot.start().catch(error => logger.error('💥 Fatal error', { error }));
