const { db, httpError, requireUser, fetchMonnifyTransaction, creditDeposit, sendError } = require("./_lib");

const DEAD = ["FAILED", "EXPIRED", "CANCELLED", "ABANDONED", "REVERSED"];

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const user = await requireUser(req);
    const paymentReference = String((req.body && req.body.paymentReference) || "");
    if (!paymentReference) throw httpError(400, "Missing reference");

    const snap = await db.collection("deposits").doc(paymentReference).get();
    if (!snap.exists) throw httpError(404, "Payment not found");
    const dep = snap.data();
    if (dep.uid !== user.uid) throw httpError(403, "Not your payment");
    if (dep.status === "credited") return res.status(200).json({ status: "credited", credited: dep.usd });

    const tx = await fetchMonnifyTransaction(dep.transactionReference);
    const result = await creditDeposit(paymentReference, tx);

    if (result.status === "credited") return res.status(200).json(result);
    if (DEAD.includes(tx.paymentStatus)) return res.status(200).json({ status: "failed" });
    res.status(200).json({ status: result.status === "failed" ? "failed" : "pending" });
  } catch (err) {
    sendError(res, err);
  }
};
