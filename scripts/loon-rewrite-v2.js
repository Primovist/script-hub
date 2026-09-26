function loonBodyText(body) {
  if (typeof body === 'string' || body == null) return body
  const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : body
  if (!ArrayBuffer.isView(bytes) && !Array.isArray(bytes)) throw new Error('Unsupported body representation')
  return decodeURIComponent(Array.from(bytes).map(byte => '%' + Number(byte).toString(16).padStart(2, '0')).join(''))
}

function loonBodyBytes(body) {
  if (typeof body !== 'string') return body instanceof ArrayBuffer ? new Uint8Array(body) : body
  const encoded = encodeURIComponent(body), bytes = []
  for (let i = 0; i < encoded.length; i++) {
    if (encoded[i] === '%') { bytes.push(parseInt(encoded.slice(i + 1, i + 3), 16)); i += 2 }
    else bytes.push(encoded.charCodeAt(i))
  }
  return new Uint8Array(bytes)
}

// Generated locally: one-second, 16x16 black H.264/MP4, no audio.
const EMPTY_LOON_VIDEO = 'AAAAHGZ0eXBtcDQyAAAAAWlzb21tcDQxbXA0MgAAAAFtZGF0AAAAAAAAAIAAAAA2BgUtR1ZK3FxMQz+U78URPNFDqAEAAAMAAQMAAAMAAQIAAeYACwAAAwAAAwAAAwCgDAORKwGAAAAAMiW4IB/eCOVM/4LMHptSRABRe9tYj3oKGR7muYOn1baygfNhrKhjb6jnpwAANoAVwz0YAAACp21vb3YAAABsbXZoZAAAAADm3Wg25t1oNgAAAlgAAAJYAAEAAAEAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAIzdHJhawAAAFx0a2hkAAAAAebdaDbm3Wg2AAAAAQAAAAAAAAJYAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAQAAAAEAAAAAAAJGVkdHMAAAAcZWxzdAAAAAAAAAABAAACWAAAAAAAAQAAAAABq21kaWEAAAAgbWRoZAAAAADm3Wg25t1oNgAAAlgAAAAoVcQAAAAAADFoZGxyAAAAAAAAAAB2aWRlAAAAAAAAAAAAAAAAQ29yZSBNZWRpYSBWaWRlbwAAAAFSbWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAABEnN0YmwAAAChc3RzZAAAAAAAAAABAAAAkWF2YzEAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAEAAQAEgAAABIAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY//8AAAAnYXZjQwFkAAv/4QAMJ2QAC6xWUMN4FmClAQAEKO48sP34+AAAAAAKZmllbAEAAAAACmNocm0AAAAAABhzdHRzAAAAAAAAAAEAAAABAAAAKAAAAA1zZHRwAAAAACAAAAAcc3RzYwAAAAAAAAABAAAAAQAAAAEAAAABAAAAFHN0c3oAAAAAAAAAcAAAAAEAAAAUc3RjbwAAAAAAAAABAAAALA=='

function createLoonExpressionRuntime(request, response) {
  const captures = Object.create(null)
  function read(value) {
    if (value.template) return value.template.map(read).join('')
    if (!value.variable) return value.value
    if (value.variable === 'url') return request.url
    if (value.variable === 'request.method') return request.method
    if (value.variable === 'response.status') return Number(response.status ?? response.statusCode)
    const capture = value.variable.match(/^([A-Za-z_][A-Za-z0-9_]*)\.(\d+)$/)
    if (capture) {
      const matched = captures[capture[1]]?.[Number(capture[2])]
      if (matched === undefined) throw new Error('Unmatched capture: ' + value.variable)
      return matched
    }
    const match = value.variable.match(/^(request|response)\.header\['([^']+)'\]$/)
    if (!match) throw new Error('Unknown variable: ' + value.variable)
    const source = match[1] === 'request' ? request : response
    const key = Object.keys(source.headers || {}).find(key => key.toLowerCase() === match[2].toLowerCase())
    return key === undefined ? null : source.headers[key]
  }
  function matches(node) {
    if (node.kind === 'constant') return node.value
    if (node.kind === 'and') return node.children.every(matches)
    if (node.kind === 'or') return node.children.some(matches)
    if (node.kind === 'equal') return read(node.left) === read(node.right)
    const value = read(node.left)
    if (typeof value !== 'string') return false
    const match = new RegExp(node.pattern, node.flags).exec(value)
    if (match && node.capture) captures[node.capture] = match
    return !!match
  }
  return { read, matches, captures }
}

function decodeLoonBase64(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const text = String(input).replace(/\s/g, '')
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) throw new Error('Invalid Base64 data')
  const bytes = []
  let bits = 0, value = 0
  for (const char of text.replace(/=+$/, '')) {
    value = (value << 6) | alphabet.indexOf(char); bits += 6
    if (bits >= 8) { bits -= 8; bytes.push((value >> bits) & 255) }
  }
  return new Uint8Array(bytes)
}

