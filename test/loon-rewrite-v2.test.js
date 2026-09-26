const assert = require('assert')
const fs = require('fs')
const vm = require('vm')

const source = fs.readFileSync('Rewrite-Parser.js', 'utf8')
const start = source.indexOf('function getLoonArgumentDefault')
const end = source.indexOf('//reject\n', start)
assert(start >= 0 && end > start, 'V2 parser block not found')
const context = {}
vm.runInNewContext(source.slice(start, end), context)

const parse = context.parseLoonRewriteV2
const samples = [
  'request if ${url} ~= /^https:\\/\\/api\\.qbb6\\.com\\/ad\\//i then reject_dict(200)',
  'request if ${url} ~= /^https:\\/\\/api\\.qbb6\\.com\\/commons\\/main\\/tab\\/info\\/get\\?/i then reject_dict(200)',
  'request if ${url} ~= /^https:\\/\\/apicommunity\\.qbb6\\.com\\/community\\/recommend\\/user\\/get\\?/i then reject_dict(200)',
  'request if ${url} ~= /^https:\\/\\/apipt\\.qbb6\\.com\\/parenting\\/pt\\/home\\/post\\/card\\/get\\?/i then reject_dict(200)',
  'request if ${url} ~= /^https:\\/\\/apipt\\.qbb6\\.com\\/lib\\/search\\/hot\\/keys\\/v\\d\\?/i then reject_dict(200)',
  'request if ${url} ~= /^https:\\/\\/apiuser\\.qbb6\\.com\\/user\\/member\\/info\\/get\\?/i then reject_dict(200)',
  'request if ${url} ~= /^https:\\/\\/apimall\\.qbb6\\.com\\/mall\\/v\\d\\/goods\\/count\\?/i then reject_dict(200)',
  'request if ${url} ~= /^https:\\/\\/apimall\\.qbb6\\.com\\/mall\\/homepage\\/data\\/get\\/v\\d$/i then reject_dict(200)',
]

const results = samples.map(parse)
assert(results.every(item => item.ok && item.action.type === 'reject-dict'))

const redirect = parse('request if ${url} ~= /old\\/path/ then redirect(302, "https://example.com/a,b?x=1")')
assert.strictEqual(redirect.action.url, 'https://example.com/a,b?x=1')
assert.strictEqual(redirect.action.status, 302)

for (const rule of [
  'request if ${url} ~= /api/ then reject(403)',
  'request if ${url} ~= /api/ then reject(451)',
  'request if ${url} ~= /api/ then reject_dict(201)',
  'request if ${url} ~= /api/ then reject(200, "Forbidden")',
]) {
  const parsed = parse(rule)
  assert.strictEqual(parsed.ok, true)
  assert.strictEqual(context.loonRewriteV2ToLegacy(parsed), null)
}

assert.strictEqual(parse('request if ${url} ~= /api/ && ${request.method} == "POST" then reject_dict(200)').ok, false)
const capture = parse('request if ${url} ~= /^https:\\/\\/old\\.example\\.com(\\/.*)$/ as urlMatch then url.replace("https://new.example.com${urlMatch.1}")')
assert.strictEqual(capture.ok, true)
assert.strictEqual(context.loonRewriteV2ToLegacy(capture).rwvalue, 'https://new.example.com$1')
assert.strictEqual(parse('request if ${url} ~= /api/ then unknown_action(200)').ok, false)
assert.strictEqual(parse('# request if ${url} ~= /api/ then reject_dict(200)').ok, false)
assert.strictEqual(parse("request if ${url} ~= /api/ then redirect(302, 'https://example.com')").ok, false)
assert.strictEqual(parse('request if ${url} ~= /api/ then redirect(302, "https://${region}")').ok, false)
const responseReject = parse('response if ${url} ~= /api/ then reject_dict(200)')
assert.strictEqual(responseReject.ok, true)
assert.strictEqual(context.loonRewriteV2ToLegacy(responseReject), null)

