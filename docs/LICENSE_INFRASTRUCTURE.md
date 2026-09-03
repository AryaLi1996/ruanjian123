# License 验证与存储基础设施架构（Lambda 方案）

> 本文档描述 SootheVoice / ruanjian123 桌面应用使用 **AWS Lambda** 进行
> license（订阅授权）确认与存储的完整基础设施。内容自包含，可直接分享给
> 其他 Claude workbench 或工程师，无需先读代码。
>
> 涉及代码：
> - `serverless/verify-license/`（Lambda 函数、SAM 模板、单元测试、部署文档）
> - `src/main/license-config.ts`（客户端配置 / 离线兜底）
> - `src/main/subscription-monitor.ts`（客户端状态机、token 存储、网络调用）
> - `src/main/device-id.ts`（试用期设备指纹）
> - `src/main/model-crypto.ts`（本地加密存储原语）
> - `scripts/deploy-license.sh` + `.github/workflows/deploy-license.yml`（CI/CD）

---

## 1. 总体架构

整个授权体系是 **单函数 + 单 Function URL + 四张 DynamoDB 表** 的（另有两张 Ticket 72 前的遗留表，只读、待删）
serverless 架构，没有 API Gateway、没有服务器、没有账号系统。

```
┌──────────────────────────── Electron 桌面端 ─────────────────────────────┐
│  renderer (React)  ──IPC──►  main 进程                                   │
│                              ├─ subscription-monitor.ts  状态机/轮询/计时 │
│                              ├─ license-config.ts        端点/密钥/兜底   │
│                              ├─ device-id.ts             硬件指纹         │
│                              └─ 本地加密文件（见 §6）                     │
└───────────────────────────────────┬──────────────────────────────────────┘
                                    │ HTTPS（electron net.request）
                                    ▼
                     ┌──────────────────────────────────┐
                     │  Lambda Function URL (AuthType   │
                     │  NONE, CORS *)                   │
                     │  区域: us-east-1                  │
                     └───────────────┬──────────────────┘
                                     ▼
              ┌───────────────────────────────────────────────┐
              │  Lambda: LicenseVerifier                      │
              │  python3.11 / arm64 / 256MB / timeout 10s     │
              │  单一 handler.py，按 path 自行路由（§3）        │
              └───┬───────────────┬───────────────┬───────────┘
                  │               │               │
        ┌─────────▼───┐ ┌─────▼────────┐ ┌──▼─────────┐ ┌▼───────────┐
        │ OrdersTable │ │LicensesV2    │ │ TrialsV2   │ │ DemosTable │
        │ PK orderId  │ │ PK userId    │ │PK deviceId │ │ PK demoKey │
        │ GSI userId- │ │ SK appId     │ │ SK appId   │ │ appId#dev  │
        │  createdAt  │ │ GSI license- │ │            │ │            │
        │             │ │  Key         │ │            │ │            │
        └─────────────┘ └──────────────┘ └────────────┘ └────────────┘
                  ▲               ▲
                  │ webhook       │ SES 发信
     ┌────────────┴───────┐  ┌────┴──────────┐
     │ Stripe / Douyin Pay│  │ Amazon SES    │
     └────────────────────┘  └───────────────┘
```

关键设计决策：

| 决策 | 原因 |
|---|---|
| Lambda Function URL 而非 API Gateway | 少一层组件、零额外成本；函数内部按 `rawPath` 自行分发 |
| 全部 DynamoDB 表用 `PAY_PER_REQUEST` | 无请求即零成本，可缩容到 0 |
| 无账号系统，只有匿名 `userId` | 首次启动本地生成 UUID，落盘持久化；仅用于关联订单 |
| 授权凭证是自签名 HMAC token，而非 Stripe 订阅状态 | 过期时间的唯一事实来源在我们自己的 token 里，支持离线宽限期 |
| 单函数多路由 | 所有路由共享 PLANS/签名/DynamoDB 帮助函数，部署一次即可 |
| 每个可选能力缺配置时返回 501 而非崩溃 | 未配置 Stripe/SES/DynamoDB 时其余路由仍可用 |

---

## 2. AWS 资源清单（CloudFormation / SAM）

定义文件：`serverless/verify-license/template.yaml`
（`Transform: AWS::Serverless-2016-10-31`）

Stack 名默认 `ruanjian-license`，区域 `us-east-1`，AWS 账号 `641628981129`
（`scripts/deploy-license.sh` 里有 `EXPECTED_ACCOUNT` 硬校验，防止误部署到别的账号）。

### 2.1 `LicenseVerifier`（AWS::Serverless::Function）

- Runtime `python3.11`，架构 `arm64`，内存 `256MB`，超时 `10s`
- `Handler: handler.handler`，`CodeUri: .`
- `FunctionUrlConfig`: `AuthType: NONE`，CORS 允许 `*` / `GET,POST` / `Content-Type`
- 无 `requirements.txt`：只用标准库 + Lambda 运行时自带的 `boto3`
- 生产 URL 形如
  `https://5pmjnezmzrbjw2tjmnzpt232xy0duvyr.lambda-url.us-east-1.on.aws/`
  （客户端默认值，可用 `LICENSE_URL` 环境变量覆盖）

> 模板注意点：`FunctionUrl` 是自动生成的 `AWS::Lambda::Url` 资源
> （逻辑 ID `LicenseVerifierUrl`）的属性，不是函数本身的属性。
> 写 `!GetAtt LicenseVerifier.FunctionUrl` 会让 stack 更新失败。

### 2.2 `LicenseVerifierRole`（AWS::IAM::Role）

最小权限执行角色，四条内联策略：

1. **WriteLicenseVerifierLogs** — 仅限本函数自己的 CloudWatch 日志组
   `/aws/lambda/${AWS::StackName}-LicenseVerifier:*`
2. **SendLicenseKeyEmail** — `ses:SendEmail`，带条件
   `ses:FromAddress == SesSenderEmail`。参数留空时该权限自然失效（拒绝）。
3. **PaymentOrderStore** — `dynamodb:GetItem/PutItem/UpdateItem/Query`，
   资源仅限三张表及 `OrdersTable` 的索引
4. （无 VPC、无其他权限）

### 2.3 四张 DynamoDB 表（+ 两张待删的遗留表）

| 表 | 主键 | 索引 | 存什么 |
|---|---|---|---|
| `OrdersTable` | HASH `orderId` (S) | GSI `userId-createdAt-index`（HASH `userId`, RANGE `createdAt`, 投影 ALL） | 支付订单：`orderId, userId, planId, method, status(pending/paid), amount, currency, createdAt, providerOrderId, paidAt, providerTxnId` |
| `LicensesV2Table` | HASH `userId` (S) + RANGE `appId` (S) | GSI `licenseKey-index`（HASH `licenseKey`, 投影 ALL） | 当前有效授权：`userId, appId, token, planId, licenseKey, expiresAt, updatedAt` |
| `TrialsV2Table` | HASH `deviceId` (S) + RANGE `appId` (S) | — | 免费试用：`deviceId, appId, trialStart, trialEnd, createdAt, lastSeen` |
| ~~`LicensesTable`~~ / ~~`TrialsTable`~~ | 旧的单键表 | — | **Ticket 72 前的遗留表**，只读回落，backfill 验证后删除。模板里带 `DeletionPolicy: Retain` |
| `DemosTable` | HASH `demoKey` (S) = `"<appId>#<deviceId>"` | — | 演示许可证：`demoKey, appId, deviceId, planId, issuedAt, expiresAt, createdAt` |

