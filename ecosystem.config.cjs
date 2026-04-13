module.exports = {
  apps: [
    {
      name: 'file-audit-llm',
      cwd: '.',
      script: 'bash',
      args: './scripts/run-local-llm-gemma4-e2b.sh',
      interpreter: 'none',
      env: {
        LLAMA_SERVER_HOST: '127.0.0.1',
        LLAMA_SERVER_PORT: 1234,
      },
      watch: false,
      kill_timeout: 15000,
      restart_delay: 5000,
      exp_backoff_restart_delay: 250,
    },
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
  ],
}
