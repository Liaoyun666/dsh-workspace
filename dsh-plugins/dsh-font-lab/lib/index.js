/**
 * dsh-font-lab — 服务端。
 *
 * 只做一件事：把本机安装的字体扫成 JSON，挂在 /font-lab 前缀下给客户端面板用。
 * 扫描很贵（359 个文件、几百个 sfnt 表），所以结果缓存在内存里，5 分钟过期；
 * 客户端想强制重扫就带 ?refresh=1。
 *
 * @module dsh-font-lab
 */
import { scanFonts } from './scan.js'

export const name = 'dsh-font-lab'

const CACHE_TTL = 5 * 60 * 1000
const ROUTE = '/font-lab'

/** 内存缓存：{ data, at } | null */
let cache = null

function getFonts(refresh) {
  const now = Date.now()
  if (!refresh && cache && now - cache.at < CACHE_TTL) return cache.data
  const data = scanFonts()
  cache = { data, at: Date.now() }
  return data
}

/** 写 JSON，顺手关掉各种代理缓冲。 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(text)
}

async function handler(req, res) {
  const url = new URL(req.url ?? '/', 'http://dsh.internal')
  const path = url.pathname
  try {
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed' } })
      return
    }
    if (path === `${ROUTE}/api/fonts`) {
      const refresh = url.searchParams.get('refresh') === '1'
      const data = getFonts(refresh)
      sendJson(res, 200, { ok: true, ...data })
      return
    }
    sendJson(res, 404, { ok: false, error: { code: 'not-found', path } })
  } catch (error) {
    sendJson(res, 500, { ok: false, error: { code: 'scan-failed', message: String(error && error.message ? error.message : error) } })
  }
}

/**
 * @param {import('cordis').Context} ctx
 */
export function apply(ctx) {
  // webServer 只存在于 Web 宿主；headless profile 没有它，所以用可选注入，
  // 拿不到就静默不注册（面板不会出现，但宿主不会崩）。
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'prefix', path: ROUTE, handler }),
      'dsh-font-lab: /font-lab api',
    )
  })
}
