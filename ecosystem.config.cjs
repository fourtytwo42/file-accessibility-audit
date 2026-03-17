module.exports = {
  apps: [
    {
      name: 'file-audit-api',
      cwd: './apps/api',
      script: 'pnpm',
      args: 'start',
      interpreter: 'none',
      env: {
        NODE_ENV: 'production',
        PORT: 6103,
      },
      watch: false,
      max_memory_restart: '512M',
      restart_delay: 3000,
      exp_backoff_restart_delay: 100,
    },
    {
      name: 'file-audit-web',
      cwd: './apps/web',
      script: 'pnpm',
      args: 'start',
      interpreter: 'none',
      env: {
        NODE_ENV: 'production',
        PORT: 6102,
      },
      watch: false,
      max_memory_restart: '512M',
      restart_delay: 3000,
      exp_backoff_restart_delay: 100,
    },
  ],
}
