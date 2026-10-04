const assert = require('assert')
const fs = require('fs')
const vm = require('vm')

async function convert(file, input, target = 'surge-module') {
  return new Promise((resolve, reject) => {
    const context = {
      $environment: { 'surge-version': 'test' },
      $request: { url: 'http://script.hub/file/_start_/http://local.text/_end_/test.sgmodule?type=loon-plugin&target=' + target + '&noNtf=true&localtext=' + encodeURIComponent(input) },
      $persistentStore: { read: () => null, write: () => true },
      $notification: { post() {} },
      $httpClient: { get: () => { throw new Error('Unexpected network request') } },
      $done: result => resolve(result.response),
      console: { log() {} }, setTimeout, clearTimeout,
    }
    try { vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { timeout: 3000 }) } catch (error) { reject(error) }
  })
}

async function main() {
  for (const file of ['Rewrite-Parser.js', 'Rewrite-Parser.beta.js']) {
    const fixture = await convert(file, fs.readFileSync('test/fixtures/loon-v2.plugin', 'utf8'))
    assert.strictEqual(fixture.status, 200, fixture.body)
    assert.doesNotMatch(fixture.body, /unconverted source entries|__SCRIPT_HUB_LOON_LITERAL_/)
    const redpaperSource = fs.readFileSync('test/fixtures/redpaper-v2.plugin', 'utf8')
    const redpaper = await convert(file, redpaperSource)
    assert.strictEqual(redpaper.status, 200, redpaper.body)
    assert.doesNotMatch(redpaper.body, /loon-.*dispatch|loon-rewrite-v2\.js|unconverted source entries|pattern=\^https\?:\/\//)
    const section = name => redpaper.body.match(new RegExp('\\[' + name + '\\]\\n([\\s\\S]*?)(?=\\n\\[|$)'))?.[1].split('\n').filter(line => line.trim() && !line.startsWith('#')) || []
    assert.strictEqual(section('Rule').length, 1)
    assert.match(section('Rule')[0], /PROTOCOL,QUIC/)
    assert.strictEqual(section('Map Local').length, 5)
    const jsonRules = section('Body Rewrite')
    assert.strictEqual(jsonRules.length, 4)
    assert(jsonRules.every(line => line.startsWith('http-response-jq ')))
    const scripts = section('Script')
    assert.strictEqual(scripts.length, 12)
    const sourceScripts = [...redpaperSource.matchAll(/^response if \$\{url\} ~= \/(.+)\/i then script\("([^"]+)"\)/gm)]
    for (let i = 0; i < sourceScripts.length; i++) {
      assert(scripts[i].includes(', pattern=(?i)' + sourceScripts[i][1] + ', script-path=' + sourceScripts[i][2]), scripts[i])
      assert(scripts[i].includes('requires-body=true'), scripts[i])
    }
    // Quoted JSON-looking values remain strings; both batched paths must survive.
    const trending = JSON.parse(jsonRules[3].match(/^http-response-jq \S+ (.+)$/)[1])
    assert(trending.includes('setpath(["data","queries"];"[]")'))
    assert(trending.includes('setpath(["data","hint_word"];"{}")'))
    assert.match(redpaper.body, /Rewrite 9\/9 converted, 0 unsupported; Script 12\/12 converted, 0 unsupported/)
    const input = `#!name=V2 Test
[Script]
request if \${url} ~= /api/ then script("https://example.com/script.js", {\${region}, \${level}, \${enabled}})
cron "0 8 * * *" then script("https://example.com/cron.js", "a # b ; c // d")
cron "0 9 * * *" then script("https://example.com/cron.js", "a # b ; c // d")
[Rewrite]
response if \${url} ~= /profile/ then response.json.delete(["data.ads", "data.tracking"]) | response.header.set("X-Result", "a ; b # c")
request if \${url} ~= /ad/ then reject_dict(200)
request if \${url} ~= /unsupported/ then unknown(200)
[Rule]
DOMAIN,ad.example.com,REJECT
DOMAIN,default.example.com
DOMAIN,REJECT.example.com,REJECT
AND,((DOMAIN,logic.example.com),(PROTOCOL,TCP))
FINAL,DIRECT
NEW-RULE,keep-me,REJECT
[Argument]
region = select,"CN,HK","US",tag=Region
level = select,2,3,type=number
enabled = switch,true
[MITM]
hostname = example.com`
    const output = await convert(file, input)
    assert.strictEqual(output.status, 200, output.body)
    assert.match(output.body, /loon-(argument|dispatch)\.js/)
    assert.match(output.body, /\[Map Local\]\nad data-type=text data="\{\}" status-code=200/)
    assert.doesNotMatch(output.body, /loon-request-dispatch/)
    assert.match(output.body, /DOMAIN,default.example.com,DIRECT/)
    assert.match(output.body, /FINAL,DIRECT/)
    assert.match(output.body, /DOMAIN,REJECT.example.com,REJECT/)
    assert.match(output.body, /AND,\(\(DOMAIN,logic.example.com\),\(PROTOCOL,TCP\)\),DIRECT/)
    assert.match(output.body, /cronexp="?0 8 \* \* \*/)
    assert.match(output.body, /cronexp="?0 9 \* \* \*/)
    assert.match(output.body, /cron-2 = type=cron/)
    assert.match(output.body, /a # b ; c \/\/ d/)
    assert.match(output.body, /loon-rewrite-v2\.js/)
    assert.match(output.body, /NEW-RULE,keep-me,REJECT/)
    assert.match(output.body, /# request if .*unknown\(200\)/)
    const url = output.body.match(/script-path=(http:\/\/script\.hub\/convert\/[^\s,]+)/)[1]
    const params = new URLSearchParams(url.split('/_end_/')[1].split('?')[1])
    const argumentContext = {}
    if (params.has('loonBundle')) argumentContext.$argument = JSON.parse(params.get('loonBundle')).rules[0].argument
    else vm.runInNewContext(params.get('prepend'), argumentContext)
    assert.strictEqual(argumentContext.$argument.region, 'CN,HK')
    assert.strictEqual(argumentContext.$argument.level, 2)
    assert.strictEqual(argumentContext.$argument.enabled, true)
    const native = await convert(file, input, 'loon-plugin')
    assert.strictEqual(native.status, 200, native.body)
    assert.match(native.body, /\{\$\{region\}, \$\{level\}, \$\{enabled\}\}/)
  }
  const runtime = { console: { log() {} } }
  vm.runInNewContext(fs.readFileSync('scripts/loon-rewrite-v2.js', 'utf8'), runtime)
  const result = runtime.runLoonRewrite({ phase: 'response', actions: [
    { name: 'json.delete', args: ['data.ads'] },
    { name: 'json.replace', args: ['data.vip', true] },
    { name: 'header.set', args: ['X-Result', 'ok'] },
  ] }, {}, { headers: { 'content-length': '20' }, body: '{"data":{"ads":[1],"vip":false}}' })
  assert.deepStrictEqual(JSON.parse(result.body), { data: { vip: true } })
  assert.strictEqual(result.headers['X-Result'], 'ok')
  assert.strictEqual(result.headers['content-length'], undefined)
  const mock = runtime.runLoonRewrite({ phase: 'response', mock: true, actions: [
    { name: 'header.set', args: ['Content-Type', 'custom/type'] },
    { name: 'body.mock', args: ['json', '{}', 201] },
  ] }, {}, {})
  assert.strictEqual(mock.response.status, 201)
  assert.strictEqual(mock.response.headers['Content-Type'], 'custom/type')
  const condition = { kind: 'and', children: [
    { kind: 'equal', left: { variable: 'request.method' }, right: { value: 'POST' } },
    { kind: 'regex', left: { variable: "response.header['Content-Type']" }, pattern: '^application/json', flags: 'i' },
  ] }
  const conditional = { phase: 'response', condition, actions: [{ name: 'json.delete', args: ['ad'] }] }
  assert.deepStrictEqual(JSON.parse(JSON.stringify(runtime.runLoonRewrite(conditional, { method: 'GET' }, { body: '{"ad":1}' }))), {})
  assert.strictEqual(runtime.runLoonRewrite(conditional, { method: 'POST' }, { headers: { 'content-type': 'Application/JSON' }, body: '{"ad":1}' }).body, '{}')
  const continued = runtime.runLoonRewrite({ phase: 'response', actions: [
    { name: 'json.delete', args: ['ad'] },
    { name: 'body.replace', args: [{ pattern: '(old)', flags: '' }, '$0-$1'] },
    { name: 'header.set', args: ['X-OK', 'yes'] },
  ] }, {}, { body: 'old text' })
  assert.strictEqual(continued.body, 'old-old text')
  assert.strictEqual(continued.headers['X-OK'], 'yes')
  for (const file of ['Rewrite-Parser.js', 'Rewrite-Parser.beta.js']) {
    const fixture = '[Script]\nhttp-request ^https://example.com script-path=https://example.com/a.js, argument=[{enabled}], enabled={enabled}\n[Argument]\nenabled = switch,false\n'
    for (const target of ['surge-module', 'shadowrocket-module', 'stash-stoverride']) {
      const output = await convert(file, fixture, target)
      assert.strictEqual(output.status, 200, output.body)
      assert.match(output.body, /loon-(argument|dispatch)\.js/)
      if (target === 'stash-stoverride') assert.match(output.body, /# +type: request/)
      else assert.match(output.body, /#a = type=http-request/)
    }
    const quoted = await convert(file, '[Script]\nhttp-request ^https://example.com script-path=https://example.com/a.js, argument="x, timeout=999, requires-body=true", timeout=10\n')
    assert.match(quoted.body, /timeout=10/)
    assert.doesNotMatch(quoted.body, /script-path=[^\n]+, requires-body=true, timeout=/)
    for (const target of ['surge-module', 'stash-stoverride', 'loon-plugin']) {
      const literal = await convert(file, '[Argument]\nregion=input,"CN"\n[Script]\nrequest if ${url} ~= /api/ then script("https://example.com/a.js", `literal ${region} {{{region}}}`)\n', target)
      assert.match(literal.body, /literal \$\{region\} \{\{\{region\}\}\}/)
      assert.doesNotMatch(literal.body, /__SCRIPT_HUB_LOON_LITERAL_/)
    }
    const multiline = await convert(file, '[Script]\nrequest if ${url} ~= /api/ then script("https://example.com/a.js", `first\nsecond\n`)\n', 'stash-stoverride')
    assert.strictEqual(multiline.status, 200, multiline.body)
    assert.match(multiline.body, /argument: "first\\nsecond\\n"/)
    const malformed = await convert(file, '[Script]\nrequest if ${url} ~= /api/ then script("broken.js\n[Rule]\nDOMAIN,next.example.com,REJECT')
    assert.match(malformed.body, /DOMAIN,next.example.com,REJECT/)
    const failure = await convert(file, '[Script]\nrequest if ${url} ~= /api/ && ${request.method} == "POST" then script("https://example.com/a.js")\n[Rewrite]\nunknown-old-rule data\n')
    assert.match(failure.body, /loon-request-dispatch/)
    assert.match(failure.body, /# unknown-old-rule data/)
  }
  console.log('Loon integration tests passed (stable, beta, runtime)')
}
module.exports = { convert }
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
