module.exports = {
  apps: [
    {
      name: "teledown",
      script: "backend/server.js",
      cwd: "/root/teledown",
      exec_mode: "fork",
      instances: 1,
      max_memory_restart: "200M",
      restart_delay: 2000,
      autorestart: true,

      out_file: "/root/teledown/logs/teledown-out.log",
      error_file: "/root/teledown/logs/teledown-error.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",

      env: {
        NODE_ENV: "production",
        TELEGRAM_API_ID: "25512975",
        TELEGRAM_API_HASH: "a292dc2abbbf6c6b4013ccb52acbcee2",
        PORT: "8000",
        DOWNLOAD_PATH: "./downloads",
        MAX_CONCURRENT_DOWNLOADS: "2",
        ALLOWED_ORIGIN: "https://dltelegram.com",
        BOT_TOKEN: "8351459922:AAEm1KOYWPoYAQkkEzrgCAv5Ys7zqkjnr_o",
        BOT_WEBHOOK_SECRET: "rUuUFVHB_e-IucJzF-c6hZB7MhgSAUwn",
        BOT_WEBHOOK_URL: "https://dltelegram.com/api/bot/webhook",
        PUBLIC_BASE_URL: "https://dltelegram.com",
        BOT_UPLOAD_LIMIT_MB: "2000"
      },

      env_development: {
        NODE_ENV: "development",
        PORT: "8000"
      },

      env_production: {
        NODE_ENV: "production",
        PORT: "8000"
      }
    }
  ]
};