const parseScript = context.parseLoonScriptV2
const requestScript = parseScript('request if ${url} ~= /^https:\\/\\/api\\.example\\.com/i then script("https://example.com/request.js", "a=1,b=2") with tag="Request", timeout=20, requires_body=true')
assert.strictEqual(requestScript.jstype, 'http-request')
assert.strictEqual(requestScript.jsarg, 'a=1,b=2')
assert.strictEqual(requestScript.jsargPresent, true)
assert.strictEqual(requestScript.jsargKind, 'string')
assert.strictEqual(requestScript.rebody, 'true')
assert(parseScript('request if ${url} ~= /api/ && ${request.method} == "POST" then script("request.js")').runtimeCondition)
assert.strictEqual(parseScript('request if ${url} ~= /api/ then script("request.js") with debug=true').jsdebug, 'true')
assert.strictEqual(parseScript('cron "0 8 * * *" then script("cron.js") with timeout=300').jstype, 'cron')
assert.strictEqual(parseScript('network-changed then script("network.js")').jstype, 'network-changed')
assert.strictEqual(parseScript('generic then script("tool.js", "region=CN") with tag="Tool"').jstype, 'generic')

// Script V1/V2 argument semantics: omitted, empty, escaped String, Raw String and plugin Object.
const noArgument = parseScript('generic then script("tool.js")')
assert.strictEqual(noArgument.jsargPresent, false)
assert.strictEqual(noArgument.jsargKind, 'none')

const emptyArgument = parseScript('generic then script("tool.js", "")')
assert.strictEqual(emptyArgument.jsargPresent, true)
assert.strictEqual(emptyArgument.jsarg, '')
assert.strictEqual(context.formatScriptArgument(emptyArgument.jsarg, context.getScriptArgumentMeta(emptyArgument), 'loon-plugin'), ', argument=""')

const escapedArgument = parseScript('generic then script("tool.js", "a=1,b=\\\"two\\\"\\nnext")')
assert.strictEqual(escapedArgument.jsarg, 'a=1,b="two"\nnext')
assert.strictEqual(context.formatScriptArgument(escapedArgument.jsarg, context.getScriptArgumentMeta(escapedArgument), 'surge-module'), ', argument="a=1,b=\\\"two\\\"\\nnext"')

const rawArgument = parseScript('generic then script("tool.js", `{"region":"CN","items":[1,2]}`)')
assert.strictEqual(rawArgument.jsarg, '{"region":"CN","items":[1,2]}')
assert.strictEqual(rawArgument.jsargKind, 'string')

const declaredArguments = [{ key: 'region' }, { key: 'level' }, { key: 'enabled' }]
const objectArgument = parseScript('generic then script("plugin.js", {${region}, ${level}, ${enabled}})', declaredArguments)
assert.deepStrictEqual(Array.from(objectArgument.jsargKeys), ['region', 'level', 'enabled'])
assert.strictEqual(objectArgument.jsargKind, 'object')
assert.strictEqual(context.formatScriptArgument(objectArgument.jsarg, context.getScriptArgumentMeta(objectArgument), 'loon-plugin'), ', argument={region,level,enabled}')
assert.strictEqual(context.formatScriptArgument(objectArgument.jsarg, context.getScriptArgumentMeta(objectArgument), 'surge-module'), null)
assert.strictEqual(parseScript('generic then script("plugin.js", {${region}, ${missing}})', declaredArguments), null)
assert.strictEqual(parseScript('generic then script("plugin.js", {${region}, ${region}})', declaredArguments), null)
assert.strictEqual(parseScript('generic then script("plugin.js", {})', declaredArguments), null)

const parseLegacyArgument = context.parseLoonLegacyScriptArgument
assert.deepStrictEqual(JSON.parse(JSON.stringify(parseLegacyArgument('generic script-path=tool.js, argument="", tag=Tool'))), { present: true, kind: 'string', value: '', keys: [] })
assert.strictEqual(parseLegacyArgument('http-request /api/ script-path=req.js, argument="a=1,b=2", timeout=20').value, 'a=1,b=2')
assert.strictEqual(parseLegacyArgument('http-request /api/ script-path=req.js, argument=a=1,b=2, timeout=20').value, 'a=1,b=2')
assert.strictEqual(parseLegacyArgument('type=http-request, script-path=req.js, argument={"a":1,"b":2}, timeout=20').kind, 'string')
const legacyObject = parseLegacyArgument('http-response /api/ script-path=res.js, argument={region,level}, enable={enabled}', declaredArguments)
assert.strictEqual(legacyObject.kind, 'object')
assert.deepStrictEqual(Array.from(legacyObject.keys), ['region', 'level'])
assert.strictEqual(parseLegacyArgument('generic script-path=tool.js, argument={missing}', declaredArguments).kind, 'invalid')

