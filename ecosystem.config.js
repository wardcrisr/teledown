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
      // 直接显示本地(Asia/Shanghai)时间，不附加偏移字符串
      log_date_format: "YYYY-MM-DD HH:mm:ss",

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
        BOT_UPLOAD_LIMIT_MB: "2000",
        BOT_WEB_LOGIN_URL: "https://dltelegram.com",
        BOT_BIND_SECRET: "V7w0Wc3-2NQK5Xzv1mYH8d4lR9_UtA3p7nq0bZcL",
        SANDBOX_MAX_ACTIVE: "6",
        QUEUE_CONCURRENCY: "6",
        // Keep worker warm to eliminate handshake latency
        SANDBOX_TTL_MIN: "120",
        // Fast start: start download immediately without queue if free
        BOT_FAST_START: "1",
        // Eager start: don't block on meta fetch & limits before starting
        BOT_EAGER_START: "1",
        BOT_PROGRESS_DEBUG: "0",
        REDIS_URL: "redis://127.0.0.1:6379",
        ADMIN_SECRET: "secret",
        ADMIN_USER: "admin",
        ADMIN_PASS: "19950214xzk",
        TZ: "Asia/Shanghai"
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
