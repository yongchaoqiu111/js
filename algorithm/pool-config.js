/**

 * 排单池公开配置（方案 A · 无后端 · pool-v3-split）

 *

 * 买券 → 打款池；付清出场池任务(主网验款) → 收款池；溢出按档位 exitAmountTrx 整数出场
 * 买券地址 purchaseAddress；出场应付 exitPoolAddress（可同址，靠金额区分）
 * 不用测试网 anchor；人人 TronGrid + 本规则回放

 */

const POOL_RULES_VERSION = 'pool-v4-dual-pool';

/** 主网出场池收款地址（各档共用） */
const DEFAULT_EXIT_POOL_ADDRESS =
  process.env.POOL_EXIT_ADDRESS || 'TRjvctzrc5WcEeu2UrT8mV5H6zW8dCgimR';



const CHECKPOINT_INTERVAL_MS = 24 * 3600 * 1000;

/** 每日唯一匹配时刻：UTC 0:00（北京时间 08:00），全天只匹配一次 */
const DAILY_MATCH_UTC_HOUR = 0;
const MATCHES_PER_DAY = 1;

const ENTRY_PERIOD_DAYS = 15;

const EXIT_PERIOD_DAYS = 7;

const MATCH_PAYMENT_TIMEOUT_HOURS = 24;

const MAX_OPEN_ENTRIES_PER_PAYER = 1;



/** 付款方一笔 poolCredit 额度最多拆成几笔打款单 */

const MAX_SPLITS_PER_PAYER = 3;

/** 池满阈值 = poolCreditTrx × 100（与旧 30万/3000 相同结构） */
const POOL_TARGET_MULTIPLIER = 100;

/** 与 queue-rules / Client queue_tiers_presets 出场比例一致；算法相同，仅参数不同 */
const POOL_PURCHASE_CONFIG = [
  {
    id: '1000',
    name: '小额排单',
    purchaseAddress: process.env.POOL_ADDRESS_1000 || process.env.POOL_ADDRESS_3000 || 'TQmzZQQQk7C9F5aG9v6E5j8H9i0j1K2L3M4N5',
    exitPoolAddress: process.env.POOL_EXIT_1000 || process.env.POOL_EXIT_3000 || DEFAULT_EXIT_POOL_ADDRESS,
    ticketPriceTrx: Number(process.env.POOL_TICKET_1000 || process.env.POOL_TICKET_3000 || 100),
    poolCreditTrx: 1000,
    poolTargetTrx: 100_000,
    exitAmountTrx: 1300,
    profitRate: 0.3,
  },
  {
    id: '10000',
    name: '中额排单',
    purchaseAddress: process.env.POOL_ADDRESS_10000 || process.env.POOL_ADDRESS_30000 || 'TQmzZQQQk7C9F5aG9v6E5j8H9i0j1K2L3M4N6',
    exitPoolAddress: process.env.POOL_EXIT_10000 || process.env.POOL_EXIT_30000 || DEFAULT_EXIT_POOL_ADDRESS,
    ticketPriceTrx: Number(process.env.POOL_TICKET_10000 || process.env.POOL_TICKET_30000 || 1000),
    poolCreditTrx: 10_000,
    poolTargetTrx: 1_000_000,
    exitAmountTrx: 12_000,
    profitRate: 0.2,
  },
  {
    id: '100000',
    name: '大额排单',
    purchaseAddress: process.env.POOL_ADDRESS_100000 || process.env.POOL_ADDRESS_300000 || 'TQmzZQQQk7C9F5aG9v6E5j8H9i0j1K2L3M4N7',
    exitPoolAddress: process.env.POOL_EXIT_100000 || process.env.POOL_EXIT_300000 || DEFAULT_EXIT_POOL_ADDRESS,
    ticketPriceTrx: Number(process.env.POOL_TICKET_100000 || process.env.POOL_TICKET_300000 || 5000),
    poolCreditTrx: 100_000,
    poolTargetTrx: 10_000_000,
    exitAmountTrx: 110_000,
    profitRate: 0.1,
  },
  {
    id: '1000000',
    name: '超大额排单',
    purchaseAddress: process.env.POOL_ADDRESS_1000000 || 'TQmzZQQQk7C9F5aG9v6E5j8H9i0j1K2L3M4N8',
    exitPoolAddress: process.env.POOL_EXIT_1000000 || DEFAULT_EXIT_POOL_ADDRESS,
    ticketPriceTrx: Number(process.env.POOL_TICKET_1000000 || 50000),
    poolCreditTrx: 1_000_000,
    poolTargetTrx: 100_000_000,
    exitAmountTrx: 1_080_000,
    profitRate: 0.08,
  },
];



function checkpointDayId(tsMs = Date.now()) {

  const d = new Date(tsMs);

  const utcDay = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

  const effective = tsMs >= utcDay ? utcDay : utcDay - CHECKPOINT_INTERVAL_MS;

  return new Date(effective).toISOString().slice(0, 10);

}



function checkpointCutoffMs(tsMs = Date.now()) {

  const d = new Date(tsMs);

  const utcDay = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

  return tsMs >= utcDay ? utcDay : utcDay - CHECKPOINT_INTERVAL_MS;

}



/** 本周期匹配已在何时触发；下一周期匹配时刻 */
function dailyMatchContext(tsMs = Date.now()) {

  const snapshotCutoffMs = checkpointCutoffMs(tsMs);

  const matchDayId = checkpointDayId(tsMs);

  const matchAtMs = snapshotCutoffMs;

  const nextMatchAtMs = snapshotCutoffMs + CHECKPOINT_INTERVAL_MS;

  return {

    matchDayId,

    snapshotCutoffMs,

    matchAtMs,

    nextMatchAtMs,

    matchesPerDay: MATCHES_PER_DAY,

    matchUtcHour: DAILY_MATCH_UTC_HOUR,

    beijingMatchHour: DAILY_MATCH_UTC_HOUR + 8,

    matchPublished: tsMs >= matchAtMs,

  };

}



function exitPoolAddressFor(cfg) {
  return cfg?.exitPoolAddress || cfg?.purchaseAddress || '';
}

module.exports = {

  POOL_RULES_VERSION,

  DEFAULT_EXIT_POOL_ADDRESS,

  exitPoolAddressFor,

  CHECKPOINT_INTERVAL_MS,

  ENTRY_PERIOD_DAYS,

  EXIT_PERIOD_DAYS,

  MATCH_PAYMENT_TIMEOUT_HOURS,

  MAX_OPEN_ENTRIES_PER_PAYER,

  MAX_SPLITS_PER_PAYER,

  POOL_PURCHASE_CONFIG,

  POOL_TARGET_MULTIPLIER,

  DAILY_MATCH_UTC_HOUR,

  MATCHES_PER_DAY,

  checkpointDayId,

  checkpointCutoffMs,

  dailyMatchContext,

};


