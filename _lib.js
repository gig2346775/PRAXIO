const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}

const db = admin.firestore();
const MONNIFY_BASE = process.env.MONNIFY_BASE_URL || "https://sandbox.monnify.com";

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

async function requireUser(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) throw httpError(401, "Not signed in");
  try {
    return await admin.auth().verifyIdToken(token);
  } catch {
    throw httpError(401, "Invalid session");
  }
}

async function monnifyToken() {
  const basic = Buffer.from(
    `${process.env.MONNIFY_API_KEY}:${process.env.MONNIFY_SECRET_KEY}`
  ).toString("base64");
  const res = await fetch(`${MONNIFY_BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}` },
  });
  const data = await res.json();
  if (!data.requestSuccessful) throw httpError(502, "Payment provider auth failed");
  return data.responseBody.accessToken;
}

async function monnifyRequest(method, path, body) {
  const token = await monnifyToken();
  const res = await fetch(`${MONNIFY_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!data.requestSuccessful) throw httpError(502, data.responseMessage || "Payment provider error");
  return data.responseBody;
}

// Ask Monnify directly for the real status of a transaction.
function fetchMonnifyTransaction(transactionReference) {
  return monnifyRequest(
    "GET",
    `/api/v2/transactions/${encodeURIComponent(transactionReference)}`
  );
}

// Credit a deposit exactly once. Safe to call from verify and webhook at the same time.
async function creditDeposit(paymentReference, monnifyTx) {
  const depositRef = db.collection("deposits").doc(paymentReference);

  return db.runTransaction(async (t) => {
    const depSnap = await t.get(depositRef);
    if (!depSnap.exists) return { status: "unknown" };
    const dep = depSnap.data();
    if (dep.status === "credited") return { status: "credited", credited: dep.usd };

    if (monnifyTx.paymentReference !== paymentReference) return { status: "failed" };
    if (monnifyTx.paymentStatus !== "PAID") return { status: "pending" };
    if (Number(monnifyTx.amountPaid) + 0.005 < dep.ngn) return { status: "failed" };

    const walletRef = db.collection("wallets").doc(dep.uid);
    const walletSnap = await t.get(walletRef);
    const wallet = walletSnap.exists
      ? walletSnap.data()
      : { balance: 0, matches: 0, wins: 0, activeLobby: null, history: [] };

    const balance = Math.round((Number(wallet.balance || 0) + dep.usd) * 100) / 100;
    const history = [
      ...(wallet.history || []),
      { name: "Deposit", amount: dep.usd, date: new Date().toISOString(), type: "pos" },
    ];

    t.set(walletRef, { ...wallet, balance, history });
    t.update(depositRef, {
      status: "credited",
      amountPaid: Number(monnifyTx.amountPaid),
      creditedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { status: "credited", credited: dep.usd };
  });
}

function sendError(res, err) {
  const status = err.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? "Server error" : err.message });
}

module.exports = {
  admin,
  db,
  httpError,
  requireUser,
  monnifyRequest,
  fetchMonnifyTransaction,
  creditDeposit,
  sendError,
};
