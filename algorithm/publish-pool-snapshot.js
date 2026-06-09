#!/usr/bin/env node
/**
 * pool-v4 官方快照发布（独立仓库 mmm-pool-snapshot）
 *
 * 用法（仓库根目录）:
 *   npm install
 *   TRONGRID_API_KEY=xxx npm run publish
 *
 * 环境变量见仓库根目录 .env.example
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { fetchLatestTronBlock } = require('./checkpoint-tron');
const {
  POOL_RULES_VERSION,
  POOL_PURCHASE_CONFIG,
  checkpointCutoffMs,
  dailyMatchContext,
  exitPoolAddressFor,
} = require('./pool-config');
const { runAllPools } = require('./pool-rules');
const {
  fetchAccountTransactions,
  parseTransferTxs,
  filterEntryTxs,
  filterExitPoolTxs,
} = require('./trongrid-pool-fetch');

function parseArgs() {
  const args = process.argv.slice(2);
  let outDir = path.join(__dirname, '..', 'public');
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--out' && args[i + 1]) {
      outDir = path.resolve(args[i + 1]);
      i += 1;
    }
  }
  return { outDir };
}

function dedupeTxs(txs) {
  const seen = new Set();
  const out = [];
  for (const t of txs) {
    if (seen.has(t.txHash)) continue;
    seen.add(t.txHash);
    out.push(t);
  }
  out.sort((a, b) => {
    const bn = (a.blockNumber || 0) - (b.blockNumber || 0);
    if (bn !== 0) return bn;
    return a.blockTimestamp - b.blockTimestamp;
  });
  return out;
}

async function loadMergedTransfers(address, cachePath) {
  let cached = [];
  if (fs.existsSync(cachePath)) {
    try {
      cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    } catch (_) {
      cached = [];
    }
  }
  let minTs = null;
  if (cached.length > 0) {
    minTs = Math.max(...cached.map((t) => t.blockTimestamp)) + 1;
  }
  const raw = await fetchAccountTransactions(address, { minTimestamp: minTs });
  const fetched = parseTransferTxs(raw);
  const merged = dedupeTxs([...cached, ...fetched]);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(merged));
  return merged;
}

function serializePoolForPublish(r) {
  return {
    poolId: r.poolId,
    checkpointCutoffMs: r.checkpointCutoffMs,
    fill: r.fill,
    entries: r.entries,
    assignments: r.assignments,
    ticketSurplusAssignments: r.ticketSurplusAssignments || [],
    collectorMode: 'exit_pool',
    purchaseAddress: r.purchaseAddress,
    matchDayId: r.matchDayId,
    matchAtMs: r.matchAtMs,
    nextMatchAtMs: r.nextMatchAtMs,
    matchedCreditTrx: r.matchedCreditTrx,
    overflowPoolCreditTrx: r.overflowPoolCreditTrx,
    receiverCount: r.receiverCount,
    remainderTrx: r.remainderTrx,
    remainderToReceiverTrx: r.remainderToReceiverTrx,
    ticketRemainderTrx: r.ticketRemainderTrx,
    exitPoolAddress: r.exitPoolAddress,
    payAssignments: r.payAssignments,
    recvAssignments: r.recvAssignments,
    replayMode: r.replayMode,
    recvPoolCount: r.receiverCount,
    snapshot: r.snapshot,
  };
}

function buildSummary(pools) {
  const summary = {};
  for (const [id, p] of Object.entries(pools)) {
    const entries = p.entries || [];
    summary[id] = {
      payPending: entries.filter((e) => e.status === 'pay_pending').length,
      recvQueued: entries.filter((e) => e.status === 'recv_queued').length,
      recvPartial: entries.filter((e) => e.status === 'recv_partial').length,
      payExpired: entries.filter((e) => e.status === 'pay_expired').length,
      entryCount: entries.length,
      canMatch: p.fill?.canMatch ?? false,
      overflowPoolCreditTrx: p.overflowPoolCreditTrx ?? 0,
    };
  }
  return summary;
}

function contentHash(payload) {
  const canonical = JSON.stringify(payload);
  return `sha256:${crypto.createHash('sha256').update(canonical).digest('hex')}`;
}

async function main() {
  const { outDir } = parseArgs();
  const nowMs = process.env.SNAPSHOT_NOW_MS
    ? Number(process.env.SNAPSHOT_NOW_MS)
    : Date.now();

  const block = await fetchLatestTronBlock();
  const matchCtx = dailyMatchContext(nowMs);
  const cutoff = checkpointCutoffMs(nowMs);

  const repoRoot = path.join(__dirname, '..');
  const cacheDir = path.join(repoRoot, '.cache');
  const purchaseByPool = {};
  const exitByPool = {};
  const snapshotsByPool = {};

  const prevPath = path.join(outDir, 'snapshot.json');
  if (fs.existsSync(prevPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(prevPath, 'utf8'));
      for (const [id, p] of Object.entries(prev.pools || {})) {
        if (p.snapshot) snapshotsByPool[id] = p.snapshot;
      }
    } catch (_) {}
  }

  for (const tier of POOL_PURCHASE_CONFIG) {
    const purchaseCache = path.join(cacheDir, `purchase_${tier.id}.json`);
    const transfers = await loadMergedTransfers(tier.purchaseAddress, purchaseCache);
    purchaseByPool[tier.id] = filterEntryTxs(transfers, tier.ticketPriceTrx);

    const exitAddr = exitPoolAddressFor(tier);
    if (exitAddr && exitAddr !== tier.purchaseAddress) {
      const exitCache = path.join(cacheDir, `exit_${tier.id}.json`);
      const exitTransfers = await loadMergedTransfers(exitAddr, exitCache);
      exitByPool[tier.id] = filterExitPoolTxs(exitTransfers, tier.ticketPriceTrx);
    } else {
      exitByPool[tier.id] = filterExitPoolTxs(transfers, tier.ticketPriceTrx);
    }
  }

  const rawPools = runAllPools({
    purchaseTxsByPool: purchaseByPool,
    exitPoolTxsByPool: exitByPool,
    snapshotsByPool,
    nowMs,
  });

  const pools = {};
  for (const [id, r] of Object.entries(rawPools)) {
    pools[id] = serializePoolForPublish(r);
  }

  const bodyForHash = {
    rulesVersion: POOL_RULES_VERSION,
    matchDayId: matchCtx.matchDayId,
    checkpointCutoffMs: cutoff,
    tronBlock: {
      number: block.blockNumber,
      timestamp: block.blockTimestamp,
      hash: block.blockHash,
    },
    pools,
  };

  const snapshot = {
    ok: true,
    rulesVersion: POOL_RULES_VERSION,
    scheme: 'A',
    matchDayId: matchCtx.matchDayId,
    checkpointCutoffMs: cutoff,
    matchAtMs: matchCtx.matchAtMs,
    nextMatchAtMs: matchCtx.nextMatchAtMs,
    publishedAt: nowMs,
    tronBlock: bodyForHash.tronBlock,
    purchaseAddresses: POOL_PURCHASE_CONFIG.map((t) => ({
      poolId: t.id,
      purchaseAddress: t.purchaseAddress,
      exitPoolAddress: exitPoolAddressFor(t),
      ticketPriceTrx: t.ticketPriceTrx,
    })),
    summary: buildSummary(pools),
    pools,
    contentHash: contentHash(bodyForHash),
  };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'snapshot.json'), JSON.stringify(snapshot, null, 2));

  const manifest = {
    ok: true,
    rulesVersion: POOL_RULES_VERSION,
    matchDayId: matchCtx.matchDayId,
    checkpointCutoffMs: cutoff,
    publishedAt: nowMs,
    tronBlockNumber: block.blockNumber,
    tronBlockTimestamp: block.blockTimestamp,
    contentHash: snapshot.contentHash,
    snapshotUrl: '/snapshot.json',
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log('OK publish-pool-snapshot', {
    outDir,
    matchDayId: matchCtx.matchDayId,
    tronBlock: block.blockNumber,
    contentHash: snapshot.contentHash,
    pools: Object.keys(pools),
  });
}

main().catch((e) => {
  console.error('FAIL publish-pool-snapshot:', e.message);
  process.exit(1);
});
