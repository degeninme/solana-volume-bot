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
      slippage: parseInt(process.env.SLIPPAGE) || 25,
      priorityFee: parseFloat(process.env.PRIORITY_FEE) || 0.001,
      rpcUrl: process.env.RPC_URL,
      threads: parseInt(process.env.THREADS) || 1,
      maxRetries: parseInt(process.env.MAX_RETRIES) || 3,
      retryDelay: parseInt(process.env.RETRY_DELAY) || 10000
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

  async performBuy(keypair, retryCount = 0) {
    const amount = this.getRandomAmount();
    const walletShort = keypair.publicKey.toBase58().substring(0, 8);
    logger.info(`${chalk.white('[BUYING]')} [${walletShort}...] ${amount} SOL${retryCount > 0 ? ` (Retry ${retryCount}/${this.config.maxRetries})` : ''}`);

    try {
      // Step 1: Get the transaction from PumpPortal
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
          pool: process.env.POOL || 'pump-amm'
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`PumpPortal API error ${response.status}: ${errText}`);
      }

      // Step 2: Deserialize, stamp with fresh blockhash, sign, and send
      const txBuffer = await response.arrayBuffer();
      const tx = VersionedTransaction.deserialize(new Uint8Array(txBuffer));

      // Get fresh blockhash right before signing to maximise validity window
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
      tx.message.recentBlockhash = blockhash;
      tx.sign([keypair]);

      const txid = await this.connection.sendTransaction(tx, {
        skipPreflight: true,
        maxRetries: 5,
        preflightCommitment: 'processed'
      });

      // Step 3: Confirm within the same blockhash window
      await this.connection.confirmTransaction(
        { signature: txid, blockhash, lastValidBlockHeight },
        'confirmed'
      );

      logger.info(`${chalk.green('✅ [BOUGHT]')} https://solscan.io/tx/${txid} (${amount} SOL)`);
      this.successfulTrades++;
      this.failedAttempts = 0;
      return txid;

    } catch (error) {
      const errorMsg = error.message || String(error);

      // Rate limit retry
      if (errorMsg.includes('429') || errorMsg.includes('Rate limit')) {
        logger.warn(`⚠️ Rate limited! Waiting ${this.config.retryDelay / 1000}s...`);
        await sleep(this.config.retryDelay);
        if (retryCount < this.config.maxRetries) {
          return await this.performBuy(keypair, retryCount + 1);
        }
        logger.error(`❌ Max retries reached. Skipping.`);
        this.failedAttempts++;
        return false;
      }

      // Blockhash expired retry
      if (errorMsg.includes('expired') || errorMsg.includes('BlockhashNotFound')) {
        logger.warn(`⚠️ Transaction expired. ${retryCount < this.config.maxRetries ? 'Retrying...' : 'Max retries reached.'}`);
        if (retryCount < this.config.maxRetries) {
          await sleep(1000);
          return await this.performBuy(keypair, retryCount + 1);
        }
      }

      logger.error(`❌ Error buying: ${errorMsg}`);
      this.failedAttempts++;

      if (this.failedAttempts > 5) {
        logger.warn(`🛑 Too many failures (${this.failedAttempts}). Cooling down 30s...`);
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

        logger.info(`🔄 Starting buy (Total buys: ${this.successfulTrades}, Failed: ${this.failedAttempts})`);
        await this.performBuy(keypair);

        this.release(keypair.publicKey.toBase58());

        logger.info(`⏳ Waiting ${this.config.delay / 1000}s before next buy...`);
        await sleep(this.config.delay);

      } catch (error) {
        logger.error(`❌ Critical error in run loop: ${error.message}`);
        await sleep(30000);
      }
    }
  }

  async start() {
    logger.info('🚀 Starting Volume Bot (PumpPortal Buy-Only Mode)');
    logger.info(`📊 Configuration:`);
    logger.info(`   - Token: ${this.config.tokenAddress}`);
    logger.info(`   - Amount: ${this.config.minAmount}${this.config.minAmount !== this.config.maxAmount ? `-${this.config.maxAmount}` : ''} SOL`);
    logger.info(`   - Delay: ${this.config.delay / 1000}s`);
    logger.info(`   - Slippage: ${this.config.slippage}%`);
    logger.info(`   - Priority Fee: ${this.config.priorityFee} SOL`);
    logger.info(`   - Pool: ${process.env.POOL || 'pump-amm'}`);
    logger.info(`   - Threads: ${Math.min(this.config.threads, this.keys.length)}`);
    logger.info(`   - RPC: ${this.config.rpcUrl.substring(0, 50)}...`);

    const walletPromises = [];
    const availableThreads = Math.min(this.config.threads, this.keys.length);
    for (let i = 0; i < availableThreads; i++) {
      walletPromises.push(this.run());
    }
    await Promise.all(walletPromises);
  }
}

const bot = new VolumeBot();
bot.start().catch(error => logger.error('💥 Fatal error', { error }));