const defaultArguments = [
  { key: 'enabled', type: 'switch', value: 'true', tag: 'tag=启用' },
  { key: 'disabled', type: 'switch', value: 'false', tag: 'tag=禁用' },
  { key: 'script_timeout', type: 'input', value: '"15"', tag: 'tag=超时' },
  { key: 'missing_timeout', type: 'input', value: '', tag: 'tag=超时' },
  { key: 'script_debug', type: 'switch', value: 'true', tag: 'tag=调试' },
  { key: 'region', type: 'select', value: '"CN","US"', tag: 'tag=地区' },
  { key: 'cron', type: 'input', value: '"0 8 * * *"', tag: 'tag=定时' },
  { key: 'url_pattern', type: 'input', value: '"/api/i"', tag: 'tag=匹配' },
  { key: 'status', type: 'input', value: '200', tag: 'type=number, tag=状态' },
  { key: 'host', type: 'input', value: '"new.example.com"', tag: 'tag=主机' },
]
const dynamicOptions = parseScript('request if ${url} ~= /api/ then script("request.js") with enable=${enabled}, timeout=${script_timeout}, debug=${script_debug}', defaultArguments)
assert.strictEqual(dynamicOptions.jsenable, 'true')
assert.strictEqual(dynamicOptions.timeout, '15')
assert.strictEqual(dynamicOptions.jsdebug, 'true')
assert.strictEqual(dynamicOptions.disabledByDefault, false)
const githubPushTimeRule = parseScript('request if ${url} ~= /^https?:\\/\\/api\\.github\\.com\\/graphql/i then script("https://raw.githubusercontent.com/TomCatXue/MyCookieCenter/refs/heads/main/scripts/tools/github/github_push_time.js?v=20260818-12") with enable=${enabled}, tag="GitHub 推送时间-查询增强", timeout=10, requires_body=true', defaultArguments)
assert.strictEqual(githubPushTimeRule.jstype, 'http-request')
assert.strictEqual(githubPushTimeRule.jsenable, 'true')
assert.strictEqual(githubPushTimeRule.rebody, 'true')
const disabledOption = parseScript('request if ${url} ~= /api/ then script("request.js") with enable=${disabled}', defaultArguments)
assert.strictEqual(disabledOption.jsenable, 'false')
assert.strictEqual(disabledOption.disabledByDefault, true)
assert.strictEqual(parseScript('request if ${url} ~= /api/ then script("request.js") with timeout=${missing_timeout}', defaultArguments).timeout, '20')
assert.strictEqual(parseScript('generic then script("tool.js") with timeout=${missing_timeout}', defaultArguments).timeout, '300')
assert.strictEqual(parseScript('generic then script("tool.js") with timeout=${enabled}', defaultArguments), null)
assert.strictEqual(parseScript('generic then script("tool.js", "region=${region}")', defaultArguments).jsarg, 'region=CN')
assert.strictEqual(parseScript('cron ${cron} then script("cron.js")', defaultArguments).cronexp, '0 8 * * *')
assert.strictEqual(parseScript('request if ${url} ~= ${url_pattern} then script("request.js")', defaultArguments).jsptn, '(?i)api')
assert.strictEqual(parseScript('request if ${enabled} == true && ${url} ~= /api/ then script("request.js")', defaultArguments).disabledByDefault, false)
assert.strictEqual(parseScript('request if ${disabled} == true && ${url} ~= /api/ then script("request.js")', defaultArguments).disabledByDefault, true)
assert.strictEqual(parseScript('request if (${region} == "CN" || ${region} == "HK") && ${url} ~= /api/ then script("request.js")', defaultArguments).disabledByDefault, false)
assert.strictEqual(parseScript('request if ${url} ~= /api/ then script("request.js") with enable=${region}', defaultArguments), null)
assert.strictEqual(parseScript('request if ${url} ~= /api/ then script("request.js", "${unknown}")', defaultArguments), null)
assert.strictEqual(parseScript('generic then script("[https://example.com/a.js](https://example.com/a.js)")', defaultArguments), null)
assert.strictEqual(parseScript('generic then script("tool.js", `literal ${region}`)', defaultArguments).jsarg, 'literal ${region}')

