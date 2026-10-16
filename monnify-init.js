const crypto = require("crypto");
const { admin, db, httpError, requireUser, monnifyRequest, sendError } = require("./_lib");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const user = await requireUser(req);

    const usd = Math.round(Number(req.body && req.body.amount) * 100) / 100;
    if (!(usd >= 5 && usd <= 500)) throw httpError(400, "Amount must be between $5 and $500");

    const rate = Number(process.env.USD_TO_NGN);
    if (!(rate > 0)) throw httpError(500, "Rate not configured");
    const ngn = Math.round(usd * rate * 100) / 100;

    const paymentReference = `PX_${user.uid.slice(0, 8)}_${Date.now()}_${crypto
      .randomBytes(3)
      .toString("hex")}`;

    const tx = await monnifyRequest("POST", "/api/v1/merchant/transactions/init-transaction", {
      amount: ngn,
      customerName: user.name || (user.email || "Praxio player").split("@")[0],
      customerEmail: user.email,
      paymentReference,
      paymentDescription: "Praxio wallet deposit",
      currencyCode: "NGN",
      contractCode: process.env.MONNIFY_CONTRACT_CODE,
      redirectUrl: `${process.env.SITE_URL}/`,
      paymentMethods: ["CARD", "ACCOUNT_TRANSFER"],
    });

    await db.collection("deposits").doc(paymentReference).set({
      uid: user.uid,
      usd,
      ngn,
      status: "pending",
      transactionReference: tx.transactionReference,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.status(200).json({ checkoutUrl: tx.checkoutUrl, paymentReference });
  } catch (err) {
    sendError(res, err);
  }
};
