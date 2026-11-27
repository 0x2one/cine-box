import type { McpServer } from '@modelcontextprotocol/server'
import type { McpInvoke } from '../mcp-types'
import { registerBackupLogTools } from './backup-logs'
import { registerCategoryTools } from './categories'
import { registerCollectTools } from './collect'
import { registerDownloadTools } from './downloads'
import { registerHomeTools } from './home'
import { registerLanCapacityTools } from './lan-capacity'
import { registerNetworkContentTools } from './network-content'
import { registerSiteTools } from './sites'
import { registerVideoTools } from './videos'

/** 所有工具按分组注册；顺序决定 tools/list 的稳定顺序 */
export function registerMcpTools(server: McpServer, invoke: McpInvoke): void {
  registerSiteTools(server, invoke)
  registerCategoryTools(server, invoke)
  registerCollectTools(server, invoke)
  registerVideoTools(server, invoke)
  registerHomeTools(server, invoke)
  registerLanCapacityTools(server, invoke)
  registerBackupLogTools(server, invoke)
  registerNetworkContentTools(server, invoke)
  registerDownloadTools(server, invoke)
}
