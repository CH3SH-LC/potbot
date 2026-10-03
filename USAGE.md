# 使用说明

本文件说明如何构建、运行与验证本项目。设计说明见 [README.md](README.md)。

---

## 1 环境要求

| 项 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 20（实测 v24 可用） | 内核与开发宿主 |
| pnpm | ≥ 9（实测 10.33 可用） | 包管理；**本项目运行期零依赖**，devDependencies 只有 TypeScript 与 Vitest |
| JDK | 17 或 21 | Gradle/AGP 需要 |
| Android SDK | Platform 34 / Build-Tools 34.0.0 | 仅构建 APK 需要 |

Android 部分：AGP 8.7.3 + Gradle 8.9（wrapper 已在仓库内，无需另装 Gradle）。

---

## 2 安装与开发

```bash
pnpm install
```

常用命令：

```bash
pnpm typecheck      # 内核与测试的类型检查（应 exit 0）
pnpm test           # 单元 / 契约 / 守卫测试
pnpm demo:build     # 编译开发宿主
pnpm demo:start     # 启动开发宿主（默认监听 127.0.0.1:8765）
pnpm demo:test      # 开发宿主自己的测试配置
```

`contracts/mobile-v1/validate.mjs` 是零依赖契约校验器，可脱离测试框架单独运行：

```bash
node contracts/mobile-v1/validate.mjs <fixtures 目录>
```

---

## 3 构建 Android 应用

首次构建前指定 SDK 路径（该文件不入库）：

```bash
# apps/android/local.properties
sdk.dir=/path/to/Android/Sdk
```

```bash
cd apps/android
./gradlew assembleDebug      # 调试包
./gradlew assembleRelease    # 发布包（未配置签名时为未签名产物）
```

**发布包签名**：仓库不含任何签名材料。自行生成密钥库并**放在仓库之外**，再通过本地（不入库的）配置引用：

```bash
keytool -genkeypair -v -keystore ~/potbot-release.jks \
        -alias potbot -keyalg RSA -keysize 2048 -validity 10000
```

`*.jks` / `*.keystore` / `local.properties` 已在 `.gitignore` 中；**请勿提交**。

产物位置：`apps/android/app/build/outputs/apk/{debug,release}/`

---

## 4 安装到设备

```bash
adb install -r apps/android/app/build/outputs/apk/release/app-release.apk
```

首次启动会请求通知权限（后台任务使用前台服务与通知）。

---

## 5 应用怎么用

界面为四个入口：**对话 / 群组 / 文件 / 我的**。

- **对话**：唯一自然语言入口。说出你想要的文件或目标即可；运行过程默认折叠，展开可见每一步；同一会话可继续追问，用于修改上一步的产物。
- **群组**：任务的分组与阶段视图；进行中的任务可暂停、取消或改条件。
- **文件**：产出的文档按版本列出；同一文件的多版本以版本链呈现，可打开任一版本。
- **我的**：连接与密钥状态、模板目录（安装 / 启用 / 授权 / 端口就绪四态分离）、记忆条目、权限与诊断。

**文档类任务**：提出目标 → 产生文档 → 在同一会话继续提出排版或内容修改 → 新版本。

**界面会如实区分状态**：读取失败、通道缺失、状态未知、内容与上一版相同，都会照实显示，不会用成功态掩盖。

---

## 6 后端连接（当前实现）

应用内的 UI 随 APK 本地加载（`file:///android_asset/`），**不依赖外部网页**；但任务执行需要本机宿主：

- 默认后端地址：`http://127.0.0.1:8765`
- 通过 USB 反向映射把手机的 `127.0.0.1:8765` 指向电脑：

  ```bash
  adb reverse tcp:8765 tcp:8765
  ```

- 也可改为局域网地址（需同时调整宿主的监听设置）。

**密钥处理**：模型与第三方业务凭据**只保存在宿主侧**，不写入代码、APK 资产、前端存储或日志；页面只会拿到引用状态，拿不到明文。

模型调用预算由环境变量控制，例如：

```bash
POTBOT_MODEL_MAX_REQUESTS=300 pnpm demo:start
```

---

## 7 常见问题

**页面空白** —— 先确认宿主是否在运行；页面自身依赖的资产都在 APK 内，宿主不可达时应显示错误态而非空白。

**任务一直排队** —— 检查宿主日志与模型预算；预算耗尽会被明确拒绝，不会以成功掩盖。

**会话打不开** —— 若服务端数据已被清空，页面记忆中的会话可能已不存在；此时界面会清除该记忆并回到起始页，而不是停在错误页。

**生成结果与预期不符** —— 模型具有随机性；同一目标建议重试。请求无法完成时，工具会返回明确原因，助手也应如实转述。