全部 `BillingMode: PAY_PER_REQUEST`。GSI 存在的唯一目的是支撑
`GET /payment-history` 按用户倒序列出订单。

### 2.4 外部依赖（非 AWS）

- **Stripe** — Checkout Session（`card` / `wechat_pay` / `alipay`）+
  Subscriptions Search API（旧的手动 key 流程）+ webhook
- **抖音支付（Douyin Pay）** — ecpay `create_order` + 商户回调
- **Amazon SES** — 发送新签发的 license key 邮件（可选）
- **CloudWatch Logs** — 唯一的可观测性手段（无 X-Ray、无告警）

---

## 3. HTTP API（同一个 Function URL，按路径分发）

分发逻辑在 `handler()` 末尾，用 `path.endswith(...)` 依次匹配；
路径来源兼容 Function URL payload 2.0 (`rawPath`)、API Gateway REST
(`requestContext.http.path` / `path`)，因此同一份代码也能跑在阿里云 FC 上。

| 方法 | 路径 | 作用 | 依赖 |
|---|---|---|---|
| POST | `/`（默认） | **license key 校验**，返回签名 token | 支付渠道配置 |
| POST | `/stripe-webhook` | Stripe 事件入口（`checkout.session.completed`） | `STRIPE_WEBHOOK_SECRET` |
| POST | `/douyin-webhook` | 抖音支付结果回调 | `DOUYIN_APP_SECRET` + `ORDERS_TABLE` |
| POST | `/create-order` | 创建订单，返回支付跳转 URL | `ORDERS_TABLE` |
| GET | `/order-status` | 轮询订单；已支付则直接返回 token | `ORDERS_TABLE` |
| GET | `/payment-history` | 列出匿名用户的历史订单 | `ORDERS_TABLE` + GSI |
| GET | `/payment-methods` | 返回**当前真正可用**的支付方式（含本地化名称/图标/颜色） | — |
| GET | `/plans` | 返回四档套餐及服务端计算的价格 | — |
| POST | `/trial/activate` | 幂等创建/读取设备试用记录 | `TRIALS_TABLE` |
| GET | `/trial/status` | 查询设备试用状态 | `TRIALS_TABLE` |
| POST | `/demo/activate` | 幂等签发本应用+本设备的演示许可证，返回签名 token | `DEMOS_TABLE` |
| GET/POST | `/demo/status` | 查询演示许可证状态（不返回 token） | `DEMOS_TABLE` |
| OPTIONS | 任意 | CORS 预检，返回 204 | — |

所有响应都带统一的 CORS 头
（`Allow-Origin: *`，`Allow-Headers: Content-Type, Stripe-Signature`）。
未配置的能力返回 **501**（`_not_configured()`），而不是 500。

### 3.1 `appId` —— 多应用共用同一套 License 服务（Ticket 65a / 65b）

同一个 Function URL 同时服务多个产品，所以每个请求都必须声明"我是哪个应用"，
否则在 A 应用买的订阅会顺带解锁 B 应用。约定的取值（**两个客户端和服务端必须完全一致**）：

| 应用 | `appId` |
|---|---|
| SootheVoice（本仓库） | `smoothvoice` |
| 舒音水印去除 | `shuyin` |

舒音一度也发 `smoothvoice`——理由是它在表里的历史记录没有 appId、backfill 会把它们
盖成这个值、改名会 strand 掉它的付费用户。这个理由不成立：它的 License 代码
2026-08-31 才进仓库，晚于 1.1.0 发版（2026-08-30），**没有任何已发布的构建调用过本
服务**，所以它在表里根本没有行。表里的历史行是 SootheVoice 的——这也正是
`DefaultAppId` 保持 `smoothvoice`、遗留行只按它收编的原因（§5.5）。

两边共用一个 id 期间，`DemosTable` 的 `"<appId>#<deviceId>"` 和 `TrialsV2Table` 的
`(deviceId, appId)` 在同时装了两个应用的机器上会撞成同一个键——在一个应用领过的
演示/试用，在另一个应用里显示为已用掉，正是 appId 维度要堵的那个洞。

**服务端支持状态（Ticket 72 起）**：`/demo/*`、`/trial/*`、`/create-order`、
`/order-status`、`/payment-history` 和默认的 verify 路由**都**按 `appId` 分区。
在此之前只有 `/demo/*` 支持——试用记录仅按 `deviceId`，授权记录仅按 `userId`，
所以同一台机器上两个应用**共用一个试用期**，在一个应用里续费会顺带延长另一个的
到期日。这两条都由 Ticket 72 修掉。

客户端侧（Ticket 65b）：

- 常量定义在 `src/main/license-config.ts` 的 `APP_ID`，同时挂在 `LICENSE_CONFIG.appId` 上；
  构建时可用 `VITE_APP_ID`（或 `APP_ID`）环境变量覆盖，留空则回落到默认值。
- 附加逻辑集中在 `subscription-monitor.ts` 的 `_request()` 这一个出口：
  **POST 写进请求体、GET 拼进 query string**（工具函数在 `src/main/license-request.ts`）。
  因此上表里的每条路由——verify、`trial/*`、`create-order`、`order-status`、
  `payment-history`、`plans`、`payment-methods`——都自动带上 `appId`，新增路由无需再记得加。
- 设备 ID 生成逻辑见 §5.3（Ticket 76 改为优先用操作系统机器标识）；试用记录仍按设备存储，由服务端按 `appId` 分区。
- 向后兼容：老 token 里没有 `appId` 字段，本地视为合法，服务端在下一次 verify 时补齐。
  只有明确标记为**别的** `appId` 的 token 才会被拒绝。
- 不匹配时（服务端返回 `code: 'app_id_mismatch'` 或消息含 appId mismatch）：
  手动激活会给出"该密钥属于其他应用"的专门提示；后台刷新则删除本地 token、
  回到 `unlicensed` 并重新同步试用状态，把用户引导到本应用的试用/订阅。
- 支付回调无需客户端参与：订单记录里已含 `appId`，服务端回调时自动为正确的应用签发 license。

---

## 4. 授权令牌（License Token）

这是整套系统的核心凭证，格式类似 JWT 但自定义：

```
base64url(header) . base64url(payload) . hex(HMAC-SHA256)
```

