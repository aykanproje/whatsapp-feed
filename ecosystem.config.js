module.exports = {
  apps: [
    {
      name:             'whatsapp-feed',
      script:           'index.js',
      instances:        1,
      autorestart:      true,
      watch:            false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        PORT:     3000,
        DB_PATH:  './data/messages.db',
        SESSION_DIR: './session-data',
      },
      error_file:  './logs/err.log',
      out_file:    './logs/out.log',
      merge_logs:  true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
