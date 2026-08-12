const path = require('node:path');

module.exports = {
  apps: [
    {
      name: 'local-agent',
      cwd: __dirname,
      script: 'dist/main.js',
      interpreter: 'node',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      restart_delay: 3000,
      time: true,
      env: {
        NODE_ENV: 'production',
        // Avoid resolving an unrelated globally installed `codex` package from
        // PM2's inherited PATH. This project bundles the official CLI.
        CODEX_PATH: path.join(__dirname, 'node_modules', '.bin', 'codex'),
      },
    },
  ],
};
