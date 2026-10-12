# 安装与原生模块

要求 Node >=22.12.0 和 npm，推荐使用受支持的 Node 22 版本。本项目提交 npm lockfile v3；使用 `npm ci` 保持已锁定依赖，不需重新生成锁文件或更换数据库适配器。

## 安装和 SQLite 检查

在项目根目录执行：

```sh
npm ci --ignore-scripts --no-audit --no-fund
node --input-type=module -e "import Database from 'better-sqlite3'; const db=new Database(':memory:'); console.log(db.prepare('SELECT 1 AS ok').get()); db.close();"
```

预期查询输出 `{ ok: 1 }`。这不会打开项目数据库或读取 `.env`。构建成功或 `import` 成功本身不能证明原生 binding 能实际使用。

锁定的 `better-sqlite3` 13.0.3 随 npm 包附带 `prebuilds/`，loader 按操作系统、x64/arm64 及 Linux libc 选择文件。此版本的 `gypfile=false`，没有安装生命周期脚本；常见平台安装时可直接使用预编译模块。`--ignore-scripts` 是跳过安装脚本的选项，不能保证任意平台无需编译，也不能替代上述查询。当前 Linux x64、Node 22 环境通过随包预编译文件完成实际 SQLite 查询；其他平台须自行验证。

`npm rebuild --ignore-scripts` 不能补做原生编译。`npm rebuild better-sqlite3` 对该版本也不是可靠的强制编译方式，应使用下述明确的 `node-gyp rebuild --force_build=1`。

## 无可用预编译文件时

先排除安装不完整、架构不匹配、旧 Node 和 libc 不匹配。原生构建需要 Python 3、支持 C++20 的编译工具链和当前 Node 版本的 headers：Linux 安装 make/g++，macOS 安装 Xcode Command Line Tools，Windows 安装 Visual Studio 的 C++ build tools。工具链版本以该依赖和 node-gyp 的要求为准。

npm 通常附带 node-gyp，可在 `npm root -g` 返回的目录附近找到 `npm/node_modules/node-gyp/bin/node-gyp.js`；各发行版路径不同。以下 `<NODE_GYP_JS>` 是替换占位符：

```sh
cd node_modules/better-sqlite3
node /ABSOLUTE/PATH/TO/NODE_GYP_JS rebuild --release --force_build=1 --jobs=4
cd ../..
node --input-type=module -e "import Database from 'better-sqlite3'; const db=new Database(':memory:'); console.log(db.prepare('SELECT 1 AS ok').get()); db.close();"
```

在 Debian/Ubuntu 的 npm 安装路径确为 `/usr/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js` 时，可用该实际路径。仅当 `/usr/include/node` 的 headers 与运行 Node 匹配时添加 `--nodedir=/usr`；其他情况下让 node-gyp 获取匹配 headers，或指定受控的匹配目录。原生编译可能需要网络和较长时间，应在自己的构建环境执行。

如果预编译文件存在但加载失败，先解决兼容性原因。loader 优先选择预编译文件，即使生成了 `build/Release` 也不会自动覆盖它；不要为了绕过错误盲目关闭校验或替换锁定版本。

## 构建、启动与 Worker

```sh
npm run typecheck
npm run typecheck:web
npm run build
# 填写 .env 后再启动：
npm start
```

脚本与实际产物：

| 命令 | 行为 |
| --- | --- |
| `build:node` | `tsc -p tsconfig.build.json`，输出 `dist/server` |
| `build:web` | `vite build`，输出 `dist/web` |
| `build` | 顺序执行上面两项 |
| `start` | Node 加载可选 `.env` 并运行编译后的 runtime；需要在项目根目录提供 `dist/web` |
| `cf:check` | `wrangler deploy --dry-run --outdir dist/worker`；先执行 `build:web` |
| `cf:deploy` | 真正部署，需由运营者在配置资源及 Secrets 后执行 |

Worker 不使用 Node 原生 SQLite 或 SMTP 模块，但 Node 本地工具和 SQLite 测试需要原生 binding。仅做 Worker 构建时不必先启动 Node 服务。

## Docker 构建边界

现有 Dockerfile 使用 `node:22-bookworm-slim`，安装时带 `--ignore-scripts`，然后执行 `npm run build` 和实际 SQLite 内存查询；最终镜像保留项目 LICENSE 与 README。它依赖该 Debian/架构下可用的随包预编译 SQLite 模块，未包含原生编译工具链。需要编译的其他架构应在自己的派生 Dockerfile 中增加构建阶段工具链和上述明确编译步骤；不要把宿主机 `node_modules` 拷入镜像。

`.dockerignore` 排除私有配置、数据库、备份、测试日志、缓存和内部交接材料；Docker 运行时通过 Compose `env_file` 注入配置，SQLite 使用卷。构建前可先执行 SQLite 查询检查，但宿主检查不能证明容器架构兼容。镜像应在目标环境通过查询和 `/api/health` 验证；本说明不代表已运行 Docker daemon 或线上数据库。

发布源码包时明确列出公开源文件、模板、迁移 SQL、锁文件和 LICENSE，排除 `node_modules`、`dist`、`.wrangler`、测试产物、实际数据库与私有配置/备份。普通 zip 命令不会自动遵循 `.gitignore` 或 `.dockerignore`；已经进入版本管理的文件也不会被新增 ignore 规则自动移除。不要用排除全部 `*.sql` 的方式过滤备份，否则会遗漏公开 schema migrations。Docker 最终镜像当前复制运行所需目录，镜像发布者还应提供项目和依赖的相应许可证材料。

上游参考：[better-sqlite3](https://github.com/WiseLibs/better-sqlite3)、[node-gyp](https://github.com/nodejs/node-gyp)、[npm ci](https://docs.npmjs.com/cli/v10/commands/npm-ci)。