- header：`{"alg":"HS256","typ":"LICENSE"}`
- payload：
  ```json
  {
    "userId": "…", "planId": "monthly", "licenseKey": "SOOTHEVOICE-XXXX-XXXX-XXXX",
    "expiresAt": 1767225600, "issuedAt": 1764547200,
    "features": ["training", "synthesis", "separation", "cover"],
    "appId": "smoothvoice"
  }
  ```
  （`appId` 由 Ticket 65a 起签发，见 §3.1；早于该版本签发的 token 没有这个字段，
  客户端按向后兼容处理。）
- 签名：`HMAC-SHA256(LICENSE_SIGNING_SECRET, "header.payload")`，hex 输出

服务端签发（`create_token()` in `handler.py`），客户端本地校验
（`verifyToken()` in `subscription-monitor.ts`，用 `timingSafeEqual` 做常量时间比较）。
**同一个共享密钥两端都持有** —— 这是对称 HMAC 方案的固有代价，
代码注释里明确指出生产环境应改为 RSA（服务端私钥签名、客户端内嵌公钥验签）。

### 密钥安全告警

模板默认值 `ruanjian-dev-signing-secret-v1-change-in-production` 同时出现在
`handler.py` 和 `license-config.ts`（公开源码）。两边都有运行时告警：

- 服务端：`MOCK_MODE=false` 且仍用默认值 → stderr 打印 SECURITY WARNING
- 客户端：`usingDefaultSigningSecret` 为 true → `index.ts` 打包构建时告警

因为一旦生产仍用它，任何人都能离线伪造有效 token。

### 4.1 密钥怎么进到打包后的应用里

**不是通过环境变量。** 打包后的 main 进程里，`process.env['LICENSE_SIGNING_SECRET']`
是在**最终用户的机器上**、启动那一刻读的——那里什么都没设。把密钥传给发布 job 曾经
什么也没做：**每一个打包出去的构建都在用 `license-config.ts` 里那个公开默认值校验
授权**，无论 job 拿到了什么。

`electron.vite.config.ts` 的 `main.define` 补上了这一环：构建时把这几个名字替换成
字面量，塞进 main 的 bundle。

| | |
|---|---|
| 替换的名字 | `LICENSE_SIGNING_SECRET`、`PREVIOUS_LICENSE_SIGNING_SECRET`、`LICENSE_URL`、`APP_ID`、`VITE_APP_ID` |
| 构建没给值时 | **不替换**，`process.env['…'] ?? DEFAULT` 表达式原样保留，行为和今天一模一样——公开默认值，加上启动告警 |
| 谁负责传 | `.github/workflows/build-*.yml` 的 `npx electron-vite build` 步骤，从仓库 secrets |
| `npm run dev` | 不受影响，仍然读真实环境变量 |

**一个值如果不在那个构建步骤的 env 里，它就到不了应用。** 传给 electron-builder
那一步也没用——替换发生在 `electron-vite build`。

密钥于是以明文躺在 bundle 里。这是「客户端持密钥做 HMAC 校验」的固有代价，§4 已经
写明并指出 RSA 是解法。但发一个私有字符串不比发公开的那个更糟：区别在于「要从二进制
里挖出来才能伪造」和「任何人照着公开仓库就能伪造」。

### 4.2 轮换签名密钥

轮换 HMAC 密钥和轮换密码不是一回事：**两端持有同一个字符串**，所以服务端一旦改用
新密钥签发，**每一个已经发到用户手上的 token 都会立刻验不过**。客户端把这读作
「授权被吊销」——进入 3 天宽限期，然后锁功能——而这些人的订阅明明还好好的，唯一的
出路是一个他们还没装的更新。

所以必须分两步，而且**第一步要先铺到用户手上**，第二步才能做：

| 步骤 | 做什么 |
|---|---|
| 1. 发一个两把都收的版本 | 在**构建 workflow 的 env** 里设 `PREVIOUS_LICENSE_SIGNING_SECRET=<当前密钥>`，`LICENSE_SIGNING_SECRET` 不动——由 §4.1 的 define 塞进 bundle。**设在那个构建步骤看不到的地方等于没设。** 此刻对任何人都毫无变化。 |
| 2. 等 | 等到装机量里足够多的人升上来。没有办法加速，而**抢跑正是这整件事要避免的**。 |
| 3. 服务端切换 | `sam deploy --parameter-overrides LicenseSigningSecret=<新密钥>`。新 token 用新密钥签，旧 token 在客户端仍然验得过。 |
| 4. 等它自己收敛 | 每个客户端在下次启动时自行换掉手上的 token——见下。 |
| 5. 发一个去掉旧密钥的版本 | 不再设 `PREVIOUS_LICENSE_SIGNING_SECRET`，旧密钥彻底停止被接受。 |

`verifyToken()` **先试当前密钥、失败才试上一把**，所以额外开销只落在轮换前签发的
那批 token 上，一次 HMAC。签发（`createToken`）**永远只用当前密钥**——这个应用不
会用旧密钥铸造任何 token。

**第 4 步自己会完成。** 启动时如果本地 token 只在上一把密钥下验得过
（`verifiedWithPreviousSecret()`，在 `initialize()` 里读），就立刻触发一次
`refresh()` 把 license key 换成用新密钥签的 token。刻意不 await、失败也不报错：
手上的 token 本来就还能用，这只是一个优化，下次启动会再试。**没有这一步的话**，
客户端会一直用着旧 token 直到过期，然后被第 5 步的版本锁在门外。

**同时接受两把密钥的代价。** 旧密钥签的 token 仍然验得过，所以如果轮换的原因正是
**旧密钥泄露了**，那么在整个窗口期内泄露仍然可被利用。这就是这笔交易：拿「泄露的
密钥还能再用一阵子」换「不把每一个付费用户都登出」。**这是一个要穿过去的窗口，不是
一个可以一直待着的状态**——`rotatingSigningSecret` 会在每次启动时告警，正是为此。

两个客户端都实现了这套：本仓库的 `src/main/`，以及舒音的 `electron/`
（`PREVIOUS_LICENSE_SIGNING_SECRET`，另接受 `VITE_` 前缀的同名变量）。
Lambda 本身**不需要改**——它只签发、从不校验 license token
（`_verify_stripe_signature` 和抖音回调用的是各自支付渠道的密钥，与此无关）。

---

## 5. 三条授权发放路径

### 5.1 订单支付流程（主路径，Ticket 28）

```
客户端                     Lambda                     支付渠道
  │                          │                            │
  │ GET /plans               │                            │
  │ GET /payment-methods     │                            │
  ├─────────────────────────►│                            │
  │                          │                            │
  │ POST /create-order       │                            │
  │  {planId, method, userId}│                            │
  ├─────────────────────────►│ 创建 Checkout / ecpay 订单  │
  │                          ├───────────────────────────►│
  │                          │◄───────────────────────────┤
  │                          │ PutItem OrdersTable        │
  │◄─────────────────────────┤ {redirectUrl, presentAs}   │
  │                          │                            │
  │ 打开支付页（见下）        │                            │
  │                          │                            │
  │                          │◄─── webhook（用户付款后）───┤
  │                          │ _settle_paid_order()       │
  │                          │  ├ UpdateItem 条件写(幂等)  │
  │                          │  └ 签发/续期 token → Licenses
  │ GET /order-status （3s 轮询，10min 超时）              │
  ├─────────────────────────►│                            │
  │◄─── {status:"paid", token} ──────────────────────────┤
  │ 本地校验 → 加密落盘 → 状态机更新（无需重启）           │
```

