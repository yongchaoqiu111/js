/**
 * 从 TRON 主网拉取最新块，供 node1 发布统一 checkpoint
 */
const TRONGRID = process.env.TRONGRID_API || 'https://api.trongrid.io';

async function fetchLatestTronBlock() {
  const headers = {};
  if (process.env.TRONGRID_API_KEY) {
    headers['TRON-PRO-API-KEY'] = process.env.TRONGRID_API_KEY;
  }
  const res = await fetch(`${TRONGRID}/wallet/getnowblock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`TronGrid getnowblock HTTP ${res.status}`);
  const body = await res.json();
  const raw = body.block_header?.raw_data;
  if (!raw?.number) throw new Error('TronGrid block missing number');
  const blockID = body.blockID || '';
  return {
    blockNumber: raw.number,
    blockTimestamp: raw.timestamp,
    blockHash: blockID,
  };
}

module.exports = { fetchLatestTronBlock };
