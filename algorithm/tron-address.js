const bs58check = require('bs58check');

/** TRON Base58 (T…) 或链上 hex (41…) 地址归一化 */
function tronBase58ToHex(address) {
  if (!address || typeof address !== 'string') return null;
  const raw = address.trim();
  if (!raw) return null;
  if (raw.startsWith('T')) {
    try {
      return Buffer.from(bs58check.decode(raw)).toString('hex').toLowerCase();
    } catch {
      return null;
    }
  }
  return raw.replace(/^0x/, '').toLowerCase();
}

function tronAddressesEqual(a, b) {
  if (a == null || b == null) return false;
  const ha = tronBase58ToHex(a);
  const hb = tronBase58ToHex(b);
  if (ha && hb) return ha === hb;
  return String(a).trim() === String(b).trim();
}

module.exports = {
  tronBase58ToHex,
  tronAddressesEqual,
};
