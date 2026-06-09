# mmm-pool-snapshot

**独立仓库**：pool-v4 算法 JS + 每日快照 JSON + Vercel 静态分发。

与主工程 `Client-flutter` / `WSS-server` 分离；算法变更时请同步 `algorithm/` 目录。

## 目录

```
mmm-pool-snapshot/
├── algorithm/          ← pool-v4 官方算法（与客户端对齐）
│   ├── pool-rules.js
│   ├── pool-config.js
│   ├── publish-pool-snapshot.js
│   └── ...
├── public/             ← Vercel 对外提供
│   ├── snapshot.json   ← 打款池+收款池全队状态
│   └── manifest.json
├── .github/workflows/  ← 每天自动发布
└── vercel.json
```

## 1. 新建 GitHub 仓库并推送

```bash
cd mmm-pool-snapshot
git init
git add .
git commit -m "init: pool-v4 snapshot repo"
git branch -M main
git remote add origin https://github.com/你的用户名/mmm-pool-snapshot.git
git push -u origin main
```

## 2. GitHub Secrets（Settings → Secrets and variables → Actions）

| Secret | 说明 |
|--------|------|
| `TRONGRID_API_KEY` | 平台索引 Key |
| `POOL_ADDRESS_1000` | 小额档买券地址 |
| `POOL_ADDRESS_10000` | 中额档 |
| `POOL_ADDRESS_100000` | 大额档 |
| `POOL_ADDRESS_1000000` | 巨额档 |
| `POOL_EXIT_ADDRESS` | 出场池地址（各档共用） |

## 3. 手动跑一次 Action

Actions → **Publish pool snapshot** → **Run workflow**

成功后 `public/snapshot.json` 会有全队 **付款池 + 收款池** 数据。

## 4. Vercel 连接本仓库

1. [vercel.com](https://vercel.com) → Add New Project → 选 **mmm-pool-snapshot**
2. Framework: **Other**
3. Root Directory: **留空**（仓库根即站点，`public/` 自动作为静态根）
4. Deploy

访问：`https://你的项目.vercel.app/snapshot.json`

## 5. App 配置

编译 Flutter 时：

```bash
flutter build apk --dart-define=POOL_SNAPSHOT_URL=https://你的项目.vercel.app
```

App 优先下载该 URL 的 JSON；本人付款/验款仍用 **用户自己的 TronGrid Key**。

## 本地测试

```bash
cp .env.example .env
# 填好 TRONGRID_API_KEY 和地址
npm install
npm run publish
```

## 算法同步

`algorithm/` 源自 `WSS-server/shared/`。主仓改 pool-v4 后，请复制以下文件到本仓：

- `pool-config.js`
- `pool-rules.js`
- `pool-snapshot.js`
- `exit-pay-verify.js`
- `tron-address.js`
