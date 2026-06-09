/**
 * 出场池主网验款（无测试网、无用户自报 anchor）
 * 配对：payAssignments + TronGrid 打到 exitPoolAddress 的 tx
 */
const { tronAddressesEqual } = require('./tron-address');

function round4(v) {
  return Math.round(Number(v) * 10000) / 10000;
}

/** 归一化链上转账（买券解析 / TronGrid raw tx 均可） */
function normalizeTransferTx(tx) {
  if (!tx) return null;
  if (tx.txHash && tx.fromAddress != null && tx.amount != null) {
    return {
      txId: String(tx.txHash),
      fromAddress: tx.fromAddress,
      toAddress: tx.toAddress || null,
      amountTrx: round4(Number(tx.amount)),
      timestampMs: Number(tx.blockTimestamp || tx.timestampMs || 0),
    };
  }
  const contract = tx.raw_data?.contract?.[0];
  if (!contract || contract.type !== 'TransferContract') return null;
  const value = contract.parameter?.value;
  if (!value || value.amount == null) return null;
  return {
    txId: String(tx.txID || tx.txId),
    fromAddress: value.owner_address,
    toAddress: value.to_address,
    amountTrx: round4(Number(value.amount) / 1e6),
    timestampMs: Number(tx.raw_data?.timestamp || tx.block_timestamp || 0),
  };
}

function amountEqual(a, b) {
  return Math.abs(round4(a) - round4(b)) < 0.000001;
}

/**
 * @param {Array} payAssignments channel=pay_in
 * @param {Array} exitPoolTxs 打到出场池的主网 tx
 * @param {string} exitPoolAddress
 * @param {number} evaluationMs 评估时刻（用于超时）
 */
function derivePayVerifications(payAssignments, exitPoolTxs, exitPoolAddress, evaluationMs, seedUsedTxIds = []) {
  const parsed = (exitPoolTxs || []).map(normalizeTransferTx).filter(Boolean);
  const usedTxIds = new Set(seedUsedTxIds || []);
  const verified = [];
  const pending = [];
  const expired = [];

  const sorted = [...(payAssignments || [])].sort((a, b) => {
    const ma = a.matchAtMs || 0;
    const mb = b.matchAtMs || 0;
    if (ma !== mb) return ma - mb;
    return String(a.assignmentId).localeCompare(String(b.assignmentId));
  });

  const byEntry = new Map();
  for (const a of sorted) {
    const list = byEntry.get(a.payerEntryId) || [];
    list.push(a);
    byEntry.set(a.payerEntryId, list);
  }

  for (const [entryId, assigns] of byEntry) {
    const hits = [];
    let allOk = true;
    for (const a of assigns) {
      const deadlineMs = a.deadlineMs || 0;
      const notBefore = a.matchAtMs || 0;
      const hit = parsed.find(
        (t) =>
          !usedTxIds.has(t.txId) &&
          tronAddressesEqual(t.fromAddress, a.payer) &&
          (!exitPoolAddress || !t.toAddress || tronAddressesEqual(t.toAddress, exitPoolAddress)) &&
          amountEqual(t.amountTrx, a.amountTrx) &&
          t.timestampMs >= notBefore &&
          t.timestampMs <= evaluationMs,
      );
      if (hit) {
        usedTxIds.add(hit.txId);
        hits.push({ assignment: a, tx: hit });
      } else if (evaluationMs > deadlineMs) {
        allOk = false;
      } else {
        allOk = false;
        pending.push(a);
      }
    }
    if (hits.length === assigns.length && assigns.length > 0) {
      const last = hits.reduce((m, h) => (h.tx.timestampMs > m.tx.timestampMs ? h : m), hits[0]);
      verified.push({
        entryId,
        payer: assigns[0].payer,
        payerEntryId: entryId,
        assignments: assigns,
        mainnetTxId: last.tx.txId,
        verifiedAtMs: last.tx.timestampMs,
        hits,
      });
    } else if (assigns.length > 0 && evaluationMs > Math.max(...assigns.map((x) => x.deadlineMs || 0))) {
      expired.push({ entryId, payer: assigns[0].payer, assignments: assigns });
    } else if (assigns.length > 0) {
      for (const a of assigns) {
        if (!pending.includes(a)) pending.push(a);
      }
    }
  }

  return { verified, pending, expired, usedTxIds };
}

module.exports = {
  normalizeTransferTx,
  derivePayVerifications,
  amountEqual,
};
