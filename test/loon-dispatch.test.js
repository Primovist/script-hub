const assert = require('assert')
const fs = require('fs')
const vm = require('vm')
const { convert } = require('./loon-integration.test')
const runtimeSource = fs.readFileSync('scripts/loon-rewrite-v2.js', 'utf8')

function helpers(file) {
  const source = fs.readFileSync(file, 'utf8')
  const context = {}
  vm.runInNewContext(source.slice(source.indexOf('function getLoonArgumentDefault'), source.indexOf('//reject\n', source.indexOf('function getLoonArgumentDefault'))), context)
  return context
}
function converterHelpers(file) {
  const source = fs.readFileSync(file, 'utf8')
  const context = {}
  vm.runInNewContext(source.slice(0, source.indexOf('const TITLE')), context)
  return context
}
function execute(source, request, response) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Generated script did not finish')), 1000)
    const context = {
      $request: request, $response: response, console: { log() {} }, setTimeout, clearTimeout,
      $done: value => { clearTimeout(timer); resolve(JSON.parse(JSON.stringify(value))) },
    }
    try { vm.runInNewContext(source, context, { timeout: 1000 }) } catch (error) { clearTimeout(timer); reject(error) }
  })
}
function bundleFrom(body) {
  const path = body.match(/script-path=(http:\/\/script\.hub\/convert\/[^\s,]+)/)?.[1]
  assert(path, body)
  const query = new URLSearchParams(path.split('/_end_/')[1].split('?')[1])
  return JSON.parse(query.get('loonBundle'))
}

async function serveConvertedScript(file, bundle, resources) {
  return new Promise((resolve, reject) => {
    const context = {
      $environment: { 'surge-version': 'test' },
      $request: { url: 'http://script.hub/convert/_start_/https://example.com/runtime.js/_end_/dispatch.js?type=loon-bundle-script&target=surge-script&loonBundle=' + encodeURIComponent(JSON.stringify(bundle)) },
      $persistentStore: { read: () => null, write: () => true },
      $notification: { post() {} },
      $httpClient: { get(options, callback) {
        const body = resources[options.url]
        callback(null, { status: body == null ? 404 : 200, headers: { 'Content-Type': 'text/javascript' } }, body || '')
      } },
      $done: result => resolve(result.response), console: { log() {} },
      setTimeout: (callback, delay) => setTimeout(callback, delay).unref(), clearTimeout,
    }
    try { vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { timeout: 1000 }) } catch (error) { reject(error) }
  })
}

