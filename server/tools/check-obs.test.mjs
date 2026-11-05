import assert from 'node:assert/strict'
import test from 'node:test'

import { createObsClient, obsAuthString } from '../core/obs.mjs'

/** 极简的假 WebSocket：只实现 createObsClient 用到的那几个口子 */
function fakeSocket({ hello = null, onIdentify = null, onRequest = null, closeCode = null } = {}) {
  return class FakeWS {
    constructor(url) {
      this.url = url
      this.listeners = {}
      this.sent = []
      this.closed = false
      fakeSocket.last = this
      // 真 ws 是先 addEventListener 再收消息；这里排到微任务，确保监听已挂上
      queueMicrotask(() => {
        if (hello) this.emit('message', { data: JSON.stringify(hello) })
      })
    }

    addEventListener(type, fn) {
      (this.listeners[type] ??= []).push(fn)
    }

    emit(type, ev) {
      for (const fn of this.listeners[type] ?? []) fn(ev)
    }

    send(raw) {
      const msg = JSON.parse(raw)
      this.sent.push(msg)
      if (msg.op === 1) {
        onIdentify?.(msg, this)
        if (closeCode) this.emit('close', { code: closeCode })
        else this.emit('message', { data: JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }) })
      } else if (msg.op === 6) {
        onRequest?.(msg, this)
      }
    }

    close() {
      if (this.closed) return
      this.closed = true
      this.emit('close', { code: 1000 })
    }
  }
}

const HELLO = {
  op: 0,
  d: {
    obsWebSocketVersion: '5.5.2',
    rpcVersion: 1,
    authentication: { challenge: '8x2v4b6n8m0q2w4e', salt: '6jj52y6s9x7w5v1s' },
  },
}

test('OBS 认证串：与 obs-websocket 的公式一致', () => {
  assert.equal(
    obsAuthString('supersecret', '6jj52y6s9x7w5v1s', '8x2v4b6n8m0q2w4e'),
    'VfHK9ZcvHCdOPLQo2Rc6UZDsty+ncQxil2LQMHSvjKo=',
  )
})

test('OBS 握手：Hello 带 authentication 时 Identify 回正确的 challenge 响应', async () => {
  let identified = null
  const WS = fakeSocket({ hello: HELLO, onIdentify: (msg) => (identified = msg) })
  const client = await createObsClient({ url: 'ws://127.0.0.1:4455', password: 'supersecret', WebSocketImpl: WS })
  await new Promise((r) => setImmediate(r))

  assert.equal(identified.op, 1)
  assert.equal(identified.d.rpcVersion, 1)
  assert.equal(
    identified.d.authentication,
    obsAuthString('supersecret', '6jj52y6s9x7w5v1s', '8x2v4b6n8m0q2w4e'),
  )
  client.close()
})

test('OBS 握手：Hello 没开认证时不带 authentication', async () => {
  let identified = null
  const WS = fakeSocket({
    hello: { op: 0, d: { obsWebSocketVersion: '5.5.2', rpcVersion: 1 } },
    onIdentify: (msg) => (identified = msg),
  })
  const client = await createObsClient({ url: 'ws://x', WebSocketImpl: WS })
  await new Promise((r) => setImmediate(r))
  assert.equal('authentication' in identified.d, false)
  client.close()
})

test('OBS 请求：SetCurrentProgramScene 成功后 resolve responseData', async () => {
  const WS = fakeSocket({
    hello: HELLO,
    onRequest: (msg, ws) => {
      ws.emit('message', {
        data: JSON.stringify({
          op: 7,
          d: {
            requestType: msg.d.requestType,
            requestId: msg.d.requestId,
            requestStatus: { result: true, code: 100 },
            responseData: { sceneName: msg.d.requestData.sceneName },
          },
        }),
      })
    },
  })
  const client = await createObsClient({ url: 'ws://x', password: 'supersecret', WebSocketImpl: WS })
  const out = await client.request('SetCurrentProgramScene', { sceneName: '直播中' })
  assert.deepEqual(out, { sceneName: '直播中' })
  client.close()
})

test('OBS 请求：result=false 时用 comment 抛错', async () => {
  const WS = fakeSocket({
    hello: HELLO,
    onRequest: (msg, ws) => {
      ws.emit('message', {
        data: JSON.stringify({
          op: 7,
          d: {
            requestId: msg.d.requestId,
            requestStatus: { result: false, code: 600, comment: 'No source was found by the name of x' },
          },
        }),
      })
    },
  })
  const client = await createObsClient({ url: 'ws://x', password: 'p', WebSocketImpl: WS })
  await assert.rejects(
    () => client.request('GetSceneItemId', { sceneName: 'nope', sourceName: 'x' }),
    /No source was found/,
  )
  client.close()
})

test('OBS 认证失败：close code 4009 提示密码不对', async () => {
  const WS = fakeSocket({ hello: HELLO, closeCode: 4009 })
  await assert.rejects(
    () => createObsClient({ url: 'ws://x', password: 'wrong', WebSocketImpl: WS }),
    /密码不对/,
  )
})
