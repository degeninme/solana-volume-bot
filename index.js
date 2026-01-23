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
      threads: parseInt(process.env.THREADS) || 1
    };
    this.keys = keys;
    this.SOL_ADDRESS = "So11111111111111111111111111111111111111112";
    this.activeWallets = new Set();
    
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
    // Generate random amount with 4 decimal precision
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

  async performSwap(solanaTracker, keypair, isBuy, customAmount = null) {
    const amount = customAmount || this.getRandomAmount();
    logger.info(`${isBuy ? chalk.white('[BUYING]') : chalk.white('[SELLING]')} [${keypair.publicKey.toBase58()}] Initiating swap${isBuy ? ` with ${amount} SOL` : ''}`);
    
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
      return txid;
    } catch (error) {
      logger.error(`Error performing ${isBuy ? "buy" : "sell"}: ${error.message}`, { error });
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
    const buyTxid = await this.performSwap(solanaTracker, keypair, true);
    if (buyTxid) {
      await sleep(this.config.sellDelay);
      const sellTxid = await this.performSwap(solanaTracker, keypair, false);
      return sellTxid;
    }
    return false;
  }

  logTransaction(txid, isBuy, amount) {
    const amountStr = isBuy && amount ? ` (${amount} SOL)` : '';
    logger.info(`${isBuy ? chalk.green('[BOUGHT]') : chalk.red('[SOLD]')} [${txid}]${amountStr}`);
  }

  async run() {
    while (true) {
      const keypair = this.getAvailableKeypair();
      const solanaTracker = new SolanaTracker(keypair, this.config.rpcUrl);

      await this.swap(solanaTracker, keypair);
      this.release(keypair.publicKey.toBase58());
      await sleep(this.config.delay);
    }
  }

  async start() {
    logger.info('Starting Volume Bot');
    const walletPromises = [];
    const availableThreads = Math.min(this.config.threads, this.keys.length);
    for (let i = 0; i < availableThreads; i++) {
      walletPromises.push(this.run());
    }
    await Promise.all(walletPromises);
  }
}

const bot = new VolumeBot();
bot.start().catch(error => logger.error('Error in bot execution', { error }));
