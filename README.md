# 系统发育资料的字符分区与树标签接入

这是面向资料接收人员的 Node.js 收件服务。当前版本支持原始资料领取、内容校验、人工摘要登记和按出处回查，并对 NEXUS 来源提供结构化自动接入：分类单元、字符、FORMAT、分区、TRANSLATE、树声明与树叶、逐字符状态观察都链接到同一套分类单元并保留来源出处；解析后的摘要不替代原文，原始载荷与版本始终可回查。

## 本地运行

运行环境为 Node.js 22（最低 22.22.1），使用运行时内置模块，没有第三方运行依赖。package.json 与 package-lock.json 声明相同的兼容范围；平台 Linux 基线使用 Node.js 22.23.4，独立 Dockerfile 仍固定 22.22.1 镜像摘要。启动与测试不执行依赖下载。执行以下命令启动真实收件与来源服务：

```sh
npm start
```

默认收件地址为本机 4310 端口，授权资料源为本机 4311 端口。PORT、SOURCE_PORT、ARCHIVE_DIR 可分别调整端口和资料目录；.local 为本地持久化内容，不纳入版本。停止进程后重新启动会继续读取原有收件。

## 检查与使用

```sh
npm run build
npm test
npm run demo
```

build 对所有源码做语法检查，test 检查当前已开放的收件能力、来源服务和 NEXUS 解释语义。demo 从临时空目录启动两个真实 HTTP 服务，领取实际来源，输出收件与资料索引，然后关闭并清理临时状态；不重播预先保存的日志。它没有固定等待，不超过来源请求本身的超时。

```sh
npm run acceptance:structured
npm run acceptance:partial
```

这两项检查分别读取完整与不完整来源样本，核对 docs/source-contract.md 中的结构化记录与出处关系。完整样本应确认全部目标观察（含交错矩阵重组、MATCHCHAR 引用、多态状态与 TRANSLATE 树叶）并可跨重启保留；不完整样本应保留已领取原文、解释已完整部分，并以 issues 说明截断或解释限制，而不是内部崩溃。完整支持范围及人工接口见 docs/service-api.md 和 docs/source-contract.md。

## 可复现环境

```sh
docker build --network=none -t local-receiver .
docker run --rm --network=none local-receiver npm test
docker run --rm --network=none local-receiver npm run demo
```

Dockerfile 固定 Linux Node 镜像摘要，容器仅需内部回环网络。镜像构建不安装额外依赖，也不读取真实账户、用户数据或公共网站；首次拉取基础镜像属于环境准备，不属于正式运行。脚本输出规模受小型本地资料控制，正常完整运行可以在九十秒内观察。
