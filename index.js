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
      pool: process.env.POOL || 'pump-amm'
    };
    this.keys = keys;
    this.connection = new Connection(this.config.rpcUrl, 'confirmed');
    this.activeWallets = new Set();
    this.successfulTrades = 0;
    this.failedAttempts = 0;

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

  async performBuy(keypair) {
    const amount = this.getRandomAmount();
    const walletShort = keypair.publicKey.toBase58().substring(0, 8);
    logger.info(`${chalk.white('[BUYING]')} [${walletShort}...] ${amount} SOL`);

    try {
      // Step 1: Get transaction from PumpPortal
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

      // Step 2: Deserialize and sign immediately (use tx as-is, blockhash is fresh from API)
      const txBuffer = await response.arrayBuffer();
      const tx = VersionedTransaction.deserialize(new Uint8Array(txBuffer));
      tx.sign([keypair]);
      const serialized = tx.serialize();

      // Step 3: Send immediately, then resend every 1.5s for 40s (covering the full blockhash window)
      const txid = await this.connection.sendRawTransaction(serialized, { skipPreflight: true });
      logger.info(`📤 Sent: ${txid.substring(0, 20)}... confirming...`);

      // Resend loop — keep hammering validators for 40s
      const resendUntil = Date.now() + 40000;
      let confirmed = false;

      while (Date.now() < resendUntil) {
        await sleep(1500);

        // Check status
        const status = await this.connection.getSignatureStatus(txid, {
          searchTransactionHistory: true
        });
        const conf = status?.value?.confirmationStatus;

        if (conf === 'confirmed' || conf === 'finalized') {
          confirmed = true;
          break;
        }

        if (status?.value?.err) {
          throw new Error(`On-chain error: ${JSON.stringify(status.value.err)}`);
        }

        // Resend
        try {
          await this.connection.sendRawTransaction(serialized, { skipPreflight: true });
        } catch (_) {}
      }

      if (!confirmed) {
        // One last check with history search
        const finalStatus = await this.connection.getSignatureStatus(txid, {
          searchTransactionHistory: true
        });
        const conf = finalStatus?.value?.confirmationStatus;
        if (conf === 'confirmed' || conf === 'finalized') {
          confirmed = true;
        }
      }

      if (confirmed) {
        logger.info(`${chalk.green('✅ [BOUGHT]')} https://solscan.io/tx/${txid} (${amount} SOL)`);
        this.successfulTrades++;
        this.failedAttempts = 0;
        return txid;
      } else {
        throw new Error('Transaction not confirmed within window');
      }

    } catch (error) {
      const errorMsg = error.message || String(error);

      if (errorMsg.includes('429') || errorMsg.includes('Rate limit')) {
        logger.warn(`⚠️ Rate limited! Waiting 10s...`);
        await sleep(10000);
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
    await Promise.all(Array.from({ length: availableThreads }, () => this.run()));
  }
}

const bot = new VolumeBot();
bot.start().catch(error => logger.error('💥 Fatal error', { error }));