**支付方式路由**（`_create_stripe_order` / `_create_douyin_order`）：

| 方式 | 渠道 | 呈现方式 (`presentAs`) |
|---|---|---|
| `card` | Stripe Checkout | `external`（系统浏览器） |
| `alipay` | Stripe Checkout | `external` |
| `wechat_pay` | Stripe Checkout（`payment_method_options[wechat_pay][client]=web`） | `embedded`（应用内窗口显示二维码） |
| `douyin_pay` | 抖音开放平台 ecpay `create_order` | `embedded` |

注意：Stripe 用的是 **一次性支付**（`mode=payment`），不是 Stripe 订阅对象 ——
到期时间由我们自己的 token 决定。

**幂等性**（关键）：`_mark_order_paid()` 用 DynamoDB 条件更新
`ConditionExpression="attribute_exists(orderId) AND #s = :pending"`。
只有第一次调用才真正把 `pending → paid` 并触发发放；webhook 重试命中
`ConditionalCheckFailed` 时返回 `None`，调用方一律视为「不要重复发放」。
所有 webhook 共用 `_settle_paid_order()`，把这段易错逻辑收在一处。

**续期叠加**（`_issue_or_extend_license`）：若 `LicensesTable` 中已有记录且
`expiresAt` 仍在未来，则从**原到期时间**往后加，而不是从当下重新计时。

### 5.2 传统手动 key 流程（legacy）

静态 Stripe Payment Link（subscription 模式）→ `checkout.session.completed`
webhook 且 metadata 无 `orderId` → `_generate_license_key()` 生成
`SOOTHEVOICE-XXXX-XXXX-XXXX` → 写入 Stripe 订阅的
`metadata.license_key` → （可选）SES 邮件发给客户 → 用户在应用里手动输入
→ `POST /` → `_check_stripe()` 通过 **Stripe Subscriptions Search API**
按 metadata 反查（这是 Stripe 唯一支持按自定义 metadata 查询的接口）
→ 签发 token。

`_check_payment_provider()` 是渠道抽象点，支持：
- `MOCK_MODE=true`：任何 key 都通过（仅 CI/演示）
- `stripe`：`_check_stripe()`
- `lemonsqueezy`：`_check_lemonsqueezy()`（激活校验接口）
- `custom`（默认）：任何 ≥8 字符的 key 都算有效，userId 由 key 的 SHA-256 派生

### 5.3 免费试用（Ticket 33，时长 3 天 / Ticket 42）

- 客户端用 `getDeviceId()` 生成设备指纹，三级信号（Ticket 76 修订）：
  1. **已落盘的 `.device_id`** —— 永远优先，所以既有安装的 id 绝不会变。
  2. **操作系统自己的机器标识** —— Linux `/etc/machine-id`、macOS `IOPlatformUUID`、
     Windows `MachineGuid`。装系统时写下、和这个应用的安装卸载无关，正是想要的性质。
  3. **过滤后的 MAC 信号** + platform + arch，做 SHA-256。
  4. 都拿不到时退回随机 UUID（不跨重装，但好过拒绝开试用）。

  **Ticket 76 之前只有第 3 条，而且不过滤**——信号是「那一刻存在的每一块非回环网卡」：
  Docker 网桥、VPN 的 tun、扩展坞的网口，以及决定性的 **Wi-Fi MAC 随机化**
  （macOS / Windows 默认每个网络一个私有 MAC）。卸载和重装之间换过网络，集合就变了，
  摘要就变了，服务端于是完全正确地判定这是一台没见过的机器——**这就是物理机重装后
  试用期被重置的原因**。现在按「本地管理位」（首字节 bit 1）剔除随机/虚拟地址，
  再按接口名剔除已知的虚拟网卡。
- `POST /trial/activate`：`put_item(..., ConditionExpression="attribute_not_exists(deviceId)")`
  —— 第一次创建，之后每次调用都命中条件失败分支并**原样返回**已有记录，
  绝不重置 `trialStart/trialEnd`。
- `GET /trial/status`：返回 `trialUsed / trialStart / trialEnd / expired /
  trialDurationDays`，并 best-effort 更新 `lastSeen`。
- **时长下调迁移**（`_apply_trial_duration_cap`）：历史上 TRIAL_DAYS 曾是 7，
  现为 3。读取时如果记录仍在有效期内且跨度超过当前 `TRIAL_DAYS`，
  就把 `trialEnd` 截断到 `trialStart + TRIAL_DAYS`（写入带
  `attribute_exists(deviceId)` 防止 upsert 出残缺记录）；已过期的记录不动。
  幂等，写失败也照样返回修正值。
- 响应里回传 `trialDurationDays`，客户端把它缓存进本地记录
  （`LocalTrialRecord.durationDays`），避免「客户端和服务端各自硬编码天数」
  再次出现 7 vs 3 的分歧。

**试用状态解析优先级**（客户端 `_resolveTrial()`）：
1. 后端可达且该设备已有记录 → **后端为准**
2. 后端可达但无记录 → 调用 activate 建立（幂等）
3. 后端不可达 → 用本地记录；首次启动且离线则本地创建

### 5.4 演示许可证（`/demo/activate`）

免费试用给的是"这个应用能用几天"，演示许可证给的是 **`DEMO_DAYS`（默认 30）天
的完整付费功能**，用于演示、评测和支持人员复现客户环境。

在此之前，演示许可证是**客户端自己用共享 HMAC 密钥签发**的：客户端里硬编码一串
演示码，校验通过就本地 mint 一个 token，"每设备一次"只靠应用数据目录里的一个
文件兜底。这有两个无法回避的问题——演示码随安装包一起发出去，而唯一的次数限制
是用户自己就能删掉的文件。把签发挪到服务端就是为了消掉这两点：

- **没有演示码**。凭据不再是"知道某个字符串"，而是"这台设备在这个应用上还没领
  过"。因此也没有可以泄露、需要轮换的演示码。
- **一应用一设备一次**，记录在 `DemosTable`，主键 `"<appId>#<deviceId>"`。
  分区键带 `appId` 的理由和 §3.1 一样：在 A 应用领过的演示不是 B 应用的演示。
  `appId` 与 `deviceId` 的字符集都排除了 `#`（`_APP_ID_RE` / `_DEVICE_ID_RE`），
  所以 `"a#b" + "c"` 不可能和 `"a" + "b#c"` 撞键。
