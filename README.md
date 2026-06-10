# mmm-pool-snapshot

**独立仓库**：pool-v4 算法 JS + 每日快照 JSON + Vercel 静态分发。

与主工程 `Client-flutter` / `WSS-server` 分离；算法变更时请同步 `algorithm/` 目录。

**开发文档（算法 + 匹配 + 4 档参数）**：Client-flutter 仓库  
https://github.com/yongchaoqiu111/Client-flutter/blob/main/docs/pool-v4-dev-master-zh.md

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

## 2. GitHub Secrets（必配，否则 Action 会失败）

仓库 → **Settings → Secrets and variables → Actions → New repository secret**

| Secret | 说明 |
|--------|------|
| `TRONGRID_API_KEY` | 平台索引 Key（[trongrid.io](https://www.trongrid.io) 注册） |
| `POOL_ADDRESS_1000` | 小额档买券地址（真实主网 T 地址） |
| `POOL_ADDRESS_10000` | 中额档 |
| `POOL_ADDRESS_100000` | 大额档 |
| `POOL_ADDRESS_1000000` | 巨额档 |
| `POOL_EXIT_ADDRESS` | 出场池地址（各档共用） |

未配置时脚本会用占位地址，TronGrid 返回 HTTP 400，`publish` 步骤 exit code 1。

## 3. 手动跑一次 Action

Actions → **Publish pool snapshot** → **Run workflow**

成功后 `public/snapshot.json` 里 `ok: true`，含全队 **付款池 + 收款池** 数据。

### Action 失败排查

| 现象 | 原因 | 处理 |
|------|------|------|
| `npm ci` 失败 | 缺少 `package-lock.json` | 已随仓库提交，拉最新 main |
| `Missing secret` | Secrets 未配 | 按上表添加后重跑 |
| `TronGrid ... HTTP 400` | 池地址无效或占位 | 改成真实主网地址 |
| `HTTP 429` | Key 配额用尽 | 换 Key 或等配额恢复 |
| Node 20 黄色警告 | Actions 弃用提示 | 已改用 Node 24，可忽略旧邮件 |

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
