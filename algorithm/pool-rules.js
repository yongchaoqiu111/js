/**
 * 无服务器排单 · 双池模型 pool-v4-dual-pool
 *
 * 1. 买券 → 打款池 pay_queued（≠ 收款人）
 * 2. 池满 30 万 + 满 15 天 + 有溢出 → 每日 UTC 0:00 匹配
 * 3. 溢出 → 打款池队尾生成 pay_in 任务 → 付到 exitPoolAddress
 * 4. 主网验款通过 → recv_queued（收款池）；超时 → pay_expired
 * 5. 收款池队首按 3900 整数分配 recv_out；零头 recv_partial
 * 6. 人人：TronGrid 买券 + 出场池入账 + 本规则回放 → 结果一致
 * 7. 不用测试网 / 用户自报 anchor
 * 8. 检查点快照：done/pay_expired/blocked 归档，增量回放 O(新增天数) 而非 O(全历史)
 */
const {
  POOL_PURCHASE_CONFIG,
  POOL_RULES_VERSION,
  ENTRY_PERIOD_DAYS,
  EXIT_PERIOD_DAYS,
  MATCH_PAYMENT_TIMEOUT_HOURS,
  MAX_OPEN_ENTRIES_PER_PAYER,
  MAX_SPLITS_PER_PAYER,
  checkpointCutoffMs,
  dailyMatchContext,
  exitPoolAddressFor,
} = require('./pool-config');
const { derivePayVerifications } = require('./exit-pay-verify');
const {
  exportPoolSnapshot,
  loadSnapshot,
  filterTxsAfter,
} = require('./pool-snapshot');

const MS_DAY = 24 * 3600 * 1000;
const PAY_IN_CHANNEL = 'pay_in';
const RECV_OUT_CHANNEL = 'recv_out';
const TICKET_SURPLUS_CHANNEL = 'ticket_surplus';

const PAY_POOL_ACTIVE = new Set(['pay_queued', 'pay_pending']);
const FROZEN_STATUSES = new Set([
  'pay_pending',
  'pay_expired',
  'recv_queued',
  'recv_partial',
  'recv_pending',
  'done',
  'consumed',
  'blocked',
]);

function round4(v) {
  return Math.round(Number(v) * 10000) / 10000;
}

function sortPoolTxs(txs) {
  return [...txs].sort((a, b) => {
    const bn = (a.blockNumber || 0) - (b.blockNumber || 0);
    if (bn !== 0) return bn;
    const bt = (a.blockTimestamp || 0) - (b.blockTimestamp || 0);
    if (bt !== 0) return bt;
    return String(a.txHash).localeCompare(String(b.txHash));
  });
}

function filterByCheckpoint(txs, cutoffMs) {
  if (cutoffMs == null) return txs;
  return txs.filter((t) => (t.blockTimestamp || 0) <= cutoffMs);
}