function loonResourceURL(path, base) {
  if (/^https?:\/\//i.test(path)) return path
  const root = String(base || '').match(/^(https?:\/\/[^/]+)(\/[^?#]*)?/i)
  if (!root || /https?:\/\/local\.text$/i.test(root[1])) throw new Error('Relative resource has no remote plugin base: ' + path)
  if (path.startsWith('//')) return root[1].split(':')[0] + ':' + path
  const joined = path.startsWith('/') ? path : (root[2] || '/').replace(/[^/]*$/, '') + path
  const parts = []
  for (const part of joined.split('/')) {
    if (part === '..') parts.pop()
    else if (part !== '.') parts.push(part)
  }
  return root[1] + '/' + parts.filter(Boolean).join('/')
}

function fetchLoonResource(url, binary) {
  return new Promise((resolve, reject) => {
    $httpClient.get({ url, 'binary-mode': binary, timeout: 15 }, (error, response, body) => {
      const status = Number(response?.status ?? response?.statusCode)
      if (error || status < 200 || status >= 300 || body == null) reject(new Error('Resource fetch failed: ' + url + ' (' + (error || status) + ')'))
      else resolve(body)
    })
  })
}

async function runLoonRewriteWithResources(spec, request, response, fetchResource = fetchLoonResource) {
  if (!spec.actions.some(action => action.name.endsWith('_file'))) return runLoonRewrite(spec, request, response)
  request = { ...request, headers: { ...request.headers } }
  response = { ...response, headers: { ...response.headers } }
  const expressions = createLoonExpressionRuntime(request, response)
  if (spec.condition && !expressions.matches(spec.condition)) return {}
  const actions = spec.mock
    ? [...spec.actions.filter(action => /^body\.mock(?:_file)?$/.test(action.name)), ...spec.actions.filter(action => !/^body\.mock(?:_file)?$/.test(action.name))]
    : spec.actions
  const patch = {}, resources = new Map()
  for (let action of actions) {
    try {
      if (action.name.endsWith('_file')) {
        const args = action.args.map(value => value?.loonValue ? expressions.read(value.loonValue) : value)
        const isJQ = action.name === 'json.jq_file'
        const path = isJQ ? args[0] : args[1]
        const base64 = args[spec.phase === 'response' ? 3 : 2] === true
        const binary = !isJQ && !base64 && ['png', 'gif', 'jpeg', 'tiff', 'mp4'].includes(args[0])
        const url = loonResourceURL(path, spec.resourceBase)
        const key = JSON.stringify([url, binary])
        if (!resources.has(key)) resources.set(key, fetchResource(url, binary))
        const content = await resources.get(key)
        if (isJQ) args[0] = content
        else args[1] = content
        action = { ...action, name: action.name.replace(/_file$/, ''), args }
      }
      const mock = spec.mock && action.name === 'body.mock'
      const changed = runLoonRewrite({ ...spec, mock, condition: null, actions: [action] }, request, response, expressions)
      if (mock && !changed.response) return {}
      if (changed.response && !spec.mock) return changed
      const result = changed.response || changed
      Object.assign(patch, result)
      Object.assign(spec.phase === 'request' ? request : response, result)
    } catch (error) {
      console.log('Loon Rewrite V2: ' + error.message)
      if (spec.mock && /^body\.mock/.test(action.name)) return {}
    }
  }
  return spec.mock ? { response: patch } : patch
}

// Executes validated Loon V2 action descriptors emitted by Rewrite-Parser.
// No source expressions or JavaScript supplied by a plugin are evaluated.
function runLoonRewrite(spec, request, response, expressionContext = null) {
  if (!expressionContext) {
    request = { ...request, headers: { ...request.headers } }
    response = { ...response, headers: { ...response.headers } }
  }
  const expressions = expressionContext || createLoonExpressionRuntime(request, response)
  if (spec.condition && !expressions.matches(spec.condition)) return {}
  const source = spec.phase === 'response' ? response : request
  const result = {}
  let terminalResponse = null, mockSucceeded = false
  let headers = { ...(source?.headers || {}) }
  let body = source?.body ?? source?.bodyBytes
  const findHeader = name => Object.keys(headers).find(key => key.toLowerCase() === name.toLowerCase())
  const setHeader = (name, value) => {
    const old = findHeader(name)
    if (old) delete headers[old]
    headers[name] = value
    source.headers = headers
    result.headers = headers
  }
  const removeHeader = name => {
    const key = findHeader(name)
    if (key) delete headers[key]
    source.headers = headers
    result.headers = headers
  }
  const mime = { json: 'application/json', text: 'text/plain', plain: 'text/plain', css: 'text/css', html: 'text/html', javascript: 'application/javascript', svg: 'image/svg+xml', png: 'image/png', gif: 'image/gif', jpeg: 'image/jpeg', tiff: 'image/tiff', mp4: 'video/mp4', 'form-data': 'multipart/form-data' }
  const replace = (value, regex, replacement) => String(value).replace(new RegExp(regex.pattern, regex.flags + 'g'), (...match) => {
    const named = typeof match[match.length - 1] === 'object'
    const count = match.length - (named ? 3 : 2)
    return replacement.replace(/\$(\d+)/g, (token, index) => Number(index) < count ? (match[Number(index)] ?? '') : token)
  })
  const apply = action => {
    const [a, b, c, d] = action.args.map(value => value?.loonValue ? expressions.read(value.loonValue) : value)
    switch (action.name) {
      case 'url.replace':
        result.url = request.url.replace(new RegExp(action.urlPattern.pattern, action.urlPattern.flags), () => a)
        request.url = result.url
        break
      case 'redirect': {
        if (![302, 307].includes(a)) throw new Error('Invalid redirect status')
        const location = request.url.replace(new RegExp(action.urlPattern.pattern, action.urlPattern.flags), () => b)
        terminalResponse = { status: a, headers: { Location: location }, body: '' }
        break
      }
      case 'reject':
      case 'reject_dict':
      case 'reject_array':
      case 'reject_img':
      case 'reject_video': {
        if (!Number.isInteger(a) || a < 100 || a > 599) throw new Error('Invalid reject status')
        const type = action.name === 'reject' ? 'text/plain' : action.name === 'reject_img' ? 'image/gif' : action.name === 'reject_video' ? 'video/mp4' : 'application/json'
        const content = action.name === 'reject_dict' ? '{}' : action.name === 'reject_array' ? '[]' : action.name === 'reject_img' ? decodeLoonBase64('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7') : action.name === 'reject_video' ? decodeLoonBase64(EMPTY_LOON_VIDEO) : b ?? ''
        terminalResponse = { status: a, headers: { 'Content-Type': type }, body: content }
        break
      }
      case 'header.add': if (!findHeader(a)) setHeader(a, b); break
      case 'header.set': setHeader(a, b); break
      case 'header.del': removeHeader(a); break
      case 'header.replace': {
        const key = findHeader(a)
        if (key) setHeader(key, replace(headers[key], b, c))
        break
      }
      case 'body.replace':
        if (body == null) throw new Error('Body unavailable')
        body = replace(loonBodyText(body), a, b); result.body = body
        break
      case 'body.mock':
        body = (spec.phase === 'response' ? d : c) === true ? decodeLoonBase64(b) : b
        result.body = body
        setHeader('Content-Type', mime[a])
        if (spec.mock) {
          if (c != null && (!Number.isInteger(c) || c < 100 || c > 599)) throw new Error('Invalid mock status')
          result.status = c ?? 200
        }
        mockSucceeded = true
        break
      case 'json.add':
      case 'json.replace':
      case 'json.delete': {
        const value = JSON.parse(loonBodyText(body))
        const path = a.match(/[^.\[\]]+/g)
        if (path.some(key => ['__proto__', 'prototype', 'constructor'].includes(key))) throw new Error('Unsafe JSON path')
        let parent = value
        for (let i = 0; i < path.length - 1; i++) {
          const key = path[i]
          if (!parent || typeof parent !== 'object') throw new Error('Invalid JSON parent')
          if (!Object.prototype.hasOwnProperty.call(parent, key)) {
            if (action.name !== 'json.add') return
            parent[key] = /^\d+$/.test(path[i + 1]) ? [] : {}
          }
          parent = parent[key]
        }
        if (!parent || typeof parent !== 'object') throw new Error('Invalid JSON parent')
        const key = path[path.length - 1]
        const exists = Object.prototype.hasOwnProperty.call(parent, key)
        if (action.name === 'json.delete') {
          if (Array.isArray(parent) && /^\d+$/.test(key)) { if (exists) parent.splice(Number(key), 1) }
          else delete parent[key]
        } else if (action.name === 'json.add' || exists) parent[key] = b
        body = JSON.stringify(value); result.body = body
        break
      }
      default: throw new Error('Unsupported action: ' + action.name)
    }
  }
  // Loon generates a mock before applying all header actions, regardless of its position.
  const actions = spec.mock
    ? [...spec.actions.filter(action => action.name === 'body.mock'), ...spec.actions.filter(action => action.name !== 'body.mock')]
    : spec.actions
  for (const action of actions) {
    try { apply(action) } catch (error) { console.log('Loon Rewrite V2: ' + error.message) }
    if (terminalResponse) return { response: terminalResponse }
  }
  if (Object.prototype.hasOwnProperty.call(result, 'body')) {
    removeHeader('Content-Length')
    removeHeader('Transfer-Encoding')
  }
  return spec.mock ? mockSucceeded ? { response: result } : {} : result
}

// Script Hub runtime entry
if (typeof $done === 'function') {
  try {
    const spec = JSON.parse(decodeURIComponent($argument))
    runLoonRewriteWithResources(spec, typeof $request === 'undefined' ? {} : $request, typeof $response === 'undefined' ? {} : $response).then($done).catch(error => { console.log('Loon Rewrite V2: ' + error.message); $done({}) })
  } catch (error) {
    console.log('Loon Rewrite V2: ' + error.message)
    $done({})
  }
}