- **幂等，但不续期**。和 `/trial/activate` 同样的
  `ConditionExpression="attribute_not_exists(demoKey)"`：第一次调用建记录，
  之后每次都读回**原来那个窗口**，并按原 `expiresAt`/`issuedAt` 重新签一个
  token。所以重装、丢 token 都能恢复，但拿不到更多时间。窗口过完之后再调用
  返回 **409 `demo_already_used`** —— 客户端把它和网络失败区分开来措辞。
- **token 就是普通的 license token**（§4 的格式，同一把签名密钥），只是
  `planId` 为 `DEMO_PLAN_ID`（默认 `demo`），刻意不属于 `_PLAN_TIERS` 里任何一
  档，任何读许可证的地方都能一眼把演示和购买区分开；payload 里带 `appId`。
- `GET/POST /demo/status` 只回状态，**不回 token** —— 状态查询不该成为
  重新领取许可证的通道。客户端在画按钮之前先问它，已经领过的设备直接告知，而不
  是点下去才发现。
- 响应回传 `demoDurationDays`，理由同 §5.3 的 `trialDurationDays`：避免客户端和
  服务端各自硬编码天数。

与试用不同，**演示时长的调整不追溯**：token 已经在客户端手里，改短记录也改不短
已签发的 token，所以这里没有 `_apply_trial_duration_cap` 那样的截断逻辑。

`DEMOS_TABLE` 未配置时两条路由都返回 501，和其他可选能力一致。

### 5.5 `appId` 隔离与 Ticket 72 迁移

Ticket 72 之前，`TrialsTable` 只按 `deviceId` 记录、`LicensesTable` 只按
`userId` 记录。后果是实打实的：同一台机器上，SootheVoice 和舒音**共用一个三天
试用期**——后打开的那个应用发现试用已经用掉了；而在一个应用里续费，会顺着同一条
`userId` 记录**延长另一个应用的到期日**。

#### 表结构

两张表都重建为复合主键：

| 表 | HASH | RANGE |
|---|---|---|
| `TrialsV2Table` | `deviceId` | `appId` |
| `LicensesV2Table` | `userId` | `appId` |

**分区键选 `deviceId`/`userId` 而不是 `appId`**：账号上只有个位数个应用，用
`appId` 做分区键会把所有写入挤进这几个分区（DynamoDB 单分区 1000 WCU 上限）。
按设备/用户分区则天然打散，而且「这台设备/这个用户手上的所有记录」变成一次
`query` 就能拿到——backfill 和客服排查要的正是这个。

`LicensesV2Table` 另有 GSI `licenseKey-index`（HASH `licenseKey`，投影 ALL）。
这是全文件唯一一处**不预先知道 `(userId, appId)`** 的查询：一串 license key 单独
到达 verify 路由，要判断的正是「它属不属于这个应用」。投影必须是 ALL，因为
`_find_license_by_key()` 要从命中的行上读 `expiresAt`。

#### 迁移：backfill，不是 cutover

DynamoDB 不能原地改主键，所以只能建新表搬数据。但**不做硬切换**——
`handler.py` 在新表未命中时会去读遗留表（`_adopt_legacy_trial` /
`_adopt_legacy_license`），把找到的行按 `DEFAULT_APP_ID` 收编进新表。因此部署与
迁移脚本的先后顺序**不影响正确性**：中间窗口里没有人会白拿第二个试用期，也没有
人的订阅会消失。跑迁移脚本换来的是——遗留表不再承重，可以删掉，回落逻辑也可以
一并移除。

**遗留行只归 `DEFAULT_APP_ID`。** 旧表没有应用维度，是因为当时只有一个应用；
把它的行给「先来问的那个应用」，等于替兄弟应用花掉它的试用期，而真正的主人反倒
拿到一个新的——正是这张单要修的 bug，反过来又犯一遍。所以其他 `appId` 在遗留表
里什么也看不见，会正常开始自己的试用期。

遗留表在模板里带 `DeletionPolicy: Retain` / `UpdateReplacePolicy: Retain`：
以后从模板里删掉这两个资源时，**不会**把数据一起删掉。IAM 上它们只给了
`dynamodb:GetItem`——函数收编时是往新表写，从不回写旧表。

#### 迁移步骤

```bash
# 1. 部署（创建 V2 表 + GSI，函数切到 V2，遗留表保留只读回落）
sam build && sam deploy

# 2. 从 stack outputs 取表名
aws cloudformation describe-stacks --stack-name ruanjian-license \
  --query "Stacks[0].Outputs" --output table

# 3. 先空跑，什么都不写
python3 serverless/verify-license/migrate_app_id.py \
  --trials-from   <TrialsTableName>   --trials-to   <TrialsV2TableName> \
  --licenses-from <LicensesTableName> --licenses-to <LicensesV2TableName>

# 4. 确认无误后再写
python3 serverless/verify-license/migrate_app_id.py ... --apply
```

脚本是**幂等**的：目标表里已存在的行绝不覆盖（`attribute_not_exists` 条件写），
所以中断后重跑能补完，跑完再跑是空操作。这也意味着**函数已经收编过的行胜过脚本的
副本**——那是更新的事实，方向是对的。

验证 backfill 完成后，再单独提一个 PR 删掉两张遗留表资源、两个 `LEGACY_*` 环境
变量和 `_adopt_legacy_*` 回落逻辑。

---

## 6. 客户端存储（Electron `userData` 目录）

| 文件 | 内容 | 保护 |
|---|---|---|
| `license.enc` | 签名 token 密文 | AES-256-GCM（`model-crypto.ts`，机器绑定密钥），`mode 0o600` |
| `trial.enc` | `{trialStart, trialEnd, durationDays}` 密文 | 同上。加密不是因为日期机密，而是防止手改文件延长试用 |
| `.license_ts` | 8 字节大端 uint64，见过的最大时间戳 | 明文，防调表 |
| `.anon_id` | 匿名支付用户 UUID | 明文（非机密），`0o600` |
| `.device_id` | 硬件派生设备指纹 | 明文（非机密） |

加密格式：`nonce(12) | authTag(16) | ciphertext`，AES-256-GCM。

**防篡改时钟**：每次成功校验都把 `max(now, 已存最大值)` 写回 `.license_ts`；
若启动时 `now < max - 60`（60 秒容 NTP 抖动），判定为调表，直接置
`expired`。

---

## 7. 客户端状态机与后台任务

`SubscriptionMonitor`（单例，`EventEmitter`）状态：

```
loading → unlicensed | invalid | active | grace_period | expired
```

- `active`：`now < expiresAt`
- `grace_period`：`expiresAt ≤ now < expiresAt + gracePeriodDays(3)*86400`
  —— 离线/网络故障时仍可用，避免误锁
- `expired`：超过宽限期

后台计时器：
- **license 刷新**：每 `refreshIntervalHours = 12` 小时调用 `refresh()`
  → 重新 `POST /` 换新 token；网络失败则静默沿用本地 token + 宽限期
