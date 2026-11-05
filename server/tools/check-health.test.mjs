import test from 'node:test'
import assert from 'node:assert/strict'

import {
  HEALTH_LOG_ERR_MS,
  HEALTH_QUIET_MS,
  HEALTH_RECONNECT_MS,
  healthIssues,
  healthView,
} from '../core/health.mjs'

const now = Date.parse('2026-11-05T21:00:00+08:00')

test('健康：一切正常时不出告警', () => {
  assert.deepEqual(
    healthIssues({ status: 'live', liveState: 'live', lastEventAt: now - 60_000, now }),
    [],
  )
})

test('健康：弹幕连接 error / closed 立刻报', () => {
  for (const status of ['error', 'closed']) {
    const out = healthIssues({ status, now })
    assert.equal(out.length, 1)
    assert.equal(out[0].code, 'ws')
    assert.match(out[0].text, /听不到/)
  }
})

test('健康：重连超过 5 分钟才报，未超过不报', () => {
  const short = healthIssues({
    status: 'reconnecting',
    reconnectingSince: now - HEALTH_RECONNECT_MS + 1000,
    now,
  })
  assert.equal(short.length, 0)

  const long = healthIssues({
    status: 'reconnecting',
    reconnectingSince: now - HEALTH_RECONNECT_MS - 1000,
    now,
  })
  assert.equal(long[0].code, 'ws')
  assert.equal(long[0].level, 'warn')
})

test('健康：只有在直播中、且真的安静了才报', () => {
  const quiet = healthIssues({
    status: 'live',
    liveState: 'live',
    lastEventAt: now - HEALTH_QUIET_MS - 1000,
    now,
  })
  assert.equal(quiet[0].code, 'quiet')

  const offline = healthIssues({
    status: 'live',
    liveState: 'offline',
    lastEventAt: now - HEALTH_QUIET_MS - 1000,
    now,
  })
  assert.equal(offline.length, 0, '没开播安静是正常的')
})

test('健康：写日志失败只在一段时间内报，旧错误不追着喊', () => {
  const recent = healthIssues({ lastLogErrorAt: now - 60_000, now })
  assert.equal(recent[0].code, 'log')

  const old = healthIssues({ lastLogErrorAt: now - HEALTH_LOG_ERR_MS - 1000, now })
  assert.equal(old.length, 0)
})

test('健康：多个问题一起报，view 保留原始数据', () => {
  const view = healthView({
    status: 'closed',
    liveState: 'live',
    lastEventAt: now - HEALTH_QUIET_MS - 1000,
    lastLogErrorAt: now - 1000,
    now,
  })
  assert.equal(view.ok, false)
  assert.deepEqual(view.issues.map((x) => x.code), ['ws', 'quiet', 'log'])
  assert.equal(view.at, now)
  assert.equal(view.status, 'closed')
  assert.equal(view.liveState, 'live')
})
