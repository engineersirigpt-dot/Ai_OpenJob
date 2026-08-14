// PM2 config for deploying on Node 22 (node:sqlite is behind a flag there).
// Run with:  pm2 start ecosystem.config.js
module.exports = {
  apps: [
    {
      name: "ai-openjob",
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3002",
      cwd: "/home/webadmin/ai_openjob",
      env: {
        NODE_ENV: "production",
        // Required because the app uses node:sqlite (experimental in Node 22)
        NODE_OPTIONS: "--experimental-sqlite",
      },
    },
  ],
};
