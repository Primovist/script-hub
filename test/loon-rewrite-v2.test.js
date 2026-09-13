const assert = require('assert')
const fs = require('fs')
const vm = require('vm')

const source = fs.readFileSync('Rewrite-Parser.js', 'utf8')
const start = source.indexOf('// Loon Rewrite V2 parser.')
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

for (const status of ['403', '451']) {
  assert.strictEqual(parse(`request if \${url} ~= /api/ then reject(${status})`).ok, false)
}
assert.strictEqual(parse('request if ${url} ~= /api/ then reject_dict(201)').ok, false)
assert.strictEqual(parse('request if ${url} ~= /api/ then reject(403, "Forbidden")').ok, false)

assert.strictEqual(parse('request if ${url} ~= /api/ && ${request.method} == "POST" then reject_dict(200)').ok, false)
assert.strictEqual(parse('request if ${url} ~= /old/ as urlMatch then url.replace("https://new.example.com${urlMatch.1}")').ok, false)
assert.strictEqual(parse('request if ${url} ~= /api/ then unknown_action(200)').ok, false)
assert.strictEqual(parse('# request if ${url} ~= /api/ then reject_dict(200)').ok, false)

// The production gate is section-scoped: a Script section must not dispatch V2.
let section = 'Script'
let dispatched = 0
for (const line of ['[Script]', 'request if ${url} ~= /api/ then reject_dict(200)', '[Rewrite]', 'request if ${url} ~= /api/ then reject_dict(200)']) {
  if (/^\[[^\]]+\]$/.test(line)) section = line.slice(1, -1)
  else if (section === 'Rewrite' && /^(?:request|response)\s+if\b/i.test(line)) dispatched++
}
assert.strictEqual(dispatched, 1)

console.log(`Loon Rewrite V2 tests passed: ${results.length} converted samples; negative cases preserved as unsupported`)
