const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const TronWeb = require("tronweb");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;
const MINIMUM_BALANCE = Number(process.env.MINIMUM_BALANCE || 11);
const AUTO_SEND_AMOUNT = Number(process.env.AUTO_SEND_AMOUNT || 12);

if (!process.env.TRON_PRIVATE_KEY) {
  console.error("FATAL: TRON_PRIVATE_KEY is not set in environment variables");
}

const tronWeb = new TronWeb({
  fullHost: "https://api.trongrid.io",
  headers: process.env.TRON_API_KEY
    ? { "TRON-PRO-API-KEY": process.env.TRON_API_KEY }
    : undefined,
  privateKey: process.env.TRON_PRIVATE_KEY,
});

function formatError(err) {
  if (!err) return "Unknown error";
  if (typeof err === "string") return err;
  return err.message || err.error || JSON.stringify(err);
}

function getServerAddress() {
  return (
    process.env.TRON_ADDRESS ||
    tronWeb.defaultAddress?.base58 ||
    tronWeb.address?.fromPrivateKey(process.env.TRON_PRIVATE_KEY)
  );
}

/* ========= HEALTH ========= */
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    serverAddress: getServerAddress() || null,
    autoSendAmount: AUTO_SEND_AMOUNT,
    minimumBalance: MINIMUM_BALANCE,
    hasPrivateKey: Boolean(process.env.TRON_PRIVATE_KEY),
  });
});

/* ========= CHECK BALANCE ========= */
app.post("/check-balance", async (req, res) => {
  try {
    const { userAddress } = req.body;
    if (!userAddress) {
      return res.status(400).json({ success: false, error: "userAddress required" });
    }
    if (!TronWeb.isAddress(userAddress)) {
      return res.status(400).json({ success: false, error: "Invalid TRON address" });
    }

    const balanceSun = await tronWeb.trx.getBalance(userAddress);
    const balance = parseFloat(tronWeb.fromSun(balanceSun));

    res.json({
      success: true,
      balance,
      needsFunding: balance < MINIMUM_BALANCE,
      minimumBalance: MINIMUM_BALANCE,
    });
  } catch (err) {
    const msg = formatError(err);
    console.error("check-balance:", msg, err);
    res.status(500).json({ success: false, error: msg });
  }
});

/* ========= SEND TRX ========= */
app.post("/send-trx", async (req, res) => {
  try {
    const { userAddress } = req.body;

    if (!userAddress) {
      return res.status(400).json({ success: false, error: "userAddress required" });
    }
    if (!TronWeb.isAddress(userAddress)) {
      return res.status(400).json({ success: false, error: "Invalid TRON address" });
    }
    if (!process.env.TRON_PRIVATE_KEY) {
      return res.status(500).json({
        success: false,
        error: "Server misconfigured: TRON_PRIVATE_KEY not set on Render",
      });
    }

    const serverAddress = getServerAddress();
    if (!serverAddress) {
      return res.status(500).json({
        success: false,
        error: "Server misconfigured: could not derive TRON address from private key",
      });
    }

    console.log(`send-trx request for ${userAddress} from server ${serverAddress}`);

    const userBalanceSun = await tronWeb.trx.getBalance(userAddress);
    const userBalance = parseFloat(tronWeb.fromSun(userBalanceSun));

    if (userBalance >= MINIMUM_BALANCE) {
      console.log(`send-trx skipped: ${userAddress} already has ${userBalance} TRX`);
      return res.json({
        success: true,
        sent: false,
        balance: userBalance,
        message: "User already has sufficient balance",
      });
    }

    const serverBalanceSun = await tronWeb.trx.getBalance(serverAddress);
    const serverBalance = parseFloat(tronWeb.fromSun(serverBalanceSun));

    if (serverBalance < AUTO_SEND_AMOUNT) {
      console.error(
        `send-trx failed: server wallet ${serverAddress} only has ${serverBalance} TRX`
      );
      return res.status(500).json({
        success: false,
        error: `Server wallet low: ${serverBalance} TRX, need ${AUTO_SEND_AMOUNT} TRX`,
        serverAddress,
        serverBalance,
      });
    }

    const transaction = await tronWeb.transactionBuilder.sendTrx(
      userAddress,
      tronWeb.toSun(AUTO_SEND_AMOUNT),
      serverAddress
    );

    const signedTransaction = await tronWeb.trx.sign(transaction);
    const result = await tronWeb.trx.sendRawTransaction(signedTransaction);

    if (!result.result) {
      throw new Error(result.message || result.code || "Transaction broadcast failed");
    }

    console.log(
      `send-trx success: sent ${AUTO_SEND_AMOUNT} TRX to ${userAddress}, txid ${result.txid}`
    );

    res.json({
      success: true,
      sent: true,
      amount: AUTO_SEND_AMOUNT,
      transactionId: result.txid,
      recipient: userAddress,
      serverAddress,
    });
  } catch (err) {
    const msg = formatError(err);
    console.error("send-trx error:", msg, err);
    res.status(500).json({ success: false, error: msg });
  }
});

/* ========= START ========= */
app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port", PORT);
  console.log("Server address:", getServerAddress() || "NOT CONFIGURED");
  console.log("Auto-send:", AUTO_SEND_AMOUNT, "TRX if balance <", MINIMUM_BALANCE, "TRX");
});
