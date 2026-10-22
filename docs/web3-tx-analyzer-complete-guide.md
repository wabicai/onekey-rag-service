# Web3 Transaction Analyzer 完整指南

> 综合后端实现规划、前端设计、浏览器扩展方案与知识库建设

---

## 目录

1. [项目概述](#1-项目概述)
2. [系统架构](#2-系统架构)
3. [后端服务设计](#3-后端服务设计)
4. [前端界面设计](#4-前端界面设计)
5. [浏览器扩展方案](#5-浏览器扩展方案)
6. [API 规范](#6-api-规范)
7. [函数签名查询机制](#7-函数签名查询机制)
8. [部署配置](#8-部署配置)
9. [知识库建设](#9-知识库建设)
10. [实施进度](#10-实施进度)

---

## 1. 项目概述

### 1.1 核心定位

**Web3 Transaction Analyzer** 是一个独立的链上交易分析微服务，提供：

| 能力 | 说明 |
|------|------|
| 智能分析 | 自动识别输入类型（交易哈希/Calldata/签名） |
| 交易解析 | 解码方法调用、事件日志 |
| Calldata 解码 | 解析未签名交易的 calldata 数据 |
| 签名解析 | 解析 EIP-712 签名、Permit 等签名请求 |
| 行为识别 | 识别 Swap/Transfer/Approve 等行为 |
| 风险检测 | 检测无限授权、大额转账等风险 |
| RAG 解释 | 调用 RAG 生成自然语言解释（支持所有输入类型） |

### 1.2 使用场景

```
场景 1：钱包 App 交易解读
  用户查看交易详情 → POST /v1/smart-analyze → 展示解释 + 风险提示

场景 2：交易签名预执行（核心场景）
  用户签名前 → POST /v1/smart-analyze (calldata) → 预览行为与风险

场景 3：EIP-712 签名安全检查
  用户签名请求 → POST /v1/smart-analyze (signature) → 解析授权内容

场景 4：开发者 Debug
  开发者输入 tx_hash → include_trace=true → 获取完整 trace 日志

场景 5：区块浏览器增强
  浏览器扩展 → 自动解析当前页面交易 → 显示 AI 分析
```

### 1.3 输入类型自动识别

Smart Analyze API 支持三种输入类型的自动识别：

| 输入类型 | 格式 | 识别规则 | 示例 |
|----------|------|----------|------|
| `tx_hash` | 0x + 64字符 | 十六进制，长度=64 | `0xabc...def` (64字符) |
| `calldata` | 0x + ≥8字符 | 十六进制，长度≥8 | `0xa9059cbb000...` |
| `signature` | JSON 对象 | 包含 domain + message | `{"domain":{...},"message":{...}}` |

### 1.4 技术栈

**后端**：

| 组件 | 选型 | 理由 |
|------|------|------|
| Web 框架 | FastAPI | 异步支持，OpenAPI 文档 |
| HTTP 客户端 | httpx | 异步支持 |
| ABI 解码 | eth-abi | 标准以太坊 ABI 编解码 |
| 日志 | structlog | 结构化 JSON 日志 |
| ORM | SQLAlchemy | 数据库操作 |
| 缓存 | Redis | 高性能缓存 |

**前端**：

| 技术 | 版本 | 用途 |
|------|------|------|
| React | 18.x | UI 框架 |
| TypeScript | 5.x | 类型安全 |
| Vite | 5.x | 构建工具 |
| TailwindCSS | 3.x | 样式框架 |
| shadcn/ui | - | UI 组件库 |

---

## 2. 系统架构

### 2.1 架构图

```
                    ┌─────────────────────────────────────────────────┐
                    │              Docker Compose 编排                 │
                    └─────────────────────────────────────────────────┘
                                          │
         ┌────────────────────────────────┼────────────────────────────────┐
         │                                │                                │
         ▼                                ▼                                ▼
┌─────────────────┐            ┌─────────────────┐            ┌─────────────────┐
│ web3-tx-analyzer│            │onekey-rag-service│           │   PostgreSQL    │
│    :8001        │───HTTP────▶│    :8000        │            │    :5432        │
│                 │            │                 │            │                 │
│ • 交易解析      │            │ • RAG 检索      │            │ • tx_analyzer   │
│ • Calldata解码  │            │ • 语义生成      │            │   schema        │
│ • 签名解析      │            │ • 知识库        │            │ • rag schema    │
│ • 行为识别      │            │                 │            │                 │
│ • 风险检测      │            │                 │            │                 │
└────────┬────────┘            └─────────────────┘            └────────┬────────┘
         │                                                             │
         │                     ┌─────────────────┐                     │
         └────────────────────▶│     Redis       │◀────────────────────┘
                               │    :6379        │
                               │ • ABI 缓存      │
                               │ • 解析结果缓存  │
                               │ • 签名缓存      │
                               └─────────────────┘
                                        │
         ┌──────────────────────────────┼──────────────────────────────┐
         ▼                              ▼                              ▼
┌─────────────────┐            ┌─────────────────┐            ┌─────────────────┐
│  EVM Chains     │            │   Etherscan     │            │  4byte.directory│
│  (JSON-RPC)     │            │   API           │            │  (签名数据库)   │
└─────────────────┘            └─────────────────┘            └─────────────────┘
```

### 2.2 目录结构

```
onekey-rag-service/
├── onekey_rag_service/              # 现有 RAG 服务
├── services/                        # 独立服务目录
│   └── web3-tx-analyzer/
│       ├── main.py                  # FastAPI 入口
│       ├── config.py                # 配置管理
│       ├── Dockerfile               # 独立镜像
│       ├── api/                     # API 层
│       │   ├── routes.py            # 路由定义（含 smart-analyze）
│       │   └── schemas.py           # 请求/响应模型
│       ├── analyzer/                # 核心解析逻辑
│       │   ├── parser.py            # 主解析流程 + _get_abi()
│       │   ├── abi_decoder.py       # ABI 解码
│       │   ├── calldata_decoder.py  # Calldata 解码器（新）
│       │   ├── signature_parser.py  # EIP-712 签名解析器（新）
│       │   ├── simulator.py         # 交易模拟器（新）
│       │   ├── event_classifier.py  # 事件分类
│       │   ├── behavior_analyzer.py # 行为识别
│       │   ├── risk_detector.py     # 风险检测
│       │   └── schemas.py           # 数据模型
│       ├── integrations/            # 外部服务集成
│       │   ├── rpc_client.py        # EVM JSON-RPC
│       │   ├── etherscan_client.py  # 链浏览器 API
│       │   └── signature_db.py      # 4byte 签名库（含本地缓存）
│       ├── clients/                 # 内部服务客户端
│       │   └── rag_client.py        # RAG 服务客户端
│       ├── storage/                 # 数据存储
│       │   ├── models.py            # SQLAlchemy 模型
│       │   ├── db.py                # 数据库连接
│       │   └── cache.py             # Redis 缓存
│       └── app_logging/             # 日志模块
│           ├── logger.py            # 结构化 JSON 日志
│           └── tracer.py            # 详细 trace 追踪
│
├── frontend-tx-analyzer/            # 前端项目
│   ├── src/
│   │   ├── web/                     # Web 应用入口
│   │   │   └── WebApp.tsx           # 主界面（Smart Input）
│   │   ├── shared/                  # 共享模块
│   │   │   ├── api/                 # API 客户端 + 类型定义
│   │   │   ├── components/          # UI 组件 (shadcn/ui)
│   │   │   ├── features/            # 功能模块
│   │   │   │   └── analyze/
│   │   │   │       ├── SmartInput.tsx       # 智能输入组件
│   │   │   │       ├── CalldataResult.tsx   # Calldata 结果展示
│   │   │   │       ├── SignatureResult.tsx  # 签名结果展示
│   │   │   │       ├── RagExplanation.tsx   # RAG 解释展示
│   │   │   │       ├── RiskAssessment.tsx   # 风险评估
│   │   │   │       └── ...
│   │   │   └── lib/                 # 工具函数
│   │   ├── popup/                   # 浏览器扩展 Popup
│   │   ├── sidepanel/               # 浏览器扩展侧边栏
│   │   └── content-scripts/         # 内容脚本
│   └── vite.config.ts
│
└── docs/
    └── web3-tx-analyzer-complete-guide.md
```

---

## 3. 后端服务设计

### 3.1 支持的链

| Chain | Chain ID | RPC | Explorer |
|-------|----------|-----|----------|
| Ethereum | 1 | https://eth.llamarpc.com | Etherscan |
| BSC | 56 | https://bsc-dataseed.binance.org | BscScan |
| Polygon | 137 | https://polygon-rpc.com | PolygonScan |
| Arbitrum | 42161 | https://arb1.arbitrum.io/rpc | Arbiscan |
| Optimism | 10 | https://mainnet.optimism.io | Optimistic Etherscan |

### 3.2 行为类型

| 行为 | 识别依据 |
|------|----------|
| `swap` | DEX Router 调用 + Swap 事件 |
| `bridge` | Bridge 合约 + Lock/Mint 事件 |
| `stake` | Staking 合约 + Stake/Deposit 事件 |
| `transfer` | ERC20/721 Transfer 事件 |
| `approve` | Approval 事件 / approve 方法 |
| `mint` | Mint 事件 |
| `liquidity_add` | addLiquidity 方法 |
| `liquidity_remove` | removeLiquidity 方法 |
| `wrap` / `unwrap` | WETH deposit/withdraw |
| `signature_request` | EIP-712 签名请求 |
| `unknown` | 无法识别 |

### 3.3 风险检测

| 风险类型 | 严重程度 | 说明 |
|----------|----------|------|
| `unlimited_approve` | High | 无限授权（接近 MAX_UINT256） |
| `nft_approval_for_all` | High | NFT setApprovalForAll(true) |
| `high_value_transfer` | Medium | 大额原生代币转账 |
| `transfer_to_zero` | High | 向零地址转账 |
| `dangerous_function` | High | 危险函数调用（Permit 等） |
| `permit_signature` | High | EIP-2612 Permit 签名 |
| `permit2_signature` | High | Uniswap Permit2 签名 |

### 3.4 核心模块

#### 3.4.1 CalldataDecoder（Calldata 解码器）

解码未签名/未发送交易的 calldata 数据：

```python
class CalldataDecoder:
    """Calldata 解码器"""

    async def decode(
        self,
        calldata: str,           # 原始 calldata (0x 开头)
        context: CalldataContext | None = None,  # 上下文（链ID、目标地址等）
        abi: list[dict] | None = None,           # 可选的合约 ABI
    ) -> DecodedCalldata:
        """
        解码流程：
        1. 尝试从 ABI 解码
        2. 如果没有 ABI，查询签名数据库（先本地，后 4byte.directory）
        3. 分析行为类型
        4. 检测风险
        5. 识别合约类型
        """
```

#### 3.4.2 SignatureParser（签名解析器）

解析 EIP-712 签名请求：

```python
class SignatureParser:
    """EIP-712 签名解析器"""

    def parse(self, data: dict | str) -> SignatureAnalysis:
        """
        解析流程：
        1. 解析 JSON 数据
        2. 识别签名类型（Permit、Permit2、NFT Permit、Order 等）
        3. 提取关键信息（授权金额、spender、deadline）
        4. 评估风险等级
        """
```

支持的签名类型：
- ERC-2612 Permit（Token 授权）
- Uniswap Permit2（批量授权）
- NFT Permit（NFT 授权）
- Seaport Order（NFT 交易订单）
- Generic EIP-712（通用签名）

### 3.5 数据库设计

```sql
-- 使用独立 schema 隔离
CREATE SCHEMA IF NOT EXISTS tx_analyzer;

-- 解析结果缓存表
CREATE TABLE tx_analyzer.parse_results (
    id SERIAL PRIMARY KEY,
    chain_id INTEGER NOT NULL,
    tx_hash VARCHAR(66) NOT NULL,
    block_number BIGINT,
    parse_result JSONB NOT NULL,
    behavior_type VARCHAR(32),
    confidence VARCHAR(16),
    parser_version VARCHAR(16) NOT NULL,
    parsed_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(chain_id, tx_hash)
);

-- ABI 缓存表
CREATE TABLE tx_analyzer.abi_cache (
    id SERIAL PRIMARY KEY,
    chain_id INTEGER NOT NULL,
    contract_address VARCHAR(42) NOT NULL,
    abi JSONB,
    source VARCHAR(32),
    fetched_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(chain_id, contract_address)
);

-- 解析日志表
CREATE TABLE tx_analyzer.parse_logs (
    id SERIAL PRIMARY KEY,
    trace_id VARCHAR(64) NOT NULL,
    chain_id INTEGER NOT NULL,
    tx_hash VARCHAR(66) NOT NULL,
    status VARCHAR(16),
    behavior_type VARCHAR(32),
    total_ms INTEGER,
    created_at TIMESTAMP DEFAULT NOW()
);
```

---

## 4. 前端界面设计

### 4.1 Smart Input 界面

前端现在使用统一的智能输入界面，自动识别输入类型：

```
┌─────────────────────────────────────────────────────────────────────────┐
│  🛡️ Web3 Transaction Analyzer                          [OneKey]        │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │  输入交易哈希、Calldata 或 EIP-712 签名数据                        │ │
│  │  ┌──────────────────────────────────────────────────────────────┐  │ │
│  │  │  0x69328dec000000000000000000000000a0b86991c6218b36c1...     │  │ │
│  │  └──────────────────────────────────────────────────────────────┘  │ │
│  │                                                                     │ │
│  │  识别类型: [Calldata]        链: [Ethereum ▼]                      │ │
│  │                                                                     │ │
│  │  ▼ 高级选项                                                        │ │
│  │  ┌─────────────────────────────────────────────────────────────┐   │ │
│  │  │ 目标地址 (to): [0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D] │   │ │
│  │  │ 发送者 (from): [可选]                                       │   │ │
│  │  │ 发送金额 (value): [0]                                       │   │ │
│  │  └─────────────────────────────────────────────────────────────┘   │ │
│  │                                                                     │ │
│  │  ☑ 包含 AI 解释    ☐ 包含 Trace                                   │ │
│  │                                                                     │ │
│  │                              [🔍 智能分析]                          │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
│  ┌─ 分析结果 ─────────────────────────────────────────────────────────┐ │
│  │                                                                     │ │
│  │  ┌─ Calldata 解码 ─────────────────────────────────────────────┐   │ │
│  │  │ 函数名: removeLiquidityETHWithPermit                        │   │ │
│  │  │ Selector: 0x69328dec                                        │   │ │
│  │  │ 行为类型: liquidity_remove                                  │   │ │
│  │  │ 风险等级: 🟢 Low                                            │   │ │
│  │  │                                                              │   │ │
│  │  │ 参数:                                                        │   │ │
│  │  │   token: 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 (USDC)  │   │ │
│  │  │   liquidity: 1000000000000000000                            │   │ │
│  │  │   amountTokenMin: 990000000                                 │   │ │
│  │  │   ...                                                        │   │ │
│  │  └──────────────────────────────────────────────────────────────┘   │ │
│  │                                                                     │ │
│  │  ┌─ AI 分析 ───────────────────────────────────────────────────┐   │ │
│  │  │ 📝 这是一笔从 Uniswap V2 移除流动性的交易。用户正在移除      │   │ │
│  │  │    USDC-ETH 流动性池中的 LP Token，并使用 Permit 签名授权    │   │ │
│  │  │    而不是传统的 approve 交易，可以节省 gas 费用。            │   │ │
│  │  │                                                              │   │ │
│  │  │ 风险提示:                                                    │   │ │
│  │  │ ✓ 操作目标为知名 DEX (Uniswap V2 Router)                    │   │ │
│  │  │ ✓ 滑点保护已设置                                            │   │ │
│  │  └──────────────────────────────────────────────────────────────┘   │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 4.2 三种结果展示

根据输入类型，显示不同的结果组件：

| 输入类型 | 结果组件 | 显示内容 |
|----------|----------|----------|
| `tx_hash` | ResultOverview + RiskAssessment + MethodDetail + EventList | 完整交易解析 |
| `calldata` | CalldataResult + RagExplanation | 函数解码 + AI 分析 |
| `signature` | SignatureResult + RagExplanation | 签名解析 + AI 分析 |

### 4.3 主题色

```css
:root {
  /* 主色调 - OneKey 品牌色 */
  --primary: #00b894;

  /* 链颜色 */
  --chain-eth: #627eea;
  --chain-bsc: #f3ba2f;
  --chain-polygon: #8247e5;
  --chain-arbitrum: #28a0f0;
  --chain-optimism: #ff0420;

  /* 风险颜色 */
  --risk-low: #00b894;
  --risk-medium: #fdcb6e;
  --risk-high: #e74c3c;
  --risk-critical: #c0392b;
}
```

---

## 5. 浏览器扩展方案

> 将 TX Analyzer 从独立 Web 应用改造为浏览器扩展，实现与 OneKey 等钱包的无缝集成

### 5.1 产品形态

#### 三种交互场景

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        浏览器扩展产品形态                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  场景 1: Popup 主动查询                                                      │
│  ┌──────────────────────┐                                                   │
│  │  [Extension Icon]    │  用户点击图标 → 弹出窗口 → 输入任意内容 → 智能分析 │
│  │  ┌────────────────┐  │                                                   │
│  │  │ 支持输入:      │  │  适用：查询历史交易、研究分析、预检签名            │
│  │  │ • TX Hash      │  │                                                   │
│  │  │ • Calldata     │  │                                                   │
│  │  │ • Signature    │  │                                                   │
│  │  │ [Smart Analyze]│  │                                                   │
│  │  └────────────────┘  │                                                   │
│  └──────────────────────┘                                                   │
│                                                                              │
│  场景 2: Content Script 交易拦截 (核心场景)                                  │
│  ┌──────────────────────────────────────────────────────────────┐           │
│  │  Uniswap / OpenSea / 任意 dApp                                │           │
│  │                                                               │           │
│  │  用户点击 [Swap] → 扩展拦截 eth_sendTransaction               │           │
│  │                           ↓                                   │           │
│  │  ┌─────────────────────────────────────────────────┐         │           │
│  │  │  ⚠️ TX Analyzer 安全检查                        │         │           │
│  │  │                                                  │         │           │
│  │  │  交易类型: Swap (USDC → ETH)                    │         │           │
│  │  │  风险等级: 🟡 Medium                            │         │           │
│  │  │                                                  │         │           │
│  │  │  ⚠️ 滑点设置较高 (5%)                          │         │           │
│  │  │  ⚠️ 首次与该合约交互                           │         │           │
│  │  │                                                  │         │           │
│  │  │  [查看详情]  [取消] [继续签名]                  │         │           │
│  │  └─────────────────────────────────────────────────┘         │           │
│  └──────────────────────────────────────────────────────────────┘           │
│                                                                              │
│  场景 3: 区块浏览器增强                                                      │
│  ┌──────────────────────────────────────────────────────────────┐           │
│  │  Etherscan.io/tx/0x...                                        │           │
│  │                                                               │           │
│  │  Transaction Details          [🔍 AI 分析] ← 注入的按钮       │           │
│  │  ─────────────────────                                        │           │
│  │  Status: Success                                              │           │
│  │  Block: 18234567                                              │           │
│  │                                                               │           │
│  └──────────────────────────────────────────────────────────────┘           │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### 场景优先级

| 优先级 | 场景 | 价值 | 复杂度 |
|--------|------|------|--------|
| P0 | 交易拦截预警 | 最高 - 签名前防护 | 中 |
| P1 | Popup 主动查询 | 高 - 研究分析 | 低 |
| P2 | 浏览器增强 | 中 - 锦上添花 | 低 |

---

## 6. API 规范

### 6.1 端点列表

| Method | Path | 说明 |
|--------|------|------|
| GET | `/healthz` | 健康检查 |
| GET | `/v1/chains` | 获取支持的链列表 |
| POST | `/v1/tx/parse` | 纯解析（不调用 RAG） |
| POST | `/v1/tx/analyze` | 完整分析（含 RAG） |
| **POST** | **`/v1/smart-analyze`** | **智能分析（推荐）** |
| POST | `/v1/decode` | 解码 Calldata |
| POST | `/v1/simulate` | 模拟交易执行 |
| POST | `/v1/signature/decode` | 解析签名数据 |

### 6.2 智能分析请求（推荐）

```json
POST /v1/smart-analyze

{
  "input": "0x69328dec000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48...",
  "chain_id": 1,
  "context": {
    "to_address": "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
    "from_address": "0x...",
    "value": "0"
  },
  "options": {
    "include_explanation": true,
    "include_trace": false,
    "language": "zh"
  }
}
```

### 6.3 智能分析响应

根据 `input_type` 返回不同的结果字段：

```json
{
  "trace_id": "tx-20250119-abc123",
  "input_type": "calldata",  // "tx_hash" | "calldata" | "signature"
  "status": "success",

  // 当 input_type == "tx_hash" 时
  "tx_result": { ... },

  // 当 input_type == "calldata" 时
  "decode_result": {
    "selector": "0x69328dec",
    "function_name": "removeLiquidityETHWithPermit",
    "function_signature": "removeLiquidityETHWithPermit(address,uint256,uint256,uint256,address,uint256,bool,uint8,bytes32,bytes32)",
    "inputs": [...],
    "behavior_type": "liquidity_remove",
    "risk_level": "low",
    "risk_flags": [],
    "warnings": [],
    "contract_type": "uniswap_v2_router"
  },

  // 当 input_type == "signature" 时
  "signature_result": {
    "signature_type": "permit",
    "primary_type": "Permit",
    "domain": { "name": "USDC", "chainId": 1, ... },
    "message": { "owner": "0x...", "spender": "0x...", "value": "..." },
    "risk_level": "high",
    "risk_reasons": ["无限授权"]
  },

  // RAG 解释（所有类型都支持）
  "explanation": {
    "summary": "这是一笔从 Uniswap V2 移除流动性的交易...",
    "risk_level": "low",
    "risk_reasons": [],
    "actions": ["移除 USDC-ETH 流动性", "使用 Permit 授权"],
    "sources": []
  },

  "timings": {
    "total_ms": 850,
    "fetch_abi_ms": 200,
    "decode_ms": 50,
    "rag_ms": 600
  }
}
```

### 6.4 旧版 API（仍然支持）

#### 交易分析

```json
POST /v1/tx/analyze

{
  "chain_id": 1,
  "tx_hash": "0xabc...def",
  "options": {
    "include_explanation": true,
    "include_trace": false,
    "language": "zh"
  }
}
```

#### Calldata 解码

```json
POST /v1/decode

{
  "calldata": "0xa9059cbb000000000000000000000000...",
  "chain_id": 1,
  "to_address": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
}
```

#### 签名解析

```json
POST /v1/signature/decode

{
  "data": {
    "domain": { "name": "USDC", "chainId": 1, ... },
    "message": { "owner": "0x...", "spender": "0x...", ... },
    "primaryType": "Permit",
    "types": { ... }
  },
  "chain_id": 1
}
```

---

## 7. 函数签名查询机制

### 7.1 什么是函数选择器 (Selector)

在 EVM 中，当调用智能合约方法时，calldata 的**前 4 字节**是函数的 "selector"：

```
selector = keccak256("函数签名")[:4]

例如：
keccak256("transfer(address,uint256)") = 0xa9059cbb1b3fed9d...
取前 4 字节 → 0xa9059cbb

所以当你看到 calldata = 0xa9059cbb00000000000000...
前 4 字节 0xa9059cbb 表示调用的是 transfer(address,uint256) 函数
```

### 7.2 签名查询的两级架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                      函数签名查询流程                                │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  输入: selector = 0xa9059cbb                                         │
│                    │                                                 │
│                    ▼                                                 │
│  ┌─────────────────────────────────┐                                │
│  │  1. COMMON_SIGNATURES           │ ◄── 本地缓存（~70个常用签名）   │
│  │     (本地 dict，O(1) 查询)      │                                │
│  │                                  │     包含：                     │
│  │     signature_db.py 中定义      │     • ERC-20/721/1155 标准    │
│  └────────────────┬────────────────┘     • Uniswap V2/V3 Router    │
│                   │                       • WETH deposit/withdraw   │
│         找到？ ───┼─── 是 ───▶ 直接返回   • Multicall              │
│                   │             (0ms)     • 常见回调函数            │
│                   │                                                  │
│                   │ 否                                               │
│                   ▼                                                 │
│  ┌─────────────────────────────────┐                                │
│  │  2. 4byte.directory API         │ ◄── 公共签名数据库            │
│  │     https://4byte.directory     │                                │
│  │                                  │     • 100万+ 函数签名         │
│  │     GET /api/v1/signatures/     │     • 网络请求 (~100-500ms)   │
│  │     ?hex_signature=0xa9059cbb   │     • 可能返回多个匹配         │
│  └────────────────┬────────────────┘     • 带重试机制              │
│                   │                                                  │
│                   ▼                                                 │
│         缓存到内存 _local_cache                                      │
│         下次查询直接返回                                             │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### 7.3 COMMON_SIGNATURES 详解

位于 `services/web3-tx-analyzer/integrations/signature_db.py`：

```python
# 常用函数签名本地缓存
COMMON_SIGNATURES: dict[str, list[str]] = {
    # ERC-20 标准
    "0xa9059cbb": ["transfer(address,uint256)"],
    "0x23b872dd": ["transferFrom(address,address,uint256)"],
    "0x095ea7b3": ["approve(address,uint256)"],

    # ERC-721 标准
    "0x42842e0e": ["safeTransferFrom(address,address,uint256)"],
    "0xa22cb465": ["setApprovalForAll(address,bool)"],

    # Uniswap V2 Router
    "0x38ed1739": ["swapExactTokensForTokens(...)"],
    "0x69328dec": ["removeLiquidityETHWithPermit(...)"],

    # ... 约 70 个常用签名
}
```

**为什么需要本地缓存？**

| 原因 | 说明 |
|------|------|
| **性能** | 本地查询 O(1)，无需网络请求 |
| **离线可用** | 即使 4byte.directory 不可用，常用函数仍能识别 |
| **准确性** | 同一 selector 可能对应多个函数，本地缓存确保返回正确的那个 |
| **稳定性** | 减少外部依赖，提高服务稳定性 |

### 7.4 4byte.directory 说明

[4byte.directory](https://www.4byte.directory/) 是一个公共的函数签名数据库：

- 任何人都可以提交函数签名
- 目前收录了超过 100 万个签名
- 提供 REST API 供查询

**API 示例：**

```bash
curl "https://www.4byte.directory/api/v1/signatures/?hex_signature=0xa9059cbb"

# 响应
{
  "count": 1,
  "results": [
    {
      "id": 145,
      "text_signature": "transfer(address,uint256)",
      "hex_signature": "0xa9059cbb"
    }
  ]
}
```

**注意事项：**
- 同一个 selector 可能对应多个不同的函数签名（哈希碰撞）
- 返回结果按 ID 排序，通常取第一个即可
- 有速率限制，需要合理使用

### 7.5 事件签名

类似地，事件也有签名查询机制：

```python
# 常用事件签名本地缓存
COMMON_EVENT_SIGNATURES: dict[str, str] = {
    # ERC-20 Transfer 事件
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef":
        "Transfer(address,address,uint256)",

    # ERC-20 Approval 事件
    "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925":
        "Approval(address,address,uint256)",

    # Uniswap V2 Swap 事件
    "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822":
        "Swap(address,uint256,uint256,uint256,uint256,address)",
}
```

事件签名使用完整的 32 字节 keccak256 哈希作为 topic[0]。

---

## 8. 部署配置

### 8.1 Docker Compose

```yaml
# docker-compose.yml
services:
  web3-tx-analyzer:
    build:
      context: ./services/web3-tx-analyzer
      dockerfile: Dockerfile
    profiles: ["tx-analyzer"]
    ports:
      - "127.0.0.1:8001:8001"
    environment:
      - DATABASE_URL=postgresql://...
      - REDIS_URL=redis://tx-analyzer-redis:6379/0
      - RAG_BASE_URL=http://api:8000
    depends_on:
      - postgres
      - tx-analyzer-redis
      - api

  frontend-tx-analyzer:
    image: node:22.23.4-alpine
    profiles: ["frontend", "tx-analyzer"]
    ports:
      - "5175:5175"
    volumes:
      - ./frontend-tx-analyzer:/app
    environment:
      NODE_OPTIONS: "--max-old-space-size=4096"
      # 开发模式下使用（Docker 网络内部）
      VITE_TX_ANALYZER_API_URL: http://web3-tx-analyzer:8001
      # 注意：生产环境前端始终使用相对路径 /tx-analyzer/api
```

### 8.2 Nginx 配置

```nginx
# TX Analyzer 前端
location ^~ /tx-analyzer/ {
    proxy_pass http://127.0.0.1:5175;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}

# TX Analyzer API
location ^~ /tx-analyzer/api/ {
    proxy_pass http://127.0.0.1:8001/;
    proxy_buffering off;
}
```

### 8.3 启动命令

```bash
# 启动 TX Analyzer 服务（含前端）
docker compose --profile tx-analyzer up -d --build

# 仅启动后端
docker compose --profile tx-analyzer up -d web3-tx-analyzer tx-analyzer-redis

# 查看日志
docker compose logs -f web3-tx-analyzer
docker compose logs -f frontend-tx-analyzer
```

### 8.4 前端 API URL 配置

前端使用以下逻辑确定 API 地址：

```typescript
// WebApp.tsx
// 生产环境始终使用相对路径（由 nginx 代理）
// 开发环境可使用环境变量直接连接后端
const API_BASE_URL = import.meta.env.MODE === 'development'
  ? (import.meta.env.VITE_TX_ANALYZER_WEB_API_URL || '/tx-analyzer/api')
  : '/tx-analyzer/api'
```

---

## 9. 知识库建设

> **重要**：当前 RAG 服务使用的是 OneKey 开发者文档，对于通用的区块链交易解释效果有限。
> 为了让 TX Analyzer 的 RAG 解释更有价值，建议添加以下区块链知识文档。

### 9.1 DeFi 协议文档（优先级：高）

#### DEX 交易所

| 协议 | 文档地址 | 内容 |
|------|----------|------|
| **Uniswap V2** | https://docs.uniswap.org/contracts/v2/overview | Swap、流动性、AMM 机制 |
| **Uniswap V3** | https://docs.uniswap.org/contracts/v3/overview | 集中流动性、价格区间 |
| **Uniswap V4** | https://docs.uniswap.org/contracts/v4/overview | Hooks、单例合约 |
| **SushiSwap** | https://docs.sushi.com/api/examples/swap | 多链 DEX、Farm |
| **PancakeSwap** | https://docs.pancakeswap.finance/ | BSC DEX、IFO |
| **Curve** | https://resources.curve.fi/ | 稳定币交易、Gauge |
| **1inch** | https://docs.1inch.io/ | 聚合器、限价单 |

#### 借贷协议

| 协议 | 文档地址 | 内容 |
|------|----------|------|
| **Aave V3** | https://docs.aave.com/ | 借贷、闪电贷、E-Mode |
| **Compound** | https://docs.compound.finance/ | cToken、治理 |
| **MakerDAO** | https://docs.makerdao.com/ | DAI、CDP、清算 |

### 9.2 安全知识（优先级：高）

| 资源 | 地址 | 内容 |
|------|------|------|
| **常见攻击模式** | 需整理 | 重入、闪电贷攻击、价格操纵 |
| **代币授权风险** | 需整理 | Approve、Permit、setApprovalForAll |
| **钓鱼识别** | 需整理 | 假代币、恶意合约特征 |
| **Rekt Database** | https://rekt.news/ | 安全事件分析 |

### 9.3 EVM 基础知识（优先级：高）

| 主题 | 内容 |
|------|------|
| **ERC-20** | 代币标准、Transfer、Approve、TransferFrom |
| **ERC-721** | NFT 标准、safeTransferFrom、setApprovalForAll |
| **ERC-1155** | 多代币标准、批量转账 |
| **ERC-2612** | Permit 签名授权 |
| **EIP-712** | 类型化数据签名 |
| **交易类型** | Legacy、EIP-1559、EIP-2930 |
| **Gas 机制** | Gas Limit、Gas Price、Priority Fee |

---

## 10. 实施进度

### 10.1 已完成

- [x] 后端服务骨架
- [x] RPC 客户端（多链支持）
- [x] Etherscan 客户端
- [x] ABI 解码器
- [x] 事件分类器
- [x] 行为分析器
- [x] 风险检测器
- [x] RAG 客户端
- [x] 日志系统（JSON + Trace）
- [x] Redis 缓存
- [x] API 路由
- [x] Docker 部署
- [x] 前端 UI
- [x] Nginx 反向代理
- [x] **Smart Analyze API**（智能分析）
- [x] **Calldata 解码器**
- [x] **EIP-712 签名解析器**
- [x] **RAG 支持所有输入类型**
- [x] **函数签名本地缓存 + 4byte.directory 查询**
- [x] **前端智能输入界面**

### 10.2 待优化

- [ ] **浏览器扩展完善**（见第 5 节）
- [ ] 知识库文档爬取（见第 9 节）
- [ ] 更多协议行为识别
- [ ] 批量分析 API
- [ ] 历史记录持久化
- [ ] 交易模拟完善
- [ ] 暗色模式

### 10.3 验收标准

| 里程碑 | 交付物 | 状态 |
|--------|--------|------|
| M1 | 服务骨架 | ✅ |
| M2 | 基础解析 | ✅ |
| M3 | 日志完善 | ✅ |
| M4 | RAG 集成 | ✅ |
| M5 | 多链支持 | ✅ |
| M6 | Docker 部署 | ✅ |
| M7 | 前端界面 | ✅ |
| M8 | **Smart Analyze** | ✅ |
| M9 | 知识库建设 | 🔧 进行中 |
| M10 | 浏览器扩展 | 🔧 进行中 |

---

## 附录

### A. 环境变量

```bash
# 后端服务
APP_ENV=local
LOG_LEVEL=INFO
DATABASE_URL=postgresql://...
REDIS_URL=redis://...
RAG_BASE_URL=http://api:8000

# 链配置
ETH_RPC_URL=https://eth.llamarpc.com
BSC_RPC_URL=https://bsc-dataseed.binance.org
POLYGON_RPC_URL=https://polygon-rpc.com

# Etherscan API Keys
ETHERSCAN_API_KEY=
BSCSCAN_API_KEY=
POLYGONSCAN_API_KEY=
```

### B. 常用命令

```bash
# 启动服务
docker compose --profile tx-analyzer up -d --build

# 查看日志
docker compose logs -f web3-tx-analyzer

# 重启前端
docker compose --profile tx-analyzer restart frontend-tx-analyzer

# 清理重建
docker compose --profile tx-analyzer down
docker compose --profile tx-analyzer up -d --build

# 测试 Smart Analyze API
curl -X POST http://localhost:8001/v1/smart-analyze \
  -H "Content-Type: application/json" \
  -d '{
    "input": "0xa9059cbb000000000000000000000000...",
    "chain_id": 1,
    "options": {"include_explanation": true}
  }'
```

### C. 参考资料

- [Etherscan API 文档](https://docs.etherscan.io/)
- [4byte.directory](https://www.4byte.directory/)
- [EVM Opcodes](https://www.evm.codes/)
- [EIP-712: 类型化数据签名](https://eips.ethereum.org/EIPS/eip-712)
- [EIP-2612: Permit 签名授权](https://eips.ethereum.org/EIPS/eip-2612)
- [以太坊黄皮书](https://ethereum.github.io/yellowpaper/paper.pdf)