- **试用同步**：每 `trial.syncIntervalHours = 6` 小时重试同步未同步的本地试用

网络层 `_request()`：走 `electron.net.request`，**默认 15s 超时**；
启动路径上的 `_resolveTrial()` 显式用 **5s**（启动预算，Ticket 38）。
超时会 `req.abort()` 真正断开 socket，而不只是停止 await。

主进程 IPC 面（`src/main/index.ts`）：

```
license:get-state / license:activate / license:deactivate /
license:refresh / license:get-config
license:state-changed   （主 → 渲染 推送）

payment:get-plans / payment:get-methods / payment:create-order /
payment:order-status / payment:history /
payment:open-embedded / payment:close-embedded / payment:window-closed
```

```
license:activate-demo / license:demo-status   （演示许可证，见 §5.4）
```

**演示许可证不再有「密钥」。** 在此之前，`license-config.ts` 里硬编码着一串
57 字符（记录在已删除的 `DEMO_LICENSE.md` 里），输进激活框就本地生成一个 30 天
token，不走网络，**而且完全没有次数限制**。这两半都不成立：那串字符随每个安装包
发出去，所以「知道它」从来不是凭据；而次数根本没人数。

现在由服务端签发（`POST demo/activate`，每个 `(appId, deviceId)` 一次，记录在
`DemosTable`），客户端只保留一份加密缓存。`refresh()` 仍然跳过演示 token，但判据
从「等于那串 key」换成了 `planId === 'demo'`——verify 路由只认购买。

---

## 8. 定价与套餐（服务端为唯一事实来源）

`_build_plans()` 由三个环境变量算出四档套餐：

| planId | period | 天数 | 折扣 |
|---|---|---|---|
| `monthly` | month | 30 | 0% |
| `quarterly` | quarter | 90 | 5% |
| `semi_annual` | half_year | 180 | 10% |
| `annual` | year | 365 | 15% |

- `BASE_MONTHLY_PRICE` 默认 `99`，`PLAN_CURRENCY` 默认 `cny`
- 金额用 `Decimal` + `ROUND_HALF_UP` 计算（浮点二进制舍入对钱是真实误差）；
  CNY 取整到元，其他币种保留 2 位小数
- `priceUSD` / `originalPriceUSD` 仅供英文 UI **展示**，按
  `USD_EXCHANGE_RATE`（默认 7.0）换算；**实际扣款永远用 `PLAN_CURRENCY`**
- `originalPrice`（划线原价）单独按 0% 折扣一次性算出，而不是让客户端
  用已舍入的月价乘月数（否则会二次舍入漂移，与折扣角标对不上）
- `amount` 是最小货币单位（分），传给支付渠道用

`license-config.ts` 里有一份**完全相同的公式**，但仅作
`GET /plans` 失败时的离线兜底；两处需保持同步。

`GET /payment-methods` 同理接管了支付方式的可用性与展示元数据
（名称/图标/颜色，按 `lang` 本地化），客户端不再硬编码 id→标签映射，
只保留兜底和渲染历史订单（某渠道下线后旧订单仍要有可读标签）。
`DISABLED_PAYMENT_METHODS`（逗号分隔）可强制隐藏某渠道，
例如抖音商户资质审核期间。

---

## 9. Webhook 安全

**Stripe**（`_verify_stripe_signature`）：按 Stripe 文档解析
`Stripe-Signature` 头的 `t=` 与 `v1=`，对 `f"{t}.".encode() + raw_body`
做 HMAC-SHA256，`hmac.compare_digest` 比对，并要求 `|now - t| ≤ 300s`
防重放。必须用**原始字节**（`_raw_body()` 处理 base64 编码的 body）。

处理异常时返回 **200 而非 500** —— Stripe 对失败的 webhook 会重试 3 天，
一次我方瞬时错误不该引发重试风暴；失败信息记入响应体和日志，人工补发。

**抖音**（`_douyin_signature`）：参数排序（排除 `sign` 与空值）→
`k=v` 用 `&` 拼接 → HMAC-SHA256(secret) → hex。回调同样做
`compare_digest` 比对，并在 payload 含 `timestamp` 时做 300s 时效检查
（字段名需按商户类型对照最新抖音文档确认，缺字段时跳过而不是全拒）。

> 代码注释明确标注：抖音的签名算法（HMAC-SHA256 vs 旧版 MD5）、
> 接口路径、回调 ack 格式，上线前必须按自己的商户类型对照
> 抖音开放平台 / 精选联盟-支付 文档核实。当前实现的是常见的 ecpay 方案。

---

## 10. 输入校验

Function URL 是 `AuthType: NONE`，即完全公开，所有输入都是攻击者可控：

- `_LICENSE_KEY_RE = ^[A-Za-z0-9_-]{8,64}$` —— 必须先校验再用，因为
  `_check_stripe()` 会把 key 插进 **Stripe 搜索查询语句**
  （另有 `_escape_search_value()` 转义反斜杠和单引号）
- `_DEVICE_ID_RE = ^[A-Za-z0-9_-]{16,128}$` —— 覆盖 SHA-256 hex（64）
  与 UUID 兜底；会进入 DynamoDB 主键操作
- `planId` 必须在 `PLANS` 内，`method` 必须在 `PAYMENT_METHODS` 内
  **且**在 `_available_payment_methods()` 内（否则直接 400，
  而不是让它掉进渠道调用里变成难懂的 502）
- `userId` 非空且 ≤128 字符
- `GET /order-status` 要求 `orderId` **和** `userId` 同时匹配，否则 404
  —— 防止用订单号横向枚举他人订单

另外 `_from_decimal()` 在**读取边界**统一把 DynamoDB 的 `Decimal`
转回 int/float，避免每个调用点各自处理 `json.dumps` 的 TypeError。

`_parse_positive_float()` 保证畸形数字环境变量不会在 import 期抛异常 ——
因为所有路由共用这一个模块，import 失败会让**全部**路由 500，而不只是 `/plans`。

---

## 11. 配置项（Lambda 环境变量 / SAM 参数）