const dynamicReject = context.parseLoonRewriteV2('request if ${url} ~= /api/ then reject_dict(${status})', defaultArguments)
assert.strictEqual(dynamicReject.ok, true)
assert.strictEqual(dynamicReject.action.status, 200)
const dynamicRedirect = context.parseLoonRewriteV2('request if ${enabled} == true && ${url} ~= /old/ then redirect(302, "https://${host}")', defaultArguments)
assert.strictEqual(dynamicRedirect.ok, true)
assert.strictEqual(dynamicRedirect.action.url, 'https://new.example.com')
const dynamicRejectBody = context.parseLoonRewriteV2('request if ${url} ~= /api/ then reject(${status}, "region=${region}")', defaultArguments)
assert.strictEqual(dynamicRejectBody.action.body, 'region=CN')
const disabledRewrite = context.parseLoonRewriteV2('request if ${disabled} == true && ${url} ~= /api/ then reject_dict(${status})', defaultArguments)
assert.strictEqual(disabledRewrite.ok, true)
assert.strictEqual(disabledRewrite.condition.disabledByDefault, true)

// The production gate is section-scoped: a Script section must not dispatch V2.
let section = 'Script'
let dispatched = 0
for (const line of ['[Script]', 'request if ${url} ~= /api/ then reject_dict(200)', '[Rewrite]', 'request if ${url} ~= /api/ then reject_dict(200)']) {
  if (/^\[[^\]]+\]$/.test(line)) section = line.slice(1, -1)
  else if (section === 'Rewrite' && /^(?:request|response)\s+if\b/i.test(line)) dispatched++
}
assert.strictEqual(dispatched, 1)

// Stable and beta parsers must accept the same Script argument grammar.
const betaSource = fs.readFileSync('Rewrite-Parser.beta.js', 'utf8')
const betaStart = betaSource.indexOf('function getLoonArgumentDefault')
const betaEnd = betaSource.indexOf('//reject\n', betaStart)
assert(betaStart >= 0 && betaEnd > betaStart, 'beta V2 parser block not found')
const betaContext = {}
vm.runInNewContext(betaSource.slice(betaStart, betaEnd), betaContext)
const betaRaw = betaContext.parseLoonScriptV2('generic then script("tool.js", `line 1\nline 2,a=b`)')
assert.strictEqual(betaRaw.jsarg, 'line 1\nline 2,a=b')
assert.strictEqual(betaRaw.jsargPresent, true)
const betaObject = betaContext.parseLoonScriptV2('generic then script("plugin.js", {${region}, ${enabled}})', declaredArguments)
assert.deepStrictEqual(Array.from(betaObject.jsargKeys), ['region', 'enabled'])
assert.strictEqual(betaContext.parseLoonLegacyScriptArgument('generic script-path=tool.js, argument="", tag=Tool').present, true)
const betaDynamic = betaContext.parseLoonScriptV2('request if ${enabled} == true && ${url} ~= ${url_pattern} then script("request.js", "region=${region}") with enable=${enabled}, timeout=${script_timeout}, debug=${script_debug}', defaultArguments)
assert.strictEqual(betaDynamic.jsptn, '(?i)api')
assert.strictEqual(betaDynamic.jsarg, 'region=CN')
assert.strictEqual(betaDynamic.timeout, '15')
assert.strictEqual(betaDynamic.jsdebug, 'true')
assert.strictEqual(betaContext.parseLoonRewriteV2('request if ${url} ~= /api/ then reject_dict(${status})', defaultArguments).action.status, 200)

