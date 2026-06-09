/**
 * 池状态检查点：已出场/已剔除的 entry 归档，增量回放不必从创世重算
 */
const { POOL_RULES_VERSION } = require('./pool-config');

/** 不再参与匹配的状态 → 快照里丢弃，仅保留 blocked 付款人名单 */
const ARCHIVE_ENTRY_STATUSES = new Set(['done', 'pay_expired', 'blocked']);

function serializeEntry(e) {
  return {
    entryId: e.entryId,
    poolId: e.poolId,
    payer: e.payer,
    ticketPaidTrx: e.ticketPaidTrx,
    poolCreditTrx: e.poolCreditTrx,
    remainingPoolCreditTrx: e.remainingPoolCreditTrx,
    exitAmountTrx: e.exitAmountTrx,
    blockNumber: e.blockNumber,
    blockTimestamp: e.blockTimestamp,
    queueIndex: e.queueIndex,
    status: e.status,
    payAssignments: e.payAssignments || [],
    payDeadlineMs: e.payDeadlineMs,
    recvQueueJoinedAt: e.recvQueueJoinedAt,
    verifiedMainnetTxId: e.verifiedMainnetTxId,
    exitRemainderTrx: e.exitRemainderTrx,
    surplusToTicketTrx: e.surplusToTicketTrx,
    blockReason: e.blockReason,
    completedAt: e.completedAt,
  };
}

/**
 * 从回放状态导出快照（本地持久化 / GitHub 发布每日检查点）
 */
function exportPoolSnapshot(poolId, stateMap, matchDays, wallNowMs, extra = {}) {
  const activeEntries = [];
  const blockedPayers = new Set(extra.blockedPayers || []);
  let lastQueueIndex = 0;
  let archivedEntryCount = 0;

  for (const e of stateMap.values()) {
    if (ARCHIVE_ENTRY_STATUSES.has(e.status)) {
      archivedEntryCount += 1;
      if (e.status === 'blocked' && e.payer) blockedPayers.add(e.payer);
      continue;
    }
    activeEntries.push(serializeEntry(e));
    if (e.queueIndex > lastQueueIndex) lastQueueIndex = e.queueIndex;
  }

  activeEntries.sort((a, b) => a.queueIndex - b.queueIndex);

  const lastMatchDayMs =
    matchDays.length > 0
      ? Date.parse(`${matchDays[matchDays.length - 1].matchDayId}T00:00:00.000Z`)
      : 0;

  return {
    rulesVersion: POOL_RULES_VERSION,
    poolId,
    snapshotAtMs: wallNowMs,
    snapshotDayId: new Date(wallNowMs).toISOString().slice(0, 10),
    lastMatchDayMs,
    matchDays: matchDays.map((d) => ({ ...d })),
    activeEntries,
    blockedPayers: [...blockedPayers],
    usedExitTxIds: [...(extra.usedExitTxIds || [])],
    lastQueueIndex,
    archivedEntryCount,
  };
}

function loadSnapshot(snapshot) {
  if (!snapshot || !snapshot.poolId) {
    throw new Error('invalid pool snapshot');
  }
  if (snapshot.rulesVersion && snapshot.rulesVersion !== POOL_RULES_VERSION) {
    throw new Error(`snapshot rulesVersion mismatch: ${snapshot.rulesVersion}`);
  }
  const stateMap = new Map();
  for (const e of snapshot.activeEntries || []) {
    stateMap.set(e.entryId, { ...e, payAssignments: e.payAssignments || [] });
  }
  return {
    stateMap,
    matchDays: (snapshot.matchDays || []).map((d) => ({ ...d })),
    blockedPayers: new Set(snapshot.blockedPayers || []),
    usedExitTxIds: new Set(snapshot.usedExitTxIds || []),
    lastQueueIndex: snapshot.lastQueueIndex || 0,
    incrementalFromMs: snapshot.snapshotAtMs || 0,
    lastMatchDayMs: snapshot.lastMatchDayMs || 0,
    archivedEntryCount: snapshot.archivedEntryCount || 0,
  };
}

function filterTxsAfter(txs, afterMs) {
  return (txs || []).filter((t) => (t.blockTimestamp || 0) > afterMs);
}

module.exports = {
  ARCHIVE_ENTRY_STATUSES,
  exportPoolSnapshot,
  loadSnapshot,
  filterTxsAfter,
  serializeEntry,
};
