# Loon V2 转换覆盖与限制

稳定版和 beta 的对应解析与执行能力保持一致。语法依据：

- [Loon Rewrite 3.5.1 (978)](https://loon0x00.github.io/docs/Rewrite/rewrite_v2)
- [Loon Script 3.5.1 (983)](https://loon0x00.github.io/docs/Script/script_v2)
- [插件 Argument](https://loon0x00.github.io/docs/Plugin/)

## 已实现的执行能力

**脚本**

- request/response 条件支持 URL、方法、Header、响应状态、类型一致的比较，以及 `&&` / `||` / 括号。Response Script 校验必需 URL Guard。
- 需要兼容执行时，同阶段 HTTP 脚本合并为一个调度脚本：按源顺序逐条判断，只执行第一条完整命中的候选；较早候选不匹配时继续检查后面的脚本。
- 候选脚本在生成时下载并分别封装，避免同名局部变量冲突。任何必需脚本下载失败都会使生成失败，不生成缺少候选的半成品。
- 同阶段兼容重写顺序执行，随后再选择脚本。Body 重写命中会禁止该阶段脚本；响应脚本条件读取原始响应状态/Header，而脚本正文得到重写后的报文。
- 保留每个候选的 Argument、Body 需求、二进制模式、超时；兼容异步 `$done`。Cron、network-changed、generic 按目标客户端支持的类型输出。

**Argument 和文本**

- 预扫描声明，不依赖段落顺序。支持 String、Raw String、转义、空参数、多行 Raw String、末尾换行。
- 支持 V2 `{${name}, ${enabled}}`、旧版 `{name,enabled}` 和 `[{name},{enabled}]`。跨客户端对象适配保留 String/Number/Boolean，缺值字段为 `null`。
- 条件和 Action 按有类型的值绑定参数，不将参数内容当成表达式再次执行。Raw String 和转义的 `${...}` 保持字面内容，避免被最终模板替换再次展开。
- 参数默认值可用于条件、Action、字符串、Cron，以及 enable/debug/timeout。旧版 enable/enabled、debug、timeout、Cron 参数也会绑定默认值。
- Argument 字符串中的逗号、`timeout=`、`requires-body=` 等不会串入脚本选项。保留源配置中的禁用状态。

**重写和资源**

- URL 替换、302/307 重定向、指定状态码的 reject、reject_dict、reject_array、reject_img、reject_video。
- Header add/set/del/replace、Body 正则替换、JSON add/delete/replace；支持 Action 管道和等长批量数组。
- 命名捕获 `${name.0}` / `${name.n}`，并检查捕获是否存在于所有成功路径。捕获缺值时跳过当前 Action，继续后续 Action。
- 文本/二进制 Mock、Base64、mock_file；文件支持 HTTP(S) 和相对插件源地址的路径。资源按 Action 顺序读取，前面 Header 修改产生的值可供后续 Action 使用。
- 静态 URL 条件下，JSON add/delete/replace/jq 可组合生成 Surge 原生 jq 管道；jq_file 可在转换时读取。失败的单个 JSON Action 保持该步骤之前的数据，继续后续 Action。
- Loon 作为目标时保留 V2 原句，静态相对脚本和资源路径重新绑定到原插件地址。

**规则与完整性**

- 缺省策略补 DIRECT，FINAL/MATCH 按目标格式输出，逻辑规则保留或补齐策略。
- 策略仅从规则尾部提取，避免误删域名内的同名文本。
- 去重区分动作、Argument 状态、禁用状态和 Cron；输出脚本名称唯一，避免同名覆盖。
- 不认识的语法、缺少策略映射或未支持的组合在输出末尾保留原文和原因，关闭通知也能核对。无效语句不会吞掉后续段落。V2 配置末尾另有 Rewrite/Script 转换计数，便于核对输入总量。

## 仍存在的边界

这些边界不能视作“已经完全等价转换”：

1. **任意 jq 与动态条件/非 JSON Action 的组合尚未实现。** 当前 jq 通过 Surge 原生 Body Rewrite 执行，兼容 JavaScript 内没有接入通用 jq 解释器。需要响应 Header/状态条件，或与 Header/正则 Body Action 混用的任意 jq，会保留为未转换条目。这是当前实现边界，不是已证明永远无法转换。
2. **不同执行通道的顺序。** 同一个调度器内部的重写/脚本顺序有回归测试；原生 jq、旧版重写和兼容脚本之间的跨通道顺序仍需目标客户端实测，不能承诺所有混合配置等价。
3. **参数使用声明默认值。** 转换服务不能读取 Loon 中保存的用户选择，也不能保证目标客户端的参数界面与 Loon 动态绑定完全一致。显式脚本参数覆盖会先于对象适配和调度合并处理。
4. **客户端和资源能力。** 原脚本使用的 Loon 专有 API 不会自动改写成目标客户端 API；不兼容 JavaScript 的正则、目标不支持的脚本类型、无法读取的本地文件、未指定映射的 PROXY 策略仍需要处理。相对资源只有在能确定原插件地址时才可重定位。
5. **真实流量尚未验证。** 已有执行测试和 Surge 离线配置校验，但本机 Surge 未运行，未执行真实 App 请求或原生脚本引擎联调。

## 验证与发布

运行 `npm test`，覆盖稳定版/beta 的解析、完整配置生成、脚本转换入口和生成脚本执行，包括首条命中、Body 重写禁用脚本、原始响应条件、捕获、文件、Base64、不同定时任务、禁用状态、Raw String 和失败路径。

完整合法输入样本在 [`test/fixtures/loon-v2.plugin`](../test/fixtures/loon-v2.plugin)。它生成的稳定版/beta Surge 配置均经过 `surge-cli --check`；JSON 混合管道另外用本机 jq 对实际 JSON 数据验证。

发布时需同步更新：

- `Rewrite-Parser.js` / `Rewrite-Parser.beta.js`
- `script-converter.js` / `script-converter.beta.js`
- `scripts/loon-rewrite-v2.js`

生成配置引用本仓库 main 分支的公共兼容脚本；只更新解析器而不更新脚本转换器和运行时，会导致调度脚本生成失败。