| 环境变量 | SAM 参数 | 必需 | 说明 |
|---|---|---|---|
| `LICENSE_SIGNING_SECRET` | `LicenseSigningSecret` | ✅ | HMAC 密钥，≥32 字符，须与客户端一致 |
| `PREVIOUS_LICENSE_SIGNING_SECRET` | — | | **仅客户端**。轮换期间额外接受的上一把密钥，从不用于签发——见 §4.2。Lambda 不读它 |
| `MOCK_MODE` | `MockMode` | | `true` 时任何 key 都通过，仅 CI/演示 |
| `PAYMENT_PROVIDER` | `PaymentProvider` | | `custom`(默认)/`stripe`/`lemonsqueezy`/`paddle` |
| `EXPIRY_DAYS` | `ExpiryDays` | | 旧 key 流程签发的 token 有效期，默认 30 |
| `TRIAL_DAYS` | `TrialDays` | | 试用天数，默认 3 |
| `STRIPE_API_KEY` | `StripeApiKey` | | 启用 card/微信/支付宝 与 Stripe 校验 |
| `STRIPE_WEBHOOK_SECRET` | `StripeWebhookSecret` | | `whsec_…`，接受 Stripe webhook 所需 |
| `LEMON_API_KEY` | `LemonApiKey` | | Lemon Squeezy |
| `SES_SENDER_EMAIL` | `SesSenderEmail` | | 已验证的 SES 发件地址；留空则不发信 |
| `SES_REGION` | — | | 默认取函数自身 `AWS_REGION` |
| `ORDERS_TABLE` / `LICENSES_TABLE` / `TRIALS_TABLE` / `DEMOS_TABLE` | 自动注入 | | 四张表名，由模板 `!Ref` 注入（后两者现指向 V2 表） |
| `LICENSES_KEY_INDEX` | 模板写死 | | `licenseKey-index`，verify 路由用它判断某个 key 属于哪个应用 |
| `LEGACY_LICENSES_TABLE` / `LEGACY_TRIALS_TABLE` | 自动注入 | | Ticket 72 前的单键表，**只读回落**；backfill 验证后连同表一起删除 |
| `DEMO_DAYS` | `DemoDays` | | 演示许可证时长，默认 30 |
| `DEMO_PLAN_ID` | `DemoPlanId` | | 演示 token 的 `planId`，默认 `demo`（刻意不属于任何付费档） |
| `DEFAULT_APP_ID` | `DefaultAppId` | | 请求未声明 `appId` 时的归属，默认 `smoothvoice` |
| `BASE_MONTHLY_PRICE` | `BaseMonthlyPrice` | | 默认 `99` |
| `PLAN_CURRENCY` | `PlanCurrency` | | 默认 `cny` |
| `USD_EXCHANGE_RATE` | `UsdExchangeRate` | | 默认 `7.0`，仅用于展示 |
| `PAYMENT_SUCCESS_URL` / `PAYMENT_CANCEL_URL` | 同名参数 | | Stripe Checkout 回跳地址（应用实际不加载该页，靠轮询判断） |
| `DOUYIN_APP_ID` / `DOUYIN_MERCHANT_ID` / `DOUYIN_APP_SECRET` / `DOUYIN_NOTIFY_URL` | 同名参数 | | 抖音支付，留空即禁用 |
| `DISABLED_PAYMENT_METHODS` | — | | 逗号分隔，强制隐藏某些支付方式 |

客户端侧：`LICENSE_URL`（main）/ `VITE_LICENSE_URL`（renderer）、
`LICENSE_SIGNING_SECRET`、`PREVIOUS_LICENSE_SIGNING_SECRET`（见 §4.2）、
`CHECKOUT_URL`、`LICENSE_PROVIDER`。`DEMO_LICENSE_KEY` 已随硬编码演示密钥一并移除。

---

## 12. CI/CD 部署管线

**触发**：push 到 `main` 且改动
`serverless/verify-license/**`、`scripts/deploy-license.sh`、
或该 workflow 自身；也可从 Actions 页手动 `workflow_dispatch`。

**流程**（`.github/workflows/deploy-license.yml`）——三个 job，权限逐级放大：

| Job | AWS 角色 | 能改生产吗 | 闸门 |
|---|---|---|---|
| `test` | 无（连 `id-token` 权限都不给） | 否 | — |
| `plan` | `AWS_PLAN_ROLE_ARN`：无 `ExecuteChangeSet` / `DeleteStack` / DynamoDB 数据面 | **否** | — |
| `apply` | `AWS_DEPLOY_ROLE_ARN` | 是 | `production` environment 的人工审批 |

1. `test`：`python3 -m unittest test_handler -v`（失败即中止，不碰 AWS）
2. `plan`：OIDC 取 plan 角色 → `PLAN_ONLY=true scripts/deploy-license.sh`，
   只创建并打印 change-set，**不执行**
3. `apply`：等人工审批放行 → OIDC 取 deploy 角色 → `scripts/deploy-license.sh`

审批者读的是 `plan` 打印出来的真实资源 diff，而 `plan` 这个 job
在 IAM 层面就没有能力把它应用上去。

**密钥作用域**：`LICENSE_SIGNING_SECRET` 等已从 repository secrets 降为
**environment secrets**（`license-plan` / `production`），仓库里其他
workflow 读不到。两个 environment 都要把 Deployment branches 限定为
`main`——改用 `environment:` 形式的 OIDC claim 后，`sub` 里不再含分支，
分支限制只能由 GitHub 侧提供。

**`scripts/deploy-license.sh` 做的事**：
- 校验 `LICENSE_SIGNING_SECRET` 存在（支持 `_FILE` 变体和交互式输入）
- `sts get-caller-identity` 校验账号 == `641628981129`，否则拒绝部署
- 若 stack 处于 `REVIEW_IN_PROGRESS` / `ROLLBACK_COMPLETE` / `CREATE_FAILED`
  这类不可更新状态，先删除再重建
- `sam build` → `sam deploy --resolve-s3 --capabilities CAPABILITY_NAMED_IAM`
- `PLAN_ONLY=true` 时改用 `--no-execute-changeset`，并跳过上面那步删 stack
  的清理逻辑与结尾的 stack outputs——预览不该有副作用
- **只为非空的可选 secret 追加 `--parameter-overrides`** ——
  `sam deploy` 的简写语法会直接拒绝 `StripeApiKey=` 这种显式空值
- 失败时打印最近 20 条 CloudFormation 事件；成功时打印 stack outputs（含 Function URL）

**并发**：`concurrency: deploy-license`，`cancel-in-progress: false` ——
中断的 `sam deploy` 会把 stack 留在 `UPDATE_ROLLBACK_FAILED`，需人工清理。

### 部署踩坑（`CI_DEPLOY_SETUP.md` 已记录，非常重要）

1. **OIDC trust policy 的 `sub` 必须用带数字 ID 的形式**：
   `repo:AryaLi1996@82909467/ruanjian123@1335383385:ref:refs/heads/main`。
   仓库/账号改过名后，GitHub 会永久在 claim 里打上稳定数字 ID，
   朴素的 `repo:AryaLi1996/ruanjian123:...` **永远匹配不上**。
   （该值取自真实 CloudTrail `AssumeRoleWithWebIdentity` 事件的
   `userIdentity.userName`，非猜测。）
2. **不要给 job 加 `environment:`**，哪怕环境没有任何保护规则 ——
   它会把 `sub` claim 从 `...:ref:refs/heads/main` 变成
   `...:environment:<name>`，静默打断信任策略。这个问题已实际发生过一次。
   若确需人工审批闸门，必须同时在 trust policy 的 `sub` 条件里
   （`StringLike` 支持列表，OR 语义）补上 environment 形式。