async function main() {
  const runtime = { console: { log() {} } }
  vm.runInNewContext(runtimeSource, runtime)
  for (const suffix of ['', '.beta']) {
    const parser = helpers(`Rewrite-Parser${suffix}.js`)
    const converter = converterHelpers(`script-converter${suffix}.js`)
    const source = `[Argument]
region=select,"CN","US"
level=select,2,3,type=number
[Script]
request if \${url} ~= /api/ && \${request.method} == "POST" then script("https://example.com/first.js", {\${region}, \${level}}) with requires_body=true
request if \${url} ~= /api/ then script("https://example.com/fallback.js", "fallback")
`
    const converted = await convert(`Rewrite-Parser${suffix}.js`, source)
    assert.strictEqual(converted.status, 200, converted.body)
    const bundle = bundleFrom(converted.body)
    const requests = []
    const generated = await converter.buildLoonScriptBundle(bundle, async url => {
      requests.push(url)
      return url.endsWith('/first.js')
        ? 'const local = $argument; setTimeout(() => $done({ body: local.region + ":" + local.level + ":" + $request.body }), 1);'
        : 'const local = $argument; $done({ body: local + ":" + typeof $request.body });'
    })
    assert.strictEqual(requests.length, 2)
    const served = await serveConvertedScript(`script-converter${suffix}.js`, bundle, {
      'https://example.com/first.js': '$done({ body: "first:" + $argument.region });',
      'https://example.com/fallback.js': '$done({ body: "fallback" });',
    })
    assert.strictEqual(served.status, 200, served.body)
    assert.strictEqual((await execute(served.body, { url: 'https://example.com/api', method: 'GET' }, {})).body, 'fallback')
    const failedServe = await serveConvertedScript(`script-converter${suffix}.js`, bundle, {})
    assert.strictEqual(failedServe.status, 500)

    assert.strictEqual((await execute(generated, { url: 'https://example.com/api', method: 'POST', body: 'input' }, {})).body, 'CN:2:input')
    assert.strictEqual((await execute(generated, { url: 'https://example.com/api', method: 'GET', body: 'hidden' }, {})).body, 'fallback:undefined')
    assert.deepStrictEqual(await execute(generated, { url: 'https://example.com/other', method: 'GET' }, {}), {})
    await assert.rejects(() => converter.buildLoonScriptBundle(bundle, async () => { throw new Error('download failed') }), /download failed/)

    const rewriteSource = `[Rewrite]
response if \${url} ~= /api/ then response.json.delete("ad")
response if \${url} ~= /api/ then response.json.replace("count", 2)
[Script]
response if \${url} ~= /api/ then script("https://example.com/not-called.js") with requires_body=true
`
    const rewritten = await convert(`Rewrite-Parser${suffix}.js`, rewriteSource)
    const rewriteBundle = bundleFrom(rewritten.body)
    assert.strictEqual(rewriteBundle.rewrites.length, 2)
    const program = await converter.buildLoonScriptBundle(rewriteBundle, async url => url.endsWith('loon-rewrite-v2.js') ? runtimeSource : '$done({ body: "WRONG: body rewrite must suppress script" });')
    assert.deepStrictEqual(JSON.parse((await execute(program, { url: 'https://example.com/api' }, { body: '{"ad":1,"count":0}' })).body), { count: 2 })

    const headerSource = `[Rewrite]
response if \${url} ~= /api/ then response.header.set("X-Cache", "new")
[Script]
response if \${url} ~= /api/ && \${response.header['X-Cache']} == "old" then script("https://example.com/original.js")
response if \${url} ~= /api/ then script("https://example.com/wrong.js")
`
    const headers = await convert(`Rewrite-Parser${suffix}.js`, headerSource)
    const headerProgram = await converter.buildLoonScriptBundle(bundleFrom(headers.body), async url => url.endsWith('loon-rewrite-v2.js') ? runtimeSource : url.endsWith('original.js') ? '$done({ body: $response.headers["X-Cache"] });' : '$done({ body: "WRONG" });')
    const headerResult = await execute(headerProgram, { url: 'https://example.com/api' }, { headers: { 'X-Cache': 'old' } })
    assert.strictEqual(headerResult.body, 'new')
    assert.strictEqual(headerResult.headers['X-Cache'], 'new')

    const captured = parser.parseLoonExtendedRewrite('response if ${url} ~= /item\\/(\\d+)/ as item then response.header.set("X-ID", "id=${item.1}") | response.json.replace("id", "${item.0}")', [])
    assert(captured)
    const captureSpec = JSON.parse(decodeURIComponent(parser.loonExtendedRewriteScript(captured, '', 1).jsarg))
    const captureResult = runtime.runLoonRewrite(captureSpec, { url: 'https://example.com/item/42' }, { body: '{"id":null}' })
    assert.strictEqual(captureResult.headers['X-ID'], 'id=42')
    assert.strictEqual(JSON.parse(captureResult.body).id, 'item/42')
    assert.strictEqual(parser.parseLoonExtendedRewrite('response if ${url} ~= /item\\/(\\d+)/ as item || ${response.status} == 200 then response.header.set("X-ID", "${item.1}")', []), null)
    assert.strictEqual(parser.parseLoonScriptV2('response if ${response.status} == 200 then script("x.js")'), null)
    assert(parser.parseLoonScriptV2('response if (${url} ~= /v1/ || ${url} ~= /v2/) && ${response.status} == 200 then script("x.js")').runtimeCondition)

    const mocked = parser.parseLoonExtendedRewrite('response if ${url} ~= /mock/ then response.body.mock_file("png", "../assets/icon.b64", 201, true) | response.header.set("X-Mock", "yes")', [])
    mocked.resourceBase = 'https://example.com/plugins/ad.plugin'
    const mockSpec = JSON.parse(decodeURIComponent(parser.loonExtendedRewriteScript(mocked, '', 1).jsarg))
    let downloads = 0
    const result = await runtime.runLoonRewriteWithResources(mockSpec, { url: 'https://example.com/mock' }, {}, async (url, binary) => {
      downloads++
      assert.strictEqual(url, 'https://example.com/assets/icon.b64')
      assert.strictEqual(binary, false)
      return 'AQID'
    })
    assert.strictEqual(downloads, 1)
    assert.deepStrictEqual(Array.from(result.response.body), [1, 2, 3])
    assert.strictEqual(result.response.status, 201)
    assert.strictEqual(result.response.headers['X-Mock'], 'yes')
    const failure = await runtime.runLoonRewriteWithResources(mockSpec, {}, {}, async () => { throw new Error('missing') })
    assert.deepStrictEqual(JSON.parse(JSON.stringify(failure)), {})

    for (const [action, status, contentType] of [['reject(451, "denied")', 451, 'text/plain'], ['reject_dict(201)', 201, 'application/json'], ['reject_img(200)', 200, 'image/gif'], ['reject_video(200)', 200, 'video/mp4']]) {
      const terminal = parser.parseLoonExtendedRewrite('request if ${url} ~= /blocked/ then ' + action, [])
      assert(terminal, action)
      const spec = JSON.parse(decodeURIComponent(parser.loonExtendedRewriteScript(terminal, '', 1).jsarg))
      const rejected = runtime.runLoonRewrite(spec, { url: 'https://example.com/blocked' }, {})
      assert.strictEqual(rejected.response.status, status)
      assert.strictEqual(rejected.response.headers['Content-Type'], contentType)
      if (contentType === 'video/mp4') assert.strictEqual(String.fromCharCode(...Array.from(rejected.response.body).slice(4, 8)), 'ftyp')
    }
    const redirect = parser.parseLoonExtendedRewrite('request if ${url} ~= /old/ as item then redirect(307, "new-${item.0}")', [])
    const redirected = runtime.runLoonRewrite(JSON.parse(decodeURIComponent(parser.loonExtendedRewriteScript(redirect, '', 1).jsarg)), { url: 'https://example.com/old/extra' }, {})
    assert.strictEqual(redirected.response.headers.Location, 'https://example.com/new-old/extra')
    assert.strictEqual(parser.compactLoonJQ('# comment\n.data | .items # another\n| map(.)'), '.data | .items   | map(.)')
    const sequenced = parser.parseLoonExtendedRewrite('request if ${url} ~= /api/ then request.header.set("X-File", "next.txt") | request.body.mock_file("text", "${request.header[\'X-File\']}")', [])
    sequenced.resourceBase = 'https://example.com/plugins/ad.plugin'
    const sequenceSpec = JSON.parse(decodeURIComponent(parser.loonExtendedRewriteScript(sequenced, '', 1).jsarg))
    const sequenceResult = await runtime.runLoonRewriteWithResources(sequenceSpec, { url: 'https://example.com/api', headers: {} }, {}, async url => {
      assert.strictEqual(url, 'https://example.com/plugins/next.txt')
      return 'loaded after header update'
    })
    assert.strictEqual(sequenceResult.body, 'loaded after header update')
    assert.strictEqual(parser.bindLoonResourceReferences('generic then script("./tool.js") with tag="Tool"', 'https://example.com/plugins/ad.plugin'), 'generic then script("https://example.com/plugins/tool.js") with tag="Tool"')
    const jq = parser.parseLoonExtendedRewrite('response if ${url} ~= /api/ then response.json.delete("ad") | response.json.jq(".items |= map(select(.ad != true))") | response.json.add("enabled", true)', [])
    const jqProgram = parser.loonNativeJQProgram(jq)
    assert.match(jqProgram, /delpaths/)
    assert.match(jqProgram, /map\(select/)
    assert.match(jqProgram, /setpath/)
    const fileJQ = parser.parseLoonExtendedRewrite('response if ${url} ~= /api/ then response.json.jq_file("filter.jq")', [])
    await parser.resolveLoonJQFiles(fileJQ, 'https://example.com/plugins/ad.plugin', async url => { assert.strictEqual(url, 'https://example.com/plugins/filter.jq'); return { status: 200, body: 'del(.ad)' } })
    assert.match(parser.loonNativeJQProgram(fileJQ), /del\(\.ad\)/)
  }
  console.log('Loon dispatch tests passed (first match, ordered rewrites, captures, resources, binary Mock, jq lowering)')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
