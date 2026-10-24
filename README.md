# dsh-three-pane

DeepSeek Harness 原生文件面板移位插件。将原本右侧的「文件」面板放到聊天左边，文件预览继续留在右边。

An independent native file explorer for DeepSeek Harness: files on the left, conversation in the center, and native previews in the right sidebar. A folder button beside the conversation-history toggle controls the explorer independently of both sidebars.

## 当前版本

当前版本：**0.3.0**。这是首次公开发行版，使用原生文件面板，并为文件栏提供独立开关。

文件页签、图标、路径栏、刷新按钮、打开方式和文件行全部使用 Harness 原生组件及其现有插件扩展。本插件只调整面板位置和宽度，不添加独立文件浏览界面。文件栏不再显示右侧侧栏的分栏、全屏和侧栏收缩按钮。

![原生文件面板移至左侧](docs/overview.png)

![收起后完全隐藏](docs/files-hidden.png)

```text
展开时： [ 对话历史（可收起） ] [ 原生文件面板 ] [ 聊天 ] [ 原生文件预览 ]
收起后： [ 对话历史（可收起） ]                  [ 聊天 ] [ 原生文件预览 ]
```

## 安装

先下载 [预构建安装包](https://github.com/Wfssll/dsh-three-pane/releases/latest/download/dsh-three-pane.tgz)，或在 [版本页面](https://github.com/Wfssll/dsh-three-pane/releases/tag/v0.3.0) 下载固定版本。安装包包含已构建的客户端，无运行时 npm 依赖，不需要本地构建。

**官方 Desktop：** 打开「插件 → 添加插件 → 安装第三方插件」，输入下载的 `.tgz` 文件的完整本地路径，安装并按提示启用。`desktop` profile 在应用运行期间由桌面版专门管理，不能通过外部 CLI 修改。升级已有社区插件时，如宿主要求先卸载旧版，先在插件详情页卸载，再安装新包；不会删除聊天和工作区文件。

**Web profile：**

```bash
dsh plugin --profile web add https://github.com/Wfssll/dsh-three-pane/releases/download/v0.3.0/dsh-three-pane-0.3.0.tgz
```

将 `web` 换成自己的 profile 名称。安装后重新加载客户端，必要时重启该 profile。尚未发布到 npm，请使用 GitHub Release 安装包。

**Desktop (English):** Download the prebuilt `.tgz`, then open **Plugins → Add plugin → Install third-party plugin**, paste the full local archive path, install, and enable. For Web profiles, use the command above.

## 使用

会话历史栏的收起按钮左侧新增文件夹图标，点击可独立展开、收起文件栏。历史栏收起后，文件夹按钮仍与「展开会话历史」「新建会话」两个原生按钮一起保留，顺序为「文件 → 会话历史 → 新建会话」。

文件栏和右侧侧栏各自管理开关，互不联动：收起预览不会收起文件，开关文件栏也不会开关预览。隐藏文件栏保留原生文件页签和目录展开状态；文件页签上的关闭按钮也只隐藏文件栏。

点击文件会在右侧原生侧栏预览。右侧侧栏保留原来的分栏、全屏和收起功能；文件栏顶部不再提供这些侧栏控件，也不再显示新建侧栏页签按钮。

文件栏右边缘可拖动调宽；聚焦分隔线后可用左右方向键调节，双击恢复 300px。文件栏始终占用独立列，右侧预览优先缩小以保留至少 400px 的聊天区域；极窄窗口可横向滚动，不覆盖聊天内容。

## 实现与兼容性

- 已在 DeepSeek Harness **`0.2.1-rc.3`** 的 Web 与官方 macOS Desktop 上验证。其他宿主版本未逐一实测。
- 复用原生 `rightbar.session` 注册的组件、Store、注入服务及子 Slot 授权。
- 只为渲染生成「文件」和「预览」布局视图；文件栏的可见状态由插件按会话独立管理，不跟随右侧侧栏的展开状态。目录仍使用原生文件页签，不复制文件数据。
- 本插件不自行读取文件；本地文件与 SSH 文件都由宿主已有文件面板处理。
- 原生组件装饰依赖当前版本的 Slot 注册结构；未来宿主升级后可能需要适配。
- 停用或卸载会恢复原生组件并移除自己的样式和布局留白。

## 开发

```bash
npm ci --ignore-scripts
npm run check
mkdir -p dist
npm pack --pack-destination dist
```

`src/client.js` 负责原生面板装饰与显示位置，`src/model.js` 负责只读布局投影，`src/style.css` 包含几何布局与文件夹按钮样式。

验证：11 项自动检查通过，覆盖独立开关、预览状态保持、会话隔离、历史栏折叠后按钮保留、原生组件复用及卸载恢复；另在真实宿主中验证本地和 SSH 文件的 PDF 预览。上面的截图使用合成测试工作区，不含私人对话或研究数据。

## 卸载

Desktop 在「插件」页卸载 `dsh-three-pane`。Web 使用 `dsh plugin --profile web remove dsh-three-pane`。

## License

[MIT](LICENSE).