3. **IAM 权限里的 `SamTransform` 语句不能漏，且其 Resource 在 `aws` 账号下**
   （`arn:aws:cloudformation:us-east-1:aws:transform/Serverless-2016-10-31`），
   不是自己的账号。漏掉时 OIDC 认证、`sam build`、S3 上传全都成功，
   直到 changeset 阶段才报 `not authorized to perform: cloudformation:CreateChangeSet`。
4. **可选 secret 要么不设，要么设真值**，不要设成空字符串。

**所需 GitHub repository secrets**：
`AWS_DEPLOY_ROLE_ARN`（必需）、`LICENSE_SIGNING_SECRET`（必需）、
`STRIPE_API_KEY` / `STRIPE_WEBHOOK_SECRET` / `LEMON_API_KEY` /
`SES_SENDER_EMAIL`（可选）。

---

## 13. 可移植性

同一份 `handler.py` 也能部署到**阿里云函数计算 FC**：
- `_request_path()` 兼容 FC 的 `event["path"]`
- `_send_license_key_email()` 在没有 `boto3` 时返回 `False` 而不抛异常
- `_ddb_table()` 在没有 `boto3` 时返回 `None`，相关路由降级为 501
- 文档中提到 `FC_COMPAT` 环境变量用于 FC 的事件格式差异

---

## 14. 已知弱点 / 后续方向

| 问题 | 现状 | 建议 |
|---|---|---|
| 对称 HMAC 密钥两端都有 | 客户端持有签名密钥，可离线伪造 token | 改 RSA：服务端私钥签名，客户端内嵌公钥 |
| Function URL `AuthType: NONE` | 完全公开，靠输入校验 + webhook 签名兜底 | 视需要加节流 / WAF |
| 无限流 / 无告警 | 仅 CloudWatch Logs | 加 Lambda reserved concurrency、CloudWatch 告警 |
| 单设备授权 | 一个 key 一台设备 | README §「未来」提到 v0.5 做多设备注册（最多 3 台） |
| 定价公式两处硬编码 | 服务端为准，客户端为离线兜底 | 修改时务必两边同步 |
| 抖音支付实现待核实 | 签名算法/接口路径/回调格式按通用 ecpay 方案实现 | 上线前对照商户类型的官方文档确认 |
| DynamoDB 表无 TTL / 无备份配置 | 数据永久保留 | 视合规要求加 PITR |

---

## 15. 快速定位表

| 想改什么 | 改哪里 |
|---|---|
| 换支付渠道 | `handler.py` 的 `_check_payment_provider()` 一个函数 |
| 改价格/折扣 | SAM 参数 `BaseMonthlyPrice` / `PlanCurrency`（并同步 `license-config.ts` 兜底） |
| 改试用天数 | SAM 参数 `TrialDays`（旧记录会被 `_apply_trial_duration_cap` 自动截断） |
| 临时下线某支付方式 | 环境变量 `DISABLED_PAYMENT_METHODS` |
| 改宽限期 / 刷新频率 | `license-config.ts` 的 `gracePeriodDays` / `refreshIntervalHours` |
| 换部署账号或 stack 名 | `scripts/deploy-license.sh` 的 `EXPECTED_ACCOUNT` / `STACK_NAME` |
| 加新 API 路由 | `handler.py` 末尾 `handler()` 的路径分发链 + `subscription-monitor.ts` 的 `_request()` 调用 |
| 改本应用的 `appId` | `license-config.ts` 的 `APP_ID`（或构建时 `VITE_APP_ID`），并同步服务端登记与本文档 §3.1 |

---

## 16. 生成测试激活码（`generate_test_license.py`）

服务端没有任何一条路由会凭空发一个 licenseKey：密钥只在 Stripe webhook 和
`_issue_or_extend_license()` 里诞生，两者都要先有付款。所以测试"输入激活码
→ 解锁"这条链路，必须在带外造一个码，这就是
`serverless/verify-license/generate_test_license.py` 的用途。

它 **import handler.py** 而不是复述其中任何逻辑，因此生成的密钥格式、令牌
声明、表记录三者与已部署函数天然一致——`_valid_license_key_format`、
`create_token`、`_license_key` 都是同一份代码。

### 两种模式

| 模式 | 做什么 | 什么时候用 |
|---|---|---|
| 默认（离线） | 打印一个 `TEST-XXXX-XXXX-XXXX` 密钥和一枚用 `LICENSE_SIGNING_SECRET` 签名的令牌，**不写任何存储** | `MOCK_MODE=true` 或 `custom` provider 下任何合法格式的密钥都能通过；也可以把令牌直接塞给只验签名的客户端 |
| `--write` | 额外按 `_issue_or_extend_license()` 的字段形状把记录写入 `LICENSES_TABLE`（键为 `(userId, appId)`） | 需要真实部署认这个码时——验证路由通过 licenseKey GSI 找到记录，读出它的 `appId` 和 `expiresAt` |

`--write` 需要 boto3、AWS 凭证，以及 `LICENSES_TABLE` 指向已部署的表名；表
没配置时报错而不是静默成功，避免把一个其实没人存过的码当成可用的码交出去。

### 常用命令

```bash
cd serverless/verify-license

# 给兄弟应用（去水印客户端，appId = shuyin）发一个年付测试码并写表
LICENSES_TABLE=<已部署的表名> \
  python3 generate_test_license.py --app-id shuyin --plan annual --write

# 一次五个，JSON 输出，什么都不写
python3 generate_test_license.py --count 5 --json

# 已经过期的授权——这是有意走到客户端 expired / 宽限期状态的唯一办法
python3 generate_test_license.py --days -1
```

| 参数 | 含义 |
|---|---|
| `--app-id` | 授权归属哪个应用，默认 `DEFAULT_APP_ID`（`smoothvoice`）；去水印客户端是 `shuyin` |
| `--plan` | `monthly` / `quarterly` / `semi_annual` / `annual` / `demo`；`demo` 的长度取 `DEMO_DAYS` 而非套餐表 |
| `--days` | 覆盖套餐长度，可以为负 |
| `--user-id` | 默认按 `custom` provider 的同一套哈希从密钥推导，因此不写表的码也能验成同一个用户 |
| `--key` | 用指定密钥而不是随机生成（隐含 `--count 1`） |
| `--count` / `--prefix` / `--json` | 数量、密钥前缀、输出格式 |

`--app-id` 不是可选的细节：写给 `smoothvoice` 的码在客户端以 `shuyin` 激活
时会被验证路由以 `app_id_mismatch` 403 拒绝——这正是 §3.1 的隔离要生效的
地方。

单元测试在 `test_generate_test_license.py`，断言走的是 handler 自己的校验
函数和 `handler()` 验证路由，而不是复检脚本刚生成的形状。CI 的 test job 现
在用 `python3 -m unittest discover` 跑整个目录，新增测试文件不需要再改
workflow。

**这些码等同于一次购买**：对任何用同一把密钥签名的部署来说，它们与付费令牌
无法区分。生产密钥下生成的码要按凭证对待。
