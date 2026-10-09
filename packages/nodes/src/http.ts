export const AUTOBOT_BASE_URL = 'https://autobot.dbautoaudit.stream';
export function httpDestination(config: Record<string, any>): 'autobot' | 'custom' {
  // Existing nodes with a URL keep their destination until explicitly changed.
  return config.destination === 'autobot' ? 'autobot' : config.destination === 'custom' || config.url ? 'custom' : 'autobot';
}
export function httpUrl(config: Record<string, any>): string {
  if (httpDestination(config) === 'custom') return String(config.url || '').trim();
  const id = String(config.autobotWorkflowId || '').trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ? `${AUTOBOT_BASE_URL}/integration/v1/workflows/${id}/builder-results` : '';
}