const betaArgumentHelpersStart = betaSource.indexOf('function stripWrapQuote')
const betaArgumentHelpersEnd = betaSource.indexOf('function parseQueryString', betaArgumentHelpersStart)
const betaArgumentContext = {}
vm.runInNewContext(
  'let sgArg = [];\n' +
    betaSource.slice(betaArgumentHelpersStart, betaArgumentHelpersEnd) +
    '\nthis.parseArgumentsForTest = parseArguments; this.readArgumentsForTest = () => sgArg; this.formatLoonArgumentValueForTest = formatLoonArgumentValue;',
  betaArgumentContext
)
betaArgumentContext.parseArgumentsForTest('region = select,"CN","US",tag=地区')
betaArgumentContext.parseArgumentsForTest('level = select,1,2,type=number,tag=等级')
const parsedDeclarations = betaArgumentContext.readArgumentsForTest()
assert.strictEqual(parsedDeclarations[0].value, '"CN","US"')
assert.strictEqual(parsedDeclarations[1].value, '1,2')
assert.match(parsedDeclarations[1].tag, /type=number/)
assert.strictEqual(betaArgumentContext.formatLoonArgumentValueForTest(parsedDeclarations[0]), '"CN","US"')
assert.strictEqual(betaArgumentContext.formatLoonArgumentValueForTest(parsedDeclarations[1]), '1,2')


for (const parser of [context, betaContext]) {
  const batch = parser.parseLoonExtendedRewrite('response if ${url} ~= /api/ then response.body.replace([/a,b/, /c/i], ["x", "y"]) | response.header.del(["Cookie", "X-A"])', [])
  assert.strictEqual(batch.actions.length, 4)
  assert.strictEqual(batch.actions[0].args[0].pattern, 'a,b')
  assert.strictEqual(parser.parseLoonExtendedRewrite('response if ${url} ~= /api/ then response.header.set(["A", "B"], ["1"])', []), null)
  assert.strictEqual(parser.parseLoonExtendedRewrite('response if ${url} ~= /api/ then request.header.del("Cookie")', []), null)
  assert.strictEqual(parser.parseLoonExtendedRewrite('response if ${response.status} == 200 then response.body.mock("json", `{}`)', []), null)
  const dynamic = parser.parseLoonExtendedRewrite('response if (${url} ~= /api/ && ${request.method} == "GET") && (${response.status} == 200 || ${response.header[\'X-Cache\']} == "HIT") then response.json.replace("data.vip", true)', [])
  assert(dynamic?.runtimeCondition)
  assert.strictEqual(dynamic.condition.pattern, 'api')
  assert.strictEqual(parser.parseLoonRuntimeCondition('${request.method} == true', [], 'request'), null)
  assert.strictEqual(parser.parseLoonRuntimeCondition('${response.status} == 200', [], 'request'), null)
  const raw = parser.parseLoonScriptV2('generic then script("tool.js", `a``b ${region}`)')
  assert.strictEqual(raw.jsarg, 'a`b ${region}')
  assert.strictEqual(parser.parseLoonScriptV2('generic then script("tool.js", "\\${region}")').jsarg, '${region}')
  assert.strictEqual(parser.parseLoonScriptV2('generic then script("tool.js", "${region}")', [{ key: 'region', type: 'input', value: '"${literal}"' }]).jsarg, '${literal}')
  assert.strictEqual(parser.parseLoonScriptV2('generic then script("tool.js") with requires_body=true'), null)
  const legacyList = parser.parseLoonLegacyScriptArgument('http-request /api/ script-path=req.js,argument=[{region},{level}],timeout=20', declaredArguments)
  assert.deepStrictEqual(Array.from(legacyList.keys), ['region', 'level'])
  assert.strictEqual(parser.stripLoonComment('request if ${url} ~= /a ; b # c/ then reject(200, "x // y") # comment'), 'request if ${url} ~= /a ; b # c/ then reject(200, "x // y")')
  assert.strictEqual(parser.splitLoonV2Args('"a", ["b", "c"], /x,y/').length, 3)
  assert.strictEqual(parser.uniqueLoonScripts([{ jstype: 'cron', cronexp: '0 8 * * *' }, { jstype: 'cron', cronexp: '0 9 * * *' }]).length, 2)
  assert.strictEqual(parser.uniqueLoonScripts([{ jsarg: '', jsargPresent: false }, { jsarg: '', jsargPresent: true }]).length, 2)
  const missing = parser.adaptLoonObjectScript({ jsargKind: 'object', jsargKeys: ['empty'], jsurl: 'https://example.com/a.js' }, [{ key: 'empty', type: 'input', value: '' }], 'surge-module')
  assert(missing)
}

console.log(`Loon Rewrite V2 tests passed: ${results.length} converted samples; negative cases preserved as unsupported`)
