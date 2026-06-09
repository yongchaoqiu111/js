/**
 * TronGrid 拉取买券/出场池入账（与 Client pool_matcher_service.dart 对齐）
 */
const TRONGRID = process.env.TRONGRID_API || 'https://api.trongrid.io';

function trongridHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.TRONGRID_API_KEY) {
    headers['TRON-PRO-API-KEY'] = process.env.TRONGRID_API_KEY;
  }
  return headers;
}

function normalizeTronAddress(addr) {
  if (!addr) return '';
  const s = String(addr).trim();
  if (s.startsWith('T')) return s;
  return s;
}

function parseTransferTxs(rawList) {
  const out = [];
  for (const tx of rawList) {
    try {
      const rawData = tx.raw_data || tx.rawData;
      const contracts = rawData?.contract;
      if (!contracts?.length) continue;
      const contract = contracts[0];
      if (contract.type !== 'TransferContract') continue;
      const value = contract.parameter?.value;
      if (!value) continue;
      const amountSun = value.amount;
      const fromAddress = value.owner_address;
      const toAddress = value.to_address;
      const txHash = tx.txID || tx.txId;
      const blockTimestamp = tx.block_timestamp ?? tx.blockTimestamp;
      if (amountSun == null || !fromAddress || !txHash || blockTimestamp == null) continue;
      out.push({
        txHash,
        fromAddress: normalizeTronAddress(fromAddress),
        toAddress: toAddress ? normalizeTronAddress(toAddress) : null,
        amount: Number(amountSun) / 1e6,
        blockTimestamp: Number(blockTimestamp),
        blockNumber: tx.blockNumber ?? tx.block_number ?? null,
      });
    } catch (_) {}
  }
  return out;
}

async function fetchAccountTransactions(address, { minTimestamp = null, maxPages = 20 } = {}) {
  const all = [];
  let fingerprint = null;
  const headers = trongridHeaders();

  for (let page = 0; page < maxPages; page += 1) {
    const params = new URLSearchParams({
      only_to: 'true',
      limit: '200',
      order_by: 'block_timestamp,asc',
    });
    if (minTimestamp != null && minTimestamp > 0) {
      params.set('min_timestamp', String(minTimestamp));
    }
    if (fingerprint) params.set('fingerprint', fingerprint);

    const url = `${TRONGRID}/v1/accounts/${address}/transactions?${params}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(60000) });
    if (res.status === 429) {
      throw new Error('TronGrid 429 限流，请配置 TRONGRID_API_KEY');
    }
    if (!res.ok) {
      throw new Error(`TronGrid ${address} HTTP ${res.status}`);
    }
    const body = await res.json();
    const batch = body.data || [];
    all.push(...batch);
    fingerprint = body.meta?.fingerprint;
    if (!fingerprint || batch.length === 0) break;
  }
  return all;
}

function filterEntryTxs(transfers, ticketPriceTrx) {
  return transfers.filter((t) => Math.abs(t.amount - ticketPriceTrx) < 0.000001);
}

function filterExitPoolTxs(transfers, ticketPriceTrx) {
  return transfers.filter((t) => Math.abs(t.amount - ticketPriceTrx) > 0.000001);
}

module.exports = {
  fetchAccountTransactions,
  parseTransferTxs,
  filterEntryTxs,
  filterExitPoolTxs,
};
