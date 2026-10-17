/**
 * PM2 Production Process Configuration — omni-discord-music
 *
 * IMPORTANT:
 * - Uses `fork` mode with `instances: 1` intentionally. Discord Gateway voice state and
 *   per-guild audio players are held in process memory; running multiple uncoordinated
 *   cluster instances with the same bot token causes duplicate command replies and
 *   conflicting voice gateway handshakes.
 * - Use EITHER PM2 on the host OR Docker Compose for deployment — never run both simultaneously
 *   with the same DISCORD_TOKEN.
 */

export default {
  apps: [
    {
      name: 'omni-discord-music',
      script: './src/index.js',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      restart_delay: 5000,
      exp_backoff_restart_delay: 200,
      max_restarts: 15,
      min_uptime: '15s',
      kill_timeout: 12000,
      wait_ready: false,
      node_args: '--enable-source-maps',
      env: {
        NODE_ENV: 'production',
        LOG_LEVEL: 'info'
      },
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      merge_logs: true,
      time: true
    }
  ]
};
