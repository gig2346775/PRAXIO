const crypto = require("crypto");
const { fetchMonnifyTransaction, creditDeposit } = require("./_lib");

// Raw body is required to check Monnify's signature.
module.exports.config = { api: { bodyParser: false } };

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const raw = await readRaw(req);

    const expected = crypto
      .createHmac("sha512", process.env.MONNIFY_SECRET_KEY)
      .update(raw)
      .digest("hex");
    const given = String(req.headers["monnify-signature"] || "");
    const a = Buffer.from(expected);
    const b = Buffer.from(given);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).end();
    }

    const event = JSON.parse(raw.toString("utf8"));
    if (event.eventType !== "SUCCESSFUL_TRANSACTION" || !event.eventData) {
      return res.status(200).json({ ignored: true });
    }

    const { paymentReference, transactionReference } = event.eventData;
    // Never trust the payload alone: confirm with Monnify before crediting.
    const tx = await fetchMonnifyTransaction(transactionReference);
    const result = await creditDeposit(paymentReference, tx);

    res.status(200).json({ ok: true, status: result.status });
  } catch (err) {
    console.error(err);
    res.status(500).end(); // Monnify will retry
  }
};
