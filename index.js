require("dotenv").config();
const { SolanaTracker } = require("solana-swap");
const { Keypair } = require("@solana/web3.js");
const bs58 = require("bs58");
const { keys } = require("./keys");
const winston = require('winston');
const chalk = require('chalk');

const sleep = (ms) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({
      format: 'YYYY-MM-DD HH:mm:ss'
    }),
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
      delay: parseInt(process.env.DELAY),
      sellDelay: parseInt(process.env.SELL_DELAY),
      slippage: parseInt(process.env.SLIPPAGE),
      priorityFee: parseFloat(process.env.PRIORITY_FEE),
      useJito: process.env.JITO === "true",
      rpcUrl: process.env.RPC_URL,
      threads: parseInt(process.env.THREADS) || 1,
      maxRetries: parseInt(process.env.MAX_RETRIES) || 3,
      retryDelay: parseInt(process.env.RETRY_DELAY) || 10000 // 10 seconds between retries
    };
    this.keys = keys;
    this.SOL_ADDRESS = "So11111111111111111111111111111111111111112";
    this.activeWallets = new Set();
    this.failedAttempts = 0;
    this.successfulTrades = 0;
    
    // Log the random amount range
    if (this.config.minAmount !== this.config.maxAmount) {
      logger.info(`💫 Random amounts enabled: ${this.config.minAmount} - ${this.config.maxAmount} SOL`);
    } else {
      logger.info(`Fixed amount: ${this.config.minAmount} SOL`);
    }
  }

  // Generate random amount between min and max
  getRandomAmount() {
    const { minAmount, maxAmount } = this.config;
    if (minAmount === maxAmount) {
      return minAmount;
    }
    const randomAmount = minAmount + (Math.random() * (maxAmount - minAmount));
    return parseFloat(randomAmount.toFixed(4));
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

  async performSwap(solanaTracker, keypair, isBuy, customAmount = null, retryCount = 0) {
    const amount = customAmount || this.getRandomAmount();
    const walletShort = keypair.publicKey.toBase58().substring(0, 8);
    logger.info(`${isBuy ? chalk.white('[BUYING]') : chalk.white('[SELLING]')} [${walletShort}...] ${isBuy ? `${amount} SOL` : 'all tokens'}${retryCount > 0 ? ` (Retry ${retryCount}/${this.config.maxRetries})` : ''}`);
    
    const { tokenAddress, slippage, priorityFee } = this.config;
    const [fromToken, toToken] = isBuy
      ? [this.SOL_ADDRESS, tokenAddress]
      : [tokenAddress, this.SOL_ADDRESS];

    try {
      const swapResponse = await solanaTracker.getSwapInstructions(
        fromToken,
        toToken,
        isBuy ? amount : "auto",
        slippage,
        keypair.publicKey.toBase58(),
        priorityFee
      );

      const swapOptions = this.buildSwapOptions();
      const txid = await solanaTracker.performSwap(swapResponse, swapOptions);
      
      this.logTransaction(txid, isBuy, amount);
      this.successfulTrades++;
      this.failedAttempts = 0; // Reset failed attempts on success
      return txid;
      
    } catch (error) {
      const errorMsg = error.message || String(error);
      
      // Check if it's a rate limit error
      if (errorMsg.includes('429') || errorMsg.includes('Rate limit')) {
        logger.warn(`⚠️ Rate limited! Waiting ${this.config.retryDelay / 1000}s before retry...`);
        await sleep(this.config.retryDelay);
        
        // Retry if we haven't exceeded max retries
        if (retryCount < this.config.maxRetries) {
          return await this.performSwap(solanaTracker, keypair, isBuy, amount, retryCount + 1);
        } else {
          logger.error(`❌ Max retries reached. Skipping this trade.`);
          this.failedAttempts++;
          return false;
        }
      }
      
      // Check if transaction expired
      if (errorMsg.includes('expired')) {
        logger.warn(`⚠️ Transaction expired. ${retryCount < this.config.maxRetries ? 'Retrying...' : 'Max retries reached.'}`);
        
        if (retryCount < this.config.maxRetries) {
          await sleep(3000); // Wait 3 seconds before retry
          return await this.performSwap(solanaTracker, keypair, isBuy, amount, retryCount + 1);
        }
      }
      
      logger.error(`❌ Error ${isBuy ? "buying" : "selling"}: ${errorMsg}`);
      this.failedAttempts++;
      
      // If too many consecutive failures, increase delay
      if (this.failedAttempts > 5) {
        logger.warn(`🛑 Too many failures (${this.failedAttempts}). Adding extra delay...`);
        await sleep(30000); // Wait 30 seconds
        this.failedAttempts = 0;
      }
      
      return false;
    }
  }

  buildSwapOptions() {
    return {
      sendOptions: { skipPreflight: true },
      confirmationRetries: 30,
      confirmationRetryTimeout: 1000,
      lastValidBlockHeightBuffer: 150,
      resendInterval: 1000,
      confirmationCheckInterval: 1000,
      commitment: "processed",
      jito: this.config.useJito ? { enabled: true, tip: 0.0001 } : undefined,
    };
  }

  async swap(solanaTracker, keypair) {
    logger.info(`🔄 Starting new trade cycle (Success: ${this.successfulTrades}, Failed: ${this.failedAttempts})`);
    
    const buyTxid = await this.performSwap(solanaTracker, keypair, true);
    
    if (buyTxid) {
      logger.info(`✅ Buy successful! Waiting ${this.config.sellDelay / 1000}s before selling...`);
      await sleep(this.config.sellDelay);
      
      const sellTxid = await this.performSwap(solanaTracker, keypair, false);
      
      if (sellTxid) {
        logger.info(`✅ Sell successful! Trade cycle complete.`);
        return true;
      } else {
        logger.warn(`⚠️ Sell failed. Tokens may be stuck in wallet!`);
        return false;
      }
    } else {
      logger.warn(`⚠️ Buy failed. Skipping sell.`);
      return false;
    }
  }

  logTransaction(txid, isBuy, amount) {
    const amountStr = isBuy && amount ? ` (${amount} SOL)` : '';
    const txUrl = `https://solscan.io/tx/${txid}`;
    logger.info(`${isBuy ? chalk.green('✅ [BOUGHT]') : chalk.red('✅ [SOLD]')} ${txUrl}${amountStr}`);
  }

  async run() {
    while (true) {
      try {
        const keypair = this.getAvailableKeypair();
        const solanaTracker = new SolanaTracker(keypair, this.config.rpcUrl);

        await this.swap(solanaTracker, keypair);
        this.release(keypair.publicKey.toBase58());
        
        logger.info(`⏳ Waiting ${this.config.delay / 1000}s before next cycle...`);
        await sleep(this.config.delay);
        
      } catch (error) {
        logger.error(`❌ Critical error in run loop: ${error.message}`);
        await sleep(30000); // Wait 30 seconds on critical error
      }
    }
  }

  async start() {
    logger.info('🚀 Starting Volume Bot');
    logger.info(`📊 Configuration:`);
    logger.info(`   - Token: ${this.config.tokenAddress}`);
    logger.info(`   - Amount: ${this.config.minAmount}${this.config.minAmount !== this.config.maxAmount ? `-${this.config.maxAmount}` : ''} SOL`);
    logger.info(`   - Delay: ${this.config.delay / 1000}s`);
    logger.info(`   - Slippage: ${this.config.slippage}%`);
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
bot.start().catch(error => logger.error('💥 Fatal error in bot execution', { error }));