function utcDayMs(tsMs) {
  const d = new Date(tsMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function poolConfig(poolId) {
  return POOL_PURCHASE_CONFIG.find((p) => p.id === poolId);
}

function remainingCreditOf(entry) {
  if (!PAY_POOL_ACTIVE.has(entry.status)) return 0;
  return Number(entry.remainingPoolCreditTrx ?? entry.poolCreditTrx ?? 0);
}

function poolLedgerBalance(entries, matchDays = []) {
  const committed = entries
    .filter((e) => !['blocked', 'pay_expired', 'done'].includes(e.status))
    .reduce((s, e) => s + Number(e.poolCreditTrx || 0), 0);
  const consumed = matchDays.reduce((s, d) => s + Number(d.matchedCreditTrx || 0), 0);
  return round4(committed - consumed);
}

/** 买券 tx → 打款池；queueIndexStart 用于增量快照之后的新单 */
function buildEntries(poolId, txs, queueIndexStart = 0) {
  const cfg = poolConfig(poolId);
  const sorted = sortPoolTxs(txs);
  const valid = sorted.filter(
    (tx) => Math.abs(Number(tx.amount) - cfg.ticketPriceTrx) < 0.000001,
  );
  return valid.map((tx, i) => ({
    entryId: tx.txHash,
    poolId,
    payer: tx.fromAddress,
    ticketPaidTrx: Number(tx.amount),
    poolCreditTrx: cfg.poolCreditTrx,
    remainingPoolCreditTrx: cfg.poolCreditTrx,
    exitAmountTrx: cfg.exitAmountTrx,
    blockNumber: tx.blockNumber,
    blockTimestamp: tx.blockTimestamp,
    queueIndex: queueIndexStart + i + 1,
    status: 'pay_queued',
    payAssignments: [],
    recvQueueJoinedAt: null,
    exitRemainderTrx: 0,
  }));
}

function applyLifecycle(entries, blockedPayers = new Set()) {
  const openByPayer = new Map();
  const result = [];
  for (const e of entries) {
    const copy = { ...e };
    if (FROZEN_STATUSES.has(copy.status)) {
      result.push(copy);
      continue;
    }
    if (blockedPayers.has(copy.payer)) {
      copy.status = 'blocked';
      copy.blockReason = '一次只能排一单';
      copy.remainingPoolCreditTrx = 0;
      result.push(copy);
      continue;
    }
    if (openByPayer.has(copy.payer)) {
      copy.status = 'blocked';
      copy.blockReason = '一次只能排一单';
      copy.remainingPoolCreditTrx = 0;
      result.push(copy);
      continue;
    }
    copy.status = 'pay_queued';
    if (copy.remainingPoolCreditTrx == null) {
      copy.remainingPoolCreditTrx = copy.poolCreditTrx;
    }
    openByPayer.set(copy.payer, copy.entryId);
    result.push(copy);
  }
  return result;
}

function mergeEntryStates(freshEntries, stateMap) {
  return freshEntries.map((e) => {
    const prev = stateMap.get(e.entryId);
    if (!prev) return e;
    return {
      ...e,
      status: prev.status,
      remainingPoolCreditTrx: prev.remainingPoolCreditTrx,
      exitRemainderTrx: prev.exitRemainderTrx,
      surplusToTicketTrx: prev.surplusToTicketTrx,
      recvQueueJoinedAt: prev.recvQueueJoinedAt,
      payAssignments: prev.payAssignments || [],
      completedAt: prev.completedAt,
      blockReason: prev.blockReason,
      verifiedMainnetTxId: prev.verifiedMainnetTxId,
    };
  });
}

function poolFillState(poolId, entries, evaluationMs = Date.now(), matchDays = []) {
  const cfg = poolConfig(poolId);
  const credits = poolLedgerBalance(entries, matchDays);
  const queuedCredits = entries
    .filter((e) => PAY_POOL_ACTIVE.has(e.status))
    .reduce((s, e) => s + remainingCreditOf(e), 0);
  const active = entries.filter((e) => !['blocked', 'pay_expired', 'done'].includes(e.status));
  const firstTs = active.length
    ? Math.min(...active.map((e) => e.blockTimestamp || evaluationMs))
    : null;
  const minFillMs = ENTRY_PERIOD_DAYS * MS_DAY;
  const full = cfg ? credits >= cfg.poolTargetTrx : false;
  const days = firstTs != null ? Math.floor((evaluationMs - firstTs) / MS_DAY) : 0;
  const entryOk = firstTs != null && evaluationMs >= firstTs + minFillMs;

  return {
    poolId,
    totalPoolCreditTrx: credits,
    queuedPoolCreditTrx: queuedCredits,
    recvPoolCount: entries.filter((e) =>
      ['recv_queued', 'recv_partial', 'recv_pending'].includes(e.status),
    ).length,
    targetTrx: cfg?.poolTargetTrx ?? 0,
    entryCount: entries.filter((e) => PAY_POOL_ACTIVE.has(e.status)).length,
    consumedPoolCreditTrx: matchDays.reduce((s, d) => s + Number(d.matchedCreditTrx || 0), 0),
    isFull: full,
    fillPercent: cfg ? Math.min(100, (credits / cfg.poolTargetTrx) * 100) : 0,
    entryPeriodDays: ENTRY_PERIOD_DAYS,
    daysSinceFirstEntry: days,
    entryPeriodSatisfied: entryOk,
    overflowPoolCreditTrx: cfg ? round4(Math.max(0, credits - cfg.poolTargetTrx)) : 0,
    canMatch: full && entryOk && (cfg ? credits - cfg.poolTargetTrx > 0.000001 : false),
    firstEntryTimestamp: firstTs,
    ticketPriceTrx: cfg?.ticketPriceTrx,
    poolCreditPerTicket: cfg?.poolCreditTrx,
    evaluatedAtMs: evaluationMs,
  };
}

function selectPayPoolPayers(payQueued, overflowAmount) {
  const payers = [];
  let sum = 0;
  for (let i = payQueued.length - 1; i >= 0 && sum + 0.000001 < overflowAmount; i -= 1) {
    const e = payQueued[i];
    const credit = remainingCreditOf(e);
    payers.unshift({
      entryId: e.entryId,
      payer: e.payer,
      availableTrx: credit,
      splitCount: 0,
    });
    sum = round4(sum + credit);
  }
  return { payers, totalSelected: sum };
}

function recvPoolOrder(entries) {
  return entries
    .filter((e) => e.status === 'recv_queued' || e.status === 'recv_partial')
    .sort((a, b) => {
      const ta = a.recvQueueJoinedAt || a.blockTimestamp || 0;
      const tb = b.recvQueueJoinedAt || b.blockTimestamp || 0;
      if (ta !== tb) return ta - tb;
      return a.queueIndex - b.queueIndex;
    });
}

function buildPayInAssignments(poolId, payers, exitPoolAddress, matchAtMs, matchDayId) {
  const deadlineMs = matchAtMs + MATCH_PAYMENT_TIMEOUT_HOURS * 3600 * 1000;
  const assignments = [];
  for (const p of payers) {
    if (p.availableTrx <= 0.000001) continue;
    const id = `pay_${matchDayId}_${p.entryId}`;
    assignments.push({
      assignmentId: id,
      poolId,
      channel: PAY_IN_CHANNEL,
      payer: p.payer,
      payerEntryId: p.entryId,
      collectorAddress: exitPoolAddress,
      amountTrx: round4(p.availableTrx),
      matchDayId,
      matchAtMs,
      deadlineMs,
      purpose: 'pay_pool_to_exit',
    });
  }
  return assignments;
}

function buildRecvPhase(poolId, entries, overflow, exitAmount, exitPoolAddress, matchDayId, matchAtMs) {
  const partialEntries = entries
    .filter((e) => e.status === 'recv_partial')
    .sort((a, b) => (a.recvQueueJoinedAt || 0) - (b.recvQueueJoinedAt || 0));

  const partialNeed = partialEntries.reduce(
    (s, e) => s + Number(e.exitRemainderTrx || exitAmount),
    0,
  );
  const overflowForNew = round4(Math.max(0, overflow - partialNeed));
  const fullNewCount = Math.floor(overflowForNew / exitAmount);
  const remainderTrx = round4(overflowForNew - fullNewCount * exitAmount);

  const recvQueued = recvPoolOrder(entries).filter((e) => e.status === 'recv_queued');
  const partialIds = new Set(partialEntries.map((e) => e.entryId));
  const newCandidates = recvQueued.filter((e) => !partialIds.has(e.entryId));
  const fullNewEntries = newCandidates.slice(0, fullNewCount);
  const partialNewEntries =
    remainderTrx > 0.000001 && newCandidates.length > fullNewCount
      ? [newCandidates[fullNewCount]]
      : [];

  const ticketRemainderTrx =
    remainderTrx > 0.000001 && partialNewEntries.length === 0 ? remainderTrx : 0;

  const receivers = [];
  partialEntries.forEach((e, idx) => {
    receivers.push({
      slotId: `recv_${e.entryId}`,
      entryId: e.entryId,
      beneficiary: e.payer,
      collectorAddress: exitPoolAddress,
      needTrx: e.exitRemainderTrx ?? exitAmount,
      remainingTrx: e.exitRemainderTrx ?? exitAmount,
      queueIndex: idx + 1,
      isPartialCarryover: true,
    });
  });
  fullNewEntries.forEach((e, idx) => {
    receivers.push({
      slotId: `recv_${e.entryId}`,
      entryId: e.entryId,
      beneficiary: e.payer,
      collectorAddress: exitPoolAddress,
      needTrx: exitAmount,
      remainingTrx: exitAmount,
      queueIndex: partialEntries.length + idx + 1,
      isPartialCarryover: false,
    });
  });
  partialNewEntries.forEach((e, idx) => {
    receivers.push({
      slotId: `recv_${e.entryId}`,
      entryId: e.entryId,
      beneficiary: e.payer,
      collectorAddress: exitPoolAddress,
      needTrx: exitAmount,
      remainingTrx: exitAmount,
      queueIndex: partialEntries.length + fullNewEntries.length + idx + 1,
      isPartialCarryover: false,
      isRemainderSlot: true,
      remainderBudgetTrx: remainderTrx,
    });
  });

  const assignments = receivers.map((recv) => {
    const paidTrx = round4(recv.needTrx - recv.remainingTrx);
    const amountTrx = recv.remainingTrx;
    return {
      assignmentId: `recv_${matchDayId}_${recv.entryId}`,
      poolId,
      channel: RECV_OUT_CHANNEL,
      beneficiary: recv.beneficiary,
      beneficiaryEntryId: recv.entryId,
      collectorAddress: exitPoolAddress,
      amountTrx: round4(amountTrx),
      exitAmountTrx: exitAmount,
      matchDayId,
      matchAtMs,
      receiverSlotId: recv.slotId,
      isPartialCarryover: recv.isPartialCarryover,
      isRemainderSlot: recv.isRemainderSlot || false,
      remainderBudgetTrx: recv.remainderBudgetTrx,
    };
  });

  return {
    receivers,
    assignments,
    receiverCount: receivers.length,
    remainderTrx,
    remainderToReceiverTrx: partialNewEntries.length ? remainderTrx : 0,
    ticketRemainderTrx,
  };
}

function buildTicketRemainderAssignments(poolId, ticketRemainderTrx, payers, purchaseAddress, matchDayId) {
  if (ticketRemainderTrx <= 0.000001) return [];
  const assignments = [];
  let left = ticketRemainderTrx;
  for (const payer of payers || []) {
    if (left <= 0.000001) break;
    const chunk = Math.min(payer.availableTrx || 0, left);
    if (chunk <= 0.000001) continue;
    assignments.push({
      assignmentId: `remainder_${matchDayId}_${payer.entryId}_${assignments.length}`,
      poolId,
      channel: TICKET_SURPLUS_CHANNEL,
      payer: payer.payer,
      payerEntryId: payer.entryId,
      collectorAddress: purchaseAddress,
      amountTrx: round4(chunk),
      matchDayId,
      purpose: 'overflow_remainder_to_ticket',
    });
    left = round4(left - chunk);
  }
  return assignments;
}

/** 主网验款：pay_pending → recv_queued；超时 → pay_expired */
function applyPayVerifications(entries, exitPoolTxs, exitPoolAddress, evaluationMs, usedExitTxIds) {
  const entryMap = new Map(entries.map((e) => [e.entryId, e]));
  const pendingAssigns = [];
  const used = usedExitTxIds || new Set();
  for (const e of entries) {
    if (e.status === 'pay_pending' && (e.payAssignments || []).length) {
      pendingAssigns.push(...e.payAssignments);
    }
    if (e.verifiedMainnetTxId) used.add(e.verifiedMainnetTxId);
  }
  if (!pendingAssigns.length) return { entries, verified: [], expired: [], usedExitTxIds: used };

  const { verified, expired, usedTxIds } = derivePayVerifications(
    pendingAssigns,
    exitPoolTxs,
    exitPoolAddress,
    evaluationMs,
    [...used],
  );

  for (const id of usedTxIds) used.add(id);

  for (const v of verified) {
    const e = entryMap.get(v.entryId);
    if (!e) continue;
    e.status = 'recv_queued';
    e.recvQueueJoinedAt = v.verifiedAtMs;
    e.verifiedMainnetTxId = v.mainnetTxId;
    e.remainingPoolCreditTrx = 0;
    e.payAssignments = [];
    e.completedAt = null;
    used.add(v.mainnetTxId);
  }
  for (const x of expired) {
    const e = entryMap.get(x.entryId);
    if (!e) continue;
    e.status = 'pay_expired';
    e.remainingPoolCreditTrx = 0;
    e.payAssignments = [];
    e.blockReason = '出场打款超时';
  }
  return { entries, verified, expired, usedExitTxIds: used };
}

function applyPayInTasks(entries, payAssignments) {
  const entryMap = new Map(entries.map((e) => [e.entryId, e]));
  const byEntry = new Map();
  for (const a of payAssignments) {
    const list = byEntry.get(a.payerEntryId) || [];
    list.push(a);
    byEntry.set(a.payerEntryId, list);
  }
  for (const [entryId, assigns] of byEntry) {
    const e = entryMap.get(entryId);
    if (!e || e.status !== 'pay_queued') continue;
    e.status = 'pay_pending';
    e.payAssignments = assigns;
    e.payDeadlineMs = Math.max(...assigns.map((x) => x.deadlineMs || 0));
  }
  return entries;
}

function applyRecvConsumption(entries, recvSplit, exitAmount) {
  const entryMap = new Map(entries.map((e) => [e.entryId, e]));
  for (const recv of recvSplit.receivers || []) {
    const e = entryMap.get(recv.entryId);
    if (!e) continue;
    if (recv.isRemainderSlot && recv.remainderBudgetTrx > 0.000001) {
      e.status = 'recv_partial';
      e.exitRemainderTrx = round4(exitAmount - recv.remainderBudgetTrx);
    } else if (recv.isPartialCarryover) {
      e.status = 'recv_partial';
      e.exitRemainderTrx = round4(Math.max(0, (e.exitRemainderTrx || exitAmount) - recv.needTrx));
      if (e.exitRemainderTrx <= 0.000001) {
        e.status = 'recv_pending';
        e.exitRemainderTrx = 0;
      }
    } else {
      e.status = 'recv_pending';
      e.exitRemainderTrx = 0;
    }
  }
  return entries;
}

function buildDayMatch(poolId, entries, evaluationMs, matchDays) {
  const cfg = poolConfig(poolId);
  const exitPoolAddress = exitPoolAddressFor(cfg);
  const fill = poolFillState(poolId, entries, evaluationMs, matchDays);
  const overflow = fill.overflowPoolCreditTrx || 0;
  const empty = {
    fill,
    payAssignments: [],
    recvAssignments: [],
    ticketSurplusAssignments: [],
    matchedCreditTrx: 0,
    overflowPoolCreditTrx: overflow,
    receiverCount: 0,
    payers: [],
    receivers: [],
    exitPoolAddress,
    purchaseAddress: cfg.purchaseAddress,
  };
  if (!fill.canMatch || overflow <= 0.000001) return empty;

  const matchDayId = new Date(evaluationMs).toISOString().slice(0, 10);
  const payQueued = entries
    .filter((e) => e.status === 'pay_queued')
    .sort((a, b) => a.queueIndex - b.queueIndex);

  const { payers } = selectPayPoolPayers(payQueued, overflow);
  const payAssignments = buildPayInAssignments(
    poolId,
    payers,
    exitPoolAddress,
    evaluationMs,
    matchDayId,
  );

  const recvSplit = buildRecvPhase(
    poolId,
    entries,
    overflow,
    cfg.exitAmountTrx,
    exitPoolAddress,
    matchDayId,
    evaluationMs,
  );

  const ticketSurplusAssignments = buildTicketRemainderAssignments(
    poolId,
    recvSplit.ticketRemainderTrx,
    payers,
    cfg.purchaseAddress,
    matchDayId,
  );

  const deployedTrx = round4(
    payAssignments.reduce((s, a) => s + a.amountTrx, 0) +
      ticketSurplusAssignments.reduce((s, a) => s + a.amountTrx, 0),
  );

  return {
    fill,
    payAssignments,
    recvAssignments: recvSplit.assignments,
    ticketSurplusAssignments,
    matchedCreditTrx: deployedTrx > 0.000001 ? deployedTrx : round4(overflow),
    overflowPoolCreditTrx: overflow,
    receiverCount: recvSplit.receiverCount,
    remainderTrx: recvSplit.remainderTrx,
    remainderToReceiverTrx: recvSplit.remainderToReceiverTrx,
    ticketRemainderTrx: recvSplit.ticketRemainderTrx,
    payers,
    receivers: recvSplit.receivers,
    exitPoolAddress,
    purchaseAddress: cfg.purchaseAddress,
  };
}

function runDayMatch(
  poolId,
  purchaseTxs,
  exitPoolTxs,
  stateMap,
  dayStartMs,
  priorMatchDays = [],
  verifyThroughMs = null,
  replayCtx = null,
) {
  const verifyMs = verifyThroughMs != null ? verifyThroughMs : dayStartMs + MS_DAY;
  const incrementalFromMs = replayCtx?.incrementalFromMs || 0;
  const blockedPayers = replayCtx?.blockedPayers || new Set();
  const usedExitTxIds = replayCtx?.usedExitTxIds || new Set();
  const lastQueueIndex = replayCtx?.lastQueueIndex || 0;

  let entries;
  if (incrementalFromMs > 0) {
    const newBuys = purchaseTxs.filter(
      (t) => (t.blockTimestamp || 0) > incrementalFromMs && (t.blockTimestamp || 0) <= dayStartMs,
    );
    const fresh = buildEntries(poolId, newBuys, lastQueueIndex);
    entries = mergeEntryStates(fresh, stateMap);
    if (replayCtx) {
      for (const e of entries) {
        if (e.queueIndex > replayCtx.lastQueueIndex) replayCtx.lastQueueIndex = e.queueIndex;
      }
    }
  } else {
    const dayPurchase = filterByCheckpoint(purchaseTxs, dayStartMs);
    entries = mergeEntryStates(buildEntries(poolId, dayPurchase), stateMap);
  }

  entries = applyLifecycle(entries, blockedPayers);
  const dayExit = filterByCheckpoint(exitPoolTxs, verifyMs);

  const cfg = poolConfig(poolId);
  const exitPoolAddress = exitPoolAddressFor(cfg);

  const verifyResult = applyPayVerifications(entries, dayExit, exitPoolAddress, verifyMs, usedExitTxIds);
  entries = verifyResult.entries;
  if (replayCtx && verifyResult.usedExitTxIds) {
    replayCtx.usedExitTxIds = verifyResult.usedExitTxIds;
  }
  for (const e of entries) {
    stateMap.set(e.entryId, e);
    if (e.status === 'blocked' && e.payer) blockedPayers.add(e.payer);
    if (e.queueIndex > (replayCtx?.lastQueueIndex || 0)) {
      if (replayCtx) replayCtx.lastQueueIndex = e.queueIndex;
    }
  }

  const fill = poolFillState(poolId, entries, dayStartMs, priorMatchDays);
  if (!fill.canMatch) return null;

  const split = buildDayMatch(poolId, entries, dayStartMs, priorMatchDays);
  if (!split.payAssignments.length && !split.recvAssignments.length) return null;

  applyPayInTasks(entries, split.payAssignments);
  applyRecvConsumption(entries, split, poolConfig(poolId).exitAmountTrx);

  for (const e of entries) stateMap.set(e.entryId, e);

  return {
    entries,
    split,
    summary: {
      matchDayId: new Date(dayStartMs).toISOString().slice(0, 10),
      matchedCreditTrx: split.matchedCreditTrx,
      remainingPoolCreditTrx: poolFillState(poolId, entries, dayStartMs, [
        ...priorMatchDays,
        { matchedCreditTrx: split.matchedCreditTrx },
      ]).totalPoolCreditTrx,
    },
  };
}

function replayPoolTimeline(poolId, purchaseTxs, exitPoolTxs, wallNowMs, snapshot = null) {
  const cfg = poolConfig(poolId);
  const sortedPurchase = sortPoolTxs(purchaseTxs);
  const exitPoolAddress = exitPoolAddressFor(cfg);

  let stateMap = new Map();
  let matchDays = [];
  let replayCtx = null;
  let loopStartDay;

  if (snapshot) {
    const loaded = loadSnapshot(snapshot);
    if (loaded && snapshot.poolId !== poolId) {
      throw new Error(`snapshot poolId ${snapshot.poolId} != ${poolId}`);
    }
    stateMap = loaded.stateMap;
    matchDays = loaded.matchDays;
    replayCtx = {
      incrementalFromMs: loaded.incrementalFromMs,
      blockedPayers: loaded.blockedPayers,
      usedExitTxIds: loaded.usedExitTxIds,
      lastQueueIndex: loaded.lastQueueIndex,
    };
    loopStartDay = loaded.lastMatchDayMs > 0 ? loaded.lastMatchDayMs + MS_DAY : utcDayMs(wallNowMs);
    purchaseTxs = sortedPurchase;
    exitPoolTxs = exitPoolTxs || [];
  } else if (!sortedPurchase.length) {
    const entries = [];
    const emptySnap = exportPoolSnapshot(poolId, stateMap, matchDays, wallNowMs, {
      blockedPayers: [],
      usedExitTxIds: [],
    });
    return {
      entries,
      fill: poolFillState(poolId, entries, wallNowMs),
      payAssignments: [],
      recvAssignments: [],
      assignments: [],
      ticketSurplusAssignments: [],
      matchedCreditTrx: 0,
      matchDays,
      exitPoolAddress,
      purchaseAddress: cfg.purchaseAddress,
      snapshot: emptySnap,
      replayMode: 'full',
    };
  } else {
    const firstTs = Math.min(...sortedPurchase.map((t) => t.blockTimestamp || wallNowMs));
    loopStartDay = utcDayMs(firstTs + ENTRY_PERIOD_DAYS * MS_DAY);
    replayCtx = {
      incrementalFromMs: 0,
      blockedPayers: new Set(),
      usedExitTxIds: new Set(),
      lastQueueIndex: 0,
    };
  }

  const endDay = utcDayMs(wallNowMs);

  for (let dayMs = loopStartDay; dayMs < endDay; dayMs += MS_DAY) {
    const result = runDayMatch(
      poolId,
      purchaseTxs,
      exitPoolTxs,
      stateMap,
      dayMs,
      matchDays,
      dayMs + MS_DAY,
      replayCtx,
    );
    if (result) matchDays.push(result.summary);
  }

  const todayResult = runDayMatch(
    poolId,
    purchaseTxs,
    exitPoolTxs,
    stateMap,
    endDay,
    matchDays,
    wallNowMs,
    replayCtx,
  );
  if (todayResult) matchDays.push(todayResult.summary);

  const newBuysFinal = replayCtx?.incrementalFromMs > 0
    ? filterTxsAfter(sortedPurchase, replayCtx.incrementalFromMs).filter((t) => (t.blockTimestamp || 0) <= wallNowMs)
    : [];
  if (newBuysFinal.length && replayCtx) {
    const fresh = buildEntries(poolId, newBuysFinal, replayCtx.lastQueueIndex);
    const merged = mergeEntryStates(fresh, stateMap);
    const lifecycled = applyLifecycle(merged, replayCtx.blockedPayers);
    for (const e of lifecycled) {
      stateMap.set(e.entryId, e);
      if (e.queueIndex > replayCtx.lastQueueIndex) replayCtx.lastQueueIndex = e.queueIndex;
    }
  }

  let entries = [...stateMap.values()].sort((a, b) => a.queueIndex - b.queueIndex);
  const verifyResult = applyPayVerifications(
    entries,
    filterByCheckpoint(exitPoolTxs, wallNowMs),
    exitPoolAddress,
    wallNowMs,
    replayCtx?.usedExitTxIds,
  );
  entries = verifyResult.entries;
  if (replayCtx && verifyResult.usedExitTxIds) replayCtx.usedExitTxIds = verifyResult.usedExitTxIds;
  for (const e of entries) stateMap.set(e.entryId, e);

  const fill = poolFillState(poolId, entries, wallNowMs, matchDays);
  const split = todayResult?.split;
  const payAssignments =
    split?.payAssignments ||
    entries.flatMap((e) => (e.status === 'pay_pending' ? e.payAssignments || [] : []));
  const recvAssignments = split?.recvAssignments || [];

  const exportedSnapshot = exportPoolSnapshot(poolId, stateMap, matchDays, wallNowMs, {
    blockedPayers: replayCtx?.blockedPayers,
    usedExitTxIds: replayCtx?.usedExitTxIds,
  });

  return {
    entries,
    fill,
    payAssignments,
    recvAssignments,
    assignments: [...payAssignments, ...recvAssignments],
    ticketSurplusAssignments: split?.ticketSurplusAssignments || [],
    matchedCreditTrx: split?.matchedCreditTrx || 0,
    overflowPoolCreditTrx: split?.overflowPoolCreditTrx || 0,
    receiverCount: split?.receiverCount || 0,
    remainderTrx: split?.remainderTrx || 0,
    matchDays,
    payers: split?.payers || [],
    receivers: split?.receivers || [],
    exitPoolAddress,
    purchaseAddress: cfg.purchaseAddress,
    snapshot: exportedSnapshot,
    replayMode: snapshot ? 'incremental' : 'full',
    archivedEntryCount: exportedSnapshot.archivedEntryCount,
    activeEntryCount: exportedSnapshot.activeEntries.length,
  };
}

function runPoolCycle(input) {
  const {
    poolId,
    txs = [],
    purchaseTxs,
    exitPoolTxs = [],
    nowMs = Date.now(),
    snapshot = null,
  } = input;

  const buyTxs = purchaseTxs || txs;
  const cutoff = checkpointCutoffMs(nowMs);
  const matchCtx = dailyMatchContext(nowMs);
  const replay = replayPoolTimeline(poolId, buyTxs, exitPoolTxs, nowMs, snapshot);

  return {
    poolId,
    checkpointCutoffMs: cutoff,
    entries: replay.entries,
    fill: replay.fill,
    payAssignments: replay.payAssignments,
    recvAssignments: replay.recvAssignments,
    assignments: replay.assignments,
    ticketSurplusAssignments: replay.ticketSurplusAssignments,
    matchedCreditTrx: replay.matchedCreditTrx,
    overflowPoolCreditTrx: replay.overflowPoolCreditTrx,
    receiverCount: replay.receiverCount,
    remainderTrx: replay.remainderTrx,
    matchDays: replay.matchDays,
    payers: replay.payers,
    receivers: replay.receivers,
    exitPoolAddress: replay.exitPoolAddress,
    purchaseAddress: replay.purchaseAddress,
    snapshot: replay.snapshot,
    replayMode: replay.replayMode,
    archivedEntryCount: replay.archivedEntryCount,
    activeEntryCount: replay.activeEntryCount,
    ...matchCtx,
  };
}

function runAllPools(input) {
  const {
    txsByPool = {},
    purchaseTxsByPool,
    exitPoolTxsByPool = {},
    snapshotsByPool = {},
    nowMs = Date.now(),
  } = input;
  const pools = {};
  for (const cfg of POOL_PURCHASE_CONFIG) {
    pools[cfg.id] = runPoolCycle({
      poolId: cfg.id,
      purchaseTxs: (purchaseTxsByPool || txsByPool)[cfg.id] || [],
      exitPoolTxs: exitPoolTxsByPool[cfg.id] || [],
      snapshot: snapshotsByPool[cfg.id] || null,
      nowMs,
    });
  }
  return pools;
}

function findUserAssignments(pools, userAddress) {
  if (!userAddress) {
    return { asPayer: [], asBeneficiary: [], asTicketSurplusPayer: [], payIn: [], recvOut: [] };
  }
  const asPayer = [];
  const asBeneficiary = [];
  const asTicketSurplusPayer = [];
  const payIn = [];
  const recvOut = [];
  for (const p of Object.values(pools)) {
    for (const a of p.payAssignments || []) {
      if (a.payer === userAddress) {
        asPayer.push(a);
        payIn.push(a);
      }
    }
    for (const a of p.recvAssignments || []) {
      if (a.beneficiary === userAddress) {
        asBeneficiary.push(a);
        recvOut.push(a);
      }
    }
    for (const a of p.assignments || []) {
      if (a.channel === PAY_IN_CHANNEL && a.payer === userAddress && !payIn.includes(a)) payIn.push(a);
      if (a.channel === RECV_OUT_CHANNEL && a.beneficiary === userAddress && !recvOut.includes(a)) {
        recvOut.push(a);
      }
      if (a.payer === userAddress) asPayer.push(a);
      if (a.beneficiary === userAddress) asBeneficiary.push(a);
    }
    for (const a of p.ticketSurplusAssignments || []) {
      if (a.payer === userAddress) asTicketSurplusPayer.push(a);
    }
  }
  return { asPayer, asBeneficiary, asTicketSurplusPayer, payIn, recvOut };
}

module.exports = {
  sortPoolTxs,
  filterByCheckpoint,
  buildEntries,
  applyLifecycle,
  remainingCreditOf,
  poolLedgerBalance,
  poolFillState,
  buildDayMatch,
  applyPayVerifications,
  applyPayInTasks,
  applyRecvConsumption,
  replayPoolTimeline,
  runPoolCycle,
  runAllPools,
  findUserAssignments,
  PAY_IN_CHANNEL,
  RECV_OUT_CHANNEL,
  TICKET_SURPLUS_CHANNEL,
  exportPoolSnapshot,
  loadSnapshot,
};
